import { makeFixture, repoFile, Fixture } from '../helpers/fixture';
import { extractFilesIntoGraph, pendingDescriptionNodes, resolveEdgesIncrementally } from '../../src/db/index-build';
import { createScratchpad } from '../../src/db/indexer';

describe('extractFilesIntoGraph', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  it('extracts every candidate from each file, writing nodes with no code_before (index snapshot, not an edit)', () => {
    const result = extractFilesIntoGraph(fx.db, [repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts')]);

    expect(result.filesExtracted).toEqual([repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts')]);
    expect(result.cursor).toBe(repoFile(fx, 'bar.ts'));
    expect(result.nodesCreated).toBe(2);
    expect(result.nodes.map(n => n.node_id).sort()).toEqual(['{app}/bar.ts#format', '{app}/foo.ts#greet'].sort());

    const greet = result.nodes.find(n => n.node_id === '{app}/foo.ts#greet')!;
    expect(greet.name).toBe('greet');
    expect(greet.type).toBe('function');
    expect(greet.exported).toBe(true);
    expect(greet.code).toContain('return format(name)');
    expect(greet.code_truncated).toBe(false);
    expect(typeof greet.start_line).toBe('number');
    expect(typeof greet.end_line).toBe('number');

    // Written straight to the graph, not staged.
    const node = fx.db.getNode('{app}/foo.ts#greet');
    expect(node).not.toBeNull();
    const latest = fx.db.getLatestCode('{app}/foo.ts#greet');
    expect(latest?.code_snapshot).toContain('return format(name)');
    // No before-state recorded for an index snapshot.
    const history = (fx.db as any).getFullHistory('{app}/foo.ts#greet');
    expect(history[0].edits).toEqual([]);
  });

  it('captures each file\'s own imports once, keyed by repo-relative path', () => {
    const result = extractFilesIntoGraph(fx.db, [repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts')]);
    expect(result.fileImports['{app}/foo.ts']).toEqual(['./bar']);
    // bar.ts has no imports, so it gets no entry at all rather than an empty array.
    expect(result.fileImports['{app}/bar.ts']).toBeUndefined();
  });

  it('a file with zero candidates still counts as fully processed (cursor advances past it)', () => {
    fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'empty.ts': '// nothing declared here\n' } });
    const result = extractFilesIntoGraph(fx.db, [repoFile(fx, 'empty.ts')]);
    expect(result.filesExtracted).toEqual([repoFile(fx, 'empty.ts')]);
    expect(result.cursor).toBe(repoFile(fx, 'empty.ts'));
    expect(result.nodes).toEqual([]);
    expect(result.fileImports).toEqual({});
  });

  it('a non-parseable file (no AST support) yields no candidates but is still marked processed', () => {
    fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'script.py': 'def helper():\n    pass\n' } });
    const result = extractFilesIntoGraph(fx.db, [repoFile(fx, 'script.py')]);
    expect(result.filesExtracted).toEqual([repoFile(fx, 'script.py')]);
    expect(result.nodesCreated).toBe(0);
  });

  it('always fully processes at least one file even when a budget is already exhausted', () => {
    const result = extractFilesIntoGraph(fx.db, [repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts')], { nodeBudget: 0 });
    expect(result.filesExtracted).toEqual([repoFile(fx, 'foo.ts')]);
    expect(result.nodes.length).toBe(1);
  });

  it('stops after the file that trips the file budget', () => {
    fx = makeFixture({ extraFiles: { 'baz.ts': 'export function baz(): void {}\n' } });
    const result = extractFilesIntoGraph(fx.db, [repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts'), repoFile(fx, 'baz.ts')], { fileBudget: 2 });
    expect(result.filesExtracted).toEqual([repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts')]);
  });

  it('truncates a node\'s code once it exceeds codeCharsPerNode', () => {
    const result = extractFilesIntoGraph(fx.db, [repoFile(fx, 'foo.ts')], { codeCharsPerNode: 5 });
    const greet = result.nodes.find(n => n.node_id === '{app}/foo.ts#greet')!;
    expect(greet.code_truncated).toBe(true);
    expect(greet.code.length).toBe(5);
  });

  it('returns an empty result for an empty file list', () => {
    const result = extractFilesIntoGraph(fx.db, []);
    expect(result).toEqual({ filesExtracted: [], nodesCreated: 0, nodes: [], fileImports: {}, cursor: null });
  });
});

describe('pendingDescriptionNodes', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  it('lists undescribed, non-deprecated nodes with their current code', () => {
    extractFilesIntoGraph(fx.db, [repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts')]);
    const pending = pendingDescriptionNodes(fx.db, 10);
    expect(pending.map(n => n.node_id).sort()).toEqual(['{app}/bar.ts#format', '{app}/foo.ts#greet'].sort());
    const greet = pending.find(n => n.node_id === '{app}/foo.ts#greet')!;
    expect(greet.code).toContain('return format(name)');
    expect(greet.code_truncated).toBe(false);
    // Re-derived from the DB, not from a fresh AST pass — line/exported info isn't known here.
    expect(greet.start_line).toBeUndefined();
    expect(greet.exported).toBeUndefined();
  });

  it('excludes a node that already has a description', () => {
    extractFilesIntoGraph(fx.db, [repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts')]);
    fx.db.upsertNode({ id: '{app}/foo.ts#greet', type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts'), description: 'Greets someone by name.' });
    const pending = pendingDescriptionNodes(fx.db, 10);
    expect(pending.map(n => n.node_id)).toEqual(['{app}/bar.ts#format']);
  });

  it('excludes a deprecated node', () => {
    extractFilesIntoGraph(fx.db, [repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts')]);
    fx.db.deprecateNode('{app}/foo.ts#greet');
    const pending = pendingDescriptionNodes(fx.db, 10);
    expect(pending.map(n => n.node_id)).toEqual(['{app}/bar.ts#format']);
  });

  it('respects the limit', () => {
    extractFilesIntoGraph(fx.db, [repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts')]);
    const pending = pendingDescriptionNodes(fx.db, 1);
    expect(pending.length).toBe(1);
  });

  it('truncates code over the shared char budget', () => {
    const longBody = 'export function big(): string {\n' + '  const x = 1;\n'.repeat(200) + '  return "x";\n}\n';
    fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'big.ts': longBody } });
    extractFilesIntoGraph(fx.db, [repoFile(fx, 'big.ts')]);
    const pending = pendingDescriptionNodes(fx.db, 10);
    expect(pending[0].code_truncated).toBe(true);
    expect(pending[0].code.length).toBe(1200);
  });

  it('a node with no code snapshot at all reports empty, non-truncated code', () => {
    fx.db.upsertNode({ id: 'app/manual#Thing', type: 'function', name: 'Thing', file_path: repoFile(fx, 'foo.ts') });
    const pending = pendingDescriptionNodes(fx.db, 10);
    const manual = pending.find(n => n.node_id === 'app/manual#Thing')!;
    expect(manual.code).toBe('');
    expect(manual.code_truncated).toBe(false);
  });
});

describe('resolveEdgesIncrementally', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  it('resolves a real cross-file edge in one pass and transitions the scratchpad to phase 2', () => {
    extractFilesIntoGraph(fx.db, [repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts')]);
    const pad = createScratchpad(fx.devmindPath, 2);
    expect(pad.phase).toBe(1);

    // opts omitted entirely — exercises the default-parameter path (25s default time budget),
    // not just the explicit `{}` every other test in this suite passes.
    const result = resolveEdgesIncrementally(fx.db, fx.devmindPath, pad);

    expect(result.done).toBe(true);
    expect(result.nodesTotal).toBe(2);
    expect(result.nodesDone).toBe(2);
    expect(result.edgesAdded).toBeGreaterThan(0);
    expect(pad.phase).toBe(2);

    const conns = fx.db.getConnections('{app}/foo.ts#greet');
    expect(conns.uses.map(n => n.id)).toContain('{app}/bar.ts#format');
  });

  it('a negative time budget resolves nothing and reports done:false, without running missing-node fill', () => {
    extractFilesIntoGraph(fx.db, [repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts')]);
    const pad = createScratchpad(fx.devmindPath, 2);

    const result = resolveEdgesIncrementally(fx.db, fx.devmindPath, pad, { timeBudgetMs: -1_000_000 });

    expect(result.done).toBe(false);
    expect(result.nodesDone).toBe(0);
    expect(result.missingFilled).toBe(0);
    expect(pad.phase).toBe(2); // still transitions, even though no node was processed
  });

  it('resumes from nodes_done on a later call and finishes', () => {
    extractFilesIntoGraph(fx.db, [repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts')]);
    const pad = createScratchpad(fx.devmindPath, 2);

    resolveEdgesIncrementally(fx.db, fx.devmindPath, pad, { timeBudgetMs: -1_000_000 });
    expect(pad.nodes_done).toBe(0);

    const finished = resolveEdgesIncrementally(fx.db, fx.devmindPath, pad, {});
    expect(finished.done).toBe(true);
    expect(finished.nodesDone).toBe(2);
  });

  it('extends nodes_total when more nodes exist on a later call against an already-phase-2 pad', () => {
    extractFilesIntoGraph(fx.db, [repoFile(fx, 'foo.ts'), repoFile(fx, 'bar.ts')]);
    const pad = createScratchpad(fx.devmindPath, 2);
    const first = resolveEdgesIncrementally(fx.db, fx.devmindPath, pad, {});
    expect(first.done).toBe(true);
    expect(pad.nodes_total).toBe(2);

    // Add a third node directly (simulating a second index_start batch landing more nodes).
    fx.db.upsertNode({ id: '{app}/baz.ts#baz', type: 'function', name: 'baz', file_path: repoFile(fx, 'foo.ts') });
    fx.db.updateHistory({ node_id: '{app}/baz.ts#baz', code_snapshot: 'export function baz(): void {}\n', reasoning: { what_changed: 'x', why: 'x', goal: 'x' } });

    const second = resolveEdgesIncrementally(fx.db, fx.devmindPath, pad, {});
    expect(second.nodesTotal).toBe(3);
    expect(second.nodesDone).toBe(3);
    expect(second.done).toBe(true);
  });

  it('auto-creates a used-but-unextracted node and reports it in missingFilled', () => {
    fx = makeFixture({
      skipDefaultFiles: true,
      extraFiles: {
        'caller.ts': `import { helper } from './helper';\n\nexport function callHelper(): string {\n  return helper();\n}\n`,
        'helper.ts': `export function helper(): string {\n  return 'hi';\n}\n`
      }
    });
    // Extract ONLY caller.ts — helper.ts is a real file with a real export that never got a node.
    extractFilesIntoGraph(fx.db, [repoFile(fx, 'caller.ts')]);
    expect(fx.db.getNode('{app}/helper.ts#helper')).toBeNull();

    const pad = createScratchpad(fx.devmindPath, 1);
    const result = resolveEdgesIncrementally(fx.db, fx.devmindPath, pad, {});

    expect(result.done).toBe(true);
    expect(result.missingFilled).toBe(1);
    expect(fx.db.getNode('{app}/helper.ts#helper')).not.toBeNull();
  });
});
