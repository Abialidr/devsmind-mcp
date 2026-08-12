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

**COMMITTED vs LOCAL is the whole storage design.** Committed is the *team's* shared brain — graph, reasoning, feature timelines. Local is either derivable (`brain.db` is a cache; delete it and `devsmind sync` rebuilds it) or genuinely personal (`local/` holds your verbatim requests and revert backups, which only mean anything on the machine that wrote them).

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
| **Workflows: how a feature grew** | A named, git-shared log of one feature across many nodes and many days. An agent resuming a week later reads how the code got this way instead of starting from zero. Each step carries the reasoning and the nodes it touched — and a step can be pure **research** ("evaluated Razorpay, no split settlements → Stripe"), which is the one thing nothing else keeps: git has the diff, history has the per-node why, neither records what you rejected. Reference docs attach as repo **paths**, not copies, so they can't go stale. Binding is per session, so two people never fight over one pointer |
| **AI-written context** | Your agent records why/goal/decision/ticket once per commit — covers everything staged since the last one |
| **Token-cheap lookups** | Agent reads one function via the graph instead of a whole file — up to ~70% fewer tokens |
| **One server, one project** | Install once globally, then `devsmind start` binds to the project it was launched in (or `--path`). The agent never discovers, remembers, or sends a brain path — it's resolved once at startup and dropped from every tool's schema. Run one per project |
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
devsmind memory    # 4. Print a prompt to paste into your AI chat, asking it to remember the workflow
devsmind skill     # 5. (optional) Write it as an explicitly-invokable /devsmind skill file too
devsmind start     # 6. Start the server (skip if your IDE launches it via stdio)
devsmind index --run --provider gemini --key YOUR_KEY   # 7. (optional) index the codebase now
git add .devmind && git commit -m "Add DevsMind brain"  # 8. share it
```

> **Step 4 is the one people skip and then wonder why the agent drifts.** A pasted rule is a file *you* maintain and it's always loaded — that part isn't optional. `devsmind memory` is a second, complementary lever: it writes nothing, it just prints a natural-language block framed as an explicit "remember this" request, because that's the one thing that actually gets an AI's own memory feature to save something reliably (background/automatic memory turns out to be discretionary almost everywhere — several tools say so in their own docs). Paste it once and ask your AI to remember it. Not every tool has a memory feature to ask that of, though — for those, `devsmind memory` says so and points at step 5's `devsmind skill` instead, which works the same regardless.

### Joining a brain a teammate already created

```bash
git pull           # 1. .devmind/ is already in the repo
devsmind init      # 2. sets up YOUR machine only (dev identity, local paths) — doesn't touch the shared graph
devsmind mcp       # 3. connect your IDE/CLI
devsmind rule      # 4. paste the workspace rule
devsmind memory    # 5. print the "remember this" prompt (see above)
devsmind skill     # 6. (optional) same idea, as an explicitly-invokable skill file (see above)
devsmind sync      # 7. load teammates' committed changes into your local cache
devsmind start     # 8. start the server (skip if stdio)
```

> `mcp`, `rule`, and `skill` are **per-machine, per-tool** — they configure your editor, not the shared brain. `memory` writes nothing at all, so there's nothing to re-run per machine there — just re-paste its output into a fresh chat whenever you want the reminder in front of your AI again. A teammate's setup never reaches you, so each of you runs `mcp`/`rule`/`skill` once.

> **Already set up, just upgrading?**
> ```bash
> npm install -g devsmind-mcp@latest
> devsmind rule     # re-paste — the generated rule changes between releases
> devsmind skill    # re-write, if you use it — same contract, goes stale the same way
> ```
>
> **This mattered most jumping to 4.0.0**, which *removed* `stage_change` (folded into `edit_node`) and changed the indexing protocol — a rule written against an older version told your agent to call a tool that no longer existed. `stage_change` is back since then, but with a different signature (it now recovers an edit already made outside `edit_node`, rather than being a second way to make one) — a rule from between 4.0.0 and now that never mentions it just won't tell your agent about the recovery path, not break anything. Check the [Changelog](CHANGELOG.md) after any upgrade — some releases need a re-paste, some don't.

> 🪝 **Optional: auto-sync after every `git pull`**
>
> Step 7 above (`devsmind sync`) is easy to forget — and a stale local cache just means your agent's `search_nodes` results are behind what teammates already committed. A git `post-merge` hook runs it automatically every time `git pull` brings in new commits.
>
> ```sh
> #!/bin/sh
> # post-merge — runs after every `git pull` / `git merge`.
> # BRAIN_DIR only needs adjusting if .devmind/ does NOT live at your repo root — devsmind
> # auto-detects .devmind by walking UP from wherever it's run, never down, so a .devmind in a
> # sibling/nested folder (a dedicated "brains" repo, a monorepo subpackage, …) needs an explicit
> # cd here (or pass --path to both commands below instead).
> BRAIN_DIR="$(git rev-parse --show-toplevel)"
>
> cd "$BRAIN_DIR" || exit 1
> devsmind analyze --fix && devsmind sync
> ```
>
> **Two ways to install it, in order of how much it's worth doing:**
> - **Quick, just for you:** save the script above as `.git/hooks/post-merge` and `chmod +x` it. Nothing to commit — `.git/hooks/` is never tracked by git, so this is per-machine only, and every teammate (and every fresh clone of yours) has to redo it by hand.
> - **Shared with the whole team:** a hooks directory doesn't have to live inside `.git/` — that's just the default. Put the script in a tracked folder instead (e.g. `.githooks/post-merge`), commit and push it like any other file, then have everyone run **once**: `git config core.hooksPath .githooks`. From then on it fires automatically for anyone who ran that command, and updating the hook is just a normal commit everyone pulls — no manual re-copying.

---

## 🔌 The four setup commands, and why there are four

| Command | Answers | Skip it and… |
|---|---|---|
| `devsmind mcp` | Can your agent *reach* the tools at all? | DevsMind tools don't exist from the agent's point of view |
| `devsmind rule` | Does your agent *know* to use them? | Agent defaults back to grep/raw file reads out of habit |
| `devsmind memory` *(optional)* | Want the reminder to persist in a tool's own memory, without re-pasting the rule? | Prints a "remember this" prompt for a tool that has real background memory to ask; explains why not otherwise |
| `devsmind skill` *(optional)* | Want an explicitly-invokable `/devsmind` command, regardless of memory support? | Writes one file, `.agents/skills/devsmind/SKILL.md`, holding the full contract |

`mcp` and `rule` are guided: pick your tool (Cursor, VS Code, Claude Code, Codex, Windsurf, Kiro, Antigravity, Qwen Code, …), then either copy a printed snippet or let DevsMind write/merge the config file for you. `devsmind rule` also asks which **workflow style** you want — **Automatic** (default: the agent stages, commits, and tracks every edit without being asked) or **Manual** (search/read stays always-on, but the agent only stages/commits when you explicitly ask it to — you stay the one deciding what reaches the graph). Either way it also prints a short **session kickoff prompt** to paste at the start of a fresh chat. `devsmind memory` asks which tool's memory feature to name in the framing line — for the 5 tools with a real memory mechanism (Claude Code, Cursor, VS Code, Windsurf, Qwen) it prints a tailored prompt; for the 4 without one (Antigravity, Antigravity CLI, Codex, Kiro) it explains there's nothing to ask and points at `devsmind skill` instead. `devsmind skill` writes the same contract as one fixed file, no picker — connecting your MCP server (`devsmind mcp`) also gets you a related, no-setup-required surface: any client that supports the MCP `prompts` capability (Claude Code, Cursor, Windsurf, Kiro, Qwen so far) can re-invoke the same contract explicitly mid-conversation.

> ### 🧪 Which tools are actually *verified* — and where you can help
>
> DevsMind has been **used and tested day-to-day in Antigravity and Claude Code**. Those two are the ones we can vouch for from real use.
>
> The other seven are built from each tool's documented config format, and automated tests confirm DevsMind writes a **well-formed** config for every one of them — the right file, the right shape, merged without clobbering anything you already had. What those tests *cannot* prove is the part that matters most: that the tool then reads it, and that the agent behaves differently afterwards. Nobody has sat in Cursor or Windsurf or Codex with this and watched what the agent actually does.
>
> **So if you use one of the unverified tools, your report is genuinely valuable** — more than a bug report, because right now there's simply no data. Useful things to check:
> - Did `devsmind mcp` land the server where your tool looks, and did the tool connect?
> - After `devsmind rule`, does the agent actually reach for `search_nodes` before grepping — and does it still, 40 turns in?
> - Does `commit_changes` get called on its own, or only when you ask?
> - How does the agent handle a tool it doesn't understand — recover, or spiral?
>
> Benchmarks against a raw agent on the same task are especially welcome. [Open an issue](https://github.com/Abialidr/devsmind-mcp/issues) with your tool, version, and what you saw — including "it just worked," which is a result too.

**`devsmind memory`** writes nothing, for any tool — where a tool has a real memory mechanism, it prints one prompt and you paste it. That's a deliberate change: DevsMind used to hand-write into each tool's own memory/skills store, but research across every tool it integrates with turned up the same result independently, several of them saying so in their own docs — background/automatic memory is discretionary by design (e.g. Qwen's docs: *"auto-memory is best-effort, QWEN.md is guaranteed"*), while an EXPLICIT in-chat "remember this" is the one thing that reliably lands. `devsmind memory --tool <id>` changes which feature name gets called out in the framing line (Claude Code's "Auto Memory", Cursor's "Memories", …) and, for the tools that have one, a short tool-specific hint on how that tool's memory actually saves — the underlying contract itself is identical either way.

Antigravity (IDE + CLI), Codex, and Kiro have no real background-memory mechanism at all — their persistence is Rules and Skills, not memory. For those, `devsmind memory --tool <id>` skips the prompt and points at **`devsmind skill`** instead: it writes the same contract as a single file, `.agents/skills/devsmind/SKILL.md`, discoverable as an explicitly-invokable command (`/devsmind`, or `$devsmind` for Codex) regardless of whether the tool has any memory concept to lean on. One file, one location — no per-tool variants, and safe to run alongside `devsmind memory` even for a tool that has real memory too.

> ⚠️ **The rule is a nudge, not a guarantee.** On long sessions agents drift back to grep and raw file reads, and quietly stop calling `search_nodes` / `commit_changes`.
>
> When you notice, just say it: *"use the DevsMind graph, then stage and commit this."* One sentence, and it's usually the highest-leverage thing you can type.
>
> **Worth saying because a skipped commit can't be backfilled.** The *code* graph is repairable after the fact — see below. The **reasoning** isn't: why a change was made, what it was weighed against, what broke before. That exists only in that conversation, in that turn. No reindex, no git log, no analyze recovers it.

> 🔧 **The graph won't be 100% right — that's expected, and fixable.**
>
> Node extraction is a judgment call, so some nodes come out too coarse, mislabeled, or missing an edge no parser could prove (dynamic dispatch, generated bindings). DevsMind is built to be corrected rather than re-indexed:
>
> - `devsmind analyze --fix` — free local health check. Finds god entities, cycles, orphans, dangling edges, duplicates; auto-applies only the safe fixes.
> - Ask your agent to fix what it hits: `record_alias` (same symbol, another name), `link_nodes` (a real edge the AST missed), `merge_nodes` / `split_node`, `create_missing_node`.
> - Every `commit_changes` also **reports** problems it noticed into `.devmind/local/feedback_graph.jsonl`. Read them back with `devsmind feedback`, or have an agent drain the queue: `read_graph_feedback` → verify → fix → `mark_graph_feedback_processed`.
>
> Nothing here needs an API key, and none of it is auto-applied behind your back.

> 💛 **And there's feedback about DevsMind itself — please share it.**
>
> The same `commit_changes` call asks your agent three questions that aren't about your graph at all: which tools actually helped, what it reached for *instead* of a DevsMind tool and why, and one concrete thing that would have made the task easier. Those land in `.devmind/local/feedback_product.jsonl`.
>
> It's **gitignored and never uploaded** — DevsMind has no telemetry, so unless you send it, nobody sees it. But it's the most useful bug report there is: a log of where a real agent, on real code, gave up on a DevsMind tool and did it the old way. Run `devsmind feedback`, and if anything in there looks like a pattern, [open an issue](https://github.com/Abialidr/devsmind-mcp/issues) with it. That's how this gets better.

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

**The LLM never has to *find* your code.** The AST enumerates every declaration; anything **exported** becomes a node with zero LLM calls. Only genuinely ambiguous leftovers — an unexported helper, an anonymous default, a small inline callback — go to an agent that decides keep / drop / merge / rename, and if it can't decide in time it keeps them. The old approach shipped the whole file to a model and asked it to "extract all code structures", which meant a function it happened to overlook just never got indexed, silently. Cheaper *and* harder to miss things.

**Common flags** (both commands): `--provider gemini|vertex|ollama` · `--model <name>` · `--key <api_key>` · `--rpm <number>` (unthrottled by default).

> `--chunk-size` / `--chunk-overlap` / `--local-edges` are still accepted but do **nothing** — extraction is per-candidate (AST-enumerated) rather than whole-file-to-an-LLM, so chunking no longer applies, and edges have been local-only for a while. Passing one prints a warning rather than failing, so an old shell script keeps working.

### The third phase: descriptions

Indexing runs in **three** phases, and the third is the one that decides whether search actually works:

| Phase | What | Cost |
|---|---|---|
| 1 | Extract nodes + code snapshots | LLM (only for *ambiguous* symbols — exported ones auto-accept for free) |
| 2 | Resolve connections | **Free** — local AST, never an LLM |
| 3 | Write a natural-language `description` per node | LLM, same credentials as Phase 1 |

Phases 1 and 2 never write a description. That matters because `search_nodes` weights `description` in its BM25 ranking and embeds it for the semantic layer — so an index that "finished" without Phase 3 can only be searched by identifier, path, and grep. Natural-language queries find nothing.

So **Phase 3 is mandatory on a full run** and happens automatically; `--describe` has no effect there. It's opt-in only on `--nodes-only` (which exists precisely to be a fast, structure-only pass), and rejected outright with `--edges-only`, which resolves no credentials and creates no nodes.

```bash
devsmind describe --provider gemini --key YOUR_KEY   # backfill a pre-existing description gap
devsmind embed                                        # then vectors — fully local, no API key
```

`describe` is for nodes that predate the requirement; anything created from now on gets described at `commit_changes`, which refuses a new node without one. `embed` turns those descriptions into vectors on-device (ONNX, `all-MiniLM-L6-v2`) — no credentials, no network. Both are idempotent: the work queue is just "what's still missing", so re-running is safe and a second run is a no-op.

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
| `devsmind describe [--provider …] [--key …] [--dry-run]` | Backfill natural-language descriptions for nodes that have none — what `search_nodes` needs to match a plain-English query. `--dry-run` lists the backlog without an API key. Safe to re-run |
| `devsmind embed [--force] [--dry-run]` | Turn those descriptions into semantic vectors, **fully local** — on-device ONNX, no credentials, no network. `--force` re-embeds everything after a model upgrade. Safe to re-run |
| `devsmind feedback [--since <days>] [--all]` | Read what your agent reported via `commit_changes` — graph problems, product feedback, indexer-rule candidates. Local, never pushed |
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
| **Read code/history** | `get_node_code` — the one node-read call. Code, metadata, imports, named callers **and** callees, a file outline, and recent reasoning, all included by default; `graph_depth`/`graph_direction` walk further for a blast radius or a whole call flow, and `history:"full"` returns every revision with diffs. `get_activity_log` answers "what changed recently / which files did we touch" — from your local log, falling back to the committed history everyone shares, so it still answers on a fresh clone (`source:"both"` to see teammates' work alongside your own) |
| **Write (the important one)** | `edit_node` — the write path to use, for every file. Edits any file, traces what changed, and **returns the red/green diff of what it changed** so you see it in the session — all in one call. `stage_change` catches up when a file already got edited WITHOUT `edit_node` — same shape, but it locates `new_string` already on disk instead of writing it. `commit_changes` flushes everything staged and takes the one `reasoning` (why/goal) that gets recorded against all of it — **not git**, despite the name: it never runs a git command, it only writes into DevsMind's own local graph. Your actual `git commit`/`git push` is still a separate step you (or your agent, if you ask it to) do yourself. |
| **Maintenance** | `analyze_graph` (zero-token health check), `recheck_graph`, `rename_node`/`deprecate_node`, and the feedback loop: `read_graph_feedback` → fix → `mark_graph_feedback_processed` |
| **Multi-day workflows** | `workflow_create`, `workflow_bind` (per session, local to you), `workflow_list`, `workflow_get_context`, `workflow_add_step`, `workflow_sync`, `workflow_archive`, `workflow_import` |

Full descriptions and token-cost notes: see [detailExplanation.md § MCP Tool Reference](detailExplanation.md#-mcp-tool-reference).

The server also declares the MCP **`prompts`** capability, separate from tools: one static prompt, `devsmind-workflow`, that returns the exact same contract text sent automatically at connect. Live the moment you connect via `devsmind mcp` — no extra setup — for any client that supports it (Claude Code, Cursor, Windsurf, Kiro, Qwen so far).

---

## 🗄️ Storage model, briefly

The layout is up top under [Architecture](#-architecture-the-devmind-directory). What matters about it:

**The JSON is the source of truth, not the database.** `graph/`, `history/`, `vectors/` and `workflows/` are line-oriented JSON — git-mergeable, reviewable in a PR. `brain.db` is a disposable local cache rebuilt from them by `devsmind sync` or on server start, which is why it's gitignored: sharing a SQLite binary would conflict on every merge.

**`local/` is the one thing nothing can regenerate.** Your requests, revert backups and feedback exist only there, on your machine, by design.

**`devsmind init` writes `.devmind/.gitignore`** covering every LOCAL entry and repairs it on each re-run, so a brain from an older version can't leave something exposed. It appends rather than rewrites, so lines you added yourself survive.

`brain.db` has 9 tables — 7 documented in [detailExplanation.md § Database Schema](detailExplanation.md#-database-schema-devmindbraindb), plus `node_tokens` and `node_vectors`, which are derived search indexes rebuilt from the nodes themselves.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for what shipped in each release.

---

## 📄 License

MIT — see [LICENSE](LICENSE).
