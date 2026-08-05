import * as fs from 'fs';
import { makeFixture, stageAndCommit, repoFile, Fixture } from '../helpers/fixture';
import { revertLastEdit } from '../../src/db/revert';
import { stageEntry, readStaged } from '../../src/db/staging';

describe('revert.ts — revertLastEdit', () => {
  let fx: Fixture;

  afterEach(() => {
    fx?.cleanup();
  });

  it('prefers a staged-but-uncommitted entry over history, and removes it via removeLastStagedEntry', () => {
    fx = makeFixture();
    const originalSnippet = 'export function greet(name: string): string {\n  return format(name);\n}';
    const newSnippet = 'export function greet(name: string): string {\n  return format(name) + \'!!!\';\n}';

    // Simulate the edit already having happened on disk (edit_node writes immediately; the
    // commit is what's still pending).
    const before = fs.readFileSync(repoFile(fx, 'foo.ts'), 'utf-8');
    fs.writeFileSync(repoFile(fx, 'foo.ts'), before.replace(originalSnippet, newSnippet));

    stageEntry(fx.devmindPath, {
      node_id: 'greet',
      file_path: repoFile(fx, 'foo.ts'),
      code_snapshot: newSnippet,
      code_before: originalSnippet,
      name: 'greet',
      type: 'function',
      description: 'Returns a greeting string built from the given name, used by the demo entrypoint.'
    });
    expect(readStaged(fx.devmindPath)).toHaveLength(1);

    const result = revertLastEdit(fx.db, fx.devmindPath, 'greet');
    expect(result.ok).toBe(true);
    expect(result.was_staged).toBe(true);
    expect(readStaged(fx.devmindPath)).toHaveLength(0);

    const restored = fs.readFileSync(repoFile(fx, 'foo.ts'), 'utf-8');
    expect(restored).toContain(originalSnippet);
    expect(restored).not.toContain(newSnippet);
  });

  it('a staged entry with code_before: null (creation, not edit) reverts by deleting the snapshot text', () => {
    fx = makeFixture();
    const createdSnippet = '\nexport function brandNew(): void {}\n';
    fs.appendFileSync(repoFile(fx, 'foo.ts'), createdSnippet);

    // code_before is explicitly `null` (this entry created the entity — see restoreFile's own
    // doc comment), not merely omitted/`undefined` — exercising the `last.code_before ?? ''`
    // fallback rather than the earlier `=== undefined` refusal at the top of the staged branch.
    stageEntry(fx.devmindPath, {
      node_id: 'brandNew',
      file_path: repoFile(fx, 'foo.ts'),
      code_snapshot: createdSnippet,
      code_before: null,
      name: 'brandNew',
      type: 'function'
    });

    const result = revertLastEdit(fx.db, fx.devmindPath, 'brandNew');
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(repoFile(fx, 'foo.ts'), 'utf-8')).not.toContain(createdSnippet);
  });

  it('refuses a staged revert when the staged entry has no before-state', () => {
    fx = makeFixture();
    stageEntry(fx.devmindPath, {
      node_id: 'greet',
      file_path: repoFile(fx, 'foo.ts'),
      code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
      // code_before intentionally omitted (undefined) — no diff to revert to.
      name: 'greet',
      type: 'function'
    });
    const result = revertLastEdit(fx.db, fx.devmindPath, 'greet');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no recorded before-state/);
  });

  it('propagates a staged-revert restoreFile failure (staged code_snapshot no longer matches what is on disk)', () => {
    fx = makeFixture();
    // The staged entry's code_snapshot claims this text is the current disk state, but the real
    // file was never actually edited to match it — restoreFile's exact-match search finds nothing.
    stageEntry(fx.devmindPath, {
      node_id: 'greet',
      file_path: repoFile(fx, 'foo.ts'),
      code_snapshot: 'export function greet(name: string): string {\n  return "this text is not actually on disk";\n}',
      code_before: 'export function greet(name: string): string {\n  return format(name);\n}',
      name: 'greet',
      type: 'function'
    });
    const result = revertLastEdit(fx.db, fx.devmindPath, 'greet');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/old_string was not found/);
    expect(result.node_id).toBe('greet');
    // Refused, so the staged entry must still be there.
    expect(readStaged(fx.devmindPath)).toHaveLength(1);
  });

  it('errors when there is no history at all for the node', () => {
    fx = makeFixture();
    const result = revertLastEdit(fx.db, fx.devmindPath, '{app}/nowhere.ts#nothing');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No history recorded/);
  });

  it('committed revert: restores disk exactly and erases the newest edit only (only-newest-edit rule)', async () => {
    fx = makeFixture();
    const v1 = 'export function greet(name: string): string {\n  return format(name);\n}';
    const v2 = 'export function greet(name: string): string {\n  return format(name).toUpperCase();\n}';

    // First commit: brand-new entity, code_before: null -> records edit {before:'', after: v1}.
    const commit1 = await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: v1,
        code_before: null,
        name: 'greet',
        type: 'function',
        description: 'Returns a greeting string built from the given name, used by the demo entrypoint.'
      }
    ]);
    const greetId = commit1.node_ids[0];

    // Apply the edit on disk (as edit_node would), then commit it with a real before-state.
    fs.writeFileSync(repoFile(fx, 'foo.ts'), fs.readFileSync(repoFile(fx, 'foo.ts'), 'utf-8').replace(v1, v2));
    await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: v2,
        code_before: v1,
        name: 'greet',
        type: 'function'
      }
    ]);

    // Within the 1-hour merge window, both edits land in the SAME history row.
    const beforeRevert = fx.db.getFullHistory(greetId);
    expect(beforeRevert).toHaveLength(1);
    expect(beforeRevert[0].edits).toHaveLength(2);

    const result = revertLastEdit(fx.db, fx.devmindPath, greetId);
    expect(result.ok).toBe(true);
    expect(result.entry_deleted).toBe(false); // one edit remains, so the row itself survives

    // Disk restored to v1 (the "before" of the reverted, newest edit) — NOT to '' (edit #1's before).
    const restored = fs.readFileSync(repoFile(fx, 'foo.ts'), 'utf-8');
    expect(restored).toContain(v1);
    expect(restored).not.toContain(v2);

    // Only the newest edit was erased — the first edit is still there.
    const afterRevert = fx.db.getFullHistory(greetId);
    expect(afterRevert).toHaveLength(1);
    expect(afterRevert[0].edits).toHaveLength(1);
    expect(afterRevert[0].edits[0].after).toBe(v1);
  });

  it('erases the whole history row once its only edit is reverted', async () => {
    fx = makeFixture();
    const v1 = 'export function greet(name: string): string {\n  return format(name);\n}';

    await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: v1,
        code_before: null,
        name: 'greet',
        type: 'function',
        description: 'Returns a greeting string built from the given name, used by the demo entrypoint.'
      }
    ]);
    // Revert the creation edit immediately (single edit, single row) — should delete the row.
    const greetId = `{app}/foo.ts#greet`;
    const before = fx.db.getFullHistory(greetId);
    expect(before).toHaveLength(1);
    expect(before[0].edits).toHaveLength(1);

    const result = revertLastEdit(fx.db, fx.devmindPath, greetId);
    expect(result.ok).toBe(true);
    expect(result.entry_deleted).toBe(true);
    expect(fx.db.getFullHistory(greetId)).toHaveLength(0);
  });

  it('errors when history exists for a node that no longer has a row in the graph', async () => {
    fx = makeFixture();
    const v1 = 'export function greet(name: string): string {\n  return format(name);\n}';
    const summary = await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: v1,
        code_before: null,
        name: 'greet',
        type: 'function',
        description: 'Returns a greeting string built from the given name, used by the demo entrypoint.'
      }
    ]);
    const greetId = summary.node_ids[0];
    expect(fx.db.getLatestHistory(greetId)).toBeTruthy();

    // Drop the node row directly while leaving its history behind — history's FK to nodes is
    // ON DELETE CASCADE, so foreign_keys must be off for this raw delete to leave history intact,
    // simulating e.g. a node hard-deleted through some other path while its history JSON survives.
    const raw = (fx.db as unknown as {
      db: { pragma: (s: string) => unknown; prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
    }).db;
    raw.pragma('foreign_keys = OFF');
    raw.prepare('DELETE FROM nodes WHERE id = ?').run(greetId);
    raw.pragma('foreign_keys = ON');
    expect(fx.db.getNode(greetId)).toBeNull();
    expect(fx.db.getLatestHistory(greetId)).toBeTruthy();

    const result = revertLastEdit(fx.db, fx.devmindPath, greetId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/has history but no node in the graph/);
  });

  it('drift guard: refuses to revert when the live file no longer matches the recorded "after"', async () => {
    fx = makeFixture();
    const v1 = 'export function greet(name: string): string {\n  return format(name);\n}';
    await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: v1,
        code_before: null,
        name: 'greet',
        type: 'function',
        description: 'Returns a greeting string built from the given name, used by the demo entrypoint.'
      }
    ]);
    const greetId = `{app}/foo.ts#greet`;

    // Hand-edit the file to something else entirely, bypassing the graph.
    const driftedContent = `import { format } from './bar';\n\nexport function greet(name: string): string {\n  return 'totally different implementation';\n}\n`;
    fs.writeFileSync(repoFile(fx, 'foo.ts'), driftedContent);

    const result = revertLastEdit(fx.db, fx.devmindPath, greetId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/changed since that edit was recorded|Could not read/);

    // File must be untouched by the refused revert.
    expect(fs.readFileSync(repoFile(fx, 'foo.ts'), 'utf-8')).toBe(driftedContent);
  });

  it('propagates a committed-path restoreFile failure when the recorded "after" text is ambiguous on disk', async () => {
    fx = makeFixture();
    const v1 = 'export function greet(name: string): string {\n  return format(name);\n}';
    await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: v1,
        code_before: null,
        name: 'greet',
        type: 'function',
        description: 'Returns a greeting string built from the given name, used by the demo entrypoint.'
      }
    ]);
    const greetId = `{app}/foo.ts#greet`;

    // Append a byte-identical COMMENTED copy of the function's text. getLiveCode's AST extraction
    // still reads the real `greet` symbol cleanly (a comment isn't a competing declaration), so the
    // drift guard above still passes — but restoreFile's plain-text search now finds the "after"
    // string twice and refuses per its own ambiguous-match rule, rather than restoring blind.
    const original = fs.readFileSync(repoFile(fx, 'foo.ts'), 'utf-8');
    fs.writeFileSync(repoFile(fx, 'foo.ts'), `${original}\n/*\n${v1}\n*/\n`);

    const result = revertLastEdit(fx.db, fx.devmindPath, greetId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not restore/);
    expect(result.error).toMatch(/matches more than one place/);
    expect(result.node_id).toBe(greetId);
  });

  it('restoreFile refuses a staged revert whose entry has an empty file_path', () => {
    fx = makeFixture();
    // The staged path calls restoreFile directly (no getLiveCode/AST detour in the way), so an
    // empty file_path reaches restoreFile's own "no file path recorded" guard cleanly.
    stageEntry(fx.devmindPath, {
      node_id: 'greet',
      file_path: '',
      code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
      code_before: 'export function greet(name: string): string {\n  return "old";\n}',
      name: 'greet',
      type: 'function'
    });
    const result = revertLastEdit(fx.db, fx.devmindPath, 'greet');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no file path recorded for this entity/);
  });

  it('refuses to revert when the file no longer exists on disk to confirm against (getLiveCode falls back to a cached snapshot)', async () => {
    fx = makeFixture();
    const v1 = 'export function greet(name: string): string {\n  return format(name);\n}';
    await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: v1,
        code_before: null,
        name: 'greet',
        type: 'function',
        description: 'Returns a greeting string built from the given name, used by the demo entrypoint.'
      }
    ]);
    const greetId = `{app}/foo.ts#greet`;

    // Delete the file entirely — extractLiveCode can no longer read anything, so getLiveCode
    // falls back to the cached history snapshot (source: 'cached'), which revertLastEdit must
    // treat the same as "couldn't confirm" rather than trusting the stale cached text.
    fs.rmSync(repoFile(fx, 'foo.ts'));

    const result = revertLastEdit(fx.db, fx.devmindPath, greetId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not read .* from disk to confirm/);
  });

  it('erases the whole history row when it has never had a describable edit (before-less entry)', async () => {
    // Legacy update_history / index-snapshot style entry: code_before undefined -> newEdit is null -> entry.edits is empty.
    fx = makeFixture();
    const summary = await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
        // code_before omitted entirely
        name: 'greet',
        type: 'function',
        description: 'Returns a greeting string built from the given name, used by the demo entrypoint.'
      }
    ]);
    const greetId = summary.node_ids[0];
    const result = revertLastEdit(fx.db, fx.devmindPath, greetId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/recorded without a before-state/);
  });

  it('expectedHistoryId guard: rejects a stale/wrong id, accepts the correct current one', async () => {
    fx = makeFixture();
    const v1 = 'export function greet(name: string): string {\n  return format(name);\n}';
    await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: v1,
        code_before: null,
        name: 'greet',
        type: 'function',
        description: 'Returns a greeting string built from the given name, used by the demo entrypoint.'
      }
    ]);
    const greetId = `{app}/foo.ts#greet`;
    const latest = fx.db.getLatestHistory(greetId)!;

    const rejected = revertLastEdit(fx.db, fx.devmindPath, greetId, 'not-a-real-history-id');
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/newer change/);
    // File and history must be untouched by the refusal.
    expect(fs.readFileSync(repoFile(fx, 'foo.ts'), 'utf-8')).toContain(v1);
    expect(fx.db.getFullHistory(greetId)).toHaveLength(1);

    const accepted = revertLastEdit(fx.db, fx.devmindPath, greetId, latest.id);
    expect(accepted.ok).toBe(true);
  });
});
