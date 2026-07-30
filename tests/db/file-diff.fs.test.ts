import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileDiffForMessage } from '../../src/db/file-diff';
import { MessageEdit } from '../../src/db/activity';

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-filediff-test-'));
}

function mkEdit(overrides: Partial<MessageEdit>): MessageEdit {
  return {
    id: overrides.id || `e-${Math.random().toString(36).slice(2)}`,
    node_id: overrides.node_id ?? 'n',
    file_path: overrides.file_path ?? '/repo/foo.ts',
    at: overrides.at ?? new Date().toISOString(),
    before: overrides.before ?? '',
    after: overrides.after ?? ''
  };
}

describe('fileDiffForMessage', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reports drift with a clear reason when the file no longer exists on disk', () => {
    const missing = path.join(dir, 'gone.ts');
    const result = fileDiffForMessage(missing, [mkEdit({ before: 'a', after: 'b' })]);
    expect(result).toEqual({
      file_path: missing, before_file: '', after_file: '', hunks: [], drifted: true,
      drift_reason: 'file no longer exists on disk'
    });
  });

  it('reconstructs the before/after whole-file diff for a single edit', () => {
    const target = path.join(dir, 'foo.ts');
    const live = 'export function foo() {\n  return 2;\n}\n';
    fs.writeFileSync(target, live);
    const edits = [mkEdit({ file_path: target, before: 'return 1;', after: 'return 2;' })];

    const result = fileDiffForMessage(target, edits);
    expect(result.drifted).toBe(false);
    expect(result.drift_reason).toBeUndefined();
    expect(result.after_file).toBe(live);
    expect(result.before_file).toBe('export function foo() {\n  return 1;\n}\n');
    expect(result.hunks.some(h => h.type === 'del' && h.text.includes('return 1;'))).toBe(true);
    expect(result.hunks.some(h => h.type === 'add' && h.text.includes('return 2;'))).toBe(true);
  });

  it('reconstructs correctly across multiple chronological edits to the same file', () => {
    const target = path.join(dir, 'foo.ts');
    const live = 'export function foo() {\n  return 3;\n}\n';
    fs.writeFileSync(target, live);
    // chronological (oldest-first) order, as they'd appear in ActivityMessage.edits
    const edits = [
      mkEdit({ file_path: target, before: 'return 1;', after: 'return 2;' }),
      mkEdit({ file_path: target, before: 'return 2;', after: 'return 3;' })
    ];

    const result = fileDiffForMessage(target, edits);
    expect(result.drifted).toBe(false);
    expect(result.before_file).toBe('export function foo() {\n  return 1;\n}\n');
    expect(result.after_file).toBe(live);
  });

  it('reports drift with a reason when the live file no longer matches what the edits predict', () => {
    const target = path.join(dir, 'foo.ts');
    // A hand-edit landed after the recorded edit — 'return 2;' is no longer present.
    const live = 'export function foo() {\n  return 999;\n}\n';
    fs.writeFileSync(target, live);
    const edits = [mkEdit({ file_path: target, before: 'return 1;', after: 'return 2;' })];

    const result = fileDiffForMessage(target, edits);
    expect(result.drifted).toBe(true);
    expect(result.drift_reason).toBe('file has changed since this message was recorded — showing per-change diffs instead');
    expect(result.after_file).toBe(live);
    expect(result.hunks).toEqual([]);
  });

  it('reports drift when the edit\'s "after" text is ambiguous (matches more than once)', () => {
    const target = path.join(dir, 'foo.ts');
    const live = 'dup\ndup\n';
    fs.writeFileSync(target, live);
    const edits = [mkEdit({ file_path: target, before: 'orig', after: 'dup' })];
    const result = fileDiffForMessage(target, edits);
    expect(result.drifted).toBe(true);
  });

  it('treats a no-op edit (before === after) as nothing to undo', () => {
    const target = path.join(dir, 'foo.ts');
    const live = 'unchanged content\n';
    fs.writeFileSync(target, live);
    const edits = [mkEdit({ file_path: target, before: 'unchanged content\n', after: 'unchanged content\n' })];

    const result = fileDiffForMessage(target, edits);
    expect(result.drifted).toBe(false);
    expect(result.before_file).toBe(live);
    expect(result.after_file).toBe(live);
    expect(result.hunks).toEqual([{ type: 'ctx', text: 'unchanged content', old_line: 1, new_line: 1 }]);
  });

  it('treats an edit with an empty "after" as unreconstructable (no anchor to undo)', () => {
    const target = path.join(dir, 'foo.ts');
    const live = 'export function foo() {}\n';
    fs.writeFileSync(target, live);
    const edits = [mkEdit({ file_path: target, before: 'export function foo() {}\n', after: '' })];

    const result = fileDiffForMessage(target, edits);
    expect(result.drifted).toBe(true);
  });

  it('handles an empty edits array as a trivial no-drift diff against itself', () => {
    const target = path.join(dir, 'foo.ts');
    const live = 'export function foo() {}\n';
    fs.writeFileSync(target, live);

    const result = fileDiffForMessage(target, []);
    expect(result.drifted).toBe(false);
    expect(result.before_file).toBe(live);
    expect(result.after_file).toBe(live);
    expect(result.hunks).toEqual([{ type: 'ctx', text: 'export function foo() {}', old_line: 1, new_line: 1 }]);
  });
});
