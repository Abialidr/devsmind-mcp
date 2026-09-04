import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

// Real-git integration tests: a bare "remote" repo plus two independent clones (repoA/repoB,
// simulating two teammates), same style as tests/utils/git.test.ts. gitSyncDevsmindBranch is
// built on `git worktree`, deliberately never checking out the caller's actual branch — the
// assertions here lean hard on proving that: the calling repo's HEAD/branch/working tree must
// never move. The merge cases are the reason this tool exists at all; see the module doc in
// src/utils/devsmind-branch.ts for the failure the old push/pull pair had.

function sh(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'git init -q');
  sh(dir, 'git config user.email "test@example.com"');
  sh(dir, 'git config user.name "Test User"');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  sh(dir, 'git add README.md');
  sh(dir, 'git commit -q -m init');
}

function writeJson(devDir: string, sub: string, name: string, content: unknown): void {
  const dir = path.join(devDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(content, null, 2));
}

function readJson(devDir: string, sub: string, name: string): any {
  return JSON.parse(fs.readFileSync(path.join(devDir, sub, name), 'utf-8'));
}

/** A realistically-shaped graph JSON — the validator checks for exactly these fields. */
function graphFile(filePath: string, nodes: { id: string; deprecated?: number }[]) {
  return {
    file_path: filePath,
    nodes: nodes.map(n => ({
      id: n.id, name: n.id, type: 'function', signature: `${n.id}()`,
      deprecated: n.deprecated ?? 0
    })),
    connections: []
  };
}

describe('devsmind-branch — git-sync over real git', () => {
  let root: string;
  let remote: string;
  let repoA: string;
  let devA: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-branch-test-'));
    remote = path.join(root, 'remote.git');
    fs.mkdirSync(remote);
    execSync('git init -q --bare', { cwd: remote });

    repoA = path.join(root, 'repo-a');
    initRepo(repoA);
    sh(repoA, `git remote add origin "${remote}"`);
    sh(repoA, 'git push -q -u origin HEAD');

    devA = path.join(repoA, '.devsmind');
    fs.mkdirSync(devA, { recursive: true });
    fs.writeFileSync(path.join(devA, 'config.json'), '{}');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    jest.resetModules();
  });

  /** Second teammate: a fresh clone that already has the devsmind branch's content pulled down. */
  function makeRepoB(): { repoB: string; devB: string } {
    const repoB = path.join(root, 'repo-b');
    execSync(`git clone -q "${remote}" "${repoB}"`);
    const devB = path.join(repoB, '.devsmind');
    fs.mkdirSync(devB, { recursive: true });
    fs.writeFileSync(path.join(devB, 'config.json'), '{}');
    return { repoB, devB };
  }

  it('creates the devsmind branch as an orphan and never moves the caller\'s checked-out branch', () => {
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo' }]));

    const startBranch = sh(repoA, 'git branch --show-current');
    const result = gitSyncDevsmindBranch(devA, 'first sync');

    expect(result.status).toBe('pushed');
    expect(result.filesChanged).toBe(1);
    expect(result.branch).toBe('devsmind');

    // Caller's own branch/HEAD untouched.
    expect(sh(repoA, 'git branch --show-current')).toBe(startBranch);
    expect(sh(repoA, 'git status --porcelain -- README.md')).toBe('');
    // No leftover worktree registration.
    expect(sh(repoA, 'git worktree list').split('\n')).toHaveLength(1);

    // The devsmind branch is an ORPHAN — no parent commit, and no README.md in its tree.
    expect(sh(repoA, 'git log --format=%P -n 1 devsmind')).toBe('');
    const files = sh(repoA, 'git ls-tree -r --name-only devsmind');
    expect(files).not.toMatch('README.md');
    expect(files).toMatch('.devsmind/graph/foo.json');
    // config.json deliberately does NOT ride along — see CHANGELOG 4.3.0.
    expect(files).not.toMatch('config.json');
  });

  it('never materializes the repo\'s own source tree into the scratch worktree', () => {
    // Regression coverage for a real timeout: creating the orphan branch used to run
    // `worktree add --detach <dir> HEAD`, which checks out EVERY file in the repository into the
    // temp dir purely so the next command could `git rm -rf .` all of it again. On a large repo
    // that copy blew straight through the per-call timeout — and the error blamed credentials,
    // which `worktree add` cannot possibly need. Proven here by watching the actual argv: the
    // checkout must be suppressed, not merely fast on a small fixture.
    const spawnSyncSpy = jest.spyOn(require('child_process'), 'spawnSync');
    jest.resetModules();
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    // A file that only exists on the code branch — it must never be written into the worktree.
    fs.writeFileSync(path.join(repoA, 'BIG_SOURCE_FILE.ts'), 'export const x = 1;\n');
    sh(repoA, 'git add -A');
    sh(repoA, 'git commit -q -m "add source file"');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo' }]));

    const result = gitSyncDevsmindBranch(devA, 'first sync');
    expect(result.status).toBe('pushed');

    const worktreeAdd = spawnSyncSpy.mock.calls
      .map(c => c[1] as string[])
      .find(a => Array.isArray(a) && a[0] === 'worktree' && a[1] === 'add');
    expect(worktreeAdd).toContain('--no-checkout');
    spawnSyncSpy.mockRestore();

    // And the branch itself carries only .devsmind/ — never the repo's source.
    const files = sh(repoA, 'git ls-tree -r --name-only devsmind');
    expect(files).not.toMatch('BIG_SOURCE_FILE.ts');
    expect(files).toMatch('.devsmind/graph/foo.json');
  });

  it('never runs the host repo\'s commit hooks — they have no business policing DevsMind\'s own bookkeeping commits', () => {
    // Regression coverage for a real failure: `git commit` blew through the timeout on a repo
    // whose pre-commit hook ran against the sync's internal commit. These commits land on an
    // orphan branch holding nothing but .devsmind/ — a linter, a conventional-commit checker, or
    // anything that shells out has no business running on them, and a hook that blocks turns a
    // routine sync into a hang. Proven with a hook that would fail the commit outright if run.
    const hookPath = path.join(repoA, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "hook ran" >&2\nexit 1\n');
    fs.chmodSync(hookPath, 0o755);

    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo' }]));

    // Would throw "commit failed" if the hook were allowed to run.
    const result = gitSyncDevsmindBranch(devA, 'sync past a failing pre-commit hook');
    expect(result.status).toBe('pushed');
    expect(sh(remote, 'git ls-tree -r --name-only devsmind')).toMatch('.devsmind/graph/foo.json');
  });

  it('a sync onto an EXISTING devsmind branch never stages the branch\'s own files as deletions', () => {
    // Regression coverage for a real, visible bug: syncing onto an already-existing devsmind
    // branch staged ~10,000 files as `D` (deleted) against a brain whose real change count was
    // 51. Cause: the "branch exists" path skipped the checkout, so git believed the worktree
    // should hold the branch's files, found them absent, and `git add -A` recorded every one as a
    // deletion — which would have wiped the team's entire graph off the branch on the next push.
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');

    // Seed several files so a wholesale deletion would be unmistakable.
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      writeJson(devA, 'graph', `${name}.json`, graphFile(`{app}/${name}.ts`, [{ id: name }]));
    }
    gitSyncDevsmindBranch(devA, 'seed five files');
    const afterSeed = sh(remote, 'git ls-tree -r --name-only devsmind').split('\n').filter(Boolean);
    expect(afterSeed).toHaveLength(5);

    // Now change exactly ONE file and sync again, onto the branch that already exists locally.
    writeJson(devA, 'graph', 'a.json', graphFile('{app}/a.ts', [{ id: 'a', deprecated: 1 }]));
    const second = gitSyncDevsmindBranch(devA, 'change one file');

    expect(second.status).toBe('pushed');
    // Exactly one file changed — not five deleted and one added.
    expect(second.filesChanged).toBe(1);
    // And all five survive on the branch.
    const afterSecond = sh(remote, 'git ls-tree -r --name-only devsmind').split('\n').filter(Boolean);
    expect(afterSecond.sort()).toEqual(afterSeed.sort());
    expect(readJson(devA, 'graph', 'a.json').nodes[0].deprecated).toBe(1);
  });

  it('works on a legacy .devmind brain, committing under its real folder name rather than .devsmind', () => {
    // Regression coverage for the bug behind ~10,000 spurious `D` (deleted) entries on a real
    // repo whose true change count was 51. A brain created before 4.2.0 is named `.devmind` and
    // keeps working forever by design, but this module hardcoded `.devsmind` — so it wrote to and
    // staged a path the branch had never heard of, while every genuine `.devmind/...` file looked
    // missing and got staged as a deletion. On the next push that would have wiped the team's
    // entire graph off the branch.
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    const legacyDev = path.join(repoA, '.devmind');
    fs.mkdirSync(legacyDev, { recursive: true });
    fs.writeFileSync(path.join(legacyDev, 'config.json'), '{}');
    writeJson(legacyDev, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo' }]));

    const first = gitSyncDevsmindBranch(legacyDev, 'seed a legacy brain');
    expect(first.status).toBe('pushed');
    // Committed under the brain's ACTUAL name, not a hardcoded one.
    const files = sh(remote, 'git ls-tree -r --name-only devsmind');
    expect(files).toMatch('.devmind/graph/foo.json');
    expect(files).not.toMatch('.devsmind/');

    // And a follow-up sync sees one real change, not a mass deletion of what it just wrote.
    writeJson(legacyDev, 'graph', 'bar.json', graphFile('{app}/bar.ts', [{ id: 'bar' }]));
    const second = gitSyncDevsmindBranch(legacyDev, 'add one more');
    expect(second.status).toBe('pushed');
    expect(second.filesChanged).toBe(1);
    expect(sh(remote, 'git ls-tree -r --name-only devsmind').split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('is idempotent: a second sync with no changes reports nothing to do', () => {
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo' }]));
    gitSyncDevsmindBranch(devA, 'first sync');

    const second = gitSyncDevsmindBranch(devA, 'second sync, no changes');
    expect(second.status).toBe('nothing_to_do');
    expect(second.filesChanged).toBe(0);
  });

  it('pushes a stranded local commit even when this run has no new file changes', () => {
    const { gitSyncDevsmindBranch, DEVSMIND_BRANCH } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo' }]));
    gitSyncDevsmindBranch(devA, 'first sync');

    // Simulate an earlier run that committed locally but failed to reach the remote: delete
    // the branch on the "remote" and prune (plain `fetch` alone does NOT drop a stale
    // remote-tracking ref — `--prune` is required), so origin/devsmind no longer resolves.
    sh(remote, `git update-ref -d refs/heads/${DEVSMIND_BRANCH}`);
    sh(repoA, `git fetch origin --prune`);

    const result = gitSyncDevsmindBranch(devA, 'unused — nothing new to commit');
    expect(result.status).toBe('pushed');
    expect(result.filesChanged).toBe(0);
    expect(sh(remote, `git rev-parse ${DEVSMIND_BRANCH}`)).toBe(sh(repoA, `git rev-parse ${DEVSMIND_BRANCH}`));
  });

  it('commits locally without error when no remote is configured', () => {
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    sh(repoA, 'git remote remove origin');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo' }]));

    const result = gitSyncDevsmindBranch(devA, 'local only');
    expect(result.status).toBe('committed_local_only');
    expect(result.remote).toBeNull();
  });

  it('rejects an empty/whitespace commit message before touching git', () => {
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    expect(() => gitSyncDevsmindBranch(devA, '   ')).toThrow(/commit message is required/);
  });

  it('throws a clear error when .devsmind is not inside a git repository', () => {
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-not-a-repo-'));
    const devDir = path.join(bare, '.devsmind');
    fs.mkdirSync(devDir, { recursive: true });
    try {
      expect(() => gitSyncDevsmindBranch(devDir, 'msg')).toThrow(/not inside a git repository/);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('never commits config.json, .env, brain.db, or local/ onto the devsmind branch', () => {
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    fs.writeFileSync(path.join(devA, '.env'), 'DEVELOPER_NAME=test');
    fs.writeFileSync(path.join(devA, 'brain.db'), 'not a real db');
    fs.mkdirSync(path.join(devA, 'local'), { recursive: true });
    fs.writeFileSync(path.join(devA, 'local', 'sessions.json'), '[]');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo' }]));

    gitSyncDevsmindBranch(devA, 'sync with local-only files present');
    const files = sh(repoA, 'git ls-tree -r --name-only devsmind');
    expect(files).not.toMatch('config.json');
    expect(files).not.toMatch('.env');
    expect(files).not.toMatch('brain.db');
    expect(files).not.toMatch('local/');
  });

  // ── The merge cases: the whole reason this replaced push/pull ──────────────

  it('auto-merges when two teammates changed DIFFERENT files — neither side is lost', () => {
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    // Shared starting point.
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo' }]));
    gitSyncDevsmindBranch(devA, 'seed');

    const { devB } = makeRepoB();
    gitSyncDevsmindBranch(devB, 'B catches up');

    // A adds its own file and pushes first.
    writeJson(devA, 'graph', 'a-only.json', graphFile('{app}/a.ts', [{ id: 'aOnly' }]));
    gitSyncDevsmindBranch(devA, 'A adds a-only');

    // B, still on the older tip, adds a DIFFERENT file and syncs.
    writeJson(devB, 'graph', 'b-only.json', graphFile('{app}/b.ts', [{ id: 'bOnly' }]));
    const result = gitSyncDevsmindBranch(devB, 'B adds b-only');

    expect(result.status).toBe('pushed');
    // Both teammates' files survive, on the shared branch and on B's disk. Read the branch from
    // the bare remote itself — repoA has not fetched since B pushed, so its remote-tracking ref
    // would still be showing the pre-merge tip.
    const files = sh(remote, 'git ls-tree -r --name-only devsmind');
    expect(files).toMatch('a-only.json');
    expect(files).toMatch('b-only.json');
    expect(fs.existsSync(path.join(devB, 'graph', 'a-only.json'))).toBe(true);
    expect(fs.existsSync(path.join(devB, 'graph', 'b-only.json'))).toBe(true);
  });

  it('the deprecated case: a field only ONE side changed survives, and the other side\'s unrelated work does too', () => {
    // This is the scenario that ruled out "newest timestamp wins". B never touches `deprecated`
    // and would happily report a newer file (it added history), but A's deliberate flip to 1 is
    // the only actual change to that field — a 3-way merge keeps it, a newest-wins would not.
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo', deprecated: 0 }]));
    gitSyncDevsmindBranch(devA, 'seed with deprecated: 0');

    const { devB } = makeRepoB();
    gitSyncDevsmindBranch(devB, 'B catches up');

    // A deprecates the node and pushes.
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo', deprecated: 1 }]));
    gitSyncDevsmindBranch(devA, 'A deprecates foo');

    // B never touched foo.json's deprecated flag; it only added an unrelated history entry.
    writeJson(devB, 'history', 'h1.json', { id: 'h1', node_id: 'foo', reasoning: 'B did some work' });
    const result = gitSyncDevsmindBranch(devB, 'B adds history');

    expect(result.status).toBe('pushed');
    // A's decision survived...
    expect(readJson(devB, 'graph', 'foo.json').nodes[0].deprecated).toBe(1);
    // ...and B's own work did too.
    expect(fs.existsSync(path.join(devB, 'history', 'h1.json'))).toBe(true);
  });

  it('a true conflict stops the sync, retains the worktree, and leaves the real brain untouched', () => {
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo', deprecated: 0 }]));
    gitSyncDevsmindBranch(devA, 'seed');

    const { devB } = makeRepoB();
    gitSyncDevsmindBranch(devB, 'B catches up');

    // Both sides change the SAME field of the SAME node to different values.
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo', deprecated: 1 }]));
    gitSyncDevsmindBranch(devA, 'A deprecates');

    writeJson(devB, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'fooRenamedByB', deprecated: 0 }]));
    const result = gitSyncDevsmindBranch(devB, 'B renames');

    expect(result.status).toBe('conflicted');
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0].path).toMatch(/foo\.json$/);
    // Both sides are handed over cleanly, not just the marker soup.
    expect(result.conflicts[0].ours).toContain('fooRenamedByB');
    expect(result.conflicts[0].theirs).toContain('"deprecated": 1');
    // The worktree is retained for resolution...
    expect(fs.existsSync(result.worktree)).toBe(true);
    // ...and nothing half-merged reached the real brain, which syncFromDisk would import
    // destructively (it deletes every node for a file before reinserting from the JSON).
    expect(fs.readFileSync(path.join(devB, 'graph', 'foo.json'), 'utf-8')).not.toMatch('<<<<<<<');
    expect(readJson(devB, 'graph', 'foo.json').nodes[0].id).toBe('fooRenamedByB');
  });

  it('resumes and pushes after the caller resolves the conflict in the worktree', () => {
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo', deprecated: 0 }]));
    gitSyncDevsmindBranch(devA, 'seed');
    const { devB } = makeRepoB();
    gitSyncDevsmindBranch(devB, 'B catches up');

    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo', deprecated: 1 }]));
    gitSyncDevsmindBranch(devA, 'A deprecates');
    writeJson(devB, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo', deprecated: 0 }, { id: 'extraFromB' }]));
    const conflict = gitSyncDevsmindBranch(devB, 'B adds a node');
    expect(conflict.status).toBe('conflicted');

    // Resolve exactly as an agent would: keep both sides' ids, honour A's deprecation.
    const resolved = graphFile('{app}/foo.ts', [{ id: 'foo', deprecated: 1 }, { id: 'extraFromB' }]);
    fs.writeFileSync(path.join(conflict.worktree, conflict.conflicts[0].path), JSON.stringify(resolved, null, 2));

    const done = gitSyncDevsmindBranch(devB, 'B resolves', { worktree: conflict.worktree, resolved: true });
    expect(done.status).toBe('pushed');
    // The resolution reached the branch and B's own disk.
    const onDisk = readJson(devB, 'graph', 'foo.json');
    expect(onDisk.nodes.map((n: { id: string }) => n.id).sort()).toEqual(['extraFromB', 'foo']);
    expect(onDisk.nodes.find((n: { id: string }) => n.id === 'foo').deprecated).toBe(1);
    // Worktree cleaned up once the merge completed.
    expect(fs.existsSync(conflict.worktree)).toBe(false);
  });

  // ── The safety net on an AI-written resolution ────────────────────────────

  it('rejects a resolution that drops an id present on either side, instead of silently losing a node', () => {
    // The failure this guards: syncFromDisk deletes every DB node for a graph file and reinserts
    // from the JSON, so a node missing from a resolution is a node deleted from the shared brain.
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo', deprecated: 0 }]));
    gitSyncDevsmindBranch(devA, 'seed');
    const { devB } = makeRepoB();
    gitSyncDevsmindBranch(devB, 'B catches up');

    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo' }, { id: 'addedByA' }]));
    gitSyncDevsmindBranch(devA, 'A adds a node');
    writeJson(devB, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo' }, { id: 'addedByB' }]));
    const conflict = gitSyncDevsmindBranch(devB, 'B adds a node');
    expect(conflict.status).toBe('conflicted');

    // A resolution that quietly drops A's node.
    const lossy = graphFile('{app}/foo.ts', [{ id: 'foo' }, { id: 'addedByB' }]);
    fs.writeFileSync(path.join(conflict.worktree, conflict.conflicts[0].path), JSON.stringify(lossy, null, 2));

    const rejected = gitSyncDevsmindBranch(devB, 'B resolves badly', { worktree: conflict.worktree, resolved: true });
    expect(rejected.status).toBe('invalid_resolution');
    expect(rejected.invalid[0].reason).toMatch(/dropped 1 id/);
    expect(rejected.invalid[0].reason).toMatch('addedByA');
    // Nothing was pushed, and the worktree is kept so the caller can try again.
    expect(fs.existsSync(rejected.worktree)).toBe(true);
    expect(sh(remote, 'git ls-tree -r --name-only devsmind')).not.toMatch('addedByB');
  });

  it('rejects a resolution that still has conflict markers or is not valid JSON', () => {
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo', deprecated: 0 }]));
    gitSyncDevsmindBranch(devA, 'seed');
    const { devB } = makeRepoB();
    gitSyncDevsmindBranch(devB, 'B catches up');

    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo', deprecated: 1 }]));
    gitSyncDevsmindBranch(devA, 'A deprecates');
    writeJson(devB, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo', deprecated: 2 }]));
    const conflict = gitSyncDevsmindBranch(devB, 'B differs');
    expect(conflict.status).toBe('conflicted');

    // Left exactly as git wrote it — markers still in place.
    const stillConflicted = gitSyncDevsmindBranch(devB, 'no real resolution', { worktree: conflict.worktree, resolved: true });
    expect(stillConflicted.status).toBe('invalid_resolution');
    expect(stillConflicted.invalid[0].reason).toMatch(/conflict markers/);

    // Now valid-JSON-but-wrong-shape.
    fs.writeFileSync(path.join(conflict.worktree, conflict.conflicts[0].path), '{"nope": true}');
    const wrongShape = gitSyncDevsmindBranch(devB, 'wrong shape', { worktree: conflict.worktree, resolved: true });
    expect(wrongShape.status).toBe('invalid_resolution');
    expect(wrongShape.invalid[0].reason).toMatch(/file_path/);
  });

  it('refuses to resume against a worktree that is gone or not mid-merge', () => {
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo' }]));

    expect(() => gitSyncDevsmindBranch(devA, 'msg', { worktree: path.join(root, 'nope'), resolved: true }))
      .toThrow(/is gone/);

    const notMerging = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-not-merging-'));
    try {
      expect(() => gitSyncDevsmindBranch(devA, 'msg', { worktree: notMerging, resolved: true }))
        .toThrow(/not in the middle of a merge/);
    } finally {
      fs.rmSync(notMerging, { recursive: true, force: true });
    }
  });

  // Regression coverage for a real incident: `devsmind push` ran inside an IDE-embedded terminal
  // with no real TTY for a credential prompt to attach to, and hung indefinitely with no error —
  // `spawnSync('git', ...)` had no GIT_TERMINAL_PROMPT=0, no stdin detach, and no timeout, so a
  // `push`/`fetch` that wanted to prompt for credentials just blocked forever instead of failing.
  // Reproducing the hang itself isn't practical here (it needs a host that actually reaches
  // credential negotiation, which isn't available offline/in CI) — this instead proves the three
  // concrete measures are in place on every git invocation this module makes, which is what
  // actually prevents the hang regardless of which git operation would have triggered it.
  it('spawns every git call with prompt suppression, detached stdin, and a timeout — so a hung credential prompt fails fast instead of hanging forever', () => {
    const spawnSyncSpy = jest.spyOn(require('child_process'), 'spawnSync');
    jest.resetModules();
    const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', graphFile('{app}/foo.ts', [{ id: 'foo' }]));

    gitSyncDevsmindBranch(devA, 'spawn-options check');

    expect(spawnSyncSpy).toHaveBeenCalled();
    for (const call of spawnSyncSpy.mock.calls) {
      const [cmd, , opts] = call as [string, string[], Record<string, unknown>];
      if (cmd !== 'git') continue;
      expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      expect(opts.timeout).toBeGreaterThan(0);
      expect((opts.env as Record<string, string>).GIT_TERMINAL_PROMPT).toBe('0');
    }
    spawnSyncSpy.mockRestore();
  });

  // A brain created before 4.3.3 has graph/history/vectors/workflows COMMITTED on the developer's
  // own branch, and a `.gitignore` that never listed them. Neither half fixes that alone: git
  // consults no ignore rule for a file it already tracks, and untracking without the ignore rule
  // just lets the next sync stage them all over again.
  describe('repairBrainTracking', () => {
    it('untracks brain files from the working branch without removing them from disk', () => {
      const { repairBrainTracking } = require('../../src/utils/devsmind-branch');
      writeJson(devA, 'graph', 'a.json', graphFile('{app}/a.ts', [{ id: 'a' }]));
      writeJson(devA, 'vectors', 'a.json', { file_path: '{app}/a.ts', vectors: {} });
      sh(repoA, 'git add -A .devsmind');
      sh(repoA, 'git commit -q -m "brain committed on main, pre-4.3.3 style"');
      expect(sh(repoA, 'git ls-files .devsmind/graph').trim()).not.toBe('');

      const result = repairBrainTracking(devA);

      expect(result).not.toBeNull();
      expect(result.needsCommit).toBe(true);
      expect(result.untracked).toEqual(expect.arrayContaining(['graph', 'vectors']));
      expect(sh(repoA, 'git ls-files .devsmind/graph').trim()).toBe('');
      // The whole point: git stops tracking them, the brain keeps working.
      expect(fs.existsSync(path.join(devA, 'graph', 'a.json'))).toBe(true);
      expect(fs.existsSync(path.join(devA, 'vectors', 'a.json'))).toBe(true);
    });

    it('stages the removal but does NOT commit it — that is the developer branch, not ours', () => {
      const { repairBrainTracking } = require('../../src/utils/devsmind-branch');
      writeJson(devA, 'graph', 'a.json', graphFile('{app}/a.ts', [{ id: 'a' }]));
      sh(repoA, 'git add -A .devsmind');
      sh(repoA, 'git commit -q -m "brain committed on main"');
      const headBefore = sh(repoA, 'git rev-parse HEAD');

      repairBrainTracking(devA);

      expect(sh(repoA, 'git rev-parse HEAD')).toBe(headBefore);
      expect(sh(repoA, 'git diff --cached --name-only')).toContain('.devsmind/graph/a.json');
    });

    it('returns null when nothing is tracked, so a healthy brain pays nothing', () => {
      const { repairBrainTracking } = require('../../src/utils/devsmind-branch');
      writeJson(devA, 'graph', 'a.json', graphFile('{app}/a.ts', [{ id: 'a' }]));

      expect(repairBrainTracking(devA)).toBeNull();
    });
  });

  // The copy step used to delete the whole target directory and write every file back, on both
  // legs of every sync. Correct, but it charged a full 10,000-file rewrite for the ordinary case
  // of a handful of edits — the single largest cost in a sync on a real brain.
  describe('only the files that actually changed are copied', () => {
    it('leaves an untouched file alone instead of rewriting it', () => {
      const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
      writeJson(devA, 'graph', 'stable.json', graphFile('{app}/stable.ts', [{ id: 'stable' }]));
      writeJson(devA, 'graph', 'edited.json', graphFile('{app}/edited.ts', [{ id: 'edited' }]));
      gitSyncDevsmindBranch(devA, 'first sync');

      // A second sync after changing exactly one of the two. syncToDisk rewrites every JSON file
      // unconditionally in real use, so mtime alone marks everything as changed — the copy has to
      // compare CONTENT or this test's whole premise disappears.
      const stablePath = path.join(devA, 'graph', 'stable.json');
      const untouchedBefore = fs.statSync(stablePath).mtimeMs;
      fs.utimesSync(stablePath, new Date(), new Date()); // fresh mtime, identical bytes
      writeJson(devA, 'graph', 'edited.json', graphFile('{app}/edited.ts', [{ id: 'edited', deprecated: 1 }]));

      const result = gitSyncDevsmindBranch(devA, 'second sync');

      expect(result.status).toBe('pushed');
      // Only the genuinely-edited file appears in the commit.
      const changedInCommit = sh(repoA, 'git show --name-only --format= devsmind').split('\n').filter(Boolean);
      expect(changedInCommit.some(f => f.endsWith('edited.json'))).toBe(true);
      expect(changedInCommit.some(f => f.endsWith('stable.json'))).toBe(false);
      // And the local copy was never rewritten on the way back down.
      expect(fs.statSync(stablePath).mtimeMs).toBeGreaterThanOrEqual(untouchedBefore);
      expect(readJson(devA, 'graph', 'stable.json').nodes[0].id).toBe('stable');
    });

    it('still propagates a deletion — the one thing the old wholesale mirror got for free', () => {
      const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
      writeJson(devA, 'graph', 'keep.json', graphFile('{app}/keep.ts', [{ id: 'keep' }]));
      writeJson(devA, 'graph', 'gone.json', graphFile('{app}/gone.ts', [{ id: 'gone' }]));
      gitSyncDevsmindBranch(devA, 'both present');
      expect(sh(repoA, 'git ls-tree -r --name-only devsmind')).toContain('gone.json');

      fs.rmSync(path.join(devA, 'graph', 'gone.json'));
      const result = gitSyncDevsmindBranch(devA, 'one removed');

      expect(result.status).toBe('pushed');
      const onBranch = sh(repoA, 'git ls-tree -r --name-only devsmind');
      expect(onBranch).toContain('keep.json');
      // Without an explicit removal pass, a deleted node would live on in the shared brain
      // forever — data resurrection, and silent.
      expect(onBranch).not.toContain('gone.json');
    });

    it('detects an edit that leaves the file exactly the same size', () => {
      const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
      // Size is compared first as a cheap reject; a same-size change is what proves the byte
      // comparison behind it actually runs.
      writeJson(devA, 'graph', 'same-size.json', graphFile('{app}/x.ts', [{ id: 'aaa' }]));
      gitSyncDevsmindBranch(devA, 'first');

      const before = fs.statSync(path.join(devA, 'graph', 'same-size.json')).size;
      writeJson(devA, 'graph', 'same-size.json', graphFile('{app}/x.ts', [{ id: 'bbb' }]));
      expect(fs.statSync(path.join(devA, 'graph', 'same-size.json')).size).toBe(before);

      const result = gitSyncDevsmindBranch(devA, 'same size, different content');

      expect(result.status).toBe('pushed');
      expect(sh(repoA, 'git show --name-only --format= devsmind')).toContain('same-size.json');
    });

    // The bug this guards: a brain that has never synced holds none of the team's files, and
    // "the branch has it, I don't" is indistinguishable from "I deleted it" using local state
    // alone. Our side is committed BEFORE the merge, so committing that as a deletion is final —
    // git sees a delete on one side against no change on the other and honors it. A developer's
    // first-ever sync silently erased everyone else's graph from the shared brain.
    it('a first-ever sync never deletes files the brain has simply never seen', () => {
      const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
      writeJson(devA, 'graph', 'mine.json', graphFile('{app}/mine.ts', [{ id: 'mine' }]));
      gitSyncDevsmindBranch(devA, 'A first');

      // B clones and syncs having only ever written its own file — it has never received A's.
      const { repoB, devB } = makeRepoB();
      writeJson(devB, 'graph', 'theirs.json', graphFile('{app}/theirs.ts', [{ id: 'theirs' }]));
      const result = gitSyncDevsmindBranch(devB, 'B first ever sync');

      expect(result.status).toBe('pushed');
      const onBranch = sh(repoB, 'git ls-tree -r --name-only devsmind');
      expect(onBranch).toContain('theirs.json');
      expect(onBranch).toContain('mine.json');
      // ...and B ends up holding both, having received A's work rather than destroyed it.
      expect(readJson(devB, 'graph', 'mine.json').nodes[0].id).toBe('mine');
    });

    it('brings a teammate\'s new file down without disturbing the rest of the brain', () => {
      const { gitSyncDevsmindBranch } = require('../../src/utils/devsmind-branch');
      writeJson(devA, 'graph', 'mine.json', graphFile('{app}/mine.ts', [{ id: 'mine' }]));
      gitSyncDevsmindBranch(devA, 'A first');

      const { devB } = makeRepoB();
      writeJson(devB, 'graph', 'theirs.json', graphFile('{app}/theirs.ts', [{ id: 'theirs' }]));
      gitSyncDevsmindBranch(devB, 'B adds one');

      const minePath = path.join(devA, 'graph', 'mine.json');
      const mineBefore = fs.readFileSync(minePath, 'utf-8');
      const result = gitSyncDevsmindBranch(devA, 'A picks it up');

      // A contributed nothing of its own this round, so there is genuinely nothing to push back —
      // receiving still has to work on that path, which is the whole point of the assertion below.
      expect(result.status).toBe('nothing_to_do');
      expect(readJson(devA, 'graph', 'theirs.json').nodes[0].id).toBe('theirs');
      expect(fs.readFileSync(minePath, 'utf-8')).toBe(mineBefore);
    });
  });
});
