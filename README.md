# 🧠 DevsMind — Team AI Brain

[![NPM Version](https://img.shields.io/npm/v/devsmind-mcp?color=blue)](https://www.npmjs.com/package/devsmind-mcp)
[![License](https://img.shields.io/badge/license-MIT-green)](https://github.com/Abialidr/devsmind/blob/main/LICENSE)
[![Awesome MCP](https://img.shields.io/badge/MCP-Awesome-purple)](https://modelcontextprotocol.io)

> **The evolutionary collective memory layer for your AI coding agents. Shared across your entire team.**

AI agents (like Cursor, Cline, Copilot, or Antigravity) lose all context between sessions. Teams repeat the same conversations, new developers ask questions answered months ago, and the same bug gets fixed twice because nobody remembered the first fix.

Git tells you **WHAT** changed. **DevsMind tells your AI agent WHY it changed, WHO decided it, WHAT requirement it served, and WHAT broke before.**

```
   ┌──────────────────────────────────────────────┐
   │             DevsMind MCP Server              │
   │    (installed once globally on machine)      │
   │                                              │
   │  Stateless. Holds no data.                   │
   │  Receives devmind_path on every call.        │
   │  Opens .devmind/brain.db at that path.       │
   └──────────────────────┬───────────────────────┘
                          │ devmind_path on every call
        ┌─────────────────┴─────────────────┐
        ▼                                   ▼
  c:\work\my-project\.devmind\        c:\work\other-project\.devmind\
  brain.db                            brain.db
  (Project A team brain)              (Project B team brain)
```

---

## 🚀 Key Features

*   **Function-Level Evolution Graph**: Every class, method, schema, endpoint, or function is mapped with a rich history chain.
*   **AI-Written Context Snapshots**: As you work, your AI agent documents the *why, goal, previous state, decision rationale, model, and ticket ID* in real-time.
*   **Token-Surgical MCP Interface**: AI can inspect function relationships, histories, and code snapshots *without* reading entire directories or files, reducing token costs by **up to 70%**.
*   **Stateless MCP Server**: A single server handles multiple distinct workspaces. The active directory configuration is injected dynamically from the IDE's Workspace Rule.
*   **D3.js 2D/3D Interactive Visualizer**: Explore, search, and navigate your code architecture and connection graphs in the browser with stunning force-directed layouts.
*   **Git-Native Collaboration**: The database and configuration are committed to Git, enabling seamless context sharing among team members.

---

## 🛠️ Architecture: The `.devmind/` Directory

Running `devsmind init` creates a `.devmind/` directory in your workspace. This folder contains the configuration, distributed graph database, and local cache:

```
.devmind/
  ├── config.json     ← Project metadata & repository mapping (Committed to Git)
  ├── .env            ← Local developer machine paths (Gitignored)
  ├── brain.db        ← Metadata-only SQLite cache database (Gitignored)
  ├── history/        ← Distributed change logs & code snapshots as JSON (Committed to Git)
  │     └── [id].json
  └── graph/          ← Distributed graph structure JSON files (Committed to Git)
        └── [repo_name]/
              └── [path].json
```

### Flexibility: Where should the brain live?

DevsMind supports two deployment topologies depending on your team's workflow:

*   **Option A: Inside the workspace/project root directory (Shared with team)**
    ```
    c:\work\my-project\
      ├── .devmind\              ← Config and distributed JSON database live here
      ├── backend-service\
      └── frontend-web\
    ```
*   **Option B: Standalone folder (Fully separated)**
    ```
    c:\Users\username\brains\my-project\
      └── .devmind\              ← Brain is kept separate from code folders
    ```

---

## ⚡ Quick Start

### 1. Install DevsMind
Install the CLI and MCP server globally via npm:
```bash
npm install -g devsmind-mcp
```

### 2. Initialize the Brain & Local Env
Navigate to your project folder (or workspace root) and run:
```bash
devsmind init
```
This will guide you through interactive setup questions:
*   **For new installations:** It prompts you for details (Project Name, Architecture, Frameworks, Naming Conventions, and Repo Paths) and automatically generates `.devmind/config.json` (committed), `.devmind/.env` (gitignored), and an empty `.devmind/brain.db`.
*   **For resuming/joining developers:** If `.devmind/config.json` already exists (e.g., pulled from Git), running `devsmind init` will detect it. It will **not** overwrite the shared team configuration; instead, it will only prompt you for missing local details (your name/email and local machine paths for your repositories) and generate/update your local `.devmind/.env` automatically.

### 3. Get and Inject the AI Workspace Rule
Instead of writing a custom prompt from scratch, DevsMind generates a fully customized Workspace Rule containing your project's unique configuration details.

Run the following command in your terminal:
```bash
devsmind rule
```
Or specify an explicit path:
```bash
devsmind rule --path C:\work\my-project\.devmind
```
This prints a tailored system instruction prompt. Copy and append it to your IDE's workspace rules (e.g., `.cursorrules`, Claude Project instructions, or Antigravity system settings) so your AI agent knows how to read, check, and update the brain during sessions.

### 4. Start the Server
Start the MCP server on your machine:
```bash
devsmind start
```
By default, this launches an HTTP MCP server listening on port **`4513`**. 

Configure your AI IDE to connect to:
`http://localhost:4513/mcp`

For IDEs requiring stdio execution, start the server in stdio mode:
```bash
devsmind start --stdio
```

---

## 🗺️ Indexing Modes: Setting Up the Brain

You have two options to index your codebase:

### Mode 1: Grow-As-You-Go (Zero Upfront Friction)
No upfront setup required. Just start writing code.
1. When your AI touches a function, it verifies if a node exists in `brain.db`.
2. If absent, it creates it, connects its local import dependencies, and writes the first history snapshot.
3. The graph grows organically around the files you actively modify.
*   *Ideal for:* Small/medium codebases, solo developer hacks, or immediate experimentation.

### Mode 2: Upfront Full Index (High Reliability)
Index the entire workspace upfront so the AI knows every type, schema, and API contract from day one.

You have two ways to run the upfront index:

#### Option A: Background CLI Indexing (Recommended — Faster & Free)
Run the indexer directly in your local terminal using a background LLM provider. This runs in the background and uses **zero tokens** in your active IDE chat session.

**Example Command:**
```bash
devsmind index --run --provider gemini --model gemini-2.5-flash --key YOUR_API_KEY
```

**Supported Providers (`--provider`):**
*   `gemini` (Default. Free tier rate-limits to stay within 15 RPM).
*   `vertex` (Google Cloud Vertex AI).
*   `ollama` (For local offline models, e.g. `--model qwen2.5-coder`).

#### Option B: In-Chat Agent Indexing
Tell your AI assistant inside your IDE chat:
1. *"Call devsmind.index_start with devmind_path = <path>"*
2. *"Then read every file it returns and call add_node + add_connection for each entity."*
3. *"Checkpoint every 10 files. Call index_complete when done."*

* **No External Scripts**: When indexing in-chat, the AI agent must perform the indexing natively using the MCP tools. It must **never** write or run custom external scripts (like Python or custom scripts), as this bypasses the tracking scratchpad and prevents proper resumption in new chat sessions if context limits are reached.

---

### 📋 Rules & Maintenance (Applies to both CLI and In-Chat Indexing)

Regardless of whether you choose Option A (CLI) or Option B (In-Chat), the following rules and database maintenance procedures remain identical:

> 💡 **Model-Dependent Indexing**: The speed and quality of indexing depend on the selected AI model. A smarter, more capable model (e.g., Gemini 2.0 Pro, Claude 3.5 Sonnet) will take slightly longer to parse complex syntax and relationships but yields a much more accurate and comprehensive code graph.
>
> 🧹 **Pruning & Maintenance**: During active development, DevsMind dynamically handles deprecations and renames if function signatures match. For manual cleanup and auditing, you have access to specialized tools:
> * `recheck_graph`: Scans code files, marks language primitives, built-ins, or nodes associated with deleted files as deprecated (removing their connections in the graph, but keeping their entries in the database).
> * `get_orphaned_nodes`: Finds disconnected code nodes that have no incoming or outgoing connections to identify dead code or stale records.
> 
> ⚠️ **Preservation Over Deletion**: The AI agent will never delete historical context by itself; it preserves all evolution records. The `delete_node` MCP tool is removed.
> * Spurious or missing nodes are **deprecated** (keeping their code history and reasoning intact, but removing active connections in the graph).
> * An interactive terminal tool is provided to let users review, inspect, and prune nodes:
>   ```bash
>   devsmind prune
>   ```
>   This utility allows you to view node stats, inspect current code, page through chronological change history, and permanently delete individual nodes or clear all nodes/history as desired.

* *Ideal for:* Production systems and team collaboration, preventing bugs where AI modifies variables used in undocumented parts of the system.

---

## 🗄️ Database Schema: `.devmind/brain.db`

The local SQLite database (`brain.db`) acts as a metadata cache. The full database schema consists of three tables:

### 1. `nodes` (Code Entities)
Contains structural identifiers.
```sql
CREATE TABLE nodes (
  id          TEXT PRIMARY KEY,  -- e.g., "CartService.applyPromoCode"
  type        TEXT NOT NULL,     -- Taxonomy type (e.g., nest_controller, route_handler)
  name        TEXT NOT NULL,     -- Friendly display name
  file_path   TEXT NOT NULL,     -- Source file path
  signature   TEXT,              -- Param types & return value signature
  deprecated  INTEGER DEFAULT 0, -- 1 if the node has been deprecated/removed
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2. `node_connections` (Architecture Relationships)
Directional mapping (Many-to-Many). Represents **uses/calls** interactions.
```sql
CREATE TABLE node_connections (
  source_node_id  TEXT,  -- The node doing the calling
  target_node_id  TEXT,  -- The node being called
  PRIMARY KEY (source_node_id, target_node_id),
  FOREIGN KEY (source_node_id) REFERENCES nodes (id) ON DELETE CASCADE,
  FOREIGN KEY (target_node_id) REFERENCES nodes (id) ON DELETE CASCADE
);
-- Direction: source_node USES target_node
```

### 3. `history` (AI Change Logs)
Holds metadata references to version histories.
```sql
CREATE TABLE history (
  id             TEXT PRIMARY KEY,  -- UUID of the history block
  node_id        TEXT NOT NULL,     -- Associated node
  session_id     TEXT NOT NULL,     -- Session key
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  code_snapshot  TEXT NOT NULL,     -- Always empty string (stored in history/[id].json)
  reasoning      TEXT NOT NULL,     -- Always empty string (stored in history/[id].json)
  FOREIGN KEY (node_id) REFERENCES nodes (id) ON DELETE CASCADE
);
```
> ⏱️ **Session Boundary Rule**: If the AI updates a function, it checks the last history log. If `updated_at` is less than **1 hour ago**, it updates the snapshot and reasoning in-place (same session). If older than 1 hour, it inserts a new history record (new session).
>
> 💾 **JSON Storage Note**: In version 2.0.0, the actual code snapshots and AI change reasonings are stored in `.devmind/history/[id].json` to resolve Git merge conflicts, while the SQLite database holds empty strings for `code_snapshot` and `reasoning`.

---

## 🔌 MCP Tool Reference

DevsMind tools are designed with **layered granularity**. The AI only pulls the depth of data it needs, keeping token overhead minimal.

### 🔍 Category 1: Discovery & Structure
*   `get_node_summary`: Returns node type, location, connections count, history counts, and last update. (~50 tokens)
*   `list_nodes`: List all nodes matching optional type and file path filters. Useful to discover all entities in a component, package, or directory.
*   `get_node_graph`: Recursively retrieves connected nodes and relationships up to a specified depth (default: 6).
*   `get_orphaned_nodes`: Identifies disconnected code nodes in the graph that have no incoming or outgoing connections.
*   `get_visualizer_url`: Returns local browser URLs for opening the interactive 2D and 3D graph visualizers.

### 📜 Category 2: Code & History
*   `get_node_history`: Retrieves all history records, code snapshots, and change reasoning logs for a node.
*   `get_recent_changes`: Lists nodes modified across the project in the last N hours (Default: 24h).
*   `get_developer_activity`: Pulls logs and changes authored by a specific team member.
*   `get_changes_by_requirement`: Finds all changes linked to a particular ticket or task ID (e.g. `JIRA-402`).
*   `search_decisions`: Performs a text search specifically across the architectural/implementation rationale logs.

### ⚙️ Category 3: Code Indexing
*   `index_start`: Scans all configured repos, counts files, creates a scratchpad, and starts the codebase indexing session.
*   `index_checkpoint`: Saves current indexing progress to the scratchpad to survive context limits (called every ~10 files).
*   `index_continue`: Reads the scratchpad and returns exactly where indexing left off to resume after a context reset.
*   `index_complete`: Marks the codebase indexing session as fully completed.

### ✍️ Category 4: Writes & Mutations
*   `add_node`: Registers a new structure (function, class, endpoint, schema, variable, etc.) in the graph.
*   `add_connection`: Links two structures together as a dependency relationship (`source` uses/calls `target`).
*   `update_history`: Registers a code snapshot and writes history logs (respects the 1h session boundary rule).
*   `rename_node`: Re-keys a node identifier and updates all associated records (connections and history) seamlessly.
*   `deprecate_node`: Marks a code node as deprecated, removing its connection mappings while retaining its coding snapshots and reasoning logs in the database.

### 🧹 Category 5: Optimization & Maintenance
*   `recheck_graph`: Scans the graph to verify file existence and deprecates language primitives, builtins, and nodes associated with missing/deleted files, retaining nodes with active histories.
*   `search_nodes`: Full-text search (FTS5) index for node names, identifiers, and reasoning logs.

---

## 🎨 Interactive Graph Visualizer

Explore your code graph visually! Start the web app by running:
```bash
devsmind view
```
*   **2D Visualizer**: D3.js force-directed canvas. Click nodes to see relationships, double-click to center, and inspect details.
*   **3D Visualizer**: ThreeJS/WebGL-powered cosmic node landscape. Fly through your architecture, rotating and zooming to trace complex microservice links.

To query the visualizer URL programmatically from your agent, call `get_visualizer_url`.

---

## 👥 Git Collaboration Workflow

By placing `.devmind/config.json` and `.devmind/brain.db` in Git, you share the codebase's brain with the entire team.

```
       Developer A                                         Developer B
   ───────────────────                                 ───────────────────
   Adds expired-coupon validation                      Pulls latest code
   AI updates applyPromoCode history                   AI inspects applyPromoCode
   `git commit -am "add validator"`                    Instantly sees validation logic,
   `git push`  ───────► [Shared Remote Git] ────────►  why it was added, and ticket ID!
```

### Joining a Project
When a new developer joins your team, they onboard instantly:
1. Clone the project repository (which contains `.devmind/config.json`, `.devmind/history/`, and `.devmind/graph/`).
2. Install the package globally: `npm install -g devsmind-mcp`
3. Initialize the local environment and generate local cache database by running: `devsmind init`
4. Copy the workspace rule printed by `devsmind rule` into their IDE configuration rules.
5. Launch the server: `devsmind start` (this automatically syncs and reconstructs the SQLite database cache from the local JSON files on startup).

The new developer's AI agent now possesses the full architectural context and decision history of your senior team.

---

## Changelog

### Version 2.0.4 (Current Release)
*   **Disk-Based History Adaptation & SQL Search Optimization**: 
    * Restored SQL-based text filtering (e.g. `getDeveloperActivity`, `getChangesByRequirement`, `searchDecisions`, and `searchNodes`) by storing the small `reasoning` text directly in the SQLite `history` table while maintaining the large `code_snapshot` exclusively on disk.
    * Fixed `getRecentChanges` and `getAllHistory` to populate reasoning/code from disk-based history files.
    * Fixed the `get_node_code` MCP tool to return `null` if the snapshot is empty/whitespace, enabling proper caching behavior for agents.

### Version 2.0.2
*   **Fully Portable Node IDs & History Metadata**: Resolved the issue where Node IDs and history JSON metadata retained absolute path prefixes or relative dots (`../../`). All Node IDs and history file paths now utilize the environment-independent `{repo_name}/relativePath` format globally, ensuring seamless database synchronization and collaboration across different developers, OS drives, and machine paths.

### Version 2.0.1
*   **Automatic .gitignore Generation Fix**: Updated the `devsmind init` command to automatically create or update `.devmind/.gitignore` to ignore the local database cache (`brain.db`, `brain.db-wal`, `brain.db-shm`) and CLI index tracker (`index_scratchpad.json`) by default.

### Version 2.0.0 (Breaking Release)
*   **Git-Friendly Distributed JSON Storage**: Solved Git binary merge conflicts by moving all massive code snapshots and reasoning logs to `.devmind/history/[id].json` and graph structures to `.devmind/graph/[repo_name]/[path].json`. This replaces the monolithic `brain.db` database storage completely.
*   **Metadata-Only SQLite Cache**: Compacted the local SQLite database (`brain.db`) to store only structural metadata. Wiped all heavy text blobs, and added `brain.db` to `.gitignore`.
*   **Auto-Sync & Reconstruction**: Added startup auto-sync. The database constructor automatically reconstructs your entire local SQLite database from the disk JSONs in less than 2 seconds on startup.
*   **Env-Mapped Repo-Relative Paths**: Resolved cross-drive crashes and folder escape issues on Windows. Replaced relative dot paths in JSONs with clean repo placeholders (`{repo_name}/relativePath`) which are resolved dynamically using absolute paths configured in your local `.env` file.
*   **Safe Import Transaction Toggles**: Disables foreign key checks during bulk syncing (`syncFromDisk()`) and edge connections (`addConnection()`) to prevent race conditions during out-of-order indexing.

### Version 1.2.2
*   **Node.js v24 LTS & npm Dependency Conflict Resolution**: Fixed native compilation conflicts (like `better-sqlite3` and `node-gyp` errors) that crashed on Node v24, ensuring DevsMind builds and installs out-of-the-box on both Node v22 and Node v24 environments.

---

## 📄 License

DevsMind is released under the [MIT License](LICENSE).
