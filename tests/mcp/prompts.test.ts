import { connectMcpClient, McpTestHarness } from '../helpers/mcpClient';
import { DEVSMIND_INSTRUCTIONS, DEVSMIND_PROMPT_NAME } from '../../src/mcp/server';

describe('MCP prompts capability (in-process, real Server + Client over InMemoryTransport)', () => {
  let harness: McpTestHarness;

  beforeEach(async () => {
    harness = await connectMcpClient();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('lists exactly one prompt: the workflow contract', async () => {
    const { prompts } = await harness.client.listPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe(DEVSMIND_PROMPT_NAME);
    expect(prompts[0].description).toContain('start_session');
  });

  it('returns the exact DEVSMIND_INSTRUCTIONS text when the prompt is fetched', async () => {
    const { messages } = await harness.client.getPrompt({ name: DEVSMIND_PROMPT_NAME });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toEqual({ type: 'text', text: DEVSMIND_INSTRUCTIONS });
  });

  it('rejects an unknown prompt name', async () => {
    await expect(harness.client.getPrompt({ name: 'not-a-real-prompt' })).rejects.toThrow(/Prompt not found/);
  });
});
