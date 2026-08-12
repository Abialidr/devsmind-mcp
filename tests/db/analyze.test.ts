import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { makeFixture, stageAndCommit, repoFile, Fixture } from '../helpers/fixture';
import { runAnalysis } from '../../src/db/analyze';
import * as configModule from '../../src/utils/config';

function git(repoDir: string, args: string) {
  execSync(`git ${args}`, { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
}

function initGitRepo(repoDir: string) {
  git(repoDir, 'init -q');
  git(repoDir, 'config user.email "test@example.com"');
  git(repoDir, 'config user.name "Test User"');
}

describe('runAnalysis (src/db/analyze.ts)', () => {
  describe('call-signature and repo-resolution edges', () => {
    it('opts argument is optional — omitting it entirely still runs a (non-fix) analysis with default godEntityThreshold', () => {
      const fx = makeFixture();
      try {
        // No third argument at all (not even `{}`), exercising the `opts: AnalysisOptions = {}`
        // default-parameter branch that every other test in this file bypasses by always
        // passing an explicit options object.
        const report = runAnalysis(fx.db, fx.root);
        expect(report.fixed).toBe(false);
        expect(report.summary).toBeTruthy();
      } finally {
        fx.cleanup();
      }
    });

    it('a repo whose path cannot be resolved, or resolves to a nonexistent directory, is silently skipped rather than crashing', () => {
      const fx = makeFixture({
        configOverrides: {
          repos: [
            { name: 'app', relative_path: 'src-repo' },
            // 'relative_path' present but falsy -> resolveRepoPath's embedded-mode branch
            // returns null outright (the `!repoPath` half of the skip condition).
            { name: 'unresolvable', relative_path: '' },
            // 'relative_path' set but points nowhere on disk -> repoPath resolves to a real
            // string, but fs.existsSync(repoPath) is false (the other half of the condition).
            { name: 'ghost', relative_path: 'does-not-exist-on-disk' },
          ]
        }
      });
      try {
        initGitRepo(fx.repoDir);
        git(fx.repoDir, 'add -A');
        git(fx.repoDir, 'commit -q -m init');

        expect(() => runAnalysis(fx.db, fx.root, {})).not.toThrow();
        const report = runAnalysis(fx.db, fx.root, {});
        // Neither bogus repo contributes any entries — only 'app' (which has no changes
        // since the lookback window here) would ever be able to.
        expect(report.renamed_files.filter(r => r.repo !== 'app')).toEqual([]);
        expect(report.untracked_files.filter(u => u.repo !== 'app')).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('god entities', () => {
    it('flags a node whose total degree meets/exceeds the threshold, and not one with few connections', async () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'hub.ts': 'export function hub(): void {}\n',
          'leaf1.ts': 'export function leaf1(): void {}\n',
          'leaf2.ts': 'export function leaf2(): void {}\n',
          'leaf3.ts': 'export function leaf3(): void {}\n',
          'lonely.ts': 'export function lonely(): void {}\n'
        }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'hub', file_path: repoFile(fx, 'hub.ts'), code_snapshot: 'export function hub(): void {}', name: 'hub', type: 'function', description: 'Hub function.' },
          { node_id: 'leaf1', file_path: repoFile(fx, 'leaf1.ts'), code_snapshot: 'export function leaf1(): void {}', name: 'leaf1', type: 'function', description: 'Leaf 1.' },
          { node_id: 'leaf2', file_path: repoFile(fx, 'leaf2.ts'), code_snapshot: 'export function leaf2(): void {}', name: 'leaf2', type: 'function', description: 'Leaf 2.' },
          { node_id: 'leaf3', file_path: repoFile(fx, 'leaf3.ts'), code_snapshot: 'export function leaf3(): void {}', name: 'leaf3', type: 'function', description: 'Leaf 3.' },
          { node_id: 'lonely', file_path: repoFile(fx, 'lonely.ts'), code_snapshot: 'export function lonely(): void {}', name: 'lonely', type: 'function', description: 'Lonely function, no edges.' },
        ]);

        const hubId = '{app}/hub.ts#hub';
        fx.db.addConnection(hubId, '{app}/leaf1.ts#leaf1');
        fx.db.addConnection(hubId, '{app}/leaf2.ts#leaf2');
        fx.db.addConnection(hubId, '{app}/leaf3.ts#leaf3');

        const report = runAnalysis(fx.db, fx.root, { godEntityThreshold: 3 });
        expect(report.god_entities.map(g => g.id)).toContain(hubId);
        expect(report.god_entities.find(g => g.id === hubId)?.degree).toBe(3);
        expect(report.god_entities.map(g => g.id)).not.toContain('{app}/leaf1.ts#leaf1');
        expect(report.summary.god_entities).toBe(report.god_entities.length);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('circular dependencies', () => {
    it('detects a 3-node cycle A -> B -> C -> A', async () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'a.ts': 'export function a(): void {}\n',
          'b.ts': 'export function b(): void {}\n',
          'c.ts': 'export function c(): void {}\n'
        }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'a', file_path: repoFile(fx, 'a.ts'), code_snapshot: 'export function a(): void {}', name: 'a', type: 'function', description: 'A.' },
          { node_id: 'b', file_path: repoFile(fx, 'b.ts'), code_snapshot: 'export function b(): void {}', name: 'b', type: 'function', description: 'B.' },
          { node_id: 'c', file_path: repoFile(fx, 'c.ts'), code_snapshot: 'export function c(): void {}', name: 'c', type: 'function', description: 'C.' },
        ]);
        const aId = '{app}/a.ts#a', bId = '{app}/b.ts#b', cId = '{app}/c.ts#c';
        fx.db.addConnection(aId, bId);
        fx.db.addConnection(bId, cId);
        fx.db.addConnection(cId, aId);

        expect(fx.db.getCircularDependencies().length).toBeGreaterThanOrEqual(1);

        const report = runAnalysis(fx.db, fx.root, {});
        expect(report.circular_dependencies.length).toBeGreaterThanOrEqual(1);
        const cycleNodes = new Set(report.circular_dependencies[0]);
        expect(cycleNodes.has(aId) && cycleNodes.has(bId) && cycleNodes.has(cId)).toBe(true);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('orphaned nodes', () => {
    it('flags a node with zero in/out edges', async () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: { 'solo.ts': 'export function solo(): void {}\n' }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'solo', file_path: repoFile(fx, 'solo.ts'), code_snapshot: 'export function solo(): void {}', name: 'solo', type: 'function', description: 'Solo, unconnected.' },
        ]);
        const soloId = '{app}/solo.ts#solo';
        expect(fx.db.getOrphanedNodes().map(n => n.id)).toContain(soloId);

        const report = runAnalysis(fx.db, fx.root, {});
        expect(report.orphaned_nodes.map(n => n.id)).toContain(soloId);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('dangling edges', () => {
    it('addConnection to a nonexistent target leaves a dangling row that runAnalysis detects and --fix removes', async () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: { 'src1.ts': 'export function src1(): void {}\n' }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'src1', file_path: repoFile(fx, 'src1.ts'), code_snapshot: 'export function src1(): void {}', name: 'src1', type: 'function', description: 'Source node.' },
        ]);
        const srcId = '{app}/src1.ts#src1';
        const ghostTarget = '{app}/ghost.ts#ghost';
        fx.db.addConnection(srcId, ghostTarget);

        const dangling = fx.db.getDanglingEdges();
        expect(dangling).toEqual([{ source_node_id: srcId, target_node_id: ghostTarget }]);

        const reportDry = runAnalysis(fx.db, fx.root, {});
        expect(reportDry.dangling_edges).toEqual([{ source_node_id: srcId, target_node_id: ghostTarget }]);
        // dry-run must not mutate
        expect(fx.db.getDanglingEdges()).toHaveLength(1);

        const reportFix = runAnalysis(fx.db, fx.root, { fix: true });
        expect(reportFix.fixed).toBe(true);
        expect(fx.db.getDanglingEdges()).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('duplicate/case-collision node ids', () => {
    it('two nodes whose ids differ only by case are flagged as duplicates', () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'Dup.ts': 'export function dup(): void {}\n',
          'dup.ts': 'export function dup(): void {}\n'
        }
      });
      try {
        fx.db.upsertNode({ id: '{app}/Dup.ts#dup', type: 'function', name: 'dup', file_path: repoFile(fx, 'Dup.ts') });
        fx.db.upsertNode({ id: '{app}/dup.ts#dup', type: 'function', name: 'dup', file_path: repoFile(fx, 'dup.ts') });

        const dupes = fx.db.getDuplicateNodeIds();
        expect(dupes).toHaveLength(1);
        expect(dupes[0].ids.sort()).toEqual(['{app}/Dup.ts#dup', '{app}/dup.ts#dup'].sort());

        const report = runAnalysis(fx.db, fx.root, {});
        expect(report.duplicate_ids).toHaveLength(1);
        expect(report.summary.duplicate_ids).toBe(1);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('missing developer attribution', () => {
    it('flags history with no non-empty Developer: line, and not history with one', async () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'noattr.ts': 'export function noattr(): void {}\n',
          'attr.ts': 'export function attr(): void {}\n'
        }
      });
      try {
        // No DEVELOPER_NAME configured in the fixture's .env, and no reasoning.developer passed
        // -> formatReasoning writes "Developer: " (empty) -> flagged.
        await stageAndCommit(fx, [
          { node_id: 'noattr', file_path: repoFile(fx, 'noattr.ts'), code_snapshot: 'export function noattr(): void {}', name: 'noattr', type: 'function', description: 'No attribution.' },
        ]);
        // Explicit developer on the reasoning object -> not flagged.
        await stageAndCommit(fx, [
          { node_id: 'attr', file_path: repoFile(fx, 'attr.ts'), code_snapshot: 'export function attr(): void {}', name: 'attr', type: 'function', description: 'Has attribution.' },
        ], { what_changed: 'added attr', why: 'test', goal: 'test', developer: 'Alice' });

        const missing = fx.db.getHistoryMissingDeveloper();
        const missingNodeIds = missing.map(m => m.node_id);
        expect(missingNodeIds).toContain('{app}/noattr.ts#noattr');
        expect(missingNodeIds).not.toContain('{app}/attr.ts#attr');

        const report = runAnalysis(fx.db, fx.root, {});
        expect(report.missing_developer_attribution.map(m => m.node_id)).toContain('{app}/noattr.ts#noattr');
      } finally {
        fx.cleanup();
      }
    });

    it('also flags a legacy row whose reasoning text has no "Developer:" line at all (pre-dates the convention)', async () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: { 'legacy.ts': 'export function legacy(): void {}\n' }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'legacy', file_path: repoFile(fx, 'legacy.ts'), code_snapshot: 'export function legacy(): void {}', name: 'legacy', type: 'function', description: 'Legacy row.' },
        ]);
        const legacyId = '{app}/legacy.ts#legacy';
        const historyId = fx.db.getLatestHistory(legacyId)!.id;

        // Bypass updateHistory/formatReasoning entirely — free-form reasoning text with no
        // "Developer:" substring at all, simulating a row written before that convention existed.
        (fx.db as any).db.prepare('UPDATE history SET reasoning = ? WHERE id = ?')
          .run('Just some free-form notes, no structured fields at all.', historyId);

        expect(fx.db.getHistoryMissingDeveloper().map(m => m.node_id)).toContain(legacyId);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('empty code snapshots', () => {
    it('flags a history entry committed with code_snapshot: ""', async () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: { 'empty.ts': '' }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'empty', file_path: repoFile(fx, 'empty.ts'), code_snapshot: '', name: 'empty', type: 'function', description: 'Empty snapshot node.' },
        ]);
        const emptyId = '{app}/empty.ts#empty';
        expect(fx.db.getEmptyCodeSnapshots().map(e => e.node_id)).toContain(emptyId);

        const report = runAnalysis(fx.db, fx.root, {});
        expect(report.empty_code_snapshots.map(e => e.node_id)).toContain(emptyId);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('spurious nodes + pruneSpuriousNodes', () => {
    it('flags a node whose name is in SPURIOUS_NODE_NAMES, and pruneSpuriousNodes removes it', async () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: { 'result.ts': 'export function result(): void {}\n' }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'result', file_path: repoFile(fx, 'result.ts'), code_snapshot: 'export function result(): void {}', name: 'result', type: 'function', description: 'Spuriously named node.' },
        ]);
        const resultId = '{app}/result.ts#result';

        const { spurious } = fx.db.findSpuriousAndMissingFileNodes(fx.root);
        expect(spurious.map(s => s.id)).toContain(resultId);

        const report = runAnalysis(fx.db, fx.root, {});
        expect(report.spurious_nodes.map(s => s.id)).toContain(resultId);

        const pruneResult = fx.db.pruneSpuriousNodes(fx.root);
        expect(pruneResult.prunedCount).toBeGreaterThanOrEqual(1);
        expect(pruneResult.prunedNodes.some(n => n.includes(resultId))).toBe(true);

        // After pruning (soft-deprecate), it no longer surfaces as spurious (deprecated nodes
        // are excluded from findSpuriousAndMissingFileNodes's candidate query).
        const { spurious: spuriousAfter } = fx.db.findSpuriousAndMissingFileNodes(fx.root);
        expect(spuriousAfter.map(s => s.id)).not.toContain(resultId);
        expect(fx.db.getNode(resultId)?.deprecated).toBe(1);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('missing files', () => {
    it('flags a node whose underlying source file was deleted from disk', async () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: { 'vanish.ts': 'export function vanish(): void {}\n' }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'vanish', file_path: repoFile(fx, 'vanish.ts'), code_snapshot: 'export function vanish(): void {}', name: 'vanish', type: 'function', description: 'Will lose its file.' },
        ]);
        const vanishId = '{app}/vanish.ts#vanish';
        fs.unlinkSync(repoFile(fx, 'vanish.ts'));

        const { missingFile } = fx.db.findSpuriousAndMissingFileNodes(fx.root);
        expect(missingFile.map(m => m.id)).toContain(vanishId);

        const report = runAnalysis(fx.db, fx.root, {});
        expect(report.missing_files.map(m => m.id)).toContain(vanishId);
      } finally {
        fx.cleanup();
      }
    });

    it('flags a node whose file_path resolves to a DIRECTORY, not a file — fs.existsSync alone would say it "exists"', () => {
      // Regression test: a real production brain had a node whose file_path was literally its
      // repo root directory (not a source file) — plain existsSync() said "exists" so it never
      // surfaced as missing_files, and only crashed much later, when writeGraphToDisk tried to
      // write a JSON *file* at that same path and hit EISDIR (the directory was already there).
      const fx = makeFixture();
      try {
        const corruptId = '{app}/#corrupt';
        fx.db.upsertNode({ id: corruptId, type: 'function', name: 'corrupt', file_path: fx.repoDir });

        const { missingFile } = fx.db.findSpuriousAndMissingFileNodes(fx.root);
        expect(missingFile.map(m => m.id)).toContain(corruptId);

        const report = runAnalysis(fx.db, fx.root, { fix: true });
        expect(report.missing_files.map(m => m.id)).toContain(corruptId);
        expect(fx.db.getNode(corruptId)?.deprecated).toBe(1);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('stray .devmind output directories blocking sync', () => {
    it('reports a directory blocking a perfectly healthy node\'s graph/vectors JSON, and --fix removes it and rewrites the file — the case plain missing_files can\'t catch, since the node\'s own file_path is fine', () => {
      const fx = makeFixture();
      try {
        const id = '{app}/foo.ts#greet';
        fx.db.upsertNode({ id, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
        // Give it a connection so it isn't ALSO orphaned — this test is isolating the
        // stray-output-dir category specifically, not exercising orphaned_nodes.
        fx.db.addConnection(id, id);

        // upsertNode already wrote a real graph JSON *file* here as a side effect — replace it
        // with a directory to simulate the stray-cruft scenario.
        const graphTarget = path.join(fx.devmindPath, 'graph', 'app', 'foo.json');
        const vectorsTarget = path.join(fx.devmindPath, 'vectors', 'app', 'foo.json');
        fs.rmSync(graphTarget, { force: true });
        fs.rmSync(vectorsTarget, { force: true });
        fs.mkdirSync(graphTarget, { recursive: true });
        fs.mkdirSync(vectorsTarget, { recursive: true });

        // The node's own file_path is perfectly healthy — this is NOT a missing_files case.
        const dryReport = runAnalysis(fx.db, fx.root, {});
        expect(dryReport.missing_files).toEqual([]);
        expect(dryReport.stray_output_dirs.length).toBe(2);
        for (const entry of dryReport.stray_output_dirs) {
          expect(entry.target.toLowerCase()).toBe(entry.kind === 'graph' ? graphTarget.toLowerCase() : vectorsTarget.toLowerCase());
        }
        // Dry run must not touch disk.
        expect(fs.statSync(graphTarget).isDirectory()).toBe(true);

        const fixedReport = runAnalysis(fx.db, fx.root, { fix: true });
        expect(fixedReport.stray_output_dirs.length).toBe(2);

        // Blocker gone, and replaced by the real JSON file in one shot — no second sync needed.
        expect(fs.existsSync(graphTarget)).toBe(true);
        expect(fs.statSync(graphTarget).isFile()).toBe(true);
        const graphData = JSON.parse(fs.readFileSync(graphTarget, 'utf-8'));
        expect(graphData.nodes.map((n: { id: string }) => n.id)).toContain(id);

        // No vectors were ever written for this node, so writeVectorsToDisk has nothing to
        // recreate — but it must not leave the stray directory behind either.
        expect(fs.existsSync(vectorsTarget)).toBe(false);

        // Node itself was never touched — this bug isn't the node's fault.
        expect(fx.db.getNode(id)?.deprecated).toBe(0);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('--fix behavior', () => {
    it('fix:true deprecates orphaned/spurious/missing-file nodes and deletes dangling edges, but leaves healthy nodes and unresolved categories untouched', async () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'healthy.ts': 'export function healthy(): void {}\n',
          'orphan.ts': 'export function orphan(): void {}\n',
          'req.ts': 'export function req(): void {}\n', // spurious name
          'gone.ts': 'export function gone(): void {}\n'
        }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'healthy', file_path: repoFile(fx, 'healthy.ts'), code_snapshot: 'export function healthy(): void {}', name: 'healthy', type: 'function', description: 'Healthy, connected node.' },
          { node_id: 'orphan', file_path: repoFile(fx, 'orphan.ts'), code_snapshot: 'export function orphan(): void {}', name: 'orphan', type: 'function', description: 'Orphaned node.' },
          { node_id: 'req', file_path: repoFile(fx, 'req.ts'), code_snapshot: 'export function req(): void {}', name: 'req', type: 'function', description: 'Spurious-named node.' },
          { node_id: 'gone', file_path: repoFile(fx, 'gone.ts'), code_snapshot: 'export function gone(): void {}', name: 'gone', type: 'function', description: 'File will be deleted.' },
        ]);
        const healthyId = '{app}/healthy.ts#healthy';
        const orphanId = '{app}/orphan.ts#orphan';
        const reqId = '{app}/req.ts#req';
        const goneId = '{app}/gone.ts#gone';

        fx.db.addConnection(healthyId, orphanId); // gives healthy+orphan an edge each; keep orphan truly "orphan" by removing again below
        fx.db.removeConnection(healthyId, orphanId);
        fx.db.addConnection(healthyId, reqId); // healthy stays connected (not orphaned); req still spurious regardless of edges
        fs.unlinkSync(repoFile(fx, 'gone.ts'));
        fx.db.addConnection(healthyId, '{app}/nonexistent.ts#nope'); // dangling edge

        // fix:false (default) — report only, no mutation.
        const dryReport = runAnalysis(fx.db, fx.root, { fix: false });
        expect(dryReport.fixed).toBe(false);
        expect(dryReport.orphaned_nodes.map(n => n.id)).toContain(orphanId);
        expect(dryReport.spurious_nodes.map(n => n.id)).toContain(reqId);
        expect(dryReport.missing_files.map(n => n.id)).toContain(goneId);
        expect(dryReport.dangling_edges.length).toBeGreaterThanOrEqual(1);
        expect(fx.db.getNode(orphanId)?.deprecated).toBe(0);
        expect(fx.db.getNode(reqId)?.deprecated).toBe(0);
        expect(fx.db.getNode(goneId)?.deprecated).toBe(0);
        expect(fx.db.getDanglingEdges().length).toBeGreaterThanOrEqual(1);

        // fix:true — applies only the documented safe fixes.
        const fixReport = runAnalysis(fx.db, fx.root, { fix: true });
        expect(fixReport.fixed).toBe(true);
        expect(fx.db.getNode(orphanId)?.deprecated).toBe(1);
        expect(fx.db.getNode(reqId)?.deprecated).toBe(1);
        expect(fx.db.getNode(goneId)?.deprecated).toBe(1);
        expect(fx.db.getDanglingEdges()).toEqual([]);

        // Healthy node untouched.
        expect(fx.db.getNode(healthyId)?.deprecated).toBe(0);

        // last_analysis_at system_meta gets stamped only on a fix run.
        expect(fx.db.getSystemMeta('last_analysis_at')).toBeTruthy();
      } finally {
        fx.cleanup();
      }
    });

    it('fix:false (or omitted) never sets last_analysis_at', async () => {
      const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'x.ts': 'export function x(): void {}\n' } });
      try {
        await stageAndCommit(fx, [
          { node_id: 'x', file_path: repoFile(fx, 'x.ts'), code_snapshot: 'export function x(): void {}', name: 'x', type: 'function', description: 'X.' },
        ]);
        runAnalysis(fx.db, fx.root, {});
        expect(fx.db.getSystemMeta('last_analysis_at')).toBeNull();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('git-based checks: renamed and untracked files', () => {
    let fx: Fixture;

    beforeEach(() => {
      fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'original.ts': 'export function original(): void {}\n' } });
    });

    afterEach(() => {
      fx.cleanup();
    });

    it('detects a git-renamed file and an untracked (node-less) changed file since the lookback window', async () => {
      initGitRepo(fx.repoDir);
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m init');

      await stageAndCommit(fx, [
        { node_id: 'original', file_path: repoFile(fx, 'original.ts'), code_snapshot: 'export function original(): void {}', name: 'original', type: 'function', description: 'Original node.' },
      ]);

      // Rename via git mv, and add a brand-new file that never became a graph node.
      git(fx.repoDir, 'mv original.ts renamed.ts');
      fs.writeFileSync(path.join(fx.repoDir, 'brand-new.ts'), 'export function untracked(): void {}\n');
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m "rename and add"');

      const report = runAnalysis(fx.db, fx.root, {});

      expect(report.renamed_files).toEqual(
        expect.arrayContaining([expect.objectContaining({ repo: 'app', from: 'original.ts', to: 'renamed.ts' })])
      );
      expect(report.untracked_files).toEqual(
        expect.arrayContaining([expect.objectContaining({ repo: 'app', file: 'brand-new.ts' })])
      );
    });

    it('a changed non-indexable file is skipped (not reported as untracked), and a node with a falsy file_path is tolerated', async () => {
      initGitRepo(fx.repoDir);
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m init');

      await stageAndCommit(fx, [
        { node_id: 'original', file_path: repoFile(fx, 'original.ts'), code_snapshot: 'export function original(): void {}', name: 'original', type: 'function', description: 'Original node.' },
      ]);
      // Directly force an empty file_path via raw SQL (upsertNode/schema both require a non-empty
      // string, so this is the only way to reach the `(n.file_path || '')` fallback branch in the
      // knownFiles-building flatMap — a defensive fallback for legacy/malformed rows).
      (fx.db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } })
        .db.prepare('UPDATE nodes SET file_path = ? WHERE id = ?').run('', '{app}/original.ts#original');

      // A changed file whose extension isn't in INDEXABLE_EXTENSIONS — hits the loop's `continue`
      // rather than being reported as untracked.
      fs.writeFileSync(path.join(fx.repoDir, 'notes.md'), '# just notes\n');
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m "add non-indexable file"');

      const report = runAnalysis(fx.db, fx.root, {});
      expect(report.untracked_files.some(u => u.file === 'notes.md')).toBe(false);
    });

    it('with no git repo present, renamed_files/untracked_files are simply empty (graceful no-op)', () => {
      // fx.repoDir was never `git init`-ed here — getRenamedFilesSince/getChangedFilesSince
      // swallow the "not a git repo" failure and return [].
      const report = runAnalysis(fx.db, fx.root, {});
      expect(report.renamed_files).toEqual([]);
      expect(report.untracked_files).toEqual([]);
    });

    // migrateRename matches affected nodes via a raw `path.resolve(p) === oldAbs` comparison
    // (no drive-letter canonicalization — see the "Canonicalized on the way in" comment on the
    // untracked-files loop above, which documents this exact bug class was fixed there but NOT
    // in migrateRename). upsertNode, meanwhile, ALWAYS lowercases the Windows drive letter via
    // canonicalizePath. So on a machine whose temp dir starts with an uppercase drive letter
    // (as this sandbox's does), a node created the normal way (stageAndCommit -> upsertNode)
    // never matches migrateRename's raw oldAbs, and the affected-node loop never runs. To
    // exercise that loop for real, these tests force the node's stored file_path to the exact
    // raw (uncanonicalized) path migrateRename itself computes — a real-world equivalent of a
    // node whose file_path was written by a case-preserving path (e.g. data from before
    // canonicalizePath existed), which is exactly the scenario this matching logic exists for.
    function forceRawFilePath(fx: Fixture, nodeId: string, rawAbsPath: string) {
      (fx.db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } })
        .db.prepare('UPDATE nodes SET file_path = ? WHERE id = ?').run(rawAbsPath, nodeId);
    }

    it('fix:true migrates a renamed node onto the new path via migrateRename, cascading its id', async () => {
      // "original" must have a real edge so it's NOT orphaned — otherwise fix:true's own
      // orphaned-node deprecation pass (which runs BEFORE migrateRename, over the SAME
      // db.listNodes() migrateRename's affected-filter reads) deprecates it first, and a
      // deprecated node is invisible to that filter — masking the rename path entirely.
      // The fixture's beforeEach wrote a bare original.ts; overwrite it (before the init commit,
      // so content is unchanged across the later rename commit — same pattern the passing
      // "detects a git-renamed file" test above uses) with a real cross-file call so the AST
      // resolver actually creates the edge to helper.
      fs.writeFileSync(repoFile(fx, 'helper.ts'), 'export function helper(): void {}\n');
      const originalSrc = "import { helper } from './helper';\n\nexport function original(): void {\n  helper();\n}\n";
      fs.writeFileSync(repoFile(fx, 'original.ts'), originalSrc);

      initGitRepo(fx.repoDir);
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m init');

      await stageAndCommit(fx, [
        { node_id: 'helper', file_path: repoFile(fx, 'helper.ts'), code_snapshot: 'export function helper(): void {}', name: 'helper', type: 'function', description: 'Helper callee.' },
        { node_id: 'original', file_path: repoFile(fx, 'original.ts'), code_snapshot: "export function original(): void {\n  helper();\n}", name: 'original', type: 'function', description: 'Calls helper so it is never orphaned.' },
      ]);
      const oldId = '{app}/original.ts#original';
      const newId = '{app}/renamed.ts#original';
      expect(fx.db.getConnections(oldId).uses.map(c => c.id)).toContain('{app}/helper.ts#helper');
      forceRawFilePath(fx, oldId, path.resolve(fx.repoDir, 'original.ts'));

      git(fx.repoDir, 'mv original.ts renamed.ts');
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m rename');

      const report = runAnalysis(fx.db, fx.root, { fix: true });
      expect(report.fixed).toBe(true);
      const renamedEntry = report.renamed_files.find(r => r.from === 'original.ts' && r.to === 'renamed.ts');
      expect(renamedEntry).toBeTruthy();
      expect(renamedEntry!.migrated).toBe(true);

      expect(fx.db.getNode(oldId)).toBeNull();
      const migratedNode = fx.db.getNode(newId);
      expect(migratedNode).toBeTruthy();
      expect(migratedNode!.file_path).toBe(path.resolve(fx.repoDir, 'renamed.ts'));
    });

    it('migrateRename reports migrated:false (and leaves the node under its old id) when the target id already exists', async () => {
      // Same non-orphaned requirement as above, so migrateRename's loop actually runs and
      // reaches the INSERT collision rather than finding zero affected nodes.
      fs.writeFileSync(repoFile(fx, 'helper.ts'), 'export function helper(): void {}\n');
      fs.writeFileSync(repoFile(fx, 'original.ts'), "import { helper } from './helper';\n\nexport function original(): void {\n  helper();\n}\n");

      initGitRepo(fx.repoDir);
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m init');

      await stageAndCommit(fx, [
        { node_id: 'helper', file_path: repoFile(fx, 'helper.ts'), code_snapshot: 'export function helper(): void {}', name: 'helper', type: 'function', description: 'Helper callee.' },
        { node_id: 'original', file_path: repoFile(fx, 'original.ts'), code_snapshot: "export function original(): void {\n  helper();\n}", name: 'original', type: 'function', description: 'Calls helper so it is never orphaned.' },
      ]);
      const oldId = '{app}/original.ts#original';
      forceRawFilePath(fx, oldId, path.resolve(fx.repoDir, 'original.ts'));

      // Pre-create a conflicting node at the id migrateRename would try to INSERT — the
      // rename's INSERT then throws a duplicate-PK error, hit by migrateRename's own catch.
      const collidingId = '{app}/renamed.ts#original';
      fx.db.upsertNode({ id: collidingId, type: 'function', name: 'original', file_path: repoFile(fx, 'original.ts') });

      git(fx.repoDir, 'mv original.ts renamed.ts');
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m rename');

      const report = runAnalysis(fx.db, fx.root, { fix: true });
      const renamedEntry = report.renamed_files.find(r => r.from === 'original.ts' && r.to === 'renamed.ts');
      expect(renamedEntry).toBeTruthy();
      expect(renamedEntry!.migrated).toBe(false);

      // Untouched by the failed rename attempt — still under its original id.
      expect(fx.db.getNode('{app}/original.ts#original')).toBeTruthy();
    });

    it('migrateRename skips (continue) a node whose id happens not to contain the "from" path, leaving it unmigrated', async () => {
      initGitRepo(fx.repoDir);
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m init');

      // A node whose file_path resolves to original.ts's absolute path, but whose id string
      // doesn't literally contain "original.ts" — id.replace(from, to) is a no-op on it, so
      // migrateRename's `newId === node.id` guard skips it via `continue` rather than migrating.
      // Given a dangling outgoing edge (rather than none) so it isn't orphaned — see the
      // "must have a real edge" comment on the earlier tests for why that matters here too.
      const weirdId = '{app}/unrelated-name#thing';
      fx.db.upsertNode({ id: weirdId, type: 'function', name: 'thing', file_path: repoFile(fx, 'original.ts') });
      fx.db.addConnection(weirdId, '{app}/dummy.ts#dummy');
      forceRawFilePath(fx, weirdId, path.resolve(fx.repoDir, 'original.ts'));

      git(fx.repoDir, 'mv original.ts renamed.ts');
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m rename');

      const report = runAnalysis(fx.db, fx.root, { fix: true });
      const renamedEntry = report.renamed_files.find(r => r.from === 'original.ts' && r.to === 'renamed.ts');
      expect(renamedEntry).toBeTruthy();
      // The only affected node's id was unchanged by the replace -> `continue` -> nothing migrated.
      expect(renamedEntry!.migrated).toBe(false);
      expect(fx.db.getNode(weirdId)).toBeTruthy();
    });

    it('migrateRename bails out (migrated:false) when the repo path fails to re-resolve during the fix pass', async () => {
      // migrateRename re-resolves the repo path itself rather than reusing the one already
      // validated by the detection loop above. Simulate that second resolution failing (e.g. a
      // config/env change mid-run) by making resolveRepoPath succeed on its first call (the
      // detection loop, so the rename is still detected) and return null on every call after
      // (migrateRename's own lookup), hitting its `if (!repoPath) return false;` guard.
      // Set up the repo/commit/node/rename entirely BEFORE installing the spy — staging a change
      // (stageAndCommit -> toRepoRelativePath) also calls resolveRepoPath internally, and those
      // setup-time calls must resolve for real or the fixture itself would be broken.
      initGitRepo(fx.repoDir);
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m init');

      await stageAndCommit(fx, [
        { node_id: 'original', file_path: repoFile(fx, 'original.ts'), code_snapshot: 'export function original(): void {}', name: 'original', type: 'function', description: 'Original node.' },
      ]);

      git(fx.repoDir, 'mv original.ts renamed.ts');
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m rename');

      const real = configModule.resolveRepoPath;
      let calls = 0;
      const spy = jest.spyOn(configModule, 'resolveRepoPath').mockImplementation((...args) => {
        calls++;
        return calls === 1 ? real(...args) : null;
      });
      try {
        const report = runAnalysis(fx.db, fx.root, { fix: true });
        const renamedEntry = report.renamed_files.find(r => r.from === 'original.ts' && r.to === 'renamed.ts');
        expect(renamedEntry).toBeTruthy();
        expect(renamedEntry!.migrated).toBe(false);
        expect(fx.db.getNode('{app}/original.ts#original')).toBeTruthy();
      } finally {
        spy.mockRestore();
      }
    });

    it('migrateRename tolerates a node with a falsy file_path when scanning for affected nodes', async () => {
      // Same falsy-file_path fallback as the untracked-files loop above (`n.file_path || ''`),
      // but this is migrateRename's OWN separate `db.listNodes().filter(...)` call site — a
      // distinct branch in the instrumented source. Force one via raw SQL (schema requires
      // file_path NOT NULL, so upsertNode can never write an empty one) and give it a real edge
      // so it isn't deprecated as orphaned before migrateRename's filter ever sees it.
      fs.writeFileSync(repoFile(fx, 'dummy.ts'), 'export function dummy(): void {}\n');
      initGitRepo(fx.repoDir);
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m init');

      await stageAndCommit(fx, [
        { node_id: 'dummy', file_path: repoFile(fx, 'dummy.ts'), code_snapshot: 'export function dummy(): void {}', name: 'dummy', type: 'function', description: 'Unrelated node with no real file_path.' },
      ]);
      fx.db.addConnection('{app}/dummy.ts#dummy', '{app}/dummy.ts#dummy2'); // dangling edge keeps it out of orphaned_nodes
      (fx.db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } })
        .db.prepare("UPDATE nodes SET file_path = '' WHERE id = ?").run('{app}/dummy.ts#dummy');

      git(fx.repoDir, 'mv original.ts renamed.ts');
      git(fx.repoDir, 'add -A');
      git(fx.repoDir, 'commit -q -m rename');

      expect(() => runAnalysis(fx.db, fx.root, { fix: true })).not.toThrow();
    });
  });
});
