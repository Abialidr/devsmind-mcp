import { connectMcpClient, McpTestHarness } from '../helpers/mcpClient';
import { buildRule, buildKickoffPrompt } from '../../src/cli/rule';
import { MEMORY_TOPICS, renderTopicFile, renderIndexLine, renderCombined } from '../../src/cli/integrations/memory-topics';
import { DEVSMIND_INSTRUCTIONS } from '../../src/mcp/server';
import { DevMindConfig } from '../../src/utils/config';

/**
 * The workflow contract is stated in three places that drift apart silently: the MCP server's
 * own tool schemas, the pasted workspace rule (`devsmind rule`), and the seeded agent memory
 * (`devsmind memory`). The server is authoritative — it's what actually rejects a bad call —
 * so these tests read the LIVE tool list off a real in-process server and assert the two
 * generated documents still match it. A tool renamed or a required param added in server.ts
 * fails here instead of silently teaching every agent a call that errors.
 */

const CONFIG: DevMindConfig = {
  project_name: 'sync-fixture',
  mode: 'standalone',
  tech_stack: { languages: ['TypeScript'], frameworks: ['NestJS'] },
  repos: [{ name: 'api', relative_path: './api' }],
  session_timeout_minutes: 60,
} as DevMindConfig;

const RULE_AUTOMATIC = buildRule(CONFIG, '/tmp/.devmind', 'automatic');
const RULE_MANUAL = buildRule(CONFIG, '/tmp/.devmind', 'manual');
const RULE_VARIANTS: [string, string][] = [['automatic', RULE_AUTOMATIC], ['manual', RULE_MANUAL]];

/**
 * Every tool the generated docs name explicitly — each must still exist on the server.
 * `get_node_graph`, `get_node_history`, `search_decisions`, `get_orphaned_nodes` are
 * deliberately NOT here: they're retired (unadvertised, folded into get_node_code/search_nodes/
 * analyze_graph — see server.ts's ListTools NOTE comments), so the docs must not reference them
 * as if they were still live tools either. Same for the retired workflow tools —
 * `workflow_pause`/`workflow_resume` (now `workflow_bind`), `workflow_get_steps` (now part of
 * `workflow_get_context`), `workflow_search` (now `workflow_list`'s `query`),
 * `workflow_add_artifact`/`workflow_read_artifact` (now `doc_paths`), and
 * `workflow_sync_retroactive` (now `workflow_sync`). `stage_change` was removed in 4.0.0
 * (folded into `edit_node`) and reinstated after — see the git history around this file if that
 * reads as a contradiction — with different semantics: it now catches up on an edit made WITHOUT
 * `edit_node` (traces + stages an already-on-disk change) rather than being a second way to make
 * one, so it belongs in this list again like any other live tool.
 */
const TOOLS_REFERENCED = [
  'start_session', 'search_nodes', 'list_nodes', 'get_node_code',
  'get_activity_log', 'edit_node', 'stage_change', 'add_description', 'add_feedback', 'commit_changes',
  'rename_node', 'deprecate_node', 'index_start', 'index_checkpoint', 'index_continue', 'index_complete',
  'analyze_graph', 'recheck_graph', 'get_visualizer_url',
  'read_graph_feedback', 'mark_graph_feedback_processed', 'flag_indexer_rule',
  'record_alias', 'link_nodes', 'merge_nodes', 'split_node', 'create_missing_node',
  'workflow_list', 'workflow_bind', 'workflow_get_context', 'workflow_add_step',
  'workflow_create', 'workflow_archive', 'workflow_sync', 'workflow_import',
];

/**
 * Tools that once existed and are now gone ENTIRELY — not merely unadvertised (like the
 * get_node_graph-style folds above, whose legacy handlers are deliberately retained). A mention
 * of one of these anywhere in the generated docs is pure drift: `TOOLS_REFERENCED`'s own
 * existence check is one-directional (it only checks names IN the list), so removing a retired
 * name from that list — the correct fix once a tool is gone — would otherwise make a leftover
 * mention invisible. This is the assertion that catches it. (`stage_change` is NOT here — see
 * the note on `TOOLS_REFERENCED` above; it's a live tool again, with different semantics.)
 */
const RETIRED_TOOL_NAMES: string[] = [];

describe('generated rule + memory stay in sync with the MCP server', () => {
  let harness: McpTestHarness;
  let toolNames: Set<string>;
  let required: Map<string, string[]>;

  beforeAll(async () => {
    harness = await connectMcpClient();
    const { tools } = await harness.client.listTools();
    toolNames = new Set(tools.map(t => t.name));
    required = new Map(
      tools.map(t => [t.name, ((t.inputSchema as { required?: string[] }).required ?? []).filter(p => p !== 'devmind_path')])
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  it('names only tools the server actually exposes', () => {
    expect([...TOOLS_REFERENCED].filter(name => !toolNames.has(name))).toEqual([]);
  });

  it('never names a retired tool in the rule, the memory bodies, the skill file, or the server instructions', () => {
    // renderCombined is what `devsmind skill` writes verbatim — a fourth generated-doc surface
    // that can drift, even though today it's built from the same MEMORY_TOPICS bodies already
    // checked above (defends against a future change to renderCombined itself, not just its inputs).
    const corpus = [
      RULE_AUTOMATIC, RULE_MANUAL, ...MEMORY_TOPICS.map(t => t.body), DEVSMIND_INSTRUCTIONS,
      renderCombined('<!-- header -->\n\n'),
    ].join('\n');
    for (const gone of RETIRED_TOOL_NAMES) {
      expect(corpus).not.toContain(gone);
    }
  });

  it('tells the AI commit_changes is NOT git, everywhere the contract lives', async () => {
    // Regression guard for a real incident: an agent ran an actual `git add`/`git commit` right
    // after calling commit_changes, unprompted — nothing in the contract ever said the two
    // "commit"s are unrelated, and commit_changes' required `message` param reads exactly like a
    // git commit message. Checked on the live tool schema too (not just the generated docs),
    // since an agent that only reads tool descriptions, never the rule, still needs to see this.
    for (const surface of [RULE_AUTOMATIC, RULE_MANUAL, DEVSMIND_INSTRUCTIONS]) {
      expect(surface.toLowerCase()).toContain('not git');
    }
    const commitTopic = MEMORY_TOPICS.find(t => t.name === 'devsmind-commit-changes-contract')!;
    expect(commitTopic.body.toLowerCase()).toContain('not git');

    const { tools } = await harness.client.listTools();
    const commitChangesTool = tools.find(t => t.name === 'commit_changes')!;
    expect((commitChangesTool.description || '').toLowerCase()).toContain('not git');
  });

  describe.each(RULE_VARIANTS)('rule (%s)', (_style, rule) => {
    it("states every param commit_changes rejects a call for", () => {
      // The breakage this guards: the rule listed only message + reasoning after `feedback`
      // became required, so an agent following it wrote a call the server refused outright.
      for (const param of required.get('commit_changes')!) {
        expect(rule).toContain(param);
      }
    });

    it('routes the always-relevant lookups', () => {
      for (const tool of ['start_session', 'search_nodes', 'get_node_code', 'get_activity_log', 'edit_node', 'commit_changes']) {
        expect(rule).toContain(tool);
      }
    });

    it('tells the agent search_nodes accepts a real regex pattern, not just a query', () => {
      // Neither `query` nor `pattern` is schema-required alone, so nothing fails loudly when the
      // agent passes only a vague query — the search just gets worse. That makes it exactly the
      // kind of guidance that rots unnoticed if the rule text drifts from the tool contract.
      expect(rule).toMatch(/pattern/);
    });

    it('keeps every Tool Triggers row a well-formed 2-cell markdown row', () => {
      // A literal `|` in a cell (even inside backticks) silently splits the table in every renderer.
      const rows = rule.split('\n').filter(l => l.startsWith('| '));
      expect(rows.length).toBeGreaterThan(5);
      for (const row of rows) {
        expect(row.split('|').filter(c => c.trim()).length).toBe(2);
      }
    });
  });

  it('kickoff prompt matches the same contract', () => {
    for (const style of ['automatic', 'manual'] as const) {
      const kickoff = buildKickoffPrompt(style);
      expect(kickoff).toContain('start_session');
      expect(kickoff).toContain('pattern');
    }
    // Only the automatic style ever commits unprompted, so only it owes the commit contract.
    expect(buildKickoffPrompt('automatic')).toContain('feedback');
  });

  describe('memory topics', () => {
    it('has a unique slug, title, description and hook per topic', () => {
      const names = MEMORY_TOPICS.map(t => t.name);
      expect(new Set(names).size).toBe(names.length);
      for (const t of MEMORY_TOPICS) {
        expect(t.name).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(t.title.length).toBeGreaterThan(0);
        // The description is what a file-per-fact store ranks on — an empty or stub one
        // means the file is written but never recalled.
        expect(t.description.length).toBeGreaterThan(20);
        expect(t.hook.length).toBeGreaterThan(0);
        expect(t.body.length).toBeGreaterThan(0);
      }
    });

    it('renders frontmatter a memory store can parse', () => {
      for (const t of MEMORY_TOPICS) {
        const file = renderTopicFile(t, '<!-- header -->\n\n');
        const [, frontmatter, ...rest] = file.split('---\n');
        expect(frontmatter).toContain(`name: ${t.name}`);
        expect(frontmatter).toContain(`description: ${t.description}`);
        expect(frontmatter).toContain(`type: ${t.type}`);
        expect(rest.join('---\n')).toContain('<!-- header -->');
        // A newline inside a scalar would break the YAML block.
        expect(t.description).not.toContain('\n');
      }
    });

    it('cross-links only slugs that exist', () => {
      const slugs = new Set(MEMORY_TOPICS.map(t => t.name));
      for (const t of MEMORY_TOPICS) {
        for (const [, slug] of t.body.matchAll(/\[\[([a-z0-9-]+)\]\]/g)) {
          expect(slugs).toContain(slug);
        }
      }
    });

    it('emits one index line per topic, pointing at its own file', () => {
      for (const t of MEMORY_TOPICS) {
        expect(renderIndexLine(t)).toBe(`- [${t.title}](${t.name}.md) — ${t.hook}`);
      }
    });

    it('flattens every topic and resolves cross-links in the combined render', () => {
      const combined = renderCombined('<!-- header -->\n\n');
      // Skill-style stores load one file — a [[slug]] link there points at nothing.
      expect(combined).not.toContain('[[');
      for (const t of MEMORY_TOPICS.slice(1)) {
        expect(combined).toContain(`### ${t.title}`);
      }
    });

    it('names only tools the server exposes', () => {
      const bodies = MEMORY_TOPICS.map(t => t.body).join('\n');
      for (const tool of TOOLS_REFERENCED) {
        if (bodies.includes(tool)) expect(toolNames).toContain(tool);
      }
      // And the contract-critical ones are actually covered, not just mentioned somewhere.
      for (const param of required.get('commit_changes')!) {
        expect(bodies).toContain(param);
      }
    });
  });
});
