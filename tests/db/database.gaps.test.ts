import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DevMindDatabase, parseReasoningBlocks, parseReasoningBlocksTimed } from '../../src/db/database';
import { hashDescription, EMBEDDING_MODEL_ID, EMBEDDING_DIM } from '../../src/db/embedder';
import { tokenizeText } from '../../src/utils/tokenize';
import { makeFixture, stageAndCommit, repoFile } from '../helpers/fixture';

// `import * as fs` (under esModuleInterop) produces a non-configurable namespace wrapper that
// jest.spyOn cannot redefine. A plain `require('fs')` returns the real, mutable Node module
// object — the same singleton src/db/database.ts's `fs.xxx` calls proxy back to — so spying on
// THIS reference still intercepts calls made from database.ts. See tests/db/activity.fs.test.ts
// for the same pattern.
const fsReal: typeof fs = require('fs');

const FOO_SNIPPET = 'export function greet(name: string): string {\n  return format(name);\n}';
const BAR_SNIPPET = 'export function format(s: string): string {\n  return "hi " + s;\n}';

/** Raw access to the live better-sqlite3 connection — `db` is `private` at the TS level only. */
function raw(db: DevMindDatabase) {
  return (db as any).db as import('better-sqlite3').Database;
}

describe('DevMindDatabase — coverage gaps', () => {
  describe('parseReasoningBlocks (pure function)', () => {
    it('returns [] for empty/non-string input', () => {
      expect(parseReasoningBlocks('')).toEqual([]);
      expect(parseReasoningBlocks(null as unknown as string)).toEqual([]);
      expect(parseReasoningBlocks(undefined as unknown as string)).toEqual([]);
    });

    it('treats an unlabeled chunk as free-text what_changed', () => {
      const result = parseReasoningBlocks('just some free text, no labels here');
      expect(result).toEqual([{ what_changed: 'just some free text, no labels here', why: '', goal: '' }]);
    });

    it('parses structured blocks and returns them NEWEST FIRST', () => {
      const raw1 = 'What changed: added v1\nWhy: needed it\nGoal: ship it\nRequirement: req1\nPrevious state: none\nDecision: use X\nDeveloper: Alice\nModel: Claude';
      const combined = `${raw1}\n\n── Update @ 2026-01-01T00:00:00.000Z ──\nWhat changed: added v2\nWhy: follow-up`;
      const blocks = parseReasoningBlocks(combined);
      expect(blocks).toHaveLength(2);
      // Newest first.
      expect(blocks[0].what_changed).toBe('added v2');
      expect(blocks[0].why).toBe('follow-up');
      expect(blocks[0].goal).toBe('');
      expect(blocks[1].what_changed).toBe('added v1');
      expect(blocks[1].requirement).toBe('req1');
      expect(blocks[1].previous_state).toBe('none');
      expect(blocks[1].decision).toBe('use X');
      expect(blocks[1].developer).toBe('Alice');
      expect(blocks[1].model).toBe('Claude');
    });
  });

  describe('dropReasoningBlock (exercised indirectly through eraseLastEdit)', () => {
    // dropReasoningBlock is a module-private helper with exactly one call site
    // (eraseLastEdit). Its two edge branches — dropping the sole/oldest block (i===0)
    // and finding no matching block at all — are not reachable through updateHistory's
    // normal merge flow (the trail and the flattened reasoning text always stay in lockstep
    // there), so they're exercised here by writing a synthetic history entry directly to
    // disk/DB where edits[].reasoning and the flattened reasoning text diverge, mimicking a
    // hand-edited or legacy-format history JSON.
    function writeSyntheticHistory(
      fx: ReturnType<typeof makeFixture>,
      opts: { id: string; nodeId: string; reasoning: string; edits: { at: string; before: string; after: string; reasoning: string }[] }
    ) {
      const now = new Date().toISOString();
      raw(fx.db).prepare(`
        INSERT INTO history (id, node_id, session_id, created_at, updated_at, code_snapshot, reasoning)
        VALUES (?, ?, ?, ?, ?, '', ?)
      `).run(opts.id, opts.nodeId, 'session-1', now, now, opts.reasoning);
      const historyDir = path.join(fx.devmindPath, 'history');
      fs.mkdirSync(historyDir, { recursive: true });
      fs.writeFileSync(path.join(historyDir, `${opts.id}.json`), JSON.stringify({
        id: opts.id, node_id: opts.nodeId, session_id: 'session-1', created_at: now, updated_at: now,
        code_snapshot: opts.edits[opts.edits.length - 1].after, reasoning: opts.reasoning, edits: opts.edits
      }, null, 2));
    }

    it('drops the sole block (i===0 branch) when the dropped edit\'s reasoning is the only block present', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        writeSyntheticHistory(fx, {
          id: 'hist-solo-block',
          nodeId,
          reasoning: 'Block A',
          edits: [
            { at: '2026-01-01T00:00:00.000Z', before: '', after: 'v1', reasoning: 'Block A' },
            { at: '2026-01-01T00:01:00.000Z', before: 'v1', after: 'v2', reasoning: 'Block A' }
          ]
        });

        const result = fx.db.eraseLastEdit('hist-solo-block');
        expect(result).toEqual({ erased: true, entry_deleted: false });

        const entry = fx.db.getHistoryEntry('hist-solo-block')!;
        expect(entry.edits).toHaveLength(1);
        // The single remaining block was spliced out entirely, leaving an empty reasoning log.
        expect(entry.reasoning).toBe('');
      } finally {
        fx.cleanup();
      }
    });

    it('leaves the reasoning text untouched when the dropped edit\'s reasoning matches no block (legacy/hand-edited data)', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        writeSyntheticHistory(fx, {
          id: 'hist-mismatch',
          nodeId,
          reasoning: 'Block A',
          edits: [
            { at: '2026-01-01T00:00:00.000Z', before: '', after: 'v1', reasoning: 'Block A' },
            { at: '2026-01-01T00:01:00.000Z', before: 'v1', after: 'v2', reasoning: 'Text that was never appended to the log' }
          ]
        });

        const result = fx.db.eraseLastEdit('hist-mismatch');
        expect(result).toEqual({ erased: true, entry_deleted: false });

        const entry = fx.db.getHistoryEntry('hist-mismatch')!;
        expect(entry.edits).toHaveLength(1);
        // No block matched the dropped edit's reasoning text, so the log is returned unchanged.
        expect(entry.reasoning).toBe('Block A');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('low-level DB ops: shouldReport / getSystemMeta / getCounts / vacuum', () => {
    it('shouldReport throttles to ~100 updates and always reports the final item', () => {
      const shouldReport = (DevMindDatabase as any).shouldReport as (done: number, total: number) => boolean;
      // total=500 -> every = floor(500/100) = 5
      expect(shouldReport(5, 500)).toBe(true);
      expect(shouldReport(3, 500)).toBe(false);
      expect(shouldReport(500, 500)).toBe(true); // always report the last one, even off-cadence
      // total=1 -> every = max(1, floor(1/100)) = 1 -> every done reports
      expect(shouldReport(1, 1)).toBe(true);
    });

    it('getSystemMeta / getCounts / vacuum degrade to safe defaults instead of throwing when the connection is closed', () => {
      const fx = makeFixture();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fx.db.setSystemMeta('foo', 'bar');
        expect(fx.db.getSystemMeta('foo')).toBe('bar');

        fx.db.close();

        expect(fx.db.getSystemMeta('foo')).toBeNull();
        expect(fx.db.getCounts()).toEqual({ nodes: 0, connections: 0, history: 0 });
        expect(() => fx.db.vacuum()).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('VACUUM failed'), expect.anything());
      } finally {
        warnSpy.mockRestore();
        // db already closed; cleanup's own close() is guarded by try/catch.
        fx.cleanup();
      }
    });
  });

  describe('clearAllConnections', () => {
    it('deletes every connection and rewrites every affected file\'s graph JSON', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
        ]);
        expect(fx.db.getAllConnections().length).toBeGreaterThan(0);

        fx.db.clearAllConnections();

        expect(fx.db.getAllConnections()).toEqual([]);
        const graphJsonPath = path.join(fx.devmindPath, 'graph', 'app', 'foo.json');
        const data = JSON.parse(fs.readFileSync(graphJsonPath, 'utf-8'));
        expect(data.connections).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getNodesNeedingEmbedding', () => {
    it('flags missing/stale/model-mismatched vectors, excludes described-and-fresh, force returns all described', () => {
      const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'x.ts': 'export const x = 1;\n' } });
      try {
        const a = '{app}/x.ts#a';
        const b = '{app}/x.ts#b';
        const c = '{app}/x.ts#c';
        const d = '{app}/x.ts#d';
        const e = '{app}/x.ts#e'; // no description
        const f = '{app}/x.ts#f'; // deprecated, described

        fx.db.upsertNode({ id: a, type: 'const', name: 'a', file_path: repoFile(fx, 'x.ts'), description: 'A desc' });
        fx.db.upsertNode({ id: b, type: 'const', name: 'b', file_path: repoFile(fx, 'x.ts'), description: 'B desc' });
        fx.db.upsertNode({ id: c, type: 'const', name: 'c', file_path: repoFile(fx, 'x.ts'), description: 'C desc' });
        fx.db.upsertNode({ id: d, type: 'const', name: 'd', file_path: repoFile(fx, 'x.ts'), description: 'D desc' });
        fx.db.upsertNode({ id: e, type: 'const', name: 'e', file_path: repoFile(fx, 'x.ts') });
        fx.db.upsertNode({ id: f, type: 'const', name: 'f', file_path: repoFile(fx, 'x.ts'), description: 'F desc' });
        fx.db.deprecateNode(f);

        // b: fresh, matching vector -> should be excluded from the normal (non-force) queue.
        fx.db.upsertNodeVector(b, new Int8Array([1, 2, 3, 4]), hashDescription('B desc'));
        // d: vector present but hash stale (description changed since it was computed).
        fx.db.upsertNodeVector(d, new Int8Array([1, 2, 3, 4]), hashDescription('stale text'));
        // c: vector present but from a different embedding model entirely (raw insert; upsertNodeVector always writes the current model).
        raw(fx.db).prepare(`
          INSERT INTO node_vectors (node_id, model_id, dim, description_hash, vector)
          VALUES (?, ?, ?, ?, ?)
        `).run(c, 'some-other-model-v0', 4, hashDescription('C desc'), Buffer.from([1, 2, 3, 4]));

        const queue = fx.db.getNodesNeedingEmbedding().map(n => n.id).sort();
        expect(queue).toEqual([a, c, d].sort());

        const forced = fx.db.getNodesNeedingEmbedding(true).map(n => n.id).sort();
        expect(forced).toEqual([a, b, c, d].sort());
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('parseNodeAliases — corrupted aliases column', () => {
    it('falls back to [] when the stored aliases JSON is malformed', () => {
      const fx = makeFixture();
      try {
        const id = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        raw(fx.db).prepare('UPDATE nodes SET aliases = ? WHERE id = ?').run('{not valid json', id);

        const node = fx.db.getNode(id)!;
        expect(node.aliases).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('deleteNode (hard delete)', () => {
    it('removes the node, its history JSONs, its vector, and rewrites both its own and callers\' graph JSON', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
        ]);
        const greetId = '{app}/foo.ts#greet';
        const formatId = '{app}/bar.ts#format';
        fx.db.upsertNodeVector(formatId, new Int8Array([1, 2, 3, 4]), hashDescription('x'));

        const barJsonPath = path.join(fx.devmindPath, 'graph', 'app', 'bar.json');
        const fooJsonPath = path.join(fx.devmindPath, 'graph', 'app', 'foo.json');
        expect(fs.existsSync(barJsonPath)).toBe(true);
        expect(JSON.parse(fs.readFileSync(fooJsonPath, 'utf-8')).connections.length).toBeGreaterThan(0);

        const historyId = fx.db.getLatestHistory(formatId)!.id;
        const historyJsonPath = path.join(fx.devmindPath, 'history', `${historyId}.json`);
        expect(fs.existsSync(historyJsonPath)).toBe(true);

        fx.db.deleteNode(formatId);

        expect(fx.db.getNode(formatId)).toBeNull();
        expect(fx.db.getNodeVector(formatId)).toBeNull();
        expect(fs.existsSync(historyJsonPath)).toBe(false);

        // bar.ts's graph JSON had exactly one node — it's now gone entirely.
        expect(fs.existsSync(barJsonPath)).toBe(false);

        // foo.ts (the caller) had its stale inbound edge cleaned up.
        const fooData = JSON.parse(fs.readFileSync(fooJsonPath, 'utf-8'));
        expect(fooData.connections.find((c: any) => c.target_node_id === formatId)).toBeUndefined();
        expect(fx.db.getConnections(greetId).uses).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });

    it('is safe (no throw) when deleting an id that does not exist', () => {
      const fx = makeFixture();
      try {
        expect(() => fx.db.deleteNode('{app}/nope.ts#ghost')).not.toThrow();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('renameNode — additional branches', () => {
    it('throws for an unknown node', () => {
      const fx = makeFixture();
      try {
        expect(() => fx.db.renameNode('{app}/nope.ts#ghost', '{app}/nope.ts#renamed')).toThrow(/Node not found/);
      } finally {
        fx.cleanup();
      }
    });

    it('a file-move rename rewrites BOTH the old and new file\'s graph JSON, and callers\' inbound edges', async () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'foo.ts': "import { format } from './bar';\n\nexport function greet(name: string): string {\n  return format(name);\n}\n",
          'bar.ts': BAR_SNIPPET,
          'bar2.ts': '// moved-to destination, initially empty aside from the import target\n'
        }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
        ]);
        const oldId = '{app}/bar.ts#format';
        const newId = '{app}/bar2.ts#format';
        const greetId = '{app}/foo.ts#greet';

        fx.db.renameNode(oldId, newId, 'format', repoFile(fx, 'bar2.ts'));

        const oldJsonPath = path.join(fx.devmindPath, 'graph', 'app', 'bar.json');
        const newJsonPath = path.join(fx.devmindPath, 'graph', 'app', 'bar2.json');
        // Old file's JSON had exactly one node, which just moved away -> file removed entirely.
        expect(fs.existsSync(oldJsonPath)).toBe(false);
        expect(fs.existsSync(newJsonPath)).toBe(true);
        const newData = JSON.parse(fs.readFileSync(newJsonPath, 'utf-8'));
        expect(newData.nodes.map((n: any) => n.id)).toContain(newId);

        // The caller's file (foo.ts) referenced the OLD id on disk — rewriteInboundSourceFiles
        // must have refreshed it to point at the new id.
        const fooData = JSON.parse(fs.readFileSync(path.join(fx.devmindPath, 'graph', 'app', 'foo.json'), 'utf-8'));
        expect(fooData.connections.some((c: any) => c.target_node_id === newId)).toBe(true);
        expect(fooData.connections.some((c: any) => c.target_node_id === oldId)).toBe(false);
        expect(fx.db.getConnections(greetId).uses.map(n => n.id)).toContain(newId);
      } finally {
        fx.cleanup();
      }
    });

    it('degrades gracefully (no throw, warns) when a cited history JSON is corrupted on disk', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const oldId = '{app}/foo.ts#greet';
        const newId = '{app}/foo.ts#greetRenamed';
        const historyId = fx.db.getLatestHistory(oldId)!.id;
        const historyJsonPath = path.join(fx.devmindPath, 'history', `${historyId}.json`);
        fs.writeFileSync(historyJsonPath, '{ not valid json at all');

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(() => fx.db.renameNode(oldId, newId, 'greetRenamed')).not.toThrow();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('patch history JSON identity'), expect.anything());
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        fx.cleanup();
      }
    });

    it('degrades gracefully (no throw, warns) when a history JSON cannot be deleted during a hard delete', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const unlinkSpy = jest.spyOn(fsReal, 'unlinkSync').mockImplementationOnce(() => { throw new Error('EPERM (simulated)'); });
        try {
          expect(() => fx.db.deleteNode('{app}/foo.ts#greet')).not.toThrow();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('delete history JSON'), expect.anything());
        } finally {
          unlinkSpy.mockRestore();
          warnSpy.mockRestore();
        }
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('mergeNodes — inbound edge reassignment (skip + real-repoint branches)', () => {
    it('does not create a self-loop when the merge target already points at the merge source, but DOES repoint a third node\'s inbound edge', async () => {
      const fx = makeFixture({
        extraFiles: { 'other.ts': "import { format } from './bar';\n\nexport function otherCaller(): string {\n  return format('x');\n}\n" }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' },
          { node_id: 'otherCaller', file_path: repoFile(fx, 'other.ts'), code_snapshot: "export function otherCaller(): string {\n  return format('x');\n}", name: 'otherCaller', type: 'function' }
        ]);
        const greetId = '{app}/foo.ts#greet'; // will be the merge TARGET (intoId) — already uses format
        const formatId = '{app}/bar.ts#format'; // will be the merge SOURCE (fromId)
        const otherId = '{app}/other.ts#otherCaller'; // a THIRD node that also uses format

        expect(fx.db.getConnections(greetId).uses.map(n => n.id)).toContain(formatId);
        expect(fx.db.getConnections(otherId).uses.map(n => n.id)).toContain(formatId);

        fx.db.mergeNodes(formatId, greetId);

        const conns = fx.db.getConnections(greetId);
        // No self-referencing edge was created from greet's own (skipped) inbound edge.
        expect(conns.uses.map(n => n.id)).not.toContain(greetId);
        expect(conns.usedBy.map(n => n.id)).not.toContain(greetId);
        // otherCaller's edge WAS genuinely reassigned onto the merge target (the real,
        // non-skipped branch of the inbound-reassignment loop).
        expect(fx.db.getConnections(otherId).uses.map(n => n.id)).toContain(greetId);
        expect(conns.usedBy.map(n => n.id)).toContain(otherId);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getInboundSources', () => {
    it('returns distinct source ids of edges pointing INTO a node', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
        ]);
        expect(fx.db.getInboundSources('{app}/bar.ts#format')).toEqual(['{app}/foo.ts#greet']);
        expect(fx.db.getInboundSources('{app}/foo.ts#greet')).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('updateHistory — configured developer overrides the AI-supplied one', () => {
    it('always attributes history to .env\'s DEVELOPER_NAME when set', () => {
      const fx = makeFixture({ env: { DEVELOPER_NAME: 'Real Developer' } });
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        const h = fx.db.updateHistory({
          node_id: nodeId,
          code_snapshot: 'v1',
          code_before: null,
          reasoning: { what_changed: 'did a thing', why: 'because', goal: 'ship', developer: 'Some AI Assistant' }
        });
        expect(h.reasoning).toContain('Developer: Real Developer');
        expect(h.reasoning).not.toContain('Some AI Assistant');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('paged reads with an unresolvable or partially-specified argument', () => {
    it('getConnections accepts a limit with no offset, defaulting to the first page', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const page = fx.db.getConnections('{app}/foo.ts#greet', { limit: 5 });
        expect(Array.isArray(page.uses)).toBe(true);
        expect(Array.isArray(page.usedBy)).toBe(true);
      } finally {
        fx.cleanup();
      }
    });

    it('the history readers fall back to the raw id when it resolves to no node', () => {
      // An id that getNode cannot resolve must still be queried verbatim rather than throwing —
      // history rows outlive the node row when one is renamed or pruned.
      const fx = makeFixture();
      try {
        expect(fx.db.getRecentHistorySummaries('{app}/nope.ts#missing', 3)).toEqual([]);
        expect(fx.db.getHistoryPage('{app}/nope.ts#missing', 5, 0)).toEqual({ entries: [], total: 0 });
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getGraph — includeCode when no code is available at all', () => {
    it('counts a node toward nodes_without_code when neither live extraction nor a cached snapshot succeeds', () => {
      const fx = makeFixture();
      try {
        const rootId = '{app}/foo.ts#greet';
        const ghostId = '{app}/foo.ts#neverExisted';
        fx.db.upsertNode({ id: rootId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        // A symbol that is not actually declared anywhere in foo.ts, and has no history —
        // extractLiveCode returns null AND getLatestCode returns null.
        fx.db.upsertNode({ id: ghostId, type: 'function', name: 'neverExisted', file_path: repoFile(fx, 'foo.ts') });
        fx.db.addConnection(rootId, ghostId);

        const g = fx.db.getGraph(rootId, 1, { direction: 'out', includeCode: true });
        expect(g.nodes.map(n => n.id)).toContain(ghostId);
        expect(g.code_truncated).toBe(true);
        expect(g.nodes_without_code).toBeGreaterThanOrEqual(1);
        const ghost = g.nodes.find(n => n.id === ghostId)!;
        expect(ghost.code).toBeUndefined();
      } finally {
        fx.cleanup();
      }
    });

    it('reports a code-less node under nodes_no_code_available, NOT as a budget omission', () => {
      // The distinction that makes the response actionable: raising graph_code_budget will never
      // resurrect this node, so listing it alongside the budget drops would send the caller off to
      // retry a call that cannot possibly do better.
      const fx = makeFixture();
      try {
        const rootId = '{app}/foo.ts#greet';
        const ghostId = '{app}/foo.ts#neverExisted';
        fx.db.upsertNode({ id: rootId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        fx.db.upsertNode({ id: ghostId, type: 'function', name: 'neverExisted', file_path: repoFile(fx, 'foo.ts') });
        fx.db.addConnection(rootId, ghostId);

        const g = fx.db.getGraph(rootId, 1, { direction: 'out', includeCode: true });
        expect(g.nodes_no_code_available).toBe(1);
        expect(g.code_omitted_node_ids).toBeUndefined();
      } finally {
        fx.cleanup();
      }
    });

    it('a code-less node does not consume budget or stop later nodes from getting code', () => {
      // The rule that keeps the two causes from interfering: only BUDGET exhaustion should end the
      // spend. If an unresolvable node were treated as a budget event, one dead node early in the
      // walk would suppress code for everything after it — and the caller would see a truncation
      // they could never clear.
      const fx = makeFixture({
        extraFiles: { 'later.ts': 'export function later(): number {\n  return 7;\n}\n' }
      });
      try {
        const rootId = '{app}/foo.ts#greet';
        const ghostId = '{app}/foo.ts#neverExisted';
        const laterId = '{app}/later.ts#later';
        fx.db.upsertNode({ id: rootId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        fx.db.upsertNode({ id: ghostId, type: 'function', name: 'neverExisted', file_path: repoFile(fx, 'foo.ts') });
        fx.db.upsertNode({ id: laterId, type: 'function', name: 'later', file_path: repoFile(fx, 'later.ts') });
        // Ordered so the code-less node is visited BEFORE the one that should still get code
        // ("{app}/foo.ts#neverExisted" sorts ahead of "{app}/later.ts#later").
        fx.db.addConnection(rootId, ghostId);
        fx.db.addConnection(rootId, laterId);

        const g = fx.db.getGraph(rootId, 1, { direction: 'out', includeCode: true });
        const later = g.nodes.find(n => n.id === laterId)!;
        expect(later.code).toContain('return 7');
        expect(g.nodes_no_code_available).toBe(1);
        expect(g.code_omitted_node_ids).toBeUndefined();
      } finally {
        fx.cleanup();
      }
    });
  });

  // NOTE: three `findWorkflowStepsCiting` describes were removed with the method. It existed to
  // stop eraseLastEdit deleting a history row a workflow step pointed at — steps record node_ids
  // now, so nothing references a history row and the guard had nothing left to check.
  // tests/db/history.test.ts asserts the replacement behaviour: the row is deleted outright.

  describe('workflow disk-write resilience', () => {
    it('createWorkflow still returns/persists the workflow row when the disk write fails', () => {
      const fx = makeFixture();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const writeSpy = jest.spyOn(fsReal, 'writeFileSync').mockImplementationOnce(() => { throw new Error('disk full (simulated)'); });
      try {
        const wf = fx.db.createWorkflow('resilient wf', 'desc');
        expect(fx.db.getWorkflow(wf.id)).toBeTruthy();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to write workflow JSON'), expect.anything());
      } finally {
        writeSpy.mockRestore();
        warnSpy.mockRestore();
        fx.cleanup();
      }
    });
  });

  describe('getWorkflowContext — artifacts', () => {
    it('returns artifact metadata and never reads the file, so an unreadable path cannot break the call', () => {
      // getWorkflowContext used to inline artifact content, which meant a whole imported doc could
      // land in one response — and an unreadable path needed its own guard. It hands back the path
      // now, so both problems are structural rather than handled.
      const fx = makeFixture();
      try {
        const wf = fx.db.createWorkflow('wf', 'desc');
        // file_path points at a real DIRECTORY: reading it would throw EISDIR.
        raw(fx.db).prepare(`
          INSERT INTO workflow_artifacts (id, workflow_id, step_id, type, source_name, file_path, created_at)
          VALUES (?, ?, NULL, 'note', 'dir-artifact', ?, ?)
        `).run('art-dir', wf.id, fx.devmindPath, new Date().toISOString());

        const ctx = fx.db.getWorkflowContext(wf.id);
        const art = ctx.artifacts.find(a => a.id === 'art-dir')!;
        expect(art).toBeTruthy();
        expect(art.file_path).toBe(fx.devmindPath);
        expect(art).not.toHaveProperty('content');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('importWorkflowDoc — existing workflow without a prior imported_doc artifact', () => {
    it('adds a fresh imported_doc artifact instead of overwriting one that does not exist yet', () => {
      const fx = makeFixture();
      try {
        const created = fx.db.createWorkflow('Existing WF', 'original desc');
        expect(fx.db.getWorkflowContext(created.id).artifacts).toEqual([]);

        const result = fx.db.importWorkflowDoc('Existing WF', 'new desc', 'doc content', 'source.md');
        expect(result.created).toBe(false);
        expect(result.workflow.id).toBe(created.id);
        expect(result.workflow.description).toBe('new desc');

        const ctx = fx.db.getWorkflowContext(created.id);
        const artifact = ctx.artifacts.find(a => a.type === 'imported_doc');
        expect(artifact).toBeTruthy();
        expect(fs.readFileSync(artifact!.file_path, 'utf-8')).toBe('doc content');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('pruneSpuriousNodes — rewrites callers of a pruned node', () => {
    it('rewrites the inbound caller\'s graph JSON when a spurious-named node with a caller is pruned', async () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: { 'caller.ts': 'export function caller(): number {\n  return 1;\n}\n' }
      });
      try {
        const callerId = '{app}/caller.ts#caller';
        const spuriousId = '{app}/caller.ts#temp';
        await stageAndCommit(fx, [
          { node_id: 'caller', file_path: repoFile(fx, 'caller.ts'), code_snapshot: 'export function caller(): number {\n  return 1;\n}', name: 'caller', type: 'function' }
        ]);
        fx.db.upsertNode({ id: spuriousId, type: 'variable', name: 'temp', file_path: repoFile(fx, 'caller.ts') });
        fx.db.addConnection(callerId, spuriousId);

        const callerJsonPath = path.join(fx.devmindPath, 'graph', 'app', 'caller.json');
        expect(JSON.parse(fs.readFileSync(callerJsonPath, 'utf-8')).connections.length).toBeGreaterThan(0);

        const result = fx.db.pruneSpuriousNodes(fx.root);
        expect(result.prunedNodes.some(n => n.startsWith('temp '))).toBe(true);

        const after = JSON.parse(fs.readFileSync(callerJsonPath, 'utf-8'));
        expect(after.connections.find((c: any) => c.target_node_id === spuriousId)).toBeUndefined();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('populateHistoryFromDisk — corrupted JSON on disk', () => {
    it('degrades to an empty snapshot/reasoning/edits instead of throwing', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const historyId = fx.db.getLatestHistory('{app}/foo.ts#greet')!.id;
        const historyJsonPath = path.join(fx.devmindPath, 'history', `${historyId}.json`);
        fs.writeFileSync(historyJsonPath, '{ this is not valid json');

        const entry = fx.db.getHistoryEntry(historyId)!;
        expect(entry.code_snapshot).toBe('');
        expect(entry.reasoning).toBe('');
        expect(entry.edits).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('writeHistoryToDisk — disk write failure', () => {
    it('does not throw and warns when the history directory cannot be created/written', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });

        // Pre-create 'history' as a plain FILE instead of a directory: existsSync(historyDir) is
        // true (so the mkdirSync guard is skipped), but writing "<historyDir>/<id>.json" then
        // fails with ENOTDIR since a path component is a file, not a directory.
        const historyDir = path.join(fx.devmindPath, 'history');
        fs.writeFileSync(historyDir, 'not a directory');

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(() => fx.db.updateHistory({ node_id: nodeId, code_snapshot: 'v1', code_before: null, reasoning: 'test' })).not.toThrow();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to write history JSON'), expect.anything());
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        fs.rmSync(path.join(fx.devmindPath, 'history'), { force: true });
        fx.cleanup();
      }
    });
  });

  describe('getDeveloperName', () => {
    it('returns the configured developer name, or null when unset', () => {
      const withDev = makeFixture({ env: { DEVELOPER_NAME: 'Ada' } });
      const withoutDev = makeFixture();
      try {
        expect(withDev.db.getDeveloperName()).toBe('Ada');
        expect(withoutDev.db.getDeveloperName()).toBeNull();
      } finally {
        withDev.cleanup();
        withoutDev.cleanup();
      }
    });
  });

  describe('path helpers: toRepoRelativePath / clampToRoot / toAbsolutePath', () => {
    it('toRepoRelativePath falls back to a workspace(.devmind)-root-relative path outside any configured repo', () => {
      const fx = makeFixture();
      try {
        // Not inside the configured "app" repo (src-repo/) — falls through to the workspace-root
        // (.devmind's parent) relative fallback instead of a "{repo}/..." form.
        const outsidePath = path.join(fx.root, 'other.txt');
        const rel = fx.db.toRepoRelativePath(outsidePath);
        expect(rel).not.toMatch(/^\{app\}/);
        expect(rel.replace(/\\/g, '/')).toBe('../other.txt');
      } finally {
        fx.cleanup();
      }
    });

    it('clampToRoot blocks a resolved path that escapes its root and warns, falling back to the root itself', () => {
      const fx = makeFixture();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const escaped = fx.db.toAbsolutePath('{app}/../../../../escape.txt');
        expect(escaped.toLowerCase()).toBe(fx.repoDir.toLowerCase());
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Path traversal blocked'));
      } finally {
        warnSpy.mockRestore();
        fx.cleanup();
      }
    });

    it('toAbsolutePath resolves a bare path containing the repo name as a folder segment (no {repo} prefix)', () => {
      const fx = makeFixture();
      try {
        const resolved = fx.db.toAbsolutePath('app/foo.ts');
        expect(resolved.toLowerCase()).toBe(repoFile(fx, 'foo.ts').toLowerCase());
      } finally {
        fx.cleanup();
      }
    });

    it('toAbsolutePath falls back to workspace-root-relative resolution when nothing matches', () => {
      const fx = makeFixture();
      try {
        const resolved = fx.db.toAbsolutePath('some/random/path.txt');
        expect(resolved.toLowerCase()).toBe(path.join(fx.devmindPath, 'some', 'random', 'path.txt').toLowerCase());
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('syncFromDisk — restores workflows from disk on a fresh DB', () => {
    it('rebuilds workflows/steps/artifacts from workflow.json, and IGNORES a v1 is_active flag', () => {
      const fx = makeFixture();
      try {
        const dbPath = path.join(fx.devmindPath, 'brain.db');
        const workflowId = 'wf_restored_1';
        const stepId = 'step_restored_1';
        const artifactId = 'art_restored_1';
        const now = new Date().toISOString();
        const wfDir = path.join(fx.devmindPath, 'workflows', workflowId);
        fs.mkdirSync(wfDir, { recursive: true });
        fs.writeFileSync(path.join(wfDir, 'workflow.json'), JSON.stringify({
          id: workflowId, name: 'Restored WF', description: 'restored from disk', status: 'active',
          created_at: now, updated_at: now, is_active: true,
          steps: [{ id: stepId, step_index: 1, summary: 'did a thing', pending_tasks: null, history_ids: null, session_id: null, created_at: now }],
          artifact_index: [{ id: artifactId, step_id: stepId, type: 'note', source_name: 'note.md', file_path: path.join(wfDir, 'note.md'), created_at: now }]
        }, null, 2));

        fx.db.close();
        const db2 = new DevMindDatabase(dbPath);
        try {
          const wf = db2.getWorkflow(workflowId);
          expect(wf).toBeTruthy();
          expect(wf!.name).toBe('Restored WF');
          expect(db2.getWorkflowSteps(workflowId)).toHaveLength(1);
          expect(db2.getWorkflowContext(workflowId).artifacts).toHaveLength(1);
          // The JSON says is_active:true — a v1 file. That flag is deliberately ignored now: it
          // was how one developer's "currently working on" travelled through git and displaced
          // everyone else's. Which workflow you are on is session-local and never synced.
          expect(db2.getSystemMeta('active_workflow_id')).toBeFalsy();
        } finally {
          db2.close();
        }
      } finally {
        fx.cleanup();
      }
    });

    it('reads a v1 workflow.json (no archived/reasoning/node_ids) without losing the workflow', () => {
      // Forward compatibility in the direction that actually happens: a teammate who has not
      // upgraded yet keeps committing v1 files. Those must still import — the step simply shows
      // its summary, which is all v1 ever stored anyway.
      const fx = makeFixture();
      try {
        const legacyId = 'wf_v1_shape';
        const now = new Date().toISOString();
        const wfDir = path.join(fx.devmindPath, 'workflows', legacyId);
        fs.mkdirSync(wfDir, { recursive: true });
        fs.writeFileSync(path.join(wfDir, 'workflow.json'), JSON.stringify({
          id: legacyId, name: 'Legacy Shape', description: 'v1', status: 'paused',
          created_at: now, updated_at: now, is_active: false,
          steps: [{ id: 'v1-step', step_index: 1, summary: 'a v1 step', pending_tasks: 'something', history_ids: '["h1"]', session_id: null, created_at: now }],
          artifact_index: []
        }, null, 2));

        fx.db.syncFromDisk();
        const wf = fx.db.getWorkflow(legacyId);
        expect(wf).toBeTruthy();
        expect(wf!.archived).toBe(0);
        const steps = fx.db.getWorkflowSteps(legacyId);
        expect(steps).toHaveLength(1);
        expect(steps[0].summary).toBe('a v1 step');
        expect(steps[0].reasoning).toBeNull();
        expect(steps[0].node_ids).toBeNull();
      } finally {
        fx.cleanup();
      }
    });

    it('updates an existing step with fields from a newer workflow.json instead of ignoring it', () => {
      // The upsert was INSERT OR IGNORE, so a teammate who already had the step row would never
      // pick up reasoning/node_ids from a newer file — their brain would stay half-migrated with
      // nothing to indicate it.
      const fx = makeFixture();
      try {
        const wf = fx.db.createWorkflow('Upserted', 'desc');
        const step = fx.db.addWorkflowStep(wf.id, { summary: 'original' });

        const wfDir = path.join(fx.devmindPath, 'workflows', wf.id);
        const json = JSON.parse(fs.readFileSync(path.join(wfDir, 'workflow.json'), 'utf-8'));
        json.steps[0].reasoning = 'Why: it arrived from a teammate';
        json.steps[0].node_ids = JSON.stringify(['{app}/foo.ts#greet']);
        fs.writeFileSync(path.join(wfDir, 'workflow.json'), JSON.stringify(json, null, 2));

        fx.db.syncFromDisk();
        const updated = fx.db.getWorkflowSteps(wf.id).find(s => s.id === step.id)!;
        expect(updated.reasoning).toBe('Why: it arrived from a teammate');
        expect(JSON.parse(updated.node_ids!)).toEqual(['{app}/foo.ts#greet']);
      } finally {
        fx.cleanup();
      }
    });

    it('warns and does not throw when the workflows/ tree cannot be read (outer catch-all)', () => {
      const fx = makeFixture();
      try {
        // No workflow was ever created, so 'workflows/' does not exist yet — pre-create it as a
        // plain FILE instead of a directory. syncFromDisk's `fs.existsSync(workflowsDir)` guard
        // sees it as "present" and proceeds to `fs.readdirSync(workflowsDir)`, which throws
        // ENOTDIR — unguarded by any of the inner per-item try/catches, so it propagates all the
        // way out to syncFromDisk's own outer try/catch.
        fs.writeFileSync(path.join(fx.devmindPath, 'workflows'), 'not a directory');

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(() => fx.db.syncFromDisk()).not.toThrow();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to sync from disk'), expect.anything());
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        fs.rmSync(path.join(fx.devmindPath, 'workflows'), { force: true });
        fx.cleanup();
      }
    });
  });

  describe('writeGraphToDisk / writeVectorsToDisk — direct disk failure', () => {
    it('writeGraphToDisk warns and does not throw when the JSON write fails', () => {
      const fx = makeFixture();
      try {
        fx.db.upsertNode({ id: '{app}/foo.ts#greet', type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const writeSpy = jest.spyOn(fsReal, 'writeFileSync').mockImplementationOnce(() => { throw new Error('disk full (simulated)'); });
        try {
          expect(() => fx.db.writeGraphToDisk(repoFile(fx, 'foo.ts'))).not.toThrow();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to write graph JSON'), expect.anything());
        } finally {
          writeSpy.mockRestore();
          warnSpy.mockRestore();
        }
      } finally {
        fx.cleanup();
      }
    });

    it('writeVectorsToDisk warns and does not throw when the JSON write fails', () => {
      const fx = makeFixture();
      try {
        const id = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        fx.db.upsertNodeVector(id, new Int8Array([1, 2, 3, 4]), hashDescription('x'));

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const writeSpy = jest.spyOn(fsReal, 'writeFileSync').mockImplementationOnce(() => { throw new Error('disk full (simulated)'); });
        try {
          expect(() => fx.db.writeVectorsToDisk(repoFile(fx, 'foo.ts'))).not.toThrow();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to write vectors JSON'), expect.anything());
        } finally {
          writeSpy.mockRestore();
          warnSpy.mockRestore();
        }
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('syncToDisk — failure resilience', () => {
    it('warns and does not throw when the underlying connection is unusable', () => {
      const fx = makeFixture();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fx.db.close();
        expect(() => fx.db.syncToDisk()).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to sync database to disk'), expect.anything());
      } finally {
        warnSpy.mockRestore();
        fx.cleanup();
      }
    });
  });

  describe('formatReasoning (pure function) — missing-field fallbacks', () => {
    it('falls back to empty strings for each unset field', () => {
      const { formatReasoning } = require('../../src/db/database');
      const out = formatReasoning({ what_changed: '', why: '', goal: '' });
      expect(out).toBe('What changed: \nWhy: \nGoal: \nRequirement: \nPrevious state: \nDecision: \nDeveloper: \nModel: ');
    });
  });

  describe('parseReasoningBlocks — a chunk with only some structured labels present', () => {
    it('leaves what_changed/why empty when only Goal is present', () => {
      const { parseReasoningBlocks: parse } = require('../../src/db/database');
      const blocks = parse('Goal: only goal here');
      expect(blocks).toEqual([{ what_changed: '', why: '', goal: 'only goal here' }]);
    });
  });

  describe('dropReasoningBlock (exercised via eraseLastEdit) — falsy/blank block guards', () => {
    function writeSyntheticHistory(
      fx: ReturnType<typeof makeFixture>,
      opts: { id: string; nodeId: string; reasoning: string; edits: { at: string; before: string; after: string; reasoning: string }[] }
    ) {
      const now = new Date().toISOString();
      raw(fx.db).prepare(`
        INSERT INTO history (id, node_id, session_id, created_at, updated_at, code_snapshot, reasoning)
        VALUES (?, ?, ?, ?, ?, '', ?)
      `).run(opts.id, opts.nodeId, 'session-1', now, now, opts.reasoning);
      const historyDir = path.join(fx.devmindPath, 'history');
      fs.mkdirSync(historyDir, { recursive: true });
      fs.writeFileSync(path.join(historyDir, `${opts.id}.json`), JSON.stringify({
        id: opts.id, node_id: opts.nodeId, session_id: 'session-1', created_at: now, updated_at: now,
        code_snapshot: opts.edits[opts.edits.length - 1].after, reasoning: opts.reasoning, edits: opts.edits
      }, null, 2));
    }

    it('leaves the reasoning log untouched when the dropped edit carries no reasoning at all', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        writeSyntheticHistory(fx, {
          id: 'hist-empty-block',
          nodeId,
          reasoning: 'Block A',
          edits: [
            { at: '2026-01-01T00:00:00.000Z', before: '', after: 'v1', reasoning: 'Block A' },
            { at: '2026-01-01T00:01:00.000Z', before: 'v1', after: 'v2', reasoning: '' }
          ]
        });

        const result = fx.db.eraseLastEdit('hist-empty-block');
        expect(result).toEqual({ erased: true, entry_deleted: false });
        const entry = fx.db.getHistoryEntry('hist-empty-block')!;
        // dropReasoningBlock's `!block` guard short-circuits before ever touching the log.
        expect(entry.reasoning).toBe('Block A');
      } finally {
        fx.cleanup();
      }
    });

    it('leaves the reasoning log untouched when the dropped edit\'s reasoning is whitespace-only', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        writeSyntheticHistory(fx, {
          id: 'hist-blank-block',
          nodeId,
          reasoning: 'Block A',
          edits: [
            { at: '2026-01-01T00:00:00.000Z', before: '', after: 'v1', reasoning: 'Block A' },
            { at: '2026-01-01T00:01:00.000Z', before: 'v1', after: 'v2', reasoning: '   ' }
          ]
        });

        const result = fx.db.eraseLastEdit('hist-blank-block');
        expect(result).toEqual({ erased: true, entry_deleted: false });
        const entry = fx.db.getHistoryEntry('hist-blank-block')!;
        // dropReasoningBlock's `!target` guard (after trimming) short-circuits before touching the log.
        expect(entry.reasoning).toBe('Block A');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('parseNodeAliases (private static) — direct-input branches not reachable via a raw SQL row', () => {
    it('passes an already-array input straight through, filtering non-string entries', () => {
      const parseNodeAliases = (DevMindDatabase as any).parseNodeAliases as (raw: unknown) => string[];
      expect(parseNodeAliases(['a', 'b', 42, null])).toEqual(['a', 'b']);
    });

    it('returns [] for null/undefined/empty-string input', () => {
      const parseNodeAliases = (DevMindDatabase as any).parseNodeAliases as (raw: unknown) => string[];
      expect(parseNodeAliases(null)).toEqual([]);
      expect(parseNodeAliases(undefined)).toEqual([]);
      expect(parseNodeAliases('')).toEqual([]);
    });

    it('returns [] when the parsed JSON is valid but not an array', () => {
      const parseNodeAliases = (DevMindDatabase as any).parseNodeAliases as (raw: unknown) => string[];
      expect(parseNodeAliases('"just a string"')).toEqual([]);
      expect(parseNodeAliases('42')).toEqual([]);
    });
  });

  describe('clearConnectionsForSources — empty input', () => {
    it('is a no-op (no throw, no writes) when given an empty array', () => {
      const fx = makeFixture();
      try {
        expect(() => fx.db.clearConnectionsForSources([])).not.toThrow();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('upsertNode — aliases on a NEW node', () => {
    it('stores the deduplicated alias set on first insert', () => {
      const fx = makeFixture();
      try {
        const id = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts'), aliases: ['hi', 'hi', 'hello'] });
        const node = fx.db.getNode(id)!;
        expect(node.aliases.sort()).toEqual(['hello', 'hi']);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('upsertNodeVector — unknown node id', () => {
    it('is a no-op (no throw, nothing stored) when the node does not exist', () => {
      const fx = makeFixture();
      try {
        expect(() => fx.db.upsertNodeVector('{app}/nope.ts#ghost', new Int8Array([1, 2, 3, 4]), 'hash')).not.toThrow();
        expect(fx.db.getNodeVector('{app}/nope.ts#ghost')).toBeNull();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getHistoryCounts / getLastUpdatedMap — empty ids array', () => {
    it('both return an empty Map without querying', () => {
      const fx = makeFixture();
      try {
        expect(fx.db.getHistoryCounts([])).toEqual(new Map());
        expect(fx.db.getLastUpdatedMap([])).toEqual(new Map());
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('listHistory / getConnections / removeConnection — unresolved node id fallback', () => {
    it('listHistory falls back to the raw id when the node does not exist (and finds nothing)', () => {
      const fx = makeFixture();
      try {
        expect(fx.db.listHistory('{app}/nope.ts#ghost')).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });

    it('getConnections falls back to the raw id when the node does not exist', () => {
      const fx = makeFixture();
      try {
        expect(fx.db.getConnections('{app}/nope.ts#ghost')).toEqual({ uses: [], usedBy: [] });
      } finally {
        fx.cleanup();
      }
    });

    it('removeConnection falls back to raw ids on both sides when neither node exists (no throw, no write)', () => {
      const fx = makeFixture();
      try {
        expect(() => fx.db.removeConnection('{app}/nope.ts#a', '{app}/nope.ts#b')).not.toThrow();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('attachDrillInHooks (private) — empty input short-circuit', () => {
    it('returns the same empty array without querying', () => {
      const fx = makeFixture();
      try {
        const attachDrillInHooks = (fx.db as any).attachDrillInHooks.bind(fx.db);
        expect(attachDrillInHooks([])).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });
  });

  // ─── Batch 2: rename/merge/history/graph area ────────────────────────────

  describe('mergeNodes — missing-node errors', () => {
    it('throws when fromId does not exist', () => {
      const fx = makeFixture();
      try {
        fx.db.upsertNode({ id: '{app}/foo.ts#greet', type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        expect(() => fx.db.mergeNodes('{app}/foo.ts#ghost', '{app}/foo.ts#greet')).toThrow(/source node not found/);
      } finally {
        fx.cleanup();
      }
    });

    it('throws when intoId does not exist', () => {
      const fx = makeFixture();
      try {
        fx.db.upsertNode({ id: '{app}/foo.ts#greet', type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        expect(() => fx.db.mergeNodes('{app}/foo.ts#greet', '{app}/foo.ts#ghost')).toThrow(/target node not found/);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('mergeNodes — outbound edge that already points at the merge target (skip branch) vs a real reassignment', () => {
    it('does not duplicate/self-loop the outbound edge fromNode already has to intoNode, but DOES reassign a different outbound edge', async () => {
      const fx = makeFixture(); // default foo.ts (greet) / bar.ts (format); greet already calls format
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
        ]);
        const greetId = '{app}/foo.ts#greet'; // merge SOURCE (fromId) — its code already calls format
        const formatId = '{app}/bar.ts#format'; // merge TARGET (intoId)
        expect(fx.db.getConnections(greetId).uses.map(n => n.id)).toContain(formatId);

        // A second, distinct outbound edge from greet, to exercise the REAL (non-skipped) half
        // of the same reassignment loop.
        const thirdId = '{app}/foo.ts#thirdNode';
        fx.db.upsertNode({ id: thirdId, type: 'function', name: 'thirdNode', file_path: repoFile(fx, 'foo.ts') });
        fx.db.addConnection(greetId, thirdId);

        fx.db.mergeNodes(greetId, formatId);

        const conns = fx.db.getConnections(formatId);
        // The pre-existing greet->format edge must not have become a format->format self-loop.
        expect(conns.uses.map(n => n.id)).not.toContain(formatId);
        // The OTHER outbound edge (greet->thirdNode) was genuinely reassigned onto format.
        expect(conns.uses.map(n => n.id)).toContain(thirdId);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('patchHistoryDiskIdentity (private, via renameNode) — history JSON already missing on disk', () => {
    it('returns silently (no warn, no throw) instead of trying to read a file that is not there', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const oldId = '{app}/foo.ts#greet';
        const historyId = fx.db.getLatestHistory(oldId)!.id;
        fs.unlinkSync(path.join(fx.devmindPath, 'history', `${historyId}.json`));

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(() => fx.db.renameNode(oldId, '{app}/foo.ts#greetRenamed', 'greetRenamed')).not.toThrow();
          expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('patch history JSON identity'), expect.anything());
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('collectInboundSourceFiles (private) — a source row with a blank file_path', () => {
    it('skips it (rather than collecting an empty path) when gathering caller files', () => {
      const fx = makeFixture();
      try {
        const targetId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: targetId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        // A source node with an empty file_path — schema allows it (TEXT NOT NULL, not "non-empty");
        // upsertNode's canonicalizePath() never produces one, so this is constructed directly.
        raw(fx.db).prepare(`INSERT INTO nodes (id, type, name, file_path) VALUES (?, 'function', 'ghostSource', '')`)
          .run('{app}/nowhere.ts#ghostSource');
        fx.db.addConnection('{app}/nowhere.ts#ghostSource', targetId);

        // deprecateNode calls collectInboundSourceFiles(targetId) before deleting the edges below.
        expect(() => fx.db.deprecateNode(targetId)).not.toThrow();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('renameNode — name/deprecated fallback branches when newName is omitted', () => {
    it('falls back to the NEW id as the name when the old node\'s own name field literally equals its id, and preserves deprecated:1', () => {
      const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'weird.ts': 'export const x = 1;\n' } });
      try {
        const oldId = '{app}/weird.ts#oldSymbol';
        const newId = '{app}/weird.ts#newSymbol';
        // name deliberately set to the id itself (as if a detector pass never resolved a real
        // name) — exercises the `node.name === resolvedOldId ? newId : node.name` fallback's TRUE branch.
        fx.db.upsertNode({ id: oldId, type: 'variable', name: oldId, file_path: repoFile(fx, 'weird.ts') });
        fx.db.deprecateNode(oldId);

        fx.db.renameNode(oldId, newId); // no newName, no newFilePath

        const renamed = fx.db.getNode(newId)!;
        expect(renamed.name).toBe(newId);
        // deprecated:1 carried over onto the new row (the `node.deprecated ? 1 : 0` TRUE branch).
        expect(renamed.deprecated).toBe(1);
      } finally {
        fx.cleanup();
      }
    });

    it('keeps the old (real) name unchanged when newName is omitted and the name differs from the id', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const oldId = '{app}/foo.ts#greet';
        const newId = '{app}/foo.ts#greetV2';
        fx.db.renameNode(oldId, newId);
        expect(fx.db.getNode(newId)!.name).toBe('greet');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('extractLiveCode (private, via getLiveCode) — symbol resolution branches', () => {
    it('resolves the symbol via the id\'s "#"-suffix when the id does not parse as {repo}/path#symbol', () => {
      const fx = makeFixture();
      try {
        // Does not match parseNodeId's `^\{repo\}/path#symbol$` shape (no leading "{") but DOES
        // have a real, non-empty suffix after "#" that happens to name a real symbol in the file.
        const legacyId = 'legacyformat#greet';
        raw(fx.db).prepare(`INSERT INTO nodes (id, type, name, file_path) VALUES (?, 'function', 'greet', ?)`)
          .run(legacyId, repoFile(fx, 'foo.ts'));

        const result = fx.db.getLiveCode(legacyId);
        expect(result.source).toBe('live');
        expect(result.code).toContain('function greet');
      } finally {
        fx.cleanup();
      }
    });

    it('falls all the way through to "no code found" when the id neither parses, nor has a "#"-suffix, nor the node has a name', () => {
      const fx = makeFixture();
      try {
        const weirdId = 'trailinghash#';
        raw(fx.db).prepare(`INSERT INTO nodes (id, type, name, file_path) VALUES (?, 'function', '', ?)`)
          .run(weirdId, repoFile(fx, 'foo.ts'));

        const result = fx.db.getLiveCode(weirdId);
        expect(result.exists).toBe(false);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getLiveCode — live code available but no history/snapshot exists at all', () => {
    it('leaves snapshot_outdated undefined (nothing to compare live code against)', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') }); // no history committed
        const result = fx.db.getLiveCode(nodeId);
        expect(result.source).toBe('live');
        expect(result.snapshot_outdated).toBeUndefined();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getGraph — maxNodesLimit (500) cap mid-traversal', () => {
    function bulkInsertHubAndLeaves(fx: ReturnType<typeof makeFixture>, hubId: string, leafPrefix: string, count: number, edgeDirection: 'out' | 'in') {
      const db = raw(fx.db);
      const insertNode = db.prepare(`INSERT INTO nodes (id, type, name, file_path) VALUES (?, 'function', ?, ?)`);
      const insertConn = db.prepare(`INSERT INTO node_connections (source_node_id, target_node_id) VALUES (?, ?)`);
      const tx = db.transaction(() => {
        insertNode.run(hubId, 'hub', repoFile(fx, 'foo.ts'));
        for (let i = 0; i < count; i++) {
          const leafId = `${leafPrefix}${i}`;
          insertNode.run(leafId, `leaf${i}`, repoFile(fx, 'foo.ts'));
          if (edgeDirection === 'out') insertConn.run(hubId, leafId);
          else insertConn.run(leafId, hubId);
        }
      });
      tx();
    }

    it('stops adding OUTBOUND nodes once the 500-node cap is hit mid-loop', () => {
      const fx = makeFixture();
      try {
        const hubId = '{app}/foo.ts#hubOut';
        bulkInsertHubAndLeaves(fx, hubId, '{app}/foo.ts#leafOut', 520, 'out');
        const g = fx.db.getGraph(hubId, 6, { direction: 'out' });
        expect(g.nodes.length).toBe(500);
      } finally {
        fx.cleanup();
      }
    });

    it('stops adding INBOUND nodes once the 500-node cap is hit mid-loop', () => {
      const fx = makeFixture();
      try {
        const hubId = '{app}/foo.ts#hubIn';
        bulkInsertHubAndLeaves(fx, hubId, '{app}/foo.ts#leafIn', 520, 'in');
        const g = fx.db.getGraph(hubId, 6, { direction: 'in' });
        expect(g.nodes.length).toBe(500);
      } finally {
        fx.cleanup();
      }
    });

    it('honors a smaller opts.maxNodes than the 500 default — get_node_code embeds a cheaper cap than a dedicated graph call', () => {
      const fx = makeFixture();
      try {
        const hubId = '{app}/foo.ts#hubSmallCap';
        bulkInsertHubAndLeaves(fx, hubId, '{app}/foo.ts#leafSmallCap', 200, 'out');
        const g = fx.db.getGraph(hubId, 6, { direction: 'out', maxNodes: 120 });
        expect(g.nodes.length).toBe(120);
      } finally {
        fx.cleanup();
      }
    });

    it('reports nodes_truncated: true only when the cap actually cut the walk short, never when the queue empties naturally', () => {
      const fx = makeFixture();
      try {
        const hubId = '{app}/foo.ts#hubTrunc';
        bulkInsertHubAndLeaves(fx, hubId, '{app}/foo.ts#leafTrunc', 520, 'out');
        const capped = fx.db.getGraph(hubId, 6, { direction: 'out' });
        expect(capped.nodes_truncated).toBe(true);

        const smallHubId = '{app}/foo.ts#hubSmall';
        bulkInsertHubAndLeaves(fx, smallHubId, '{app}/foo.ts#leafSmall', 5, 'out');
        const uncapped = fx.db.getGraph(smallHubId, 6, { direction: 'out' });
        expect(uncapped.nodes.length).toBe(6);
        expect(uncapped.nodes_truncated).toBeUndefined();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getGraph — depth stamping', () => {
    function chainFixture() {
      return makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'foo.ts': "import { bar } from './bar';\n\nexport function foo(): number {\n  return bar();\n}\n",
          'bar.ts': "import { baz } from './baz';\n\nexport function bar(): number {\n  return baz();\n}\n",
          'baz.ts': 'export function baz(): number {\n  return 1;\n}\n'
        }
      });
    }
    async function commitChain(fx: ReturnType<typeof chainFixture>) {
      return stageAndCommit(fx, [
        { node_id: 'foo', file_path: repoFile(fx, 'foo.ts'), code_snapshot: 'export function foo(): number {\n  return bar();\n}', name: 'foo', type: 'function' },
        { node_id: 'bar', file_path: repoFile(fx, 'bar.ts'), code_snapshot: 'export function bar(): number {\n  return baz();\n}', name: 'bar', type: 'function' },
        { node_id: 'baz', file_path: repoFile(fx, 'baz.ts'), code_snapshot: 'export function baz(): number {\n  return 1;\n}', name: 'baz', type: 'function' }
      ]);
    }

    it('stamps 0/1/2 walking OUT along foo -> bar -> baz', async () => {
      const fx = chainFixture();
      try {
        await commitChain(fx);
        const g = fx.db.getGraph('{app}/foo.ts#foo', 2, { direction: 'out' });
        const depthOf = new Map(g.nodes.map(n => [n.id, n.depth]));
        expect(depthOf.get('{app}/foo.ts#foo')).toBe(0);
        expect(depthOf.get('{app}/bar.ts#bar')).toBe(1);
        expect(depthOf.get('{app}/baz.ts#baz')).toBe(2);
      } finally {
        fx.cleanup();
      }
    });

    it('stamps 0/1/2 walking IN along baz <- bar <- foo, from baz as root', async () => {
      const fx = chainFixture();
      try {
        await commitChain(fx);
        const g = fx.db.getGraph('{app}/baz.ts#baz', 2, { direction: 'in' });
        const depthOf = new Map(g.nodes.map(n => [n.id, n.depth]));
        expect(depthOf.get('{app}/baz.ts#baz')).toBe(0);
        expect(depthOf.get('{app}/bar.ts#bar')).toBe(1);
        expect(depthOf.get('{app}/foo.ts#foo')).toBe(2);
      } finally {
        fx.cleanup();
      }
    });

    it('direction "both" still stamps a monotonically increasing depth per hop from the root, even while alternating caller/callee', async () => {
      const fx = chainFixture();
      try {
        await commitChain(fx);
        // From bar (the middle node), "both" reaches foo (a caller, depth 1) and baz (a callee,
        // depth 1) in the same hop — direction is irrelevant to depth, only hop count is.
        const g = fx.db.getGraph('{app}/bar.ts#bar', 1, { direction: 'both' });
        const depthOf = new Map(g.nodes.map(n => [n.id, n.depth]));
        expect(depthOf.get('{app}/bar.ts#bar')).toBe(0);
        expect(depthOf.get('{app}/foo.ts#foo')).toBe(1);
        expect(depthOf.get('{app}/baz.ts#baz')).toBe(1);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getGraph — never returns a connection referencing a node absent from `nodes`', () => {
    it('drops an edge whose target no longer resolves to a real node (deleted/renamed, connections row survives) and reports connections_truncated', () => {
      const fx = makeFixture();
      try {
        const db = raw(fx.db);
        const rootId = '{app}/foo.ts#root';
        const ghostId = '{app}/foo.ts#ghostDeleted';
        db.prepare(`INSERT INTO nodes (id, type, name, file_path) VALUES (?, 'function', 'root', ?)`).run(rootId, repoFile(fx, 'foo.ts'));
        // node_connections has ON DELETE CASCADE against nodes (schema.ts), so a row referencing
        // a deleted node cannot normally survive — the FK itself prevents the exact scenario this
        // guards against. Disabling the pragma just for this insert reproduces the shape a real
        // inconsistency (e.g. a disk-synced graph JSON referencing a node whose own file never
        // made it into `nodes`) would leave behind, without needing to drive that whole path.
        db.pragma('foreign_keys = OFF');
        try {
          db.prepare(`INSERT INTO node_connections (source_node_id, target_node_id) VALUES (?, ?)`).run(rootId, ghostId);
        } finally {
          db.pragma('foreign_keys = ON');
        }

        const g = fx.db.getGraph(rootId, 3, { direction: 'out' });
        const nodeIds = new Set(g.nodes.map(n => n.id));
        expect(nodeIds.has(ghostId)).toBe(false);
        for (const c of g.connections) {
          expect(nodeIds.has(c.source_node_id)).toBe(true);
          expect(nodeIds.has(c.target_node_id)).toBe(true);
        }
        expect(g.connections_truncated).toBe(true);
      } finally {
        fx.cleanup();
      }
    });

    it('leaves connections_truncated unset when every discovered edge resolves to a real node', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
        ]);
        const g = fx.db.getGraph('{app}/foo.ts#greet', 2, { direction: 'out' });
        expect(g.connections_truncated).toBeUndefined();
        expect(g.connections.length).toBeGreaterThan(0);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getGraph — includeCode with a CACHED (non-live) snapshot for a non-root node', () => {
    it('marks a node code_source: "cached" when only the stored snapshot is available, not a live-extractable one', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const rootId = '{app}/foo.ts#greet';
        const ghostId = '{app}/foo.ts#ghostFn';
        fx.db.upsertNode({ id: ghostId, type: 'function', name: 'ghostFn', file_path: repoFile(fx, 'foo.ts') });
        fx.db.addConnection(rootId, ghostId);
        // ghostFn isn't actually declared in foo.ts -> extractLiveCode returns null; seed a
        // history snapshot directly so getLatestCode() has something to fall back to.
        fx.db.updateHistory({ node_id: ghostId, code_snapshot: 'export function ghostFn() { /* long gone from disk */ }', code_before: null, reasoning: 'seed a cached-only snapshot' });

        const g = fx.db.getGraph(rootId, 1, { direction: 'out', includeCode: true });
        const ghost = g.nodes.find(n => n.id === ghostId)!;
        expect(ghost.code_source).toBe('cached');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('updateHistory — unresolved node_id (raw id used as-is)', () => {
    it('merges into an existing orphaned history row (no matching node) via the raw node_id, rather than an FK-violating fresh insert', () => {
      const fx = makeFixture();
      try {
        // history.node_id has ON DELETE CASCADE FK to nodes(id), so a brand-new INSERT for a
        // node_id with no matching row would always throw — the `resolvedId = node ? node.id :
        // node_id` fallback is only reachable (without violating that FK) on the WITHIN-THE-HOUR
        // UPDATE-in-place path, against a pre-existing (e.g. legacy/hand-edited) orphaned row.
        const now = new Date().toISOString();
        const conn = raw(fx.db);
        conn.pragma('foreign_keys = OFF');
        conn.prepare(`
          INSERT INTO history (id, node_id, session_id, created_at, updated_at, code_snapshot, reasoning)
          VALUES ('hist-orphan', 'totally-unknown-node-id', 'session-1', ?, ?, '', 'seed')
        `).run(now, now);
        conn.pragma('foreign_keys = ON');

        const h = fx.db.updateHistory({ node_id: 'totally-unknown-node-id', code_snapshot: 'v1', code_before: null, reasoning: 'test' });
        expect(h.id).toBe('hist-orphan');
        expect(h.node_id).toBe('totally-unknown-node-id');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('updateHistory — same-session merge with an empty existing reasoning log', () => {
    it('does not prepend an "── Update @ ──" separator when the log being merged into is blank', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        const now = new Date().toISOString();
        raw(fx.db).prepare(`
          INSERT INTO history (id, node_id, session_id, created_at, updated_at, code_snapshot, reasoning)
          VALUES (?, ?, 'session-1', ?, ?, '', '')
        `).run('hist-empty-log', nodeId, now, now);

        const h = fx.db.updateHistory({ node_id: nodeId, code_snapshot: 'v2', code_before: 'v1', reasoning: 'fresh reasoning' });
        expect(h.id).toBe('hist-empty-log'); // merged in place — within the 1h window
        expect(h.reasoning).toBe('fresh reasoning');
        expect(h.reasoning).not.toContain('── Update @');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('searchNodes — an orphaned-vector-row defensive branch is unreachable via the public API', () => {
    // `if (!src) continue;` guards against a fused-ranking id with no matching node. All three
    // sources feeding `fused` (tokenSearchNodes, vectorSearchNodes, mapGrepHitsToNodes) query
    // `nodes` directly (deprecated = 0) at call time, and nothing mutates the DB between that
    // point and this synchronous loop a few lines later — so `src` can never actually be missing
    // here today. See the `istanbul ignore` comment at its call site for the full reasoning.
    it('is a smoke test only: a normal search still runs to completion', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function', description: 'Greets a person.' }
        ]);
        const result = await fx.db.searchNodes('greet');
        expect(result.nodes.length).toBeGreaterThan(0);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('tokenSearchNodes (private) — sort comparator with 2+ ranked results', () => {
    it('orders results by descending BM25 score when multiple nodes match', () => {
      const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'x.ts': 'export const x = 1;\n' } });
      try {
        fx.db.upsertNode({ id: '{app}/x.ts#alpha', type: 'const', name: 'alpha', file_path: repoFile(fx, 'x.ts'), description: 'gadflykeyword repeated one time only in this text' });
        fx.db.upsertNode({ id: '{app}/x.ts#beta', type: 'const', name: 'beta', file_path: repoFile(fx, 'x.ts'), description: 'gadflykeyword gadflykeyword repeated repeated repeated repeated many many times over' });

        const tokenSearchNodes = (fx.db as any).tokenSearchNodes.bind(fx.db);
        // tokenSearchNodes expects already-tokenized (stemmed) input, matching what the stored
        // node_tokens index holds — the same pipeline searchNodes() itself feeds it via tokenizeText.
        const results = tokenSearchNodes(tokenizeText('gadflykeyword repeated'));
        expect(results.length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < results.length; i++) {
          expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
        }
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('repoRoots (private) — no loaded project context', () => {
    it('returns [] when the database has no project context (e.g. missing config.json)', () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-nocontext-'));
      const devmindPath = path.join(tmpRoot, '.devmind');
      fs.mkdirSync(devmindPath, { recursive: true });
      const db = new DevMindDatabase(path.join(devmindPath, 'brain.db'));
      try {
        const repoRoots = (db as any).repoRoots.bind(db);
        expect(repoRoots()).toEqual([]);
      } finally {
        db.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  describe('mapGrepHitsToNodes (private) — symbol resolution branches not covered by search.gaps.test.ts', () => {
    function mapHits(db: DevMindDatabase, hits: any[]) {
      return (db as any).mapGrepHitsToNodes(hits) as { nodeId: string; lines: { line_number: number; line_content: string }[] }[];
    }

    it('resolves via the id\'s "#"-suffix for a legacy/non-standard id shape that does not parse', () => {
      const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'plain.ts': 'export function plainSymbolName(): number {\n  return 1;\n}\n' } });
      try {
        const filePath = repoFile(fx, 'plain.ts');
        raw(fx.db).prepare(`INSERT INTO nodes (id, type, name, file_path) VALUES (?, 'function', 'plainSymbolName', ?)`)
          .run('plainSymbolName', filePath);

        const result = mapHits(fx.db, [
          { file_path: filePath, line_number: 1, line_content: 'export function plainSymbolName(): number {', matched_keyword: 'plainSymbolName' }
        ]);
        expect(result.find(r => r.nodeId === 'plainSymbolName')).toBeTruthy();
      } finally {
        fx.cleanup();
      }
    });

    it('skips a node whose resolved symbol cannot be located in the file, and one with no resolvable symbol at all, while still resolving a real one', () => {
      const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'multi.ts': 'export function realFn(): number {\n  return 1;\n}\n' } });
      try {
        const filePath = repoFile(fx, 'multi.ts');
        const db = raw(fx.db);
        db.prepare(`INSERT INTO nodes (id, type, name, file_path) VALUES (?, 'function', 'realFn', ?)`).run('{app}/multi.ts#realFn', filePath);
        // Parses fine, but "ghostFn" is not actually declared anywhere in the file -> locateNodeInFile -> null.
        db.prepare(`INSERT INTO nodes (id, type, name, file_path) VALUES (?, 'function', 'ghostFn', ?)`).run('{app}/multi.ts#ghostFn', filePath);
        // Symbol resolution fully exhausted: doesn't parse, no "#"-suffix, and an empty name.
        db.prepare(`INSERT INTO nodes (id, type, name, file_path) VALUES (?, 'function', '', ?)`).run('onlyhash#', filePath);

        const result = mapHits(fx.db, [
          { file_path: filePath, line_number: 1, line_content: 'export function realFn(): number {', matched_keyword: 'realFn' }
        ]);
        expect(result.find(r => r.nodeId === '{app}/multi.ts#realFn')).toBeTruthy();
        expect(result.find(r => r.nodeId === '{app}/multi.ts#ghostFn')).toBeUndefined();
        expect(result.find(r => r.nodeId === 'onlyhash#')).toBeUndefined();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('vectorSearchNodes (private, via searchNodes) — embedding succeeds but no vector rows exist', () => {
    it('short-circuits to no "meaning" matches when node_vectors is empty', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function', description: 'Greets a person by name.' }
        ]);
        // No upsertNodeVector call anywhere in this fixture -> node_vectors is empty; the real
        // embedder here resolves the query to a real vector (or null — either way the SQL join
        // against an empty table returns zero rows), exercising `if (rows.length === 0) return [];`.
        const result = await fx.db.searchNodes('a query about nothing in particular');
        expect(result.nodes.every(n => !n.found_by.includes('meaning'))).toBe(true);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('searchCode — case-sensitive regex matching', () => {
    it('honors case_insensitive:false on the regex-pattern branch', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const lower = fx.db.searchCode({ query: 'return format', is_regex: true, case_insensitive: false });
        expect(lower.length).toBeGreaterThan(0);
        const upperMiss = fx.db.searchCode({ query: 'RETURN FORMAT', is_regex: true, case_insensitive: false });
        expect(upperMiss).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('searchCode — missing history JSON / blank code_snapshot / multi-result sort', () => {
    it('skips a history entry whose JSON file is missing from disk, instead of throwing', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const historyId = fx.db.getLatestHistory('{app}/foo.ts#greet')!.id;
        fs.unlinkSync(path.join(fx.devmindPath, 'history', `${historyId}.json`));
        // "format(name)" is unique to greet's own snippet (format's own body reads
        // `return "hi " + s;`), so this can't accidentally match the auto-detected format node.
        expect(() => fx.db.searchCode({ query: 'format(name)' })).not.toThrow();
        expect(fx.db.searchCode({ query: 'format(name)' })).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });

    it('skips a history entry with a blank code_snapshot, instead of matching an empty string', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const historyId = fx.db.getLatestHistory('{app}/foo.ts#greet')!.id;
        const jsonPath = path.join(fx.devmindPath, 'history', `${historyId}.json`);
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        data.code_snapshot = '';
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
        expect(fx.db.searchCode({ query: 'format(name)' })).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });

    it('sorts multiple matching results by descending match_count', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
        ]);
        const results = fx.db.searchCode({ query: 'format' });
        expect(results.length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < results.length; i++) {
          expect(results[i - 1].match_count).toBeGreaterThanOrEqual(results[i].match_count);
        }
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getGodEntities — default threshold argument', () => {
    it('defaults to threshold 15 when called with no argument at all', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        expect(() => fx.db.getGodEntities()).not.toThrow();
        expect(fx.db.getGodEntities()).toEqual([]); // nothing reaches degree 15 in this tiny fixture
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getCircularDependencies — maxCycles cap and a revisited (non-cycle) node', () => {
    it('caps reported cycles at maxCycles (skipping remaining neighbors once reached) and does not re-walk an already-visited non-cycle node', () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'a1.ts': 'export function a1(){}\n', 'a2.ts': 'export function a2(){}\n', 'a3.ts': 'export function a3(){}\n',
          'd.ts': 'export function d(){}\n', 'e.ts': 'export function e(){}\n', 'f.ts': 'export function f(){}\n', 'g.ts': 'export function g(){}\n'
        }
      });
      try {
        const ids: Record<string, string> = {};
        for (const name of ['a1', 'a2', 'a3', 'd', 'e', 'f', 'g']) {
          const id = `{app}/${name}.ts#${name}`;
          fx.db.upsertNode({ id, type: 'function', name, file_path: repoFile(fx, `${name}.ts`) });
          ids[name] = id;
        }
        // a1 <-> a2 is a 2-node cycle; a1 -> a3 is a SECOND outbound edge from a1, processed
        // AFTER the cycle is found (so its loop iteration hits the maxCycles cap-check).
        fx.db.addConnection(ids.a1, ids.a2);
        fx.db.addConnection(ids.a2, ids.a1);
        fx.db.addConnection(ids.a1, ids.a3);

        const capped = fx.db.getCircularDependencies(1);
        expect(capped.length).toBe(1);

        // A diamond (d->e->g, d->f->g): g is reached twice via two different paths but never
        // re-explored, and forms no cycle of its own.
        fx.db.addConnection(ids.d, ids.e);
        fx.db.addConnection(ids.d, ids.f);
        fx.db.addConnection(ids.e, ids.g);
        fx.db.addConnection(ids.f, ids.g);
        const full = fx.db.getCircularDependencies(50);
        expect(full.length).toBe(1); // still just the a1/a2 cycle — the diamond has none
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getHistoryMissingDeveloper — whitespace-only Developer field', () => {
    it('counts a whitespace-only "Developer:" line as missing, not just an absent one', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        fx.db.updateHistory({ node_id: nodeId, code_snapshot: 'v1', code_before: null, reasoning: 'What changed: x\nDeveloper:   \nModel: y' });
        const missing = fx.db.getHistoryMissingDeveloper();
        expect(missing.some(m => m.node_id === nodeId)).toBe(true);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('writeWorkflowToDisk (private) — nonexistent workflow id', () => {
    it('is a silent no-op when the workflow row does not exist', () => {
      const fx = makeFixture();
      try {
        expect(() => (fx.db as any).writeWorkflowToDisk('wf_does_not_exist')).not.toThrow();
        expect(fs.existsSync(path.join(fx.devmindPath, 'workflows', 'wf_does_not_exist'))).toBe(false);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('addWorkflowArtifact — an empty sourceName', () => {
    it('falls back to "artifact.md" when sourceName is empty (sanitization substitutes disallowed chars, so only a truly empty name reaches this fallback)', () => {
      const fx = makeFixture();
      try {
        const wf = fx.db.createWorkflow('wf', 'desc');
        const artifact = fx.db.addWorkflowArtifact(wf.id, { type: 'note', sourceName: '', content: 'hi' });
        expect(path.basename(artifact.file_path)).toBe(`${artifact.id}_artifact.md`);
      } finally {
        fx.cleanup();
      }
    });
  });

  // NOTE: the `searchWorkflows — remaining branches` describe was removed with the method.
  // Its replacement, listWorkflows({ query }), is covered in tests/db/workflow.test.ts — including
  // the case searchWorkflows could never handle: matching a workflow by its own name.

  describe('findSpuriousAndMissingFileNodes — a relative (non-absolute) file_path', () => {
    it('resolves it against workspaceRoot before checking existence', () => {
      const fx = makeFixture();
      try {
        raw(fx.db).prepare(`INSERT INTO nodes (id, type, name, file_path) VALUES (?, 'function', 'relNode', 'relative/does-not-exist.ts')`)
          .run('{app}/rel.ts#relNode');
        const { missingFile } = fx.db.findSpuriousAndMissingFileNodes(fx.root);
        expect(missingFile.some(n => n.id === '{app}/rel.ts#relNode')).toBe(true);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('populateHistoryFromDisk (private) — non-string reasoning / non-array edits on disk', () => {
    it('formats an object-shaped reasoning via formatReasoning, and defaults a non-array edits field to []', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        const now = new Date().toISOString();
        raw(fx.db).prepare(`
          INSERT INTO history (id, node_id, session_id, created_at, updated_at, code_snapshot, reasoning)
          VALUES (?, ?, 'session-1', ?, ?, '', 'placeholder')
        `).run('hist-object-reasoning', nodeId, now, now);
        const historyDir = path.join(fx.devmindPath, 'history');
        fs.mkdirSync(historyDir, { recursive: true });
        fs.writeFileSync(path.join(historyDir, 'hist-object-reasoning.json'), JSON.stringify({
          id: 'hist-object-reasoning', node_id: nodeId, session_id: 'session-1', created_at: now, updated_at: now,
          code_snapshot: 'v1',
          reasoning: { what_changed: 'legacy object-shaped reasoning', why: '', goal: '' },
          edits: 'not-an-array'
        }, null, 2));

        const entry = fx.db.getHistoryEntry('hist-object-reasoning')!;
        expect(entry.reasoning).toContain('What changed: legacy object-shaped reasoning');
        expect(entry.edits).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('writeHistoryToDisk (private) — default edits argument', () => {
    it('defaults edits to [] when the caller omits the argument entirely', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        // writeHistoryToDisk only writes the disk JSON — getHistoryEntry additionally requires a
        // matching `history` DB row (it's a raw SQL SELECT), so seed one directly first.
        const now = new Date().toISOString();
        raw(fx.db).prepare(`
          INSERT INTO history (id, node_id, session_id, created_at, updated_at, code_snapshot, reasoning)
          VALUES ('hist-default-edits', ?, 'session-1', ?, ?, '', 'reasoning text')
        `).run(nodeId, now, now);

        (fx.db as any).writeHistoryToDisk('hist-default-edits', nodeId, 'session-1', now, now, 'v1', 'reasoning text');
        const entry = fx.db.getHistoryEntry('hist-default-edits')!;
        expect(entry.edits).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('toRepoRelativePath / toAbsolutePath — empty-input guards', () => {
    it('toRepoRelativePath returns the input unchanged for an empty string', () => {
      const fx = makeFixture();
      try {
        expect(fx.db.toRepoRelativePath('')).toBe('');
      } finally {
        fx.cleanup();
      }
    });

    it('toAbsolutePath returns the input unchanged for an empty string', () => {
      const fx = makeFixture();
      try {
        expect(fx.db.toAbsolutePath('')).toBe('');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('syncFromDisk — onProgress callback fires for each phase', () => {
    it('calls onProgress for the history, graph, and vectors phases when reconstructing from disk', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function', description: 'x' }
        ]);
        const greetId = '{app}/foo.ts#greet';
        fx.db.upsertNodeVector(greetId, new Int8Array([1, 2, 3, 4]), hashDescription('x'));
        fx.db.close();

        const calls: [string, number, number][] = [];
        const db2 = new DevMindDatabase(path.join(fx.devmindPath, 'brain.db'), { onSyncProgress: (phase, done, total) => calls.push([phase, done, total]) });
        try {
          expect(calls.some(([phase]) => phase === 'history')).toBe(true);
          expect(calls.some(([phase]) => phase === 'graph')).toBe(true);
          expect(calls.some(([phase]) => phase === 'vectors')).toBe(true);
        } finally {
          db2.close();
        }
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('syncFromDisk — malformed/minimal history JSON on disk', () => {
    it('skips a history/*.json missing id or node_id, instead of throwing', () => {
      const fx = makeFixture();
      try {
        const historyDir = path.join(fx.devmindPath, 'history');
        fs.mkdirSync(historyDir, { recursive: true });
        fs.writeFileSync(path.join(historyDir, 'bad1.json'), JSON.stringify({ node_id: 'x' })); // missing id
        fs.writeFileSync(path.join(historyDir, 'bad2.json'), JSON.stringify({ id: 'y' })); // missing node_id
        expect(() => fx.db.syncFromDisk()).not.toThrow();
        expect(fx.db.getHistoryEntry('y')).toBeNull();
      } finally {
        fx.cleanup();
      }
    });

    it('formats an object-shaped reasoning read fresh off disk via formatReasoning', () => {
      const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'x.ts': 'export function xx(){}\n' } });
      try {
        const nodeId = '{app}/x.ts#xx';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'xx', file_path: repoFile(fx, 'x.ts') });
        const historyDir = path.join(fx.devmindPath, 'history');
        fs.mkdirSync(historyDir, { recursive: true });
        fs.writeFileSync(path.join(historyDir, 'newhist.json'), JSON.stringify({
          id: 'newhist', node_id: nodeId, session_id: 's1', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          code_snapshot: 'v1',
          reasoning: { what_changed: 'from disk, object-shaped', why: '', goal: '' }
        }));
        expect(() => fx.db.syncFromDisk()).not.toThrow();
        const entry = fx.db.getHistoryEntry('newhist')!;
        expect(entry.reasoning).toContain('What changed: from disk, object-shaped');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('syncFromDisk — malformed/minimal graph JSON on disk', () => {
    it('skips a graph/*.json missing file_path, and defaults missing nodes/connections arrays to []', () => {
      const fx = makeFixture();
      try {
        const graphDir = path.join(fx.devmindPath, 'graph', 'app');
        fs.mkdirSync(graphDir, { recursive: true });
        fs.writeFileSync(path.join(graphDir, 'nofilepath.json'), JSON.stringify({ nodes: [], connections: [] })); // missing file_path
        fs.writeFileSync(path.join(graphDir, 'minimal.json'), JSON.stringify({ file_path: '{app}/minimal.ts' })); // missing nodes AND connections
        expect(() => fx.db.syncFromDisk()).not.toThrow();
      } finally {
        fx.cleanup();
      }
    });

    it('re-syncs a node carrying aliases and deprecated:1 from its own graph JSON', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts'), aliases: ['alias1', 'alias2'] });
        fx.db.deprecateNode(nodeId);
        // Force a re-sync from the just-written graph JSON, which now carries aliases + deprecated:1.
        fx.db.syncFromDisk();
        const node = fx.db.getNode(nodeId)!;
        expect([...node.aliases].sort()).toEqual(['alias1', 'alias2']);
        expect(node.deprecated).toBe(1);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('syncFromDisk — malformed/minimal vectors JSON on disk', () => {
    it('defaults a missing "vectors" key to {}, skips an entry missing v/h, and defaults a missing "dim"', () => {
      const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'v.ts': 'export function vv(){}\n' } });
      try {
        const nodeId = '{app}/v.ts#vv';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'vv', file_path: repoFile(fx, 'v.ts') });
        const vectorsDir = path.join(fx.devmindPath, 'vectors', 'app');
        fs.mkdirSync(vectorsDir, { recursive: true });
        // No "vectors" key at all -> `data.vectors || {}` fallback.
        fs.writeFileSync(path.join(vectorsDir, 'empty.json'), JSON.stringify({ file_path: '{app}/v.ts', model_id: EMBEDDING_MODEL_ID }));
        // A "vectors" entry missing v/h -> `if (!entry || !entry.v || !entry.h) continue;`, and no
        // top-level "dim" -> `data.dim || EMBEDDING_DIM` fallback.
        fs.writeFileSync(path.join(vectorsDir, 'partial.json'), JSON.stringify({
          file_path: '{app}/v.ts', model_id: EMBEDDING_MODEL_ID,
          vectors: {
            [nodeId]: { h: 'somehash', v: Buffer.from([1, 2, 3, 4]).toString('base64') },
            '{app}/v.ts#ghostVec': { h: 'onlyHashNoVector' }
          }
        }));
        expect(() => fx.db.syncFromDisk()).not.toThrow();
        const vec = fx.db.getNodeVector(nodeId);
        expect(vec).toBeTruthy();
        expect(vec!.dim).toBe(EMBEDDING_DIM);
        expect(fx.db.getNodeVector('{app}/v.ts#ghostVec')).toBeNull();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('syncFromDisk — malformed/minimal workflow JSON on disk', () => {
    it('skips a subdir with no workflow.json, one missing id/name, steps missing id, artifacts missing id, and defaults every other optional field', () => {
      const fx = makeFixture({ skipDefaultFiles: true });
      try {
        const workflowsDir = path.join(fx.devmindPath, 'workflows');
        fs.mkdirSync(path.join(workflowsDir, 'no-json-subdir'), { recursive: true });

        fs.mkdirSync(path.join(workflowsDir, 'bad-wf'), { recursive: true });
        fs.writeFileSync(path.join(workflowsDir, 'bad-wf', 'workflow.json'), JSON.stringify({ name: 'missing id' })); // no id

        const minimalId = 'wf_minimal_fields';
        const wfDir = path.join(workflowsDir, minimalId);
        fs.mkdirSync(wfDir, { recursive: true });
        fs.writeFileSync(path.join(wfDir, 'workflow.json'), JSON.stringify({
          id: minimalId, name: 'Minimal WF',
          // description/archived/created_at/updated_at all omitted -> every `|| fallback` branch.
          steps: [
            { step_index: 1, summary: 'step with no id -> skipped' }, // no id
            { id: 'step_minimal', step_index: 2 } // no summary/reasoning/node_ids/doc_paths/session_id/created_at
          ],
          artifact_index: [
            { step_id: 'step_minimal', type: 'note' }, // no id -> skipped
            { id: 'art_minimal' } // no type/source_name/file_path/created_at
          ]
        }, null, 2));

        expect(() => fx.db.syncFromDisk()).not.toThrow();

        const wf = fx.db.getWorkflow(minimalId)!;
        expect(wf).toBeTruthy();
        expect(wf.description).toBe('');
        expect(wf.archived).toBe(0);

        const steps = fx.db.getWorkflowSteps(minimalId);
        expect(steps.map(s => s.id)).toEqual(['step_minimal']);

        const ctx = fx.db.getWorkflowContext(minimalId);
        expect(ctx.artifacts.map(a => a.id)).toEqual(['art_minimal']);
        expect(ctx.artifacts[0].type).toBe('unknown');
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('writeGraphToDisk / writeVectorsToDisk — empty filePath guard', () => {
    it('both are no-ops (no throw) when called with an empty filePath', () => {
      const fx = makeFixture();
      try {
        expect(() => fx.db.writeGraphToDisk('')).not.toThrow();
        expect(() => fx.db.writeVectorsToDisk('')).not.toThrow();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('writeGraphToDisk / writeVectorsToDisk — directory-typed file_path guard', () => {
    // Regression test for a real EISDIR crash: a node whose file_path is a DIRECTORY makes
    // toRepoRelativePath collapse the relative part to something degenerate — '' when file_path
    // IS `workspaceRoot` (== path.dirname(dbPath), i.e. the `.devmind` directory itself, the
    // value these functions actually use, NOT the project root one level up), '{repo}/' when
    // file_path is a configured repo root, or '..' when file_path is the project root (one level
    // ABOVE `.devmind`, so relative-to-`.devmind` is a parent traversal). Every one of those
    // makes `path.join(graph/vectors dir, diskRelPath)` resolve to that directory itself or an
    // ancestor of it, never a fresh `.json` file inside it — throwing EISDIR when the target
    // already exists (the common case on a synced brain) or silently creating a file where a
    // directory belongs otherwise. `isDegenerateDiskJsonPath` catches all three shapes.

    it('writeGraphToDisk warns and skips, without touching the graph/ directory, when file_path IS the .devmind directory', () => {
      const fx = makeFixture();
      try {
        fx.db.upsertNode({ id: '{app}/#corrupt', type: 'function', name: 'corrupt', file_path: fx.devmindPath });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(() => fx.db.writeGraphToDisk(fx.devmindPath)).not.toThrow();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('resolves to a directory'));
        } finally {
          warnSpy.mockRestore();
        }
        // graph/ must still be a real directory afterward — never overwritten as a file.
        const graphPath = path.join(fx.devmindPath, 'graph');
        expect(fs.existsSync(graphPath) ? fs.statSync(graphPath).isDirectory() : true).toBe(true);
      } finally {
        fx.cleanup();
      }
    });

    it('writeGraphToDisk warns and skips when file_path is a configured repo root', () => {
      const fx = makeFixture();
      try {
        fx.db.upsertNode({ id: '{app}/#corrupt2', type: 'function', name: 'corrupt2', file_path: fx.repoDir });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(() => fx.db.writeGraphToDisk(fx.repoDir)).not.toThrow();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('resolves to a directory'));
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        fx.cleanup();
      }
    });

    it('writeGraphToDisk warns and skips when file_path is the project root, one level above .devmind (the "../" collapse)', () => {
      const fx = makeFixture();
      try {
        fx.db.upsertNode({ id: '{app}/#corrupt3', type: 'function', name: 'corrupt3', file_path: fx.root });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(() => fx.db.writeGraphToDisk(fx.root)).not.toThrow();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('resolves to a directory'));
        } finally {
          warnSpy.mockRestore();
        }
        const devmindPath = fx.devmindPath;
        expect(fs.existsSync(devmindPath) ? fs.statSync(devmindPath).isDirectory() : true).toBe(true);
      } finally {
        fx.cleanup();
      }
    });

    it('writeVectorsToDisk warns and skips when file_path resolves to a directory', () => {
      const fx = makeFixture();
      try {
        const id = '{app}/#corrupt4';
        fx.db.upsertNode({ id, type: 'function', name: 'corrupt4', file_path: fx.devmindPath });
        fx.db.upsertNodeVector(id, new Int8Array([1, 2, 3, 4]), hashDescription('x'));
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(() => fx.db.writeVectorsToDisk(fx.devmindPath)).not.toThrow();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('resolves to a directory'));
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('parseReasoningBlocksTimed (pure function)', () => {
    const CREATED_AT = '2026-01-01T00:00:00.000Z';

    it('dates the first block from created_at and every later block from its own separator', () => {
      // The separator's captured timestamp is what makes a block groupable back into the commit
      // that wrote it; only block 0 predates any separator and so inherits created_at.
      const blocks = parseReasoningBlocksTimed(
        'first block\n── Update @ 2026-01-02T00:00:00.000Z ──\nsecond block',
        CREATED_AT
      );
      expect(blocks.map(b => b.text)).toEqual(['first block', 'second block']);
      expect(blocks.map(b => b.at)).toEqual([CREATED_AT, '2026-01-02T00:00:00.000Z']);
    });

    it('skips the empty leading chunk when the blob opens with a separator', () => {
      // An accumulated log whose first write was itself an update has nothing before the first
      // separator. That empty chunk must be dropped, not emitted as a blank block.
      const blocks = parseReasoningBlocksTimed(
        '── Update @ 2026-01-02T00:00:00.000Z ──\nonly block',
        CREATED_AT
      );
      expect(blocks.map(b => b.text)).toEqual(['only block']);
      expect(blocks[0].at).toBe('2026-01-02T00:00:00.000Z');
    });

    it('falls back to created_at when a separator carries no timestamp', () => {
      const blocks = parseReasoningBlocksTimed('first\n── Update @  ──\nsecond', CREATED_AT);
      expect(blocks.map(b => b.text)).toEqual(['first', 'second']);
      expect(blocks.map(b => b.at)).toEqual([CREATED_AT, CREATED_AT]);
    });

    it('parses each block through parseReasoningBlocks, keeping unlabelled text as reasoning', () => {
      const blocks = parseReasoningBlocksTimed(
        'What changed: renamed greet\nWhy: clarity\nGoal: readability\n── Update @ 2026-01-02T00:00:00.000Z ──\njust free text',
        CREATED_AT
      );
      expect(blocks[0].parsed.what_changed).toBe('renamed greet');
      expect(blocks[0].parsed.why).toBe('clarity');
      expect(blocks[1].parsed.what_changed).toBe('just free text');
    });
  });

  describe('queryHistoryForActivity — default row cap', () => {
    it('applies the built-in LIMIT when the caller passes no limit', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const rows = fx.db.queryHistoryForActivity({});
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0].node_id).toBeTruthy();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getHistoryMissingDeveloper — blank reasoning', () => {
    it('reports a row whose reasoning is an empty string', () => {
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        const now = new Date().toISOString();
        // A row lands here once every reasoning block has been erased off it (schema keeps the
        // column NOT NULL, so "no reasoning left" is ''). Unattributable is exactly what this
        // query exists to surface, so it must be listed rather than skipped by the regex.
        raw(fx.db).prepare(`
          INSERT INTO history (id, node_id, session_id, created_at, updated_at, code_snapshot, reasoning)
          VALUES (?, ?, ?, ?, ?, '', '')
        `).run('hist-blank-reasoning', nodeId, 'session-1', now, now);

        const missing = fx.db.getHistoryMissingDeveloper();
        expect(missing.map(m => m.id)).toContain('hist-blank-reasoning');
      } finally {
        fx.cleanup();
      }
    });
  });
});
