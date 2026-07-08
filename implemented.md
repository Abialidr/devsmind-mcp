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

## 🛡️ Phase 3: Agent Self-Correction

### 3. Enhanced Recent Changes with Downstream Impact (`get_recent_changes` upgrade)
*   **Goal**: Upgrade the existing `get_recent_changes` MCP tool to automatically cross-reference the dependency graph and surface downstream callers that may be affected by recent changes — giving the AI agent a self-correction loop after every edit session.
*   **Implementation Status**: Fully Implemented.
*   **Technical Details**:
    *   **Callers Query**: Runs an additional caller query per modified node inside the existing tool response (`getRecentChanges`).
    *   **Stale Warning Detection**: Surgically flags downstream callers as either `already_updated` (if modified in the same window) or `stale_warning` (requiring validation), allowing the AI to auto-correct and complete updates across the codebase dependency chain.
