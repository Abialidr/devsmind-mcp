import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The local, gitignored activity log — sessions and messages, grouped for the Activity page.
 *
 * Everything here lives under `.devmind/local/`, which `devsmind init` adds to `.devmind/.gitignore`
 * (see [[cli/init.ts]]). It never gets pushed: message text is only ever meaningful on the machine
 * that wrote it, and the point of this store is to be a working-tree time machine for one
 * developer, not a second copy of the shared graph. Committed history in `.devmind/history/*.json`
 * is untouched by anything in this file — a message's `edits[]` is a self-contained backup, not a
 * reference into committed data, so revert never depends on (or corrupts) what the team shares.
 *
 * JSON on disk, one file per message plus one sessions index — same shape of storage as staging.ts,
 * same atomic temp+rename write, deliberately no new SQLite tables: this data has no reason to
 * survive a `brain.db` rebuild via anything other than being read back from these files.
 */

/**
 * `'partial'` means some but not all of a message's edits are reverted — the result of reverting
 * one file, or one single edit, within a message rather than the whole thing. Whole-message
 * revert/un-revert (message-revert.ts) still exists and still flips every edit at once; this
 * status is what lets the UI (and the un-revert ordering rule) tell "fully reverted" apart from
 * "partially reverted via a more surgical action."
 */
export type MessageStatus = 'applied' | 'partial' | 'reverted';

export interface MessageEdit {
  /** Stable identity for this one edit — what a single-edit revert/un-revert targets. */
  id: string;
  node_id: string;
  file_path: string;
  at: string;
  before: string;
  after: string;
  /** True once this specific edit has been reverted (via any granularity). Absent/false = applied. */
  reverted?: boolean;
}

/** A message's status is derived from its edits, not tracked independently — this is the one
 * place that mapping happens, so whole-message and granular (file/edit) revert paths can't drift
 * out of sync with each other. */
export function deriveStatus(edits: MessageEdit[]): MessageStatus {
  if (!edits.length) return 'applied';
  const revertedCount = edits.filter(e => e.reverted).length;
  if (revertedCount === 0) return 'applied';
  if (revertedCount === edits.length) return 'reverted';
  return 'partial';
}

export interface ActivityMessage {
  id: string;
  session_id: string;
  developer: string | null;
  created_at: string;
  updated_at: string;
  /** The user's original request, when the caller supplied one. Null degrades to `summary` only. */
  request: string | null;
  /** Short machine-generated label (from the commit's reasoning), always present. */
  summary: string;
  status: MessageStatus;
  edits: MessageEdit[];
  /**
   * Which of this message's edits have already been turned into workflow steps.
   *
   * Tracked as EDIT IDS rather than a "synced: true" flag because a message keeps growing after it
   * is tagged — `recordMessage` appends edits to an existing message when consecutive commits share
   * a request, and the revert engine rewrites `edits` in place. A boolean would permanently strand
   * everything added after the moment it was set; a list of consumed ids means a re-sync is a true
   * no-op and a message that grew produces a delta step.
   */
  workflow_sync?: { workflow_id: string; step_ids: string[]; synced_edit_ids: string[] }[];
}

export interface ActivitySession {
  id: string;
  developer: string | null;
  started_at: string;
  last_active: string;
  message_ids: string[];
  /** Human-readable name for the session, set at `start_session` time. Shown on the Activity page. */
  label?: string;
  /**
   * The workflow this session is currently working on, or absent/null when unbound.
   *
   * Deliberately LOCAL. A workflow is a shared record, but "which one am I on right now" is a
   * property of the reader, not the thing being read — the previous design kept one global pointer
   * that synced through git, so two sessions (or two teammates) silently took it from each other
   * mid-work and logged their commits onto the wrong timeline.
   */
  workflow_id?: string | null;
}

interface SessionsFile {
  sessions: ActivitySession[];
}

/** Exported so other `.devmind/local/`-based stores (e.g. `feedback.ts`) share the same directory
 * and gitignore convention instead of re-deriving it. */
export function localDir(devmindPath: string): string {
  return path.join(path.resolve(devmindPath), 'local');
}

function sessionsPath(devmindPath: string): string {
  return path.join(localDir(devmindPath), 'sessions.json');
}

function messagesDir(devmindPath: string): string {
  return path.join(localDir(devmindPath), 'messages');
}

function messagePath(devmindPath: string, messageId: string): string {
  return path.join(messagesDir(devmindPath), `${messageId}.json`);
}

/**
 * Guards against `local/` landing in a commit on a brain that predates this feature: `devsmind
 * init` writes the ignore line for anyone who re-runs it, but a brain that never does wouldn't
 * otherwise pick it up. Checked (not assumed) on first write per process, since accidentally
 * committing a developer's request history and revert backups is the one outcome worth a cheap
 * file read to prevent.
 */
let gitignoreChecked = false;

/**
 * Collapse a `.gitignore` line to what git actually reads it as, so `local`, `local/`, `/local`
 * and `/local/` all compare equal — they name the same directory. Exported because `devsmind
 * init` tops the same file up from its own entry list, and the two must agree on "is this
 * already ignored?": comparing raw strings meant a hand-written `local` went unrecognized and a
 * second `local/` got appended underneath it on every run.
 */
export function normalizeIgnoreEntry(line: string): string {
  return line.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Exported for reuse by other `.devmind/local/` stores — see {@link localDir}. */
export function ensureGitignored(devmindPath: string): void {
  if (gitignoreChecked) return;
  gitignoreChecked = true;
  try {
    const gitignorePath = path.join(path.resolve(devmindPath), '.gitignore');
    const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
    if (current.split('\n').some(l => normalizeIgnoreEntry(l) === 'local')) return;
    const next = current.length && !current.endsWith('\n') ? current + '\n' : current;
    fs.writeFileSync(gitignorePath, `${next}local/\n`, 'utf-8');
  } catch {
    // Best-effort — a failed self-heal shouldn't block recording the activity log itself.
  }
}

/** Same atomic write as staging.ts's writeBuffer: temp file + rename, never a half-written file. */
function writeJsonAtomic(devmindPath: string, target: string, data: unknown): void {
  ensureGitignored(devmindPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

function readJson<T>(target: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

export function readSessions(devmindPath: string): ActivitySession[] {
  return readJson<SessionsFile>(sessionsPath(devmindPath), { sessions: [] }).sessions;
}

function writeSessions(devmindPath: string, sessions: ActivitySession[]): void {
  writeJsonAtomic(devmindPath, sessionsPath(devmindPath), { sessions });
}

/** Upserts a session's `last_active`, creating it (and linking the message) on first sight. */
function touchSession(devmindPath: string, sessionId: string, developer: string | null, messageId: string, nowStr: string): void {
  const sessions = readSessions(devmindPath);
  const existing = sessions.find(s => s.id === sessionId);
  if (existing) {
    existing.last_active = nowStr;
    if (!existing.message_ids.includes(messageId)) existing.message_ids.push(messageId);
  } else {
    sessions.push({ id: sessionId, developer, started_at: nowStr, last_active: nowStr, message_ids: [messageId] });
  }
  writeSessions(devmindPath, sessions);
}

/**
 * The only way a session comes into being — called by the `start_session` tool. Idempotent: calling
 * it again with an id that already exists (a client retrying a dropped response) just no-ops rather
 * than clobbering `started_at` or the messages already linked to it.
 */
export function createSession(devmindPath: string, sessionId: string, developer: string | null, label?: string): ActivitySession {
  const nowStr = new Date().toISOString();
  const sessions = readSessions(devmindPath);
  const existing = sessions.find(s => s.id === sessionId);
  if (existing) return existing;
  const created: ActivitySession = { id: sessionId, developer, started_at: nowStr, last_active: nowStr, message_ids: [], ...(label ? { label } : {}) };
  sessions.push(created);
  writeSessions(devmindPath, sessions);
  return created;
}

/**
 * Binds this session to a workflow, or unbinds it when `workflowId` is null.
 *
 * Creates the session row if it does not exist yet, mirroring `createSession`'s upsert shape — an
 * agent can legitimately bind before its first commit has created anything.
 */
export function bindSessionWorkflow(
  devmindPath: string,
  sessionId: string,
  workflowId: string | null,
  developer: string | null = null
): ActivitySession {
  const nowStr = new Date().toISOString();
  const sessions = readSessions(devmindPath);
  let session = sessions.find(s => s.id === sessionId);
  if (!session) {
    session = { id: sessionId, developer, started_at: nowStr, last_active: nowStr, message_ids: [] };
    sessions.push(session);
  }
  session.workflow_id = workflowId;
  session.last_active = nowStr;
  writeSessions(devmindPath, sessions);
  return session;
}

/** The workflow this session is bound to right now, or null. */
export function readSessionWorkflow(devmindPath: string, sessionId: string): string | null {
  const session = readSessions(devmindPath).find(s => s.id === sessionId);
  return session?.workflow_id || null;
}

/**
 * The workflow most recently worked on from this machine — what a fresh session offers to continue.
 *
 * Derived, not stored: the newest session that carries a binding. A separate "last workflow"
 * field would be a second copy of a fact already recorded here, and second copies drift — which is
 * precisely the failure the global active pointer this replaces kept producing.
 *
 * `excludeSessionId` skips the session asking the question, so a session that already bound itself
 * does not get offered its own binding back as a suggestion.
 */
export function lastBoundWorkflowId(devmindPath: string, excludeSessionId?: string): string | null {
  const candidates = readSessions(devmindPath)
    .filter(s => s.workflow_id && s.id !== excludeSessionId)
    .sort((a, b) => b.last_active.localeCompare(a.last_active));
  return candidates.length ? candidates[0].workflow_id! : null;
}

export function readMessage(devmindPath: string, messageId: string): ActivityMessage | null {
  return readJson<ActivityMessage | null>(messagePath(devmindPath, messageId), null);
}

function writeMessage(devmindPath: string, message: ActivityMessage): void {
  writeJsonAtomic(devmindPath, messagePath(devmindPath, message.id), message);
}

/** Every message, newest-created first — the read path for the Activity page and the CLI. */
export function listMessages(devmindPath: string): ActivityMessage[] {
  const dir = messagesDir(devmindPath);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const messages = files
    .map(f => readJson<ActivityMessage | null>(path.join(dir, f), null))
    .filter((m): m is ActivityMessage => m !== null);
  messages.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return messages;
}

/** One message's changes, shaped for `get_activity_log` — the per-commit "what changed" view. */
export interface ActivityLogEntry {
  id: string;
  session_id: string;
  developer: string | null;
  created_at: string;
  updated_at: string;
  request: string | null;
  summary: string;
  status: MessageStatus;
  /** Deduped, first-touched order — every file this message touched. This is the field the old
   * `get_developer_activity`/`get_changes_by_requirement` never carried (only `get_recent_changes`
   * did, and only without a developer filter) — the actual gap this tool closes. */
  files: string[];
  /** Deduped graph node ids this message touched. */
  node_ids: string[];
  edit_count: number;
}

export interface ActivityLogResult {
  total_messages: number;
  /** Every distinct file touched across ALL returned entries, flattened — "give me every file
   * that changed" in one list, e.g. to scope a test-writing pass, without walking `entries`
   * yourself. */
  all_files: string[];
  entries: ActivityLogEntry[];
}

/**
 * Queries the local activity log — the one place `developer`, a time window, a specific session,
 * AND the actual files touched all already live together (`ActivityMessage`/`MessageEdit`, see
 * this file's module doc). This is what `get_activity_log` (MCP) wraps; it replaces three
 * narrower, non-composable tools that each only covered one dimension: `get_recent_changes` had
 * dates + files but no developer filter, `get_developer_activity` had a developer filter but no
 * date range and no files, `get_changes_by_requirement` had neither dates nor files. All three
 * filters compose here (AND'd together) since they're all just predicates over the same message
 * list.
 */
export function queryActivityLog(
  devmindPath: string,
  opts: {
    /** Case-insensitive substring match against `developer`. */
    developer?: string;
    sessionId?: string;
    /** Lookback window in hours — convenience for "the last N hours/days". Ignored when `since`
     * is also given. */
    sinceHours?: number;
    /** ISO timestamp lower bound (inclusive) — takes priority over `sinceHours` when both given. */
    since?: string;
    /** ISO timestamp upper bound (inclusive). */
    until?: string;
    /** Case-insensitive substring match against `request` OR `summary` — the requirement/ticket
     * lookup `get_changes_by_requirement` used to do, now against the actual verbatim user
     * request text rather than a reasoning-block LIKE search. */
    requirementContains?: string;
    limit?: number;
  } = {}
): ActivityLogResult {
  let messages = listMessages(devmindPath);

  if (opts.developer) {
    const needle = opts.developer.toLowerCase();
    messages = messages.filter(m => (m.developer ?? '').toLowerCase().includes(needle));
  }
  if (opts.sessionId) {
    messages = messages.filter(m => m.session_id === opts.sessionId);
  }
  const sinceIso = opts.since ?? (opts.sinceHours !== undefined ? new Date(Date.now() - opts.sinceHours * 3600_000).toISOString() : undefined);
  if (sinceIso) {
    messages = messages.filter(m => m.created_at >= sinceIso);
  }
  if (opts.until) {
    messages = messages.filter(m => m.created_at <= opts.until!);
  }
  if (opts.requirementContains) {
    const needle = opts.requirementContains.toLowerCase();
    messages = messages.filter(m => (m.request ?? '').toLowerCase().includes(needle) || m.summary.toLowerCase().includes(needle));
  }

  const limited = messages.slice(0, opts.limit ?? 100);

  const allFilesSet = new Set<string>();
  const entries: ActivityLogEntry[] = limited.map(m => {
    const files: string[] = [];
    const nodeIds: string[] = [];
    const seenFiles = new Set<string>();
    const seenNodes = new Set<string>();
    for (const e of m.edits) {
      if (!seenFiles.has(e.file_path)) {
        seenFiles.add(e.file_path);
        files.push(e.file_path);
        allFilesSet.add(e.file_path);
      }
      if (e.node_id && !seenNodes.has(e.node_id)) {
        seenNodes.add(e.node_id);
        nodeIds.push(e.node_id);
      }
    }
    return {
      id: m.id, session_id: m.session_id, developer: m.developer, created_at: m.created_at, updated_at: m.updated_at,
      request: m.request, summary: m.summary, status: m.status, files, node_ids: nodeIds, edit_count: m.edits.length
    };
  });

  return { total_messages: entries.length, all_files: Array.from(allFilesSet), entries };
}

/**
 * The newest message in a session that is still open to appending — i.e. not yet superseded by a
 * later, different request. Used to decide whether a commit continues the current message
 * (consecutive saves for one request) or starts a new one.
 */
function newestMessageInSession(devmindPath: string, sessionId: string): ActivityMessage | null {
  const sessions = readSessions(devmindPath);
  const session = sessions.find(s => s.id === sessionId);
  if (!session || !session.message_ids.length) return null;
  return readMessage(devmindPath, session.message_ids[session.message_ids.length - 1]);
}

export interface RecordMessageParams {
  session_id: string;
  developer: string | null;
  /** Explicit continuation target — set when the caller already knows which message this extends. */
  message_id?: string;
  /** The user's original request text, when the caller has it. */
  request?: string | null;
  summary: string;
  edits: MessageEdit[];
}

/**
 * Records a commit's edits against a message, creating or continuing one.
 *
 * Continuation, in priority order: an explicit `message_id`; else the session's newest message,
 * when its `request` text matches this commit's (consecutive saves for the same ask collapse into
 * one message); else a new message. A caller with no `request` at all always gets a new message
 * per commit — there is nothing to match on, so grouping degrades to "one message per save" rather
 * than guessing.
 */
export function recordMessage(devmindPath: string, params: RecordMessageParams): ActivityMessage {
  const nowStr = new Date().toISOString();

  let target: ActivityMessage | null = null;
  if (params.message_id) {
    target = readMessage(devmindPath, params.message_id);
  } else if (params.request) {
    const newest = newestMessageInSession(devmindPath, params.session_id);
    if (newest && newest.status === 'applied' && newest.request === params.request) target = newest;
  }

  // Guaranteed here (not just assumed of the caller) so a single-edit revert always has a real
  // id to target, even if some future caller forgets to mint one.
  const edits = params.edits.map(e => (e.id ? e : { ...e, id: crypto.randomUUID() }));

  if (target) {
    target.edits.push(...edits);
    target.updated_at = nowStr;
    if (params.summary) target.summary = params.summary;
    writeMessage(devmindPath, target);
    touchSession(devmindPath, params.session_id, params.developer, target.id, nowStr);
    return target;
  }

  const created: ActivityMessage = {
    id: crypto.randomUUID(),
    session_id: params.session_id,
    developer: params.developer,
    created_at: nowStr,
    updated_at: nowStr,
    request: params.request || null,
    summary: params.summary,
    status: 'applied',
    edits
  };
  writeMessage(devmindPath, created);
  touchSession(devmindPath, params.session_id, params.developer, created.id, nowStr);
  return created;
}

/** Persists a message after its status/edits were mutated in place (by the revert engine). */
export function saveMessage(devmindPath: string, message: ActivityMessage): void {
  writeMessage(devmindPath, message);
}
