import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { resolveDevmindDir, loadProjectContext, findMissingStandaloneRepoPaths, SKIPPED_REPO_MARKER } from '../utils/config';
import { DevMindDatabase } from '../db/database';
import { runAnalysis } from '../db/analyze';
import { printReport } from './analyze';
import { renderSyncProgress, clearSyncProgressLine } from './sync-progress';
import { browseForDir, confirmPrompt, selectPrompt, CancelledError } from './integrations/prompt';
import { handleRule } from './rule';
import { handleSkill } from './integrations/skill';

/**
 * Standalone mode only: `config.json` may now name a repo this machine's `.env` has no path
 * for yet — a teammate ran `devsmind add-repo` (or `init`) and pushed the change, but nothing
 * updates `.env`/rule/skill files on ITS OWN just because a pull brought that in. Detected here
 * so `devsmind sync`/`devsmind pull` catch it rather than leaving rule/skill silently describing
 * a smaller repo set than what's actually configured.
 *
 * Interactive only — a non-TTY run (CI, a script) prints a warning and skips straight to the
 * sync itself rather than hanging on a prompt that can't be answered; the missing repo(s) just
 * won't sync until someone runs this from a real terminal.
 */
export async function reconcileRepoPaths(devmindDir: string): Promise<void> {
  const ctx = loadProjectContext(devmindDir);
  const { ok, missing, invalid, skipped } = findMissingStandaloneRepoPaths(ctx.config, ctx.env);
  if (missing.length === 0 && invalid.length === 0) return;

  const needsPath = [...missing, ...invalid.map(i => i.repo)];
  console.log(`\n🔍 DevsMind — Repo list changed since this machine last synced`);
  console.log(`   ${needsPath.length} repo(s) need a local path here (likely "devsmind add-repo" ran elsewhere): ${needsPath.map(r => r.name).join(', ')}`);

  if (!process.stdout.isTTY) {
    console.log(`   ⚠️  Non-interactive session — skipping the path prompt. Add ${needsPath.map(r => r.path_key).join('/')} to .env manually, or re-run this from a terminal.\n`);
    return;
  }

  // Rebuild .env from KNOWN-good state — the already-valid repo paths (`ok`) plus every
  // non-repo-path key untouched — rather than filtering the raw file line by line, so a stale
  // `invalid` entry's old line can't survive alongside the freshly-resolved replacement for the
  // same key (same rebuild-not-patch approach devsmind init's existing-brain repair step uses).
  const envLines: string[] = [];
  for (const { repo, currentPath } of ok) envLines.push(`${repo.path_key}=${currentPath}`);
  // Already-skipped repos need no prompt — carry their marker forward untouched, same as `ok`.
  for (const repo of skipped) envLines.push(`${repo.path_key}=${SKIPPED_REPO_MARKER}`);
  const repoPathKeys = new Set(ctx.config.repos.map(r => 'path_key' in r ? r.path_key : undefined).filter(Boolean));
  for (const [key, value] of Object.entries(ctx.env)) {
    if (!repoPathKeys.has(key)) envLines.push(`${key}=${value}`);
  }

  for (const repo of needsPath) {
    if (!repo.path_key) continue;
    const invalidEntry = invalid.find(i => i.repo.name === repo.name);
    const choice = await selectPrompt(
      `Repo "${repo.name}" (${repo.path_key})`,
      [
        { title: '📂 Browse for its local folder', value: 'browse' as const },
        { title: `⏭️  Skip — not on this machine`, value: 'skip' as const },
      ],
      0
    );
    if (choice === 'skip') {
      envLines.push(`${repo.path_key}=${SKIPPED_REPO_MARKER}`);
      continue;
    }
    const localPath = await browseForDir(
      `Select the local folder for repo "${repo.name}" (${repo.path_key})`,
      invalidEntry?.currentPath || process.cwd()
    );
    if (localPath === null) { console.log('\nCancelled.'); throw new CancelledError(); }
    envLines.push(`${repo.path_key}=${localPath}`);
  }
  const envPath = path.join(devmindDir, '.env');
  fs.writeFileSync(envPath, envLines.join('\n') + '\n', 'utf-8');
  console.log(`   💾 Updated ${envPath.replace(/\\/g, '/')}`);

  // The repo list just grew — rule/skill were generated against the OLD, shorter list. Walk
  // through refreshing them, one tool at a time, looping so more than one can be updated.
  console.log(`\n📋 Your devsmind rule/skill files may now be stale — they don't mention the new repo yet.`);
  let addRule = await confirmPrompt('Update devsmind rule for a tool now?', true);
  while (addRule) {
    await handleRule({ path: devmindDir });
    addRule = await confirmPrompt('Update the rule for another tool too?', false);
  }
  let addSkill = await confirmPrompt('Update devsmind skill for a tool now?', true);
  while (addSkill) {
    await handleSkill({ path: devmindDir });
    addSkill = await confirmPrompt('Update the skill for another tool too?', false);
  }
  console.log(`\nℹ️  If your tool has its own memory feature, run "devsmind memory" too — the repo list it should mention just changed.\n`);
}

/**
 * `devsmind sync` — force the on-disk graph (`graph/**`), history (`history/*.json`),
 * vectors (`vectors/**`), and workflows (`workflows/‹id›/workflow.json`) into the local
 * `brain.db` (`syncFromDisk`), then force-writes graph/vectors/workflows back out from
 * that DB state (`syncToDisk` — history is written immediately elsewhere, not here).
 * The printed summary reports all five counts (Nodes/Connections/History/Vectors/
 * Workflows) with their delta from before the run, so it's visible which of them the
 * sync actually touched, not just nodes.
 *
 * Under `--stdio` (VS Code and other IDE-managed setups) the MCP process is
 * spawned by the editor and never serves the HTTP routes that would otherwise
 * trigger a sync, and the DB's constructor-time `syncFromDisk()` only runs once
 * per process. So after a `git pull` the committed graph changes never reach the
 * local DB without a restart. This command applies them on demand.
 *
 * Starts with {@link reconcileRepoPaths} — standalone mode only, and a no-op the vast
 * majority of runs (nothing missing), so this stays exactly as fast as before whenever
 * there's nothing to reconcile.
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

  try {
    await reconcileRepoPaths(devmindDir);
  } catch (err) {
    if (err instanceof CancelledError) return;
    throw err;
  }

  const dbPath = path.join(devmindDir, 'brain.db');
  console.log(`\n🔄 DevsMind — Sync graph from disk`);
  console.log(`   Brain : ${devmindDir.replace(/\\/g, '/')}`);

  // Read the pre-sync counts straight from the existing brain.db file (if any),
  // BEFORE DevMindDatabase's constructor runs syncFromDisk(). This lets us show
  // an honest delta of what the sync actually pulled in.
  let before: { nodes: number; connections: number; history: number; vectors: number; workflows: number };
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

    // All five reported here because all five actually round-trip through sync now — vectors
    // and workflows included, not just nodes/connections/history — see syncToDisk's own comment.
    console.log(`\n✅ Sync complete.`);
    console.log(`   Nodes       : ${after.nodes}${delta(before.nodes, after.nodes)}`);
    console.log(`   Connections : ${after.connections}${delta(before.connections, after.connections)}`);
    console.log(`   History     : ${after.history}${delta(before.history, after.history)}`);
    console.log(`   Vectors     : ${after.vectors}${delta(before.vectors, after.vectors)}`);
    console.log(`   Workflows   : ${after.workflows}${delta(before.workflows, after.workflows)}\n`);

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
function readRawCounts(dbPath: string): { nodes: number; connections: number; history: number; vectors: number; workflows: number } {
  const zero = { nodes: 0, connections: 0, history: 0, vectors: 0, workflows: 0 };
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
      vectors: one('SELECT COUNT(*) AS c FROM node_vectors'),
      workflows: one('SELECT COUNT(*) AS c FROM workflows'),
    };
  } finally {
    raw.close();
  }
}
