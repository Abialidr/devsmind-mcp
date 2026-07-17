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

> This is the exhaustive reference doc. For a fast-path quick start, see [README.md](README.md).

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

> **🔄 Already using DevsMind? Upgrading an existing install?**
> ```bash
> npm install -g devsmind-mcp@latest   # pull the latest CLI
> devsmind rule                        # re-paste — rule content changed in 2.2.1
> devsmind memory                      # new in 2.2.2 — seed your tool's own memory too (optional)
> ```
> As of **2.2.1**, the generated rule's content changed (a new "why this matters" section, and a scope restriction on `stage_change`) — an old pasted rule still works, but re-running `devsmind rule` and re-pasting it into your IDE picks up the update. **2.2.2** adds `devsmind memory` as an entirely new, optional command — nothing to re-run for it, just something new you can now do. Check the [Changelog](#changelog) each time you upgrade to see if a given release calls for this.

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

# 4. (Optional) Seed your tool's OWN persistent memory/skills store too — a
#    different mechanism from the rule file above, only available for a
#    couple of tools (see why below). Safe to skip; the rule alone is enough.
devsmind memory

# 5. Start the MCP server. Run from the folder containing .devmind (or pass
#    --path <devmind_path>). Skip this if you connected via stdio in step 2 —
#    then your IDE launches the server itself.
devsmind start

# 6. (Optional, recommended) Index your codebase so the graph actually has
#    content to look up. This is the one step unique to a NEW project. It's
#    skippable — you can instead let the graph "grow as you go" as your agent
#    records changes — but until the code is indexed (or enough organic usage
#    has accumulated) there's little for the agent to query yet.
devsmind index --run --provider gemini --key YOUR_GEMINI_KEY
#    (see the `index` / `reindex` reference below for providers, flags, and the
#     zero-setup grow-as-you-go alternative)

# 7. Commit .devmind/ so your team shares the same brain.
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

# 5. (Optional) Seed your tool's own persistent memory/skills store, if it
#    has one DevsMind can safely write to (see why below). Skippable.
devsmind memory

# 6. Sync the committed graph/ + history/ JSONs into your local brain.db.
#    Especially important for stdio setups (VS Code and most CLI tools): the
#    editor spawns the server itself and only loads the graph once per process,
#    so after every `git pull` run this to pick up teammates' changes.
devsmind sync

# 7. Start the server (skip if you connected via stdio — the IDE runs it).
devsmind start
```

That's the whole loop. For what each step actually does under the hood — `init`'s full prompt flow, `mcp`/`rule`/`sync`/`memory` in depth, every `index`/`reindex` flag, provider setup, and benchmarks — see the sections below.

---

## 🔌 Adding DevsMind to your IDE / CLI: `devsmind mcp`, `devsmind rule` & `devsmind memory`

These three commands solve three genuinely different problems, and it helps to understand *why* there are three instead of one:

1. **`devsmind mcp` — can your agent even reach the tools?** Connecting the MCP server is what makes `search_nodes`, `get_node_graph`, `stage_change`, and every other DevsMind tool *exist* from your agent's point of view. Skip this and DevsMind is just files sitting on disk — nothing in your IDE or CLI knows they're there to query at all. This is pure capability, wired up per tool since every one of them expects the server in a different config file, key, and shape.
2. **`devsmind rule` — does your agent know it should use them?** Being *connectable* isn't the same as being *used*. Without the workspace rule, an agent with DevsMind fully wired up will often still default to grep and raw file reads out of habit, because nothing told it DevsMind exists or why it matters more than what it already knows how to do. The rule is what actually changes behavior — it's where DevsMind explains the team-brain framing, the consequence of skipping `stage_change`/`commit_changes`, and exactly which tool to reach for and when.
3. **`devsmind memory` — does that behavior survive without you re-pasting anything?** The rule file is still a static file *you* maintain and paste in once. Several tools now have their own persistent, agent-written memory or "skills" store — a place the agent records a lesson itself and reads it back automatically forever after, independent of whether the pasted rule ever goes stale or gets skipped during a teammate's setup. Where it's safe to do so, this seeds that store directly with the same content, so the workflow contract lives in a place the *tool itself* owns and refreshes, not just a copy-pasted file.

`mcp` and `rule` are both **guided and per-tool**: they ask what you're working in (Cursor, VS Code, Windsurf, Kiro, Antigravity, Claude Code, Codex CLI, Qwen Code CLI, …), then either **print the exact snippet to copy-paste (manual)** or **create/merge the config file for you (automatic)** — with a preview and confirmation, never clobbering your existing servers.

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
devsmind sync --analyze          # also run devsmind analyze right after, on the same connection
devsmind sync --analyze --fix    # ...and apply the safe automatic fixes too
```

`devsmind start` can do the same before it launches the server — useful so a fresh `--stdio` process (or a restarted HTTP one) always starts from a synced, health-checked graph instead of you remembering to run `sync`/`analyze` separately first:

```bash
devsmind start --sync                    # sync, then start
devsmind start --sync --analyze          # sync, report health, then start
devsmind start --sync --analyze --fix    # ...and apply safe fixes too
```
Neither flag is on by default — plain `devsmind start` behaves exactly as before.

**`devsmind memory`** — beyond the rule file, some IDEs/CLIs have their own persistent, agent-managed memory or "skills" store — a place the agent itself writes a lesson to once and reads back automatically in every future session, no re-pasting required. This is a *different* mechanism per tool, under genuinely different names (Claude Code's "Auto Memory," Antigravity's "Skills" / `/learn`, Cursor's "Memories," Windsurf's "Cascade Memories," …), and not every one of them is safe to write into — some are backed by an undocumented database, gated behind manual approval, or explicitly documented as internal, regenerated state that a manual edit would just get overwritten. Writing to the wrong one is worse than doing nothing: it looks like it worked and either silently does nothing or gets clobbered by the tool's own background process. So `devsmind memory` only writes where research specifically confirmed the tool reads back a file it didn't create itself — everywhere else, it explains why not and what to do instead:

```bash
devsmind memory
```

| Tool | Feature | Seeded automatically? |
|---|---|---|
| Google Antigravity (IDE + CLI) | Skills / `/learn` | ✅ — confirmed by Google's own codelab plus a firsthand test that a manually-placed `SKILL.md` is discovered the same as an agent-created one |
| Claude Code | Auto Memory | ✅ — writes a `devsmind.md` topic file plus a one-line pointer appended into `MEMORY.md` (topic files only load "on demand," so the pointer is what makes it get found) |
| Qwen Code CLI | `QWEN.md` | Already handled — it's the same file `devsmind rule` writes to |
| Codex CLI | Memories | ❌ manual guidance only — Codex's own docs warn these files are "generated state" a background job regenerates; a manual write would likely get silently overwritten |
| Qwen Code CLI | background auto-memory dir | ❌ manual guidance only — same undocumented, auto-generated pattern as Codex, no source confirms a manual file survives |
| Cursor | Memories | ❌ manual guidance only — internal database, requires the agent to propose and you to approve, nothing to write a file to |
| Windsurf | Cascade Memories | ❌ manual guidance only — no source confirms whether a manually-placed file is ever discovered |
| Kiro | Knowledge / PR-comment learning | ❌ manual guidance only — not file-based (JSON+embeddings or AWS-internal, opaque) |
| VS Code (Copilot) | Copilot Memory | ❌ manual guidance only — no documented write API, format has changed repeatedly through 2026 |

For everything in the ❌ rows, `devsmind memory` prints the tool's own name for the feature and exactly why it isn't safe to write to, plus what to do instead — never a silent no-op.

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

## 🔄 Workflows In Depth

DevsMind Workflows provide a persistent context vault for multi-day, complex coding tasks. When an AI agent context resets (due to context window limits, IDE restarts, or spawning subagents), it loses memory of previous discussions, decisions, and bugs fixed. Workflows keep this context durable and shareable across Git.

### 1. File Persistence & Git Sync
Workflows utilize a two-tier database structure:
* **SQLite Cache:** `brain.db` acts as the active query and caching engine.
* **On-Disk JSON Files:** The primary recovery source of truth is stored under `.devmind/workflows/<workflow_id>/workflow.json`. 
  - When workflows are modified (e.g. adding steps or attaching reference artifacts), the JSON is automatically updated.
  - This JSON is designed to be committed to Git, letting your teammates restore the exact timeline of steps and reference specs after running `git pull` followed by `devsmind sync` (or starting the MCP server).
  - During startup, `syncFromDisk()` scans for all `workflow.json` files and rebuilds the SQLite tables, while dynamically recovering which workflow was last active based on the latest `updated_at` timestamp.

### 2. Reference Artifacts Directory
When you attach a reference document (e.g. a specification, pull request description, or database diagram) using `workflow_add_artifact`:
- The metadata is logged in SQLite (`workflow_artifacts` table) and the workflow's JSON index.
- The actual content of the artifact is saved as a plain file inside `.devmind/workflows/<workflow_id>/artifacts/<artifact_id>`.
- These files are committed to Git so anyone working on the workflow has access to the raw material.

### 3. Lightweight Context Reading
As workflows grow indefinitely, sending the entire timeline of steps and raw file contents in every MCP tool response would consume and pollute the AI's context window. To solve this, the workflow system uses a split-reading model:
* **`workflow_get_context`**: Instantly returns a summary of all steps and the file paths of all artifacts. Artifact content is hidden by default unless requested using `--include-artifact-content`.
* **`workflow_get_steps`**: Reads only a paginated slice or the tail of a long workflow (e.g., `last_n: 10` gets the most recent 10 steps to quickly catch up).
* **`workflow_read_artifact`**: Allows reading the content of a specific artifact file on demand once the agent identifies it from the context overview.
* **`workflow_search`**: Runs a project-wide search across all workflows' step summaries, pending tasks, and artifact names, scanning inside artifact contents if requested.

---


## 🖥️ Other CLI Commands

*   **`devsmind start [--stdio] [-p, --port <number>]`** — starts the MCP server. Default: HTTP on port `4513`, reachable at `http://localhost:4513/mcp`. Pass `--stdio` for IDEs that manage the server process directly instead of connecting over HTTP.
*   **`devsmind view [-p, --path <devmind_path>] [-P, --port <number>]`** — opens the interactive D3.js graph visualizer in your browser (see [below](#-interactive-graph-visualizer)).
*   **`devsmind prune [-p, --path <devmind_path>]`** — interactive terminal tool to review node stats, inspect current code, page through chronological change history, and permanently delete individual nodes or clear all nodes/history.
*   **`devsmind analyze [-p, --path <devmind_path>] [--fix] [--god-entity-threshold <n>]`** — local, **zero-AI** graph health check. Pure SQLite queries, filesystem checks, and `git log` — no LLM calls, no tokens spent. One command reports on:
    *   **God entities** — nodes with 15+ (configurable) total connections, an architectural-bottleneck signal.
    *   **Circular dependency cycles** — DFS cycle detection over the connection graph.
    *   **Orphaned nodes** — active nodes with zero connections.
    *   **Dangling edges** — connections pointing at a node id that no longer exists.
    *   **Duplicate/case-collision ids** — two node ids differing only by case (a real risk on Windows's case-insensitive filesystem).
    *   **History missing developer attribution** — history rows with no non-empty `Developer:` line.
    *   **Empty code snapshots** — history rows with a blank snapshot (silent AST extraction failure).
    *   **Spurious/built-in nodes** and **missing files** — the same detections `devsmind prune` already used, now also surfaced in a dry-run report.
    *   **Renamed files** — detected via `git log`'s rename tracking since the last analysis run.
    *   **Untracked files** — git-tracked code files with **zero** graph nodes at all. This is a coarse, low-noise blind-spot signal (a file DevsMind has never recorded anything about), not a claim that any specific edit was skipped — it can't know that without guessing.

    Pass `--fix` to auto-apply only the *safe, reversible* fixes: soft-deprecate orphaned/spurious/missing-file nodes (history is preserved, never hard-deleted) and delete dangling edges, and cascade-migrate detected renames. Everything else (god entities, cycles, duplicate ids, missing developer attribution, empty snapshots, untracked files) is **report-only** — these need a human or AI to decide what to do, not a mechanical fixer.
*   **`devsmind workflow [-p, --path <devmind_path>]`** — interactive terminal view of your workflows: list by status, view a workflow's full timeline (steps + artifact file paths), pause/resume/mark completed. Day-to-day creation and step-recording happens through the `workflow_*` MCP tools the agent calls — this is a visibility/manual-override surface, not the primary way workflows get built.
*   **`devsmind workflow-import <path> [-p, --path <devmind_path>]`** — imports a folder of `.md` flow/architecture docs (one workflow per file), or a single file, as **paused** workflows. Expects the common `# Title` / `## Summary` structure (falls back to the filename / first paragraph if a file doesn't follow it) — the whole file becomes a workflow artifact, plus one seed step noting it was imported. Re-running the import on the same file updates that workflow in place instead of duplicating it, so it's safe to re-import after the source docs change.

---

## 🗄️ Database Schema: `.devmind/brain.db`

The local SQLite database (`brain.db`) acts as a metadata cache. The full database schema consists of seven tables:

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
> ⏱️ **Session Boundary Rule**: If the AI updates a function, it checks the last history log. If `updated_at` is less than **1 hour ago**, it updates the same record in-place (same session) instead of inserting a new row — `code_snapshot` is replaced with the latest state (git already owns code version history), but `reasoning` is **appended**, not overwritten, so an earlier commit's "why" within the same session is preserved rather than silently lost. If older than 1 hour, it inserts a new history record (new session).
>
> 💾 **JSON Storage Note**: In version 2.0.0, the actual code snapshots and AI change reasonings are stored in `.devmind/history/[id].json` to resolve Git merge conflicts, while the SQLite database holds empty strings for `code_snapshot` and `reasoning`.

### 4. `system_meta` (System Configuration & Caching Metadata)
Stores project caching timestamps and active workflow tracking.
```sql
CREATE TABLE system_meta (
  key         TEXT PRIMARY KEY, -- Metadata key (e.g., 'active_workflow_id', 'last_reindex_at')
  value       TEXT NOT NULL,    -- Config value
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 5. `workflows` (Context Vault Workflows)
Tracks high-level active, paused, or completed tasks.
```sql
CREATE TABLE workflows (
  id           TEXT PRIMARY KEY,  -- UUID or custom workflow id
  name         TEXT NOT NULL,     -- User-facing task name
  description  TEXT NOT NULL,     -- High-level goals
  status       TEXT DEFAULT 'active', -- Status: 'active', 'paused', 'completed'
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 6. `workflow_steps` (Chronological Workflow Logs)
Stores each individual task progression step in sequence.
```sql
CREATE TABLE workflow_steps (
  id             TEXT PRIMARY KEY,  -- Step UUID
  workflow_id    TEXT NOT NULL,     -- Link to parent workflow
  step_index     INTEGER NOT NULL,  -- Chronological sequence index
  summary        TEXT NOT NULL,     -- What was completed / discovered
  pending_tasks  TEXT,              -- Leftover goals for future sessions
  history_ids    TEXT,              -- Comma-separated history IDs linked to this step
  session_id     TEXT,              -- Parent IDE edit session
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workflow_id) REFERENCES workflows (id) ON DELETE CASCADE
);
```

### 7. `workflow_artifacts` (Reference Materials Index)
Tracks specifications, PR details, and diagnostic info linked to a workflow.
```sql
CREATE TABLE workflow_artifacts (
  id           TEXT PRIMARY KEY,  -- Artifact UUID
  workflow_id  TEXT NOT NULL,     -- Link to parent workflow
  step_id      TEXT,              -- Links to the step where it was attached (nullable)
  type         TEXT NOT NULL,     -- e.g., 'pr_description', 'spec', 'file_patch'
  source_name  TEXT NOT NULL,     -- User-facing descriptor name
  file_path    TEXT NOT NULL,     -- File path where the raw content is saved on disk
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workflow_id) REFERENCES workflows (id) ON DELETE CASCADE
);
```


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

DevsMind exposes **35 tools** to the AI agent, grouped below by what they're for.

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
*   `edit_node`: **The primary write path — use this, not the IDE's own edit/write tool, for every edit and every new file.** One call — `file_path` + `old_string` + `new_string` + `reasoning`, exactly like an ordinary edit tool — never refuses a file type, and never rejects for being the wrong extension. Under the hood it works out WHERE the text landed and which function/class that spot belongs to (by position, not by name — so it survives the symbol being renamed by the very edit that touched it, and correctly identifies code that didn't exist until this write), then records `reasoning` against that node automatically. No `node_id` to look up, no `code_snapshot` to send back, no follow-up `stage_change` call, for any TS/JS/JSX/TSX/Vue/Svelte file. It also hands back every CALLER of what you just changed (i.e. what you may have just broken) and the reasoning previously recorded against it. To create a file that doesn't exist yet, pass `old_string: ""` and the whole file as `new_string` — every symbol in it gets traced and recorded the same way. Writes landing outside any function (markup, config, an import line, a stylesheet) simply record nothing — a normal, expected outcome, not a failure, since the graph only models code. Nothing reaches the graph until `commit_changes`.
*   `stage_change`: The fallback for what `edit_node` can't trace — a language with no local parser (Python, Go, Java, C#, Ruby, PHP, Rust, Swift, Kotlin, Dart) — or code you already wrote with your own tool for some other reason. Buffers one touched entity (node id + code snapshot + reasoning) to disk **without** writing to the graph yet.
*   `commit_changes`: Flushes the whole staged buffer in one pass — creates/updates every node, writes every history snapshot, then resolves all connections between them (and into the existing graph) via local AST, auto-creating any referenced-but-missing target nodes. Because all nodes exist before edges are resolved, calls between the changed files link correctly regardless of staging order. If a workflow is currently active, this also auto-records one step on its timeline from the batch just committed (`history_ids` linking to every node in it) — see `workflow_add_step` below. **Must be called at least once per staged batch**, or nothing is written to the graph. `edit_node` also only stages — it needs `commit_changes` too.
*   `rename_node`: Re-keys a node identifier and updates all associated records (connections and history) seamlessly.
*   `deprecate_node`: Marks a code node as deprecated, removing its connection mappings while retaining its coding snapshots and reasoning logs in the database.

> The former `add_node` / `add_connection` tools are removed — nodes and edges are now created automatically by `stage_change` + `commit_changes` (or `edit_node` alone, for TS/JS), so the AI never hand-manages edges. `update_history` (the old single-node write) and `search_code` (now folded into `search_nodes`'s automatic fallback) still work if called directly for backward compatibility, but neither is advertised to the AI anymore. Neither `edit_node` nor `stage_change` can write inside `.devmind/` itself (DevsMind's own config/database) — only inside your configured repos.

### 🧹 Category 5: Optimization & Maintenance
*   `recheck_graph`: Scans the graph to verify file existence and deprecates language primitives, builtins, and nodes associated with missing/deleted files, retaining nodes with active histories.
*   `analyze_graph`: Runs a local, **zero-token** health check — god entities, circular dependency cycles, orphaned nodes, dangling edges, duplicate/case-collision ids, history missing developer attribution, empty code snapshots, spurious/built-in nodes, missing files, git-detected renames, and git-tracked files with zero graph nodes. Set `fix:true` to auto-apply only the safe fixes (soft-deprecate dead nodes, remove dangling edges, migrate renames); everything else is report-only since it needs a human/AI judgement call. See [`devsmind analyze`](#-other-cli-commands) below for the CLI equivalent and full detection list.

### 🗂️ Category 6: Workflow Context Vault
Persistent, cross-session memory for a multi-day feature — solves "context death" when you resume something days later and the agent has forgotten every decision made along the way. Steps link to existing `history` rows rather than duplicating code/reasoning; reference artifacts are plain files under `.devmind/workflows/<id>/`, committed to git like everything else.
*   `workflow_create`: Starts a new workflow and makes it active (auto-pausing whatever was active before).
*   `workflow_add_step`: Records a step in the active (or a given) workflow's timeline — a short summary plus optional `history_ids` it covers. **Usually not called directly** — `commit_changes` auto-records a step from whatever it just staged whenever a workflow is active. Call this yourself only for something a commit doesn't cover (a decision made with no code change, or a `pending_tasks` note).
*   `workflow_pause` / `workflow_resume`: Pause the active workflow, or resume a paused one (also auto-pausing the previously active one — only one workflow is active at a time).
*   `workflow_list`: Lists workflows, optionally filtered by status. The agent is instructed to call this before starting work that might relate to a paused feature, and to offer resuming it instead of silently starting fresh.
*   `workflow_get_context`: Returns a workflow's full timeline (steps in order) plus every artifact's file path, in one call — the call to make right after resuming.
*   `workflow_add_artifact`: Saves reference material (a spec excerpt, ticket description, API doc) to a workflow, written to disk and linked in the DB.
*   `workflow_sync_retroactive`: Backfills a workflow's timeline after a session that skipped `workflow_add_step`. Takes an already-extracted `steps` array, **not** raw transcript text — DevsMind never makes its own LLM calls, so the calling agent (which already has the transcript in context) does the extraction itself, for free.
*   `workflow_import`: Imports existing flow/architecture docs (`# Title` / `## Summary` markdown files) as paused, resumable workflows — either a whole folder or a single file. Re-importing the same file updates its workflow in place instead of duplicating it. See [`devsmind workflow-import`](#-other-cli-commands) below for the CLI equivalent.

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

### 2.4.0 — `edit_node`: one write path for every file

The write path used to be two calls: edit the file with your IDE's own tool, then remember a separate `stage_change` call to record why. That second call was easy to skip — it cost the agent tokens and gave nothing back in return, so it got treated as a courtesy step rather than something the agent actually needed. `edit_node` collapses this to one call that pays for itself: it edits the file (never refusing a type, unlike `stage_change`), works out which function/class the text actually landed in **by position, not by name** (so it survives the symbol being renamed mid-edit, and correctly identifies code that didn't exist until the write itself), and records `reasoning` against it automatically. In return it hands back every caller of what you just changed — the one thing you'd otherwise spend a separate call discovering. For TS/JS/JSX/TSX/Vue/Svelte, `stage_change` is no longer needed at all; it's now scoped to languages with no local parser (Python, Go, Java, and friends) plus anything you genuinely wrote with your own tool for some other reason.

This release also came out of a deliberate hardcore adversarial testing pass — three parallel agents stress-testing the indexing/read/lifecycle tools, the workflow tools, and every CLI command, plus targeted fuzzing of the new `edit_node` path (path traversal, CRLF/BOM/Unicode files, decorators, concurrent writes, monorepo scoping, empty files). Two of the confirmed bugs were genuine data corruption, unrelated to anything new: `syncFromDisk`'s "is this path already absolute?" check only recognized the `C:` drive and POSIX roots, so a project on `D:` or a UNC path had its `file_path`s silently rewritten to the `.devmind` folder on every server restart; and `rename_node` given a bare id (the same short form every read tool accepts) quietly left the old node's history and edges in place while creating an empty, disconnected node under the new id — the tool reported success either way. A third pass caught something more systemic: 35 tools' worth of required-string arguments were read via a bare `String(args.x)`, which turns a missing field into the 4-character string `"undefined"` instead of an error — confirmed concretely in `workflow_create`/`workflow_add_step`, then generalized into one validation helper applied everywhere the same risk existed.

Older releases: see [CHANGELOG.md](CHANGELOG.md) for the full compact release history.

---

## 📄 License

DevsMind is released under the [MIT License](LICENSE).
