import { DEVSMIND_INSTRUCTIONS } from '../../mcp/server';
import { IdeTarget } from './registry';

/**
 * The DevsMind workflow contract, split into one fact per topic.
 *
 * `devsmind memory` no longer writes any of this to a file — see `renderMemoryPrompt` at the
 * bottom of this file for what it prints instead, and its own doc comment for why. Research
 * across every tool DevsMind integrates with turned up the same finding independently, stated in
 * several of those tools' own docs: background/automatic memory is discretionary by design, and
 * an explicit in-chat "remember this" is the one thing that reliably lands. Writing a file never
 * crosses that trigger at all — several tools (Cursor, Windsurf, Kiro) don't even have a safe
 * file to write to in the first place.
 *
 * This catalog is kept as the canonical, structured breakdown of the contract — reference
 * material and a record of what each fact is FOR, in case a genuinely safe per-tool write target
 * ever shows up again. `renderMemoryPrompt` deliberately does not flatten all of it into the
 * paste-able prompt: a short, human-readable ask beats a wall of reference docs for something
 * meant to be read and acted on by another AI in one sitting.
 */
export interface MemoryTopic {
  /** Slug — also the filename (`<name>.md`) in a file-per-fact store. */
  name: string;
  /** Human title, used as the index-line label and the combined-render heading. */
  title: string;
  /** One line. This is what a memory store matches on to decide relevance — write it as the trigger, not a summary. */
  description: string;
  /** Short hook for the index line, after the em dash. */
  hook: string;
  /** Claude Code memory taxonomy. `feedback` = how to work; `reference` = pointers/surface area. */
  type: 'feedback' | 'reference' | 'project';
  /** Markdown body. May link sibling topics with [[slug]] — resolved to titles in the combined render. */
  body: string;
}

export const MEMORY_TOPICS: MemoryTopic[] = [
  {
    name: 'devsmind',
    title: 'DevsMind workflow contract',
    description: 'The cross-cutting DevsMind workflow — read before any code search, edit, or commit in a project with the DevsMind MCP server.',
    hook: 'the full contract: session, search, edit, record.',
    type: 'feedback',
    body: DEVSMIND_INSTRUCTIONS,
  },
  {
    name: 'devsmind-edit-node-always',
    title: 'Always write with edit_node',
    description: 'Write every file with DevsMind edit_node — never the built-in Edit/Write tools. If one already got used by mistake, stage_change recovers it.',
    hook: 'every file, every extension; never the built-in Edit/Write. stage_change recovers a miss.',
    type: 'feedback',
    body: [
      '`edit_node` is the write path for **every** file, whatever the extension. Never use your own edit/write tool. Params: `file_path` + `old_string` + `new_string`; to create a file pass `old_string: ""` and the whole file as `new_string`. If the edit creates exactly ONE new function/class, pass `description` in the same call ([[devsmind-commit-changes-contract]] refuses an undescribed new node).',
      '',
      '**Why:** it traces where the text landed to the real function/class, stages it, and answers with its callers; a plain edit tool records nothing. Writes outside any function (markup, config, imports) get no graph node, which is expected; the whole-file change is still staged.',
      '',
      '**How to apply:** if a file already got edited WITHOUT it, call `stage_change` (same shape): it traces and stages the change already on disk without rewriting the file, and fails clearly if `new_string` is not found. It only recovers a miss; it is never a second way to edit.',
    ].join('\n'),
  },
  {
    name: 'devsmind-start-session-first',
    title: 'start_session first',
    description: 'Call start_session before your first WRITE — session_id is required on every write, but read-only tools do NOT need one.',
    hook: 'session_id is required on every DevsMind WRITE; reads (search_nodes, get_node_code, get_activity_log, etc.) do not need one.',
    type: 'feedback',
    body: [
      '`start_session` mints a `session_id` that every WRITE tool (`edit_node`, `commit_changes`, the other mutating calls) REQUIRES. Read-only tools (`search_nodes`, `get_node_code`, `list_nodes`, `get_activity_log`, the other getters) do NOT: search and read freely before it has run. Never invent an id; on a resumed conversation reuse the earlier one.',
      '',
      "**Why:** a session ties a request's writes together on the local Activity log so it can be reverted as a unit. Reads mutate nothing, so gating them only adds friction.",
      '',
      '**How to apply:** if a write errors saying `session_id` is required, call `start_session` and retry. `get_activity_log` takes `session_id` only as an optional filter: omit it unless you want one session, or you silently narrow a broad query.',
    ].join('\n'),
  },
  {
    name: 'devsmind-search-nodes-before-grep',
    title: 'search_nodes before grep',
    description: 'Find code with search_nodes (query and/or pattern, a real regex) instead of grep or reading files — it covers the graph AND a real file grep.',
    hook: 'query and/or pattern (a real regex); covers graph + file grep.',
    type: 'feedback',
    body: [
      '`search_nodes` is the one search call: it covers the indexed graph AND the raw filesystem, so no external grep is needed. Pass `query` (natural language; drives meaning-matching) and/or `pattern` (a REAL regex, used exactly as you would give grep, not re-escaped). Pattern-only is a precision mode: exact grep + code-body matches. Your knowledge of identifiers, error strings and config keys makes a better pattern than any query.',
      '',
      'It returns `nodes` (primary; each leads with `confidence`, `relevance`, `found_by`; `nodes_total` is the true count before the top-20 cap) and `files` (a real grep of every repo for what the graph does not model: CSS, JSON, `.env`, markup, wiring; sample lines name the enclosing function; `files_total` is exact and `offset` pages).',
      '',
      '**Why:** empty buckets plus a `hint` mean it genuinely is not there; it never pads with guesses. Triage on `confidence`, not on a plausible-looking name: it is corroboration across independent layers, which you cannot reconstruct by eye. `used_by: 0` with a `used_by_note` means unverified, not dead.',
      '',
      '**How to apply:** search before any grep or file read; retry once with a different query/pattern before concluding absence; fall back to a manual grep only if the response says `truncated: true`. Lockfiles and build artifacts are excluded by default (config, JSON, `.env` are not). A `compacted` field names what was trimmed; `compact:false` returns all. Next: [[devsmind-get-node-graph]] for blast radius.',
    ].join('\n'),
  },
  {
    name: 'devsmind-get-node-graph',
    title: 'get_node_code graph params for callers and flows',
    description: 'Before changing a signature or tracing a feature end to end, pass graph_depth/graph_direction on get_node_code — "in" for the full caller blast radius, "out" + graph_code for a whole call flow.',
    hook: 'graph_direction:"in" for blast radius, "out"+graph_code for a whole flow, in the SAME get_node_code call.',
    type: 'feedback',
    body: [
      '`get_node_code` already includes direct callers/callees by name on every call. `graph_depth` + `graph_direction` walk the transitive graph in that same call:',
      '- `graph_depth: 2-3` + `graph_direction: "in"`: the full caller blast radius. Use BEFORE changing any signature or behaviour.',
      '- `graph_depth: 3` + `graph_direction: "out"` + `graph_code: true`: the node plus everything it transitively calls, with source, in ONE call. Use it to trace a request or feature end to end.',
      '',
      '**Why:** git shows what changed, never what depends on it, and one call replaces a long chain of per-function fetches.',
      '',
      '**How to apply:** never chain per-function fetches. If `graph.code_truncated: true`, `graph.code_omitted_node_ids` names nodes whose code did not fit (fetch exactly those or raise `graph_code_budget`), while `graph.nodes_no_code_available` counts nodes whose source is genuinely missing (a bigger budget will not help). `graph.nodes_truncated: true` means the walk hit its 120-node cap. See [[devsmind-search-nodes-before-grep]] and [[devsmind-get-node-code-and-history]].',
    ].join('\n'),
  },
  {
    name: 'devsmind-get-node-code-and-history',
    title: 'get_node_code — the one node-read call',
    description: 'Read one function with get_node_code instead of opening the file — it already returns metadata, imports, named callers/callees, a file outline, and recent reasoning; pass history:"full" for the complete revision trail before refactoring.',
    hook: 'one call: code + metadata + imports + named callers/callees + file outline + recent reasoning.',
    type: 'feedback',
    body: [
      "`get_node_code` is the ONE node-read call: one function/class, live-parsed from disk, so trust it as current. Always included: `name`/`type`/`signature`/`description`, `imports`, `uses_nodes`/`used_by_nodes` (up to 20 named callers AND callees each way; `uses`/`used_by` are the true counts), `file_outline` (up to 40 other declarations in the file), and `recent_history` (the last 3 changes' reasoning, no code).",
      '',
      'Reach further in the SAME call: `graph_depth`/`graph_direction` ([[devsmind-get-node-graph]]), and `history:"full"` for every revision with diffable edits (pageable via `history_limit`/`history_offset`); use it before refactoring anything with a non-trivial `history_count`.',
      '',
      '**Why:** git blame gives who and when; the decision context exists only in DevsMind history.',
      '',
      '**How to apply:** do not re-open the file for imports, callers or siblings; those fields answer it. A `*_hint` means more is reachable in this same call. `snapshot_outdated: true` means the graph disagrees with disk (an `edit_node` there resyncs it). `source: "cached"` means the symbol was not found: check `file_outline`, then `rename_node` or `deprecate_node` ([[devsmind-never-delete-nodes]]).',
    ].join('\n'),
  },
  {
    name: 'devsmind-get-activity-log',
    title: 'get_activity_log for "what changed"',
    description: 'For "what changed recently" or "which files did we touch", call get_activity_log — the only source of the actual file list per commit; falls back to shared graph history when the local log is empty.',
    hook: 'the one "what changed" tool, and the only source of the FILES touched; source:"auto" falls back to shared history, "both" adds teammates.',
    type: 'feedback',
    body: [
      '`get_activity_log` answers "what changed", one entry per `commit_changes`. Filters compose (AND): `developer`, `session_id`, `since_hours` or `since`/`until`, `requirement_contains`. Each entry has `files` (every file that commit touched), `node_ids`, `developer`, `created_at`, `request`, `summary`, `status`, `source`; the response adds `all_files` and `total_matched` (the pre-`limit` count).',
      '',
      'It reads two stores: the local log (full fidelity, gitignored, so EMPTY on a fresh clone) and shared graph history (lossier). `source`: `"auto"` (default) uses local and falls back to graph history only when local is empty; `"both"` adds sessions from other machines; `"local"`/`"graph"` force one. Graph-backed entries carry a `caveats` array.',
      '',
      '**Why:** it is the only source of the full file set per commit, and the fallback makes the question answerable on a fresh clone.',
      '',
      "**How to apply:** use `\"auto\"` for your own recent work; use `\"both\"` for TEAMMATES' work, since `auto` stops at your local store once it has anything. Human views: `devsmind activity` and `devsmind view` ([[devsmind-cli-commands]]).",
    ].join('\n'),
  },
  {
    name: 'devsmind-commit-changes-contract',
    title: 'commit_changes contract',
    description: 'commit_changes requires message + reasoning + feedback (all three), refuses any batch containing an undescribed new node, and is NOT git — never run git add/commit/push because this succeeded.',
    hook: 'message + reasoning + feedback all required; new nodes need a description; NOT git.',
    type: 'feedback',
    body: [
      '`commit_changes` fails unless all THREE are present:',
      '',
      "1. `message`: the user's request, verbatim. Reuse the exact text on later commits for the same request; it merges them into one log entry.",
      '2. `reasoning`: ONE object (`what_changed`/`why`/`goal`) for everything staged since the last commit.',
      '3. `feedback`: 5 strings (`graph_problems`, `edge_problems`, `tools_used`, `dropped_and_why`, `devsmind_better`), each answered. `"none"` is allowed only after checking whether this task cost an extra call, a guess or a wrong turn. Never invent an issue.',
      '',
      'It also REFUSES a batch with a brand-NEW node lacking a `description` (1-3 sentences of purpose, in words a teammate would search by). Nothing staged is lost: describe it via `add_description` (or inline on `edit_node`) and retry.',
      '',
      "**`commit_changes` is NOT git.** It writes only to DevsMind's local graph and never runs `git add`/`git commit`/`git push`. Never run git on your own initiative because it succeeded or a task feels done; a real git commit is the developer's separate decision, only when asked.",
      '',
      '**Why:** `edit_node`/`stage_change` only stage; nothing reaches the graph or the activity log until commit. `feedback` is the only channel that improves DevsMind ([[devsmind-graph-feedback-queue]]).',
      '',
      '**How to apply:** commit at natural checkpoints and before ending a turn with staged work. `add_feedback` sends the same 5 categories on demand, with no commit needed.',
    ].join('\n'),
  },
  {
    name: 'devsmind-list-nodes-discovery',
    title: 'list_nodes for discovery',
    description: 'To enumerate what exists in a component or directory, call list_nodes rather than search_nodes or walking the file tree.',
    hook: 'enumerate a component/directory instead of walking the tree.',
    type: 'feedback',
    body: [
      '`list_nodes` enumerates all nodes for a component, module or directory: use it for "what exists here", not "find the thing that does X" ([[devsmind-search-nodes-before-grep]]).',
      '',
      '**Why:** search ranks and stops at the good hits; listing is exhaustive over a scope, which an audit or onboarding sweep needs.',
      '',
      '**How to apply:** use it before reading a directory tree by hand, then drill in with `get_node_code`. It is PAGED: `{nodes, total, offset}`, `total` the true count, `limit` default 100 (max 500); a `truncated` flag and `hint` name the next call, so never read a short page as complete. Narrow with `type`/`file_path` instead of paging a whole repo. An oversized page degrades to id/name/type/file_path with a `compacted` note; `total` stays exact.',
    ].join('\n'),
  },
  {
    name: 'devsmind-workflow-tools',
    title: 'Workflow tools for multi-session work',
    description: 'A workflow is a named log of how one piece of functionality grew — bind your session to one so commits record onto it, and sync afterwards if you forgot.',
    hook: 'bind the session; commits auto-log; workflow_sync fixes attribution afterwards.',
    type: 'feedback',
    body: [
      'A workflow is a named, backward-looking log of how one piece of functionality grew across many nodes and sessions. It is not a task list and never "completes".',
      '',
      "`start_session` flags a recent workflow worth continuing; otherwise `workflow_list` (`query` matches name, description and step content) finds one. Continue with `workflow_bind`, then `workflow_get_context` (`last_n` reads the tail). Binding is local to YOUR session; it never moves or displaces anyone else's. Others: `workflow_create`; `workflow_archive` (retire, no delete); `workflow_remove_step` (delete one mistaken step, no undo); `workflow_delete` (only an empty workflow); `workflow_import` (turn flow/architecture `.md` docs into workflows).",
      '',
      "**Why:** a feature's decision history is invisible to git blame, and what was evaluated and rejected is kept nowhere else.",
      '',
      '**How to apply:** once bound, `commit_changes` auto-logs a step, so skip `workflow_add_step` for ordinary code. Use it for a decision or research finding that changed no code, attaching docs by `doc_paths` (inside the repo), `doc_uploads` (copy up to 10 files in) or `doc_content` (paste text). If you worked unbound or on the wrong workflow, `workflow_sync` attaches it from your local activity log (previews until `confirm:true`; re-running is a no-op). See [[devsmind-commit-changes-contract]].',
    ].join('\n'),
  },
  {
    name: 'devsmind-graph-feedback-queue',
    title: 'Graph feedback queue',
    description: 'Fixing accumulated graph problems: read_graph_feedback, re-verify, fix, then mark_graph_feedback_processed.',
    hook: 'read → verify → fix → mark processed, or it never drains.',
    type: 'feedback',
    body: [
      "Graph-problem reports from `commit_changes`' `feedback`, or from `add_feedback`'s `graph_problem`/`edge_problem` at any time, drain through a supervised loop:",
      '',
      '1. `read_graph_feedback`: unprocessed reports clustered by (node_id, category), most frequent first.',
      '2. Re-verify against current code. `confidence` ("confirmed" = evidence, "suspected" = none) is a priority signal only; reports go stale. Only `add_feedback` can produce "confirmed", because its evidence is verified fresh at call time.',
      '3. Fix: one `record_alias`/`link_nodes`/`merge_nodes` often resolves a whole cluster ([[devsmind-graph-maintenance-tools]]).',
      '4. `mark_graph_feedback_processed` with those ids, even when it does not apply, or the queue never drains.',
      '',
      '`flag_indexer_rule` notes a recurring pattern worth a permanent indexer rule; it does not change the graph. `devsmind feedback` is the human view.',
    ].join('\n'),
  },
  {
    name: 'devsmind-never-delete-nodes',
    title: 'Never delete a node',
    description: 'A renamed function goes through rename_node and a removed one through deprecate_node — never delete a node.',
    hook: 'rename_node / deprecate_node; deletion loses history forever.',
    type: 'feedback',
    body: [
      'A renamed function/class goes through `rename_node`; a removed one through `deprecate_node`. Never delete.',
      '',
      '**Why:** deleting a node destroys its recorded history (the reasoning behind every past change); nothing can recover it.',
      '',
      '**How to apply:** if `get_node_code` returns `source: "cached"`, the symbol is gone from disk: verify what happened, then rename or deprecate rather than leave the graph stale. See [[devsmind-get-node-code-and-history]].',
    ].join('\n'),
  },
  {
    name: 'devsmind-graph-maintenance-tools',
    title: 'Graph maintenance tools',
    description: 'Repairing the graph itself — analyze_graph (includes orphan detection), recheck_graph, merge/split/link_nodes, record_alias, create_missing_node.',
    hook: 'analyze (incl. orphans)/recheck plus merge, split, link, record_alias.',
    type: 'reference',
    body: [
      'Maintenance surface, not day-to-day lookup:',
      '',
      '- `analyze_graph`: zero-token local health check (god entities, cycles, dangling edges, renames, orphaned nodes). `fix: true` applies only safe automatic fixes. CLI: `devsmind analyze`.',
      '- `recheck_graph`: drift and disconnection sweep, pruning spurious nodes.',
      '- `merge_nodes` / `split_node`: a node wrongly split, or wrongly lumped together.',
      "- `link_nodes`: a real connection the AST couldn't prove (dynamic dispatch, generated bindings).",
      '- `record_alias`: the same symbol known by another name; often fixes a whole feedback cluster.',
      '- `create_missing_node`: something real the indexer never picked up.',
      '- `get_visualizer_url`: the local URL for the interactive graph view (`devsmind view`).',
      '',
      'These are the fixers the [[devsmind-graph-feedback-queue]] loop reaches for.',
    ].join('\n'),
  },
  {
    name: 'devsmind-indexing-tools',
    title: 'Indexing tools',
    description: 'Indexing a workspace runs through index_start/index_checkpoint/index_continue/index_complete — never an external script.',
    hook: "index_start/checkpoint/continue/complete natively; don't pause mid-index.",
    type: 'feedback',
    body: [
      'Indexing runs through the MCP tools: `index_start` → `index_checkpoint` → `index_continue` → `index_complete`. No external scripts.',
      '',
      '**Why:** the checkpoint/continue pair is what makes progress survive a context reset.',
      '',
      "**How to apply:** don't pause mid-index for confirmation; keep going until the workspace is indexed or the context limit is hit. `devsmind index` (first run) and `devsmind reindex` (incremental, for changes made outside `edit_node`) are the CLI counterparts ([[devsmind-cli-commands]]).",
    ].join('\n'),
  },
  {
    name: 'devsmind-cli-commands',
    title: 'devsmind CLI commands',
    description: 'What the human-facing devsmind CLI offers — setup, graph maintenance, and reviewing recorded work.',
    hook: 'setup, graph, and review command surface.',
    type: 'reference',
    body: [
      '`devsmind <cmd>`:',
      '',
      "**Setup**: `init`, `start`, `rule` (build + place the workspace rule), `mcp` (register the server per tool), `memory`, `skill`, `style` (shorter agent replies).",
      '',
      '**Graph**: `index` (first time), `reindex` (incremental), `sync` (load committed graph + history into the local brain.db), `analyze` (zero-AI health check), `describe` (backfill descriptions; safe to re-run), `embed` (local vector embeddings; `--force` for a model upgrade), `prune` (interactive permanent removal).',
      '',
      "**Review**: `view` (graph visualizer plus Activity/Chat tabs), `activity`, `feedback`, `diff <node_id>`, `revert <node_id>` (undo an entity's most recent recorded edit), `workflow` / `workflow-import <path>`.",
      '',
      'The activity and feedback logs are LOCAL and gitignored. See [[devsmind-get-activity-log]].',
    ].join('\n'),
  },
];

/** Map of slug → title, for resolving [[links]] when topics get flattened into one document. */
const TITLES: Record<string, string> = Object.fromEntries(MEMORY_TOPICS.map(t => [t.name, t.title]));

/** Resolve `[[slug]]` cross-links to plain titles — meaningful only when each topic is its own file. */
function flattenLinks(body: string): string {
  return body.replace(/\[\[([a-z0-9-]+)\]\]/g, (_m, slug: string) => `"${TITLES[slug] ?? slug}"`);
}

/**
 * One topic as a standalone memory file: YAML frontmatter (name/description/type)
 * + body. The `description` is the field a file-per-fact store ranks on when
 * deciding what to load, so it must survive on its own without the body.
 */
export function renderTopicFile(topic: MemoryTopic, header: string): string {
  return [
    '---',
    `name: ${topic.name}`,
    `description: ${topic.description}`,
    'metadata:',
    `  type: ${topic.type}`,
    '---',
    '',
    header + topic.body.replace(/\n*$/, '\n'),
  ].join('\n');
}

/** One index line per topic, for the store's always-loaded index file. */
export function renderIndexLine(topic: MemoryTopic): string {
  return `- [${topic.title}](${topic.name}.md) — ${topic.hook}`;
}

/**
 * Every topic flattened into ONE document — for stores that load a single file
 * (Antigravity Skills) rather than ranking many. The contract topic leads; the
 * rest become `##` sections in registry order.
 */
export function renderCombined(header: string): string {
  const [contract, ...rest] = MEMORY_TOPICS;
  return [
    header + flattenLinks(contract.body),
    '',
    '## Tool playbook',
    '',
    ...rest.flatMap(t => [`### ${t.title}`, '', flattenLinks(t.body), '']),
  ].join('\n').replace(/\n*$/, '\n');
}

/**
 * The ONE thing `devsmind memory` prints for a tool with a real memory mechanism — a single
 * block meant to be pasted directly into any AI chat and framed as an explicit "remember this"
 * request, not written to a file on the user's behalf. Leads with the two rules that matter most
 * (edit_node is the only write path; prefer search_nodes/get_node_code over grepping or opening
 * files) so they survive even a skim, then carries the full live contract below — the SAME
 * `DEVSMIND_INSTRUCTIONS` text the MCP handshake and `devsmind rule` both use, so this can never
 * quietly drift from what the server enforces. `target.memory.askHint`, when present, inserts a
 * short AI-voiced paragraph on how THIS tool's memory actually gets saved (e.g. Cursor needs the
 * agent to explicitly propose it, not just read the request) — distinct from `target.memory.note`,
 * which is human-facing and printed separately by `handleMemory`, never pasted into the prompt.
 */
export function renderMemoryPrompt(target: IdeTarget): string {
  return [
    "Please remember the following about working in this codebase — it's the DevsMind MCP workflow, and it applies every time we work in a project with a DevsMind server.",
    ...(target.memory.askHint ? ['', target.memory.askHint] : []),
    '',
    '1. Always write files with the `edit_node` tool — never your own built-in edit/write tool, whatever the file type.',
    '2. Prefer `search_nodes` and `get_node_code` over grepping or opening files directly — they already know this codebase\'s structure and history.',
    '',
    'The full contract, so nothing gets missed:',
    '',
    DEVSMIND_INSTRUCTIONS,
  ].join('\n');
}
