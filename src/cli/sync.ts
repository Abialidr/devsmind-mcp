import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { resolveDevmindDir } from '../utils/config';
import { DevMindDatabase } from '../db/database';
import { runAnalysis } from '../db/analyze';
import { printReport } from './analyze';
import { renderSyncProgress, clearSyncProgressLine } from './sync-progress';

/**
 * `devsmind sync` — force the on-disk graph (`graph/**`) and history
 * (`history/*.json`) into the local `brain.db`.
 *
 * Under `--stdio` (VS Code and other IDE-managed setups) the MCP process is
 * spawned by the editor and never serves the HTTP routes that would otherwise
 * trigger a sync, and the DB's constructor-time `syncFromDisk()` only runs once
 * per process. So after a `git pull` the committed graph changes never reach the
 * local DB without a restart. This command applies them on demand.
 *
 * `--analyze` (optionally with `--fix`) runs `devsmind analyze` immediately after,
 * on the same connection — the natural place to catch drift a teammate's changes
 * introduced, right when you pull them in.
 */
export async function handleSync(opts: { path?: string; analyze?: boolean; fix?: boolean; godEntityThreshold?: string }): Promise<void> {
  const devmindDir = resolveDevmindDir(opts.path);

  if (!devmindDir) {
    console.error(
      `❌ No .devmind directory found.\n` +
      `   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.`
    );
    process.exit(1);
  }

  const dbPath = path.join(devmindDir, 'brain.db');
  console.log(`\n🔄 DevsMind — Sync graph from disk`);
  console.log(`   Brain : ${devmindDir.replace(/\\/g, '/')}`);

  // Read the pre-sync counts straight from the existing brain.db file (if any),
  // BEFORE DevMindDatabase's constructor runs syncFromDisk(). This lets us show
  // an honest delta of what the sync actually pulled in.
  let before: { nodes: number; connections: number; history: number };
  try {
    before = readRawCounts(dbPath);
  } catch (err) {
    console.error(`\n❌ ${(err as Error).message}`);
    process.exit(1);
  }

  // Constructing the DB runs syncFromDisk() once; we call it again explicitly so
  // the behaviour is obvious and robust even if the constructor changes later.
  const db = new DevMindDatabase(dbPath, { onSyncProgress: renderSyncProgress });
  clearSyncProgressLine();
  try {
    db.syncFromDisk(renderSyncProgress);
    clearSyncProgressLine();
    db.syncToDisk();
    const after = db.getCounts();

    const delta = (a: number, b: number): string => {
      const d = b - a;
      return d === 0 ? '' : ` (${d > 0 ? '+' : ''}${d})`;
    };

    console.log(`\n✅ Sync complete.`);
    console.log(`   Nodes       : ${after.nodes}${delta(before.nodes, after.nodes)}`);
    console.log(`   Connections : ${after.connections}${delta(before.connections, after.connections)}`);
    console.log(`   History     : ${after.history}${delta(before.history, after.history)}\n`);

    if (opts.analyze) {
      const godEntityThreshold = opts.godEntityThreshold ? parseInt(opts.godEntityThreshold, 10) : undefined;
      console.log(`🩺 Running analyze${opts.fix ? ' (--fix)' : ''}...`);
      const report = runAnalysis(db, path.dirname(devmindDir), { fix: opts.fix === true, godEntityThreshold });
      printReport(report);
    }
  } finally {
    db.close();
  }
}

/**
 * Count rows in an existing brain.db without triggering a sync. A missing file is a
 * legitimate zero (first-ever sync). A file that exists but fails to OPEN (corrupt/
 * truncated SQLite) is NOT a legitimate zero — that would print a misleading "+500"
 * delta as if the DB were simply empty, masking real corruption. Per-table read
 * failures (e.g. a table missing on an older schema) still fall back to 0.
 */
function readRawCounts(dbPath: string): { nodes: number; connections: number; history: number } {
  const zero = { nodes: 0, connections: 0, history: 0 };
  if (!fs.existsSync(dbPath)) return zero;
  let raw: Database.Database | null = null;
  try {
    raw = new Database(dbPath, { readonly: true });
    // better-sqlite3 opens lazily — a garbage/truncated file doesn't throw until the
    // first real read, so force one here to detect corruption up front rather than
    // letting per-table reads below silently swallow it into a misleading zero.
    raw.prepare('SELECT 1').get();
  } catch (err) {
    if (raw) raw.close();
    throw new Error(`brain.db exists but could not be read (${(err as Error).message}) — it may be corrupted. Investigate before syncing, or remove it to start fresh.`);
  }
  try {
    const one = (sql: string): number => {
      try {
        const row = raw!.prepare(sql).get() as { c: number } | undefined;
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
  } finally {
    raw.close();
  }
}
