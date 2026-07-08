import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { INIT_SCHEMA_SQL, DbNode, DbHistory, DbConnection } from './schema';
import { loadProjectContext, resolveRepoPath, ProjectContext } from '../utils/config';

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
  private dbPath: string;
  private context: ProjectContext | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    // Open SQLite database
    this.db = new Database(dbPath);
    
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');
    
    // Initialize schema
    this.initSchema();

    // Load project context from .devmind directory path
    try {
      this.context = loadProjectContext(path.dirname(dbPath));
    } catch (err) {
      // Ignore context errors (e.g. running from scratch scripts)
    }

    // Auto-sync history and graph from disk JSONs
    this.syncFromDisk();
  }

  private initSchema() {
    this.db.exec(INIT_SCHEMA_SQL);
    try {
      this.db.exec('ALTER TABLE nodes ADD COLUMN deprecated INTEGER DEFAULT 0');
    } catch {
      // Column already exists, ignore
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  getSystemMeta(key: string): string | null {
    try {
      const stmt = this.db.prepare('SELECT value FROM system_meta WHERE key = ?');
      const row = stmt.get(key) as { value: string } | undefined;
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  setSystemMeta(key: string, value: string) {
    const stmt = this.db.prepare(`
      INSERT INTO system_meta (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(key, value, value);
  }

  getNodesByFilePath(filePath: string): DbNode[] {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE file_path = ? AND deprecated = 0');
    return stmt.all(filePath) as DbNode[];
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
    const existing = this.getNode(node.id);
    if (existing) {
      let finalPath = existing.file_path;
      const paths = existing.file_path.split(',').map(p => p.trim()).filter(Boolean);
      const incoming = node.file_path.trim();
      if (!paths.includes(incoming)) {
        paths.push(incoming);
        finalPath = paths.join(', ');
      }

      const stmt = this.db.prepare(`
        UPDATE nodes
        SET type = ?,
            name = ?,
            file_path = ?,
            signature = COALESCE(?, signature),
            deprecated = 0
        WHERE id = ?
      `);
      stmt.run(node.type, node.name, finalPath, node.signature || null, node.id);
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO nodes (id, type, name, file_path, signature)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(node.id, node.type, node.name, node.file_path, node.signature || null);
    }
    this.writeGraphToDisk(node.file_path);
  }

  getNode(id: string): DbNode | null {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    const direct = stmt.get(id) as DbNode;
    if (direct) return direct;

    if (!id.includes('#')) {
      const suffixStmt = this.db.prepare('SELECT * FROM nodes WHERE id LIKE ? AND deprecated = 0');
      const matches = suffixStmt.all(`%#${id}`) as DbNode[];
      if (matches.length === 1) {
        return matches[0];
      }
    }
    return null;
  }

  deleteNode(id: string) {
    const node = this.getNode(id);
    const resolvedId = node ? node.id : id;
    const stmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    stmt.run(resolvedId);
    if (node && node.file_path) {
      this.writeGraphToDisk(node.file_path);
    }
  }

  deprecateNode(id: string) {
    const node = this.getNode(id);
    const resolvedId = node ? node.id : id;
    const updateStmt = this.db.prepare('UPDATE nodes SET deprecated = 1 WHERE id = ?');
    const deleteConnStmt = this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ? OR target_node_id = ?');
    const tx = this.db.transaction(() => {
      updateStmt.run(resolvedId);
      deleteConnStmt.run(resolvedId, resolvedId);
    });
    tx();
    if (node && node.file_path) {
      this.writeGraphToDisk(node.file_path);
    }
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
      if (node.file_path) {
        this.writeGraphToDisk(node.file_path);
      }
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  // --- Connection Operations ---

  addConnection(sourceNodeId: string, targetNodeId: string) {
    const srcNode = this.getNode(sourceNodeId);
    const tgtNode = this.getNode(targetNodeId);
    const resolvedSrc = srcNode ? srcNode.id : sourceNodeId;
    const resolvedTgt = tgtNode ? tgtNode.id : targetNodeId;
    
    this.db.pragma('foreign_keys = OFF');
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO node_connections (source_node_id, target_node_id)
        VALUES (?, ?)
      `);
      stmt.run(resolvedSrc, resolvedTgt);
      if (srcNode && srcNode.file_path) {
        this.writeGraphToDisk(srcNode.file_path);
      }
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  removeConnection(sourceNodeId: string, targetNodeId: string) {
    const srcNode = this.getNode(sourceNodeId);
    const tgtNode = this.getNode(targetNodeId);
    const resolvedSrc = srcNode ? srcNode.id : sourceNodeId;
    const resolvedTgt = tgtNode ? tgtNode.id : targetNodeId;
    const stmt = this.db.prepare(`
      DELETE FROM node_connections
      WHERE source_node_id = ? AND target_node_id = ?
    `);
    stmt.run(resolvedSrc, resolvedTgt);
    if (srcNode && srcNode.file_path) {
      this.writeGraphToDisk(srcNode.file_path);
    }
  }

  getConnections(nodeId: string): { uses: DbNode[]; usedBy: DbNode[] } {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
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
      uses: usesStmt.all(resolvedId) as DbNode[],
      usedBy: usedByStmt.all(resolvedId) as DbNode[]
    };
  }

  // --- History Operations ---

  getLatestHistory(nodeId: string): DbHistory | null {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const stmt = this.db.prepare(`
      SELECT id, node_id, session_id, created_at, updated_at FROM history
      WHERE node_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    const row = stmt.get(resolvedId) as any;
    if (!row) return null;
    return this.populateHistoryFromDisk(row);
  }

  listHistory(nodeId: string): Omit<DbHistory, 'code_snapshot' | 'reasoning'>[] {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const stmt = this.db.prepare(`
      SELECT id, node_id, session_id, created_at, updated_at
      FROM history
      WHERE node_id = ?
      ORDER BY updated_at DESC
    `);
    return stmt.all(resolvedId) as Omit<DbHistory, 'code_snapshot' | 'reasoning'>[];
  }

  getHistoryEntry(id: string): DbHistory | null {
    const stmt = this.db.prepare('SELECT id, node_id, session_id, created_at, updated_at FROM history WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return this.populateHistoryFromDisk(row);
  }

  getFullHistory(nodeId: string): DbHistory[] {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const stmt = this.db.prepare(`
      SELECT id, node_id, session_id, created_at, updated_at
      FROM history
      WHERE node_id = ?
      ORDER BY updated_at DESC
    `);
    const rows = stmt.all(resolvedId) as any[];
    return rows.map(row => this.populateHistoryFromDisk(row));
  }

  getLatestCode(nodeId: string): { code_snapshot: string; updated_at: string } | null {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const history = this.getLatestHistory(resolvedId);
    if (!history) return null;
    return {
      updated_at: history.updated_at,
      code_snapshot: history.code_snapshot
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
    const node = this.getNode(node_id);
    const resolvedId = node ? node.id : node_id;
    const formattedReasoning = formatReasoning(reasoning);
    const nowStr = new Date().toISOString();

    const compressedCode = compressText(code_snapshot);

    // 1-hour session boundary rule check
    const latest = this.getLatestHistory(resolvedId);
    if (latest) {
      const lastUpdate = new Date(latest.updated_at).getTime();
      const nowTime = new Date(nowStr).getTime();
      const diffMs = nowTime - lastUpdate;

      // If updated < 1 hour ago, update same record
      if (diffMs < 3600000) {
        const updateStmt = this.db.prepare(`
          UPDATE history
          SET code_snapshot = '', reasoning = '', updated_at = ?
          WHERE id = ?
        `);
        updateStmt.run(nowStr, latest.id);
        
        // Write/Update on disk
        this.writeHistoryToDisk(latest.id, resolvedId, latest.session_id, latest.created_at, nowStr, code_snapshot, formattedReasoning);

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
      VALUES (?, ?, ?, ?, ?, '', '')
    `);
    insertStmt.run(newId, resolvedId, sessionId, nowStr, nowStr);

    // Write to disk
    this.writeHistoryToDisk(newId, resolvedId, sessionId, nowStr, nowStr, code_snapshot, formattedReasoning);

    return {
      id: newId,
      node_id: resolvedId,
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

  getRecentChanges(hours: number = 24, analyzeImpact: boolean = true): {
    node_id: string;
    node_name: string;
    file_path: string;
    updated_at: string;
    reasoning: string;
    downstream_impact?: {
      node_id: string;
      node_name: string;
      file_path: string;
      status: 'stale_warning' | 'already_updated';
    }[];
  }[] {
    const stmt = this.db.prepare(`
      SELECT h.node_id, n.name as node_name, n.file_path, h.updated_at, h.reasoning
      FROM history h
      JOIN nodes n ON h.node_id = n.id
      WHERE h.updated_at >= datetime('now', ?)
      ORDER BY h.updated_at DESC
    `);
    const recentChanges = stmt.all(`-${hours} hours`) as any[];

    if (!analyzeImpact) {
      return recentChanges;
    }

    const modifiedSet = new Set(recentChanges.map(c => c.node_id));

    const callersStmt = this.db.prepare(`
      SELECT n.id as node_id, n.name as node_name, n.file_path
      FROM nodes n
      JOIN node_connections c ON n.id = c.source_node_id
      WHERE c.target_node_id = ?
    `);

    for (const change of recentChanges) {
      const callers = callersStmt.all(change.node_id) as any[];
      change.downstream_impact = callers.map(caller => ({
        node_id: caller.node_id,
        node_name: caller.node_name,
        file_path: caller.file_path,
        status: modifiedSet.has(caller.node_id) ? 'already_updated' : 'stale_warning'
      }));
    }

    return recentChanges;
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
      'any', 'void', 'unknown', 'never', 'null', 'undefined', 'dict', 'list',
      'data', 'useeffect', 'val', 'temp', 'result', 'item', 'key', 'value', 'err', 'req', 'res', 'args', 'params', 'response', 'request'
    ]);

    // Get all active nodes (including those with history) to check for missing files or spurious names
    const stmt = this.db.prepare(`
      SELECT id, name, file_path FROM nodes
      WHERE deprecated = 0
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
        const paths = node.file_path.split(',').map(p => p.trim()).filter(Boolean);
        if (paths.length > 0) {
          const allMissing = paths.every(p => {
            const resolvedPath = path.isAbsolute(p)
              ? p
              : path.resolve(workspaceRoot, p);
            return !fs.existsSync(resolvedPath);
          });
          if (allMissing) {
            fileMissing = true;
          }
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
      const deleteHistoryStmt = this.db.prepare('DELETE FROM history WHERE node_id = ?');
      const deprecateTx = this.db.transaction((ids: string[]) => {
        for (const id of ids) {
          updateStmt.run(id);
          deleteConnStmt.run(id, id);
          deleteHistoryStmt.run(id);
        }
      });
      deprecateTx(idsToDelete);
    }

    return {
      prunedCount: idsToDelete.length,
      prunedNodes: namesDeleted
    };
  }

  private populateHistoryFromDisk(row: any): DbHistory {
    try {
      const historyDir = path.join(path.dirname(this.dbPath), 'history');
      const filePath = path.join(historyDir, `${row.id}.json`);
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return {
          ...row,
          code_snapshot: data.code_snapshot || '',
          reasoning: typeof data.reasoning === 'string' ? data.reasoning : formatReasoning(data.reasoning || '')
        };
      }
    } catch (err) {
      // ignore errors
    }
    return {
      ...row,
      code_snapshot: '',
      reasoning: ''
    };
  }

  private writeHistoryToDisk(
    id: string,
    nodeId: string,
    sessionId: string,
    createdAt: string,
    updatedAt: string,
    codeSnapshot: string,
    reasoning: string
  ) {
    try {
      const historyDir = path.join(path.dirname(this.dbPath), 'history');
      if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir, { recursive: true });
      }

      const node = this.getNode(nodeId);
      const nodeMetadata = node ? {
        name: node.name,
        type: node.type,
        file_path: this.toRepoRelativePath(node.file_path),
        signature: node.signature
      } : null;

      const data = {
        id,
        node_id: nodeId,
        node_metadata: nodeMetadata,
        session_id: sessionId,
        created_at: createdAt,
        updated_at: updatedAt,
        code_snapshot: codeSnapshot,
        reasoning
      };

      const filePath = path.join(historyDir, `${id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('⚠️ SQLite warning: Failed to write history JSON to disk:', err);
    }
  }

  public toRepoRelativePath(absolutePath: string): string {
    if (!absolutePath || !this.context) return absolutePath;
    const abs = path.resolve(absolutePath).replace(/\\/g, '/');
    
    for (const repo of this.context.config.repos) {
      const repoPath = resolveRepoPath(this.context, repo.name);
      if (repoPath) {
        const normalizedRepoPath = path.resolve(repoPath).replace(/\\/g, '/');
        if (abs.startsWith(normalizedRepoPath)) {
          const relative = path.relative(normalizedRepoPath, abs).replace(/\\/g, '/');
          return `{${repo.name}}/${relative}`;
        }
      }
    }
    
    // Fallback: resolve relative to workspace root
    const workspaceRoot = path.dirname(this.dbPath);
    return path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
  }

  public toAbsolutePath(repoRelativePath: string): string {
    if (!repoRelativePath) return repoRelativePath;
    const workspaceRoot = path.dirname(this.dbPath);
    
    const match = repoRelativePath.match(/^\{([^}]+)\}\/(.*)$/);
    if (match && this.context) {
      const repoName = match[1];
      const relativePath = match[2];
      const repoPath = resolveRepoPath(this.context, repoName);
      if (repoPath) {
        return path.resolve(repoPath, relativePath);
      }
    }
    
    // Fallback: resolve relative to workspace root
    return path.resolve(workspaceRoot, repoRelativePath);
  }

  syncFromDisk() {
    this.db.pragma('foreign_keys = OFF');
    try {
      const workspaceRoot = path.dirname(this.dbPath);
      
      // 1. Sync History JSONs
      const historyDir = path.join(workspaceRoot, 'history');
      if (fs.existsSync(historyDir)) {
        const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
        if (files.length > 0) {
          const checkHistoryStmt = this.db.prepare('SELECT id FROM history WHERE id = ?');
          const checkNodeStmt = this.db.prepare('SELECT id FROM nodes WHERE id = ?');
          const insertNodeStmt = this.db.prepare(`
            INSERT INTO nodes (id, type, name, file_path, signature, deprecated)
            VALUES (?, ?, ?, ?, ?, 0)
          `);
          const insertHistoryStmt = this.db.prepare(`
            INSERT INTO history (id, node_id, session_id, created_at, updated_at, code_snapshot, reasoning)
            VALUES (?, ?, ?, ?, ?, '', '')
          `);

          const syncHistoryTx = this.db.transaction(() => {
            for (const file of files) {
              try {
                const filePath = path.join(historyDir, file);
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                if (!data.id || !data.node_id) continue;

                if (checkHistoryStmt.get(data.id)) continue;

                if (!checkNodeStmt.get(data.node_id) && data.node_metadata) {
                  insertNodeStmt.run(
                    data.node_id,
                    data.node_metadata.type,
                    data.node_metadata.name,
                    this.toAbsolutePath(data.node_metadata.file_path),
                    data.node_metadata.signature
                  );
                }

                insertHistoryStmt.run(
                  data.id,
                  data.node_id,
                  data.session_id,
                  data.created_at,
                  data.updated_at
                );
              } catch (err) {
                // ignore
              }
            }
          });
          syncHistoryTx();
        }
      }

      // 2. Sync Graph JSONs
      const graphDir = path.join(workspaceRoot, 'graph');
      if (fs.existsSync(graphDir)) {
        // Recursively find all JSON files in graphDir
        const walkSync = (dir: string, fileList: string[] = []): string[] => {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            const filePath = path.join(dir, file);
            if (fs.statSync(filePath).isDirectory()) {
              walkSync(filePath, fileList);
            } else if (file.endsWith('.json')) {
              fileList.push(filePath);
            }
          }
          return fileList;
        };

        const jsonFiles = walkSync(graphDir);
        if (jsonFiles.length > 0) {
          const deleteNodesForFileStmt = this.db.prepare('DELETE FROM nodes WHERE file_path = ? OR file_path LIKE ?');
          const deleteConnsForNodesStmt = this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ?');
          const insertNodeStmt = this.db.prepare(`
            INSERT OR REPLACE INTO nodes (id, type, name, file_path, signature, deprecated)
            VALUES (?, ?, ?, ?, ?, 0)
          `);
          const insertConnStmt = this.db.prepare(`
            INSERT OR IGNORE INTO node_connections (source_node_id, target_node_id)
            VALUES (?, ?)
          `);

          // Transaction for fast batch syncing
          const syncGraphTx = this.db.transaction(() => {
            for (const file of jsonFiles) {
              try {
                const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
                if (!data.file_path) continue;

                const fileRelPath = data.file_path; // E.g. "{harrir-web}/app/page.tsx" or relative path
                const fileAbsPath = this.toAbsolutePath(fileRelPath);

                // Strip leading {repo} or ../ and normalize separators for matching
                const cleanRelPath = fileRelPath.replace(/^\{[^}]+\}\//, '').replace(/^(\.\.\/)+/, '').replace(/\\/g, '/');
                const fileQueryPath = `%${cleanRelPath.replace(/\//g, path.sep)}`;

                // Clean existing nodes in SQLite for this file
                deleteNodesForFileStmt.run(fileAbsPath, fileQueryPath);

                // Insert nodes
                const nodes = data.nodes || [];
                for (const n of nodes) {
                  deleteConnsForNodesStmt.run(n.id);
                  insertNodeStmt.run(n.id, n.type, n.name, fileAbsPath, n.signature || null);
                }

                // Insert connections
                const connections = data.connections || [];
                for (const c of connections) {
                  insertConnStmt.run(c.source_node_id, c.target_node_id);
                }
              } catch (err) {
                // ignore
              }
            }
          });
          syncGraphTx();
        }
      }
    } catch (err) {
      console.warn('⚠️ SQLite warning: Failed to sync from disk:', err);
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  writeGraphToDisk(filePath: string) {
    try {
      if (!filePath) return;
      const workspaceRoot = path.dirname(this.dbPath);
      // Clean/resolve the file path
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath);
      const relPath = path.relative(workspaceRoot, absPath).replace(/\\/g, '/');
      const repoRelPath = this.toRepoRelativePath(absPath);

      // E.g., "{harrir-web}/app/page.tsx" -> "graph/harrir-web/app/page.json"
      const diskRelPath = repoRelPath.replace(/^\{([^}]+)\}/, '$1').replace(/\.[^/.]+$/, '.json');
      const graphJsonPath = path.join(workspaceRoot, 'graph', diskRelPath);

      // Get all active nodes in this file
      const stmtNodes = this.db.prepare(`
        SELECT * FROM nodes
        WHERE deprecated = 0 AND (file_path = ? OR file_path LIKE ? OR file_path LIKE ? OR file_path LIKE ?)
      `);
      const nodes = stmtNodes.all(absPath, `%${relPath}%`, `%${absPath}%`, `%${relPath}`) as DbNode[];

      if (nodes.length === 0) {
        // If no nodes left, delete the JSON file if it exists
        if (fs.existsSync(graphJsonPath)) {
          fs.unlinkSync(graphJsonPath);
        }
        return;
      }

      // Collect all connections where source node is one of these nodes
      const nodeIds = nodes.map(n => n.id);
      const connections: DbConnection[] = [];
      
      if (nodeIds.length > 0) {
        const stmtConn = this.db.prepare(`
          SELECT * FROM node_connections
          WHERE source_node_id = ?
        `);
        for (const id of nodeIds) {
          const conns = stmtConn.all(id) as DbConnection[];
          connections.push(...conns);
        }
      }

      // Format data
      const data = {
        file_path: repoRelPath,
        nodes: nodes.map(n => ({
          id: n.id,
          name: n.name,
          type: n.type,
          signature: n.signature
        })),
        connections: connections.map(c => ({
          source_node_id: c.source_node_id,
          target_node_id: c.target_node_id
        }))
      };

      fs.mkdirSync(path.dirname(graphJsonPath), { recursive: true });
      fs.writeFileSync(graphJsonPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('⚠️ SQLite warning: Failed to write graph JSON to disk:', err);
    }
  }
}
