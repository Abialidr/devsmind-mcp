# 🧠 DevsMind — Team AI Brain

[![NPM Version](https://img.shields.io/npm/v/devsmind?color=blue)](https://www.npmjs.com/package/devsmind)
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

Running `devsmind init` creates a `.devmind/` directory in your workspace. This folder contains the entire brain:

```
.devmind/
  ├── config.json     ← Project metadata & repository mapping (Committed to Git)
  ├── .env            ← Local developer machine paths (Gitignored)
  └── brain.db        ← SQLite database with the knowledge graph (Committed to Git)
```

### Flexibility: Where should the brain live?

DevsMind supports two deployment topologies depending on your team's workflow:

*   **Option A: Inside the workspace/project root directory (Committed to Git, shared with team)**
    ```
    c:\work\my-project\
      ├── .devmind\              ← Brain lives inside the project root directory
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
npm install -g devsmind
```

### 2. Initialize the Brain
Navigate to your project folder (or workspace root) and initialize:
```bash
devsmind init
```
This will guide you through interactive questions:
*   Project Name
*   Architecture (single app, monorepo, or microservices)
*   Main languages and frameworks (NestJS, Express, FastAPI, Next.js, etc.)
*   File naming conventions
*   Configured repositories (if serving multiple code folders)

It will generate `.devmind/config.json`, `.devmind/.env` (gitignored), and an empty `.devmind/brain.db`.

### 3. Set Up Local Paths
Open the generated `.devmind/.env` and update the local paths for each repository. Because each developer stores code in different directories, this file is gitignored.

```bash
# Example .devmind/.env
REPO_ORDER_SERVICE=C:\work\my-project\backend-service
REPO_FRONTEND=C:\work\my-project\frontend-web
```

### 4. Get and Inject the AI Workspace Rule
Instead of writing a custom prompt from scratch, DevsMind generates a fully customized Workspace Rule containing your project's unique configuration details.

Run the following command in your terminal:
```bash
devsmind rule
```
Or specify an explicit path:
```bash
devsmind rule --path C:\work\my-project\.devmind
```
This prints a tailored system instruction prompt. Copy and append it to your IDE's workspace rules (e.g. `.cursorrules`, Claude Project instructions, or Antigravity system settings) so your AI agent knows how to read, check, and update the brain during sessions.

### 5. Start the Server
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
1. Run `/devsmind index` in your IDE chat or run `devsmind index` in the console.
2. The AI will receive the file list, read the contents recursively, and call `add_node` and `add_connection` for all entities.
3. It will save progress to a checkpoint scratchpad every 10 files, allowing safe resumption if the session resets.
*   *Ideal for:* Production systems and team collaboration, preventing bugs where AI modifies variables used in undocumented parts of the system.

---

## 🗄️ Database Schema: `.devmind/brain.db`

The brain is backed by a local SQLite database containing exactly three tables:

### 1. `nodes` (Code Entities)
Contains structural identifiers. **No code snapshots live here.**
```sql
CREATE TABLE nodes (
  id          TEXT PRIMARY KEY,  -- e.g., "CartService.applyPromoCode"
  type        TEXT,              -- Taxonomy type (e.g., nest_controller, route_handler)
  name        TEXT,              -- Friendly display name
  file_path   TEXT,              -- Source file path
  signature   TEXT,              -- Param types & return value signature
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
-- Direction: source_node USES target_node (or target_node IS USED BY source_node)
```

### 3. `history` (AI Change Logs)
Holds snapshots and the evolutionary story.
```sql
CREATE TABLE history (
  id             TEXT PRIMARY KEY,
  node_id        TEXT,       -- Associated node
  session_id     TEXT,       -- Session key (optional)
  created_at     DATETIME,   -- When version was opened
  updated_at     DATETIME,   -- When version was last updated
  code_snapshot  TEXT,       -- Source code of this entity at this point in time
  reasoning      TEXT,       -- JSON string of AI-written history logs
  FOREIGN KEY (node_id) REFERENCES nodes (id) ON DELETE CASCADE
);
```
> ⏱️ **Session Boundary Rule**: If the AI updates a function, it checks the last history log. If `updated_at` is less than **1 hour ago**, it updates the snapshot and reasoning in-place (same session). If older than 1 hour, it inserts a new history record (new session).

---

## 🔌 MCP Tool Reference

DevsMind tools are designed with **layered granularity**. The AI only pulls the depth of data it needs, keeping token overhead minimal.

### 🔍 Category 1: Discovery & Structure
*   `get_project_context`: Returns workspace layout, repositories, and framework metadata.
*   `get_node_summary`: Returns node type, location, connections count, and history counts. (~50 tokens)
*   `get_node_graph`: Recursively retrieves connected nodes up to a specific depth limit.
*   `get_connections`: Lists files/nodes that use this entity, and what this entity calls.

### 📜 Category 2: Code & History
*   `get_node_history`: Retrieves all history records, code snapshots, and change reasoning logs for a node.
*   `get_recent_changes`: Lists nodes modified across the project in the last N hours (Default: 24h).
*   `get_developer_activity`: Pulls logs authored by a specific team member.
*   `get_changes_by_requirement`: Finds all changes linked to a particular ticket or task ID (e.g. `JIRA-402`).
*   `search_decisions`: Performs a text search specifically across the architectural/implementation rationale logs.

### ✍️ Category 3: Writes & Mutations
*   `add_node`: Registers a new structure in the graph.
*   `add_connection`: Links two structures together.
*   `update_history`: Registers a code snapshot and writes history logs (respects the 1h session rule).
*   `delete_node`: Purges a node and its connections from the graph.
*   `rename_node`: Re-keys a node identifier and updates all associated records seamlessly.

### 🧹 Category 4: Optimization & Maintenance
*   `recheck_graph`: Scans the graph to prune orphaned nodes, language primitives/builtins, and nodes associated with missing files, retaining nodes with active histories.
*   `search_nodes`: Full-text search (FTS5) index for names, descriptions, and reasoning logs.

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
1. Clone the project repository (which contains the `.devmind/` folder and `brain.db`).
2. Install the package globally: `npm install -g devsmind`
3. Create their local `.devmind/.env` from `.devmind/.env.example` and update their machine paths.
4. Add the Workspace Rule to their IDE configuration.
5. Launch: `devsmind start`

The new developer's AI agent now possesses the full architectural context and decision history of your senior team.

---

## 📄 License

DevsMind is released under the [MIT License](LICENSE).
