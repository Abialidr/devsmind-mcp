# 🧠 DevsMind — Team AI Brain

[![NPM Version](https://img.shields.io/npm/v/devsmind-mcp?color=blue)](https://www.npmjs.com/package/devsmind-mcp)
[![License](https://img.shields.io/badge/license-MIT-green)](https://github.com/Abialidr/devsmind/blob/main/LICENSE)
[![Awesome MCP](https://img.shields.io/badge/MCP-Awesome-purple)](https://modelcontextprotocol.io)

DevsMind stores code structure, change rationale, and workflow history in a project brain shared by a team. This document covers the data model, commands, MCP tools, and release rationale.
> This is the exhaustive reference doc. For a fast-path quick start, see [README.md](README.md).

<details open>
<summary><strong>📑 Index</strong></summary>

- [🚀 Key Features](#-key-features)
- [🛠️ Architecture: The `.devsmind/` Directory](#-architecture-the-devsmind-directory)
  - [Flexibility: Where should the brain live?](#flexibility-where-should-the-brain-live)
- [⚡ Quick Start](#-quick-start)
- [🔌 Adding DevsMind to your IDE / CLI](#-adding-devsmind-to-your-ide--cli-devsmind-mcp-devsmind-rule-devsmind-memory--devsmind-skill)
- [📇 Command Reference: `index` & `reindex`](#-command-reference-index--reindex)
- [🆕 `devsmind init` In Depth](#-devsmind-init-in-depth)
- [🔄 Workflows In Depth](#-workflows-in-depth)
- [🖥️ Other CLI Commands](#-other-cli-commands)
- [🗄️ Database Schema: `.devsmind/brain.db`](#-database-schema-devsmindbraindb)
- [🔌 MCP Tool Reference](#-mcp-tool-reference)
- [🎨 `devsmind view` — Chat + Graph, offline](#-devsmind-view--chat--graph-one-app-fully-offline)
- [👥 Git Collaboration Workflow](#-git-collaboration-workflow)
- [Changelog](#changelog)
- [📄 License](#-license)

</details>

---

## 🚀 Key Features

*   **Code history and rationale** - indexed declarations have relationships and change history; commits can record one rationale for all staged edits.
*   **Search** - `search_nodes` combines code entities, filesystem matches, and workflow history. BM25 and optional local vectors support natural-language discovery.
*   **Workflows** - multi-session timelines preserve implementation reasoning and research that did not change code.
*   **Team sync** - graph, history, vectors, and workflows move through the dedicated `devsmind` branch, in place and without copying files, one sync at a time; local cache and Activity data stay on the machine.
*   **Local viewer** - `devsmind view` provides graph exploration and Activity history with request-level revert.
---

## 🛠️ Architecture: The `.devsmind/` Directory

Running `devsmind init` creates a `.devsmind/` directory in your workspace. This folder contains the configuration, distributed graph database, and local cache:

> **Brains named `.devmind/` keep working — there is no migration, and none is needed.** The directory is `.devsmind/` for new brains because the older name was one letter off from `devmind-mcp`, an unrelated npm package that had it first. Only `devsmind init` on a project with **no brain yet** uses the new name. Every existing `.devmind/` brain keeps resolving, permanently. Nothing inside a brain records its own folder name (`config.json` holds repo-relative paths or `.env` repo keys, and `brain.db` is a rebuildable cache), so the same directory is valid under either name and no command exists to convert one. The single consequence worth knowing: a brain created with the `.devsmind/` name needs devsmind-mcp **4.2.0 or newer** on every teammate's machine, because older installs only look for `.devmind`.

```
.devsmind/
  ├── .gitignore              ← Written by init; ignores LOCAL and BRANCH entries
  ├── config.json             ← Project metadata & repository mapping        (COMMITTED)
  ├── graph/                  ← Distributed graph structure JSON               (BRANCH)
  │     └── [repo_name]/[path].json
  ├── history/                ← Change logs, code snapshots, reasoning         (BRANCH)
  │     └── [id].json
  ├── vectors/                ← Semantic embeddings from `devsmind embed`      (BRANCH)
  ├── workflows/              ← Feature timelines: steps + reasoning           (BRANCH)
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

**Those three labels are the whole storage design.** COMMITTED is `config.json` alone — the repo list, which travels with your code branch because a teammate needs it before a brain sync can run at all. BRANCH is the team's shared brain: the graph, the reasoning, the feature timelines, shared from one dedicated branch rather than from every branch. LOCAL is either derivable (`brain.db` is a cache; delete it and it rebuilds) or genuinely personal (`local/` holds your verbatim requests and your revert backups, which are only meaningful on the machine that wrote them).

> **Those four directories are BRANCH, not COMMITTED, which is why `.gitignore` lists them.** They still sit in `.devsmind/` on your disk and the brain still reads them from there — your working branch simply stops tracking them. Before this, they committed onto whatever branch you happened to be on: an ordinary feature PR arrived carrying thousands of graph and history files alongside a few lines of real code, and two teammates conflicted on files neither had opened. Ask your agent to sync (`devsmind_git_sync`) and it moves them to the `devsmind` branch and brings teammates' work back down.
>
> **A brain set up with an older version may still track these folders on the code branch.** Updating `.gitignore` does not untrack existing files. `devsmind_git_sync` checks for that state and repairs it; review and commit any cleanup it leaves on the code branch as indicated by the tool output.

`devsmind init` writes `.devsmind/.gitignore` covering every LOCAL and BRANCH entry, and repairs it on every re-run so a brain from an older version — or a teammate's checkout that predates an entry — can't leave something exposed. It appends rather than rewrites, so lines you added yourself survive, and it matches entries the way git reads them (`local`, `/local` and `local/` are one entry, not three). As a backstop, the activity log checks the same file on its first write, since a brain where nobody ever re-runs `init` would otherwise never pick the line up.

### Flexibility: Where should the brain live?

DevsMind supports two deployment topologies depending on your team's workflow:

*   **Option A: Inside the workspace/project root directory (Shared with team)**
    ```
    c:\work\my-project\
      ├── .devsmind\              ← Config and distributed JSON database live here
      ├── backend-service\
      └── frontend-web\
    ```
*   **Option B: Standalone folder (Fully separated)**
    ```
    c:\Users\username\brains\my-project\
      └── .devsmind\              ← Brain is kept separate from code folders
    ```

---

## ⚡ Quick Start



DevsMind is installed once per machine. The setup commands configure a developer's local tool; shared graph data moves through the `devsmind_git_sync` MCP tool.

```bash
npm install -g devsmind-mcp
```

### A) Create a brain

```bash
devsmind init
devsmind mcp
devsmind rule
devsmind skill       # optional
# Optional initial index:
devsmind index --run --provider gemini --key YOUR_GEMINI_KEY
```

Commit `.devsmind/config.json` and `.devsmind/.gitignore` on the code branch. Then ask the connected agent to run `devsmind_git_sync`; it creates or updates the shared `devsmind` branch.

`devsmind index --run` writes the brain directly, so setup has no `devsmind sync` step: there is nothing on disk to import yet.

### B) Join an existing brain

```bash
git clone <repo>     # or git pull
npm install -g devsmind-mcp
devsmind init         # configure this machine's identity and repo paths
devsmind mcp
devsmind rule
```

Then ask the connected agent to run `devsmind_git_sync` to fetch the shared brain. `devsmind sync` only imports files already on disk into the local database; it does not fetch the branch. The setup commands and their options are described below; command flags are in [Other CLI Commands](#-other-cli-commands).



## 🔌 Adding DevsMind to your IDE / CLI: `devsmind mcp`, `devsmind rule`, `devsmind memory` & `devsmind skill`



These commands solve separate setup problems and are run per developer and per tool. They write only local IDE or workspace configuration, not the shared brain.

| Command | What it does |
|---|---|
| `devsmind mcp` | Connects the IDE or CLI to the MCP server. Guided mode writes or prints the client-specific connection config. The server also exposes the `devsmind-workflow` MCP prompt where supported. |
| `devsmind rule` | Writes or prints the workspace instructions that tell the agent when to use DevsMind. Offers Automatic and Manual workflow styles and prints a session kickoff prompt. |
| `devsmind memory` | Prints a prompt for a tool's own persistent memory feature. It does not write to that feature or to disk. Tools without a suitable memory surface are directed to `devsmind skill`. |
| `devsmind skill` | Writes or prints `.agents/skills/devsmind/SKILL.md`, an explicitly invokable `/devsmind` skill (or `$devsmind` in Codex). |

`mcp`, `rule`, and `skill` support print/non-interactive flows; see [Other CLI Commands](#-other-cli-commands) for their flags. `memory` has tool-specific framing, including a guided setup reminder for Codex. Generated config tests verify file shape and merging; they do not prove that every client loads the config or that its agent follows the instructions. Refresh the files you use after upgrading when the release notes say their content changed.



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
| `-p, --path <devmind_path>` | Path to the brain directory (default: `.devsmind`, or a legacy `.devmind`, in cwd) |
| `--run` | **Required** to actually start indexing |
| `--provider <provider>` | `gemini` (default) \| `vertex` \| `ollama` \| `claude` \| `openai` \| `bedrock` \| `claude-cli` \| `codex-cli` \| `agy-cli` (see [Providers & Performance](#providers--performance)) |
| `--model <name>` | Model id (default per provider — see [Providers & Performance](#providers--performance) below) |
| `--key <api_key>` | API key or service account JSON path (overrides `GEMINI_API_KEY` / `GOOGLE_APPLICATION_CREDENTIALS`) |
| `--url <url>` | Ollama server endpoint (default `http://localhost:11434`) |
| `--rpm <number>` | Max LLM requests per minute, paced proactively (default: **unthrottled** — fires back-to-back, relies on 429 retry/backoff) |
| `--from-scratch` | Wipes ALL nodes, connections, history, and `graph/`/`history/` folders, then reindexes from zero. Prompts for confirmation unless `--yes` is passed |
| `--nodes-only` | Only run Phase 1 (node extraction). No connections touched, and no descriptions unless you add `--describe` |
| `--edges-only` | Only run Phase 2 (connection resolution). Wipes and rebuilds connections across all current nodes. Requires nodes to already exist |
| `--describe` | **Only meaningful with `--nodes-only`** — also run Phase 3 right after that structure-only extraction, using the same credentials, so the run is searchable immediately instead of needing a separate `devsmind describe` later. On a full run Phase 3 is already mandatory and this flag does nothing; with `--edges-only` it is rejected outright |
| `--describe-batch-size <number>` | Nodes described per LLM call during Phase 3 (default `25`) |
| `--repos <names>` | Comma-separated repo names to restrict the run to (standalone mode only) |
| `--yes` | Skip the confirmation prompt for `--from-scratch` |

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
| `-p, --path <devmind_path>` | Path to the brain directory (default: `.devsmind`, or a legacy `.devmind`, in cwd) |
| `--provider <provider>` | `gemini` (default) \| `vertex` \| `ollama` \| `claude` \| `openai` \| `bedrock` \| `claude-cli` \| `codex-cli` \| `agy-cli` (see [Providers & Performance](#providers--performance)) |
| `--model <name>` | Model id |
| `--key <api_key>` | API key / service account path |
| `--url <url>` | Ollama endpoint |
| `--rpm <number>` | Same as `index` — unthrottled by default |
| `--fill-gaps` | Gap-fill mode — see below |

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
| `claude` | `--key` or `ANTHROPIC_API_KEY` | Anthropic API. `anthropic` is accepted as an alias |
| `openai` | `--key` or `OPENAI_API_KEY` | For another OpenAI-compatible Chat Completions service, set `OPENAI_BASE_URL` or pass `--url`, and pass its model id with `--model` |
| `bedrock` | AWS credentials and region (for example `AWS_PROFILE`, `AWS_REGION`) | Pass a Converse-capable model or inference profile id with `--model`, or set `BEDROCK_MODEL_ID` |
| `claude-cli`, `codex-cli`, `agy-cli` | A signed-in Claude Code, Codex, or Antigravity CLI on `PATH` | Each request runs headlessly in a temporary folder outside the repository, with the prompt on stdin. `--model` overrides the CLI's default. `codex` and `agy`/`antigravity` are accepted as aliases |

**Performance flags:**
*   **Connections are always local.** Phase 2 runs entirely on this machine through the TypeScript/JavaScript AST parser (with a regex fallback for Python, Go, Java, etc.) — instant, offline, free, deterministic. Only Phase 1 (node extraction) and Phase 3 (descriptions) call the provider.
*   `--rpm <number>`: opt-in throttling, and the **real** lever if a large repo is erroring out. Leave unset unless you're hitting a known provider quota or seeing 429s.

**Benchmarks** *(approximate — from informal internal testing, not a rigorous accuracy-scoring methodology; your results will vary by repo, prompt, and quota)*:

| Model | Repo size | Time | Approx. graph accuracy |
|---|---|---|---|
| `qwen2.5-coder:30b` (Ollama, local) | ~1,080 files | ~15 hours | ~50% |
| `gemini-2.5-flash` (cloud) | same repo | ~5 hours | ~90% |

Takeaway: local models avoid API cost and keep code on-machine, but for anything beyond small/medium repos a cloud flash-tier model is dramatically faster and more accurate for Phase 1 extraction. Phase 2 (edges) is local/free either way, and Phase 3 (descriptions) uses whichever provider Phase 1 already resolved. Embedding those descriptions into vectors (`devsmind embed`) is always local and free regardless of provider — on-device ONNX, no key, no network.

---

## 🆕 `devsmind init` In Depth

`devsmind init` behaves differently depending on whether a `.devsmind/config.json` already exists in the target directory.

### First-time setup (no existing config)

1. **Project name + mode.** Prompts for a project name, then a choice between:
   *   **Embedded** — the brain lives inside the project's own repo at `<repo>/.devsmind`. Repo paths are stored as a relative path (`.`), so cloning the repo anywhere just works — no machine-specific config needed.
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
   *   `.devsmind/config.json` — project name, mode, repos, ignored paths, tech stack, environments, notes. **Committed to Git.**
   *   `.devsmind/.env` — developer name/email + (standalone mode) each repo's local absolute path. **Gitignored.**
   *   `.devsmind/.gitignore` — auto-created to exclude everything machine-local: `.env`, `brain.db` (+ `-journal`/`-wal`/`-shm`), `index_scratchpad.json`, `history_scratchpad.json`, and **`local/`** (your activity log, revert backups and feedback — the one entry that protects private data rather than just noise). Re-running `init` tops up a stale or missing file rather than leaving it as-is, so a brain from an older version can't silently expose something. It **appends** and never rewrites, so any lines you added yourself survive, and entries are matched the way git reads them — `local`, `/local` and `local/` count as one, not three. As a backstop for a brain nobody ever re-inits, the activity log checks the same file on its first write.
   *   `.devsmind/graph/` and `.devsmind/history/` — created with `.gitkeep` so Git tracks the (initially empty) directories.
   *   `.devsmind/brain.db` — empty SQLite cache, initialized immediately.

### Re-running `init` (config already exists)

This is the **joining-developer / repair flow** — it never overwrites the shared `config.json`:

1. Checks `.env` for developer name/email; prompts only if missing.
2. **Embedded mode:** verifies the repo's relative path still resolves and reports any that don't (rare — embedded paths are just `.`).
3. **Standalone mode:** checks every repo's `path_key` in `.env` against the filesystem. Any repo with a missing or now-invalid local path gets prompted for a corrected absolute path; everything else in `.env` (including unrelated keys) is preserved as-is.
4. Rewrites `.env`, **repairs `.gitignore`** (tops up any entry a newer version added — `local/` in particular, which a brain predating the activity log won't have — appending rather than rewriting, so your own lines are untouched), and re-initializes `brain.db` if needed. It reports what it added, or confirms the file already covers everything.

This is exactly what a new team member runs after `git clone`-ing a project that already has `.devsmind/config.json` committed — see [Quick Start B) Joining / resuming an existing brain](#-quick-start) above.

---

## 🔄 Workflows In Depth

> Design rationale, in full: [WORKFLOW_DESIGN.md](WORKFLOW_DESIGN.md).

A workflow is a **named, backward-looking log of how one piece of functionality grew** — across many nodes, many sessions, many days. You read it before touching something, to understand how it got this way. It is not a plan and not a task list; nothing ever "completes".

That framing matters because it settles what belongs in one. Development already leaves a recoverable trail — git has the diff, node history has the per-node reasoning. **Research leaves nothing**: nobody can reconstruct "we evaluated three options and rejected two" from the code that survived. So a workflow's job is the part nothing else keeps.

### 1. What's stored, and where

Shared with your team, committed to git under `.devsmind/workflows/<workflow_id>/`:

| | |
|---|---|
| **workflow** | `id`, `name`, `description`, `archived`, `created_at`/`updated_at` |
| **step** | `id`, `workflow_id`, `step_index`, `summary`, `reasoning`, `node_ids[]`, `doc_paths[]`, `session_id`, `created_at` |

Local to your machine, gitignored under `.devsmind/local/`:

| | |
|---|---|
| **session** | `workflow_id` — what this conversation is bound to right now |
| **message** | `workflow_sync` — which of your edits already became steps |

`brain.db` is a cache; the JSON on disk is the source of truth, so teammates receive it through `devsmind_git_sync`. **The workflow never stores your chat** — messages stay local. The shared side holds the summary, the reasoning, and which nodes were touched.

Each workflow is written as **two** files: `workflow.json` in the shape a pre-3.0 client understands, and `v2.json` holding what that shape has no field for (`archived`, per-step `reasoning`/`node_ids`/`doc_paths`). the sync code re-serializes the legacy `workflow.json` shape from local columns, so an older build that rewrites the file could omit fields kept only in `v2.json` — they have no idea the sidecar exists, so they can't touch it, and the next read merges everything back.

### 2. Binding is per session, and local

There is no project-wide "active workflow". Each session binds to at most one (`workflow_bind`), and that binding lives in `.devsmind/local/` — so it never moves, pauses, or steals anyone else's, and two sessions can work different workflows at once.

This replaced a single global pointer that was also serialized into the committed JSON. Two sessions shared it: `workflow_resume` in one silently paused the other's mid-work, and that session's next `commit_changes` wrote its step onto the **wrong** workflow, with no error — and because the pointer travelled through git, a teammate could do it to you.

"What was I last working on" isn't stored at all now; it's derived — the newest session that carries a `workflow_id`. `start_session` surfaces it only when there is one, so an ordinary session sees no friction.

### 3. Steps point at nodes, not history rows

A step used to store `history_ids`, which could not actually identify a commit: two commits touching the same node within an hour **merge into one history row**, so a step's ids could point at rows an earlier commit created, and one row could be cited by several steps. Reasoning is now copied onto the step, and the step records the `node_ids` it touched.

Copying rather than joining is deliberate. History reasoning *mutates* afterwards — the hourly merge appends to it, a revert can drop a block — and a record of "what we thought at the time" can't read from a moving target.

### 4. Documents are paths by default, with two deliberate exceptions

The old design copied whole files into `.devsmind/workflows/<id>/artifacts/`. A copy goes stale the moment the original changes, and your repo already versions and shares the original. A step stores `doc_paths` — repo-relative paths — instead. A path outside every configured repo is rejected, since it wouldn't exist for a teammate.

That reasoning holds for anything already in the repo, but not for a doc that was never a file (research pasted into the conversation) or one that genuinely has no on-repo home (a PDF, a screenshot, a spec in some other tool). `doc_content` (paste text, DevsMind writes the file) and `doc_uploads` (copy an existing file's bytes in) for exactly those two cases — see [4.3.0](#430--the-devsmind-branch-devsmind-add-repo-and-workflow_add_step-can-copy-a-doc-in). `doc_paths` is still the default; the other two exist because "never copy" turned out to be one rule too many, not because the original reasoning was wrong.

### 5. Reading a long one

`workflow_get_context` is the single read, and it is paged (`limit`/`offset`, or `last_n` for the tail, which is what catching up usually means). `steps_total` is always the true count. An oversized page is trimmed in tiers — `reasoning` goes first, then `node_ids` — with a `compacted` field naming what was dropped. Document content is never inlined; you get the path.

### 6. Fixing attribution afterwards

Nothing detects drift onto a different topic — asking an AI to notice "this isn't related anymore" gets it wrong in both directions, nagging when it shouldn't and staying silent when it should. Steps just keep attaching to whatever you're bound to, and `workflow_sync` fixes it later: it reads your local activity log, previews what it would attach, and writes only on `confirm:true`. Dedupe is by consumed edit id rather than a per-message flag, so re-running is a true no-op while a message that keeps growing can still contribute a later delta.

---


## 🖥️ Other CLI Commands

*   **`devsmind start [--stdio] [-p, --port <number>]`** — starts the MCP server. Default: HTTP on port `4513`, reachable at `http://localhost:4513/mcp`. Pass `--stdio` for IDEs that manage the server process directly instead of connecting over HTTP.
*   **`devsmind sync [-p, --path <devmind_path>] [--analyze] [--fix]`** - imports brain JSON already on disk into the local SQLite cache. It is not part of setup or indexing and does not fetch or merge the `devsmind` branch; use `devsmind_git_sync` for team sync, which also refreshes the cache. In standalone mode, it can also reconcile repo paths missing from local `.env`.
*   **`devsmind style [normal|lite|full]`** - sets the personal response style in the brain's gitignored `.env`. `on`, `off`, and `caveman` are aliases; the process environment overrides the saved value. It affects chat replies, not code or shared DevsMind content.
*   **`devsmind git-status`** - read-only counts of brain files waiting to sync.
*   **`devsmind skill [-p, --path <devmind_path>] [--print]`** - writes the workflow contract as an explicitly-invokable skill file, `.agents/skills/devsmind/SKILL.md` (`/devsmind`, or `$devsmind` for Codex). In the interactive project-only flow it asks for the actual project root before writing, matching `devsmind rule` and `devsmind mcp`; `--print` (or a non-TTY run) prints the resolved path and contents instead of writing. Idempotent: content is regenerated fresh each run from the same source as `devsmind memory`'s prompt, so it never drifts from it.
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
*   **`devsmind prune [-p, --path <devmind_path>]`** — interactive terminal tool to review node stats, inspect current code, page through chronological change history, and permanently delete individual nodes, prune every deprecated node, or clear all nodes/history. To clear out dead code, run `devsmind analyze --fix` first so only genuinely dead nodes remain deprecated, then prune.
*   **`devsmind analyze [-p, --path <devmind_path>] [--fix] [--god-entity-threshold <n>]`** - local, zero-AI health report. It checks graph structure, history metadata, tracked files without nodes, renamed files, stray output directories, and unsafe generated paths in `graph/`, `vectors/`, `history/`, and `workflows/`. `--fix` soft-deprecates nodes whose file is gone and built-in names that should not be nodes, removes dangling edges, migrates detected renames, and deletes unsafe output files or blocking directories. Node history is retained, but filesystem cleanup is permanent. Orphaned nodes (no connections) are report-only: edges exist only where a reference was resolved, so a live variable or type can legitimately have none. God entities, cycles, duplicate IDs, missing developer attribution, empty snapshots, and untracked files are also report-only.

    **One-time repair.** Older versions deprecated every orphaned node, which marked live code as dead. On such a brain, `analyze` lists a "Wrongly deprecated nodes" section: deprecated nodes whose file exists and still contains their name as a whole word. The first `--fix` restores them, before its other fixes, and records that in the brain's system metadata, so a node an agent deprecates on purpose later is never revived. Restored nodes keep their history but lost their connections and vectors when they were deprecated; `devsmind embed` rebuilds the vectors for those with a description. The name match is a plain word search, so a common name can match a file that no longer defines it.
*   **`devsmind workflow [-p, --path <devmind_path>]`** — interactive terminal view of your workflows: list them (newest-touched first, archived ones hidden until you ask), read a workflow's full timeline (steps in order, each with its reasoning, the nodes it touched, and any document paths), and archive/unarchive. Day-to-day creation and step-recording happens through the `workflow_*` MCP tools the agent calls — this is a visibility/manual-override surface, not the primary way workflows get built. There is no pause/resume here any more: binding is per session and lives on the agent side.
*   **`devsmind workflow-import <path> [-p, --path <devmind_path>]`** — imports a folder of `.md` flow/architecture docs (one workflow per file), or a single file. Expects the common `# Title` / `## Summary` structure (falls back to the filename / first paragraph if a file doesn't follow it) — the workflow gets one seed step recording where it came from, pointing at the source document by **path** rather than copying it, so it can't go stale. Re-running the import on the same file updates that workflow in place instead of duplicating it, so it's safe to re-import after the source docs change.
*   **`devsmind add-repo [-p, --path] [--provider …] [--key …] …`** *(standalone mode only)* — adds ONE repo to an existing brain (prompts for name + local path) and indexes just that repo, reusing `index --run`'s own flags/credentials for the indexing step. Resumable: an interrupted run continues automatically on the next `add-repo` call, with no re-prompt. See [4.3.0](#430--the-devsmind-branch-devsmind-add-repo-and-workflow_add_step-can-copy-a-doc-in) above.

---

## 🗄️ Database Schema: `.devsmind/brain.db`



The SQLite database is a local cache. Graph, history, vector, and workflow JSON on disk are the shared source data; `brain.db` can be rebuilt. It contains ten tables:

| Table | Purpose and key fields |
|---|---|
| `nodes` | Code entities: `id`, `type`, `name`, `file_path`, `signature`, `description`, `aliases`, `deprecated`, `created_at`. |
| `node_connections` | Directed edges: `source_node_id` uses `target_node_id`. |
| `history` | Per-node metadata: `id`, `node_id`, `session_id`, timestamps. Snapshot, reasoning, and edit details are stored in `history/<id>.json`. |
| `system_meta` | Local cache and process metadata. |
| `node_tokens` | Derived local BM25 index for node names, descriptions, paths, and reasoning. Rebuilt when its source fingerprint changes. |
| `node_vectors` | Semantic vectors keyed by node and model. Rebuilt locally by `devsmind embed`; vector JSON is also shared under `vectors/`. |
| `workflows` | Workflow identity, name, description, archive flag, and timestamps. The legacy `status` column remains for database compatibility and is unused. |
| `workflow_steps` | Ordered summaries, reasoning, touched node IDs, document paths, session ID, and timestamp. Legacy `pending_tasks` and `history_ids` columns are unused. |
| `workflow_artifacts` | Uploaded documents and inline content attached to a workflow or step. |
| `workflow_tokens` | Derived local BM25 index over workflow names, descriptions, and step text. Rebuilt when stale. |

`local/` is not a database table. It contains the machine-local Activity log and revert backups and is gitignored. The `node_tokens` and `workflow_tokens` tables are rebuildable; they are not synced. `node_vectors` has a local cache and a shared JSON representation so teammates can use embeddings without running inference themselves.

History JSON keeps the edit trail used by `devsmind diff` and `devsmind revert`. A history row may be updated within the one-hour grouping window, so workflow steps copy their reasoning and touched node IDs rather than joining to a history row whose contents can later change. Older history without an edit before-state cannot be reverted by DevsMind.



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
> **Node history is preserved by graph maintenance fixes.** They soft-deprecate stale nodes and retain history; `devsmind prune` is the explicit path for permanent node deletion. `analyze --fix` also deletes unsafe generated files and blocking directories, including invalid workflow folders, so those filesystem repairs are permanent.
---

## 🔌 MCP Tool Reference

DevsMind tools are designed with **layered granularity**. The AI only pulls the depth of data it needs, keeping token overhead minimal.

DevsMind exposes **40 tools** to the AI agent, grouped below by what they're for.

> The server also declares the MCP **`prompts`** capability, a separate surface from tools — `prompts/list` returns one static prompt, `devsmind-workflow`, and `prompts/get` returns the exact same contract text sent automatically at connect (`DEVSMIND_INSTRUCTIONS`). It takes no arguments; a client that supports the capability can invoke it any time to re-assert the contract mid-conversation, the same way a slash command would. Not every client speaks `prompts` — where it isn't supported, `devsmind rule`/`devsmind memory`/`devsmind skill` remain the way to get the contract in front of the agent.

### 🚦 Category 0: Session
*   `start_session`: Call once before graph-writing tools. It creates a `session_id` used to group edits in the local Activity log and support request-level revert. Read-only tools do not require it, and `devsmind_git_sync` and `devsmind_git_sync_status` are also exempt because they record no graph edit and do not read the ID. Responses echo a supplied session ID so it remains available across long conversations and context compaction. There is no server-side active session; resume a conversation with its existing ID.

### 🔍 Category 1: Discovery & Search
*   `list_nodes`: Enumerates nodes matching optional `type`/`file_path` filters — the "what exists here" call for a component, package, or directory, as opposed to `search_nodes`' "find the thing that does X". **Paged**: it answers `{nodes, total, offset}` where `total` is the true match count and `nodes` is one page (`limit`, default 100, max 500), with a `truncated` flag and a `hint` naming the exact next call. It previously had no bound of any kind, which on a real backend meant a single unfiltered call returned ~600KB across ~10,900 lines — past the client's inline limit, spilled to a file, and truncated again on read from there. A page that is still oversized falls back to id/name/type/file_path per node with a `compacted` note; `total` stays exact either way.
*   `search_nodes`: The one search tool to call — covers the indexed graph AND the raw filesystem in one call, so an external grep is never needed. Two independent inputs, pass either or both: `query` (a natural-language phrase, drives the semantic/BM25 layers) and `pattern` (a REAL regex, used exactly as you'd give `grep` — nothing is re-escaped or split, e.g. `heartRed|onLikeTap|item\.liked` matches exactly that). A `pattern`-only call is a first-class precision mode that skips the semantic/BM25/identifier-shortcut layers entirely (a regex has no meaning to embed), returning exact grep + code-body matches only. Optional `path` scopes the search to one folder/file instead of every configured repo (rejected if outside every repo). Returns **three buckets**: `nodes` (tagged `matched_via: "identifier" | "fuzzy" | "semantic" | "code"`, with a true `nodes_total` before the top-20 cap) and `files` (a real grep of every repo/scope, each sample line reporting the containing function/class when resolvable, with true `files_total`/`files_offset` so a capped page is never mistaken for "nothing more" — page further with `offset`/`limit`), and `workflow_steps` (past workflow step summaries and reasoning searched by BM25 in the same single pass — capped at 5 best-matching steps, each with `workflow_id`, `workflow_name`, `step_index`, `summary`, `relevance` (1–100), `matched_terms`, and `nodes_touched` — always present as `[]` when nothing matched; steps from archived workflows are excluded. Drill into any step with `workflow_get_context(workflow_id, step_index)` for the full reasoning). Optional `scope` param (`'all'` / `'nodes'` / `'files'` / `'steps'`): default `'all'` runs all three buckets in one pass at zero extra cost; `'steps'` skips the AST and grep layers entirely and returns only workflow history — the call for “when did we decide X?” historical questions; `'nodes'` or `'files'` restrict to those buckets only. Preferred over a raw grep of the filesystem, and over calling any search tool twice. Each `nodes` entry also carries `workflows: [{id, name, description}]` — every existing multi-day workflow (see Category 6) that already has a step touching this node, `description` included so the agent can judge relevance without a separate `workflow_list` call. The agent is instructed to always ask the developer before acting on it: offer to bind when a match looks relevant and nothing (or something else) is currently bound, flag it when the bound workflow differs from what a result names, or offer to unbind when the current work looks unrelated to whatever's bound.
*   `get_visualizer_url`: Returns local browser URLs for opening the interactive 2D and 3D graph visualizers.

> Search results are size-guarded. An oversized `search_nodes` response is trimmed automatically in two tiers — first the bulk-without-signal (per-file `match_counts`, `matched_terms`, `aliases`, repeated boilerplate, thinned sample lines), and only then the evidence lines themselves — with a `compacted` field always naming which happened. **Every count stays exact**, so a trimmed result can never be mistaken for a complete one. `compact:false` demands the full payload; `compact:true` asks for a lean triage list up front. Lockfiles (`package-lock.json`, `yarn.lock`, `go.sum`, …) and build artifacts (`*.min.js`, `*.map`) are excluded by default; `.env`, JSON and other config stay fully searchable, since that is exactly what the `files` bucket is for.

### 📜 Category 2: Code & History
*   `get_node_code`: **The one node-read call.** Returns a node's current source — token-efficient, since it returns only that function/class/route rather than the whole file — parsed live from disk, falling back to the last known snapshot when the symbol can no longer be located (renamed/moved/deleted, reported as `source:"cached"`). Included on **every** call at no extra cost: `name`/`type`/`signature`/`description`, the file's `imports`, up to 20 named callers **and** callees per direction (`uses_nodes`/`used_by_nodes`, with the counts always true even when capped), up to 40 other declarations from the same file (`file_outline`), the last 3 changes' reasoning (`recent_history`), and — — the same `workflows: [{id, name, description}]` field `search_nodes` carries, present whenever this node already belongs to an existing workflow. A raw file read shouldn't be needed afterwards for any of that.
    *   `graph_depth` + `graph_direction` walk the **transitive** graph past those direct neighbors, in the same call: `"in"` at depth 2-3 is the full caller blast radius before you change a signature; `"out"` at depth 3 with `graph_code:true` is a whole call flow — every function a request touches, with live source, in one round trip instead of a chain of per-function fetches. The walk is deterministic and capped at 120 nodes; `graph_code_budget` defaults to 24000 characters when riding along inside a `get_node_code` response. When the budget runs out, the dropped nodes are named **by id** in `graph.code_omitted_node_ids` — fetch exactly those, or re-issue larger. Nodes whose source genuinely couldn't be found are counted separately as `graph.nodes_no_code_available`, because raising the budget will never bring those back.
    *   `history:"full"` (default `"recent"`) returns every revision with diffable before/after edits, pageable via `history_limit`/`history_offset` — the call to make before refactoring anything with a non-trivial `history_count`.
*   `get_activity_log`: The "what changed recently" call, reading the local activity log (one entry per `commit_changes`). Filters compose: `developer`, `session_id`, `since_hours` or `since`/`until`, `requirement_contains`. Each entry carries the actual `files` that commit touched, plus an `all_files` union across every match — the graph tools know nodes, so this is the only source of a commit's full file list. Local and gitignored: this machine only, never the shared graph.

### ⚙️ Category 3: Code Indexing
*   `index_start`: Scans all configured repos, creates a scratchpad, and extracts the first batch of nodes **itself** — locally, deterministically, via AST, no LLM. Returns that batch's nodes (with their code) needing a description.
*   `index_checkpoint`: A zero-argument progress read — files done/total, phase, described/undescribed counts. The server owns progress now, so there's nothing left for the AI to report.
*   `index_continue`: Extracts the next batch, and re-serves any still-undescribed nodes from earlier batches so a description is never silently dropped. Call again after a context reset — the server tracks exactly where extraction left off.
*   `index_complete`: Once every file is extracted, resolves connections across the **whole** graph in one resumable pass (never per-batch — a node from an early batch can be the target of one from a much later batch), then fills any used-but-unextracted references and vacuums the DB.
*   `add_repo` *(standalone mode only)*: Registers ONE new repo in `config.json`/`.env`, then runs `index_start`'s own extraction, scoped to just that repo. Continue with the same `index_continue`/`index_checkpoint`/`index_complete` above, always passing the `scratchpad` value this call returns — omitting it targets the unrelated whole-workspace session instead. Resumable: a second call with no `name`/`path` reports which repo and scratchpad an interrupted session was for, rather than starting over. See [4.3.0](#430--the-devsmind-branch-devsmind-add-repo-and-workflow_add_step-can-copy-a-doc-in).

The AI's only job anywhere in this flow is writing descriptions, via `add_description` — one call per batch. No code is ever sent back to the server; it already has it.

### ✍️ Category 4: Writes & Mutations
*   `edit_node`: **The write path to use — not the IDE's own edit/write tool — for every edit and every new file.** One call — `file_path` + `old_string` + `new_string`, exactly like an ordinary edit tool — never refuses a file type, and never rejects for being the wrong extension. Under the hood it works out WHERE the text landed and which function/class that spot belongs to (by position, not by name — so it survives the symbol being renamed by the very edit that touched it, and correctly identifies code that didn't exist until this write). No `node_id` to look up, no `code_snapshot` to send back, for any TS/JS/JSX/TSX/Vue/Svelte file. It also hands back every CALLER of what you just changed (i.e. what you may have just broken) and the reasoning previously recorded against it. To create a file that doesn't exist yet, pass `old_string: ""` and the whole file as `new_string` — every symbol in it gets traced the same way. Writes landing outside any function (markup, config, an import line, a stylesheet) get no graph node — a normal, expected outcome, not a failure, since the graph only models code — but the whole-file before/after is still staged for the local activity log, so `commit_changes` makes even a CSS/JSON/XML/etc change individually revertable in `devsmind view` → Chat, the same as a traced code edit. Nothing reaches the graph — or the activity log — until `commit_changes`, which is also where you give the one `reasoning` covering everything staged since the last commit.
*   `stage_change`: **Catches up when a file already got edited WITHOUT `edit_node`** — your own editor's edit/write tool got used by mistake, or you're recording work from before this session. Same shape as `edit_node` — `file_path` + `old_string` + `new_string` (+ `replace_all`/`description`) — but it never writes to the file: `new_string` is expected to already be sitting on disk, and `old_string` (what the code looked like BEFORE) is used only to reconstruct history and a diff, the exact reverse of what `edit_node` searches for. It traces and stages exactly like `edit_node` would have, had it been called at the time — same caller/callee info back, same `commit_changes` step needed afterward. Fails clearly (`new_string` not found) if the edit never actually happened, so it can't silently record the wrong span. the old shape (hand-fed `node_id`/`code_snapshot`) really was fully covered by `edit_node`'s tracing, and that removal stands; this is a different tool solving a different problem: `edit_node` can't retroactively record a write it didn't make. Prefer `edit_node` for every edit going forward — `stage_change` exists only to recover one it missed, never as a second way to make one.
*   `commit_changes`: Flushes the whole staged buffer in one pass — creates/updates every node, writes every history snapshot with the ONE `reasoning` given on this call, then resolves all connections between them (and into the existing graph) via local AST, auto-creating any referenced-but-missing target nodes. Because all nodes exist before edges are resolved, calls between the changed files link correctly regardless of staging order. If this session is bound to a workflow, this also auto-records one step on its timeline from that reasoning, carrying the `node_ids` it touched and the `session_id` that recorded it — see `workflow_add_step` below. **Must be called at least once per staged batch**, or nothing is written to the graph. `edit_node` only stages — it needs `commit_changes` too. `message` AND `reasoning` are **REQUIRED** — validated before any write happens, so a call rejected for a missing field leaves the staged batch untouched and the AI can just retry with it. `message` is the user's original request, verbatim, feeding the local Activity log (`devsmind view` → Chat, see below) together with the conversation's `session_id` (from `start_session`, carried automatically) — grouping consecutive commits for the same request into one entry, never reaching the shared graph. `reasoning` (`what_changed`/`why`/`goal`, plus optional `requirement`/`previous_state`/`decision`/`developer`/`model`) is the one object recorded against EVERY node this commit touches — a commit is one logical change, so it gets one why, not one per `edit_node` call.
*   `rename_node`: Re-keys a node identifier and updates all associated records (connections and history) seamlessly.
*   `deprecate_node`: Marks a code node as deprecated, removing its connection mappings while retaining its coding snapshots and reasoning logs in the database.

### 🧹 Category 5: Optimization & Maintenance
*   `recheck_graph`: Scans the graph to verify file existence and deprecates language primitives, builtins, and nodes associated with missing/deleted files, retaining nodes with active histories.
*   `analyze_graph`: Runs a local, zero-token health check for graph issues and unsafe generated output. With `fix:true`, it also soft-deprecates stale nodes, removes dangling edges, migrates detected renames, and permanently removes unsafe output files or blocking directories. Other findings are report-only; see [`devsmind analyze`](#-other-cli-commands) for the categories.

### 🗂️ Category 6: Workflows
A named, backward-looking log of how one piece of functionality grew across many nodes and many sessions — read it to learn how the code got this way. Ten tools; see [Workflows In Depth](#-workflows-in-depth) above for the model behind them.
*   `workflow_create`: Names a new thread. Does not touch anyone else's session — creating one doesn't pause anything, because there is nothing global to pause.
*   `workflow_bind`: Attaches THIS session to a workflow; omit the id to detach. The binding is local to your session and to your machine. (`workflow_pause`/`workflow_resume` still answer as unadvertised aliases for detach/attach, so an agent working from a pre-3.0 rule doesn't hard-fail.)
*   `workflow_list`: Lists workflows — `limit`/`offset` page, `include_archived` opts the retired ones back in. `query` is BM25-ranked, token-based search (the same tokenizing/stemming/IDF weighting `search_nodes` uses over code, via a `workflow_tokens` index that mirrors `node_tokens` exactly — local-only, never synced, lazily rebuilt from a cheap fingerprint check) across the workflow's own `name`/`description` **and every step's `summary`/`reasoning`** — previously `query` only ever matched name/description, so a workflow's actual day-to-day substance was invisible to search. Each result may carry `matched_steps` (up to 3, best-match-first) naming the specific step(s) that caused the match. `total`/paging stay exact because one `rankWorkflows` call produces both the ranked list and its count together, the same fix `search_nodes` uses for `nodes_total`. The agent is instructed to call this before starting work that might relate to an existing thread, and to offer continuing it rather than silently starting fresh.
*   `workflow_get_context`: The one read — steps in order, each with its reasoning and the nodes it touched, plus any document paths. Paged (`limit`/`offset`/`last_n`), with `steps_total` always exact. The call to make right after binding.
*   `workflow_add_step`: Records one step. **Usually not called directly** — `commit_changes` auto-records a step from whatever it just staged whenever the session is bound. Call it yourself for what a commit can't express: a decision or research finding that changed no code, with the documents behind it three ways: `doc_paths` (repo-relative paths, never copies; a path outside every configured repo is rejected), `doc_content` (paste up to 10 docs' full text — 500K chars each — for research that was never a file), or `doc_uploads` (up to 10 absolute paths to existing files, any type, 20MB cap each, copied byte-for-byte into `.devsmind/workflows/` for a doc with no on-repo home). See [4.3.0](#430--the-devsmind-branch-devsmind-add-repo-and-workflow_add_step-can-copy-a-doc-in) below.
*   `workflow_delete`: Deletes a workflow that has **no steps** — a mistyped name, a duplicate created because the first one wasn't found, a thread bound and then abandoned. Refuses the moment there are steps, and separately if there are artifacts filed with no steps (`addWorkflowArtifact` takes a workflow-level artifact, so "no steps" doesn't mean "nothing here"). Anything with history is archived, not deleted: that record is why the workflow exists, and nothing could rebuild it.
*   `workflow_remove_step`: Removes ONE step that should not have been recorded — a duplicate from a retry, or one attached to the wrong workflow. Unlike `workflow_archive`, this is a real delete: the step and any artifacts filed under it (files on disk included) are gone, `step_index` is left gapped rather than renumbered, and there is no undo. Use it to correct a mistake just made, not to edit settled history.
*   `workflow_sync`: Attaches work you already did — for when you were unbound, or on the wrong thread. Reads your local activity log, previews what it would attach, and only writes on `confirm:true`. Re-running is a no-op.
*   `workflow_archive`: Retires a thread from the list without deleting anything, reversibly. Deliberately not "complete": a feature is never finished, it just stops being worked on.
*   `workflow_import`: Imports existing flow/architecture docs (`# Title` / `## Summary` markdown files) as workflows — a whole folder or a single file. The doc is referenced by path, not copied. Re-importing the same file updates its workflow in place instead of duplicating it. See [`devsmind workflow-import`](#-other-cli-commands) below for the CLI equivalent.

### 🌿 Category 7: The `devsmind` branch
Moves the churny part of the brain (`graph`/`history`/`vectors`/`workflows`) onto its own git branch, out of your code branch's diff. Sharing it takes two tools: one that syncs, and one that follows a sync that is still running.
*   `devsmind_git_sync`: Flushes shared brain data, commits it to the `devsmind` branch, three-way merges teammates' work, pushes, and writes back only the files that changed. It works on `.devsmind/` in place through a private git index (`.devsmind/local/git-sync.index`) and merges with `git merge-tree`, so it copies no files and never touches your checked-out branch, HEAD, `.git/index`, or staged changes. It does not require a `session_id`; it requires a `message`. Before it starts it scans local and remote branch paths: unsafe remote paths return `blocked_on_remote_paths` (removing them from the remote requires developer approval), and unsafe local-branch paths are cleaned and committed locally, not pushed.
    *   **One sync per brain at a time.** A lock file (`.devsmind/local/git-sync.lock`, holding the process id and start time) makes a second call return `status: "busy"` with the running job's id instead of starting another sync. A running sync cannot be stopped; it always finishes, success or error, and releases the lock either way. A lock whose process has died, or that is over two hours old, is taken over. The lock covers agents on the same machine and brain folder; teammates on other machines are handled by git (one push is rejected and the retry merges).
    *   **Long syncs return early.** The git work runs on a worker thread. A sync still running after about a minute returns `status: "running"` with a `job_id`, and the agent keeps calling `devsmind_git_sync_status`. `DEVSMIND_GIT_SYNC_WAIT_MS` changes the wait.
    *   On `status: "conflicted"`, git couldn't merge some files by itself. This is the one case that needs files on disk, so a temporary worktree holding the branch is created for it. Each entry carries the file's `path` (relative to the returned `worktree`), its marker-bearing `content`, and `ours`/`theirs` showing both sides cleanly. Write each file back as valid JSON with no markers, then call again with the same `worktree` plus `resolved: true`.
    *   A resolution is **validated before anything is committed**: it must parse, keep the right shape for its tree, and retain every node/vector/step id present on *either* side. A resolution that drops one comes back as `status: "invalid_resolution"` and nothing is pushed — because `syncFromDisk` deletes a graph file's DB nodes before reinserting from the JSON, so a dropped id would be a silently deleted node in the shared brain.
*   `devsmind_git_sync_status`: Waits up to a minute for a sync that answered `running` (or `busy` with a `job_id`) and returns exactly what `devsmind_git_sync` itself would have returned. Call it again while it still says `running`. Read-only: it never starts, stops, or changes a sync. Omit `job_id` to ask about the latest sync of this brain.

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

The code branch carries `.devsmind/config.json` and `.devsmind/.gitignore`. The dedicated `devsmind` branch carries `graph/`, `history/`, `vectors/`, and `workflows/`. Local state such as `.env`, `brain.db`, and `local/` is gitignored.

Ask the connected agent to call `devsmind_git_sync` to publish and receive shared brain changes. It commits and merges only on the `devsmind` branch, without copying the brain or touching your checked-out branch, then refreshes the local database. Only one sync runs per brain at a time, and a long one continues in the background: the agent follows it with `devsmind_git_sync_status`. It does not require a DevsMind session ID. This is separate from `commit_changes`, which records graph history and activity locally but does not run Git commands.

A fresh teammate checks out the code branch, runs `devsmind init` to configure machine-local paths and identity, connects the IDE, then calls `devsmind_git_sync`. `devsmind sync` is not part of this flow; use it only to import brain JSON already present on disk. It does not fetch the team branch.

## Changelog

### 4.7.1 - git sync without copies, one sync at a time, and a repair for wrongly deprecated nodes

#### Why a sync took 30 minutes

`devsmind_git_sync` made about seven full passes over the brain: it flushed `brain.db`, checked the `devsmind` branch out into a fresh temporary worktree (every file written), copied the brain into it, staged everything in a brand-new index, merged, copied the whole result back, and deleted the worktree. The work grew with the size of the brain, not with what had changed, and on Windows with antivirus scanning every write, a brain of tens of thousands of files took tens of minutes. Codex and Gemini give up on a tool call after about five minutes, so the call timed out while the sync was still running.

#### Sync works in place

Git now reads `.devsmind/` where it is. A private index file keeps file timestamps between syncs, so `git add` re-reads only files that changed. The commit is built with plumbing (`write-tree`, `commit-tree`) on top of the `devsmind` branch tip, teammates' work is merged with `git merge-tree` inside the object store, and only files that differ between the two trees are written back. The index is separate from `.git/index`, so your branch, HEAD, and staged files are never touched. The `devsmind` branch has the same layout as before, so teammates on older versions keep syncing against it. On a synthetic 10,000-file brain with a local remote, a sync after editing 20 files fell from 188 s to 9.4 s, a first sync from 255 s to 58 s, and a sync with nothing changed from 167 s to 1.4 s. A real brain pushing to a remote will be slower; these are not guarantees.

A real merge conflict still falls back to a temporary worktree, because resolving it means editing files on disk. That path was not rewritten, so a sync that hits many conflicts is much slower than a clean one: one real sync with 13 conflicts took about 25 minutes.

#### One sync at a time

There was no lock: two agents syncing the same brain could both flush `brain.db` at once, one could copy merged files back while the other wrote, and the manifest of synced files could fall out of step. A lock file (`.devsmind/local/git-sync.lock`) now makes a second request return `status: "busy"`, with the running job's id, process id, start time, and stage. A running sync cannot be cancelled on purpose: stopping after the commit but before the push, or halfway through writing files back, could leave the brain half-updated. The lock is released however the sync ends. A lock whose process has died, or that is more than two hours old, is taken over.

#### No more tool-call timeouts

The git work runs on a worker thread. A sync still going after about a minute returns `status: "running"` with a `job_id`. The new `devsmind_git_sync_status` tool waits up to a minute per call and returns the final result, so a client with a five-minute limit never loses it. The tool count is now 40.

#### `analyze --fix` no longer deprecates orphaned nodes

A node with no connections was treated as dead code and deprecated. But edges exist only where the extractor resolved a reference, and most variables, constants, types, and interfaces never get one even while in constant use. On one real brain of about 20,000 nodes and 9,858 connections, one `--fix` run had marked over 9,000 live nodes deprecated. Orphans are now report-only. `--fix` deprecates a node only on direct evidence: its file is gone, or it is a built-in name the extractor should not have recorded.

#### One-time repair of the damage

Nodes already deprecated that way stay deprecated unless something undoes it. `analyze` now reports "Wrongly deprecated nodes": deprecated nodes whose file exists and still contains their name as a whole word. The first `analyze --fix` on a brain restores them in one transaction (rewriting each file's graph JSON once) before its other fixes, then records that in the system metadata so it never runs again; a node an agent deprecates deliberately afterwards stays deprecated. Restoring does not bring back the connections and vectors dropped at deprecation. `devsmind embed` rebuilds vectors for restored nodes that have a description; connections return as files are re-indexed. The check is a plain word search over each file, so a short common name such as `container` or `list` can match a file that no longer defines it. The cleanup order for a damaged brain is `analyze --fix`, then `embed`, then `prune` to delete the nodes that are genuinely dead.

#### Documentation

The README and this reference now describe the in-place sync, the lock, the background job, and `devsmind_git_sync_status`; state that initial indexing needs no `devsmind sync`; list every indexing provider; and no longer describe removed or deprecated commands and flags in the body.

#### Verification limits

The sync, lock, restore, and analyze tests passed on Windows only. The benchmark used a synthetic brain and a local remote. The restore ran on one real brain and was not benchmarked.


### 4.7.0 - cross-platform path safety and shorter agent replies

#### Path safety across writers, imports, and sync

A Windows sync exposed a bad filename created when `upsertNode` appended a teammate's Linux absolute path to an existing path. The combined value was later treated as a filename. Path handling now collapses entries that identify the same file under different operating-system spellings, while graph and vector writers split multi-path values and write each path separately.

The shared `safe-path` rules reject Windows-invalid characters, control characters, reserved device names, trailing dots or spaces, empty segments, malformed comma-joined paths, and paths beyond the safe length. The default is 200 characters; when Windows Git long paths are unavailable, the effective limit is tightened to 259 characters minus the Git path prefix. It is a conservative default rather than a measurement of each machine. Collision checks include files, directories, file-versus-directory conflicts, case-only differences, and Unicode normalization forms.

A foreign-root check catches paths whose leading slash was stripped from common operating-system roots (`home`, `Users`, `root`, `mnt`, `Volumes`, `tmp`, `var`, `usr`, `opt`, `etc`, and `srv`). It exempts a repository genuinely named after one of those roots. `isForeignAbsolutePath` takes the platform explicitly, so each platform branch can be tested on any host. Path-to-repository mapping now uses folder names only when there is evidence that a path is foreign, relative, or exists in the repository. When a folder name repeats, the repository occurrence wins. Missing native absolute paths are no longer guessed into a repository, and startup healing no longer replaces an unmappable path with the workspace root.

Writers require graph and vector output to remain under a configured repository. Publishing skips unsafe paths, path collisions, collisions with files already on the branch, and foreign-root paths; imports ignore those files. `devsmind analyze` reports unsafe output files in `graph/`, `vectors/`, `history/`, and `workflows/`. With `--fix`, it removes those files and tidies empty folders. Removing a bad workflow folder is permanent.

Before checkout, sync scans both `origin/devsmind` and the local `devsmind` branch. Remote problems return `blocked_on_remote_paths` with exact paths for an explicit repair. The local branch is cleaned in a temporary worktree and committed locally only; that cleanup is not pushed. The stderr parser also recognizes Git's invalid-path and unable-to-create-file errors. On Windows, sync sets `core.longpaths` only in the repository-local Git configuration and records whether the setting took effect.

Repairing a remote branch required exact-name deletion because Git could reject invalid filenames before loading them, Windows rewrites backslashes in pathspecs, and case-insensitive index behavior could remove the wrong case variant. `removeRemoteBranchPaths` now lists index entries with NUL delimiters and removes the exact entries through `update-index --index-info`, without pathspecs and with `core.protectNTFS=false` and `core.ignorecase=false` scoped to that command.

#### Response style and session handling

The personal `devsmind style` setting is stored as `DEVSMIND_RESPONSE_STYLE` in the brain's gitignored `.env`; the process environment takes precedence and the setting is not written to committed `config.json`. The style instruction is placed first in the MCP handshake and the `/devsmind` prompt, stays under 900 characters, and begins with a bold mandatory line that applies from the first reply. While enabled, each tool result ends with a bold reminder. Code, commands, paths, errors, graph descriptions, commit reasoning, and workflow steps remain unshortened. The setting applies to new connections, so a running stdio server must be restarted.

The session-exempt set was renamed from `SESSION_EXEMPT_READ_TOOLS` to `SESSION_EXEMPT_TOOLS`. `devsmind_git_sync` is exempt because a session connects graph edits to the local Activity log for revert, while Git sync does not create a graph edit or read the supplied session ID. Clients that still include one are accepted.

The handshake and generated rule, skill, and memory instructions were shortened by removing text already present in each tool's description. Their contract remains intact. The 39 tool definitions still total about 83,598 characters (roughly 21,000 tokens); trimming the ten longest descriptions remains a possible follow-up.

#### CI and verification limits

A GitHub Actions workflow now runs the type check and `jest --ci` on Ubuntu, macOS, and Windows with Node 20. It has not run yet. The current verification is Windows-only: the type check is clean and all 65 suites / 1,580 tests pass. macOS and Linux behavior remains unverified until CI runs. Foreign-folder mapping is still heuristic, Windows-safe but incorrect remote paths are caught only when their first folder resembles an operating-system root, and models or clients may not consistently follow terse-style instructions.

### 4.4.0 — brain data leaves your pull requests, and sync gets ~4x faster

**One manual step if your brain predates this release** (below). Nothing else to do.

#### The brain was being tracked on two branches at once

4.3.0 introduced the `devsmind` branch so the shared brain would have a home of its own, away from code review. It worked — the branch was created, the data was pushed there, teammates merged through it. What was never done was the other half: telling the *developer's own* branch to stop tracking the same four directories.

So both were true simultaneously. `graph/`, `history/`, `vectors/` and `workflows/` lived on the `devsmind` branch **and** on `main`, on `xyz`, on every feature branch anyone happened to be standing on when a sync ran. Every sync wrote into `.devsmind/`, that folder sits inside the repo, and `.devsmind/.gitignore` listed only local-machine state — the credentials file, `brain.db`, the scratchpads, `local/`. The four data directories were absent from it, carried forward from the design that predated the branch, where committing them alongside the code was the whole point.

The result was a working branch permanently showing thousands of pending brain files, an ordinary three-line feature PR arriving as a three-thousand-file diff, and two teammates conflicting on graph files neither of them had opened.

**The fix is those four entries in `.gitignore`.** They remain shared, 3-way merged and reviewable — from one branch instead of every branch. The `devsmind` branch carries its own copy of that file, without these entries, so it goes on tracking them normally; this is ordinary per-branch gitignore behaviour, not a special case. The files themselves never move: they stay in `.devsmind/` on disk and the brain reads them from there exactly as before.

Worth stating plainly, because "gitignore" reads as *throw away*: nothing is deleted and nothing stops being shared. Only which branch watches the folder changes.

**Existing brains need one command.** Git keeps tracking what it already tracks, so topping up `.gitignore` — which `init` does automatically on every re-run — cannot untrack a directory that was already committed. Run once, and commit:

```bash
git rm -r --cached .devsmind/graph .devsmind/history .devsmind/vectors .devsmind/workflows
```

`--cached` removes them from git's index and leaves every file on disk; the brain keeps working throughout. Use `.devmind` for a brain created before 4.2.0. Skip this and the directories keep appearing in pull requests exactly as before, because from git's point of view nothing changed.

#### Sync copied all 10,000 files to carry twenty

The copy step mirrored a directory by deleting the target outright and writing the whole source back. Correct, and free of edge cases — every sync paid for a complete rewrite of the brain regardless of how little had changed, and paid it twice, since a sync copies brain → worktree on the way out and merged worktree → brain on the way back. On a brain of ten thousand files carrying a day's twenty edits, essentially all of that work was wasted.

It now compares first and copies only what differs. **Comparison is by content, never mtime**, and that distinction is what makes it work at all: `syncToDisk` rewrites every JSON file unconditionally on every run, so every mtime is fresh every time and a timestamp check would mark all ten thousand as changed — reproducing exactly the cost being removed. Size is checked before bytes, which rejects most differing files without reading either one.

**Deletions still propagate**, explicitly now. The old mirror got that for free: wiping the target meant a locally-deleted file simply never came back. A copy that only touches changed files has to walk the target and remove what the source no longer has, or a deleted node would live on in the shared brain forever — silent data resurrection rather than a visible failure. That case has its own regression test.

#### A sync took four minutes, and none of the obvious causes were it

Flushing a 14,000-node brain to disk took 228 seconds, of which 0.6 were CPU. Everything about that says filesystem, and it was not.

The first guess was the writing itself — `syncToDisk` re-serializes every file path on every run and rewrote each one unconditionally, identical bytes included. Skipping unchanged writes is worth doing on its own (it also stops every mtime being freshened on every sync, which is why nothing downstream could ever use timestamps to tell what changed) but it bought 13%.

The second was the node lookup, which `EXPLAIN QUERY PLAN` reported as `SCAN nodes` across 14,445 rows, twice per file path. The brain turned out to carry a genuinely broken index: an older build had created `idx_nodes_file_path` as `REPLACE(LOWER(file_path), '', '/')`, the backslash lost somewhere in escaping. An expression index is consulted only for a query whose expression matches it *textually*, so a one-character difference does not degrade it — it makes it inert, maintained on every write and used by nothing. Repairing that was worth doing too, and for more than sync: every `getNodesByFilePath` in the codebase was scanning, including on `get_node_code`'s hot path. It bought another 13%.

Neither was the answer, because the query could not have used any index in any case. It was shaped:

```sql
WHERE REPLACE(LOWER(file_path), '', '/') = ?    -- indexed
   OR LOWER(file_path) LIKE ? ESCAPE ''         -- and this discards the index
   OR LOWER(file_path) LIKE ? ESCAPE ''
   OR LOWER(file_path) LIKE ? ESCAPE ''
```

SQLite cannot satisfy `A = ? OR B LIKE ?` from one index — a single scan is the only plan that answers all the alternatives — so it scans, no matter how good the index on the first arm is. Measured on the same connection: the equality alone is an index seek at 0.05ms; add the three `LIKE` arms and it is `SCAN nodes` at 22ms. Multiplied by 1,881 file paths and two calls each, that is essentially the whole of the four minutes.

Those `LIKE` arms exist for a real case — a node whose `file_path` is a ", "-joined list of several files — but as a separate query rather than three `OR` arms, so the common path stays an index seek. That second query is skipped entirely unless the brain actually contains such a node, which is answered once and cached; the profiled brain had 0 of 14,445. The result is 228 seconds down to 58.

Worth recording how easily this hid: every benchmark run against "the indexed query" still had the `LIKE` arms attached, so it was measuring a scan and reporting it as an index hit. Only `EXPLAIN QUERY PLAN` on the exact four-arm form showed it. And the correctness check was not the test suite — it was re-deriving every file with the *original* query and comparing node id sets: 14,445 rows both ways across 1,881 paths, identical.

#### `devsmind git-status`, and why a new command was needed at all

Ignoring the four directories on the developer's own branch has one cost: `git status` stops mentioning the brain entirely. That is the point — but it also means "do I have anything worth sharing?" had no answer short of running a full sync and watching what it did.

`devsmind git-status` answers it directly, per directory, and counts **modified** files rather than only added and deleted ones. That distinction is the whole reason it does not read `local/last-synced-files.json`: that manifest records file NAMES, so it sees a file appear or vanish and is blind to a hundred edited in place — which is the ordinary case and precisely what the command exists to report. Instead each file's git blob id is computed and compared against the id recorded in the branch's tree. It flushes `brain.db` to disk first (otherwise it would be reporting the previous sync's files as current) and fetches, but commits, merges and pushes nothing.

Building it surfaced two bugs that had been sitting in every git call this module makes.

**Output above 1 MB was being silently truncated.** Node's `spawnSync` caps captured stdout at 1 MB by default and, on exceeding it, neither throws nor prints anything — it truncates and reports failure. A `ls-tree -r` over a 16,000-entry history is about 1.8 MB, so the branch listing came back empty and every file already shared looked brand new: the first run of this command reported 16,234 new files for a brain whose real figure was a few dozen. The same truncation would have made the sync's own deletion guard see an empty branch and conclude there was nothing to protect, which is the more dangerous half.

**Every file looked modified on Windows.** With `core.autocrlf=true` — the Windows default — git stores LF in the repository while the working copy holds CRLF, so hashing a file's raw bytes disagrees with git about every text file in the brain. Unfixed, the command would have confidently reported a whole brain as pending on every run, which is worse than reporting nothing at all.

#### git-sync repairs a brain still tracked on the developer's own branch

The `.gitignore` change only governs files git is not already tracking. A brain created before 4.4.0 — or one a teammate on an older version keeps re-committing — has all four directories in the index, where no ignore rule is ever consulted. Left alone, that brain keeps putting thousands of files into every pull request no matter how correct the ignore file is.

So `git-sync` now checks, and fixes both halves: it tops up `.gitignore`, and runs `git rm --cached` so git stops tracking the directories. Every file stays on disk throughout; the brain never notices.

It deliberately stops before committing. `git rm --cached` stages a deletion of every brain file on the developer's *own* branch, and committing that is a change to their history rather than DevsMind's — the same line this tool holds everywhere else (`commit_changes` runs no git at all). The result is reported back in a `repo_repair` block with `needsCommit: true`, and the tool description instructs the agent to say so rather than quietly commit.

That choice has a real cost, worth stating plainly: staged deletions are fragile. A merge or a checkout discards them without a word and the files return. That is not hypothetical — it happened on the brain this was written for, between the untrack and the commit. Hence the emphasis on committing promptly rather than a note buried in output.

#### Writing that removal pass exposed a much worse bug, older than this release

Making deletion explicit forced the question the wholesale mirror had been answering wrong all along without anyone noticing: *which* files is a sync entitled to delete?

A file the branch holds and `.devsmind/graph/` does not means one of two opposite things — "I deleted this node" or "a teammate added this node and my brain has never seen it." On disk they are identical. And our side is committed **before** the merge runs, so choosing wrong is not recoverable: git sees a deliberate delete on one side against no change on the other, honors it without raising a conflict, and a teammate's work is gone from the shared brain with nothing to review. The worst case is the most ordinary one — a developer's *first* sync, whose brain holds their own file and none of the team's, wiping everyone else's graph.

Nothing in git can answer it. The branch tip cannot: a fresh clone's worktree checkout holds every teammate's file while its brain holds none of them, which is exactly the case that does the damage. The merge-base cannot either, and fails in a more misleading way — for a brain that has never synced it *is* the remote tip, so it reports "you had all of this" about a brain that had none of it. Both were tried, and both were caught by the regression test rather than by review.

The question is about this brain's own history, so this brain has to record the answer. Each successful sync now writes what it holds to `local/last-synced-files.json` (gitignored, per-machine, meaningless to anyone else), and only files listed there may be deleted from the branch. A brain that has received nothing can delete nothing. A genuine local deletion still propagates, one sync later than before — the cost is a deletion arriving late, which is recoverable, against a teammate's work vanishing, which is not.

One consequence worth knowing: the same reasoning explains why both call sites copy the four subdirectories rather than `.devsmind/` itself. Copying the brain folder wholesale would carry `.gitignore` into the worktree, applying the developer's ignore rules on the `devsmind` branch — where `git add -A` would then skip the very files the branch exists to hold, and push an empty commit while reporting success.

### 4.3.2 — one `devsmind_git_sync` tool replaces `devsmind push`/`pull`

**Breaking.** `devsmind push` and `devsmind pull` are gone as CLI commands, and `push_devsmind_branch`/`pull_devsmind_branch` are gone as MCP tools. One tool, `devsmind_git_sync`, replaces all four. Re-run `devsmind rule`/`devsmind skill` after upgrading.

#### The bug that forced a redesign rather than a fix

The old pair could not survive the most ordinary sequence on a team: you pull, you work, a teammate pushes, then you push.

`pushDevsmindBranch` built a fresh commit from disk and fast-forwarded. Once the remote had moved, git rejected that push — correctly — and the error text told you to run `devsmind pull` and try again. But `pullDevsmindBranch` never merged anything. It checked out the remote tip into a worktree and called `replaceDir` to overwrite your local `graph/`, `history/`, `vectors/`, `workflows/` wholesale. So the documented recovery path *was itself* the data loss: your unpushed work vanished from disk, with no conflict, no prompt, no warning. Worse than a conflict, because a conflict at least announces that something needs attention.

That is not a bug you patch — the two commands were the wrong shape. A pull that overwrites can never be safely composed with a push that can be rejected.

#### Why 3-way merge, and why not "newest wins"

The obvious-sounding fix — compare timestamps, keep the newer file — fails twice over.

It is **unimplementable**: `writeGraphToDisk` and `writeVectorsToDisk` emit no timestamp fields at all. `nodes.created_at` exists as a column but is deliberately not serialized, and is reset on every re-sync anyway. The only recency signal available is filesystem mtime, which git rewrites on every checkout, so it cannot compare your copy against a teammate's.

It is also **wrong on the merits**, which matters more. Say a teammate sets `deprecated: 1` on a node and your copy still says `0`. A file-level timestamp cannot tell "I deliberately un-deprecated this" apart from "I never saw their change" — and if you touched that file for any unrelated reason (appending history, say), your file is now newer and newest-wins silently erases their decision.

Git's 3-way merge resolves that case correctly and with no interaction, because it compares both sides against their **common ancestor**: only one side moved `deprecated`, so that side wins. A conflict is raised only when both sides moved the *same* thing to *different* values, which is genuinely ambiguous and genuinely needs a decision.

The one thing that made this possible is committing your own state to the branch **first**. Without that commit there is no ancestor, which is precisely why the old pull could only overwrite — it had nothing to merge against.

#### Sequencing, which had to be exactly right

`syncToDisk` is a file-*generating* step: it writes a graph JSON and a vectors JSON per distinct `file_path` in the DB plus a workflow JSON per workflow — thousands of files on a real brain — and it writes them into the **real** `.devsmind/`, never a worktree. So the order is: flush `brain.db` to disk first (this is the step the old `push` skipped entirely, meaning anything committed to the graph but not yet written out was never shared at all), then worktree, then commit our side, then merge theirs, then push, then copy the merged result back and re-sync the DB so teammates' changes land in `brain.db`.

One subtlety worth recording: `replaceDir` treats an absent source as "delete the target", which was right for the old push (a straight mirror) but catastrophic here — a teammate syncing for the very first time has no local `graph/` yet, and mirroring that absence would commit a deletion of everyone else's graph before the merge ever ran. Subdirs the local brain doesn't have are now skipped; a real deletion *inside* a subdir still propagates, because that subdir exists and is replaced wholesale.

#### Conflicts, and validating what comes back

Genuine conflicts return `status: "conflicted"` with each file's merged content plus `ours`/`theirs` separately (parsing marker soup back apart is exactly the kind of busywork to hand over pre-done), and the worktree is **retained** — it is the quarantined place holding the files to fix, and keeping half-merged JSON out of the real `.devsmind/` is not optional: `syncFromDisk` deletes every DB node for a graph file before reinserting from that file, so a file that no longer parses means the delete lands with no reinsert. Nodes disappear silently.

That same hazard is why a resolution is never trusted. Before anything is committed, every resolved file must parse, keep the right shape for its tree, and — the check that matters — retain **every** node id, vector key and workflow step id present on either side of the conflict. A merge may add and may change, but it may never lose; an id that vanished comes back as `status: "invalid_resolution"` naming exactly what went missing, nothing is pushed, and the worktree is kept for another attempt.

#### Why the terminal commands went away entirely

Sharing the brain is something you ask an agent to do, in the same breath as the edits it just made — and the conflict round-trip needs a resolver that can read JSON and decide, which is the agent, not a prompt in a terminal. Keeping a CLI copy would have meant a second entry point into a flow whose interesting path (resolve, validate, resume) has no terminal-shaped answer. `devsmind sync` — the local `brain.db` command — is untouched and keeps its name.

### 4.3.1 — remove a mistaken workflow step, and skip repos you'll never touch

No breaking changes. Nothing here runs automatically until you use one of the two new pieces.

#### `workflow_remove_step`

Every existing workflow tool was append-only or reversible: `workflow_add_step` only adds, `workflow_archive` only hides (and un-hides). Nothing removed a step outright — so a duplicate step from a retried tool call, or one recorded onto the wrong workflow because the session was bound somewhere unintended, stayed on the timeline permanently, with no way to correct it short of leaving it there.

`workflow_remove_step` (`db.removeWorkflowStep` in `db/database.ts`) is a real delete, not a lifecycle state: it removes the step row, deletes any `workflow_artifacts` filed under it — including their bytes on disk, via `fs.unlinkSync` — and updates `workflows.updated_at`. `step_index` is deliberately **not** renumbered afterwards. Steps 1 and 3 with no 2 in between is an honest record of what happened; renumbering would rewrite every later step's identity for a purely cosmetic gap, and neither `getWorkflowSteps` nor `getWorkflowContext` need contiguous indices — both page by row count in `step_index ASC` order, not by index arithmetic, so a gap costs nothing downstream.

This is intentionally the odd one out among the workflow tools, and the tool description says so explicitly: use it to correct a mistake just made, not to edit settled history. `workflow_archive` remains the right tool for "this thread is done" — reversible, nothing lost. `workflow_remove_step` has no undo.

#### Skipping a repo you don't have locally

A standalone-mode brain lists every repo the *team* has ever registered in the one shared `config.json` — but a given developer's machine often only has some of them checked out. Before this release, `devsmind init`/`sync`/`pull`'s repo-path reconciliation (`findMissingStandaloneRepoPaths`, `reconcileRepoPaths`) treated "no `.env` entry for this repo" as something to fix *right now*, every time it was detected — there was no way to say "I will never have this one, stop asking." A developer working on a single repo in a brain that also tracks a dozen backend services (a mobile app, say) hit this on every `sync`.

New `SKIPPED_REPO_MARKER` (`__skip__`) in `utils/config.ts` is a fourth outcome alongside `ok`/`missing`/`invalid` in `findMissingStandaloneRepoPaths`'s scan — an `.env` entry whose value is the literal marker string, not a path. The path-reconciliation prompt (now identical in `init.ts`'s existing-brain repair loop and `sync.ts`'s `reconcileRepoPaths`, which `devsmind pull` shares) offers "Skip — not on this machine" alongside the existing folder browser for any repo that still needs an answer; choosing it writes the marker instead of a path. A repo already marked skipped is carried forward on every future `.env` rewrite — the same treatment `ok` repos already got — and `sync` never asks about it again, which is the entire point: a developer who works in one repo out of a dozen would otherwise answer eleven prompts on every sync.

`devsmind init` is the exception, as of 4.4.0. It re-offers skipped repos, defaulting the choice back to "keep skipping" so preserving the answer is one keypress. The asymmetry is deliberate: `sync` runs routinely and must stay silent, while `init` is the command you run *because* your setup changed — "I cloned that repo since" is exactly what it exists to capture. Before this, nothing ever asked again, and the printed advice ("change with `devsmind add-repo`") did not work either, since `add-repo` refuses a name already in `config.json` and a skipped repo is already there; hand-editing `.env` was the only real route.

`resolveRepoPath` treats the marker exactly like "not configured": it returns `null` rather than resolving to a bogus literal path (`cwd()/__skip__`, say). Every caller downstream — `utils/scanner.ts`'s per-repo file walk, `db/analyze.ts`'s renamed/changed-file scan, the indexer — already treated a `null` repo path as "unavailable, skip silently," since that's exactly what a `missing` repo has always resolved to. So the marker slots into an existing degrade-gracefully path rather than requiring changes at every consumer; the only place that needed a real code change was `resolveRepoPath` itself, to stop the sentinel string from being handed out as if it were a real directory.

The marker is a plain `.env` value rather than a new config field or separate file, because `.env` is already the one place a per-machine, per-repo fact like this lives, and every reconciliation call site already reads and rewrites it as plain `key=value` lines.

### 4.3.0 — the `devsmind` branch, `devsmind add-repo`, and `workflow_add_step` can copy a doc in

No breaking changes to an existing brain. `config.json` still lives on your code branch exactly as before — nothing moves automatically; the first `devsmind push` is what starts the new branch. `doc_paths` behaves exactly as before too — this only adds two more ways to attach a document.

#### The problem

DevsMind writes one JSON file per node/history entry under `graph/`/`history/`, plus `vectors/` and `workflows/`. On a real codebase a single indexing run or a busy session can touch hundreds of them. Committed straight onto whatever branch you're working on — the default since 1.0 — every one of those files shows up in that branch's diff, which means every PR review has to scroll past hundreds of graph/history changes to find the actual code change being reviewed. That friction was the direct trigger for this release: it was making PRs difficult to open and difficult to review.

#### The fix: a dedicated `devsmind` branch, decoupled from your code branch

`devsmind push` commits the current `graph/`, `history/`, `vectors/`, `workflows/` onto a branch literally named `devsmind` and pushes it (if a remote is configured). `devsmind pull` is the reverse: it copies that content back down into `.devsmind/` and re-syncs `brain.db`. Same two operations as `push_devsmind_branch`/`pull_devsmind_branch` over MCP — one shared implementation (`utils/devsmind-branch.ts`) underneath both entry points, so an agent asked to push does exactly what the CLI command does, no separate code path to drift out of sync.

`config.json` is deliberately excluded from the move. It's small, changes rarely, and — critically — it's what a fresh `git clone` needs to see immediately for DevsMind's own directory-detection (`resolveBrainDir`/`findBrainDir`, from the 4.2.0 rename work) to recognize "this repo has a brain" at all. If `config.json` also lived only on the `devsmind` branch, a brand-new clone would show zero trace that the repo uses DevsMind until someone already knew to go run `devsmind pull` — a real onboarding regression. Keeping it on the code branch means the only asymmetry after a fresh clone is an empty `graph/`; everything else about brain detection works exactly as it does today.

#### Why a `git worktree`, not a stash

The natural-sounding implementation — `git stash`, checkout `devsmind`, pop the stash, commit, push, checkout back — was considered and rejected. It operates directly on the developer's real working directory and index: any interruption (a conflict on pop, a crash, Ctrl-C) leaves the repo straddling two branches with a stash floating around, and it stashes/pops the developer's actual in-progress code edits just to shuttle them across a branch switch, for zero benefit.

`push`/`pull` instead use a throwaway `git worktree` in a scratch temp directory, set up in a `finally` block that's always cleaned up. The caller's HEAD, checked-out branch, index, and working tree are never touched — there is no "checkout back" step because the caller never left. When the `devsmind` branch doesn't exist yet, it's created as a **genuine orphan** (`git checkout --orphan`, with the inherited working tree explicitly cleared before the first commit) rather than a divergent copy of whatever code branch happened to be checked out at the time — so the branch's tree only ever holds `.devsmind/`, never a stale snapshot of source code nobody should be looking at there anyway.

#### Mirror semantics, and the stranded-commit case

Each of the four subdirs is fully replaced on both `push` and `pull` — removed, then recopied — rather than merged file-by-file. A file deleted on one side disappears on the other after the next push/pull; a rename shows up as a delete-plus-add, same as it would in a normal git diff.

One edge case worth calling out: if the `git push` step fails after the local commit already landed (a network blip, most likely), naively re-running `push` with no new file changes would report "nothing to push" and leave that commit stranded forever — the diff check only looks at whether `.devsmind/` changed THIS run, not whether the branch is already ahead of the remote. `pushDevsmindBranch` checks both: no new changes AND local already matches the remote is a true no-op, but no new changes with local still ahead of `<remote>/devsmind` triggers a push of the existing commit. Caught during manual testing, not planned upfront — the first version of this logic returned early on `filesChanged === 0` regardless of push state.

#### What was deliberately left out of this release

Whether `devsmind init` should start writing `graph/`, `history/`, `vectors/`, `workflows/` into a brain's own `.devsmind/.gitignore` — so a fresh project stops tracking them on the code branch by default, rather than only stopping once someone has manually run `devsmind push` — is an open question, not answered here. That's a product-wide default-behavior change affecting every future project, not just this one, and deserves its own explicit decision rather than riding along with the push/pull mechanism itself.

#### `devsmind add-repo` — one repo at a time, into an existing brain

Standalone mode only. Before this, adding a repo to a brain that already existed meant re-running the whole `devsmind init` wizard — developer info, every existing repo's path check, the lot — just to register one new one. `devsmind add-repo` (CLI) and `add_repo` (MCP tool) do exactly the one thing: prompt for a name and a local path (the same prompt `init`'s existing-brain path-repair step already used, extracted rather than duplicated — see `findMissingStandaloneRepoPaths` below), write it into `config.json`/`.env`, and index just that repo by calling `index --run`'s own machinery with `--repos <name>` under the hood.

**Resumable, which scoped indexing wasn't before this.** `index --run --repos <name>` always started its scratchpad fresh, on purpose — every ad-hoc `--repos` invocation shares one file (`index_scratchpad.scoped.json`), so blindly resuming it could resume a completely different repo's leftover run. `add-repo` sidesteps that by owning its own dedicated scratchpad file instead of the shared one; `runBackgroundIndexing` gained an optional `padFile` override for exactly this, and only reuses (rather than recreates) a scratchpad when the caller explicitly supplies one. A second `add-repo` call with an interrupted run pending picks it up from a small marker file recording which repo was in progress — needed because `config.json`/`.env` are written *before* indexing starts, so a crash in that narrow window would otherwise leave nothing to identify which repo to resume.

**The MCP tool mirrors `index_start`'s own pattern** (extract structure locally, no LLM, hand back a batch to describe) rather than trying to drive the CLI's LLM-driven `--run` from inside a tool call, which isn't a fit for a request/response cycle. `index_continue`/`index_checkpoint`/`index_complete` gained an optional `scratchpad` parameter so the SAME three tools keep working for `add_repo`'s scoped session — Phase 1 (file scanning) is filtered down to just the one repo when a caller passes a scratchpad name, but Phase 2 (edge resolution) deliberately stays whole-graph even then: a newly-added repo's own outgoing references need the full node set to resolve against, and an existing repo can gain a new incoming reference into it, so narrowing that step would be a correctness regression, not an optimization.

One implementation snag worth recording: the MCP server caches one `DevMindDatabase` instance per brain, and that instance snapshots `config.repos` once, in its constructor. A DB already cached by an earlier tool call in the same session (`start_session`, say) would keep producing `../<repo>/...`-shaped node ids for the just-added repo instead of `{<repo>}/...`, having never seen it in the config it loaded at construction time. `add_repo`'s handler now evicts that cache entry (`invalidateDatabase`) right after writing the new repo into `config.json`, before indexing it — caught by an assertion on the returned node ids during testing, not something manual testing alone surfaced.

#### `devsmind sync` / `devsmind pull` catch a repo added elsewhere

`config.json` is shared (committed on the code branch); `.env` is per-machine and never shared. So when a teammate runs `add-repo` and pushes, every *other* machine's `.env` silently falls behind — nothing detected that gap before this, and rule/skill files kept describing the old, shorter repo list indefinitely.

Both `sync` and `pull` now start with the same check (`reconcileRepoPaths` in `cli/sync.ts`, `findMissingStandaloneRepoPaths` in `utils/config.ts` — the latter extracted from `devsmind init`'s existing-brain path-repair loop rather than a second hand-rolled copy of the same scan): does `config.json` name a repo `.env` has no path for, or one whose recorded path no longer exists on disk? Nothing missing is the common case, and stays exactly as fast as before — no prompts, no extra output. Something missing triggers, in order: a path prompt for each affected repo (same `browseForDir` picker `init` uses), a rewrite of `.env` from its own known-good state (not a naive append — an early version of this literally left the stale line next to the corrected one, caught by a test asserting the old value was gone, not just that the new one was present), then a loop offering to re-run `devsmind rule` and `devsmind skill` for however many tools are in use, since those files were generated against the shorter repo list and are now stale. A non-interactive run (CI, a script) prints a warning and skips straight past the prompt rather than hanging on one nothing can answer.

`devsmind pull` reuses this unchanged rather than a thinner copy of it, and along the way also gained the second half of a real sync: it previously only ran `syncFromDisk` (disk → `brain.db`), never `syncToDisk` back out, unlike `devsmind sync` which always did both.

#### Why `doc_paths` alone wasn't enough

`doc_paths` (see [Workflows In Depth § 4](#4-documents-are-paths-by-default-with-two-deliberate-exceptions)) is deliberately a reference, not a copy — a path outside every configured repo is rejected, because a document only you can see is useless to a teammate. That's the right default for anything already versioned in the repo. But it's the wrong answer for two real cases: research pasted straight into the conversation that was never a file anywhere, and a doc that genuinely has no on-repo home (a PDF a stakeholder emailed, a screenshot, a spec living in some other tool) — or one that needs to outlive its source being deleted. `doc_paths` can't express either, so that knowledge was getting dropped on the floor.

#### `doc_content` and `doc_uploads`

`workflow_add_step` now takes two additional, optional params alongside `doc_paths`:

- **`doc_content`** — up to 10 entries, each a `name` + `content` string (500K chars per doc). For text you already have in hand that isn't a file. Written to disk as a new artifact; content is never echoed back in the response, same reasoning as `workflow_get_context` never inlining artifact content — you get the `file_path`.
- **`doc_uploads`** — up to 10 absolute paths to files that already exist on disk (any type, 20MB cap each). Copied byte-for-byte via `fs.copyFileSync`, so binary files (PDFs, images, `.docx`) survive intact — `doc_content` can only hold text. No configured-repo restriction, unlike `doc_paths`: the entire point is capturing something that may not live in a repo at all.

Both are validated before the step is ever written — count caps, size caps, and (for uploads) existence and file-vs-directory checks all run first, so a call that fails validation leaves the step's `doc_paths` docs attached but nothing partial from the new params.

#### `workflow_artifacts` is no longer vestigial

The table was marked vestigial (see [Database Schema § 7](#7-workflow_artifacts--dormant-since-300-active-again-in-430)) when `doc_paths` replaced the old copy-everything `workflow_add_artifact`. `doc_content` and `doc_uploads` write to it again — via `addWorkflowArtifact` (already existed, just unused) and new `addWorkflowArtifactFromFile` in `db/database.ts` — but only for the two cases above. `doc_paths` is still the path of least surprise for anything already in a repo; the table is back because "never copy" turned out to be one rule too many, not because the original reasoning against copies was wrong.

---

### 4.2.0 — the brain directory is `.devsmind/`, and `.devmind/` keeps working forever

No breaking changes for any existing brain. One thing to know if you create a NEW one: it needs devsmind-mcp **>= 4.2.0** on every teammate's machine.

#### Why rename a directory at all

`devmind-mcp` is an unrelated npm package, published October 2025, one letter away from ours. It stores prose memories in a global `~/.devmind/memory.db` — a different product solving a different problem — but it had the name first. Ours is called DevsMind and wrote a directory called `.devmind/`, so a developer who saw that folder in a teammate's repo and searched npm for it landed on someone else's project. That is a naming problem that only gets more expensive with adoption, so the cheapest time to fix it is the earliest one.

The rename applies to what `init` **creates**, and nothing else.

#### Why there is no `migrate` command, and why that is the right call

A brain is git-committed and team-shared. Renaming an existing one is therefore not a per-developer action — it's a repo-wide commit every teammate pulls. Ship a migrate command and you manufacture the one failure mode that otherwise cannot happen: someone still on 4.1.x pulls a commit that moved `.devmind/` out from under them and loses their brain mid-sprint, for a cosmetic gain.

So the fallback is permanent rather than a deprecation window: `.devsmind` is tried first, `.devmind` second, at every level of the walk-up, forever. An existing brain is never orphaned, never warned about, never asked to move.

This is only possible because **nothing inside a brain records its own folder name.** `config.json` stores repo-relative paths (embedded mode) or `.env` repo keys (standalone); `graph/`, `history/`, `vectors/` and `workflows/` are keyed by repo and symbol; `brain.db` is a rebuildable cache. The bytes are identical under either name. Anyone who *wants* to rename one can `git mv .devmind .devsmind` and be done — which is exactly why building a command for it would have been ceremony around a one-line git operation.

#### The part that was actually work: finding every place that hardcoded the name

The rename itself is trivial. The risk was that `.devmind` was written as a bare string literal in **16 places** across 8 files, each answering "where is the brain" independently. Fixing only the obvious two — the CLI's lookup and the MCP server's startup auto-detect — would have left the rest silently blind to any brain created from this release on.

The worst of them: **all 12 web-view HTTP routes** each did their own `path.join(process.cwd(), '.devmind')` as the `?path=` default. Left alone, `devsmind view` would have opened successfully against a new project and shown an empty graph, empty history, empty activity — which reads as "my data is gone", not "the path default is stale". Also caught: the `--path` defaults for `index`/`reindex`, `devsmind view` and `devsmind prune`'s own hand-rolled copies of the walk-up, the `ALWAYS_IGNORED` lists in `db/grep.ts` and `utils/scanner.ts` (which now hold both names, or a brain would leak into your own search results), and the interactive directory picker in `integrations/prompt.ts`, which whitelisted `.devmind` as the one dot-folder worth showing — so a `.devsmind` brain would have been invisible in the picker whose whole job is finding it.

All of them now call one resolver in `utils/config.ts`: `resolveBrainDir` (one directory), `findBrainDir` (walk up), `brainDirOrDefault` (never null; falls back to the *current* name, since pointing a fresh project at the legacy one would name a directory that will never exist). `findDevmindDir` remains as an alias so nothing else had to change.

#### The one genuine bug this would have shipped

`devsmind init`'s "does a brain already exist here?" check was a hardcoded `.devmind` test, entirely separate from the lookup every other code path used. Change only what `init` *creates* and that check becomes a landmine: re-running `init` on any pre-4.2.0 project would find no `.devsmind`, conclude the project was brand new, and write a second `config.json` + `brain.db` + `graph/` beside the real one — two brains in one repo, with the server reading whichever the resolver reached first. The check now asks `resolveBrainDir`, the same question everything else asks, so an existing brain is always repaired in place under whatever name it already has.

#### What a user actually sees

A fresh `init` prints one line naming the new directory and the version teammates need — pointed at the person creating the brain, since they're the only one who can pass it on (a teammate on 4.1.x will never see a message written in 4.2.0). Not-found errors across the CLI and server now name both directories, so "no brain here" can't be misread as "wrong name". Nothing is printed when the server binds to a legacy brain — it works, and saying so would only invite an unnecessary migration.

18 tests cover the resolver: both names, precedence when both exist, an empty leftover directory not shadowing a real brain next to it, nearest-brain-wins on the walk-up, and the fallback landing on the current name.

---

### 4.1.2 — devsmind analyze --fix now actually clears the EISDIR-class warning, not just the node behind it

No breaking changes.

#### Fix: the "file_path resolves to a directory" sync warning survived `analyze --fix`, forever, on completely healthy files

A user hit this directly on their real, ~7,700-node brain: `devsmind sync` printed "Skipped writing graph JSON: a node's file_path resolves to a directory, not a file" for a couple dozen files, ran `devsmind analyze --fix` in between (which reported 0 missing-files issues — nothing to fix), then ran `devsmind sync` again and got the exact same warnings, unchanged, for the exact same files.

That "0 missing-files issues" result was the tell. `isDegenerateDiskJsonPath` (4.1.1) refuses a write for three distinct reasons, but the warning text only describes the first: the node's own `file_path` resolving to a directory. Reproducing it directly showed the source file was completely real (`fs.statSync(srcFile).isFile()` — `true`) while the *computed output path*, `.devmind/graph/<repo>/pages/personal-details/index.json`, already existed on disk as a directory (`fs.statSync(target).isDirectory()` — `true`). That's the guard's third check — an existsSync+isDirectory catch-all for any collapse shape not caught by the first two — firing for a reason that has nothing to do with the node at all: some earlier corrupted write (very plausibly the exact bug 4.1.1 fixed, or its predecessor) left a stray directory sitting exactly where a healthy file's JSON now needs to go. `analyze`'s "missing files" detector only ever looks at whether a node's *own* `file_path` resolves to a real file — it has no way to see, and no reason to suspect, that the *output* tree itself is corrupted. `writeGraphToDisk`/`writeVectorsToDisk` can only refuse-and-warn; neither one ever deletes anything. So nothing in the system was ever capable of removing that stray directory — not the write guard (skip-only by design, to stay safe on a write path), not `analyze --fix` (DB-only, never touched `.devmind/graph`/`.devmind/vectors`). The same warning was structurally guaranteed to repeat on every future sync, forever, regardless of how many times `--fix` ran.

The fix adds exactly the detector that was missing: `findStrayOutputDirs()` recomputes each live node's `graph/`/`vectors/` output path the same way `writeGraphToDisk`/`writeVectorsToDisk` do, and flags any target that `existsSync` + `isDirectory` — deliberately mirroring only that third check, never the first two (an empty/trailing-slash/`..`-collapsing path always means the node's own `file_path` is degenerate, already `missing_files`' job and already fixed by deprecating the node; treating it as "stray" here too would risk recommending deletion of `graph/`/`vectors/` themselves). It's a new `analyze` category — report-only on a dry run, and on `--fix`, the stray directories are removed and the graph/vectors JSON for every file they blocked is rewritten immediately, in the same `--fix` pass. That last part matters: without it, a user would still need to remember to run `sync` a second time after `--fix` to actually see the file repaired. The node itself is never touched — this class of bug was never the node's fault, so nothing about it should show up as a deprecation.

#### `devsmind analyze` looked hung on a large brain — it was just silent

The same ~7,700-node brain surfaced a second, smaller issue while confirming the fix above: `devsmind analyze --fix` printed its two-line header, then nothing, for long enough to genuinely wonder whether it had hung. It hadn't — `new DevMindDatabase(dbPath)` always runs a full `syncFromDisk()` pass in its constructor (every `graph/`/`history/`/`vectors/`/`workflows/` JSON file on disk read back into SQLite), and on a brain this size that pass alone takes real time. `sync`, `describe`, and `embed` already pass an `onSyncProgress` callback into that same constructor and render a live "Syncing graph from disk: N/M (X%)" line for it (`cli/sync-progress.ts`) — `analyze` was just never wired up to it. It now is, plus one static "Running health checks..." line for the detector pass that follows, so there's visible progress the whole way through instead of a blank terminal.

#### The SAME directory-typed warning kept reappearing on every sync, even after the node was already deprecated

Confirming the `findStrayOutputDirs()` fix on the same brain turned up a third, distinct flavor of the same underlying story: a node whose `file_path` was literally `.devmind` itself (the workspace root) kept producing the exact "a node's file_path resolves to a directory" warning on every single `devsmind sync` — not once, not until the next `--fix`, but forever, every run, unchanged.

The cause was in the one place that hadn't been touched yet: `deprecateNode`. When `analyze --fix` deprecates a `missing_files` node, it sets `deprecated = 1` — which is correct and exactly what's supposed to happen — but it has no reason to (and doesn't) touch that node's `file_path` column, which is still the same garbage directory path it always was. The node row is never deleted (DevsMind never deletes nodes, by design — history has to survive). `syncToDisk`'s force-resync loop built its set of file_paths to write from `SELECT DISTINCT file_path FROM nodes` with no filter on `deprecated` at all, so that garbage path came right back on the next sync, and the one after that, and every one after that — `writeGraphToDisk`/`writeVectorsToDisk` dutifully tried again each time, hit the same guard, and printed the same warning. The node WAS fixed. The warning had no way of knowing that.

The fix teaches `syncToDisk` the difference between "still needs attempting" and "already handled, permanently." A file_path is now skipped — no write attempt, no warning — only when BOTH: every node currently holding that exact string is deprecated, AND the path is `isFilePathStructurallyDegenerate` (a new, disk-I/O-free check reusing just the first two of `isDegenerateDiskJsonPath`'s three tests — the ones that mean the *file_path itself* is unfixable, never the third, existsSync+isDirectory one, since that's the stray-output-directory case from the fix above, which is real, removable disk cruft and must never be treated as permanent). Either condition failing means the write still happens exactly as before: a file_path shared by a live node and a deprecated sibling is still rewritten on every sync, because the sibling's `deprecated:1` flag genuinely needs to stay current on disk for a teammate's `syncFromDisk` to see it.

### 4.1.1 — devsmind sync stops crashing, tells the AI commit_changes isn't git

No breaking changes.

#### Fix: nothing ever told the AI that `commit_changes` isn't git

A teammate reported an agent running an actual `git add`/`git commit` immediately after calling `commit_changes` — unprompted, without being asked to touch git at all. The implementation was never in question: `commit_changes` has no shell-out, no git command anywhere in it, and only ever writes into `.devmind/`'s own local graph/database and activity log. The gap was entirely in what the AI was ever told. `commit_changes` takes a required `message` param described as "the user's original request, verbatim" — which reads exactly like a commit message would — and nowhere in `DEVSMIND_INSTRUCTIONS`, the generated rule, or the memory topics was there ever a sentence saying the two "commit"s are unrelated. An agent that treats the tool name at face value, or that has its own habitual "wrap up with a git commit" behavior, has every reason to either run a real git commit right after (what got reported) or, just as bad the other way, assume `commit_changes` already covered the real git commit and skip one that should have happened.

Fixed by saying it explicitly, everywhere the contract lives: a new numbered point in `DEVSMIND_INSTRUCTIONS` (`commit_changes is NOT git and never touches it... never run git add/git commit/git push on your own initiative just because commit_changes succeeded`), the same language appended to the `commit_changes` tool's own schema description (so it's visible even to an agent that only ever reads tool schemas, not the rule), a new point in `devsmind rule` for both Automatic and Manual workflow styles, and an expanded `devsmind-commit-changes-contract` memory topic. The Git Collaboration Workflow diagram just above (a human-facing doc, not part of what the AI reads) had the same ambiguity in a smaller way — `git commit -am`/`git push` sat unlabeled right after "AI updates history," with nothing marking whose step that actually is — now both lines read **YOU**.

#### Fix: `devsmind sync` could crash with EISDIR, and never actually wrote `vectors/` back either

A user ran `devsmind sync` on a real, 7,794-node brain and hit `EISDIR: illegal operation on a directory, open '...\.devmind\graph'` — repeated four times, once per malformed value hit during the run — right before the sync otherwise reported success. The path in the error was telling: not a file inside `graph/`, but the `graph/` directory itself.

The cause traces to `toRepoRelativePath` (`database.ts`): it turns an absolute file path into a `{repo}/relative/path` string for disk storage, by finding which configured repo the path falls under and calling `path.relative(repoPath, absPath)`. That function assumes `absPath` names a *file inside* a repo. Nothing enforces that assumption — and somewhere in this brain's history, a node ended up with `file_path` set to a whole repo directory (or the workspace root itself), not a file within one. For that node, `path.relative` returns `''` (or, from the workspace-root fallback branch, `'..'` when compared against a path one level up) — a directory compared against itself, or its own parent, is not "5 characters into some/path.ts", it is nothing at all, or "go up one." `writeGraphToDisk` builds a disk path from this string with a single `path.join`, never checking whether the result actually still lands inside `graph/` — so for this one corrupted node, the "JSON to write" resolved to `graph/` itself, or `graph/`'s parent, and `fs.writeFileSync` treats an existing directory at that path exactly as its error name says: an illegal operation.

The proximate fix is a new `isDegenerateDiskJsonPath` check shared by `writeGraphToDisk` and `writeVectorsToDisk`: reject an empty or trailing-slash relative path, reject one whose `path.relative` back to the `graph`/`vectors` directory is empty or starts with `..`, and as a last catch-all, reject a target that already exists as a directory. Any of the three stops the write with one clear warning (`a node's file_path resolves to a directory, not a file — run devsmind analyze --fix to clean it up`) instead of a stack trace, and — just as important for a brand-new brain that has never synced, where `graph/` doesn't exist as anything yet — instead of *silently creating a file named `graph`* where a directory belongs, which would have been a quieter and much worse outcome than the crash the user actually saw.

The deeper fix is making the corrupted node findable and fixable at all. `devsmind analyze`'s "missing files" detector (`findSpuriousAndMissingFileNodes`) used `fs.existsSync(resolvedPath)` — true for a directory just as much as a file, so a node like this passed every health check that ever ran against it, indefinitely, and only ever surfaced as the write-time crash above. It's now `fs.statSync(resolvedPath).isFile()`, which is false for both "doesn't exist" and "exists but is a directory" — one check catching both failure shapes cleanly, and `analyze --fix` already knew how to safely deprecate anything landing in that category, so the corrupted node is now something `devsmind analyze --fix` can actually clean up, no new fix path needed.

Separately, investigating this surfaced a real question worth its own fix: does `devsmind sync` actually sync vectors? Reading — yes, `syncFromDisk` loads `vectors/*.json` into `node_vectors` right alongside `graph/`/`history/`/`workflows/`. Writing back — no, `syncToDisk` only ever force-rewrote `graph/` and `workflows/` JSON from the DB, never `vectors/`. That asymmetry rarely mattered under normal operation (`writeVectorsToDisk` already runs immediately alongside every embedding write, the same as `writeGraphToDisk` does), but it directly undercut the one thing `sync` exists for: forcing a clean resync after something on disk got deleted, corrupted, or — as in this exact incident — silently failed to write in the first place. `syncToDisk` now calls `writeVectorsToDisk` for every node's file_path too, closing the gap.

That question — "does sync actually touch X?" — is exactly what the command's own output couldn't previously answer. `getCounts()` only ever reported `nodes`/`connections`/`history`, so a run's printed summary was silent about two of the five things `sync` actually moves. It now also queries `node_vectors`/`workflows` and prints **Vectors** and **Workflows** lines alongside the existing three, each with the same before/after delta — so a run that picked up new embeddings or workflow state (or, just as usefully, one that didn't) is visible directly in the command's own output instead of something you'd have to go check the database for.

### 4.1.0 — MCP Prompts, one skill file, memory that skips what can't remember, and stage_change is back

No breaking changes — nothing removed, nothing renamed except a dead, never-read registry field. Worth re-running `devsmind memory` if you use Antigravity, Antigravity CLI, Codex, or Kiro: it now tells you plainly there's nothing to ask those tools to remember, instead of printing a prompt that would just get acknowledged and dropped. Worth re-running `devsmind rule`/`devsmind memory`/`devsmind skill` either way, to pick up `stage_change`.

#### The server never declared the MCP `prompts` capability, even though it's been sitting there fully supported

Three ways to get DevsMind's workflow contract in front of an agent existed before this release: the workspace rule (`devsmind rule`, always loaded), the memory prompt (`devsmind memory`, pasted once), and the connect-time `instructions` string every MCP client already receives on handshake. What was missing was a way to re-assert that same contract *explicitly*, mid-conversation, the way a slash command does — without re-pasting anything. The installed SDK (`1.29.0`, newer than `package.json`'s declared `^1.0.1`) already ships the full `prompts` capability — `ListPromptsRequestSchema`/`GetPromptRequestSchema`, `prompts/list`/`prompts/get` — DevsMind's server just never declared it. It does now: `capabilities: { tools: {}, prompts: {} }`, with one static prompt, `devsmind-workflow`, whose `prompts/get` response is the exact same `DEVSMIND_INSTRUCTIONS` string already sent at connect and reused by `devsmind memory`'s prompt — a fourth consumer of one already-single-source-of-truth constant, not a new one to keep in sync. No arguments, no registry change, no CLI change — it's live the moment a client that supports the capability connects via the existing `devsmind mcp`. Claude Code, Cursor, Windsurf, Kiro, and Qwen are the tools researched to implement `prompts` well; a client that doesn't simply never calls `prompts/list` and nothing changes for it.

#### `devsmind memory` printed the same prompt for a tool with nothing to attach it to

Research across all integrated tools shaped the print-only design in 4.0.0. Antigravity (IDE + CLI) and Kiro do not have a genuine background-memory concept, so `devsmind memory` still points them at `devsmind skill`. Codex now has a real Memories toggle under Settings > Personalization > Memory; for Codex, `handleMemory` first prints that setup path, asks the user to confirm it is enabled in interactive mode, and then prints the same explicit "remember this" prompt backed by `DEVSMIND_INSTRUCTIONS`.

#### A dead skill-file writer got revived as its own command

`registry.ts` already defined exactly where a shared skill file should live - `AGENTS_SKILL_SCOPE`/`skillMdWrap`, pointing at `.agents/skills/devsmind/SKILL.md` - left over from before `devsmind memory` went print-only in 4.0.0, when it was still one of several write targets. `memory-topics.ts`'s `renderCombined()` already produced exactly the content such a file would need - the same 15 topics flattened into one document, also unused since that switch. Rather than leaving both dead, `devsmind skill` is a standalone command that reuses them as-is: one file, one location, no per-tool variants. It gives every tool an explicitly-invokable command (`/devsmind`, or `$devsmind` for Codex) as a lever independent of whether that tool has any memory concept to lean on - confirmed discoverable today by Antigravity, Antigravity CLI, and Codex, and Claude Code/Cursor are documented to read the same `.agents/skills/` convention and may pick it up too. In 4.6.0 the interactive project-only path now prompts for the target project root before writing, matching `rule` and `mcp`; `-p/--path` and `--print` keep the direct path/print behavior. `mergeRuleFile`'s existing `standalone` write path handles the actual write, so this needed no new write primitive anywhere.

#### `stage_change` is back — recovering a write `edit_node` never saw, not a second way to make one

4.0.0 removed `stage_change` because its old shape — a hand-fed `node_id`/`code_snapshot`/`type` the AI had to work out and supply itself — was fully subsumed by `edit_node`'s automatic tracing. That reasoning still holds; nothing about it changed. What surfaced afterward is a gap neither tool ever covered: an AI's own editor sometimes makes an edit through its native edit/write tool instead of `edit_node` — a habit slip, a tool picked automatically by the IDE, a change made before DevsMind was even connected — and once that happens there was no way to get it into the graph at all. The code was on disk; DevsMind had no record of it, and no path to acquire one. `edit_node` can't help retroactively, since it performs a write itself.

`stage_change` fills exactly that gap, with a shape that looks identical to `edit_node` at a glance but means something different underneath. Same parameters — `file_path`, `old_string`, `new_string`, `replace_all`, `description` — but `old_string`/`new_string` swap roles: `new_string` is what must already be found on disk (it gets *located*, never written), and `old_string` is what the code looked like before, supplied only to reconstruct history and a diff. `locateAppliedEdit()` (`utils/edit.ts`) is the new read-only mirror of `replaceTextInFile()` that makes this possible — same EOL-tolerant matching, same single-occurrence-unless-`replace_all` rule, same "was not found" and "matches more than one place" errors, just searching for what the edit left behind instead of what it's about to remove. Its result feeds the exact same `findTouchedSymbols` → `stageEntry` → `commit_changes` path `edit_node` already uses, so there was no second staging pipeline to build — only a different way of arriving at the `ranges`/`before` pair that pipeline needs. If `new_string` isn't found, it fails clearly and says so (`stage_change records an edit that has ALREADY landed on disk`) rather than staging nothing silently or, worse, staging the wrong span.

The workspace rule, the memory prompt, and the skill file all mention it now, framed consistently as recovery rather than an alternative: `edit_node` stays the one tool to reach for while making an edit; `stage_change` is what to call afterward, only when a file already changed some other way.

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

