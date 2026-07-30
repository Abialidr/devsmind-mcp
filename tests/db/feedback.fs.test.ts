import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendGraphFeedback,
  appendProductFeedback,
  readGraphFeedback,
  readProductFeedback,
  markGraphFeedbackProcessed,
  appendIndexerRuleCandidate,
  readIndexerRuleCandidates
} from '../../src/db/feedback';

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-feedback-test-'));
}

describe('graph feedback', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns an empty array before anything has been appended', () => {
    expect(readGraphFeedback(dir)).toEqual([]);
  });

  it('marks an entry confirmed when evidence is supplied', () => {
    appendGraphFeedback(dir, {
      session_id: 's1', category: 'graph_problem', text: 'edge is wrong',
      node_id: '{app}/foo.ts#greet', evidence: { file: 'foo.ts', line: 3, snippet: 'return x;' }
    });
    const entries = readGraphFeedback(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].confidence).toBe('confirmed');
    expect(entries[0].evidence).toEqual({ file: 'foo.ts', line: 3, snippet: 'return x;' });
    expect(entries[0].category).toBe('graph_problem');
    expect(entries[0].node_id).toBe('{app}/foo.ts#greet');
    expect(entries[0].id).toBeTruthy();
    expect(entries[0].ts).toBeTruthy();
    expect(entries[0].processed).toBeFalsy();
  });

  it('downgrades to suspected when no evidence is supplied, even for edge_problem', () => {
    appendGraphFeedback(dir, { session_id: 's1', category: 'edge_problem', text: 'missing edge' });
    const entries = readGraphFeedback(dir);
    expect(entries[0].confidence).toBe('suspected');
    expect(entries[0].evidence).toBeUndefined();
  });

  it('readGraphFeedback excludes processed entries by default and includes them with includeProcessed', () => {
    appendGraphFeedback(dir, { session_id: 's1', category: 'graph_problem', text: 'a' });
    appendGraphFeedback(dir, { session_id: 's1', category: 'graph_problem', text: 'b' });
    const [first] = readGraphFeedback(dir);
    markGraphFeedbackProcessed(dir, [first.id]);

    const unprocessed = readGraphFeedback(dir);
    expect(unprocessed).toHaveLength(1);
    expect(unprocessed[0].text).toBe('b');

    const all = readGraphFeedback(dir, { includeProcessed: true });
    expect(all).toHaveLength(2);
    expect(all.find(e => e.id === first.id)?.processed).toBe(true);
  });

  it('markGraphFeedbackProcessed is idempotent across repeated calls', () => {
    appendGraphFeedback(dir, { session_id: 's1', category: 'graph_problem', text: 'a' });
    const [entry] = readGraphFeedback(dir);
    markGraphFeedbackProcessed(dir, [entry.id]);
    const after1 = readGraphFeedback(dir, { includeProcessed: true });
    markGraphFeedbackProcessed(dir, [entry.id]);
    const after2 = readGraphFeedback(dir, { includeProcessed: true });
    expect(after2).toEqual(after1);
  });

  it('marking an unknown id is a no-op for that id and does not throw', () => {
    appendGraphFeedback(dir, { session_id: 's1', category: 'graph_problem', text: 'a' });
    expect(() => markGraphFeedbackProcessed(dir, ['unknown-id'])).not.toThrow();
    const entries = readGraphFeedback(dir, { includeProcessed: true });
    expect(entries[0].processed).toBeFalsy();
  });

  it('marking with an empty id list is a no-op and does not create the file', () => {
    markGraphFeedbackProcessed(dir, []);
    expect(fs.existsSync(path.join(dir, 'local', 'feedback_graph.jsonl'))).toBe(false);
  });

  it('marking ids against an existing-but-empty feedback file writes back an empty file, not a stray newline', () => {
    const target = path.join(dir, 'local', 'feedback_graph.jsonl');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '', 'utf-8');
    expect(() => markGraphFeedbackProcessed(dir, ['some-id'])).not.toThrow();
    expect(fs.readFileSync(target, 'utf-8')).toBe('');
  });

  it('skips a corrupted line rather than failing the whole read', () => {
    appendGraphFeedback(dir, { session_id: 's1', category: 'graph_problem', text: 'good' });
    const target = path.join(dir, 'local', 'feedback_graph.jsonl');
    fs.appendFileSync(target, 'not valid json\n');
    const entries = readGraphFeedback(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('good');
  });
});

describe('product feedback', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns an empty array before anything has been appended', () => {
    expect(readProductFeedback(dir)).toEqual([]);
  });

  it('round-trips each product feedback category', () => {
    appendProductFeedback(dir, { session_id: 's1', category: 'tools_used', text: 'used search_nodes a lot' });
    appendProductFeedback(dir, { session_id: 's1', category: 'dropped_and_why', text: 'dropped edit_node, too slow' });
    appendProductFeedback(dir, { session_id: 's1', category: 'devsmind_better', text: 'add bulk edit' });

    const entries = readProductFeedback(dir);
    expect(entries).toHaveLength(3);
    expect(entries.map(e => e.category)).toEqual(['tools_used', 'dropped_and_why', 'devsmind_better']);
    expect(entries.every(e => e.session_id === 's1' && !!e.ts)).toBe(true);
  });
});

describe('indexer rule candidates', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns an empty array before anything has been appended', () => {
    expect(readIndexerRuleCandidates(dir)).toEqual([]);
  });

  it('round-trips a rule candidate', () => {
    appendIndexerRuleCandidate(dir, {
      pattern: 'Vue computed() properties never get aliased',
      evidence_count: 12,
      examples: ['a.vue:10', 'b.vue:22']
    });
    const entries = readIndexerRuleCandidates(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].pattern).toBe('Vue computed() properties never get aliased');
    expect(entries[0].evidence_count).toBe(12);
    expect(entries[0].examples).toEqual(['a.vue:10', 'b.vue:22']);
    expect(entries[0].ts).toBeTruthy();
  });

  it('appends multiple candidates independently', () => {
    appendIndexerRuleCandidate(dir, { pattern: 'p1', evidence_count: 1, examples: [] });
    appendIndexerRuleCandidate(dir, { pattern: 'p2', evidence_count: 2, examples: ['x'] });
    const entries = readIndexerRuleCandidates(dir);
    expect(entries.map(e => e.pattern)).toEqual(['p1', 'p2']);
  });
});
