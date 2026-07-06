import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { INIT_SCHEMA_SQL, DbNode, DbHistory, DbConnection } from './schema';

function compressText(text: string): Buffer {
  return zlib.deflateSync(Buffer.from(text, 'utf-8'));
}

function decompressText(val: any): string {
  if (val instanceof Buffer || Buffer.isBuffer(val)) {
    try {
      return zlib.inflateSync(val).toString('utf-8');
    } catch {
      return val.toString('utf-8');
    }
  }
  return String(val);
}

export interface ReasoningObject {
  what_changed: string;
  why: string;
  goal: string;
  requirement?: string;
  previous_state?: string;
  decision?: string;
  developer?: string;
  model?: string;
}

export function formatReasoning(r: string | ReasoningObject): string {
  if (typeof r === 'string') {
    return r;
  }
  const lines = [
    `What changed: ${r.what_changed || ''}`,
    `Why: ${r.why || ''}`,
    `Goal: ${r.goal || ''}`,
    `Requirement: ${r.requirement || ''}`,
    `Previous state: ${r.previous_state || ''}`,
    `Decision: ${r.decision || ''}`,
    `Developer: ${r.developer || ''}`,
    `Model: ${r.model || ''}`
  ];
  return lines.join('\n');
}

export class DevMindDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Open SQLite database
    this.db = new Database(dbPath);
    
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');
    
    // Initialize schema
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(INIT_SCHEMA_SQL);
    try {
      this.db.exec('ALTER TABLE nodes ADD COLUMN deprecated INTEGER DEFAULT 0');
    } catch {
      // Column already exists, ignore
    }
  }

  close() {
    this.db.close();
  }

  vacuum() {
    try {
      this.db.exec('VACUUM');
    } catch (err) {
      console.warn('⚠️ SQLite VACUUM failed:', err);
    }
  }

  // --- Node Operations ---

  upsertNode(node: { id: string; type: string; name: string; file_path: string; signature?: string | null }) {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, type, name, file_path, signature)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        name = excluded.name,
        file_path = excluded.file_path,
        signature = COALESCE(excluded.signature, nodes.signature),
        deprecated = 0
    `);
    stmt.run(node.id, node.type, node.name, node.file_path, node.signature || null);
  }

  getNode(id: string): DbNode | null {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    return (stmt.get(id) as DbNode) || null;
  }

  deleteNode(id: string) {
    const stmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    stmt.run(id);
  }

  deprecateNode(id: string) {
    const updateStmt = this.db.prepare('UPDATE nodes SET deprecated = 1 WHERE id = ?');
    const deleteConnStmt = this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ? OR target_node_id = ?');
    const tx = this.db.transaction(() => {
      updateStmt.run(id);
      deleteConnStmt.run(id, id);
    });
    tx();
  }

  renameNode(oldId: string, newId: string, newName?: string) {
    const node = this.getNode(oldId);
    if (!node) {
      throw new Error(`Node not found: ${oldId}`);
    }

    const name = newName || (node.name === oldId ? newId : node.name);

    this.db.pragma('foreign_keys = OFF');

    try {
      const runTx = this.db.transaction(() => {
        const insertStmt = this.db.prepare(`
          INSERT INTO nodes (id, type, name, file_path, signature, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        insertStmt.run(newId, node.type, name, node.file_path, node.signature, node.created_at);

        const updateSourceStmt = this.db.prepare(`
          UPDATE node_connections SET source_node_id = ? WHERE source_node_id = ?
        `);
        updateSourceStmt.run(newId, oldId);

        const updateTargetStmt = this.db.prepare(`
          UPDATE node_connections SET target_node_id = ? WHERE target_node_id = ?
        `);
        updateTargetStmt.run(newId, oldId);

        const updateHistoryStmt = this.db.prepare(`
          UPDATE history SET node_id = ? WHERE node_id = ?
        `);
        updateHistoryStmt.run(newId, oldId);

        const deleteOldStmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
        deleteOldStmt.run(oldId);
      });

      runTx();
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  // --- Connection Operations ---

  addConnection(sourceNodeId: string, targetNodeId: string) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO node_connections (source_node_id, target_node_id)
      VALUES (?, ?)
    `);
    stmt.run(sourceNodeId, targetNodeId);
  }

  removeConnection(sourceNodeId: string, targetNodeId: string) {
    const stmt = this.db.prepare(`
      DELETE FROM node_connections
      WHERE source_node_id = ? AND target_node_id = ?
    `);
    stmt.run(sourceNodeId, targetNodeId);
  }

  getConnections(nodeId: string): { uses: DbNode[]; usedBy: DbNode[] } {
    const usesStmt = this.db.prepare(`
      SELECT n.* FROM nodes n
      JOIN node_connections c ON n.id = c.target_node_id
      WHERE c.source_node_id = ?
    `);
    const usedByStmt = this.db.prepare(`
      SELECT n.* FROM nodes n
      JOIN node_connections c ON n.id = c.source_node_id
      WHERE c.target_node_id = ?
    `);

    return {
      uses: usesStmt.all(nodeId) as DbNode[],
      usedBy: usedByStmt.all(nodeId) as DbNode[]
    };
  }

  // --- History Operations ---

  getLatestHistory(nodeId: string): DbHistory | null {
    const stmt = this.db.prepare(`
      SELECT * FROM history
      WHERE node_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    const row = stmt.get(nodeId) as any;
    if (!row) return null;
    return {
      ...row,
      code_snapshot: decompressText(row.code_snapshot),
      reasoning: decompressText(row.reasoning)
    };
  }

  listHistory(nodeId: string): Omit<DbHistory, 'code_snapshot' | 'reasoning'>[] {
    const stmt = this.db.prepare(`
      SELECT id, node_id, session_id, created_at, updated_at
      FROM history
      WHERE node_id = ?
      ORDER BY updated_at DESC
    `);
    return stmt.all(nodeId) as Omit<DbHistory, 'code_snapshot' | 'reasoning'>[];
  }

  getHistoryEntry(id: string): DbHistory | null {
    const stmt = this.db.prepare('SELECT * FROM history WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      ...row,
      code_snapshot: decompressText(row.code_snapshot),
      reasoning: decompressText(row.reasoning)
    };
  }

  getFullHistory(nodeId: string): DbHistory[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM history
      WHERE node_id = ?
      ORDER BY updated_at DESC
    `);
    const rows = stmt.all(nodeId) as any[];
    return rows.map(row => ({
      ...row,
      code_snapshot: decompressText(row.code_snapshot),
      reasoning: decompressText(row.reasoning)
    }));
  }

  getLatestCode(nodeId: string): { code_snapshot: string; updated_at: string } | null {
    const stmt = this.db.prepare(`
      SELECT code_snapshot, updated_at
      FROM history
      WHERE node_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    const row = stmt.get(nodeId) as any;
    if (!row) return null;
    return {
      updated_at: row.updated_at,
      code_snapshot: decompressText(row.code_snapshot)
    };
  }


  getGraph(nodeId: string, maxDepth: number = 6): { nodes: DbNode[]; connections: DbConnection[] } {
    const maxNodesLimit = 500;
    const visited = new Set<string>();
    const queue: { id: string; depth: number }[] = [{ id: nodeId, depth: 0 }];
    const nodes: DbNode[] = [];
    const connections: DbConnection[] = [];
    const connSet = new Set<string>();

    const rootNode = this.getNode(nodeId);
    if (!rootNode) {
      return { nodes, connections };
    }

    visited.add(nodeId);
    nodes.push(rootNode);

    const usesStmt = this.db.prepare(`
      SELECT target_node_id FROM node_connections WHERE source_node_id = ?
    `);
    const usedByStmt = this.db.prepare(`
      SELECT source_node_id FROM node_connections WHERE target_node_id = ?
    `);

    while (queue.length > 0 && nodes.length < maxNodesLimit) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) {
        continue;
      }

      // Get outbound connections (what this node uses)
      const outbound = usesStmt.all(current.id) as { target_node_id: string }[];
      for (const row of outbound) {
        const targetId = row.target_node_id;
        const connKey = `${current.id}->${targetId}`;
        if (!connSet.has(connKey)) {
          connSet.add(connKey);
          connections.push({ source_node_id: current.id, target_node_id: targetId });
        }
        if (!visited.has(targetId)) {
          visited.add(targetId);
          const targetNode = this.getNode(targetId);
          if (targetNode) {
            nodes.push(targetNode);
            if (nodes.length >= maxNodesLimit) break;
          }
          queue.push({ id: targetId, depth: current.depth + 1 });
        }
      }

      if (nodes.length >= maxNodesLimit) break;

      // Get inbound connections (what uses this node)
      const inbound = usedByStmt.all(current.id) as { source_node_id: string }[];
      for (const row of inbound) {
        const sourceId = row.source_node_id;
        const connKey = `${sourceId}->${current.id}`;
        if (!connSet.has(connKey)) {
          connSet.add(connKey);
          connections.push({ source_node_id: sourceId, target_node_id: current.id });
        }
        if (!visited.has(sourceId)) {
          visited.add(sourceId);
          const sourceNode = this.getNode(sourceId);
          if (sourceNode) {
            nodes.push(sourceNode);
            if (nodes.length >= maxNodesLimit) break;
          }
          queue.push({ id: sourceId, depth: current.depth + 1 });
        }
      }
    }

    return { nodes, connections };
  }

  updateHistory(params: {
    node_id: string;
    code_snapshot: string;
    reasoning: string | ReasoningObject;
    session_id?: string;
  }): DbHistory {
    const { node_id, code_snapshot, reasoning } = params;
    const formattedReasoning = formatReasoning(reasoning);
    const nowStr = new Date().toISOString();

    const compressedCode = compressText(code_snapshot);

    // 1-hour session boundary rule check
    const latest = this.getLatestHistory(node_id);
    if (latest) {
      const lastUpdate = new Date(latest.updated_at).getTime();
      const nowTime = new Date(nowStr).getTime();
      const diffMs = nowTime - lastUpdate;

      // If updated < 1 hour ago, update same record
      if (diffMs < 3600000) {
        const updateStmt = this.db.prepare(`
          UPDATE history
          SET code_snapshot = ?, reasoning = ?, updated_at = ?
          WHERE id = ?
        `);
        updateStmt.run(compressedCode, formattedReasoning, nowStr, latest.id);
        
        return {
          ...latest,
          code_snapshot,
          reasoning: formattedReasoning,
          updated_at: nowStr
        };
      }
    }

    // Otherwise (or if no record exists), insert new history block
    const newId = crypto.randomUUID();
    const sessionId = params.session_id || crypto.randomUUID();

    const insertStmt = this.db.prepare(`
      INSERT INTO history (id, node_id, session_id, created_at, updated_at, code_snapshot, reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(newId, node_id, sessionId, nowStr, nowStr, compressedCode, formattedReasoning);

    return {
      id: newId,
      node_id,
      session_id: sessionId,
      created_at: nowStr,
      updated_at: nowStr,
      code_snapshot,
      reasoning: formattedReasoning
    };
  }

  // --- Search Operations ---

  searchNodes(query: string): DbNode[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT n.* FROM nodes n
      LEFT JOIN history h ON n.id = h.node_id
      WHERE n.name LIKE ? OR n.id LIKE ? OR h.reasoning LIKE ?
      LIMIT 50
    `);
    const wildcard = `%${query}%`;
    return stmt.all(wildcard, wildcard, wildcard) as DbNode[];
  }

  getRecentChanges(hours: number = 24): { node_id: string; node_name: string; file_path: string; updated_at: string; reasoning: string }[] {
    const stmt = this.db.prepare(`
      SELECT h.node_id, n.name as node_name, n.file_path, h.updated_at, h.reasoning
      FROM history h
      JOIN nodes n ON h.node_id = n.id
      WHERE h.updated_at >= datetime('now', ?)
      ORDER BY h.updated_at DESC
    `);
    // SQLite datetime('now', '-24 hours') style modifier
    return stmt.all(`-${hours} hours`) as { node_id: string; node_name: string; file_path: string; updated_at: string; reasoning: string }[];
  }

  getDeveloperActivity(developer: string, limit: number = 50): { node_id: string; node_name: string; updated_at: string; reasoning: string }[] {
    const stmt = this.db.prepare(`
      SELECT h.node_id, n.name as node_name, h.updated_at, h.reasoning
      FROM history h
      JOIN nodes n ON h.node_id = n.id
      WHERE h.reasoning LIKE ?
      ORDER BY h.updated_at DESC
      LIMIT ?
    `);
    const query = `%Developer: %${developer}%`;
    return stmt.all(query, limit) as { node_id: string; node_name: string; updated_at: string; reasoning: string }[];
  }

  getChangesByRequirement(requirementId: string): { node_id: string; node_name: string; updated_at: string; reasoning: string }[] {
    const stmt = this.db.prepare(`
      SELECT h.node_id, n.name as node_name, h.updated_at, h.reasoning
      FROM history h
      JOIN nodes n ON h.node_id = n.id
      WHERE h.reasoning LIKE ?
      ORDER BY h.updated_at DESC
    `);
    const query = `%Requirement: %${requirementId}%`;
    return stmt.all(query) as { node_id: string; node_name: string; updated_at: string; reasoning: string }[];
  }

  searchDecisions(query: string): { node_id: string; node_name: string; updated_at: string; reasoning: string }[] {
    const stmt = this.db.prepare(`
      SELECT h.node_id, n.name as node_name, h.updated_at, h.reasoning
      FROM history h
      JOIN nodes n ON h.node_id = n.id
      WHERE h.reasoning LIKE ?
      ORDER BY h.updated_at DESC
    `);
    const wildcard = `%Decision: %${query}%`;
    return stmt.all(wildcard) as { node_id: string; node_name: string; updated_at: string; reasoning: string }[];
  }

  getOrphanedNodes(): DbNode[] {
    const stmt = this.db.prepare(`
      SELECT * FROM nodes
      WHERE id NOT IN (SELECT DISTINCT source_node_id FROM node_connections)
        AND id NOT IN (SELECT DISTINCT target_node_id FROM node_connections)
    `);
    return stmt.all() as DbNode[];
  }

  getAllNodes(): DbNode[] {
    const stmt = this.db.prepare('SELECT * FROM nodes');
    return stmt.all() as DbNode[];
  }

  listNodes(filter?: { type?: string; file_path?: string; include_deprecated?: boolean }): DbNode[] {
    let sql = 'SELECT * FROM nodes WHERE 1=1';
    const params: any[] = [];

    if (filter?.type) {
      sql += ' AND type = ?';
      params.push(filter.type);
    }

    if (filter?.file_path) {
      sql += ' AND file_path LIKE ?';
      params.push(`%${filter.file_path}%`);
    }

    if (!filter?.include_deprecated) {
      sql += ' AND deprecated = 0';
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as DbNode[];
  }

  getAllConnections(): DbConnection[] {
    const stmt = this.db.prepare('SELECT * FROM node_connections');
    return stmt.all() as DbConnection[];
  }

  getAllHistory(): DbHistory[] {
    const stmt = this.db.prepare('SELECT * FROM history ORDER BY updated_at DESC');
    const rows = stmt.all() as any[];
    return rows.map(row => ({
      ...row,
      code_snapshot: decompressText(row.code_snapshot),
      reasoning: decompressText(row.reasoning)
    }));
  }

  pruneSpuriousNodes(workspaceRoot: string): { prunedCount: number; prunedNodes: string[] } {
    const spuriousNames = new Set([
      'promise', 'map', 'set', 'json', 'console', 'error', 'object', 'function', 'array', 'string', 'number', 'boolean', 'regexp', 'date', 'math',
      'any', 'void', 'unknown', 'never', 'null', 'undefined', 'dict', 'list'
    ]);

    // Get nodes with 0 history entries that are not already deprecated
    const stmt = this.db.prepare(`
      SELECT id, name, file_path FROM nodes
      WHERE deprecated = 0 AND id NOT IN (SELECT DISTINCT node_id FROM history)
    `);
    const candidates = stmt.all() as { id: string; name: string; file_path: string }[];

    const idsToDelete: string[] = [];
    const namesDeleted: string[] = [];

    for (const node of candidates) {
      const lowerName = node.name.toLowerCase();
      
      // 1. Check if name is in the spurious list
      const isSpurious = spuriousNames.has(lowerName);

      // 2. Check if file path does not exist on disk
      let fileMissing = false;
      if (node.file_path) {
        const resolvedPath = path.isAbsolute(node.file_path)
          ? node.file_path
          : path.resolve(workspaceRoot, node.file_path);
        
        if (!fs.existsSync(resolvedPath)) {
          fileMissing = true;
        }
      }

      if (isSpurious || fileMissing) {
        idsToDelete.push(node.id);
        namesDeleted.push(`${node.name} (${node.id})`);
      }
    }

    if (idsToDelete.length > 0) {
      const updateStmt = this.db.prepare('UPDATE nodes SET deprecated = 1 WHERE id = ?');
      const deleteConnStmt = this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ? OR target_node_id = ?');
      const deprecateTx = this.db.transaction((ids: string[]) => {
        for (const id of ids) {
          updateStmt.run(id);
          deleteConnStmt.run(id, id);
        }
      });
      deprecateTx(idsToDelete);
    }

    return {
      prunedCount: idsToDelete.length,
      prunedNodes: namesDeleted
    };
  }
}
