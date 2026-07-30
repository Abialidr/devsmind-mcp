import * as fs from 'fs';
import { MessageEdit } from './activity';
import { diffSnapshots, DiffLine } from '../utils/diff';

export interface FileDiffResult {
  file_path: string;
  before_file: string;
  after_file: string;
  hunks: DiffLine[];
  drifted: boolean;
  drift_reason?: string;
}

/**
 * Same single-occurrence exact-match semantics as replaceTextInFile (src/utils/edit.ts), but
 * in-memory and read-only — no disk write, no atomic-rename. Returns null (rather than throwing)
 * when `oldString` isn't found exactly once, so the caller can treat that as drift.
 */
function replaceOnce(content: string, oldString: string, newString: string): string | null {
  if (oldString === newString) return content; // a no-op edit (before === after) has nothing to undo
  if (oldString === '') return null; // no anchor to locate — can't undo an insertion blind
  let count = 0;
  for (let i = content.indexOf(oldString); i !== -1; i = content.indexOf(oldString, i + oldString.length)) {
    count++;
    if (count > 1) break;
  }
  if (count !== 1) return null;
  const i = content.indexOf(oldString);
  return content.slice(0, i) + newString + content.slice(i + oldString.length);
}

/**
 * Reconstructs the whole-file "before" state for one file's worth of edits from a single
 * activity message, by undoing each edit's `after -> before` in memory, newest-first — the same
 * ordering `revertOneMessageAtomically` (message-revert.ts) uses when it does this for real on
 * disk. `fileEdits` must already be filtered to one file_path, in chronological (oldest-first)
 * order, matching how they appear in `ActivityMessage.edits`.
 *
 * Drift (a hand-edit, a pull, a later message touching the same text) means some `after` snippet
 * no longer matches the file uniquely — reported rather than guessed at, same as revert refuses
 * rather than forcing a mismatched restore.
 */
export function reconstructBeforeFile(liveContent: string, fileEdits: MessageEdit[]): { before: string; drifted: boolean } {
  const newestFirst = fileEdits.slice().reverse();
  let content = liveContent;
  for (const edit of newestFirst) {
    const undone = replaceOnce(content, edit.after, edit.before);
    if (undone === null) return { before: content, drifted: true };
    content = undone;
  }
  return { before: content, drifted: false };
}

/**
 * Collapses every edit a message made to ONE file into a single git-style whole-file diff,
 * reading the live file off disk as the "after" state. On drift, the reconstruction is not
 * trustworthy — the caller should fall back to the per-node `diffSnapshots(before, after)` for
 * this file instead of rendering a wrong whole-file diff.
 */
export function fileDiffForMessage(filePath: string, fileEdits: MessageEdit[]): FileDiffResult {
  let live: string;
  try {
    live = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { file_path: filePath, before_file: '', after_file: '', hunks: [], drifted: true, drift_reason: 'file no longer exists on disk' };
  }

  const { before, drifted } = reconstructBeforeFile(live, fileEdits);
  if (drifted) {
    return {
      file_path: filePath,
      before_file: before,
      after_file: live,
      hunks: [],
      drifted: true,
      drift_reason: 'file has changed since this message was recorded — showing per-change diffs instead'
    };
  }

  return { file_path: filePath, before_file: before, after_file: live, hunks: diffSnapshots(before, live, 8), drifted: false };
}
