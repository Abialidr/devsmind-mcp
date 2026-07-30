import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  revertMessage,
  unrevertMessage,
  revertMessageFile,
  unrevertMessageFile,
  revertMessageEdit,
  unrevertMessageEdit
} from '../../src/db/message-revert';
import { recordMessage, readMessage, saveMessage, MessageEdit } from '../../src/db/activity';

/**
 * message-revert.ts operates on real files on disk (via replaceTextInFile's exact-match guard),
 * so these tests use a real temp directory rather than mocking fs — same approach as
 * tests/db/revert.test.ts. `devmindPath` holds the `.devmind/local/` message store; `repoDir`
 * holds the "source" files the recorded edits point at.
 */
function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-msgrevert-'));
}

/** Builds a MessageEdit input for recordMessage, omitting `id` so recordMessage mints one —
 * mirrors the `as MessageEdit` cast pattern used in tests/db/activity.fs.test.ts. */
function editInput(overrides: { file_path: string; before: string; after: string; node_id?: string }): MessageEdit {
  return {
    node_id: overrides.node_id ?? 'node',
    file_path: overrides.file_path,
    at: new Date().toISOString(),
    before: overrides.before,
    after: overrides.after
  } as MessageEdit;
}

describe('message-revert.ts', () => {
  let root: string;
  let devmindPath: string;
  let repoDir: string;

  beforeEach(() => {
    root = mkTempRoot();
    devmindPath = path.join(root, '.devmind');
    repoDir = path.join(root, 'repo');
    fs.mkdirSync(devmindPath, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('revertMessage — cascade', () => {
    it('reverting the oldest of 3 messages also reverts the later, non-reverted ones', () => {
      const filePath = path.join(repoDir, 'a.ts');
      const v0 = 'export const a = 0;\n';
      const v1 = 'export const a = 1;\n';
      const v2 = 'export const a = 2;\n';
      const v3 = 'export const a = 3;\n';

      // Each edit is applied to disk first (as edit_node would), then recorded — same convention
      // as tests/db/revert.test.ts. No `request` is passed, so each recordMessage call starts a
      // brand-new message (per recordMessage's documented "no request -> one message per call").
      fs.writeFileSync(filePath, v0);
      fs.writeFileSync(filePath, v1);
      const msgA = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'A', edits: [editInput({ file_path: filePath, before: v0, after: v1 })]
      });

      fs.writeFileSync(filePath, v2);
      const msgB = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'B', edits: [editInput({ file_path: filePath, before: v1, after: v2 })]
      });

      fs.writeFileSync(filePath, v3);
      const msgC = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'C', edits: [editInput({ file_path: filePath, before: v2, after: v3 })]
      });

      // Sanity: all three start out applied, file at v3.
      expect(readMessage(devmindPath, msgA.id)!.status).toBe('applied');
      expect(readMessage(devmindPath, msgB.id)!.status).toBe('applied');
      expect(readMessage(devmindPath, msgC.id)!.status).toBe('applied');

      const result = revertMessage(devmindPath, msgA.id);

      expect(result.ok).toBe(true);
      expect(result.blocked_at).toBeUndefined();
      // All three messages were flipped this call — A alone was requested, but B and C (built on
      // top of it) had to come off too.
      expect(new Set(result.reverted)).toEqual(new Set([msgA.id, msgB.id, msgC.id]));
      expect(result.reverted).toHaveLength(3);

      expect(readMessage(devmindPath, msgA.id)!.status).toBe('reverted');
      expect(readMessage(devmindPath, msgB.id)!.status).toBe('reverted');
      expect(readMessage(devmindPath, msgC.id)!.status).toBe('reverted');

      // Edits undone newest-first, all the way back to the pre-A state.
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v0);
    });

    it('reverting a middle message only cascades from there upward, leaving earlier messages untouched', () => {
      const filePath = path.join(repoDir, 'a.ts');
      const v0 = 'export const a = 0;\n';
      const v1 = 'export const a = 1;\n';
      const v2 = 'export const a = 2;\n';

      fs.writeFileSync(filePath, v0);
      fs.writeFileSync(filePath, v1);
      const msgA = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'A', edits: [editInput({ file_path: filePath, before: v0, after: v1 })]
      });
      fs.writeFileSync(filePath, v2);
      const msgB = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'B', edits: [editInput({ file_path: filePath, before: v1, after: v2 })]
      });

      const result = revertMessage(devmindPath, msgB.id);
      expect(result.ok).toBe(true);
      expect(result.reverted).toEqual([msgB.id]);
      expect(readMessage(devmindPath, msgA.id)!.status).toBe('applied');
      expect(readMessage(devmindPath, msgB.id)!.status).toBe('reverted');
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v1);
    });

    it('reports blocked_at and leaves the message untouched when the message id does not exist', () => {
      const result = revertMessage(devmindPath, 'nope');
      expect(result.ok).toBe(false);
      expect(result.reverted).toEqual([]);
      expect(result.blocked_at).toEqual({ message_id: 'nope', reason: 'message not found' });
    });

    it('rolls back the whole message atomically when a later edit in the SAME message fails mid-cascade, and reports blocked_at', () => {
      // A message's edits are trusted to chain (edit[n].before === edit[n-1].after) but nothing
      // enforces that when the caller builds them by hand — here they deliberately DON'T chain at
      // the seam between them (older.after !== newer.before), so reverting the newest edit
      // succeeds, but reverting the older one then fails: its recorded "after" text isn't what's
      // actually on disk once the newest edit came off. revertOneMessageAtomically must undo its
      // own already-applied step and leave nothing half-reverted.
      const filePath = path.join(repoDir, 'a.ts');
      const v0 = 'export const a = 0;\n';
      const v2 = 'export const a = 2;\n';
      const chainBreakA = 'export const a = "chain-break-A";\n'; // older's recorded "after" — never actually written
      const chainBreakB = 'export const a = "chain-break-B";\n'; // newer's recorded "before"

      fs.writeFileSync(filePath, v2);
      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'inconsistent chain',
        edits: [
          editInput({ file_path: filePath, before: v0, after: chainBreakA, node_id: 'older' }),
          editInput({ file_path: filePath, before: chainBreakB, after: v2, node_id: 'newer' })
        ]
      });

      const result = revertMessage(devmindPath, msg.id);
      expect(result.ok).toBe(false);
      expect(result.reverted).toEqual([]);
      expect(result.blocked_at?.message_id).toBe(msg.id);
      expect(result.blocked_at?.reason).toContain('older');

      // File restored to its pre-attempt state (v2) — the successful newest-edit revert to
      // chainBreakB was undone once the older edit's revert failed.
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v2);
      // Neither edit ends up flagged reverted.
      const saved = readMessage(devmindPath, msg.id)!;
      expect(saved.edits.every(e => !e.reverted)).toBe(true);
      expect(saved.status).toBe('applied');
    });

    it('refuses to revert an already-reverted message', () => {
      const filePath = path.join(repoDir, 'a.ts');
      const v0 = 'export const a = 0;\n';
      const v1 = 'export const a = 1;\n';
      fs.writeFileSync(filePath, v0);
      fs.writeFileSync(filePath, v1);
      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'A', edits: [editInput({ file_path: filePath, before: v0, after: v1 })]
      });
      expect(revertMessage(devmindPath, msg.id).ok).toBe(true);

      const second = revertMessage(devmindPath, msg.id);
      expect(second.ok).toBe(false);
      expect(second.blocked_at).toEqual({ message_id: msg.id, reason: 'already reverted' });
    });

    it('a no-op edit (before === after) reverts as a trivial success — nothing to write', () => {
      const filePath = path.join(repoDir, 'a.ts');
      const same = 'export const a = 0;\n';
      fs.writeFileSync(filePath, same);
      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'no-op', edits: [editInput({ file_path: filePath, before: same, after: same })]
      });

      const result = revertMessage(devmindPath, msg.id);
      expect(result.ok).toBe(true);
      expect(result.reverted).toEqual([msg.id]);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(same);
      expect(readMessage(devmindPath, msg.id)!.status).toBe('reverted');
    });

    it('skips an edit already reverted via a granular action, reverting only the rest of the message', () => {
      const fileA = path.join(repoDir, 'a.ts');
      const fileB = path.join(repoDir, 'b.ts');
      const a0 = 'export const a = 0;\n';
      const a1 = 'export const a = 1;\n';
      const b0 = 'export const b = 0;\n';
      const b1 = 'export const b = 1;\n';
      fs.writeFileSync(fileA, a0);
      fs.writeFileSync(fileB, b0);
      fs.writeFileSync(fileA, a1);
      const msg1 = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'A', edits: [editInput({ file_path: fileA, before: a0, after: a1 })]
      });
      fs.writeFileSync(fileB, b1);
      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, message_id: msg1.id, summary: 'B',
        edits: [editInput({ file_path: fileB, before: b0, after: b1 })]
      });
      const [editA, editB] = msg.edits;

      // Granularly revert just editA first — message goes to 'partial'.
      expect(revertMessageEdit(devmindPath, msg.id, editA.id).ok).toBe(true);
      expect(readMessage(devmindPath, msg.id)!.status).toBe('partial');

      // Now revert the whole message — revertOneMessageAtomically's newest-first loop hits editA
      // (already reverted) and must skip it via `continue` rather than re-applying, while still
      // reverting editB.
      const result = revertMessage(devmindPath, msg.id);
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(fileA, 'utf-8')).toBe(a0);
      expect(fs.readFileSync(fileB, 'utf-8')).toBe(b0);
      const saved = readMessage(devmindPath, msg.id)!;
      expect(saved.edits.every(e => e.reverted)).toBe(true);
      expect(saved.status).toBe('reverted');
    });
  });

  describe('unrevertMessage — stack-order enforcement', () => {
    function threeMessageStack() {
      const filePath = path.join(repoDir, 'a.ts');
      const v0 = 'export const a = 0;\n';
      const v1 = 'export const a = 1;\n';
      const v2 = 'export const a = 2;\n';
      const v3 = 'export const a = 3;\n';

      fs.writeFileSync(filePath, v0);
      fs.writeFileSync(filePath, v1);
      const msgA = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'A', edits: [editInput({ file_path: filePath, before: v0, after: v1 })]
      });
      fs.writeFileSync(filePath, v2);
      const msgB = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'B', edits: [editInput({ file_path: filePath, before: v1, after: v2 })]
      });
      fs.writeFileSync(filePath, v3);
      const msgC = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'C', edits: [editInput({ file_path: filePath, before: v2, after: v3 })]
      });

      // Revert the whole stack (cascade), so all three are 'reverted' and file is back at v0.
      const revertResult = revertMessage(devmindPath, msgA.id);
      expect(revertResult.ok).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v0);

      return { filePath, v0, v1, v2, v3, msgA, msgB, msgC };
    }

    it('refuses to un-revert a newer message before the oldest reverted one, then succeeds in order', () => {
      const { filePath, v1, v2, v3, msgA, msgB, msgC } = threeMessageStack();

      // Newest first: must be refused — oldest reverted message (A) has to come back first.
      const refusedC = unrevertMessage(devmindPath, msgC.id);
      expect(refusedC.ok).toBe(false);
      expect(refusedC.error).toMatch(/oldest reverted message first/);
      expect(refusedC.error).toContain(msgA.id);
      // Refusal must not touch the file or state.
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('export const a = 0;\n');
      expect(readMessage(devmindPath, msgC.id)!.status).toBe('reverted');

      // Also refuses the middle one for the same reason.
      const refusedB = unrevertMessage(devmindPath, msgB.id);
      expect(refusedB.ok).toBe(false);
      expect(refusedB.error).toContain(msgA.id);

      // Restoring the oldest (A) succeeds.
      const okA = unrevertMessage(devmindPath, msgA.id);
      expect(okA.ok).toBe(true);
      expect(okA.message_id).toBe(msgA.id);
      expect(readMessage(devmindPath, msgA.id)!.status).toBe('applied');
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v1);

      // C is still blocked — now B is the oldest reverted message.
      const stillRefusedC = unrevertMessage(devmindPath, msgC.id);
      expect(stillRefusedC.ok).toBe(false);
      expect(stillRefusedC.error).toContain(msgB.id);

      // Restoring B (now the oldest reverted) succeeds.
      const okB = unrevertMessage(devmindPath, msgB.id);
      expect(okB.ok).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v2);

      // Now C can finally be restored.
      const okC = unrevertMessage(devmindPath, msgC.id);
      expect(okC.ok).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v3);
      expect(readMessage(devmindPath, msgC.id)!.status).toBe('applied');
    });

    it('rolls back atomically when a later edit fails mid-unrevert, restoring the reverted state', () => {
      // Symmetric to the revertMessage rollback test above: un-revert oldest-first, older
      // succeeds, newer fails (broken chain at the seam), so unrevertOneMessageAtomically must
      // undo the older edit's just-applied restoration and leave both edits marked reverted.
      const filePath = path.join(repoDir, 'a.ts');
      const v0 = 'export const a = 0;\n';
      const v2 = 'export const a = 2;\n';
      const chainBreakA = 'export const a = "chain-break-A";\n'; // older's recorded "after"
      const chainBreakB = 'export const a = "chain-break-B";\n'; // newer's recorded "before" — never actually written

      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'inconsistent chain',
        edits: [
          editInput({ file_path: filePath, before: v0, after: chainBreakA, node_id: 'older' }),
          editInput({ file_path: filePath, before: chainBreakB, after: v2, node_id: 'newer' })
        ]
      });
      // Force the message into a fully-reverted state directly (bypassing an actual revert call,
      // since the broken chain would never get here that way) with the file at "older.before".
      fs.writeFileSync(filePath, v0);
      const loaded = readMessage(devmindPath, msg.id)!;
      loaded.edits.forEach(e => { e.reverted = true; });
      loaded.status = 'reverted';
      saveMessage(devmindPath, loaded);

      const result = unrevertMessage(devmindPath, msg.id);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('newer');

      // File restored to its pre-attempt (reverted) state — the successful older-edit unrevert
      // to chainBreakA was undone once the newer edit's unrevert failed.
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v0);
      const after = readMessage(devmindPath, msg.id)!;
      expect(after.edits.every(e => e.reverted)).toBe(true);
      expect(after.status).toBe('reverted');
    });

    it('errors on an unknown message id and on a message that is not reverted', () => {
      expect(unrevertMessage(devmindPath, 'nope')).toEqual({ ok: false, error: 'message not found' });

      const filePath = path.join(repoDir, 'a.ts');
      const v0 = 'export const a = 0;\n';
      const v1 = 'export const a = 1;\n';
      fs.writeFileSync(filePath, v0);
      fs.writeFileSync(filePath, v1);
      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'A', edits: [editInput({ file_path: filePath, before: v0, after: v1 })]
      });
      const result = unrevertMessage(devmindPath, msg.id);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not reverted/);
    });

    it('skips an edit already restored via a granular action, un-reverting only the rest of the message', () => {
      const fileA = path.join(repoDir, 'a.ts');
      const fileB = path.join(repoDir, 'b.ts');
      const a0 = 'export const a = 0;\n';
      const a1 = 'export const a = 1;\n';
      const b0 = 'export const b = 0;\n';
      const b1 = 'export const b = 1;\n';
      fs.writeFileSync(fileA, a0);
      fs.writeFileSync(fileB, b0);
      fs.writeFileSync(fileA, a1);
      const msg1 = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'A', edits: [editInput({ file_path: fileA, before: a0, after: a1 })]
      });
      fs.writeFileSync(fileB, b1);
      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, message_id: msg1.id, summary: 'B',
        edits: [editInput({ file_path: fileB, before: b0, after: b1 })]
      });
      const [editA, editB] = msg.edits;

      // Fully revert the message (both edits reverted, file at a0/b0).
      expect(revertMessage(devmindPath, msg.id).ok).toBe(true);
      expect(readMessage(devmindPath, msg.id)!.status).toBe('reverted');

      // Granularly restore just editA — message goes to 'partial', which (per unrevertMessage's
      // own doc comment) can be un-reverted independently of stack ordering.
      expect(unrevertMessageEdit(devmindPath, msg.id, editA.id).ok).toBe(true);
      expect(readMessage(devmindPath, msg.id)!.status).toBe('partial');

      // Now un-revert the whole message — unrevertOneMessageAtomically's oldest-first loop hits
      // editA (already applied, not reverted) and must skip it via `continue`, while still
      // restoring editB.
      const result = unrevertMessage(devmindPath, msg.id);
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(fileA, 'utf-8')).toBe(a1);
      expect(fs.readFileSync(fileB, 'utf-8')).toBe(b1);
      const saved = readMessage(devmindPath, msg.id)!;
      expect(saved.edits.every(e => !e.reverted)).toBe(true);
      expect(saved.status).toBe('applied');
    });
  });

  describe('revertMessageFile / unrevertMessageFile — one file within a message', () => {
    it('reverts only the target file’s edits, leaving the message’s other file untouched (status -> partial)', () => {
      const fileA = path.join(repoDir, 'a.ts');
      const fileB = path.join(repoDir, 'b.ts');
      const a0 = 'export const a = 0;\n';
      const a1 = 'export const a = 1;\n';
      const a2 = 'export const a = 2;\n';
      const b0 = 'export const b = 0;\n';
      const b1 = 'export const b = 1;\n';

      fs.writeFileSync(fileA, a0);
      fs.writeFileSync(fileB, b0);
      fs.writeFileSync(fileA, a1);
      const msg1 = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'first',
        edits: [editInput({ file_path: fileA, before: a0, after: a1 })]
      });
      fs.writeFileSync(fileA, a2);
      const msg2 = recordMessage(devmindPath, {
        session_id: 's', developer: null, message_id: msg1.id, summary: 'second',
        edits: [editInput({ file_path: fileA, before: a1, after: a2 })]
      });
      fs.writeFileSync(fileB, b1);
      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, message_id: msg1.id, summary: 'third',
        edits: [editInput({ file_path: fileB, before: b0, after: b1 })]
      });
      expect(msg.id).toBe(msg1.id);
      expect(msg.edits).toHaveLength(3);
      const [editA1, editA2] = msg.edits; // the two fileA edits, oldest-recorded-first

      const result = revertMessageFile(devmindPath, msg.id, fileA);
      expect(result.ok).toBe(true);
      // Newest edit of the file comes off first.
      expect(result.edit_ids).toEqual([editA2.id, editA1.id]);

      expect(fs.readFileSync(fileA, 'utf-8')).toBe(a0);
      expect(fs.readFileSync(fileB, 'utf-8')).toBe(b1); // untouched

      const afterRevert = readMessage(devmindPath, msg.id)!;
      expect(afterRevert.status).toBe('partial');
      expect(afterRevert.edits.filter(e => e.file_path === fileA).every(e => e.reverted)).toBe(true);
      expect(afterRevert.edits.find(e => e.file_path === fileB)!.reverted).toBeFalsy();

      const unrevertResult = unrevertMessageFile(devmindPath, msg.id, fileA);
      expect(unrevertResult.ok).toBe(true);
      // Oldest edit of the file restored first.
      expect(unrevertResult.edit_ids).toEqual([editA1.id, editA2.id]);
      expect(fs.readFileSync(fileA, 'utf-8')).toBe(a2);
      expect(readMessage(devmindPath, msg.id)!.status).toBe('applied');
    });

    it('errors when there are no applied/reverted edits for that file in the message', () => {
      const fileA = path.join(repoDir, 'a.ts');
      const fileB = path.join(repoDir, 'b.ts');
      const a0 = 'export const a = 0;\n';
      const a1 = 'export const a = 1;\n';
      fs.writeFileSync(fileA, a0);
      fs.writeFileSync(fileA, a1);
      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'A', edits: [editInput({ file_path: fileA, before: a0, after: a1 })]
      });

      const noSuchFile = revertMessageFile(devmindPath, msg.id, fileB);
      expect(noSuchFile).toEqual({ ok: false, error: 'no applied edits for this file in this message' });

      const noSuchMessage = revertMessageFile(devmindPath, 'nope', fileA);
      expect(noSuchMessage).toEqual({ ok: false, error: 'message not found' });

      const noSuchMessageUnrevert = unrevertMessageFile(devmindPath, 'nope', fileA);
      expect(noSuchMessageUnrevert).toEqual({ ok: false, error: 'message not found' });

      // Nothing reverted yet -> unrevert has nothing to do either.
      const nothingToRestore = unrevertMessageFile(devmindPath, msg.id, fileA);
      expect(nothingToRestore).toEqual({ ok: false, error: 'no reverted edits for this file in this message' });
    });

    it('revertMessageFile rolls back atomically when an older edit to the same file fails after a newer one succeeded', () => {
      const filePath = path.join(repoDir, 'a.ts');
      const v0 = 'export const a = 0;\n';
      const v2 = 'export const a = 2;\n';
      const chainBreakA = 'export const a = "chain-break-A";\n'; // older's recorded "after" — never actually written
      const chainBreakB = 'export const a = "chain-break-B";\n'; // newer's recorded "before"

      fs.writeFileSync(filePath, v2);
      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'inconsistent chain',
        edits: [
          editInput({ file_path: filePath, before: v0, after: chainBreakA, node_id: 'older' }),
          editInput({ file_path: filePath, before: chainBreakB, after: v2, node_id: 'newer' })
        ]
      });

      const result = revertMessageFile(devmindPath, msg.id, filePath);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('older');
      // Rolled back to the pre-attempt state — the successful newest-edit revert was undone.
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v2);
      expect(readMessage(devmindPath, msg.id)!.edits.every(e => !e.reverted)).toBe(true);
    });

    it('unrevertMessageFile rolls back atomically when a newer edit to the same file fails after an older one succeeded', () => {
      const filePath = path.join(repoDir, 'a.ts');
      const v0 = 'export const a = 0;\n';
      const v2 = 'export const a = 2;\n';
      const chainBreakA = 'export const a = "chain-break-A";\n'; // older's recorded "after"
      const chainBreakB = 'export const a = "chain-break-B";\n'; // newer's recorded "before" — never actually written

      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'inconsistent chain',
        edits: [
          editInput({ file_path: filePath, before: v0, after: chainBreakA, node_id: 'older' }),
          editInput({ file_path: filePath, before: chainBreakB, after: v2, node_id: 'newer' })
        ]
      });
      fs.writeFileSync(filePath, v0);
      const loaded = readMessage(devmindPath, msg.id)!;
      loaded.edits.forEach(e => { e.reverted = true; });
      loaded.status = 'reverted';
      saveMessage(devmindPath, loaded);

      const result = unrevertMessageFile(devmindPath, msg.id, filePath);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('newer');
      // Rolled back to the pre-attempt (reverted) state.
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v0);
      expect(readMessage(devmindPath, msg.id)!.edits.every(e => e.reverted)).toBe(true);
    });
  });

  describe('revertMessageEdit / unrevertMessageEdit — one edit by stable id', () => {
    it('reverts and un-reverts a single edit, and refuses double-revert / double-unrevert', () => {
      const filePath = path.join(repoDir, 'a.ts');
      const v0 = 'export const a = 0;\n';
      const v1 = 'export const a = 1;\n';

      fs.writeFileSync(filePath, v0);
      fs.writeFileSync(filePath, v1);
      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'A', edits: [editInput({ file_path: filePath, before: v0, after: v1 })]
      });
      const editId = msg.edits[0].id;

      const result = revertMessageEdit(devmindPath, msg.id, editId);
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v0);
      expect(readMessage(devmindPath, msg.id)!.status).toBe('reverted');
      expect(readMessage(devmindPath, msg.id)!.edits[0].reverted).toBe(true);

      const doubleRevert = revertMessageEdit(devmindPath, msg.id, editId);
      expect(doubleRevert).toEqual({ ok: false, error: 'already reverted' });

      const unrevertResult = unrevertMessageEdit(devmindPath, msg.id, editId);
      expect(unrevertResult.ok).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v1);
      expect(readMessage(devmindPath, msg.id)!.status).toBe('applied');

      const doubleUnrevert = unrevertMessageEdit(devmindPath, msg.id, editId);
      expect(doubleUnrevert).toEqual({ ok: false, error: 'not reverted' });
    });

    it('errors for an unknown message or an edit id not present in that message', () => {
      const filePath = path.join(repoDir, 'a.ts');
      const v0 = 'export const a = 0;\n';
      const v1 = 'export const a = 1;\n';
      fs.writeFileSync(filePath, v0);
      fs.writeFileSync(filePath, v1);
      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'A', edits: [editInput({ file_path: filePath, before: v0, after: v1 })]
      });

      expect(revertMessageEdit(devmindPath, 'nope', msg.edits[0].id)).toEqual({ ok: false, error: 'message not found' });
      expect(revertMessageEdit(devmindPath, msg.id, 'nope')).toEqual({ ok: false, error: 'edit not found in this message' });
      expect(unrevertMessageEdit(devmindPath, 'nope', msg.edits[0].id)).toEqual({ ok: false, error: 'message not found' });
      expect(unrevertMessageEdit(devmindPath, msg.id, 'nope')).toEqual({ ok: false, error: 'edit not found in this message' });
    });

    it('refuses to revert an older edit whose recorded "after" text is no longer on disk because a newer edit built on top of it', () => {
      const filePath = path.join(repoDir, 'a.ts');
      const v0 = 'export const a = 0;\n';
      const v1 = 'export const a = 1;\n';
      const v2 = 'export const a = 2;\n';

      fs.writeFileSync(filePath, v0);
      fs.writeFileSync(filePath, v1);
      const msg1 = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'first', edits: [editInput({ file_path: filePath, before: v0, after: v1 })]
      });
      fs.writeFileSync(filePath, v2);
      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, message_id: msg1.id, summary: 'second',
        edits: [editInput({ file_path: filePath, before: v1, after: v2 })]
      });
      const [oldEdit, newEdit] = msg.edits;

      // The older edit's `after` (v1) isn't literally on disk anymore — v2 fully replaced it —
      // so reverting the OLDER edit while the newer one is still applied must be refused rather
      // than guessed at.
      const blocked = revertMessageEdit(devmindPath, msg.id, oldEdit.id);
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toBeTruthy();
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v2); // untouched by the refusal
      expect(readMessage(devmindPath, msg.id)!.edits.find(e => e.id === oldEdit.id)!.reverted).toBeFalsy();

      // Reverting the NEWEST edit first (the one actually on top) works fine.
      const ok = revertMessageEdit(devmindPath, msg.id, newEdit.id);
      expect(ok.ok).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v1);
    });

    it('refuses to un-revert an edit whose recorded "before" text is no longer on disk (drifted since the revert)', () => {
      const filePath = path.join(repoDir, 'a.ts');
      const v0 = 'export const a = 0;\n';
      const v1 = 'export const a = 1;\n';
      const driftedElsewhere = 'export const a = "hand-edited after the revert";\n';

      fs.writeFileSync(filePath, v0);
      fs.writeFileSync(filePath, v1);
      const msg = recordMessage(devmindPath, {
        session_id: 's', developer: null, summary: 'A', edits: [editInput({ file_path: filePath, before: v0, after: v1 })]
      });
      const editId = msg.edits[0].id;

      expect(revertMessageEdit(devmindPath, msg.id, editId).ok).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(v0);

      // Hand-edit the file after the revert, bypassing the graph — the reverted edit's recorded
      // "before" (v0) is no longer literally on disk to restore "after" onto.
      fs.writeFileSync(filePath, driftedElsewhere);

      const result = unrevertMessageEdit(devmindPath, msg.id, editId);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(driftedElsewhere); // untouched by the refusal
      expect(readMessage(devmindPath, msg.id)!.edits[0].reverted).toBe(true); // still reverted
    });
  });
});
