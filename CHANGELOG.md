# Changelog (compact)

> Full prose version with rationale for each change: [detailExplanation.md § Changelog](detailExplanation.md#changelog). This file is the scan-fast version — one line per change.

## 2.4.0 — `edit_node`: one write path for every file
- New: `edit_node` MCP tool — a single `file_path` + `old_string` + `new_string` + `reasoning` call edits ANY file (never refuses a file type, unlike `stage_change`) and works out which function/class the edit actually landed in, recording it automatically — no `node_id` lookup, no `code_snapshot` echo, no separate `stage_change` call for TS/JS/JSX/TSX/Vue/Svelte. Also creates brand-new files (`old_string: ""`). `stage_change` is now scoped to what `edit_node` can't trace: languages with no local parser (Python, Go, Java, C#, Ruby, PHP, Rust, Swift, Kotlin, Dart).
- Fix (data corruption): the startup path-healer in `syncFromDisk` only recognized `C:`/POSIX paths as "already absolute" — every node's `file_path` on a `D:` drive or a UNC path (`\\server\share\...`) was silently rewritten to the `.devmind` folder path, on every server restart.
- Fix (data corruption): `rename_node` given a bare/unqualified id (the exact form every read tool accepts, e.g. `get_node_code`) silently left the OLD node's history/edges in place and created an empty, disconnected node under the new id — the rename reported success but didn't actually move anything.
- Fix: required string arguments across all 35 tools are now validated before use — a forgotten field now errors with a clear message instead of silently persisting the literal 9-character string `"undefined"` as real data (found via `workflow_create`/`workflow_add_step`, generalized to every tool).
- Fix: `edit_node`/`stage_change` could write to DevsMind's own `.devmind/` directory (config, brain.db, cached graph JSON) — the path-allowlist check computed the wrong root. Now explicitly excluded.
- Fix: `workflow_sync_retroactive` duplicated every step on a retry with an identical payload — now idempotent, matching `workflow_import`'s existing behavior.
- Fix: `search_nodes`, `workflow_search`, and `list_nodes`'s `file_path` filter had unescaped SQL `LIKE` wildcards (a literal `%`/`_` in a real query matched everything) and/or unnormalized path slashes (a forward-slash filter silently matched nothing on Windows).
- Fix: `devsmind analyze` reported real, correctly-indexed files as "untracked" on Windows due to a drive-letter case mismatch — same bug class fixed for `getNodesByFilePath` last release, not previously applied here.
- Fix: `devsmind init` exited 0 with no output under a non-interactive shell instead of failing clearly (now matches `mcp`/`memory`'s existing guard); `devsmind prune` swallowed its own errors so a failure during pruning still exited 0.
- Fix: corrupted (mojibake) emoji/arrow and em-dash characters in `server.ts`, including inside tool-description text sent to every AI model on every session.
- **Action needed:** re-run `devsmind rule` (and `devsmind memory` if you seeded it) — the workspace contract now teaches `edit_node` as the primary write path.

## 2.3.0 — Workflow Context Vault + graph health check
- New: 9 `workflow_*` MCP tools + `devsmind workflow` + `devsmind workflow-import` — persistent, git-shared timeline for multi-day features.
- New: `commit_changes` now auto-records a workflow step when a workflow is active — no separate `workflow_add_step` call needed for the normal case, so the agent can't forget it on a long session the way it could forget a second tool call. `workflow_add_step` is still available for anything a commit doesn't cover (a decision with no code change, a `pending_tasks` note).
- New: `workflow_search`, `workflow_read_artifact`, `workflow_get_steps` (paginated) for cheap reads on large workflows.
- New: `devsmind analyze` / `analyze_graph` — zero-AI local health check (god entities, cycles, orphans, dangling edges, dupe ids, missing attribution, empty snapshots, renames). `--fix` applies only safe/reversible fixes.
- New: `devsmind sync --analyze` and `devsmind start --sync --analyze` chaining.
- Fix: Windows drive-casing bugs that could delete/misplace graph JSON files; added a startup self-heal migration.
- Fix: history was attributed to the AI's own name instead of the configured developer from `.env`.
- Fix: orphan-node query was including already-deprecated nodes.
- Fix: same-session history updates (<1hr, same node) overwrote `reasoning` instead of appending it — an earlier commit's "why" within that hour was silently destroyed by a later one on the same node, which also meant two workflow steps pointing at the same history row could end up citing content that never matched what they originally recorded. `reasoning` is now appended (timestamped) on each same-session update instead of replaced; `code_snapshot` still just holds the latest state, since Git already owns code version history.
- `devsmind sync` is now full two-way (disk↔db), not just disk→db.

## 2.2.2 — `devsmind memory`
- New: seeds each tool's own persistent agent-memory/skills store where confirmed safe (Claude Code, Antigravity). Prints honest "not safe" guidance everywhere else instead of a silent no-op.

## 2.2.1 — Search fallback + rule rewrite
- `search_nodes` now auto-falls-back to code-content search (folds in the old `search_code`).
- MCP `instructions` field now carries the core workflow contract server-side, independent of a pasted rule file.
- `stage_change` now rejects non-source files (was previously unguarded).
- **Action needed:** re-run `devsmind rule`.

## 2.2.0 — Guided setup commands
- New: `devsmind mcp` — guided, per-tool MCP connection setup (print or auto-write).
- New: `devsmind sync` — force-load committed graph into local `brain.db` (fixes stdio tools not picking up teammates' changes).
- `devsmind rule` now offers to write the rule file directly, not just print it.
- New: interactive folder navigator wherever the CLI asks for a path.

## 2.1.1 — Live source reads
- `get_node_code` now reads live from disk instead of a cached snapshot (was serving stale code on 87% of sampled nodes in one test brain).
- New: `snapshot_outdated` / `source: "cached"` drift flags.
- `get_node_graph` + `include_code: true` returns a whole call flow with source in one call (~21 turns → ~2).
- **Action needed:** re-run `devsmind rule`.

## 2.1.0 — Stage/commit model
- New: `stage_change` + `commit_changes` replace `add_node`/`add_connection` — buffer changes, then flush + auto-resolve all edges via local AST in one pass.
- Edge accuracy ~45% → ~90%, node extraction ~58% → ~92% (internal testing, iterative fixes).
- New: `--rpm` opt-in throttling; `--fill-gaps` for `reindex`.

## 2.0.5 — Local edge resolution
- Connection resolution moved fully local (AST for TS/JS, regex for others) — free, instant, offline.
- New: `--chunk-size` / `--chunk-overlap` flags.

## 2.0.0 — Git-friendly storage (breaking)
- Code snapshots + reasoning moved out of `brain.db` into `.devmind/history/*.json` and `.devmind/graph/**/*.json` — fixes Git binary merge conflicts.
- `brain.db` is now a disposable metadata-only cache, auto-rebuilt from JSON on startup.

## 1.x — Foundations
- 1.2.2: Node v24 support, robust LLM JSON parsing.
- 1.2.1: Vertex AI provider; config browser fixes.
- 1.2.0: Interactive tree-based config browser for `devsmind init`.
- 1.1.0: Native background `index --run` (moved indexing out of chat token budget).
- 1.0.0: Initial release — core MCP toolset, `devsmind prune`, first README.

---

*Versions before 1.0.0 or without user-facing behavior change are omitted here — see [README.md](README.md) for the complete list.*
