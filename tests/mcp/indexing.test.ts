import { connectMcpClient, callTool, callToolJson, McpTestHarness } from '../helpers/mcpClient';
import { makeFixture, Fixture, repoFile } from '../helpers/fixture';
import { readScratchpad } from '../../src/db/indexer';

/**
 * First-ever coverage for the in-chat indexing tools, rebuilt around local AST extraction (no
 * LLM, no `stage_change`) — see src/db/index-build.ts. The server parses structure itself; the
 * AI's only job is writing descriptions via the existing `add_description` tool.
 */
describe('in-chat indexing (index_start / index_continue / index_checkpoint / index_complete)', () => {
  let harness: McpTestHarness;
  let fx: Fixture;

  beforeEach(async () => {
    harness = await connectMcpClient();
    fx = makeFixture();
  });

  afterEach(async () => {
    await harness.close();
    fx.cleanup();
  });

  async function startSession(): Promise<string> {
    const { parsed } = await callToolJson(harness.client, 'start_session', { devmind_path: fx.devmindPath });
    return (parsed as { session_id: string }).session_id;
  }

  it('extracts structure locally with no code round-trip required, and add_description finishes the node (with a type upgrade)', async () => {
    const sessionId = await startSession();

    const { isError, parsed } = await callToolJson(harness.client, 'index_start', {
      devmind_path: fx.devmindPath, session_id: sessionId
    });
    expect(isError).toBe(false);
    const p = parsed as any;

    expect(p.scratchpad.files_done).toBe(2);
    expect(p.total_files).toBe(2);
    expect(p.batch.nodes.map((n: any) => n.node_id).sort()).toEqual(['{app}/bar.ts#format', '{app}/foo.ts#greet'].sort());

    const greet = p.batch.nodes.find((n: any) => n.node_id === '{app}/foo.ts#greet');
    expect(greet.code).toContain('return format(name)');
    expect(greet.exported).toBe(true);
    expect(p.batch.file_imports['{app}/foo.ts']).toEqual(['./bar']);

    // Written straight to the graph already, before any description exists.
    expect(fx.db.getNode('{app}/foo.ts#greet')).not.toBeNull();
    expect(fx.db.getNode('{app}/foo.ts#greet')!.description).toBeNull();

    const described = await callToolJson(harness.client, 'add_description', {
      devmind_path: fx.devmindPath, session_id: sessionId,
      descriptions: [
        { node_id: '{app}/foo.ts#greet', description: 'Builds a greeting string for the given name, used on user sign-in.', type: 'formatter' },
        { node_id: '{app}/bar.ts#format', description: 'Formats a display string by prefixing a friendly greeting.' }
      ]
    });
    expect(described.isError).toBe(false);
    expect((described.parsed as any).described).toBe(true);

    const greetNode = fx.db.getNode('{app}/foo.ts#greet')!;
    expect(greetNode.description).toContain('greeting');
    expect(greetNode.type).toBe('formatter'); // upgraded from the AST's generic "function"
  });

  it('index_checkpoint is a zero-argument progress read, unaffected by whether description writes happened', async () => {
    const sessionId = await startSession();
    await callTool(harness.client, 'index_start', { devmind_path: fx.devmindPath, session_id: sessionId });

    const { isError, parsed } = await callToolJson(harness.client, 'index_checkpoint', {
      devmind_path: fx.devmindPath, session_id: sessionId
    });
    expect(isError).toBe(false);
    const p = parsed as any;
    expect(p.nodes_total).toBe(2);
    expect(p.described).toBe(0);
    expect(p.undescribed).toBe(2);
    expect(p.progress).toBe('2/2 files (100%)');
  });

  it('a full pipeline — extract, describe, continue to exhaustion, complete with a real cross-file edge, then a re-run does not duplicate nodes', async () => {
    const sessionId = await startSession();
    await callTool(harness.client, 'index_start', { devmind_path: fx.devmindPath, session_id: sessionId });

    await callTool(harness.client, 'add_description', {
      devmind_path: fx.devmindPath, session_id: sessionId,
      descriptions: [
        { node_id: '{app}/foo.ts#greet', description: 'Builds a greeting string for the given name.' },
        { node_id: '{app}/bar.ts#format', description: 'Formats a display string with a greeting prefix.' }
      ]
    });

    // Both files were already extracted inside index_start (well under the 40-file batch
    // budget), so this call's only job is noticing nothing is left and moving to phase 2.
    const cont = await callToolJson(harness.client, 'index_continue', { devmind_path: fx.devmindPath, session_id: sessionId });
    expect(cont.isError).toBe(false);
    expect((cont.parsed as any).scratchpad.phase).toBe(2);
    expect((cont.parsed as any).still_undescribed).toEqual([]);

    const complete = await callToolJson(harness.client, 'index_complete', { devmind_path: fx.devmindPath, session_id: sessionId });
    expect(complete.isError).toBe(false);
    const c = complete.parsed as any;
    expect(c.summary.connections_created).toBeGreaterThan(0);
    expect(c.undescribed_count).toBe(0);
    expect(c.hint).toBeUndefined();
    expect(readScratchpad(fx.devmindPath)!.status).toBe('complete');

    const conns = fx.db.getConnections('{app}/foo.ts#greet');
    expect(conns.uses.map(n => n.id)).toContain('{app}/bar.ts#format');

    // index_complete a second time on an already-complete session reports status, not an error.
    const again = await callToolJson(harness.client, 'index_complete', { devmind_path: fx.devmindPath, session_id: sessionId });
    expect(again.isError).toBe(false);
    expect((again.parsed as any).status).toBe('complete');

    // Re-running index_start must not duplicate anything already in the graph.
    const nodeCountBefore = fx.db.listNodes().length;
    const rerun = await callToolJson(harness.client, 'index_start', { devmind_path: fx.devmindPath, session_id: sessionId });
    expect((rerun.parsed as any).existing_nodes).toBe(nodeCountBefore);
    expect(fx.db.listNodes().length).toBe(nodeCountBefore);
  });

  it('index_complete refuses while files remain unextracted, and index_continue drains the batch across calls', async () => {
    const extraFiles: Record<string, string> = {};
    for (let i = 0; i < 45; i++) {
      extraFiles[`dummy${i}.ts`] = `export function dummyFn${i}(): number {\n  return ${i};\n}\n`;
    }
    fx.cleanup();
    fx = makeFixture({ skipDefaultFiles: true, extraFiles });

    const sessionId = await startSession();
    const start = await callToolJson(harness.client, 'index_start', { devmind_path: fx.devmindPath, session_id: sessionId });
    expect(start.isError).toBe(false);
    const startPad = (start.parsed as any).scratchpad;
    // The default 40-file batch budget must have left some of the 45 files unextracted.
    expect(startPad.files_done).toBeLessThan(45);
    expect(startPad.files_done).toBeGreaterThan(0);

    const refused = await callToolJson(harness.client, 'index_complete', { devmind_path: fx.devmindPath, session_id: sessionId });
    expect(refused.isError).toBe(true);
    expect((refused.parsed as any).error).toMatch(/still unextracted/);

    // Drain remaining batches — bounded loop so a real bug (stuck cursor) fails the test
    // instead of hanging it.
    let pad = startPad;
    let iterations = 0;
    while (pad.phase === 1 && iterations < 10) {
      const cont = await callToolJson(harness.client, 'index_continue', { devmind_path: fx.devmindPath, session_id: sessionId });
      pad = (cont.parsed as any).scratchpad;
      iterations++;
    }
    expect(pad.phase).toBe(2);
    expect(pad.files_done).toBe(45);
    expect(fx.db.listNodes().length).toBe(45);
  });
});
