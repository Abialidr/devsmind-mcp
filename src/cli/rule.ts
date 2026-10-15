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
    ? `DevsMind is this team's shared code graph: every teammate's agent reads the same one. ${bt}get_node_code${bt} shows what git can't: live callers/callees and, with ${bt}history:"full"${bt}, why a change was made. Reading it is never optional: check it before you touch code. **Writing to it is the developer's call: this project is MANUAL, so only stage or commit when explicitly asked.**`
    : `DevsMind is this team's shared code graph: every teammate's agent reads the same one you write to. ${bt}get_node_code${bt} shows what git can't: live callers/callees and, with ${bt}history:"full"${bt}, why a change was made. It is only as good as what gets recorded, so recording is not optional.`;

  const editRow = manual
    ? `| Editing a file | ${bt}edit_node${bt} (${bt}file_path${bt} + ${bt}old_string${bt} + ${bt}new_string${bt}) is a safe drop-in for your edit tool and traces for you if you later commit; optional here |`
    : `| ANY edit to ANY file | ${bt}edit_node${bt} (${bt}file_path${bt} + ${bt}old_string${bt} + ${bt}new_string${bt}), never your own edit tool. It never refuses a file type and traces what you changed |`;
  const createRow = manual
    ? `| Creating a NEW file | ${bt}edit_node${bt} with ${bt}old_string: ""${bt} works the same way |`
    : `| Create a NEW file | ${bt}edit_node${bt} with ${bt}old_string: ""${bt} and the whole file as ${bt}new_string${bt} |`;
  const commitRow = manual
    ? `| The developer explicitly asks you to commit/save/record this | ${bt}commit_changes${bt}, never on your own initiative |`
    : `| Checkpoints in a long task, and before ending a turn with staged work | ${bt}commit_changes${bt} |`;
  const stageChangeRow = `| A file already got edited WITHOUT ${bt}edit_node${bt} | ${bt}stage_change${bt}: same params as ${bt}edit_node${bt}, but it never writes the file, it only traces and stages the change already on disk. Prefer ${bt}edit_node${bt}; this only recovers a miss |`;

  const recordingHeader = manual
    ? '### Recording Changes: Manual, Only When Asked'
    : '### Recording Changes: Per Node, At Checkpoints';

  const feedbackFields = `${bt}graph_problems${bt}, ${bt}edge_problems${bt}, ${bt}tools_used${bt}, ${bt}dropped_and_why${bt}, ${bt}devsmind_better${bt}`;
  const commitContract = `${bt}commit_changes${bt} REQUIRES all three of ${bt}message${bt} (the user's request, verbatim; reuse the exact text on later commits for the same request), ${bt}reasoning${bt} (ONE ${bt}what_changed${bt}/${bt}why${bt}/${bt}goal${bt} object for everything staged since the last commit) and ${bt}feedback${bt} (5 strings: ${feedbackFields}; each must be answered, ${bt}"none"${bt} is fine only after you checked whether this task cost an extra call, a guess or a wrong turn). A brand-NEW node also needs a ${bt}description${bt} (1-3 sentences of purpose, in words a teammate would search by): pass it on the ${bt}edit_node${bt} call that created it, or call ${bt}add_description${bt}.`;
  const notGit = `${bt}commit_changes${bt} is NOT git: it writes only to DevsMind's local graph. Never ${bt}git add${bt}/${bt}git commit${bt}/${bt}git push${bt} on your own initiative because it succeeded or a task feels done; that stays the developer's decision, only when asked.`;

  const recordingBody = manual ? [
    `This project is **MANUAL**. Search/read tools (${bt}search_nodes${bt}, ${bt}get_node_code${bt}) stay always on. The write side is different:`,
    '',
    `1. Do **not** call ${bt}commit_changes${bt} on your own initiative: not after an edit, not at a checkpoint, not because a turn is ending.`,
    `2. If the developer asks you to commit/save/record something, ${bt}edit_node${bt} has already staged what it traced. ${commitContract} Set ${bt}message${bt} to their request verbatim.`,
    `3. ${bt}session_id${bt} is mechanically required on every write in both styles (see above); calling ${bt}start_session${bt} does not mean anything is being tracked.`,
    `4. Don't narrate that you skipped committing; silence is the default here.`,
    `5. ${notGit}`,
  ] : [
    `1. ${bt}edit_node${bt} is the write path for **every** file, never your own edit/write tool. Writes landing outside any function (markup, config, imports) get no graph node, which is expected; the whole-file change is still staged so ${bt}commit_changes${bt} makes it revertable.`,
    `2. Call ${bt}commit_changes${bt} at natural checkpoints, not once at the end. ${bt}edit_node${bt} only stages. Always commit before ending a turn with anything staged.`,
    `3. ${commitContract}`,
    `4. Before writing ${bt}"none"${bt} in ${bt}feedback${bt}, actually check; one specific sentence with evidence (${bt}file:line${bt}) beats a reflexive "none". Never invent an issue. It is the only channel that improves DevsMind; ${bt}add_feedback${bt} sends the same 5 categories on demand.`,
    `5. Don't print node/history data as text instead of calling the tools; that records nothing.`,
    `6. ${notGit}`,
  ];

  const lines = [
    '## DevsMind — AI Brain',
    '',
    `**DEVMIND_PATH**: ${bt}${safeDevmindDir}${bt}`,
    `**Project**: ${projectName} | **Mode**: ${mode} | **Tech**: ${techLine} | **Session timeout**: ${timeout}min`,
    `**Repos**: ${repoLines}`,
    `**Workflow style**: ${manual ? 'MANUAL: DevsMind is for search & context; stage/commit only when explicitly asked' : 'AUTOMATIC: stage, commit and track every edit without being asked'}`,
    notes ? `**Notes**: ${notes}` : '',
    '',
    '### What This Is',
    '',
    whatThisIs,
    '',
    `**${bt}session_id${bt} is required on every DevsMind WRITE** (${bt}edit_node${bt}, ${bt}commit_changes${bt}, the other mutating calls); read-only tools do not need it. Call ${bt}start_session${bt} before your first write and reuse the id it returns for the rest of the conversation (never invent one). ${bt}get_activity_log${bt} also takes ${bt}session_id${bt} as an OPTIONAL filter: don't pass your own by default or you silently narrow the query to one session.`,
    '',
    '### Tool Triggers',
    '',
    '| Situation | Tool |',
    '|-----------|------|',
    `| **Before your first WRITE** | ${bt}start_session${bt}, which mints the ${bt}session_id${bt} writes require. On a resumed conversation reuse the earlier id |`,
    `| Find a module, feature, concept or code fragment, or config/CSS/markup the graph doesn't index | ${bt}search_nodes${bt} with ${bt}query${bt} (natural language) and/or ${bt}pattern${bt} (a real regex, used exactly as you'd give grep). Returns ${bt}nodes${bt} (triage on ${bt}confidence${bt}/${bt}relevance${bt}, not on a plausible-looking name) and ${bt}files${bt} (a real grep of every repo). ${bt}nodes_total${bt}/${bt}files_total${bt} are exact; a ${bt}compacted${bt} field says what was trimmed (${bt}compact:false${bt} for all). Never start with your own grep; retry once with a different query before giving up |`,
    `| List everything in a component or directory | ${bt}list_nodes${bt}, paged: ${bt}total${bt} is the true count, a ${bt}hint${bt} names the next call |`,
    `| Read ONE function/class | ${bt}get_node_code${bt}: imports, named callers/callees, file outline and recent reasoning included, so no raw file read afterward |`,
    `| Trace a flow, or what breaks if I change this | ${bt}get_node_code${bt} with ${bt}graph_depth${bt} + ${bt}graph_direction${bt}: ${bt}"out"${bt} + ${bt}graph_code:true${bt} for a whole call flow, ${bt}"in"${bt} at depth 2-3 for the full blast radius. One call, not a chain |`,
    `| Before refactoring | ${bt}get_node_code${bt} with ${bt}history:"full"${bt}: every revision with diffable edits |`,
    `| "What changed recently?" / which files did you touch / what did a TEAMMATE change | ${bt}get_activity_log${bt}: every entry lists its ${bt}files${bt}. ${bt}source${bt} defaults to ${bt}"auto"${bt} (local log, falling back to shared history); use ${bt}"both"${bt} for teammates' work |`,
    editRow,
    createRow,
    stageChangeRow,
    commitRow,
    `| Function/class renamed | ${bt}rename_node${bt} |`,
    `| Function/class removed | ${bt}deprecate_node${bt}. Never delete: history is lost |`,
    '',
    recordingHeader,
    '',
    ...recordingBody,
    '',
    '### Other Rules',
    '',
    `1. **Index natively** with ${bt}index_start${bt}/${bt}index_checkpoint${bt}/${bt}index_continue${bt}/${bt}index_complete${bt}, no external scripts, and don't pause mid-index for confirmation.`,
    `2. **Drift:** ${bt}snapshot_outdated:true${bt} from ${bt}get_node_code${bt} means the graph disagrees with disk; an ${bt}edit_node${bt} on that node resyncs it, otherwise run ${bt}devsmind reindex${bt}. ${bt}source:"cached"${bt} means the symbol wasn't found: verify, then ${bt}rename_node${bt} or ${bt}deprecate_node${bt}.`,
    `3. **Before multi-day work** call ${bt}workflow_list${bt}; if one matches, offer to continue it (${bt}workflow_bind${bt} then ${bt}workflow_get_context${bt}). Binding is local to your session. Once bound, ${bt}commit_changes${bt} logs steps itself; use ${bt}workflow_add_step${bt} only for a decision or research finding that changed no code (docs via ${bt}doc_paths${bt}, ${bt}doc_uploads${bt} or ${bt}doc_content${bt}). ${bt}workflow_sync${bt} attaches earlier work, previewing until ${bt}confirm:true${bt}.`,
    `4. **Maintenance:** ${bt}analyze_graph${bt} is a zero-token health check (${bt}fix:true${bt} for safe fixes). The graph-feedback loop is ${bt}read_graph_feedback${bt}, re-verify, fix (${bt}record_alias${bt}/${bt}link_nodes${bt}/${bt}merge_nodes${bt}/${bt}split_node${bt}/${bt}create_missing_node${bt}), then ${bt}mark_graph_feedback_processed${bt}, even for reports that don't apply, or the queue never drains. ${bt}get_visualizer_url${bt} opens the graph view.`,
    '',
    `Every tool's own description lists its parameters and limits.`,
  ];

  return lines.filter(l => l !== null).join('\n');
}

/** Keep always-loaded Codex/Gemini rules small; the full rule lives in one shared Markdown file. */
function buildSharedRulePointer(ruleFile: string, workflowStyle: WorkflowStyle): string {
  const lines = [
    `For DevsMind work, read and follow \`${ruleFile.replace(/\\/g, '/')}\`. That file is the single full DevsMind rule shared by Codex and Gemini. Keep DevsMind instructions there; do not duplicate them in this file.`,
  ];
  if (workflowStyle === 'manual') {
    lines.push('', 'Project policy: DevsMind writes are manual. Search and read freely, but stage or commit graph changes only when the developer explicitly asks.');
  }
  return lines.join('\n');
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
    const workflowStyle: WorkflowStyle = opts.manual ? 'manual' : 'automatic';
    const rule = buildRule(config, devmindDir, workflowStyle);
    let sharedRulePath = target.rules.sharedRuleFile
      ? resolveScopeFile(target.rules.sharedRuleFile, 'project', workspaceRoot)
      : null;
    const agentRule = sharedRulePath
      ? buildSharedRulePointer(target.rules.sharedRuleFile!, workflowStyle)
      : rule;
    const kickoff = buildKickoffPrompt(workflowStyle);
    const mode = await pickMode();

    if (mode === 'manual') {
      const scope = target.rules.scopes[0];
      const file = resolveScopeFile(scope.file, scope.scope, workspaceRoot);
      const noteFrontmatter = target.rules.wrap
        ? '\n    (this file needs frontmatter — automatic mode adds it for you)'
        : '';
      if (sharedRulePath) {
        printRuleBanner(rule, kickoff, projectName, ` 💡 Save this full rule to ${sharedRulePath.replace(/\\/g, '/')}.`);
        console.log(`AGENTS.md pointer to add to ${file.replace(/\\/g, '/')}${noteFrontmatter}:\n`);
        console.log(mergeRuleFile(file, agentRule, target.rules.style, target.rules.wrap).preview);
      } else {
        printRuleBanner(
          rule,
          kickoff,
          projectName,
          ` 💡 Save this to ${file.replace(/\\/g, '/')}${noteFrontmatter}`
        );
      }
      return;
    }

    // Automatic mode (install method — writes the rule file for you).
    const scope = await pickRuleScope(target);
    let filePath: string;
    if (scope.scope === 'project') {
      const base = await pickDirectory(workspaceRoot, `Where is the project root for ${target.label}?`);
      filePath = path.join(base, resolveOsPath(scope.file));
      if (target.rules.sharedRuleFile) {
        sharedRulePath = path.join(base, resolveOsPath(target.rules.sharedRuleFile));
      }
    } else {
      filePath = resolveScopeFile(scope.file, 'global', workspaceRoot);
    }

    const merged = mergeRuleFile(filePath, agentRule, target.rules.style, target.rules.wrap);
    const sharedMerged = sharedRulePath
      ? mergeRuleFile(sharedRulePath, rule, 'standalone')
      : null;
    const mergeError = merged.error ?? sharedMerged?.error;
    if (mergeError) {
      console.error(`\n❌ ${mergeError}`);
      return;
    }

    console.log(`\n📝 Target: ${filePath.replace(/\\/g, '/')}  (${merged.existed ? (target.rules.style === 'append-section' ? 'merge DevsMind block into existing' : 'overwrite dedicated file') : 'create new'})`);
    console.log(`\n${target.rules.style === 'append-section' ? 'The DevsMind block to be written:' : 'File contents to be written:'}\n`);
    console.log(merged.preview.split('\n').map(l => '   ' + l).join('\n'));
    if (sharedMerged && sharedRulePath) {
      console.log(`\n📝 Full DevsMind rule: ${sharedRulePath.replace(/\\/g, '/')} (${sharedMerged.existed ? 'overwrite generated rule' : 'create new'})`);
      console.log(sharedMerged.preview.split('\n').map(l => '   ' + l).join('\n'));
    }

    const ok = await confirmPrompt('Write this?', true);
    if (!ok) {
      console.log('\nAborted — nothing written.');
      return;
    }

    if (sharedMerged && sharedRulePath) writeConfigFile(sharedRulePath, sharedMerged.content);
    writeConfigFile(filePath, merged.content);
    console.log(`\n✅ DevsMind rule written to ${filePath.replace(/\\/g, '/')} for ${target.label}.${sharedRulePath ? ` Full rule: ${sharedRulePath.replace(/\\/g, '/')}.` : ''}\n`);
    printKickoffBlock(kickoff);
  } catch (err) {
    if (err instanceof CancelledError) {
      console.log('\nCancelled.');
      return;
    }
    throw err;
  }
}
