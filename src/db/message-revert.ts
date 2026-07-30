import { ActivityMessage, MessageEdit, deriveStatus, listMessages, readMessage, saveMessage } from './activity';
import { replaceTextInFile } from '../utils/edit';
import { invalidateParsedFile } from '../utils/ast';

export interface RevertOutcome {
  ok: boolean;
  /** Messages actually flipped to 'reverted' this call, oldest-affected-first. */
  reverted: string[];
  /** Set when the cascade stopped before finishing everything requested. */
  blocked_at?: { message_id: string; reason: string };
}

export interface UnrevertOutcome {
  ok: boolean;
  error?: string;
  message_id?: string;
}

/** Outcome of reverting/un-reverting one file's edits within one message. */
export interface FileRevertOutcome {
  ok: boolean;
  error?: string;
  /** Ids of the edits actually flipped this call. */
  edit_ids?: string[];
}

/** Outcome of reverting/un-reverting exactly one edit. */
export interface EditRevertOutcome {
  ok: boolean;
  error?: string;
}

/** All messages, oldest-created first — the timeline order the stack model operates over. */
function timeline(devmindPath: string): ActivityMessage[] {
  return listMessages(devmindPath).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Applies one edit's `from` -> `to` text via the same exact-match, atomic-write primitive
 * `edit_node` uses. A failure here means the file has drifted since this edit was recorded — a
 * hand-edit, a pull, a later message's edit to the same text, anything — and is reported rather
 * than forced. This exact-match requirement is also what makes file-level and single-edit revert
 * safe without any separate "is this the newest" bookkeeping: an edit whose recorded text isn't
 * uniquely present anymore simply can't be applied, whatever the reason.
 */
function applyEdit(edit: MessageEdit, from: string, to: string): { ok: boolean; error?: string } {
  if (from === to) return { ok: true }; // a no-op edit (e.g. before === after) has nothing to write
  const r = replaceTextInFile(edit.file_path, from, to, false);
  if (!r.ok) return { ok: false, error: r.error };
  invalidateParsedFile(edit.file_path);
  return { ok: true };
}

/**
 * Reverts one message's edits as a single atomic unit: newest edit first (later edits to the same
 * node were built on earlier ones, so they must come off in reverse), and if any edit can't be
 * applied, everything from this same message that DID succeed in this attempt is rolled back
 * immediately — a message is never left half-reverted by THIS call. (It can still end up
 * `partial` from an earlier, separate file/edit-level revert — this function skips edits already
 * in the target state rather than re-applying them, so it composes safely with that.)
 */
function revertOneMessageAtomically(message: ActivityMessage): { ok: boolean; error?: string } {
  const newestFirst = message.edits.slice().reverse();
  const applied: MessageEdit[] = [];

  for (const edit of newestFirst) {
    if (edit.reverted) continue; // already reverted via a granular action — nothing to do
    const r = applyEdit(edit, edit.after, edit.before);
    if (!r.ok) {
      // Undo in LIFO order — the most recently reverted edit must come off first. `applied` was
      // built newest-edit-first, so `applied[0]` was reverted first and must be un-reverted LAST;
      // reversing the array puts the most recent action first, exactly as a proper undo requires.
      for (const undo of applied.slice().reverse()) {
        applyEdit(undo, undo.before, undo.after); // best-effort; started from a known-good state
        undo.reverted = false;
      }
      return { ok: false, error: `${edit.node_id}: ${r.error}` };
    }
    edit.reverted = true;
    applied.push(edit);
  }
  return { ok: true };
}

/** Symmetric to revertOneMessageAtomically: oldest edit first, same rollback-on-failure guarantee. */
function unrevertOneMessageAtomically(message: ActivityMessage): { ok: boolean; error?: string } {
  const oldestFirst = message.edits;
  const applied: MessageEdit[] = [];

  for (const edit of oldestFirst) {
    if (!edit.reverted) continue; // already applied — nothing to restore
    const r = applyEdit(edit, edit.before, edit.after);
    if (!r.ok) {
      for (const undo of applied.slice().reverse()) {
        applyEdit(undo, undo.after, undo.before);
        undo.reverted = true;
      }
      return { ok: false, error: `${edit.node_id}: ${r.error}` };
    }
    edit.reverted = false;
    applied.push(edit);
  }
  return { ok: true };
}

/**
 * Reverts `messageId` and every message after it that isn't already fully reverted — the stack
 * model: later messages were built on top of earlier ones, so undoing one partway through the
 * stack undoes everything above it too, newest first. Stops at the first message that can't be
 * fully reverted (a drifted edit) and reports which; everything reverted before that point in
 * this call stays reverted. A `partial` message (touched by an earlier file/edit-level revert)
 * counts as "not yet fully reverted" and is swept up here too, finishing the job on it.
 */
export function revertMessage(devmindPath: string, messageId: string): RevertOutcome {
  const target = readMessage(devmindPath, messageId);
  if (!target) return { ok: false, reverted: [], blocked_at: { message_id: messageId, reason: 'message not found' } };
  if (target.status === 'reverted') {
    return { ok: false, reverted: [], blocked_at: { message_id: messageId, reason: 'already reverted' } };
  }

  const all = timeline(devmindPath);
  const targetIndex = all.findIndex(m => m.id === messageId);
  // Newest-first: everything from the end of the timeline down to (and including) the target.
  const candidates = all.slice(targetIndex).filter(m => m.status !== 'reverted').reverse();

  const reverted: string[] = [];
  for (const message of candidates) {
    const result = revertOneMessageAtomically(message);
    if (!result.ok) {
      message.status = deriveStatus(message.edits);
      saveMessage(devmindPath, message);
      return { ok: reverted.length > 0, reverted, blocked_at: { message_id: message.id, reason: result.error! } };
    }
    message.status = deriveStatus(message.edits);
    message.updated_at = new Date().toISOString();
    saveMessage(devmindPath, message);
    reverted.push(message.id);
  }

  return { ok: true, reverted };
}

/**
 * Re-applies exactly one message: the OLDEST currently-**fully**-reverted one. Un-revert restores
 * up the stack in the order things came off it — out-of-order restoration would recreate the same
 * "later edit built on code that isn't there yet" hazard the revert direction guards against, so
 * it's refused rather than attempted. A `partial` message wasn't produced by that cascade — it was
 * touched by a surgical file/edit-level revert — so it can be un-reverted independently of the
 * fully-reverted stack's ordering.
 */
export function unrevertMessage(devmindPath: string, messageId: string): UnrevertOutcome {
  const target = readMessage(devmindPath, messageId);
  if (!target) return { ok: false, error: 'message not found' };
  if (target.status === 'applied') return { ok: false, error: 'message is not reverted — nothing to restore' };

  if (target.status === 'reverted') {
    const reverted = timeline(devmindPath).filter(m => m.status === 'reverted');
    const oldest = reverted[0];
    /* istanbul ignore next -- unreachable: `target.status === 'reverted'` (just checked above) means
       `target` itself is in `timeline(devmindPath)` with status 'reverted', so `reverted` can never
       be empty here. Kept as a real guard (not just a comment) in case that invariant ever breaks. */
    if (!oldest) return { ok: false, error: 'no reverted messages found' };
    if (oldest.id !== messageId) {
      return {
        ok: false,
        error: `un-revert must restore the oldest reverted message first: "${oldest.summary}" (${oldest.id}). Restore that one before this one.`
      };
    }
  }

  const result = unrevertOneMessageAtomically(target);
  if (!result.ok) {
    target.status = deriveStatus(target.edits);
    saveMessage(devmindPath, target);
    return { ok: false, error: result.error };
  }

  target.status = deriveStatus(target.edits);
  target.updated_at = new Date().toISOString();
  saveMessage(devmindPath, target);
  return { ok: true, message_id: target.id };
}

/**
 * Reverts just the edits ONE file picked up within ONE message, leaving the message's other
 * files untouched. Newest-edit-first within that file, atomic (rolls back this operation's own
 * partial progress on failure, same as the whole-message path) — never leaves this one file
 * half-reverted, though the message as a whole is expected to end up `partial`.
 */
export function revertMessageFile(devmindPath: string, messageId: string, filePath: string): FileRevertOutcome {
  const message = readMessage(devmindPath, messageId);
  if (!message) return { ok: false, error: 'message not found' };
  const fileEdits = message.edits.filter(e => e.file_path === filePath && !e.reverted);
  if (!fileEdits.length) return { ok: false, error: 'no applied edits for this file in this message' };

  const newestFirst = fileEdits.slice().reverse();
  const applied: MessageEdit[] = [];
  for (const edit of newestFirst) {
    const r = applyEdit(edit, edit.after, edit.before);
    if (!r.ok) {
      for (const undo of applied.slice().reverse()) { applyEdit(undo, undo.before, undo.after); undo.reverted = false; }
      return { ok: false, error: `${edit.node_id}: ${r.error}` };
    }
    edit.reverted = true;
    applied.push(edit);
  }

  message.status = deriveStatus(message.edits);
  message.updated_at = new Date().toISOString();
  saveMessage(devmindPath, message);
  return { ok: true, edit_ids: applied.map(e => e.id) };
}

/** Symmetric to revertMessageFile: oldest-edit-first, same atomic rollback. */
export function unrevertMessageFile(devmindPath: string, messageId: string, filePath: string): FileRevertOutcome {
  const message = readMessage(devmindPath, messageId);
  if (!message) return { ok: false, error: 'message not found' };
  const fileEdits = message.edits.filter(e => e.file_path === filePath && e.reverted);
  if (!fileEdits.length) return { ok: false, error: 'no reverted edits for this file in this message' };

  const applied: MessageEdit[] = [];
  for (const edit of fileEdits) {
    const r = applyEdit(edit, edit.before, edit.after);
    if (!r.ok) {
      for (const undo of applied.slice().reverse()) { applyEdit(undo, undo.after, undo.before); undo.reverted = true; }
      return { ok: false, error: `${edit.node_id}: ${r.error}` };
    }
    edit.reverted = false;
    applied.push(edit);
  }

  message.status = deriveStatus(message.edits);
  message.updated_at = new Date().toISOString();
  saveMessage(devmindPath, message);
  return { ok: true, edit_ids: applied.map(e => e.id) };
}

/**
 * Reverts exactly ONE edit, identified by its stable `id`, regardless of what else in the message
 * or file is applied. Safe by construction: if a later edit (to the same node, in this message or
 * a later one) already changed this text further, this edit's `after` string won't be found on
 * disk anymore and the exact-match guard in applyEdit refuses rather than guessing.
 */
export function revertMessageEdit(devmindPath: string, messageId: string, editId: string): EditRevertOutcome {
  const message = readMessage(devmindPath, messageId);
  if (!message) return { ok: false, error: 'message not found' };
  const edit = message.edits.find(e => e.id === editId);
  if (!edit) return { ok: false, error: 'edit not found in this message' };
  if (edit.reverted) return { ok: false, error: 'already reverted' };

  const r = applyEdit(edit, edit.after, edit.before);
  if (!r.ok) return { ok: false, error: r.error };

  edit.reverted = true;
  message.status = deriveStatus(message.edits);
  message.updated_at = new Date().toISOString();
  saveMessage(devmindPath, message);
  return { ok: true };
}

/** Symmetric to revertMessageEdit. */
export function unrevertMessageEdit(devmindPath: string, messageId: string, editId: string): EditRevertOutcome {
  const message = readMessage(devmindPath, messageId);
  if (!message) return { ok: false, error: 'message not found' };
  const edit = message.edits.find(e => e.id === editId);
  if (!edit) return { ok: false, error: 'edit not found in this message' };
  if (!edit.reverted) return { ok: false, error: 'not reverted' };

  const r = applyEdit(edit, edit.before, edit.after);
  if (!r.ok) return { ok: false, error: r.error };

  edit.reverted = false;
  message.status = deriveStatus(message.edits);
  message.updated_at = new Date().toISOString();
  saveMessage(devmindPath, message);
  return { ok: true };
}
