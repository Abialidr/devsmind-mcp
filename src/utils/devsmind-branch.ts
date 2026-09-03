import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * `devsmind push` / `devsmind pull` — moves the churny, multi-hundred-file part of a brain
 * (`graph/`, `history/`, `vectors/`, `workflows/`) onto its own `devsmind` branch, decoupled
 * from whatever code branch you're actually working on. `config.json` deliberately stays on
 * the code branch (see CHANGELOG 4.3.0) — it's what lets a fresh clone recognize "this repo
 * has a brain" before anyone has pulled the `devsmind` branch at all.
 *
 * Implemented via a throwaway `git worktree`, never a checkout of the caller's actual branch:
 * the working tree, HEAD, and index the user is looking at are never touched. A stash-based
 * "stash → checkout → pop → checkout back" approach was considered and rejected — it mutates
 * the user's real working directory mid-flight, and any interruption (crash, conflict on pop)
 * leaves the repo straddling two branches with a stash floating around. A worktree can't do
 * that: it's a separate directory, cleaned up in a `finally`, and the real branch never moves.
 */

export const DEVSMIND_BRANCH = 'devsmind';

/** The subset of a brain that lives on the `devsmind` branch — the actual source of PR/commit
 *  noise. `config.json` (and LOCAL-only `.env`/`brain.db`/`local/`/scratchpads) are deliberately
 *  excluded; see the module doc above. */
export const DEVSMIND_BRANCH_SUBDIRS = ['graph', 'history', 'vectors', 'workflows'] as const;

export interface PushResult {
  /** false only when there was literally nothing to commit (working tree already matched). */
  committed: boolean;
  pushed: boolean;
  remote: string | null;
  branch: string;
  commit: string | null;
  filesChanged: number;
  repoRoot: string;
}

export interface PullResult {
  /** false when the `devsmind` branch doesn't exist yet, locally or on the remote. */
  found: boolean;
  fromRemote: boolean;
  remote: string | null;
  branch: string;
  commit: string | null;
  /** Subdirs actually copied down (present on the branch, or removed locally because they're
   *  no longer on it). Not a content diff — just what this pull touched on disk. */
  subdirsSynced: string[];
  repoRoot: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Hard ceiling on any single git call. Push/fetch are the only ones that touch the network,
 *  but every call gets this — a stuck call is a stuck call regardless of which one it is, and
 *  this exists as the last-resort net under the two prompt-suppression measures below, not as
 *  the primary defense against a slow network. */
const GIT_TIMEOUT_MS = 60_000;

/** Runs `git <args>` via argv (never a shell string) — the commit message and paths passed
 *  through this module can be arbitrary text, so nothing here may go through `execSync`'s
 *  shell interpolation. Never throws; callers check `.ok`.
 *
 *  Three measures against `git push`/`fetch` hanging forever waiting on a credential or
 *  host-key prompt nothing can answer — the exact failure a `devsmind push` run inside an
 *  IDE-embedded terminal (no real TTY for a GUI credential prompt to attach to) hit in
 *  practice, silently, with no error and no way out short of killing the process:
 *  `GIT_TERMINAL_PROMPT=0` is git's own documented switch to fail fast instead of prompting;
 *  `stdio: ['ignore', ...]` detaches stdin so there is no path to read a response from even if
 *  something ignored that env var; and `timeout` is the backstop for a stall that isn't a
 *  prompt at all (a dead network) but still isn't self-resolving. */
function git(cwd: string, args: string[]): GitResult {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.error) {
    // spawnSync sets this on a timeout kill (or the git binary not being found) rather than a
    // normal non-zero exit — surfaced through the same shape everything else here already checks.
    const timedOut = (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || res.signal === 'SIGTERM';
    return {
      ok: false,
      stdout: (res.stdout || '').toString().trim(),
      stderr: timedOut
        ? `git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s — likely waiting on a credential prompt with nothing to answer it. Configure a credential helper (git config credential.helper) or an SSH key with no passphrase prompt, then retry.`
        : res.error.message,
    };
  }
  return { ok: res.status === 0, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

function gitOrThrow(cwd: string, args: string[], errPrefix: string): string {
  const res = git(cwd, args);
  if (!res.ok) throw new Error(`${errPrefix}: ${res.stderr || res.stdout || `git ${args.join(' ')} failed`}`);
  return res.stdout;
}

function findRepoRoot(devmindDir: string): string {
  const res = git(devmindDir, ['rev-parse', '--show-toplevel']);
  if (!res.ok) {
    throw new Error(
      `"${devmindDir}" is not inside a git repository — devsmind push/pull needs one (this is separate from ` +
      `whichever repos the brain tracks). Run "git init" there first.`
    );
  }
  return path.resolve(res.stdout);
}

/** `origin` if present, else whatever single remote exists, else none. */
function detectRemote(repoRoot: string): string | null {
  const res = git(repoRoot, ['remote']);
  if (!res.ok || !res.stdout) return null;
  const remotes = res.stdout.split('\n').map(l => l.trim()).filter(Boolean);
  if (remotes.includes('origin')) return 'origin';
  return remotes[0] ?? null;
}

function branchExistsLocally(repoRoot: string): boolean {
  return git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${DEVSMIND_BRANCH}`]).ok;
}

function branchExistsOnRemote(repoRoot: string, remote: string | null): boolean {
  if (!remote) return false;
  return git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${DEVSMIND_BRANCH}`]).ok;
}

function uniqueWorktreeDir(): string {
  return path.join(os.tmpdir(), `devsmind-branch-${crypto.randomUUID()}`);
}

/** Always run from a `finally` — best-effort on every step so a failed push/pull never leaves
 *  a dangling worktree registration behind. */
function removeWorktree(repoRoot: string, worktreeDir: string): void {
  git(repoRoot, ['worktree', 'remove', worktreeDir, '--force']);
  try {
    if (fs.existsSync(worktreeDir)) fs.rmSync(worktreeDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
  git(repoRoot, ['worktree', 'prune']);
}

/** Sets up `worktreeDir` checked out to the `devsmind` branch, creating it if it exists
 *  nowhere yet — as an ORPHAN (no source code in its tree at all, just `.devsmind/`), not a
 *  divergent copy of whatever code branch happened to be checked out when it was first made. */
function setUpPushWorktree(repoRoot: string, worktreeDir: string, remote: string | null): void {
  if (branchExistsLocally(repoRoot)) {
    gitOrThrow(repoRoot, ['worktree', 'add', worktreeDir, DEVSMIND_BRANCH], 'devsmind push: could not check out the devsmind branch');
    return;
  }
  if (branchExistsOnRemote(repoRoot, remote)) {
    gitOrThrow(
      repoRoot,
      ['worktree', 'add', '-b', DEVSMIND_BRANCH, worktreeDir, `${remote}/${DEVSMIND_BRANCH}`],
      'devsmind push: could not track the remote devsmind branch'
    );
    return;
  }

  const head = git(repoRoot, ['rev-parse', 'HEAD']);
  if (!head.ok) throw new Error('devsmind push: this repository has no commits yet — make at least one commit first.');
  gitOrThrow(repoRoot, ['worktree', 'add', '--detach', worktreeDir, head.stdout], 'devsmind push: could not create a scratch worktree');
  gitOrThrow(worktreeDir, ['checkout', '--orphan', DEVSMIND_BRANCH], 'devsmind push: could not create the devsmind branch');
  // --orphan populates the working tree from the detached HEAD it branched off; clear it so
  // the new branch starts holding nothing but the .devsmind/ subset we're about to write in.
  const hasFiles = fs.readdirSync(worktreeDir).some(f => f !== '.git');
  if (hasFiles) gitOrThrow(worktreeDir, ['rm', '-rf', '--quiet', '.'], 'devsmind push: could not clear the new branch tree');
}

function replaceDir(source: string, target: string): boolean {
  const sourceExists = fs.existsSync(source);
  const targetExisted = fs.existsSync(target);
  if (!sourceExists && !targetExisted) return false;
  if (targetExisted) fs.rmSync(target, { recursive: true, force: true });
  if (sourceExists) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
  return true;
}

/**
 * Commits the current `graph/history/vectors/workflows` state onto the `devsmind` branch and
 * pushes it, without touching the caller's actual checked-out branch. A no-op (returns
 * `committed:false`) when nothing under those subdirs has changed since the last push.
 */
export function pushDevsmindBranch(devmindDir: string, message: string): PushResult {
  if (!message || !message.trim()) throw new Error('devsmind push: a commit message is required.');

  const repoRoot = findRepoRoot(devmindDir);
  const remote = detectRemote(repoRoot);
  // Best-effort: so a brand-new local devsmind branch doesn't fork from work a teammate
  // already pushed. Silently skipped if offline or the branch doesn't exist remotely yet.
  if (remote) git(repoRoot, ['fetch', remote, DEVSMIND_BRANCH]);

  const worktreeDir = uniqueWorktreeDir();
  try {
    setUpPushWorktree(repoRoot, worktreeDir, remote);

    for (const sub of DEVSMIND_BRANCH_SUBDIRS) {
      replaceDir(path.join(devmindDir, sub), path.join(worktreeDir, '.devsmind', sub));
    }

    gitOrThrow(worktreeDir, ['add', '-A', '.devsmind'], 'devsmind push: staging failed');
    const status = git(worktreeDir, ['status', '--porcelain', '--', '.devsmind']);
    const filesChanged = status.stdout ? status.stdout.split('\n').filter(Boolean).length : 0;

    let committed = false;
    if (filesChanged > 0) {
      gitOrThrow(worktreeDir, ['commit', '-m', message], 'devsmind push: commit failed');
      committed = true;
    }
    const commit = gitOrThrow(worktreeDir, ['rev-parse', 'HEAD'], 'devsmind push: could not read the commit hash');

    // Even with nothing new THIS run, the branch may already be ahead of the remote — e.g. an
    // earlier run committed successfully but its push failed (network blip). Don't silently
    // strand that commit: push whenever local and remote disagree, not only on a fresh commit.
    if (!committed && remote) {
      const remoteHead = git(worktreeDir, ['rev-parse', `${remote}/${DEVSMIND_BRANCH}`]);
      if (remoteHead.ok && remoteHead.stdout === commit) {
        return { committed: false, pushed: false, remote, branch: DEVSMIND_BRANCH, commit, filesChanged: 0, repoRoot };
      }
    } else if (!committed && !remote) {
      return { committed: false, pushed: false, remote, branch: DEVSMIND_BRANCH, commit, filesChanged: 0, repoRoot };
    }

    let pushed = false;
    if (remote) {
      const res = git(worktreeDir, ['push', '-u', remote, DEVSMIND_BRANCH]);
      if (!res.ok) {
        throw new Error(
          `${committed ? `Committed locally on ${DEVSMIND_BRANCH} (${commit.slice(0, 8)}), but push` : 'Push'} to ${remote}/${DEVSMIND_BRANCH} failed: ` +
          `${res.stderr || res.stdout}. Someone else may have pushed since you last pulled — run "devsmind pull" and try again.`
        );
      }
      pushed = true;
    }

    return { committed, pushed, remote, branch: DEVSMIND_BRANCH, commit, filesChanged, repoRoot };
  } finally {
    removeWorktree(repoRoot, worktreeDir);
  }
}

/**
 * Copies `graph/history/vectors/workflows` down from the `devsmind` branch (remote-tracking
 * ref preferred when a remote exists) into the real `.devsmind/` on disk, replacing each
 * subdir wholesale so deletions/renames on the branch propagate too. Does NOT run
 * `devsmind sync` itself — callers own that, since only they know whether a DB connection is
 * already open (the MCP server) or needs to be (the CLI).
 */
export function pullDevsmindBranch(devmindDir: string): PullResult {
  const repoRoot = findRepoRoot(devmindDir);
  const remote = detectRemote(repoRoot);
  if (remote) git(repoRoot, ['fetch', remote, DEVSMIND_BRANCH]); // best-effort, offline-safe

  const fromRemote = branchExistsOnRemote(repoRoot, remote);
  const fromLocal = branchExistsLocally(repoRoot);
  if (!fromRemote && !fromLocal) {
    return { found: false, fromRemote: false, remote, branch: DEVSMIND_BRANCH, commit: null, subdirsSynced: [], repoRoot };
  }

  const worktreeDir = uniqueWorktreeDir();
  try {
    const checkoutRef = fromRemote && remote ? `${remote}/${DEVSMIND_BRANCH}` : DEVSMIND_BRANCH;
    gitOrThrow(repoRoot, ['worktree', 'add', '--detach', worktreeDir, checkoutRef], 'devsmind pull: could not read the devsmind branch');

    const subdirsSynced: string[] = [];
    for (const sub of DEVSMIND_BRANCH_SUBDIRS) {
      const changed = replaceDir(path.join(worktreeDir, '.devsmind', sub), path.join(devmindDir, sub));
      if (changed) subdirsSynced.push(sub);
    }

    const commit = gitOrThrow(worktreeDir, ['rev-parse', 'HEAD'], 'devsmind pull: could not read the commit hash');
    return { found: true, fromRemote, remote, branch: DEVSMIND_BRANCH, commit, subdirsSynced, repoRoot };
  } finally {
    removeWorktree(repoRoot, worktreeDir);
  }
}
