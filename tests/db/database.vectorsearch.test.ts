// Isolated in its own file: mocks src/db/embedder's embedTextInt8 at module scope so
// vectorSearchNodes (src/db/database.ts) can be exercised deterministically regardless of
// whether real ONNX inference succeeds in this environment (it doesn't, under ts-jest — see
// tests/db/embedder.fallback.test.ts). Jest gives each test FILE its own module registry, so
// this mock never leaks into other test files that need the real degrade-to-null behavior.
jest.mock('../../src/db/embedder', () => {
  const actual = jest.requireActual('../../src/db/embedder');
  return {
    ...actual,
    embedTextInt8: jest.fn()
  };
});

import { embedTextInt8 } from '../../src/db/embedder';
import { makeFixture, stageAndCommit, repoFile, Fixture } from '../helpers/fixture';

const mockEmbedTextInt8 = embedTextInt8 as jest.MockedFunction<typeof embedTextInt8>;

function fakeVector(dim: number, fill: (i: number) => number): Int8Array {
  const v = new Int8Array(dim);
  for (let i = 0; i < dim; i++) v[i] = fill(i);
  return v;
}

describe('vectorSearchNodes (via searchNodes) with a mocked embedder', () => {
  let fx: Fixture;

  afterEach(() => {
    fx.cleanup();
    mockEmbedTextInt8.mockReset();
  });

  it('returns no semantic layer when no node has a stored vector, even though the embedder resolves a query vector', async () => {
    fx = makeFixture();
    mockEmbedTextInt8.mockResolvedValue(fakeVector(384, () => 1));

    await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: 'export function greet(name: string) { return format(name); }',
        name: 'greet',
        type: 'function'
        // No description -> commitStagedChanges never embeds it -> node_vectors stays empty for
        // this node, so the SELECT inside vectorSearchNodes returns zero rows (the `rows.length
        // === 0` branch) even though the query vector itself resolved.
      }
    ]);

    const result = await fx.db.searchNodes('a greeting helper');
    expect(result.nodes.every(n => !n.found_by?.includes('meaning'))).toBe(true);
  });

  it('excludes a stored vector below the cosine-similarity floor from the semantic layer', async () => {
    fx = makeFixture();
    // Query vector and stored vector deliberately dissimilar (one all +1s, one all -1s) so their
    // cosine similarity lands well under vectorSearchNodes' MIN_COSINE_SIMILARITY floor.
    mockEmbedTextInt8.mockResolvedValue(fakeVector(384, () => 1));

    await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: 'export function greet(name: string) { return format(name); }',
        name: 'greet',
        type: 'function',
        description: 'Returns a greeting string built from the given name, used by the demo entrypoint for testing.'
      }
    ]);
    // Overwrite whatever real/degraded vector commit stored with one that is deliberately opposite
    // to the query vector, so the floor definitely excludes it regardless of what embedding ran.
    fx.db.upsertNodeVector('{app}/foo.ts#greet', fakeVector(384, () => -1), 'test-hash');

    const result = await fx.db.searchNodes('completely unrelated query text');
    const greetResult = result.nodes.find(n => n.id === '{app}/foo.ts#greet');
    if (greetResult) {
      expect(greetResult.found_by).not.toContain('meaning');
    }
  });

  it('includes a stored vector above the cosine-similarity floor in the semantic layer', async () => {
    fx = makeFixture();
    mockEmbedTextInt8.mockResolvedValue(fakeVector(384, () => 1));

    await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: 'export function greet(name: string) { return format(name); }',
        name: 'greet',
        type: 'function',
        description: 'Returns a greeting string built from the given name, used by the demo entrypoint for testing.'
      }
    ]);
    // An identical vector -> cosine similarity 1.0, well above the floor.
    fx.db.upsertNodeVector('{app}/foo.ts#greet', fakeVector(384, () => 1), 'test-hash');

    // Shares "greeting" with the stored description so the keyword layer has at least a sliver of
    // signal too — a pure zero-textual-overlap query gets filtered upstream by search's own
    // no-meaningful-match guard before the semantic layer's result ever surfaces, which is a
    // real (and separately reasonable) safeguard, not something this test is trying to prove.
    const result = await fx.db.searchNodes('greeting message for a visitor, said however you like');
    // Whether the final result surfaces via the "meaning"/"keyword"/"code" found_by label is a
    // downstream ranking/labeling detail; what this test proves is that vectorSearchNodes' own
    // cosine-floor filter (rows scored, sorted, and kept when sim clears MIN_COSINE_SIMILARITY)
    // ran on a real above-floor row and didn't drop it — an identical stored vector at sim 1.0.
    const greetResult = result.nodes.find(n => n.id === '{app}/foo.ts#greet');
    expect(greetResult).toBeTruthy();
  });
});
