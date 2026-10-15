import * as fs from 'fs';
import * as os from 'os';
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

    // syncToDisk re-serializes EVERY file_path on every run, so on a real brain the overwhelming
    // majority of its writes reproduce bytes that are already there. Measured on a ~19,000-file
    // brain that was 228 seconds of almost pure filesystem wait. Rewriting an unchanged file is
    // also what keeps every mtime permanently fresh, which is why nothing downstream can use
    // timestamps to tell what actually changed.
    // A node whose file_path is a ", "-joined list of several files is the one case the fast path
    // cannot answer: the indexed equality arm matches only an exact path, so a second LIKE query
    // covers these. That query is SKIPPED entirely on a brain with no such node — which is the
    // optimization — so this proves it still runs when one exists.
    it('still writes a node whose file_path is a ", "-joined list of files', async () => {
      const fx = makeFixture();
      try {
        const a = repoFile(fx, 'a.ts');
        const b = repoFile(fx, 'b.ts');
        fx.db.upsertNode({
          id: '{app}/a.ts#shared', type: 'function', name: 'shared',
          file_path: `${a}, ${b}`, description: 'Spans two files.'
        });

        fx.db.syncToDisk();

        // It belongs to BOTH files, and must appear under each.
        const underA = JSON.parse(fs.readFileSync(path.join(fx.devmindPath, 'graph', 'app', 'a.json'), 'utf-8'));
        const underB = JSON.parse(fs.readFileSync(path.join(fx.devmindPath, 'graph', 'app', 'b.json'), 'utf-8'));
        expect(underA.nodes.map((n: any) => n.id)).toContain('{app}/a.ts#shared');
        expect(underB.nodes.map((n: any) => n.id)).toContain('{app}/a.ts#shared');
      } finally {
        fx.cleanup();
      }
    });

    // The multi-file query is gated on a cached "does this brain have any such node" answer. A
    // brain that had none when the cache was filled and then gains one must start running it, or
    // the node silently never reaches disk until the process restarts.
    it('does not hand a comma-joined multi-file path to writeGraphToDisk during upsert', async () => {
      const fx = makeFixture();
      try {
        const a = repoFile(fx, 'a.ts');
        const b = repoFile(fx, 'b.ts');
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          fx.db.upsertNode({
            id: '{app}/a.ts#shared_nowarn', type: 'function', name: 'shared_nowarn',
            file_path: `${a}, ${b}`, description: 'Spans two files without malformed path warnings.'
          });
          expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Failed to write graph JSON'), expect.anything());
        } finally {
          warnSpy.mockRestore();
        }

        expect(fs.existsSync(path.join(fx.devmindPath, 'graph', 'app', 'a.json'))).toBe(true);
        expect(fs.existsSync(path.join(fx.devmindPath, 'graph', 'app', 'b.json'))).toBe(true);
      } finally {
        fx.cleanup();
      }
    });

    it('picks up the first multi-file node added after the cache was warmed', async () => {
      const fx = makeFixture();
      try {
        const a = repoFile(fx, 'a.ts');
        const b = repoFile(fx, 'b.ts');
        // Warm the cache on a brain with no multi-file node at all.
        fx.db.upsertNode({ id: '{app}/a.ts#solo', type: 'function', name: 'solo', file_path: a, description: 'Single file.' });
        fx.db.syncToDisk();

        fx.db.upsertNode({
          id: '{app}/a.ts#late', type: 'function', name: 'late',
          file_path: `${a}, ${b}`, description: 'Added later, spans two files.'
        });
        fx.db.syncToDisk();

        const underB = JSON.parse(fs.readFileSync(path.join(fx.devmindPath, 'graph', 'app', 'b.json'), 'utf-8'));
        expect(underB.nodes.map((n: any) => n.id)).toContain('{app}/a.ts#late');
      } finally {
        fx.cleanup();
      }
    });

    it('leaves a file alone when its content would be identical', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          {
            node_id: 'greet',
            file_path: repoFile(fx, 'foo.ts'),
            code_snapshot: 'export function greet(n: string): string {\n  return n;\n}',
            name: 'greet',
            type: 'function',
            description: 'Greets by name.'
          }
        ]);
        const graphJsonPath = path.join(fx.devmindPath, 'graph', 'app', 'foo.json');
        const before = fs.statSync(graphJsonPath).mtimeMs;

        // Far enough back that a rewrite could not land on the same timestamp by coincidence.
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(graphJsonPath, old, old);
        const stamped = fs.statSync(graphJsonPath).mtimeMs;

        fx.db.syncToDisk();

        expect(fs.statSync(graphJsonPath).mtimeMs).toBe(stamped);
        expect(before).toBeGreaterThan(0);
        // ...and the content is still correct, not merely untouched.
        const data = JSON.parse(fs.readFileSync(graphJsonPath, 'utf-8'));
        expect(data.nodes.map((n: any) => n.id)).toContain('{app}/foo.ts#greet');
      } finally {
        fx.cleanup();
      }
    });

    it('does write when the content genuinely differs', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          {
            node_id: 'greet',
            file_path: repoFile(fx, 'foo.ts'),
            code_snapshot: 'export function greet(n: string): string {\n  return n;\n}',
            name: 'greet',
            type: 'function',
            description: 'Greets by name.'
          }
        ]);
        const graphJsonPath = path.join(fx.devmindPath, 'graph', 'app', 'foo.json');
        fs.writeFileSync(graphJsonPath, '{"file_path":"stale","nodes":[],"connections":[]}');

        fx.db.syncToDisk();

        const data = JSON.parse(fs.readFileSync(graphJsonPath, 'utf-8'));
        expect(data.nodes.map((n: any) => n.id)).toContain('{app}/foo.ts#greet');
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

    it('keeps a structurally valid file path when the only node for it is deprecated', () => {
      const fx = makeFixture();
      try {
        const filePath = repoFile(fx, 'deprecated.ts');
        const id = '{app}/deprecated.ts#old';
        fx.db.upsertNode({ id, type: 'function', name: 'old', file_path: filePath });
        fx.db.deprecateNode(id);

        fx.db.syncToDisk();

        const graphPath = path.join(fx.devmindPath, 'graph', 'app', 'deprecated.json');
        expect(fs.existsSync(graphPath)).toBe(true);
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

  describe('cross-OS portable paths & malformed vector filename prevention', () => {
    it('upsertNode does not join two paths representing the same file from different OS representations', () => {
      const fx = makeFixture();
      try {
        const localFoo = repoFile(fx, 'foo.ts');
        // Seed node with a simulated teammate Linux path
        const linuxPath = `/home/teammate/project/app/foo.ts`;
        fx.db.upsertNode({
          id: '{app}/foo.ts#testFunc',
          type: 'function',
          name: 'testFunc',
          file_path: linuxPath,
          description: 'A test function.'
        });

        // Now local Windows machine runs upsertNode with local absolute path
        fx.db.upsertNode({
          id: '{app}/foo.ts#testFunc',
          type: 'function',
          name: 'testFunc',
          file_path: localFoo,
          description: 'Updated test function description.'
        });

        const node = fx.db.getNode('{app}/foo.ts#testFunc');
        expect(node).toBeTruthy();
        expect(node!.file_path).not.toContain(',');
        expect(node!.file_path).not.toContain('/home/');
        expect(node!.file_path.toLowerCase()).toBe(localFoo.toLowerCase());
      } finally {
        fx.cleanup();
      }
    });

    it('upsertNode collapses pre-existing comma-joined duplicate paths into a single canonical path', () => {
      const fx = makeFixture();
      try {
        const localFoo = repoFile(fx, 'foo.ts');
        const simulatedCorrupted = `${localFoo}, /home/teammate/Documents/Harrir/app/foo.ts`;
        
        // Directly insert corrupted row in SQLite
        (fx.db as any).db.prepare(`
          INSERT INTO nodes (id, type, name, file_path, description, deprecated)
          VALUES ('{app}/foo.ts#corrupted', 'function', 'corrupted', ?, 'Test corrupted', 0)
        `).run(simulatedCorrupted);

        // Next upsertNode cleans and collapses it
        fx.db.upsertNode({
          id: '{app}/foo.ts#corrupted',
          type: 'function',
          name: 'corrupted',
          file_path: localFoo,
          description: 'Cleaned'
        });

        const node = fx.db.getNode('{app}/foo.ts#corrupted');
        expect(node).toBeTruthy();
        expect(node!.file_path.toLowerCase()).toBe(localFoo.toLowerCase());
        expect(node!.file_path).not.toContain(',');
      } finally {
        fx.cleanup();
      }
    });

    it('writeVectorsToDisk splits comma-separated file_path into separate clean JSON files', () => {
      const fx = makeFixture();
      try {
        const foo = repoFile(fx, 'foo.ts');
        const bar = repoFile(fx, 'bar.ts');

        fx.db.upsertNode({ id: '{app}/foo.ts#f1', type: 'function', name: 'f1', file_path: foo, description: 'f1' });
        fx.db.upsertNode({ id: '{app}/bar.ts#b1', type: 'function', name: 'b1', file_path: bar, description: 'b1' });

        const vec = new Int8Array(EMBEDDING_DIM).fill(1);
        fx.db.upsertNodeVector('{app}/foo.ts#f1', vec, 'hash1');
        fx.db.upsertNodeVector('{app}/bar.ts#b1', vec, 'hash2');

        // Call writeVectorsToDisk with a comma-joined path
        fx.db.writeVectorsToDisk(`${foo}, ${bar}`);

        const vectorsDir = path.join(fx.devmindPath, 'vectors', 'app');
        expect(fs.existsSync(path.join(vectorsDir, 'foo.json'))).toBe(true);
        expect(fs.existsSync(path.join(vectorsDir, 'bar.json'))).toBe(true);

        // Verify NO files or dirs with commas exist anywhere in vectors/
        const allInVectors = fs.readdirSync(path.join(fx.devmindPath, 'vectors'), { recursive: true });
        for (const item of allInVectors) {
          expect(String(item)).not.toContain(',');
          expect(String(item)).not.toContain('/home/');
        }
      } finally {
        fx.cleanup();
      }
    });

    it('writeVectorsToDisk rejects degenerate and malformed paths without creating corrupt files', () => {
      const fx = makeFixture();
      try {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          fx.db.writeVectorsToDisk('/home/user/other/malformed, /opt/bad.ts');
          fx.db.writeVectorsToDisk('C:\\invalid:path\\test*.json');
        } finally {
          warnSpy.mockRestore();
        }

        const vectorsDir = path.join(fx.devmindPath, 'vectors');
        if (fs.existsSync(vectorsDir)) {
          const files = fs.readdirSync(vectorsDir, { recursive: true });
          for (const f of files) {
            expect(String(f)).not.toContain('malformed');
            expect(String(f)).not.toContain(':');
          }
        }
      } finally {
        fx.cleanup();
      }
    });

    it('syncFromDisk step 0 heals comma-joined and cross-OS duplicate paths in nodes table', () => {
      const fx = makeFixture();
      try {
        const localFoo = repoFile(fx, 'foo.ts');
        const dbPath = path.join(fx.devmindPath, 'brain.db');

        // Write a graph file for foo.ts
        fs.mkdirSync(path.join(fx.devmindPath, 'graph', 'app'), { recursive: true });
        fs.writeFileSync(path.join(fx.devmindPath, 'graph', 'app', 'foo.json'), JSON.stringify({
          file_path: '{app}/foo.ts',
          nodes: [{ id: '{app}/foo.ts#healed', name: 'healed', type: 'function', deprecated: 0 }]
        }));

        // Directly insert comma-joined duplicate in SQLite
        (fx.db as any).db.prepare(`
          INSERT INTO nodes (id, type, name, file_path, deprecated)
          VALUES ('{app}/foo.ts#healed', 'function', 'healed', ?, 0)
        `).run(`${localFoo}, /home/propelius/app/foo.ts`);

        fx.db.close();

        // New DevMindDatabase triggers syncFromDisk() step 0 auto-heal
        const db2 = new DevMindDatabase(dbPath);
        try {
          const node = db2.getNode('{app}/foo.ts#healed');
          expect(node).toBeTruthy();
          expect(node!.file_path).not.toContain(',');
          expect(node!.file_path).not.toContain('/home/');
        } finally {
          db2.close();
        }
      } finally {
        fx.cleanup();
      }
    });

    it('syncFromDisk ignores a graph/vectors file with an unsafe name instead of importing it', () => {
      const fx = makeFixture();
      try {
        const dbPath = path.join(fx.devmindPath, 'brain.db');
        fs.mkdirSync(path.join(fx.devmindPath, 'graph', 'app'), { recursive: true });
        fs.writeFileSync(path.join(fx.devmindPath, 'graph', 'app', 'foo.json, home.json'), JSON.stringify({
          file_path: '{app}/foo.ts',
          nodes: [{ id: '{app}/foo.ts#poison', name: 'poison', type: 'function', deprecated: 0 }]
        }));
        fs.writeFileSync(path.join(fx.devmindPath, 'graph', 'app', 'ok.json'), JSON.stringify({
          file_path: '{app}/bar.ts',
          nodes: [{ id: '{app}/bar.ts#fine', name: 'fine', type: 'function', deprecated: 0 }]
        }));
        fx.db.close();

        const db2 = new DevMindDatabase(dbPath);
        try {
          expect(db2.getNode('{app}/foo.ts#poison')).toBeFalsy();
          expect(db2.getNode('{app}/bar.ts#fine')).toBeTruthy();
        } finally {
          db2.close();
        }
      } finally {
        fx.cleanup();
      }
    });

    it('never writes graph/vectors output for a file that is not under a configured repo, even when it sits inside the brain folder', () => {
      const fx = makeFixture();
      try {
        // Inside the workspace root, so toRepoRelativePath's fallback yields a clean `zzz/foo.ts`
        // with no `..` — the shape that used to slip through as `graph/zzz/foo.json`.
        const outside = path.join(fx.devmindPath, 'zzz', 'foo.ts');
        fs.mkdirSync(path.dirname(outside), { recursive: true });
        fs.writeFileSync(outside, 'export const a = 1;\n');
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          fx.db.upsertNode({ id: '{app}/foo.ts#stray', type: 'function', name: 'stray', file_path: outside });
        } finally {
          warnSpy.mockRestore();
        }
        expect(fs.existsSync(path.join(fx.devmindPath, 'graph', 'zzz'))).toBe(false);
        expect(fs.existsSync(path.join(fx.devmindPath, 'vectors', 'zzz'))).toBe(false);
      } finally {
        fx.cleanup();
      }
    });

    it('does not remap a real local file outside every repo just because a folder in its path shares a repo name', () => {
      const fx = makeFixture();
      const stray = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-stray-'));
      try {
        // The fixture's only repo is named `app`; this file is real, local, and under a folder
        // that happens to be called `app` — it must NOT be attributed to `{app}`.
        const strayFile = path.join(stray, 'app', 'stray.ts');
        fs.mkdirSync(path.dirname(strayFile), { recursive: true });
        fs.writeFileSync(strayFile, 'export const x = 1;\n');
        expect(fx.db.toRepoRelativePath(strayFile).startsWith('{app}/')).toBe(false);
      } finally {
        fs.rmSync(stray, { recursive: true, force: true });
        fx.cleanup();
      }
    });

    it('does not invent a repo identity for a native absolute path that is simply gone, but still maps another machine\'s path', () => {
      const fx = makeFixture();
      try {
        // A native absolute path under a folder named like the repo, to a file that no longer
        // exists: nothing says it ever belonged to `app`, so it must not be mapped there.
        const gone = path.join(os.tmpdir(), 'devsmind-gone-xyz', 'app', 'deleted.ts');
        expect(fs.existsSync(gone)).toBe(false);
        expect(fx.db.toRepoRelativePath(gone).startsWith('{app}/')).toBe(false);

        // Another machine's path to a file this repo does not hold locally is still recognized as
        // foreign and mapped — that is the whole point of the cross-OS mapping.
        const foreign = process.platform === 'win32' ? '/home/teammate/work/app/only-theirs.ts' : 'C:\\work\\app\\only-theirs.ts';
        expect(fx.db.toRepoRelativePath(foreign)).toBe('{app}/only-theirs.ts');
      } finally {
        fx.cleanup();
      }
    });

    it('maps a foreign path whose repo-name folder repeats to the occurrence that exists locally, not blindly the first', () => {
      const fx = makeFixture();
      try {
        // `/…/app/nested/app/foo.ts`: leftmost-match would give `nested/app/foo.ts` (absent here);
        // the occurrence that resolves to a real file in the repo is `foo.ts`.
        const rel = fx.db.toRepoRelativePath('/home/teammate/app/nested/app/foo.ts');
        expect(rel).toBe('{app}/foo.ts');
        expect(fx.db.toAbsolutePath('/home/teammate/app/nested/app/foo.ts').toLowerCase())
          .toBe(repoFile(fx, 'foo.ts').toLowerCase());
      } finally {
        fx.cleanup();
      }
    });

    it('syncFromDisk heal leaves an unmappable foreign path alone instead of rewriting it to the workspace root', () => {
      const fx = makeFixture();
      try {
        const dbPath = path.join(fx.devmindPath, 'brain.db');
        // Looks foreign on every platform (Windows drive form on posix, posix root on Windows),
        // and no configured repo can claim it.
        const foreign = process.platform === 'win32' ? '/home/stranger/unknown/zzz.ts' : 'Z:\\stranger\\unknown\\zzz.ts';
        (fx.db as any).db.prepare(`
          INSERT INTO nodes (id, type, name, file_path, deprecated)
          VALUES ('{app}/zzz.ts#ghost', 'function', 'ghost', ?, 0)
        `).run(foreign);
        fx.db.close();

        const db2 = new DevMindDatabase(dbPath);
        try {
          const node = db2.getNode('{app}/zzz.ts#ghost');
          expect(node).toBeTruthy();
          expect(node!.file_path).toBe(foreign);
          expect(path.resolve(node!.file_path).toLowerCase()).not.toBe(path.resolve(fx.devmindPath).toLowerCase());
        } finally {
          db2.close();
        }
      } finally {
        fx.cleanup();
      }
    });
  });
});
