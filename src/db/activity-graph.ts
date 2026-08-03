import * as crypto from 'crypto';
import { DevMindDatabase, parseReasoningBlocksTimed, TimedReasoningBlock } from './database';
import {
  queryActivityLog, readSessions,
  ActivityLogEntry, ActivityLogResult, ActivitySource
} from './activity';

/**
 * The SHARED half of `get_activity_log` — "what changed" reconstructed from committed graph
 * history instead of this machine's local message store.
 *
 * The local log (activity.ts) is gitignored by design: it holds verbatim request text and full
 * before/after backups, neither of which belongs in a shared repo. The cost of that decision is
 * that it is empty for everyone except the person who wrote it — a teammate who clones the repo,
 * or the same developer on a second machine, asks "what changed here lately?" and gets nothing
 * back, even though `.devmind/history/*.json` has been recording exactly that all along, committed
 * and pulled.
 *
 * This module reconstructs per-commit entries from that shared record so the answer degrades
 * instead of disappearing. It is a genuinely lossier view, and says so rather than papering over
 * the difference — see {@link GRAPH_SOURCE_CAVEATS}.
 *
 * ── How a commit is recovered ────────────────────────────────────────────────
 * History is stored per NODE, but `commitStagedChanges` hands one `reasoning` object to
 * `updateHistory` for every node in the batch, so all of them come back carrying a byte-identical
 * formatted block. Block text is therefore the primary commit identity.
 *
 * `session_id` is deliberately NOT part of that key, despite looking like the obvious
 * discriminator. The 1-hour merge writes a later block into an EXISTING row and keeps that row's
 * original session id (`writeHistoryToDisk(latest.id, …, latest.session_id, …)`), so within a
 * single commit, a node whose row already existed reports the session that created it while a node
 * getting a fresh row reports the current one. Keying on session would split one real commit in
 * two — a strictly worse error than the one it would prevent.
 *
 * What separates two commits that happen to share reasoning text is TIME. Blocks are stamped
 * inside `commitStagedChanges`'s synchronous per-node loop, so one commit's blocks land
 * milliseconds apart, while a repeat of the same text is a separate editing act minutes or hours
 * later. Grouping therefore cuts on the gap between CONSECUTIVE blocks ({@link COMMIT_CLUSTER_MS}),
 * never on total span, so a slow many-node commit stays intact however long it ran end to end.
 *
 * The irreducible ambiguity: two sessions committing byte-identical reasoning within the same
 * minute read as one commit. The shared record genuinely does not distinguish them.
 */

/**
 * Longest gap between consecutive same-reasoning blocks that still counts as one commit.
 *
 * Sized to sit far above a per-node write (milliseconds) and far below any plausible re-run of the
 * same reasoning text by a human or an agent. It bounds the gap between neighbours, never the
 * group's total duration.
 */
const COMMIT_CLUSTER_MS = 60_000;

/** Everything the shared record cannot answer, stated once and attached to any graph-backed
 * response. Callers act on this data (reverting, attributing, scoping a test pass), so the gaps
 * have to travel with it — a silently thinner entry reads as an authoritative one. */
export const GRAPH_SOURCE_CAVEATS = [
  'status is always "applied": revert state lives in the local log only, so a reverted change still appears here as applied.',
  'request is the reasoning block\'s Requirement field, not the verbatim user request — that text is never committed.',
  'files/node_ids cover only nodes tracked in the graph; whole-file edits that traced to no node are absent.',
  'developer is null for commits made before a DEVELOPER_NAME was configured.',
  'session_id names the session that created the history row, which the 1-hour merge can attribute to an earlier session than the one that wrote the change.'
];

/** How `get_activity_log` chooses its source. See the tool schema for the caller-facing wording. */
export type ActivitySourceMode = 'auto' | 'local' | 'graph' | 'both';

export interface ResolvedActivityLogResult extends ActivityLogResult {
  /** Which store(s) actually produced `entries`. */
  source: 'local' | 'graph' | 'both';
  /** True when `auto` found nothing locally and fell through to shared history. */
  fell_back: boolean;
  /** Present whenever any entry came from graph history. */
  caveats?: string[];
  /** Set when the history scan hit its row cap — more shared history exists than was read. */
  history_scan_truncated?: boolean;
}

export interface ActivityQueryOptions {
  developer?: string;
  sessionId?: string;
  sinceHours?: number;
  since?: string;
  until?: string;
  requirementContains?: string;
  limit?: number;
  /** Rows of shared history to scan before giving up. Only used on graph-backed paths. */
  historyScanLimit?: number;
}

/** Stable, content-derived id — the same commit must get the same id on every machine that pulls
 * it, which rules out a random uuid. Prefixed so a graph id is never mistaken for a local message
 * id by a caller that then tries to `readMessage` it. */
function graphEntryId(startedAt: string, blockText: string): string {
  const hash = crypto.createHash('sha1').update(`${startedAt}\n${blockText}`).digest('hex');
  return `graph:${hash.slice(0, 32)}`;
}

interface CommitGroup {
  /** Every session id this group's rows carry, first-seen order. More than one is normal — see the
   * module doc on the merge reusing an earlier row's session. */
  session_ids: string[];
  seenSessions: Set<string>;
  /** The reasoning block this group was keyed on, kept for id derivation. */
  block_text: string;
  developer: string | null;
  request: string | null;
  summary: string;
  first_at: string;
  last_at: string;
  files: string[];
  node_ids: string[];
  seenFiles: Set<string>;
  seenNodes: Set<string>;
  edit_count: number;
}

/**
 * Rebuilds per-commit activity entries from committed history.
 *
 * The date bounds are applied twice on purpose: {@link DevMindDatabase.queryHistoryForActivity}
 * over-selects rows whose accumulation span merely OVERLAPS the window (it cannot see inside the
 * blob), then each block is tested against its own timestamp here. Filtering only in SQL would
 * either drop in-window blocks appended to an older row, or admit out-of-window ones from a row
 * that stayed active — both wrong in a way the caller could not detect.
 */
export function queryGraphActivityLog(
  db: DevMindDatabase,
  opts: ActivityQueryOptions = {}
): { result: ActivityLogResult; scanTruncated: boolean } {
  const sinceIso = opts.since ?? (opts.sinceHours !== undefined
    ? new Date(Date.now() - opts.sinceHours * 3600_000).toISOString()
    : undefined);
  const scanLimit = opts.historyScanLimit ?? 5000;

  const rows = db.queryHistoryForActivity({
    sessionId: opts.sessionId,
    since: sinceIso,
    until: opts.until,
    limit: scanLimit
  });

  // Pass 1 — every in-window block, bucketed by its verbatim reasoning text.
  type BlockItem = { row: (typeof rows)[number]; at: string; parsed: TimedReasoningBlock['parsed'] };
  const byText = new Map<string, BlockItem[]>();
  for (const row of rows) {
    for (const block of parseReasoningBlocksTimed(row.reasoning, row.created_at)) {
      if (sinceIso && block.at < sinceIso) continue;
      if (opts.until && block.at > opts.until) continue;
      const item: BlockItem = { row, at: block.at, parsed: block.parsed };
      const bucket = byText.get(block.text);
      if (bucket) bucket.push(item);
      else byText.set(block.text, [item]);
    }
  }

  // Pass 2 — cut each bucket into commits wherever consecutive blocks fall more than
  // COMMIT_CLUSTER_MS apart. The ascending sort makes `last_at` a running maximum, so the gap test
  // only ever measures against the nearest earlier block, never the group's total span.
  const groups: CommitGroup[] = [];
  for (const [text, items] of byText) {
    items.sort((a, b) => a.at.localeCompare(b.at));
    let group: CommitGroup | null = null;
    for (const item of items) {
      if (!group || Date.parse(item.at) - Date.parse(group.last_at) > COMMIT_CLUSTER_MS) {
        const p = item.parsed;
        group = {
          session_ids: [], seenSessions: new Set(),
          block_text: text,
          developer: p.developer || null,
          // The closest the shared record gets to "what was asked for". The verbatim request is
          // local-only, so this is a substitute, not the same field — flagged in the caveats.
          request: p.requirement || null,
          summary: p.what_changed || p.why || p.goal || '(no summary recorded)',
          first_at: item.at,
          last_at: item.at,
          files: [], node_ids: [], seenFiles: new Set(), seenNodes: new Set(),
          edit_count: 0
        };
        groups.push(group);
      }
      group.last_at = item.at;
      if (!group.seenSessions.has(item.row.session_id)) {
        group.seenSessions.add(item.row.session_id);
        group.session_ids.push(item.row.session_id);
      }
      if (!group.seenNodes.has(item.row.node_id)) {
        group.seenNodes.add(item.row.node_id);
        group.node_ids.push(item.row.node_id);
      }
      // Null when the node was hard-deleted out from under its history. Skipped rather than
      // recorded as an empty path, but the row still counts toward edit_count: something was
      // edited, we just can no longer say in which file.
      if (item.row.file_path && !group.seenFiles.has(item.row.file_path)) {
        group.seenFiles.add(item.row.file_path);
        group.files.push(item.row.file_path);
      }
      group.edit_count++;
    }
  }

  let entries: ActivityLogEntry[] = groups.map(g => ({
    // Keyed on the group's start time as well as its text: two separate commits that share
    // reasoning must not collide on one id, and `first_at` is exactly what told them apart.
    id: graphEntryId(g.first_at, g.block_text),
    source: 'graph' as ActivitySource,
    session_id: g.session_ids[0],
    session_ids: g.session_ids,
    developer: g.developer,
    created_at: g.first_at,
    updated_at: g.last_at,
    request: g.request,
    summary: g.summary,
    // Committed history records no revert state — that is a local-log concept. Claiming anything
    // other than "applied" here would be invention; the caveats say so out loud.
    status: 'applied' as const,
    files: g.files,
    node_ids: g.node_ids,
    edit_count: g.edit_count
  }));

  // The same predicates the local path applies, over the same fields — so a filter means the same
  // thing regardless of which store answered.
  if (opts.developer) {
    const needle = opts.developer.toLowerCase();
    entries = entries.filter(e => (e.developer ?? '').toLowerCase().includes(needle));
  }
  if (opts.requirementContains) {
    const needle = opts.requirementContains.toLowerCase();
    entries = entries.filter(e =>
      (e.request ?? '').toLowerCase().includes(needle) || e.summary.toLowerCase().includes(needle));
  }

  entries.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const matched = entries.length;
  const limited = entries.slice(0, opts.limit ?? 100);

  const allFiles = new Set<string>();
  for (const e of limited) for (const f of e.files) allFiles.add(f);

  return {
    result: {
      total_messages: limited.length,
      total_matched: matched,
      all_files: Array.from(allFiles),
      entries: limited
    },
    scanTruncated: rows.length >= scanLimit
  };
}

/**
 * The single read path behind `get_activity_log` — picks a store, or merges both.
 *
 * `auto` (the default) answers from the local log and falls through to shared history only when it
 * produced nothing. That covers the case the local-only design silently failed: a teammate on a
 * fresh clone, or this developer on another machine.
 *
 * It does NOT cover the inverse, which is why `both` exists — once you have any local activity of
 * your own, `auto` stops short and you never see a teammate's work at all. `both` is the honest
 * team-wide view: local entries in full fidelity, plus shared history for every commit that did not
 * happen here.
 */
export function resolveActivityLog(
  db: DevMindDatabase,
  devmindPath: string,
  mode: ActivitySourceMode,
  opts: ActivityQueryOptions = {}
): ResolvedActivityLogResult {
  const withCaveats = (r: ResolvedActivityLogResult): ResolvedActivityLogResult =>
    r.entries.some(e => e.source === 'graph') ? { ...r, caveats: GRAPH_SOURCE_CAVEATS } : r;

  if (mode === 'local') {
    return { ...queryActivityLog(devmindPath, opts), source: 'local', fell_back: false };
  }

  if (mode === 'graph') {
    const { result, scanTruncated } = queryGraphActivityLog(db, opts);
    return withCaveats({ ...result, source: 'graph', fell_back: false, history_scan_truncated: scanTruncated });
  }

  if (mode === 'auto') {
    const local = queryActivityLog(devmindPath, opts);
    if (local.entries.length > 0) {
      return { ...local, source: 'local', fell_back: false };
    }
    const { result, scanTruncated } = queryGraphActivityLog(db, opts);
    return withCaveats({ ...result, source: 'graph', fell_back: true, history_scan_truncated: scanTruncated });
  }

  // mode === 'both'
  const local = queryActivityLog(devmindPath, opts);
  const { result: graph, scanTruncated } = queryGraphActivityLog(db, opts);
  // Read once per call, not per entry: sessions.json can gain a row while this server is running,
  // so it must not be cached across calls, but it also cannot change midway through one.
  const localSessionIds = new Set(readSessions(devmindPath).map(s => s.id));
  const me = db.getDeveloperName();
  const foreign = graph.entries.filter(e => !isOwnWork(e, localSessionIds, me));

  const merged = [...local.entries, ...foreign]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, opts.limit ?? 100);

  const allFiles = new Set<string>();
  for (const e of merged) for (const f of e.files) allFiles.add(f);

  return withCaveats({
    total_messages: merged.length,
    total_matched: local.total_matched + foreign.length,
    all_files: Array.from(allFiles),
    entries: merged,
    source: 'both',
    fell_back: false,
    history_scan_truncated: scanTruncated
  });
}

/**
 * True when a graph entry describes work that already appears in this machine's local log, and
 * would therefore be a duplicate in a merged view.
 *
 * Both conditions are required, and each covers a hole the other leaves:
 *
 * - The session must be one of THIS machine's. Sessions are minted per machine, so a teammate's id
 *   never collides. Checked against `sessions.json` rather than against the local entries actually
 *   returned, because those are already narrowed by the caller's filters — a message excluded by a
 *   date range would stop shadowing its own graph twin and the duplicate would slip through.
 *
 * - The developer must not be someone else. This is what the session test alone gets wrong: the
 *   1-hour merge stamps a block with the row's ORIGINAL session, so a teammate who pulls your
 *   history and edits the same node within the window gets their work filed under your session id.
 *   Unlike session_id, the Developer field is written per block, so it survives the merge intact.
 *
 * The asymmetry is deliberate. Failing to drop a duplicate shows your own work twice, which is
 * visible and harmless; dropping too much silently hides a teammate's commit, which is the exact
 * failure `both` exists to fix. When the two signals disagree, keep the entry.
 */
function isOwnWork(entry: ActivityLogEntry, localSessionIds: Set<string>, me: string | null): boolean {
  const ids = entry.session_ids || [entry.session_id];
  if (!ids.some(id => localSessionIds.has(id))) return false;
  // An unattributed entry on a local session is mine — nothing contradicts the session match.
  if (!entry.developer) return true;
  // A NAMED developer must actually be me. Notably not "me is unknown, so assume mine": with no
  // DEVELOPER_NAME configured there is no identity to match against, and treating every named
  // commit on a shared session as local is how a teammate's work would disappear.
  return !!me && entry.developer.toLowerCase() === me.toLowerCase();
}
