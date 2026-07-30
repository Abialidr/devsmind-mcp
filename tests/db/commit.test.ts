import { makeFixture, stageAndCommit, repoFile } from '../helpers/fixture';
import * as embedderModule from '../../src/db/embedder';

const FOO_SNIPPET = 'export function greet(name: string): string {\n  return format(name);\n}';
const BAR_SNIPPET = 'export function format(s: string): string {\n  return "hi " + s;\n}';

describe('commitStagedChanges — two-pass commit pipeline (src/db/staging.ts)', () => {
  it('resolves edges regardless of which order the staged entries array lists source/target in', async () => {
    const fx = makeFixture({
      skipDefaultFiles: true,
      extraFiles: {
        // Pair 1: caller listed BEFORE callee in the array (the "natural" forward-reference case).
        'c.ts': "import { d } from './d';\n\nexport function c(): number {\n  return d();\n}\n",
        'd.ts': 'export function d(): number {\n  return 1;\n}\n',
        // Pair 2: caller listed AFTER callee in the array (fully reversed).
        'e.ts': "import { f } from './f';\n\nexport function e(): number {\n  return f();\n}\n",
        'f.ts': 'export function f(): number {\n  return 2;\n}\n'
      }
    });
    try {
      // Pair 1: [caller, callee] — the array order a naive single-pass indexer would need to get right.
      await stageAndCommit(fx, [
        { node_id: 'c', file_path: repoFile(fx, 'c.ts'), code_snapshot: 'export function c(): number {\n  return d();\n}', name: 'c', type: 'function' },
        { node_id: 'd', file_path: repoFile(fx, 'd.ts'), code_snapshot: 'export function d(): number {\n  return 1;\n}', name: 'd', type: 'function' }
      ]);
      expect(fx.db.getConnections('{app}/c.ts#c').uses.map(n => n.id)).toContain('{app}/d.ts#d');

      // Pair 2: [callee, caller] — reversed. If Pass 1 (upsert all nodes) didn't run to completion
      // before Pass 2 (edge resolution) started, this order would leave the edge unresolved.
      await stageAndCommit(fx, [
        { node_id: 'f', file_path: repoFile(fx, 'f.ts'), code_snapshot: 'export function f(): number {\n  return 2;\n}', name: 'f', type: 'function' },
        { node_id: 'e', file_path: repoFile(fx, 'e.ts'), code_snapshot: 'export function e(): number {\n  return f();\n}', name: 'e', type: 'function' }
      ]);
      expect(fx.db.getConnections('{app}/e.ts#e').uses.map(n => n.id)).toContain('{app}/f.ts#f');
    } finally {
      fx.cleanup();
    }
  });

  it('resolves a multi-file edge and it shows up via getConnections from both ends', async () => {
    const fx = makeFixture();
    try {
      const summary = await stageAndCommit(fx, [
        { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
        { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
      ]);
      expect(summary.nodes).toBe(2);
      expect(summary.edges_added).toBeGreaterThanOrEqual(1);

      const greetId = '{app}/foo.ts#greet';
      const formatId = '{app}/bar.ts#format';
      expect(fx.db.getConnections(greetId).uses.map(n => n.id)).toContain(formatId);
      expect(fx.db.getConnections(formatId).usedBy.map(n => n.id)).toContain(greetId);
    } finally {
      fx.cleanup();
    }
  });

  it('auto-creates ("fills") a node for a real symbol referenced by staged code but not itself staged', async () => {
    const fx = makeFixture({
      skipDefaultFiles: true,
      extraFiles: {
        'helper.ts': 'export function helper(): number {\n  return 42;\n}\n',
        'caller.ts': "import { helper } from './helper';\n\nexport function caller(): number {\n  return helper();\n}\n"
      }
    });
    try {
      // helper.ts exists on disk and is a real, locatable declaration, but only "caller" is staged —
      // helper was never staged/committed, so no node exists for it yet before this commit.
      expect(fx.db.getNode('{app}/helper.ts#helper')).toBeNull();

      const summary = await stageAndCommit(fx, [
        { node_id: 'caller', file_path: repoFile(fx, 'caller.ts'), code_snapshot: 'export function caller(): number {\n  return helper();\n}', name: 'caller', type: 'function' }
      ]);

      expect(summary.missing_filled).toBeGreaterThan(0);

      const helperNode = fx.db.getNode('{app}/helper.ts#helper');
      expect(helperNode).toBeTruthy();
      expect(helperNode!.name).toBe('helper');

      // And the edge from the staged node to the auto-filled one resolves too.
      expect(fx.db.getConnections('{app}/caller.ts#caller').uses.map(n => n.id)).toContain('{app}/helper.ts#helper');
    } finally {
      fx.cleanup();
    }
  });

  it('applies explicit `connections` on a staged entry, on top of whatever AST resolution finds', async () => {
    const fx = makeFixture({
      skipDefaultFiles: true,
      extraFiles: {
        'a.ts': 'export function a(): void {}\n',
        'b.ts': 'export function b(): void {}\n',
        'c.ts': 'export function c(): void {}\n'
      }
    });
    try {
      const summary = await stageAndCommit(fx, [
        { node_id: 'a', file_path: repoFile(fx, 'a.ts'), code_snapshot: 'export function a(): void {}', name: 'a', type: 'function' },
        { node_id: 'b', file_path: repoFile(fx, 'b.ts'), code_snapshot: 'export function b(): void {}', name: 'b', type: 'function' },
        {
          node_id: 'c',
          file_path: repoFile(fx, 'c.ts'),
          code_snapshot: 'export function c(): void {}',
          name: 'c',
          type: 'function',
          // No AST-visible call from c to a or b (the source has no such call) — these edges only
          // exist because they're explicitly declared here. One omits source_node_id (defaults to
          // this entry's own id); the other names a different source entirely.
          connections: [
            { target_node_id: '{app}/a.ts#a' },
            { source_node_id: '{app}/b.ts#b', target_node_id: '{app}/a.ts#a' }
          ]
        }
      ]);
      // edges_added counts AST-resolved edges + explicit ones, so it's at least the 2 explicit ones.
      expect(summary.edges_added).toBeGreaterThanOrEqual(2);
      expect(fx.db.getConnections('{app}/c.ts#c').uses.map(n => n.id)).toContain('{app}/a.ts#a');
      expect(fx.db.getConnections('{app}/b.ts#b').uses.map(n => n.id)).toContain('{app}/a.ts#a');
    } finally {
      fx.cleanup();
    }
  });

  it('resolveEntryId returns an already-qualified node_id (containing "#") unchanged, skipping the repo-relative-path derivation', async () => {
    const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'z.ts': 'export function z(): void {}\n' } });
    try {
      const summary = await stageAndCommit(fx, [
        { node_id: '{app}/z.ts#customQualifiedId', file_path: repoFile(fx, 'z.ts'), code_snapshot: 'export function z(): void {}', name: 'z', type: 'function' }
      ]);
      expect(summary.node_ids).toEqual(['{app}/z.ts#customQualifiedId']);
      expect(fx.db.getNode('{app}/z.ts#customQualifiedId')).toBeTruthy();
    } finally {
      fx.cleanup();
    }
  });

  it('derives name/type from a dotted node_id ("Class.method") when neither is supplied explicitly', async () => {
    const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'cls.ts': 'export class Widget {\n  render(): void {}\n}\n' } });
    try {
      const summary = await stageAndCommit(fx, [
        // No `name`/`type` at all — commitStagedChanges must derive name='render' (text after the
        // last '.') and type='method' (dotted id implies a method) from the node_id itself.
        { node_id: 'Widget.render', file_path: repoFile(fx, 'cls.ts'), code_snapshot: 'render(): void {}' }
      ]);
      const nodeId = summary.node_ids[0];
      expect(nodeId).toBe('{app}/cls.ts#Widget.render');
      const node = fx.db.getNode(nodeId)!;
      expect(node.name).toBe('render');
      expect(node.type).toBe('method');
    } finally {
      fx.cleanup();
    }
  });

  it('falls back to the raw node_id as both name and type "function" when it has no dot and neither is supplied', async () => {
    const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'plain.ts': 'export function plainThing(): void {}\n' } });
    try {
      // No `name`/`type`, and node_id has no '.' — the OTHER halves of the ternaries exercised by
      // the "Widget.render" test above: name falls back to the node_id itself (not split), and
      // type falls back to 'function' (not 'method').
      const summary = await stageAndCommit(fx, [
        { node_id: 'plainThing', file_path: repoFile(fx, 'plain.ts'), code_snapshot: 'export function plainThing(): void {}' }
      ]);
      const nodeId = summary.node_ids[0];
      const node = fx.db.getNode(nodeId)!;
      expect(node.name).toBe('plainThing');
      expect(node.type).toBe('function');
    } finally {
      fx.cleanup();
    }
  });

  it('is idempotent: committing the exact same entries twice leaves the same node/edge counts', async () => {
    const fx = makeFixture();
    try {
      const entries = [
        { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
        { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
      ];

      await stageAndCommit(fx, entries);
      const nodesAfterFirst = fx.db.listNodes().length;
      const edgesAfterFirst = fx.db.getAllConnections().length;
      expect(nodesAfterFirst).toBe(2);
      expect(edgesAfterFirst).toBe(1);

      // Re-run the SAME entries array through commitStagedChanges again.
      await stageAndCommit(fx, entries);
      const nodesAfterSecond = fx.db.listNodes().length;
      const edgesAfterSecond = fx.db.getAllConnections().length;

      expect(nodesAfterSecond).toBe(nodesAfterFirst);
      expect(edgesAfterSecond).toBe(edgesAfterFirst);

      // The graph shape (which nodes point at which) is identical too, not just the counts.
      expect(fx.db.getConnections('{app}/foo.ts#greet').uses.map(n => n.id)).toEqual(['{app}/bar.ts#format']);
    } finally {
      fx.cleanup();
    }
  });

  it(
    'batch-embeds a staged description into a vector (or degrades gracefully if ONNX is unavailable)',
    async () => {
      const fx = makeFixture();
      try {
        const summary = await stageAndCommit(fx, [
          {
            node_id: 'greet',
            file_path: repoFile(fx, 'foo.ts'),
            code_snapshot: FOO_SNIPPET,
            name: 'greet',
            type: 'function',
            description: 'Returns a greeting string built from the given name.'
          }
        ]);
        expect(summary.nodes).toBe(1);

        const nodeId = '{app}/foo.ts#greet';
        // upsertNode's own description write always happens regardless of the embedding outcome.
        expect(fx.db.getNode(nodeId)?.description).toBe('Returns a greeting string built from the given name.');

        // The vector write is best-effort: commitStagedChanges must not throw even if the optional
        // ONNX dependency is unavailable in some environment — embedTextsInt8 degrades to null there.
        const vector = fx.db.getNodeVector(nodeId);
        if (vector) {
          expect(vector.vector).toBeInstanceOf(Int8Array);
          expect(vector.vector.length).toBe(vector.dim);
          expect(vector.descriptionHash).toBeTruthy();
        } else {
          // onnxruntime-node/vendored model unavailable or embedding skipped in this environment —
          // acceptable graceful degradation, not a failure of the commit pipeline itself.
          console.warn('commit.test.ts: no vector was stored for the described node — embedding degraded gracefully.');
        }
      } finally {
        fx.cleanup();
      }
    },
    30000
  );

  it('stores a vector for every staged description when the embedder is available (mocked, so this runs regardless of ONNX availability)', async () => {
    const fx = makeFixture({
      skipDefaultFiles: true,
      extraFiles: {
        'a.ts': 'export function a(): void {}\n',
        'b.ts': 'export function b(): void {}\n'
      }
    });
    // The real embedTextsInt8 degrades to null whenever onnxruntime-node/the vendored model isn't
    // available in this environment (see the test above) — that leaves commitStagedChanges'
    // `if (vectors) { for (...) db.upsertNodeVector(...) }` loop unexercised. Mock a real-shaped
    // batch result so that loop runs for real, independent of the environment's ONNX support.
    const spy = jest.spyOn(embedderModule, 'embedTextsInt8').mockImplementation(async (texts: string[]) =>
      texts.map((_, i) => new Int8Array(384).fill(i + 1))
    );
    try {
      const summary = await stageAndCommit(fx, [
        { node_id: 'a', file_path: repoFile(fx, 'a.ts'), code_snapshot: 'export function a(): void {}', name: 'a', type: 'function', description: 'First described node.' },
        { node_id: 'b', file_path: repoFile(fx, 'b.ts'), code_snapshot: 'export function b(): void {}', name: 'b', type: 'function', description: 'Second described node.' }
      ]);
      expect(summary.nodes).toBe(2);
      expect(spy).toHaveBeenCalledWith(['First described node.', 'Second described node.']);

      const vecA = fx.db.getNodeVector('{app}/a.ts#a');
      const vecB = fx.db.getNodeVector('{app}/b.ts#b');
      expect(vecA).toBeTruthy();
      expect(vecB).toBeTruthy();
      expect(vecA!.vector).toEqual(new Int8Array(384).fill(1));
      expect(vecB!.vector).toEqual(new Int8Array(384).fill(2));
    } finally {
      spy.mockRestore();
      fx.cleanup();
    }
  });
});
