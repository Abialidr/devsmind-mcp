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
      '`edit_node` is the write path for **every** file — `.ts`, `.vue`, `.css`, `.json`, `.xml`, `.md`, `.py`, anything. Never reach for your own edit/write tool. Params are the ordinary ones: `file_path` + `old_string` + `new_string`; to create a new file pass `old_string: ""` and the whole file as `new_string`. If the edit creates exactly ONE new function/class, pass `description` in the same call to skip a later round trip ([[devsmind-commit-changes-contract]] would otherwise refuse the batch).',
      '',
      "**Why:** it traces where the text landed to the actual function/class changed, stages it, and answers with that node's callers — a plain edit tool records nothing. Writes that land outside any function (markup, config, an import line) get no graph node; that is expected, not a failure, and the whole-file change is still staged for the local activity log.",
      '',
      "**How to apply:** `edit_node` is the write path for every file, going forward. If one already got edited WITHOUT it — the built-in tool got used by mistake, or you're catching up on earlier work — call `stage_change` instead of redoing the edit: same `old_string`/`new_string` shape, but it never rewrites the file, it just traces and stages the change that's already on disk. It fails clearly if `new_string` isn't found, so it can't silently record the wrong thing. `stage_change` recovers a missed write; it is never a second way to make one.",
    ].join('\n'),
  },
  {
    name: 'devsmind-start-session-first',
    title: 'start_session first',
    description: 'Call start_session before your first WRITE — session_id is required on every write, but read-only tools do NOT need one.',
    hook: 'session_id is required on every DevsMind WRITE; reads (search_nodes, get_node_code, get_activity_log, etc.) do not need one.',
    type: 'feedback',
    body: [
      '`start_session` mints a `session_id` that every WRITE tool (edit_node, commit_changes, and the other mutating calls) REQUIRES. Read-only tools (search_nodes, get_node_code, list_nodes, get_activity_log, and the other getters) do NOT need it — search and read freely from the very first call, before start_session has even run. Never invent a session_id. On a resumed conversation that already called start_session earlier (visible in reloaded history), reuse that same id instead of starting a new one.',
      '',
      '**Why:** a session ties a request\'s WRITES together on the local Activity log and makes them revertable as a unit — reads mutate nothing, so gating them buys nothing and only adds friction to the first thing an agent does (usually a search). `get_activity_log` additionally accepts `session_id` as its own OPTIONAL filter ("show me just this session\'s activity") — do not default to passing your own conversation\'s session_id there just because you have it, or you\'ll silently scope an otherwise-broad query (e.g. "what did I do today") down to only this one conversation.',
      '',
      '**How to apply:** if a WRITE call errors saying session_id is required, start_session was skipped — call it, then retry. Every response echoes the id back, so it stays visible across a long or compacted conversation. For get_activity_log, omit session_id unless you specifically want to filter to one session.',
    ].join('\n'),
  },
  {
    name: 'devsmind-search-nodes-before-grep',
    title: 'search_nodes before grep',
    description: 'Find code with search_nodes (query and/or pattern, a real regex) instead of grep or reading files — it covers the graph AND a real file grep.',
    hook: 'query and/or pattern (a real regex); covers graph + file grep.',
    type: 'feedback',
    body: [
      "`search_nodes` is the one search call: it covers the indexed graph AND the raw filesystem, so an external grep is not needed. Two inputs, pass either or both — a natural-language `query` (a real phrase, drives the semantic/vector layer) and/or `pattern` (a REAL regex, used exactly as you'd give grep — not re-escaped, not split — e.g. an identifier or \"item\\.liked\"). Pattern-only is a precision mode: exact grep + code-body matches, no semantic blur. Your own knowledge of the codebase (identifiers, error strings, config keys) makes a better pattern than tokenizing the query ever will.",
      '',
      'Two buckets come back:',
      '- `nodes` (primary) — functions/classes, each LEADING with `confidence` (high/medium/low), `relevance` and `found_by`, then `uses`/`used_by`/`history_count`; `nodes_total` is the true count before the top-20 cap.',
      "- `files` (last resort) — a real grep of every repo (or just `path`, if scoped), for what the graph doesn't model: CSS, JSON, `.env`, markup, wiring like \"where is CORS configured\". Sample lines report which function/class they fall inside. `files_total` is the true match count — bigger than what's returned means there's more; pass `offset` for the next page.",
      '',
      "**Why:** empty buckets plus a `hint` mean the thing genuinely isn't there — it never pads with guesses. `used_by: 0` carrying a `used_by_note` means \"unverified\", not \"dead code\". A capped page was silently indistinguishable from a complete result before `files_total`/`nodes_total` existed — never assume \"not there\" from a short list alone. Triage on `confidence`, not on which node name reads plausibly: confidence is corroboration across independent search layers, which is evidence you cannot reconstruct by eye, and a name that merely looks right is the easiest way to pick the wrong node.",
      '',
      "**How to apply:** search before any grep/glob/file read. Retry once with a different pattern/query before giving up. Drop to a manual grep only if the response says `truncated: true`, or you need full file context after it points at the file. Lockfiles and build artifacts are excluded by default (`.env`, JSON and config are NOT — those are what the files bucket is for); scoping `path` at an excluded file returns nothing and says so in `scope_note`, so read it directly rather than re-querying. A `compacted` field means the response was trimmed to fit and names what was dropped — counts stay exact either way, and `compact:false` demands the full payload. See [[devsmind-get-node-graph]] for blast radius once you have a hit.",
    ].join('\n'),
  },
  {
    name: 'devsmind-get-node-graph',
    title: 'get_node_code graph params for callers and flows',
    description: 'Before changing a signature or tracing a feature end to end, pass graph_depth/graph_direction on get_node_code — "in" for the full caller blast radius, "out" + graph_code for a whole call flow.',
    hook: 'graph_direction:"in" for blast radius, "out"+graph_code for a whole flow, in the SAME get_node_code call.',
    type: 'feedback',
    body: [
      'There is no separate get_node_graph tool anymore — `get_node_code` already includes direct callers/callees by name on every call (`uses_nodes`/`used_by_nodes`). `graph_depth` + `graph_direction` walk the TRANSITIVE graph past those, in that same call, answering the two questions git cannot:',
      '- `graph_depth: 2-3` + `graph_direction: "in"` — the full caller blast radius, not just direct callers. Use this BEFORE changing any signature or behavior.',
      '- `graph_depth: 3` + `graph_direction: "out"` + `graph_code: true` — the starting node plus everything it transitively calls, with current source, in ONE call. Use this for tracing a request/endpoint/feature end to end.',
      '',
      '**Why:** git shows what changed, never what depends on it. The "out"+`graph_code` combination replaces a long chain of `get_node_code` calls with a single round trip — and depth 1 is already free, since direct neighbors come back on every call regardless of `graph_depth`.',
      '',
      '**How to apply:** never chain per-function code fetches when tracing a flow — one `get_node_code` call with the right `graph_depth`/`graph_direction`/`graph_code` does it. When `graph.code_truncated: true`, check WHICH of the two causes applies, because only one is fixable: `graph.code_omitted_node_ids` names the nodes whose code exists but did not fit the budget (call `get_node_code` on exactly those, or re-issue with a bigger `graph_code_budget`), while `graph.nodes_no_code_available` counts nodes whose source genuinely could not be found — raising the budget will never bring those back. If `graph.nodes_truncated: true`, the walk hit its 120-node cap before the queue emptied. Pairs with [[devsmind-search-nodes-before-grep]] (find the node) and [[devsmind-get-node-code-and-history]] (read it, and why it looks that way).',
    ].join('\n'),
  },
  {
    name: 'devsmind-get-node-code-and-history',
    title: 'get_node_code — the one node-read call',
    description: 'Read one function with get_node_code instead of opening the file — it already returns metadata, imports, named callers/callees, a file outline, and recent reasoning; pass history:"full" for the complete revision trail before refactoring.',
    hook: 'one call: code + metadata + imports + named callers/callees + file outline + recent reasoning.',
    type: 'feedback',
    body: [
      '`get_node_code` is the ONE node-read call — no separate get_node_graph or get_node_history tool exists anymore, both folded in as params. It reads ONE function/class, live-parsed from disk — cheaper than opening the whole file, and current, so trust it as-is. ALWAYS included, at no extra cost: `name`/`type`/`signature`/`description` (the node\'s own metadata — `description` is the highest-signal field there is), `imports` (the file\'s ES import lines), `uses_nodes`/`used_by_nodes` (up to 20 named callers AND callees per direction, with `uses`/`used_by` always the TRUE count even when capped), `file_outline` (up to 40 OTHER declarations in the same file — consts, types, sibling helpers, whether or not they\'re graph nodes), and `recent_history` (last 3 changes\' reasoning ONLY, no code).',
      '',
      'Reach further in the SAME call: `graph_depth`/`graph_direction` (default off) walks the TRANSITIVE graph past the always-included direct neighbors — see [[devsmind-get-node-graph]]. `history:"full"` (default `"recent"`) returns EVERY revision with diffable before/after edits, pageable with `history_limit`/`history_offset` — call it before refactoring anything with a non-trivial `history_count`.',
      '',
      '**Why:** git blame gives who and when; the actual decision context exists only in DevsMind history. Nothing else records why a change was made. And a bare function body alone does not say what its identifiers resolve to, who calls it, or what else lives nearby — that used to send agents back to a raw file read for all three; `get_node_code` closes that gap itself now.',
      '',
      '**How to apply:** do not re-open the file after `get_node_code` for imports, "what calls this", or "what else is in this file" — `imports`, `uses_nodes`/`used_by_nodes`, and `file_outline` already answer those. Every capped section says so honestly (`*_truncated`, `*_hint`) — a hint means more is reachable in this SAME call (`neighbors_offset`, `graph_depth`, `history_offset`), not a dead end. `snapshot_outdated: true` means the graph disagrees with disk — an `edit_node` on that node re-syncs it as a side effect. `source: "cached"` means the symbol was not found (renamed/moved/deleted) — the `file_outline` still shows what IS in the file, so check there before assuming it vanished — then verify and `rename_node` or `deprecate_node` ([[devsmind-never-delete-nodes]]).',
    ].join('\n'),
  },
  {
    name: 'devsmind-get-activity-log',
    title: 'get_activity_log for "what changed"',
    description: 'For "what changed recently" or "which files did we touch", call get_activity_log — the only source of the actual file list per commit; falls back to shared graph history when the local log is empty.',
    hook: 'the one "what changed" tool, and the only source of the FILES touched; source:"auto" falls back to shared history, "both" adds teammates.',
    type: 'feedback',
    body: [
      '`get_activity_log` answers "what changed", one entry per `commit_changes`. It replaced `get_recent_changes` / `get_developer_activity` / `get_changes_by_requirement` — all three are removed. Filters compose (AND): `developer`, `session_id`, `since_hours` or `since`/`until`, `requirement_contains`.',
      '',
      'Each entry carries `files` (every file that commit touched), `node_ids`, `developer`, `created_at`, `request`, `summary`, `status`, `source`. The response also has `all_files` (every distinct file across the returned entries) and `total_matched` — the pre-`limit` count, so a capped result is not mistaken for a complete one.',
      '',
      'It reads TWO stores. The local activity log is full-fidelity but gitignored, so it is EMPTY on a teammate\'s clone or your second machine; committed graph history is shared but lossier. `source` chooses: `"auto"` (default) reads local and falls back to graph history only when local is empty; `"both"` merges local with every session that did not run on this machine; `"local"` / `"graph"` force one. Graph-backed responses carry a `caveats` array — `status` is always `"applied"` there, and `request` degrades to the reasoning\'s Requirement field.',
      '',
      '**Why:** it is the answer to "show me all the files you changed" (e.g. before writing tests against recent work). The graph tools know nodes, not the full file set of a commit. And the fallback is what makes the question answerable at all for someone who just cloned the repo.',
      '',
      '**How to apply:** use it for any "what did we change recently", "what did this ticket touch", "which files from this session" question — the default `source:"auto"` is right almost always. Reach for `source:"both"` when you want TEAMMATES\' work too: once you have local activity of your own, `auto` stops at the local store and never consults shared history. `devsmind activity` and `devsmind view` → Activity are the human-facing views of the local log ([[devsmind-cli-commands]]).',
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
      "1. `message` — the user's request, verbatim, that led to this commit. Reuse the exact same text on later commits still answering that request; it merges them into one activity-log entry instead of splitting them.",
      '2. `reasoning` — ONE object (`what_changed`/`why`/`goal`) covering everything staged since the last commit, not one per edit.',
      '3. `feedback` — 5 string fields (`graph_problems`, `edge_problems`, `tools_used`, `dropped_and_why`, `devsmind_better`). Every field must be answered; `"none"` is allowed, but only after actually checking whether something in THIS task took an extra tool call, a guess, or a wrong turn. Never invent an issue to fill it.',
      '',
      'It also REFUSES any batch containing a brand-NEW node with no `description` (1-3 sentences of what it does and its domain concepts, in words a teammate might search by — never a restatement of the name). Nothing staged is lost: describe it via `add_description` and retry the same call.',
      '',
      '**`commit_changes` is NOT git**, despite sharing the word. It never runs `git add`/`git commit`/`git push` or any other git command, and never touches the actual git history — it writes only into DevsMind\'s own local graph/database. Calling it successfully is not a signal to now run a real git commit yourself: never `git add`/`git commit`/`git push` on your own initiative just because `commit_changes` succeeded or a task feels done. A real git commit is the developer\'s decision, made separately, only when explicitly asked for — same as any other git action.',
      '',
      '**Why:** `edit_node`/`stage_change` only stage; nothing reaches the graph or the activity log until commit. `feedback` is the only channel that improves DevsMind over time — it routes to a local graph-fix queue and a product log ([[devsmind-graph-feedback-queue]]). The git distinction matters because the shared word "commit" is an easy thing to conflate — one is a local DevsMind write, the other is your actual version control, and mixing them up means either an unwanted autonomous git commit, or code that never actually gets git-committed because it looked "already committed".',
      '',
      '**How to apply:** commit at natural checkpoints during a long task, and always before ending a turn with staged work. Pass `description` inline on [[devsmind-edit-node-always]] when the edit created exactly one new symbol. Noticed something worth reporting but are not committing right now? `add_feedback` takes the same 5 categories ON DEMAND — any one or more, nothing required, no commit needed (see [[devsmind-graph-feedback-queue]]).',
    ].join('\n'),
  },
  {
    name: 'devsmind-list-nodes-discovery',
    title: 'list_nodes for discovery',
    description: 'To enumerate what exists in a component or directory, call list_nodes rather than search_nodes or walking the file tree.',
    hook: 'enumerate a component/directory instead of walking the tree.',
    type: 'feedback',
    body: [
      '`list_nodes` is the discovery/enumeration call: all nodes for a component, module, or directory. Use it when the question is "what exists here", not "find the thing that does X" — that one is [[devsmind-search-nodes-before-grep]].',
      '',
      '**Why:** search ranks by relevance and stops at the good hits; listing is exhaustive over a scope, which is what an audit or an onboarding sweep needs.',
      '',
      '**How to apply:** reach for it before reading a directory tree by hand, then drill in with `get_node_code` (its `graph_depth`/`graph_direction` params reach further from there). It is PAGED — the answer is `{nodes, total, offset}`, where `total` is the true match count and `nodes` is at most `limit` (default 100, max 500). When `total` exceeds what came back, `truncated` and a `hint` name the exact next call; never read a short page as the complete set. Narrow with `type`/`file_path` in preference to paging through a whole repo. If a page is still too large the nodes come back as id/name/type/file_path only, with a `compacted` note — `total` stays exact either way.',
    ].join('\n'),
  },
  {
    name: 'devsmind-workflow-tools',
    title: 'Workflow tools for multi-session work',
    description: 'A workflow is a named log of how one piece of functionality grew — bind your session to one so commits record onto it, and sync afterwards if you forgot.',
    hook: 'bind the session; commits auto-log; workflow_sync fixes attribution afterwards.',
    type: 'feedback',
    body: [
      'A workflow is a named, BACKWARD-LOOKING log of how one piece of functionality grew across many nodes and many sessions. You read it to learn how the code got this way. It is not a task list and nothing ever "completes".',
      '',
      '`start_session` tells you when there is a recent workflow worth continuing; otherwise `workflow_list` (with `query`, which matches name and description) finds one. Continue it with `workflow_bind`, then `workflow_get_context` to read the story — steps in order, each with the reasoning behind it and the nodes it touched. `last_n` reads the tail, which is what catching up usually means.',
      '',
      '**Binding is local to YOUR session.** It never moves, pauses, or steals anyone else\'s, and two sessions can work different workflows — or the same one — at once. There is no project-wide "active workflow" any more; the old one synced through git and let one developer displace everybody else.',
      '',
      'The rest: `workflow_create`, `workflow_archive` (retire a thread without deleting it), `workflow_import` (turns existing flow/architecture `.md` docs into workflows).',
      '',
      "**Why:** a feature's decision history is invisible to git blame; starting fresh silently loses it. And research is the part nothing else keeps at all — git has the diff, history has the per-node reasoning, but neither records what was evaluated and rejected.",
      '',
      "**How to apply:** once bound, `commit_changes` auto-logs a step — you do NOT need `workflow_add_step` for ordinary code work. Call it for what a commit cannot express: a decision or research finding that changed no code, with the docs behind it via `doc_paths` (paths, never copies — a path outside the repo is rejected because it would not exist for a teammate). If you worked while unbound or on the wrong thread, `workflow_sync` attaches it afterwards from your local activity log: it previews first and only writes with `confirm:true`, and re-running is a no-op. See [[devsmind-commit-changes-contract]].",
    ].join('\n'),
  },
  {
    name: 'devsmind-graph-feedback-queue',
    title: 'Graph feedback queue',
    description: 'Fixing accumulated graph problems: read_graph_feedback, re-verify, fix, then mark_graph_feedback_processed.',
    hook: 'read → verify → fix → mark processed, or it never drains.',
    type: 'feedback',
    body: [
      "The graph-problem reports collected by `commit_changes`' `feedback` param — or reported directly, any time, via `add_feedback`'s `graph_problem`/`edge_problem` (no commit needed) — drain through a supervised loop:",
      '',
      '1. `read_graph_feedback` — every unprocessed report, clustered by (node_id, category), sorted by frequency. Start any batch graph-fix session here.',
      '2. Re-verify against current code regardless of source. `confidence` ("confirmed" = evidence given, "suspected" = none) is a PRIORITY signal only — reports go stale. `commit_changes`\' `feedback` is plain text with no evidence field, so anything sourced from it is always `suspected`; `add_feedback`\'s `graph_problem`/`edge_problem` is the only path that can produce `confirmed` — and only because its evidence is VERIFIED FRESH at call time (file must exist, snippet must still be found in it), not self-reported.',
      '3. Fix — one `record_alias` / `link_nodes` / `merge_nodes` often resolves a whole cluster ([[devsmind-graph-maintenance-tools]]).',
      "4. `mark_graph_feedback_processed` with those entry ids — whether you fixed it or decided it doesn't apply. Otherwise the queue never drains.",
      '',
      "`flag_indexer_rule` records a candidate for a PERMANENT deterministic indexer rule when several reports turn out to be the same recurring pattern (e.g. a framework's generated-binding convention). It doesn't change the graph — it's a note for a human, prioritized by `evidence_count`.",
      '',
      '**Why:** without step 4 the same cluster resurfaces forever; without step 2 you act on stale reports.',
      '',
      '**How to apply:** `devsmind feedback` (CLI) is the human-facing view of both this queue and the product-feedback log.',
    ].join('\n'),
  },
  {
    name: 'devsmind-never-delete-nodes',
    title: 'Never delete a node',
    description: 'A renamed function goes through rename_node and a removed one through deprecate_node — never delete a node.',
    hook: 'rename_node / deprecate_node; deletion loses history forever.',
    type: 'feedback',
    body: [
      'A renamed function/class goes through `rename_node`. A removed one goes through `deprecate_node` — never a delete.',
      '',
      "**Why:** deleting the node destroys its recorded history — the reasoning behind every past change — and nothing can recover it. Not git, not a reindex.",
      '',
      '**How to apply:** if `get_node_code` comes back with `source: "cached"`, the symbol is gone from disk — verify what actually happened, then `rename_node` or `deprecate_node` rather than leaving the graph stale. See [[devsmind-get-node-code-and-history]].',
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
      '- `analyze_graph` — zero-token local health check (god entities, cycles, dangling edges, renames, AND orphaned nodes — no separate orphan lookup tool exists). `fix: true` applies only the safe automatic fixes. CLI equivalent: `devsmind analyze`.',
      '- `recheck_graph` — drift and disconnection sweep, pruning spurious nodes.',
      '- `merge_nodes` / `split_node` — a node that was wrongly split, or wrongly lumped together.',
      "- `link_nodes` — a real connection the AST couldn't prove (dynamic dispatch, generated bindings).",
      '- `record_alias` — the same symbol known by another name; often fixes a whole feedback cluster at once.',
      '- `create_missing_node` — something real the indexer never picked up.',
      '- `get_visualizer_url` — the local URL for the interactive graph view: one page, Chat + Graph tabs, 2D/3D toggle inside Graph (`devsmind view`).',
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
      '**Why:** the checkpoint/continue pair is what makes progress survive a context reset — a script-driven index loses everything on a restart.',
      '',
      '**How to apply:** don\'t pause mid-index for confirmation; keep going until the workspace is indexed or the context limit is hit. `devsmind index` (first run) and `devsmind reindex` (incremental, for manual changes made outside `edit_node`) are the CLI counterparts ([[devsmind-cli-commands]]).',
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
      "**Setup** — `init` (create/update a brain), `start`, `rule` (build + place the AI workspace rule), `mcp` (register the MCP server per tool), `memory` (seed a tool's agent-memory store).",
      '',
      '**Graph** — `index` (first-time), `reindex` (incremental, for edits made outside `edit_node`), `sync` (pull committed graph + history from disk into the local brain.db), `analyze` (zero-AI health check), `describe` (backfill descriptions for nodes predating the requirement; safe to re-run), `embed` (local/offline vector embeddings, no LLM credentials; safe to re-run, `--force` for a model upgrade), `prune` (interactive permanent removal).',
      '',
      '**Review** — `view` (D3 graph visualizer plus Activity/Chat tabs), `activity` (local session/message timeline), `feedback` (graph problems, product feedback, indexer-rule candidates), `diff <node_id>` (red/green with the recorded reasoning), `revert <node_id>` (undo an entity\'s most recent recorded edit), `workflow` / `workflow-import <path>`.',
      '',
      'The activity and feedback logs are LOCAL and gitignored — never pushed. See [[devsmind-get-activity-log]].',
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
