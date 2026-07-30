import * as fs from 'fs';
import * as path from 'path';
import { DevMindDatabase, ReasoningObject } from './database';
import { resolveEdgesForNodes } from './edges';
import { embedTextsInt8, hashDescription } from './embedder';

const STAGING_FILE = 'history_scratchpad.json';

/** One staged change — the same payload as update_history, buffered for a later commit. */
export interface StagedEntry {
  node_id: string;
  file_path: string;
  code_snapshot: string;
  /**
   * The entity's text before this edit. Only `edit_node` can supply it (it holds the pre-edit
   * file); `stage_change` takes a snapshot with nothing to diff against and leaves it undefined.
   * Absent means the entry gets no diff and no revert.
   */
  code_before?: string | null;
  name?: string;
  type?: string;
  signature?: string;
  /**
   * A 1-3 sentence natural-language description of what this entity does. `commit_changes`
   * refuses to create a node that has never had one before (see `add_description`) — but an
   * ordinary edit to an already-described node can leave this unset; `upsertNode`'s COALESCE
   * means the existing description survives untouched.
   */
  description?: string;
  session_id?: string;
  /** Optional explicit edges to add on top of AST resolution (source defaults to this entry). */
  connections?: { source_node_id?: string; target_node_id: string }[];
  /**
   * When this was staged — set automatically by `stageEntry`, not by the caller. A file can pick
   * up both a traced node-level entry and an untraced whole-file entry (StagedFileEdit) across
   * separate edit_node calls before one commit; the activity message's edits must interleave the
   * two in true chronological order for that file's whole-file reconstruction to undo cleanly, so
   * this is the sort key `commit_changes` uses.
   */
  staged_at?: string;
}

/**
 * A whole-file edit that didn't trace to any graph node — a non-code file (CSS, XML, JSON, ...)
 * or a code edit landing outside any function/class (an import line, a top-level constant). The
 * graph has nothing to hold for these, but the local activity log still can: `commit_changes`
 * folds these into the same message as any traced node edits, so every file `edit_node` touches
 * shows up and is individually revertable there, not just the ones that became graph nodes.
 */
export interface StagedFileEdit {
  file_path: string;
  before: string;
  after: string;
  session_id?: string;
  /** When this was staged — set automatically by `stageFileEdit`. See StagedEntry.staged_at. */
  staged_at?: string;
}

interface StagingBuffer {
  entries: StagedEntry[];
  file_edits: StagedFileEdit[];
  updated_at: string;
}

function stagingPath(devmindPath: string): string {
  return path.join(path.resolve(devmindPath), STAGING_FILE);
}

function readBuffer(devmindPath: string): StagingBuffer {
  try {
    const raw = fs.readFileSync(stagingPath(devmindPath), 'utf-8');
    const buf = JSON.parse(raw) as Partial<StagingBuffer>;
    return {
      entries: Array.isArray(buf.entries) ? buf.entries : [],
      file_edits: Array.isArray(buf.file_edits) ? buf.file_edits : [],
      updated_at: buf.updated_at || new Date().toISOString()
    };
  } catch {
    return { entries: [], file_edits: [], updated_at: new Date().toISOString() };
  }
}

/** Atomic write (temp file + rename) so an accumulating buffer is never left half-written. */
function writeBuffer(devmindPath: string, buf: StagingBuffer): void {
  const target = stagingPath(devmindPath);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(buf, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

export function readStaged(devmindPath: string): StagedEntry[] {
  return readBuffer(devmindPath).entries;
}

export function readStagedFileEdits(devmindPath: string): StagedFileEdit[] {
  return readBuffer(devmindPath).file_edits;
}

/**
 * An entry with no `session_id` predates this field (a buffer written before session-scoping
 * existed) — there is no session left to ever reclaim it, so it is treated as belonging to
 * whoever commits next rather than staying stranded in the buffer forever. Anything stamped
 * with a DIFFERENT session's id is a genuinely different in-flight task and must not be swept
 * up by someone else's commit.
 */
function belongsToSession<T extends { session_id?: string }>(item: T, sessionId: string): boolean {
  return !item.session_id || item.session_id === sessionId;
}

export interface SessionStagingPartition {
  entries: StagedEntry[];
  fileEdits: StagedFileEdit[];
  /** Count of staged entries/file edits left behind because another session owns them. */
  otherSessionsPending: number;
}

/**
 * Splits the shared buffer into "what this session may commit" vs. "left behind" — the fix for
 * the multi-session bug where `commit_changes` used to flush the ENTIRE buffer regardless of who
 * staged what, silently pulling unrelated in-flight work (sometimes from other repos entirely)
 * into a commit and stamping it with the committing session's reasoning. A plain commit now only
 * ever touches its own session's staged work; other sessions' entries stay staged untouched.
 */
export function partitionStagedForSession(devmindPath: string, sessionId: string): SessionStagingPartition {
  const buf = readBuffer(devmindPath);
  const entries = buf.entries.filter(e => belongsToSession(e, sessionId));
  const fileEdits = buf.file_edits.filter(e => belongsToSession(e, sessionId));
  const otherSessionsPending = (buf.entries.length - entries.length) + (buf.file_edits.length - fileEdits.length);
  return { entries, fileEdits, otherSessionsPending };
}

/**
 * Removes only this session's staged entries/file edits, leaving any other session's pending
 * work in place — the scoped counterpart to `clearStaged`, which used to wipe the whole buffer
 * (including work another session had not committed yet) after every commit.
 */
export function clearStagedForSession(devmindPath: string, sessionId: string): void {
  const buf = readBuffer(devmindPath);
  const entries = buf.entries.filter(e => !belongsToSession(e, sessionId));
  const file_edits = buf.file_edits.filter(e => !belongsToSession(e, sessionId));
  if (entries.length || file_edits.length) {
    writeBuffer(devmindPath, { entries, file_edits, updated_at: new Date().toISOString() });
  } else {
    clearStaged(devmindPath);
  }
}

/** Appends one entry to the buffer (stamping `staged_at`) and returns the new pending count. */
export function stageEntry(devmindPath: string, entry: StagedEntry): number {
  const buf = readBuffer(devmindPath);
  buf.entries.push({ ...entry, staged_at: entry.staged_at || new Date().toISOString() });
  buf.updated_at = new Date().toISOString();
  writeBuffer(devmindPath, buf);
  return buf.entries.length;
}

/** Appends one whole-file edit to the buffer (stamping `staged_at`) and returns the new pending count. */
export function stageFileEdit(devmindPath: string, edit: StagedFileEdit): number {
  const buf = readBuffer(devmindPath);
  buf.file_edits.push({ ...edit, staged_at: edit.staged_at || new Date().toISOString() });
  buf.updated_at = new Date().toISOString();
  writeBuffer(devmindPath, buf);
  return buf.file_edits.length;
}

/**
 * Replaces the buffer's entries wholesale, keeping `file_edits` untouched — used by
 * `add_description` to persist a description written onto an already-staged entry (e.g. after
 * a `commit_changes` rejection), since `readStaged` returns a fresh array each call and
 * mutating it in memory has no effect until it's written back.
 */
export function overwriteStaged(devmindPath: string, entries: StagedEntry[]): void {
  const buf = readBuffer(devmindPath);
  buf.entries = entries;
  buf.updated_at = new Date().toISOString();
  writeBuffer(devmindPath, buf);
}

export function clearStaged(devmindPath: string): void {
  const target = stagingPath(devmindPath);
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch { /* ignore */ }
}

/**
 * Drops the newest staged entry for one node and returns it, or null if the node has none.
 *
 * Newest rather than all: the buffer can hold several edits to the same entity, and reverting is
 * an undo of the last one. An entry removed here was never committed, so nothing else has to be
 * unwound — there is no history row yet for it to have written.
 */
export function removeLastStagedEntry(devmindPath: string, nodeId: string): StagedEntry | null {
  const buf = readBuffer(devmindPath);
  const idx = buf.entries.map(e => e.node_id).lastIndexOf(nodeId);
  if (idx === -1) return null;
  const [removed] = buf.entries.splice(idx, 1);
  if (buf.entries.length || buf.file_edits.length) {
    buf.updated_at = new Date().toISOString();
    writeBuffer(devmindPath, buf);
  } else {
    clearStaged(devmindPath);
  }
  return removed;
}

/** Resolves an entry's raw node_id to the canonical `{repo}/relpath#symbol` form. Exported so
 * the commit_changes gate can check "does this node already exist" using the exact same
 * canonicalization commitStagedChanges itself uses — a mismatch there would let a node the
 * gate thinks is new slip through uncommitted, or block one that's actually already described. */
export function resolveEntryId(db: DevMindDatabase, entry: StagedEntry): string {
  if (entry.node_id.includes('#')) return entry.node_id;
  const repoRelPath = db.toRepoRelativePath(entry.file_path);
  return `${repoRelPath}#${entry.node_id}`;
}

export interface CommitSummary {
  nodes: number;
  history_entries: number;
  edges_added: number;
  missing_filled: number;
  history_ids: string[];
  node_ids: string[];
}

/**
 * Two-pass commit of a batch of staged changes:
 *   Pass 1 — upsert every node + write its history entry (so all nodes exist before any edge
 *            resolution; forward references within the batch resolve regardless of order).
 *   Pass 2 — clear-then-resolve each staged node's OUTGOING edges via the local AST resolver,
 *            auto-creating any missing target nodes. Only the staged nodes' own outbound edges
 *            are recomputed; every other node's edges are left intact.
 *
 * `reasoning` is ONE object covering the whole batch — every entry in one commit serves one
 * request, so it is asked for once here rather than repeated on every staged entry. Kept as an
 * object (not pre-formatted) all the way to `updateHistory`, since the configured-developer
 * override only fires on the object form.
 *
 * Idempotent: re-running the same batch yields the same graph (upsert + INSERT OR IGNORE +
 * clear-then-resolve). Callers should clear the buffer only after this returns successfully.
 */
export async function commitStagedChanges(
  db: DevMindDatabase,
  devmindPath: string,
  entries: StagedEntry[],
  reasoning: string | ReasoningObject
): Promise<CommitSummary> {
  const stagedIds: string[] = [];
  const historyIds: string[] = [];

  // Pass 1 — nodes + history (+ any explicit connections the caller supplied).
  const explicitEdges: { source: string; target: string }[] = [];
  const toEmbed: { node_id: string; description: string }[] = [];
  for (const entry of entries) {
    const nodeId = resolveEntryId(db, entry);
    stagedIds.push(nodeId);

    const name = entry.name || (entry.node_id.includes('.') ? entry.node_id.split('.').pop()! : entry.node_id);
    const type = entry.type || (entry.node_id.includes('.') ? 'method' : 'function');

    db.upsertNode({
      id: nodeId,
      name,
      type,
      file_path: entry.file_path,
      signature: entry.signature || null,
      description: entry.description || null
    });
    if (entry.description) toEmbed.push({ node_id: nodeId, description: entry.description });
    const history = db.updateHistory({
      node_id: nodeId,
      code_snapshot: entry.code_snapshot,
      code_before: entry.code_before,
      reasoning,
      session_id: entry.session_id
    });
    historyIds.push(history.id);

    for (const c of entry.connections || []) {
      if (c.target_node_id) explicitEdges.push({ source: c.source_node_id || nodeId, target: c.target_node_id });
    }
  }

  // Batched, not per-entry — this is where a STAGED description (from stage_change, or from
  // add_description filling in a gate rejection) first has somewhere to actually store a vector.
  // No-op (embedTextsInt8 returns null) if the optional ONNX dependency is unavailable; those
  // nodes just fall into the `devsmind embed` queue like any other unembedded description.
  if (toEmbed.length > 0) {
    const vectors = await embedTextsInt8(toEmbed.map(t => t.description));
    if (vectors) {
      for (let i = 0; i < toEmbed.length; i++) {
        db.upsertNodeVector(toEmbed[i].node_id, vectors[i], hashDescription(toEmbed[i].description));
      }
    }
  }

  // Pass 2 — AST edge resolution for the batch (clear stale outbound edges of staged nodes first).
  const { edgesAdded, missingFilled } = resolveEdgesForNodes(db, devmindPath, stagedIds, { clearSources: true });

  // Apply any explicit edges the caller passed, on top of AST resolution (additive).
  for (const e of explicitEdges) {
    db.addConnection(e.source, e.target);
  }

  return {
    nodes: entries.length,
    history_entries: entries.length,
    edges_added: edgesAdded + explicitEdges.length,
    missing_filled: missingFilled,
    history_ids: historyIds,
    node_ids: stagedIds
  };
}

/** Builds a short workflow-step/activity summary for a commit. The commit's own `reasoning`
 * (one object covering the whole batch) is authoritative when it has a `what_changed`; falls
 * back to naming the staged entities for a bare-string reasoning. */
export function summarizeEntriesForWorkflow(entries: StagedEntry[], reasoning: string | ReasoningObject): string {
  if (typeof reasoning === 'object' && reasoning.what_changed) return reasoning.what_changed;
  const bits = entries.map(e => e.node_id);
  return bits.length === 1 ? bits[0] : `${bits.length} entities updated: ${bits.join('; ')}`;
}
