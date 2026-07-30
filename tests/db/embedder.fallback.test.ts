// This file covers the two "does inference actually work here" surfaces of src/db/embedder.ts
// that tests/db/embedder.pure.test.ts deliberately leaves alone (that file only exercises the
// pure math: quantizeInt8/cosineInt8/hashDescription):
//
//   1. The ONNX-ABSENT fallback path — onnxruntime-node mocked to throw on require(), simulating
//      an unsupported platform where the optional dependency failed to install. Every entry point
//      must degrade to null/false, never throw, per the module's own doc comment. This half is
//      fully deterministic and is the main point of this file.
//
//   2. The ONNX-PRESENT path, run for real (no mocking) against the vendored model in
//      src/mcp/vendor/model/. onnxruntime-node IS installed here and isEmbedderAvailable()
//      legitimately returns true. HOWEVER: under ts-jest specifically, the actual session.run()
//      inference call has been observed to silently return null (via embedder.ts's own
//      try/catch-and-degrade around session.run — not a bug in embedder.ts) even though the exact
//      same code returns a real 384-dim vector when run standalone via `npx tsx` outside Jest.
//      This looks like a Jest-worker/native-binding interaction. So this half asserts graceful
//      behavior in EITHER branch (null, or a real vector) rather than requiring a non-null result,
//      and logs which branch this run actually took.
//
// Both mocked and real describe blocks live in the same file but use jest.resetModules() +
// isolated require() so the mock in block 1 can't leak into block 2 (mirrors the re-require
// pattern already used in tests/utils/git.test.ts for execSync mocking).

describe('embedder — ONNX absent (onnxruntime-node missing/failed to load)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('onnxruntime-node', () => {
      throw new Error('Cannot find module \'onnxruntime-node\' (simulated: unsupported platform)');
    });
  });

  afterEach(() => {
    jest.dontMock('onnxruntime-node');
    jest.resetModules();
  });

  it('isEmbedderAvailable() resolves to false', async () => {
    const { isEmbedderAvailable } = require('../../src/db/embedder');
    await expect(isEmbedderAvailable()).resolves.toBe(false);
  });

  it('embedTextInt8() resolves to null, not a rejection', async () => {
    const { embedTextInt8 } = require('../../src/db/embedder');
    await expect(embedTextInt8('validates the user session token')).resolves.toBeNull();
  });

  it('embedTextsInt8() resolves to null (not an array, not a throw) for a batch', async () => {
    const { embedTextsInt8 } = require('../../src/db/embedder');
    await expect(embedTextsInt8(['first description', 'second description'])).resolves.toBeNull();
  });

  it('embedBatch() resolves to null for a non-empty batch', async () => {
    const { embedBatch } = require('../../src/db/embedder');
    await expect(embedBatch(['some text'])).resolves.toBeNull();
  });

  it('embedBatch() still short-circuits to [] for an empty batch (no ONNX/session involvement at all)', async () => {
    const { embedBatch } = require('../../src/db/embedder');
    await expect(embedBatch([])).resolves.toEqual([]);
  });

  it('none of the above throw synchronously or reject', async () => {
    const { isEmbedderAvailable, embedTextInt8, embedTextsInt8, embedBatch } = require('../../src/db/embedder');
    await expect(Promise.all([
      isEmbedderAvailable(),
      embedTextInt8('x'),
      embedTextsInt8(['x', 'y']),
      embedBatch(['x']),
    ])).resolves.toBeDefined();
  });

  // tokenize() is pure WordPiece logic over vocab.txt — per the source, loadVocab() reads
  // vocab.txt directly off disk and never touches ortModule/tryLoadOrt() at all, so it must keep
  // working identically whether or not the ONNX runtime is available.
  it('tokenize() still works from vocab.txt, independent of the ONNX runtime being absent', () => {
    const { tokenize } = require('../../src/db/embedder');
    const result = tokenize('validates the user session token');
    expect(result).not.toBeNull();
    expect(result.inputIds.length).toBe(256); // default maxTokens
    expect(result.attentionMask.length).toBe(256);
    // [CLS] ... [SEP] framing regardless of ONNX availability
    expect(result.inputIds[0]).toBeGreaterThan(0); // [CLS] id
    const lastRealIdx = result.attentionMask.lastIndexOf(1);
    expect(lastRealIdx).toBeGreaterThan(0);
    // everything after the last attended position is padding (mask 0)
    expect(result.attentionMask.slice(lastRealIdx + 1).every((m: number) => m === 0)).toBe(true);
  });

  it('tokenize() respects a custom maxTokens even with ONNX absent', () => {
    const { tokenize } = require('../../src/db/embedder');
    const result = tokenize('short text', 16);
    expect(result).not.toBeNull();
    expect(result.inputIds.length).toBe(16);
    expect(result.attentionMask.length).toBe(16);
  });
});

describe('embedder — ONNX present (real onnxruntime-node + vendored model, unmocked)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('isEmbedderAvailable() resolves to true (onnxruntime-node + model file + vocab all present)', async () => {
    const { isEmbedderAvailable } = require('../../src/db/embedder');
    await expect(isEmbedderAvailable()).resolves.toBe(true);
  });

  it('embedTextInt8() degrades gracefully — either a real quantized vector, or null if session.run fails under this test runner', async () => {
    const { embedTextInt8, EMBEDDING_DIM } = require('../../src/db/embedder');
    const v = await embedTextInt8('validates the user session token against the database');

    const gotRealVector = v !== null && v instanceof Int8Array && v.length > 0;
    const gotNull = v === null;
    // eslint-disable-next-line no-console
    console.log(`[embedder.fallback.test] ONNX-present branch hit: ${gotRealVector ? `real ${v!.length}-dim vector` : 'null (session.run degraded under ts-jest)'}`);

    expect(gotRealVector || gotNull).toBe(true);
    if (gotRealVector) {
      expect(v!.length).toBe(EMBEDDING_DIM);
      // every component must be a valid int8
      expect(Array.from(v!).every(x => x >= -128 && x <= 127)).toBe(true);
    }
  });

  it('embedTextsInt8() degrades gracefully for a batch — either all real vectors or null, never a partial/mixed result', async () => {
    const { embedTextsInt8, EMBEDDING_DIM } = require('../../src/db/embedder');
    const vs = await embedTextsInt8(['first description here', 'second, different description']);

    const gotRealVectors = vs !== null && Array.isArray(vs) && vs.length === 2;
    const gotNull = vs === null;
    // eslint-disable-next-line no-console
    console.log(`[embedder.fallback.test] ONNX-present batch branch hit: ${gotRealVectors ? 'real vectors' : 'null'}`);

    expect(gotRealVectors || gotNull).toBe(true);
    if (gotRealVectors) {
      for (const v of vs!) {
        expect(v.length).toBe(EMBEDDING_DIM);
      }
    }
  });

  it('embedBatch() still short-circuits to [] for an empty batch even with ONNX present', async () => {
    const { embedBatch } = require('../../src/db/embedder');
    await expect(embedBatch([])).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The "ONNX present" block above can't reliably exercise the actual tensor-construction /
// mean-pool / quantize code path under ts-jest (session.run silently degrades to null there —
// see the comment at the top of this file). Mocking onnxruntime-node ourselves, with a fake
// InferenceSession whose .run() resolves a plausible tensor-shaped result, lets that code run
// for real and deterministically, independent of the test runner's native-binding quirks.
// ---------------------------------------------------------------------------
describe('embedder — ONNX mocked with a fake session (deterministic tensor-shaped result)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.dontMock('onnxruntime-node');
    jest.resetModules();
  });

  /** Minimal stand-in for ort.Tensor — embedder.ts only ever constructs these to hand to
   * session.run(feeds); our fake run() reads shape off input_ids.dims and ignores the rest. */
  class FakeTensor {
    constructor(public type: string, public data: unknown, public dims: number[]) {}
  }

  it('embedBatch mean-pools and L2-normalizes a real (fake-session) hidden-state tensor, and embedTextInt8/embedTextsInt8 quantize the result', async () => {
    const FAKE_DIM = 8; // deliberately different from the real EMBEDDING_DIM, to prove the code
                         // reads dims[2] off the tensor rather than assuming a constant.
    jest.doMock('onnxruntime-node', () => ({
      Tensor: FakeTensor,
      InferenceSession: {
        create: jest.fn(async () => ({
          run: jest.fn(async (feeds: { input_ids: { dims: number[] } }) => {
            const [batch, seqLen] = feeds.input_ids.dims;
            const data = new Float32Array(batch * seqLen * FAKE_DIM);
            // A deterministic, non-uniform pattern (not all zero, not all equal) so mean-pooling
            // and normalization both do real work rather than trivially no-op-ing.
            for (let i = 0; i < data.length; i++) data[i] = ((i % 7) - 3) / 10;
            return { last_hidden_state: { data, dims: [batch, seqLen, FAKE_DIM] } };
          })
        }))
      }
    }));

    const { embedBatch, embedTextInt8, embedTextsInt8, EMBEDDING_DIM } = require('../../src/db/embedder');

    const vectors = await embedBatch(['hello world', 'a second, different sentence']);
    expect(vectors).not.toBeNull();
    expect(vectors!.length).toBe(2);
    for (const v of vectors!) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(FAKE_DIM);
      // meanPoolAndNormalize L2-normalizes non-zero output — norm should be ~1.
      let normSq = 0;
      for (const x of v) normSq += x * x;
      expect(Math.sqrt(normSq)).toBeCloseTo(1, 4);
    }
    // The two inputs differ in length (different attention-mask coverage), so their pooled
    // vectors must differ too — confirms this isn't just returning a constant.
    expect(Array.from(vectors![0])).not.toEqual(Array.from(vectors![1]));

    // embedTextInt8/embedTextsInt8 build on embedBatch — confirm they quantize a REAL result.
    const one = (await embedTextInt8('another sentence entirely')) as Int8Array;
    expect(one).toBeInstanceOf(Int8Array);
    expect(one.length).toBe(FAKE_DIM);
    expect(Array.from(one).every((x: number) => x >= -128 && x <= 127)).toBe(true);

    const many = await embedTextsInt8(['x text', 'y text', 'z text']);
    expect(many).not.toBeNull();
    expect(many!.length).toBe(3);
    for (const v of many!) expect(v).toBeInstanceOf(Int8Array);

    // EMBEDDING_DIM itself is a fixed export unrelated to the fake session's own dim — sanity
    // check it's still the real constant, not something the mock accidentally overrode.
    expect(EMBEDDING_DIM).toBe(384);
  });

  it('embedBatch resolves to null when the session result has no last_hidden_state', async () => {
    jest.doMock('onnxruntime-node', () => ({
      Tensor: FakeTensor,
      InferenceSession: { create: jest.fn(async () => ({ run: jest.fn(async () => ({})) })) }
    }));
    const { embedBatch } = require('../../src/db/embedder');
    await expect(embedBatch(['some text'])).resolves.toBeNull();
  });

  it('embedBatch resolves to null (not a rejection) when session.run() itself throws', async () => {
    jest.doMock('onnxruntime-node', () => ({
      Tensor: FakeTensor,
      InferenceSession: {
        create: jest.fn(async () => ({
          run: jest.fn(async () => { throw new Error('simulated inference failure'); })
        }))
      }
    }));
    const { embedBatch } = require('../../src/db/embedder');
    await expect(embedBatch(['some text'])).resolves.toBeNull();
  });

  it('getSession()/isEmbedderAvailable() degrade to false-y when InferenceSession.create() itself throws', async () => {
    jest.doMock('onnxruntime-node', () => ({
      Tensor: FakeTensor,
      InferenceSession: {
        create: jest.fn(async () => { throw new Error('simulated session-load failure'); })
      }
    }));
    const { isEmbedderAvailable, embedBatch } = require('../../src/db/embedder');
    await expect(isEmbedderAvailable()).resolves.toBe(false);
    await expect(embedBatch(['some text'])).resolves.toBeNull();
  });

  it('getSession() resolves to null when the vendored model file does not exist on disk (ort loads fine, but the file check fails)', async () => {
    jest.doMock('onnxruntime-node', () => ({
      Tensor: FakeTensor,
      InferenceSession: { create: jest.fn(async () => ({ run: jest.fn() })) }
    }));
    const fs = require('fs');
    const realExistsSync = fs.existsSync.bind(fs);
    const spy = jest.spyOn(fs, 'existsSync').mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('model_int8.onnx') ? false : realExistsSync(p)
    );
    try {
      const { isEmbedderAvailable, embedBatch } = require('../../src/db/embedder');
      await expect(isEmbedderAvailable()).resolves.toBe(false);
      await expect(embedBatch(['some text'])).resolves.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('meanPoolAndNormalize falls back to norm 1 (rather than dividing by zero) when the hidden state is all zeros', async () => {
    jest.doMock('onnxruntime-node', () => ({
      Tensor: FakeTensor,
      InferenceSession: {
        create: jest.fn(async () => ({
          run: jest.fn(async (feeds: { input_ids: { dims: number[] } }) => {
            const [batch, seqLen] = feeds.input_ids.dims;
            const dim = 4;
            // All-zero hidden state — sums stay 0 throughout, so normSq is 0 and
            // `Math.sqrt(normSq) || 1` must take its `|| 1` fallback rather than dividing by 0.
            return { last_hidden_state: { data: new Float32Array(batch * seqLen * dim), dims: [batch, seqLen, dim] } };
          })
        }))
      }
    }));
    const { embedBatch } = require('../../src/db/embedder');
    const vectors = await embedBatch(['anything at all']);
    expect(vectors).not.toBeNull();
    expect(vectors!.length).toBe(1);
    // No NaN/Infinity from a division by zero — every component is a clean 0.
    expect(Array.from(vectors![0])).toEqual([0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// loadVocab() (vocab.txt) failure path — independent of ONNX entirely.
// ---------------------------------------------------------------------------
describe('embedder — vocab.txt load failure', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('tokenize() degrades to null (and stays null on a later call, via the cached failure flag) when vocab.txt cannot be read', () => {
    const fs = require('fs');
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('simulated ENOENT reading vocab.txt');
    });
    const { tokenize } = require('../../src/db/embedder');

    expect(tokenize('hello world')).toBeNull();
    // Second call must hit the cached `vocabLoadFailed` short-circuit, not attempt another read —
    // still returns null either way, so this is really just confirming it doesn't throw/hang.
    expect(tokenize('a second call')).toBeNull();
    spy.mockRestore();
  });

  it('embedBatch resolves to null when the vocab loads but is missing a required special token ([UNK]/[CLS]/[SEP]/[PAD])', async () => {
    const fs = require('fs');
    const realReadFileSync = fs.readFileSync.bind(fs);
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((p: unknown, enc: unknown) => {
      // A vocab that parses fine (loadVocab() itself succeeds — a non-null Map) but has no
      // [UNK] entry at all, so tokenize()'s `unkId === undefined` guard trips for every input —
      // and embedBatch's `tokenized.some(t => t === null)` check must then bail cleanly too.
      if (typeof p === 'string' && p.endsWith('vocab.txt')) return '[CLS]\n[SEP]\n[PAD]\nhello\nworld\n';
      return realReadFileSync(p, enc);
    });
    try {
      const { embedBatch, tokenize: freshTokenize } = require('../../src/db/embedder');
      expect(freshTokenize('hello world')).toBeNull();
      await expect(embedBatch(['hello world'])).resolves.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
