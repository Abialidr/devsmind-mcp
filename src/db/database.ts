import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { INIT_SCHEMA_SQL, DbNode, DbHistory, DbConnection } from './schema';
import { loadProjectContext, resolveRepoPath, ProjectContext } from '../utils/config';
import { parseNodeId, extractNodeFromFile } from '../utils/ast';

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

/** Where a returned code body came from: parsed off disk, or served from the cached snapshot. */
export type CodeSource = 'live' | 'cached';

export interface LiveCodeResult {
  exists: boolean;
  node_id: string;
  file_path?: string;
  code?: string;
  source?: CodeSource;
  /** True when the cached snapshot disagrees with disk, or could not be checked against it. */
  snapshot_outdated?: boolean;
  updated_at?: string;
  message?: string;
}

export type GraphNode = DbNode & { code?: string; code_source?: CodeSource };

export interface GraphOptions {
  /** 'out' = callees only (call-flow trace), 'in' = callers only, 'both' = neighborhood. */
  direction?: 'out' | 'in' | 'both';
  includeCode?: boolean;
  codeCharBudget?: number;
}

export interface GraphResult {
  nodes: GraphNode[];
  connections: DbConnection[];
  /** Total characters of code attached (only set when includeCode is true). */
  code_chars?: number;
  /** Set when some nodes came back without code (budget exhausted, or no code available). */
  code_truncated?: boolean;
  nodes_without_code?: number;
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

  /** Snapshot of active-node / connection / history row counts (used by `devsmind sync`). */
  getCounts(): { nodes: number; connections: number; history: number } {
    const one = (sql: string): number => {
      try {
        const row = this.db.prepare(sql).get() as { c: number } | undefined;
        return row ? row.c : 0;
      } catch {
        return 0;
      }
    };
    return {
      nodes: one('SELECT COUNT(*) AS c FROM nodes WHERE deprecated = 0'),
      connections: one('SELECT COUNT(*) AS c FROM node_connections'),
      history: one('SELECT COUNT(*) AS c FROM history'),
    };
  }

  vacuum() {
    try {
      this.db.exec('VACUUM');
    } catch (err) {
      console.warn('⚠️ SQLite VACUUM failed:', err);
    }
  }

  /**
   * Wipes all nodes, connections, history, and system_meta from the DB, and clears
   * the committed graph/ and history/ JSON directories on disk. Used by `--from-scratch`
   * reindexing. This is destructive and irreversible from within the app — callers are
   * responsible for confirming with the user first.
   */
  resetAll(): void {
    this.db.exec('DELETE FROM node_connections');
    this.db.exec('DELETE FROM history');
    this.db.exec('DELETE FROM nodes');
    this.db.exec('DELETE FROM system_meta');

    const workspaceRoot = path.dirname(this.dbPath);
    for (const dir of ['graph', 'history']) {
      const p = path.join(workspaceRoot, dir);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
      fs.mkdirSync(p, { recursive: true });
    }

    this.vacuum();
  }

  /**
   * Deletes every connection from both the DB and (by rewriting each affected file's
   * graph JSON) from disk. Used by `--edges-only` to rebuild the edge graph from
   * scratch without touching nodes or history.
   */
  clearAllConnections(): void {
    const rows = this.db.prepare('SELECT DISTINCT file_path FROM nodes WHERE deprecated = 0').all() as { file_path: string }[];
    const affectedFilePaths = new Set<string>();
    for (const row of rows) {
      for (const p of row.file_path.split(',').map(s => s.trim()).filter(Boolean)) {
        affectedFilePaths.add(p);
      }
    }
    this.db.exec('DELETE FROM node_connections');
    for (const filePath of affectedFilePaths) {
      this.writeGraphToDisk(filePath);
    }
  }

  /**
   * Deletes only the OUTGOING connections of the given source nodes (and re-syncs the
   * affected files' graph JSON). Used by repo-scoped `--edges-only` so that rebuilding
   * one repo's edges doesn't wipe every other repo's edges.
   */
  clearConnectionsForSources(nodeIds: string[]): void {
    if (nodeIds.length === 0) return;
    const affectedFilePaths = new Set<string>();
    const del = this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ?');
    const getFp = this.db.prepare('SELECT file_path FROM nodes WHERE id = ?');
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        const row = getFp.get(id) as { file_path?: string } | undefined;
        if (row?.file_path) {
          for (const p of row.file_path.split(',').map(s => s.trim()).filter(Boolean)) {
            affectedFilePaths.add(p);
          }
        }
        del.run(id);
      }
    });
    tx(nodeIds);
    for (const filePath of affectedFilePaths) {
      this.writeGraphToDisk(filePath);
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
    // Capture caller files, and delete the node's history JSONs, BEFORE the row (and its
    // cascade-deleted history rows / edges) is gone. Without the JSON cleanup, syncFromDisk()
    // would resurrect the node from its lingering history/[id].json on the next server start.
    const inboundSourceFiles = this.collectInboundSourceFiles(resolvedId);
    this.deleteHistoryFilesForNode(resolvedId);
    const stmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    stmt.run(resolvedId);
    if (node && node.file_path) {
      this.writeGraphToDisk(node.file_path);
    }
    for (const p of inboundSourceFiles) {
      this.writeGraphToDisk(p);
    }
  }

  deprecateNode(id: string) {
    const node = this.getNode(id);
    const resolvedId = node ? node.id : id;
    // Capture the caller files BEFORE we delete the inbound edges — afterwards the join
    // that finds them returns nothing.
    const inboundSourceFiles = this.collectInboundSourceFiles(resolvedId);
    const updateStmt = this.db.prepare('UPDATE nodes SET deprecated = 1 WHERE id = ?');
    const deleteConnStmt = this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ? OR target_node_id = ?');
    const tx = this.db.transaction(() => {
      updateStmt.run(resolvedId);
      deleteConnStmt.run(resolvedId, resolvedId);
    });
    tx();
    // Rewrite the node's own file (now carrying deprecated:1) and every caller file (so their
    // stale inbound edges don't resurrect the connection on the next syncFromDisk()).
    if (node && node.file_path) {
      this.writeGraphToDisk(node.file_path);
    }
    for (const p of inboundSourceFiles) {
      this.writeGraphToDisk(p);
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

      // Edges pointing INTO the renamed node live in the SOURCE nodes' files' graph JSONs
      // (which still reference oldId on disk). The DB was already repointed to newId above,
      // so rewrite each such file — otherwise syncFromDisk reloads the stale oldId edge and
      // the renamed node silently loses all its inbound ("used-by") edges.
      this.rewriteInboundSourceFiles(newId);

      // Keep the committed history/*.json files in sync with the rename. Without this,
      // syncFromDisk() on the next server start would find the old node_id (which no
      // longer exists in the DB) and re-insert it right back, undoing the rename.
      const historyIds = this.db.prepare('SELECT id FROM history WHERE node_id = ?').all(newId) as { id: string }[];
      for (const row of historyIds) {
        this.patchHistoryDiskIdentity(row.id, newId, name, node.type, node.file_path, node.signature);
      }
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  /**
   * Rewrites a history/[id].json file's identifying fields (node_id, node_metadata) in
   * place, leaving code_snapshot/reasoning/timestamps untouched. Used after a rename so
   * disk stays consistent with the DB without needing the full code_snapshot/reasoning
   * to be re-passed in.
   */
  private patchHistoryDiskIdentity(
    historyId: string,
    nodeId: string,
    name: string,
    type: string,
    filePath: string,
    signature: string | null
  ): void {
    try {
      const historyDir = path.join(path.dirname(this.dbPath), 'history');
      const filePathOnDisk = path.join(historyDir, `${historyId}.json`);
      if (!fs.existsSync(filePathOnDisk)) return;

      const data = JSON.parse(fs.readFileSync(filePathOnDisk, 'utf-8'));
      data.node_id = nodeId;
      data.node_metadata = {
        name,
        type,
        file_path: this.toRepoRelativePath(filePath),
        signature
      };

      fs.writeFileSync(filePathOnDisk, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('⚠️ SQLite warning: Failed to patch history JSON identity on disk:', err);
    }
  }

  /**
   * Collects the distinct file paths of every SOURCE node that has an OUTGOING edge pointing
   * INTO `nodeId` (i.e. this node's "used-by" callers). Those inbound edges live on disk in the
   * source nodes' files, not in the target's own file. Callers that DELETE the inbound edges
   * (deprecate/delete) must call this BEFORE the deletion to capture the affected files;
   * callers that merely repoint them (rename) can rewrite after the fact.
   */
  private collectInboundSourceFiles(nodeId: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT n.file_path AS file_path
      FROM node_connections c JOIN nodes n ON n.id = c.source_node_id
      WHERE c.target_node_id = ?
    `).all(nodeId) as { file_path: string }[];
    const files = new Set<string>();
    for (const row of rows) {
      if (!row.file_path) continue;
      for (const p of row.file_path.split(',').map(s => s.trim()).filter(Boolean)) {
        files.add(p);
      }
    }
    return Array.from(files);
  }

  /**
   * Re-syncs each given source file's graph JSON. Used after the DB has been mutated so that
   * syncFromDisk() won't reload a stale inbound ("used-by") edge on the next server start.
   */
  private rewriteInboundSourceFiles(nodeId: string) {
    for (const p of this.collectInboundSourceFiles(nodeId)) {
      this.writeGraphToDisk(p);
    }
  }

  /**
   * Deletes the committed history/[id].json files for every history record of `nodeId`.
   * Used on HARD delete so that syncFromDisk()'s history pass can't resurrect the node
   * (and its metadata) from a lingering JSON on the next server start. Reads the history
   * ids BEFORE the DB rows are removed, so call this while they still exist (or pass ids in).
   */
  private deleteHistoryFilesForNode(nodeId: string) {
    try {
      const historyDir = path.join(path.dirname(this.dbPath), 'history');
      const rows = this.db.prepare('SELECT id FROM history WHERE node_id = ?').all(nodeId) as { id: string }[];
      for (const row of rows) {
        const filePath = path.join(historyDir, `${row.id}.json`);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.warn('⚠️ SQLite warning: Failed to delete history JSON(s) on disk:', err);
    }
  }

  // --- Connection Operations ---

  addConnection(sourceNodeId: string, targetNodeId: string) {
    const srcNode = this.getNode(sourceNodeId);
    const tgtNode = this.getNode(targetNodeId);
    const resolvedSrc = srcNode ? srcNode.id : sourceNodeId;
    const resolvedTgt = tgtNode ? tgtNode.id : targetNodeId;
    
    // The on-disk graph format is node-anchored: each file's JSON lists its nodes and their
    // OUTGOING edges. An edge whose SOURCE node doesn't exist has nowhere to be written on
    // disk, so it would live only in brain.db and be silently dropped by syncFromDisk() on the
    // next server start. Rather than leak that DB-only orphan, refuse the edge and tell the
    // caller to add the source node first (the two-phase indexing protocol already does this).
    if (!srcNode) {
      console.warn(
        `⚠️ DevsMind: connection skipped — source node "${sourceNodeId}" does not exist in ` +
        `the graph. Add it (stage_change / update_history) before connecting it, otherwise the edge ` +
        `cannot be persisted to disk and would not survive a restart.`
      );
      return;
    }

    this.db.pragma('foreign_keys = OFF');
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO node_connections (source_node_id, target_node_id)
        VALUES (?, ?)
      `);
      stmt.run(resolvedSrc, resolvedTgt);
      if (srcNode.file_path) {
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

  /** Distinct source node ids of edges pointing INTO this node (its "used-by" callers). */
  getInboundSources(nodeId: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT source_node_id FROM node_connections WHERE target_node_id = ?')
      .all(nodeId) as { source_node_id: string }[];
    return rows.map(r => r.source_node_id);
  }

  getLatestCode(nodeId: string): { code_snapshot: string; updated_at: string } | null {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const history = this.getLatestHistory(resolvedId);
    if (!history || !history.code_snapshot || history.code_snapshot.trim() === '') return null;
    return {
      updated_at: history.updated_at,
      code_snapshot: history.code_snapshot
    };
  }

  /**
   * Parse a node's CURRENT source straight off disk via the AST, bypassing the stored snapshot.
   * `nodes.file_path` is already absolute, and may be a ", "-joined list when a symbol spans
   * files — try each until one resolves. Returns null for non-TS/JS files, or when the symbol
   * no longer exists in the file (renamed / moved / deleted).
   */
  private extractLiveCode(node: DbNode): string | null {
    const parsed = parseNodeId(node.id);
    // Pass the FULL symbol name ("Foo.bar") — extractNodeFromFile re-derives the class itself.
    const symbol = parsed ? parsed.symbolName : node.id.split('#').pop() || node.name;
    if (!symbol) return null;

    for (const p of String(node.file_path).split(',').map(s => s.trim()).filter(Boolean)) {
      const derived = extractNodeFromFile(p, symbol);
      if (derived) return derived.codeSnapshot;
    }
    return null;
  }

  /**
   * Current code for a node, read from the file on disk (the source of truth) rather than the
   * cached snapshot. Falls back to the snapshot only when the file can't be parsed for this
   * symbol, and flags that fallback as unverified. When live code IS available, comparing it to
   * the snapshot is free — so drift between the graph and disk is reported rather than hidden.
   */
  getLiveCode(nodeId: string): LiveCodeResult {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const snapshot = this.getLatestCode(resolvedId);

    if (node) {
      const live = this.extractLiveCode(node);
      if (live !== null) {
        return {
          exists: true,
          node_id: node.id,
          file_path: node.file_path,
          code: live,
          source: 'live',
          // Snapshot exists but disagrees with disk → the graph has drifted.
          snapshot_outdated: snapshot ? snapshot.code_snapshot !== live : undefined,
          updated_at: snapshot?.updated_at
        };
      }
    }

    if (snapshot) {
      return {
        exists: true,
        node_id: resolvedId,
        file_path: node?.file_path,
        code: snapshot.code_snapshot,
        source: 'cached',
        // Could not confirm against disk (non-TS/JS file, or symbol gone) — treat as suspect.
        snapshot_outdated: true,
        updated_at: snapshot.updated_at,
        message:
          'Could not locate this symbol in its source file — the file may not be TS/JS, or the symbol was renamed, moved, or deleted. Returning the last cached snapshot, which may be out of date. Verify against the file before relying on it.'
      };
    }

    return {
      exists: false,
      node_id: resolvedId,
      message:
        'No code found on disk or in cache. Read the source file, then stage_change + commit_changes so future agents skip the file read entirely.'
    };
  }

  getGraph(nodeId: string, maxDepth: number = 6, opts: GraphOptions = {}): GraphResult {
    const direction = opts.direction ?? 'both';
    const codeCharBudget = opts.codeCharBudget ?? 60_000;

    const maxNodesLimit = 500;
    const visited = new Set<string>();
    const nodes: GraphNode[] = [];
    const connections: DbConnection[] = [];
    const connSet = new Set<string>();

    const rootNode = this.getNode(nodeId);
    if (!rootNode) {
      return { nodes, connections };
    }

    // Seed with the CANONICAL id. getNode() resolves a bare, unqualified symbol name, but
    // node_connections is keyed by the fully-qualified id — seeding the queue with the raw
    // argument would find zero edges and return a lone root.
    const queue: { id: string; depth: number }[] = [{ id: rootNode.id, depth: 0 }];
    visited.add(rootNode.id);
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

      // Outbound — what this node uses (callees). Skipped when tracing callers only.
      if (direction !== 'in') {
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
      }

      if (nodes.length >= maxNodesLimit) break;

      // Inbound — what uses this node (callers). Skipped when tracing a call flow outward.
      if (direction !== 'out') {
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
    }

    const result: GraphResult = { nodes, connections };

    if (opts.includeCode) {
      let spent = 0;
      let withoutCode = 0;
      // `nodes` is in BFS order (nearest the root first), so the budget is spent on the most
      // relevant code before anything is dropped.
      for (const [i, n] of nodes.entries()) {
        const live = this.extractLiveCode(n);
        const code = live ?? this.getLatestCode(n.id)?.code_snapshot ?? null;
        if (!code) {
          withoutCode++;
          continue;
        }
        // The root always gets its code — it is what was asked for, and dropping it would make
        // the response useless. Every other node must fit in the REMAINING budget, so a single
        // large node can't blow past the cap (it is skipped and counted, not truncated).
        if (i > 0 && spent + code.length > codeCharBudget) {
          withoutCode++;
          continue;
        }
        n.code = code;
        n.code_source = live !== null ? 'live' : 'cached';
        spent += code.length;
      }
      result.code_chars = spent;
      if (withoutCode > 0) {
        result.code_truncated = true;
        result.nodes_without_code = withoutCode;
      }
    }

    return result;
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
          SET code_snapshot = '', reasoning = ?, updated_at = ?
          WHERE id = ?
        `);
        updateStmt.run(formattedReasoning, nowStr, latest.id);
        
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
      VALUES (?, ?, ?, ?, ?, '', ?)
    `);
    insertStmt.run(newId, resolvedId, sessionId, nowStr, nowStr, formattedReasoning);

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

  /**
   * Search for nodes by name/id/reasoning first (cheap, SQL-only). If that finds
   * nothing, transparently fall back to a code-content search (same engine as
   * {@link searchCode}) so a query like "alipay" still succeeds even when no
   * node's name/id/reasoning mentions it but the code itself does. Every result
   * is tagged `matched_via` so the caller knows which path found it.
   */
  searchNodes(
    query: string,
    opts: { is_regex?: boolean; case_insensitive?: boolean } = {}
  ): Array<(DbNode & { matched_via: 'identifier' }) | (ReturnType<DevMindDatabase['searchCode']>[number] & { matched_via: 'code' })> {
    const stmt = this.db.prepare(`
      SELECT DISTINCT n.* FROM nodes n
      LEFT JOIN history h ON n.id = h.node_id
      WHERE n.name LIKE ? OR n.id LIKE ? OR h.reasoning LIKE ?
      LIMIT 50
    `);
    const wildcard = `%${query}%`;
    const identifierMatches = stmt.all(wildcard, wildcard, wildcard) as DbNode[];

    if (identifierMatches.length > 0) {
      return identifierMatches.map(n => ({ ...n, matched_via: 'identifier' as const }));
    }

    const codeMatches = this.searchCode({
      query,
      is_regex: opts.is_regex,
      case_insensitive: opts.case_insensitive
    });
    return codeMatches.map(m => ({ ...m, matched_via: 'code' as const }));
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
      SELECT h.id, h.node_id, n.name as node_name, n.file_path, h.updated_at, h.reasoning
      FROM history h
      JOIN nodes n ON h.node_id = n.id
      WHERE h.updated_at >= datetime('now', ?)
      ORDER BY h.updated_at DESC
    `);
    const recentChanges = stmt.all(`-${hours} hours`) as any[];

    for (const change of recentChanges) {
      const populated = this.populateHistoryFromDisk({ id: change.id, reasoning: change.reasoning });
      change.reasoning = populated.reasoning;
      delete change.id;
    }

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

  searchCode(params: {
    query: string;
    is_regex?: boolean;
    case_insensitive?: boolean;
  }): {
    node_id: string;
    node_name: string;
    file_path: string;
    matches: { line_number: number; line_content: string }[];
    match_count: number;
    total_lines: number;
    match_ratio: number;
  }[] {
    const { query, is_regex = false, case_insensitive = true } = params;
    const historyDir = path.join(path.dirname(this.dbPath), 'history');
    
    const stmt = this.db.prepare(`
      SELECT h.id, n.id AS node_id, n.name AS node_name, n.file_path
      FROM nodes n
      JOIN history h ON h.node_id = n.id
      WHERE n.deprecated = 0
        AND h.id = (
          SELECT id FROM history
          WHERE node_id = n.id
          ORDER BY updated_at DESC
          LIMIT 1
        )
    `);
    const rows = stmt.all() as { id: string; node_id: string; node_name: string; file_path: string }[];

    let matcher: RegExp;
    if (is_regex) {
      try {
        matcher = new RegExp(query, case_insensitive ? 'i' : '');
      } catch (err) {
        throw new Error(`Invalid regex pattern: ${(err as Error).message}`);
      }
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matcher = new RegExp(escaped, case_insensitive ? 'i' : '');
    }

    const results: any[] = [];

    for (const row of rows) {
      const filePath = path.join(historyDir, `${row.id}.json`);
      if (!fs.existsSync(filePath)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const code = data.code_snapshot || '';
        if (!code) continue;

        const lines = code.split('\n');
        const nodeMatches: { line_number: number; line_content: string }[] = [];

        lines.forEach((line: string, idx: number) => {
          if (matcher.test(line)) {
            nodeMatches.push({
              line_number: idx + 1,
              line_content: line
            });
          }
        });

        if (nodeMatches.length > 0) {
          results.push({
            node_id: row.node_id,
            node_name: row.node_name,
            file_path: row.file_path,
            matches: nodeMatches,
            match_count: nodeMatches.length,
            total_lines: lines.length,
            match_ratio: parseFloat((nodeMatches.length / lines.length).toFixed(4))
          });
        }
      } catch {
        // Skip corrupted or unreadable history files
      }
    }

    return results.sort((a, b) => b.match_count - a.match_count);
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
    return rows.map(row => this.populateHistoryFromDisk(row));
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
    const affectedFilePaths = new Set<string>();

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
        if (node.file_path) {
          for (const p of node.file_path.split(',').map(s => s.trim()).filter(Boolean)) {
            affectedFilePaths.add(p);
          }
        }
      }
    }

    if (idsToDelete.length > 0) {
      // Capture caller files and drop the pruned nodes' history JSONs BEFORE the tx: the
      // inbound-edge join goes empty once edges are deleted, and the history rows (whose ids
      // name the JSON files) are removed by deleteHistoryStmt. Without the JSON cleanup, a
      // pruned node would resurrect from its history/[id].json on the next syncFromDisk().
      for (const id of idsToDelete) {
        for (const p of this.collectInboundSourceFiles(id)) {
          affectedFilePaths.add(p);
        }
        this.deleteHistoryFilesForNode(id);
      }

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

      // Keep the committed graph/*.json files in sync with the DB. Pruned nodes are written
      // with deprecated:1 (so they don't come back as active), and every caller file is
      // rewritten so its stale inbound edge doesn't resurrect the connection on next start.
      for (const filePath of affectedFilePaths) {
        this.writeGraphToDisk(filePath);
      }
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
        if (abs === normalizedRepoPath || abs.startsWith(normalizedRepoPath + '/')) {
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
            VALUES (?, ?, ?, ?, ?, '', ?)
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

                const formattedReasoning = typeof data.reasoning === 'string'
                  ? data.reasoning
                  : formatReasoning(data.reasoning || '');

                insertHistoryStmt.run(
                  data.id,
                  data.node_id,
                  data.session_id,
                  data.created_at,
                  data.updated_at,
                  formattedReasoning
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
          const deleteNodesForFileStmt = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
          const deleteConnsForNodesStmt = this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ?');
          const insertNodeStmt = this.db.prepare(`
            INSERT OR REPLACE INTO nodes (id, type, name, file_path, signature, deprecated)
            VALUES (?, ?, ?, ?, ?, ?)
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

                // Clean existing nodes in SQLite for this file BEFORE re-inserting from
                // the JSON (so removed/renamed symbols are cleared). Match ONLY the exact
                // absolute path: the previous suffix `LIKE '%<relpath>'` matched the same
                // relative path in EVERY repo, so syncing one repo's file deleted another
                // repo's same-named file nodes (cross-repo data loss).
                deleteNodesForFileStmt.run(fileAbsPath);

                // Insert nodes
                const nodes = data.nodes || [];
                for (const n of nodes) {
                  deleteConnsForNodesStmt.run(n.id);
                  insertNodeStmt.run(n.id, n.type, n.name, fileAbsPath, n.signature || null, n.deprecated ? 1 : 0);
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

  /** Escape LIKE metacharacters so a path is matched literally (use with ESCAPE '\\'). */
  private likeEscape(s: string): string {
    return s.replace(/[\\%_]/g, ch => '\\' + ch);
  }

  writeGraphToDisk(filePath: string) {
    try {
      if (!filePath) return;
      const workspaceRoot = path.dirname(this.dbPath);
      // Clean/resolve the file path
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath);
      const repoRelPath = this.toRepoRelativePath(absPath);

      // E.g., "{harrir-web}/app/page.tsx" -> "graph/harrir-web/app/page.json"
      const diskRelPath = repoRelPath.replace(/^\{([^}]+)\}/, '$1').replace(/\.[^/.]+$/, '.json');
      const graphJsonPath = path.join(workspaceRoot, 'graph', diskRelPath);

      // Get all nodes in this file (active AND deprecated). A node's file_path is either
      // exactly this absolute path, or (for the rare node spanning multiple files) a ", "-joined
      // list containing it. We anchor on the FULL absolute path with ", " boundaries and escape
      // LIKE metacharacters — the old `%<relpath>%` / `%<relpath>` matched short relative
      // suffixes shared across repos, pulling in (and later corrupting) other repos' nodes.
      // Deprecated nodes are INCLUDED (and carry deprecated:1 in the JSON) so that deprecation
      // is durable across a syncFromDisk() restart and propagates to teammates via git —
      // otherwise the node's history JSON would resurrect it as active on the next start.
      const absEsc = this.likeEscape(absPath);
      const stmtNodes = this.db.prepare(`
        SELECT * FROM nodes
        WHERE (
          file_path = ? OR
          file_path LIKE ? ESCAPE '\\' OR
          file_path LIKE ? ESCAPE '\\' OR
          file_path LIKE ? ESCAPE '\\'
        )
      `);
      const nodes = stmtNodes.all(
        absPath,
        `${absEsc}, %`,
        `%, ${absEsc}`,
        `%, ${absEsc}, %`
      ) as DbNode[];

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
          signature: n.signature,
          deprecated: n.deprecated ? 1 : 0
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
