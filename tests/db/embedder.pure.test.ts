import { quantizeInt8, cosineInt8, hashDescription, tokenize } from '../../src/db/embedder';

describe('quantizeInt8', () => {
  it('scales an L2-normalized value of 1 to 127', () => {
    const out = quantizeInt8(new Float32Array([1]));
    expect(out[0]).toBe(127);
  });

  it('scales a value of -1 to -127', () => {
    const out = quantizeInt8(new Float32Array([-1]));
    expect(out[0]).toBe(-127);
  });

  it('scales 0 to 0', () => {
    const out = quantizeInt8(new Float32Array([0]));
    expect(out[0]).toBe(0);
  });

  it('rounds to the nearest integer', () => {
    // 0.5 * 127 = 63.5 -> rounds to 64
    const out = quantizeInt8(new Float32Array([0.5]));
    expect(out[0]).toBe(64);
  });

  it('clamps values above the representable range to 127', () => {
    const out = quantizeInt8(new Float32Array([10])); // 10*127 way over int8 range
    expect(out[0]).toBe(127);
  });

  it('clamps values below the representable range to -128', () => {
    const out = quantizeInt8(new Float32Array([-10]));
    expect(out[0]).toBe(-128);
  });

  it('produces an Int8Array of the same length as the input', () => {
    const out = quantizeInt8(new Float32Array([0.1, 0.2, -0.3, 0.9]));
    expect(out.length).toBe(4);
    expect(out).toBeInstanceOf(Int8Array);
  });

  it('handles an empty vector', () => {
    const out = quantizeInt8(new Float32Array([]));
    expect(out.length).toBe(0);
  });
});

describe('cosineInt8', () => {
  it('is ~1 for identical (parallel) vectors quantized from a unit-length input', () => {
    const vec = quantizeInt8(new Float32Array([1, 0, 0]));
    const sim = cosineInt8(vec, vec);
    expect(sim).toBeCloseTo(1, 1);
  });

  it('is ~0 for orthogonal unit vectors', () => {
    const a = quantizeInt8(new Float32Array([1, 0]));
    const b = quantizeInt8(new Float32Array([0, 1]));
    const sim = cosineInt8(a, b);
    expect(sim).toBeCloseTo(0, 1);
  });

  it('is ~ -1 for opposite unit vectors', () => {
    const a = quantizeInt8(new Float32Array([1, 0]));
    const b = quantizeInt8(new Float32Array([-1, 0]));
    const sim = cosineInt8(a, b);
    expect(sim).toBeCloseTo(-1, 1);
  });

  it('computes the raw integer dot product scaled by QUANT_SCALE^2 for known small vectors', () => {
    const a = new Int8Array([127, 0]);
    const b = new Int8Array([127, 0]);
    // dot = 127*127 + 0*0 = 16129; scale^2 = 127*127 = 16129 -> 16129/16129 = 1
    expect(cosineInt8(a, b)).toBeCloseTo(1, 5);
  });

  it('returns 0 for zero vectors', () => {
    const a = new Int8Array([0, 0, 0]);
    const b = new Int8Array([0, 0, 0]);
    expect(cosineInt8(a, b)).toBe(0);
  });

  it('handles empty vectors, returning 0', () => {
    expect(cosineInt8(new Int8Array([]), new Int8Array([]))).toBe(0);
  });
});

describe('hashDescription', () => {
  it('is deterministic — same input yields the same hash', () => {
    const text = 'Verifies user credentials against the stored hash.';
    expect(hashDescription(text)).toBe(hashDescription(text));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashDescription('description A')).not.toBe(hashDescription('description B'));
  });

  it('produces a 16-character lowercase hex string (sha256 truncated to 16 chars)', () => {
    const hash = hashDescription('anything');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is sensitive to even a single-character change', () => {
    expect(hashDescription('hello world')).not.toBe(hashDescription('hello world.'));
  });

  it('handles an empty string input', () => {
    const hash = hashDescription('');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// tokenize — WordPiece edge cases against the real vendored vocab.txt (no ONNX involved at all,
// so these run identically regardless of onnxruntime-node availability in this environment).
// ─────────────────────────────────────────────────────────────────────────
describe('tokenize — WordPiece edge cases', () => {
  it('falls back to [UNK] (without throwing) for a single "word" over 100 characters — wordpieceTokenize\'s length guard', () => {
    // A run of 150 letters with no punctuation/whitespace stays ONE token for basicTokenize to
    // hand to wordpieceTokenize, which refuses to even attempt matching anything over 100 chars.
    const longWord = 'x'.repeat(150);
    const result = tokenize(`hello ${longWord} world`);
    expect(result).not.toBeNull();
    expect(result!.inputIds.length).toBe(256);
    expect(result!.attentionMask.length).toBe(256);
  });

  it('falls back to [UNK] for a subword with no vocab match at any length (greedy match exhausted)', () => {
    // An obscure/recent emoji is extremely unlikely to be a literal token OR any "##"-prefixed
    // continuation in an English BERT vocab — wordpieceTokenize's greedy loop should exhaust every
    // candidate length down to nothing and mark the word "bad" rather than looping forever.
    const result = tokenize('hello \u{1FAE0} world');
    expect(result).not.toBeNull();
    expect(result!.inputIds.length).toBe(256);
    // [CLS] framing at the start, and at least one non-padding position beyond it.
    expect(result!.inputIds[0]).toBeGreaterThan(0);
    expect(result!.attentionMask.filter(m => m === 1).length).toBeGreaterThan(1);
  });

  it('stops accumulating pieces once the maxTokens-2 budget is reached, silently dropping the remaining words', () => {
    // 10 short, common one-piece words against a deliberately tiny maxTokens=8 (budget=6 pieces)
    // — the word loop must `break` after the 6th rather than tokenizing (and then truncating) all
    // ten, so the returned length is exactly maxTokens regardless of how much input there was.
    const manyWords = 'one two three four five six seven eight nine ten';
    const result = tokenize(manyWords, 8);
    expect(result).not.toBeNull();
    expect(result!.inputIds.length).toBe(8);
    expect(result!.attentionMask.length).toBe(8);
    // [CLS] + up to 6 piece ids + [SEP], with every position attended (no padding needed/possible
    // at exactly the budget).
    expect(result!.attentionMask.every(m => m === 1)).toBe(true);
  });
});
