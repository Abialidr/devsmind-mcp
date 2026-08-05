import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { connectMcpClient, callTool, callToolJson, McpTestHarness } from '../helpers/mcpClient';
import { makeFixture, Fixture, repoFile, stageAndCommit, defaultReasoning, defaultFeedback } from '../helpers/fixture';
import { DevMindDatabase, NO_STATIC_CALLERS_NOTE } from '../../src/db/database';
import { readProductFeedback } from '../../src/db/feedback';

/** Raw access to the live better-sqlite3 connection — `db` is `private` at the TS level only. */
function raw(db: DevMindDatabase) {
  return (db as any).db as import('better-sqlite3').Database;
}

/**
 * `updateHistory` merges any commit within 1 hour of the previous one into the SAME row (a
 * deliberate rule — see database.ts:1415-1462 — so an active editing session doesn't bloat into
 * one row per commit). Rapid-fire commits in a test all land inside that window, so without this,
 * a test doing several `stageAndCommit` calls in a row gets ONE merged history row, not several
 * distinct ones. Pushing the latest row's `updated_at` back outside the window forces the NEXT
 * commit to start a genuinely new row — the only way to build a real multi-revision fixture here.
 */
function ageOutLatestHistory(fx: Fixture, nodeId: string): void {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  raw(fx.db).prepare(
    `UPDATE history SET updated_at = ? WHERE id = (SELECT id FROM history WHERE node_id = ? ORDER BY updated_at DESC LIMIT 1)`
  ).run(twoHoursAgo, nodeId);
}

describe('MCP tools (in-process, real Server + Client over InMemoryTransport)', () => {
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

  describe('session_id gating', () => {
    it('start_session mints a session id with no session_id required', async () => {
      const { isError, parsed } = await callToolJson(harness.client, 'start_session', {
        devmind_path: fx.devmindPath
      });
      expect(isError).toBe(false);
      expect(parsed).toBeTruthy();
    });

    it('rejects a WRITE tool (edit_node) when session_id is omitted', async () => {
      let threw = false;
      let errorText = '';
      try {
        // Every required field EXCEPT session_id, so the ONLY thing missing is the session gate.
        // The gate runs BEFORE the tool switch, so the file is never actually written here.
        const { isError, textBlocks } = await callTool(harness.client, 'edit_node', {
          devmind_path: fx.devmindPath,
          file_path: repoFile(fx, 'foo.ts'),
          old_string: 'return format(name);',
          new_string: 'return format(name) + "!";'
        });
        threw = isError;
        errorText = textBlocks.join(' ');
      } catch (err) {
        // The SDK client may reject client-side against the tool's own advertised schema
        // (session_id was injected as required by the server's ListTools handler) before the
        // request ever reaches the server's own runtime check — either path proves the gate.
        threw = true;
        errorText = String((err as Error).message || err);
      }
      expect(threw).toBe(true);
      expect(errorText.toLowerCase()).toContain('session_id');
    });

    it('allows a read-only tool (list_nodes) with no session_id', async () => {
      const { isError } = await callTool(harness.client, 'list_nodes', {
        devmind_path: fx.devmindPath
      });
      expect(isError).toBe(false);
    });

    // The read/write session boundary, asserted explicitly rather than by importing the server's
    // own set (which would be tautological). These are the read-only tools that must NOT gate on
    // session_id; every OTHER advertised tool (the writes) must.
    //
    // get_node_history/get_node_graph/search_decisions/get_orphaned_nodes are retired (unadvertised
    // — see the 'retired tools' describe block below) but kept in this list anyway: the loop below
    // only iterates tools() from listTools(), which never includes them now, so their presence
    // here is inert — it just documents that their still-live retained handlers are reads, for
    // whoever next edits this list.
    // `workflow_list` is deliberately NOT exempt: it reports `bound_workflow_id`, which is a
    // per-session fact, so without a session it could only ever answer null — indistinguishable
    // from "you are on nothing".
    const SESSION_EXEMPT_READS = [
      'list_nodes', 'get_node_code', 'get_node_history', 'get_node_graph', 'search_nodes',
      'search_decisions', 'get_orphaned_nodes', 'get_visualizer_url', 'read_graph_feedback',
      'workflow_get_context', 'get_activity_log'
    ];

    it('write tools require session_id; read-only tools do not', async () => {
      const { tools } = await harness.client.listTools();
      expect(tools.length).toBeGreaterThan(30);
      for (const tool of tools) {
        if (tool.name === 'start_session') continue;
        const schema = tool.inputSchema as { required?: string[] };
        if (SESSION_EXEMPT_READS.includes(tool.name)) {
          expect(schema.required ?? []).not.toContain('session_id');
        } else {
          expect(schema.required).toContain('session_id');
        }
      }
    });

    it('accepts list_nodes once a real session_id is supplied', async () => {
      const { parsed: session } = await callToolJson(harness.client, 'start_session', {
        devmind_path: fx.devmindPath
      }) as { parsed: { session_id: string } };
      const { isError } = await callTool(harness.client, 'list_nodes', {
        devmind_path: fx.devmindPath,
        session_id: session.session_id
      });
      expect(isError).toBe(false);
    });
  });

  describe('retired tools (get_node_graph, get_node_history, search_decisions, get_orphaned_nodes)', () => {
    const RETIRED_TOOLS = ['get_node_graph', 'get_node_history', 'search_decisions', 'get_orphaned_nodes'];

    it('get_node_code advertises the merged params; the 4 retired tools are absent from listTools()', async () => {
      const { tools } = await harness.client.listTools();
      const names = new Set(tools.map(t => t.name));
      for (const retired of RETIRED_TOOLS) {
        expect(names.has(retired)).toBe(false);
      }

      const getNodeCode = tools.find(t => t.name === 'get_node_code')!;
      const schema = getNodeCode.inputSchema as { properties?: Record<string, unknown> };
      for (const param of ['neighbors_limit', 'neighbors_offset', 'graph_depth', 'graph_direction', 'graph_code', 'graph_code_budget', 'history', 'history_limit', 'history_offset', 'file_outline']) {
        expect(schema.properties).toHaveProperty(param);
      }
    });

    it('a direct/legacy call to each retired tool still succeeds without session_id — the handler is retained', async () => {
      await stageAndCommit(fx, [{ node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: 'export function greet() { return 1; }', name: 'greet', type: 'function' }]);

      const { isError: graphErr } = await callTool(harness.client, 'get_node_graph', {
        devmind_path: fx.devmindPath, node_id: '{app}/foo.ts#greet'
      });
      expect(graphErr).toBe(false);

      const { isError: historyErr } = await callTool(harness.client, 'get_node_history', {
        devmind_path: fx.devmindPath, node_id: '{app}/foo.ts#greet'
      });
      expect(historyErr).toBe(false);

      const { isError: decisionsErr } = await callTool(harness.client, 'search_decisions', {
        devmind_path: fx.devmindPath, query: 'anything'
      });
      expect(decisionsErr).toBe(false);

      const { isError: orphanedErr } = await callTool(harness.client, 'get_orphaned_nodes', {
        devmind_path: fx.devmindPath
      });
      expect(orphanedErr).toBe(false);
    });
  });

  describe('stage_change — removed, not retired (unlike the block above)', () => {
    it('is absent from listTools() and a direct/legacy call now errors — the handler itself was deleted, not just unadvertised', async () => {
      const { tools } = await harness.client.listTools();
      expect(tools.map(t => t.name)).not.toContain('stage_change');

      const { parsed: session } = await callToolJson(harness.client, 'start_session', {
        devmind_path: fx.devmindPath
      }) as { parsed: { session_id: string } };

      const { isError, textBlocks } = await callTool(harness.client, 'stage_change', {
        devmind_path: fx.devmindPath,
        session_id: session.session_id,
        node_id: 'wontWork',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: 'export function wontWork() { return 1; }'
      });
      expect(isError).toBe(true);
      expect(textBlocks.join(' ').toLowerCase()).toContain('tool not found');
    });
  });

  describe('one representative tool per functional area', () => {
    let sessionId: string;

    beforeEach(async () => {
      const { parsed } = await callToolJson(harness.client, 'start_session', {
        devmind_path: fx.devmindPath
      }) as { parsed: { session_id: string } };
      sessionId = parsed.session_id;
    });

    it('search_nodes (area E) returns the graph+files bucket shape, with true totals', async () => {
      const { isError, parsed } = await callToolJson(harness.client, 'search_nodes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        query: 'greeting helper function'
      }) as { isError: boolean; parsed: { nodes: unknown[]; files: unknown[]; files_total: number; nodes_total: number } };
      expect(isError).toBe(false);
      expect(Array.isArray(parsed.nodes)).toBe(true);
      expect(Array.isArray(parsed.files)).toBe(true);
      expect(typeof parsed.files_total).toBe('number');
      expect(typeof parsed.nodes_total).toBe('number');
    });

    it('search_nodes accepts pattern-only (no query) as a first-class precision mode over the wire', async () => {
      const { isError, parsed } = await callToolJson(harness.client, 'search_nodes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        pattern: 'greet|format'
      }) as { isError: boolean; parsed: { nodes: unknown[]; files: unknown[] } };
      expect(isError).toBe(false);
      expect(Array.isArray(parsed.nodes)).toBe(true);
      expect(Array.isArray(parsed.files)).toBe(true);
    });

    it('search_nodes rejects when neither query nor pattern is given', async () => {
      const { isError, textBlocks } = await callTool(harness.client, 'search_nodes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId
      });
      expect(isError).toBe(true);
      expect(textBlocks.join(' ')).toMatch(/requires at least one of/);
    });

    it('search_nodes advertises pattern/path/offset/limit and no longer advertises keywords/is_regex', async () => {
      const { tools } = await harness.client.listTools();
      const tool = tools.find(t => t.name === 'search_nodes')!;
      const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(schema.properties).toHaveProperty('pattern');
      expect(schema.properties).toHaveProperty('path');
      expect(schema.properties).toHaveProperty('offset');
      expect(schema.properties).toHaveProperty('limit');
      expect(schema.properties).not.toHaveProperty('keywords');
      expect(schema.properties).not.toHaveProperty('is_regex');
      // query is no longer required — only devmind_path/session_id are (search_nodes is read-only,
      // so session_id itself isn't required either; devmind_path is, in this unbound test server).
      expect(schema.required ?? []).not.toContain('query');
      expect(schema.properties).toHaveProperty('compact');
    });

    it('search_nodes clamps a non-numeric limit instead of returning an empty files bucket', async () => {
      // The failure this closes was maximally misleading: `Number('abc')` is NaN, `??` does not
      // catch NaN, and `slice(0, NaN)` returns [] — so the agent saw an empty `files` array next
      // to a non-zero `files_total`, which reads exactly like "grep found nothing".
      const { isError, parsed } = await callToolJson(harness.client, 'search_nodes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        pattern: 'greet|format',
        limit: 'abc'
      }) as { isError: boolean; parsed: { files: unknown[]; files_total: number; files_offset: number } };
      expect(isError).toBe(false);
      expect(parsed.files.length).toBe(Math.min(parsed.files_total, 25));
      expect(parsed.files_offset).toBe(0);
    });

    it('search_nodes clamps a negative offset and an oversized limit', async () => {
      const { isError, parsed } = await callToolJson(harness.client, 'search_nodes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        pattern: 'greet|format',
        offset: -5,
        limit: 100000
      }) as { isError: boolean; parsed: { files: unknown[]; files_offset: number } };
      expect(isError).toBe(false);
      // A negative offset used to slice from the END of the ranking.
      expect(parsed.files_offset).toBe(0);
      expect(parsed.files.length).toBeLessThanOrEqual(200);
    });

    it('search_nodes compact:true returns a triage-only shape that keeps every count exact', async () => {
      const { isError, parsed } = await callToolJson(harness.client, 'search_nodes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        query: 'greeting helper function',
        compact: true
      }) as {
        isError: boolean;
        parsed: {
          nodes: Record<string, unknown>[];
          files: Record<string, unknown>[];
          nodes_total: number;
          files_total: number;
          compacted?: string;
        };
      };
      expect(isError).toBe(false);
      expect(parsed.compacted).toBeTruthy();
      expect(typeof parsed.nodes_total).toBe('number');
      expect(typeof parsed.files_total).toBe('number');
      for (const n of parsed.nodes) {
        // Evidence lines are gone...
        expect(n.code_matches).toBeUndefined();
        expect(n.match_counts).toBeUndefined();
        // ...but the fields a caller actually triages and drills in on survive. A compact
        // response that dropped these would be smaller and useless at the same time.
        expect(n.confidence).toBeTruthy();
        expect(n).toHaveProperty('relevance');
        expect(Array.isArray(n.found_by)).toBe(true);
        expect(n).toHaveProperty('uses');
        expect(n).toHaveProperty('used_by');
        expect(n).toHaveProperty('history_count');
      }
      for (const f of parsed.files) {
        expect(f.sample_lines).toBeUndefined();
        expect(f.match_counts).toBeUndefined();
        expect(f).toHaveProperty('file_path');
      }
    });

    it('search_nodes auto-compacts an oversized result and says so, without touching the counts', async () => {
      // The real-world failure: a ~56KB payload exceeded the client's inline cap, spilled to a
      // file, and that file truncated on read too — leaving the agent hand-writing regexes against
      // a single-line JSON blob. Auto-compaction is the size guard for exactly that, and the
      // `compacted` field is what keeps it from being a silent substitution.
      const bigFiles: Record<string, string> = {};
      for (let i = 0; i < 30; i++) {
        bigFiles[`bulk/file${i}.css`] = Array.from({ length: 6 }, () => `needleToken ${'x'.repeat(500)}`).join('\n');
      }
      const bigFx = makeFixture({ skipDefaultFiles: true, extraFiles: bigFiles });
      try {
        const bigHarness = await connectMcpClient();
        try {
          const { parsed: session } = await callToolJson(bigHarness.client, 'start_session', { devmind_path: bigFx.devmindPath }) as { parsed: { session_id: string } };
          const { isError, parsed, textBlocks } = await callToolJson(bigHarness.client, 'search_nodes', {
            devmind_path: bigFx.devmindPath,
            session_id: session.session_id,
            pattern: 'needleToken'
          }) as {
            isError: boolean;
            textBlocks: string[];
            parsed: { files: Record<string, unknown>[]; files_total: number; compacted?: string };
          };

          expect(isError).toBe(false);
          expect(parsed.compacted).toBeTruthy();
          // The count is of ALL matching files, not of the page returned — trimming must never
          // make a partial result look complete.
          expect(parsed.files_total).toBe(30);
          expect(parsed.files.length).toBeGreaterThan(0);
          expect(parsed.files[0]).not.toHaveProperty('match_counts');
          // And it actually got smaller — the whole point.
          expect(textBlocks.join('').length).toBeLessThan(24_000);
        } finally {
          await bigHarness.close();
        }
      } finally {
        bigFx.cleanup();
      }
    });

    it('search_nodes compact:false returns the untrimmed payload even when it is oversized', async () => {
      const bigFiles: Record<string, string> = {};
      for (let i = 0; i < 30; i++) {
        bigFiles[`bulk/file${i}.css`] = Array.from({ length: 6 }, () => `needleToken ${'x'.repeat(500)}`).join('\n');
      }
      const bigFx = makeFixture({ skipDefaultFiles: true, extraFiles: bigFiles });
      try {
        const bigHarness = await connectMcpClient();
        try {
          const { parsed: session } = await callToolJson(bigHarness.client, 'start_session', { devmind_path: bigFx.devmindPath }) as { parsed: { session_id: string } };
          const { parsed, textBlocks } = await callToolJson(bigHarness.client, 'search_nodes', {
            devmind_path: bigFx.devmindPath,
            session_id: session.session_id,
            pattern: 'needleToken',
            compact: false
          }) as { textBlocks: string[]; parsed: { files: Record<string, unknown>[]; compacted?: string } };

          expect(parsed.compacted).toBeUndefined();
          expect(parsed.files[0]).toHaveProperty('match_counts');
          expect(textBlocks.join('').length).toBeGreaterThan(24_000);
        } finally {
          await bigHarness.close();
        }
      } finally {
        bigFx.cleanup();
      }
    });

    it('search_nodes leaves a small result untrimmed, with no compacted field', async () => {
      const { isError, parsed } = await callToolJson(harness.client, 'search_nodes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        query: 'greeting helper function'
      }) as { isError: boolean; parsed: { compacted?: string; nodes: Record<string, unknown>[] } };
      expect(isError).toBe(false);
      // Auto-compaction is a size guard, not a default — a fixture-sized result must come back
      // whole, or the escape hatch has quietly become the normal path.
      expect(parsed.compacted).toBeUndefined();
    });

    it('search_nodes leads each node with its trust signals, ahead of description — on BOTH match paths', async () => {
      // Ordering IS the fix here: the fields were always present, but landing after a full sentence
      // of description meant agents skipped them and triaged on node names instead. There are two
      // separate places a result node gets built — the exact-identifier short-circuit and the fused
      // ranker — and fixing only one would leave the two paths disagreeing about their own shape.
      await stageAndCommit(fx, [{
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: 'export function greet(name: string): string {\n  return `hi ${name}`;\n}',
        name: 'greet',
        type: 'function',
        description: 'Builds a friendly salutation string for a given user name.'
      }]);

      const assertTrustFirst = (node: Record<string, unknown>) => {
        const keys = Object.keys(node);
        expect(keys).toContain('confidence');
        expect(keys.indexOf('confidence')).toBeLessThan(keys.indexOf('description'));
        expect(keys.indexOf('relevance')).toBeLessThan(keys.indexOf('description'));
        expect(keys.indexOf('found_by')).toBeLessThan(keys.indexOf('description'));
      };

      // Exact identifier → the short-circuit path.
      const { parsed: byName } = await callToolJson(harness.client, 'search_nodes', {
        devmind_path: fx.devmindPath, session_id: sessionId, query: 'greet'
      }) as { parsed: { nodes: Record<string, unknown>[] } };
      expect(byName.nodes.length).toBeGreaterThan(0);
      expect(byName.nodes[0].matched_via).toBe('identifier');
      byName.nodes.forEach(assertTrustFirst);

      // A description phrase that is not an identifier → the fused ranker path.
      const { parsed: byPhrase } = await callToolJson(harness.client, 'search_nodes', {
        devmind_path: fx.devmindPath, session_id: sessionId, query: 'friendly salutation string'
      }) as { parsed: { nodes: Record<string, unknown>[] } };
      expect(byPhrase.nodes.length).toBeGreaterThan(0);
      expect(byPhrase.nodes[0].matched_via).not.toBe('identifier');
      byPhrase.nodes.forEach(assertTrustFirst);
    });

    it('list_nodes (area F) lists nodes with type/file filters', async () => {
      const { isError, parsed } = await callToolJson(harness.client, 'list_nodes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        type: 'function'
      });
      expect(isError).toBe(false);
      expect(parsed).toBeTruthy();
    });

    it('list_nodes pages instead of dumping the whole graph, and reports the true total', async () => {
      // This tool previously returned EVERY matching node with no bound at all — on a real backend
      // that was ~600KB in one response, which exceeded the client's inline limit, spilled to a
      // file, and truncated on read from there too. An enumeration call is precisely the one that
      // has to be paged: the reason you are asking is that you don't know how many there are.
      const many: Record<string, string> = {};
      for (let i = 0; i < 12; i++) {
        many[`mod${i}.ts`] = `export function fn${i}(): number {\n  return ${i};\n}\n`;
      }
      const listFx = makeFixture({ skipDefaultFiles: true, extraFiles: many });
      try {
        await stageAndCommit(listFx, Array.from({ length: 12 }, (_, i) => ({
          node_id: `fn${i}`,
          file_path: repoFile(listFx, `mod${i}.ts`),
          code_snapshot: `export function fn${i}(): number {\n  return ${i};\n}`,
          name: `fn${i}`,
          type: 'function'
        })));

        const listHarness = await connectMcpClient();
        try {
          const { parsed: session } = await callToolJson(listHarness.client, 'start_session', { devmind_path: listFx.devmindPath }) as { parsed: { session_id: string } };
          const page = (extra: Record<string, unknown>) => callToolJson(listHarness.client, 'list_nodes', {
            devmind_path: listFx.devmindPath,
            session_id: session.session_id,
            type: 'function',
            ...extra
          }) as Promise<{ parsed: { nodes: { id: string }[]; total: number; offset: number; truncated?: boolean; hint?: string } }>;

          const { parsed: first } = await page({ limit: 5 });
          expect(first.total).toBe(12);
          expect(first.nodes).toHaveLength(5);
          expect(first.offset).toBe(0);
          // A short page must never be readable as "that's everything".
          expect(first.truncated).toBe(true);
          expect(first.hint).toMatch(/offset:5/);

          const { parsed: second } = await page({ limit: 5, offset: 5 });
          expect(second.nodes).toHaveLength(5);
          // Stably ordered, so pages neither overlap nor skip.
          const overlap = second.nodes.filter(n => first.nodes.some(f => f.id === n.id));
          expect(overlap).toEqual([]);

          const { parsed: last } = await page({ limit: 5, offset: 10 });
          expect(last.nodes).toHaveLength(2);
          expect(last.truncated).toBeUndefined();
          expect(last.hint).toBeUndefined();

          // Defaults cover the whole fixture in one page, so nothing is flagged.
          const { parsed: all } = await page({});
          expect(all.nodes).toHaveLength(12);
          expect(all.truncated).toBeUndefined();
        } finally {
          await listHarness.close();
        }
      } finally {
        listFx.cleanup();
      }
    });

    it('list_nodes clamps limit/offset and advertises them', async () => {
      const { tools } = await harness.client.listTools();
      const schema = (tools.find(t => t.name === 'list_nodes')!.inputSchema) as { properties?: Record<string, unknown> };
      expect(schema.properties).toHaveProperty('limit');
      expect(schema.properties).toHaveProperty('offset');

      const { isError, parsed } = await callToolJson(harness.client, 'list_nodes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        limit: 'abc',
        offset: -3
      }) as { isError: boolean; parsed: { nodes: unknown[]; offset: number; total: number } };
      expect(isError).toBe(false);
      // NaN would have made `LIMIT NaN` return nothing while `total` said otherwise.
      expect(Array.isArray(parsed.nodes)).toBe(true);
      expect(parsed.offset).toBe(0);
      expect(parsed.nodes.length).toBe(Math.min(parsed.total, 100));
    });

    it('list_nodes trims an oversized page to identity fields and says so, keeping total exact', async () => {
      // The page limit bounds the node COUNT, not the byte size — a page of nodes with long
      // descriptions can still overflow. Same backstop and the same "say what you dropped"
      // contract as search_nodes.
      const heavy: Record<string, string> = {};
      for (let i = 0; i < 60; i++) {
        heavy[`big${i}.ts`] = `export function big${i}(): number {\n  return ${i};\n}\n`;
      }
      const heavyFx = makeFixture({ skipDefaultFiles: true, extraFiles: heavy });
      try {
        await stageAndCommit(heavyFx, Array.from({ length: 60 }, (_, i) => ({
          node_id: `big${i}`,
          file_path: repoFile(heavyFx, `big${i}.ts`),
          code_snapshot: `export function big${i}(): number {\n  return ${i};\n}`,
          name: `big${i}`,
          type: 'function',
          description: `Node ${i}. ${'A long human-written description of what this does. '.repeat(12)}`
        })));

        const heavyHarness = await connectMcpClient();
        try {
          const { parsed: session } = await callToolJson(heavyHarness.client, 'start_session', { devmind_path: heavyFx.devmindPath }) as { parsed: { session_id: string } };
          const { parsed, textBlocks } = await callToolJson(heavyHarness.client, 'list_nodes', {
            devmind_path: heavyFx.devmindPath,
            session_id: session.session_id,
            type: 'function',
            limit: 500
          }) as {
            textBlocks: string[];
            parsed: { nodes: Record<string, unknown>[]; total: number; compacted?: string };
          };

          expect(parsed.compacted).toBeTruthy();
          expect(parsed.total).toBe(60);
          expect(parsed.nodes[0]).toHaveProperty('id');
          expect(parsed.nodes[0]).toHaveProperty('file_path');
          expect(parsed.nodes[0]).not.toHaveProperty('description');
          expect(textBlocks.join('').length).toBeLessThan(24_000);
        } finally {
          await heavyHarness.close();
        }
      } finally {
        heavyFx.cleanup();
      }
    });

    it('get_node_graph (area F) traverses depth/direction on a nonexistent node without throwing', async () => {
      const { isError, parsed } = await callToolJson(harness.client, 'get_node_graph', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        node_id: '{app}/foo.ts#doesNotExist',
        max_depth: 2,
        direction: 'both'
      });
      // A nonexistent root is a valid, well-formed empty-ish result, not a crash.
      expect(isError).toBe(false);
      expect(parsed).toBeTruthy();
    });

    it("get_node_code returns imports, uses/used_by/history_count, and recent_history alongside the code — not just the bare function body", async () => {
      // foo.ts's default fixture content imports `format` from bar.ts and calls it inside
      // `greet` — committing both nodes lets commitStagedChanges auto-resolve the real edge
      // between them, so `uses` on greet is genuinely earned, not hand-inserted.
      await stageAndCommit(fx, [
        { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: 'export function format(s: string): string {\n  return "hi " + s;\n}\n', name: 'format', type: 'function' },
        { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: "import { format } from './bar';\n\nexport function greet(name: string): string {\n  return format(name);\n}\n", name: 'greet', type: 'function' }
      ]);

      const { isError, parsed } = await callToolJson(harness.client, 'get_node_code', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        node_id: '{app}/foo.ts#greet'
      }) as {
        isError: boolean;
        parsed: {
          exists: boolean;
          imports: Array<{ importedName: string; moduleSpecifier: string }>;
          uses: number;
          used_by: number;
          history_count: number;
          recent_history: Array<{ reasoning: unknown }>;
        };
      };

      expect(isError).toBe(false);
      expect(parsed.exists).toBe(true);
      expect(parsed.imports.some(i => i.importedName === 'format' && i.moduleSpecifier === './bar')).toBe(true);
      expect(parsed.uses).toBeGreaterThanOrEqual(1);
      expect(parsed.history_count).toBeGreaterThanOrEqual(1);
      expect(parsed.recent_history.length).toBeGreaterThanOrEqual(1);
      expect(parsed.recent_history.length).toBeLessThanOrEqual(3);
      // No code_snapshot on the summary entries — the code above already IS current; repeating it
      // per history entry would just duplicate what's already in the response.
      expect(parsed.recent_history[0]).not.toHaveProperty('code_snapshot');
      expect(parsed.recent_history[0]).not.toHaveProperty('edits');
    });

    it('get_node_code on a node with no history yet returns an empty recent_history, not an error', async () => {
      const nodeId = '{app}/foo.ts#greet';
      fx.db.upsertNode({ id: nodeId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });

      const { isError, parsed } = await callToolJson(harness.client, 'get_node_code', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        node_id: nodeId
      }) as { isError: boolean; parsed: { exists: boolean; history_count: number; recent_history: unknown[] } };

      expect(isError).toBe(false);
      expect(parsed.exists).toBe(true);
      expect(parsed.history_count).toBe(0);
      expect(parsed.recent_history).toEqual([]);
    });

    it('get_node_code (merged tool) returns name/type/signature/description, uses_nodes naming a real callee, and a file_outline naming a sibling but not itself', async () => {
      // outlineFile reads the REAL on-disk file (it's an AST-independent, DB-independent walk) —
      // code_snapshot alone (DB-only) would not put `helper` in front of it, so the fixture's
      // actual foo.ts has to contain it too.
      const fooContent = "import { format } from './bar';\n\nexport function greet(name: string): string {\n  return format(name);\n}\n\nexport function helper(): void {}\n";
      fs.writeFileSync(repoFile(fx, 'foo.ts'), fooContent);

      await stageAndCommit(fx, [
        { node_id: 'format', file_path: repoFile(fx, 'bar.ts'), code_snapshot: 'export function format(s: string): string {\n  return "hi " + s;\n}\n', name: 'format', type: 'function' },
        {
          node_id: 'greet',
          file_path: repoFile(fx, 'foo.ts'),
          code_snapshot: fooContent,
          name: 'greet',
          type: 'function',
          signature: 'greet(name: string): string',
          description: 'Greets a user by name using the format helper.'
        }
      ]);

      const { isError, parsed } = await callToolJson(harness.client, 'get_node_code', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        node_id: '{app}/foo.ts#greet'
      }) as {
        isError: boolean;
        parsed: {
          name: string;
          type: string;
          signature: string;
          description: string;
          uses_nodes: Array<{ node_id: string; name: string }>;
          used_by_nodes: Array<{ node_id: string; name: string }>;
          file_outline: Array<{ name: string; qualified: string; node_id?: string }>;
        };
      };

      expect(isError).toBe(false);
      expect(parsed.name).toBe('greet');
      expect(parsed.type).toBe('function');
      expect(parsed.signature).toBe('greet(name: string): string');
      expect(parsed.description).toContain('format helper');
      expect(parsed.uses_nodes.some(n => n.name === 'format')).toBe(true);
      // helper() is a real declaration in foo.ts that was never staged as its own node — the
      // outline should still name it (no node_id, since it's not indexed), and must not include
      // greet itself (that's the node the call is already about).
      const helperEntry = parsed.file_outline.find(e => e.qualified === 'helper');
      expect(helperEntry).toBeTruthy();
      expect(helperEntry!.node_id).toBeUndefined();
      expect(parsed.file_outline.some(e => e.qualified === 'greet')).toBe(false);
    });

    it('get_node_code carries used_by_note (shared with search_nodes) only when used_by is genuinely 0', async () => {
      await stageAndCommit(fx, [
        { node_id: 'lonely', file_path: repoFile(fx, 'foo.ts'), code_snapshot: 'export function lonely(): void {}\n', name: 'lonely', type: 'function' }
      ]);

      const { parsed } = await callToolJson(harness.client, 'get_node_code', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        node_id: '{app}/foo.ts#lonely'
      }) as { parsed: { used_by: number; used_by_note?: string } };

      expect(parsed.used_by).toBe(0);
      expect(parsed.used_by_note).toBe(NO_STATIC_CALLERS_NOTE);
    });

    it('get_node_code pages a hub node\'s callers: exact used_by count, a capped+truncated page, and a disjoint next page via neighbors_offset', async () => {
      await stageAndCommit(fx, [
        { node_id: 'hub', file_path: repoFile(fx, 'foo.ts'), code_snapshot: 'export function hub(): void {}\n', name: 'hub', type: 'function' }
      ]);
      const hubId = '{app}/foo.ts#hub';
      for (let i = 0; i < 30; i++) {
        const callerId = `{app}/callers.ts#caller${String(i).padStart(2, '0')}`;
        fx.db.upsertNode({ id: callerId, type: 'function', name: `caller${i}`, file_path: repoFile(fx, 'callers.ts') });
        fx.db.addConnection(callerId, hubId);
      }

      const { parsed: page1 } = await callToolJson(harness.client, 'get_node_code', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        node_id: hubId
      }) as { parsed: { used_by: number; used_by_nodes: Array<{ node_id: string }>; used_by_truncated?: boolean; used_by_hint?: string } };

      expect(page1.used_by).toBe(30);
      expect(page1.used_by_nodes).toHaveLength(20);
      expect(page1.used_by_truncated).toBe(true);
      expect(page1.used_by_hint).toContain('neighbors_offset');

      const { parsed: page2 } = await callToolJson(harness.client, 'get_node_code', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        node_id: hubId,
        neighbors_offset: 20
      }) as { parsed: { used_by_nodes: Array<{ node_id: string }>; used_by_truncated?: boolean } };

      expect(page2.used_by_nodes).toHaveLength(10);
      expect(page2.used_by_truncated).toBeUndefined();
      const page1Ids = new Set(page1.used_by_nodes.map(n => n.node_id));
      expect(page2.used_by_nodes.every(n => !page1Ids.has(n.node_id))).toBe(true);
    });

    it('get_node_code history modes: "full" adds full_history with snapshots+edits without displacing recent_history; "none" empties recent_history but keeps history_count', async () => {
      const nodeId = '{app}/foo.ts#greet';
      await stageAndCommit(fx, [{ node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: 'export function greet() { return 1; }', name: 'greet', type: 'function' }], { what_changed: 'v1', why: 'first', goal: 'test' });
      ageOutLatestHistory(fx, nodeId);
      await stageAndCommit(fx, [{ node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: 'export function greet() { return 2; }', name: 'greet', type: 'function' }], { what_changed: 'v2', why: 'second', goal: 'test' });

      const { parsed: full } = await callToolJson(harness.client, 'get_node_code', {
        devmind_path: fx.devmindPath, session_id: sessionId, node_id: nodeId, history: 'full'
      }) as { parsed: { history_count: number; recent_history: Array<Record<string, unknown>>; full_history: Array<{ code_snapshot: string; edits: unknown[] }> } };

      expect(full.history_count).toBe(2);
      expect(full.full_history).toHaveLength(2);
      expect(full.full_history[0].code_snapshot).toBeTruthy();
      expect(Array.isArray(full.full_history[0].edits)).toBe(true);
      expect(full.recent_history).toHaveLength(2);
      expect(full.recent_history[0]).not.toHaveProperty('code_snapshot');
      expect(full.recent_history[0]).not.toHaveProperty('edits');

      const { parsed: none } = await callToolJson(harness.client, 'get_node_code', {
        devmind_path: fx.devmindPath, session_id: sessionId, node_id: nodeId, history: 'none'
      }) as { parsed: { history_count: number; recent_history: unknown[]; full_history?: unknown } };

      expect(none.history_count).toBe(2);
      expect(none.recent_history).toEqual([]);
      expect(none.full_history).toBeUndefined();
    });

    it('get_node_code history_limit/history_offset page a 6-revision node without duplication or gaps', async () => {
      const nodeId = '{app}/foo.ts#greet';
      for (let i = 1; i <= 6; i++) {
        await stageAndCommit(fx, [{ node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: `export function greet() { return ${i}; }`, name: 'greet', type: 'function' }], { what_changed: `v${i}`, why: 'x', goal: 'test' });
        if (i < 6) ageOutLatestHistory(fx, nodeId);
      }

      const { parsed: page1 } = await callToolJson(harness.client, 'get_node_code', {
        devmind_path: fx.devmindPath, session_id: sessionId, node_id: nodeId, history: 'full', history_limit: 3, history_offset: 0
      }) as { parsed: { full_history: Array<{ id: string }>; history_truncated?: boolean } };
      const { parsed: page2 } = await callToolJson(harness.client, 'get_node_code', {
        devmind_path: fx.devmindPath, session_id: sessionId, node_id: nodeId, history: 'full', history_limit: 3, history_offset: 3
      }) as { parsed: { full_history: Array<{ id: string }>; history_truncated?: boolean } };

      expect(page1.full_history).toHaveLength(3);
      expect(page1.history_truncated).toBe(true);
      expect(page2.full_history).toHaveLength(3);
      expect(page2.history_truncated).toBeUndefined();
      const ids1 = new Set(page1.full_history.map(e => e.id));
      expect(page2.full_history.every(e => !ids1.has(e.id))).toBe(true);
    });

    it('get_node_code graph_depth/graph_direction walks the transitive graph and stamps depth, past the always-included direct neighbors', async () => {
      const chainFx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'foo.ts': "import { bar } from './bar';\n\nexport function foo(): number {\n  return bar();\n}\n",
          'bar.ts': "import { baz } from './baz';\n\nexport function bar(): number {\n  return baz();\n}\n",
          'baz.ts': 'export function baz(): number {\n  return 1;\n}\n'
        }
      });
      try {
        await stageAndCommit(chainFx, [
          { node_id: 'foo', file_path: repoFile(chainFx, 'foo.ts'), code_snapshot: 'export function foo(): number {\n  return bar();\n}', name: 'foo', type: 'function' },
          { node_id: 'bar', file_path: repoFile(chainFx, 'bar.ts'), code_snapshot: 'export function bar(): number {\n  return baz();\n}', name: 'bar', type: 'function' },
          { node_id: 'baz', file_path: repoFile(chainFx, 'baz.ts'), code_snapshot: 'export function baz(): number {\n  return 1;\n}', name: 'baz', type: 'function' }
        ]);

        const chainHarness = await connectMcpClient();
        try {
          const { parsed: session } = await callToolJson(chainHarness.client, 'start_session', { devmind_path: chainFx.devmindPath }) as { parsed: { session_id: string } };
          const { parsed } = await callToolJson(chainHarness.client, 'get_node_code', {
            devmind_path: chainFx.devmindPath,
            session_id: session.session_id,
            node_id: '{app}/foo.ts#foo',
            graph_depth: 2,
            graph_direction: 'out'
          }) as { parsed: { graph: { nodes: Array<{ id: string; depth?: number }> } } };

          const byId = new Map(parsed.graph.nodes.map(n => [n.id, n.depth]));
          expect(byId.get('{app}/foo.ts#foo')).toBe(0);
          expect(byId.get('{app}/bar.ts#bar')).toBe(1);
          expect(byId.get('{app}/baz.ts#baz')).toBe(2);
        } finally {
          await chainHarness.close();
        }
      } finally {
        chainFx.cleanup();
      }
    });

    it('get_node_code graph_code: an unparseable budget is clamped, not treated as unlimited; omitted nodes are named', async () => {
      const chainFx = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'foo.ts': "import { bar } from './bar';\n\nexport function foo(): number {\n  return bar();\n}\n",
          'bar.ts': "import { baz } from './baz';\n\nexport function bar(): number {\n  return baz();\n}\n",
          'baz.ts': 'export function baz(): number {\n  return 1;\n}\n'
        }
      });
      try {
        await stageAndCommit(chainFx, [
          { node_id: 'foo', file_path: repoFile(chainFx, 'foo.ts'), code_snapshot: 'export function foo(): number {\n  return bar();\n}', name: 'foo', type: 'function' },
          { node_id: 'bar', file_path: repoFile(chainFx, 'bar.ts'), code_snapshot: 'export function bar(): number {\n  return baz();\n}', name: 'bar', type: 'function' },
          { node_id: 'baz', file_path: repoFile(chainFx, 'baz.ts'), code_snapshot: 'export function baz(): number {\n  return 1;\n}', name: 'baz', type: 'function' }
        ]);

        const chainHarness = await connectMcpClient();
        try {
          const { parsed: session } = await callToolJson(chainHarness.client, 'start_session', { devmind_path: chainFx.devmindPath }) as { parsed: { session_id: string } };
          const call = (budget: unknown) => callToolJson(chainHarness.client, 'get_node_code', {
            devmind_path: chainFx.devmindPath,
            session_id: session.session_id,
            node_id: '{app}/foo.ts#foo',
            graph_depth: 2,
            graph_direction: 'out',
            graph_code: true,
            graph_code_budget: budget
          }) as Promise<{
            parsed: {
              code?: string;
              graph_code_hint?: string;
              graph: { nodes: Array<{ id: string; code?: string }>; code_omitted_node_ids?: string[] };
            };
          }>;

          // 'abc' → NaN, and `spent + len > NaN` is always false — which silently meant an
          // UNLIMITED budget, the exact opposite of what passing a budget asks for. Clamped, it
          // falls back to the default and behaves like any other ordinary call.
          const { parsed: bad } = await call('abc');
          expect(bad.graph.nodes.filter(n => n.code).length).toBeGreaterThan(0);
          expect(bad.graph.code_omitted_node_ids).toBeUndefined();

          // A budget too small for anything past the root: the dropped nodes are NAMED, so the
          // caller can fetch exactly those instead of guessing or re-running blind.
          const { parsed: tight } = await call(1);
          expect(tight.graph.code_omitted_node_ids).toEqual(['{app}/bar.ts#bar', '{app}/baz.ts#baz']);
          expect(tight.graph_code_hint).toMatch(/code_omitted_node_ids/);

          // The root's code is on `result.code` already; duplicating it inside the graph would
          // spend a chunk of the budget on a byte-identical copy.
          const rootInGraph = tight.graph.nodes.find(n => n.id === '{app}/foo.ts#foo')!;
          expect(rootInGraph.code).toBeUndefined();
          expect(tight.code).toContain('return bar()');
        } finally {
          await chainHarness.close();
        }
      } finally {
        chainFx.cleanup();
      }
    });

    it('get_node_code file_outline still lists what IS in the file for a source:"cached" node whose symbol was renamed out from under it', async () => {
      // A DB-only node pointing at foo.ts under a name that does NOT exist in the real file —
      // extractLiveCode fails to find it there, so getLiveCode falls back to the cached snapshot.
      // This is the highest-value outline case: "was this renamed?" without a raw file read.
      const staleSnapshot = 'export function renamedAwayFn() { return "stale"; }';
      await stageAndCommit(fx, [{ node_id: 'renamedAwayFn', file_path: repoFile(fx, 'foo.ts'), code_snapshot: staleSnapshot, name: 'renamedAwayFn', type: 'function' }]);

      const { parsed } = await callToolJson(harness.client, 'get_node_code', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        node_id: '{app}/foo.ts#renamedAwayFn'
      }) as { parsed: { code: string; file_outline: Array<{ qualified: string }> } };

      // Proves the cached path was taken: this text can only have come from the snapshot, since
      // "renamedAwayFn" does not appear anywhere in foo.ts's real, on-disk content.
      expect(parsed.code).toBe(staleSnapshot);
      // The outline reflects the ACTUAL file (greet/format from the default fixture), not the
      // stale node — this is what answers "was it renamed?" without opening the file.
      expect(parsed.file_outline.some(e => e.qualified === 'greet')).toBe(true);
    });

    it('get_node_code file_outline:false omits the key entirely', async () => {
      await stageAndCommit(fx, [{ node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: 'export function greet() { return 1; }', name: 'greet', type: 'function' }]);

      const { parsed } = await callToolJson(harness.client, 'get_node_code', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        node_id: '{app}/foo.ts#greet',
        file_outline: false
      }) as { parsed: Record<string, unknown> };

      expect('file_outline' in parsed).toBe(false);
    });

    it('add_feedback rejects a call with none of the five fields', async () => {
      const { isError, textBlocks } = await callTool(harness.client, 'add_feedback', {
        devmind_path: fx.devmindPath,
        session_id: sessionId
      });
      expect(isError).toBe(true);
      expect(textBlocks.join(' ')).toContain('at least one of');
    });

    it('add_feedback requires session_id (it is a WRITE, not session-exempt)', async () => {
      let threw = false;
      let errorText = '';
      try {
        const { isError, textBlocks } = await callTool(harness.client, 'add_feedback', {
          devmind_path: fx.devmindPath,
          tools_used: 'search_nodes found it in one call'
        });
        threw = isError;
        errorText = textBlocks.join(' ');
      } catch (err) {
        threw = true;
        errorText = String((err as Error).message || err);
      }
      expect(threw).toBe(true);
      expect(errorText.toLowerCase()).toContain('session_id');
    });

    it('add_feedback records tools_used/dropped_and_why/devsmind_better to the local product-feedback log', async () => {
      const { isError, parsed } = await callToolJson(harness.client, 'add_feedback', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        tools_used: 'get_node_code answered everything in one call',
        dropped_and_why: 'grepped node_modules once because search_nodes scopes to configured repos only',
        devsmind_better: 'wish file_outline showed decorators explicitly'
      }) as { isError: boolean; parsed: { recorded: string[] } };

      expect(isError).toBe(false);
      expect(parsed.recorded.sort()).toEqual(['devsmind_better', 'dropped_and_why', 'tools_used']);

      const entries = readProductFeedback(fx.devmindPath);
      expect(entries.some(e => e.category === 'tools_used' && e.text.includes('get_node_code'))).toBe(true);
      expect(entries.some(e => e.category === 'dropped_and_why' && e.text.includes('node_modules'))).toBe(true);
      expect(entries.some(e => e.category === 'devsmind_better' && e.text.includes('decorators'))).toBe(true);
      expect(entries.every(e => e.session_id === sessionId)).toBe(true);
    });

    it('add_feedback records a graph_problem with no evidence as "suspected", readable via read_graph_feedback', async () => {
      const { isError } = await callToolJson(harness.client, 'add_feedback', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        graph_problem: { text: 'this node looks stale, description does not match the code anymore' }
      });
      expect(isError).toBe(false);

      const { parsed } = await callToolJson(harness.client, 'read_graph_feedback', {
        devmind_path: fx.devmindPath, session_id: sessionId
      }) as { parsed: { clusters: Array<{ entries: Array<{ confidence: string; text: string }> }> } };
      const allEntries = parsed.clusters.flatMap(c => c.entries);
      expect(allEntries.some(e => e.confidence === 'suspected' && e.text.includes('stale'))).toBe(true);
    });

    it('add_feedback verifies evidence fresh at call time: a real file+snippet confirms, a fabricated one is rejected outright', async () => {
      const realSnippet = 'export function greet(name: string): string {';
      const confirmed = await callToolJson(harness.client, 'add_feedback', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        edge_problem: {
          text: 'format() really is called from greet(), 0 used_by was wrong',
          node_id: '{app}/bar.ts#format',
          evidence: { file: repoFile(fx, 'foo.ts'), snippet: realSnippet }
        }
      });
      expect(confirmed.isError).toBe(false);

      const { parsed } = await callToolJson(harness.client, 'read_graph_feedback', {
        devmind_path: fx.devmindPath, session_id: sessionId
      }) as { parsed: { clusters: Array<{ entries: Array<{ confidence: string; text: string }> }> } };
      const allEntries = parsed.clusters.flatMap(c => c.entries);
      expect(allEntries.some(e => e.confidence === 'confirmed' && e.text.includes('0 used_by was wrong'))).toBe(true);

      const rejected = await callTool(harness.client, 'add_feedback', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        edge_problem: {
          text: 'a fabricated claim',
          evidence: { file: repoFile(fx, 'foo.ts'), snippet: 'this exact text is not in the file anywhere' }
        }
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.textBlocks.join(' ')).toContain('evidence verification failed');
    });

    it('workflow_create (area M) starts and activates a workflow', async () => {
      const { isError, parsed } = await callToolJson(harness.client, 'workflow_create', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        name: 'Test Feature',
        description: 'A workflow created from an MCP tool test'
      }) as { isError: boolean; parsed: { id?: string; workflow_id?: string } };
      expect(isError).toBe(false);
      expect(parsed).toBeTruthy();
    });

    it('analyze_graph (area I) runs the zero-AI health check', async () => {
      const { isError, parsed } = await callToolJson(harness.client, 'analyze_graph', {
        devmind_path: fx.devmindPath,
        session_id: sessionId
      });
      expect(isError).toBe(false);
      expect(parsed).toBeTruthy();
    });

    it('get_visualizer_url (area N) returns a localhost URL with the devmind path encoded', async () => {
      const { isError, textBlocks } = await callTool(harness.client, 'get_visualizer_url', {
        devmind_path: fx.devmindPath,
        session_id: sessionId
      });
      expect(isError).toBe(false);
      const joined = textBlocks.join(' ');
      expect(joined).toContain('http://localhost:');
    });
  });

  describe('edit_node -> commit_changes working flow and gates (area G)', () => {
    let sessionId: string;

    beforeEach(async () => {
      const { parsed } = await callToolJson(harness.client, 'start_session', {
        devmind_path: fx.devmindPath
      }) as { parsed: { session_id: string } };
      sessionId = parsed.session_id;
    });

    /** edit_node's JSON block is NOT the first content block (a human-readable diff leads it),
     *  unlike every other tool here — so callToolJson (which only ever parses textBlocks[0])
     *  can't be used directly against it. */
    async function callEditNodeJson(client: Parameters<typeof callTool>[0], args: Record<string, unknown>) {
      const { isError, textBlocks } = await callTool(client, 'edit_node', args);
      const jsonBlock = textBlocks.find(b => b.trim().startsWith('{'));
      return { isError, parsed: jsonBlock ? JSON.parse(jsonBlock) : undefined, textBlocks };
    }

    it('edit_node writes the file to disk and stages the touched symbol', async () => {
      const filePath = repoFile(fx, 'bar.ts');
      const { isError, textBlocks } = await callTool(harness.client, 'edit_node', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        file_path: filePath,
        old_string: 'return "hi " + s;',
        new_string: 'return "hello " + s;',
        description: 'Formats a raw string into the "hello <value>" greeting format used across the app for testing.'
      });
      expect(isError).toBe(false);
      expect(textBlocks.join(' ')).toBeTruthy();

      const fs = require('fs');
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('hello ');
    });

    it('commit_changes rejects when message is missing', async () => {
      await callTool(harness.client, 'edit_node', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        file_path: repoFile(fx, 'newthing.ts'),
        old_string: '',
        new_string: 'export function newThing() { return 1; }\n',
        description: 'A trivial test function that returns the constant 1, used to exercise commit gating.'
      });

      const { isError, textBlocks } = await callTool(harness.client, 'commit_changes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        // message intentionally omitted
        reasoning: { what_changed: 'x', why: 'y', goal: 'z' },
        feedback: {
          graph_problems: 'none', edge_problems: 'none', tools_used: 'none',
          dropped_and_why: 'none', devsmind_better: 'none'
        }
      } as any);
      expect(isError).toBe(true);
      expect(textBlocks.join(' ').toLowerCase()).toContain('message');
    });

    it('commit_changes rejects when reasoning is missing', async () => {
      await callTool(harness.client, 'edit_node', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        file_path: repoFile(fx, 'anotherthing.ts'),
        old_string: '',
        new_string: 'export function anotherThing() { return 2; }\n',
        description: 'A trivial test function that returns the constant 2, used to exercise commit gating.'
      });

      const { isError, textBlocks } = await callTool(harness.client, 'commit_changes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        message: 'add anotherThing',
        feedback: {
          graph_problems: 'none', edge_problems: 'none', tools_used: 'none',
          dropped_and_why: 'none', devsmind_better: 'none'
        }
      } as any);
      expect(isError).toBe(true);
      expect(textBlocks.join(' ').toLowerCase()).toContain('reasoning');
    });

    it('commit_changes rejects when feedback is missing', async () => {
      await callTool(harness.client, 'edit_node', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        file_path: repoFile(fx, 'thirdthing.ts'),
        old_string: '',
        new_string: 'export function thirdThing() { return 3; }\n',
        description: 'A trivial test function that returns the constant 3, used to exercise commit gating.'
      });

      const { isError, textBlocks } = await callTool(harness.client, 'commit_changes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        message: 'add thirdThing',
        reasoning: { what_changed: 'x', why: 'y', goal: 'z' }
      } as any);
      expect(isError).toBe(true);
      expect(textBlocks.join(' ').toLowerCase()).toContain('feedback');
    });

    it('commit_changes rejects a brand-new node with no description', async () => {
      await callTool(harness.client, 'edit_node', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        file_path: repoFile(fx, 'nodescriptionthing.ts'),
        old_string: '',
        new_string: 'export function noDescriptionThing() { return 4; }\n'
        // description intentionally omitted — this node has never been described before.
      });

      const { isError, textBlocks } = await callTool(harness.client, 'commit_changes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        message: 'add noDescriptionThing',
        reasoning: { what_changed: 'x', why: 'y', goal: 'z' },
        feedback: {
          graph_problems: 'none', edge_problems: 'none', tools_used: 'none',
          dropped_and_why: 'none', devsmind_better: 'none'
        }
      });
      expect(isError).toBe(true);
      expect(textBlocks.join(' ').toLowerCase()).toContain('description');
    });

    it('commit_changes succeeds end-to-end with all gates satisfied', async () => {
      await callTool(harness.client, 'edit_node', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        file_path: repoFile(fx, 'fullygatedthing.ts'),
        old_string: '',
        new_string: 'export function fullyGatedThing() { return 5; }\n',
        description: 'A trivial test function returning the constant 5, used to prove the full commit gate succeeds.'
      });

      const { isError, parsed } = await callToolJson(harness.client, 'commit_changes', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        message: 'add fullyGatedThing',
        reasoning: { what_changed: 'added fullyGatedThing', why: 'test', goal: 'exercise the commit gate' },
        feedback: {
          graph_problems: 'none', edge_problems: 'none', tools_used: 'none',
          dropped_and_why: 'none', devsmind_better: 'none'
        }
      });
      expect(isError).toBe(false);
      expect(parsed).toBeTruthy();
    });

    it('commit_changes only commits/clears the calling session\'s own staged work, never another session\'s pending edits', async () => {
      // Reproduces the multi-session staging bug: two sessions pointed at the same .devmind
      // directory share one on-disk staging buffer. Session B stages a change but never commits
      // it. Session A must be able to stage and commit its OWN unrelated change without B's
      // still-pending entry being swept into A's commit (wrong reasoning attached to B's node) or
      // wiped from the buffer (B's work silently lost).
      const hB = await connectMcpClient();
      try {
        const { parsed: sB } = await callToolJson(hB.client, 'start_session', {
          devmind_path: fx.devmindPath
        }) as { parsed: { session_id: string } };

        // B writes to its OWN new file — edit_node writes to disk (unlike the old stage_change),
        // so B must never touch a file session A is about to edit in this same test.
        const bEdit = await callEditNodeJson(hB.client, {
          devmind_path: fx.devmindPath,
          session_id: sB.session_id,
          file_path: repoFile(fx, 'staysstagedforb.ts'),
          old_string: '',
          new_string: 'export function staysStagedForB() { return 99; }\n',
          description: 'Belongs to session B only — must not be pulled into session A\'s commit.'
        });
        const bNodeId = bEdit.parsed.touched[0].node_id as string;

        // Session A stages and commits its own change to a DIFFERENT, already-described node.
        await callTool(harness.client, 'edit_node', {
          devmind_path: fx.devmindPath,
          session_id: sessionId,
          file_path: repoFile(fx, 'bar.ts'),
          old_string: 'return "hi " + s;',
          new_string: 'return "yo " + s;',
          description: 'Formats a raw string into the "yo <value>" greeting format used for this test.'
        });
        const { parsed: commitA } = await callToolJson(harness.client, 'commit_changes', {
          devmind_path: fx.devmindPath,
          session_id: sessionId,
          message: 'session A change',
          reasoning: defaultReasoning({ what_changed: 'A\'s own change' }),
          feedback: defaultFeedback()
        }) as { parsed: { other_sessions_pending: number } };

        // A's commit sees B's entry pending but leaves it alone.
        expect(commitA.other_sessions_pending).toBe(1);
        expect(fx.db.getNode(bNodeId)).toBeNull();

        // B's own entry is still sitting in the shared buffer, untouched by A's commit — B can
        // commit it later and it still lands correctly, with B's own reasoning.
        const { parsed: commitB } = await callToolJson(hB.client, 'commit_changes', {
          devmind_path: fx.devmindPath,
          session_id: sB.session_id,
          message: 'session B change',
          reasoning: defaultReasoning({ what_changed: 'B\'s own change' }),
          feedback: defaultFeedback()
        }) as { parsed: { other_sessions_pending: number; nodes: number } };

        expect(commitB.other_sessions_pending).toBe(0);
        expect(commitB.nodes).toBe(1);
        expect(fx.db.getNode(bNodeId)).toBeTruthy();
      } finally {
        await hB.close();
      }
    });

    it('add_description refuses to write onto a node staged by another session, and still works on the caller\'s own', async () => {
      const hB = await connectMcpClient();
      try {
        const { parsed: sB } = await callToolJson(hB.client, 'start_session', {
          devmind_path: fx.devmindPath
        }) as { parsed: { session_id: string } };

        // Session B stages a brand-new node with no description yet, on its own file.
        const bEdit = await callEditNodeJson(hB.client, {
          devmind_path: fx.devmindPath,
          session_id: sB.session_id,
          file_path: repoFile(fx, 'bownsthisnode.ts'),
          old_string: '',
          new_string: 'export function bOwnsThisNode() { return 7; }\n'
          // description intentionally omitted.
        });
        const bNodeId = bEdit.parsed.touched[0].node_id as string;

        // Session A tries to describe B's staged node — must be refused, not silently applied.
        const { parsed: fromA } = await callToolJson(harness.client, 'add_description', {
          devmind_path: fx.devmindPath,
          session_id: sessionId,
          descriptions: [{
            node_id: bNodeId,
            description: 'An attempt from session A to describe session B\'s own staged node.'
          }]
        }) as { parsed: { described: boolean; results: { ok: boolean; error?: string }[] } };
        expect(fromA.described).toBe(false);
        expect(fromA.results[0].ok).toBe(false);
        expect(fromA.results[0].error?.toLowerCase()).toContain('another session');

        // Session B describing its OWN staged node still works as normal.
        const { parsed: fromB } = await callToolJson(hB.client, 'add_description', {
          devmind_path: fx.devmindPath,
          session_id: sB.session_id,
          descriptions: [{
            node_id: bNodeId,
            description: 'A trivial test function only session B staged and may describe.'
          }]
        }) as { parsed: { described: boolean; results: { ok: boolean; target: string }[] } };
        expect(fromB.described).toBe(true);
        expect(fromB.results[0].target).toBe('staged');

        // And A's earlier rejected attempt left B's staged description untouched by A entirely —
        // B's own commit now succeeds without needing to describe it again.
        const { parsed: commitB } = await callToolJson(hB.client, 'commit_changes', {
          devmind_path: fx.devmindPath,
          session_id: sB.session_id,
          message: 'session B adds bOwnsThisNode',
          reasoning: defaultReasoning({ what_changed: 'B added bOwnsThisNode' }),
          feedback: defaultFeedback()
        }) as { parsed: { nodes: number } };
        expect(commitB.nodes).toBe(1);
        expect(fx.db.getNode(bNodeId)).toBeTruthy();
      } finally {
        await hB.close();
      }
    });

    it('edit_node reports pending_count scoped to the calling session, not the whole shared buffer', async () => {
      const hB = await connectMcpClient();
      try {
        const { parsed: sB } = await callToolJson(hB.client, 'start_session', {
          devmind_path: fx.devmindPath
        }) as { parsed: { session_id: string } };

        // Session B stages one entry, on its own file, and never commits it.
        await callTool(hB.client, 'edit_node', {
          devmind_path: fx.devmindPath,
          session_id: sB.session_id,
          file_path: repoFile(fx, 'bstayspending.ts'),
          old_string: '',
          new_string: 'export function bStaysPending() { return 1; }\n',
          description: 'A trivial test function belonging only to session B\'s own pending work.'
        });

        // Session A stages its own, unrelated entry — pending_count must reflect only A's own
        // staged work (1), not the shared buffer's total (2).
        const stageA = await callEditNodeJson(harness.client, {
          devmind_path: fx.devmindPath,
          session_id: sessionId,
          file_path: repoFile(fx, 'astagesthis.ts'),
          old_string: '',
          new_string: 'export function aStagesThis() { return 2; }\n',
          description: 'A trivial test function belonging only to session A\'s own pending work.'
        });
        expect(stageA.parsed.pending_count).toBe(1);

        // A second, traced edit by session A must bring A's own pending_count to 2.
        const editA = await callEditNodeJson(harness.client, {
          devmind_path: fx.devmindPath,
          session_id: sessionId,
          file_path: repoFile(fx, 'bar.ts'),
          old_string: 'return "hi " + s;',
          new_string: 'return "yo " + s;',
          description: 'Formats a raw string into the "yo <value>" greeting format used for this test.'
        });
        expect(editA.parsed.pending_count).toBe(2); // A's first edit_node entry + this second one.
      } finally {
        await hB.close();
      }
    });

    it('edit_node rejects a file path outside every configured repo', async () => {
      const outsidePath = require('path').join(fx.root, 'outside.ts');
      require('fs').writeFileSync(outsidePath, 'export const x = 1;\n');

      const { isError, textBlocks } = await callTool(harness.client, 'edit_node', {
        devmind_path: fx.devmindPath,
        session_id: sessionId,
        file_path: outsidePath,
        old_string: 'export const x = 1;',
        new_string: 'export const x = 2;'
      });
      expect(isError).toBe(true);
      expect(textBlocks.join(' ')).toBeTruthy();
    });
  });

  describe('workflow — session binding, research steps, and retroactive sync', () => {
    /** Commits one traced edit through the real MCP path, so a workflow step is created the way it is in practice. */
    async function commitOnce(client: any, devmindPath: string, sid: string, file: string, from: string, to: string, request: string) {
      await callTool(client, 'edit_node', {
        devmind_path: devmindPath, session_id: sid, file_path: file, old_string: from, new_string: to,
        // A brand-new node has to be described before commit_changes will accept it.
        description: 'A small numeric helper used by the workflow binding tests.'
      });
      return callToolJson(client, 'commit_changes', {
        devmind_path: devmindPath,
        session_id: sid,
        message: request,
        reasoning: { what_changed: 'changed a thing', why: 'because it was wrong', goal: 'make it right' },
        feedback: { graph_problems: 'none', edge_problems: 'none', tools_used: 'none', dropped_and_why: 'none', devsmind_better: 'none' }
      });
    }

    it('two sessions bound to DIFFERENT workflows never write onto each other timeline', async () => {
      // This is the bug the whole rewrite exists for. There used to be ONE project-wide active
      // pointer, so session B binding a workflow silently paused session A's and A's next commit
      // landed on B's timeline — no error, and because the pointer was serialized into git, a
      // teammate could do it to you.
      const fx2 = makeFixture({
        skipDefaultFiles: true,
        extraFiles: {
          'a.ts': 'export function alpha(): number {\n  return 1;\n}\n',
          'b.ts': 'export function beta(): number {\n  return 2;\n}\n'
        }
      });
      try {
        const hA = await connectMcpClient();
        const hB = await connectMcpClient();
        try {
          const { parsed: sA } = await callToolJson(hA.client, 'start_session', { devmind_path: fx2.devmindPath }) as { parsed: { session_id: string } };
          const { parsed: sB } = await callToolJson(hB.client, 'start_session', { devmind_path: fx2.devmindPath }) as { parsed: { session_id: string } };

          const { parsed: wfA } = await callToolJson(hA.client, 'workflow_create', {
            devmind_path: fx2.devmindPath, session_id: sA.session_id, name: 'Alpha Thread', description: 'alpha work'
          }) as { parsed: { workflow: { id: string } } };
          const { parsed: wfB } = await callToolJson(hB.client, 'workflow_create', {
            devmind_path: fx2.devmindPath, session_id: sB.session_id, name: 'Beta Thread', description: 'beta work'
          }) as { parsed: { workflow: { id: string } } };

          await callTool(hA.client, 'workflow_bind', { devmind_path: fx2.devmindPath, session_id: sA.session_id, workflow_id: wfA.workflow.id });
          // B binds SECOND — under the old design this is the moment A silently lost its workflow.
          await callTool(hB.client, 'workflow_bind', { devmind_path: fx2.devmindPath, session_id: sB.session_id, workflow_id: wfB.workflow.id });

          await commitOnce(hA.client, fx2.devmindPath, sA.session_id, repoFile(fx2, 'a.ts'), 'return 1;', 'return 11;', 'alpha request');
          await commitOnce(hB.client, fx2.devmindPath, sB.session_id, repoFile(fx2, 'b.ts'), 'return 2;', 'return 22;', 'beta request');

          const read = async (client: any, sid: string, id: string) =>
            (await callToolJson(client, 'workflow_get_context', { devmind_path: fx2.devmindPath, session_id: sid, workflow_id: id })) as
              { parsed: { steps: { summary: string; session_id: string | null; node_ids: string | null }[] } };

          const { parsed: ctxA } = await read(hA.client, sA.session_id, wfA.workflow.id);
          const { parsed: ctxB } = await read(hB.client, sB.session_id, wfB.workflow.id);

          expect(ctxA.steps).toHaveLength(1);
          expect(ctxB.steps).toHaveLength(1);
          // Each step is attributed to the session that actually made it — a column that existed
          // all along and was never populated on the path that creates nearly every step.
          expect(ctxA.steps[0].session_id).toBe(sA.session_id);
          expect(ctxB.steps[0].session_id).toBe(sB.session_id);
          // And each touched only its own file's node.
          expect(JSON.parse(ctxA.steps[0].node_ids!).join()).toContain('a.ts');
          expect(JSON.parse(ctxB.steps[0].node_ids!).join()).toContain('b.ts');
        } finally {
          await hA.close();
          await hB.close();
        }
      } finally {
        fx2.cleanup();
      }
    });

    it('commit_changes records a step only while bound, and stops when unbound', async () => {
      const fx2 = makeFixture({ skipDefaultFiles: true, extraFiles: { 'a.ts': 'export function alpha(): number {\n  return 1;\n}\n' } });
      try {
        const h = await connectMcpClient();
        try {
          const { parsed: s } = await callToolJson(h.client, 'start_session', { devmind_path: fx2.devmindPath }) as { parsed: { session_id: string } };
          const { parsed: wf } = await callToolJson(h.client, 'workflow_create', {
            devmind_path: fx2.devmindPath, session_id: s.session_id, name: 'Thread', description: 'x'
          }) as { parsed: { workflow: { id: string } } };

          // Unbound: nothing is recorded.
          const { parsed: before } = await commitOnce(h.client, fx2.devmindPath, s.session_id, repoFile(fx2, 'a.ts'), 'return 1;', 'return 2;', 'first request') as { parsed: { workflow_step_id: string | null } };
          expect(before.workflow_step_id).toBeNull();

          await callTool(h.client, 'workflow_bind', { devmind_path: fx2.devmindPath, session_id: s.session_id, workflow_id: wf.workflow.id });
          const { parsed: during } = await commitOnce(h.client, fx2.devmindPath, s.session_id, repoFile(fx2, 'a.ts'), 'return 2;', 'return 3;', 'second request') as { parsed: { workflow_step_id: string | null } };
          expect(during.workflow_step_id).toBeTruthy();

          // Unbind, and it stops again — the whole point of being able to step away mid-session.
          await callTool(h.client, 'workflow_bind', { devmind_path: fx2.devmindPath, session_id: s.session_id });
          const { parsed: after } = await commitOnce(h.client, fx2.devmindPath, s.session_id, repoFile(fx2, 'a.ts'), 'return 3;', 'return 4;', 'third request') as { parsed: { workflow_step_id: string | null } };
          expect(after.workflow_step_id).toBeNull();

          const { parsed: ctx } = await callToolJson(h.client, 'workflow_get_context', {
            devmind_path: fx2.devmindPath, session_id: s.session_id, workflow_id: wf.workflow.id
          }) as { parsed: { steps: { reasoning: string | null }[]; steps_total: number } };
          expect(ctx.steps_total).toBe(1);
          // The reasoning carried onto the step is the WHY, not the eight-label formatReasoning
          // dump — no empty Requirement:/Previous state:, no Developer/Model repeated per step.
          expect(ctx.steps[0].reasoning).toContain('because it was wrong');
          expect(ctx.steps[0].reasoning).not.toContain('Model:');
        } finally {
          await h.close();
        }
      } finally {
        fx2.cleanup();
      }
    });

    it('workflow_add_step records a research finding with no code, and validates doc_paths', async () => {
      const fx2 = makeFixture({ skipDefaultFiles: true, extraFiles: { 'docs/spec.md': '# Spec\n' } });
      try {
        const h = await connectMcpClient();
        try {
          const { parsed: s } = await callToolJson(h.client, 'start_session', { devmind_path: fx2.devmindPath }) as { parsed: { session_id: string } };
          const { parsed: wf } = await callToolJson(h.client, 'workflow_create', {
            devmind_path: fx2.devmindPath, session_id: s.session_id, name: 'Payments', description: 'x'
          }) as { parsed: { workflow: { id: string } } };
          await callTool(h.client, 'workflow_bind', { devmind_path: fx2.devmindPath, session_id: s.session_id, workflow_id: wf.workflow.id });

          const { isError, parsed } = await callToolJson(h.client, 'workflow_add_step', {
            devmind_path: fx2.devmindPath,
            session_id: s.session_id,
            summary: 'Chose Stripe over Razorpay',
            reasoning: 'Razorpay has no split settlements, which marketplace payouts need.',
            // Absolute or workspace-relative, same as edit_node's file_path — it comes back
            // normalized to a repo-relative path, which is what a teammate can actually resolve.
            doc_paths: [repoFile(fx2, 'docs/spec.md')]
          }) as { isError: boolean; parsed: { step: { node_ids: string | null; doc_paths: string | null; reasoning: string } } };

          expect(isError).toBe(false);
          // A research step touches no code at all — the case nothing else in DevsMind records.
          expect(parsed.step.node_ids).toBeNull();
          expect(JSON.parse(parsed.step.doc_paths!)[0].replace(/\\/g, '/')).toContain('docs/spec.md');
          expect(parsed.step.reasoning).toContain('split settlements');

          // A path outside the repo is refused, not stored: it would resolve to nothing on a
          // teammate's machine, and steps are committed and read by the whole team.
          const outside = await callTool(h.client, 'workflow_add_step', {
            devmind_path: fx2.devmindPath, session_id: s.session_id, summary: 's', doc_paths: [path.join(os.tmpdir(), 'elsewhere.md')]
          });
          expect(outside.isError).toBe(true);
          expect(outside.textBlocks.join(' ')).toMatch(/outside this project/);

          // So is a path that does not exist.
          const missing = await callTool(h.client, 'workflow_add_step', {
            devmind_path: fx2.devmindPath, session_id: s.session_id, summary: 's', doc_paths: [repoFile(fx2, 'docs/nope.md')]
          });
          expect(missing.isError).toBe(true);
          expect(missing.textBlocks.join(' ')).toMatch(/does not exist/);
        } finally {
          await h.close();
        }
      } finally {
        fx2.cleanup();
      }
    });

    it('workflow_sync previews before writing, then attaches once and is a no-op on re-run', async () => {
      const fx2 = makeFixture({ skipDefaultFiles: true, extraFiles: { 'a.ts': 'export function alpha(): number {\n  return 1;\n}\n' } });
      try {
        const h = await connectMcpClient();
        try {
          const { parsed: s } = await callToolJson(h.client, 'start_session', { devmind_path: fx2.devmindPath }) as { parsed: { session_id: string } };
          const { parsed: wf } = await callToolJson(h.client, 'workflow_create', {
            devmind_path: fx2.devmindPath, session_id: s.session_id, name: 'Thread', description: 'x'
          }) as { parsed: { workflow: { id: string } } };

          // One commit made while BOUND (auto-recorded), then one while UNBOUND. Sync must offer
          // only the second: work that commit_changes already attached must not be proposed again,
          // or a well-meaning sync silently doubles every step already on the timeline.
          await callTool(h.client, 'workflow_bind', { devmind_path: fx2.devmindPath, session_id: s.session_id, workflow_id: wf.workflow.id });
          await commitOnce(h.client, fx2.devmindPath, s.session_id, repoFile(fx2, 'a.ts'), 'return 1;', 'return 2;', 'the recorded request');
          await callTool(h.client, 'workflow_bind', { devmind_path: fx2.devmindPath, session_id: s.session_id });
          await commitOnce(h.client, fx2.devmindPath, s.session_id, repoFile(fx2, 'a.ts'), 'return 2;', 'return 3;', 'the forgotten request');

          const syncArgs = { devmind_path: fx2.devmindPath, session_id: s.session_id, workflow_id: wf.workflow.id };

          // Dry run by default: proposes, writes nothing.
          const { parsed: preview } = await callToolJson(h.client, 'workflow_sync', syncArgs) as
            { parsed: { status: string; proposed_steps: { summary: string; node_ids: string[] }[] } };
          expect(preview.status).toBe('proposed');
          // Exactly one — the unbound commit. The bound one is already on the timeline.
          expect(preview.proposed_steps).toHaveLength(1);
          expect(preview.proposed_steps[0].summary).toBeTruthy();
          const { parsed: beforeWrite } = await callToolJson(h.client, 'workflow_get_context', { ...syncArgs }) as { parsed: { steps_total: number } };
          expect(beforeWrite.steps_total).toBe(1);

          // Confirmed: writes exactly once.
          const { parsed: applied } = await callToolJson(h.client, 'workflow_sync', { ...syncArgs, confirm: true }) as { parsed: { status: string; steps_added: number } };
          expect(applied.status).toBe('synced');
          expect(applied.steps_added).toBe(1);

          // Re-running changes nothing — dedupe is by consumed EDIT ids, so a message that keeps
          // growing after being synced can still contribute later, but nothing is ever doubled.
          const { parsed: again } = await callToolJson(h.client, 'workflow_sync', { ...syncArgs, confirm: true }) as { parsed: { status: string } };
          expect(again.status).toBe('nothing_to_sync');
          const { parsed: final } = await callToolJson(h.client, 'workflow_get_context', { ...syncArgs }) as { parsed: { steps_total: number } };
          expect(final.steps_total).toBe(2);
        } finally {
          await h.close();
        }
      } finally {
        fx2.cleanup();
      }
    });

    it('start_session offers a resumable workflow only when there is one', async () => {
      const fx2 = makeFixture({ skipDefaultFiles: true });
      try {
        const h = await connectMcpClient();
        try {
          // Nothing bound anywhere yet: the response must not raise workflows at all, or every
          // ordinary session pays for a question that has no answer.
          const { parsed: first } = await callToolJson(h.client, 'start_session', { devmind_path: fx2.devmindPath }) as
            { parsed: { session_id: string; resumable_workflow?: unknown } };
          expect(first.resumable_workflow).toBeUndefined();

          const { parsed: wf } = await callToolJson(h.client, 'workflow_create', {
            devmind_path: fx2.devmindPath, session_id: first.session_id, name: 'Wallet Integration', description: 'x'
          }) as { parsed: { workflow: { id: string } } };
          await callTool(h.client, 'workflow_bind', { devmind_path: fx2.devmindPath, session_id: first.session_id, workflow_id: wf.workflow.id });

          const h2 = await connectMcpClient();
          try {
            const { parsed: next } = await callToolJson(h2.client, 'start_session', { devmind_path: fx2.devmindPath }) as
              { parsed: { resumable_workflow?: { id: string; name: string } } };
            expect(next.resumable_workflow?.id).toBe(wf.workflow.id);
            expect(next.resumable_workflow?.name).toBe('Wallet Integration');
          } finally {
            await h2.close();
          }

          // An archived workflow is not offered — retiring it has to actually stop it surfacing.
          await callTool(h.client, 'workflow_archive', { devmind_path: fx2.devmindPath, session_id: first.session_id, workflow_id: wf.workflow.id });
          const h3 = await connectMcpClient();
          try {
            const { parsed: afterArchive } = await callToolJson(h3.client, 'start_session', { devmind_path: fx2.devmindPath }) as
              { parsed: { resumable_workflow?: unknown } };
            expect(afterArchive.resumable_workflow).toBeUndefined();
          } finally {
            await h3.close();
          }
        } finally {
          await h.close();
        }
      } finally {
        fx2.cleanup();
      }
    });

    it('advertises 7 workflow tools and none of the retired ones', async () => {
      const { tools } = await harness.client.listTools();
      const names = tools.map(t => t.name).filter(n => n.startsWith('workflow_')).sort();
      expect(names).toEqual([
        'workflow_add_step', 'workflow_archive', 'workflow_bind', 'workflow_create',
        'workflow_get_context', 'workflow_import', 'workflow_list', 'workflow_sync'
      ].sort());
      for (const gone of ['workflow_pause', 'workflow_resume', 'workflow_get_steps', 'workflow_search', 'workflow_add_artifact', 'workflow_read_artifact', 'workflow_sync_retroactive']) {
        expect(names).not.toContain(gone);
      }
    });

    it('workflow_pause/workflow_resume still answer, as binding aliases', async () => {
      // Retained so a legacy caller is not left with a hard failure — but they bind THIS session
      // now. Their old meaning (move one shared pointer, pausing whoever held it) could not be
      // reproduced without reintroducing the bug this change removed.
      const fx2 = makeFixture({ skipDefaultFiles: true });
      try {
        const h = await connectMcpClient();
        try {
          const { parsed: s } = await callToolJson(h.client, 'start_session', { devmind_path: fx2.devmindPath }) as { parsed: { session_id: string } };
          const { parsed: wf } = await callToolJson(h.client, 'workflow_create', {
            devmind_path: fx2.devmindPath, session_id: s.session_id, name: 'Legacy', description: 'x'
          }) as { parsed: { workflow: { id: string } } };

          const resumed = await callToolJson(h.client, 'workflow_resume', {
            devmind_path: fx2.devmindPath, session_id: s.session_id, workflow_id: wf.workflow.id
          }) as { isError: boolean; parsed: { status: string } };
          expect(resumed.isError).toBe(false);
          expect(resumed.parsed.status).toBe('bound');

          const paused = await callToolJson(h.client, 'workflow_pause', { devmind_path: fx2.devmindPath, session_id: s.session_id }) as
            { isError: boolean; parsed: { status: string } };
          expect(paused.isError).toBe(false);
          expect(paused.parsed.status).toBe('unbound');
        } finally {
          await h.close();
        }
      } finally {
        fx2.cleanup();
      }
    });
  });
});
