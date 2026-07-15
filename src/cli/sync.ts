import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { resolveDevmindDir } from '../utils/config';
import { DevMindDatabase } from '../db/database';

/**
 * `devsmind sync` — force the on-disk graph (`graph/**`) and history
 * (`history/*.json`) into the local `brain.db`.
 *
 * Under `--stdio` (VS Code and other IDE-managed setups) the MCP process is
 * spawned by the editor and never serves the HTTP routes that would otherwise
 * trigger a sync, and the DB's constructor-time `syncFromDisk()` only runs once
 * per process. So after a `git pull` the committed graph changes never reach the
 * local DB without a restart. This command applies them on demand.
 */
export async function handleSync(opts: { path?: string }): Promise<void> {
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
  const before = readRawCounts(dbPath);

  // Constructing the DB runs syncFromDisk() once; we call it again explicitly so
  // the behaviour is obvious and robust even if the constructor changes later.
  const db = new DevMindDatabase(dbPath);
  try {
    db.syncFromDisk();
    const after = db.getCounts();

    const delta = (a: number, b: number): string => {
      const d = b - a;
      return d === 0 ? '' : ` (${d > 0 ? '+' : ''}${d})`;
    };

    console.log(`\n✅ Sync complete.`);
    console.log(`   Nodes       : ${after.nodes}${delta(before.nodes, after.nodes)}`);
    console.log(`   Connections : ${after.connections}${delta(before.connections, after.connections)}`);
    console.log(`   History     : ${after.history}${delta(before.history, after.history)}\n`);
  } finally {
    db.close();
  }
}

/** Count rows in an existing brain.db without triggering a sync. Missing file or tables → zeros. */
function readRawCounts(dbPath: string): { nodes: number; connections: number; history: number } {
  const zero = { nodes: 0, connections: 0, history: 0 };
  if (!fs.existsSync(dbPath)) return zero;
  let raw: Database.Database | null = null;
  try {
    raw = new Database(dbPath, { readonly: true });
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
  } catch {
    return zero;
  } finally {
    if (raw) raw.close();
  }
}
