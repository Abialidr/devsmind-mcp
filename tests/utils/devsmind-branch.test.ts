import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

// Real-git integration tests: a bare "remote" repo plus two independent clones (repoA/repoB,
// simulating two teammates), same style as tests/utils/git.test.ts. push/pull are built on
// `git worktree`, deliberately never checking out the caller's actual branch — the assertions
// here lean hard on proving that: the calling repo's HEAD/branch/working tree must never move.

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
  fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
}

describe('devsmind-branch — push/pull over real git', () => {
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

  it('push creates the devsmind branch as an orphan and never moves the caller\'s checked-out branch', () => {
    const { pushDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', { a: 1 });

    const startBranch = sh(repoA, 'git branch --show-current');
    const result = pushDevsmindBranch(devA, 'first push');

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.filesChanged).toBe(1);
    expect(result.branch).toBe('devsmind');

    // Caller's own branch/HEAD untouched.
    expect(sh(repoA, 'git branch --show-current')).toBe(startBranch);
    expect(sh(repoA, 'git status --porcelain -- README.md')).toBe('');
    // No leftover worktree registration.
    expect(sh(repoA, 'git worktree list').split('\n')).toHaveLength(1);

    // The devsmind branch is an ORPHAN — no parent commit, and no README.md in its tree.
    const parents = sh(repoA, `git log --format=%P -n 1 devsmind`);
    expect(parents).toBe('');
    const files = sh(repoA, 'git ls-tree -r --name-only devsmind');
    expect(files).not.toMatch('README.md');
    expect(files).toMatch('.devsmind/graph/foo.json');
    // config.json deliberately does NOT ride along — see CHANGELOG 4.3.0.
    expect(files).not.toMatch('config.json');
  });

  it('is idempotent: a second push with no changes reports nothing to do', () => {
    const { pushDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', { a: 1 });
    pushDevsmindBranch(devA, 'first push');

    const second = pushDevsmindBranch(devA, 'second push, no changes');
    expect(second.committed).toBe(false);
    expect(second.pushed).toBe(false);
    expect(second.filesChanged).toBe(0);
  });

  it('pushes a stranded local commit even when this run has no new file changes', () => {
    const { pushDevsmindBranch, DEVSMIND_BRANCH } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', { a: 1 });
    pushDevsmindBranch(devA, 'first push');

    // Simulate an earlier push that committed locally but failed to reach the remote: delete
    // the branch on the "remote" and prune (plain `fetch` alone does NOT drop a stale
    // remote-tracking ref — `--prune` is required), so origin/devsmind no longer resolves.
    sh(remote, `git update-ref -d refs/heads/${DEVSMIND_BRANCH}`);
    sh(repoA, `git fetch origin --prune`);

    const result = pushDevsmindBranch(devA, 'unused — nothing new to commit');
    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(true);
    expect(sh(remote, `git rev-parse ${DEVSMIND_BRANCH}`)).toBe(sh(repoA, `git rev-parse ${DEVSMIND_BRANCH}`));
  });

  it('commits locally without error when no remote is configured', () => {
    const { pushDevsmindBranch } = require('../../src/utils/devsmind-branch');
    sh(repoA, 'git remote remove origin');
    writeJson(devA, 'graph', 'foo.json', { a: 1 });

    const result = pushDevsmindBranch(devA, 'local only');
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.remote).toBeNull();
  });

  it('rejects an empty/whitespace commit message before touching git', () => {
    const { pushDevsmindBranch } = require('../../src/utils/devsmind-branch');
    expect(() => pushDevsmindBranch(devA, '   ')).toThrow(/commit message is required/);
  });

  it('throws a clear error when .devsmind is not inside a git repository', () => {
    const { pushDevsmindBranch } = require('../../src/utils/devsmind-branch');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-not-a-repo-'));
    const devDir = path.join(bare, '.devsmind');
    fs.mkdirSync(devDir, { recursive: true });
    try {
      expect(() => pushDevsmindBranch(devDir, 'msg')).toThrow(/not inside a git repository/);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('pull reports found:false when the devsmind branch does not exist anywhere yet', () => {
    const { pullDevsmindBranch } = require('../../src/utils/devsmind-branch');
    const result = pullDevsmindBranch(devA);
    expect(result.found).toBe(false);
  });

  it('round-trips push → clone → pull, including deletion propagation, without touching the puller\'s checked-out branch', () => {
    const { pushDevsmindBranch, pullDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', { a: 1 });
    writeJson(devA, 'history', 'h1.json', { b: 2 });
    pushDevsmindBranch(devA, 'seed');

    // Second teammate: fresh clone, config.json arrives via the normal code-branch commit.
    sh(repoA, 'git add .devsmind/config.json');
    sh(repoA, 'git commit -q -m "add config.json to code branch"');
    sh(repoA, 'git push -q origin HEAD');

    const repoB = path.join(root, 'repo-b');
    execSync(`git clone -q "${remote}" "${repoB}"`);
    const devB = path.join(repoB, '.devsmind');
    expect(fs.existsSync(path.join(devB, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(devB, 'graph'))).toBe(false);

    const startBranchB = sh(repoB, 'git branch --show-current');
    const pulled = pullDevsmindBranch(devB);

    expect(pulled.found).toBe(true);
    expect(pulled.fromRemote).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(devB, 'graph', 'foo.json'), 'utf-8'))).toEqual({ a: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(devB, 'history', 'h1.json'), 'utf-8'))).toEqual({ b: 2 });
    expect(sh(repoB, 'git branch --show-current')).toBe(startBranchB);
    expect(sh(repoB, 'git worktree list').split('\n')).toHaveLength(1);

    // Teammate A deletes a file and pushes again.
    fs.rmSync(path.join(devA, 'history', 'h1.json'));
    writeJson(devA, 'graph', 'bar.json', { c: 3 });
    pushDevsmindBranch(devA, 'delete h1, add bar');

    pullDevsmindBranch(devB);
    expect(fs.existsSync(path.join(devB, 'history', 'h1.json'))).toBe(false);
    // history/ had exactly one file — mirror semantics remove the now-empty subdir entirely.
    expect(fs.existsSync(path.join(devB, 'history'))).toBe(false);
    expect(fs.existsSync(path.join(devB, 'graph', 'bar.json'))).toBe(true);
    expect(fs.existsSync(path.join(devB, 'graph', 'foo.json'))).toBe(true);
  });

  it('never commits config.json, .env, brain.db, or local/ onto the devsmind branch', () => {
    const { pushDevsmindBranch } = require('../../src/utils/devsmind-branch');
    fs.writeFileSync(path.join(devA, '.env'), 'DEVELOPER_NAME=test');
    fs.writeFileSync(path.join(devA, 'brain.db'), 'not a real db');
    fs.mkdirSync(path.join(devA, 'local'), { recursive: true });
    fs.writeFileSync(path.join(devA, 'local', 'sessions.json'), '[]');
    writeJson(devA, 'graph', 'foo.json', { a: 1 });

    pushDevsmindBranch(devA, 'push with local-only files present');
    const files = sh(repoA, 'git ls-tree -r --name-only devsmind');
    expect(files).not.toMatch('config.json');
    expect(files).not.toMatch('.env');
    expect(files).not.toMatch('brain.db');
    expect(files).not.toMatch('local/');
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
    const { pushDevsmindBranch } = require('../../src/utils/devsmind-branch');
    writeJson(devA, 'graph', 'foo.json', { a: 1 });

    pushDevsmindBranch(devA, 'spawn-options check');

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
});
