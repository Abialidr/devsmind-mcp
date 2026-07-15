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

DevsMind is installed **once per machine**, but there are two different first-time flows depending on whether you're *creating* a brain for a project or *joining* one a teammate already created. Both start with the global install:

```bash
npm install -g devsmind-mcp
```

The MCP connection and the workspace rule are **per-developer, per-tool** — they live in your IDE/CLI's own config files on your machine and are **not** committed to git. So every teammate runs `devsmind mcp` and `devsmind rule` once on their own machine, even when the brain itself is already set up.

### 🆕 A) Starting a new brain (first person on the project)

```bash
# 1. Create the brain. Interactive: asks for project name, repos, tech stack,
#    which folders to index, etc. Creates the .devmind/ directory.
devsmind init

# 2. Connect your IDE / CLI to the DevsMind MCP server (guided, per-tool).
#    Asks what you're working in (Cursor, VS Code, Claude Code, Codex, …) and
#    then either PRINTS the exact snippet to paste, or WRITES/merges the correct
#    config file for you (with a preview + confirmation).
devsmind mcp

# 3. Place the AI workspace rule into your tool's native rules file (guided).
#    This is what actually teaches your agent to USE DevsMind (which tools to
#    call, when, and the DEVMIND_PATH for this project). Without it the server
#    is connected but your agent won't know to use it.
devsmind rule

# 4. Start the MCP server. Run from the folder containing .devmind (or pass
#    --path <devmind_path>). Skip this if you connected via stdio in step 2 —
#    then your IDE launches the server itself.
devsmind start

# 5. (Optional, recommended) Index your codebase so the graph actually has
#    content to look up. This is the one step unique to a NEW project. It's
#    skippable — you can instead let the graph "grow as you go" as your agent
#    records changes — but until the code is indexed (or enough organic usage
#    has accumulated) there's little for the agent to query yet.
devsmind index --run --provider gemini --key YOUR_GEMINI_KEY
#    (see the `index` / `reindex` reference below for providers, flags, and the
#     zero-setup grow-as-you-go alternative)

# 6. Commit .devmind/ so your team shares the same brain.
git add .devmind && git commit -m "Add DevsMind brain"
```

### 🔄 B) Joining / resuming an existing brain (teammate already set it up)

The `.devmind/` folder is already in the repo — **no fresh setup, no indexing.** The committed `config.json` + `graph/` + `history/` are shared, but the `.env` (your developer identity, and in standalone mode your machine's local repo paths) is gitignored, so you still run `devsmind init` once to set up your local side:

```bash
# 1. Get the committed brain.
git pull        # or: git clone <repo>

# 2. Set up your machine-local .env. `init` detects the existing brain and,
#    instead of creating a new one, just configures this machine: your
#    developer name/email, and (standalone mode) the local paths to each repo.
#    It does NOT re-create config or re-index the graph.
devsmind init

# 3. Connect your IDE / CLI (same guided command as above).
devsmind mcp

# 4. Place the workspace rule for your tool.
devsmind rule

# 5. Sync the committed graph/ + history/ JSONs into your local brain.db.
#    Especially important for stdio setups (VS Code and most CLI tools): the
#    editor spawns the server itself and only loads the graph once per process,
#    so after every `git pull` run this to pick up teammates' changes.
devsmind sync

# 6. Start the server (skip if you connected via stdio — the IDE runs it).
devsmind start
```

That's the whole loop. For what each step actually does under the hood — `init`'s full prompt flow, `mcp`/`rule`/`sync` in depth, every `index`/`reindex` flag, provider setup, and benchmarks — see the sections below.

---

## 🔌 Adding DevsMind to your IDE / CLI: `devsmind mcp` & `devsmind rule`

Both commands are **guided and per-tool**. They ask what you're working in (Cursor, VS Code, Windsurf, Kiro, Antigravity, Claude Code, Codex CLI, Qwen Code CLI, …), then either **print the exact snippet to copy-paste (manual)** or **create/merge the config file for you (automatic)** — with a preview and confirmation, never clobbering your existing servers.

```bash
# Add the MCP server connection. Picks the right transport per tool
# (stdio for CLI tools, stdio-or-HTTP for IDEs) and the right config file
# + key (mcpServers / servers / [mcp_servers] / serverUrl / httpUrl / url).
devsmind mcp

# Place the workspace rule in the tool's native rules file
# (.cursor/rules/*.mdc, CLAUDE.md, AGENTS.md, QWEN.md, .github/copilot-instructions.md, …).
# In a pipe or with --print, it just prints the rule (back-compat: `devsmind rule --print > rule.md`).
devsmind rule
```

**`devsmind sync`** — force the committed `graph/` + `history/` JSONs into your local `brain.db`.
Under `--stdio` (how VS Code and most CLI tools run the server), the editor spawns the process itself and the on-disk graph is only loaded once per process — so after a `git pull` your teammates' graph changes won't appear until you re-sync. Run this to apply them without restarting:

```bash
devsmind sync
```

---

## 📇 Command Reference: `index` & `reindex`

Both commands extract code entities ("nodes") via an LLM and resolve connections between them ("edges") via local AST analysis. **`index` is for the first full pass over a codebase; `reindex` is for keeping an already-indexed graph in sync afterward.** They share most flags.

> You can also index via in-chat agent tools (`index_start`/`index_checkpoint`/`index_continue`/`index_complete`) instead of the CLI — but that burns your IDE chat's own token budget for every file, which gets expensive fast on anything beyond a small repo. The CLI (`--run`) does the same extraction in the background for free (aside from your own LLM API key usage) and is the recommended path for a full/initial index.
>
> Neither of these is *required* upfront — see [Growing the graph outside of `index`/`reindex`](#growing-the-graph-outside-of-indexreindex) below for the zero-setup "grow-as-you-go" mode. But until the graph actually covers your codebase (via one of these commands, or enough organic grow-as-you-go usage), it's mostly not useful to your AI agent yet — there's nothing to look up.

### `devsmind index --run`

Full/initial indexing. Must be run with `--run`, otherwise it just prints instructions for in-chat indexing instead.

```bash
devsmind index --run --provider gemini --model gemini-2.5-flash --key YOUR_API_KEY --chunk-size 1500
```

| Flag | Description |
|---|---|
| `-p, --path <devmind_path>` | Path to `.devmind` (default: `.devmind` in cwd) |
| `--run` | **Required** to actually start indexing |
| `--provider <provider>` | `gemini` (default) \| `vertex` \| `ollama` |
| `--model <name>` | Model id (default per provider — see [Providers & Performance](#providers--performance) below) |
| `--key <api_key>` | API key or service account JSON path (overrides `GEMINI_API_KEY` / `GOOGLE_APPLICATION_CREDENTIALS`) |
| `--url <url>` | Ollama server endpoint (default `http://localhost:11434`) |
| `--chunk-size <lines>` | Max lines per chunk sent to the LLM (default: off — whole file in one call) |
| `--chunk-overlap <lines>` | Overlap lines between chunks, only used with `--chunk-size` (default `50`) |
| `--rpm <number>` | Max LLM requests per minute, paced proactively (default: **unthrottled** — fires back-to-back, relies on 429 retry/backoff) |
| `--from-scratch` | Wipes ALL nodes, connections, history, and `graph/`/`history/` folders, then reindexes from zero. Prompts for confirmation unless `--yes` is passed |
| `--nodes-only` | Only run Phase 1 (node extraction). No connections touched |
| `--edges-only` | Only run Phase 2 (connection resolution). Wipes and rebuilds connections across all current nodes. Requires nodes to already exist |
| `--repos <names>` | Comma-separated repo names to restrict the run to (standalone mode only) |
| `--yes` | Skip the confirmation prompt for `--from-scratch` |
| `--local-edges` | *Deprecated, no-op.* Connections are always resolved locally via AST now |

**Valid / invalid combinations** (enforced in code, not just convention):
*   ❌ `--nodes-only` + `--edges-only` together — mutually exclusive, omit both for a full run.
*   ❌ `--from-scratch` + `--edges-only` together — nothing to build edges from after a full wipe. Use `--from-scratch --nodes-only`, then `--edges-only` as a separate follow-up run.
*   ❌ `--repos` + `--from-scratch` together — `--from-scratch` wipes the entire graph, so per-repo scoping doesn't apply.
*   ✅ `--repos` composes fine with `--nodes-only` or `--edges-only` (e.g. rebuild edges for just one repo).

```bash
devsmind index --run --provider ollama --model qwen2.5-coder
devsmind index --run --provider gemini --key YOUR_KEY --nodes-only
devsmind index --run --edges-only --repos harrir-web,harrir-web-admin
devsmind index --run --provider gemini --key YOUR_KEY --from-scratch --yes
```

### `devsmind reindex`

Syncs the graph with code changes since the last run. No `--run` flag needed — it always executes.

```bash
devsmind reindex --provider gemini --key YOUR_API_KEY
```

| Flag | Description |
|---|---|
| `-p, --path <devmind_path>` | Path to `.devmind` (default: `.devmind` in cwd) |
| `--provider <provider>` | `gemini` (default) \| `vertex` \| `ollama` |
| `--model <name>` | Model id |
| `--key <api_key>` | API key / service account path |
| `--url <url>` | Ollama endpoint |
| `--chunk-size <lines>` / `--chunk-overlap <lines>` | Same as `index` — bump `--chunk-size` (e.g. `3000`) if large files are timing out |
| `--rpm <number>` | Same as `index` — unthrottled by default |
| `--fill-gaps` | Gap-fill mode — see below |
| `--local-edges` | *Deprecated, no-op* |

There is no `--from-scratch` / `--nodes-only` / `--edges-only` / `--repos` on `reindex` — those are `index`-only.

**Two selection modes:**

*   **Default (no flags beyond provider/key):** diffs file modification times against the graph's `last_reindex_at` cursor. Only files touched since the last successful reindex get reprocessed. Fast, but a file whose extraction fails partway through is *not* retried automatically on the next run once the cursor moves past it.
*   **`--fill-gaps`:** ignores mtimes entirely. Instead it finds every indexable file that currently has **zero nodes** in the graph (never indexed, or dropped by a prior crashed run) and backfills just those. Per-file failures are logged and skipped rather than aborting the whole run — safe to re-run repeatedly until the gap list is empty. After backfilling, it rebuilds connections across the *entire* active graph (not just the new nodes) via local AST resolution — no LLM cost — so edges pointing *into* the newly-added nodes from already-indexed files get picked up too. History and existing nodes are never touched by this rebuild.

```bash
devsmind reindex --provider vertex --model gemini-2.5-flash --key sa.json --fill-gaps --rpm 60 --chunk-size 3000
```

### Providers & Performance

Applies to both `index` and `reindex` — same `--provider`/`--model`/`--rpm`/`--chunk-size` flags, same Phase 1 (LLM) vs Phase 2 (local AST) split.

**Supported providers (`--provider`):**

| Provider | Auth | Notes |
|---|---|---|
| `gemini` (default) | `--key` or `GEMINI_API_KEY` env var | Default model: `gemini-2.0-flash` |
| `vertex` | `--key` (service account JSON path or inline JSON, or a raw `ya29.` bearer token) or `GOOGLE_APPLICATION_CREDENTIALS` / `VERTEX_API_KEY` / `GEMINI_API_KEY`. Needs `GCP_PROJECT_ID` (or a project id embedded in the service account JSON) | Default model: `gemini-1.5-flash` |
| `ollama` | None — local server | Default model: `qwen2.5-coder`. Default endpoint `http://localhost:11434`, override with `--url` |

**Performance flags:**
*   `--local-edges` *(always on, flag is a no-op)*: connection resolution (Phase 2) runs entirely locally via the TypeScript/JavaScript AST parser (with a regex fallback for Python, Go, Java, etc.) — instant, offline, free, deterministic. Only Phase 1 (node extraction) calls the LLM.
*   `--chunk-size <lines>`: for large-context models, scale this up (e.g. `1500`–`3000`) to process big files in one or two chunks instead of timing out or getting truncated on a single whole-file call.
*   `--rpm <number>`: opt-in throttling. Leave unset unless you're hitting a known provider quota.

**Benchmarks** *(approximate — from informal internal testing, not a rigorous accuracy-scoring methodology; your results will vary by repo, prompt, and quota)*:

| Model | Repo size | Time | Approx. graph accuracy |
|---|---|---|---|
| `qwen2.5-coder:30b` (Ollama, local) | ~1,080 files | ~15 hours | ~50% |
| `gemini-2.5-flash` (cloud) | same repo | ~5 hours | ~90% |

Takeaway: local models avoid API cost and keep code on-machine, but for anything beyond small/medium repos a cloud flash-tier model is dramatically faster and more accurate for Phase 1 extraction. Phase 2 (edges) is local/free either way.

---

## 🆕 `devsmind init` In Depth

`devsmind init` behaves differently depending on whether a `.devmind/config.json` already exists in the target directory.

### First-time setup (no existing config)

1. **Project name + mode.** Prompts for a project name, then a choice between:
   *   **Embedded** — the brain lives inside the project's own repo at `<repo>/.devmind`. Repo paths are stored as a relative path (`.`), so cloning the repo anywhere just works — no machine-specific config needed.
   *   **Standalone** — the brain lives in its own separate folder (you're prompted for a folder name and parent directory), and can reference *multiple* independent Git repos. Each repo's absolute local path is stored per-developer in `.env` (since paths differ machine to machine).
2. **Repo configuration.** Embedded mode configures exclusions once for the single repo. Standalone mode loops, letting you add as many repos as you want, each with its own name, local path, and exclusions.
3. **Exclusions, per repo.** For each repo you get:
   *   An offer to auto-import the repo's own `.gitignore` patterns.
   *   An offer to add common non-code config files (lockfiles, `tsconfig.json`, eslint/prettier configs, etc.) if present.
   *   An interactive file browser to manually toggle folders/files in or out of indexing scope.
4. **Developer info.** Name and email, pre-filled from `git config user.name` / `user.email` if available. Always written to `.env` (never committed).
5. **Tech stack auto-detection.** Scans each repo path for `tsconfig.json`, `go.mod`, `pom.xml`, `Cargo.toml`, `requirements.txt`/`pyproject.toml`, and `package.json` dependencies (detects nestjs, express, nextjs, react, vue, fastify, angular, svelte, hono, koa, prisma, typeorm, mongoose). You confirm or manually correct the result.
6. **Session timeout** (default 60 minutes) and optional **environment URLs** (dev/staging/prod) and **free-text notes** for the AI.
7. **Files written:**
   *   `.devmind/config.json` — project name, mode, repos, ignored paths, tech stack, environments, notes. **Committed to Git.**
   *   `.devmind/.env` — developer name/email + (standalone mode) each repo's local absolute path. **Gitignored.**
   *   `.devmind/.gitignore` — auto-created to exclude `.env`, `brain.db`, `brain.db-wal`, `brain.db-shm`, `index_scratchpad.json`.
   *   `.devmind/graph/` and `.devmind/history/` — created with `.gitkeep` so Git tracks the (initially empty) directories.
   *   `.devmind/brain.db` — empty SQLite cache, initialized immediately.

### Re-running `init` (config already exists)

This is the **joining-developer / repair flow** — it never overwrites the shared `config.json`:

1. Checks `.env` for developer name/email; prompts only if missing.
2. **Embedded mode:** verifies the repo's relative path still resolves and reports any that don't (rare — embedded paths are just `.`).
3. **Standalone mode:** checks every repo's `path_key` in `.env` against the filesystem. Any repo with a missing or now-invalid local path gets prompted for a corrected absolute path; everything else in `.env` (including unrelated keys) is preserved as-is.
4. Rewrites `.env`, ensures `.gitignore` exists, and re-initializes `brain.db` if needed.

This is exactly what a new team member runs after `git clone`-ing a project that already has `.devmind/config.json` committed — see [Quick Start B) Joining / resuming an existing brain](#-quick-start) above.

---

## 🖥️ Other CLI Commands

*   **`devsmind start [--stdio] [-p, --port <number>]`** — starts the MCP server. Default: HTTP on port `4513`, reachable at `http://localhost:4513/mcp`. Pass `--stdio` for IDEs that manage the server process directly instead of connecting over HTTP.
*   **`devsmind view [-p, --path <devmind_path>] [-P, --port <number>]`** — opens the interactive D3.js graph visualizer in your browser (see [below](#-interactive-graph-visualizer)).
*   **`devsmind prune [-p, --path <devmind_path>]`** — interactive terminal tool to review node stats, inspect current code, page through chronological change history, and permanently delete individual nodes or clear all nodes/history.

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

### Growing the graph outside of `index`/`reindex`

You don't have to run the CLI indexer at all — the graph also grows organically as your AI agent works, via the MCP write tools below:
1. When your AI touches a function, it checks whether a node already exists for it in `brain.db`.
2. If absent, it creates the node, connects its local import dependencies, and writes the first history snapshot.
3. The graph grows around whatever files you actively modify.

This "grow-as-you-go" path needs zero upfront setup and is a reasonable default for small/medium codebases; `index`/`reindex` are for getting full upfront coverage on a whole workspace, including files your AI hasn't touched yet.

> 🧹 **Pruning & Maintenance**: DevsMind dynamically handles deprecations and renames if function signatures match. For manual cleanup and auditing:
> * `recheck_graph`: Scans code files, marks language primitives, built-ins, or nodes associated with deleted files as deprecated (removing their connections in the graph, but keeping their entries in the database).
> * `get_orphaned_nodes`: Finds disconnected code nodes that have no incoming or outgoing connections to identify dead code or stale records.
>
> ⚠️ **Preservation Over Deletion**: The AI agent will never delete historical context by itself; it preserves all evolution records. The `delete_node` MCP tool is removed.
> * Spurious or missing nodes are **deprecated** (keeping their code history and reasoning intact, but removing active connections in the graph).
> * Use `devsmind prune` (see [Other CLI Commands](#-other-cli-commands)) for interactive manual review and permanent deletion.

---

## 🔌 MCP Tool Reference

DevsMind tools are designed with **layered granularity**. The AI only pulls the depth of data it needs, keeping token overhead minimal.

DevsMind exposes **21 tools** to the AI agent, grouped below by what they're for.

### 🔍 Category 1: Discovery & Search
*   `get_node_summary`: Returns node type, location, connections count, history counts, and last update. (~50 tokens)
*   `list_nodes`: List all nodes matching optional type and file path filters. Useful to discover all entities in a component, package, or directory.
*   `search_nodes`: The one search tool to call — searches node names/identifiers/reasoning first (cheap, SQL-only) and, if nothing matches, **automatically falls back to a full regex/string code-content search** (matches grouped by node ID, file path, and matching lines) in the same call. Each result is tagged `matched_via: "identifier"` or `matched_via: "code"`. Preferred over a raw grep of the filesystem, and over calling any search tool twice.
*   `get_node_graph`: Recursively retrieves connected nodes and relationships up to a specified depth (default: 6). With `direction:"out"` + `include_code:true`, pulls an entire call flow — the starting node plus everything it transitively calls, each with live source — in a single call. `direction:"in"` finds every caller (impact analysis before a change).
*   `get_orphaned_nodes`: Identifies disconnected code nodes in the graph that have no incoming or outgoing connections.
*   `get_visualizer_url`: Returns local browser URLs for opening the interactive 2D and 3D graph visualizers.

### 📜 Category 2: Code & History
*   `get_node_code`: Returns a node's **current** source code, parsed live from its file on disk — token-efficient, since it returns only that function/class/route rather than the whole file. Flags drift explicitly: `snapshot_outdated: true` means the graph has fallen behind disk (re-stage it), and `source: "cached"` means the symbol couldn't be located in its file at all (renamed/moved/deleted) and a possibly-stale cached snapshot was returned instead.
*   `get_node_history`: Retrieves all history records, code snapshots, and change reasoning logs for a node.
*   `get_recent_changes`: Lists nodes modified across the project in the last N hours (default: 24h), with optional downstream impact analysis.
*   `get_developer_activity`: Pulls logs and changes authored by a specific team member.
*   `get_changes_by_requirement`: Finds all changes linked to a particular ticket or task ID (e.g. `JIRA-402`).
*   `search_decisions`: Performs a text search specifically across the architectural/implementation rationale logs.

### ⚙️ Category 3: Code Indexing
*   `index_start`: Scans all configured repos, counts files, creates a scratchpad, and starts the codebase indexing session.
*   `index_checkpoint`: Saves current indexing progress to the scratchpad to survive context limits (called every ~10 files).
*   `index_continue`: Reads the scratchpad and returns exactly where indexing left off to resume after a context reset.
*   `index_complete`: Marks the codebase indexing session as fully completed.

### ✍️ Category 4: Writes & Mutations
*   `stage_change`: Buffers one touched entity (node id + code snapshot + reasoning) to disk **without** writing to the graph yet. Call once per file/entity you changed during a task — you do *not* reason about connections here.
*   `commit_changes`: Flushes the whole staged buffer in one pass — creates/updates every node, writes every history snapshot, then resolves all connections between them (and into the existing graph) via local AST, auto-creating any referenced-but-missing target nodes. Because all nodes exist before edges are resolved, calls between the changed files link correctly regardless of staging order. **Must be called exactly once** after staging, or nothing is written to the graph.
*   `rename_node`: Re-keys a node identifier and updates all associated records (connections and history) seamlessly.
*   `deprecate_node`: Marks a code node as deprecated, removing its connection mappings while retaining its coding snapshots and reasoning logs in the database.

> The former `add_node` / `add_connection` tools are removed — nodes and edges are now created automatically by `stage_change` + `commit_changes`, so the AI never hand-manages edges. `update_history` (the old single-node write) and `search_code` (now folded into `search_nodes`'s automatic fallback) still work if called directly for backward compatibility, but neither is advertised to the AI anymore.

### 🧹 Category 5: Optimization & Maintenance
*   `recheck_graph`: Scans the graph to verify file existence and deprecates language primitives, builtins, and nodes associated with missing/deleted files, retaining nodes with active histories.

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

---

## Changelog

### Version 2.2.0 (Current Release)
*   **`devsmind mcp` — Guided, Per-Tool MCP Setup**: Adding DevsMind to an IDE was previously undocumented and manual — every tool uses a different config file, location, key, and transport, and you were left to figure yours out. The new `devsmind mcp` command asks what you're working in (Cursor, VS Code/Copilot, Windsurf, Kiro, Google Antigravity, Claude Code, OpenAI Codex CLI, Qwen Code CLI, plus the Antigravity CLI) and then either **prints the exact snippet to paste** (manual mode) or **creates/merges the correct config file for you** (automatic mode) — with a preview and confirmation, and merging into any existing servers rather than overwriting them. It picks the best-fit transport per tool (stdio for CLI tools; stdio or HTTP for IDEs) and emits each tool's specific shape: the right top-level key (`mcpServers` vs VS Code's `servers` vs Codex's TOML `[mcp_servers.*]`) and the right remote-endpoint key (`url` vs Windsurf/Antigravity's `serverUrl` vs Qwen's `httpUrl`). Automatic mode includes a `cd`-style folder navigator so you can place project- or global-scoped configs anywhere on disk.
*   **`devsmind sync` — Force a Graph → `brain.db` Load On Demand**: The disk-to-DB sync (`syncFromDisk()`, which loads the committed `graph/**` + `history/*.json` into the local SQLite cache) only runs once per process, in the DB constructor. Under `--stdio` — how VS Code and most CLI tools run the server — the editor spawns the process itself and never hits the HTTP routes that would otherwise trigger a fresh sync, so after a `git pull` your teammates' graph changes never reached your local brain without restarting the whole editor. `devsmind sync` applies them explicitly and reports what changed (node / connection / history counts with deltas). Run it after pulling.
*   **`devsmind rule` — Now Places the Rule For You, Per Tool**: Previously `rule` only dumped the workspace rule to stdout with a generic "paste this somewhere" tip. It now runs the same guided per-tool flow: pick your tool, then either see the exact native rules-file path (manual) or have the rule **written into that file for you** (automatic) — `.cursor/rules/devsmind.mdc` (with the required frontmatter), `CLAUDE.md`, `AGENTS.md`, `QWEN.md`, `.github/copilot-instructions.md`, and so on. Shared files get a delimited DevsMind block that updates in place on re-run instead of duplicating. Piped/redirected output and the new `--print` flag still emit the plain rule, so `devsmind rule --print > rule.md` and existing scripts keep working.
*   **Interactive Folder Navigator for Paths**: Everywhere the CLI asks for a directory — `devsmind init`'s brain location and repository paths, and the automatic-write location in `devsmind mcp` / `devsmind rule` — you now get a `cd`-style browser: step into subfolders, go up, or type/paste a path directly (handy for another drive or a far-away folder, with `~` expansion). No more hand-typing and re-typing absolute paths; only existing directories can be confirmed.
*   **`search_nodes` Now Falls Back to Code Content — `search_code` Folded In**: `search_nodes` only ever matched a node's name, id, or reasoning text, so a query like "alipay" returned nothing whenever "Alipay" only appeared inside the code body rather than the function name — the agent had to burn a second turn calling `search_code` to actually find it. `search_nodes` now tries the cheap identifier match first and, if that's empty, automatically runs the same code-content search `search_code` used to do, tagging each result `matched_via: "identifier"` or `matched_via: "code"`. `search_code` is no longer advertised as a separate tool — its logic lives inside `search_nodes` now — but its handler is kept for direct/legacy calls, so any existing workspace rule that still names it explicitly keeps working unchanged. **Re-run `devsmind rule` to pick up the updated guidance** (not required — old rules still function, just with one avoidable extra turn on a cold miss).

### Version 2.1.1
*   **`get_node_code` Now Reads Live Source From Disk**: Previously this tool served the last *cached* code snapshot from `.devmind/history/`, never touching the source file. If anyone edited code outside the agent's `stage_change` flow — a `git pull`, a manual edit, a teammate's commit — the agent was handed confidently-wrong code with no warning. It now parses the node's current source straight from its file via the local AST (deterministic, no LLM, no file read into context), and only falls back to the cached snapshot when the symbol genuinely can't be located on disk. Measured against a real 7,300-node production brain, **87% of sampled nodes were serving stale code** under the old behavior.
*   **Silent Staleness Is Now Reported**: Because the live source and the stored snapshot are both in hand, comparing them is free. `get_node_code` now returns `snapshot_outdated: true` when the graph has drifted from disk, and `source: "cached"` when a symbol could not be found in its file at all (renamed, moved, deleted, or a non-TS/JS file) — so the agent can re-record the node instead of silently trusting a stale answer. Historical snapshots from `get_node_history` are unchanged and still frozen, which is the point of them.
*   **Whole Call Flows in a Single Call (`get_node_graph` + `include_code`)**: Tracing a request through ~10 functions previously meant a `get_node_code` round trip per function — roughly 21 chat turns, each re-sending the conversation and generating fresh output tokens. `get_node_graph` now accepts `direction` (`"out"` = callees / a call flow, `"in"` = callers / impact analysis, `"both"` = the surrounding neighborhood, the unchanged default) and `include_code: true`, which attaches each node's live source. One call now returns the entry point plus everything it transitively calls, with code — collapsing that trace to ~2 turns.
*   **Bounded, Non-Silent Truncation**: `include_code` spends a character budget (`code_char_budget`, default 60,000) in breadth-first order, so the nodes nearest the starting point keep their code. Anything dropped still comes back with full metadata, and the response carries `code_chars`, `code_truncated`, and `nodes_without_code` — the agent is told exactly what it did *not* receive rather than being left to assume it saw everything.
*   **Fixed: `get_node_graph` Returned a Lone Root for Unqualified Node IDs**: The traversal seeded its queue with the raw `node_id` argument while `node_connections` is keyed by the fully-qualified ID. Passing a bare symbol name (e.g. `PaymentController`) resolved the root node but then matched zero edges, silently returning a single disconnected node. It now canonicalizes the root before traversing.
*   **Workspace Rule Updated (re-run `devsmind rule`)**: The generated agent rule still taught the old snapshot-first model and had no knowledge of `include_code`, which would have left the flow-tracing win unused. It now directs agents to read code through `get_node_code` instead of the filesystem, to trace flows with a single `direction:"out"` + `include_code:true` call rather than chaining per-function lookups, and to fix drift when `snapshot_outdated` is reported. **Existing users must re-run `devsmind rule` and re-paste it into their IDE to pick this up.**

### Version 2.1.0
*   **Staged Batch Writes (`stage_change` + `commit_changes`)**: Replaced the per-entity `add_node` / `add_connection` tools with a stage-then-commit flow. As an AI agent works a task across many files, it calls `stage_change` once per touched entity (passing only code + reasoning — no manual edge reasoning), buffered to disk so it survives a context reset. A single `commit_changes` then creates every node, writes every history snapshot, and resolves all connections at once via the local AST resolver. Because all nodes exist before any edge is resolved, calls between the changed files link correctly regardless of order — eliminating the forward-reference gap that previously required a separate Phase 2. Missing target nodes are auto-created from the AST. `update_history` remains as a single-node one-shot (it now also resolves that node's edges). `add_node` / `add_connection` are removed.
*   **Durable Deprecation & Deletion**: Deprecations, prunes, and hard-deletes now persist to the on-disk graph JSONs (and clean up caller files / history JSONs), so they survive a server restart and propagate to teammates via git instead of resurrecting from disk on the next `devsmind start`.
*   **Deterministic AST Edge Resolver & Missing-Node Auto-Fill**: Connection resolution now checks references in both directions per node — not just "who calls into this node" but also "what does this node itself call out to" — and when it finds a reference to something that was never extracted in Phase 1 (an import used but never turned into a node), it deterministically creates that node straight from the AST and immediately re-resolves connections for it and its callers. No LLM call needed, so it's free and runs on every edge-resolution pass automatically. Across ~15 rounds of iterative `--edges-only` testing against real repos, fixing what each round surfaced, this and related resolver fixes raised connection/edge accuracy from **~45% to ~90%** (per internal testing).
*   **Node Extraction Accuracy Fixes**: A series of fixes to extraction and taxonomy handling in the indexer raised node-extraction accuracy from **~58% to ~92%** across the same testing rounds (per internal testing).
*   **Opt-in Request Throttling (`--rpm`)**: Added `--rpm <number>` to both `index` and `reindex`. Previously, `gemini`/`vertex` runs silently applied a hardcoded default pace (60/30 requests-per-minute); now requests fire back-to-back by default (relying on 429 retry/backoff) and throttling is only applied if you explicitly ask for it — meant for known, verified provider quotas.
*   **Gap-Fill Reindexing (`--fill-gaps`)**: Added `--fill-gaps` to `reindex`. Instead of the normal mtime-based diff, it finds every indexable file with zero graph nodes (never indexed, or dropped by a prior crashed run) and backfills just those. Per-file extraction failures are logged and skipped instead of aborting the whole run, and connections are rebuilt across the entire graph afterward (local AST resolution, no LLM cost) so edges into the newly-added nodes are captured. Safe to run repeatedly — each run only touches what's still actually missing.

### Version 2.0.5
*   **Local Connection Resolution (`--local-edges`)**: Added local compiler AST connection resolution for TypeScript and JavaScript files, and regex identifier mapping for other languages (Python, Go, Java, etc.). This offloads Phase 2 connection resolution entirely from LLM APIs to the local machine, making edge connection generation instant, offline, and free of API costs.
*   **Configurable Indexer Chunk Size (`--chunk-size` and `--chunk-overlap`)**: Exposed chunk size and overlap controls as CLI flags. Users of large-context models (like Gemini 2.5 Flash) can scale chunk sizes to process files in a single pass, accelerating Phase 1 node extraction.

### Version 2.0.4
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
*   **Robust LLM JSON Parsing**: Added extraction/repair utilities for the indexer's LLM responses, so malformed or fenced JSON (trailing commas, markdown code fences, truncated output) is recovered instead of aborting the extraction step.
*   **Duplicate Node Location Support**: Fixed indexing failures when two distinct code entities legitimately shared the same declared location (e.g. overloaded members), instead of one silently clobbering the other.

### Version 1.2.1
*   **Vertex AI Gemini Provider**: Added `--provider vertex` as an alternative to the direct Gemini API for `index`/`reindex`, authenticating via a Google Cloud service account instead of a raw API key — the option teams already using GCP IAM and billing need instead of managing a separate Gemini key.
*   **Fixed: 3 Bugs in the Interactive Configuration Browser**: The tree-based folder browser introduced in 1.2.0 could let navigation escape above the repo root, didn't visually show that a folder was excluded *because* its parent was excluded (only directly-excluded entries were marked), and mishandled the `.gitignore`-import confirmation step. All three fixed.
*   **Cursor Position Preserved in the File Browser**: Toggling a file or folder's include/exclude state used to reset the browser's cursor to the top of the list, making it tedious to toggle several entries in a row in a large tree. The cursor position is now retained across toggles.

### Version 1.2.0
*   **Interactive Tree-Based Configuration Browser for `devsmind init`**: Replaced manually typing comma-separated ignore patterns with a navigable folder tree — browse into subdirectories, toggle files/folders to include or exclude them (with inherited-exclusion status shown for anything under an excluded parent), and optionally seed exclusions from the repo's `.gitignore` or a common-preset list (lockfiles, build configs, etc.) before fine-tuning by hand.

### Version 1.1.1
*   **Fixed: Foreign Key Constraint Failures in `addConnection`**: Creating a connection could fail outright if the target node hadn't been inserted yet (an ordering issue during indexing), instead of being handled gracefully. Connection writes are now resilient to out-of-order node creation.

### Version 1.1.0
*   **Native Background Index Runner (`devsmind index --run`)**: Indexing could previously only be driven in-chat via MCP tools, burning the IDE agent's own token budget per file. This release moved the Gemini and Ollama LLM integrations directly into the CLI runner, so a full first-pass index can run in the background from the terminal instead — the predecessor to today's `index`/`reindex` commands.
*   **Compressed History Snapshots**: History code snapshots are now transparently zlib-compressed on write and decompressed on read, substantially shrinking `brain.db`'s on-disk size as a project's change history grows.
*   **SQLite `VACUUM` on Index Completion & Graph Recheck**: Reclaims space freed by deletions/compaction automatically at the end of an index run and during `recheck_graph`, instead of the database file only ever growing.

### Version 1.0.1
*   **MCP Server & Rule Generator Scaffolding**: Wired the initial `devsmind rule` generator, a versioned SQLite database schema, and the first MCP server tool surface together as a coherent baseline for the releases that followed.

### Version 1.0.0 (Initial Release)
*   **Core MCP Toolset**: Shipped the first working tool surface — including `deprecate_node` and `get_node_code` (with a stale-snapshot refresh protocol referenced from the workspace rule) — plus the `devsmind prune` command, replacing an earlier `get_project_context` / `delete_node` pairing with the deprecate-first model DevsMind still uses today.
*   **Workspace Rule Tuning**: Slimmed the generated rule to roughly 400 tokens by cutting redundant inline tool-argument JSON, then reorganized the remaining guidance into an "Available Tools" table with a one-line use-case per tool for faster agent lookup.
*   **Cross-Platform Path Fixes**: Fixed `DEVMIND_PATH` printing with backslashes on Windows (which broke downstream parsing) in favor of forward slashes, added a descriptive error when `getDatabase` can't find the target directory, and added `resolveDevmindPath` auto-detection so tools still work if the calling agent forgot to pass `devmind_path` explicitly.
*   **Initial Documentation**: First pass of the README — workspace topologies, the full MCP tool list, `devsmind init` re-initialization behavior, a simplified quick start, and the `delete_node`-to-`deprecate_node` policy — plus an internal roadmap doc for planned "next core" features.

---

## 📄 License

DevsMind is released under the [MIT License](LICENSE).
