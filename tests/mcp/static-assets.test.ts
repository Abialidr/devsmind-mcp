import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Regression guard for the view app's static routes when the package lives under a dot-directory.
 *
 * `res.sendFile(absolutePath)` with no `root` makes `send` dotfile-check EVERY segment of the
 * absolute path, and its default policy ('ignore') turns any hit into a 404. A global install
 * under nvm (/home/x/.nvm/versions/node/vXX/lib/node_modules/devsmind-mcp/dist/mcp) trips that on
 * `.nvm` alone, so every /app/* and /vendor/* request 404s while `GET /` — plain readFileSync —
 * still serves the shell. The view app loads and renders nothing.
 *
 * ASSETS_DIR is `__dirname`, so it is mocked here onto a temp tree containing a dot segment; the
 * real one never does inside the repo, which is exactly why this shipped.
 */
const DOT_ASSETS_DIR = path.join(os.tmpdir(), 'devsmind-static-assets-test', '.nvm', 'mcp');

jest.mock('../../src/mcp/visualizer', () => ({
  ...jest.requireActual('../../src/mcp/visualizer'),
  ASSETS_DIR: DOT_ASSETS_DIR
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createHttpApp, cleanup: cleanupCachedDatabases } = require('../../src/mcp/server');

const APP_FILES = ['view.css', 'view.js', 'view_chat.js', 'view_graph.js'];
const VENDOR_FILES = ['three.min.js', 'force-graph.min.js', '3d-force-graph.min.js'];

describe('static view assets served from a path containing a dot-directory', () => {
  const app = createHttpApp(4514);

  beforeAll(() => {
    fs.mkdirSync(path.join(DOT_ASSETS_DIR, 'vendor'), { recursive: true });
    for (const file of APP_FILES) {
      fs.writeFileSync(path.join(DOT_ASSETS_DIR, file), `/* ${file} */`);
    }
    for (const file of VENDOR_FILES) {
      fs.writeFileSync(path.join(DOT_ASSETS_DIR, 'vendor', file), `/* ${file} */`);
    }
  });

  afterAll(() => {
    cleanupCachedDatabases();
    fs.rmSync(path.join(os.tmpdir(), 'devsmind-static-assets-test'), { recursive: true, force: true });
  });

  it.each(APP_FILES)('GET /app/%s serves the file', async (file) => {
    const res = await request(app).get(`/app/${file}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(file);
  });

  it.each(VENDOR_FILES)('GET /vendor/%s serves the file', async (file) => {
    const res = await request(app).get(`/vendor/${file}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(file);
  });

  it('GET /app/:file rejects a name outside the whitelist', async () => {
    const res = await request(app).get('/app/server.js');
    expect(res.status).toBe(404);
  });

  it('GET /vendor/:file rejects a name outside the whitelist', async () => {
    const res = await request(app).get('/vendor/server.js');
    expect(res.status).toBe(404);
  });
});
