import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readStaged,
  readStagedFileEdits,
  stageEntry,
  stageFileEdit,
  overwriteStaged,
  clearStaged,
  removeLastStagedEntry,
  partitionStagedForSession,
  clearStagedForSession,
  StagedEntry,
  StagedFileEdit
} from '../../src/db/staging';

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-staging-test-'));
}

function entry(overrides: Partial<StagedEntry> = {}): StagedEntry {
  return {
    node_id: overrides.node_id ?? 'greet',
    file_path: overrides.file_path ?? '/repo/foo.ts',
    code_snapshot: overrides.code_snapshot ?? 'function greet() {}',
    ...overrides
  };
}

describe('staging buffer (filesystem)', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('readStaged/readStagedFileEdits return empty arrays before anything is staged', () => {
    expect(readStaged(dir)).toEqual([]);
    expect(readStagedFileEdits(dir)).toEqual([]);
  });

  it('readStaged tolerates a missing/corrupt buffer file', () => {
    fs.writeFileSync(path.join(dir, 'history_scratchpad.json'), 'not json{{{');
    expect(readStaged(dir)).toEqual([]);
    expect(readStagedFileEdits(dir)).toEqual([]);
  });

  it('readStaged tolerates VALID JSON that is missing/malformed entries, file_edits, or updated_at fields', () => {
    // Parses fine (so this bypasses the catch-block fallback above), but each field individually
    // falls back: entries/file_edits default to [] when not actually arrays, updated_at defaults
    // to "now" when falsy.
    fs.writeFileSync(path.join(dir, 'history_scratchpad.json'), JSON.stringify({ entries: 'not-an-array', file_edits: null }));
    expect(readStaged(dir)).toEqual([]);
    expect(readStagedFileEdits(dir)).toEqual([]);
  });

  it('stageEntry appends an entry, stamps staged_at, and returns the new pending count', () => {
    const count1 = stageEntry(dir, entry({ node_id: 'a' }));
    expect(count1).toBe(1);
    const count2 = stageEntry(dir, entry({ node_id: 'b' }));
    expect(count2).toBe(2);

    const staged = readStaged(dir);
    expect(staged).toHaveLength(2);
    expect(staged[0].node_id).toBe('a');
    expect(staged[0].staged_at).toBeTruthy();
    expect(staged[1].node_id).toBe('b');
  });

  it('stageEntry preserves an explicit staged_at rather than overwriting it', () => {
    stageEntry(dir, entry({ node_id: 'a', staged_at: '2020-01-01T00:00:00.000Z' }));
    expect(readStaged(dir)[0].staged_at).toBe('2020-01-01T00:00:00.000Z');
  });

  it('stageFileEdit appends a whole-file edit, stamps staged_at, and returns the new pending count', () => {
    const fileEdit: StagedFileEdit = { file_path: '/repo/style.css', before: 'a', after: 'b' };
    const count1 = stageFileEdit(dir, fileEdit);
    expect(count1).toBe(1);
    const count2 = stageFileEdit(dir, { file_path: '/repo/other.css', before: 'x', after: 'y' });
    expect(count2).toBe(2);

    const staged = readStagedFileEdits(dir);
    expect(staged).toHaveLength(2);
    expect(staged[0].staged_at).toBeTruthy();
    expect(staged[0].file_path).toBe('/repo/style.css');
  });

  it('staged entries and file_edits are independent buffers', () => {
    stageEntry(dir, entry());
    stageFileEdit(dir, { file_path: '/repo/x.css', before: '', after: 'x' });
    expect(readStaged(dir)).toHaveLength(1);
    expect(readStagedFileEdits(dir)).toHaveLength(1);
  });

  it('overwriteStaged replaces entries wholesale but leaves file_edits untouched', () => {
    stageEntry(dir, entry({ node_id: 'a' }));
    stageFileEdit(dir, { file_path: '/repo/x.css', before: '', after: 'x' });

    overwriteStaged(dir, [entry({ node_id: 'z', description: 'now described' })]);

    const staged = readStaged(dir);
    expect(staged).toHaveLength(1);
    expect(staged[0].node_id).toBe('z');
    expect(staged[0].description).toBe('now described');
    expect(readStagedFileEdits(dir)).toHaveLength(1);
  });

  it('clearStaged removes the buffer file entirely', () => {
    stageEntry(dir, entry());
    clearStaged(dir);
    expect(readStaged(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'history_scratchpad.json'))).toBe(false);
  });

  it('clearStaged is a no-op when there is nothing to clear', () => {
    expect(() => clearStaged(dir)).not.toThrow();
  });

  it('removeLastStagedEntry returns null when the node has nothing staged', () => {
    stageEntry(dir, entry({ node_id: 'a' }));
    expect(removeLastStagedEntry(dir, 'does-not-exist')).toBeNull();
    expect(readStaged(dir)).toHaveLength(1);
  });

  it('removeLastStagedEntry drops only the newest entry for that node', () => {
    stageEntry(dir, entry({ node_id: 'a', code_snapshot: 'v1' }));
    stageEntry(dir, entry({ node_id: 'b', code_snapshot: 'v1' }));
    stageEntry(dir, entry({ node_id: 'a', code_snapshot: 'v2' }));

    const removed = removeLastStagedEntry(dir, 'a');
    expect(removed?.code_snapshot).toBe('v2');

    const remaining = readStaged(dir);
    expect(remaining.map(e => `${e.node_id}:${e.code_snapshot}`)).toEqual(['a:v1', 'b:v1']);
  });

  it('removeLastStagedEntry clears the whole buffer file when nothing else remains staged', () => {
    stageEntry(dir, entry({ node_id: 'only' }));
    const removed = removeLastStagedEntry(dir, 'only');
    expect(removed?.node_id).toBe('only');
    expect(fs.existsSync(path.join(dir, 'history_scratchpad.json'))).toBe(false);
    expect(readStaged(dir)).toEqual([]);
  });

  it('removeLastStagedEntry keeps the buffer file when file_edits still remain', () => {
    stageEntry(dir, entry({ node_id: 'only' }));
    stageFileEdit(dir, { file_path: '/repo/x.css', before: '', after: 'x' });
    removeLastStagedEntry(dir, 'only');
    expect(fs.existsSync(path.join(dir, 'history_scratchpad.json'))).toBe(true);
    expect(readStaged(dir)).toEqual([]);
    expect(readStagedFileEdits(dir)).toHaveLength(1);
  });

  describe('multi-session isolation (partitionStagedForSession / clearStagedForSession)', () => {
    it('partitionStagedForSession only returns entries/file_edits stamped with the caller\'s session_id', () => {
      stageEntry(dir, entry({ node_id: 'mine', session_id: 'session-A' }));
      stageEntry(dir, entry({ node_id: 'theirs', session_id: 'session-B' }));
      stageFileEdit(dir, { file_path: '/repo/mine.css', before: '', after: 'a', session_id: 'session-A' });
      stageFileEdit(dir, { file_path: '/repo/theirs.css', before: '', after: 'b', session_id: 'session-B' });

      const partition = partitionStagedForSession(dir, 'session-A');
      expect(partition.entries.map(e => e.node_id)).toEqual(['mine']);
      expect(partition.fileEdits.map(e => e.file_path)).toEqual(['/repo/mine.css']);
      expect(partition.otherSessionsPending).toBe(2);
    });

    it('treats entries with no session_id (pre-existing buffers) as claimable by any session, not stranded forever', () => {
      stageEntry(dir, entry({ node_id: 'legacy' })); // no session_id at all
      const partition = partitionStagedForSession(dir, 'session-A');
      expect(partition.entries.map(e => e.node_id)).toEqual(['legacy']);
      expect(partition.otherSessionsPending).toBe(0);
    });

    it('clearStagedForSession removes only the caller\'s entries, leaving another session\'s work staged', () => {
      stageEntry(dir, entry({ node_id: 'mine', session_id: 'session-A' }));
      stageEntry(dir, entry({ node_id: 'theirs', session_id: 'session-B' }));

      clearStagedForSession(dir, 'session-A');

      const remaining = readStaged(dir);
      expect(remaining.map(e => e.node_id)).toEqual(['theirs']);
    });

    it('clearStagedForSession removes only the caller\'s file edits, leaving another session\'s staged', () => {
      // The entries and file_edits lists are filtered independently, so scoping one correctly
      // says nothing about the other — an unscoped file_edits wipe would silently discard
      // another session's pending edit to a file it had already staged.
      stageFileEdit(dir, { file_path: '/repo/mine.css', before: '', after: 'a', session_id: 'session-A' });
      stageFileEdit(dir, { file_path: '/repo/theirs.css', before: '', after: 'b', session_id: 'session-B' });

      clearStagedForSession(dir, 'session-A');

      expect(readStagedFileEdits(dir).map(e => e.file_path)).toEqual(['/repo/theirs.css']);
    });

    it('clearStagedForSession deletes the buffer file entirely once no other session has anything left', () => {
      stageEntry(dir, entry({ node_id: 'only', session_id: 'session-A' }));
      clearStagedForSession(dir, 'session-A');
      expect(fs.existsSync(path.join(dir, 'history_scratchpad.json'))).toBe(false);
      expect(readStaged(dir)).toEqual([]);
    });
  });
});
