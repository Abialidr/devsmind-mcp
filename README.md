# DevsMind

[![npm version](https://img.shields.io/npm/v/devsmind-mcp?color=blue)](https://www.npmjs.com/package/devsmind-mcp)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## Give your coding agent a map of your project

DevsMind helps AI coding agents understand a project before they change it. It builds a searchable map of your code, connects symbols to the files and functions around them, and carries useful project context across agent sessions and teammates.

That means an agent can find where a behavior lives, inspect what calls it, see related work already underway, and recover the decisions behind earlier changes. Your team spends less time re-explaining the codebase and less time repeating investigations every time a conversation or agent changes.

DevsMind is a project context layer for coding agents: part code map, part searchable team knowledge, part accountable editing workflow. It is designed to work alongside Git and your existing coding tools.

## Why teams use DevsMind

Codebases hold more than source files. Understanding a change often means finding the right implementation, tracing how it connects to the rest of the app, and learning what the team already tried or decided. That context is easy to lose between tasks, people, and agent conversations.

DevsMind keeps those pieces connected:

- **Understand the shape of the code.** An AST-based graph maps functions, classes, routes, and their relationships, so an agent can inspect a relevant area without loading a whole repository into its prompt.
- **Search code and project context together.** One search can look across graph symbols, source files, and workflow decisions. Semantic and token-based search help with concepts; exact patterns help locate names and code.
- **Continue work with its history attached.** Multi-session workflows collect implementation steps, research, decisions, and relevant documents. Search results can point to the exact step or existing workflow related to a symbol.
- **Make agent edits traceable.** The DevsMind edit flow maps code changes to affected symbols and callers, then records the change with its purpose. Local activity includes whole-file diffs and can be reviewed or reverted.
- **Share team context without crowding code reviews.** The graph and workflows sync on a dedicated `devsmind` Git branch. Your code branch and pull requests stay focused on product changes.
- **Keep working across sessions and teammates.** The shared brain gives each connected agent a durable starting point, so useful discoveries do not depend on one long conversation.

Use DevsMind when an agent is new to a codebase, when work spans multiple sessions, when a feature has prior decisions to recover, or when you want the team to share context without pasting the same explanations into every prompt.

## What DevsMind understands

The code graph is built from TypeScript and JavaScript source, including JSX and TSX. It relates code symbols to their current source, imports, callers, callees, and recent change context. Source is read live when possible, so an agent can inspect the implementation rather than rely only on a saved description.

Search also covers files across configured repositories, including languages outside the core AST graph. Workflows can capture decisions and research for any project area, with links to project documents or attached research files. Writes outside code symbols, such as configuration, stylesheets, and markup, can still be recorded in the local activity timeline.

This separation makes the supported scope clear: TypeScript and JavaScript get the richest structural code map; other files remain searchable and can be included in team workflows.

## How the shared brain works

A project brain lives in `.devsmind/`. Graph data, indexed context, and workflows are shared through a dedicated `devsmind` Git branch. The local SQLite cache, credentials, and personal activity log remain on each machine.

Your agent uses `devsmind_git_sync` to fetch, merge, and publish brain changes. Git works on `.devsmind/` where it already is, through a private index, so a sync copies no files and never touches your checked-out branch, HEAD, or staged changes. Only files that teammates changed are written back. One sync runs per brain at a time; a long sync keeps running in the background and the agent follows it with `devsmind_git_sync_status`, so a client tool timeout cannot interrupt it. Git remains the source control for your application code; DevsMind syncs the project context layer.

## Quick start

Install DevsMind:

```bash
npm install -g devsmind-mcp
```

### Start a brain for a project

Run these commands from the project directory:

```bash
devsmind init
devsmind mcp
devsmind rule        # writes the shared .agents/rules/devsmind.md rule and AGENTS.md pointer for Codex/Gemini
```

Optionally index the codebase to create the initial graph:

```bash
devsmind index --run --provider gemini --key YOUR_GEMINI_KEY
```

For unattended initial indexing or incremental updates, choose a provider with
`devsmind index --run --provider <name>` or `devsmind reindex --provider <name>`.
The same choices are available in `devsmind describe` and `devsmind add-repo`.

| Provider | Setup |
| --- | --- |
| `claude-cli`, `codex-cli`, `agy-cli` | Install and authenticate Claude Code, Codex, or Antigravity CLI. Make the executable available on `PATH`. Pass `--model` to override the CLI's default. |
| `claude` | Set `ANTHROPIC_API_KEY` or pass `--key`. |
| `openai` | Set `OPENAI_API_KEY` or pass `--key`. For another OpenAI-compatible Chat Completions service, set `OPENAI_BASE_URL` or pass its API base with `--url`, and pass its model ID with `--model`. |
| `bedrock` | Configure AWS credentials and region, for example with `AWS_PROFILE` and `AWS_REGION`. Pass a Converse-capable model or inference profile ID with `--model`, or set `BEDROCK_MODEL_ID`. |
| `gemini`, `vertex`, `ollama` | Use your Gemini API key, Vertex credentials, or local Ollama endpoint. |

```bash
devsmind index --run --provider codex-cli
devsmind reindex --provider claude-cli
```

DevsMind handles file discovery, parsing, checkpoints, and graph writes.
It sends candidate code and imports to the selected provider for curation, and
sends code snapshots in batches for description generation. The CLI agents run
headlessly outside the repository. Use `--rpm` to pace provider requests.

Indexing writes straight into your local brain, so there is nothing to import first and no `devsmind sync` step in setup. Share the finished graph with `devsmind_git_sync`.

Commit `.devsmind/config.json` and `.devsmind/.gitignore` to your project branch. Then ask your connected agent to sync the team brain; `devsmind_git_sync` will initialize and publish the shared `devsmind` branch.

### Join an existing brain

Pull the project, then run `devsmind init` to configure local paths and identity. Connect the agent with `devsmind mcp` and `devsmind rule`, then ask it to run `devsmind_git_sync`. It will receive the team's shared context.

## What the agent can do

The DevsMind MCP tools give a connected agent a focused set of project capabilities:

- Search graph nodes, source files, and workflow steps in one call with `search_nodes`.
- Read a symbol's current code together with its callers, callees, file outline, recent history, and associated workflows using `get_node_code`.
- Find related ongoing or past work with `workflow_list`, and inspect the matching decision with `workflow_get_context`.
- Record code edits through `edit_node` and `commit_changes`, attaching the original request and the reason for the change.
- Track research and decisions in a workflow, even when they do not change code.
- Review local activity, diffs, and request-level reverts in `devsmind view`.

## Learn more

- [Changelog](CHANGELOG.md) - release history and the features and fixes added over time.
- [Detailed explanation](detailExplanation.md) - architecture, workflows, commands, MCP tools, and design rationale.

## Team sync and local commands

| Command | What it does |
|---|---|
| `devsmind_git_sync` (MCP) | Fetches, merges, and publishes shared brain data without copying the brain. Runs one sync per brain at a time and continues in the background if it takes long. No DevsMind session ID is needed. |
| `devsmind_git_sync_status` (MCP) | Waits for a running or busy sync and returns its final result. Read-only. |
| `devsmind git-status` | Shows local brain files waiting to sync. Read-only. |
| `devsmind sync` | Rarely needed. Re-imports brain JSON already on disk into the local SQLite cache, for example after files were changed by hand. `devsmind_git_sync` already refreshes the cache and indexing writes it directly. It does not fetch from Git. |
| `devsmind index --run` / `devsmind reindex` | Builds or refreshes the code graph. |
| `devsmind describe` / `devsmind embed` | Adds node descriptions or local semantic vectors. |
| `devsmind analyze [--fix]` | Checks graph health and can repair supported issues. Nodes with no connections are only reported. On a brain that older versions damaged, the first `--fix` also restores nodes that were wrongly marked deprecated. |
| `devsmind prune` | Interactive review and permanent deletion of nodes and history, including every deprecated node. |
| `devsmind view` | Opens the local graph and activity viewer. |
| `devsmind workflow` | Lists and inspects multi-session work. |
| `devsmind style [normal\|lite\|full]` | Sets a personal response style for connected agents; off by default. |

Response style only affects agent chat replies. It does not shorten code, commands, paths, errors, or content recorded in the shared brain.

## Local data and path safety

The brain's shared files live in `.devsmind/`; the SQLite cache, credentials, and activity log are local. Activity can include whole-file diffs for edits that do not map to a code symbol. It is not published to teammates.

DevsMind checks generated paths before writing, importing, or publishing them. `devsmind analyze` reports unsafe generated files; `devsmind analyze --fix` removes them from graph, vector, history, and workflow data. Review the report before using the repair option, especially if it identifies a workflow folder you want to keep.

## License

MIT. See [LICENSE](LICENSE).
