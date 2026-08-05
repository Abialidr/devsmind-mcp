import { DevMindDatabase } from './database';
import { removeLastStagedEntry, readStaged } from './staging';
import { replaceTextInFile } from '../utils/edit';
import { invalidateParsedFile } from '../utils/ast';

export interface RevertResult {
  ok: boolean;
  error?: string;
  node_id?: string;
  file_path?: string;
  /** True when the change was still staged, so there was no recorded history to unwind. */
  was_staged?: boolean;
  entry_deleted?: boolean;
  /** Set when the code was restored but the history entry could not be fully removed. */
  note?: string;
}

/**
 * Undoes the most recent recorded edit to one entity: restores the file, then erases what was
 * written about it.
 *
 * Only the newest edit is reversible. An older one cannot be undone in isolation — every edit
 * after it was made against the code it produced, so putting its "before" back would overwrite
 * work that has nothing to do with it. Git is the tool for that, and it already does it properly.
 *
 * `expectedHistoryId`, when given, is the specific entry the caller intended to revert (e.g. the
 * one a "Revert this change" button was clicked on). It must match the node's actual latest entry
 * — if it doesn't (a newer entry was recorded since, perhaps from another session), the revert is
 * refused rather than silently reverting that newer entry instead, which would undo the wrong
 * change from the caller's point of view.
 *
 * The file is restored by swapping the recorded `after` back to the recorded `before`, which
 * routes through the same exact-match write `edit_node` uses: if that text is no longer uniquely
 * present, the write is refused rather than guessed at.
 */
export function revertLastEdit(db: DevMindDatabase, devmindPath: string, nodeId: string, expectedHistoryId?: string): RevertResult {
  const node = db.getNode(nodeId);
  const resolvedId = node ? node.id : nodeId;

  // Staged edits are the newest thing that happened, and were never recorded — undo those first,
  // or a revert would restore the file underneath a staged entry still waiting to be committed.
  const staged = readStaged(devmindPath).filter(e => e.node_id === resolvedId);
  if (staged.length) {
    const last = staged[staged.length - 1];
    if (last.code_before === undefined) {
      return { ok: false, error: `The staged change to ${resolvedId} has no recorded before-state, so it cannot be undone here. Use git to restore the file.` };
    }
    const restored = restoreFile(last.file_path, last.code_snapshot, last.code_before ?? '');
    if (!restored.ok) return { ok: false, error: restored.error, node_id: resolvedId, file_path: last.file_path };
    removeLastStagedEntry(devmindPath, resolvedId);
    return { ok: true, node_id: resolvedId, file_path: last.file_path, was_staged: true };
  }

  const entry = db.getLatestHistory(resolvedId);
  if (!entry) return { ok: false, error: `No history recorded for ${resolvedId} — nothing to revert.` };
  if (expectedHistoryId && entry.id !== expectedHistoryId) {
    return {
      ok: false,
      error: `A newer change to ${resolvedId} was recorded since this one — reverting it would undo that newer change instead. Refresh and revert the newest entry, or use git.`,
      node_id: resolvedId
    };
  }
  if (!entry.edits.length) {
    return {
      ok: false,
      error: `The last change to ${resolvedId} was recorded without a before-state, so there is nothing to restore it to. Entries written before edit_node tracked diffs, and legacy update_history / initial index snapshots, are both like this. Use git to restore the file.`
    };
  }

  const last = entry.edits[entry.edits.length - 1];
  if (!node) return { ok: false, error: `${resolvedId} has history but no node in the graph — cannot locate its file.` };

  // The recorded `after` must still be what is on disk. If it isn't, the code moved on after this
  // edit and restoring `before` would silently discard whatever came since.
  const live = db.getLiveCode(resolvedId);
  if (live.source !== 'live' || live.code === undefined) {
    return {
      ok: false,
      error: `Could not read ${resolvedId} from disk to confirm what is there now (the symbol may have been renamed, moved, or deleted). Revert refused — use git.`,
      node_id: resolvedId
    };
  }
  if (live.code !== last.after) {
    return {
      ok: false,
      error: `${resolvedId} has changed since that edit was recorded — reverting would discard the newer change. Revert refused; use git to restore the file.`,
      node_id: resolvedId,
      file_path: node.file_path
    };
  }

  const restored = restoreFile(node.file_path, last.after, last.before);
  if (!restored.ok) return { ok: false, error: restored.error, node_id: resolvedId, file_path: node.file_path };

  const erased = db.eraseLastEdit(entry.id);
  return {
    ok: true,
    node_id: resolvedId,
    file_path: node.file_path,
    entry_deleted: erased.entry_deleted,
    note: erased.entry_deleted ? undefined : erased.reason
  };
}

/**
 * Swaps `after` back to `before` in the file.
 *
 * `before` is empty when the edit created the entity, so the revert deletes it — which is the
 * correct inverse, and the one case where the two strings could not both be present.
 */
function restoreFile(filePath: string, after: string, before: string): { ok: boolean; error?: string } {
  const paths = String(filePath).split(',').map(s => s.trim()).filter(Boolean);
  const target = paths[0];
  if (!target) return { ok: false, error: 'no file path recorded for this entity' };

  const r = replaceTextInFile(target, after, before, false);
  if (!r.ok) return { ok: false, error: `could not restore ${target}: ${r.error}` };
  invalidateParsedFile(target);
  return { ok: true };
}
