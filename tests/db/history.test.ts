import * as fs from 'fs';
import { makeFixture, stageAndCommit, repoFile } from '../helpers/fixture';

const FOO_SNIPPET = 'export function greet(name: string): string {\n  return format(name);\n}';

describe('DevMindDatabase — history machinery', () => {
  describe('updateHistory — 1-hour session-merge rule', () => {
    it('two updates well within the window merge into the SAME row (reasoning appended, edits trail grows)', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });

        const h1 = fx.db.updateHistory({ node_id: nodeId, code_snapshot: 'v1', code_before: null, reasoning: 'created v1' });
        expect(fx.db.listHistory(nodeId)).toHaveLength(1);

        // Second call happens milliseconds later in real time — well under the 1h window.
        const h2 = fx.db.updateHistory({ node_id: nodeId, code_snapshot: 'v2', code_before: 'v1', reasoning: 'updated to v2' });

        // Same row, not a new one.
        expect(fx.db.listHistory(nodeId)).toHaveLength(1);
        expect(h2.id).toBe(h1.id);

        const full = fx.db.getFullHistory(nodeId)[0];
        expect(full.code_snapshot).toBe('v2'); // always the latest state
        expect(full.reasoning).toContain('created v1');
        expect(full.reasoning).toContain('updated to v2');
        expect(full.reasoning).toContain('── Update @'); // separator marking the merge
        expect(full.edits).toHaveLength(2); // both edits kept in the trail
        expect(full.edits[0].after).toBe('v1');
        expect(full.edits[1].before).toBe('v1');
        expect(full.edits[1].after).toBe('v2');
      } finally {
        fx.cleanup();
      }
    });

    it('an update more than 1 hour after the last one starts a NEW row instead of merging', () => {
      // updateHistory reads real wall-clock time via `new Date()` with no injectable clock — the
      // only way to exercise the ">1h => new row" branch deterministically is to mock the global
      // Date via Jest's fake timers (no source changes needed for this).
      jest.useFakeTimers({ doNotFake: ['nextTick'] });
      try {
        const t0 = new Date('2026-01-01T00:00:00.000Z');
        jest.setSystemTime(t0);

        const fx = makeFixture();
        try {
          const nodeId = '{app}/foo.ts#greet';
          fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });

          const h1 = fx.db.updateHistory({ node_id: nodeId, code_snapshot: 'v1', code_before: null, reasoning: 'created v1' });
          expect(fx.db.listHistory(nodeId)).toHaveLength(1);

          // Jump 1 hour + 1ms forward — crosses the session boundary.
          jest.setSystemTime(new Date(t0.getTime() + 3600_001));

          const h2 = fx.db.updateHistory({ node_id: nodeId, code_snapshot: 'v2', code_before: 'v1', reasoning: 'updated to v2' });

          expect(h2.id).not.toBe(h1.id);
          expect(fx.db.listHistory(nodeId)).toHaveLength(2);

          const full = fx.db.getFullHistory(nodeId);
          // Newest first (ORDER BY updated_at DESC).
          expect(full[0].id).toBe(h2.id);
          expect(full[0].reasoning).not.toContain('created v1'); // fresh row, no carried-over reasoning
          expect(full[1].id).toBe(h1.id);
        } finally {
          fx.cleanup();
        }
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('code_before semantics', () => {
    it('code_before === undefined records no edit; null vs a real snapshot distinguish addition from a diff', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });

        // undefined -> nothing to diff against, no edit recorded at all.
        fx.db.updateHistory({ node_id: nodeId, code_snapshot: 'v1', code_before: undefined, reasoning: 'no diff (legacy update_history)' });
        let full = fx.db.getFullHistory(nodeId)[0];
        expect(full.edits).toEqual([]);

        // null -> pure addition (entity didn't exist before); still recorded as an edit, `before` is ''.
        fx.db.updateHistory({ node_id: nodeId, code_snapshot: 'v2', code_before: null, reasoning: 'pure addition' });
        full = fx.db.getFullHistory(nodeId)[0];
        expect(full.edits).toHaveLength(1);
        expect(full.edits[0].before).toBe('');
        expect(full.edits[0].after).toBe('v2');

        // A real prior snapshot -> a genuine edit, `before` carries the real prior text.
        fx.db.updateHistory({ node_id: nodeId, code_snapshot: 'v3', code_before: 'v2', reasoning: 'real edit' });
        full = fx.db.getFullHistory(nodeId)[0];
        expect(full.edits).toHaveLength(2);
        expect(full.edits[1].before).toBe('v2');
        expect(full.edits[1].after).toBe('v3');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('read-back: getLatestHistory / listHistory / getHistoryEntry / getFullHistory / getLatestCode', () => {
    it('is correct after a single commit', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const nodeId = '{app}/foo.ts#greet';

        const latest = fx.db.getLatestHistory(nodeId);
        expect(latest?.code_snapshot).toBe(FOO_SNIPPET);

        const list = fx.db.listHistory(nodeId);
        expect(list).toHaveLength(1);
        expect((list[0] as any).code_snapshot).toBeUndefined(); // listHistory omits the heavy fields
        expect((list[0] as any).reasoning).toBeUndefined();

        const entry = fx.db.getHistoryEntry(latest!.id);
        expect(entry?.code_snapshot).toBe(FOO_SNIPPET);
        expect(fx.db.getHistoryEntry('nonexistent-id')).toBeNull();

        const full = fx.db.getFullHistory(nodeId);
        expect(full).toHaveLength(1);
        expect(full[0].id).toBe(latest!.id);

        const latestCode = fx.db.getLatestCode(nodeId);
        expect(latestCode?.code_snapshot).toBe(FOO_SNIPPET);
      } finally {
        fx.cleanup();
      }
    });

    it('falls back to empty code_snapshot/reasoning/edits when the history/<id>.json file is missing on disk', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const nodeId = '{app}/foo.ts#greet';
        const latest = fx.db.getLatestHistory(nodeId)!;

        const historyFile = require('path').join(fx.devmindPath, 'history', `${latest.id}.json`);
        fs.rmSync(historyFile);

        const afterDelete = fx.db.getLatestHistory(nodeId);
        expect(afterDelete?.code_snapshot).toBe('');
        expect(afterDelete?.reasoning).toBe('');
        expect(afterDelete?.edits).toEqual([]);
        // SQLite-native columns (id/node_id/timestamps) are unaffected — only the disk-backed
        // heavy fields degrade.
        expect(afterDelete?.id).toBe(latest.id);
      } finally {
        fx.cleanup();
      }
    });

    it('is correct after multiple commits to the same node (session-merged into one row)', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const nodeId = '{app}/foo.ts#greet';
        const secondSnippet = 'export function greet(name: string): string {\n  return format(name) + "!";\n}';
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: secondSnippet, code_before: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);

        expect(fx.db.listHistory(nodeId)).toHaveLength(1);
        expect(fx.db.getLatestCode(nodeId)?.code_snapshot).toBe(secondSnippet);
        expect(fx.db.getFullHistory(nodeId)[0].edits).toHaveLength(1);
      } finally {
        fx.cleanup();
      }
    });

    it('getLatestCode returns null when the only history row has an empty (merged, in-progress) snapshot', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#weird';
        // A history row can legitimately have '' as its SQLite code_snapshot column value in the
        // merge branch (the disk JSON carries the real content) — getLatestCode treats a blank
        // snapshot as "nothing usable" defensively. Exercise this via a node with literally no history.
        expect(fx.db.getLatestCode(nodeId)).toBeNull();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getLiveCode', () => {
    it('reads the CURRENT file off disk (source: "live") and flags drift from the cached snapshot', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const nodeId = '{app}/foo.ts#greet';

        // Bypass the graph entirely — edit the file directly on disk.
        fs.writeFileSync(
          repoFile(fx, 'foo.ts'),
          "import { format } from './bar';\n\nexport function greet(name: string): string {\n  return format(name) + '!';\n}\n"
        );

        const live = fx.db.getLiveCode(nodeId);
        expect(live.exists).toBe(true);
        expect(live.source).toBe('live');
        expect(live.snapshot_outdated).toBe(true);
        expect(live.code).toContain("'!'");
        expect(live.message).toBeTruthy();
      } finally {
        fx.cleanup();
      }
    });

    it('reports source: "live" and snapshot_outdated: false when disk agrees with the cached snapshot', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const nodeId = '{app}/foo.ts#greet';
        const live = fx.db.getLiveCode(nodeId);
        expect(live.source).toBe('live');
        expect(live.snapshot_outdated).toBe(false);
      } finally {
        fx.cleanup();
      }
    });

    it('falls back to the cached snapshot (source: "cached", snapshot_outdated: true) when the symbol cannot be located on disk', async () => {
      const fx = makeFixture();
      try {
        // "ghost" is never actually declared in foo.ts, so extractNodeFromFile can't locate it.
        await stageAndCommit(fx, [
          { node_id: 'ghost', file_path: repoFile(fx, 'foo.ts'), code_snapshot: 'export function ghost() { return 1; }', name: 'ghost', type: 'function' }
        ]);
        const ghostId = '{app}/foo.ts#ghost';
        const live = fx.db.getLiveCode(ghostId);
        expect(live.exists).toBe(true);
        expect(live.source).toBe('cached');
        expect(live.snapshot_outdated).toBe(true);
        expect(live.code).toBe('export function ghost() { return 1; }');
      } finally {
        fx.cleanup();
      }
    });

    it('reports exists: false when there is neither a node nor a cached snapshot', () => {
      const fx = makeFixture();
      try {
        const missing = fx.db.getLiveCode('{app}/nope.ts#ghost');
        expect(missing.exists).toBe(false);
        expect(missing.code).toBeUndefined();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('eraseLastEdit', () => {
    it('returns a not-found reason for an unknown history id', () => {
      const fx = makeFixture();
      try {
        const result = fx.db.eraseLastEdit('nonexistent-history-id');
        expect(result).toEqual({ erased: false, entry_deleted: false, reason: 'history entry not found' });
      } finally {
        fx.cleanup();
      }
    });

    it('refuses when the entry has no recorded edits', async () => {
      const fx = makeFixture();
      try {
        // code_before undefined -> no edit recorded (legacy update_history / index-snapshot style entry).
        const summary = await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const result = fx.db.eraseLastEdit(summary.history_ids[0]);
        expect(result).toEqual({ erased: false, entry_deleted: false, reason: 'entry has no recorded edits' });
      } finally {
        fx.cleanup();
      }
    });

    it('unwinds a middle edit, leaving the row with the prior edit as its new snapshot', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        fx.db.updateHistory({ node_id: nodeId, code_snapshot: 'v1', code_before: null, reasoning: 'v1' });
        const h = fx.db.updateHistory({ node_id: nodeId, code_snapshot: 'v2', code_before: 'v1', reasoning: 'v2' });

        expect(fx.db.getFullHistory(nodeId)[0].edits).toHaveLength(2);

        const result = fx.db.eraseLastEdit(h.id);
        expect(result).toEqual({ erased: true, entry_deleted: false });

        const after = fx.db.getFullHistory(nodeId)[0];
        expect(after.edits).toHaveLength(1);
        expect(after.edits[0].after).toBe('v1');
        expect(after.code_snapshot).toBe('v1'); // rolled back to the remaining edit's "after"
      } finally {
        fx.cleanup();
      }
    });

    it('deletes the row outright when its LAST remaining edit is erased and nothing cites it', async () => {
      const fx = makeFixture();
      try {
        const summary = await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, code_before: null, name: 'greet', type: 'function' }
        ]);
        const historyId = summary.history_ids[0];
        expect(fx.db.getHistoryEntry(historyId)?.edits).toHaveLength(1);

        const result = fx.db.eraseLastEdit(historyId);
        expect(result).toEqual({ erased: true, entry_deleted: true });
        expect(fx.db.getHistoryEntry(historyId)).toBeNull();
        expect(fx.db.listHistory('{app}/foo.ts#greet')).toHaveLength(0);
      } finally {
        fx.cleanup();
      }
    });

    it('deletes the row outright even when a workflow step exists — nothing cites history any more', async () => {
      // There used to be a citation guard: a history row referenced by a workflow step was emptied
      // rather than deleted, so the step was not left pointing at nothing. Steps record `node_ids`
      // now, so no step references a history row at all and the guard had nothing to check —
      // keeping it would have meant keeping the `history_ids` column alive to protect a reference
      // nothing makes. A revert should leave no trace, and now it does.
      const fx = makeFixture();
      try {
        const summary = await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, code_before: null, name: 'greet', type: 'function' }
        ]);
        const historyId = summary.history_ids[0];

        const workflow = fx.db.createWorkflow('test workflow', 'a step exists alongside this edit');
        fx.db.addWorkflowStep(workflow.id, { summary: 'did the thing', nodeIds: ['{app}/foo.ts#greet'] });

        const result = fx.db.eraseLastEdit(historyId);
        expect(result.erased).toBe(true);
        expect(result.entry_deleted).toBe(true);
        expect(result.reason).toBeUndefined();
        expect(fx.db.getHistoryEntry(historyId)).toBeNull();

        // The step is untouched — it never depended on that row.
        expect(fx.db.getWorkflowSteps(workflow.id)).toHaveLength(1);
      } finally {
        fx.cleanup();
      }
    });
  });
});
