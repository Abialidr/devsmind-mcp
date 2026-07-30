import { makeFixture, stageAndCommit, repoFile } from './fixture';

describe('fixture helper smoke test', () => {
  it('creates a brain, stages+commits a node, resolves its edges, and reads it back', async () => {
    const fx = makeFixture();
    try {
      const summary = await stageAndCommit(fx, [
        {
          node_id: 'greet',
          file_path: repoFile(fx, 'foo.ts'),
          code_snapshot: 'export function greet(name: string): string {\n  return format(name);\n}',
          name: 'greet',
          type: 'function',
          description: 'Returns a greeting string built from the given name, used by the demo entrypoint.'
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

      expect(summary.nodes).toBe(2);
      expect(summary.node_ids).toEqual(
        expect.arrayContaining(['{app}/foo.ts#greet', '{app}/bar.ts#format'])
      );

      const greetNode = fx.db.getNode('{app}/foo.ts#greet');
      expect(greetNode).toBeTruthy();
      expect(greetNode!.name).toBe('greet');

      // AST edge resolution: greet() calls format() imported from ./bar.
      const conns = fx.db.getConnections('{app}/foo.ts#greet');
      expect(conns.uses.map(c => c.id)).toContain('{app}/bar.ts#format');
    } finally {
      fx.cleanup();
    }
  });
});
