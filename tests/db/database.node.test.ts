import * as path from 'path';
import { makeFixture, stageAndCommit, repoFile } from '../helpers/fixture';
import { hashDescription } from '../../src/db/embedder';

const FOO_SNIPPET = 'export function greet(name: string): string {\n  return format(name);\n}';
const BAR_SNIPPET = 'export function format(s: string): string {\n  return "hi " + s;\n}';

describe('DevMindDatabase — node CRUD', () => {
  describe('upsertNode', () => {
    it('COALESCE: re-upserting without description/signature preserves the existing values', () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: { 'thing.ts': 'export function thing(): number {\n  return 1;\n}\n' }
      });
      try {
        const id = '{app}/thing.ts#thing';
        const filePath = repoFile(fx, 'thing.ts');

        fx.db.upsertNode({
          id,
          type: 'function',
          name: 'thing',
          file_path: filePath,
          description: 'Does a thing.',
          signature: 'function thing(): number'
        });
        let node = fx.db.getNode(id)!;
        expect(node.description).toBe('Does a thing.');
        expect(node.signature).toBe('function thing(): number');

        // Re-upsert WITHOUT description/signature — must not blank them out.
        fx.db.upsertNode({ id, type: 'function', name: 'thing', file_path: filePath });
        node = fx.db.getNode(id)!;
        expect(node.description).toBe('Does a thing.');
        expect(node.signature).toBe('function thing(): number');

        // An explicit new value DOES overwrite.
        fx.db.upsertNode({ id, type: 'function', name: 'thing', file_path: filePath, description: 'New desc.' });
        node = fx.db.getNode(id)!;
        expect(node.description).toBe('New desc.');
        expect(node.signature).toBe('function thing(): number'); // still preserved, no signature passed this time
      } finally {
        fx.cleanup();
      }
    });

    it('merges file_path when upserted twice with different paths for the same id (symbol spanning files)', () => {
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'a.ts': 'export function shared(): number {\n  return 1;\n}\n',
          'b.ts': 'export function shared(): number {\n  return 2;\n}\n'
        }
      });
      try {
        const id = '{app}/a.ts#shared';
        fx.db.upsertNode({ id, type: 'function', name: 'shared', file_path: repoFile(fx, 'a.ts') });
        fx.db.upsertNode({ id, type: 'function', name: 'shared', file_path: repoFile(fx, 'b.ts') });

        const node = fx.db.getNode(id)!;
        const paths = node.file_path.split(',').map(p => p.trim());
        expect(paths).toHaveLength(2);
        expect(paths.some(p => p.endsWith('a.ts'))).toBe(true);
        expect(paths.some(p => p.endsWith('b.ts'))).toBe(true);

        // Upserting the SAME path again must not duplicate it.
        fx.db.upsertNode({ id, type: 'function', name: 'shared', file_path: repoFile(fx, 'a.ts') });
        const node2 = fx.db.getNode(id)!;
        expect(node2.file_path.split(',').map(p => p.trim())).toHaveLength(2);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getNode', () => {
    it('resolves by exact id and by unique bare-name suffix', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
        ]);

        const exact = fx.db.getNode('{app}/foo.ts#greet');
        expect(exact?.id).toBe('{app}/foo.ts#greet');

        const bySuffix = fx.db.getNode('greet');
        expect(bySuffix?.id).toBe('{app}/foo.ts#greet');

        expect(fx.db.getNode('totally-nonexistent')).toBeNull();
      } finally {
        fx.cleanup();
      }
    });

    it('returns null for an ambiguous suffix match (two nodes share the same bare symbol name)', async () => {
      const fx = makeFixture({
        extraFiles: { 'dup.ts': 'export function greet(x: string): string {\n  return x;\n}\n' }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'greet', file_path: repoFile(fx, 'dup.ts'), code_snapshot: 'export function greet(x: string): string {\n  return x;\n}', name: 'greet', type: 'function' }
        ]);

        expect(fx.db.getNode('{app}/foo.ts#greet')).toBeTruthy();
        expect(fx.db.getNode('{app}/dup.ts#greet')).toBeTruthy();
        // Bare "greet" now matches two distinct nodes — ambiguous, so getNode refuses to guess.
        expect(fx.db.getNode('greet')).toBeNull();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('listNodes', () => {
    it('filters by type, file_path, and include_deprecated', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
        ]);

        expect(fx.db.listNodes({ type: 'function' }).map(n => n.id).sort()).toEqual(
          ['{app}/bar.ts#format', '{app}/foo.ts#greet']
        );
        expect(fx.db.listNodes({ type: 'class' })).toEqual([]);

        const byFile = fx.db.listNodes({ file_path: 'foo.ts' });
        expect(byFile.map(n => n.id)).toEqual(['{app}/foo.ts#greet']);

        fx.db.deprecateNode('{app}/foo.ts#greet');
        expect(fx.db.listNodes().map(n => n.id)).not.toContain('{app}/foo.ts#greet');
        expect(fx.db.listNodes({ include_deprecated: true }).map(n => n.id)).toContain('{app}/foo.ts#greet');
      } finally {
        fx.cleanup();
      }
    });

    it('returns every row when unpaged, and a stable page when limit/offset are given', async () => {
      // Paging has to stay OPT-IN at this layer: analyze.ts and edges.ts enumerate the whole graph
      // to resolve edges, and a default page size would silently give them a partial graph to
      // reason about — a far worse failure than a large response.
      const fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: Object.fromEntries(
          Array.from({ length: 6 }, (_, i) => [`m${i}.ts`, `export function fn${i}(): number {\n  return ${i};\n}\n`])
        )
      });
      try {
        await stageAndCommit(fx, Array.from({ length: 6 }, (_, i) => ({
          node_id: `fn${i}`,
          file_path: repoFile(fx, `m${i}.ts`),
          code_snapshot: `export function fn${i}(): number {\n  return ${i};\n}`,
          name: `fn${i}`,
          type: 'function'
        })));

        expect(fx.db.listNodes()).toHaveLength(6);
        expect(fx.db.countNodes()).toBe(6);
        expect(fx.db.countNodes({ type: 'class' })).toBe(0);

        const first = fx.db.listNodes({ limit: 4 });
        const second = fx.db.listNodes({ limit: 4, offset: 4 });
        expect(first).toHaveLength(4);
        expect(second).toHaveLength(2);
        // Ordered, so the two pages partition the set rather than overlapping by luck.
        expect(new Set([...first, ...second].map(n => n.id)).size).toBe(6);
        // And the order is repeatable.
        expect(fx.db.listNodes({ limit: 4 }).map(n => n.id)).toEqual(first.map(n => n.id));

        // A filtered count must describe the same rows the filtered page returns.
        expect(fx.db.countNodes({ file_path: 'm3.ts' })).toBe(fx.db.listNodes({ file_path: 'm3.ts' }).length);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('deprecateNode', () => {
    it('soft-deletes: drops connections on both ends, keeps history, node row remains flagged deprecated', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
        ]);
        const greetId = '{app}/foo.ts#greet';
        const formatId = '{app}/bar.ts#format';

        expect(fx.db.getConnections(greetId).uses.map(n => n.id)).toContain(formatId);
        expect(fx.db.getFullHistory(greetId)).toHaveLength(1);

        fx.db.deprecateNode(greetId);

        const node = fx.db.getNode(greetId);
        expect(node).toBeTruthy();
        expect(node!.deprecated).toBe(1);

        // deprecateNode's DELETE targets `source_node_id = ? OR target_node_id = ?` — i.e. it
        // drops the connection in EITHER direction, not just the node's own outgoing edges.
        expect(fx.db.getConnections(greetId).uses).toEqual([]);
        expect(fx.db.getConnections(formatId).usedBy).toEqual([]);

        // History survives the soft-delete.
        expect(fx.db.getFullHistory(greetId)).toHaveLength(1);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('renameNode', () => {
    it('cascades the id across connections, history, and vectors', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
        ]);
        const oldId = '{app}/foo.ts#greet';
        const newId = '{app}/foo.ts#greetRenamed';
        const formatId = '{app}/bar.ts#format';

        // Give it a vector directly (deterministic, no ONNX dependency) to verify rename carries it.
        fx.db.upsertNodeVector(oldId, new Int8Array([1, 2, 3, 4]), hashDescription('x'));
        expect(fx.db.getNodeVector(oldId)).toBeTruthy();

        fx.db.renameNode(oldId, newId, 'greetRenamed');

        expect(fx.db.getNode(oldId)).toBeNull();
        const renamed = fx.db.getNode(newId);
        expect(renamed).toBeTruthy();
        expect(renamed!.name).toBe('greetRenamed');

        // Edges moved.
        expect(fx.db.getConnections(newId).uses.map(n => n.id)).toContain(formatId);
        expect(fx.db.getConnections(formatId).usedBy.map(n => n.id)).toContain(newId);

        // History moved.
        expect(fx.db.getFullHistory(newId)).toHaveLength(1);
        expect(fx.db.getFullHistory(oldId)).toHaveLength(0);

        // Vector moved.
        expect(fx.db.getNodeVector(oldId)).toBeNull();
        expect(fx.db.getNodeVector(newId)).toBeTruthy();
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('mergeNodes', () => {
    it('reassigns edges/history onto the target, folds aliases, and deprecates the source', async () => {
      const fx = makeFixture({
        extraFiles: {
          'baz.ts': 'export function baz(): number {\n  return 1;\n}\n',
          'greet2.ts': "import { baz } from './baz';\n\nexport function greet2(): number {\n  return baz();\n}\n"
        }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' },
          { node_id: 'baz', file_path: repoFile(fx, 'baz.ts'), code_snapshot: 'export function baz(): number {\n  return 1;\n}', name: 'baz', type: 'function' },
          { node_id: 'greet2', file_path: repoFile(fx, 'greet2.ts'), code_snapshot: 'export function greet2(): number {\n  return baz();\n}', name: 'greet2', type: 'function' }
        ]);
        const greetId = '{app}/foo.ts#greet';
        const formatId = '{app}/bar.ts#format';
        const bazId = '{app}/baz.ts#baz';
        const greet2Id = '{app}/greet2.ts#greet2';

        // Pre-merge sanity: greet2 -> baz, greet does NOT use baz.
        expect(fx.db.getConnections(greet2Id).uses.map(n => n.id)).toContain(bazId);
        expect(fx.db.getConnections(greetId).uses.map(n => n.id)).not.toContain(bazId);
        expect(fx.db.getFullHistory(greet2Id)).toHaveLength(1);

        fx.db.mergeNodes(greet2Id, greetId);

        // Edges reassigned onto the target (greet keeps its own edge AND gains greet2's).
        const mergedConns = fx.db.getConnections(greetId);
        expect(mergedConns.uses.map(n => n.id)).toEqual(expect.arrayContaining([formatId, bazId]));

        // Source's own connections are gone.
        expect(fx.db.getConnections(greet2Id).uses).toEqual([]);

        // Source deprecated, not deleted.
        const fromNode = fx.db.getNode(greet2Id);
        expect(fromNode).toBeTruthy();
        expect(fromNode!.deprecated).toBe(1);

        // Aliases folded in (source's own name becomes an alias on the target).
        const intoNode = fx.db.getNode(greetId)!;
        expect(intoNode.aliases).toContain('greet2');

        // History reassigned.
        expect(fx.db.getFullHistory(greetId)).toHaveLength(2);
        expect(fx.db.getFullHistory(greet2Id)).toHaveLength(0);
      } finally {
        fx.cleanup();
      }
    });

    it('is a no-op when merging a node into itself', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const greetId = '{app}/foo.ts#greet';
        expect(() => fx.db.mergeNodes(greetId, greetId)).not.toThrow();
        expect(fx.db.getNode(greetId)?.deprecated).toBe(0);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('addAlias / addConnection / getConnections', () => {
    it('addAlias adds an alias without duplicating and no-ops for an unknown node', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const id = '{app}/foo.ts#greet';
        fx.db.addAlias(id, 'sayHello');
        fx.db.addAlias(id, 'sayHello'); // duplicate — no-op
        expect(fx.db.getNode(id)!.aliases).toEqual(['sayHello']);

        expect(() => fx.db.addAlias('{app}/nope.ts#ghost', 'x')).not.toThrow();
      } finally {
        fx.cleanup();
      }
    });

    it('addConnection links two existing nodes and getConnections reflects both ends', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
        ]);
        const greetId = '{app}/foo.ts#greet';
        const formatId = '{app}/bar.ts#format';

        // AST already resolved greet -> format. Add the reverse edge manually.
        fx.db.addConnection(formatId, greetId);

        const greetConns = fx.db.getConnections(greetId);
        expect(greetConns.uses.map(n => n.id)).toContain(formatId);
        expect(greetConns.usedBy.map(n => n.id)).toContain(formatId);

        const formatConns = fx.db.getConnections(formatId);
        expect(formatConns.uses.map(n => n.id)).toContain(greetId);
        expect(formatConns.usedBy.map(n => n.id)).toContain(greetId);
      } finally {
        fx.cleanup();
      }
    });

    it('refuses (and warns, no-ops) an edge whose source node does not exist', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
        ]);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          fx.db.addConnection('{app}/nope.ts#ghost', '{app}/foo.ts#greet');
          expect(warnSpy).toHaveBeenCalled();
          expect(fx.db.getConnections('{app}/foo.ts#greet').usedBy).toEqual([]);
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getConnectionCounts', () => {
    it('returns batched degree counts, with a zeroed entry for unknown ids', async () => {
      const fx = makeFixture();
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' }
        ]);
        const counts = fx.db.getConnectionCounts(['{app}/foo.ts#greet', '{app}/bar.ts#format', '{app}/nope.ts#ghost']);
        expect(counts.get('{app}/foo.ts#greet')).toEqual({ uses: 1, usedBy: 0 });
        expect(counts.get('{app}/bar.ts#format')).toEqual({ uses: 0, usedBy: 1 });
        expect(counts.get('{app}/nope.ts#ghost')).toEqual({ uses: 0, usedBy: 0 });
        expect(fx.db.getConnectionCounts([]).size).toBe(0);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getGraph', () => {
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

    it('direction "out" walks callees only, one hop then two', async () => {
      const fx = chainFixture();
      try {
        await commitChain(fx);
        const fooId = '{app}/foo.ts#foo';
        const g1 = fx.db.getGraph(fooId, 1, { direction: 'out' });
        expect(g1.nodes.map(n => n.id).sort()).toEqual(['{app}/bar.ts#bar', '{app}/foo.ts#foo']);

        const g2 = fx.db.getGraph(fooId, 2, { direction: 'out' });
        expect(g2.nodes.map(n => n.id).sort()).toEqual(['{app}/bar.ts#bar', '{app}/baz.ts#baz', '{app}/foo.ts#foo']);
      } finally {
        fx.cleanup();
      }
    });

    it('direction "in" walks callers only', async () => {
      const fx = chainFixture();
      try {
        await commitChain(fx);
        const bazId = '{app}/baz.ts#baz';
        const g = fx.db.getGraph(bazId, 2, { direction: 'in' });
        expect(g.nodes.map(n => n.id).sort()).toEqual(['{app}/bar.ts#bar', '{app}/baz.ts#baz', '{app}/foo.ts#foo']);
      } finally {
        fx.cleanup();
      }
    });

    it('direction "both" (default) walks both directions from a middle node', async () => {
      const fx = chainFixture();
      try {
        await commitChain(fx);
        const barId = '{app}/bar.ts#bar';
        const g = fx.db.getGraph(barId, 1, { direction: 'both' });
        expect(g.nodes.map(n => n.id).sort()).toEqual(['{app}/bar.ts#bar', '{app}/baz.ts#baz', '{app}/foo.ts#foo']);
      } finally {
        fx.cleanup();
      }
    });

    it('maxDepth=0 returns only the root — depth has no enforced minimum clamp in database.ts', async () => {
      // Note: getGraph's `maxDepth` parameter is used as-is (`current.depth >= maxDepth: continue`)
      // with no min/max clamping anywhere in DevMindDatabase itself — any clamp (e.g. 1-10) would
      // have to live in a caller (the MCP tool schema), which is out of scope here.
      const fx = chainFixture();
      try {
        await commitChain(fx);
        const fooId = '{app}/foo.ts#foo';
        const g = fx.db.getGraph(fooId, 0);
        expect(g.nodes.map(n => n.id)).toEqual([fooId]);
        expect(g.connections).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });

    it('returns an empty result for a nonexistent root', () => {
      const fx = makeFixture();
      try {
        const g = fx.db.getGraph('{app}/nope.ts#ghost');
        expect(g.nodes).toEqual([]);
        expect(g.connections).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });

    it('includeCode attaches live code within the char budget; the root always gets its code', async () => {
      const fx = chainFixture();
      try {
        await commitChain(fx);
        const fooId = '{app}/foo.ts#foo';
        const g = fx.db.getGraph(fooId, 2, { direction: 'out', includeCode: true, codeCharBudget: 5 });

        const root = g.nodes.find(n => n.id === fooId)!;
        expect(root.code).toBeTruthy();
        expect(root.code_source).toBe('live');

        // Budget (5 chars) is blown by the root alone, so every OTHER node is dropped.
        expect(g.code_truncated).toBe(true);
        expect(g.nodes_without_code).toBeGreaterThan(0);
        const nonRootWithCode = g.nodes.filter(n => n.id !== fooId && n.code);
        expect(nonRootWithCode).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });

    it('names budget-dropped nodes by id, and reports "no code available" as a separate cause', async () => {
      // These two used to share one `nodes_without_code` counter, so a caller could not tell a
      // fixable problem (raise the budget) from an unfixable one (the source is genuinely gone),
      // and `code_truncated: true` on a completely unspent budget was possible. Ids rather than a
      // count because an id is a valid argument to get_node_code — a bare number is not actionable,
      // and a positional index into a BFS that gets re-derived every call is not stable.
      const fx = chainFixture();
      try {
        await commitChain(fx);
        const fooId = '{app}/foo.ts#foo';
        const g = fx.db.getGraph(fooId, 2, { direction: 'out', includeCode: true, codeCharBudget: 5 });

        expect(g.code_omitted_node_ids).toEqual(['{app}/bar.ts#bar', '{app}/baz.ts#baz']);
        // Every node here HAS code; nothing was dropped for the other reason.
        expect(g.nodes_no_code_available).toBeUndefined();
        // The combined count stays consistent with the split fields.
        expect(g.nodes_without_code).toBe(2);
        expect(g.code_chars).toBeGreaterThan(0);
      } finally {
        fx.cleanup();
      }
    });

    it('leaves code_truncated unset when the whole graph fits, and counts the chars it spent', async () => {
      // The negative case, which nothing asserted before: a complete result must be positively
      // distinguishable from a trimmed one, not merely "probably fine".
      const fx = chainFixture();
      try {
        await commitChain(fx);
        const g = fx.db.getGraph('{app}/foo.ts#foo', 2, { direction: 'out', includeCode: true });

        expect(g.code_truncated).toBeUndefined();
        expect(g.nodes_without_code).toBeUndefined();
        expect(g.code_omitted_node_ids).toBeUndefined();
        expect(g.nodes_no_code_available).toBeUndefined();
        expect(g.nodes.every(n => typeof n.code === 'string')).toBe(true);
        expect(g.code_chars).toBe(g.nodes.reduce((sum, n) => sum + (n.code?.length ?? 0), 0));
      } finally {
        fx.cleanup();
      }
    });

    it('returns nodes in a stable order across identical calls, so the same query gives the same answer', async () => {
      // Without ORDER BY, sibling order within a depth was SQLite physical row order — which meant
      // two identical calls could disagree about WHICH nodes got code once the budget ran out.
      const fx = chainFixture();
      try {
        await commitChain(fx);
        const fooId = '{app}/foo.ts#foo';
        const a = fx.db.getGraph(fooId, 3, { direction: 'both' });
        const b = fx.db.getGraph(fooId, 3, { direction: 'both' });
        expect(a.nodes.map(n => n.id)).toEqual(b.nodes.map(n => n.id));
        expect(a.connections).toEqual(b.connections);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('getOrphanedNodes', () => {
    it('lists nodes with no edges in either direction, excludes connected ones', async () => {
      const fx = makeFixture({
        extraFiles: { 'orphan.ts': 'export function orphan(): number {\n  return 1;\n}\n' }
      });
      try {
        await stageAndCommit(fx, [
          { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' },
          { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: BAR_SNIPPET, name: 'format', type: 'function' },
          { node_id: 'orphan', file_path: repoFile(fx, 'orphan.ts'), code_snapshot: 'export function orphan(): number {\n  return 1;\n}', name: 'orphan', type: 'function' }
        ]);

        const orphans = fx.db.getOrphanedNodes().map(n => n.id);
        expect(orphans).toEqual(['{app}/orphan.ts#orphan']);
      } finally {
        fx.cleanup();
      }
    });
  });

  describe('isPathAllowed', () => {
    it('allows paths inside the configured repo; rejects outside paths and .devmind itself', () => {
      const fx = makeFixture();
      try {
        expect(fx.db.isPathAllowed(repoFile(fx, 'foo.ts'))).toBe(true);
        expect(fx.db.isPathAllowed(path.join(fx.root, 'outside.txt'))).toBe(false);
        expect(fx.db.isPathAllowed(path.join(fx.devmindPath, 'config.json'))).toBe(false);
        expect(fx.db.isPathAllowed(fx.devmindPath)).toBe(false);
      } finally {
        fx.cleanup();
      }
    });
  });
});
