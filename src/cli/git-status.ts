import { resolveDevmindDir } from '../utils/config';
import { gitStatusDevsmindBranch, SubdirStatus } from '../utils/devsmind-branch';

/**
 * `devsmind git-status` — how much of this brain has not reached the shared `devsmind` branch yet.
 *
 * Exists because 4.4.0 stopped tracking `graph/`/`history/`/`vectors/`/`workflows/` on the
 * developer's own branch, which is what keeps thousands of brain files out of ordinary pull
 * requests. The side effect is that plain `git status` no longer says anything about the brain at
 * all, so "do I have anything worth syncing?" had no answer short of running a full sync and
 * watching what it did. This answers it in a few seconds, changing nothing.
 *
 * Read-only: it flushes `brain.db` to disk (otherwise it would be reporting the PREVIOUS sync's
 * files as though they were current) and fetches the branch, but never commits, merges or pushes.
 */
export async function handleGitStatus(opts: { path?: string }): Promise<void> {
  const devmindDir = resolveDevmindDir(opts.path);
  if (!devmindDir) {
    console.error(
      `❌ No .devmind directory found.\n` +
      `   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.`
    );
    process.exit(1);
  }

  console.log(`\n🔍 DevsMind — brain vs the shared "devsmind" branch`);
  console.log(`   Brain : ${devmindDir.replace(/\\/g, '/')}`);

  // Deliberately does NOT flush brain.db to disk first, though the JSON files it counts are that
  // database's projection and could in principle be one edit stale.
  //
  // The flush is by far the most expensive thing a sync does — a minute or more on a large brain,
  // against a couple of seconds for the counting itself — and paying it here inverts the point of
  // the command, which exists to be cheap enough to run before deciding whether to sync at all.
  // It would also make a command named "status" write thousands of files, which is its own
  // surprise. Normal operation already keeps these directories current: `edit_node`,
  // `commit_changes` and the embedding writes each call writeGraphToDisk/writeVectorsToDisk as
  // they go. The full flush exists for the abnormal case (a JSON tree deleted or corrupted out
  // from under the DB), which is `devsmind sync`'s job, not this one — and `git-sync` runs it
  // before pushing regardless, so nothing can actually be shared unflushed.
  const status = gitStatusDevsmindBranch(devmindDir);

  if (status.offline) {
    console.log(`   ⚠️  Could not reach "${status.remote}" — comparing against the last fetched copy, which may be behind.`);
  }

  if (!status.branchExists) {
    console.log(`\n📭 The "${status.branch}" branch doesn't exist yet — nothing has been shared.`);
    console.log(`   Everything below would be part of the first sync:\n`);
    printTable(status.perSubdir);
    console.log(`\n   ${status.totalFiles} file(s) — ask your agent to sync to create the branch.\n`);
    return;
  }

  if (status.totalFiles === 0) {
    console.log(`\n✅ Up to date — this brain matches the "${status.branch}" branch. Nothing to sync.\n`);
    return;
  }

  console.log(`\n📦 Not yet on the "${status.branch}" branch:\n`);
  printTable(status.perSubdir);
  console.log(`\n   ${status.totalFiles} file(s) — ask your agent to sync to share them.\n`);
}

function printTable(rows: SubdirStatus[]): void {
  for (const row of rows) {
    const total = row.modified + row.added + row.deleted;
    if (total === 0) continue;
    const parts: string[] = [];
    if (row.modified) parts.push(`${row.modified} modified`);
    if (row.added) parts.push(`${row.added} new`);
    if (row.deleted) parts.push(`${row.deleted} deleted`);
    console.log(`     ${(row.sub + '/').padEnd(12)} ${parts.join(',  ')}`);
  }
}
