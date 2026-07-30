import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEVMIND_GITIGNORE_ENTRIES, ensureDevmindGitignore } from '../../src/cli/init';
import { normalizeIgnoreEntry } from '../../src/db/activity';

/**
 * `.devmind/.gitignore` is the single thing standing between a developer's local state — their
 * request history, revert backups, credentials — and a shared commit. It had no test coverage at
 * all, which is how the duplicate-entry bug below survived.
 */
describe('ensureDevmindGitignore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-gitignore-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const read = () => fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
  const entries = () =>
    read().split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).map(l => l.trim());

  it('creates the file with every local-only entry when none exists', () => {
    const result = ensureDevmindGitignore(dir);

    expect(result.changed).toBe(true);
    expect(result.added).toEqual(DEVMIND_GITIGNORE_ENTRIES);
    expect(entries()).toEqual(DEVMIND_GITIGNORE_ENTRIES);
    // The banner explains where the block came from, so it doesn't read as mystery config.
    expect(read()).toContain('devsmind init');
  });

  it('is a no-op on a second run — the common case, since init repairs on every re-run', () => {
    ensureDevmindGitignore(dir);
    const before = read();

    const second = ensureDevmindGitignore(dir);

    expect(second.changed).toBe(false);
    expect(second.added).toEqual([]);
    expect(read()).toBe(before);
  });

  it('tops up only what is missing on a brain from an older version', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\nbrain.db\n', 'utf-8');

    const result = ensureDevmindGitignore(dir);

    expect(result.changed).toBe(true);
    expect(result.added).not.toContain('.env');
    expect(result.added).toContain('local/');
    expect(entries()).toEqual(DEVMIND_GITIGNORE_ENTRIES);
  });

  // The bug this function had: matching was raw string equality, so a hand-written `local`
  // never counted as covering `local/`, and every run appended another one underneath.
  it.each(['local', '/local', '/local/', 'local/'])(
    'treats %p as already covering the local/ directory',
    variant => {
      fs.writeFileSync(path.join(dir, '.gitignore'), `${variant}\n`, 'utf-8');

      ensureDevmindGitignore(dir);

      expect(entries().filter(l => normalizeIgnoreEntry(l) === 'local')).toEqual([variant]);
    }
  );

  it('does not duplicate entries across repeated runs on a hand-written file', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'local\n.env\n', 'utf-8');

    ensureDevmindGitignore(dir);
    ensureDevmindGitignore(dir);
    ensureDevmindGitignore(dir);

    const all = entries();
    expect(new Set(all).size).toBe(all.length);
  });

  it("preserves the user's own lines, comments and blank-line grouping", () => {
    const original = ['# my own notes', '', 'scratch/', '', '# credentials', '.env', ''].join('\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), original, 'utf-8');

    ensureDevmindGitignore(dir);

    // Appended to, never reflowed — the old version stripped every blank line on the way through.
    expect(read().startsWith(original)).toBe(true);
    expect(read()).toContain('scratch/');
    expect(entries().filter(l => l === '.env')).toHaveLength(1);
  });

  it('ignores commented-out entries rather than reading them as active', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '# local/\n', 'utf-8');

    const result = ensureDevmindGitignore(dir);

    expect(result.added).toContain('local/');
  });

  it('handles a file with no trailing newline without gluing entries together', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env', 'utf-8');

    ensureDevmindGitignore(dir);

    expect(entries()).toContain('.env');
    expect(entries()).toContain('brain.db');
    expect(read()).not.toContain('.envbrain.db');
  });

  it('rewrites an existing but empty file without a stray leading blank line', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '\n  \n', 'utf-8');

    ensureDevmindGitignore(dir);

    expect(read().startsWith('#')).toBe(true);
    expect(entries()).toEqual(DEVMIND_GITIGNORE_ENTRIES);
  });

  it('covers every local-only path the rest of the codebase writes under .devmind/', () => {
    // Guard against a new local store landing without its ignore line. `local/` covers
    // sessions, messages and feedback; the rest are named individually.
    for (const required of ['.env', 'brain.db', 'index_scratchpad.json', 'history_scratchpad.json', 'local/']) {
      expect(DEVMIND_GITIGNORE_ENTRIES).toContain(required);
    }
    // ...and must NOT ignore what the team is meant to share.
    for (const shared of ['config.json', 'graph', 'history', 'vectors', 'workflows']) {
      expect(DEVMIND_GITIGNORE_ENTRIES.map(normalizeIgnoreEntry)).not.toContain(shared);
    }
  });
});

describe('normalizeIgnoreEntry', () => {
  it('collapses the slash variants git treats identically', () => {
    for (const v of ['local', 'local/', '/local', '/local/', '  local/  ']) {
      expect(normalizeIgnoreEntry(v)).toBe('local');
    }
  });

  it('leaves unrelated lines distinguishable', () => {
    expect(normalizeIgnoreEntry('# local')).toBe('# local');
    expect(normalizeIgnoreEntry('')).toBe('');
    expect(normalizeIgnoreEntry('locale')).toBe('locale');
  });
});
