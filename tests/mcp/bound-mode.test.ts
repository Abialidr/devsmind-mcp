import { connectMcpClient, callToolJson, McpTestHarness } from '../helpers/mcpClient';
import { makeFixture, Fixture } from '../helpers/fixture';
import { bindDevmindPath } from '../../src/mcp/server';

/**
 * Bound (stateful) server mode: after bindDevmindPath, the server serves exactly one project.
 * `devmind_path` must vanish from every advertised schema, and tool calls that omit it must still
 * resolve to the bound brain — the whole point of "the AI never passes a path again."
 *
 * Safe to mutate the module-global bound path here: Jest gives each test file its own module
 * registry, so binding in this file never leaks into the unbound tools.test.ts / http-api.test.ts.
 */
describe('bound-mode server', () => {
  let harness: McpTestHarness;
  let fx: Fixture;

  beforeAll(async () => {
    fx = makeFixture();
    bindDevmindPath(fx.devmindPath); // must bind BEFORE the server lists tools
    harness = await connectMcpClient();
  });

  afterAll(async () => {
    await harness.close();
    fx.cleanup();
  });

  it('drops devmind_path from every advertised tool schema', async () => {
    const { tools } = await harness.client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      const schema = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(schema.properties?.devmind_path).toBeUndefined();
      expect(schema.required ?? []).not.toContain('devmind_path');
    }
  });

  it('resolves a read tool to the bound brain with no devmind_path passed', async () => {
    // start_session first (server gates everything else on it), then a read that hits the DB —
    // proving resolveDevmindPath short-circuited to the bound path with no arg supplied.
    const started = await callToolJson(harness.client, 'start_session', {});
    expect(started.isError).toBe(false);
    const sessionId = (started.parsed as { session_id?: string })?.session_id;
    expect(sessionId).toBeTruthy();

    const listed = await callToolJson(harness.client, 'list_nodes', { session_id: sessionId });
    expect(listed.isError).toBe(false);
    expect(listed.parsed).toBeTruthy();
  });
});
