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
   │  `devsmind start` binds it to ONE project    │
   │  (--path, or auto-detected from cwd), so     │
   │  the agent never passes a path at all.       │
   └──────────────────────┬───────────────────────┘
                          │ one bound server per project
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
*   **AI-Written Context Snapshots**: Once per commit, your AI agent documents the *why, goal, previous state, decision rationale, model, and ticket ID* — one reasoning covering everything staged since the last commit, recorded against every node it touches.
*   **Token-Surgical MCP Interface**: AI can inspect function relationships, histories, and code snapshots *without* reading entire directories or files, reducing token costs by **up to 70%**.
*   **Stateless MCP Server**: A single server handles multiple distinct workspaces. The active directory configuration is injected dynamically from the IDE's Workspace Rule.
*   **`devsmind view` — Chat + Graph, offline**: a chat-style timeline of your own work with whole-file diffs and revert, and a node-first graph explorer (repo/type sidebar, filters, a small ego-graph per node instead of the whole thing at once, 2D/3D) — no CDN dependencies, works with no internet.
*   **Git-Native Collaboration**: The database and configuration are committed to Git, enabling seamless context sharing among team members.

---

## 🛠️ Architecture: The `.devmind/` Directory

Running `devsmind init` creates a `.devmind/` directory in your workspace. This folder contains the configuration, distributed graph database, and local cache:

```
.devmind/
  ├── .gitignore              ← Written by init; ignores everything marked LOCAL below
  ├── config.json             ← Project metadata & repository mapping        (COMMITTED)
  ├── graph/                  ← Distributed graph structure JSON             (COMMITTED)
  │     └── [repo_name]/[path].json
  ├── history/                ← Change logs, code snapshots, reasoning       (COMMITTED)
  │     └── [id].json
  ├── vectors/                ← Semantic embeddings from `devsmind embed`    (COMMITTED)
  ├── workflows/              ← Feature timelines: steps + reasoning         (COMMITTED)
  │     └── [id]/workflow.json + v2.json
  ├── .env                    ← This machine's developer name + repo paths       (LOCAL)
  ├── brain.db                ← SQLite cache, rebuilt from the JSON above       (LOCAL)
  ├── index_scratchpad.json   ← In-progress index, resumable across restarts    (LOCAL)
  ├── history_scratchpad.json ← Staged-but-uncommitted edits                    (LOCAL)
  └── local/                  ← Activity log + feedback: YOUR requests, YOUR    (LOCAL)
        ├── sessions.json         reverts. Never pushed, never a teammate's.
        ├── messages/[id].json
        └── feedback*.jsonl
```

**The committed/local split is the whole storage design.** Everything committed is the *team's* shared brain — the graph, the reasoning, the feature timelines. Everything local is either derivable (`brain.db` is a cache; delete it and it rebuilds) or genuinely personal (`local/` holds your verbatim requests and your revert backups, which are only meaningful on the machine that wrote them).

`devsmind init` writes `.devmind/.gitignore` covering every LOCAL entry, and repairs it on every re-run so a brain from an older version — or a teammate's checkout that predates an entry — can't leave something exposed. It appends rather than rewrites, so lines you added yourself survive, and it matches entries the way git reads them (`local`, `/local` and `local/` are one entry, not three). As a backstop, the activity log checks the same file on its first write, since a brain where nobody ever re-runs `init` would otherwise never pick the line up.

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

1. **`devsmind mcp` — can your agent even reach the tools?** Connecting the MCP server is what makes `search_nodes`, `get_node_code`, `stage_change`, and every other DevsMind tool *exist* from your agent's point of view. Skip this and DevsMind is just files sitting on disk — nothing in your IDE or CLI knows they're there to query at all. This is pure capability, wired up per tool since every one of them expects the server in a different config file, key, and shape.
2. **`devsmind rule` — does your agent know it should use them?** Being *connectable* isn't the same as being *used*. Without the workspace rule, an agent with DevsMind fully wired up will often still default to grep and raw file reads out of habit, because nothing told it DevsMind exists or why it matters more than what it already knows how to do. The rule is what actually changes behavior — it's where DevsMind explains the team-brain framing, the consequence of skipping `stage_change`/`commit_changes`, and exactly which tool to reach for and when. As of **2.5.0** it also asks which **workflow style** you want: **Automatic** (the original default — stages, commits, and tracks every edit without being asked) or **Manual** (search/read tools like `search_nodes`/`get_node_code` stay always-on, since that part is never optional, but the agent never stages or commits on its own — only when you explicitly ask it to). You're the owner of this project's graph; which style fits depends on whether you want DevsMind quietly building the team's shared context as you go, or only when you say so. `session_id` and `message` stay required either way — that's the MCP protocol layer, not a style choice, so Manual mode doesn't make those optional, it just changes whether the agent *decides on its own* to reach for `commit_changes`. Every run also prints a short **session kickoff prompt** — a separate block meant to be pasted at the start of a fresh chat (not baked into the rule file itself) so a new conversation commits to the rule immediately instead of drifting into it over the first few turns.
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

**`devsmind memory --print [--tool <id>]`** prints the files it would write instead of placing them, the same escape hatch `devsmind rule --print` has — for reading the seeded contract, diffing it against a store you already have, or piping it somewhere from a script. It's also what a non-TTY run does automatically, so `devsmind memory > memory.md` works rather than erroring. `--tool` takes `claude-code` (one file per fact, plus the `MEMORY.md` index block that makes them findable), `antigravity`, or `antigravity-cli` (one combined document). Without `--tool` it prints the Claude Code shape and says that's what it defaulted to.

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

> Design rationale, in full: [WORKFLOW_DESIGN.md](WORKFLOW_DESIGN.md).

A workflow is a **named, backward-looking log of how one piece of functionality grew** — across many nodes, many sessions, many days. You read it before touching something, to understand how it got this way. It is not a plan and not a task list; nothing ever "completes".

That framing matters because it settles what belongs in one. Development already leaves a recoverable trail — git has the diff, node history has the per-node reasoning. **Research leaves nothing**: nobody can reconstruct "we evaluated three options and rejected two" from the code that survived. So a workflow's job is the part nothing else keeps.

### 1. What's stored, and where

Shared with your team, committed to git under `.devmind/workflows/<workflow_id>/`:

| | |
|---|---|
| **workflow** | `id`, `name`, `description`, `archived`, `created_at`/`updated_at` |
| **step** | `id`, `workflow_id`, `step_index`, `summary`, `reasoning`, `node_ids[]`, `doc_paths[]`, `session_id`, `created_at` |

Local to your machine, gitignored under `.devmind/local/`:

| | |
|---|---|
| **session** | `workflow_id` — what this conversation is bound to right now |
| **message** | `workflow_sync` — which of your edits already became steps |

`brain.db` is a cache; the JSON on disk is the source of truth, so a teammate gets the whole timeline from `git pull` + `devsmind sync` (or just starting the server). **The workflow never stores your chat** — messages stay local. The shared side holds the summary, the reasoning, and which nodes were touched.

Each workflow is written as **two** files: `workflow.json` in the shape a pre-3.0 client understands, and `v2.json` holding what that shape has no field for (`archived`, per-step `reasoning`/`node_ids`/`doc_paths`). `devsmind sync` re-serializes `workflow.json` from local columns, so a teammate on an older build who pulled and synced would otherwise rewrite the file without the new fields and commit that loss — they have no idea the sidecar exists, so they can't touch it, and the next read merges everything back.

### 2. Binding is per session, and local

There is no project-wide "active workflow". Each session binds to at most one (`workflow_bind`), and that binding lives in `.devmind/local/` — so it never moves, pauses, or steals anyone else's, and two sessions can work different workflows at once.

This replaced a single global pointer that was also serialized into the committed JSON. Two sessions shared it: `workflow_resume` in one silently paused the other's mid-work, and that session's next `commit_changes` wrote its step onto the **wrong** workflow, with no error — and because the pointer travelled through git, a teammate could do it to you.

"What was I last working on" isn't stored at all now; it's derived — the newest session that carries a `workflow_id`. `start_session` surfaces it only when there is one, so an ordinary session sees no friction.

### 3. Steps point at nodes, not history rows

A step used to store `history_ids`, which could not actually identify a commit: two commits touching the same node within an hour **merge into one history row**, so a step's ids could point at rows an earlier commit created, and one row could be cited by several steps. Reasoning is now copied onto the step, and the step records the `node_ids` it touched.

Copying rather than joining is deliberate. History reasoning *mutates* afterwards — the hourly merge appends to it, a revert can drop a block — and a record of "what we thought at the time" can't read from a moving target.

### 4. Documents are paths, not copies

The old design copied whole files into `.devmind/workflows/<id>/artifacts/`. A copy goes stale the moment the original changes, and your repo already versions and shares the original. A step stores `doc_paths` — repo-relative paths — instead. A path outside every configured repo is rejected, since it wouldn't exist for a teammate.

### 5. Reading a long one

`workflow_get_context` is the single read, and it is paged (`limit`/`offset`, or `last_n` for the tail, which is what catching up usually means). `steps_total` is always the true count. An oversized page is trimmed in tiers — `reasoning` goes first, then `node_ids` — with a `compacted` field naming what was dropped. Document content is never inlined; you get the path.

### 6. Fixing attribution afterwards

Nothing detects drift onto a different topic — asking an AI to notice "this isn't related anymore" gets it wrong in both directions, nagging when it shouldn't and staying silent when it should. Steps just keep attaching to whatever you're bound to, and `workflow_sync` fixes it later: it reads your local activity log, previews what it would attach, and writes only on `confirm:true`. Dedupe is by consumed edit id rather than a per-message flag, so re-running is a true no-op while a message that keeps growing can still contribute a later delta.

---


## 🖥️ Other CLI Commands

*   **`devsmind start [--stdio] [-p, --port <number>]`** — starts the MCP server. Default: HTTP on port `4513`, reachable at `http://localhost:4513/mcp`. Pass `--stdio` for IDEs that manage the server process directly instead of connecting over HTTP.
*   **`devsmind view [-p, --path <devmind_path>] [-P, --port <number>]`** — opens the `devsmind view` app in your browser (see the **devsmind view** section below): Chat (your work as a timeline, per-request) and Graph, one app, no CDN dependencies.
*   **`devsmind activity [-p, --path <devmind_path>] [--since <days>]`** — the same activity timeline `devsmind view` → Chat shows, in the terminal, read-only. Grouped by day, newest first; each line is one message (a user request, or a commit's own summary when no request text was given) with its edit count and id. Revert/un-revert isn't a CLI verb — it stays on the page, next to the diff and the confirmation, rather than a bare id you'd have to look up first.
*   **`devsmind diff <node_id> [-p, --path <devmind_path>]`** — prints every recorded change to one entity as a red/green line diff, newest last, each with the `What changed:` line the agent wrote for it. Entities whose last change was recorded without a before-state say so instead of printing an empty diff — see the note under [`revert`](#-other-cli-commands) below for which those are.
*   **`devsmind revert <node_id> [-p, --path <devmind_path>] [-y, --yes]`** — restores an entity to how it looked before its **most recent** recorded edit, then erases that edit and its reasoning from history. Shows the diff and asks for confirmation first (`--yes` skips the prompt; a non-interactive shell without it exits `1` rather than acting unasked).

    Only the newest edit is revertable, and only when the entity on disk still matches what was recorded for it. Both limits are the same point: every edit after an older one was written against the code it produced, and any hand-edit since means the file has moved on — restoring a "before" in either case silently discards work that has nothing to do with the change being undone. When that happens the revert is refused and points you at git, which does this properly.

    Changes recorded before v2.5.0, and changes recorded by `stage_change` (non-TS/JS files), have no before-state stored at all and cannot be reverted this way. There's no backfill — the information was never captured. Git still has them.

    **This is a different tool from Activity's message-revert, on purpose.** This one is permanent (erase, no trace) and scoped to one entity's last edit — a quick "that was wrong" with no ceremony. Activity's revert undoes a whole request, keeps a backup, and can itself be undone — the deliberate tradeoff for that is that it's a bigger, slower operation with more moving parts (a cascade, an un-revert order). Use this one for a fast single-function undo; use Activity when you want to walk back a session's worth of work and keep the option to walk it forward again.
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
*   **`devsmind workflow [-p, --path <devmind_path>]`** — interactive terminal view of your workflows: list them (newest-touched first, archived ones hidden until you ask), read a workflow's full timeline (steps in order, each with its reasoning, the nodes it touched, and any document paths), and archive/unarchive. Day-to-day creation and step-recording happens through the `workflow_*` MCP tools the agent calls — this is a visibility/manual-override surface, not the primary way workflows get built. There is no pause/resume here any more: binding is per session and lives on the agent side.
*   **`devsmind workflow-import <path> [-p, --path <devmind_path>]`** — imports a folder of `.md` flow/architecture docs (one workflow per file), or a single file. Expects the common `# Title` / `## Summary` structure (falls back to the filename / first paragraph if a file doesn't follow it) — the workflow gets one seed step recording where it came from, pointing at the source document by **path** rather than copying it, so it can't go stale. Re-running the import on the same file updates that workflow in place instead of duplicating it, so it's safe to re-import after the source docs change.

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
>
> 🔴🟢 **Edit trail (v2.5.0)**: that same JSON also carries an `edits` array — one entry per edit, each holding the entity's code `before` and `after` it, plus `at` and the `reasoning` of the commit that produced it (one `reasoning` object per `commit_changes` call, shared by every edit that commit made — not one per edit). It lives only in the JSON, never in SQLite, exactly like `code_snapshot`. This is what `devsmind diff` renders and what `devsmind revert` restores from.
>
> It's a trail rather than a single "previous code" field *because* of the session rule above: the 1-hour window is measured from `updated_at`, so an entity edited every 50 minutes keeps sliding the same row forward and one row can span hours. A single before-field would make a revert undo the whole span instead of the last change. A gap between one edit's `after` and the next one's `before` also means someone edited the file by hand in between.
>
> Entries written before v2.5.0 have no `edits` key; it reads as `[]`, which is the honest answer — no diff, no revert. `stage_change` supplies no before-state either, so its entries read the same way.

### 4. `system_meta` (System Configuration & Caching Metadata)
Stores project caching timestamps.
```sql
CREATE TABLE system_meta (
  key         TEXT PRIMARY KEY, -- Metadata key (e.g., 'last_reindex_at')
  value       TEXT NOT NULL,    -- Config value
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
> `'active_workflow_id'` used to live here. It was removed in 3.0.0: one project-wide pointer meant two sessions fought over it, and it travelled through git so a teammate could move yours. Binding is per session and local now — see [Workflows In Depth](#-workflows-in-depth).

### 5. `workflows`
One row per named thread of work.
```sql
CREATE TABLE workflows (
  id           TEXT PRIMARY KEY,  -- UUID or custom workflow id
  name         TEXT NOT NULL,     -- User-facing name, e.g. "Wallet Integration"
  description  TEXT NOT NULL,     -- What this thread is about
  archived     INTEGER NOT NULL DEFAULT 0, -- 1 = hide from the list (reversible)
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,  -- threads sort by this
  status       TEXT DEFAULT 'active'  -- VESTIGIAL: nothing reads or writes it
);
```
> `archived` replaced `status` in 3.0.0. Nothing ever "completed" and nobody marked it, so the field lied; archiving claims only what it delivers. `status` survives as an unused column rather than being dropped — a `DROP COLUMN` buys nothing and breaks an older CLI opening the same `brain.db`. It is absent from the TypeScript types, so no code can reach it by accident.

### 6. `workflow_steps` (the timeline)
One row per commit, or per research finding. Self-contained by design: reading a workflow's story needs no joins.
```sql
CREATE TABLE workflow_steps (
  id             TEXT PRIMARY KEY,  -- Step UUID
  workflow_id    TEXT NOT NULL,     -- Link to parent workflow
  step_index     INTEGER NOT NULL,  -- Chronological sequence index
  summary        TEXT NOT NULL,     -- One line: what was done / discovered
  reasoning      TEXT,              -- The why, COPIED (not joined) — see note
  node_ids       TEXT,              -- JSON array of the nodes this step touched
  doc_paths      TEXT,              -- JSON array of repo-relative doc paths (research)
  session_id     TEXT,              -- Which session recorded it
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  pending_tasks  TEXT,              -- VESTIGIAL: nothing reads or writes it
  history_ids    TEXT,              -- VESTIGIAL: nothing reads or writes it
  FOREIGN KEY (workflow_id) REFERENCES workflows (id) ON DELETE CASCADE
);
```
> **Why `reasoning` is copied rather than joined to `history`.** History reasoning *mutates* after the fact — the 1-hour merge appends to it, a revert can drop a block — and a record of "what we thought at the time" cannot read from a moving target.
>
> **Why `history_ids` had to go.** It could not identify a commit at all: two commits touching the same node within an hour merge into a **single** history row, so a step's ids could point at rows an earlier commit created, and one row could be cited by several steps. Old steps are backfilled to `node_ids` on the first open of an upgraded brain — approximately, for that same reason.

### 7. `workflow_artifacts` — **vestigial as of 3.0.0**
```sql
CREATE TABLE workflow_artifacts (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL,
  step_id      TEXT,
  type         TEXT NOT NULL,
  source_name  TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workflow_id) REFERENCES workflows (id) ON DELETE CASCADE
);
```
> The table and any existing rows remain readable, but nothing writes to it. Artifacts were **copies** of files placed under `.devmind/workflows/<id>/artifacts/`, and a copy goes stale the moment the original changes — while your repo already versions and shares the original. A step's `doc_paths` stores the **path** instead: already versioned, already synced, can't drift.


### 8. Activity log (v2.5.0) — `.devmind/local/`, not `brain.db`

Not a SQLite table, deliberately — everything above lives in `brain.db`, which the README calls "a disposable local cache rebuilt from JSON on startup," and an activity log that could be silently rebuilt away would defeat the point of it. Plain JSON instead, gitignored, its own small directory:

```
.devmind/local/
  sessions.json                  -- [{ id, developer, started_at, last_active, message_ids[], label? }]
  messages/<message_id>.json     -- one file per message, see below
```

A session row only comes into being via the `start_session` tool — no auto-mint, no time-window guessing. `label` is the optional human-readable name passed to `start_session`, shown on the Activity page.

```jsonc
// messages/<id>.json
{
  "id", "session_id", "developer",
  "created_at", "updated_at",
  "request": "add expiry validation to coupons",  // the user's ask — REQUIRED on commit_changes
  "summary": "Cart.applyPromo, validateCoupon",   // machine-generated fallback, always present
  "status": "applied" | "reverted",
  "edits": [
    { "node_id", "file_path", "at", "before", "after" }  // the backup — nothing is deleted on revert
  ]
}
```

A message's `edits[]` stores `before`/`after` directly rather than pointing at a `history_ids` entry — self-contained on purpose, so a revert never depends on (or can corrupt) what the team shares in `history/*.json`. `devsmind init` writes `local/` into `.devmind/.gitignore`; a brain that predates this release self-heals the same line the first time anything is recorded, so it can't land in a commit by accident.

### Growing the graph outside of `index`/`reindex`

You don't have to run the CLI indexer at all — the graph also grows organically as your AI agent works, via the MCP write tools below:
1. When your AI touches a function, it checks whether a node already exists for it in `brain.db`.
2. If absent, it creates the node, connects its local import dependencies, and writes the first history snapshot.
3. The graph grows around whatever files you actively modify.

This "grow-as-you-go" path needs zero upfront setup and is a reasonable default for small/medium codebases; `index`/`reindex` are for getting full upfront coverage on a whole workspace, including files your AI hasn't touched yet.

> 🧹 **Pruning & Maintenance**: DevsMind dynamically handles deprecations and renames if function signatures match. For manual cleanup and auditing:
> * `recheck_graph`: Scans code files, marks language primitives, built-ins, or nodes associated with deleted files as deprecated (removing their connections in the graph, but keeping their entries in the database).
> * `analyze_graph`: Reports orphaned nodes — no incoming or outgoing connections, so dead code or a stale record — alongside every other health check it runs. There is no separate orphan-lookup tool.
>
> ⚠️ **Preservation Over Deletion**: The AI agent will never delete historical context by itself; it preserves all evolution records. The `delete_node` MCP tool is removed.
> * Spurious or missing nodes are **deprecated** (keeping their code history and reasoning intact, but removing active connections in the graph).
> * Use `devsmind prune` (see [Other CLI Commands](#-other-cli-commands)) for interactive manual review and permanent deletion.

---

## 🔌 MCP Tool Reference

DevsMind tools are designed with **layered granularity**. The AI only pulls the depth of data it needs, keeping token overhead minimal.

DevsMind exposes **35 tools** to the AI agent, grouped below by what they're for.

### 🚦 Category 0: Session (v2.5.0)
*   `start_session`: **Call once, before your first WRITE of the conversation** (`edit_node`/`stage_change`/`commit_changes` and the other mutating tools). Mints a `session_id` and records it locally (optionally with a `label`, shown on the Activity page). Every WRITE call REQUIRES that exact `session_id` — it ties a request's edits together on the local Activity log and makes them revertable as a unit — and every tool response echoes it back in a plain sentence so it stays in front of the agent even across a long conversation or a context compaction. Read-only tools (`search_nodes`, `get_node_code`, `list_nodes`, and the other getters) do NOT need it — search and read freely from the very first call. There is no auto-mint fallback and no server-tracked "active session" — DevsMind is stateless by design (two agents working the same project never collide over a shared "current" id), so the session token lives entirely in the conversation and must be carried explicitly. Resuming a conversation that already called `start_session` earlier should reuse that same id rather than minting a new one.

### 🔍 Category 1: Discovery & Search
*   `list_nodes`: Enumerates nodes matching optional `type`/`file_path` filters — the "what exists here" call for a component, package, or directory, as opposed to `search_nodes`' "find the thing that does X". **Paged**: it answers `{nodes, total, offset}` where `total` is the true match count and `nodes` is one page (`limit`, default 100, max 500), with a `truncated` flag and a `hint` naming the exact next call. It previously had no bound of any kind, which on a real backend meant a single unfiltered call returned ~600KB across ~10,900 lines — past the client's inline limit, spilled to a file, and truncated again on read from there. A page that is still oversized falls back to id/name/type/file_path per node with a `compacted` note; `total` stays exact either way.
*   `search_nodes`: The one search tool to call — covers the indexed graph AND the raw filesystem in one call, so an external grep is never needed. Two independent inputs, pass either or both: `query` (a natural-language phrase, drives the semantic/BM25 layers) and `pattern` (a REAL regex, used exactly as you'd give `grep` — nothing is re-escaped or split, e.g. `heartRed|onLikeTap|item\.liked` matches exactly that). A `pattern`-only call is a first-class precision mode that skips the semantic/BM25/identifier-shortcut layers entirely (a regex has no meaning to embed), returning exact grep + code-body matches only. Optional `path` scopes the search to one folder/file instead of every configured repo (rejected if outside every repo). Returns two buckets: `nodes` (tagged `matched_via: "identifier" | "fuzzy" | "semantic" | "code"`, with a true `nodes_total` before the top-20 cap) and `files` (a real grep of every repo/scope, each sample line reporting the containing function/class when resolvable, with true `files_total`/`files_offset` so a capped page is never mistaken for "nothing more" — page further with `offset`/`limit`). Preferred over a raw grep of the filesystem, and over calling any search tool twice.
*   `get_visualizer_url`: Returns local browser URLs for opening the interactive 2D and 3D graph visualizers.

> Search results are size-guarded. An oversized `search_nodes` response is trimmed automatically in two tiers — first the bulk-without-signal (per-file `match_counts`, `matched_terms`, `aliases`, repeated boilerplate, thinned sample lines), and only then the evidence lines themselves — with a `compacted` field always naming which happened. **Every count stays exact**, so a trimmed result can never be mistaken for a complete one. `compact:false` demands the full payload; `compact:true` asks for a lean triage list up front. Lockfiles (`package-lock.json`, `yarn.lock`, `go.sum`, …) and build artifacts (`*.min.js`, `*.map`) are excluded by default; `.env`, JSON and other config stay fully searchable, since that is exactly what the `files` bucket is for.

### 📜 Category 2: Code & History
*   `get_node_code`: **The one node-read call.** Returns a node's current source — token-efficient, since it returns only that function/class/route rather than the whole file — parsed live from disk, falling back to the last known snapshot when the symbol can no longer be located (renamed/moved/deleted, reported as `source:"cached"`). Included on **every** call at no extra cost: `name`/`type`/`signature`/`description`, the file's `imports`, up to 20 named callers **and** callees per direction (`uses_nodes`/`used_by_nodes`, with the counts always true even when capped), up to 40 other declarations from the same file (`file_outline`), and the last 3 changes' reasoning (`recent_history`). A raw file read shouldn't be needed afterwards for any of that.
    *   `graph_depth` + `graph_direction` walk the **transitive** graph past those direct neighbors, in the same call: `"in"` at depth 2-3 is the full caller blast radius before you change a signature; `"out"` at depth 3 with `graph_code:true` is a whole call flow — every function a request touches, with live source, in one round trip instead of a chain of per-function fetches. The walk is deterministic and capped at 120 nodes; `graph_code_budget` defaults to 24000 characters when riding along inside a `get_node_code` response. When the budget runs out, the dropped nodes are named **by id** in `graph.code_omitted_node_ids` — fetch exactly those, or re-issue larger. Nodes whose source genuinely couldn't be found are counted separately as `graph.nodes_no_code_available`, because raising the budget will never bring those back.
    *   `history:"full"` (default `"recent"`) returns every revision with diffable before/after edits, pageable via `history_limit`/`history_offset` — the call to make before refactoring anything with a non-trivial `history_count`.
*   `get_activity_log`: The "what changed recently" call, reading the local activity log (one entry per `commit_changes`). Filters compose: `developer`, `session_id`, `since_hours` or `since`/`until`, `requirement_contains`. Each entry carries the actual `files` that commit touched, plus an `all_files` union across every match — the graph tools know nodes, so this is the only source of a commit's full file list. Local and gitignored: this machine only, never the shared graph.

> Removed in 3.0.0: `get_node_graph` and `get_node_history` are folded into `get_node_code` as the `graph_*`/`history` params above — one call instead of three, and depth-1 neighbors come back whether you ask or not. `get_recent_changes`, `get_developer_activity` and `get_changes_by_requirement` collapsed into `get_activity_log`'s composable filters. `search_decisions` is gone because `search_nodes` already searches reasoning text from **every** history revision, not just the latest. `get_orphaned_nodes` is gone because `analyze_graph` reports orphans along with everything else it checks.

### ⚙️ Category 3: Code Indexing
*   `index_start`: Scans all configured repos, counts files, creates a scratchpad, and starts the codebase indexing session.
*   `index_checkpoint`: Saves current indexing progress to the scratchpad to survive context limits (called every ~10 files).
*   `index_continue`: Reads the scratchpad and returns exactly where indexing left off to resume after a context reset.
*   `index_complete`: Marks the codebase indexing session as fully completed.

### ✍️ Category 4: Writes & Mutations
*   `edit_node`: **The primary write path — use this, not the IDE's own edit/write tool, for every edit and every new file.** One call — `file_path` + `old_string` + `new_string`, exactly like an ordinary edit tool — never refuses a file type, and never rejects for being the wrong extension. Under the hood it works out WHERE the text landed and which function/class that spot belongs to (by position, not by name — so it survives the symbol being renamed by the very edit that touched it, and correctly identifies code that didn't exist until this write). No `node_id` to look up, no `code_snapshot` to send back, no follow-up `stage_change` call, for any TS/JS/JSX/TSX/Vue/Svelte file. It also hands back every CALLER of what you just changed (i.e. what you may have just broken) and the reasoning previously recorded against it. To create a file that doesn't exist yet, pass `old_string: ""` and the whole file as `new_string` — every symbol in it gets traced the same way. Writes landing outside any function (markup, config, an import line, a stylesheet) get no graph node — a normal, expected outcome, not a failure, since the graph only models code — but the whole-file before/after is still staged for the local activity log, so `commit_changes` makes even a CSS/JSON/XML/etc change individually revertable in `devsmind view` → Chat, the same as a traced code edit. Nothing reaches the graph — or the activity log — until `commit_changes`, which is also where you give the one `reasoning` covering everything staged since the last commit.
*   `stage_change`: The fallback for what `edit_node` can't trace — a language with no local parser (Python, Go, Java, C#, Ruby, PHP, Rust, Swift, Kotlin, Dart) — or code you already wrote with your own tool for some other reason. Buffers one touched entity (node id + code snapshot) to disk **without** writing to the graph yet.
*   `commit_changes`: Flushes the whole staged buffer in one pass — creates/updates every node, writes every history snapshot with the ONE `reasoning` given on this call, then resolves all connections between them (and into the existing graph) via local AST, auto-creating any referenced-but-missing target nodes. Because all nodes exist before edges are resolved, calls between the changed files link correctly regardless of staging order. If this session is bound to a workflow, this also auto-records one step on its timeline from that reasoning, carrying the `node_ids` it touched and the `session_id` that recorded it — see `workflow_add_step` below. **Must be called at least once per staged batch**, or nothing is written to the graph. `edit_node` also only stages — it needs `commit_changes` too. `message` AND `reasoning` are **REQUIRED** — validated before any write happens, so a call rejected for a missing field leaves the staged batch untouched and the AI can just retry with it. `message` is the user's original request, verbatim, feeding the local Activity log (`devsmind view` → Chat, see below) together with the conversation's `session_id` (from `start_session`, carried automatically) — grouping consecutive commits for the same request into one entry, never reaching the shared graph. `reasoning` (`what_changed`/`why`/`goal`, plus optional `requirement`/`previous_state`/`decision`/`developer`/`model`) is the one object recorded against EVERY node this commit touches — a commit is one logical change, so it gets one why, not one per `edit_node`/`stage_change` call.
*   `rename_node`: Re-keys a node identifier and updates all associated records (connections and history) seamlessly.
*   `deprecate_node`: Marks a code node as deprecated, removing its connection mappings while retaining its coding snapshots and reasoning logs in the database.

> The former `add_node` / `add_connection` tools are removed — nodes and edges are now created automatically by `stage_change` + `commit_changes` (or `edit_node` alone, for TS/JS), so the AI never hand-manages edges. `update_history` (the old single-node write) and `search_code` (now folded into `search_nodes`'s automatic fallback) still work if called directly for backward compatibility, but neither is advertised to the AI anymore. Neither `edit_node` nor `stage_change` can write inside `.devmind/` itself (DevsMind's own config/database) — only inside your configured repos.

### 🧹 Category 5: Optimization & Maintenance
*   `recheck_graph`: Scans the graph to verify file existence and deprecates language primitives, builtins, and nodes associated with missing/deleted files, retaining nodes with active histories.
*   `analyze_graph`: Runs a local, **zero-token** health check — god entities, circular dependency cycles, orphaned nodes, dangling edges, duplicate/case-collision ids, history missing developer attribution, empty code snapshots, spurious/built-in nodes, missing files, git-detected renames, and git-tracked files with zero graph nodes. Set `fix:true` to auto-apply only the safe fixes (soft-deprecate dead nodes, remove dangling edges, migrate renames); everything else is report-only since it needs a human/AI judgement call. See [`devsmind analyze`](#-other-cli-commands) below for the CLI equivalent and full detection list.

### 🗂️ Category 6: Workflows
A named, backward-looking log of how one piece of functionality grew across many nodes and many sessions — read it to learn how the code got this way. Eight tools; see [Workflows In Depth](#-workflows-in-depth) above for the model behind them.
*   `workflow_create`: Names a new thread. Does not touch anyone else's session — creating one doesn't pause anything, because there is nothing global to pause.
*   `workflow_bind`: Attaches THIS session to a workflow; omit the id to detach. The binding is local to your session and to your machine. (`workflow_pause`/`workflow_resume` still answer as unadvertised aliases for detach/attach, so an agent working from a pre-3.0 rule doesn't hard-fail.)
*   `workflow_list`: Lists workflows — `query` matches name **and** description, `limit`/`offset` page, `include_archived` opts the retired ones back in. The agent is instructed to call this before starting work that might relate to an existing thread, and to offer continuing it rather than silently starting fresh.
*   `workflow_get_context`: The one read — steps in order, each with its reasoning and the nodes it touched, plus any document paths. Paged (`limit`/`offset`/`last_n`), with `steps_total` always exact. The call to make right after binding.
*   `workflow_add_step`: Records one step. **Usually not called directly** — `commit_changes` auto-records a step from whatever it just staged whenever the session is bound. Call it yourself for what a commit can't express: a decision or research finding that changed no code, with the documents behind it via `doc_paths` (repo-relative paths, never copies; a path outside every configured repo is rejected).
*   `workflow_sync`: Attaches work you already did — for when you were unbound, or on the wrong thread. Reads your local activity log, previews what it would attach, and only writes on `confirm:true`. Re-running is a no-op.
*   `workflow_archive`: Retires a thread from the list without deleting anything, reversibly. Deliberately not "complete": a feature is never finished, it just stops being worked on.
*   `workflow_import`: Imports existing flow/architecture docs (`# Title` / `## Summary` markdown files) as workflows — a whole folder or a single file. The doc is referenced by path, not copied. Re-importing the same file updates its workflow in place instead of duplicating it. See [`devsmind workflow-import`](#-other-cli-commands) below for the CLI equivalent.

> Removed in 3.0.0: `workflow_pause`/`workflow_resume` (→ `workflow_bind`), `workflow_get_steps` (→ `workflow_get_context`, which is paged), `workflow_search` (→ `workflow_list`'s `query` — the old one scanned step summaries and artifact names but never the workflow's own name, so looking one up by name returned nothing), `workflow_add_artifact`/`workflow_read_artifact` (→ `doc_paths`), and `workflow_sync_retroactive` (→ `workflow_sync`, which actually reads something).

---

## 🎨 `devsmind view` — Chat + Graph, one app, fully offline

```bash
devsmind view
```

One app, two tabs, no CDN dependencies (the graph libraries are vendored into the package, so this works with no internet connection). The old three-separate-pages layout (`/` 2D graph, `/3d`, `/activity`) is gone — everything lives at `/` now.

**Chat (default tab)** — a read-only history of your own work, chat-bubble style: your request on one side, the AI's summary on the other, grouped into the sessions `start_session` created. A floating date-range filter defaults to today. Expand a message to see what it changed:
*   **Whole-file, PR-style diffs.** Every edit a message made to one file collapses into a single git-style hunk view, red/green, even if several functions in that file changed — with a **"view full file"** toggle that shows the complete reconstructed file, changes highlighted in place, instead of just the changed lines.
*   **Revert / un-revert**, with a backup. Reverting a message restores the code and marks the message reverted rather than erasing it; un-revert brings it back. **Stack semantics**: revert message *N* and every later message still applied reverts too (newest first, since later work was built on top of it); un-revert restores oldest-reverted-first, back up the stack in the order things came off. A revert that hits a file changed since (a hand-edit, a pull) stops at a clean boundary instead of forcing it, and says exactly which message blocked it.
*   **Covers every file** — a CSS/JSON/XML/Markdown edit, or a code edit landing outside any function, gets no *graph* node (the graph stays code-only) but still shows up here as a revertable whole-file change, same as a traced code edit.
*   This is deliberately a *second*, different revert system from `devsmind revert` (below) — that one is permanent, no backup, scoped to one entity's last edit; this one is reversible, backed up, and scoped to a whole request. They coexist on purpose.

**Graph tab** — rebuilt around the actual complaint that a whole-graph render doesn't scale past a trivial project size:
*   A sidebar **accordion** (repo → type, with a search box) is how you find a node, instead of staring at the full force-graph looking for it.
*   Clicking a node opens a small **ego-graph** — just that node's `uses` (outgoing) and `used by` (incoming) neighbors, one hop, with distinct colours, directional arrows, and a legend so the direction is never ambiguous. Click a neighbor to re-center on it. Every node is labeled (name under the dot), not just a bare colored circle. 2D/3D toggle on this view.
*   **Filters** for type, developer, and an actual date **range** (two date pickers, not just presets) — each checkbox group has "select all / none," and your filter selections persist across reloads (scoped per-project, via `localStorage`).
*   A **"See whole graph (2D)"** button stays as the escape hatch when you genuinely want the full picture over your current filtered set — 2D only, since that's the view that's actually usable at scale; 3D is reserved for the small ego-graph where depth helps rather than just looking impressive.
*   The detail pane (file, signature, history, per-edit diffs, revert) works the same as before — same engine as [`devsmind revert`](#-other-cli-commands), same refusals.

The server binds loopback only (`127.0.0.1`), and every write route (`/api/revert`, `/api/message-revert`, `/api/message-unrevert`) additionally requires a per-process token that only a page this server rendered is given — a page loaded from anywhere else can't reach them, even from this machine. `view.html` and its JS/CSS are re-read from disk on every request (never cached), so a server left running across an update always serves the current build, not a stale pairing of old HTML with new JS.

To query the view URL programmatically from your agent, call `get_visualizer_url`.

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

### 3.0.0 — Workflows rebuilt around sessions, search that survives one turn, no more `devmind_path`

A major rather than a minor, for a plain reason: tools were **removed**. `workflow_pause`/`resume`/`search`/`get_steps`/`add_artifact`/`read_artifact`/`sync_retroactive` are gone, `get_node_graph` and `get_node_history` folded into `get_node_code` as parameters, `search_nodes` lost `keywords` and `is_regex`, and `list_nodes` answers an object where it used to answer a bare array. Re-run `devsmind rule` (and `devsmind memory`, if you seeded it) after upgrading — an agent working from the old rule will confidently call tools that no longer exist.

**Workflows were designed before sessions existed, and it showed.** "Which workflow is active" was a *single project-wide pointer*, serialized into the committed `workflow.json` and restored on sync. That isn't awkwardness, it's a correctness bug: two sessions shared one pointer, so session B calling `workflow_resume` silently paused session A's workflow mid-work, and A's next `commit_changes` wrote its step onto **B's** timeline. No error, nothing to notice. And because the pointer travelled through git, a teammate could do it to you from another machine.

The fix is to stop storing the thing at all. Binding is now per session and lives in gitignored `.devmind/local/` — a bookmark belongs to the reader, not the book, and one book with one bookmark means two readers fight over it. "What was I last working on" is derived (the newest session carrying a `workflow_id`) rather than recorded, and "is this workflow active" simply stops existing as state: it's whether some session is bound right now.

Two other things were quietly wrong. A step stored `history_ids`, which **cannot identify a commit** — `updateHistory` merges any two commits on the same node within an hour into a single row and returns the pre-existing id, so a step's ids could point at rows an earlier commit created, and one row could be cited by several steps. Steps now carry their own `reasoning` plus the `node_ids` they touched. Copying the reasoning rather than joining to it is deliberate: history reasoning *mutates* afterwards (the hourly merge appends, a revert can drop a block), and a record of what we thought at the time can't read from a moving target. Separately, `commit_changes` never passed `session_id` when creating a step — the column existed and sat null on the path that creates nearly every step.

`status: active/paused/completed` is replaced by `archived`. Nothing ever completed and nobody marked it, so the field lied; threads sort by last-touched so live work floats up on its own, and archiving claims only what it delivers — hide this from the list, reversibly. `pending_tasks` is gone with no replacement: a "what's left" note goes stale the moment it's written, and a *wrong* one is worse than none, because an agent will act on it confidently.

Research became a first-class step, which is the part that actually justifies the feature. Development already leaves a recoverable trail — git has the diff, node history has the per-node reasoning. Research leaves nothing: nobody can reconstruct "we evaluated three options and rejected two" from the code that survived. So `workflow_add_step` takes a finding with no code change at all, plus the documents behind it as `doc_paths` — **paths, not copies**. The old `workflow_add_artifact` duplicated whole files into `.devmind/workflows/<id>/artifacts/`, which goes stale the moment the original changes; your repo already versions and shares the original. A path outside every configured repo is rejected, since a file only you can see is useless to a teammate.

`workflow_sync_retroactive` was the one tool that didn't do what its name said — it read no activity log, no history, no transcript; the agent hand-assembled a `steps` array from its own context and the tool wrote it down. `workflow_sync` now reads your local activity log, previews what it would attach, and writes only on `confirm:true`. Dedupe is by consumed edit id rather than a per-message flag, because a message keeps growing after it's tagged — a boolean would permanently strand everything added later, while edit ids make a re-run a true no-op and still let a grown message contribute a delta. This is also why no drift detection was built: asking an agent to notice "this task isn't related anymore" gets it wrong in both directions, and retroactive fixing being cheap is what makes getting it wrong in the moment acceptable.

One migration detail worth stating plainly. New columns are added on the next brain open via the same guarded `ALTER TABLE` pattern already used elsewhere, and old steps are backfilled by resolving their `history_ids` to the nodes those rows belong to — but because of that same one-hour merge, **a backfilled node list can be broader than what the step really touched**. Steps written from now on are exact. And a teammate on an older build can no longer destroy the new data: each workflow is written as two files, `workflow.json` in the shape a pre-3.0 client understands plus `v2.json` holding what that shape has no field for. `devsmind sync` re-serializes `workflow.json` from local columns, so an un-upgraded machine that pulled and synced *would* have rewritten the file without the new fields and committed that loss — it has no idea the sidecar exists, so it can't touch it, and the next read merges everything back.

**Oversized responses used to dead-end.** A large `search_nodes` result could exceed the client's inline limit, spill to a file, and then have *that* file truncate on read — leaving nothing usable at all, which is worse than a small answer. Results are now trimmed in two tiers: first the bulk carrying no signal (per-file `match_counts`, `matched_terms`, `aliases`, repeated boilerplate, thinned sample lines), and only if that isn't enough, the evidence lines themselves. A `compacted` field always states which happened and **every count stays exact**, so a trimmed result can never read as a complete one. Compaction also *skips* the AST symbol-annotation pass rather than computing it and throwing it away, and responses are no longer pretty-printed — indentation was 20-30% of the payload, and MCP clients parse rather than read it.

`list_nodes` had no bound of any kind, which is precisely backwards for an enumeration tool: the reason you call it is that you don't know how many there are. On a real backend one unfiltered call returned ~600KB across ~10,900 lines. It's paged now, with `total` as the true match count and a `hint` naming the exact next call. `get_node_code`'s embedded `graph_code` budget dropped to 24000 characters (it rides along with code, imports, neighbors and history rather than being the whole payload), and when it runs out the dropped nodes are named **by id** rather than left to a positional cursor — the walk is re-derived per call and the cut-off depends on file contents, so an index would silently skip or repeat nodes.

**Your configured file exclusions never worked.** `ignored_paths` was only ever checked against *directories*, so every file listed in it was silently searched anyway — and that was the common case, not an edge one: `devsmind init`'s own preset list is entirely file names, and `.gitignore` import passes literal file names straight through. Users had excluded these, watched them keep appearing in every result, and had no way to tell the setting was being dropped on the floor. Lockfiles and build artifacts are now excluded by default too, so a repo predating `init` still gets clean results — a lockfile names every dependency in the tree, so a product term matched it purely because some package was named that. Also fixed: a leading-slash `.gitignore` entry (`/dist`, `/build`) matched nothing at all, in both the search walk and the indexer.

**`search_nodes` got a real regex.** `keywords` was a pipe/comma-split list that got regex-**escaped** before matching, which silently mangled a caller's own correct regex — `item\.liked` searched for a literal backslash and never matched real code. It's replaced by `pattern`: the string is used exactly as given, the same one you'd hand `grep`. `query` became optional, making a pattern-only call a first-class precision mode that skips the semantic layers entirely (a regex has no meaning to embed). `path` scopes the walk to one folder or file; `case_insensitive`, previously accepted and silently ignored, is actually wired through. Both buckets gained true `*_total` fields so a capped page is never mistaken for "nothing more to find", and every `files` sample line reports its containing function or class when resolvable — insight a plain filesystem grep can't give. Node results also now **lead** with `confidence`/`relevance`/`found_by` instead of trailing `description`: the fields always existed, but landing behind a full sentence of prose meant they got skipped in favor of eyeballing node names, and a name that merely looks right is the easiest way to pick the wrong node.

**Several numeric params were unvalidated in ways that failed silently** — the worst kind. `graph_code_budget:"abc"` became `NaN`, and since every `spent + len > NaN` comparison is false, that meant an **unlimited** budget: the exact opposite of passing a budget. `search_nodes`' `limit:"abc"` became `NaN` too, and `slice(0, NaN)` returned an empty `files` array next to a non-zero `files_total`, indistinguishable from "grep found nothing"; a negative `offset` paged from the *end* of the ranking. Also adds a missing index on `node_connections(target_node_id)` — every "who uses X" lookup was a full table scan, once per node visited in a graph walk.

**The server binds to one project.** `devsmind start` (HTTP or `--stdio`) resolves its project once at startup — `--path`, or auto-detected from cwd — and every advertised tool schema then drops `devmind_path` entirely, so the agent never discovers, remembers, or re-sends it. Generated stdio configs bake in an absolute `--path`, because the IDE controls the spawn cwd and auto-detection alone isn't reliable there. Unbound (tests, or no `.devmind` to find) falls back to the legacy per-call behavior unchanged.

**`session_id` came off reads.** Searching and reading mutate nothing, so gating them on a session bought nothing but friction — the very first thing an agent does in a conversation is usually a search, and it used to error. Only writes require it now. `get_activity_log`'s own optional `session_id` filter is also no longer force-promoted to required by the blanket injection it used to go through.

**And `devsmind -v` reports the real version.** It answered `1.0.0` from the first commit through 2.5.0 — hardcoded next to `package.json`'s real number and never once updated. That's worse than having no version flag at all: someone filing a bug reads it and believes it, and so does whoever tries to reproduce against that release. The CLI, the MCP server's `serverInfo`, and `GET /health` all derive from `package.json` now, so there's one number and nothing left to keep in sync.

### 2.5.0 — A new view app, an activity log with revert, explicit sessions, two rule styles

Everything in this section shipped as one release. None of it was ever published to npm individually — 2.4.0 was the last version that actually went out, so this is a single jump, not five quiet ones.

**`edit_node`'s missing half.** 2.4.0 made `edit_node` the way an agent writes code, which quietly took something away: a native edit tool shows you a diff and lets you reject it, `edit_node` wrote straight to disk and told you a node id. `edit_node` now returns the diff of what it just changed as a rendered `+`/`-` block in its own tool result — a second content block alongside the JSON, so nothing that parsed the old response breaks — and it keeps the pre-edit code of every symbol it touches (it already computed this internally to tell which symbols changed; it just used to throw it away) as an `edits` trail on the history JSON. That trail is what makes `devsmind diff`/`devsmind revert` possible from the terminal. Two limits are permanent rather than unfinished: only the newest edit to an entity can be reverted, and only while the file still matches what was recorded — anything else means restoring a "before" that later work was built on top of, which git handles correctly and this defers to. And nothing recorded before this release has a before-state to diff or revert; it can't be backfilled.

**The activity log** (`devsmind view` → Chat) answers a different question than a single node's diff: "what did I do today," and lets you walk back more than one edit at a time. The unit is a **message** — one user request, however many `commit_changes` calls it took to satisfy; pass `message` with the request text and consecutive commits for the same request merge into one entry instead of scattering into several. It lives in `.devmind/local/`, gitignored from the start: message text is only ever meaningful on the machine that wrote it, and `brain.db` is documented as a disposable cache that gets rebuilt from committed JSON, so an activity log that could vanish on a rebuild wasn't one worth having.

The interesting design problem was revert, and the shape came directly from how the person using it actually thinks about undo: *"if I revert one message in the middle, all the messages after it should revert too, and I can un-revert them one by one as changes stack on each other."* That's a stack, not a delete. Reverting message *N* takes everything from *N* to the newest still-applied message, newest first, because each one was written against the code the previous one produced. Un-revert is the mirror: only the oldest currently-reverted message can come back, one at a time, in the order things came off. Both directions refuse rather than force when a file has drifted since — the cascade stops at a clean boundary and says exactly where. This is explicitly a *second* revert system next to `devsmind revert`, not a replacement for it: that one stays permanent, no backup, one entity — a fast "that was wrong" for a single function. This one trades simplicity for reversibility and scope: a whole request, backed up, undoable.

It initially inherited a scope limit it shouldn't have: `edit_node` writing a non-code file (CSS, JSON, XML, Markdown, ...), or landing outside any function in a traceable file, correctly gets no *graph* node — the graph is deliberately code-only — but as an unintended side effect it also left no trace in the activity log either. The file was written; there was just no record of it once the session ended. Fixed by staging a whole-file before/after for exactly that case (never instead of a traced node edit, only when there isn't one), so `commit_changes` folds it into the same message as everything else in that commit. The one real subtlety: a single commit can mix a traced node edit and an untraced whole-file edit on the *same* file, and the whole-file reconstruction undoes a file's edits newest-first — so it depends on true chronological order, not "all node edits, then all whole-file edits," which a naive concatenation would produce. Staged entries are now stamped with when they were staged, and the activity message sorts by that before saving.

**A new view app.** The three-separate-pages layout (`/` 2D graph, `/3d`, `/activity`) is retired in favor of one app with Chat and Graph tabs, and it now works fully offline — the graph libraries are vendored into the package instead of loaded from a CDN. Chat renders the activity log above as an actual chat transcript, with git-style whole-file diffs (a "view full file" toggle shows the complete reconstructed file, not just the changed hunks) and revert/un-revert inline. Graph is a deliberate rebuild around the complaint that a whole-graph render doesn't scale: a repo→type accordion sidebar with search drives what you look at, clicking a node opens a small labeled ego-graph of just its uses/used-by neighbors (colours, arrows, a legend, click-to-re-center) instead of the entire graph at once, filters (type/developer/date-range, each with select-all/none) persist across reloads, and a "See whole graph (2D)" button stays as the escape hatch for when the big picture is genuinely what's wanted. One bug worth naming: `view.html` was being cached once at server start while its JS/CSS were always read fresh — a server left running across an update could serve a stale page paired with newer JS expecting elements the stale page didn't have. Both are now re-read on every request, with `Cache-Control: no-store`.

**Explicit sessions.** The activity log's session identity was the weak link — `session_id` was optional, so a missing one got silently auto-minted per commit, scattering one task's work across several sessions instead of grouping it the way the feature promised. A new `start_session` tool is now the only way a session comes into being; every other DevsMind tool call, reads included, now REQUIRES the `session_id` it returns, echoed back on every single response afterward so it survives a long conversation or a context compaction — one mention at the top of a session doesn't reliably make it to turn 40, a value repeated on every response does. `commit_changes` now also hard-requires `message`, validated *before* anything is written or staging is cleared, so a rejected commit for a missing message is a true no-op, safe to retry. DevsMind stays fully stateless through this — it never tracks "the active session" server-side, so two agents on the same project never collide over a shared "current" id.

**Reasoning, once per commit instead of once per edit.** Every `edit_node`/`stage_change` call used to require its own `reasoning` object — `what_changed`/`why`/`goal`, sometimes `requirement`/`decision`/`previous_state` too — even though a commit almost always answers one request, so five edits in service of it meant retyping a near-identical justification five times for no real payoff (nobody reads five copies of the same "why"). `reasoning` moved to `commit_changes`, required exactly once there, and now gets recorded against every node staged since the last commit. The one thing this trades away is the ability to give two nodes in the same commit genuinely different reasons — the position taken here is that if that's ever actually needed, it's two commits, not two reasoning params on one. Every consumer of the old per-edit field already ran at commit time anyway (`updateHistory`'s write into node history, the workflow-step/activity summary), so nothing earlier in the pipeline needed it in the first place — this is a straightforward move of a required argument to where it was already being used.

**Two rule workflow styles.** Every rule up to this point assumed the AI should stage and commit everything proactively — the right default for a team's shared graph, but not the only reasonable way to run it. `devsmind rule` now asks up front: **Automatic** (unchanged) or **Manual** (search/read tools stay fully on, but `stage_change`/`commit_changes` are off-limits unless explicitly asked for). `session_id` and `message` stay hard-required by the protocol in both — a rule can shape the agent's judgment, it can't waive a server-side validation; the style only changes whether the agent *decides on its own* to write. Every run also prints a short **session kickoff prompt**, deliberately kept out of the persistent rule file, meant to be pasted fresh at the start of every new conversation — a direct instruction rather than background context a long session, or a brand-new one, might not weigh appropriately on its own. The shortest, strictest version of that reminder, usable regardless of which style a project is set to:

> Before doing anything else: fully read and follow this project's DevsMind rule — no exceptions, no shortcuts, not even for a small edit.
> Call `start_session` first and carry its `session_id` on every DevsMind call this conversation, or nothing else will work.

The one thing none of this adds is pre-write approval — catching a bad edit before it lands, rather than undoing it after. That needs an inline diff inside the editor itself, which an MCP tool cannot draw; only a real IDE extension can. It remains open.

### 2.4.0 — `edit_node`: one write path for every file

The write path used to be two calls: edit the file with your IDE's own tool, then remember a separate `stage_change` call to record why. That second call was easy to skip — it cost the agent tokens and gave nothing back in return, so it got treated as a courtesy step rather than something the agent actually needed. `edit_node` collapses this to one call that pays for itself: it edits the file (never refusing a type, unlike `stage_change`), works out which function/class the text actually landed in **by position, not by name** (so it survives the symbol being renamed mid-edit, and correctly identifies code that didn't exist until the write itself), and records `reasoning` against it automatically. In return it hands back every caller of what you just changed — the one thing you'd otherwise spend a separate call discovering. For TS/JS/JSX/TSX/Vue/Svelte, `stage_change` is no longer needed at all; it's now scoped to languages with no local parser (Python, Go, Java, and friends) plus anything you genuinely wrote with your own tool for some other reason.

This release also came out of a deliberate hardcore adversarial testing pass — three parallel agents stress-testing the indexing/read/lifecycle tools, the workflow tools, and every CLI command, plus targeted fuzzing of the new `edit_node` path (path traversal, CRLF/BOM/Unicode files, decorators, concurrent writes, monorepo scoping, empty files). Two of the confirmed bugs were genuine data corruption, unrelated to anything new: `syncFromDisk`'s "is this path already absolute?" check only recognized the `C:` drive and POSIX roots, so a project on `D:` or a UNC path had its `file_path`s silently rewritten to the `.devmind` folder on every server restart; and `rename_node` given a bare id (the same short form every read tool accepts) quietly left the old node's history and edges in place while creating an empty, disconnected node under the new id — the tool reported success either way. A third pass caught something more systemic: 35 tools' worth of required-string arguments were read via a bare `String(args.x)`, which turns a missing field into the 4-character string `"undefined"` instead of an error — confirmed concretely in `workflow_create`/`workflow_add_step`, then generalized into one validation helper applied everywhere the same risk existed.

Older releases: see [CHANGELOG.md](CHANGELOG.md) for the full compact release history.

---

## 📄 License

DevsMind is released under the [MIT License](LICENSE).
