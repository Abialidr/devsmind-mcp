import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * One git sync per brain at a time, across every process on this machine.
 *
 * Two agents syncing the same brain at once (two IDE windows, Codex beside Claude Code) would
 * both flush brain.db into the same JSON files, both rewrite the sync index, and both write the
 * merged result back into `.devsmind/` — one sync's files landing in the middle of the other's
 * commit. Git refuses only the second checkout of the same branch, which covered the old
 * worktree flow by accident and covers the in-place flow not at all.
 *
 * The lock is a file created with `wx` (fails if it already exists, atomically, on every
 * platform), holding who took it and when. It lives in `local/`, which is gitignored on every
 * branch — it means nothing to another machine, and teammates elsewhere need no lock: a push
 * that loses the race is rejected and the next sync merges.
 *
 * A sync is never cancelled once it holds the lock. Stopping between commit and push, or halfway
 * through writing files back, would leave the brain half-updated; finishing is the safe end
 * state, success or error. The lock is released in a `finally`, so an error releases it too.
 */

export interface SyncLockHolder {
  pid: number;
  host: string;
  startedAt: string;
  /** The background job holding it, when the holder is an MCP server. */
  jobId?: string;
}

export type SyncLockAttempt =
  | { acquired: true; release: () => void }
  | { acquired: false; holder: SyncLockHolder | null };

/** A lock older than this is treated as abandoned even if its pid looks alive — pids get reused. */
export const SYNC_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export function syncLockPath(devmindDir: string): string {
  return path.join(devmindDir, 'local', 'git-sync.lock');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: existence check only, nothing is sent
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(file: string): SyncLockHolder | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return typeof parsed?.pid === 'number' ? parsed as SyncLockHolder : null;
  } catch {
    return null;
  }
}

/**
 * Abandoned: its process is gone (checkable only on the same host), or it is older than
 * {@link SYNC_LOCK_STALE_MS}. An unreadable lock is abandoned only once it is a few seconds old —
 * a fresh one may simply be mid-write by the process that just created it.
 */
function isAbandoned(file: string, holder: SyncLockHolder | null, now: number): boolean {
  if (!holder) {
    try {
      return now - fs.statSync(file).mtimeMs > 10_000;
    } catch {
      return true; // vanished between our attempt and this check
    }
  }
  const age = now - Date.parse(holder.startedAt);
  if (!Number.isFinite(age) || age > SYNC_LOCK_STALE_MS) return true;
  return holder.host === os.hostname() && !pidAlive(holder.pid);
}

export function acquireSyncLock(devmindDir: string, jobId?: string): SyncLockAttempt {
  const file = syncLockPath(devmindDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine: SyncLockHolder = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), ...(jobId ? { jobId } : {}) };

  // Two attempts: the second only after clearing an abandoned lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(mine));
      } finally {
        fs.closeSync(fd);
      }
      return { acquired: true, release: () => releaseIfMine(file, mine) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readHolder(file);
      if (attempt === 0 && isAbandoned(file, holder, Date.now())) {
        console.error(`[DevsMind git-sync] clearing an abandoned sync lock${holder ? ` (pid ${holder.pid}, started ${holder.startedAt})` : ''}`);
        fs.rmSync(file, { force: true });
        continue;
      }
      return { acquired: false, holder };
    }
  }
  return { acquired: false, holder: readHolder(file) };
}

/** Who holds the lock right now, or null when nobody does (an abandoned lock counts as nobody). */
export function readSyncLock(devmindDir: string): SyncLockHolder | null {
  const file = syncLockPath(devmindDir);
  if (!fs.existsSync(file)) return null;
  const holder = readHolder(file);
  return isAbandoned(file, holder, Date.now()) ? null : holder;
}

/** Removes the lock only if it is still the one we wrote — never one a later sync took over. */
function releaseIfMine(file: string, mine: SyncLockHolder): void {
  const current = readHolder(file);
  if (current && current.pid === mine.pid && current.startedAt === mine.startedAt && current.jobId === mine.jobId) {
    fs.rmSync(file, { force: true });
  }
}

export function describeBusy(holder: SyncLockHolder | null): string {
  if (!holder) return 'devsmind git-sync: another sync of this brain is already running. Wait for it to finish, then sync again.';
  const since = Math.max(0, Math.round((Date.now() - Date.parse(holder.startedAt)) / 1000));
  return `devsmind git-sync: another sync of this brain is already running (pid ${holder.pid} on ${holder.host}, for ${since}s). ` +
    'It cannot be stopped part-way and will finish on its own, success or error. Wait for it, then sync again.';
}
