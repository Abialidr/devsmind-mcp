import request from 'supertest';
import * as fs from 'fs';
import { createHttpApp, cleanup as cleanupCachedDatabases } from '../../src/mcp/server';
import { DEVSMIND_TOKEN } from '../../src/mcp/visualizer';
import { makeFixture, Fixture, stageAndCommit, repoFile } from '../helpers/fixture';

describe('HTTP API (Express app via supertest, no port bound)', () => {
  const app = createHttpApp(4513);
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    cleanupCachedDatabases();
    fx.cleanup();
  });

  it('GET /health reports server status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.endpoint).toContain('/mcp');
  });

  it('GET / serves the view app shell', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/graph-data requires an existing brain directory', async () => {
    const res = await request(app).get('/api/graph-data').query({ path: fx.devmindPath + '-does-not-exist' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('GET /api/graph-data returns nodes/connections/history for a real brain', async () => {
    await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: 'export function greet(name: string) { return format(name); }',
        name: 'greet',
        type: 'function',
        description: 'Returns a greeting string built from the given name, exercised by the HTTP API test.'
      }
    ]);

    const res = await request(app).get('/api/graph-data').query({ path: fx.devmindPath });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(res.body.nodes.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.connections)).toBe(true);
    expect(Array.isArray(res.body.history)).toBe(true);
    // history entries are summarized to edit_count, not the full edits[] trail
    expect(res.body.history[0]).toHaveProperty('edit_count');
    expect(res.body.history[0]).not.toHaveProperty('edits');
  });

  it('GET /api/activity returns the local session/message timeline', async () => {
    const res = await request(app).get('/api/activity').query({ path: fx.devmindPath });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });

  it('GET /api/node-diff requires a history_id', async () => {
    const res = await request(app).get('/api/node-diff').query({ path: fx.devmindPath });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('history_id');
  });

  it('GET /api/node-diff returns per-edit diffs for a real history entry', async () => {
    const summary = await stageAndCommit(fx, [
      {
        node_id: 'greet',
        file_path: repoFile(fx, 'foo.ts'),
        code_snapshot: 'export function greet(name: string) { return format(name); }',
        name: 'greet',
        type: 'function',
        description: 'Returns a greeting string, exercised by the node-diff HTTP API test.'
      }
    ]);
    const historyId = summary.history_ids[0];

    const res = await request(app).get('/api/node-diff').query({ path: fx.devmindPath, history_id: historyId });
    expect(res.status).toBe(200);
    expect(res.body.history_id).toBe(historyId);
    expect(Array.isArray(res.body.edits)).toBe(true);
  });

  describe('token + origin gate on write routes', () => {
    it('POST /api/revert without X-Devsmind-Token is rejected (403)', async () => {
      const res = await request(app)
        .post('/api/revert')
        .send({ path: fx.devmindPath, history_id: 'whatever' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('POST /api/revert with the WRONG token is rejected (403)', async () => {
      const res = await request(app)
        .post('/api/revert')
        .set('X-Devsmind-Token', 'not-the-real-token')
        .send({ path: fx.devmindPath, history_id: 'whatever' });
      expect(res.status).toBe(403);
    });

    it('POST /api/revert with a non-local Origin is rejected (403) even with a valid token', async () => {
      const res = await request(app)
        .post('/api/revert')
        .set('X-Devsmind-Token', DEVSMIND_TOKEN)
        .set('Origin', 'https://evil.example.com')
        .send({ path: fx.devmindPath, history_id: 'whatever' });
      expect(res.status).toBe(403);
    });

    it('POST /api/revert with the real token and no Origin header reaches the handler (history_id missing -> 400, not 403)', async () => {
      const res = await request(app)
        .post('/api/revert')
        .set('X-Devsmind-Token', DEVSMIND_TOKEN)
        .send({ path: fx.devmindPath });
      // Cleared the token+origin gate; failed downstream on a missing history_id instead.
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('history_id');
    });

    it('POST /api/revert with a valid token reverts a real edit end-to-end', async () => {
      // getLiveCode/revertLastEdit compare against the SYMBOL's own source (parsed live via AST),
      // not the whole file — code_before/code_snapshot must be just the function body, matching
      // what edit_node itself would have staged.
      const codeBefore = 'export function format(s: string): string {\n  return "hi " + s;\n}';
      const codeAfter = 'export function format(s: string): string {\n  return "hey " + s;\n}';
      const fileBefore = fs.readFileSync(repoFile(fx, 'bar.ts'), 'utf-8');
      const fileAfter = fileBefore.replace('return "hi " + s;', 'return "hey " + s;');

      const summary = await stageAndCommit(fx, [
        {
          node_id: 'format',
          file_path: repoFile(fx, 'bar.ts'),
          code_snapshot: codeAfter,
          code_before: codeBefore,
          name: 'format',
          type: 'function',
          description: 'Formats a raw string into a greeting, exercised by the revert HTTP API test.'
        }
      ]);
      fs.writeFileSync(repoFile(fx, 'bar.ts'), fileAfter);
      const historyId = summary.history_ids[0];

      const res = await request(app)
        .post('/api/revert')
        .set('X-Devsmind-Token', DEVSMIND_TOKEN)
        .send({ path: fx.devmindPath, history_id: historyId });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const restored = fs.readFileSync(repoFile(fx, 'bar.ts'), 'utf-8');
      expect(restored).toBe(fileBefore);
    });

    it('POST /api/revert requires application/json content type', async () => {
      const res = await request(app)
        .post('/api/revert')
        .set('X-Devsmind-Token', DEVSMIND_TOKEN)
        .set('Content-Type', 'text/plain')
        .send('path=x&history_id=y');
      expect(res.status).toBe(415);
    });

    it('POST /api/message-revert is also gated by the same token check', async () => {
      const res = await request(app)
        .post('/api/message-revert')
        .send({ path: fx.devmindPath, message_id: 'whatever' });
      expect(res.status).toBe(403);
    });
  });
});
