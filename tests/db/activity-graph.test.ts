import * as fs from 'fs';
import * as path from 'path';
import { makeFixture, stageAndCommit, repoFile, Fixture } from '../helpers/fixture';
import { DevMindDatabase, parseReasoningBlocksTimed, formatReasoning, ReasoningObject } from '../../src/db/database';
import { createSession, recordMessage } from '../../src/db/activity';
import { queryGraphActivityLog, resolveActivityLog, GRAPH_SOURCE_CAVEATS } from '../../src/db/activity-graph';

/** Path comparison that survives Windows drive-letter canonicalization. */
const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** Commits `greet` and `format` under one reasoning object — the two-node commit shape the
 * grouping rule has to collapse back into a single entry. */
async function commitTwoNodes(fx: Fixture, sessionId: string, reasoning: ReasoningObject) {
  return stageAndCommit(fx, [
    {
      node_id: '{app}/foo.ts#greet',
      file_path: repoFile(fx, 'foo.ts'),
      code_snapshot: 'export function greet() { return 1; }',
      code_before: 'export function greet() { return 0; }',
      name: 'greet', type: 'function', description: 'Greets a caller by name.',
      session_id: sessionId
    },
    {
      node_id: '{app}/bar.ts#format',
      file_path: repoFile(fx, 'bar.ts'),
      code_snapshot: 'export function format() { return "b"; }',
      code_before: 'export function format() { return "a"; }',
      name: 'format', type: 'function', description: 'Formats a string for display.',
      session_id: sessionId
    }
  ], reasoning);
}

interface SeedRow {
  id: string;
  node_id: string;
  session_id: string;
  created_at: string;
  updated_at: string;
  /** Already-formatted blob, separators and all — exactly what lands on disk. */
  reasoning: string;
  file_path?: string;
  /** Omit `node_metadata`, so syncFromDisk cannot backfill a node row. Reproduces a history entry
   * whose node is absent from the graph — the LEFT JOIN's null `file_path` case. */
  withoutNodeMetadata?: boolean;
}

/**
 * Writes history JSON straight into `.devmind/history/` and re-opens the brain so `syncFromDisk`
 * ingests it — precisely what happens to a teammate after `git pull`. Lets a test pin timestamps
 * and session ids that a live commit would stamp with the wall clock.
 */
function seedPulledHistory(fx: Fixture, rows: SeedRow[]): void {
  const dir = path.join(fx.devmindPath, 'history');
  fs.mkdirSync(dir, { recursive: true });
  for (const r of rows) {
    fs.writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify({
      id: r.id,
      node_id: r.node_id,
      node_metadata: r.withoutNodeMetadata ? null : {
        name: r.node_id.split('#').pop(),
        type: 'function',
        file_path: r.file_path ?? '{app}/foo.ts',
        signature: null
      },
      session_id: r.session_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      code_snapshot: '',
      reasoning: r.reasoning,
      edits: []
    }, null, 2));
  }
  fx.db.close();
  fx.db = new DevMindDatabase(path.join(fx.devmindPath, 'brain.db'));
}

/** A formatted reasoning blob with each block dated, mimicking updateHistory's 1-hour merge. */
function mergedReasoning(blocks: { reasoning: ReasoningObject; at?: string }[]): string {
  return blocks
    .map((b, i) => (i === 0 ? '' : `\n\n── Update @ ${b.at} ──\n`) + formatReasoning(b.reasoning))
    .join('');
}

describe('parseReasoningBlocksTimed', () => {
  it('dates a single unmerged block from the row created_at', () => {
    const raw = formatReasoning({ what_changed: 'did a thing', why: 'because', goal: 'ship' });
    const blocks = parseReasoningBlocksTimed(raw, '2026-01-01T00:00:00.000Z');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].at).toBe('2026-01-01T00:00:00.000Z');
    expect(blocks[0].parsed.what_changed).toBe('did a thing');
  });

  it('reads each merged block\'s own timestamp off its separator, oldest first', () => {
    const raw = mergedReasoning([
      { reasoning: { what_changed: 'first', why: 'w1', goal: 'g1' } },
      { reasoning: { what_changed: 'second', why: 'w2', goal: 'g2' }, at: '2026-01-01T05:00:00.000Z' }
    ]);
    const blocks = parseReasoningBlocksTimed(raw, '2026-01-01T00:00:00.000Z');
    expect(blocks.map(b => b.parsed.what_changed)).toEqual(['first', 'second']);
    expect(blocks.map(b => b.at)).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T05:00:00.000Z']);
  });

  it('carries the Developer and Requirement fields through', () => {
    const raw = formatReasoning({
      what_changed: 'x', why: 'y', goal: 'z', requirement: 'TICKET-9', developer: 'Grace'
    });
    const [block] = parseReasoningBlocksTimed(raw, '2026-01-01T00:00:00.000Z');
    expect(block.parsed.developer).toBe('Grace');
    expect(block.parsed.requirement).toBe('TICKET-9');
  });

  it('keeps unlabelled free-text reasoning rather than dropping it', () => {
    const blocks = parseReasoningBlocksTimed('just a bare string', '2026-01-01T00:00:00.000Z');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parsed.what_changed).toBe('just a bare string');
  });

  it('returns nothing for empty or non-string input', () => {
    expect(parseReasoningBlocksTimed('', '2026-01-01T00:00:00.000Z')).toEqual([]);
    expect(parseReasoningBlocksTimed(null as any, '2026-01-01T00:00:00.000Z')).toEqual([]);
  });
});

describe('queryGraphActivityLog — reconstructing live commits', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  // `seedPulledHistory` swaps in a fresh DevMindDatabase; the fixture's own cleanup closes the
  // handle it captured at construction, so close the current one here or Windows keeps the file
  // locked against rmSync.
  afterEach(() => { try { fx.db.close(); } catch { /* already closed */ } fx.cleanup(); });

  it('collapses one commit spanning two nodes into a single entry', async () => {
    await commitTwoNodes(fx, 'sess-a', {
      what_changed: 'renamed the greeting', why: 'clarity', goal: 'readability',
      requirement: 'TICKET-42', developer: 'Ada'
    });

    const { result } = queryGraphActivityLog(fx.db);
    expect(result.entries).toHaveLength(1);

    const entry = result.entries[0];
    expect(entry.source).toBe('graph');
    expect(entry.session_id).toBe('sess-a');
    expect(entry.developer).toBe('Ada');
    expect(entry.summary).toBe('renamed the greeting');
    // The shared record has no verbatim request; Requirement is the documented substitute.
    expect(entry.request).toBe('TICKET-42');
    expect(entry.status).toBe('applied');
    expect(entry.node_ids.sort()).toEqual(['{app}/bar.ts#format', '{app}/foo.ts#greet']);
    expect(entry.edit_count).toBe(2);
    expect(entry.files.map(norm).sort())
      .toEqual([repoFile(fx, 'bar.ts'), repoFile(fx, 'foo.ts')].map(norm).sort());
    expect(result.all_files).toHaveLength(2);
  });

  it('separates two same-session commits that merged into one history row', async () => {
    // Both land inside the 1-hour window, so updateHistory appends the second under a separator
    // rather than inserting a new row — the case a row-per-commit reading would lose entirely.
    await commitTwoNodes(fx, 'sess-a', { what_changed: 'first pass', why: 'w', goal: 'g' });
    await commitTwoNodes(fx, 'sess-a', { what_changed: 'second pass', why: 'w', goal: 'g' });

    const { result } = queryGraphActivityLog(fx.db);
    expect(result.entries.map(e => e.summary).sort()).toEqual(['first pass', 'second pass']);
    // Each still reports both nodes — the split is per block, not per row.
    expect(result.entries.every(e => e.node_ids.length === 2)).toBe(true);
  });

  it('gives an id that is stable across calls and distinct per commit', async () => {
    await commitTwoNodes(fx, 'sess-a', { what_changed: 'change one', why: 'w', goal: 'g' });
    await commitTwoNodes(fx, 'sess-a', { what_changed: 'change two', why: 'w', goal: 'g' });

    const first = queryGraphActivityLog(fx.db).result.entries;
    const second = queryGraphActivityLog(fx.db).result.entries;
    expect(first.map(e => e.id)).toEqual(second.map(e => e.id));
    expect(new Set(first.map(e => e.id)).size).toBe(2);
    expect(first.every(e => e.id.startsWith('graph:'))).toBe(true);
  });

  it('filters by developer and requirement text', async () => {
    await commitTwoNodes(fx, 'sess-a', { what_changed: 'ada work', why: 'w', goal: 'g', requirement: 'TICKET-1', developer: 'Ada' });
    await commitTwoNodes(fx, 'sess-a', { what_changed: 'grace work', why: 'w', goal: 'g', requirement: 'TICKET-2', developer: 'Grace' });

    expect(queryGraphActivityLog(fx.db, { developer: 'ada' }).result.entries.map(e => e.summary)).toEqual(['ada work']);
    expect(queryGraphActivityLog(fx.db, { requirementContains: 'ticket-2' }).result.entries.map(e => e.summary)).toEqual(['grace work']);
  });

  it('reports the pre-limit match count so a capped page is detectable', async () => {
    await commitTwoNodes(fx, 'sess-a', { what_changed: 'one', why: 'w', goal: 'g' });
    await commitTwoNodes(fx, 'sess-a', { what_changed: 'two', why: 'w', goal: 'g' });
    await commitTwoNodes(fx, 'sess-a', { what_changed: 'three', why: 'w', goal: 'g' });

    const { result } = queryGraphActivityLog(fx.db, { limit: 1 });
    expect(result.total_messages).toBe(1);
    expect(result.total_matched).toBe(3);
  });

  it('excludes blocks outside an explicit time window', async () => {
    await commitTwoNodes(fx, 'sess-a', { what_changed: 'recent', why: 'w', goal: 'g' });

    expect(queryGraphActivityLog(fx.db, { sinceHours: 24 }).result.entries).toHaveLength(1);
    // A window that closed before the commit was made.
    expect(queryGraphActivityLog(fx.db, { until: '2020-01-01T00:00:00.000Z' }).result.entries).toHaveLength(0);
  });

  it('is empty, not broken, on a brain with no history', () => {
    const { result } = queryGraphActivityLog(fx.db);
    expect(result).toEqual({ total_messages: 0, total_matched: 0, all_files: [], entries: [] });
  });
});

describe('queryGraphActivityLog — history pulled from teammates', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  // `seedPulledHistory` swaps in a fresh DevMindDatabase; the fixture's own cleanup closes the
  // handle it captured at construction, so close the current one here or Windows keeps the file
  // locked against rmSync.
  afterEach(() => { try { fx.db.close(); } catch { /* already closed */ } fx.cleanup(); });

  it('splits a repeat of identical reasoning that is far apart in time', () => {
    // One row, one reasoning text, written twice five hours apart. Text alone would fuse these
    // into a single entry spanning the whole day; the cluster gap is what separates them.
    const reasoning = { what_changed: 'ran the codemod', why: 'w', goal: 'g' };
    seedPulledHistory(fx, [{
      id: 'h1', node_id: '{app}/foo.ts#greet', session_id: 'sess-x',
      created_at: '2026-03-01T09:00:00.000Z', updated_at: '2026-03-01T14:00:00.000Z',
      reasoning: mergedReasoning([{ reasoning }, { reasoning, at: '2026-03-01T14:00:00.000Z' }])
    }]);

    const { result } = queryGraphActivityLog(fx.db);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map(e => e.created_at))
      .toEqual(['2026-03-01T14:00:00.000Z', '2026-03-01T09:00:00.000Z']);
    expect(new Set(result.entries.map(e => e.id)).size).toBe(2);
  });

  it('keeps one commit together across nodes stamped moments apart', () => {
    const reasoning = formatReasoning({ what_changed: 'one commit, two nodes', why: 'w', goal: 'g' });
    seedPulledHistory(fx, [
      { id: 'h1', node_id: '{app}/foo.ts#greet', session_id: 'sess-x', created_at: '2026-03-01T09:00:00.000Z', updated_at: '2026-03-01T09:00:00.000Z', reasoning, file_path: '{app}/foo.ts' },
      // A different session id on the second node — exactly what the 1-hour merge produces when
      // that node's row was created by an earlier session. Must NOT split the commit.
      { id: 'h2', node_id: '{app}/bar.ts#format', session_id: 'sess-older', created_at: '2026-03-01T09:00:00.400Z', updated_at: '2026-03-01T09:00:00.400Z', reasoning, file_path: '{app}/bar.ts' }
    ]);

    const { result } = queryGraphActivityLog(fx.db);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].node_ids.sort()).toEqual(['{app}/bar.ts#format', '{app}/foo.ts#greet']);
    expect(result.entries[0].session_ids).toEqual(['sess-x', 'sess-older']);
    expect(result.entries[0].session_id).toBe('sess-x');
  });

  it('restricts to one session when asked', () => {
    seedPulledHistory(fx, [
      { id: 'h1', node_id: '{app}/foo.ts#greet', session_id: 'sess-x', created_at: '2026-03-01T09:00:00.000Z', updated_at: '2026-03-01T09:00:00.000Z', reasoning: formatReasoning({ what_changed: 'x work', why: 'w', goal: 'g' }) },
      { id: 'h2', node_id: '{app}/bar.ts#format', session_id: 'sess-y', created_at: '2026-03-02T09:00:00.000Z', updated_at: '2026-03-02T09:00:00.000Z', reasoning: formatReasoning({ what_changed: 'y work', why: 'w', goal: 'g' }), file_path: '{app}/bar.ts' }
    ]);

    expect(queryGraphActivityLog(fx.db, { sessionId: 'sess-y' }).result.entries.map(e => e.summary)).toEqual(['y work']);
  });

  it('keeps an in-window block appended to a row that started out of window', () => {
    // The row's created_at predates `since`; only its second block is in range. A SQL-only
    // `created_at >= since` filter would drop the whole row and lose that block.
    seedPulledHistory(fx, [{
      id: 'h1', node_id: '{app}/foo.ts#greet', session_id: 'sess-x',
      created_at: '2026-03-01T09:00:00.000Z', updated_at: '2026-03-01T09:40:00.000Z',
      reasoning: mergedReasoning([
        { reasoning: { what_changed: 'too old', why: 'w', goal: 'g' } },
        { reasoning: { what_changed: 'in window', why: 'w', goal: 'g' }, at: '2026-03-01T09:40:00.000Z' }
      ])
    }]);

    const { result } = queryGraphActivityLog(fx.db, { since: '2026-03-01T09:30:00.000Z' });
    expect(result.entries.map(e => e.summary)).toEqual(['in window']);
  });

  it('still counts an edit whose node is missing, without inventing a path', () => {
    seedPulledHistory(fx, [{
      id: 'h1', node_id: '{app}/gone.ts#vanished', session_id: 'sess-x',
      created_at: '2026-03-01T09:00:00.000Z', updated_at: '2026-03-01T09:00:00.000Z',
      reasoning: formatReasoning({ what_changed: 'touched a node the graph lost', why: 'w', goal: 'g' }),
      withoutNodeMetadata: true
    }]);

    const { result } = queryGraphActivityLog(fx.db);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].files).toEqual([]);
    expect(result.entries[0].node_ids).toEqual(['{app}/gone.ts#vanished']);
    // The edit is still real — only the file it landed in is unknowable.
    expect(result.entries[0].edit_count).toBe(1);
  });
});

describe('resolveActivityLog', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  // `seedPulledHistory` swaps in a fresh DevMindDatabase; the fixture's own cleanup closes the
  // handle it captured at construction, so close the current one here or Windows keeps the file
  // locked against rmSync.
  afterEach(() => { try { fx.db.close(); } catch { /* already closed */ } fx.cleanup(); });

  /** A local message for `sessionId`, as commit_changes would have written on this machine. */
  function recordLocal(sessionId: string, summary: string) {
    createSession(fx.devmindPath, sessionId, 'Ada');
    return recordMessage(fx.devmindPath, {
      session_id: sessionId,
      developer: 'Ada',
      request: 'the verbatim ask',
      summary,
      edits: [{
        id: `edit-${summary}`, node_id: '{app}/foo.ts#greet', file_path: repoFile(fx, 'foo.ts'),
        at: new Date().toISOString(), before: 'a', after: 'b'
      }]
    });
  }

  /** Shared history for a session that never ran on this machine. */
  function seedForeign(sessionId: string, summary: string, developer = 'Grace') {
    seedPulledHistory(fx, [{
      id: `h-${sessionId}`, node_id: '{app}/bar.ts#format', session_id: sessionId,
      created_at: '2026-03-01T09:00:00.000Z', updated_at: '2026-03-01T09:00:00.000Z',
      reasoning: formatReasoning({ what_changed: summary, why: 'w', goal: 'g', developer }),
      file_path: '{app}/bar.ts'
    }]);
  }

  it('auto falls back to graph history when the local log is empty', () => {
    seedForeign('sess-teammate', 'pulled work');

    const result = resolveActivityLog(fx.db, fx.devmindPath, 'auto');
    expect(result.source).toBe('graph');
    expect(result.fell_back).toBe(true);
    expect(result.entries.map(e => e.summary)).toEqual(['pulled work']);
    expect(result.caveats).toEqual(GRAPH_SOURCE_CAVEATS);
  });

  it('auto stays local when the local log has anything', () => {
    seedForeign('sess-teammate', 'pulled work');
    recordLocal('sess-mine', 'my work');

    const result = resolveActivityLog(fx.db, fx.devmindPath, 'auto');
    expect(result.source).toBe('local');
    expect(result.fell_back).toBe(false);
    expect(result.entries.map(e => e.summary)).toEqual(['my work']);
    expect(result.caveats).toBeUndefined();
  });

  it('auto still reports an empty result when neither store has anything', () => {
    const result = resolveActivityLog(fx.db, fx.devmindPath, 'auto');
    expect(result.entries).toEqual([]);
    expect(result.source).toBe('graph');
    expect(result.fell_back).toBe(true);
  });

  it('local never falls back, even with graph history available', () => {
    seedForeign('sess-teammate', 'pulled work');

    const result = resolveActivityLog(fx.db, fx.devmindPath, 'local');
    expect(result.source).toBe('local');
    expect(result.entries).toEqual([]);
    expect(result.caveats).toBeUndefined();
  });

  it('both merges local entries with foreign ones and drops the local twin', async () => {
    seedForeign('sess-teammate', 'teammate work');
    // `sess-mine` in BOTH stores — the duplicate the merge has to suppress.
    await commitTwoNodes(fx, 'sess-mine', { what_changed: 'my work (graph copy)', why: 'w', goal: 'g' });
    recordLocal('sess-mine', 'my work');

    const result = resolveActivityLog(fx.db, fx.devmindPath, 'both');
    expect(result.source).toBe('both');
    expect(result.entries.map(e => e.summary).sort()).toEqual(['my work', 'teammate work']);
    expect(result.entries.find(e => e.summary === 'my work')!.source).toBe('local');
    expect(result.entries.find(e => e.summary === 'teammate work')!.source).toBe('graph');
    expect(result.caveats).toEqual(GRAPH_SOURCE_CAVEATS);
  });

  it('both keeps a teammate\'s block that the merge filed under a local session id', () => {
    // The 1-hour merge stamps a pulled block with the row's ORIGINAL session — here, one of mine.
    // Session id alone would call this my own work and hide it; the Developer field is per-block
    // and still says otherwise.
    createSession(fx.devmindPath, 'sess-mine', 'Ada');
    seedPulledHistory(fx, [{
      id: 'h-merged', node_id: '{app}/bar.ts#format', session_id: 'sess-mine',
      created_at: '2026-03-01T09:00:00.000Z', updated_at: '2026-03-01T09:00:00.000Z',
      reasoning: formatReasoning({ what_changed: 'grace work', why: 'w', goal: 'g', developer: 'Grace' }),
      file_path: '{app}/bar.ts'
    }]);

    const result = resolveActivityLog(fx.db, fx.devmindPath, 'both');
    expect(result.entries.map(e => e.summary)).toEqual(['grace work']);
  });

  it('both suppresses the twin even when a filter hides the local entry', async () => {
    await commitTwoNodes(fx, 'sess-mine', { what_changed: 'my work (graph copy)', why: 'w', goal: 'g' });
    recordLocal('sess-mine', 'my work');

    // `requirement_contains` matches neither entry, so the local one cannot shadow its graph twin
    // by being present in the results — dedup is against sessions.json, not the filtered page.
    const result = resolveActivityLog(fx.db, fx.devmindPath, 'both', { requirementContains: 'nothing-matches-this' });
    expect(result.entries).toEqual([]);
  });

  it('both drops a graph twin attributed to the configured local developer', () => {
    fx.cleanup();
    fx = makeFixture({ env: { DEVELOPER_NAME: 'Ada' } });
    createSession(fx.devmindPath, 'sess-mine', 'Ada');
    seedPulledHistory(fx, [
      {
        id: 'h-mine', node_id: '{app}/foo.ts#greet', session_id: 'sess-mine',
        created_at: '2026-03-01T09:00:00.000Z', updated_at: '2026-03-01T09:00:00.000Z',
        reasoning: formatReasoning({ what_changed: 'ada work', why: 'w', goal: 'g', developer: 'Ada' })
      },
      {
        id: 'h-theirs', node_id: '{app}/bar.ts#format', session_id: 'sess-mine',
        created_at: '2026-03-02T09:00:00.000Z', updated_at: '2026-03-02T09:00:00.000Z',
        reasoning: formatReasoning({ what_changed: 'grace work', why: 'w', goal: 'g', developer: 'Grace' }),
        file_path: '{app}/bar.ts'
      }
    ]);

    // Same local session on both rows; only the Developer field tells them apart.
    const result = resolveActivityLog(fx.db, fx.devmindPath, 'both');
    expect(result.entries.map(e => e.summary)).toEqual(['grace work']);
  });

  it('both carries no caveats when nothing graph-derived survived', () => {
    recordLocal('sess-mine', 'my work');
    const result = resolveActivityLog(fx.db, fx.devmindPath, 'both');
    expect(result.entries.map(e => e.source)).toEqual(['local']);
    expect(result.caveats).toBeUndefined();
  });
});
