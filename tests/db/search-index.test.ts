import {
  tokenizeNodeField,
  scoreCandidate,
  reciprocalRankFusion,
  DEFAULT_FIELD_WEIGHTS,
  FieldMatch
} from '../../src/db/search-index';
import { tokenizeText, tokenizeIdentifier } from '../../src/utils/tokenize';

describe('tokenizeNodeField', () => {
  it('returns [] for null/undefined/empty text', () => {
    expect(tokenizeNodeField(null, 'description')).toEqual([]);
    expect(tokenizeNodeField(undefined, 'identifier')).toEqual([]);
    expect(tokenizeNodeField('', 'path')).toEqual([]);
  });

  it('uses the identifier splitter for the "identifier" field', () => {
    const rows = tokenizeNodeField('verifyCredentials', 'identifier');
    const expected = tokenizeIdentifier('verifyCredentials');
    expect(rows.map(r => r.token).sort()).toEqual([...new Set(expected)].sort());
    expect(rows.every(r => r.field === 'identifier')).toBe(true);
  });

  it('uses the identifier splitter for the "path" field', () => {
    const rows = tokenizeNodeField('pages/product-detail.ts', 'path');
    const expected = tokenizeIdentifier('pages/product-detail.ts');
    expect(rows.map(r => r.token).sort()).toEqual([...new Set(expected)].sort());
    expect(rows.every(r => r.field === 'path')).toBe(true);
  });

  it('uses the natural-language tokenizer for the "description" field', () => {
    const text = 'Verifies the supplied user credentials against the stored hash.';
    const rows = tokenizeNodeField(text, 'description');
    const expected = tokenizeText(text);
    expect(rows.map(r => r.token).sort()).toEqual([...new Set(expected)].sort());
    expect(rows.every(r => r.field === 'description')).toBe(true);
  });

  it('uses the natural-language tokenizer for the "reasoning" field', () => {
    const text = 'Refactored to reduce duplicate validation logic across handlers.';
    const rows = tokenizeNodeField(text, 'reasoning');
    const expected = tokenizeText(text);
    expect(rows.map(r => r.token).sort()).toEqual([...new Set(expected)].sort());
  });

  it('deduplicates tokens and reports correct term frequency', () => {
    const rows = tokenizeNodeField('login login login user', 'description');
    const loginRow = rows.find(r => r.token === 'login');
    expect(loginRow?.tf).toBe(3);
    // no duplicate token rows
    const tokens = rows.map(r => r.token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe('DEFAULT_FIELD_WEIGHTS', () => {
  it('matches the documented per-field weights', () => {
    expect(DEFAULT_FIELD_WEIGHTS).toEqual({
      description: 4,
      identifier: 3,
      path: 2,
      reasoning: 1.5
    });
  });
});

describe('scoreCandidate', () => {
  it('returns 0 for an empty match list', () => {
    expect(scoreCandidate([])).toBe(0);
  });

  it('is strictly positive for a single ordinary match', () => {
    const matches: FieldMatch[] = [{ field: 'description', tf: 1, docFreq: 5, totalNodes: 100 }];
    expect(scoreCandidate(matches)).toBeGreaterThan(0);
  });

  it('weights fields per DEFAULT_FIELD_WEIGHTS — description scores higher than reasoning for identical tf/docFreq/totalNodes', () => {
    const base = { tf: 2, docFreq: 10, totalNodes: 100 };
    const descScore = scoreCandidate([{ field: 'description', ...base }]);
    const reasoningScore = scoreCandidate([{ field: 'reasoning', ...base }]);
    const identifierScore = scoreCandidate([{ field: 'identifier', ...base }]);
    const pathScore = scoreCandidate([{ field: 'path', ...base }]);
    expect(descScore).toBeGreaterThan(identifierScore);
    expect(identifierScore).toBeGreaterThan(pathScore);
    expect(pathScore).toBeGreaterThan(reasoningScore);
    // exact ratio should match the weight ratio since idf/tfNorm factor out identically
    expect(descScore / reasoningScore).toBeCloseTo(DEFAULT_FIELD_WEIGHTS.description / DEFAULT_FIELD_WEIGHTS.reasoning, 5);
  });

  it('accepts a custom weights map overriding the defaults', () => {
    const matches: FieldMatch[] = [{ field: 'path', tf: 1, docFreq: 5, totalNodes: 50 }];
    const customWeights = { identifier: 1, path: 100, description: 1, reasoning: 1 };
    const scoreDefault = scoreCandidate(matches);
    const scoreCustom = scoreCandidate(matches, customWeights);
    expect(scoreCustom).toBeGreaterThan(scoreDefault);
  });

  it('gives a rarer token (lower docFreq) a higher IDF-driven score than a common one, tf/totalNodes held equal', () => {
    const rare: FieldMatch = { field: 'identifier', tf: 1, docFreq: 1, totalNodes: 1000 };
    const common: FieldMatch = { field: 'identifier', tf: 1, docFreq: 900, totalNodes: 1000 };
    expect(scoreCandidate([rare])).toBeGreaterThan(scoreCandidate([common]));
  });

  it('applies TF saturation — score grows sub-linearly with tf (diminishing returns)', () => {
    const low: FieldMatch = { field: 'description', tf: 1, docFreq: 10, totalNodes: 100 };
    const high: FieldMatch = { field: 'description', tf: 10, docFreq: 10, totalNodes: 100 };
    const scoreLow = scoreCandidate([low]);
    const scoreHigh = scoreCandidate([high]);
    expect(scoreHigh).toBeGreaterThan(scoreLow);
    // tf multiplied 10x should NOT multiply the score anywhere close to 10x (saturating curve)
    expect(scoreHigh / scoreLow).toBeLessThan(5);
  });

  it('sums contributions across multiple (field, token) matches', () => {
    const matches: FieldMatch[] = [
      { field: 'description', tf: 1, docFreq: 5, totalNodes: 100 },
      { field: 'identifier', tf: 1, docFreq: 5, totalNodes: 100 }
    ];
    const combined = scoreCandidate(matches);
    const descOnly = scoreCandidate([matches[0]]);
    const idOnly = scoreCandidate([matches[1]]);
    expect(combined).toBeCloseTo(descOnly + idOnly, 10);
  });

  it('floors the IDF contribution at 0.01 rather than going negative when docFreq exceeds totalNodes', () => {
    // A pathological input (docFreq > totalNodes) that would make the raw idf log negative.
    const matches: FieldMatch[] = [{ field: 'identifier', tf: 1, docFreq: 1000, totalNodes: 10 }];
    const score = scoreCandidate(matches);
    expect(score).toBeGreaterThan(0);
    expect(Number.isFinite(score)).toBe(true);
  });
});

describe('reciprocalRankFusion', () => {
  it('returns [] for no rankings', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it('scores a single ranking by pure rank position (1/(k+index+1))', () => {
    const result = reciprocalRankFusion([['a', 'b', 'c']], 60);
    expect(result[0]).toEqual({ id: 'a', score: 1 / 61 });
    expect(result[1]).toEqual({ id: 'b', score: 1 / 62 });
    expect(result[2]).toEqual({ id: 'c', score: 1 / 63 });
  });

  it('sorts the fused result by descending score', () => {
    const result = reciprocalRankFusion([['a', 'b', 'c']]);
    const scores = result.map(r => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('merges overlapping rankings additively, boosting ids that appear in both', () => {
    const bm25 = ['x', 'y', 'z'];
    const vector = ['y', 'x', 'w'];
    const result = reciprocalRankFusion([bm25, vector], 60);
    const byId = Object.fromEntries(result.map(r => [r.id, r.score]));
    // 'y' is rank1 in vector + rank1 (index1->rank2) in bm25; 'x' rank0 bm25 + rank1 vector.
    expect(byId['x']).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(byId['y']).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(byId['z']).toBeCloseTo(1 / 63, 10);
    expect(byId['w']).toBeCloseTo(1 / 63, 10);
    // x and y (present in both rankings) should outrank z and w (present in only one)
    expect(byId['x']).toBeGreaterThan(byId['z']);
    expect(byId['y']).toBeGreaterThan(byId['w']);
  });

  it('handles non-overlapping rankings by simply concatenating their contributions', () => {
    const result = reciprocalRankFusion([['a'], ['b']], 60);
    const byId = Object.fromEntries(result.map(r => [r.id, r.score]));
    expect(byId['a']).toBeCloseTo(1 / 61, 10);
    expect(byId['b']).toBeCloseTo(1 / 61, 10);
  });

  it('respects a custom k constant', () => {
    const result = reciprocalRankFusion([['a']], 0);
    expect(result[0].score).toBeCloseTo(1 / 1, 10);
  });

  it('handles an empty individual ranking within the list', () => {
    const result = reciprocalRankFusion([[], ['a']], 60);
    expect(result).toEqual([{ id: 'a', score: 1 / 61 }]);
  });
});
