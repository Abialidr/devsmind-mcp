import * as fs from 'fs';
import * as path from 'path';
import { DevMindConfig } from '../utils/config';

/**
 * Walk up from `startDir` until we find a `.devmind/config.json`,
 * or return null if not found.
 */
function findDevmindDir(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, '.devmind');
    if (fs.existsSync(path.join(candidate, 'config.json'))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null; // filesystem root
    current = parent;
  }
}

export function handleRule(opts: { path?: string }) {
  const cwd = process.cwd();

  // Resolve .devmind path: explicit flag, or walk up from cwd
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

  // Build the repo list for context
  const repoLines = repos.map(r => {
    if ('relative_path' in r) {
      return `  - ${r.name}  (relative: ${r.relative_path})`;
    } else {
      return `  - ${r.name}  (env key: ${r.path_key})`;
    }
  }).join('\n');

  const techLine = tech
    ? `${[...(tech.languages || []), ...(tech.frameworks || [])].join(', ')}`
    : 'Not specified';

  const timeout = config.session_timeout_minutes ?? 60;

  // ── Rule output ────────────────────────────────────────────────
  const rule = `
## DevsMind — Team AI Brain Instructions

> This project utilizes the **devsmind** MCP server as a shared team brain.
> Always use it when coding in this workspace.

# 🛑 CRITICAL MANDATORY INSTRUCTIONS 🛑
BEFORE answering ANY user request or searching the codebase, you MUST read and understand the project context embedded below. Do not attempt to run any project setup or configuration discovery calls, as you already possess this information from this rule.

### Brain Location
\`\`\`
DEVMIND_PATH = ${devmindDir}
\`\`\`

### Project Context
- **Project Name**: ${projectName}
- **Setup Mode**: ${mode}
- **Tech Stack**: ${techLine}
- **Session Timeout**: ${timeout} minutes
${notes ? `- **Developer Notes**: ${notes}` : ''}

### Tracked Repositories
${repoLines}

### When to Use DevsMind Tools

| Trigger / Action | Tool to call | Protocol & Details |
|------------------|--------------|-------------------|
| **Searching for code modules, logic flow, or conceptual topics (e.g., "auth", "pricing")** | \`search_nodes\` | Call this first to locate potential node candidates. Do not start with filesystem grep. |
| **Explaining, reading, debugging, or modifying a specific function, class, or service** | \`get_node_summary\` | Fetch details. If it exists, call \`get_node_history\` (to see past decisions) and \`get_node_graph\` (to inspect dependencies). |
| **Finishing code changes in a function/class** | \`update_history\` | Call this once the changes are completed to record your snapshot and reasoning. (Apply 1h session rule automatically). |
| **Function/class is renamed** | \`rename_node\` | Rename the old ID to the new ID. This preserves all historical entries and connection points. |
| **Function/class is deleted/removed** | \`deprecate_node\` | Never run delete queries. Instead, call \`deprecate_node\` to clear active connections but preserve reasoning/history. |

### 🛑 CRITICAL PROTOCOLS FOR CODE DEVELOPMENT & DOCUMENTATION 🛑

1. **Zero Hallucination on Architecture**: Never guess which files or functions depend on each other. You MUST call \`get_node_summary\` and \`get_node_graph\` (default depth: 6) to verify callers and dependencies before modifying any signature.
2. **Context-Aware Refactoring**: Always review past history snapshots (\`get_node_history\`) for a function before altering its logic. This prevents repeating past design mistakes or re-introducing resolved bugs.
3. **Resurrecting Deprecated Nodes**: If you re-write or re-introduce a function that was previously marked as deprecated, simply calling \`update_history\` or \`add_node\` will automatically mark the node as active (\`deprecated = 0\`).
4. **Surgical Token Management**: Avoid reading entire files or directories. Use DevsMind tools to retrieve just the active node structure and code snippets.
5. **No Independent Deletions**: Under no circumstances should you attempt to delete nodes or history from the database. Let DevsMind handle it via \`deprecate_node\` or CLI pruning commands.

### Tool Reference

**\`search_nodes\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}",
  "query": "<search query>"
}
\`\`\`
Searches node names, identifiers, or reasoning logs matching the query.

**\`get_node_summary\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}",
  "node_id": "<function or class name>"
}
\`\`\`
Returns file location, history count, connections, and last change timestamp.

**\`get_node_history\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}",
  "node_id": "<function or class name>"
}
\`\`\`
Returns the full version history of a code node, including all past code snapshots and change reasoning.

**\`get_node_graph\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}",
  "node_id": "<starting function or class name>",
  "max_depth": 6
}
\`\`\`
Returns a localized node dependency graph up to a specified depth (default 6), showing connected nodes and relationships.

**\`add_node\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}",
  "node_id": "<node identifier>",
  "name": "<display name>",
  "type": "<taxonomy type (e.g. function, class, route_handler)>",
  "file_path": "<source file path>"
}
\`\`\`
Registers a new code entity in the graph.

**\`add_connection\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}",
  "source_node_id": "<calling node>",
  "target_node_id": "<called node>"
}
\`\`\`
Links two structures together as a dependency relationship (\`source\` uses/calls \`target\`).

**\`rename_node\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}",
  "old_node_id": "<current unique node ID>",
  "new_node_id": "<new unique node ID>",
  "new_name": "<optional new display name>"
}
\`\`\`
Rename a code node ID, automatically updating all its associations (incoming/outgoing connections and history logs) to prevent losing context.

**\`deprecate_node\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}",
  "node_id": "<node ID to deprecate>"
}
\`\`\`
Mark a code node as deprecated, removing all its connections while retaining its code and reasoning logs in the database. Use this if a function/class is deleted/removed.

**\`get_recent_changes\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}",
  "hours": 24
}
\`\`\`
Get team modifications and history updates over the last N hours.

**\`get_developer_activity\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}",
  "developer": "<developer name or email>",
  "limit": 50
}
\`\`\`
List recent history logs and changes made by a specific developer.

**\`get_changes_by_requirement\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}",
  "requirement_id": "<ticket or requirement ID>"
}
\`\`\`
List all modifications linked to a specific requirement, ticket, or issue ID.

**\`search_decisions\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}",
  "query": "<decision keyword>"
}
\`\`\`
Search reasoning logs for specific architectural or implementation decisions.

**\`get_orphaned_nodes\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}"
}
\`\`\`
Find disconnected code nodes in the graph that have no incoming or outgoing connections.

**\`get_visualizer_url\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}"
}
\`\`\`
Get local URLs to open the interactive 2D and 3D code graph visualizer pages.

**\`update_history\`**
\`\`\`json
{
  "devmind_path": "${devmindDir}",
  "node_id": "<identifier>",
  "file_path": "<relative path to file>",
  "code_snapshot": "<full function/class source>",
  "reasoning": {
    "what_changed": "<what you changed>",
    "why": "<reason>",
    "goal": "<what this achieves>"
  }
}
\`\`\`
Records a code change. Apply the 1-hour session boundary rule automatically.

---
> Generated by: devsmind rule
> Brain: ${devmindDir}
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
