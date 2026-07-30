import { tokenizeText, tokenizeIdentifier } from '../utils/tokenize';

/**
 * The searchable "surface" of a node, split into fields so each can carry its own relevance
 * weight. `description` is the whole point of this module: without it, natural-language search
 * has almost nothing to match against — an identifier and a file path are a handful of words.
 */
export type TokenField = 'identifier' | 'path' | 'description' | 'reasoning';

export interface TokenRow {
  token: string;
  field: TokenField;
  /** Term frequency — how many times this token appears in this field, for this node. */
  tf: number;
}

/**
 * Tokenizes one field's text into deduplicated (token, tf) pairs, ready to write into
 * `node_tokens`. `identifier`/`path` fields use the identifier splitter (camelCase/snake/kebab
 * boundaries) since that's what they actually are; `description`/`reasoning` use the plain
 * natural-language tokenizer since they're already prose.
 */
export function tokenizeNodeField(text: string | null | undefined, field: TokenField): TokenRow[] {
  if (!text) return [];
  const tokens = field === 'identifier' || field === 'path' ? tokenizeIdentifier(text) : tokenizeText(text);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  return Array.from(counts.entries()).map(([token, tf]) => ({ token, field, tf }));
}

export interface FieldWeights {
  identifier: number;
  path: number;
  description: number;
  reasoning: number;
}

/**
 * `description` outweighs everything else — it's the field written specifically to be found
 * by natural language, so a hit there is the strongest possible signal that this is the right
 * node. `identifier` is still weighted highly since an exact-ish name match is usually right.
 * `reasoning` is last: it explains WHY something changed, not WHAT it is, so it's a weaker
 * signal for "find the code that does X" than the other three.
 */
export const DEFAULT_FIELD_WEIGHTS: FieldWeights = {
  description: 4,
  identifier: 3,
  path: 2,
  reasoning: 1.5
};

export interface FieldMatch {
  field: TokenField;
  /** This node's term frequency for the matched token, in this field. */
  tf: number;
  /** How many OTHER nodes also have this token in this field — rarer tokens carry more signal. */
  docFreq: number;
  /** Total nodes considered, for the IDF calculation. */
  totalNodes: number;
}

/**
 * A saturating-TF, IDF-weighted score for one candidate node across every (field, token) it
 * matched. This is BM25-shaped (the same `tf*(k1+1)/(tf+k1)` saturation and log-IDF term BM25
 * uses) but deliberately simplified: it scores a small, already-narrowed candidate set (nodes
 * that matched at least one query token via a SQL lookup), not a full-corpus scan, so there's
 * no need for BM25's document-length normalization term — every "document" here is one node's
 * handful of fields, not a variable-length passage.
 */
export function scoreCandidate(matches: FieldMatch[], weights: FieldWeights = DEFAULT_FIELD_WEIGHTS): number {
  const K1 = 1.2;
  let score = 0;
  for (const m of matches) {
    const idf = Math.log(1 + (m.totalNodes - m.docFreq + 0.5) / (m.docFreq + 0.5));
    const tfNorm = (m.tf * (K1 + 1)) / (m.tf + K1);
    score += weights[m.field] * Math.max(idf, 0.01) * tfNorm;
  }
  return score;
}

export interface RankedId {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion — merges the BM25 ranking and the vector-cosine ranking into one list,
 * using each id's POSITION within each ranking rather than the raw scores. Necessary because
 * BM25 scores are unbounded and cosine similarity is bounded [-1,1]; there's no principled scale
 * to sum them on directly, but "1st place" means the same thing in both rankings. An id missing
 * from a ranking simply contributes 0 from it — appearing in both rankings compounds naturally.
 * k=60 is the standard RRF constant (Cormack et al.): large enough that rank 1 vs rank 2 isn't a
 * cliff, small enough that being ranked at all still matters more than being buried at rank 500.
 */
export function reciprocalRankFusion(rankings: string[][], k: number = 60): RankedId[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + index + 1));
    });
  }
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
