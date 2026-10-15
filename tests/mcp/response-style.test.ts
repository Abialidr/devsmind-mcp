import * as fs from 'fs';
import * as path from 'path';
import { connectMcpClient, callTool } from '../helpers/mcpClient';
import { makeFixture } from '../helpers/fixture';
import { DEVSMIND_INSTRUCTIONS, DEVSMIND_PROMPT_NAME, bindDevmindPath } from '../../src/mcp/server';
import { RESPONSE_STYLE_ENV_KEY, buildResponseStyleBlock, buildResponseStyleReminder } from '../../src/utils/response-style';

// Real Server + real Client over an in-process transport: what an agent actually receives at connect.
describe('terse reply style reaches the agent through the MCP handshake', () => {
  let fx: ReturnType<typeof makeFixture>;
  const saved = process.env[RESPONSE_STYLE_ENV_KEY];

  beforeEach(() => {
    delete process.env[RESPONSE_STYLE_ENV_KEY];
    fx = makeFixture();
    bindDevmindPath(fx.devmindPath);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[RESPONSE_STYLE_ENV_KEY];
    else process.env[RESPONSE_STYLE_ENV_KEY] = saved;
    fx.cleanup();
  });

  const writeStyle = (v: string) => fs.writeFileSync(path.join(fx.devmindPath, '.env'), `${RESPONSE_STYLE_ENV_KEY}=${v}\n`);

  async function handshake(): Promise<{ instructions: string; prompt: string }> {
    const h = await connectMcpClient();
    try {
      const instructions = h.client.getInstructions() ?? '';
      const { messages } = await h.client.getPrompt({ name: DEVSMIND_PROMPT_NAME });
      const c = messages[0].content as { type: string; text: string };
      return { instructions, prompt: c.text };
    } finally {
      await h.close();
    }
  }

  it('sends the contract byte-for-byte unchanged by default', async () => {
    const { instructions, prompt } = await handshake();
    expect(instructions).toBe(DEVSMIND_INSTRUCTIONS);
    expect(prompt).toBe(DEVSMIND_INSTRUCTIONS);
  });

  it('puts the full-style block FIRST, ahead of the untouched contract, in both the handshake and the prompt', async () => {
    writeStyle('full');
    const { instructions, prompt } = await handshake();
    const expected = `${buildResponseStyleBlock('full')}\n\n${DEVSMIND_INSTRUCTIONS}`;
    expect(instructions).toBe(expected);
    expect(prompt).toBe(expected);
    // The contract is 11k characters; a client that truncates must still reach the style note.
    expect(instructions.slice(0, 1500)).toContain('(full)');
  });

  it('picks up a change on the next connection, with no server restart', async () => {
    writeStyle('lite');
    expect((await handshake()).instructions).toContain('(lite)');
    writeStyle('full');
    expect((await handshake()).instructions).toContain('(full)');
    fs.rmSync(path.join(fx.devmindPath, '.env'));
    expect((await handshake()).instructions).toBe(DEVSMIND_INSTRUCTIONS);
  });

  it('lets the process environment override the brain setting', async () => {
    writeStyle('lite');
    process.env[RESPONSE_STYLE_ENV_KEY] = 'full';
    expect((await handshake()).instructions).toContain('(full)');
    process.env[RESPONSE_STYLE_ENV_KEY] = 'off';
    expect((await handshake()).instructions).toBe(DEVSMIND_INSTRUCTIONS);
  });

  // The handshake note is read once, far up a long context; this reminder is the last thing the
  // agent reads before it writes its reply, which is the point of having it.
  async function listNodesBlocks(): Promise<string[]> {
    const h = await connectMcpClient();
    try {
      return (await callTool(h.client, 'list_nodes', {})).textBlocks;
    } finally {
      await h.close();
    }
  }

  it('ends every tool result with a bold reminder while a style is on, as its own block after the real payload', async () => {
    writeStyle('full');
    const blocks = await listNodesBlocks();
    expect(blocks[blocks.length - 1]).toBe(buildResponseStyleReminder('full'));
    // The payload is untouched: still parseable JSON in the first block.
    expect(() => JSON.parse(blocks[0])).not.toThrow();
    expect(blocks[0]).not.toContain('TERSE REPLY');

    writeStyle('lite');
    const lite = await listNodesBlocks();
    expect(lite[lite.length - 1]).toBe(buildResponseStyleReminder('lite'));
  });

  it('adds nothing to tool results by default', async () => {
    const blocks = await listNodesBlocks();
    expect(blocks.join('\n')).not.toContain('TERSE REPLY');
  });

  it('survives a garbage value by serving the normal contract', async () => {
    writeStyle('shouty');
    expect((await handshake()).instructions).toBe(DEVSMIND_INSTRUCTIONS);
  });
});
