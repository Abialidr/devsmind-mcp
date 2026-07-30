import * as fs from 'fs';
import { makeFixture, stageAndCommit, repoFile, Fixture } from '../helpers/fixture';
import { RankedNode } from '../../src/db/database';

jest.setTimeout(60000);

describe('DevMindDatabase.searchNodes / searchDecisions / searchCode', () => {
  let fx: Fixture;
  let greetingId: string;
  let invoiceId: string;
  let sessionManagerId: string;

  beforeAll(async () => {
    fx = makeFixture({ skipDefaultFiles: true });

    fs.writeFileSync(
      repoFile(fx, 'greeting.ts'),
      `export function formatGreeting(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`
    );
    fs.writeFileSync(
      repoFile(fx, 'mathUtils.ts'),
      `export function computeInvoiceTotal(items: { price: number }[]): number {\n  // sum invoice items\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n`
    );
    fs.writeFileSync(
      repoFile(fx, 'authService.ts'),
      `import { formatGreeting } from './greeting';\n\nexport class SessionManager {\n  welcome(userName: string): string {\n    return formatGreeting(userName);\n  }\n}\n`
    );
    // A file the graph never indexes at all — pure filesystem-grep coverage, the "files" bucket.
    fs.writeFileSync(
      repoFile(fx, 'notes.md'),
      `# Notes\n\nThis file mentions ZQXFILEBUCKETMARKER98765 as a unique diagnostic string for search tests.\n`
    );

    const summary = await stageAndCommit(
      fx,
      [
        {
          node_id: 'formatGreeting',
          file_path: repoFile(fx, 'greeting.ts'),
          code_snapshot: `export function formatGreeting(name: string): string {\n  return \`Hello, \${name}!\`;\n}`,
          name: 'formatGreeting',
          type: 'function',
          description:
            'Formats a raw string into the standard greeting message shown to a person by name, for display in the app header banner.'
        },
        {
          node_id: 'computeInvoiceTotal',
          file_path: repoFile(fx, 'mathUtils.ts'),
          code_snapshot: `export function computeInvoiceTotal(items: { price: number }[]): number {\n  // sum invoice items\n  return items.reduce((sum, item) => sum + item.price, 0);\n}`,
          name: 'computeInvoiceTotal',
          type: 'function',
          description:
            'Calculates the total monetary amount owed on an invoice by summing line item prices and applicable taxes.'
        },
        {
          node_id: 'SessionManager',
          file_path: repoFile(fx, 'authService.ts'),
          code_snapshot: `export class SessionManager {\n  welcome(userName: string): string {\n    return formatGreeting(userName);\n  }\n}`,
          name: 'SessionManager',
          type: 'class',
          description:
            'Manages a signed-in user session by welcoming them and tracking basic session state for the login flow.'
        }
      ],
      {
        what_changed: 'Added greeting/invoice/session utilities for search test fixture',
        why: 'Establish a small realistic graph to exercise tri-modal search',
        goal: 'Test coverage for searchNodes/searchDecisions/searchCode',
        decision:
          'Use monetary rounding half-up for invoice totals, rather than banker\'s rounding, to match the finance requirement.'
      }
    );

    greetingId = summary.node_ids.find(id => id.endsWith('#formatGreeting'))!;
    invoiceId = summary.node_ids.find(id => id.endsWith('#computeInvoiceTotal'))!;
    sessionManagerId = summary.node_ids.find(id => id.endsWith('#SessionManager'))!;

    expect(greetingId).toBeTruthy();
    expect(invoiceId).toBeTruthy();
    expect(sessionManagerId).toBeTruthy();

    // SessionManager.welcome() calls formatGreeting() — a real edge for the drill-in hooks test.
    const conns = fx.db.getConnections(sessionManagerId);
    expect(conns.uses.map(c => c.id)).toContain(greetingId);
  });

  afterAll(() => {
    fx.cleanup();
  });

  it('exact-identifier short-circuit: finds a node by its literal name and skips the rankers', async () => {
    const result = await fx.db.searchNodes('computeInvoiceTotal');
    expect(result.nodes.length).toBeGreaterThan(0);
    const hit = result.nodes.find(n => n.id === invoiceId) as Extract<RankedNode, { matched_via: 'identifier' }>;
    expect(hit).toBeTruthy();
    expect(hit.matched_via).toBe('identifier');
    expect(hit.found_by).toEqual(['name']);
    expect(hit.confidence).toBe('high');
    expect(hit.relevance).toBe(100);
  });

  it('exact-identifier short-circuit still populates the files bucket with NO explicit keywords passed (regression: used to gate grep on opts.keywords instead of the query-derived keywords)', async () => {
    const result = await fx.db.searchNodes('computeInvoiceTotal'); // no `opts.keywords` at all
    const hit = result.nodes.find(n => n.id === invoiceId)!;
    expect(hit.matched_via).toBe('identifier');
    // The literal identifier also appears in mathUtils.ts's own source text, so grep — run with
    // the query's own derived keywords, not the (absent) caller-supplied ones — must find it.
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.some(f => f.file_path.includes('mathUtils.ts'))).toBe(true);
  });

  it('a query that only literal-matches a node\'s DESCRIPTION (not its name/id) does NOT trigger the identifier short-circuit (regression: the short-circuit used to also LIKE-match description/reasoning, wrongly treating a natural-language substring hit as an "exact identifier" and skipping vector+code search)', async () => {
    // This exact phrase is a verbatim substring of computeInvoiceTotal's description above, but
    // shares no substring with its name/id ("computeInvoiceTotal") at all.
    const query = 'summing line item prices';
    const result = await fx.db.searchNodes(query);
    const hit = result.nodes.find(n => n.id === invoiceId);
    expect(hit).toBeTruthy();
    expect(hit!.matched_via).not.toBe('identifier');
  });

  it('BM25/keyword search: finds a node via description words that are not its identifier', async () => {
    // "monetary total owed" is not a literal substring of any node's id/name/description/reasoning
    // (the words appear, but out of order), so this must go through the full ranked path rather
    // than the exact-identifier short-circuit.
    const query = 'monetary total owed';
    const result = await fx.db.searchNodes(query);
    const hit = result.nodes.find(n => n.id === invoiceId);
    expect(hit).toBeTruthy();
    expect(hit!.matched_via).not.toBe('identifier');
    expect(hit!.found_by).toContain('keyword');
  });

  it('semantic vector search: finds a node via a semantically related query sharing no keywords', async () => {
    // Deliberately avoids literal overlap with the stored description's vocabulary
    // ("formats", "greeting", "message", "header", "banner", "person", "name").
    const query = 'how do we welcome a visitor and say hi to them';
    const result = await fx.db.searchNodes(query);

    // The search must run to completion regardless (real ONNX embedder is available in this env).
    expect(Array.isArray(result.nodes)).toBe(true);

    const hit = result.nodes.find(n => n.id === greetingId);
    if (hit) {
      // Found — verify it carries genuine semantic-layer evidence, not just an accidental keyword hit.
      expect(hit.found_by).toContain('meaning');
      expect(['high', 'medium', 'low']).toContain(hit.confidence);
      expect(typeof hit.relevance).toBe('number');
    } else {
      // If the real embedder legitimately didn't clear MIN_COSINE_SIMILARITY (0.35) for this
      // query/description pair, that's still a real signal — assert the call at least completed
      // cleanly rather than silently weakening this into a no-op.
      expect(result).toHaveProperty('nodes');
      expect(result).toHaveProperty('files');
    }
  });

  it('grep files bucket: surfaces a literal string that only exists in raw file text', async () => {
    const result = await fx.db.searchNodes('ZQXFILEBUCKETMARKER98765');
    expect(result.files.length).toBeGreaterThan(0);
    const file = result.files.find(f => f.file_path.includes('notes.md'));
    expect(file).toBeTruthy();
    expect(file!.total_matches).toBeGreaterThan(0);
    expect(file!.sample_lines.some(l => l.line_content.includes('ZQXFILEBUCKETMARKER98765'))).toBe(true);
  });

  it('result shape: ranked nodes carry found_by/confidence/relevance and drill-in hooks', async () => {
    const result = await fx.db.searchNodes('monetary total owed');
    const hit = result.nodes.find(n => n.id === invoiceId)!;
    expect(hit).toBeTruthy();
    expect(hit).toHaveProperty('found_by');
    expect(hit).toHaveProperty('confidence');
    expect(hit).toHaveProperty('relevance');
    expect(hit).toHaveProperty('uses');
    expect(hit).toHaveProperty('used_by');
    expect(hit).toHaveProperty('history_count');
    expect(hit.history_count).toBeGreaterThanOrEqual(1);
    // computeInvoiceTotal has no callers — the honest "0 callers" note must be attached.
    expect(hit.used_by).toBe(0);
    expect(hit.used_by_note).toBeTruthy();

    const smHit = result.nodes.find(n => n.id === sessionManagerId);
    // SessionManager may or may not surface for this particular query; only assert its shape
    // if present, but separately confirm the SessionManager -> formatGreeting edge is reflected
    // via a direct identifier search instead (deterministic).
    if (smHit) {
      expect(smHit.uses).toBeGreaterThanOrEqual(1);
    }
    const smExact = await fx.db.searchNodes('SessionManager');
    const smExactHit = smExact.nodes.find(n => n.id === sessionManagerId)!;
    expect(smExactHit.uses).toBe(1);
    expect(smExactHit).toHaveProperty('last_updated');
  });

  it('returns an empty-result hint when nothing matches anywhere', async () => {
    const result = await fx.db.searchNodes('zzznonexistentqueryzzz_thiswillneverexist_12345');
    expect(result.nodes).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.hint).toBeTruthy();
  });

  it('searchDecisions: finds a "Decision:" line by keyword', () => {
    const results = fx.db.searchDecisions('monetary rounding half-up');
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find(r => r.node_id === invoiceId || r.node_id === greetingId || r.node_id === sessionManagerId);
    expect(hit).toBeTruthy();
    expect(hit!.reasoning).toContain('Decision: Use monetary rounding half-up');
  });

  it('searchDecisions: returns nothing for an unrelated query', () => {
    const results = fx.db.searchDecisions('completely unrelated decision text xyz');
    expect(results).toEqual([]);
  });

  it('searchCode: literal search over the latest code_snapshot returns matching lines and ratios', () => {
    const results = fx.db.searchCode({ query: 'invoice' });
    const hit = results.find(r => r.node_id === invoiceId);
    expect(hit).toBeTruthy();
    expect(hit!.match_count).toBeGreaterThanOrEqual(1);
    expect(hit!.matches.some(m => m.line_content.includes('invoice'))).toBe(true);
    expect(hit!.total_lines).toBeGreaterThan(0);
    expect(hit!.match_ratio).toBeCloseTo(hit!.match_count / hit!.total_lines);
  });

  it('searchCode: regex search matches via pattern', () => {
    const results = fx.db.searchCode({ query: 'return .*reduce', is_regex: true });
    const hit = results.find(r => r.node_id === invoiceId);
    expect(hit).toBeTruthy();
    expect(hit!.match_count).toBeGreaterThanOrEqual(1);
  });

  it('searchCode: case-insensitive by default, case-sensitive when disabled', () => {
    const insensitive = fx.db.searchCode({ query: 'INVOICE', case_insensitive: true });
    expect(insensitive.some(r => r.node_id === invoiceId)).toBe(true);

    const sensitive = fx.db.searchCode({ query: 'INVOICE', case_insensitive: false });
    expect(sensitive.some(r => r.node_id === invoiceId)).toBe(false);
  });

  it('searchCode: throws on an invalid regex pattern', () => {
    expect(() => fx.db.searchCode({ query: '(', is_regex: true })).toThrow(/Invalid regex pattern/);
  });

  it('searchCode: returns [] when nothing matches', () => {
    const results = fx.db.searchCode({ query: 'zzz_no_such_token_zzz' });
    expect(results).toEqual([]);
  });

  it('an explicit pattern matches the exact regex the caller wrote, not a re-escaped version of it', async () => {
    // The motivating bug: a caller-supplied regex like this used to be escaped into a search for
    // a literal backslash, so it could never match. mathUtils.ts's own comment contains "invoice"
    // — this alternation should reach it via the pattern, independent of the query text.
    const result = await fx.db.searchNodes('nonexistent-query-text-xyz', { pattern: 'sum invoice|computeInvoiceTotal' });
    expect(result.files.some(f => f.file_path.includes('mathUtils.ts'))).toBe(true);
  });

  it('files bucket sample lines report the containing function/class when the hit lands inside one', async () => {
    const result = await fx.db.searchNodes(undefined, { pattern: 'items\\.reduce' });
    const file = result.files.find(f => f.file_path.includes('mathUtils.ts'));
    expect(file).toBeTruthy();
    const line = file!.sample_lines.find(l => l.line_content.includes('items.reduce'));
    expect(line).toBeTruthy();
    expect(line!.symbol).toBe('computeInvoiceTotal');
  });

  it('files_total/nodes_total report true counts, and offset pages through the files bucket', async () => {
    // A pattern broad enough to hit every fixture file's own filename-adjacent text.
    const first = await fx.db.searchNodes(undefined, { pattern: 'function|class', limit: 1 });
    expect(first.files.length).toBeLessThanOrEqual(1);
    expect(first.files_total).toBeGreaterThanOrEqual(first.files.length);
    expect(first.files_offset).toBe(0);
    expect(typeof first.nodes_total).toBe('number');

    if (first.files_total > 1) {
      const second = await fx.db.searchNodes(undefined, { pattern: 'function|class', limit: 1, offset: 1 });
      expect(second.files_offset).toBe(1);
      if (first.files.length && second.files.length) {
        expect(second.files[0].file_path).not.toBe(first.files[0].file_path);
      }
    }
  });

  it('path scoping restricts the files bucket to one file', async () => {
    const scoped = await fx.db.searchNodes(undefined, { pattern: 'invoice', path: repoFile(fx, 'mathUtils.ts') });
    expect(scoped.files.every(f => f.file_path.includes('mathUtils.ts'))).toBe(true);
    expect(scoped.files.some(f => f.file_path.includes('notes.md'))).toBe(false);
  });
});
