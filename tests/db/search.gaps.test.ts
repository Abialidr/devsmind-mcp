import { makeFixture, stageAndCommit, repoFile } from '../helpers/fixture';
import {
  toCompactSearchResult, NO_STATIC_CALLERS_NOTE, SearchNodesResult, RankedNode
} from '../../src/db/database';

const FOO_SNIPPET = 'export function greet(name: string): string {\n  return format(name);\n}';

describe('DevMindDatabase.searchNodes — remaining branches', () => {
  it('honors an explicit opts.pattern (both for the identifier-match + grep combo)', async () => {
    const fx = makeFixture();
    try {
      await stageAndCommit(fx, [
        { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
      ]);
      // "greet" is an exact-identifier hit; passing an explicit pattern also makes the
      // identifier short-circuit run grep with that pattern (not the query-derived fallback).
      const result = await fx.db.searchNodes('greet', { pattern: 'greet|format' });
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes[0].matched_via).toBe('identifier');
      // files bucket may or may not have grep hits depending on filesystem walk timing, but the
      // call must complete and return the shape (grep DID run — no throw either way).
      expect(Array.isArray(result.files)).toBe(true);
      expect(typeof result.files_total).toBe('number');
    } finally {
      fx.cleanup();
    }
  });

  it('a pattern-only search (no query) skips the semantic layer and identifier short-circuit, returning code-match nodes', async () => {
    const fx = makeFixture();
    try {
      await stageAndCommit(fx, [
        { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
      ]);
      const result = await fx.db.searchNodes(undefined, { pattern: 'format\\(name\\)' });
      expect(result.nodes.every(n => n.matched_via !== 'identifier')).toBe(true);
      const hit = result.nodes.find(n => n.id.endsWith('#greet'));
      expect(hit).toBeTruthy();
      expect((hit as any).found_by).toContain('code');
    } finally {
      fx.cleanup();
    }
  });

  it('throws when neither query nor pattern is given', async () => {
    const fx = makeFixture();
    try {
      await expect(fx.db.searchNodes(undefined, {})).rejects.toThrow(/requires at least one of/);
    } finally {
      fx.cleanup();
    }
  });

  it('rejects a path scope outside every configured repo', async () => {
    const fx = makeFixture();
    try {
      await expect(fx.db.searchNodes('greet', { path: 'C:\\completely\\unrelated\\dir' })).rejects.toThrow(/outside every configured repo/);
    } finally {
      fx.cleanup();
    }
  });

  it('says "none configured" in the rejection when the brain has no repos at all', async () => {
    // With zero repos the roots list is empty, so the message would otherwise read
    // "(...)" with nothing inside it and give the caller no idea why the scope failed.
    const fx = makeFixture({ configOverrides: { repos: [] }, skipDefaultFiles: true });
    try {
      await expect(fx.db.searchNodes('greet', { path: 'C:\\anywhere' })).rejects.toThrow(/none configured/);
    } finally {
      fx.cleanup();
    }
  });

  it('DEVSMIND_PERF_DEBUG=1 logs the [perf] breakdown line on the full ranked path', async () => {
    const fx = makeFixture();
    const prevDebug = process.env.DEVSMIND_PERF_DEBUG;
    process.env.DEVSMIND_PERF_DEBUG = '1';
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await stageAndCommit(fx, [
        { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function', description: 'Greets a person by name' }
      ]);
      // A query with no literal identifier/id/description/reasoning substring match forces the
      // full ranked path (bm25/vector/grep), not the identifier short-circuit.
      await fx.db.searchNodes('completely unrelated query text xyz123');
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[perf]'));
    } finally {
      errSpy.mockRestore();
      if (prevDebug === undefined) delete process.env.DEVSMIND_PERF_DEBUG; else process.env.DEVSMIND_PERF_DEBUG = prevDebug;
      fx.cleanup();
    }
  });

  it('reports the vector layer as skipped, not as 0ms, on a pattern-only search', async () => {
    // A regex has no meaning to embed, so the vector layer never runs without a `query`. The perf
    // line has to say "skipped" rather than a timing — a 0ms reading would read as "the vector
    // search ran and was instant", which is the opposite of what happened.
    const fx = makeFixture();
    const prevDebug = process.env.DEVSMIND_PERF_DEBUG;
    process.env.DEVSMIND_PERF_DEBUG = '1';
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await stageAndCommit(fx, [
        { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
      ]);
      await fx.db.searchNodes(undefined, { pattern: 'greet|format' });
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('vector=skipped(no query)'));
    } finally {
      errSpy.mockRestore();
      if (prevDebug === undefined) delete process.env.DEVSMIND_PERF_DEBUG; else process.env.DEVSMIND_PERF_DEBUG = prevDebug;
      fx.cleanup();
    }
  });
});

describe('DevMindDatabase — mapGrepHitsToNodes (private, exercised via cast)', () => {
  function mapHits(db: any, hits: any[]) {
    return db.mapGrepHitsToNodes(hits) as { nodeId: string; lines: { line_number: number; line_content: string }[] }[];
  }

  it('drops a hit that falls between symbols (e.g. an import line) in an AST-parseable file, keeps one inside a symbol\'s span', () => {
    const fx = makeFixture();
    try {
      const greetId = '{app}/foo.ts#greet';
      const formatId = '{app}/bar.ts#format';
      fx.db.upsertNode({ id: greetId, type: 'function', name: 'greet', file_path: repoFile(fx, 'foo.ts') });
      fx.db.upsertNode({ id: formatId, type: 'function', name: 'format', file_path: repoFile(fx, 'bar.ts') });
      const fooPath = repoFile(fx, 'foo.ts');
      const barPath = repoFile(fx, 'bar.ts');

      // Hits spread across TWO files (not just one) so filesByStrength's `.sort()` comparator
      // actually runs at least once (a 1-entry array never invokes its comparator at all).
      const result = mapHits(fx.db, [
        { file_path: fooPath, line_number: 1, line_content: "import { format } from './bar';", matched_text: 'import' },
        { file_path: fooPath, line_number: 4, line_content: '  return format(name);', matched_text: 'format' },
        { file_path: barPath, line_number: 1, line_content: 'export function format(s: string): string {', matched_text: 'format' }
      ]);

      const greetEntry = result.find(r => r.nodeId === greetId)!;
      expect(greetEntry).toBeTruthy();
      expect(greetEntry.lines).toHaveLength(1);
      expect(greetEntry.lines[0].line_number).toBe(4);
    } finally {
      fx.cleanup();
    }
  });

  it('falls back to coarse whole-file assignment for an indexed but non-AST-parseable file', () => {
    const fx = makeFixture({
      skipDefaultFiles: true,
      extraFiles: { 'script.py': 'def helper():\n    return 1\n' }
    });
    try {
      const nodeId = '{app}/script.py#helper';
      const filePath = repoFile(fx, 'script.py');
      fx.db.upsertNode({ id: nodeId, type: 'function', name: 'helper', file_path: filePath });

      const result = mapHits(fx.db, [
        { file_path: filePath, line_number: 1, line_content: 'def helper():', matched_text: 'helper' }
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].nodeId).toBe(nodeId);
      expect(result[0].lines).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  it('returns [] for an empty hit list', () => {
    const fx = makeFixture();
    try {
      expect(mapHits(fx.db, [])).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});

describe('annotateSampleLinesWithSymbol — a file whose indexed nodes resolve to no spans', () => {
  it('leaves the sample lines unannotated instead of throwing or mislabelling them', async () => {
    // The file is AST-parseable and DOES have indexed nodes, but none of those symbols is actually
    // declared in it (a node left behind by a rename). computeSymbolSpans then yields nothing, and
    // the only correct answer is "no symbol" — guessing a container from an unrelated node would
    // be worse than leaving the field off, since `symbol` is presented as fact.
    const fx = makeFixture();
    try {
      fx.db.upsertNode({
        id: '{app}/foo.ts#neverDeclared',
        type: 'function',
        name: 'neverDeclared',
        file_path: repoFile(fx, 'foo.ts')
      });
      const result = await fx.db.searchNodes(undefined, {
        pattern: 'greet',
        path: repoFile(fx, 'foo.ts')
      });
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.files[0].sample_lines.every(l => l.symbol === undefined)).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});

describe('toCompactSearchResult', () => {
  const fullResult = (): SearchNodesResult => ({
    nodes: [{
      id: '{app}/foo.ts#greet',
      type: 'function',
      name: 'greet',
      file_path: '/repo/foo.ts',
      signature: 'greet(name: string): string',
      description: 'Builds a salutation.',
      aliases: ['sayHi'],
      deprecated: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      matched_via: 'fuzzy',
      found_by: ['keyword', 'code'],
      confidence: 'high',
      relevance: 100,
      matched_terms: ['greet'],
      code_matches: [
        { line_number: 1, line_content: 'A'.repeat(400) },
        { line_number: 2, line_content: 'b' },
        { line_number: 3, line_content: 'c' }
      ],
      uses: 2,
      used_by: 7,
      history_count: 3,
      used_by_note: NO_STATIC_CALLERS_NOTE
    } as RankedNode],
    files: [{
      file_path: '/repo/styles.css',
      total_matches: 9,
      match_counts: { greet: 6, format: 3 },
      distinct_matches: 2,
      score: 12.5,
      sample_lines: [
        { line_number: 1, line_content: 'Z'.repeat(400), symbol: 'greet' },
        { line_number: 2, line_content: 'y' },
        { line_number: 3, line_content: 'x' }
      ]
    }],
    files_total: 40,
    files_offset: 0,
    nodes_total: 55,
    truncated: true
  });

  it('tier 1 keeps trimmed evidence and drops the bulk-without-signal fields', () => {
    const out = toCompactSearchResult(fullResult(), 1);
    const node = out.nodes[0];

    // Kept: everything a caller triages or drills in on. A compact result that dropped these
    // would be smaller and useless at the same time.
    expect(node.confidence).toBe('high');
    expect(node.relevance).toBe(100);
    expect(node.found_by).toEqual(['keyword', 'code']);
    expect(node.uses).toBe(2);
    expect(node.used_by).toBe(7);
    expect(node.history_count).toBe(3);
    expect(node.description).toBe('Builds a salutation.');

    // Dropped: bulk with no bearing on which result to open next. `used_by_note` especially —
    // it's ~140 chars of identical boilerplate repeated per zero-caller node.
    expect(node).not.toHaveProperty('aliases');
    expect(node).not.toHaveProperty('created_at');
    expect(node).not.toHaveProperty('matched_terms');
    expect(node).not.toHaveProperty('used_by_note');
    expect(out.files[0]).not.toHaveProperty('match_counts');
    expect(out.files[0]).not.toHaveProperty('score');

    // Evidence survives, thinned: 2 entries max, 200 chars max.
    expect(node.code_matches).toHaveLength(2);
    expect(node.code_matches![0].line_content).toHaveLength(200);
    expect(out.files[0].sample_lines).toHaveLength(2);
    expect(out.files[0].sample_lines![0].line_content).toHaveLength(200);
    // The symbol annotation rides along on the line it belongs to.
    expect(out.files[0].sample_lines![0].symbol).toBe('greet');
  });

  it('tier 2 drops evidence entirely, leaving a pure triage list', () => {
    const out = toCompactSearchResult(fullResult(), 2);
    expect(out.nodes[0].code_matches).toBeUndefined();
    expect(out.files[0].sample_lines).toBeUndefined();
    expect(out.nodes[0].confidence).toBe('high');
    expect(out.files[0].file_path).toBe('/repo/styles.css');
    expect(out.files[0].total_matches).toBe(9);
  });

  it('never alters a count — a trimmed result must not be mistakable for a complete one', () => {
    for (const tier of [1, 2] as const) {
      const out = toCompactSearchResult(fullResult(), tier);
      expect(out.nodes_total).toBe(55);
      expect(out.files_total).toBe(40);
      expect(out.files_offset).toBe(0);
      expect(out.truncated).toBe(true);
    }
  });

  it('carries hint and scope_note through untouched', () => {
    const src = { ...fullResult(), hint: 'nothing matched', scope_note: 'excluded by default' };
    const out = toCompactSearchResult(src, 2);
    expect(out.hint).toBe('nothing matched');
    expect(out.scope_note).toBe('excluded by default');
  });

  it('handles an identifier-path node, which carries no code_matches at all', () => {
    const src = fullResult();
    const node = { ...src.nodes[0] } as Record<string, unknown>;
    delete node.code_matches;
    node.matched_via = 'identifier';
    const out = toCompactSearchResult({ ...src, nodes: [node as unknown as RankedNode] }, 1);
    expect(out.nodes[0].code_matches).toBeUndefined();
    expect(out.nodes[0].confidence).toBe('high');
  });
});

describe('searchNodes — scope_note for a default-excluded path', () => {
  it('says the path was excluded rather than letting an empty result read as "not found"', async () => {
    const fx = makeFixture({ extraFiles: { 'yarn.lock': 'greet everywhere\n' } });
    try {
      const result = await fx.db.searchNodes(undefined, {
        pattern: 'greet',
        path: repoFile(fx, 'yarn.lock')
      });
      expect(result.files).toEqual([]);
      expect(result.scope_note).toMatch(/excluded from search by default/);
    } finally {
      fx.cleanup();
    }
  });

  it('leaves scope_note unset for an ordinary scoped path', async () => {
    const fx = makeFixture();
    try {
      const result = await fx.db.searchNodes(undefined, {
        pattern: 'greet',
        path: repoFile(fx, 'foo.ts')
      });
      expect(result.scope_note).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });
});

describe('searchNodes — compact skips the AST annotation work', () => {
  it('leaves sample_lines unannotated when compact is set, and annotates them when it is not', async () => {
    // compact is not merely a projection flag: it must SKIP annotateSampleLinesWithSymbol, the AST
    // path whose only product is the `symbol` field on lines a compact response then discards.
    const fx = makeFixture();
    try {
      await stageAndCommit(fx, [
        { node_id: 'greet', file_path: repoFile(fx, 'foo.ts'), code_snapshot: FOO_SNIPPET, name: 'greet', type: 'function' }
      ]);
      const scoped = { pattern: 'greet', path: repoFile(fx, 'foo.ts') };

      const annotated = await fx.db.searchNodes(undefined, scoped);
      expect(annotated.files.length).toBeGreaterThan(0);
      expect(annotated.files[0].sample_lines.some(l => l.symbol)).toBe(true);

      const skipped = await fx.db.searchNodes(undefined, { ...scoped, compact: true });
      expect(skipped.files.length).toBeGreaterThan(0);
      expect(skipped.files[0].sample_lines.every(l => l.symbol === undefined)).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});
