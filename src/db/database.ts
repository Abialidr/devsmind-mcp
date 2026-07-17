import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { INIT_SCHEMA_SQL, DbNode, DbHistory, DbConnection, DbWorkflow, DbWorkflowStep, DbWorkflowArtifact } from './schema';
import { loadProjectContext, resolveRepoPath, ProjectContext, canonicalizePath } from '../utils/config';
import { parseNodeId, extractNodeFromFile, normalizeFsPath } from '../utils/ast';

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

/**
 * Inverse of `formatReasoning`. A single history row accumulates every later update appended
 * under a `── Update @ … ──` separator, so one stored blob can hold several changes — this
 * splits them back apart and returns them NEWEST FIRST.
 *
 * Reasoning written before the structured format (or by a caller passing a bare string) has no
 * labels to read; rather than drop it, the whole chunk is surfaced as `what_changed`.
 */
export function parseReasoningBlocks(raw: string): ReasoningObject[] {
  if (!raw || typeof raw !== 'string') return [];
  const chunks = raw
    .split(/\n*── Update @ [^\n]*──\n/g)
    .map(c => c.trim())
    .filter(Boolean);

  const parsed = chunks.map(chunk => {
    const field = (label: string): string | undefined => {
      const m = chunk.match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'm'));
      const v = m?.[1]?.trim();
      return v ? v : undefined;
    };
    const what = field('What changed');
    const why = field('Why');
    const goal = field('Goal');
    // No recognised labels → free-text reasoning; keep it rather than return an empty shell.
    if (!what && !why && !goal) {
      return { what_changed: chunk, why: '', goal: '' } as ReasoningObject;
    }
    return {
      what_changed: what || '',
      why: why || '',
      goal: goal || '',
      requirement: field('Requirement'),
      previous_state: field('Previous state'),
      decision: field('Decision'),
      developer: field('Developer'),
      model: field('Model')
    } as ReasoningObject;
  });

  return parsed.reverse();
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

  getContext(): ProjectContext | null {
    return this.context;
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

  /**
   * Nodes declared in one file. Both sides are folded to a canonical form before comparing:
   * a stored `c:\x\y.ts` and a caller's `C:/x/y.ts` are the same file on Windows, and a raw
   * `=` match silently returns nothing — which reads as "this file has no nodes" rather than
   * as an error. There is no index on file_path, so this was already a full scan; normalizing
   * in SQL costs nothing extra.
   */
  getNodesByFilePath(filePath: string): DbNode[] {
    const stmt = this.db.prepare(
      `SELECT * FROM nodes WHERE deprecated = 0 AND REPLACE(LOWER(file_path), '\\', '/') = ?`
    );
    return stmt.all(normalizeFsPath(filePath)) as DbNode[];
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
    // NOTE: 'workflows/' is intentionally NOT wiped — workflow data is long-lived
    // cross-session state that survives a node/history reindex. It will be
    // restored from workflows/*/workflow.json on the next syncFromDisk().

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
    const canonicalFp = canonicalizePath(node.file_path);
    const existing = this.getNode(node.id);
    if (existing) {
      let finalPath = existing.file_path;
      const paths = existing.file_path.split(',').map(p => p.trim()).filter(Boolean);
      const incoming = canonicalFp.trim();
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
      stmt.run(node.id, node.type, node.name, canonicalFp, node.signature || null);
    }
    this.writeGraphToDisk(canonicalFp);
  }

  getNode(id: string): DbNode | null {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    const direct = stmt.get(id) as DbNode;
    if (direct) return direct;

    if (!id.includes('#')) {
      const suffixStmt = this.db.prepare("SELECT * FROM nodes WHERE id LIKE ? ESCAPE '\\' AND deprecated = 0");
      const matches = suffixStmt.all(`%#${this.likeEscape(id)}`) as DbNode[];
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

  /** `newFilePath`: pass when the rename is a file move (analyze's rename migration), leave undefined for a pure symbol-id rename where the file itself is unchanged. */
  renameNode(oldId: string, newId: string, newName?: string, newFilePath?: string) {
    const node = this.getNode(oldId);
    if (!node) {
      throw new Error(`Node not found: ${oldId}`);
    }
    // getNode() resolves a bare/unqualified id (e.g. "createCart") to the node's fully-qualified
    // one via a suffix match — but node_connections/history are keyed by the FULLY-QUALIFIED id
    // only. Every statement below must use node.id, not the raw oldId parameter: using oldId
    // directly makes each UPDATE a silent no-op whenever the caller passed a bare id (matching
    // no rows, throwing no error), leaving the new id's row empty/disconnected while the old
    // node's history and edges stay put under the id that was supposedly just renamed away.
    const resolvedOldId = node.id;

    const name = newName || (node.name === resolvedOldId ? newId : node.name);
    const filePath = newFilePath || node.file_path;

    this.db.pragma('foreign_keys = OFF');

    try {
      const runTx = this.db.transaction(() => {
        const insertStmt = this.db.prepare(`
          INSERT INTO nodes (id, type, name, file_path, signature, created_at, deprecated)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        insertStmt.run(newId, node.type, name, filePath, node.signature, node.created_at, node.deprecated ? 1 : 0);

        const updateSourceStmt = this.db.prepare(`
          UPDATE node_connections SET source_node_id = ? WHERE source_node_id = ?
        `);
        updateSourceStmt.run(newId, resolvedOldId);

        const updateTargetStmt = this.db.prepare(`
          UPDATE node_connections SET target_node_id = ? WHERE target_node_id = ?
        `);
        updateTargetStmt.run(newId, resolvedOldId);

        const updateHistoryStmt = this.db.prepare(`
          UPDATE history SET node_id = ? WHERE node_id = ?
        `);
        updateHistoryStmt.run(newId, resolvedOldId);

        const deleteOldStmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
        deleteOldStmt.run(resolvedOldId);
      });

      runTx();
      if (node.file_path) {
        // Rewrite the OLD file's graph JSON too when the file itself moved, so the
        // stale node entry doesn't linger under the old path's JSON on disk.
        this.writeGraphToDisk(node.file_path);
      }
      if (filePath && filePath !== node.file_path) {
        this.writeGraphToDisk(filePath);
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
        this.patchHistoryDiskIdentity(row.id, newId, name, node.type, filePath, node.signature);
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
    const { node_id, code_snapshot } = params;
    let reasoning = params.reasoning;
    // The calling AI has no reliable way to know who the human running this
    // machine actually is -- it can only guess ("Claude Code", "AI Assistant",
    // etc). Whenever this project has a configured developer identity (from
    // .env's DEVELOPER_NAME, set by `devsmind init`), that's authoritative and
    // always overrides whatever the agent supplied, so history is attributed
    // to the real developer regardless of what the agent wrote in this field.
    if (typeof reasoning === 'object' && this.context?.developer?.name) {
      reasoning = { ...reasoning, developer: this.context.developer.name };
    }
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

      // If updated < 1 hour ago, update the same record IN PLACE (no new row — this is what
      // keeps db/graph/history from bloating with one entry per commit during an active editing
      // session). code_snapshot is always the latest state (git already owns version history for
      // code). reasoning is APPENDED, not overwritten — an earlier commit's "why" in this same
      // session is still real and still worth keeping; losing it silently is worse than a few
      // extra lines in one file. This also keeps any workflow step whose history_ids point at
      // this row valid: it never loses what it originally linked to, only gains more below it.
      if (diffMs < 3600000) {
        const previousReasoning = typeof latest.reasoning === 'string' ? latest.reasoning : '';
        const mergedReasoning = previousReasoning.trim().length > 0
          ? `${previousReasoning}\n\n── Update @ ${nowStr} ──\n${formattedReasoning}`
          : formattedReasoning;

        const updateStmt = this.db.prepare(`
          UPDATE history
          SET code_snapshot = '', reasoning = ?, updated_at = ?
          WHERE id = ?
        `);
        updateStmt.run(mergedReasoning, nowStr, latest.id);

        // Write/Update on disk
        this.writeHistoryToDisk(latest.id, resolvedId, latest.session_id, latest.created_at, nowStr, code_snapshot, mergedReasoning);

        return {
          ...latest,
          code_snapshot,
          reasoning: mergedReasoning,
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
  ): Array<
    | (DbNode & { matched_via: 'identifier' })
    | (ReturnType<DevMindDatabase['searchCode']>[number] & { matched_via: 'code' })
    | (DbNode & { matched_via: 'fuzzy'; matched_terms: string[]; score: number })
  > {
    const stmt = this.db.prepare(`
      SELECT DISTINCT n.* FROM nodes n
      LEFT JOIN history h ON n.id = h.node_id
      WHERE n.name LIKE ? ESCAPE '\\' OR n.id LIKE ? ESCAPE '\\' OR h.reasoning LIKE ? ESCAPE '\\'
      LIMIT 50
    `);
    // Escaped so a query containing '%'/'_' (a real identifier fragment like "CartService_addItem"
    // matches the literal underscore, not "any single character") searches for those characters
    // rather than acting as SQL LIKE wildcards — sibling methods (getDeveloperActivity,
    // searchDecisions) already do this; this one didn't.
    const wildcard = `%${this.likeEscape(query)}%`;
    const identifierMatches = stmt.all(wildcard, wildcard, wildcard) as DbNode[];

    if (identifierMatches.length > 0) {
      return identifierMatches.map(n => ({ ...n, matched_via: 'identifier' as const }));
    }

    const codeMatches = this.searchCode({
      query,
      is_regex: opts.is_regex,
      case_insensitive: opts.case_insensitive
    });
    if (codeMatches.length > 0) {
      return codeMatches.map(m => ({ ...m, matched_via: 'code' as const }));
    }

    const tokens = this.tokenizeQuery(query);
    if (tokens.length === 0) {
      return [];
    }
    return this.fuzzySearchNodes(tokens);
  }

  /**
   * Splits a query string into lowercase word tokens for the fuzzy fallback
   * stage of {@link searchNodes}. This is request-scoped tokenization only —
   * nothing is persisted or indexed; the result is discarded after the call.
   */
  private tokenizeQuery(query: string): string[] {
    const seen = new Set<string>();
    for (const raw of query.toLowerCase().split(/[^a-z0-9]+/i)) {
      if (raw.length >= 2) seen.add(raw);
    }
    return Array.from(seen);
  }

  /**
   * Word-split relevance-ranked fallback for {@link searchNodes}. Runs only
   * when the exact identifier and code stages both return nothing. Scores
   * every non-deprecated node by how many distinct query tokens appear as a
   * substring of its file_path/name/id (highest signal), latest reasoning,
   * or code content (lowest signal, one point per matching line). No new
   * data is written or synced — this is a plain in-memory scan reusing the
   * same node/history sources searchCode already reads.
   */
  private fuzzySearchNodes(
    tokens: string[]
  ): Array<DbNode & { matched_via: 'fuzzy'; matched_terms: string[]; score: number }> {
    const historyDir = path.join(path.dirname(this.dbPath), 'history');
    const stmt = this.db.prepare(`
      SELECT n.*, h.id AS latest_history_id, h.reasoning AS reasoning
      FROM nodes n
      LEFT JOIN history h ON h.id = (
        SELECT id FROM history WHERE node_id = n.id ORDER BY updated_at DESC LIMIT 1
      )
      WHERE n.deprecated = 0
    `);
    const rows = stmt.all() as (DbNode & { latest_history_id: string | null; reasoning: string | null })[];

    const FIELD_WEIGHT = { path: 3, identifier: 3, reasoning: 2, code: 1 } as const;
    const scored: Array<DbNode & { matched_via: 'fuzzy'; matched_terms: string[]; score: number }> = [];

    for (const row of rows) {
      const { latest_history_id, reasoning, ...node } = row;
      const matchedTerms = new Set<string>();
      let score = 0;

      const filePathLower = (node.file_path || '').toLowerCase();
      const nameLower = (node.name || '').toLowerCase();
      const idLower = (node.id || '').toLowerCase();
      const reasoningLower = (reasoning || '').toLowerCase();

      let code = '';
      if (latest_history_id) {
        const historyFile = path.join(historyDir, `${latest_history_id}.json`);
        if (fs.existsSync(historyFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
            code = (data.code_snapshot || '').toLowerCase();
          } catch {
            // Skip corrupted or unreadable history files
          }
        }
      }

      for (const token of tokens) {
        let tokenMatched = false;
        if (filePathLower.includes(token)) {
          score += FIELD_WEIGHT.path;
          tokenMatched = true;
        }
        if (nameLower.includes(token) || idLower.includes(token)) {
          score += FIELD_WEIGHT.identifier;
          tokenMatched = true;
        }
        if (reasoningLower.includes(token)) {
          score += FIELD_WEIGHT.reasoning;
          tokenMatched = true;
        }
        if (code && code.includes(token)) {
          score += FIELD_WEIGHT.code;
          tokenMatched = true;
        }
        if (tokenMatched) matchedTerms.add(token);
      }

      if (score > 0) {
        scored.push({ ...node, matched_via: 'fuzzy' as const, matched_terms: Array.from(matchedTerms), score });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, 20);
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
      WHERE h.reasoning LIKE ? ESCAPE '\\'
      ORDER BY h.updated_at DESC
      LIMIT ?
    `);
    const query = `%Developer: %${this.likeEscape(developer)}%`;
    return stmt.all(query, limit) as { node_id: string; node_name: string; updated_at: string; reasoning: string }[];
  }

  getChangesByRequirement(requirementId: string): { node_id: string; node_name: string; updated_at: string; reasoning: string }[] {
    const stmt = this.db.prepare(`
      SELECT h.node_id, n.name as node_name, h.updated_at, h.reasoning
      FROM history h
      JOIN nodes n ON h.node_id = n.id
      WHERE h.reasoning LIKE ? ESCAPE '\\'
      ORDER BY h.updated_at DESC
    `);
    const query = `%Requirement: %${this.likeEscape(requirementId)}%`;
    return stmt.all(query) as { node_id: string; node_name: string; updated_at: string; reasoning: string }[];
  }

  searchDecisions(query: string): { node_id: string; node_name: string; updated_at: string; reasoning: string }[] {
    const stmt = this.db.prepare(`
      SELECT h.node_id, n.name as node_name, h.updated_at, h.reasoning
      FROM history h
      JOIN nodes n ON h.node_id = n.id
      WHERE h.reasoning LIKE ? ESCAPE '\\'
      ORDER BY h.updated_at DESC
    `);
    const wildcard = `%Decision: %${this.likeEscape(query)}%`;
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
      WHERE deprecated = 0
        AND id NOT IN (SELECT DISTINCT source_node_id FROM node_connections)
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
      // file_path is stored with OS-native separators (backslashes on Windows), but the tool's
      // own schema example is forward-slash ("src/components") — a raw LIKE against the
      // unmodified column means that exact example returns nothing on Windows unless the
      // caller happens to pass backslashes instead. Normalize both sides to forward slashes
      // (getNodesByFilePath a few hundred lines up already does the equivalent for exact
      // matches; this just extends the same fix to the substring-filter path) and escape LIKE
      // metacharacters so a literal '%' or '_' in a path segment can't be misread as a wildcard.
      sql += " AND REPLACE(file_path, '\\', '/') LIKE ? ESCAPE '\\'";
      params.push(`%${this.likeEscape(filter.file_path.replace(/\\/g, '/'))}%`);
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

  // ─── `devsmind analyze` read-only health checks ────────────────────────────
  // All pure queries/graph traversal, no mutation, no LLM calls.

  /** Nodes whose total (in + out) connection degree meets/exceeds `threshold` — architectural bottleneck candidates. */
  getGodEntities(threshold = 15): { id: string; name: string; file_path: string; degree: number }[] {
    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT n.id, n.name, n.file_path, (
          (SELECT COUNT(*) FROM node_connections c WHERE c.source_node_id = n.id) +
          (SELECT COUNT(*) FROM node_connections c WHERE c.target_node_id = n.id)
        ) AS degree
        FROM nodes n
        WHERE n.deprecated = 0
      )
      WHERE degree >= ?
      ORDER BY degree DESC
    `);
    return stmt.all(threshold) as { id: string; name: string; file_path: string; degree: number }[];
  }

  /** DFS cycle detection over the connection graph, capped at `maxCycles` reported paths. */
  getCircularDependencies(maxCycles = 50): string[][] {
    const edges = this.getAllConnections();
    const adjacency = new Map<string, string[]>();
    for (const e of edges) {
      if (!adjacency.has(e.source_node_id)) adjacency.set(e.source_node_id, []);
      adjacency.get(e.source_node_id)!.push(e.target_node_id);
    }

    const cycles: string[][] = [];
    const visited = new Set<string>();
    const stack: string[] = [];
    const onStack = new Set<string>();

    const dfs = (node: string) => {
      if (cycles.length >= maxCycles) return;
      if (onStack.has(node)) {
        const start = stack.indexOf(node);
        cycles.push([...stack.slice(start), node]);
        return;
      }
      if (visited.has(node)) return;
      visited.add(node);
      stack.push(node);
      onStack.add(node);
      for (const next of adjacency.get(node) || []) {
        if (cycles.length >= maxCycles) break;
        dfs(next);
      }
      stack.pop();
      onStack.delete(node);
    };

    for (const node of adjacency.keys()) {
      if (cycles.length >= maxCycles) break;
      if (!visited.has(node)) dfs(node);
    }
    return cycles;
  }

  /** node_connections rows whose source or target no longer exists in `nodes` (broken by a non-transactional delete, or a sync race). */
  getDanglingEdges(): DbConnection[] {
    const stmt = this.db.prepare(`
      SELECT * FROM node_connections
      WHERE source_node_id NOT IN (SELECT id FROM nodes)
         OR target_node_id NOT IN (SELECT id FROM nodes)
    `);
    return stmt.all() as DbConnection[];
  }

  /** Deletes a single dangling `node_connections` row. The edge itself is invalid data — no history/graph JSON to rewrite. */
  deleteDanglingEdge(sourceId: string, targetId: string) {
    this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ? AND target_node_id = ?').run(sourceId, targetId);
  }

  /** Node ids that differ only by case — a real collision risk on Windows's case-insensitive filesystem. */
  getDuplicateNodeIds(): { lowerId: string; ids: string[] }[] {
    const stmt = this.db.prepare(`
      SELECT LOWER(id) AS lower_id, GROUP_CONCAT(id, '|') AS ids
      FROM nodes
      WHERE deprecated = 0
      GROUP BY lower_id
      HAVING COUNT(*) > 1
    `);
    const rows = stmt.all() as { lower_id: string; ids: string }[];
    return rows.map(r => ({ lowerId: r.lower_id, ids: r.ids.split('|') }));
  }

  /** History rows whose flattened `reasoning` text has no non-empty `Developer:` line — can't be attributed to anyone. */
  getHistoryMissingDeveloper(): { id: string; node_id: string; updated_at: string }[] {
    const stmt = this.db.prepare('SELECT id, node_id, updated_at, reasoning FROM history');
    const rows = stmt.all() as { id: string; node_id: string; updated_at: string; reasoning: string }[];
    return rows
      .filter(r => {
        // [ \t]* (not \s*) so the match can't swallow the newline and bleed into the
        // next "Model:" line when Developer is blank, which would wrongly capture
        // "Model: <value>" as if it were the developer's name.
        const match = /Developer:[ \t]*([^\n]*)/i.exec(r.reasoning || '');
        return !match || !match[1].trim();
      })
      .map(({ id, node_id, updated_at }) => ({ id, node_id, updated_at }));
  }

  /**
   * History rows with a blank code snapshot — usually a silent AST extraction failure.
   * The `history.code_snapshot` DB column is always written as `''` (the real content
   * lives only in the per-row JSON on disk, see `populateHistoryFromDisk`), so this
   * must read through the populated rows rather than querying the column directly.
   */
  getEmptyCodeSnapshots(): { id: string; node_id: string; updated_at: string }[] {
    return this.getAllHistory()
      .filter(h => !h.code_snapshot || h.code_snapshot.trim() === '')
      .map(({ id, node_id, updated_at }) => ({ id, node_id, updated_at }));
  }

  // ─── Workflow Context Vault ─────────────────────────────────────────────
  // Persistent, cross-session feature memory. Steps link to existing `history`
  // rows rather than duplicating code/reasoning; artifacts are plain files on
  // disk under `.devmind/workflows/<id>/`, with only the path stored in the DB.

  private workflowsDir(): string {
    return path.join(path.dirname(this.dbPath), 'workflows');
  }

  /** Serializes the workflow + its steps + artifact index to disk so teammates can sync it via git. */
  private writeWorkflowToDisk(workflowId: string): void {
    try {
      const workflow = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as DbWorkflow | undefined;
      if (!workflow) return;
      const steps = this.db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_index ASC').all(workflowId) as DbWorkflowStep[];
      const artifacts = this.db.prepare('SELECT * FROM workflow_artifacts WHERE workflow_id = ? ORDER BY created_at ASC').all(workflowId) as DbWorkflowArtifact[];
      const activeId = this.getSystemMeta('active_workflow_id');
      const data = {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        status: workflow.status,
        created_at: workflow.created_at,
        updated_at: workflow.updated_at,
        is_active: activeId === workflowId,
        steps: steps.map(s => ({
          id: s.id,
          step_index: s.step_index,
          summary: s.summary,
          pending_tasks: s.pending_tasks,
          history_ids: s.history_ids,
          session_id: s.session_id,
          created_at: s.created_at
        })),
        artifact_index: artifacts.map(a => ({
          id: a.id,
          step_id: a.step_id,
          type: a.type,
          source_name: a.source_name,
          file_path: a.file_path,
          created_at: a.created_at
        }))
      };
      const dir = path.join(this.workflowsDir(), workflowId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('⚠️ DevsMind: Failed to write workflow JSON to disk:', err);
    }
  }

  createWorkflow(name: string, description: string): DbWorkflow {
    const id = `wf_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workflows (id, name, description, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(id, name, description, now, now);
    this.setSystemMeta('active_workflow_id', id);
    this.writeWorkflowToDisk(id);
    return { id, name, description, status: 'active', created_at: now, updated_at: now };
  }

  getWorkflow(id: string): DbWorkflow | null {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as DbWorkflow | undefined;
    return row || null;
  }

  getActiveWorkflow(): DbWorkflow | null {
    const id = this.getSystemMeta('active_workflow_id');
    return id ? this.getWorkflow(id) : null;
  }

  listWorkflows(status?: 'active' | 'paused' | 'completed'): DbWorkflow[] {
    if (status) {
      return this.db.prepare('SELECT * FROM workflows WHERE status = ? ORDER BY updated_at DESC').all(status) as DbWorkflow[];
    }
    return this.db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all() as DbWorkflow[];
  }

  /** Pauses the currently active workflow (if any) and clears the active pointer. */
  pauseWorkflow(): DbWorkflow | null {
    const active = this.getActiveWorkflow();
    if (!active) return null;
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE workflows SET status = 'paused', updated_at = ? WHERE id = ?`).run(now, active.id);
    this.setSystemMeta('active_workflow_id', '');
    this.writeWorkflowToDisk(active.id);
    return { ...active, status: 'paused', updated_at: now };
  }

  /** Resumes `id`, auto-pausing whatever was previously active (only one workflow is active at a time). */
  resumeWorkflow(id: string): DbWorkflow {
    const workflow = this.getWorkflow(id);
    if (!workflow) throw new Error(`Workflow not found: ${id}`);
    const currentActive = this.getActiveWorkflow();
    if (currentActive && currentActive.id !== id) this.pauseWorkflow();
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE workflows SET status = 'active', updated_at = ? WHERE id = ?`).run(now, id);
    this.setSystemMeta('active_workflow_id', id);
    this.writeWorkflowToDisk(id);
    return { ...workflow, status: 'active', updated_at: now };
  }

  completeWorkflow(id: string): DbWorkflow {
    const workflow = this.getWorkflow(id);
    if (!workflow) throw new Error(`Workflow not found: ${id}`);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE workflows SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, id);
    if (this.getSystemMeta('active_workflow_id') === id) this.setSystemMeta('active_workflow_id', '');
    this.writeWorkflowToDisk(id);
    return { ...workflow, status: 'completed', updated_at: now };
  }

  addWorkflowStep(workflowId: string, opts: { summary: string; pendingTasks?: string; historyIds?: string[]; sessionId?: string }): DbWorkflowStep {
    if (!this.getWorkflow(workflowId)) throw new Error(`Workflow not found: ${workflowId}`);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const nextIndex = ((this.db.prepare('SELECT MAX(step_index) AS m FROM workflow_steps WHERE workflow_id = ?').get(workflowId) as { m: number | null }).m ?? 0) + 1;
    const historyIdsJson = opts.historyIds && opts.historyIds.length ? JSON.stringify(opts.historyIds) : null;
    this.db.prepare(`
      INSERT INTO workflow_steps (id, workflow_id, step_index, summary, pending_tasks, history_ids, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, workflowId, nextIndex, opts.summary, opts.pendingTasks || null, historyIdsJson, opts.sessionId || null, now);
    this.db.prepare(`UPDATE workflows SET updated_at = ? WHERE id = ?`).run(now, workflowId);
    this.writeWorkflowToDisk(workflowId);
    return { id, workflow_id: workflowId, step_index: nextIndex, summary: opts.summary, pending_tasks: opts.pendingTasks || null, history_ids: historyIdsJson, session_id: opts.sessionId || null, created_at: now };
  }

  /** Writes `content` to `.devmind/workflows/<workflowId>/<artifactId>_<sourceName>` and records the DB row. */
  addWorkflowArtifact(workflowId: string, opts: { stepId?: string; type: string; sourceName: string; content: string }): DbWorkflowArtifact {
    if (!this.getWorkflow(workflowId)) throw new Error(`Workflow not found: ${workflowId}`);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const safeName = opts.sourceName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'artifact.md';
    const dir = path.join(this.workflowsDir(), workflowId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${id}_${safeName}`);
    fs.writeFileSync(filePath, opts.content, 'utf-8');
    this.db.prepare(`
      INSERT INTO workflow_artifacts (id, workflow_id, step_id, type, source_name, file_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, workflowId, opts.stepId || null, opts.type, opts.sourceName, filePath, now);
    this.db.prepare(`UPDATE workflows SET updated_at = ? WHERE id = ?`).run(now, workflowId);
    this.writeWorkflowToDisk(workflowId);
    return { id, workflow_id: workflowId, step_id: opts.stepId || null, type: opts.type, source_name: opts.sourceName, file_path: filePath, created_at: now };
  }

  getWorkflowContext(id: string, opts?: { includeArtifactContent?: boolean }): { workflow: DbWorkflow; steps: DbWorkflowStep[]; artifacts: (DbWorkflowArtifact & { content?: string })[] } {
    const workflow = this.getWorkflow(id);
    if (!workflow) throw new Error(`Workflow not found: ${id}`);
    const steps = this.db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_index ASC').all(id) as DbWorkflowStep[];
    const artifactRows = this.db.prepare('SELECT * FROM workflow_artifacts WHERE workflow_id = ? ORDER BY created_at ASC').all(id) as DbWorkflowArtifact[];
    const artifacts: (DbWorkflowArtifact & { content?: string })[] = artifactRows.map(a => {
      if (!opts?.includeArtifactContent) return a;
      try {
        const content = fs.existsSync(a.file_path) ? fs.readFileSync(a.file_path, 'utf-8') : undefined;
        return { ...a, content };
      } catch {
        return a;
      }
    });
    return { workflow, steps, artifacts };
  }

  /**
   * Returns steps for a workflow with optional pagination.
   * Use `last_n` to get only the most recent N steps (tail), or `limit`/`offset` for
   * arbitrary pagination. Without any option, all steps are returned.
   */
  getWorkflowSteps(
    workflowId: string,
    opts?: { limit?: number; offset?: number; last_n?: number }
  ): DbWorkflowStep[] {
    if (!this.getWorkflow(workflowId)) throw new Error(`Workflow not found: ${workflowId}`);
    if (opts?.last_n && opts.last_n > 0) {
      // Fetch the last N steps by descending step_index, then reverse to chronological
      const rows = this.db.prepare(
        'SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_index DESC LIMIT ?'
      ).all(workflowId, opts.last_n) as DbWorkflowStep[];
      return rows.reverse();
    }
    if (opts?.limit) {
      return this.db.prepare(
        'SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_index ASC LIMIT ? OFFSET ?'
      ).all(workflowId, opts.limit, opts.offset ?? 0) as DbWorkflowStep[];
    }
    return this.db.prepare(
      'SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_index ASC'
    ).all(workflowId) as DbWorkflowStep[];
  }

  /**
   * Reads a single workflow artifact's file content from disk.
   * Accepts either an artifact_id or a source_name (first match used).
   */
  readWorkflowArtifact(workflowId: string, artifactId: string): { artifact: DbWorkflowArtifact; content: string } {
    if (!this.getWorkflow(workflowId)) throw new Error(`Workflow not found: ${workflowId}`);
    const row = this.db.prepare(
      'SELECT * FROM workflow_artifacts WHERE workflow_id = ? AND id = ?'
    ).get(workflowId, artifactId) as DbWorkflowArtifact | undefined;
    if (!row) throw new Error(`Artifact not found: ${artifactId} in workflow ${workflowId}`);
    if (!fs.existsSync(row.file_path)) throw new Error(`Artifact file missing on disk: ${row.file_path}`);
    const content = fs.readFileSync(row.file_path, 'utf-8');
    return { artifact: row, content };
  }

  /**
   * Full-text keyword search across all workflows' step summaries, pending_tasks,
   * and artifact source names. Optionally also searches artifact file content.
   * Returns a list of matches grouped by workflow.
   */
  searchWorkflows(
    query: string,
    opts?: { include_artifact_content?: boolean; status?: 'active' | 'paused' | 'completed' }
  ): Array<{
    workflow: DbWorkflow;
    matched_steps: DbWorkflowStep[];
    matched_artifacts: (DbWorkflowArtifact & { content_snippet?: string })[];
  }> {
    // Escaped so a query containing '%' or '_' matches those characters literally instead of
    // acting as SQL LIKE wildcards — otherwise `query: "%"` matches every row in the project.
    const lq = `%${this.likeEscape(query.toLowerCase())}%`;

    // Find matching steps
    const matchedStepRows = this.db.prepare(`
      SELECT ws.* FROM workflow_steps ws
      JOIN workflows w ON w.id = ws.workflow_id
      WHERE (LOWER(ws.summary) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(ws.pending_tasks,'')) LIKE ? ESCAPE '\\')
      ${opts?.status ? 'AND w.status = ?' : ''}
      ORDER BY ws.workflow_id, ws.step_index ASC
    `).all(...(opts?.status ? [lq, lq, opts.status] : [lq, lq])) as DbWorkflowStep[];

    // Find matching artifacts by source_name
    const matchedArtifactRows = this.db.prepare(`
      SELECT wa.* FROM workflow_artifacts wa
      JOIN workflows w ON w.id = wa.workflow_id
      WHERE LOWER(wa.source_name) LIKE ? ESCAPE '\\'
      ${opts?.status ? 'AND w.status = ?' : ''}
      ORDER BY wa.workflow_id, wa.created_at ASC
    `).all(...(opts?.status ? [lq, opts.status] : [lq])) as DbWorkflowArtifact[];

    // If content search requested, also scan artifact files
    const contentMatchedArtifactIds = new Set<string>();
    const artifactContentSnippets = new Map<string, string>();
    if (opts?.include_artifact_content) {
      const allArtifacts = this.db.prepare(
        `SELECT wa.* FROM workflow_artifacts wa JOIN workflows w ON w.id = wa.workflow_id${opts.status ? ' WHERE w.status = ?' : ''}`
      ).all(...(opts.status ? [opts.status] : [])) as DbWorkflowArtifact[];
      const lqPlain = query.toLowerCase();
      for (const a of allArtifacts) {
        if (contentMatchedArtifactIds.has(a.id)) continue;
        try {
          if (fs.existsSync(a.file_path)) {
            const text = fs.readFileSync(a.file_path, 'utf-8');
            const idx = text.toLowerCase().indexOf(lqPlain);
            if (idx !== -1) {
              contentMatchedArtifactIds.add(a.id);
              const start = Math.max(0, idx - 80);
              const end = Math.min(text.length, idx + query.length + 80);
              artifactContentSnippets.set(a.id, (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : ''));
            }
          }
        } catch { /* skip unreadable */ }
      }
    }

    // Collect all relevant workflow IDs
    const workflowIdSet = new Set<string>([
      ...matchedStepRows.map(s => s.workflow_id),
      ...matchedArtifactRows.map(a => a.workflow_id),
      ...Array.from(contentMatchedArtifactIds).map(id => {
        const r = this.db.prepare('SELECT workflow_id FROM workflow_artifacts WHERE id = ?').get(id) as { workflow_id: string } | undefined;
        return r?.workflow_id || '';
      }).filter(Boolean)
    ]);

    const results: Array<{ workflow: DbWorkflow; matched_steps: DbWorkflowStep[]; matched_artifacts: (DbWorkflowArtifact & { content_snippet?: string })[] }> = [];
    for (const wid of workflowIdSet) {
      const workflow = this.getWorkflow(wid);
      if (!workflow) continue;
      const steps = matchedStepRows.filter(s => s.workflow_id === wid);
      const artByName = matchedArtifactRows.filter(a => a.workflow_id === wid);
      const artByContent: DbWorkflowArtifact[] = opts?.include_artifact_content
        ? (this.db.prepare('SELECT * FROM workflow_artifacts WHERE workflow_id = ?').all(wid) as DbWorkflowArtifact[]).filter(a => contentMatchedArtifactIds.has(a.id) && !artByName.find(x => x.id === a.id))
        : [];
      const allArtifacts: (DbWorkflowArtifact & { content_snippet?: string })[] = [
        ...artByName.map(a => ({ ...a, content_snippet: artifactContentSnippets.get(a.id) })),
        ...artByContent.map(a => ({ ...a, content_snippet: artifactContentSnippets.get(a.id) }))
      ];
      results.push({ workflow, matched_steps: steps, matched_artifacts: allArtifacts });
    }

    // Sort by most recently updated workflow first
    results.sort((a, b) => b.workflow.updated_at.localeCompare(a.workflow.updated_at));
    return results;
  }

  /**
   * Imports an existing flow/architecture doc as a paused workflow (not active — importing
   * a doc isn't the same as declaring active work). Idempotent on `name`: re-importing the
   * same doc overwrites its existing `imported_doc` artifact file in place instead of
   * creating a duplicate workflow every time the source docs are re-imported.
   */
  importWorkflowDoc(name: string, description: string, content: string, sourceFileName: string): { workflow: DbWorkflow; created: boolean } {
    const existing = this.db.prepare('SELECT * FROM workflows WHERE name = ?').get(name) as DbWorkflow | undefined;
    const now = new Date().toISOString();

    if (existing) {
      this.db.prepare(`UPDATE workflows SET description = ?, updated_at = ? WHERE id = ?`).run(description, now, existing.id);
      const existingArtifact = this.db.prepare(
        `SELECT * FROM workflow_artifacts WHERE workflow_id = ? AND type = 'imported_doc' ORDER BY created_at ASC LIMIT 1`
      ).get(existing.id) as DbWorkflowArtifact | undefined;
      if (existingArtifact) {
        fs.writeFileSync(existingArtifact.file_path, content, 'utf-8');
      } else {
        this.addWorkflowArtifact(existing.id, { type: 'imported_doc', sourceName: sourceFileName, content });
      }
      this.writeWorkflowToDisk(existing.id);
      return { workflow: { ...existing, description, updated_at: now }, created: false };
    }

    const id = `wf_${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO workflows (id, name, description, status, created_at, updated_at)
      VALUES (?, ?, ?, 'paused', ?, ?)
    `).run(id, name, description, now, now);
    this.addWorkflowStep(id, { summary: `Imported existing flow documentation: ${sourceFileName}` });
    this.addWorkflowArtifact(id, { type: 'imported_doc', sourceName: sourceFileName, content });
    // writeWorkflowToDisk is already called inside addWorkflowArtifact/addWorkflowStep above
    return { workflow: { id, name, description, status: 'paused', created_at: now, updated_at: now }, created: true };
  }

  private static readonly SPURIOUS_NODE_NAMES = new Set([
    'promise', 'map', 'set', 'json', 'console', 'error', 'object', 'function', 'array', 'string', 'number', 'boolean', 'regexp', 'date', 'math',
    'any', 'void', 'unknown', 'never', 'null', 'undefined', 'dict', 'list',
    'data', 'useeffect', 'val', 'temp', 'result', 'item', 'key', 'value', 'err', 'req', 'res', 'args', 'params', 'response', 'request'
  ]);

  /**
   * Read-only detection shared by `pruneSpuriousNodes` (which acts on it) and `devsmind
   * analyze`'s dry-run report (which just lists it). Never mutates the DB.
   */
  findSpuriousAndMissingFileNodes(workspaceRoot: string): {
    spurious: { id: string; name: string; file_path: string }[];
    missingFile: { id: string; name: string; file_path: string }[];
  } {
    const stmt = this.db.prepare(`
      SELECT id, name, file_path FROM nodes
      WHERE deprecated = 0
    `);
    const candidates = stmt.all() as { id: string; name: string; file_path: string }[];

    const spurious: { id: string; name: string; file_path: string }[] = [];
    const missingFile: { id: string; name: string; file_path: string }[] = [];

    for (const node of candidates) {
      const lowerName = node.name.toLowerCase();
      if (DevMindDatabase.SPURIOUS_NODE_NAMES.has(lowerName)) {
        spurious.push(node);
        continue;
      }

      if (node.file_path) {
        const paths = node.file_path.split(',').map(p => p.trim()).filter(Boolean);
        if (paths.length > 0) {
          const allMissing = paths.every(p => {
            const resolvedPath = path.isAbsolute(p) ? p : path.resolve(workspaceRoot, p);
            return !fs.existsSync(resolvedPath);
          });
          if (allMissing) missingFile.push(node);
        }
      }
    }

    return { spurious, missingFile };
  }

  pruneSpuriousNodes(workspaceRoot: string): { prunedCount: number; prunedNodes: string[] } {
    const { spurious, missingFile } = this.findSpuriousAndMissingFileNodes(workspaceRoot);
    const candidates = [...spurious, ...missingFile];

    const idsToDelete: string[] = [];
    const namesDeleted: string[] = [];
    const affectedFilePaths = new Set<string>();

    for (const node of candidates) {
      idsToDelete.push(node.id);
      namesDeleted.push(`${node.name} (${node.id})`);
      if (node.file_path) {
        for (const p of node.file_path.split(',').map(s => s.trim()).filter(Boolean)) {
          affectedFilePaths.add(p);
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
    const abs = canonicalizePath(absolutePath).replace(/\\/g, '/');
    const absLower = abs.toLowerCase();
    
    for (const repo of this.context.config.repos) {
      const repoPath = resolveRepoPath(this.context, repo.name);
      if (repoPath) {
        const normalizedRepoPath = canonicalizePath(repoPath).replace(/\\/g, '/');
        const normalizedRepoPathLower = normalizedRepoPath.toLowerCase();
        if (absLower === normalizedRepoPathLower || absLower.startsWith(normalizedRepoPathLower + '/')) {
          const relative = path.relative(normalizedRepoPath, abs).replace(/\\/g, '/');
          return `{${repo.name}}/${relative}`;
        }
      }
    }
    
    // Fallback: resolve relative to workspace root
    const workspaceRoot = canonicalizePath(path.dirname(this.dbPath));
    return path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
  }

  /**
   * Rejects a resolved path that escapes its expected root (e.g. via a stored
   * `{repo}/../../..` path traveling outside the repo) by clamping it back to
   * the root itself. node_id/file_path values flow in from AI-supplied tool
   * calls, so a resolve must never be trusted to stay inside root on its own.
   */
  private clampToRoot(root: string, resolved: string): string {
    const normalizedRoot = canonicalizePath(root);
    const normalizedResolved = canonicalizePath(resolved);
    const rootLower = normalizedRoot.toLowerCase();
    const resolvedLower = normalizedResolved.toLowerCase();
    if (resolvedLower === rootLower || resolvedLower.startsWith(rootLower + path.sep)) {
      return normalizedResolved;
    }
    console.warn(`⚠️ Path traversal blocked: "${resolved}" escapes root "${root}"`);
    return normalizedRoot;
  }

  /**
   * True if `absPath` sits inside a configured repo root or the workspace root itself.
   * Used to reject `stage_change`/`update_history` file paths that would otherwise let a
   * tool call read/write any file on disk (absolute path, or a `../` escape) instead of
   * just repo source — nothing upstream of this validates that the AI-supplied path is
   * actually inside the project.
   */
  /**
   * Gate for every AI-facing write (edit_node, stage_change, the legacy update_history):
   * true only for paths inside a configured repo. `.devmind` itself — this project's OWN
   * config, brain.db, and cached graph JSON — is never writable through these tools, even
   * though it sits next to (and, before this check, was indistinguishable from) real source:
   * without this, a write tool built to "never refuse a file type" would just as happily
   * rewrite devsmind's own config.json as it would application source.
   */
  public isPathAllowed(absPath: string): boolean {
    const abs = canonicalizePath(absPath);
    const absLower = abs.toLowerCase();
    const devmindDirLower = canonicalizePath(path.dirname(this.dbPath)).toLowerCase();
    if (absLower === devmindDirLower || absLower.startsWith(devmindDirLower + path.sep)) return false;
    if (this.context) {
      for (const repo of this.context.config.repos) {
        const repoPath = resolveRepoPath(this.context, repo.name);
        if (repoPath) {
          const normalizedRepoPath = canonicalizePath(repoPath);
          const normalizedRepoPathLower = normalizedRepoPath.toLowerCase();
          if (absLower === normalizedRepoPathLower || absLower.startsWith(normalizedRepoPathLower + path.sep)) return true;
        }
      }
    }
    return false;
  }

  public toAbsolutePath(repoRelativePath: string): string {
    if (!repoRelativePath) return repoRelativePath;
    const workspaceRoot = canonicalizePath(path.dirname(this.dbPath));

    const match = repoRelativePath.match(/^\{([^}]+)\}\/(.*)$/);
    if (match && this.context) {
      const repoName = match[1];
      const relativePath = match[2];
      const repoPath = resolveRepoPath(this.context, repoName);
      if (repoPath) {
        return canonicalizePath(this.clampToRoot(repoPath, path.resolve(repoPath, relativePath)));
      }
    }

    // Heuristic: if it doesn't start with {repoName} but contains a configured repo name in the path
    if (this.context) {
      for (const repo of this.context.config.repos) {
        // Find if repo.name appears as a folder in the path, e.g. "harrir-express-backend/tests/..."
        const escapedRepoName = repo.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp('(?:^|/|\\\\)' + escapedRepoName + '(?:/|\\\\)(.*)$', 'i');
        const m = repoRelativePath.match(regex);
        if (m) {
          const repoPath = resolveRepoPath(this.context, repo.name);
          if (repoPath) {
            const relativePath = m[1];
            return canonicalizePath(path.resolve(repoPath, relativePath));
          }
        }
      }
    }

    // Fallback: resolve relative to workspace root
    return canonicalizePath(this.clampToRoot(workspaceRoot, path.resolve(workspaceRoot, repoRelativePath)));
  }

  syncFromDisk() {
    this.db.pragma('foreign_keys = OFF');
    try {
      const workspaceRoot = path.dirname(this.dbPath);

      // 0. Auto-heal any legacy relative path records in SQLite.
      //
      // Runs on every server start, so getting "already absolute" wrong is not a one-time
      // migration slip — it recurs forever. The original check only recognized the C: drive
      // and POSIX roots ('c:%'/'C:%'/'/%'); SQL LIKE has no character-range syntax, so it could
      // not express "any drive letter" or a UNC path (\\server\share\...) in one pattern. Every
      // node on a D:, E:, ... drive or a UNC path was misclassified as relative, run through
      // toAbsolutePath() -> clampToRoot(), and silently rewritten to the workspace root — i.e.
      // real file_paths for an entire class of valid Windows paths got destroyed on restart.
      // path.isAbsolute() classifies all of these correctly in one call.
      try {
        const legacyNodes = (this.db.prepare('SELECT id, file_path FROM nodes').all() as { id: string; file_path: string }[])
          .filter(n => n.file_path && !path.isAbsolute(n.file_path));
        if (legacyNodes.length > 0) {
          const updateStmt = this.db.prepare('UPDATE nodes SET file_path = ? WHERE id = ?');
          const healTx = this.db.transaction(() => {
            for (const n of legacyNodes) {
              const abs = this.toAbsolutePath(n.file_path);
              updateStmt.run(abs, n.id);
            }
          });
          healTx();
        }
      } catch (err) {
        // ignore legacy errors
      }
      
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

      // 3. Sync Workflow JSONs
      const workflowsDir = this.workflowsDir();
      if (fs.existsSync(workflowsDir)) {
        const upsertWorkflow = this.db.prepare(`
          INSERT INTO workflows (id, name, description, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            status = excluded.status,
            updated_at = excluded.updated_at
        `);
        const upsertStep = this.db.prepare(`
          INSERT OR IGNORE INTO workflow_steps (id, workflow_id, step_index, summary, pending_tasks, history_ids, session_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const upsertArtifact = this.db.prepare(`
          INSERT OR IGNORE INTO workflow_artifacts (id, workflow_id, step_id, type, source_name, file_path, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        // Track which workflow.json has is_active:true with the latest updated_at
        let bestActiveId: string | null = null;
        let bestActiveUpdatedAt = '';

        const syncWorkflowsTx = this.db.transaction(() => {
          const subdirs = fs.readdirSync(workflowsDir);
          for (const subdir of subdirs) {
            const jsonPath = path.join(workflowsDir, subdir, 'workflow.json');
            if (!fs.existsSync(jsonPath)) continue;
            try {
              const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
              if (!data.id || !data.name) continue;

              upsertWorkflow.run(
                data.id, data.name, data.description || '', data.status || 'paused',
                data.created_at || new Date().toISOString(),
                data.updated_at || new Date().toISOString()
              );

              for (const s of (data.steps || [])) {
                if (!s.id) continue;
                upsertStep.run(
                  s.id, data.id, s.step_index, s.summary || '',
                  s.pending_tasks || null, s.history_ids || null, s.session_id || null,
                  s.created_at || new Date().toISOString()
                );
              }

              for (const a of (data.artifact_index || [])) {
                if (!a.id) continue;
                upsertArtifact.run(
                  a.id, data.id, a.step_id || null, a.type || 'unknown',
                  a.source_name || '', a.file_path || '', a.created_at || new Date().toISOString()
                );
              }

              // Track which workflow declared itself active most recently
              if (data.is_active && data.updated_at > bestActiveUpdatedAt) {
                bestActiveId = data.id;
                bestActiveUpdatedAt = data.updated_at;
              }
            } catch { /* skip malformed */ }
          }
        });
        syncWorkflowsTx();

        // Restore active_workflow_id if not already set and a JSON claims active status
        if (bestActiveId && !this.getSystemMeta('active_workflow_id')) {
          this.setSystemMeta('active_workflow_id', bestActiveId);
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
      const workspaceRoot = canonicalizePath(path.dirname(this.dbPath));
      // Clean/resolve the file path
      const absPath = canonicalizePath(filePath);
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
      const absLower = absPath.toLowerCase();
      const absEscLower = absEsc.toLowerCase();
      const stmtNodes = this.db.prepare(`
        SELECT * FROM nodes
        WHERE (
          LOWER(file_path) = ? OR
          LOWER(file_path) LIKE ? ESCAPE '\\' OR
          LOWER(file_path) LIKE ? ESCAPE '\\' OR
          LOWER(file_path) LIKE ? ESCAPE '\\'
        )
      `);
      const nodes = stmtNodes.all(
        absLower,
        `${absEscLower}, %`,
        `%, ${absEscLower}`,
        `%, ${absEscLower}, %`
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

  /** Force-syncs all database nodes and workflows to disk JSON files. */
  syncToDisk(): void {
    try {
      const rows = this.db.prepare('SELECT DISTINCT file_path FROM nodes').all() as { file_path: string }[];
      const filePaths = new Set<string>();
      for (const row of rows) {
        if (row.file_path) {
          for (const p of row.file_path.split(',').map(s => s.trim()).filter(Boolean)) {
            filePaths.add(p);
          }
        }
      }

      for (const filePath of filePaths) {
        this.writeGraphToDisk(filePath);
      }

      const workflowRows = this.db.prepare('SELECT id FROM workflows').all() as { id: string }[];
      for (const row of workflowRows) {
        this.writeWorkflowToDisk(row.id);
      }
    } catch (err) {
      console.warn('⚠️ DevsMind: Failed to sync database to disk:', err);
    }
  }
}
