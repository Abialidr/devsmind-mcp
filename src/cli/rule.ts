import * as fs from 'fs';
import * as path from 'path';
import { DevMindConfig } from '../utils/config';

function findDevmindDir(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, '.devmind');
    if (fs.existsSync(path.join(candidate, 'config.json'))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function handleRule(opts: { path?: string }) {
  const cwd = process.cwd();

  let devmindDir: string | null;
  if (opts.path) {
    const resolved = path.resolve(opts.path);
    devmindDir = fs.existsSync(path.join(resolved, 'config.json')) ? resolved : null;
  } else {
    devmindDir = findDevmindDir(cwd);
  }

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
  }

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
    '### Tool Triggers',
    '',
    '| Situation | Tool |',
    '|-----------|------|',
    `| Searching for a module, feature, or concept | ${bt}search_nodes${bt} |`,
    `| Want to list/discover all nodes for a component or directory | ${bt}list_nodes${bt} |`,
    `| Need to read the code of a specific function/class | ${bt}get_node_code${bt} |`,
    `| Working on / debugging a specific function or class | ${bt}get_node_summary${bt} → ${bt}get_node_history${bt} → ${bt}get_node_graph${bt} |`,
    `| After finishing code edits to a function/class | ${bt}update_history${bt} (once per session, not per message) |`,
    `| Function/class is renamed | ${bt}rename_node${bt} |`,
    `| Function/class is removed from codebase | ${bt}deprecate_node${bt} |`,
    '',
    '### Critical Rules',
    '',
    `1. **Never guess dependencies** — call ${bt}get_node_graph${bt} before touching any function signature.`,
    `2. **Always read history first** — call ${bt}get_node_history${bt} before refactoring to understand past decisions.`,
    `3. **No deletions** — never delete nodes. Use ${bt}deprecate_node${bt} to preserve history.`,
    `4. **Resurrecting nodes** — calling ${bt}update_history${bt} or ${bt}add_node${bt} on a deprecated node automatically re-activates it.`,
    `5. **Search before grep** — use ${bt}search_nodes${bt} before any filesystem search.`,
    `6. **Code snapshots — populate if missing** — always call ${bt}get_node_code${bt} before reading a source file. If no snapshot exists, read the file, then immediately call ${bt}update_history${bt} with the current code. Do not skip this — it caches the code for all future agents.`,
    `7. **Code snapshots — refresh if stale** — if you open a source file and notice the stored snapshot differs from the actual file, call ${bt}update_history${bt} with the fresh code before making any changes. Stale snapshots must be corrected first.`,
    `8. **No external scripts for indexing** — When indexing a repository, NEVER write or run external scripts (like Python, Bash, or Node.js) to automate or lazy load indexing. You must perform the indexing natively step-by-step in the chat using the designated tools: ${bt}index_start${bt}, ${bt}index_checkpoint${bt}, ${bt}index_continue${bt}, and ${bt}index_complete${bt}. This ensures progress is tracked in the SQLite scratchpad database and allows indexing to be safely resumed across chat sessions if context limits are hit.`,
    `9. **Continuous Indexing** — Once you start the codebase indexing process, do not stop, pause, or ask for user confirmation between checkpoints. Keep executing and indexing files continuously until the workspace is fully indexed, or until the chat session's context token limit is reached.`,
    '',
    '### Available Tools',
    '',
    '| Tool | Use when |',
    '|------|----------|',
    `| ${bt}search_nodes${bt} | Find nodes by name, keyword, or reasoning text |`,
    `| ${bt}list_nodes${bt} | List nodes in the graph with optional filters (type, file path, etc.) |`,
    `| ${bt}get_node_summary${bt} | Get file location, connection count, history count for a node |`,
    `| ${bt}get_node_code${bt} | Get latest stored code snapshot for a node (check before reading file) |`,
    `| ${bt}get_node_graph${bt} | See all callers/dependencies of a node up to N levels deep |`,
    `| ${bt}get_node_history${bt} | Read all past snapshots and reasoning logs for a node |`,
    `| ${bt}update_history${bt} | Save a code snapshot + reasoning after editing a function/class |`,
    `| ${bt}add_node${bt} | Register a new function, class, or entity in the graph |`,
    `| ${bt}add_connection${bt} | Link two nodes with a caller → callee dependency |`,
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

  const rule = lines.filter(l => l !== null).join('\n');

  const divider = '═'.repeat(70);

  console.log(`\n${divider}`);
  console.log(` DevsMind Workspace Rule — "${projectName}"`);
  console.log(` Copy the block below into your AI workspace rules file`);
  console.log(`${divider}\n`);
  console.log(rule);
  console.log(`\n${divider}`);
  console.log(` 💡 Tip: save this to .agents/AGENTS.md in your workspace root`);
  console.log(`    or paste directly into your IDE's AI rules/instructions panel.`);
  console.log(`${divider}\n`);
}
