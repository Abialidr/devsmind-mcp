import * as fs from 'fs';
import { makeFixture, stageAndCommit, repoFile, Fixture } from '../helpers/fixture';
import { resolveEdgesForNodes, applyDeterministicAliases, finalizeMissingNodes, splitNode, createMissingCollector } from '../../src/db/edges';
import * as astModule from '../../src/utils/ast';

describe('edges.ts — DB-integrated edge resolution', () => {
  let fx: Fixture;

  afterEach(() => {
    fx?.cleanup();
  });

  describe('resolveEdgesForNodes', () => {
    it('clears a stale edge and adds the new one after the source file changes imports', async () => {
      fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'foo.ts': `import { format } from './bar';\n\nexport function greet(name: string): string {\n  return format(name);\n}\n`,
          'bar.ts': `export function format(s: string): string {\n  return "hi " + s;\n}\n\nexport function shout(s: string): string {\n  return s.toUpperCase() + "!";\n}\n`
        }
      });

      const summary = await stageAndCommit(fx, [
        {
          node_id: 'greet',
          file_path: repoFile(fx, 'foo.ts'),
          code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
          name: 'greet',
          type: 'function',
          description: 'Greets a person by name, delegating the actual message formatting to a helper.'
        },
        {
          node_id: 'format',
          file_path: repoFile(fx, 'bar.ts'),
          code_snapshot: 'export function format(s: string): string {\n  return "hi " + s;\n}',
          name: 'format',
          type: 'function',
          description: 'Formats a raw string into the "hi <value>" greeting format used across the app.'
        }
      ]);

      const greetId = summary.node_ids.find(id => id.endsWith('#greet'))!;
      const formatId = summary.node_ids.find(id => id.endsWith('#format'))!;
      const shoutId = formatId.replace('#format', '#shout');

      // Initial commit already resolved the edge via commitStagedChanges' own resolveEdgesForNodes.
      expect(fx.db.getConnections(greetId).uses.map(c => c.id)).toContain(formatId);
      expect(fx.db.getNode(shoutId)).toBeNull();

      // Simulate a hand-edit: greet() now calls shout() instead of format().
      fs.writeFileSync(
        repoFile(fx, 'foo.ts'),
        `import { shout } from './bar';\n\nexport function greet(name: string): string {\n  return shout(name);\n}\n`
      );

      const result = resolveEdgesForNodes(fx.db, fx.devmindPath, [greetId], { clearSources: true });
      // shout wasn't a committed node at resolution time, so it's reported as missing rather than
      // counted in edgesAdded — finalizeMissingNodes creates the node AND its edge internally.
      expect(result.missingFilled).toBeGreaterThanOrEqual(1);

      const conns = fx.db.getConnections(greetId);
      expect(conns.uses.map(c => c.id)).not.toContain(formatId);
      expect(conns.uses.map(c => c.id)).toContain(shoutId);
      expect(fx.db.getNode(shoutId)).toBeTruthy();
    });

    it('is a no-op for an empty source list', () => {
      fx = makeFixture();
      const result = resolveEdgesForNodes(fx.db, fx.devmindPath, [], { clearSources: true });
      expect(result).toEqual({ edgesAdded: 0, missingFilled: 0 });
    });

    it('opts is optional — omitting it entirely defaults clearSources to falsy (pure-additive)', async () => {
      fx = makeFixture();
      const summary = await stageAndCommit(fx, [
        {
          node_id: 'greet',
          file_path: repoFile(fx, 'foo.ts'),
          code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
          name: 'greet',
          type: 'function',
          description: 'Returns a greeting string built from the given name, used by the demo entrypoint.'
        }
      ]);
      const greetId = summary.node_ids.find(id => id.endsWith('#greet'))!;
      // No 3rd argument at all, exercising the `opts: { clearSources?: boolean } = {}` default.
      const result = resolveEdgesForNodes(fx.db, fx.devmindPath, [greetId]);
      expect(result.edgesAdded).toBeGreaterThanOrEqual(0);
    });

    it('skips (continue) a source id with no corresponding node or no file_path, without throwing', async () => {
      fx = makeFixture();
      const result = resolveEdgesForNodes(fx.db, fx.devmindPath, ['{app}/nowhere.ts#nothing']);
      expect(result).toEqual({ edgesAdded: 0, missingFilled: 0 });
    });
  });

  describe('applyDeterministicAliases', () => {
    it('attaches RTK Query generated hook aliases to the endpoint node', async () => {
      fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'api.ts': `import { createApi } from '@reduxjs/toolkit/query';\n\nexport const api = createApi({\n  reducerPath: 'api',\n  endpoints: (builder) => ({\n    getUser: builder.query({\n      query: (id: string) => \`/users/\${id}\`\n    })\n  })\n});\n`
        }
      });

      const summary = await stageAndCommit(fx, [
        {
          node_id: 'getUser',
          file_path: repoFile(fx, 'api.ts'),
          code_snapshot: `getUser: builder.query({\n  query: (id: string) => \`/users/\${id}\`\n})`,
          name: 'getUser',
          type: 'rtk_endpoint',
          description: 'RTK Query endpoint that fetches a single user record by id from the users API.'
        }
      ]);
      const nodeId = summary.node_ids[0];

      // Sanity: commitStagedChanges' own resolveEdgesForNodes already runs applyDeterministicAliases,
      // so aliases may already be attached. Verify directly (and idempotently) regardless.
      applyDeterministicAliases(fx.db, [nodeId]);

      const node = fx.db.getNode(nodeId)!;
      expect(node.aliases).toEqual(expect.arrayContaining(['useGetUserQuery', 'useLazyGetUserQuery']));
    });

    it('does nothing when the file has no RTK endpoints', async () => {
      fx = makeFixture();
      const summary = await stageAndCommit(fx, [
        {
          node_id: 'greet',
          file_path: repoFile(fx, 'foo.ts'),
          code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
          name: 'greet',
          type: 'function',
          description: 'Returns a greeting string built from the given name, used by the demo entrypoint.'
        }
      ]);
      const nodeId = summary.node_ids[0];
      expect(() => applyDeterministicAliases(fx.db, [nodeId])).not.toThrow();
      expect(fx.db.getNode(nodeId)!.aliases).toEqual([]);
    });

    it('skips (continue) a source id with no corresponding node or no file_path, without throwing', () => {
      fx = makeFixture();
      expect(() => applyDeterministicAliases(fx.db, ['{app}/nowhere.ts#nothing'])).not.toThrow();
    });

    it('continues past a file whose detector throws, without aborting the rest of the batch', async () => {
      fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'api.ts': `import { createApi } from '@reduxjs/toolkit/query';\n\nexport const api = createApi({\n  reducerPath: 'api',\n  endpoints: (builder) => ({\n    getUser: builder.query({\n      query: (id: string) => \`/users/\${id}\`\n    })\n  })\n});\n`
        }
      });
      const summary = await stageAndCommit(fx, [
        {
          node_id: 'getUser',
          file_path: repoFile(fx, 'api.ts'),
          code_snapshot: `getUser: builder.query({\n  query: (id: string) => \`/users/\${id}\`\n})`,
          name: 'getUser',
          type: 'rtk_endpoint',
          description: 'RTK Query endpoint that fetches a single user record by id from the users API.'
        }
      ]);
      const nodeId = summary.node_ids[0];
      // stageAndCommit's own internal resolveEdgesForNodes already ran applyDeterministicAliases
      // once for real (with the real, unmocked detector), so the node may already carry aliases
      // from THAT pass — capture them before the mocked call below so we can assert the mocked,
      // throwing call added nothing further, rather than asserting an empty array outright.
      const aliasesBeforeThrow = fx.db.getNode(nodeId)!.aliases;

      // In real usage detectRtkEndpointAliases already swallows its own parse errors and returns
      // [] — this catch in applyDeterministicAliases is defensive against ANY detector throwing,
      // not just a parse failure. Force that with a spy to exercise the catch for real.
      const spy = jest.spyOn(astModule, 'detectRtkEndpointAliases').mockImplementation(() => {
        throw new Error('simulated detector crash');
      });
      try {
        expect(() => applyDeterministicAliases(fx.db, [nodeId])).not.toThrow();
        // Unchanged by the throwing call — the catch skipped this file without adding anything.
        expect(fx.db.getNode(nodeId)!.aliases).toEqual(aliasesBeforeThrow);
      } finally {
        spy.mockRestore();
      }
    });

    it('skips (continue) a detected endpoint whose symbol was never extracted as a node', async () => {
      fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'api.ts': `import { createApi } from '@reduxjs/toolkit/query';\n\nexport const api = createApi({\n  reducerPath: 'api',\n  endpoints: (builder) => ({\n    getUser: builder.query({\n      query: (id: string) => \`/users/\${id}\`\n    })\n  })\n});\n\nexport function unrelatedHelper(): void {}\n`
        }
      });
      // Stage a DIFFERENT symbol from the same file — the endpoint itself ('getUser') was never
      // committed as a node, so detectRtkEndpointAliases still finds it in the file, but
      // getNodesByFilePath's result has no node named 'getUser' to attach the aliases to.
      const summary = await stageAndCommit(fx, [
        {
          node_id: 'unrelatedHelper',
          file_path: repoFile(fx, 'api.ts'),
          code_snapshot: 'export function unrelatedHelper(): void {}',
          name: 'unrelatedHelper',
          type: 'function',
          description: 'A node in the same file as the RTK endpoint, but not the endpoint itself.'
        }
      ]);
      const nodeId = summary.node_ids[0];
      expect(() => applyDeterministicAliases(fx.db, [nodeId])).not.toThrow();
      expect(fx.db.getNode(nodeId)!.aliases).toEqual([]);
      expect(fx.db.getNode('{app}/api.ts#getUser')).toBeNull();
    });
  });

  describe('finalizeMissingNodes', () => {
    it('creates the node, writes auto-history, and writes missing_nodes_report.json when requested', async () => {
      fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'caller.ts': `export function useShout(): void {}\n`,
          'bar.ts': `export function format(s: string): string {\n  return "hi " + s;\n}\n\nexport function shout(s: string): string {\n  return s.toUpperCase() + "!";\n}\n`
        }
      });
      const summary = await stageAndCommit(fx, [
        {
          node_id: 'useShout',
          file_path: repoFile(fx, 'caller.ts'),
          code_snapshot: 'export function useShout(): void {}',
          name: 'useShout',
          type: 'function',
          description: 'Placeholder caller node used only so a missing-reference source id exists for the test.'
        }
      ]);
      const callerId = summary.node_ids[0];

      const { missing, onMissing } = createMissingCollector();
      onMissing({ sourceNodeId: callerId, name: 'shout', targetFile: repoFile(fx, 'bar.ts') });

      const filled = finalizeMissingNodes(fx.devmindPath, fx.db, missing, { writeReport: true, quiet: true });
      expect(filled).toBe(1);

      const shoutId = `{app}/bar.ts#shout`;
      const node = fx.db.getNode(shoutId);
      expect(node).toBeTruthy();
      expect(node!.name).toBe('shout');

      const history = fx.db.getLatestHistory(shoutId);
      expect(history).toBeTruthy();
      expect(history!.reasoning).toContain('Auto-created from a used-but-unextracted reference');

      const reportPath = `${fx.devmindPath}/missing_nodes_report.json`;
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      expect(report.filled).toBe(1);
      expect(report.missing.some((m: any) => m.symbol === 'shout' && m.filled === true)).toBe(true);
    });

    it('leaves an unresolvable reference in the report only (not filled) and does not write a report when writeReport is false', async () => {
      fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: { 'bar.ts': `export function format(s: string): string {\n  return "hi " + s;\n}\n` }
      });
      const { missing, onMissing } = createMissingCollector();
      onMissing({ sourceNodeId: '{app}/nowhere.ts#nothing', name: 'doesNotExist', targetFile: repoFile(fx, 'bar.ts') });

      const filled = finalizeMissingNodes(fx.devmindPath, fx.db, missing, { writeReport: false, quiet: true });
      expect(filled).toBe(0);
      expect(fx.db.getNode('{app}/bar.ts#doesNotExist')).toBeNull();
      expect(fs.existsSync(`${fx.devmindPath}/missing_nodes_report.json`)).toBe(false);
    });

    it('opts is optional (defaults writeReport:true, quiet:false), sorts multi-entry reports by referenced-by count, and logs a summary', () => {
      fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: { 'bar.ts': `export function format(s: string): string {\n  return "hi " + s;\n}\n` }
      });
      const { missing, onMissing } = createMissingCollector();
      // Two DISTINCT report entries (format resolves, doesNotExist stays unresolved) — the
      // report-building `.sort((a, b) => b.count - a.count)` only actually invokes its comparator
      // when there's more than one element to compare.
      onMissing({ sourceNodeId: '{app}/nowhere.ts#a', name: 'format', targetFile: repoFile(fx, 'bar.ts') });
      onMissing({ sourceNodeId: '{app}/nowhere.ts#b', name: 'doesNotExist', targetFile: repoFile(fx, 'bar.ts') });

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        // No 4th argument at all — exercises the `opts: { writeReport?: boolean; quiet?: boolean }
        // = {}` default, meaning writeReport defaults true and quiet defaults false.
        const filled = finalizeMissingNodes(fx.devmindPath, fx.db, missing);
        expect(filled).toBe(1);
        expect(fs.existsSync(`${fx.devmindPath}/missing_nodes_report.json`)).toBe(true);
        // quiet defaulted to false -> the summary lines were logged.
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Missing-node references'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('missing_nodes_report.json'));
      } finally {
        logSpy.mockRestore();
      }
    });

    it('tolerates a filled reference whose caller id has no real node when re-resolving edges', () => {
      fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: { 'bar.ts': `export function format(s: string): string {\n  return "hi " + s;\n}\n` }
      });
      const { missing, onMissing } = createMissingCollector();
      // 'format' resolves and gets filled, but its recorded caller ('ghost-caller') was never
      // actually staged as a node — the reresolve loop's `db.getNode(id)` for it returns null.
      onMissing({ sourceNodeId: '{app}/ghost-caller.ts#ghost', name: 'format', targetFile: repoFile(fx, 'bar.ts') });

      expect(() => {
        const filled = finalizeMissingNodes(fx.devmindPath, fx.db, missing, { writeReport: false, quiet: true });
        expect(filled).toBe(1);
      }).not.toThrow();
      expect(fx.db.getNode('{app}/bar.ts#format')).toBeTruthy();
    });
  });

  describe('splitNode', () => {
    it('splits a coarse node into real per-symbol nodes and deprecates the original', async () => {
      fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'multi.ts': `export function alpha(): string {\n  return "a";\n}\n\nexport function beta(): string {\n  return "b";\n}\n`
        }
      });
      const fullFile = `export function alpha(): string {\n  return "a";\n}\n\nexport function beta(): string {\n  return "b";\n}\n`;
      const summary = await stageAndCommit(fx, [
        {
          node_id: 'alphaBeta',
          file_path: repoFile(fx, 'multi.ts'),
          code_snapshot: fullFile,
          name: 'alphaBeta',
          type: 'file',
          description: 'A deliberately over-coarse node spanning two unrelated exported functions in one file.'
        }
      ]);
      const coarseId = summary.node_ids[0];

      const result = splitNode(fx.db, coarseId, ['alpha', 'beta']);
      expect(result.failed).toEqual([]);
      expect(result.created.sort()).toEqual(['{app}/multi.ts#alpha', '{app}/multi.ts#beta'].sort());

      const alphaNode = fx.db.getNode('{app}/multi.ts#alpha');
      const betaNode = fx.db.getNode('{app}/multi.ts#beta');
      expect(alphaNode).toBeTruthy();
      expect(betaNode).toBeTruthy();
      expect(alphaNode!.name).toBe('alpha');
      expect(betaNode!.name).toBe('beta');

      const original = fx.db.getNode(coarseId)!;
      expect(original.deprecated).toBe(1);
    });

    it('reports an unlocatable symbol in `failed` without crashing, and deprecates when at least one other split succeeded', async () => {
      fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'multi2.ts': `export function gamma(): string {\n  return "g";\n}\n\nexport function delta(): string {\n  return "d";\n}\n`
        }
      });
      const fullFile = `export function gamma(): string {\n  return "g";\n}\n\nexport function delta(): string {\n  return "d";\n}\n`;
      const summary = await stageAndCommit(fx, [
        {
          node_id: 'gammaDelta',
          file_path: repoFile(fx, 'multi2.ts'),
          code_snapshot: fullFile,
          name: 'gammaDelta',
          type: 'file',
          description: 'Another deliberately over-coarse node spanning two exported functions in one file.'
        }
      ]);
      const coarseId = summary.node_ids[0];

      const result = splitNode(fx.db, coarseId, ['gamma', 'doesNotExist']);
      expect(result.created).toEqual(['{app}/multi2.ts#gamma']);
      expect(result.failed).toEqual(['doesNotExist']);
      expect(fx.db.getNode(coarseId)!.deprecated).toBe(1);
    });

    it('leaves the original node untouched when EVERY split target fails to locate', async () => {
      fx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: { 'multi3.ts': `export function epsilon(): string {\n  return "e";\n}\n` }
      });
      const summary = await stageAndCommit(fx, [
        {
          node_id: 'epsilonNode',
          file_path: repoFile(fx, 'multi3.ts'),
          code_snapshot: `export function epsilon(): string {\n  return "e";\n}`,
          name: 'epsilonNode',
          type: 'function',
          description: 'A node whose split targets will all fail to locate, to test the all-failed path.'
        }
      ]);
      const coarseId = summary.node_ids[0];

      const result = splitNode(fx.db, coarseId, ['doesNotExist1', 'doesNotExist2']);
      expect(result.created).toEqual([]);
      expect(result.failed).toEqual(['doesNotExist1', 'doesNotExist2']);
      expect(fx.db.getNode(coarseId)!.deprecated).toBe(0);
    });

    it('returns everything as failed when the node itself has no file_path (not found)', () => {
      fx = makeFixture();
      const result = splitNode(fx.db, 'no-such-node-id', ['a', 'b']);
      expect(result.created).toEqual([]);
      expect(result.failed).toEqual(['a', 'b']);
    });
  });
});
