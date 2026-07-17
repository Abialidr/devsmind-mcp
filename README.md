# 🧠 DevsMind — Team AI Brain

[![NPM Version](https://img.shields.io/npm/v/devsmind-mcp?color=blue)](https://www.npmjs.com/package/devsmind-mcp)
[![License](https://img.shields.io/badge/license-MIT-green)](https://github.com/Abialidr/devsmind/blob/main/LICENSE)

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

> 📖 Looking for the exhaustive version (every flag, every schema field)? See [detailExplanation.md](detailExplanation.md). This file is the fast path.

---

## How it works

Run `devsmind init` once per project → creates `.devmind/`. Commit it. Every teammate's agent reads and writes the same graph.

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

## 🚀 Why teams use it

| Feature | What it means |
|---|---|
| **Function-level history** | Every function/class has a change log — not just diffs, but *why* |
| **Workflow context vault** | Persistent, git-shared timeline for multi-day features — solves "context death": an agent resuming days later picks up the full decision history instead of starting from zero |
| **AI-written context** | Your agent records why/goal/decision/ticket as it works |
| **Token-cheap lookups** | Agent reads one function via the graph instead of a whole file — up to ~70% fewer tokens |
| **One server, many projects** | Install once globally; each call passes its own project path |
| **Git-native sharing** | The graph is JSON + SQLite cache, committed like code |
| **Visual explorer** | `devsmind view` opens a 2D/3D graph of your architecture |

---

## ⚡ Quick Start

```bash
npm install -g devsmind-mcp
```

### Starting a brand-new brain

```bash
devsmind init      # 1. Create .devmind/ — interactive: project name, repos, tech stack
devsmind mcp       # 2. Connect your IDE/CLI to the MCP server
devsmind rule      # 3. Paste the workspace rule — this is what teaches your agent to actually use it
devsmind start     # 4. Start the server (skip if your IDE launches it via stdio)
devsmind index --run --provider gemini --key YOUR_KEY   # 5. (optional) index the codebase now
git add .devmind && git commit -m "Add DevsMind brain"  # 6. share it
```

### Joining a brain a teammate already created

```bash
git pull           # 1. .devmind/ is already in the repo
devsmind init      # 2. sets up YOUR machine only (dev identity, local paths) — doesn't touch the shared graph
devsmind mcp       # 3. connect your IDE/CLI
devsmind rule      # 4. paste the workspace rule
devsmind sync      # 5. load teammates' committed changes into your local cache
devsmind start     # 6. start the server (skip if stdio)
```

> **Already set up, just upgrading?**
> ```bash
> npm install -g devsmind-mcp@latest
> devsmind rule     # re-paste — the generated rule content changes between releases
> ```
> Check the [Changelog](CHANGELOG.md) after upgrading — some releases need this re-run, some don't.

---

## 🔌 The three setup commands, and why there are three

| Command | Answers | Skip it and… |
|---|---|---|
| `devsmind mcp` | Can your agent *reach* the tools at all? | DevsMind tools don't exist from the agent's point of view |
| `devsmind rule` | Does your agent *know* to use them? | Agent defaults back to grep/raw file reads out of habit |
| `devsmind memory` *(optional)* | Does that behavior *persist* without re-pasting? | Only matters for a handful of tools with their own agent-writable memory store |

`mcp` and `rule` are both guided: pick your tool (Cursor, VS Code, Claude Code, Codex, Windsurf, Kiro, Antigravity, Qwen Code, …), then either copy a printed snippet or let DevsMind write/merge the config file for you.

**`devsmind memory`** only writes where it's actually confirmed safe:

| Tool | Seeded automatically? |
|---|---|
| Claude Code (Auto Memory) | ✅ |
| Google Antigravity (Skills / `/learn`) | ✅ |
| Qwen Code CLI | Already covered by `devsmind rule` |
| Codex CLI, Cursor, Windsurf, Kiro, VS Code Copilot | ❌ — prints why + what to do instead |

> ⚠️ **`devsmind rule` / `devsmind memory` are not a guarantee, they're a nudge.** Pasting the rule doesn't make an agent use DevsMind every turn for the rest of time — on long sessions, agents drift back to their default habits (grep, raw file reads) and quietly stop calling `search_nodes`/`stage_change`/`commit_changes` as context fills up. When you notice that happening, just tell it directly: *"use the DevsMind graph, then stage and commit this."* It's a cheap thing to say and usually the highest-leverage sentence you can add — DevsMind's whole value is the code context + the *why* behind it, which plain grep never gives you.
>
> **And this part doesn't have a workaround:** if the agent never calls `commit_changes`, that history is gone for good. `devsmind reindex` / `devsmind analyze --fix` can repair the *code graph* (nodes, edges, stale entries) after the fact, but neither one can reconstruct the reasoning, decisions, or workflow steps that were only ever going to be written by the agent, in that turn. Skipped commits don't just leave a gap you can backfill later — they silently defeat the entire point of DevsMind.

---

## 📇 Indexing your codebase: `index` vs `reindex`

Both extract code entities via an LLM, then resolve connections locally (free, no LLM). You don't strictly need either — the graph also grows "as you go" from your agent's own edits — but until something has indexed the codebase, there's little for the agent to look up yet.

| | `index --run` | `reindex` |
|---|---|---|
| Use for | First full pass | Keeping an already-indexed graph in sync |
| Flag required | `--run` | none — always executes |
| Selection | Whole repo (or `--nodes-only` / `--edges-only` / `--repos`) | Diffs mtimes since last run, or `--fill-gaps` to backfill zero-node files |
| Destructive option | `--from-scratch` wipes everything first | — |

```bash
devsmind index --run --provider gemini --key YOUR_KEY
devsmind reindex --provider gemini --key YOUR_KEY --fill-gaps
```

**Common flags** (both commands): `--provider gemini|vertex|ollama` · `--model <name>` · `--key <api_key>` · `--chunk-size <lines>` · `--rpm <number>` (unthrottled by default).

**Providers:**

| Provider | Auth | Notes |
|---|---|---|
| `gemini` (default) | `--key` or `GEMINI_API_KEY` | fastest, most accurate in testing |
| `vertex` | service account JSON or bearer token | for teams already on GCP |
| `ollama` | none — local server | free, private, slower and less accurate |

Rough benchmark (~1,080-file repo, informal): local Ollama model took ~15h at ~50% accuracy; `gemini-2.5-flash` took ~5h at ~90%. Local avoids API cost; cloud is faster and more accurate for extraction. Edge resolution is local/free either way.

---

## 🖥️ Other commands (cheat sheet)

| Command | What it does |
|---|---|
| `devsmind start [--stdio] [-p <port>]` | Run the MCP server |
| `devsmind sync [--analyze] [--fix]` | Pull committed graph changes into your local cache |
| `devsmind view` | Open the interactive 2D/3D graph visualizer |
| `devsmind analyze [--fix]` | Zero-AI local health check (god entities, cycles, orphans, dangling edges, dupes, stale attribution…) — `--fix` auto-applies only the safe/reversible fixes |
| `devsmind prune` | Interactive review + permanent delete of nodes/history |
| `devsmind workflow` | Interactive view of multi-day feature workflows |
| `devsmind workflow-import <path>` | Import existing flow docs as resumable workflows |

---

## 🔌 MCP tools, grouped by purpose

DevsMind exposes ~35 tools to the agent. The ones you'll see referenced most:

| Group | Tools |
|---|---|
| **Search/discovery** | `search_nodes`, `list_nodes`, `get_node_graph`, `get_orphaned_nodes` |
| **Read code/history** | `get_node_code`, `get_node_history`, `get_recent_changes`, `search_decisions` |
| **Write (the important one)** | `edit_node` — edits any file, traces what changed, records why, all in one call. `stage_change` + `commit_changes` cover what it can't (non-TS/JS languages, brand-new files written another way). |
| **Maintenance** | `recheck_graph`, `analyze_graph` |
| **Multi-day workflows** | `workflow_create`, `workflow_add_step`, `workflow_pause/resume`, `workflow_get_context`, `workflow_search` |

Full descriptions and token-cost notes: see [detailExplanation.md § MCP Tool Reference](detailExplanation.md#-mcp-tool-reference).

---

## 🗄️ Storage model, briefly

```
.devmind/
  config.json   ← project + repo config          (committed)
  .env          ← your machine's local paths      (gitignored)
  brain.db      ← SQLite metadata cache           (gitignored, rebuilt from JSON on start)
  history/      ← code snapshots + reasoning      (committed, one JSON per entry)
  graph/        ← node/connection structure       (committed, one JSON per file)
  workflows/    ← multi-day feature timelines      (committed)
```

The JSON files are the source of truth (git-mergeable); `brain.db` is a disposable local cache rebuilt from them on startup. Full 7-table schema: see [detailExplanation.md § Database Schema](detailExplanation.md#-database-schema-devmindbraindb).

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for what shipped in each release.

---

## 📄 License

MIT — see [LICENSE](LICENSE).
