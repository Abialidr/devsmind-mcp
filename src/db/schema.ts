export interface DbNode {
  id: string;
  type: string;
  name: string;
  file_path: string;
  signature: string | null;
  deprecated: number;
  created_at: string;
}

export interface DbConnection {
  source_node_id: string;
  target_node_id: string;
}

export interface DbHistory {
  id: string;
  node_id: string;
  session_id: string;
  created_at: string;
  updated_at: string;
  code_snapshot: string;
  reasoning: string;
}

export const INIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  signature   TEXT,
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

-- Index for searching nodes by name and type
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes (name);
CREATE INDEX IF NOT EXISTS idx_history_node_id ON history (node_id);
`;
