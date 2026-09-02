import * as path from 'path';
import { resolveDevmindDir } from '../utils/config';
import { DevMindDatabase } from '../db/database';
import { pushDevsmindBranch, pullDevsmindBranch, DEVSMIND_BRANCH } from '../utils/devsmind-branch';
import { textPrompt, CancelledError } from './integrations/prompt';
import { reconcileRepoPaths } from './sync';

function requireDevmindDir(opts: { path?: string }): string {
  const devmindDir = resolveDevmindDir(opts.path);
  if (!devmindDir) {
    console.error(
      `❌ No .devsmind directory found (nor a legacy .devmind one).\n` +
      `   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.`
    );
    process.exit(1);
  }
  return devmindDir;
}

/**
 * `devsmind push` — commits the current graph/history/vectors/workflows onto the dedicated
 * `devsmind` branch and pushes it, leaving your actual checked-out branch untouched. See
 * `utils/devsmind-branch.ts` for why: this is what keeps a PR diff to your real code changes
 * instead of the hundreds of graph/history files DevsMind itself writes.
 */
export async function handlePush(opts: { path?: string; message?: string }): Promise<void> {
  const devmindDir = requireDevmindDir(opts);

  let message = opts.message?.trim();
  if (!message) {
    if (!process.stdout.isTTY) {
      console.error(`❌ devsmind push needs a commit message. Pass --message "<text>" (non-interactive session, cannot prompt).`);
      process.exit(1);
    }
    try {
      message = await textPrompt('Commit message for the devsmind branch:', {
        validate: v => v.trim().length > 0 || 'A message is required.'
      });
    } catch (err) {
      if (err instanceof CancelledError) { console.log('\nCancelled.'); return; }
      throw err;
    }
  }

  console.log(`\n📤 DevsMind — Push to '${DEVSMIND_BRANCH}'`);
  console.log(`   Brain : ${devmindDir.replace(/\\/g, '/')}`);

  const result = pushDevsmindBranch(devmindDir, message);

  if (!result.committed && !result.pushed) {
    console.log(`\n✅ Nothing to push — '${result.branch}' already matches, and is already up to date with the remote.\n`);
    return;
  }

  if (result.committed) {
    console.log(`\n✅ Committed to '${result.branch}': ${result.filesChanged} file(s) changed (${result.commit?.slice(0, 8)}).`);
  } else {
    console.log(`\n✅ Nothing new to commit, but '${result.branch}' had an earlier commit not yet on the remote (${result.commit?.slice(0, 8)}).`);
  }
  if (result.pushed) {
    console.log(`   Pushed to ${result.remote}/${result.branch}.\n`);
  } else {
    console.log(`   Not pushed — no git remote configured. Committed locally only.\n`);
  }
}

/**
 * `devsmind pull` — the read side of `devsmind push`: copies graph/history/vectors/workflows
 * down from the `devsmind` branch (preferring the remote-tracking ref when a remote exists)
 * into the real `.devsmind/` on disk, then fully re-syncs `brain.db` from it (both directions,
 * same as `devsmind sync`). Needed because a fresh clone of the code branch alone no longer
 * carries that data — see CHANGELOG 4.3.0.
 *
 * Runs the SAME `reconcileRepoPaths` pre-flight `devsmind sync` does — a pull is exactly the
 * other moment (besides a plain `sync`) a repo a teammate added elsewhere would first become
 * visible on this machine, so it needs the same catch-up walkthrough, not a thinner copy of it.
 */
export async function handlePull(opts: { path?: string }): Promise<void> {
  const devmindDir = requireDevmindDir(opts);

  try {
    await reconcileRepoPaths(devmindDir);
  } catch (err) {
    if (err instanceof CancelledError) return;
    throw err;
  }

  console.log(`\n📥 DevsMind — Pull from '${DEVSMIND_BRANCH}'`);
  console.log(`   Brain : ${devmindDir.replace(/\\/g, '/')}`);

  const result = pullDevsmindBranch(devmindDir);

  if (!result.found) {
    console.log(
      `\nℹ️  No '${DEVSMIND_BRANCH}' branch found locally or on the remote — nothing to pull yet.\n` +
      `   Run "devsmind push" first to create it.\n`
    );
    return;
  }

  console.log(`\n✅ Synced from ${result.fromRemote ? `${result.remote}/${result.branch}` : result.branch} (${result.commit?.slice(0, 8)}).`);
  console.log(`   Updated: ${result.subdirsSynced.length ? result.subdirsSynced.join(', ') : '(nothing changed)'}`);

  const dbPath = path.join(devmindDir, 'brain.db');
  const db = new DevMindDatabase(dbPath);
  try {
    db.syncFromDisk();
    db.syncToDisk();
    const counts = db.getCounts();
    console.log(`\n🔄 brain.db re-synced.`);
    console.log(`   Nodes       : ${counts.nodes}`);
    console.log(`   Connections : ${counts.connections}`);
    console.log(`   History     : ${counts.history}`);
    console.log(`   Vectors     : ${counts.vectors}`);
    console.log(`   Workflows   : ${counts.workflows}\n`);
  } finally {
    db.close();
  }
}
