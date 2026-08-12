import * as fs from 'fs';
import * as path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import { DevMindDatabase } from '../../src/db/database';
import { EMBEDDING_MODEL_ID, EMBEDDING_DIM, hashDescription } from '../../src/db/embedder';
import { makeFixture, stageAndCommit, repoFile } from '../helpers/fixture';

describe('DevMindDatabase — syncFromDisk / syncToDisk / resetAll', () => {
  describe('round-trip via syncFromDisk', () => {
    it('losslessly rebuilds nodes/edges/history purely from graph/*.json + history/*.json after brain.db is deleted', async () => {
      const fx = makeFixture(); // default foo.ts/bar.ts pair
      try {
        const summary = await stageAndCommit(fx, [
          {
            node_id: 'greet',
            file_path: repoFile(fx, 'foo.ts'),
            code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
            name: 'greet',
            type: 'function',
            description: 'Greets by name, delegating formatting to format().'
          },
          {
            node_id: 'format',
            file_path: repoFile(fx, 'bar.ts'),
            code_snapshot: 'export function format(s: string): string {\n  return "hi " + s;\n}',
            name: 'format',
            type: 'function',
            description: 'Formats a raw string into a greeting.'
          }
        ]);
        expect(summary.nodes).toBe(2);

        const dbPath = path.join(fx.devmindPath, 'brain.db');
        const beforeCounts = fx.db.getCounts();
        expect(beforeCounts.nodes).toBe(2);
        expect(beforeCounts.connections).toBeGreaterThanOrEqual(1);
        expect(beforeCounts.history).toBe(2);

        const greetBefore = fx.db.getNode('{app}/foo.ts#greet')!;
        const formatBefore = fx.db.getNode('{app}/bar.ts#format')!;
        const connsBefore = fx.db.getConnections('{app}/foo.ts#greet');
        const historyBefore = fx.db.getAllHistory().map(h => ({ node_id: h.node_id, reasoning: h.reasoning, code_snapshot: h.code_snapshot })).sort((a, b) => a.node_id.localeCompare(b.node_id));

        fx.db.close();
        // Simulate a lost/corrupted brain.db: delete it entirely.
        fs.rmSync(dbPath, { force: true });
        for (const ext of ['-wal', '-shm', '-journal']) {
          fs.rmSync(dbPath + ext, { force: true });
        }
        expect(fs.existsSync(dbPath)).toBe(false);

        // Constructing a fresh DevMindDatabase auto-runs syncFromDisk() and must rebuild
        // everything purely from the committed graph/*.json + history/*.json trees.
        const db2 = new DevMindDatabase(dbPath);
        try {
          const afterCounts = db2.getCounts();
          expect(afterCounts).toEqual(beforeCounts);

          const greetAfter = db2.getNode('{app}/foo.ts#greet')!;
          const formatAfter = db2.getNode('{app}/bar.ts#format')!;
          expect(greetAfter).toBeTruthy();
          expect(formatAfter).toBeTruthy();
          expect(greetAfter.name).toBe(greetBefore.name);
          expect(greetAfter.type).toBe(greetBefore.type);
          expect(greetAfter.description).toBe(greetBefore.description);
          expect(formatAfter.description).toBe(formatBefore.description);

          const connsAfter = db2.getConnections('{app}/foo.ts#greet');
          expect(connsAfter.uses.map(c => c.id).sort()).toEqual(connsBefore.uses.map(c => c.id).sort());

          const historyAfter = db2.getAllHistory().map(h => ({ node_id: h.node_id, reasoning: h.reasoning, code_snapshot: h.code_snapshot })).sort((a, b) => a.node_id.localeCompare(b.node_id));
          expect(historyAfter).toEqual(historyBefore);
        } finally {
          db2.close();
        }
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('resetAll', () => {
    it('wipes nodes/edges/history/vectors/system_meta and the graph/+history/ folders on disk, but preserves workflows/', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          {
            node_id: 'greet',
            file_path: repoFile(fx, 'foo.ts'),
            code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
            name: 'greet',
            type: 'function',
            description: 'Greets by name.'
          }
        ]);
        const wf = fx.db.createWorkflow('Keep Me', 'Should survive resetAll');
        fx.db.addWorkflowStep(wf.id, { summary: 'a step' });
        fx.db.addWorkflowArtifact(wf.id, { type: 'note', sourceName: 'note.md', content: 'still here' });

        expect(fx.db.getCounts().nodes).toBeGreaterThan(0);

        const graphDir = path.join(fx.devmindPath, 'graph');
        const historyDir = path.join(fx.devmindPath, 'history');
        const vectorsDir = path.join(fx.devmindPath, 'vectors');
        const workflowsDir = path.join(fx.devmindPath, 'workflows');
        expect(fs.readdirSync(historyDir).length).toBeGreaterThan(0);

        fx.db.resetAll();

        const counts = fx.db.getCounts();
        // vectors wiped along with nodes/history; workflows is NOT — the one created above
        // (and asserted still present just below) survives resetAll by design.
        expect(counts).toEqual({ nodes: 0, connections: 0, history: 0, vectors: 0, workflows: 1 });
        expect(fx.db.getAllNodes()).toEqual([]);
        // The workflow ROW itself, and its files on disk, are untouched — resetAll clears the
        // graph, not the long-lived feature record.
        expect(fx.db.getWorkflow(wf.id)).toBeTruthy();
        expect(fx.db.getWorkflowSteps(wf.id)).toHaveLength(1);

        expect(fs.existsSync(graphDir)).toBe(true);
        expect(fs.readdirSync(graphDir)).toEqual([]);
        expect(fs.existsSync(historyDir)).toBe(true);
        expect(fs.readdirSync(historyDir)).toEqual([]);
        expect(fs.existsSync(vectorsDir)).toBe(true);
        expect(fs.readdirSync(vectorsDir)).toEqual([]);

        expect(fs.existsSync(workflowsDir)).toBe(true);
        expect(fs.existsSync(path.join(workflowsDir, wf.id, 'workflow.json'))).toBe(true);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('vector orphan sweep', () => {
    it('a vectors/*.json entry for a node_id with no corresponding node is dropped by syncFromDisk, not resurrected as a phantom node', () => {
      const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'orphan.ts': 'export function orphan(): void {}\n' } });
      try {
        const ghostNodeId = '{app}/orphan.ts#ghostNode';
        const vectorsPath = path.join(fx.devmindPath, 'vectors', 'app', 'orphan.json');
        fs.mkdirSync(path.dirname(vectorsPath), { recursive: true });
        const fakeVector = Buffer.from(new Int8Array([1, 2, 3, 4])).toString('base64');
        fs.writeFileSync(vectorsPath, JSON.stringify({
          file_path: '{app}/orphan.ts',
          model_id: EMBEDDING_MODEL_ID,
          dim: EMBEDDING_DIM,
          vectors: { [ghostNodeId]: { h: 'deadbeef', v: fakeVector } }
        }, null, 2));

        expect(fx.db.getNode(ghostNodeId)).toBeNull();
        fx.db.syncFromDisk();

        // No phantom node was created by the vectors pass...
        expect(fx.db.getNode(ghostNodeId)).toBeNull();
        // ...and its vector row was swept, not left dangling.
        expect(fx.db.getNodeVector(ghostNodeId)).toBeNull();
      } finally {
        fx.cleanup();
      }
    });

    it('a mismatched model_id vectors file is ignored entirely on import', () => {
      const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'orphan.ts': 'export function orphan(): void {}\n' } });
      try {
        const ghostNodeId = '{app}/orphan.ts#ghostNode2';
        const vectorsPath = path.join(fx.devmindPath, 'vectors', 'app', 'orphan2.json');
        fs.mkdirSync(path.dirname(vectorsPath), { recursive: true });
        fs.writeFileSync(vectorsPath, JSON.stringify({
          file_path: '{app}/orphan.ts',
          model_id: 'some-other-model-v9',
          dim: EMBEDDING_DIM,
          vectors: { [ghostNodeId]: { h: 'deadbeef', v: Buffer.from([1]).toString('base64') } }
        }, null, 2));

        fx.db.syncFromDisk();
        expect(fx.db.getNodeVector(ghostNodeId)).toBeNull();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('legacy relative-path healing', () => {
    it('heals a nodes.file_path row stored in old repo-relative form ("{repo}/rel/path") into an absolute path on the next syncFromDisk', () => {
      // Assumption: "legacy" rows are ones where file_path was stored in the pre-normalization
      // repo-relative form (`{repoName}/relative/path`) instead of the canonical absolute path
      // upsertNode() always writes today. Step 0 of syncFromDisk detects any nodes.file_path
      // that is NOT path.isAbsolute() and rewrites it via toAbsolutePath(). upsertNode() itself
      // can't produce such a row (it always canonicalizes to absolute), so this is constructed
      // by writing directly to the underlying SQLite file between two DevMindDatabase instances.
      const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'legacy.ts': 'export function legacy(): void {}\n' } });
      try {
        const dbPath = path.join(fx.devmindPath, 'brain.db');
        const legacyId = '{app}/legacy.ts#legacy';
        fx.db.close();

        const raw = new BetterSqlite3(dbPath);
        raw.prepare(`
          INSERT INTO nodes (id, type, name, file_path, signature, description, aliases, deprecated)
          VALUES (?, 'function', 'legacy', ?, NULL, NULL, '[]', 0)
        `).run(legacyId, '{app}/legacy.ts');
        raw.close();

        const db2 = new DevMindDatabase(dbPath); // constructor runs syncFromDisk -> heals the row
        try {
          const healed = db2.getNode(legacyId);
          expect(healed).toBeTruthy();
          expect(path.isAbsolute(healed!.file_path)).toBe(true);
          expect(healed!.file_path.toLowerCase()).toBe(repoFile(fx, 'legacy.ts').toLowerCase());
        } finally {
          db2.close();
        }
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('incremental sync (mtime/existence checkpoint)', () => {
    it('does not re-import an unchanged graph/*.json on a second syncFromDisk (DB stays as directly mutated, not reverted to the stale-mtime file)', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          {
            node_id: 'greet',
            file_path: repoFile(fx, 'foo.ts'),
            code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
            name: 'greet',
            type: 'function',
            description: 'Original description from the JSON.'
          }
        ]);
        const nodeId = '{app}/foo.ts#greet';
        expect(fx.db.getNode(nodeId)!.description).toBe('Original description from the JSON.');

        // Back-date the graph JSON so it is UNAMBIGUOUSLY older than the checkpoint the sync
        // below will write. Without this the test depended on `stageAndCommit`'s file write and
        // `syncFromDisk`'s `Date.now()` landing in different milliseconds: the skip is
        // `mtimeMs < lastSyncedAtMs` (strict), so an equal timestamp reprocesses the file and the
        // assertion fails. That made this case flaky under parallel load — and it was testing the
        // clock, not the skip logic. The sibling test below establishes its precondition the same
        // explicit way, in the opposite direction.
        const graphJsonPath = path.join(fx.devmindPath, 'graph', 'app', 'foo.json');
        const past = new Date(Date.now() - 60_000);
        fs.utimesSync(graphJsonPath, past, past);

        // Establish a checkpoint that POST-dates the graph JSON's write (the fixture's initial
        // construction checkpoint predates `stageAndCommit`, so the first sync after a commit
        // always sees the file as "newer than checkpoint" regardless of the skip logic — this
        // call is what makes the skip check below actually meaningful).
        fx.db.syncFromDisk();

        // Mutate the DB directly, bypassing the write path entirely — the graph/*.json on disk
        // still says "Original description...". Its mtime is untouched.
        const dbPath = path.join(fx.devmindPath, 'brain.db');
        const raw = new BetterSqlite3(dbPath);
        raw.prepare('UPDATE nodes SET description = ? WHERE id = ?').run('Mutated directly in SQLite.', nodeId);
        raw.close();
        expect(fx.db.getNode(nodeId)!.description).toBe('Mutated directly in SQLite.');

        // If syncFromDisk re-read this unchanged file, it would overwrite the description back
        // to the JSON's "Original description...". It must NOT, because the file's mtime is
        // older than the checkpoint set by the syncFromDisk() call above.
        fx.db.syncFromDisk();
        expect(fx.db.getNode(nodeId)!.description).toBe('Mutated directly in SQLite.');
      } finally {
        fx.cleanup();
      }
    });

    it('DOES re-import a graph/*.json once its mtime is bumped past the last sync checkpoint', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          {
            node_id: 'greet',
            file_path: repoFile(fx, 'foo.ts'),
            code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
            name: 'greet',
            type: 'function',
            description: 'Original description from the JSON.'
          }
        ]);
        const nodeId = '{app}/foo.ts#greet';

        // Same reasoning as the previous test: establish a checkpoint that post-dates the
        // file's write, so the mtime bump below is what triggers reprocessing, not merely
        // "first sync since the fixture's pre-commit initial checkpoint."
        fx.db.syncFromDisk();

        const dbPath = path.join(fx.devmindPath, 'brain.db');
        const raw = new BetterSqlite3(dbPath);
        raw.prepare('UPDATE nodes SET description = ? WHERE id = ?').run('Mutated directly in SQLite.', nodeId);
        raw.close();

        // Bump the graph JSON's mtime into the future so it reads as "changed since last sync",
        // without touching its content — isolates the mtime check from a content check.
        const graphJsonPath = path.join(fx.devmindPath, 'graph', 'app', 'foo.json');
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(graphJsonPath, future, future);

        fx.db.syncFromDisk();
        // Reprocessed: the DB now reflects the JSON's content again, not the raw-SQL mutation.
        expect(fx.db.getNode(nodeId)!.description).toBe('Original description from the JSON.');
      } finally {
        fx.cleanup();
      }
    });

    it('does not error or duplicate when syncFromDisk runs twice over the same history/*.json (filename-based already-synced check)', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          {
            node_id: 'greet',
            file_path: repoFile(fx, 'foo.ts'),
            code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
            name: 'greet',
            type: 'function',
            description: 'Greets by name.'
          }
        ]);
        const before = fx.db.getCounts();

        fx.db.syncFromDisk();
        fx.db.syncFromDisk();

        expect(fx.db.getCounts()).toEqual(before);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('syncToDisk', () => {
    it('force-writes every node file_path\'s graph JSON and every workflow JSON from current DB state', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          {
            node_id: 'greet',
            file_path: repoFile(fx, 'foo.ts'),
            code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
            name: 'greet',
            type: 'function',
            description: 'Greets by name.'
          }
        ]);
        const wf = fx.db.createWorkflow('Sync Test', 'desc');

        const graphJsonPath = path.join(fx.devmindPath, 'graph', 'app', 'foo.json');
        const workflowJsonPath = path.join(fx.devmindPath, 'workflows', wf.id, 'workflow.json');
        expect(fs.existsSync(graphJsonPath)).toBe(true);
        expect(fs.existsSync(workflowJsonPath)).toBe(true);

        // Corrupt/delete the on-disk copies, then force a re-sync from DB state.
        fs.rmSync(graphJsonPath, { force: true });
        fs.rmSync(workflowJsonPath, { force: true });
        expect(fs.existsSync(graphJsonPath)).toBe(false);
        expect(fs.existsSync(workflowJsonPath)).toBe(false);

        fx.db.syncToDisk();

        expect(fs.existsSync(graphJsonPath)).toBe(true);
        expect(fs.existsSync(workflowJsonPath)).toBe(true);
        const graphData = JSON.parse(fs.readFileSync(graphJsonPath, 'utf-8'));
        expect(graphData.nodes.map((n: any) => n.id)).toContain('{app}/foo.ts#greet');
      } finally {
        fx.cleanup();
      }
    });

    it('also force-writes every node\'s vectors JSON from current DB state, not just graph/workflows', async () => {
      // Regression test: syncToDisk used to only call writeGraphToDisk/writeWorkflowToDisk,
      // silently leaving vectors/*.json stale on a force-resync even though syncFromDisk (the
      // read half) does load vectors/*.json into node_vectors — an asymmetry that defeated half
      // the point of `devsmind sync` as a recovery tool for exactly this kind of on-disk drift.
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        await stageAndCommit(fx, [
          {
            node_id: 'greet',
            file_path: repoFile(fx, 'foo.ts'),
            code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
            name: 'greet',
            type: 'function',
            description: 'Greets by name.'
          }
        ]);
        fx.db.upsertNodeVector(nodeId, new Int8Array([1, 2, 3, 4]), hashDescription('Greets by name.'));

        const vectorsJsonPath = path.join(fx.devmindPath, 'vectors', 'app', 'foo.json');
        expect(fs.existsSync(vectorsJsonPath)).toBe(true);

        fs.rmSync(vectorsJsonPath, { force: true });
        expect(fs.existsSync(vectorsJsonPath)).toBe(false);

        fx.db.syncToDisk();

        expect(fs.existsSync(vectorsJsonPath)).toBe(true);
        const vectorsData = JSON.parse(fs.readFileSync(vectorsJsonPath, 'utf-8'));
        expect(Object.keys(vectorsData.vectors)).toContain(nodeId);
      } finally {
        fx.cleanup();
      }
    });

    it('stops repeating the directory-typed file_path warning on every future syncToDisk once the node is deprecated — deprecating it never clears the garbage file_path, so it used to warn forever', () => {
      // Regression test: a real production brain reported the exact same "Skipped writing graph
      // JSON: a node's file_path resolves to a directory" warning on EVERY `devsmind sync`, even
      // after `devsmind analyze --fix` had already deprecated the offending node. `deprecateNode`
      // sets deprecated=1 but never touches the (already-garbage) file_path column, and
      // syncToDisk's own `SELECT DISTINCT file_path FROM nodes` never filtered deprecated — so
      // the same unwritable path kept getting handed to writeGraphToDisk/writeVectorsToDisk,
      // forever, indistinguishable from the bug never having been fixed.
      const fx = makeFixture();
      try {
        // Two distinct collapse shapes: file_path == the .devmind dir itself (diskRelPath goes
        // empty) and file_path == the project root one level up (diskRelPath collapses to '..'
        // with no trailing slash) — isFilePathStructurallyDegenerate must catch both.
        const id1 = '{app}/#corrupt';
        const id2 = '{app}/#corrupt2';
        fx.db.upsertNode({ id: id1, type: 'function', name: 'corrupt', file_path: fx.devmindPath });
        fx.db.upsertNode({ id: id2, type: 'function', name: 'corrupt2', file_path: fx.root });
        fx.db.deprecateNode(id1); // what analyze --fix actually does for a missing_files node
        fx.db.deprecateNode(id2);

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          fx.db.syncToDisk();
          fx.db.syncToDisk(); // twice, to prove it's not a one-time thing
          expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('resolves to a directory'));
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        fx.cleanup();
      }
    });

    it('still re-attempts (and rewrites) a file_path shared by an active node and a deprecated one', () => {
      // The skip above must not become a blanket "any deprecated node's file_path is ignored" —
      // a file with one live node and one deprecated sibling still needs its graph JSON kept
      // current so the deprecated:1 flag on the sibling survives a fresh syncFromDisk elsewhere.
      const fx = makeFixture();
      try {
        const liveId = '{app}/foo.ts#greet';
        const deadId = '{app}/foo.ts#dead';
        fx.db.upsertNode({ id: liveId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        fx.db.upsertNode({ id: deadId, type: 'function', name: 'dead', file_path: repoFile(fx, 'foo.ts') });
        fx.db.deprecateNode(deadId);

        const graphJsonPath = path.join(fx.devmindPath, 'graph', 'app', 'foo.json');
        fs.rmSync(graphJsonPath, { force: true });
        expect(fs.existsSync(graphJsonPath)).toBe(false);

        fx.db.syncToDisk();

        expect(fs.existsSync(graphJsonPath)).toBe(true);
        const graphData = JSON.parse(fs.readFileSync(graphJsonPath, 'utf-8'));
        const byId = Object.fromEntries(graphData.nodes.map((n: any) => [n.id, n]));
        expect(byId[liveId]?.deprecated).toBe(0);
        expect(byId[deadId]?.deprecated).toBe(1);
      } finally {
        fx.cleanup();
      }
    });

    it('tolerates a node with a blank file_path instead of throwing or warning', () => {
      const fx = makeFixture();
      try {
        fx.db.upsertNode({ id: '{app}/#blank', type: 'function', name: 'blank', file_path: '' });

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(() => fx.db.syncToDisk()).not.toThrow();
          expect(warnSpy).not.toHaveBeenCalled();
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getCounts', () => {
    it('reports vectors and workflows alongside nodes/connections/history, not just the original three', async () => {
      // `devsmind sync`'s printed summary is only as honest as this — it drives the
      // Nodes/Connections/History/Vectors/Workflows lines the CLI shows after a sync.
      const fx = makeFixture();
      try {
        const nodeId = '{app}/foo.ts#greet';
        await stageAndCommit(fx, [
          {
            node_id: 'greet',
            file_path: repoFile(fx, 'foo.ts'),
            code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
            name: 'greet',
            type: 'function',
            description: 'Greets by name.'
          }
        ]);
        fx.db.upsertNodeVector(nodeId, new Int8Array([1, 2, 3, 4]), hashDescription('Greets by name.'));
        fx.db.createWorkflow('Count Me', 'exercises getCounts');

        const counts = fx.db.getCounts();
        expect(counts.nodes).toBeGreaterThan(0);
        expect(counts.vectors).toBe(1);
        expect(counts.workflows).toBe(1);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('syncFromDisk tolerates sparse/legacy hand-written JSON', () => {
    it('rebuilds a workflow from a workflow.json missing every optional field, and resurrects a node from a history.json carrying node_metadata', async () => {
      const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'legacy.ts': 'export function legacy(): void {}\n' } });
      try {
        const dbPath = path.join(fx.devmindPath, 'brain.db');
        fx.db.close();
        fs.rmSync(dbPath, { force: true });

        // A workflow.json with only the two required fields (id, name) — every other field the
        // rebuild loop reads (description/status/created_at/updated_at, and a step's
        // pending_tasks/history_ids/session_id/created_at) is absent, exercising every `|| <default>`
        // fallback in syncFromDisk's workflow-rebuild transaction in one pass.
        // Genuinely empty workflow.json — no steps, no artifact_index at all (as opposed to empty
        // arrays), exercising the `data.steps || []` / `data.artifact_index || []` fallbacks too.
        const wfDir = path.join(fx.devmindPath, 'workflows', 'wf-sparse');
        fs.mkdirSync(wfDir, { recursive: true });
        fs.writeFileSync(path.join(wfDir, 'workflow.json'), JSON.stringify({
          id: 'wf-sparse',
          name: 'Sparse Workflow'
        }));

        // A second workflow.json that DOES have a step/artifact, each missing every optional field
        // of their own, to independently cover the per-step/per-artifact `|| <default>` fallbacks
        // without also re-triggering the (already-covered) missing-array fallback above.
        const wfDir2 = path.join(fx.devmindPath, 'workflows', 'wf-sparse-2');
        fs.mkdirSync(wfDir2, { recursive: true });
        fs.writeFileSync(path.join(wfDir2, 'workflow.json'), JSON.stringify({
          id: 'wf-sparse-2',
          name: 'Sparse Workflow 2',
          steps: [{ id: 'step-1', step_index: 0 }],
          artifact_index: [{ id: 'art-1', type: 'note', source_name: 'x', file_path: 'x.md', created_at: '2024-01-01T00:00:00.000Z' }]
        }));

        // A history/<id>.json referencing a node_id with no graph/*.json counterpart yet, but
        // carrying node_metadata — exercises syncFromDisk's node-resurrection branch (insertNodeStmt
        // fires only when the node doesn't already exist AND node_metadata is present). Also
        // deliberately omits code_snapshot and gives reasoning as an OBJECT (not a string), to
        // exercise the `data.code_snapshot || ''` and non-string-reasoning `formatReasoning(...)`
        // fallbacks in the same pass.
        const historyDir = path.join(fx.devmindPath, 'history');
        fs.mkdirSync(historyDir, { recursive: true });
        fs.writeFileSync(path.join(historyDir, 'hist-resurrected.json'), JSON.stringify({
          id: 'hist-resurrected',
          node_id: '{app}/legacy.ts#legacy',
          session_id: 'legacy-session',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
          reasoning: { what_changed: 'Resurrected from history alone.', why: 'test', goal: 'test' },
          node_metadata: {
            type: 'function', name: 'legacy',
            // toAbsolutePath expects the {repo}/relative form, not an OS-absolute path.
            file_path: '{app}/legacy.ts',
            signature: undefined
          }
        }));

        // Constructing a fresh DevMindDatabase auto-runs syncFromDisk() over this hand-written state.
        const db2 = new DevMindDatabase(dbPath);
        try {
          const wf = db2.getWorkflow('wf-sparse');
          expect(wf?.name).toBe('Sparse Workflow');
          expect(wf?.description).toBe('');
          // A JSON with no `archived` key defaults to visible, not hidden — an absent field must
          // never silently retire someone's workflow.
          expect(wf?.archived).toBe(0);

          const wf2 = db2.getWorkflowContext('wf-sparse-2');
          expect(wf2?.workflow.name).toBe('Sparse Workflow 2');
          expect(wf2?.steps).toHaveLength(1);

          const resurrected = db2.getNode('{app}/legacy.ts#legacy');
          expect(resurrected).toBeTruthy();
          expect(resurrected?.name).toBe('legacy');
          const resurrectedHistory = db2.getFullHistory(resurrected!.id)[0];
          expect(resurrectedHistory).toBeTruthy();
          expect(resurrectedHistory.code_snapshot).toBe('');
          expect(resurrectedHistory.reasoning).toContain('Resurrected from history alone.');
        } finally {
          db2.close();
        }
      } finally {
        fx.cleanup();
      }
    });
  });
});
