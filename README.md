# 🧠 DevsMind — Team AI Brain

[![NPM Version](https://img.shields.io/npm/v/devsmind-mcp?color=blue)](https://www.npmjs.com/package/devsmind-mcp)
[![License](https://img.shields.io/badge/license-MIT-green)](https://github.com/Abialidr/devsmind/blob/main/LICENSE)

> **The evolutionary collective memory layer for your AI coding agents. Shared across your entire team.**
>
> **TypeScript / JavaScript projects only, for now.** The core write path (`edit_node`) relies on parsing your code — that's currently TS/JS only. Other languages are on the roadmap, not yet supported.

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
  ├── local/          ← Your activity log — sessions, messages, revert backups (Gitignored)
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
| **AI-written context** | Your agent records why/goal/decision/ticket once per commit — covers everything staged since the last one |
| **Token-cheap lookups** | Agent reads one function via the graph instead of a whole file — up to ~70% fewer tokens |
| **One server, many projects** | Install once globally; each call passes its own project path |
| **Git-native sharing** | The graph is JSON + SQLite cache, committed like code |
| **See it and undo it** | `edit_node` replaces your agent's edit tool — so it gives back what one gives you: `devsmind view` shows a red/green diff of every change with the *why* attached, and reverts it in a click |
| **Chat: your work, by day** | `devsmind view` → Chat: a chat-bubble timeline of your requests, local-only, with git-style whole-file diffs. Revert a whole request (with a backup, un-revertable) — not just one function |
| **Graph, made findable** | `devsmind view` → Graph: a repo/type sidebar and filters instead of a wall of nodes — click one to see just its uses/used-by, 2D or 3D, no CDN required (works offline) |

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

`mcp` and `rule` are both guided: pick your tool (Cursor, VS Code, Claude Code, Codex, Windsurf, Kiro, Antigravity, Qwen Code, …), then either copy a printed snippet or let DevsMind write/merge the config file for you. `devsmind rule` also asks which **workflow style** you want — **Automatic** (default: the agent stages, commits, and tracks every edit without being asked) or **Manual** (search/read stays always-on, but the agent only stages/commits when you explicitly ask it to — you stay the one deciding what reaches the graph). Either way it also prints a short **session kickoff prompt** to paste at the start of a fresh chat.

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

**Paste this at the start of every session**, no matter which workflow style your project uses — the strictest, shortest version of the nudge above:

> Before doing anything else: fully read and follow this project's DevsMind rule — no exceptions, no shortcuts, not even for a small edit.
> Call `start_session` before your first write and carry its `session_id` on every DevsMind write this conversation, or nothing gets recorded.

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
| `devsmind view` | Open the DevsMind app — Chat (your work by day, whole-file diffs, revert a whole request with a backup) and Graph (click a node for its change history and a revert button; ego-graph, filters, works offline) |
| `devsmind activity [--since <days>]` | Your local activity timeline in the terminal (read-only — revert stays on the page) |
| `devsmind diff <node_id>` | Red/green of what the agent changed in one function/class, with the reasoning it recorded |
| `devsmind revert <node_id>` | Undo that entity's most recent recorded edit, and erase it from history — permanent, single-entity. See Activity for a reversible, whole-request revert |
| `devsmind analyze [--fix]` | Zero-AI local health check (god entities, cycles, orphans, dangling edges, dupes, stale attribution…) — `--fix` auto-applies only the safe/reversible fixes |
| `devsmind prune` | Interactive review + permanent delete of nodes/history |
| `devsmind workflow` | Interactive view of multi-day feature workflows |
| `devsmind workflow-import <path>` | Import existing flow docs as resumable workflows |

---

## 🔌 MCP tools, grouped by purpose

DevsMind exposes 35 tools to the agent. The ones you'll see referenced most:

| Group | Tools |
|---|---|
| **Session (call before your first write)** | `start_session` — mints a `session_id`. Every **write** requires it; read-only tools don't, so an agent can search from its very first call. Every response echoes the id back so it survives a long or compacted conversation |
| **Search/discovery** | `search_nodes` — one call covering the graph **and** a real grep of every repo; takes a natural-language `query` and/or `pattern` (a real regex, used exactly as you'd give grep). `list_nodes` enumerates a component or directory, paged |
| **Read code/history** | `get_node_code` — the one node-read call. Code, metadata, imports, named callers **and** callees, a file outline, and recent reasoning, all included by default; `graph_depth`/`graph_direction` walk further for a blast radius or a whole call flow, and `history:"full"` returns every revision with diffs. `get_activity_log` answers "what changed recently / which files did we touch" |
| **Write (the important one)** | `edit_node` — edits any file, traces what changed, and **returns the red/green diff of what it changed** so you see it in the session — all in one call. `stage_change` covers what it can't (non-TS/JS languages). `commit_changes` flushes everything staged and takes the one `reasoning` (why/goal) that gets recorded against all of it. |
| **Maintenance** | `analyze_graph` (zero-token health check), `recheck_graph`, `rename_node`/`deprecate_node`, and the feedback loop: `read_graph_feedback` → fix → `mark_graph_feedback_processed` |
| **Multi-day workflows** | `workflow_create`, `workflow_bind` (per session, local to you), `workflow_list`, `workflow_get_context`, `workflow_add_step`, `workflow_sync`, `workflow_archive`, `workflow_import` |

Full descriptions and token-cost notes: see [detailExplanation.md § MCP Tool Reference](detailExplanation.md#-mcp-tool-reference).

---

## 🗄️ Storage model, briefly

```
.devmind/
  config.json   ← project + repo config          (committed)
  .env          ← your machine's local paths      (gitignored)
  brain.db      ← SQLite metadata cache           (gitignored, rebuilt from JSON on start)
  *_scratchpad.json ← in-progress index / staged edits (gitignored)
  local/        ← your activity log + revert backups (gitignored, never rebuilt from anything else)
  history/      ← code snapshots + reasoning      (committed, one JSON per entry)
  graph/        ← node/connection structure       (committed, one JSON per file)
  vectors/      ← semantic embeddings             (committed, from `devsmind embed`)
  workflows/    ← multi-day feature timelines      (committed)
```

`devsmind init` writes `.devmind/.gitignore` covering every gitignored entry above, and repairs it on each re-run so an older brain can't leave something exposed — appending rather than rewriting, so your own lines survive.

The JSON files are the source of truth (git-mergeable); `brain.db` is a disposable local cache rebuilt from them on startup. `local/` is the one exception — nothing regenerates it, since your request history and revert backups exist only there. Full 7-table schema: see [detailExplanation.md § Database Schema](detailExplanation.md#-database-schema-devmindbraindb).

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for what shipped in each release.

---

## 📄 License

MIT — see [LICENSE](LICENSE).
