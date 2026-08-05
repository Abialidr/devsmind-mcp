import * as fs from 'fs';
import * as path from 'path';
import { DevMindConfig, resolveDevmindDir } from '../utils/config';
import {
  pickTarget,
  pickMode,
  pickWorkflowStyle,
  WorkflowStyle,
  pickRuleScope,
  pickDirectory,
  confirmPrompt,
  mergeRuleFile,
  writeConfigFile,
  CancelledError,
} from './integrations/prompt';
import { resolveScopeFile, resolveOsPath } from './integrations/registry';

/**
 * Build the ready-to-paste DevsMind workspace rule from a project's config.
 * Pure string builder — no I/O — so it can be printed or written to a file.
 *
 * `workflowStyle` picks which of two rules gets built:
 * - `'automatic'` (default): the AI stages, commits, and tracks every edit without being asked —
 *   the original, still-recommended default for a team's shared graph.
 * - `'manual'`: the AI uses DevsMind's search/read tools freely (that part is never optional —
 *   it's why the tool exists) but never stages or commits on its own initiative; the developer
 *   stays the one deciding what reaches the graph and when. `session_id` (on writes) and `message`
 *   are still mechanically required by the protocol either way — that's not something a rule can
 *   opt out of, only WHEN commit_changes gets called is a style choice.
 */
export function buildRule(config: DevMindConfig, devmindDir: string, workflowStyle: WorkflowStyle = 'automatic'): string {
  const projectName = config.project_name;
  const mode = config.mode;
  const notes = config.notes;
  const tech = config.tech_stack;
  const repos = config.repos;
  const manual = workflowStyle === 'manual';

  const repoLines = repos
    .map(r => ('relative_path' in r ? `${r.name} → ${r.relative_path}` : `${r.name} → env:${r.path_key}`))
    .join(', ');

  const techLine = tech
    ? [...(tech.languages || []), ...(tech.frameworks || [])].join(', ')
    : 'Not specified';

  const timeout = config.session_timeout_minutes ?? 60;
  const safeDevmindDir = devmindDir.replace(/\\/g, '/');

  const bt = '`';

  const whatThisIs = manual
    ? `DevsMind is this team's shared code graph — every teammate's AI agent reads the same graph, there is no "your copy." ${bt}get_node_code${bt} shows what git can't (live callers/callees by name already included; ${bt}graph_depth${bt}+${bt}graph_direction:"in"${bt} for the full blast radius before you break a signature). Its ${bt}history:"full"${bt} option shows what git blame can't (why a change was made, not just who/when). Reading from it is never optional — check it before you touch code. **Writing to it is the developer's call, not yours: this project is set to MANUAL — only stage or commit when explicitly asked to.**`
    : `DevsMind is this team's shared code graph — every teammate's AI agent reads the same graph you write to, there is no "your copy." ${bt}get_node_code${bt} shows what git can't (live callers/callees by name already included; ${bt}graph_depth${bt}+${bt}graph_direction:"in"${bt} for the full blast radius before you break a signature). Its ${bt}history:"full"${bt} option shows what git blame can't (why a change was made, not just who/when). Both are worthless if changes stop getting recorded — so recording is not optional, it's the product.`;

  const editRow = manual
    ? `| Editing a file | ${bt}edit_node${bt} (${bt}file_path${bt} + ${bt}old_string${bt} + ${bt}new_string${bt}) is a safe drop-in for your own edit tool and traces automatically if you ever do commit — but it's optional here, your own editor's edit tool is equally fine |`
    : `| ANY edit to ANY file — ${bt}.ts${bt}, ${bt}.vue${bt}, ${bt}.css${bt}, ${bt}.json${bt}, ${bt}.xml${bt}, anything | ${bt}edit_node${bt} (${bt}file_path${bt} + ${bt}old_string${bt} + ${bt}new_string${bt}) — never your own edit tool. It never refuses a file type, and traces what you changed for you |`;
  const createRow = manual
    ? `| Creating a NEW file | ${bt}edit_node${bt} with ${bt}old_string: ""${bt} works the same way |`
    : `| Create a NEW file | ${bt}edit_node${bt} with ${bt}old_string: ""${bt} and the whole file as ${bt}new_string${bt} — never your own write tool |`;
  const commitRow = manual
    ? `| The developer explicitly asks you to commit/save/record this to DevsMind | ${bt}commit_changes${bt} — never on your own initiative |`
    : `| Checkpoints during a long task, and before ending any turn with staged work | ${bt}commit_changes${bt} |`;

  const recordingHeader = manual
    ? '### Recording Changes — Manual: Only When Asked'
    : '### Recording Changes — Per Node, Not Per File, Not At The End';

  const recordingBody = manual ? [
    `This project is set to **MANUAL**. Search/read tools (${bt}search_nodes${bt}, ${bt}get_node_code${bt}) stay always-on — use them before reading a raw file or guessing at impact, same as automatic mode. What's different is the write side:`,
    '',
    `1. Do **not** call ${bt}commit_changes${bt} on your own initiative — not after an edit, not at a "natural checkpoint," not because a turn is ending. The developer decides what reaches the graph and when.`,
    `2. If the developer explicitly asks you to commit/save/record something ("commit this", "save that to devsmind", "record what we just did"), then follow the normal automatic-mode mechanics: ${bt}edit_node${bt} already staged whatever it traced; call ${bt}commit_changes${bt} with ${bt}message${bt} set to their request verbatim, ONE ${bt}reasoning${bt} (what_changed/why/goal) covering everything staged, and ${bt}feedback${bt} (5 strings: ${bt}graph_problems${bt}, ${bt}edge_problems${bt}, ${bt}tools_used${bt}, ${bt}dropped_and_why${bt}, ${bt}devsmind_better${bt} — each must be answered, ${bt}"none"${bt} is fine where nothing applies). All three are REQUIRED by the tool itself, not a style choice. If anything staged is a brand-NEW node, ${bt}commit_changes${bt} also requires a ${bt}description${bt} for it first (pass it on the ${bt}edit_node${bt} call that created it, or call ${bt}add_description${bt}) — enforced by the tool regardless of workflow style, not something MANUAL mode opts out of.`,
    `3. ${bt}session_id${bt} is also mechanically required on every DevsMind WRITE regardless of mode (see above) — that's the protocol, not a recording obligation. Calling ${bt}start_session${bt} and carrying its id doesn't mean anything is being tracked; it's just what makes a write succeed at all. Read-only tools (${bt}search_nodes${bt}, ${bt}get_node_code${bt}, ${bt}get_activity_log${bt}, etc.) do NOT need it — search and read freely before ${bt}start_session${bt} has even run.`,
    `4. Don't narrate that you skipped staging/committing — silence is the expected default here. Only bring up DevsMind's state when it's relevant or the developer asks.`,
  ] : [
    `1. ${bt}edit_node${bt} is the write path for **every** file — never your own edit/write tool, whatever the extension. Pass ${bt}file_path${bt} + ${bt}old_string${bt} + ${bt}new_string${bt}, exactly like an ordinary edit tool; to create a file, pass ${bt}old_string: ""${bt} and the whole file as ${bt}new_string${bt}. It traces where your text landed to the function/class you actually changed, and answers with that node's callers. No ${bt}node_id${bt} to look up, no ${bt}code_snapshot${bt} to send back. Writes landing outside any function (markup, config, imports) get no graph node — expected, not a failure — but the whole-file change is still staged for the local activity log, so ${bt}commit_changes${bt} makes it revertable there too.`,
    `2. Call ${bt}commit_changes${bt} at natural checkpoints (a batch of related nodes, a context switch) — not saved for a single end-of-task call that's easy to skip when the task runs long. ${bt}edit_node${bt} only stages; it never writes to the graph on its own. Always commit before ending a turn with anything staged.`,
    `3. ${bt}message${bt}, ${bt}reasoning${bt} AND ${bt}feedback${bt} are all REQUIRED on ${bt}commit_changes${bt} — the call fails without any one of them. ${bt}message${bt} is the user's request, verbatim, that led to this commit; it builds a local activity log (${bt}devsmind view${bt} → Activity, never pushed) grouping your work by request and letting the user revert one as a whole. Pass the exact same text again on a later commit that's still answering the same request — that merges them into one entry instead of splitting it. ${bt}reasoning${bt} (${bt}what_changed${bt}/${bt}why${bt}/${bt}goal${bt}) is ONE object covering **everything staged since the last commit** — not one per edit_node call, one per commit — and gets recorded against every node that commit touches.`,
    `4. ${bt}feedback${bt} is the third required field: 5 strings (${bt}graph_problems${bt}, ${bt}edge_problems${bt}, ${bt}tools_used${bt}, ${bt}dropped_and_why${bt}, ${bt}devsmind_better${bt}). Every field must be ANSWERED, but none has to contain a problem — ${bt}"none"${bt} is a valid answer everywhere. It's the only channel that improves DevsMind instead of leaving it frozen at index time, so before writing "none", actually check whether one moment in THIS task took an extra tool call, a guess, a re-read, or a wrong turn; one specific sentence with evidence (${bt}file:line${bt}) beats a reflexive "none". Never invent an issue to fill a field. ${bt}graph_problems${bt}/${bt}edge_problems${bt} feed a local graph-fix queue (${bt}read_graph_feedback${bt}); the rest feed a product log. Both are local and gitignored — ${bt}devsmind feedback${bt} shows them.`,
    `5. Every brand-NEW node needs a ${bt}description${bt} before ${bt}commit_changes${bt} will accept it — 1-3 sentences of what it does and its domain concepts, in words a teammate might search by later, never a restatement of the name. If an ${bt}edit_node${bt} call creates exactly ONE new function/class, pass ${bt}description${bt} on that same call — you already know what you just wrote, so there's no reason to wait for the refusal and a separate round trip. Otherwise call ${bt}add_description${bt} for whatever ${bt}edit_node${bt} traced as new (its response tells you when). Write it while the code is still in front of you — commit_changes will otherwise refuse the batch and hand back exactly which node_ids need one.`,
    `6. Don't print node/history data as text instead of calling the tools — that looks done but records nothing.`
  ];

  const lines = [
    '## DevsMind — AI Brain',
    '',
    `**DEVMIND_PATH**: ${bt}${safeDevmindDir}${bt}`,
    `**Project**: ${projectName} | **Mode**: ${mode} | **Tech**: ${techLine} | **Session timeout**: ${timeout}min`,
    `**Repos**: ${repoLines}`,
    `**Workflow style**: ${manual ? 'MANUAL — DevsMind is for search & context here; the AI stages/commits only when explicitly asked' : 'AUTOMATIC — the AI stages, commits, and tracks every edit without being asked'}`,
    notes ? `**Notes**: ${notes}` : '',
    '',
    '### What This Is',
    '',
    whatThisIs,
    '',
    `**${bt}session_id${bt} is required on every DevsMind WRITE** (${bt}edit_node${bt}, ${bt}commit_changes${bt}, and the other mutating calls) **— read-only tools do not need it.** Call ${bt}start_session${bt} before your first write, then pass the ${bt}session_id${bt} it returns on every later write this conversation — every response echoes it back so it stays in front of you even across a long or compacted conversation. Never invent one. This applies in both workflow styles — it's the protocol, not a recording obligation. ${bt}get_activity_log${bt} additionally accepts ${bt}session_id${bt} as its own OPTIONAL filter ("just this session's activity") — don't pass your own conversation's id there by default, or you'll silently narrow an otherwise-broad query to one session.`,
    '',
    '### Tool Triggers',
    '',
    '| Situation | Tool |',
    '|-----------|------|',
    `| **Before your first WRITE this conversation** | ${bt}start_session${bt} — mints a ${bt}session_id${bt}. Every WRITE tool call (not reads) REQUIRES that exact ${bt}session_id${bt}; a write without one errors. On a resumed conversation that already called ${bt}start_session${bt} earlier (visible in the reloaded history), reuse that same id — don't start a new one |`,
    `| Searching for a module, feature, concept, or code fragment — AND for config/CSS/markup the graph doesn't index | ${bt}search_nodes${bt}, passing ${bt}query${bt} (a natural-language phrase — drives meaning-matching) and/or ${bt}pattern${bt} (a real regex, used exactly as you'd give grep — e.g. an identifier or "item\.liked", not re-escaped or split). Pattern-only skips semantic ranking for exact matches. It answers with ${bt}nodes${bt} (the graph — triage on the ${bt}confidence${bt} and ${bt}relevance${bt} each node now leads with, NOT on which name reads plausibly to you; ${bt}nodes_total${bt} is the true count before the cap) AND ${bt}files${bt} (a real grep of every repo, or just ${bt}path${bt} if scoped; ${bt}files_total${bt} tells you honestly if there's more than the page shown). Lockfiles and build artifacts are excluded by default, so what comes back is real source. An oversized response is trimmed automatically and a ${bt}compacted${bt} field says what was dropped — counts stay exact, and ${bt}compact:false${bt} gets you all of it. Never start with your own grep; retry once with a different pattern/query before giving up on it |`,
    `| List/discover all nodes for a component or directory | ${bt}list_nodes${bt} — paged. It answers ${bt}{nodes, total, offset}${bt}; ${bt}total${bt} is the true match count and ${bt}nodes${bt} is one page (default 100). A ${bt}truncated${bt} flag plus a ${bt}hint${bt} name the next call — never read a short page as everything. Narrow with ${bt}type${bt}/${bt}file_path${bt} rather than paging a whole repo |`,
    `| Read the code of ONE function/class | ${bt}get_node_code${bt} — the ONE node-read call, live-parsed, cheaper than opening the file. Already includes ${bt}imports${bt}, ${bt}name${bt}/${bt}type${bt}/${bt}signature${bt}/${bt}description${bt}, up to 20 named callers AND callees per direction (${bt}uses_nodes${bt}/${bt}used_by_nodes${bt}, exact counts even when capped), up to 40 other declarations from the same file (${bt}file_outline${bt}), and up to 3 ${bt}recent_history${bt} summaries — a raw file read shouldn't be needed afterward for any of that |`,
    `| Trace a flow through MULTIPLE functions | ${bt}get_node_code${bt} with ${bt}graph_depth:3${bt} + ${bt}graph_direction:"out"${bt} + ${bt}graph_code:true${bt} in ONE call — don't chain per-function calls. If some nodes' code didn't fit the budget they're named in ${bt}graph.code_omitted_node_ids${bt}; fetch exactly those, or re-issue with a larger ${bt}graph_code_budget${bt} |`,
    `| What would break if I change this? | Direct callers are already in ${bt}used_by_nodes${bt} on the plain ${bt}get_node_code${bt} call; for the FULL transitive blast radius add ${bt}graph_depth:2-3${bt} + ${bt}graph_direction:"in"${bt} in that same call |`,
    `| Before refactoring a function | ${bt}get_node_code${bt} with ${bt}history:"full"${bt} — every revision, with diffable before/after edits |`,
    `| "What changed recently?" / "which files did you touch?" / everything done for a ticket | ${bt}get_activity_log${bt} — filters compose (${bt}developer${bt}, ${bt}session_id${bt}, ${bt}since_hours${bt}/${bt}since${bt}/${bt}until${bt}, ${bt}requirement_contains${bt}), and every entry lists the actual ${bt}files${bt} that commit touched, plus an ${bt}all_files${bt} union and ${bt}total_matched${bt} (the pre-${bt}limit${bt} count). ${bt}source${bt} defaults to ${bt}"auto"${bt}: the local gitignored log, falling back to shared graph history when it's empty — so a fresh clone still gets an answer |`,
    `| What did a TEAMMATE change? / anything on a machine that isn't this one | ${bt}get_activity_log${bt} with ${bt}source:"both"${bt} — ${bt}"auto"${bt} stops at the local log the moment it has anything of your own, so it never surfaces other developers' work. Graph-backed entries come with a ${bt}caveats${bt} array (no revert status, ${bt}request${bt} degrades to the reasoning's Requirement) — read it before acting on them |`,
    editRow,
    createRow,
    commitRow,
    `| Function/class renamed | ${bt}rename_node${bt} |`,
    `| Function/class removed | ${bt}deprecate_node${bt} (never delete — history is lost otherwise) |`,
    '',
    recordingHeader,
    '',
    ...recordingBody,
    '',
    '### Other Rules',
    '',
    `1. **No external scripts for indexing.** Use ${bt}index_start${bt} / ${bt}index_checkpoint${bt} / ${bt}index_continue${bt} / ${bt}index_complete${bt} natively so progress survives a context reset.`,
    `2. **Don't pause mid-index** for confirmation — keep going until the workspace is indexed or the context limit is hit.`,
    `3. **Drift signals** — ${bt}get_node_code${bt} returning ${bt}snapshot_outdated:true${bt} means the graph disagrees with disk. If you're about to edit that node anyway, an ${bt}edit_node${bt} call re-syncs it as a side effect — nothing extra to do. To force a resync with NO real code change, ${bt}edit_node${bt} can't help (it requires ${bt}old_string${bt} to actually differ from ${bt}new_string${bt}) — run ${bt}devsmind reindex${bt} instead (incremental parsing of modified/new files). ${bt}source:"cached"${bt} means the symbol wasn't found (renamed/moved/deleted) — verify, then ${bt}rename_node${bt} or ${bt}deprecate_node${bt}.`,
    `4. **Before multi-day work**, call ${bt}workflow_list${bt} — a workflow is a named log of how one piece of functionality grew. If a description matches, offer to continue it (${bt}workflow_bind${bt} + ${bt}workflow_get_context${bt}) rather than starting fresh. Binding is local to your session: it never moves or pauses anyone else's. Once bound, ${bt}commit_changes${bt} auto-logs a step — call ${bt}workflow_add_step${bt} only for what a commit can't express, a decision or research finding that changed no code, with its docs via ${bt}doc_paths${bt}.`,
    '',
    '### A Few Less-Obvious Tools',
    '',
    `Every tool's own name/schema/description is already sent to you automatically by the MCP server — no need to list them all here. Just the ones worth knowing about ahead of time:`,
    '',
    `* ${bt}recheck_graph${bt} / ${bt}analyze_graph${bt} — maintenance, not day-to-day lookup. ${bt}analyze_graph${bt} is a zero-token local health check (god entities, cycles, dangling edges, renames, AND orphaned nodes — no separate orphan lookup needed); ${bt}fix:true${bt} applies only the safe automatic fixes.`,
    `* Want the decision but don't know which node made it? ${bt}search_nodes${bt} already searches reasoning text from EVERY history revision, not just the latest — no separate decisions-only search needed (${bt}get_node_code${bt} ${bt}history:"full"${bt} is the same thing scoped to one node you've already found).`,
    `* ${bt}add_feedback${bt} — the same 5 ${bt}commit_changes${bt} feedback categories, callable ON DEMAND instead of waiting for a commit: pass any one or more, nothing required. Evidence (${bt}file${bt} + ${bt}snippet${bt}) on a ${bt}graph_problem${bt}/${bt}edge_problem${bt} is verified fresh at call time — a fabricated or stale claim is rejected outright, not silently downgraded.`,
    `* ${bt}read_graph_feedback${bt} → fix → ${bt}mark_graph_feedback_processed${bt} — the supervised loop that drains what ${bt}commit_changes${bt}'/${bt}add_feedback${bt}'s ${bt}graph_problem${bt}/${bt}edge_problem${bt} collected, clustered by frequency. Re-verify each cluster against current code first: ${bt}confidence${bt} is a priority signal, not proof, and reports go stale. Mark entries processed even when you decide they don't apply, or the queue never drains. ${bt}flag_indexer_rule${bt} notes a recurring pattern worth turning into a permanent detector.`,
    `* ${bt}record_alias${bt} / ${bt}link_nodes${bt} / ${bt}merge_nodes${bt} / ${bt}split_node${bt} / ${bt}create_missing_node${bt} — the structural fixers that loop reaches for: a symbol known by another name, a real connection no AST could prove (dynamic dispatch, generated bindings), a node wrongly split or lumped together, something the indexer never picked up.`,
    `* ${bt}get_visualizer_url${bt} — the local URL for the interactive graph view: one page, Chat + Graph tabs, with a 2D/3D toggle inside the Graph tab (same thing ${bt}devsmind view${bt} opens).`,
    `* ${bt}workflow_get_context${bt} — call right after ${bt}workflow_bind${bt} to read that workflow's story: its steps in order, each with the reasoning and the nodes it touched. Paged, so ${bt}last_n${bt} is how you catch up on a long one.`,
    `* ${bt}workflow_sync${bt} — attaches work you already did onto a workflow, for when you were unbound or on the wrong one. Reads your local activity log and previews first; it only writes when you pass ${bt}confirm:true${bt}, and re-running it is a no-op.`,
    `* ${bt}workflow_archive${bt} — retires a workflow from the list without deleting anything. Deliberately not "complete": a feature is never finished, it just stops being worked on.`,
    `* ${bt}workflow_import${bt} — turns existing flow/architecture docs into workflows.`,
  ];

  return lines.filter(l => l !== null).join('\n');
}

/**
 * A short block meant to be pasted at the START of a fresh AI chat — deliberately separate from
 * the persistent rule file above. The rule file only helps once the agent actually reads it, and
 * a long session can lose track of something it read once at the very beginning; this is the
 * human's manual lever to make a brand-new conversation commit to the rule from its first move,
 * rather than drifting into using DevsMind slowly (or not at all) over the first few turns.
 */
export function buildKickoffPrompt(workflowStyle: WorkflowStyle = 'automatic'): string {
  const manual = workflowStyle === 'manual';
  const base = "Before doing anything else in this session: call DevsMind's `start_session` and carry the `session_id` it returns on every DevsMind call for the rest of this conversation — every tool requires it. Follow this project's DevsMind workspace rule exactly, not as a suggestion, even for edits that feel too small to bother with.";
  const styleLine = manual
    ? ' Use `search_nodes` (`query` and/or `pattern`, a real regex) / `get_node_code` (already includes named callers/callees and recent history; add `graph_depth`/`graph_direction` or `history:"full"` for more) before you read a file or guess at impact — that part is always on. Do NOT stage or commit anything to DevsMind on your own initiative; only do it if I explicitly ask you to record, save, or commit it.'
    : ' Search with `search_nodes` (`query` and/or `pattern`, a real regex) before any grep, write every file with `edit_node` rather than your own editor tool, and call `commit_changes` (with `message` set to my actual request, one `reasoning` covering everything staged, and `feedback` — all three are required) at natural checkpoints — never leave work uncommitted at the end of a turn.';
  return base + styleLine;
}

function printRuleBanner(rule: string, kickoff: string, projectName: string, tip?: string): void {
  const divider = '═'.repeat(70);
  console.log(`\n${divider}`);
  console.log(` DevsMind Workspace Rule — "${projectName}"`);
  console.log(` Copy the block below into your AI workspace rules file`);
  console.log(`${divider}\n`);
  console.log(rule);
  console.log(`\n${divider}`);
  if (tip) {
    console.log(tip);
  } else {
    console.log(` 💡 Tip: save this to .agents/AGENTS.md in your workspace root`);
    console.log(`    or paste directly into your IDE's AI rules/instructions panel.`);
  }
  console.log(`${divider}\n`);
  printKickoffBlock(kickoff);
}

function printKickoffBlock(kickoff: string): void {
  const thin = '─'.repeat(70);
  console.log(` 🚀 Session kickoff — paste this at the start of a NEW chat so the agent`);
  console.log(`    commits to the rule immediately instead of drifting into it slowly:`);
  console.log(`${thin}\n`);
  console.log(kickoff);
  console.log(`\n${thin}\n`);
}

/**
 * `devsmind rule` — print the workspace rule and, interactively, help place it
 * in the chosen tool's native rules file (manual snippet or automatic write).
 * Falls back to plain printing when piped/non-TTY or when `--print` is passed,
 * preserving `devsmind rule > file` usage. `--manual` picks the manual workflow
 * style non-interactively (the fallback path has no prompt to ask with).
 */
export async function handleRule(opts: { path?: string; print?: boolean; manual?: boolean }): Promise<void> {
  const devmindDir = resolveDevmindDir(opts.path);

  if (!devmindDir) {
    console.error(
      `❌ No .devmind directory found.\n` +
      `   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.`
    );
    process.exit(1);
  }

  const configPath = path.join(devmindDir, 'config.json');
  let config: DevMindConfig;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as DevMindConfig;
  } catch {
    console.error(`❌ Failed to read config.json at ${configPath}`);
    process.exit(1);
    return;
  }

  const projectName = config.project_name;

  // Backward-compat: piped/redirected output or explicit --print → plain print, no prompts.
  if (opts.print || !process.stdout.isTTY) {
    const workflowStyle: WorkflowStyle = opts.manual ? 'manual' : 'automatic';
    const rule = buildRule(config, devmindDir, workflowStyle);
    printRuleBanner(rule, buildKickoffPrompt(workflowStyle), projectName);
    return;
  }

  const workspaceRoot = path.dirname(devmindDir);

  try {
    const target = await pickTarget();
    const workflowStyle = await pickWorkflowStyle();
    const rule = buildRule(config, devmindDir, workflowStyle);
    const kickoff = buildKickoffPrompt(workflowStyle);
    const mode = await pickMode();

    if (mode === 'manual') {
      const scope = target.rules.scopes[0];
      const file = resolveScopeFile(scope.file, scope.scope, workspaceRoot);
      const noteFrontmatter = target.rules.wrap
        ? '\n    (this file needs frontmatter — automatic mode adds it for you)'
        : '';
      printRuleBanner(
        rule,
        kickoff,
        projectName,
        ` 💡 Save this to ${file.replace(/\\/g, '/')}${noteFrontmatter}`
      );
      return;
    }

    // Automatic mode (install method — writes the rule file for you).
    const scope = await pickRuleScope(target);
    let filePath: string;
    if (scope.scope === 'project') {
      const base = await pickDirectory(workspaceRoot, `Where is the project root for ${target.label}?`);
      filePath = path.join(base, resolveOsPath(scope.file));
    } else {
      filePath = resolveScopeFile(scope.file, 'global', workspaceRoot);
    }

    const merged = mergeRuleFile(filePath, rule, target.rules.style, target.rules.wrap);
    if (merged.error) {
      console.error(`\n❌ ${merged.error}`);
      return;
    }

    console.log(`\n📝 Target: ${filePath.replace(/\\/g, '/')}  (${merged.existed ? (target.rules.style === 'append-section' ? 'merge DevsMind block into existing' : 'overwrite dedicated file') : 'create new'})`);
    console.log(`\n${target.rules.style === 'append-section' ? 'The DevsMind block to be written:' : 'File contents to be written:'}\n`);
    console.log(merged.preview.split('\n').map(l => '   ' + l).join('\n'));

    const ok = await confirmPrompt('Write this?', true);
    if (!ok) {
      console.log('\nAborted — nothing written.');
      return;
    }

    writeConfigFile(filePath, merged.content);
    console.log(`\n✅ DevsMind rule written to ${filePath.replace(/\\/g, '/')} for ${target.label}.\n`);
    printKickoffBlock(kickoff);
  } catch (err) {
    if (err instanceof CancelledError) {
      console.log('\nCancelled.');
      return;
    }
    throw err;
  }
}
