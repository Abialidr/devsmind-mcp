import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

// getRenamedFilesSince / getChangedFilesSince wrap `execSync('git ...')` via a `runGit()` helper
// that never throws — missing git, a non-repo cwd, and an empty history all degrade to an empty
// result. We cover the real-git integration path, the pure parsing logic against hand-built
// multi-line `git log` output (mocking child_process), and the error-swallowing path.

describe('git utils — real git integration', () => {
  let repoDir: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-git-test-'));
    execSync('git init -q', { cwd: repoDir });
    execSync('git config user.email "test@example.com"', { cwd: repoDir });
    execSync('git config user.name "Test User"', { cwd: repoDir });
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('detects a real rename via `git mv` since a given timestamp', () => {
    const sinceIso = '2000-01-01T00:00:00.000Z';

    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello world file content\n');
    execSync('git add a.txt', { cwd: repoDir });
    execSync('git commit -q -m "init"', { cwd: repoDir });

    execSync('git mv a.txt b.txt', { cwd: repoDir });
    execSync('git commit -q -m "rename a to b"', { cwd: repoDir });

    // require fresh here (after module registry reset in other describe blocks below could
    // otherwise leak mocks) — plain top-level import is fine since this file doesn't mock
    // child_process at module scope.
    const { getRenamedFilesSince, getChangedFilesSince } = require('../../src/utils/git');

    const renamed = getRenamedFilesSince(repoDir, sinceIso);
    expect(renamed).toEqual([{ from: 'a.txt', to: 'b.txt' }]);

    const changed: string[] = getChangedFilesSince(repoDir, sinceIso);
    expect(changed.sort()).toEqual(['a.txt', 'b.txt'].sort());
    // distinct — no duplicates even though git log --name-only can repeat a path across commits
    expect(new Set(changed).size).toBe(changed.length);
  });

  it('returns [] when sinceIso is in the future (empty history in range)', () => {
    const { getRenamedFilesSince, getChangedFilesSince } = require('../../src/utils/git');
    // NOTE: a *far*-future year (e.g. 2999) triggers a date-parsing quirk in this git build
    // (git-for-windows 2.48.1) where `--since` silently fails to filter anything beyond
    // roughly year ~2100 — confirmed empirically against a real repo. One year ahead of "now"
    // is comfortably inside the range where `--since` filters correctly, and stays valid
    // indefinitely since it's computed relative to the actual clock rather than hardcoded.
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    expect(getRenamedFilesSince(repoDir, future)).toEqual([]);
    expect(getChangedFilesSince(repoDir, future)).toEqual([]);
  });
});

describe('git utils — error swallowing (not a git repo / no git)', () => {
  let plainDir: string;

  beforeAll(() => {
    plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-not-a-repo-'));
  });

  afterAll(() => {
    fs.rmSync(plainDir, { recursive: true, force: true });
  });

  it('getRenamedFilesSince returns [] instead of throwing for a non-repo directory', () => {
    const { getRenamedFilesSince } = require('../../src/utils/git');
    expect(() => getRenamedFilesSince(plainDir, '2000-01-01T00:00:00.000Z')).not.toThrow();
    expect(getRenamedFilesSince(plainDir, '2000-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('getChangedFilesSince returns [] instead of throwing for a non-repo directory', () => {
    const { getChangedFilesSince } = require('../../src/utils/git');
    expect(() => getChangedFilesSince(plainDir, '2000-01-01T00:00:00.000Z')).not.toThrow();
    expect(getChangedFilesSince(plainDir, '2000-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('swallows a genuinely nonexistent cwd (execSync spawn failure) rather than throwing', () => {
    const { getRenamedFilesSince, getChangedFilesSince } = require('../../src/utils/git');
    const nonexistent = path.join(plainDir, 'does', 'not', 'exist');
    expect(getRenamedFilesSince(nonexistent, '2000-01-01T00:00:00.000Z')).toEqual([]);
    expect(getChangedFilesSince(nonexistent, '2000-01-01T00:00:00.000Z')).toEqual([]);
  });
});

describe('git utils — parsing logic against mocked execSync output', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('getRenamedFilesSince dedupes by destination path, keeping the last entry for a given `to`', () => {
    jest.resetModules();
    const cp = require('child_process');
    const rawOutput = [
      'R100\told/name.ts\tsrc/name.ts',
      'R087\tsrc/foo.ts\tsrc/bar.ts',
      // A second, later rename landing on the SAME destination as the first — dedup keeps this one.
      'R100\tsrc/other-old.ts\tsrc/name.ts',
      // Malformed / irrelevant lines that must be ignored:
      '',
      'M\tsrc/unrelated.ts',
      'R100\tonly-two-fields.ts',
    ].join('\n');
    jest.spyOn(cp, 'execSync').mockReturnValue(rawOutput as any);

    const { getRenamedFilesSince } = require('../../src/utils/git');
    const result = getRenamedFilesSince('/fake/repo', '2020-01-01T00:00:00.000Z');

    expect(result).toEqual(
      expect.arrayContaining([
        { from: 'src/foo.ts', to: 'src/bar.ts' },
        { from: 'src/other-old.ts', to: 'src/name.ts' },
      ])
    );
    // Only one entry for the `src/name.ts` destination (deduped), so total length is 2.
    expect(result).toHaveLength(2);
    expect(result.filter((r: any) => r.to === 'src/name.ts')).toHaveLength(1);
  });

  it('getRenamedFilesSince returns [] when execSync yields empty/whitespace output', () => {
    jest.resetModules();
    const cp = require('child_process');
    jest.spyOn(cp, 'execSync').mockReturnValue('   \n  ' as any);
    const { getRenamedFilesSince } = require('../../src/utils/git');
    expect(getRenamedFilesSince('/fake/repo', '2020-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('getChangedFilesSince returns distinct, trimmed, non-empty paths from multi-commit output', () => {
    jest.resetModules();
    const cp = require('child_process');
    const rawOutput = [
      'src/a.ts',
      'src/b.ts',
      '',
      'src/a.ts', // repeated across commits — must be deduped
      '  src/c.ts  ', // whitespace around the path must be trimmed
      '',
    ].join('\n');
    jest.spyOn(cp, 'execSync').mockReturnValue(rawOutput as any);

    const { getChangedFilesSince } = require('../../src/utils/git');
    const result: string[] = getChangedFilesSince('/fake/repo', '2020-01-01T00:00:00.000Z');

    expect(result.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('getChangedFilesSince returns [] when execSync yields empty output', () => {
    jest.resetModules();
    const cp = require('child_process');
    jest.spyOn(cp, 'execSync').mockReturnValue('' as any);
    const { getChangedFilesSince } = require('../../src/utils/git');
    expect(getChangedFilesSince('/fake/repo', '2020-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('swallows an execSync throw (e.g. git not installed) and returns []', () => {
    jest.resetModules();
    const cp = require('child_process');
    jest.spyOn(cp, 'execSync').mockImplementation(() => {
      throw new Error('spawnSync git ENOENT');
    });
    const { getRenamedFilesSince, getChangedFilesSince } = require('../../src/utils/git');
    expect(getRenamedFilesSince('/fake/repo', '2020-01-01T00:00:00.000Z')).toEqual([]);
    expect(getChangedFilesSince('/fake/repo', '2020-01-01T00:00:00.000Z')).toEqual([]);
  });
});
