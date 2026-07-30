import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// vectorSearchNodes (src/db/database.ts) calls embedder.ts's embedTextInt8() for the QUERY
// vector, then does real DB work (query node_vectors, cosine-compare, sort, floor-filter). Under
// ts-jest in this environment, the real ONNX session.run() call has been observed to silently
// return null even though onnxruntime-node loads and the vendored model exists (documented in
// tests/db/embedder.fallback.test.ts) — a Jest-worker/native-binding interaction, not a real
// "embedder unavailable" condition. That means searchNodes's vector layer never gets past its
// early `if (!queryVector) return []` under the real embedder here, leaving the rest of
// vectorSearchNodes's body (and the confidence-scoring branches downstream in searchNodes that
// depend on a real cosine value) permanently unexercised by the rest of the suite.
//
// This file mocks ONLY embedTextInt8 (every other embedder.ts export — cosineInt8, hashDescription,
// the model id/dim constants — stays real) to return a deterministic, hand-picked vector, so the
// rest of the pipeline (real SQLite reads, real cosine math, real confidence thresholds) runs for
// real. Uses jest.doMock + fresh require() (the same isolated-module pattern embedder.fallback.test.ts
// already uses for this exact module) rather than a hoisted jest.mock, since ts-jest does not
// auto-hoist jest.mock the way babel-jest does.

const DIM = 384;

function vec(firstComponent: number): Int8Array {
  const v = new Int8Array(DIM);
  v[0] = firstComponent;
  return v;
}

let mockQueryVector: Int8Array | null = null;

describe('DevMindDatabase.searchNodes — vectorSearchNodes body + confidence branches (mocked query embedding)', () => {
  let tmpRoot: string;
  let devmindPath: string;
  let repoDir: string;
  let db: any;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../src/db/embedder', () => {
      const actual = jest.requireActual('../../src/db/embedder');
      return {
        ...actual,
        embedTextInt8: jest.fn(async (_text: string) => mockQueryVector)
      };
    });

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-vecsearch-'));
    devmindPath = path.join(tmpRoot, '.devmind');
    repoDir = path.join(tmpRoot, 'src-repo');
    fs.mkdirSync(devmindPath, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(devmindPath, 'config.json'), JSON.stringify({
      project_name: 'fixture', mode: 'embedded', repos: [{ name: 'app', relative_path: 'src-repo' }]
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'vec.ts'), '// unrelated placeholder file for vector-search fixture\nexport const placeholder = 1;\n');

    const { DevMindDatabase } = require('../../src/db/database');
    db = new DevMindDatabase(path.join(devmindPath, 'brain.db'));
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    jest.dontMock('../../src/db/embedder');
    jest.resetModules();
    mockQueryVector = null;
  });

  it('ranks by real cosine similarity and maps it to high/medium/low confidence, filtering sub-threshold matches', async () => {
    const { hashDescription } = require('../../src/db/embedder');
    const filePath = path.join(repoDir, 'vec.ts');

    const highId = '{app}/vec.ts#gadflyAlphaNode';
    const medId = '{app}/vec.ts#gadflyBetaNode';
    const lowId = '{app}/vec.ts#gadflyGammaNode';
    const excludedId = '{app}/vec.ts#gadflyDeltaNode';

    for (const [id, name] of [[highId, 'gadflyAlphaNode'], [medId, 'gadflyBetaNode'], [lowId, 'gadflyGammaNode'], [excludedId, 'gadflyDeltaNode']] as const) {
      db.upsertNode({ id, type: 'function', name, file_path: filePath, description: `unrelated description for ${name}` });
    }

    // Cosine = dot / (127*127) for two single-nonzero-component int8 vectors: dot = 127*c.
    db.upsertNodeVector(highId, vec(127), hashDescription('h'));   // cosine = 1.0    -> high
    db.upsertNodeVector(medId, vec(64), hashDescription('m'));     // cosine ≈ 0.504  -> medium
    db.upsertNodeVector(lowId, vec(48), hashDescription('l'));     // cosine ≈ 0.378  -> low (still > 0.35 floor)
    db.upsertNodeVector(excludedId, vec(40), hashDescription('e')); // cosine ≈ 0.315 -> below the 0.35 floor, dropped

    mockQueryVector = vec(127);

    // Gibberish query/keywords that share no tokens with any node's name/id/description/reasoning
    // and appear in no file on disk — isolates the result to the vector layer alone.
    const result = await db.searchNodes('zzqxbrqx1 zzqxbrqx2 zzqxbrqx3 nonsense query terms');

    const byId = new Map(result.nodes.map((n: any) => [n.id, n]));
    expect(byId.has(excludedId)).toBe(false);

    const high = byId.get(highId) as any;
    expect(high).toBeTruthy();
    expect(high.matched_via).toBe('semantic');
    expect(high.found_by).toEqual(['meaning']);
    expect(high.confidence).toBe('high');

    const med = byId.get(medId) as any;
    expect(med).toBeTruthy();
    expect(med.confidence).toBe('medium');

    const low = byId.get(lowId) as any;
    expect(low).toBeTruthy();
    expect(low.confidence).toBe('low');
  });

  it('returns [] from the vector layer (not null, not a throw) when embedTextInt8 resolves null', async () => {
    mockQueryVector = null;
    db.upsertNode({ id: '{app}/vec.ts#soloNode', type: 'function', name: 'soloNode', file_path: path.join(repoDir, 'vec.ts') });
    const result = await db.searchNodes('anything at all');
    expect(Array.isArray(result.nodes)).toBe(true);
  });
});
