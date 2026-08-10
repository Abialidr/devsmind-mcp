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
*   **One server, one project**: `devsmind start` resolves its brain once at startup (`--path`, or auto-detected from the directory you launched it in) and every tool then serves that project — the agent never discovers, remembers, or sends a path, because `devmind_path` is dropped from every advertised tool schema. Run one server per project. (Before 3.0.0 a single server served many workspaces and each call carried its own path; that still works as an unbound fallback when no brain can be found, but it is no longer the normal mode.)
*   **Workflows that survive a context reset**: a named, backward-looking log of how one feature grew — steps carry the reasoning and the nodes they touched, so an agent picking the thread up days later reads how the code got this way instead of starting from zero. Research findings that changed no code are first-class, since nothing else records what was evaluated and rejected.
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
> devsmind rule                        # re-paste — the generated rule changes between releases
> devsmind memory                      # re-print — it carries the same contract and goes stale the same way
> devsmind skill                       # re-write — same contract again, a third surface for it
> ```
> **Run all three you use, not just the rule.** They put the same contract in different places, so refreshing one and not the others leaves your agent working from multiple versions of the truth.
>
> **3.0.0 makes this more important than any release before it**, because it *removed* tools rather than adding them. A rule or memory file written against 2.x points your agent at `workflow_pause`, `get_node_graph`, `search_decisions`, and `search_nodes`' `keywords` — none of which exist now. Nothing fails loudly; the agent just burns turns calling tools that aren't there. Check the [Changelog](#changelog) after each upgrade — some releases need this, some don't.

The MCP connection, the workspace rule, the memory prompt, and the skill file are all **per-developer, per-tool** — they live in your IDE/CLI's own config files on your machine and are **not** committed to git. So every teammate runs `devsmind mcp`, `devsmind rule`, and whichever of `devsmind memory`/`devsmind skill` their tool supports, once on their own machine, even when the brain itself is already set up.

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
#    This is what actually teaches your agent to USE DevsMind — which tools to
#    call and when. Without it the server is connected but your agent won't know
#    to use it. (The rule still prints DEVMIND_PATH for reference, but a bound
#    server resolves its own brain — the agent never sends a path.)
devsmind rule

# 4. (Optional) Print a "remember this" prompt to paste into your AI chat — a
#    different lever from the rule file above (see why below). Writes nothing
#    to disk. Safe to skip; the rule alone is enough. Skipped automatically
#    (with an explanation) for a tool with no real background-memory feature.
devsmind memory

# 5. (Optional) Write the workflow contract as an explicitly-invokable skill
#    file (.agents/skills/devsmind/SKILL.md) — a single file, `/devsmind` (or
#    `$devsmind` for Codex) to re-assert the contract mid-conversation. Worth
#    running especially for the tools step 4 skipped, since this works
#    regardless of whether a tool has a background-memory feature at all.
devsmind skill

# 6. Start the MCP server. Run from the folder containing .devmind (or pass
#    --path <devmind_path>). Skip this if you connected via stdio in step 2 —
#    then your IDE launches the server itself.
devsmind start

# 7. (Optional, recommended) Index your codebase so the graph actually has
#    content to look up. This is the one step unique to a NEW project. It's
#    skippable — you can instead let the graph "grow as you go" as your agent
#    records changes — but until the code is indexed (or enough organic usage
#    has accumulated) there's little for the agent to query yet.
devsmind index --run --provider gemini --key YOUR_GEMINI_KEY
#    (see the `index` / `reindex` reference below for providers, flags, and the
#     zero-setup grow-as-you-go alternative)

# 8. Commit .devmind/ so your team shares the same brain.
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

# 5. (Optional) Print the "remember this" prompt again (see why below).
#    Nothing to sync here — it never wrote anything in the first place.
devsmind memory

# 6. (Optional) Re-run the skill file too — same reasoning as the memory
#    step above. Idempotent: regenerates the same content every time.
devsmind skill

# 7. Sync the committed graph/ + history/ JSONs into your local brain.db.
#    Especially important for stdio setups (VS Code and most CLI tools): the
#    editor spawns the server itself and only loads the graph once per process,
#    so after every `git pull` run this to pick up teammates' changes.
devsmind sync

# 8. Start the server (skip if you connected via stdio — the IDE runs it).
devsmind start
```

That's the whole loop. For what each step actually does under the hood — `init`'s full prompt flow, `mcp`/`rule`/`sync`/`memory`/`skill` in depth, every `index`/`reindex` flag, provider setup, and benchmarks — see the sections below.

---

## 🔌 Adding DevsMind to your IDE / CLI: `devsmind mcp`, `devsmind rule`, `devsmind memory` & `devsmind skill`

These four commands solve four genuinely different problems, and it helps to understand *why* there are four instead of one:

1. **`devsmind mcp` — can your agent even reach the tools?** Connecting the MCP server is what makes `search_nodes`, `get_node_code`, `edit_node`, and every other DevsMind tool *exist* from your agent's point of view. Skip this and DevsMind is just files sitting on disk — nothing in your IDE or CLI knows they're there to query at all. This is pure capability, wired up per tool since every one of them expects the server in a different config file, key, and shape. As of this release, connecting also gets you a second, related surface for free: the server declares the MCP `prompts` capability and answers `prompts/list`/`prompts/get` with one static prompt, `devsmind-workflow`, carrying the exact same contract text sent automatically at connect. Any client that supports the capability (Claude Code, Cursor, Windsurf, Kiro, Qwen so far) can invoke it explicitly mid-conversation, the same way a slash command would — no extra setup, no CLI flag, it's just there once `devsmind mcp` is done.
2. **`devsmind rule` — does your agent know it should use them?** Being *connectable* isn't the same as being *used*. Without the workspace rule, an agent with DevsMind fully wired up will often still default to grep and raw file reads out of habit, because nothing told it DevsMind exists or why it matters more than what it already knows how to do. The rule is what actually changes behavior — it's where DevsMind explains the team-brain framing, the consequence of skipping `commit_changes`, and exactly which tool to reach for and when. As of **3.0.0** it also asks which **workflow style** you want: **Automatic** (the original default — stages, commits, and tracks every edit without being asked) or **Manual** (search/read tools like `search_nodes`/`get_node_code` stay always-on, since that part is never optional, but the agent never stages or commits on its own — only when you explicitly ask it to). You're the owner of this project's graph; which style fits depends on whether you want DevsMind quietly building the team's shared context as you go, or only when you say so. `session_id` and `message` stay required either way — that's the MCP protocol layer, not a style choice, so Manual mode doesn't make those optional, it just changes whether the agent *decides on its own* to reach for `commit_changes`. Every run also prints a short **session kickoff prompt** — a separate block meant to be pasted at the start of a fresh chat (not baked into the rule file itself) so a new conversation commits to the rule immediately instead of drifting into it over the first few turns.
3. **`devsmind memory` — want the reminder to persist in a tool's own memory, without re-pasting the rule?** As of **4.0.0** this writes nothing to disk — it prints ONE natural-language block framed as an explicit "remember this" ask, and you paste it into your AI chat yourself. That's because research across every tool DevsMind integrates with found the same thing independently, several tools saying so in their own docs: background/agent-written memory is discretionary by design, while an EXPLICIT in-chat request is what actually gets saved reliably. Not every tool has a background-memory concept to ask anything of in the first place, though — Antigravity (IDE + CLI), Codex, and Kiro don't, so for those four `devsmind memory` skips the prompt entirely and prints a short explanation pointing at `devsmind skill` instead. For the five that do (Claude Code, Cursor, VS Code, Windsurf, Qwen), `--tool <id>` changes both the framing line (which feature name to call out) and a short tool-specific hint on how that tool's memory actually gets saved (e.g. Cursor's only saves once the agent explicitly proposes it and you approve) — the full contract underneath never varies.
4. **`devsmind skill` — want one file that works the same way regardless of whether a tool has memory at all?** New this release. Writes a single file, `.agents/skills/devsmind/SKILL.md`, holding the same contract as an explicitly-invokable command (`/devsmind`, or `$devsmind` for Codex) instead of something a tool decides on its own whether to recall. One file, one location — no per-tool variants. Confirmed discoverable today by Antigravity, Antigravity CLI, and Codex; Claude Code and Cursor are documented to read the same `.agents/skills/` convention and may pick it up too. Complementary to `devsmind memory`, not a replacement for it — worth running for the four tools memory skips, and harmless to also run for the other five.

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

**`devsmind memory`** — beyond the rule file, some IDEs/CLIs have their own persistent, agent-managed memory store — a place the agent itself writes a lesson to once and reads back automatically in every future session, no re-pasting required. This is a *different* mechanism per tool, under genuinely different names (Claude Code's "Auto Memory," Cursor's "Memories," Windsurf's "Cascade Memories," Qwen's "Auto-Memory," …), and DevsMind never writes into any of them directly — some are backed by an undocumented database, gated behind manual approval, or explicitly documented as internal, regenerated state a manual edit would just get overwritten by. Instead `devsmind memory` prints ONE natural-language block, framed as an explicit "remember this" ask, and you paste it into your AI chat yourself — research across every tool found the same thing independently: background/agent-written memory is discretionary by design, while an EXPLICIT in-chat request is what actually gets saved reliably.

Not every tool has a background-memory concept to ask anything of in the first place, though. `devsmind memory` checks that first (`registry.ts`'s `hasRealMechanism`) and only prints the ask where there's something for it to attach to:

```bash
devsmind memory
```

| Tool | Feature | `devsmind memory --tool <id>` |
|---|---|---|
| Claude Code | Auto Memory | Tailored "remember this" prompt — Auto Memory saves reliably from exactly this kind of explicit in-chat request |
| Cursor | Memories | Tailored prompt, with a hint that the agent must explicitly *propose* the memory — Cursor only saves once you approve what it proposes |
| VS Code (Copilot) | Copilot Memory | Tailored prompt — Copilot Memory builds up from repeated real usage rather than one instant save, so this is the first strong signal, not a guarantee |
| Windsurf (Cascade) | Cascade Memories | Tailored prompt, with a hint that the agent should explicitly state it's *creating* a Cascade Memory, not just acknowledging the request |
| Qwen Code CLI | Auto-Memory | Tailored prompt, with a hint that Qwen's own docs call auto-memory best-effort (`QWEN.md`, already handled by `devsmind rule`, is the guaranteed fallback) |
| Google Antigravity (IDE + CLI) | Skills (`/learn`) | No real background-memory mechanism — its only persistence is Skills. Prints a short explanation and points at `devsmind skill` |
| Codex CLI | Skills | Same — its human-authored surface is Skills, not memory. Its *other* store, `~/.codex/memories/`, is generated state its own docs warn against hand-editing, and stays untouched either way. Points at `devsmind skill` |
| Kiro | Knowledge / PR-comment learning | No real background-memory mechanism — Knowledge is explicit-command-only (JSON + embeddings, not file-based) and steering is static. Points at `devsmind skill` |

For the last three rows, `devsmind memory` never prints a dead-end prompt that would just get acknowledged and dropped — it explains why there's nothing to ask and points at the alternative that works for any of them regardless of memory support:

```bash
devsmind skill
```

Writes ONE file, `.agents/skills/devsmind/SKILL.md`, holding the same contract as an explicitly-invokable command instead of something a tool decides on its own whether to recall — `/devsmind`, or `$devsmind` for Codex. Confirmed discoverable today by Antigravity, Antigravity CLI, and Codex; Claude Code and Cursor are documented to read the same `.agents/skills/` convention too. `-p/--path` and `--print` work the same as `rule`/`mcp`.

### 🧪 How much of this table is actually verified

Worth being precise, because "supported" can mean two very different things:

| Level | Tools | What it means |
|---|---|---|
| **Used in anger** | Antigravity, Claude Code | Run day-to-day against real projects. Behavior observed, not inferred. |
| **Config verified** | Cursor, VS Code, Windsurf, Kiro, Codex, Qwen Code, Antigravity CLI | Automated tests confirm DevsMind writes a well-formed config — right file, right shape, merged without clobbering existing entries — for every target × scope × transport. Whether the tool then *reads* it, and how the agent behaves afterwards, is untested. |

The gap between those rows is the interesting one. A test can prove we produced valid JSON at `.cursor/mcp.json`; it cannot prove Cursor loads it, that the agent notices the rule, or that it still reaches for `search_nodes` forty turns into a session instead of drifting back to grep. That second question is the one that decides whether DevsMind is useful, and it can only be answered by someone using the tool.

**If you work in one of the "config verified" tools, a report is worth more than a bug report** — there is currently no data at all. Useful to know: did the server connect? Does the agent search before grepping, and does it keep doing so late in a long session? Does it commit on its own, or only when asked? Benchmarks against a raw agent on the same task are especially welcome. [Open an issue](https://github.com/Abialidr/devsmind-mcp/issues) with your tool and version — including "it just worked", which is also a result.

**`devsmind memory --print [--tool <id>]`** skips the interactive tool picker and prints immediately — for reading the prompt (or the skip message) without the picker, diffing it against something you already pasted, or piping it from a script. It's also what a non-TTY run does automatically, so `devsmind memory > memory.md` works rather than erroring. `--tool` takes any of the 9 registered ids; without it, it defaults to `claude-code`'s framing and says so rather than picking silently. `devsmind skill --print` is the same escape hatch for the skill file — prints the resolved path and contents instead of writing.

---

## 📇 Command Reference: `index` & `reindex`

Both commands extract code entities ("nodes") via an LLM, resolve connections between them ("edges") via local AST analysis, and then describe the nodes so they are actually findable. **`index` is for the first full pass over a codebase; `reindex` is for keeping an already-indexed graph in sync afterward.** They share most flags.

**Three phases, and the third is the one people don't expect:**

| Phase | What it does | Cost |
|---|---|---|
| **1** | Extract nodes + code snapshots | LLM — but only for *ambiguous* symbols; exported ones auto-accept for free |
| **2** | Resolve connections between them | **Free** — local AST, never an LLM call |
| **3** | Write a natural-language `description` per node | LLM, reusing Phase 1's already-resolved credentials |

Phase 1 and Phase 2 never write a description — `upsertNode` on this path doesn't pass one, so every node they create starts out exactly like a pre-requirement backlog node. That matters more than it sounds: `description` is a weighted field in `search_nodes`' BM25 index *and* the text its vector layer embeds. An index that "finished" without Phase 3 can only be found by identifier, path, reasoning text, or grep — ask it a plain-English question and it returns nothing, while reporting complete.

So **Phase 3 is mandatory on a full run** (neither `--nodes-only` nor `--edges-only`) and runs automatically; passing `--describe` there is accepted but changes nothing. It is opt-in only on `--nodes-only`, which exists precisely to be a fast structure-only pass, and rejected up front with `--edges-only`, which resolves no credentials and creates no nodes to describe.

> You can also index via in-chat agent tools (`index_start`/`index_checkpoint`/`index_continue`/`index_complete`) instead of the CLI — but that burns your IDE chat's own token budget for every file, which gets expensive fast on anything beyond a small repo. The CLI (`--run`) does the same extraction in the background for free (aside from your own LLM API key usage) and is the recommended path for a full/initial index.
>
> Neither of these is *required* upfront — see [Growing the graph outside of `index`/`reindex`](#growing-the-graph-outside-of-indexreindex) below for the zero-setup "grow-as-you-go" mode. But until the graph actually covers your codebase (via one of these commands, or enough organic grow-as-you-go usage), it's mostly not useful to your AI agent yet — there's nothing to look up.

### `devsmind index --run`

Full/initial indexing. Must be run with `--run`, otherwise it just prints instructions for in-chat indexing instead.

```bash
devsmind index --run --provider gemini --model gemini-2.5-flash --key YOUR_API_KEY
```

| Flag | Description |
|---|---|
| `-p, --path <devmind_path>` | Path to `.devmind` (default: `.devmind` in cwd) |
| `--run` | **Required** to actually start indexing |
| `--provider <provider>` | `gemini` (default) \| `vertex` \| `ollama` |
| `--model <name>` | Model id (default per provider — see [Providers & Performance](#providers--performance) below) |
| `--key <api_key>` | API key or service account JSON path (overrides `GEMINI_API_KEY` / `GOOGLE_APPLICATION_CREDENTIALS`) |
| `--url <url>` | Ollama server endpoint (default `http://localhost:11434`) |
| `--chunk-size <lines>` | ⚠️ *Accepted but does nothing.* Extraction is per-candidate (AST-enumerated) rather than whole-file-to-an-LLM, so chunking no longer applies. Passing it prints a warning instead of failing, so an existing script keeps running |
| `--chunk-overlap <lines>` | ⚠️ *Accepted but does nothing* — same reason |
| `--rpm <number>` | Max LLM requests per minute, paced proactively (default: **unthrottled** — fires back-to-back, relies on 429 retry/backoff) |
| `--from-scratch` | Wipes ALL nodes, connections, history, and `graph/`/`history/` folders, then reindexes from zero. Prompts for confirmation unless `--yes` is passed |
| `--nodes-only` | Only run Phase 1 (node extraction). No connections touched, and no descriptions unless you add `--describe` |
| `--edges-only` | Only run Phase 2 (connection resolution). Wipes and rebuilds connections across all current nodes. Requires nodes to already exist |
| `--describe` | **Only meaningful with `--nodes-only`** — also run Phase 3 right after that structure-only extraction, using the same credentials, so the run is searchable immediately instead of needing a separate `devsmind describe` later. On a full run Phase 3 is already mandatory and this flag does nothing; with `--edges-only` it is rejected outright |
| `--describe-batch-size <number>` | Nodes described per LLM call during Phase 3 (default `25`) |
| `--repos <names>` | Comma-separated repo names to restrict the run to (standalone mode only) |
| `--yes` | Skip the confirmation prompt for `--from-scratch` |
| `--local-edges` | *Deprecated, no-op.* Connections are always resolved locally via AST now |

**Valid / invalid combinations** (enforced in code, not just convention):
*   ❌ `--nodes-only` + `--edges-only` together — mutually exclusive, omit both for a full run.
*   ❌ `--from-scratch` + `--edges-only` together — nothing to build edges from after a full wipe. Use `--from-scratch --nodes-only`, then `--edges-only` as a separate follow-up run.
*   ❌ `--repos` + `--from-scratch` together — `--from-scratch` wipes the entire graph, so per-repo scoping doesn't apply.
*   ❌ `--describe` + `--edges-only` together — edges-only resolves no credentials and creates no nodes, so Phase 3 would have nothing valid to run against.
*   ✅ `--repos` composes fine with `--nodes-only` or `--edges-only` (e.g. rebuild edges for just one repo), and with a full run's mandatory Phase 3.
*   ✅ `--describe` on a full run is accepted but redundant — Phase 3 already runs.

```bash
devsmind index --run --provider ollama --model qwen2.5-coder
devsmind index --run --provider gemini --key YOUR_KEY --nodes-only
devsmind index --run --provider gemini --key YOUR_KEY --nodes-only --describe   # structure + searchable
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
| `--chunk-size <lines>` / `--chunk-overlap <lines>` | ⚠️ *Accepted but do nothing*, same as `index`. If large files are timing out, this is **not** the lever — lower `--rpm` or switch model |
| `--rpm <number>` | Same as `index` — unthrottled by default |
| `--fill-gaps` | Gap-fill mode — see below |
| `--local-edges` | *Deprecated, no-op* |

There is no `--from-scratch` / `--nodes-only` / `--edges-only` / `--repos` on `reindex` — those are `index`-only.

**Two selection modes:**

*   **Default (no flags beyond provider/key):** diffs file modification times against the graph's `last_reindex_at` cursor. Only files touched since the last successful reindex get reprocessed. Fast, but a file whose extraction fails partway through is *not* retried automatically on the next run once the cursor moves past it.
*   **`--fill-gaps`:** ignores mtimes entirely. Instead it finds every indexable file that currently has **zero nodes** in the graph (never indexed, or dropped by a prior crashed run) and backfills just those. Per-file failures are logged and skipped rather than aborting the whole run — safe to re-run repeatedly until the gap list is empty. After backfilling, it rebuilds connections across the *entire* active graph (not just the new nodes) via local AST resolution — no LLM cost — so edges pointing *into* the newly-added nodes from already-indexed files get picked up too. History and existing nodes are never touched by this rebuild.

```bash
devsmind reindex --provider vertex --model gemini-2.5-flash --key sa.json --fill-gaps --rpm 60
```

### Providers & Performance

Applies to both `index` and `reindex` — same `--provider`/`--model`/`--rpm` flags, same Phase 1 (LLM) vs Phase 2 (local AST) split.

**Supported providers (`--provider`):**

| Provider | Auth | Notes |
|---|---|---|
| `gemini` (default) | `--key` or `GEMINI_API_KEY` env var | Default model: `gemini-2.0-flash` |
| `vertex` | `--key` (service account JSON path or inline JSON, or a raw `ya29.` bearer token) or `GOOGLE_APPLICATION_CREDENTIALS` / `VERTEX_API_KEY` / `GEMINI_API_KEY`. Needs `GCP_PROJECT_ID` (or a project id embedded in the service account JSON) | Default model: `gemini-1.5-flash` |
| `ollama` | None — local server | Default model: `qwen2.5-coder`. Default endpoint `http://localhost:11434`, override with `--url` |

**Performance flags:**
*   `--local-edges` *(always on, flag is a no-op)*: connection resolution (Phase 2) runs entirely locally via the TypeScript/JavaScript AST parser (with a regex fallback for Python, Go, Java, etc.) — instant, offline, free, deterministic. Only Phase 1 (node extraction) calls the LLM.
*   `--chunk-size <lines>` / `--chunk-overlap <lines>` *(no-ops, flags accepted for back-compat)*: these mattered when a whole file went to the LLM in one call. Extraction is per-candidate now — the AST enumerates every declaration and each one is judged on its own — so file size stopped being the unit of work and there is nothing left to chunk. A big file no longer risks a truncated single response, which is what chunking existed to prevent.
*   `--rpm <number>`: opt-in throttling, and the **real** lever if a large repo is erroring out. Leave unset unless you're hitting a known provider quota or seeing 429s.

**Benchmarks** *(approximate — from informal internal testing, not a rigorous accuracy-scoring methodology; your results will vary by repo, prompt, and quota)*:

| Model | Repo size | Time | Approx. graph accuracy |
|---|---|---|---|
| `qwen2.5-coder:30b` (Ollama, local) | ~1,080 files | ~15 hours | ~50% |
| `gemini-2.5-flash` (cloud) | same repo | ~5 hours | ~90% |

Takeaway: local models avoid API cost and keep code on-machine, but for anything beyond small/medium repos a cloud flash-tier model is dramatically faster and more accurate for Phase 1 extraction. Phase 2 (edges) is local/free either way, and Phase 3 (descriptions) uses whichever provider Phase 1 already resolved. Embedding those descriptions into vectors (`devsmind embed`) is always local and free regardless of provider — on-device ONNX, no key, no network.

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
   *   `.devmind/.gitignore` — auto-created to exclude everything machine-local: `.env`, `brain.db` (+ `-journal`/`-wal`/`-shm`), `index_scratchpad.json`, `history_scratchpad.json`, and **`local/`** (your activity log, revert backups and feedback — the one entry that protects private data rather than just noise). Re-running `init` tops up a stale or missing file rather than leaving it as-is, so a brain from an older version can't silently expose something. It **appends** and never rewrites, so any lines you added yourself survive, and entries are matched the way git reads them — `local`, `/local` and `local/` count as one, not three. As a backstop for a brain nobody ever re-inits, the activity log checks the same file on its first write.
   *   `.devmind/graph/` and `.devmind/history/` — created with `.gitkeep` so Git tracks the (initially empty) directories.
   *   `.devmind/brain.db` — empty SQLite cache, initialized immediately.

### Re-running `init` (config already exists)

This is the **joining-developer / repair flow** — it never overwrites the shared `config.json`:

1. Checks `.env` for developer name/email; prompts only if missing.
2. **Embedded mode:** verifies the repo's relative path still resolves and reports any that don't (rare — embedded paths are just `.`).
3. **Standalone mode:** checks every repo's `path_key` in `.env` against the filesystem. Any repo with a missing or now-invalid local path gets prompted for a corrected absolute path; everything else in `.env` (including unrelated keys) is preserved as-is.
4. Rewrites `.env`, **repairs `.gitignore`** (tops up any entry a newer version added — `local/` in particular, which a brain predating the activity log won't have — appending rather than rewriting, so your own lines are untouched), and re-initializes `brain.db` if needed. It reports what it added, or confirms the file already covers everything.

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
*   **`devsmind skill [-p, --path <devmind_path>] [--print]`** — writes the workflow contract as an explicitly-invokable skill file, `.agents/skills/devsmind/SKILL.md` (`/devsmind`, or `$devsmind` for Codex). One file, one location, regardless of tool — no picker. `--print` (or a non-TTY run) prints the resolved path and contents instead of writing. Idempotent: content is regenerated fresh each run from the same source as `devsmind memory`'s prompt, so it never drifts from it.
*   **`devsmind view [-p, --path <devmind_path>] [-P, --port <number>]`** — opens the `devsmind view` app in your browser (see the **devsmind view** section below): Chat (your work as a timeline, per-request) and Graph, one app, no CDN dependencies.
*   **`devsmind describe [--provider <p>] [--model <name>] [--key <k>] [--url <u>] [--rpm <n>] [--batch-size <n>] [--dry-run]`** — backfills a natural-language `description` onto every node that has none. This is the field `search_nodes` weights in its BM25 ranking *and* embeds for the semantic layer, so a node without one is only reachable by identifier, path, or grep — a plain-English query will never find it. The work queue is literally "nodes where `description IS NULL`", which makes the command idempotent: re-running it is a no-op once the backlog is clear. `--dry-run` lists what's pending and needs no credentials at all. **Only for a backlog** — nodes created from here on get described at commit time, because `commit_changes` refuses a brand-new node without one. Same engine (`describePendingNodes`) that `devsmind index --run`'s Phase 3 calls, so results are identical either way; only the credential source differs.
*   **`devsmind embed [-p, --path <devmind_path>] [--batch-size <n>] [--force] [--dry-run]`** — turns those descriptions into vectors for semantic search. **Fully local**: on-device ONNX (`all-MiniLM-L6-v2`, int8), no API key, no network, nothing leaves the machine. Queue is "described nodes with a missing, stale, or wrong-model vector", so it too is safe to re-run; `--force` re-embeds everything, which is what you want after a model upgrade. If `onnxruntime-node` isn't installed it says so plainly rather than degrading silently — and search still works, just without the semantic layer.
*   **`devsmind feedback [-p, --path <devmind_path>] [--since <days>] [--all]`** — reads back what your agent reported through `commit_changes`' required `feedback` field: graph problems, product feedback, and indexer-rule candidates. Unprocessed graph entries only by default; `--all` includes ones already marked handled. Local and gitignored — this is your machine's log, never a teammate's. It's the human-facing end of the loop the `read_graph_feedback` → fix → `mark_graph_feedback_processed` tools drain.

    Two files, two audiences. `feedback_graph.jsonl` is about **your** graph and is machine-actionable — an agent drains it with the structural fixers (`record_alias`, `link_nodes`, `merge_nodes`, `split_node`, `create_missing_node`). `feedback_product.jsonl` is about **DevsMind** and is for a human: which tools helped, what the agent reached for *instead* of a DevsMind tool and why, and one concrete thing that would have made the task easier.

    That second file is worth sharing upstream. It is gitignored and there is **no telemetry anywhere in DevsMind**, so it never leaves your machine unless you send it — which also means the project has no visibility into where its tools fall short. A log of a real agent, on real code, abandoning a DevsMind tool for raw grep is a better bug report than anything a person would think to write by hand. If a pattern shows up, [open an issue](https://github.com/Abialidr/devsmind-mcp/issues).
*   **`devsmind activity [-p, --path <devmind_path>] [--since <days>]`** — the same activity timeline `devsmind view` → Chat shows, in the terminal, read-only. Grouped by day, newest first; each line is one message (a user request, or a commit's own summary when no request text was given) with its edit count and id. Revert/un-revert isn't a CLI verb — it stays on the page, next to the diff and the confirmation, rather than a bare id you'd have to look up first.
*   **`devsmind diff <node_id> [-p, --path <devmind_path>]`** — prints every recorded change to one entity as a red/green line diff, newest last, each with the `What changed:` line the agent wrote for it. Entities whose last change was recorded without a before-state say so instead of printing an empty diff — see the note under [`revert`](#-other-cli-commands) below for which those are.
*   **`devsmind revert <node_id> [-p, --path <devmind_path>] [-y, --yes]`** — restores an entity to how it looked before its **most recent** recorded edit, then erases that edit and its reasoning from history. Shows the diff and asks for confirmation first (`--yes` skips the prompt; a non-interactive shell without it exits `1` rather than acting unasked).

    Only the newest edit is revertable, and only when the entity on disk still matches what was recorded for it. Both limits are the same point: every edit after an older one was written against the code it produced, and any hand-edit since means the file has moved on — restoring a "before" in either case silently discards work that has nothing to do with the change being undone. When that happens the revert is refused and points you at git, which does this properly.

    Changes recorded before 3.0.0 (i.e. by 2.4.0 or earlier — see the changelog note about the unpublished 2.5.0), and changes recorded by the legacy `update_history` path or an initial index snapshot, have no before-state stored at all and cannot be reverted this way. There's no backfill — the information was never captured. Git still has them.

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
> 🔴🟢 **Edit trail (3.0.0)**: that same JSON also carries an `edits` array — one entry per edit, each holding the entity's code `before` and `after` it, plus `at` and the `reasoning` of the commit that produced it (one `reasoning` object per `commit_changes` call, shared by every edit that commit made — not one per edit). It lives only in the JSON, never in SQLite, exactly like `code_snapshot`. This is what `devsmind diff` renders and what `devsmind revert` restores from.
>
> It's a trail rather than a single "previous code" field *because* of the session rule above: the 1-hour window is measured from `updated_at`, so an entity edited every 50 minutes keeps sliding the same row forward and one row can span hours. A single before-field would make a revert undo the whole span instead of the last change. A gap between one edit's `after` and the next one's `before` also means someone edited the file by hand in between.
>
> Entries written before 3.0.0 have no `edits` key; it reads as `[]`, which is the honest answer — no diff, no revert. The legacy `update_history` path and an initial index snapshot supply no before-state either, so their entries read the same way.

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


### 8. Activity log (3.0.0) — `.devmind/local/`, not `brain.db`

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

DevsMind exposes **34 tools** to the AI agent, grouped below by what they're for.

> The server also declares the MCP **`prompts`** capability, a separate surface from tools — `prompts/list` returns one static prompt, `devsmind-workflow`, and `prompts/get` returns the exact same contract text sent automatically at connect (`DEVSMIND_INSTRUCTIONS`). It takes no arguments; a client that supports the capability can invoke it any time to re-assert the contract mid-conversation, the same way a slash command would. Not every client speaks `prompts` — where it isn't supported, `devsmind rule`/`devsmind memory`/`devsmind skill` remain the way to get the contract in front of the agent.

### 🚦 Category 0: Session (3.0.0)
*   `start_session`: **Call once, before your first WRITE of the conversation** (`edit_node`/`commit_changes` and the other mutating tools). Mints a `session_id` and records it locally (optionally with a `label`, shown on the Activity page). Every WRITE call REQUIRES that exact `session_id` — it ties a request's edits together on the local Activity log and makes them revertable as a unit — and every tool response echoes it back in a plain sentence so it stays in front of the agent even across a long conversation or a context compaction. Read-only tools (`search_nodes`, `get_node_code`, `list_nodes`, and the other getters) do NOT need it — search and read freely from the very first call. There is no auto-mint fallback and no server-tracked "active session" — DevsMind is stateless by design (two agents working the same project never collide over a shared "current" id), so the session token lives entirely in the conversation and must be carried explicitly. Resuming a conversation that already called `start_session` earlier should reuse that same id rather than minting a new one.

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

### ⚙️ Category 3: Code Indexing (rebuilt in 4.0.0)
*   `index_start`: Scans all configured repos, creates a scratchpad, and extracts the first batch of nodes **itself** — locally, deterministically, via AST, no LLM. Returns that batch's nodes (with their code) needing a description.
*   `index_checkpoint`: A zero-argument progress read — files done/total, phase, described/undescribed counts. The server owns progress now, so there's nothing left for the AI to report.
*   `index_continue`: Extracts the next batch, and re-serves any still-undescribed nodes from earlier batches so a description is never silently dropped. Call again after a context reset — the server tracks exactly where extraction left off.
*   `index_complete`: Once every file is extracted, resolves connections across the **whole** graph in one resumable pass (never per-batch — a node from an early batch can be the target of one from a much later batch), then fills any used-but-unextracted references and vacuums the DB.

The AI's only job anywhere in this flow is writing descriptions, via `add_description` — one call per batch. No code is ever sent back to the server; it already has it.

### ✍️ Category 4: Writes & Mutations
*   `edit_node`: **The write path to use — not the IDE's own edit/write tool — for every edit and every new file.** One call — `file_path` + `old_string` + `new_string`, exactly like an ordinary edit tool — never refuses a file type, and never rejects for being the wrong extension. Under the hood it works out WHERE the text landed and which function/class that spot belongs to (by position, not by name — so it survives the symbol being renamed by the very edit that touched it, and correctly identifies code that didn't exist until this write). No `node_id` to look up, no `code_snapshot` to send back, for any TS/JS/JSX/TSX/Vue/Svelte file. It also hands back every CALLER of what you just changed (i.e. what you may have just broken) and the reasoning previously recorded against it. To create a file that doesn't exist yet, pass `old_string: ""` and the whole file as `new_string` — every symbol in it gets traced the same way. Writes landing outside any function (markup, config, an import line, a stylesheet) get no graph node — a normal, expected outcome, not a failure, since the graph only models code — but the whole-file before/after is still staged for the local activity log, so `commit_changes` makes even a CSS/JSON/XML/etc change individually revertable in `devsmind view` → Chat, the same as a traced code edit. Nothing reaches the graph — or the activity log — until `commit_changes`, which is also where you give the one `reasoning` covering everything staged since the last commit.
*   `stage_change`: **Catches up when a file already got edited WITHOUT `edit_node`** — your own editor's edit/write tool got used by mistake, or you're recording work from before this session. Same shape as `edit_node` — `file_path` + `old_string` + `new_string` (+ `replace_all`/`description`) — but it never writes to the file: `new_string` is expected to already be sitting on disk, and `old_string` (what the code looked like BEFORE) is used only to reconstruct history and a diff, the exact reverse of what `edit_node` searches for. It traces and stages exactly like `edit_node` would have, had it been called at the time — same caller/callee info back, same `commit_changes` step needed afterward. Fails clearly (`new_string` not found) if the edit never actually happened, so it can't silently record the wrong span. **Removed in 4.0.0, reinstated after** — the old shape (hand-fed `node_id`/`code_snapshot`) really was fully covered by `edit_node`'s tracing, and that removal stands; this is a different tool solving a different problem: `edit_node` can't retroactively record a write it didn't make. Prefer `edit_node` for every edit going forward — `stage_change` exists only to recover one it missed, never as a second way to make one.
*   `commit_changes`: Flushes the whole staged buffer in one pass — creates/updates every node, writes every history snapshot with the ONE `reasoning` given on this call, then resolves all connections between them (and into the existing graph) via local AST, auto-creating any referenced-but-missing target nodes. Because all nodes exist before edges are resolved, calls between the changed files link correctly regardless of staging order. If this session is bound to a workflow, this also auto-records one step on its timeline from that reasoning, carrying the `node_ids` it touched and the `session_id` that recorded it — see `workflow_add_step` below. **Must be called at least once per staged batch**, or nothing is written to the graph. `edit_node` only stages — it needs `commit_changes` too. `message` AND `reasoning` are **REQUIRED** — validated before any write happens, so a call rejected for a missing field leaves the staged batch untouched and the AI can just retry with it. `message` is the user's original request, verbatim, feeding the local Activity log (`devsmind view` → Chat, see below) together with the conversation's `session_id` (from `start_session`, carried automatically) — grouping consecutive commits for the same request into one entry, never reaching the shared graph. `reasoning` (`what_changed`/`why`/`goal`, plus optional `requirement`/`previous_state`/`decision`/`developer`/`model`) is the one object recorded against EVERY node this commit touches — a commit is one logical change, so it gets one why, not one per `edit_node` call.
*   `rename_node`: Re-keys a node identifier and updates all associated records (connections and history) seamlessly.
*   `deprecate_node`: Marks a code node as deprecated, removing its connection mappings while retaining its coding snapshots and reasoning logs in the database.

> The former `add_node` / `add_connection` tools are removed — nodes and edges are now created automatically by `edit_node` + `commit_changes`, so the AI never hand-manages edges. `update_history` (the old single-node write) and `search_code` (now folded into `search_nodes`'s automatic fallback) still work if called directly for backward compatibility, but neither is advertised to the AI anymore. `edit_node` can't write inside `.devmind/` itself (DevsMind's own config/database) — only inside your configured repos. To force a graph resync with no real code change, run `devsmind reindex` instead (`edit_node` requires `old_string` to actually differ from `new_string`, so it can't express a no-op).

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

You commit `.devmind/config.json` plus the JSON trees — `graph/`, `history/`, `vectors/`, `workflows/` — and the whole team shares one brain. **`brain.db` is *not* committed**: it's a disposable local cache, gitignored, rebuilt from those JSONs by `devsmind sync` (or on server start). Sharing a SQLite binary would conflict on every merge; sharing line-oriented JSON does not.

Nor is `local/` — your requests, your revert backups, your feedback. That stays on your machine by design.

`commit_changes` (the AI's step below) and a real `git commit` (yours) are two different, separate things that happen to share the word "commit" — the AI's call writes only into `.devmind/`'s local graph/database, never git; the actual `git commit -am`/`git push` step is **you**, the developer, deciding to commit and share, same as on any project without DevsMind:

```
       Developer A                                         Developer B
   ───────────────────                                 ───────────────────
   Adds expired-coupon validation                      Pulls latest code
   AI records it via commit_changes                    AI inspects applyPromoCode
   YOU run `git commit -am "add validator"`             Instantly sees validation logic,
   YOU run `git push`  ───► [Shared Remote Git] ──────► why it was added, and ticket ID!
```

---

## Changelog

### 4.1.0 — MCP Prompts, one skill file, memory that skips what can't remember, and stage_change is back

No breaking changes — nothing removed, nothing renamed except a dead, never-read registry field. Worth re-running `devsmind memory` if you use Antigravity, Antigravity CLI, Codex, or Kiro: it now tells you plainly there's nothing to ask those tools to remember, instead of printing a prompt that would just get acknowledged and dropped. Worth re-running `devsmind rule`/`devsmind memory`/`devsmind skill` either way, to pick up `stage_change`.

#### The server never declared the MCP `prompts` capability, even though it's been sitting there fully supported

Three ways to get DevsMind's workflow contract in front of an agent existed before this release: the workspace rule (`devsmind rule`, always loaded), the memory prompt (`devsmind memory`, pasted once), and the connect-time `instructions` string every MCP client already receives on handshake. What was missing was a way to re-assert that same contract *explicitly*, mid-conversation, the way a slash command does — without re-pasting anything. The installed SDK (`1.29.0`, newer than `package.json`'s declared `^1.0.1`) already ships the full `prompts` capability — `ListPromptsRequestSchema`/`GetPromptRequestSchema`, `prompts/list`/`prompts/get` — DevsMind's server just never declared it. It does now: `capabilities: { tools: {}, prompts: {} }`, with one static prompt, `devsmind-workflow`, whose `prompts/get` response is the exact same `DEVSMIND_INSTRUCTIONS` string already sent at connect and reused by `devsmind memory`'s prompt — a fourth consumer of one already-single-source-of-truth constant, not a new one to keep in sync. No arguments, no registry change, no CLI change — it's live the moment a client that supports the capability connects via the existing `devsmind mcp`. Claude Code, Cursor, Windsurf, Kiro, and Qwen are the tools researched to implement `prompts` well; a client that doesn't simply never calls `prompts/list` and nothing changes for it.

#### `devsmind memory` printed the same prompt for a tool with nothing to attach it to

Research across all 9 integrated tools that shaped the original print-only design in 4.0.0 also turned up a fact that design didn't yet act on: Antigravity (IDE + CLI), Codex, and Kiro don't have a genuine background-memory concept at all — their only real persistence mechanisms are Rules and Skills. Printing the same "remember this" ask for them anyway meant it just got acknowledged in the conversation and dropped, with nothing actually saved anywhere — indistinguishable from success until someone checked. `registry.ts` already had a dead field for this distinction, `memory.supported`, computed and never read by anything live. It's now `memory.hasRealMechanism`, and `handleMemory` branches on it: `false` (those three tools, four ids counting Antigravity's two surfaces) skips straight to a short explanation and a pointer at `devsmind skill`; `true` (the other five — Claude Code, Cursor, VS Code, Windsurf, Qwen) prints the prompt as before, now with a new `askHint` field — a short, AI-voiced line inserted directly into the pasted prompt describing how *that specific tool's* memory actually gets saved (Cursor's, for instance, needs the agent to explicitly propose the memory before it can be approved — silently "remembering" it saves nothing). The full contract underneath, `DEVSMIND_INSTRUCTIONS`, is unchanged either way; only the lead-in varies.

#### A dead skill-file writer got revived as its own command

`registry.ts` already defined exactly where a shared skill file should live — `AGENTS_SKILL_SCOPE`/`skillMdWrap`, pointing at `.agents/skills/devsmind/SKILL.md` — left over from before `devsmind memory` went print-only in 4.0.0, when it was still one of several write targets. `memory-topics.ts`'s `renderCombined()` already produced exactly the content such a file would need — the same 15 topics flattened into one document, also unused since that switch. Rather than leaving both dead, `devsmind skill` is a new, standalone command that reuses them as-is: one file, one location, no per-tool variants, no picker. It gives every tool an explicitly-invokable command (`/devsmind`, or `$devsmind` for Codex) as a lever independent of whether that tool has any memory concept to lean on — confirmed discoverable today by Antigravity, Antigravity CLI, and Codex, and Claude Code/Cursor are documented to read the same `.agents/skills/` convention and may pick it up too. `-p/--path` and `--print` mirror `rule`/`mcp`'s existing conventions; `mergeRuleFile`'s existing `standalone` write path handles the actual write, so this needed no new write primitive anywhere.

#### `stage_change` is back — recovering a write `edit_node` never saw, not a second way to make one

4.0.0 removed `stage_change` because its old shape — a hand-fed `node_id`/`code_snapshot`/`type` the AI had to work out and supply itself — was fully subsumed by `edit_node`'s automatic tracing. That reasoning still holds; nothing about it changed. What surfaced afterward is a gap neither tool ever covered: an AI's own editor sometimes makes an edit through its native edit/write tool instead of `edit_node` — a habit slip, a tool picked automatically by the IDE, a change made before DevsMind was even connected — and once that happens there was no way to get it into the graph at all. The code was on disk; DevsMind had no record of it, and no path to acquire one. `edit_node` can't help retroactively, since it performs a write itself.

`stage_change` fills exactly that gap, with a shape that looks identical to `edit_node` at a glance but means something different underneath. Same parameters — `file_path`, `old_string`, `new_string`, `replace_all`, `description` — but `old_string`/`new_string` swap roles: `new_string` is what must already be found on disk (it gets *located*, never written), and `old_string` is what the code looked like before, supplied only to reconstruct history and a diff. `locateAppliedEdit()` (`utils/edit.ts`) is the new read-only mirror of `replaceTextInFile()` that makes this possible — same EOL-tolerant matching, same single-occurrence-unless-`replace_all` rule, same "was not found" and "matches more than one place" errors, just searching for what the edit left behind instead of what it's about to remove. Its result feeds the exact same `findTouchedSymbols` → `stageEntry` → `commit_changes` path `edit_node` already uses, so there was no second staging pipeline to build — only a different way of arriving at the `ranges`/`before` pair that pipeline needs. If `new_string` isn't found, it fails clearly and says so (`stage_change records an edit that has ALREADY landed on disk`) rather than staging nothing silently or, worse, staging the wrong span.

The workspace rule, the memory prompt, and the skill file all mention it now, framed consistently as recovery rather than an alternative: `edit_node` stays the one tool to reach for while making an edit; `stage_change` is what to call afterward, only when a file already changed some other way.

#### Fix: nothing ever told the AI that `commit_changes` isn't git

A teammate reported an agent running an actual `git add`/`git commit` immediately after calling `commit_changes` — unprompted, without being asked to touch git at all. The implementation was never in question: `commit_changes` has no shell-out, no git command anywhere in it, and only ever writes into `.devmind/`'s own local graph/database and activity log. The gap was entirely in what the AI was ever told. `commit_changes` takes a required `message` param described as "the user's original request, verbatim" — which reads exactly like a commit message would — and nowhere in `DEVSMIND_INSTRUCTIONS`, the generated rule, or the memory topics was there ever a sentence saying the two "commit"s are unrelated. An agent that treats the tool name at face value, or that has its own habitual "wrap up with a git commit" behavior, has every reason to either run a real git commit right after (what got reported) or, just as bad the other way, assume `commit_changes` already covered the real git commit and skip one that should have happened.

Fixed by saying it explicitly, everywhere the contract lives: a new numbered point in `DEVSMIND_INSTRUCTIONS` (`commit_changes is NOT git and never touches it... never run git add/git commit/git push on your own initiative just because commit_changes succeeded`), the same language appended to the `commit_changes` tool's own schema description (so it's visible even to an agent that only ever reads tool schemas, not the rule), a new point in `devsmind rule` for both Automatic and Manual workflow styles, and an expanded `devsmind-commit-changes-contract` memory topic. The Git Collaboration Workflow diagram just above (a human-facing doc, not part of what the AI reads) had the same ambiguity in a smaller way — `git commit -am`/`git push` sat unlabeled right after "AI updates history," with nothing marking whose step that actually is — now both lines read **YOU**.

### 4.0.1 — Global MCP configs stop pinning every project to one brain

A patch release: nothing removed, nothing renamed. Re-run `devsmind mcp` for any tool you registered with **global** scope — the config it wrote before this release has one specific project's path baked into a file every project reads, and needs to be regenerated.

#### A global config named one project, and every project read it

`devsmind mcp` asks where to write an editor's MCP config: **this project only**, or **global (all your projects)**. Before this release it wrote the same stdio entry either way:

```
devsmind start --stdio --path C:\projectA\.devmind
```

In a project-scoped file that's correct — the file itself lives inside one project and only that project's editor ever reads it. In a global file it's a mistake with no error to signal it. A global config is ONE file, read by every project on the machine. Baking project A's absolute path into it meant that opening project B or C and asking the AI to record a change wrote into **project A's graph** instead. Nothing failed. Nothing looked wrong in the moment.

It was also uncorrectable by the AI in the room when it happened. A server that already knows which brain it's bound to — via `--path`, or via cwd auto-detect — strips `devmind_path` out of every tool's advertised schema, on purpose: that's the whole point of binding, an AI shouldn't have to discover, remember, or resend a path on every call. But that means an AI working against a mis-pinned global config can't see the parameter it would need to point itself at the right project, even if it somehow suspected something was off.

The fix removes the assumption that a global config needs a path at all. Without `--path`, the server's own `bindServerToProject` walks up from wherever it was started, looking for a `.devmind` directory — the same auto-detect that's always powered the case where you start the HTTP server yourself, standing inside your project. A stdio server is normally launched by the editor with the open workspace as its working directory, so a global entry with no path binds to whichever project is actually open, correctly, every time, from one shared file. `stdioEntry` now takes the chosen scope and only appends `--path` for `project`; the four transport-specific entry builders (`entryUrl`/`entryTyped`/`entryServerUrl`/`entryHttpUrl`) all thread it through unchanged.

That auto-detect has one real assumption behind it: the editor spawns the server from the workspace it has open. Most do. One that doesn't (spawns from its own install directory, or the user's home) leaves the server unbound, falling back to the older per-call `devmind_path` behavior — degraded, but never silently wrong, which is the property that matters. `devsmind mcp` now says this out loud the moment global scope is picked, with separate wording for the two transports: stdio gets the auto-detect explanation above; HTTP gets a reminder that it was never affected by this bug in the first place — a global HTTP entry is just `http://localhost:4513/mcp`, and the one thing that decides which project answers on that port is whichever directory you ran `devsmind start` in, a fact scope can't change. Both notes also appear in the manual (copy-paste snippet) flow, not just the automatic-write one.

The other side of the fix is making the auto-detect debuggable, which it never was. `bindServerToProject` used to log only when it found nothing. It now logs its result either way, to stderr (stdout is the JSON-RPC pipe in stdio mode) — the folder it started in and the brain it bound to. That single line is what turns "why is my AI reading the wrong project" from a support conversation into something visible in the first few lines of output.

#### The view app 404'd on any install path with a dot-directory in it

`devsmind view` serves its JS/CSS assets and vendored graph libraries (`three.min.js`, `force-graph.min.js`) with Express's `res.sendFile`, which was being called with a full absolute path — `path.join(ASSETS_DIR, req.params.file)`. The library underneath, `send`, dotfile-checks *every segment* of an absolute path it's given and refuses the whole request if any segment starts with a dot, as a path-traversal guard. That's a reasonable check on a path a caller constructed from user input. It is nonsense here — `req.params.file` was already whitelisted against a fixed set of filenames a few lines above — but `send` has no way to know that, and an npm global install under `nvm` looks exactly like `/home/x/.nvm/versions/node/v22/lib/node_modules/devsmind-mcp/...`, dot-segment included. Anyone who installed DevsMind under `nvm` — which is most Linux/macOS Node setups — got a blank view app and a `NotFoundError` in the logs, with no code of theirs at fault. The fix is the standard way around this: pass `send`/`sendFile` a `root` option and the bare basename instead of a joined path. `root` confines the lookup to one directory (costing nothing, since the basename was already whitelisted) and the dotfile check has nothing left to trip on, since only the final segment is ever considered.

#### `--stdio --path` silently truncated any project path containing a space

Node itself warns about this one (`DEP0190`): a child process spawned with `shell: true` and an argv array gets that array **concatenated without quoting** before the shell parses it. Several MCP clients spawn stdio servers exactly that way. So a registered entry like

```
{ command: 'devsmind', args: ['start', '--stdio', '--path', 'C:\\work 2\\devsmind\\.devmind'] }
```

does not reach `devsmind` as four distinct arguments — it reaches the shell as one concatenated string, which then re-splits on whitespace like any other shell command. `--path` picks up only `C:\work`, and `2\devsmind\.devmind` lands among the leftover positional operands, which nothing was reading. The server then fails with "devmind_path does not exist" for a directory that was never moved — the message just names the wrong problem, so anyone hitting it went looking for a missing folder instead of a parsing bug. `--stdio` alone worked, which is what made this so easy to misattribute to something project-specific rather than universal to any path with a space in it.

The fix is `recoverSpaceSplitPath`, wired in right after Commander parses argv and before anything else reads `opts.path`. It only has commander's own leftover operands to work with — `cmd.args` — so it rejoins them onto the truncated `opts.path` with the spaces the shell ate, trying the longest reconstruction first and falling back to shorter ones. Critically, it only ever returns a candidate that **actually exists on disk**; a `--path` that's wrong for a real reason (typo, deleted folder) still fails loudly instead of being "corrected" into some other existing directory that happens to share a prefix.

A second, more robust fix rides alongside it: `bindServerToProject` now also accepts a `DEVSMIND_PATH` environment variable. An MCP config's `env` block reaches the child process as a real environment variable, never touched by shell re-splitting regardless of how the client spawns the process — so it sidesteps the whole class of bug rather than working around one instance of it. And for whoever still hits the error some other way, the message itself now checks for whitespace in the failed path and, if found, names the actual cause and points at `DEVSMIND_PATH` as the fix, instead of leaving the search for a "missing" directory to the reader.

### 4.0.0 — One write path, a server-driven indexer, and memory that writes nothing

A breaking release: a tool was removed and the in-chat indexing protocol changed shape. Re-run `devsmind rule` after upgrading — a rule written against an older version still tells your agent to call `stage_change`, which no longer exists.

#### `stage_change` is gone; `edit_node` is now the only write path

`stage_change` and `edit_node` used to split the write path two ways: `edit_node` *discovered* what changed by tracing where a write landed, `stage_change` was *told* — the AI supplied `node_id`/`type`/`code_snapshot` by hand for code it hadn't just written through `edit_node`. That split earned its keep once, but DevsMind's own README has said "TypeScript / JavaScript projects only, for now" since before this release, and `edit_node`'s tracing already covers every one of those files. There was no longer a real capability gap for a second tool to fill — only in-chat indexing still depended on the "told" shape, and that got rebuilt (below) so it no longer does either. Every rule, memory topic, and instruction block that used to explain when to reach for which tool now just says `edit_node`.

The one genuine capability `stage_change` had that `edit_node` structurally can't (forcing a graph resync with no real code change — `edit_node` requires `old_string` to actually differ from `new_string`) is now `devsmind reindex`'s job: incremental parsing of modified/new files.

#### In-chat indexing now parses locally; the AI only writes descriptions

The old protocol made the AI read every file, extract every entity itself, and send each one's full source back through `stage_change` — code crossing the wire twice, with LLM-guessed structure. `index_start`/`index_continue` now extract structure themselves, deterministically, via the same local AST machinery the CLI's `devsmind index --run` already used (`enumerateFileCandidates`) — no LLM, so nothing is silently missed. Nodes are written straight to the graph as they're found; the AI's only remaining job is writing a 1-3 sentence description for each one, through the existing `add_description` tool (which now also accepts an optional `type`, to upgrade the AST's generic `function`/`class` to a framework-specific role like `nest_service` when the AI recognizes one). Connections still resolve once, over the whole graph, in `index_complete` — never per-batch, since a node from an early batch can be the target of one from a much later batch. `index_checkpoint` is a zero-argument progress read now; the server owns progress, so there's nothing left for the AI to report.

#### `devsmind memory` stops writing files, for every tool, not just the unsupported ones

3.0.1 taught `devsmind memory` to skip tools with no safe write target and explain why. 4.0.0 goes further: it doesn't write anywhere, for any tool. The reason is empirical, not aesthetic. Research across every tool DevsMind integrates with turned up the same result independently — stated outright in more than one tool's own docs (Qwen: *"auto-memory is best-effort, QWEN.md is guaranteed"*) — that background, automatically-written memory is discretionary by design, while an EXPLICIT in-chat "remember this" request is the one thing that reliably gets saved. A file `devsmind memory` writes on your behalf never crosses that trigger at all. So the command now prints ONE natural-language block, framed as that explicit ask, for you to paste into any AI chat — `--tool <id>` only changes which feature name gets called out in the framing line (Claude Code's "Auto Memory", Cursor's "Memories", …); the prompt itself is identical everywhere, because there's no longer a per-tool file format to differ over.

### 3.0.1 — `get_activity_log` answers on a fresh clone, and Codex gets seeded like Antigravity

A patch release: nothing removed, nothing renamed, no schema anyone was relying on changed shape. Re-running `devsmind memory` is worth it if you use Codex, because it now has somewhere to write.

#### `get_activity_log` was answering from one store, and it was the wrong one for everybody else

The local activity log is gitignored on purpose. It holds the verbatim text of what you asked for and a full before/after backup of every edit — neither belongs in a shared repo, and the gitignore is the feature, not an oversight.

What nobody traced was the consequence for the person *reading*. `get_activity_log` read that store and only that store. So a teammate who cloned the repo, or you on a second machine, asked "what changed here lately?" and got back `{ total_messages: 0, entries: [] }` — while `.devmind/history/` had been recording exactly that information the whole time, committed and pulled and sitting right there. Empty is the worst answer it could have given. It doesn't read as "I looked in the wrong place"; it reads as "nothing happened."

The fix is a `source` param that **defaults to `auto`**: read local, and fall through to committed history only when local produced nothing. A fresh clone gets a real answer instead of silence.

`auto` alone doesn't finish the job, though, and it's worth being explicit about why `both` also exists. The moment you have any local activity of your own, `auto` stops at the first non-empty store — so it never consults shared history, and you still never see a teammate's work. `both` is the honest team-wide view: your own entries at full fidelity, plus shared history for every commit that didn't happen on this machine. `local` and `graph` force one store when you want to be sure which you're looking at.

**Reconstructing a commit from per-node history.** History is stored one row per node, but a commit is not a node — so the entries have to be regrouped. `commitStagedChanges` hands a single `reasoning` object to every node in the batch, so all of them come back carrying a byte-identical formatted block. That text is the commit's identity.

`session_id` looks like the obvious discriminator and is deliberately *not* part of the key. The 1-hour merge rule writes a later block into an existing history row and keeps that row's **original** session id. So within one commit, a node whose row already existed reports the session that created it, while a node getting a fresh row reports the current one — key on session and you split one real commit into two. That is a strictly worse error than the one it would prevent.

What actually separates two commits that share reasoning text is time. Blocks from a single commit are stamped inside a synchronous per-node loop, milliseconds apart; a genuine repeat of the same text is a separate editing act minutes or hours later. So grouping cuts on the gap between **consecutive** blocks, never on total span — which means a slow many-node commit stays intact however long it ran end to end. The irreducible ambiguity is two sessions committing identical reasoning within the same minute; the shared record genuinely cannot tell those apart, and nothing here pretends otherwise.

**Saying what the shared view can't tell you.** A graph-backed response carries a `caveats` array. `status` is always `applied`, because revert state is a local-log concept and claiming anything else would be invention. `request` is the reasoning's `Requirement` field rather than what you actually typed, because the verbatim ask is never committed. Whole-file edits that traced to no graph node are absent. These travel *with* the data because callers act on it — reverting, attributing, scoping a test pass — and a silently thinner entry reads as an authoritative one.

**De-duplication in `both`, and why it takes two signals.** Every commit made on this machine exists in both stores, so the merge has to drop one copy or double-count all of your own work. Session id is the first check. It is not sufficient: because the merge can file a teammate's block under one of *your* session ids, session alone would classify their work as yours and hide it — which is precisely the failure `both` exists to fix. The `Developer` field is written per block and survives the merge intact, so it settles the disagreement. When the two signals conflict, the entry is kept. Showing your own work twice is visible and harmless; dropping someone else's is not.

**A capped result was indistinguishable from a complete one.** `total_messages` was computed after `limit` was applied, so asking for 10 out of 50 matches answered `10` with nothing to indicate more existed. `total_matched` now reports the true pre-`limit` count — the same honesty contract `nodes_total` and `getHistoryPage().total` already keep elsewhere — on both stores.

#### Codex gets seeded automatically, and it turned out to be a smaller change than expected

Codex was marked unsupported for `devsmind memory`, and the reasoning was sound as far as it went: `~/.codex/memories/` is generated state, its own docs warn against hand-editing it, and a background consolidation job rewrites it. Writing there would be undone. That is still true and that directory is still never touched — there's a test that fails if any memory scope ever resolves into it.

The mistake was stopping there. Codex has a second store, and unlike the first it is human-authored by design: skills, discovered by scanning `.agents/skills/` for a `SKILL.md`. That is **the same path Antigravity already writes**. So supporting Codex was less a new integration than pointing a third target at a file that already existed — and anyone who had run `devsmind memory` for Antigravity already had a Codex-discoverable skill sitting in their repo without knowing it.

Antigravity, Antigravity CLI and Codex now share one scope and one frontmatter wrapper. That sharing is load-bearing rather than tidy: these writes are whole-file, so per-tool wrappers would mean seeding for one tool silently rewrote the file the other two read, with the last command run winning. Identical bytes make the collision a no-op instead, and a test asserts all three render the same thing.

No new flags, no new commands. Same picker, same preview, same confirmation — the goal was parity with Antigravity, not a second and larger interface.

One thing worth knowing rather than acting on: a skill loads only when the task matches its description, while `AGENTS.md` is read every turn. `devsmind rule` already targets `AGENTS.md` for Codex, so both halves exist; the command now says to run both.

#### `devsmind memory` stops rewriting files that are already correct

Re-running it walked the whole preview-and-confirm flow to write bytes identical to what was already on disk. It now compares first and reports that it's up to date. That matters more than it sounds now that two tools share one file: seeding Antigravity genuinely does finish the job for Codex, and the command should be able to say so instead of making you confirm a no-op.

It deliberately does not short-circuit on the pointer file. Claude Code's topic files load only on demand, via the index block in `MEMORY.md` — current topic files with a missing index is a broken install, not a finished one, and reporting "already seeded" there would hide the single thing that makes them findable. A corrupted-marker merge is excluded for the same reason: it returns the file unchanged, which would otherwise read as a match and swallow the error.

### 3.0.0 — Workflows rebuilt around sessions, search that survives one turn, no more `devmind_path`

**If you are upgrading, you are almost certainly coming from 2.4.0** — that is the last version that actually went to npm. A 2.5.0 was prepared and never published, so everything in it ships here: the rebuilt `devsmind view` app, the activity log with revert, explicit sessions, and the two rule workflow styles. Those are written up under [Also in 3.0.0](#also-in-300--a-new-view-app-an-activity-log-with-revert-explicit-sessions-two-rule-styles) further down. One jump covers the lot.

A major rather than a minor, for a plain reason: tools were **removed**. `workflow_pause`/`resume`/`search`/`get_steps`/`add_artifact`/`read_artifact`/`sync_retroactive` are gone, `get_node_graph` and `get_node_history` folded into `get_node_code` as parameters, `search_nodes` lost `keywords` and `is_regex`, and `list_nodes` answers an object where it used to answer a bare array. Re-run `devsmind rule` **and** `devsmind memory` after upgrading — an agent working from the old rule will confidently call tools that no longer exist.

**Workflows were designed before sessions existed, and it showed.** "Which workflow is active" was a *single project-wide pointer*, serialized into the committed `workflow.json` and restored on sync. That isn't awkwardness, it's a correctness bug: two sessions shared one pointer, so session B calling `workflow_resume` silently paused session A's workflow mid-work, and A's next `commit_changes` wrote its step onto **B's** timeline. No error, nothing to notice. And because the pointer travelled through git, a teammate could do it to you from another machine.

The fix is to stop storing the thing at all. Binding is now per session and lives in gitignored `.devmind/local/` — a bookmark belongs to the reader, not the book, and one book with one bookmark means two readers fight over it. "What was I last working on" is derived (the newest session carrying a `workflow_id`) rather than recorded, and "is this workflow active" simply stops existing as state: it's whether some session is bound right now.

Two other things were quietly wrong. A step stored `history_ids`, which **cannot identify a commit** — `updateHistory` merges any two commits on the same node within an hour into a single row and returns the pre-existing id, so a step's ids could point at rows an earlier commit created, and one row could be cited by several steps. Steps now carry their own `reasoning` plus the `node_ids` they touched. Copying the reasoning rather than joining to it is deliberate: history reasoning *mutates* afterwards (the hourly merge appends, a revert can drop a block), and a record of what we thought at the time can't read from a moving target. Separately, `commit_changes` never passed `session_id` when creating a step — the column existed and sat null on the path that creates nearly every step.

`status: active/paused/completed` is replaced by `archived`. Nothing ever completed and nobody marked it, so the field lied; threads sort by last-touched so live work floats up on its own, and archiving claims only what it delivers — hide this from the list, reversibly. `pending_tasks` is gone with no replacement: a "what's left" note goes stale the moment it's written, and a *wrong* one is worse than none, because an agent will act on it confidently.

Research became a first-class step, which is the part that actually justifies the feature. Development already leaves a recoverable trail — git has the diff, node history has the per-node reasoning. Research leaves nothing: nobody can reconstruct "we evaluated three options and rejected two" from the code that survived. So `workflow_add_step` takes a finding with no code change at all, plus the documents behind it as `doc_paths` — **paths, not copies**. The old `workflow_add_artifact` duplicated whole files into `.devmind/workflows/<id>/artifacts/`, which goes stale the moment the original changes; your repo already versions and shares the original. A path outside every configured repo is rejected, since a file only you can see is useless to a teammate.

`workflow_sync_retroactive` was the one tool that didn't do what its name said — it read no activity log, no history, no transcript; the agent hand-assembled a `steps` array from its own context and the tool wrote it down. `workflow_sync` now reads your local activity log, previews what it would attach, and writes only on `confirm:true`. Dedupe is by consumed edit id rather than a per-message flag, because a message keeps growing after it's tagged — a boolean would permanently strand everything added later, while edit ids make a re-run a true no-op and still let a grown message contribute a delta. This is also why no drift detection was built: asking an agent to notice "this task isn't related anymore" gets it wrong in both directions, and retroactive fixing being cheap is what makes getting it wrong in the moment acceptable.

One migration detail worth stating plainly. New columns are added on the next brain open via the same guarded `ALTER TABLE` pattern already used elsewhere, and old steps are backfilled by resolving their `history_ids` to the nodes those rows belong to — but because of that same one-hour merge, **a backfilled node list can be broader than what the step really touched**. Steps written from now on are exact. And a teammate on an older build can no longer destroy the new data: each workflow is written as two files, `workflow.json` in the shape a pre-3.0 client understands plus `v2.json` holding what that shape has no field for. `devsmind sync` re-serializes `workflow.json` from local columns, so an un-upgraded machine that pulled and synced *would* have rewritten the file without the new fields and committed that loss — it has no idea the sidecar exists, so it can't touch it, and the next read merges everything back.

**Indexing stopped asking a model to find your code.** The old extractor handed a whole file's source to the LLM with *"analyze the source code file provided and extract all code structures… Return ONLY a valid JSON object"* — one prompt carrying two jobs that are nothing alike: **finding** every declaration, and **judging** which ones deserve to be nodes. Only the second needs a model. The first is a parse, and delegating it fails in the worst available way — a function the model happened to overlook simply never became a node, and nothing anywhere recorded that something was missed. You'd find out months later when a search came back empty.

Extraction is now deterministic-first. `enumerateFileCandidates` walks the AST and finds every declaration; **existence is never delegated**. Candidates then split on a signal that requires no judgment at all: anything **exported** is part of the file's public surface by definition, so it is auto-accepted with **zero LLM turns**. On a typical file that is most of them, and plenty of files never reach the model.

What's left is the genuinely ambiguous remainder — an unexported helper, an anonymous default export, a three-line inline callback — where "is this its own thing?" really is a judgment call. Those go to a **tool-calling agent** (`curateAmbiguousCandidates`) that returns one of four decisions per candidate: keep, drop, merge into a sibling, or rename to something more meaningful. It can call `get_file_imports` mid-decision when the file's dependencies would settle the question, and it has to call `submit_decisions` to finish, so a model that wanders off doesn't quietly produce a half-answer.

Two failure modes are handled deliberately, both biased the same direction. A candidate the model never mentions defaults to **keep**, and if the turn budget runs out before `submit_decisions`, *every* undecided candidate defaults to keep. Over-including a node is visible and fixable with `merge_nodes` or `deprecate_node`; silently dropping a real one leaves no trace to notice. Everything reaching this stage already exists in the AST, so "keep" is never a fabrication.

This is also the reason `--chunk-size`/`--chunk-overlap` became no-ops. Chunking existed to stop a large file blowing past the context limit of a single whole-file call — once the unit of work became one candidate rather than one file, there was nothing left to chunk.

**Oversized responses used to dead-end.** A large `search_nodes` result could exceed the client's inline limit, spill to a file, and then have *that* file truncate on read — leaving nothing usable at all, which is worse than a small answer. Results are now trimmed in two tiers: first the bulk carrying no signal (per-file `match_counts`, `matched_terms`, `aliases`, repeated boilerplate, thinned sample lines), and only if that isn't enough, the evidence lines themselves. A `compacted` field always states which happened and **every count stays exact**, so a trimmed result can never read as a complete one. Compaction also *skips* the AST symbol-annotation pass rather than computing it and throwing it away, and responses are no longer pretty-printed — indentation was 20-30% of the payload, and MCP clients parse rather than read it.

`list_nodes` had no bound of any kind, which is precisely backwards for an enumeration tool: the reason you call it is that you don't know how many there are. On a real backend one unfiltered call returned ~600KB across ~10,900 lines. It's paged now, with `total` as the true match count and a `hint` naming the exact next call. `get_node_code`'s embedded `graph_code` budget dropped to 24000 characters (it rides along with code, imports, neighbors and history rather than being the whole payload), and when it runs out the dropped nodes are named **by id** rather than left to a positional cursor — the walk is re-derived per call and the cut-off depends on file contents, so an index would silently skip or repeat nodes.

**Your configured file exclusions never worked.** `ignored_paths` was only ever checked against *directories*, so every file listed in it was silently searched anyway — and that was the common case, not an edge one: `devsmind init`'s own preset list is entirely file names, and `.gitignore` import passes literal file names straight through. Users had excluded these, watched them keep appearing in every result, and had no way to tell the setting was being dropped on the floor. Lockfiles and build artifacts are now excluded by default too, so a repo predating `init` still gets clean results — a lockfile names every dependency in the tree, so a product term matched it purely because some package was named that. Also fixed: a leading-slash `.gitignore` entry (`/dist`, `/build`) matched nothing at all, in both the search walk and the indexer.

**`search_nodes` got a real regex.** `keywords` was a pipe/comma-split list that got regex-**escaped** before matching, which silently mangled a caller's own correct regex — `item\.liked` searched for a literal backslash and never matched real code. It's replaced by `pattern`: the string is used exactly as given, the same one you'd hand `grep`. `query` became optional, making a pattern-only call a first-class precision mode that skips the semantic layers entirely (a regex has no meaning to embed). `path` scopes the walk to one folder or file; `case_insensitive`, previously accepted and silently ignored, is actually wired through. Both buckets gained true `*_total` fields so a capped page is never mistaken for "nothing more to find", and every `files` sample line reports its containing function or class when resolvable — insight a plain filesystem grep can't give. Node results also now **lead** with `confidence`/`relevance`/`found_by` instead of trailing `description`: the fields always existed, but landing behind a full sentence of prose meant they got skipped in favor of eyeballing node names, and a name that merely looks right is the easiest way to pick the wrong node.

**Several numeric params were unvalidated in ways that failed silently** — the worst kind. `graph_code_budget:"abc"` became `NaN`, and since every `spent + len > NaN` comparison is false, that meant an **unlimited** budget: the exact opposite of passing a budget. `search_nodes`' `limit:"abc"` became `NaN` too, and `slice(0, NaN)` returned an empty `files` array next to a non-zero `files_total`, indistinguishable from "grep found nothing"; a negative `offset` paged from the *end* of the ranking. Also adds a missing index on `node_connections(target_node_id)` — every "who uses X" lookup was a full table scan, once per node visited in a graph walk.

**The server binds to one project.** `devsmind start` (HTTP or `--stdio`) resolves its project once at startup — `--path`, or auto-detected from cwd — and every advertised tool schema then drops `devmind_path` entirely, so the agent never discovers, remembers, or re-sends it. Generated stdio configs bake in an absolute `--path`, because the IDE controls the spawn cwd and auto-detection alone isn't reliable there. Unbound (tests, or no `.devmind` to find) falls back to the legacy per-call behavior unchanged.

**`session_id` came off reads.** Searching and reading mutate nothing, so gating them on a session bought nothing but friction — the very first thing an agent does in a conversation is usually a search, and it used to error. Only writes require it now. `get_activity_log`'s own optional `session_id` filter is also no longer force-promoted to required by the blanket injection it used to go through.

**`commit_changes` could flush and mis-attribute another session's staged work.** The on-disk staging buffer (`history_scratchpad.json`) is shared by every session pointed at one `.devmind` directory — that's intentional, it's how two agents working the same project converge on one graph — but `commit_changes` read and cleared the **entire** buffer regardless of who staged what. A session committing its own change could silently pull in another session's still-in-progress edits, sometimes from an unrelated file or even a different repo, record them under the committing session's `reasoning`, and either way erase them from the buffer whether or not the owning session ever got to commit them itself. `stage_change` and `edit_node` had a quieter version of the same bug: the `pending_count` they report back was the raw buffer length, so it could tell a session it had more staged than it actually did, inflated by someone else's work. `add_description` could go further and write a description straight onto another session's not-yet-committed node. All four are now scoped to the calling session — a plain `commit_changes` only ever touches and clears its own staged entries (`other_sessions_pending` in the response says whether anything was left behind), `pending_count` reflects only what the caller staged, and `add_description` refuses outright, with a clear reason, when the target node belongs to someone else's still-staged work. Tools that write straight to the committed graph — `rename_node`, `deprecate_node`, `merge_nodes`, `split_node`, `link_nodes`, `record_alias`, `create_missing_node` — were never part of this bug: there is no per-session staging step for them to protect, only the one shared graph everyone is meant to converge on.

**And `devsmind -v` reports the real version.** It answered `1.0.0` from the first commit through the entire 2.x line — hardcoded next to `package.json`'s real number and never once updated. That's worse than having no version flag at all: someone filing a bug reads it and believes it, and so does whoever tries to reproduce against that release. The CLI, the MCP server's `serverInfo`, and `GET /health` all derive from `package.json` now, so there's one number and nothing left to keep in sync.

#### Also in 3.0.0 — a new view app, an activity log with revert, explicit sessions, two rule styles

This was staged as **2.5.0 and never published**, so it ships as part of 3.0.0. None of it is separately installable — 2.4.0 was the last version that actually went out, so coming from there this is a single jump, not five quiet ones.

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
