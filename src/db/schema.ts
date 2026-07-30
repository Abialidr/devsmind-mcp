export interface DbNode {
  id: string;
  type: string;
  name: string;
  file_path: string;
  signature: string | null;
  /**
   * A 1-3 sentence natural-language description of what this entity does — the thing a plain
   * identifier can't carry. This is what makes `search_nodes` findable by natural language
   * instead of only by exact identifier/path substring. Null until an agent (or `devsmind
   * describe`) writes one; `commit_changes` refuses to create a NEW node without it.
   */
  description: string | null;
  /**
   * Other names this SAME entity is referenced by — a generated hook (`useGetAdminOrdersQuery`
   * for an RTK `getAdminOrders` endpoint), a renamed default-export import, or an `export { x as
   * y }` re-export. One implementation, several exported handles: this is what lets the edge
   * resolver match a caller against ANY of them instead of only the entity's own declared name,
   * which is the fix for edges that otherwise can't exist because the reference in the code never
   * spells out the original name at all. Empty array, not null, when there are none.
   */
  aliases: string[];
  deprecated: number;
  created_at: string;
}

export interface DbConnection {
  source_node_id: string;
  target_node_id: string;
}

/** One recorded edit within a history entry — what the code looked like either side of it. */
export interface HistoryEdit {
  at: string;
  before: string;
  after: string;
  reasoning: string;
}

export interface DbHistory {
  id: string;
  node_id: string;
  session_id: string;
  created_at: string;
  updated_at: string;
  code_snapshot: string;
  reasoning: string;
  /**
   * Per-edit before/after trail, newest last. Lives only in the history JSON, never in SQLite —
   * same as code_snapshot. Empty for entries written before this existed, and for `stage_change`
   * entries, which have no before-state to record: both mean "no diff, no revert".
   */
  edits: HistoryEdit[];
}

export interface DbWorkflow {
  id: string;
  name: string;
  description: string;
  /** 1 = hidden from the default listing. Replaces the old `status` field: nothing ever genuinely
   * "completes" — a feature keeps getting changed — so a completed/paused/active lifecycle was a
   * value nobody maintained. "Archived" claims only what it can deliver: hide this from the list. */
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface DbWorkflowStep {
  id: string;
  workflow_id: string;
  step_index: number;
  summary: string;
  /** The commit's own `why`/`goal`/`decision`, copied at write time rather than joined from
   * `history`. Deliberate duplication: history reasoning MUTATES after the fact (the 1-hour merge
   * appends under a `── Update @ … ──` separator, and eraseLastEdit can drop a block), so a step
   * that joined to it would describe a moving target — disqualifying for a record whose whole
   * purpose is "what did we think at the time". */
  reasoning: string | null;
  /** JSON array of the node ids this step touched. Replaces `history_ids`, which could not
   * identify a commit: within an hour, two commits on the same node merge into ONE history row,
   * so a step's ids could point at rows an earlier commit created, and one row could be cited by
   * several steps. Node ids have no such ambiguity and are directly usable with get_node_code. */
  node_ids: string | null;
  /** JSON array of repo-relative paths to research/spec docs behind this step. A path, never a
   * copy: the file is already versioned and already shared, so it cannot go stale the way the old
   * `workflow_artifacts` content duplicates did. */
  doc_paths: string | null;
  session_id: string | null;
  created_at: string;
}

export interface DbWorkflowArtifact {
  id: string;
  workflow_id: string;
  step_id: string | null;
  type: string;
  source_name: string;
  file_path: string;
  created_at: string;
}

export const INIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  signature   TEXT,
  description TEXT,
  aliases     TEXT DEFAULT '[]',
  deprecated  INTEGER DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS node_connections (
  source_node_id  TEXT,
  target_node_id  TEXT,
  PRIMARY KEY (source_node_id, target_node_id),
  FOREIGN KEY (source_node_id) REFERENCES nodes (id) ON DELETE CASCADE,
  FOREIGN KEY (target_node_id) REFERENCES nodes (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS history (
  id             TEXT PRIMARY KEY,
  node_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  code_snapshot  TEXT NOT NULL,
  reasoning      TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS system_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Local, derived search index — never synced or committed, purely a cache rebuilt from
-- nodes+history whenever search-index.ts's fingerprint check finds it stale. Same category as
-- brain.db itself: safe to wipe and rebuild from the source of truth at any time.
CREATE TABLE IF NOT EXISTS node_tokens (
  node_id  TEXT NOT NULL,
  token    TEXT NOT NULL,
  field    TEXT NOT NULL,
  tf       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (node_id, token, field)
);
CREATE INDEX IF NOT EXISTS idx_node_tokens_token ON node_tokens (token);

-- Semantic (dense) vectors, one per node, from the vendored ONNX embedder (src/db/embedder.ts).
-- Unlike node_tokens, these ARE synced via git (vectors/**/*.json, mirroring graph/**/*.json) —
-- deliberately, per an explicit product decision to trade repo size for teammates skipping local
-- inference. No foreign key to nodes(id): syncFromDisk() runs its destructive graph pass under
-- foreign_keys=OFF, so a cascade here would silently never fire; orphans are swept explicitly
-- instead (see syncFromDisk's vectors pass). model_id guards the git-sync hazard — vectors from
-- a different embedding model are structurally valid but numerically meaningless, so any reader
-- MUST check model_id before trusting a row, not just check for its presence.
CREATE TABLE IF NOT EXISTS node_vectors (
  node_id          TEXT PRIMARY KEY,
  model_id         TEXT NOT NULL,
  dim              INTEGER NOT NULL,
  description_hash TEXT NOT NULL,
  vector           BLOB NOT NULL
);

-- status is vestigial: still declared (NOT NULL DEFAULT makes an INSERT that omits it succeed)
-- but no longer read or written. archived replaces it -- see DbWorkflow.
CREATE TABLE IF NOT EXISTS workflows (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- pending_tasks and history_ids are vestigial: never written or read by current code, and kept
-- only so an older CLI opening the same brain.db does not hit "no such column". They are dropped
-- from DbWorkflowStep, so nothing in TypeScript can reach them by accident.
CREATE TABLE IF NOT EXISTS workflow_steps (
  id             TEXT PRIMARY KEY,
  workflow_id    TEXT NOT NULL,
  step_index     INTEGER NOT NULL,
  summary        TEXT NOT NULL,
  reasoning      TEXT,
  node_ids       TEXT,
  doc_paths      TEXT,
  pending_tasks  TEXT,
  history_ids    TEXT,
  session_id     TEXT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workflow_id) REFERENCES workflows (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_artifacts (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL,
  step_id       TEXT,
  type          TEXT NOT NULL,
  source_name   TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workflow_id) REFERENCES workflows (id) ON DELETE CASCADE
);

-- Index for searching nodes by name and type
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes (name);
-- Matches getNodesByFilePath's own normalization (REPLACE(LOWER(file_path), '\', '/')) exactly —
-- without this, that call is a full table scan, and get_node_code's file_outline now puts it on
-- the hot path of the most-called read tool (once per call, to cross-reference outline entries
-- against indexed nodes). Idempotent: existing brains pick this up on next open, no migration.
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes (REPLACE(LOWER(file_path), '\', '/'));
-- node_connections' PRIMARY KEY is (source_node_id, target_node_id), so its autoindex serves
-- "what does X use" but NOT the reverse. Every "who uses X" lookup — the inbound half of getGraph's
-- BFS, getConnections' used_by, getConnectionCounts — was therefore a full table scan, and the BFS
-- runs one PER NODE VISITED (up to 500 in a single call). The trailing source_node_id makes this
-- covering, so the inbound query is answered from the index alone and comes back already ordered
-- (which is what makes getGraph's ORDER BY free rather than a sort on top of a scan).
-- Idempotent: existing brains pick this up on next open, no migration.
CREATE INDEX IF NOT EXISTS idx_node_connections_target ON node_connections (target_node_id, source_node_id);
CREATE INDEX IF NOT EXISTS idx_history_node_id ON history (node_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_id ON workflow_steps (workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_workflow_id ON workflow_artifacts (workflow_id);
`;
