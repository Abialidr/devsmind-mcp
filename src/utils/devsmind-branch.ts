import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * `devsmind git-sync` — moves the churny, multi-hundred-file part of a brain (`graph/`,
 * `history/`, `vectors/`, `workflows/`) onto its own `devsmind` branch, decoupled from whatever
 * code branch you're actually working on, and keeps it in step with the rest of the team.
 * `config.json` deliberately stays on the code branch (see CHANGELOG 4.3.0) — it's what lets a
 * fresh clone recognize "this repo has a brain" before anyone has pulled the `devsmind` branch.
 *
 * ONE operation, not the old push/pull pair. That pair could not survive the most ordinary team
 * sequence — you pull, you work, a teammate pushes, you push: the push was rejected, and the
 * pull it told you to run then overwrote your unpushed work wholesale, because pull never
 * merged, it only copied the remote tip over your files. `gitSyncDevsmindBranch` commits your
 * side FIRST (so git has a common ancestor), then 3-way merges theirs in, then pushes.
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

/**
 * The brain directory's own folder name, taken from the path the caller actually passed rather
 * than assumed to be `.devsmind`.
 *
 * This matters because a brain created before 4.2.0 is named `.devmind`, and those keep working
 * forever by design (see `BRAIN_DIR_NAMES` in utils/config.ts). Hardcoding `.devsmind` here meant
 * that on a legacy brain the branch legitimately held `.devmind/graph/...` from earlier syncs
 * while this module wrote to and staged `.devsmind/` — a different path entirely. Git then saw
 * every real file as missing and staged it as a DELETION: ~10,000 spurious `D` entries against a
 * brain whose true change count was 51, which on the next push would have wiped the team's whole
 * graph off the branch.
 */
function brainDirName(devmindDir: string): string {
  return path.basename(path.resolve(devmindDir));
}

/** One file git could not merge on its own, handed to the caller (an AI agent) to resolve. */
export interface ConflictedFile {
  /** Path relative to the worktree root, e.g. `.devsmind/graph/app/page.json`. */
  path: string;
  /** The merged-with-markers content git left on disk — what needs resolving. */
  content: string;
  /** Our side (stage 2) and their side (stage 3), so a resolver can see both cleanly rather
   *  than having to parse the marker soup back apart. Null when a stage is genuinely absent
   *  (add/add and delete/modify conflicts don't have all three stages). */
  ours: string | null;
  theirs: string | null;
}

export type GitSyncStatus =
  | 'pushed'
  | 'committed_local_only'
  | 'nothing_to_do'
  | 'conflicted'
  | 'invalid_resolution';

export interface GitSyncResult {
  status: GitSyncStatus;
  remote: string | null;
  branch: string;
  commit: string | null;
  /** How many files this run's own commit changed (0 when nothing local had changed). */
  filesChanged: number;
  repoRoot: string;
  /** Present on `conflicted` — the files needing resolution, and the worktree they live in.
   *  The caller resolves them on disk there, then calls back with `{ worktree, resolved: true }`. */
  conflicts?: ConflictedFile[];
  /** Retained (not cleaned up) while a conflict or an invalid resolution is outstanding. */
  worktree?: string;
  /** Present on `invalid_resolution` — why each rejected file was rejected. */
  invalid?: { path: string; reason: string }[];
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Hard ceiling on any single git call. Push/fetch are the only ones that touch the network,
 *  but every call gets this — a stuck call is a stuck call regardless of which one it is, and
 *  this exists as the last-resort net under the two prompt-suppression measures below, not as
 *  the primary defense against a slow network. Generous enough that honest local work on a large
 *  repo (a checkout, a big `add`) finishes well inside it. */
const GIT_TIMEOUT_MS = 120_000;

/** The only subcommands that can reach the network, and therefore the only ones whose timeout
 *  could plausibly be a credential/host-key prompt. Everything else (`worktree`, `checkout`,
 *  `add`, `commit`, `merge`, `rm`, `status`, `rev-parse`, `show`, `diff`, `ls-files`) is purely
 *  local, so blaming credentials there sends the reader hunting in entirely the wrong place —
 *  which is exactly what happened when a `worktree add` on a multi-thousand-file repo timed out
 *  and reported a credential problem it could not possibly have had. */
const NETWORK_GIT_SUBCOMMANDS = new Set(['push', 'fetch', 'pull', 'clone', 'ls-remote']);

/**
 * Ceiling on a single git call's captured stdout. Node's default is 1 MB, which a brain of any
 * real size blows straight through: `ls-tree -r` over 16,000 history files is ~1.8 MB of output.
 *
 * The failure mode is what makes this worth naming. Exceeding `maxBuffer` does not throw or print
 * anything — spawnSync just truncates and reports failure, so the listing came back "empty", every
 * file already on the branch looked absent from it, and a status count reported 16,234 brand-new
 * files for a brain whose real figure was a few dozen. The same silent truncation would make the
 * sync's own deletion-safety check see an empty branch and conclude nothing was there to protect.
 */
const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * Every commit this module makes, with the two flags that keep it from being hijacked by the
 * host repository's own tooling.
 *
 * `--no-verify` is the important one. These are internal bookkeeping commits on an orphan branch
 * that contains nothing but `.devsmind/` — they are not the developer's code commits, and running
 * the repo's `pre-commit`/`commit-msg` hooks against them is wrong on every axis: a linter or
 * formatter has nothing meaningful to say about DevsMind's own generated JSON, a hook that
 * expects a conventional-commit message will reject a message it was never meant to police, and
 * a hook that shells out to a test suite or waits on input turns a routine sync into a hang. That
 * last one was observed in practice — `git commit` blowing through the 120s ceiling on a real
 * repo, with the failure surfacing as a bare timeout that said nothing about hooks.
 *
 * `--quiet` suppresses the per-file summary git prints after a commit, which on a brain holding
 * thousands of graph/history files is a large amount of output produced for nobody to read.
 */
const COMMIT_ARGS = (rest: string[]): string[] => ['commit', '--no-verify', '--quiet', ...rest];

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
 *  prompt at all (a dead network) but still isn't self-resolving. A timeout's message is chosen
 *  by whether the subcommand can reach the network at all — see NETWORK_GIT_SUBCOMMANDS. */
function git(cwd: string, args: string[]): GitResult {
  const startedAt = Date.now();
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  // Anything this slow is worth naming while it is happening rather than only in a post-mortem:
  // on a large repo a single `add`/`commit`/`merge` can run for a long time, and silence for
  // minutes is indistinguishable from a hang. Stderr is safe here even in stdio mode.
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > 5_000) {
    console.error(`[DevsMind git-sync] git ${args[0]} took ${Math.round(elapsedMs / 1000)}s`);
  }
  if (res.error) {
    // spawnSync sets this on a timeout kill (or the git binary not being found) rather than a
    // normal non-zero exit — surfaced through the same shape everything else here already checks.
    const timedOut = (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || res.signal === 'SIGTERM';
    const seconds = GIT_TIMEOUT_MS / 1000;
    return {
      ok: false,
      stdout: (res.stdout || '').toString().trim(),
      stderr: timedOut
        ? (NETWORK_GIT_SUBCOMMANDS.has(args[0])
            ? `git ${args[0]} timed out after ${seconds}s — it reaches the network, so this is most likely a credential or host-key prompt with nothing to answer it. Configure a credential helper (git config credential.helper) or an SSH key with no passphrase prompt, then retry.`
            : `git ${args[0]} timed out after ${seconds}s. This command is purely local — it never contacts a remote — so this is not a credentials problem. On a very large repository it may simply need longer, or another git process may be holding the repository's index lock.`)
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
  // The two "branch already exists" paths MUST do a real checkout. The devsmind branch's own
  // content has to be present on disk, because the next steps diff against it and then merge —
  // and `git add -A` on a working tree that git believes should hold files it cannot find stages
  // every one of them as a DELETION. That was observed as ~10,000 spurious `D` entries against a
  // brain whose real change count was 51. `--no-checkout` belongs ONLY on the orphan path below,
  // where the tree is discarded immediately anyway.
  if (branchExistsLocally(repoRoot)) {
    gitOrThrow(repoRoot, ['worktree', 'add', worktreeDir, DEVSMIND_BRANCH], 'devsmind git-sync: could not check out the devsmind branch');
    return;
  }
  if (branchExistsOnRemote(repoRoot, remote)) {
    gitOrThrow(
      repoRoot,
      ['worktree', 'add', '-b', DEVSMIND_BRANCH, worktreeDir, `${remote}/${DEVSMIND_BRANCH}`],
      'devsmind git-sync: could not track the remote devsmind branch'
    );
    return;
  }

  const head = git(repoRoot, ['rev-parse', 'HEAD']);
  if (!head.ok) throw new Error('devsmind git-sync: this repository has no commits yet — make at least one commit first.');

  // `--no-checkout` is load-bearing here, not an optimization detail, and it is safe here for the
  // reason it is unsafe above: this branch does not exist yet, so there is no content to preserve.
  // Without the flag, `worktree add` materializes the ENTIRE repository tree at HEAD into the temp
  // dir — every source file — only for the index to be cleared immediately after, since the
  // devsmind branch is an orphan holding nothing but `.devsmind/`. On a large repo that copy is
  // minutes of pure wasted I/O, and it was observed timing out the per-call ceiling on a real
  // multi-thousand-file repo.
  gitOrThrow(repoRoot, ['worktree', 'add', '--no-checkout', '--detach', worktreeDir, head.stdout], 'devsmind git-sync: could not create a scratch worktree');
  gitOrThrow(worktreeDir, ['checkout', '--orphan', DEVSMIND_BRANCH], 'devsmind git-sync: could not create the devsmind branch');
  // The orphan branch starts with HEAD's tree staged in the index (even with --no-checkout, the
  // index is populated), so clear it — the branch must hold nothing but the `.devsmind/` subset
  // written in next. `git rm -rf --cached` unstages without touching the working tree, which
  // --no-checkout left empty anyway.
  const staged = git(worktreeDir, ['ls-files']);
  if (staged.stdout) gitOrThrow(worktreeDir, ['rm', '-rf', '--quiet', '--cached', '.'], 'devsmind git-sync: could not clear the new branch tree');
}

/** Every file under `dir`, as paths relative to it. `[]` for a directory that isn't there. */
function listFilesRelative(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else out.push(childRel);
    }
  };
  walk(dir, '');
  return out;
}

/** True when both paths hold byte-identical content. Size is checked first because it settles
 *  the overwhelming majority of differing files without reading either one. */
function sameFileContent(a: string, b: string): boolean {
  let statA: fs.Stats, statB: fs.Stats;
  try {
    statA = fs.statSync(a);
    statB = fs.statSync(b);
  } catch {
    return false;
  }
  if (statA.size !== statB.size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/**
 * Makes `target` hold exactly what `source` holds, touching ONLY the files that actually differ.
 * Returns whether anything changed at all.
 *
 * This replaced a straight "delete the target, copy the whole source back" mirror. That was
 * correct but paid for a full 10,000-file delete-and-rewrite on every single sync, including the
 * ordinary case of twenty edited files — and it ran twice per sync (brain → worktree, then merged
 * worktree → brain). Content comparison brings that down to the handful of files that moved.
 *
 * Three properties the old mirror got for free, which anything replacing it must preserve:
 *
 * - **Deletions propagate.** Wiping the target made a locally-deleted file vanish from the branch
 *   with no special handling. Here that is explicit (the second loop); without it a deleted node
 *   would linger in the shared brain forever, which is silent data resurrection rather than a
 *   visible failure. `deletable` bounds which files that loop may remove — see below.
 * - **Comparison is by CONTENT, never mtime.** `syncToDisk` rewrites files unconditionally, so
 *   every mtime is fresh on every run and would mark all 10,000 as changed — the exact cost this
 *   is here to avoid. Bytes are the only signal that reflects a real edit.
 * - **An absent source means "nothing to contribute", not "delete everything".** Callers skip
 *   absent subdirs before calling; the early return keeps that safe if one ever doesn't.
 *
 * `deletable`, when given, is the ONLY set of paths the removal loop may delete; anything else the
 * target holds is left alone. This is what stops a teammate from silently wiping work they have
 * never seen. Pushing commits "my brain is the whole truth" BEFORE merging, so with an unbounded
 * removal loop a developer whose brain lacks a file another developer added would commit that file
 * as deleted — and the merge cannot rescue it, since git reads a deliberate delete on one side
 * against no change on the other as an unambiguous delete. Caller passes the branch's own file
 * list from before this brain contributed anything, so a delete only lands for a file this sync
 * genuinely knows to be gone rather than one it simply never had.
 *
 * Note both call sites copy the four SUBDIRECTORIES (`graph/`, `history/`, …) rather than the
 * brain folder itself, which is what keeps `.devmind/.gitignore` out of the worktree. That matters
 * more than it looks: that file now lists those same four directories so the developer's working
 * branch stops tracking brain data, and carrying it onto the `devsmind` branch would apply those
 * rules there too — making `git add -A` skip the very files the branch exists to hold, and push an
 * empty commit while reporting success. Copy the brain folder wholesale here and that returns.
 */
function syncDir(source: string, target: string, deletable?: ReadonlySet<string>): boolean {
  const sourceExists = fs.existsSync(source);
  const targetExists = fs.existsSync(target);
  if (!sourceExists && !targetExists) return false;

  const sourceFiles = listFilesRelative(source);
  const targetFiles = listFilesRelative(target);
  let changed = false;

  for (const rel of sourceFiles) {
    const from = path.join(source, rel);
    const to = path.join(target, rel);
    if (fs.existsSync(to) && sameFileContent(from, to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    changed = true;
  }

  const wanted = new Set(sourceFiles);
  for (const rel of targetFiles) {
    if (wanted.has(rel)) continue;
    if (deletable && !deletable.has(rel)) continue;
    fs.rmSync(path.join(target, rel), { force: true });
    changed = true;
  }

  // Directories emptied by those removals would otherwise accumulate in the worktree and in the
  // brain folder — harmless to git, which tracks no empty directories, but they make a `graph/`
  // full of hollow paths that reads as data still being there.
  pruneEmptyDirs(target);
  return changed;
}

/** Where the last-received manifest lives. Under `local/`, which is already gitignored on every
 *  branch — this is per-machine bookkeeping, meaningless to anyone else and never shared. */
function syncedManifestPath(devmindDir: string): string {
  return path.join(devmindDir, 'local', 'last-synced-files.json');
}

/**
 * The files under `<brainDir>/<sub>` this sync may DELETE from the devsmind branch: the ones this
 * brain actually RECEIVED on its last sync, relative to that subdirectory. Everything else the
 * branch holds is left untouched.
 *
 * Deletion is the one operation local state cannot justify on its own. A file the branch has and
 * `.devmind/graph/` does not means either "I deleted this node" or "a teammate added this node and
 * my brain has never seen it" — identical on disk, opposite in meaning, and getting it wrong is
 * unrecoverable. Our side is committed BEFORE the merge runs, so git reads a deliberate delete on
 * one side against no change on the other as an unambiguous delete: a teammate's work erased from
 * the shared brain by someone who never opened it, no conflict raised, nothing to review.
 *
 * Nothing in git answers this. The branch tip cannot — a fresh clone's worktree checkout holds
 * every teammate's file while its brain holds none of them, which is precisely the case that
 * erased another developer's graph. Nor can the merge-base: for a brain that has never synced it
 * IS the remote tip, so it says "you had everything" about a brain that had nothing. The question
 * is about this brain's own history, so only this brain can record the answer — written after each
 * successful sync by {@link recordSyncedManifest}.
 *
 * No manifest means no sync has completed here yet, so nothing is deletable: a brain that has
 * never received a file cannot have deleted one. A genuine local deletion then propagates from the
 * NEXT sync onward, once there is a recorded state to have deleted it from.
 */
function deletableOnBranch(devmindDir: string, sub: string): ReadonlySet<string> {
  try {
    const raw = fs.readFileSync(syncedManifestPath(devmindDir), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    const files = parsed[sub];
    return Array.isArray(files) ? new Set(files) : new Set();
  } catch {
    return new Set();
  }
}

/** Records what the brain holds after a sync, so the NEXT one can tell a real local deletion from
 *  a teammate's file this brain has simply never seen. Best-effort: failing to write it costs a
 *  deletion propagating a sync later, never data. */
function recordSyncedManifest(devmindDir: string): void {
  try {
    const manifest: Record<string, string[]> = {};
    for (const sub of DEVSMIND_BRANCH_SUBDIRS) {
      manifest[sub] = listFilesRelative(path.join(devmindDir, sub));
    }
    const target = syncedManifestPath(devmindDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2));
  } catch {
    // best-effort only
  }
}

/** Removes directories left empty under `dir` (depth-first), but never `dir` itself. */
function pruneEmptyDirs(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    pruneEmptyDirs(child);
    try {
      if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
    } catch {
      // best-effort only — a directory we cannot remove is cosmetic, not a sync failure
    }
  }
}

// ─── Resolution validation ───────────────────────────────────────────────────

/** Collects every identifier a `.devsmind` JSON file is responsible for — node ids for a
 *  graph/vectors file, step ids for a workflow. Used to prove a merge resolution didn't quietly
 *  drop one. Unparseable input yields null, which callers treat as "cannot verify, reject". */
function idsInDevsmindJson(content: string): Set<string> | null {
  let data: any;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  const ids = new Set<string>();
  if (Array.isArray(data?.nodes)) for (const n of data.nodes) if (n?.id) ids.add(String(n.id));
  if (data?.vectors && typeof data.vectors === 'object') for (const k of Object.keys(data.vectors)) ids.add(k);
  if (Array.isArray(data?.steps)) for (const s of data.steps) if (s?.id) ids.add(String(s.id));
  return ids;
}

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})/m;

/**
 * Gate on everything an AI resolver hands back, because a wrong resolution here is invisible:
 * `syncFromDisk` deletes every DB node for a graph file and reinserts from the JSON, so a
 * dropped node is a silently deleted node in the team's shared brain, and a file that no longer
 * parses means the delete lands with no reinsert at all. Three checks, in increasing cost:
 * no leftover markers, still valid JSON of the right shape, and — the one that matters —
 * no id present on either side of the conflict has gone missing from the result.
 */
function validateResolution(
  worktreeDir: string,
  relPath: string,
  ours: string | null,
  theirs: string | null
): string | null {
  const abs = path.join(worktreeDir, relPath);
  if (!fs.existsSync(abs)) return 'file is missing from the worktree — a merge resolution must leave the file in place';

  const content = fs.readFileSync(abs, 'utf-8');
  if (CONFLICT_MARKER.test(content)) return 'still contains conflict markers (<<<<<<< / ======= / >>>>>>>)';

  let data: any;
  try {
    data = JSON.parse(content);
  } catch (err) {
    return `is not valid JSON after resolution: ${(err as Error).message}`;
  }

  // Shape, per tree — matches exactly what writeGraphToDisk/writeVectorsToDisk/writeWorkflowToDisk
  // emit and what syncFromDisk reads back, so a structurally wrong file is caught here rather
  // than silently importing as an empty file list.
  const norm = relPath.replace(/\\/g, '/');
  if (norm.includes('/graph/')) {
    if (typeof data.file_path !== 'string') return 'graph JSON is missing its "file_path" string';
    if (!Array.isArray(data.nodes)) return 'graph JSON is missing its "nodes" array';
    if (!Array.isArray(data.connections)) return 'graph JSON is missing its "connections" array';
  } else if (norm.includes('/vectors/')) {
    if (typeof data.file_path !== 'string') return 'vectors JSON is missing its "file_path" string';
    if (!data.vectors || typeof data.vectors !== 'object') return 'vectors JSON is missing its "vectors" object';
  } else if (norm.includes('/workflows/')) {
    if (!data.id) return 'workflow JSON is missing its "id"';
  }

  // The real safety net: a merge may add, and may change, but must never lose. Any id either
  // side brought to the table has to survive into the result.
  const resolvedIds = idsInDevsmindJson(content);
  if (!resolvedIds) return 'could not be parsed for id verification';
  const expected = new Set<string>();
  for (const side of [ours, theirs]) {
    if (!side) continue;
    const sideIds = idsInDevsmindJson(side);
    if (sideIds) for (const id of sideIds) expected.add(id);
  }
  const missing = [...expected].filter(id => !resolvedIds.has(id));
  if (missing.length) {
    return `dropped ${missing.length} id(s) that existed on one side of the merge: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}. A merge must never delete an entry — keep every id from both sides.`;
  }
  return null;
}

/** Reads one stage of a conflicted path (2 = ours, 3 = theirs) — absent for add/add and
 *  delete/modify conflicts, where that stage genuinely doesn't exist. */
function conflictStage(worktreeDir: string, relPath: string, stage: 2 | 3): string | null {
  const res = git(worktreeDir, ['show', `:${stage}:${relPath}`]);
  return res.ok ? res.stdout : null;
}

function collectConflicts(worktreeDir: string): ConflictedFile[] {
  const res = git(worktreeDir, ['diff', '--name-only', '--diff-filter=U']);
  const paths = res.stdout ? res.stdout.split('\n').map(l => l.trim()).filter(Boolean) : [];
  return paths.map(relPath => {
    const abs = path.join(worktreeDir, relPath);
    let content = '';
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      // A delete/modify conflict leaves nothing on disk; the stages below still describe it.
    }
    return {
      path: relPath,
      content,
      ours: conflictStage(worktreeDir, relPath, 2),
      theirs: conflictStage(worktreeDir, relPath, 3),
    };
  });
}

// ─── The one sync operation ──────────────────────────────────────────────────

/** True when the worktree is sitting in the middle of a merge (MERGE_HEAD present). */
function isMidMerge(worktreeDir: string): boolean {
  return git(worktreeDir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).ok;
}

function finishAndPush(
  worktreeDir: string,
  repoRoot: string,
  remote: string | null,
  message: string,
  filesChanged: number
): GitSyncResult {
  const commit = gitOrThrow(worktreeDir, ['rev-parse', 'HEAD'], 'devsmind git-sync: could not read the commit hash');

  // Nothing new locally AND already level with the remote is the only true no-op. Anything else
  // still pushes — an earlier run may have committed successfully but failed to push (a network
  // blip), and that commit must not be silently stranded.
  if (filesChanged === 0) {
    if (!remote) {
      return { status: 'nothing_to_do', remote, branch: DEVSMIND_BRANCH, commit, filesChanged: 0, repoRoot };
    }
    const remoteHead = git(worktreeDir, ['rev-parse', `${remote}/${DEVSMIND_BRANCH}`]);
    if (remoteHead.ok && remoteHead.stdout === commit) {
      return { status: 'nothing_to_do', remote, branch: DEVSMIND_BRANCH, commit, filesChanged: 0, repoRoot };
    }
  }

  if (!remote) {
    return { status: 'committed_local_only', remote, branch: DEVSMIND_BRANCH, commit, filesChanged, repoRoot };
  }

  const res = git(worktreeDir, ['push', '-u', remote, DEVSMIND_BRANCH]);
  if (!res.ok) {
    throw new Error(
      `Committed locally on ${DEVSMIND_BRANCH} (${commit.slice(0, 8)}), but push to ${remote}/${DEVSMIND_BRANCH} failed: ` +
      `${res.stderr || res.stdout}. Run devsmind git-sync again — it will merge whatever landed in the meantime and retry.`
    );
  }
  return { status: 'pushed', remote, branch: DEVSMIND_BRANCH, commit, filesChanged, repoRoot };
}

/**
 * The whole brain-sharing cycle in one operation: commit local `graph/history/vectors/workflows`
 * onto the `devsmind` branch, 3-way merge whatever teammates pushed, and push the result — all
 * inside a throwaway worktree, so the caller's actual checked-out branch never moves.
 *
 * Replaces the old `pushDevsmindBranch`/`pullDevsmindBranch` pair, which could not survive the
 * ordinary case of a teammate pushing between your pull and your push: push was rejected, and
 * the pull it told you to run then OVERWROTE your unpushed work wholesale, because it never
 * merged — it just copied the remote tip over your files. The fix is to make the local state a
 * real commit first, so git has a common ancestor to merge against, and then let git do the
 * 3-way merge it is already good at.
 *
 * Deliberately no timestamp-based "newest wins": `graph/`/`vectors/` JSON carry no timestamps at
 * all (see writeGraphToDisk/writeVectorsToDisk), and file mtime is rewritten by every checkout,
 * so there is nothing to order two teammates' copies by. Ancestor comparison needs no such field
 * and is also simply more correct: a value only one side moved is that side's, whether or not
 * the other side happened to rewrite the file for unrelated reasons.
 *
 * Conflicts that git cannot resolve come back as `status: 'conflicted'` with each file's merged
 * content plus both sides, and the worktree retained. The caller resolves them on disk there and
 * calls again with `{ worktree, resolved: true }`; every resolved file is then validated before
 * anything is committed (see validateResolution).
 */
export function gitSyncDevsmindBranch(
  devmindDir: string,
  message: string,
  opts: { worktree?: string; resolved?: boolean } = {}
): GitSyncResult {
  if (!message || !message.trim()) throw new Error('devsmind git-sync: a commit message is required.');

  const repoRoot = findRepoRoot(devmindDir);
  const remote = detectRemote(repoRoot);

  // ── Resuming after the caller resolved a conflict on disk ──
  if (opts.resolved && opts.worktree) {
    const worktreeDir = opts.worktree;
    if (!fs.existsSync(worktreeDir)) {
      throw new Error(`devsmind git-sync: the worktree "${worktreeDir}" is gone — re-run without "resolved" to start a fresh sync.`);
    }
    if (!isMidMerge(worktreeDir)) {
      throw new Error(`devsmind git-sync: "${worktreeDir}" is not in the middle of a merge — re-run without "resolved" to start a fresh sync.`);
    }

    // A rejected resolution must KEEP the worktree — it is the only place the caller can fix the
    // files, and deleting it would strand them with no way to retry.
    let keepOnResume = false;
    try {
      // Validate BEFORE staging: what the caller wrote is unverified input, and a bad resolution
      // here corrupts the shared brain rather than just this run.
      const stillConflicted = collectConflicts(worktreeDir);
      const invalid: { path: string; reason: string }[] = [];
      for (const c of stillConflicted) {
        const reason = validateResolution(worktreeDir, c.path, c.ours, c.theirs);
        if (reason) invalid.push({ path: c.path, reason });
      }
      if (invalid.length) {
        keepOnResume = true;
        return {
          status: 'invalid_resolution', remote, branch: DEVSMIND_BRANCH, commit: null,
          filesChanged: 0, repoRoot, worktree: worktreeDir, invalid,
          conflicts: stillConflicted.filter(c => invalid.some(i => i.path === c.path)),
        };
      }

      gitOrThrow(worktreeDir, ['add', '-A', brainDirName(devmindDir)], 'devsmind git-sync: staging the resolution failed');
      gitOrThrow(worktreeDir, COMMIT_ARGS(['--no-edit']), 'devsmind git-sync: committing the merge failed');

      const result = finishAndPush(worktreeDir, repoRoot, remote, message, 1);
      copyBranchStateToBrain(worktreeDir, devmindDir);
      return result;
    } finally {
      if (!keepOnResume) removeWorktree(repoRoot, worktreeDir);
    }
  }

  // ── A fresh sync ──
  if (remote) git(repoRoot, ['fetch', remote, DEVSMIND_BRANCH]); // best-effort, offline-safe

  const worktreeDir = uniqueWorktreeDir();
  let keepWorktree = false;
  try {
    setUpPushWorktree(repoRoot, worktreeDir, remote);

    // 1. Our side, as a real commit — without this there is no ancestor for git to merge against,
    //    which is exactly why the old pull could only overwrite.
    //
    //    Only subdirs this brain ACTUALLY HAS are mirrored. A teammate syncing for the first time
    //    has no local `graph/` yet, and mirroring that absence would commit a deletion of
    //    everyone else's graph before the merge ever ran. An absent subdir means "I have nothing
    //    to contribute here", not "remove it".
    //
    //    A real deletion still propagates, but only for files this brain HAD. `deletableOnBranch`
    //    is the intersection of what the branch holds with what this brain last received, so
    //    "I deleted this node" and "I have never seen this node" stop looking identical — they
    //    are indistinguishable from local state alone, and treating the second as the first let
    //    one developer's push wipe a file another had added moments earlier.
    const brainDir = brainDirName(devmindDir);
    for (const sub of DEVSMIND_BRANCH_SUBDIRS) {
      const localSub = path.join(devmindDir, sub);
      if (!fs.existsSync(localSub)) continue;
      syncDir(localSub, path.join(worktreeDir, brainDir, sub), deletableOnBranch(devmindDir, sub));
    }
    gitOrThrow(worktreeDir, ['add', '-A', brainDir], 'devsmind git-sync: staging failed');
    const status = git(worktreeDir, ['status', '--porcelain', '--', brainDir]);
    const filesChanged = status.stdout ? status.stdout.split('\n').filter(Boolean).length : 0;
    if (filesChanged > 0) {
      gitOrThrow(worktreeDir, COMMIT_ARGS(['-m', message]), 'devsmind git-sync: commit failed');
    }

    // 2. Their side, 3-way merged in. Only meaningful once a remote branch actually exists.
    if (remote && branchExistsOnRemote(repoRoot, remote)) {
      // `--no-verify` for the same reason the commits carry it: a clean merge creates a commit,
      // which would otherwise fire the host repo's pre-commit/commit-msg hooks.
      const merge = git(worktreeDir, ['merge', '--no-edit', '--no-verify', `${remote}/${DEVSMIND_BRANCH}`]);
      if (!merge.ok) {
        const conflicts = collectConflicts(worktreeDir);
        if (conflicts.length === 0) {
          // Failed for some reason other than conflicts — don't leave a half-merged worktree.
          gitOrThrow(worktreeDir, ['merge', '--abort'], 'devsmind git-sync: merge failed and could not be aborted');
          throw new Error(`devsmind git-sync: merging ${remote}/${DEVSMIND_BRANCH} failed: ${merge.stderr || merge.stdout}`);
        }
        keepWorktree = true;
        return {
          status: 'conflicted', remote, branch: DEVSMIND_BRANCH, commit: null,
          filesChanged, repoRoot, worktree: worktreeDir, conflicts,
        };
      }
    }

    const result = finishAndPush(worktreeDir, repoRoot, remote, message, filesChanged);
    // 3. Bring whatever the merge pulled in back down into the real brain folder.
    copyBranchStateToBrain(worktreeDir, devmindDir);
    // AFTER the brain reflects the branch: this is the state a future sync compares against to
    // tell a real local deletion from a teammate's file it has simply never seen.
    recordSyncedManifest(devmindDir);
    return result;
  } finally {
    if (!keepWorktree) removeWorktree(repoRoot, worktreeDir);
  }
}

/** Mirrors the branch's `<brain dir>/<subdir>` state back into the real brain directory, so what
 *  the merge brought in from teammates is actually on disk for `syncFromDisk` to import. The
 *  brain dir name comes from the caller's own path — a pre-4.2.0 brain is `.devmind`, not
 *  `.devsmind`, and reading from the wrong one silently syncs nothing back. */
function copyBranchStateToBrain(worktreeDir: string, devmindDir: string): string[] {
  const brainDir = brainDirName(devmindDir);
  const synced: string[] = [];
  for (const sub of DEVSMIND_BRANCH_SUBDIRS) {
    const changed = syncDir(path.join(worktreeDir, brainDir, sub), path.join(devmindDir, sub));
    if (changed) synced.push(sub);
  }
  return synced;
}

// ─── Status ──────────────────────────────────────────────────────────────────

export interface SubdirStatus {
  sub: string;
  modified: number;
  added: number;
  deleted: number;
}

export interface GitStatusResult {
  /** null when this repo has no remote at all — counts are then vs the LOCAL branch only. */
  remote: string | null;
  branch: string;
  /** False when the devsmind branch does not exist anywhere yet: nothing has ever been shared, so
   *  every brain file is new. Callers should say that rather than print a bare count. */
  branchExists: boolean;
  /** True when the remote could not be reached; counts are then against a possibly-stale local
   *  copy of the branch, which is worth saying out loud rather than presenting as current. */
  offline: boolean;
  perSubdir: SubdirStatus[];
  totalFiles: number;
}

/**
 * Counts what this brain holds that the shared `devsmind` branch does not yet — the answer to
 * "how much am I about to push, and is it worth syncing right now".
 *
 * Git does the counting, deliberately. The obvious alternative is to compare against
 * `local/last-synced-files.json`, but that manifest records only FILE NAMES: it can see a file
 * appear or disappear and is blind to a hundred edited in place, which is the common case and the
 * one a status command exists to report. `git diff` compares content, so a modified file counts as
 * modified whether or not anything was created or removed alongside it.
 *
 * Read-only with respect to the branch: it fetches (to compare against what teammates have
 * actually pushed rather than a stale local ref) but never commits, merges, or pushes. The caller
 * is expected to have flushed `brain.db` to disk first — comparing against unflushed files would
 * report the previous sync's state as if it were current.
 */
export function gitStatusDevsmindBranch(
  devmindDir: string,
  onProgress: (message: string) => void = () => {}
): GitStatusResult {
  const repoRoot = findRepoRoot(devmindDir);
  const remote = detectRemote(repoRoot);
  const brainDir = brainDirName(devmindDir);

  let offline = false;
  if (remote) {
    // The one step that leaves the machine, and on a slow link the longest single wait here.
    onProgress(`fetching ${remote}/${DEVSMIND_BRANCH}...`);
    const fetched = git(repoRoot, ['fetch', remote, DEVSMIND_BRANCH]);
    if (!fetched.ok) offline = true;
  }

  // Prefer the remote's view: the question is "what have my teammates NOT got", and the local
  // branch ref can trail behind whatever was last fetched.
  const ref = remote && branchExistsOnRemote(repoRoot, remote)
    ? `${remote}/${DEVSMIND_BRANCH}`
    : branchExistsLocally(repoRoot) ? DEVSMIND_BRANCH : null;

  if (!ref) {
    // Nothing shared yet — every file this brain holds is new.
    const perSubdir = DEVSMIND_BRANCH_SUBDIRS.map(sub => ({
      sub,
      modified: 0,
      added: listFilesRelative(path.join(devmindDir, sub)).length,
      deleted: 0,
    }));
    return {
      remote, branch: DEVSMIND_BRANCH, branchExists: false, offline,
      perSubdir, totalFiles: perSubdir.reduce((n, s) => n + s.added, 0),
    };
  }

  // Whether git converted line endings is decided PER SUBDIRECTORY, from a file in that
  // subdirectory. Deciding it once for the whole brain is wrong and quietly so: these trees are
  // written by different code paths, and a brain was observed with LF graph files beside history
  // files that were not — one sample then applied the wrong rule to thousands of files and
  // reported 14,334 of them as modified when 38 had changed.
  const autocrlf = repoConvertsLineEndings(repoRoot);
  const perSubdir: SubdirStatus[] = [];
  for (const sub of DEVSMIND_BRANCH_SUBDIRS) {
    onProgress(`comparing ${sub}/...`);
    const normalizeCrlf = autocrlf && subdirHasCrlf(path.join(devmindDir, sub));
    perSubdir.push(diffSubdirAgainstBranch(repoRoot, devmindDir, brainDir, sub, ref, normalizeCrlf));
  }
  return {
    remote, branch: DEVSMIND_BRANCH, branchExists: true, offline,
    perSubdir, totalFiles: perSubdir.reduce((n, s) => n + s.modified + s.added + s.deleted, 0),
  };
}

/**
 * A file's git blob id, computed the way git computes it: SHA-1 over `blob <bytelength>\0` followed
 * by the raw contents. Matching git's own algorithm is what lets a local file be compared directly
 * against the id recorded in a tree listing, with no index and no temp files in between.
 *
 * Done in-process rather than by shelling out to `git hash-object`, which is the obvious approach
 * and the wrong one at this scale: it is one process spawn per file, and a brain with 16,000
 * history entries turns a status check into 16,000 spawns — minutes of pure overhead for a command
 * whose entire value is being fast enough to run before deciding whether to sync.
 */
function gitBlobSha(absPath: string, normalizeCrlf: boolean): string | null {
  try {
    const raw = fs.readFileSync(absPath);
    const data = normalizeCrlf ? crlfToLf(raw) : raw;
    return crypto.createHash('sha1')
      .update(`blob ${data.length}\0`)
      .update(data)
      .digest('hex');
  } catch {
    return null;
  }
}

/** CRLF → LF over raw bytes (no string round-trip, which would corrupt anything non-UTF-8). */
function crlfToLf(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue; // drop CR of a CRLF pair
    out[n++] = buf[i];
  }
  return out.subarray(0, n);
}

/** Whether this repo is configured to rewrite line endings at all. Cheap, and false here means no
 *  subdirectory needs sampling. */
function repoConvertsLineEndings(repoRoot: string): boolean {
  const cfg = git(repoRoot, ['config', '--get', 'core.autocrlf']);
  if (!cfg.ok) return false;
  const value = cfg.stdout.trim().toLowerCase();
  return value === 'true' || value === 'input';
}

/**
 * Whether files in this ONE subdirectory actually carry CRLF, sampled from its first file.
 *
 * The config saying git MAY convert is not the same as these files BEING converted, and the
 * difference is expensive: under conversion a byte length can only be compared one-directionally,
 * so every same-size file falls through to a full read and hash. That turned a directory of 1,164
 * small files — 63ms to read and hash outright — into an 11.5-second stage.
 *
 * Sampled per subdirectory rather than per brain because the trees are written by different code
 * paths and do differ: one brain had pure-LF graph files beside history files that were not.
 * Guessing from a single sample across all four reported 14,334 files as modified when 38 were.
 *
 * Unreadable or empty sample means "assume converted", which is merely slower, never wrong.
 */
function subdirHasCrlf(dir: string): boolean {
  const rel = listFilesRelative(dir)[0];
  if (!rel) return false;
  try {
    const buf = fs.readFileSync(path.join(dir, rel));
    for (let i = 1; i < buf.length; i++) {
      if (buf[i] === 0x0a && buf[i - 1] === 0x0d) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * One subdirectory's added/modified/deleted counts against `ref`, by hashing what is on disk and
 * comparing to the tree the branch recorded.
 *
 * Hashing is used rather than `git diff` because the brain files are NOT tracked on the developer's
 * own branch — that is the entire point of the 4.4.0 gitignore change — so there is no index here
 * for `git diff` to read them through.
 */
function diffSubdirAgainstBranch(
  repoRoot: string,
  devmindDir: string,
  brainDir: string,
  sub: string,
  ref: string,
  normalizeCrlf: boolean
): SubdirStatus {
  // `-l` asks for each blob's SIZE alongside its id, which is what makes the comparison below
  // able to rule most files out without reading them. Getting the sizes any other way means a
  // second pass over every object (`cat-file --batch-check`), and that measured SLOWER than simply
  // reading all 19,000 files — 3.2s against 2.2s — so the cheap way has to be the same call.
  const prefix = `${brainDir}/${sub}/`;
  const onBranch = new Map<string, { sha: string; size: number }>();
  const listing = git(repoRoot, ['ls-tree', '-r', '-l', ref, prefix]);
  if (listing.ok && listing.stdout) {
    for (const line of listing.stdout.split('\n')) {
      // `<mode> <type> <sha> <size>\t<path>`
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const [, , sha, size] = line.slice(0, tab).trim().split(/\s+/);
      const filePath = line.slice(tab + 1).trim();
      if (!sha || !filePath.startsWith(prefix)) continue;
      // A submodule entry reports "-" rather than a byte count; treat that as "size unknown"
      // rather than 0, which would wrongly claim every such file differs.
      const parsed = Number(size);
      onBranch.set(filePath.slice(prefix.length), {
        sha,
        size: Number.isFinite(parsed) ? parsed : -1,
      });
    }
  }

  const localDir = path.join(devmindDir, sub);
  const localFiles = listFilesRelative(localDir);
  let modified = 0, added = 0;

  for (const rel of localFiles) {
    const recorded = onBranch.get(rel);
    if (recorded === undefined) { added++; continue; }

    // A byte length that cannot match rules the file out without reading it — the thing that keeps
    // this fast on a brain of tens of thousands of files.
    //
    // What "cannot match" means depends on line endings. Normally it is plain inequality. Under
    // `core.autocrlf` the working copy may hold CRLF where the blob holds LF, so an identical file
    // is legitimately LONGER on disk by one byte per line and never shorter — the test narrows to
    // `localSize < blobSize` there, which stays sound.
    //
    // Note that `core.autocrlf` being set does NOT mean these files were converted: DevsMind
    // writes its JSON with LF, and on the brain this was profiled against every graph file was
    // pure LF despite autocrlf being on. Treating the config flag alone as "sizes are useless"
    // gave up the fast path for nothing and left the command opening 19,410 files needlessly.
    if (recorded.size >= 0) {
      let localSize: number | null = null;
      try {
        localSize = fs.statSync(path.join(localDir, rel)).size;
      } catch {
        localSize = null;
      }
      if (localSize !== null) {
        if (normalizeCrlf ? localSize < recorded.size : localSize !== recorded.size) {
          modified++;
          continue;
        }
      }
    }
    // A file we cannot hash is reported as modified rather than skipped: under-reporting a pending
    // change is the one outcome that makes this command actively misleading.
    if (gitBlobSha(path.join(localDir, rel), normalizeCrlf) !== recorded.sha) modified++;
  }

  const localSet = new Set(localFiles);
  let deleted = 0;
  for (const rel of onBranch.keys()) if (!localSet.has(rel)) deleted++;

  return { sub, modified, added, deleted };
}

// ─── Repairing a brain still tracked on the developer's own branch ───────────

export interface BrainTrackingRepair {
  /** Subdirectories that were tracked on the working branch and have now been unstaged. */
  untracked: string[];
  /** How many files `git rm --cached` removed from the index. */
  filesUntracked: number;
  /** The staged deletions are NOT committed — see the doc on repairBrainTracking. */
  needsCommit: boolean;
  /** Populated when the untrack could not run at all, so the caller can say why. */
  error?: string;
}

/**
 * Stops the developer's own branch from tracking the four shared-brain directories, for a brain
 * created before 4.4.0 (or by a teammate still on an older version) where they were committed
 * alongside the code.
 *
 * Adding them to `.gitignore` — which `devsmind init` now does — cannot fix this on its own: git
 * keeps tracking whatever it already tracks, and an ignore rule is never consulted for a tracked
 * file. Until they are removed from the index they keep appearing in every `git status` and every
 * pull request, which is the whole problem the 4.4.0 gitignore change exists to solve.
 *
 * **Deliberately does not commit.** `git rm --cached` stages a deletion of every brain file on the
 * user's real branch, which is a change to THEIR history, not DevsMind's — the same line this tool
 * holds everywhere else (`commit_changes` never runs git either). Staging it and saying so leaves
 * the decision with the developer.
 *
 * The cost of that choice is worth naming: staged-but-uncommitted deletions are fragile. A merge or
 * a checkout discards them silently and the files come straight back — which is exactly what
 * happened on the brain this was written for. Hence `needsCommit`, which callers must surface
 * rather than treat as a detail.
 */
export function repairBrainTracking(devmindDir: string): BrainTrackingRepair | null {
  let repoRoot: string;
  try {
    repoRoot = findRepoRoot(devmindDir);
  } catch {
    return null; // not a git repo at all — nothing to untrack, and sync will report that itself
  }

  const tracked: string[] = [];
  for (const sub of DEVSMIND_BRANCH_SUBDIRS) {
    const abs = path.join(devmindDir, sub);
    if (!fs.existsSync(abs)) continue;
    // `ls-files` against the working branch's index: a hit means this directory is tracked HERE,
    // on the branch the developer is standing on, which is what has to stop.
    const listed = git(repoRoot, ['ls-files', '--', abs]);
    if (listed.ok && listed.stdout.trim()) tracked.push(sub);
  }
  if (tracked.length === 0) return null;

  const paths = tracked.map(sub => path.join(devmindDir, sub));
  const before = countIndexedFiles(repoRoot, paths);
  // `--cached` is the entire point: the index entry goes, every file stays on disk untouched, and
  // the brain keeps working through and after the repair.
  const removed = git(repoRoot, ['rm', '-r', '--cached', '--quiet', '--', ...paths]);
  if (!removed.ok) {
    return {
      untracked: [], filesUntracked: 0, needsCommit: false,
      error: removed.stderr || removed.stdout || 'git rm --cached failed',
    };
  }
  const after = countIndexedFiles(repoRoot, paths);
  return { untracked: tracked, filesUntracked: Math.max(0, before - after), needsCommit: true };
}

function countIndexedFiles(repoRoot: string, paths: string[]): number {
  const listed = git(repoRoot, ['ls-files', '--', ...paths]);
  if (!listed.ok || !listed.stdout.trim()) return 0;
  return listed.stdout.split('\n').filter(Boolean).length;
}


