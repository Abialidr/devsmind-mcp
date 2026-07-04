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

  const rule = `
## DevsMind — AI Brain

**DEVMIND_PATH**: \`${devmindDir}\`
**Project**: ${projectName} | **Mode**: ${mode} | **Tech**: ${techLine} | **Session timeout**: ${timeout}min
**Repos**: ${repoLines}
${notes ? `**Notes**: ${notes}` : ''}

### Tool Triggers

| Situation | Tool |
|-----------|------|
| Searching for a module, feature, or concept | \`search_nodes\` |
| Working on / debugging a specific function or class | \`get_node_summary\` → \`get_node_history\` → \`get_node_graph\` |
| After finishing code edits to a function/class | \`update_history\` (once per session, not per message) |
| Function/class is renamed | \`rename_node\` |
| Function/class is removed from codebase | \`deprecate_node\` |

### Critical Rules

1. **Never guess dependencies** — call \`get_node_graph\` before touching any function signature.
2. **Always read history first** — call \`get_node_history\` before refactoring to understand past decisions.
3. **No deletions** — never delete nodes. Use \`deprecate_node\` to preserve history.
4. **Resurrecting nodes** — calling \`update_history\` or \`add_node\` on a deprecated node automatically re-activates it.
5. **Search before grep** — use \`search_nodes\` before any filesystem search.

### Available Tools
\`search_nodes\` · \`get_node_summary\` · \`get_node_graph\` · \`get_node_history\` · \`update_history\` · \`add_node\` · \`add_connection\` · \`rename_node\` · \`deprecate_node\` · \`get_recent_changes\` · \`get_developer_activity\` · \`get_changes_by_requirement\` · \`search_decisions\` · \`get_orphaned_nodes\` · \`recheck_graph\` · \`get_visualizer_url\`

> All tool schemas and argument details are exposed automatically by the MCP server.
`.trim();

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
