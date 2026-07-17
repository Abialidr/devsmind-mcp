# Next Core Features — Implemented (Not Released)

This document tracks the Next Core features that have been successfully implemented in the local repository but have not yet been packaged/released into a public NPM version.

---

## 📈 Phase 1: CLI Reindexing & DB Cache Control

### 1.3. CLI Reindexing Command (`devsmind reindex`)
*   **Goal**: Provide a Quality-of-Life terminal command `devsmind reindex` to synchronize the graph with manual changes made outside of active chat sessions, while enforcing that initial indexing must be complete first.
*   **Implementation Status**: Fully Implemented.
*   **Technical Details**:
    *   **Initial Index Check**: When `devsmind reindex` is run, it checks the database state or the scratchpad status. If the initial index is not yet complete, it fails immediately with: `"Error: Initial indexing has not been completed. Please run 'devsmind index --run' first."`
    *   **Incremental Parsing (Timestamp Filtered)**: Tracks `last_reindex_at` in the `system_meta` table. When running `devsmind reindex`, it scans the repository files and checks for modifications (using file modification times `mtime` newer than `last_reindex_at`). It only re-runs the LLM parser on modified or newly added files, leaving unchanged nodes intact. After successful execution, it updates `last_reindex_at` to the current timestamp.

### system_meta Table Structure
*   **Goal**: Adds a lightweight metadata table `system_meta` to keep track of execution timestamps for incremental processing and caching.
*   **Implementation Status**: Fully Implemented.
*   **Technical Details**:
    ```sql
    CREATE TABLE IF NOT EXISTS system_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    ```

---

## 🩺 Phase 2: Graph Health & Integrity

### 2. Graph Health & Integrity (`devsmind analyze` / `analyze_graph`)
*   **Goal**: Run structural analysis algorithms over the existing SQLite graph (circular dependencies, God entities, orphaned/abandoned nodes) and perform local, token-free cleanup (Git-native rename detection, spurious node checks, soft-delete deprecations) under a single entry point.
*   **Implementation Status**: Fully Implemented (v2.2.4).
*   **Technical Details**:
    *   Shipped as `devsmind analyze` (CLI) and `analyze_graph` (MCP tool), plus `devsmind sync --analyze` and `devsmind start --sync --analyze` for running it as a step of syncing/starting.
    *   **Detections**: God entities (>15 callers/dependencies), DFS-based circular dependency cycles, orphaned/abandoned nodes, spurious/built-in nodes (`promise`, `map`, etc.), Git-native rename detection with cascading id migration across `nodes`/`node_connections`/`history`, dangling edges, duplicate/case-collision node ids, history entries missing developer attribution, empty code snapshots, and git-tracked files with zero graph nodes (detections beyond the original spec).
    *   **Dry-Run vs. Fix Mode**: Default is a read-only summary; `fix: true` (MCP) / `--fix` (CLI) applies soft deprecation (`deprecated = 1` + connection cleanup, history preserved) and rename migrations.
    *   **Deviation from original spec**: the `last_analysis_at` caching optimization (skip re-analysis if nothing changed) was **not** implemented — correctness-first given real dataset sizes; every run computes fresh.
    *   Runs entirely on local SQLite + Git CLI, zero LLM tokens.

---

## 🛡️ Phase 3: Agent Self-Correction

### 3. Enhanced Recent Changes with Downstream Impact (`get_recent_changes` upgrade)
*   **Goal**: Upgrade the existing `get_recent_changes` MCP tool to automatically cross-reference the dependency graph and surface downstream callers that may be affected by recent changes — giving the AI agent a self-correction loop after every edit session.
*   **Implementation Status**: Fully Implemented.
*   **Technical Details**:
    *   **Callers Query**: Runs an additional caller query per modified node inside the existing tool response (`getRecentChanges`).
    *   **Stale Warning Detection**: Surgically flags downstream callers as either `already_updated` (if modified in the same window) or `stale_warning` (requiring validation), allowing the AI to auto-correct and complete updates across the codebase dependency chain.

---

## 🗂️ Phase 4: Workflow Context Vault (Feature Sessions)

### 4. Persistent Feature Memory & Milestones (`workflow_*` tools)
*   **Goal**: Provide long-term institutional memory for the AI across multiple vibe coding sessions spanning days or weeks, so resuming a feature days later doesn't mean re-explaining the journey, decisions, and reference materials from scratch.
*   **Implementation Status**: Fully Implemented (v2.3.0).
*   **Technical Details**:
    *   Shipped as twelve `workflow_*` MCP tools (`workflow_create`, `workflow_add_step`, `workflow_pause`, `workflow_resume`, `workflow_list`, `workflow_get_context`, `workflow_add_artifact`, `workflow_sync_retroactive`, `workflow_import`, `workflow_search`, `workflow_read_artifact`, `workflow_get_steps`) plus `devsmind workflow` and `devsmind workflow-import <path>` (CLI).
    *   **Workflow Steps**: A `workflow_steps` table tracks high-level steps, decisions, and pending tasks. Does **not** duplicate code snapshots — links to existing `history` row ids instead.
    *   **Filesystem Artifacts**: External reference material (PDF extracts, PM docs, web snippets) saved as text files under `.devmind/workflows/<workflow_id>/`; the DB only stores the file path.
    *   **Session Continuity**: `workflow_get_context` returns the full chronological timeline + artifact metadata in one call for instant resume.
    *   **Auto-Step-Logging**: `commit_changes` automatically logs a workflow step from staged entries' reasoning whenever a workflow is active — no separate `workflow_add_step` call needed for the normal case.
    *   **Deviations from the original spec** (both to preserve the zero-external-API-cost design constraint): `workflow_sync_retroactive` takes an already-extracted `steps` array rather than raw `transcript_text` — the calling agent already has the transcript and extracts for free, since DevsMind never makes its own LLM calls. "Proactive AI Guardrails" is implemented as a `workflow_list` tool plus rule/instructions guidance telling the agent to check and ask, not server-side semantic matching.
    *   `workflow_import` (not in the original spec) was added afterward — reads existing hand-written flow docs directly into the vault as paused workflows, idempotent by file name on re-import.
