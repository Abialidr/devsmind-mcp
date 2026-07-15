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
    '### ⚠️ CRITICAL PRE-FLIGHT CHECK & FEW-SHOT EXAMPLE',
    '',
    'Before executing any filesystem search or reading any file contents, you MUST perform this check:',
    `1. **Am I searching for code/modules/features?** -> You MUST use ${bt}search_nodes${bt} or ${bt}search_code${bt} first. DO NOT start with grep or native filesystem search.`,
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
    `| Searching for a module, feature, or concept | ${bt}search_nodes${bt} |`,
    `| Searching for specific code fragments, variables, or regex patterns | ${bt}search_code${bt} |`,
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
    'This is NOT optional. Whenever you add, modify, rename, or delete code, you MUST record it in the graph in the SAME turn — before you consider the task done. An answer that changed code but did not update the graph is INCOMPLETE.',
    '',
    `1. **For ANY change (one file or many):** call ${bt}stage_change${bt} EXACTLY ONCE for EVERY function/class/entity you touched — pass its ${bt}node_id${bt}, ${bt}file_path${bt}, ${bt}code_snapshot${bt}, and ${bt}reasoning${bt}. You do NOT reason about connections. When every touched entity is staged, call ${bt}commit_changes${bt} EXACTLY ONCE.`,
    `2. **⚠️ ${bt}commit_changes${bt} IS REQUIRED.** Staging alone writes NOTHING to the graph. If you call ${bt}stage_change${bt} and forget ${bt}commit_changes${bt}, all your work is lost and the run is wasted. NEVER end your turn with un-committed staged changes.`,
    `3. **Do NOT hand-manage edges.** ${bt}commit_changes${bt} resolves all connections from the code via AST automatically. Never try to reason about or pass connections yourself.`,
    `4. **Do NOT print node/history data as text instead of calling the tools.** Printing does not write to the graph and wastes the turn.`,
    '',
    '### Critical Rules',
    '',
    `1. **Never guess dependencies** — call ${bt}get_node_graph${bt} before touching any function signature.`,
    `2. **Always read history first** — call ${bt}get_node_history${bt} before refactoring to understand past decisions.`,
    `3. **No deletions** — never delete nodes. Use ${bt}deprecate_node${bt} to preserve history.`,
    `4. **Resurrecting nodes** — calling ${bt}stage_change${bt} on a deprecated node automatically re-activates it on the next ${bt}commit_changes${bt}.`,
    `5. **Search before grep** — use ${bt}search_nodes${bt} or ${bt}search_code${bt} before any filesystem search. If no nodes are found using ${bt}search_nodes${bt}, use the ${bt}list_nodes${bt} tool to see all available nodes in the graph.`,
    `6. **Read code through the graph, not the filesystem** — call ${bt}get_node_code${bt} instead of opening a source file. It parses the node live from disk and returns only that entity, so it is always current AND far cheaper than reading the whole file. If the node isn't in the graph at all, read the file, then ${bt}stage_change${bt} + ${bt}commit_changes${bt} to add it.`,
    `7. **Fix drift when the tools report it** — if ${bt}get_node_code${bt} returns ${bt}snapshot_outdated: true${bt}, the graph has fallen behind the code on disk. Re-record that node with ${bt}stage_change${bt} + ${bt}commit_changes${bt}. If it returns ${bt}source: "cached"${bt}, the symbol could NOT be found in its file — it was likely renamed, moved, or deleted, so the code you got may be wrong. Verify against the file, then ${bt}rename_node${bt} or ${bt}deprecate_node${bt} as appropriate.`,
    `8. **No external scripts for indexing** — When indexing a repository, NEVER write or run external scripts (like Python, Bash, or Node.js) to automate or lazy load indexing. You must perform the indexing natively step-by-step in the chat using the designated tools: ${bt}index_start${bt}, ${bt}index_checkpoint${bt}, ${bt}index_continue${bt}, and ${bt}index_complete${bt}. This ensures progress is tracked in the SQLite scratchpad database and allows indexing to be safely resumed across chat sessions if context limits are hit.`,
    `9. **Continuous Indexing** — Once you start the codebase indexing process, do not stop, pause, or ask for user confirmation between checkpoints. Keep executing and indexing files continuously until the workspace is fully indexed, or until the chat session's context token limit is reached.`,
    `10. **Grow-as-you-go Graph Maintenance (MANDATORY)** — DevsMind is a living code graph and keeping it in sync is a hard requirement, not a nicety. At the end of EVERY task or message where code was added, modified, renamed, or deleted, you MUST record it per the "MANDATORY: Record Every Code Change" section above — ${bt}stage_change${bt} per touched entity then ${bt}commit_changes${bt} once. NEVER finish a turn with un-committed staged changes. If you notice deprecated/stale nodes, clean them up with ${bt}deprecate_node${bt} or ${bt}rename_node${bt}. Do not let the graph go stale.`,
    '',
    '### Available Tools',
    '',
    '| Tool | Use when |',
    '|------|----------|',
    `| ${bt}search_nodes${bt} | Find nodes by name, keyword, or reasoning text |`,
    `| ${bt}search_code${bt} | Regex or string search over cached codebase code snapshots |`,
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
