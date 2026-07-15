import * as fs from 'fs';
import * as path from 'path';
import { DevMindConfig, resolveDevmindDir } from '../utils/config';
import {
  pickTarget,
  pickMode,
  pickRuleScope,
  pickDirectory,
  confirmPrompt,
  mergeRuleFile,
  writeConfigFile,
  CancelledError,
} from './integrations/prompt';
import { resolveScopeFile, resolveOsPath } from './integrations/registry';
import { INDEXABLE_EXTENSIONS } from '../utils/scanner';

/**
 * Build the ready-to-paste DevsMind workspace rule from a project's config.
 * Pure string builder — no I/O — so it can be printed or written to a file.
 */
export function buildRule(config: DevMindConfig, devmindDir: string): string {
  const projectName = config.project_name;
  const mode = config.mode;
  const notes = config.notes;
  const tech = config.tech_stack;
  const repos = config.repos;

  const repoLines = repos
    .map(r => ('relative_path' in r ? `${r.name} → ${r.relative_path}` : `${r.name} → env:${r.path_key}`))
    .join(', ');

  const techLine = tech
    ? [...(tech.languages || []), ...(tech.frameworks || [])].join(', ')
    : 'Not specified';

  const timeout = config.session_timeout_minutes ?? 60;
  const safeDevmindDir = devmindDir.replace(/\\/g, '/');

  const bt = '`';

  const lines = [
    '## DevsMind — AI Brain',
    '',
    `**DEVMIND_PATH**: ${bt}${safeDevmindDir}${bt}`,
    `**Project**: ${projectName} | **Mode**: ${mode} | **Tech**: ${techLine} | **Session timeout**: ${timeout}min`,
    `**Repos**: ${repoLines}`,
    notes ? `**Notes**: ${notes}` : '',
    '',
    '### 🧠 What DevsMind Actually Is — Read This First',
    '',
    'This is NOT a normal tool you reach for only when asked to search something. DevsMind is the **persistent shared brain for this entire team** — every teammate\'s AI agent, in every session, reads from the exact same graph you are about to write to. There is no "your copy" vs "their copy."',
    '',
    `**If you skip ${bt}stage_change${bt} + ${bt}commit_changes${bt}, you are not skipping a formality.** You are leaving the graph stale for every other developer's AI agent that queries this code later — tomorrow, next week, on a completely different task. And the reasoning behind your change (why it was made, what ticket drove it, what was broken before, what you tried and rejected) exists **only in this conversation, right now**. It is not in the diff. It is not in the commit message. If it isn't recorded this turn, it is gone forever — no reindex, no log, no ${bt}git blame${bt} can ever recover it.`,
    '',
    `* ${bt}get_node_graph${bt} fills the gap git can't: git shows you WHAT lines changed, never what depends on them. This gives you the live call graph instantly — every caller, every callee — so you find out what breaks BEFORE you change a signature, not after a teammate hits the bug.`,
    `* ${bt}get_node_history${bt} fills a different gap: git blame tells you WHO and WHEN. It never tells you WHY. The actual decision — what was tried, what was rejected, what ticket demanded this, what was broken before — only exists here, written by whichever AI agent made the change. Skip it before refactoring and you risk silently re-breaking a bug that was already fixed once, or undoing a decision that had a reason you never saw.`,
    '',
    '### ⚠️ CRITICAL PRE-FLIGHT CHECK & FEW-SHOT EXAMPLE',
    '',
    'Before executing any filesystem search or reading any file contents, you MUST perform this check:',
    `1. **Am I searching for code/modules/features?** -> You MUST use ${bt}search_nodes${bt} first — it searches names/reasoning AND falls back to full code-content search automatically if nothing matches, in the SAME call. DO NOT start with grep or native filesystem search.`,
    `2. **Am I reading a source file?** -> You MUST call ${bt}get_node_code${bt} instead. It returns that one function/class parsed live from the file, not the whole file — far cheaper. Only read the raw file if the node genuinely isn't in the graph.`,
    `3. **Am I tracing how something flows through the code?** -> You MUST call ${bt}get_node_graph${bt} with ${bt}direction: "out"${bt} and ${bt}include_code: true${bt}. This returns the entry point PLUS everything it transitively calls, each with its source, in ONE call. Do NOT chain ${bt}get_node_code${bt} calls one function at a time — that wastes a chat turn per function.`,
    '',
    '#### Correct Workflow Example (single entity):',
    '* **User asks:** "Explain how rule generation works."',
    `* **Step 1 (Search):** Call ${bt}search_nodes${bt} with query "rule".`,
    `* **Step 2 (Get Code):** Call ${bt}get_node_code${bt} with node_id "${bt}{DevMinds}/src/cli/rule.ts#handleRule${bt}".`,
    '* **Step 3 (Explain):** Explain the logic using the returned code.',
    '',
    '#### Correct Workflow Example (tracing a flow — DO THIS, it is 2 turns not 15):',
    '* **User asks:** "How does an Alipay payment get processed end to end?"',
    `* **Step 1 (Find the entry point):** Call ${bt}search_nodes${bt} with query "alipay".`,
    `* **Step 2 (Pull the whole flow at once):** Call ${bt}get_node_graph${bt} with the entry node_id, ${bt}direction: "out"${bt}, ${bt}include_code: true${bt}, ${bt}max_depth: 3${bt}.`,
    '* **Step 3 (Explain):** You now have every function in the call chain with its code. Explain the flow. Do NOT make further tool calls to fetch code you already have.',
    '',
    '### Tool Triggers',
    '',
    '| Situation | Tool |',
    '|-----------|------|',
    `| Searching for a module, feature, concept, code fragment, variable, or regex pattern | ${bt}search_nodes${bt} (name/reasoning match, auto-falls-back to code-content search) |`,
    `| Want to list/discover all nodes for a component or directory | ${bt}list_nodes${bt} |`,
    `| Need to read the code of ONE specific function/class | ${bt}get_node_code${bt} |`,
    `| Tracing a request/feature/flow through MULTIPLE functions | ${bt}get_node_graph${bt} with ${bt}direction:"out"${bt} + ${bt}include_code:true${bt} (ONE call — never chain ${bt}get_node_code${bt}) |`,
    `| Need to know what would break if I change this | ${bt}get_node_graph${bt} with ${bt}direction:"in"${bt} (finds every caller) |`,
    `| Working on / debugging a specific function or class | ${bt}get_node_summary${bt} → ${bt}get_node_history${bt} → ${bt}get_node_graph${bt} |`,
    `| After adding/editing code (one file or many) | ${bt}stage_change${bt} once per touched entity, then ${bt}commit_changes${bt} once |`,
    `| Function/class is renamed | ${bt}rename_node${bt} |`,
    `| Function/class is removed from codebase | ${bt}deprecate_node${bt} |`,
    '',
    '### ⚠️ MANDATORY: Record Every Code Change in the Graph',
    '',
    'This is NOT optional. Whenever you add, modify, rename, or delete code, you MUST record it in the graph in the SAME turn — before you consider the task done. An answer that changed code but did not update the graph is INCOMPLETE: the code changed, but every other developer\'s AI agent querying this project still sees the old version and none of the reasoning behind the new one.',
    '',
    `**Scope — this applies to source code only.** ${bt}stage_change${bt} models functions/classes/logic entities and will be REJECTED for anything outside: ${Array.from(INDEXABLE_EXTENSIONS).sort().join(', ')}. Do NOT stage stylesheets (${bt}.css${bt}/${bt}.scss${bt}/${bt}.less${bt}), markup, JSON/config, docs, images, or other non-code assets — they have no callers/callees to resolve and only bloat the graph with dead-end nodes. If a file's extension isn't in that list, skip it; do not retry.`,
    '',
    `1. **For ANY change (one file or many):** call ${bt}stage_change${bt} EXACTLY ONCE for EVERY function/class/entity you touched — pass its ${bt}node_id${bt}, ${bt}file_path${bt}, ${bt}code_snapshot${bt}, and ${bt}reasoning${bt}. You do NOT reason about connections. The ${bt}reasoning${bt} you write is the whole point — it's the only place "why" ever gets recorded, and it only exists if you write it down right now. When every touched entity is staged, call ${bt}commit_changes${bt} EXACTLY ONCE.`,
    `2. **⚠️ ${bt}commit_changes${bt} IS REQUIRED.** Staging alone writes NOTHING to the graph — it just buffers to a local file no one else will ever read. If you call ${bt}stage_change${bt} and forget ${bt}commit_changes${bt}, the reasoning you just wrote is stranded and effectively lost: the next session (yours or a teammate's) starts from a graph that never learned about this change. NEVER end your turn with un-committed staged changes.`,
    `3. **Do NOT hand-manage edges.** ${bt}commit_changes${bt} resolves all connections from the code via AST automatically. Never try to reason about or pass connections yourself — a hand-guessed edge is more likely wrong than one resolved from the actual code.`,
    `4. **Do NOT print node/history data as text instead of calling the tools.** Printing looks like you did the work, but writes nothing to the graph — the next session sees no trace this ever happened.`,
    '',
    '### Critical Rules',
    '',
    `1. **Never guess dependencies** — call ${bt}get_node_graph${bt} before touching any function signature. Git shows you what a diff changed; it never shows you what else calls this function and would silently break. Guessing here is how a "small" change becomes a production incident someone else has to debug without knowing why you touched this.`,
    `2. **Always read history first** — call ${bt}get_node_history${bt} before refactoring to understand past decisions. Skipping this risks re-introducing a bug that was already fixed once, or undoing a decision that had a reason you can't see from the code alone.`,
    `3. **No deletions** — never delete nodes. Use ${bt}deprecate_node${bt} to preserve history, so the reasoning behind code that's no longer active isn't lost the moment it's removed.`,
    `4. **Resurrecting nodes** — calling ${bt}stage_change${bt} on a deprecated node automatically re-activates it on the next ${bt}commit_changes${bt}.`,
    `5. **Search before grep** — use ${bt}search_nodes${bt} before any filesystem search; it tries identifiers first and automatically falls back to a full code-content search if nothing matches, so one call covers both cases. A raw grep finds text; it can't tell you the reasoning already recorded behind that code, which is the whole reason to check here first. If it still finds nothing, use the ${bt}list_nodes${bt} tool to see all available nodes in the graph.`,
    `6. **Read code through the graph, not the filesystem** — call ${bt}get_node_code${bt} instead of opening a source file. It parses the node live from disk and returns only that entity, so it is always current AND far cheaper than reading the whole file. Reading the raw file instead means the graph has no way to know you looked, so any drift between what's recorded and what's on disk goes unnoticed. If the node isn't in the graph at all, read the file, then ${bt}stage_change${bt} + ${bt}commit_changes${bt} to add it.`,
    `7. **Fix drift when the tools report it** — if ${bt}get_node_code${bt} returns ${bt}snapshot_outdated: true${bt}, the graph has fallen behind the code on disk. Re-record that node with ${bt}stage_change${bt} + ${bt}commit_changes${bt}. If it returns ${bt}source: "cached"${bt}, the symbol could NOT be found in its file — it was likely renamed, moved, or deleted, so the code you got may be wrong. Verify against the file, then ${bt}rename_node${bt} or ${bt}deprecate_node${bt} as appropriate. Ignoring a drift signal means everyone after you keeps trusting a record you already know is wrong.`,
    `8. **No external scripts for indexing** — When indexing a repository, NEVER write or run external scripts (like Python, Bash, or Node.js) to automate or lazy load indexing. You must perform the indexing natively step-by-step in the chat using the designated tools: ${bt}index_start${bt}, ${bt}index_checkpoint${bt}, ${bt}index_continue${bt}, and ${bt}index_complete${bt}. This ensures progress is tracked in the SQLite scratchpad database and allows indexing to be safely resumed across chat sessions if context limits are hit.`,
    `9. **Continuous Indexing** — Once you start the codebase indexing process, do not stop, pause, or ask for user confirmation between checkpoints. Keep executing and indexing files continuously until the workspace is fully indexed, or until the chat session's context token limit is reached.`,
    `10. **Grow-as-you-go Graph Maintenance (MANDATORY)** — DevsMind is a living code graph and keeping it in sync is a hard requirement, not a nicety. At the end of EVERY task or message where code was added, modified, renamed, or deleted, you MUST record it per the "MANDATORY: Record Every Code Change" section above — ${bt}stage_change${bt} per touched entity then ${bt}commit_changes${bt} once. NEVER finish a turn with un-committed staged changes. If you notice deprecated/stale nodes, clean them up with ${bt}deprecate_node${bt} or ${bt}rename_node${bt}. A graph that's allowed to go stale stops being worth checking at all — every skipped update is one more reason for the next agent to distrust what's here and fall back to guessing.`,
    '',
    '### Available Tools',
    '',
    '| Tool | Use when |',
    '|------|----------|',
    `| ${bt}search_nodes${bt} | Find code by name, keyword, or reasoning text — auto-falls-back to a regex/string code-content search if nothing matches |`,
    `| ${bt}list_nodes${bt} | List nodes in the graph with optional filters (type, file path, etc.) |`,
    `| ${bt}get_node_summary${bt} | Get file location, connection count, history count for a node |`,
    `| ${bt}get_node_code${bt} | Get ONE node's current source, parsed live from its file (use instead of reading the file) |`,
    `| ${bt}get_node_graph${bt} | See a node's callers/dependencies. With ${bt}direction:"out"${bt} + ${bt}include_code:true${bt}, returns an entire call flow WITH source code in a single call |`,
    `| ${bt}get_node_history${bt} | Read all past snapshots and reasoning logs for a node |`,
    `| ${bt}stage_change${bt} | Buffer one touched node after a code change (code + reasoning only; no edge reasoning) |`,
    `| ${bt}commit_changes${bt} | Flush all staged changes: create nodes, save history, resolve all connections via AST |`,
    `| ${bt}rename_node${bt} | Rename a node ID and update all its connections/history |`,
    `| ${bt}deprecate_node${bt} | Mark a removed function/class as deprecated (preserves history) |`,
    `| ${bt}get_recent_changes${bt} | List nodes modified in the last N hours across the project |`,
    `| ${bt}get_developer_activity${bt} | List recent changes made by a specific developer |`,
    `| ${bt}get_changes_by_requirement${bt} | Find all changes linked to a ticket or requirement ID |`,
    `| ${bt}search_decisions${bt} | Search architectural reasoning and decision logs by keyword |`,
    `| ${bt}get_orphaned_nodes${bt} | Find nodes with no connections (dead code / stale entries) |`,
    `| ${bt}recheck_graph${bt} | Scan files, deprecate nodes for deleted files, clean primitives |`,
    `| ${bt}get_visualizer_url${bt} | Get URL to open the interactive 2D/3D graph visualizer |`,
    '',
    '> All tool argument schemas are exposed automatically by the MCP server.'
  ];

  return lines.filter(l => l !== null).join('\n');
}

function printRuleBanner(rule: string, projectName: string, tip?: string): void {
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
}

/**
 * `devsmind rule` — print the workspace rule and, interactively, help place it
 * in the chosen tool's native rules file (manual snippet or automatic write).
 * Falls back to plain printing when piped/non-TTY or when `--print` is passed,
 * preserving `devsmind rule > file` usage.
 */
export async function handleRule(opts: { path?: string; print?: boolean }): Promise<void> {
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

  const rule = buildRule(config, devmindDir);
  const projectName = config.project_name;

  // Backward-compat: piped/redirected output or explicit --print → plain print.
  if (opts.print || !process.stdout.isTTY) {
    printRuleBanner(rule, projectName);
    return;
  }

  const workspaceRoot = path.dirname(devmindDir);

  try {
    const target = await pickTarget();
    const mode = await pickMode();

    if (mode === 'manual') {
      const scope = target.rules.scopes[0];
      const file = resolveScopeFile(scope.file, scope.scope, workspaceRoot);
      const noteFrontmatter = target.rules.wrap
        ? '\n    (this file needs frontmatter — automatic mode adds it for you)'
        : '';
      printRuleBanner(
        rule,
        projectName,
        ` 💡 Save this to ${file.replace(/\\/g, '/')}${noteFrontmatter}`
      );
      return;
    }

    // Automatic mode.
    const scope = await pickRuleScope(target);
    let filePath: string;
    if (scope.scope === 'project') {
      const base = await pickDirectory(workspaceRoot, `Where is the project root for ${target.label}?`);
      filePath = path.join(base, resolveOsPath(scope.file));
    } else {
      filePath = resolveScopeFile(scope.file, 'global', workspaceRoot);
    }

    const merged = mergeRuleFile(filePath, rule, target.rules.style, target.rules.wrap);

    console.log(`\n📝 Target: ${filePath.replace(/\\/g, '/')}  (${merged.existed ? (target.rules.style === 'append-section' ? 'merge DevsMind block into existing' : 'overwrite dedicated file') : 'create new'})`);
    console.log(`\n${target.rules.style === 'append-section' ? 'The DevsMind block to be written:' : 'File contents to be written:'}\n`);
    console.log(merged.preview.split('\n').map(l => '   ' + l).join('\n'));

    const ok = await confirmPrompt('Write this?', true);
    if (!ok) {
      console.log('\nAborted — nothing written.');
      return;
    }

    writeConfigFile(filePath, merged.content);
    console.log(`\n✅ DevsMind rule written to ${filePath.replace(/\\/g, '/')} for ${target.label}.`);
  } catch (err) {
    if (err instanceof CancelledError) {
      console.log('\nCancelled.');
      return;
    }
    throw err;
  }
}
