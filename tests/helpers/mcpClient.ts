import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, cleanup as cleanupCachedDatabases } from '../../src/mcp/server';

export interface McpTestHarness {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Spins up a real devsmind MCP `Server` (via the exported `createMcpServer`) wired to a real
 * SDK `Client` over an in-process `InMemoryTransport` pair — no port bound, no stdio process.
 * Exercises the exact same tool-dispatch code path production traffic hits.
 */
export async function connectMcpClient(): Promise<McpTestHarness> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'devsmind-test-client', version: '1.0.0' });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      // Tool handlers open DB connections through a module-level cache keyed by devmind_path
      // (see src/mcp/server.ts's getDatabase/dbCache) that's never closed on its own outside a
      // real process shutdown — without this a fixture's brain.db stays locked (EPERM on
      // Windows) when the test tries to rm its temp dir afterward.
      cleanupCachedDatabases();
    }
  };
}

/** Calls a tool and returns its parsed result. Devsmind tools always return one text content block
 * containing JSON (or an error string) plus a trailing `devsmind_session_id: <id>` text block. */
export async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }) as {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const textBlocks = (result.content || []).filter(c => c.type === 'text').map(c => c.text || '');
  return { isError: !!result.isError, textBlocks, raw: result };
}

/** Convenience: calls a tool expecting a single JSON payload in the first text block. */
export async function callToolJson(client: Client, name: string, args: Record<string, unknown>) {
  const { isError, textBlocks, raw } = await callTool(client, name, args);
  let parsed: unknown = undefined;
  try {
    parsed = textBlocks[0] ? JSON.parse(textBlocks[0]) : undefined;
  } catch {
    // Not every tool returns JSON in the first block (some are plain text/errors) — leave undefined.
  }
  return { isError, parsed, textBlocks, raw };
}
