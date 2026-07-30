import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readScratchpad,
  writeScratchpad,
  createScratchpad,
  updateScratchpad,
  completeScratchpad,
  IndexScratchpad
} from '../../src/db/indexer';

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-indexer-test-'));
}

describe('indexer scratchpad lifecycle', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('readScratchpad returns null when no scratchpad file exists', () => {
    expect(readScratchpad(dir)).toBeNull();
  });

  it('readScratchpad returns null on malformed JSON rather than throwing', () => {
    fs.writeFileSync(path.join(dir, 'index_scratchpad.json'), '{not valid json');
    expect(readScratchpad(dir)).toBeNull();
  });

  it('writeScratchpad + readScratchpad round-trip an arbitrary pad', () => {
    const pad: IndexScratchpad = {
      status: 'in_progress', phase: 1, started_at: 'a', updated_at: 'a',
      files_done: 1, files_total: 2, nodes_created: 0, nodes_done: 0, nodes_total: 0,
      connections_created: 0, last_file_indexed: null, repos_done: [], current_repo: null
    };
    writeScratchpad(dir, pad);
    expect(readScratchpad(dir)).toEqual(pad);
  });

  it('supports a custom file name, independent of the default scratchpad', () => {
    const pad: IndexScratchpad = {
      status: 'complete', phase: 2, started_at: 'a', updated_at: 'a',
      files_done: 1, files_total: 1, nodes_created: 1, nodes_done: 1, nodes_total: 1,
      connections_created: 1, last_file_indexed: 'x.ts', repos_done: ['app'], current_repo: null
    };
    writeScratchpad(dir, pad, 'custom.json');
    expect(fs.existsSync(path.join(dir, 'custom.json'))).toBe(true);
    expect(readScratchpad(dir, 'custom.json')).toEqual(pad);
    expect(readScratchpad(dir)).toBeNull();
  });

  it('createScratchpad initializes a fresh in_progress pad with the given file total', () => {
    const pad = createScratchpad(dir, 5);
    expect(pad.status).toBe('in_progress');
    expect(pad.phase).toBe(1);
    expect(pad.files_total).toBe(5);
    expect(pad.files_done).toBe(0);
    expect(pad.nodes_created).toBe(0);
    expect(pad.nodes_done).toBe(0);
    expect(pad.nodes_total).toBe(0);
    expect(pad.connections_created).toBe(0);
    expect(pad.last_file_indexed).toBeNull();
    expect(pad.repos_done).toEqual([]);
    expect(pad.current_repo).toBeNull();
    expect(pad.started_at).toBeTruthy();
    expect(pad.updated_at).toBe(pad.started_at);
    expect(readScratchpad(dir)).toEqual(pad);
  });

  it('createScratchpad also accepts a custom file name', () => {
    const pad = createScratchpad(dir, 3, 'custom.json');
    expect(readScratchpad(dir, 'custom.json')).toEqual(pad);
    expect(readScratchpad(dir)).toBeNull();
  });

  it('updateScratchpad throws when no scratchpad exists yet', () => {
    expect(() => updateScratchpad(dir, { files_done: 1 })).toThrow(/No indexing session found/);
  });

  it('updateScratchpad merges a partial patch, bumps updated_at, and leaves other fields intact', async () => {
    const created = createScratchpad(dir, 10);
    await new Promise(r => setTimeout(r, 5));
    const updated = updateScratchpad(dir, { files_done: 3, current_repo: 'app', last_file_indexed: 'foo.ts' });
    expect(updated.files_done).toBe(3);
    expect(updated.current_repo).toBe('app');
    expect(updated.last_file_indexed).toBe('foo.ts');
    expect(updated.files_total).toBe(10); // untouched fields survive
    expect(updated.status).toBe('in_progress');
    expect(updated.started_at).toBe(created.started_at);
    expect(updated.updated_at).not.toBe(created.updated_at);
    expect(readScratchpad(dir)).toEqual(updated);
  });

  it('updateScratchpad can progress nodes/connections/repos_done across multiple calls', () => {
    createScratchpad(dir, 2);
    updateScratchpad(dir, { current_repo: 'app', nodes_total: 10 });
    const afterSecond = updateScratchpad(dir, { nodes_done: 5, nodes_created: 5, connections_created: 3 });
    expect(afterSecond.nodes_total).toBe(10);
    expect(afterSecond.nodes_done).toBe(5);
    expect(afterSecond.nodes_created).toBe(5);
    expect(afterSecond.connections_created).toBe(3);
    const afterRepoDone = updateScratchpad(dir, { repos_done: ['app'], current_repo: null });
    expect(afterRepoDone.repos_done).toEqual(['app']);
    expect(afterRepoDone.current_repo).toBeNull();
  });

  it('completeScratchpad throws when no scratchpad exists yet', () => {
    expect(() => completeScratchpad(dir)).toThrow(/No indexing session found/);
  });

  it('completeScratchpad flips status to complete and preserves other fields', () => {
    createScratchpad(dir, 4);
    updateScratchpad(dir, { files_done: 4, nodes_done: 8 });
    const completed = completeScratchpad(dir);
    expect(completed.status).toBe('complete');
    expect(completed.files_done).toBe(4);
    expect(completed.nodes_done).toBe(8);
    expect(readScratchpad(dir)).toEqual(completed);
  });
});
