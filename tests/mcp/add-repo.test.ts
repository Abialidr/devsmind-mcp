import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { connectMcpClient, callTool, callToolJson, McpTestHarness } from '../helpers/mcpClient';
import { readScratchpad } from '../../src/db/indexer';
import { cleanup as cleanupCachedDatabases } from '../../src/mcp/server';

/**
 * `add_repo` — standalone mode's "add one repo and index just it" tool. Uses a hand-built
 * standalone fixture (two repos) rather than `makeFixture()`, which is embedded-mode-shaped
 * (one `src-repo`, `mode: 'embedded'` baked into its defaults).
 */
function makeStandaloneFixture(): { root: string; devmindPath: string; existingRepoDir: string; newRepoDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-add-repo-mcp-'));
  const devmindPath = path.join(root, '.devsmind');
  const existingRepoDir = path.join(root, 'existing-repo');
  const newRepoDir = path.join(root, 'new-repo');
  fs.mkdirSync(devmindPath, { recursive: true });
  fs.mkdirSync(existingRepoDir, { recursive: true });
  fs.mkdirSync(newRepoDir, { recursive: true });

  fs.writeFileSync(path.join(existingRepoDir, 'existing.ts'), 'export function fromExisting() { return 1; }\n');
  fs.writeFileSync(path.join(newRepoDir, 'a.ts'), 'export function alpha() { return 1; }\n');
  fs.writeFileSync(path.join(newRepoDir, 'b.ts'), 'export function beta() { return 2; }\n');

  fs.writeFileSync(path.join(devmindPath, 'config.json'), JSON.stringify({
    project_name: 'add-repo-mcp-test',
    mode: 'standalone',
    repos: [{ name: 'existing-repo', path_key: 'REPO_EXISTING_REPO' }]
  }, null, 2));
  fs.writeFileSync(path.join(devmindPath, '.env'),
    `DEVELOPER_NAME=Test\nDEVELOPER_EMAIL=test@test.com\nREPO_EXISTING_REPO=${existingRepoDir}\n`
  );

  return { root, devmindPath, existingRepoDir, newRepoDir };
}

function makeEmbeddedFixture(): { root: string; devmindPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-add-repo-embedded-'));
  const devmindPath = path.join(root, '.devsmind');
  const repoDir = path.join(root, 'app');
  fs.mkdirSync(devmindPath, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(devmindPath, 'config.json'), JSON.stringify({
    project_name: 'embedded-test', mode: 'embedded', repos: [{ name: 'app', relative_path: 'app' }]
  }, null, 2));
  fs.writeFileSync(path.join(devmindPath, '.env'), 'DEVELOPER_NAME=Test\nDEVELOPER_EMAIL=test@test.com\n');
  return { root, devmindPath };
}

describe('add_repo (MCP)', () => {
  let harness: McpTestHarness;

  beforeEach(async () => {
    harness = await connectMcpClient();
  });
  afterEach(async () => {
    await harness.close();
  });

  async function startSession(devmindPath: string): Promise<string> {
    const { parsed } = await callToolJson(harness.client, 'start_session', { devmind_path: devmindPath });
    return (parsed as { session_id: string }).session_id;
  }

  it('refuses in embedded mode with a clear isError, without touching config.json', async () => {
    const fx = makeEmbeddedFixture();
    try {
      const sessionId = await startSession(fx.devmindPath);
      const before = fs.readFileSync(path.join(fx.devmindPath, 'config.json'), 'utf-8');

      const { isError, textBlocks } = await callTool(harness.client, 'add_repo', {
        devmind_path: fx.devmindPath, session_id: sessionId, name: 'x', path: fx.root
      });

      expect(isError).toBe(true);
      expect(textBlocks.join(' ')).toMatch(/only available in standalone mode/);
      expect(fs.readFileSync(path.join(fx.devmindPath, 'config.json'), 'utf-8')).toBe(before);
    } finally {
      cleanupCachedDatabases(); // release the server's cached brain.db handle before rm (Windows locks it otherwise)
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('requires session_id (a real write)', async () => {
    const fx = makeStandaloneFixture();
    try {
      // The SDK client may reject client-side against the tool's own advertised schema
      // (session_id was injected as required by the server's ListTools handler) before the
      // request ever reaches the server's own runtime check — either path proves the gate.
      let rejected = false;
      try {
        const { isError } = await callTool(harness.client, 'add_repo', { devmind_path: fx.devmindPath, name: 'new-repo', path: fx.newRepoDir });
        rejected = isError;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    } finally {
      cleanupCachedDatabases(); // release the server's cached brain.db handle before rm (Windows locks it otherwise)
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('registers the repo in config.json/.env and indexes ONLY that repo (existing repo untouched)', async () => {
    const fx = makeStandaloneFixture();
    try {
      const sessionId = await startSession(fx.devmindPath);

      const { isError, parsed } = await callToolJson(harness.client, 'add_repo', {
        devmind_path: fx.devmindPath, session_id: sessionId, name: 'new-repo', path: fx.newRepoDir
      });
      expect(isError).toBe(false);
      const p = parsed as any;
      expect(p.status).toBe('started');
      expect(p.repo_name).toBe('new-repo');
      expect(p.scratchpad.current_repo).toBe('new-repo');
      expect(p.batch.nodes.map((n: any) => n.node_id).sort()).toEqual(['{new-repo}/a.ts#alpha', '{new-repo}/b.ts#beta'].sort());

      const config = JSON.parse(fs.readFileSync(path.join(fx.devmindPath, 'config.json'), 'utf-8'));
      expect(config.repos.map((r: any) => r.name).sort()).toEqual(['existing-repo', 'new-repo']);
      const env = fs.readFileSync(path.join(fx.devmindPath, '.env'), 'utf-8');
      expect(env).toMatch(new RegExp(`REPO_NEW_REPO=`));

      // The dedicated scratchpad exists and is scoped; the DEFAULT scratchpad was never created —
      // proof the existing repo's own (nonexistent) index session wasn't touched.
      const scopedPad = readScratchpad(fx.devmindPath, 'add_repo_scratchpad.json');
      expect(scopedPad).not.toBeNull();
      expect(scopedPad!.files_total).toBe(2); // only new-repo's 2 files, not existing-repo's too
      expect(readScratchpad(fx.devmindPath)).toBeNull();
    } finally {
      cleanupCachedDatabases(); // release the server's cached brain.db handle before rm (Windows locks it otherwise)
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('rejects a duplicate repo name and a nonexistent path, writing nothing', async () => {
    const fx = makeStandaloneFixture();
    try {
      const sessionId = await startSession(fx.devmindPath);
      const before = fs.readFileSync(path.join(fx.devmindPath, 'config.json'), 'utf-8');

      const dup = await callTool(harness.client, 'add_repo', {
        devmind_path: fx.devmindPath, session_id: sessionId, name: 'existing-repo', path: fx.newRepoDir
      });
      expect(dup.isError).toBe(true);
      expect(dup.textBlocks.join(' ')).toMatch(/already exists/);

      const badPath = await callTool(harness.client, 'add_repo', {
        devmind_path: fx.devmindPath, session_id: sessionId, name: 'new-repo', path: path.join(fx.root, 'does-not-exist')
      });
      expect(badPath.isError).toBe(true);
      expect(badPath.textBlocks.join(' ')).toMatch(/does not exist/);

      expect(fs.readFileSync(path.join(fx.devmindPath, 'config.json'), 'utf-8')).toBe(before);
    } finally {
      cleanupCachedDatabases(); // release the server's cached brain.db handle before rm (Windows locks it otherwise)
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('index_continue/index_complete stay scoped to the new repo via the returned scratchpad name, and complete correctly', async () => {
    const fx = makeStandaloneFixture();
    try {
      const sessionId = await startSession(fx.devmindPath);
      await callToolJson(harness.client, 'add_repo', {
        devmind_path: fx.devmindPath, session_id: sessionId, name: 'new-repo', path: fx.newRepoDir
      });
      const scratchpad = 'add_repo_scratchpad.json';

      // Both files were already extracted in one batch (tiny fixture) — Phase 1 is done.
      const cont = await callToolJson(harness.client, 'index_continue', {
        devmind_path: fx.devmindPath, session_id: sessionId, scratchpad
      });
      expect(cont.isError).toBe(false);
      expect((cont.parsed as any).message).toMatch(/All files extracted/);

      const complete = await callToolJson(harness.client, 'index_complete', {
        devmind_path: fx.devmindPath, session_id: sessionId, scratchpad
      });
      expect(complete.isError).toBe(false);
      const c = complete.parsed as any;
      expect(c.summary.files_indexed).toBe(2);

      const finalPad = readScratchpad(fx.devmindPath, scratchpad);
      expect(finalPad!.status).toBe('complete');

      // A SECOND add_repo call now sees no in-progress session (previous one completed) — so it
      // requires name/path again rather than trying to "resume" a finished session.
      const again = await callTool(harness.client, 'add_repo', { devmind_path: fx.devmindPath, session_id: sessionId });
      expect(again.isError).toBe(true);
      expect(again.textBlocks.join(' ')).toMatch(/both name and path are required/);
    } finally {
      cleanupCachedDatabases(); // release the server's cached brain.db handle before rm (Windows locks it otherwise)
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('resume: a second add_repo call with no args points at the in-progress session instead of erroring or restarting', async () => {
    const fx = makeStandaloneFixture();
    try {
      const sessionId = await startSession(fx.devmindPath);
      await callToolJson(harness.client, 'add_repo', {
        devmind_path: fx.devmindPath, session_id: sessionId, name: 'new-repo', path: fx.newRepoDir
      });
      // Simulate "still in progress" (this tiny fixture finishes Phase 1 in one call for real).
      const padPath = path.join(fx.devmindPath, 'add_repo_scratchpad.json');
      const pad = JSON.parse(fs.readFileSync(padPath, 'utf-8'));
      fs.writeFileSync(padPath, JSON.stringify({ ...pad, status: 'in_progress' }));

      const resumed = await callToolJson(harness.client, 'add_repo', { devmind_path: fx.devmindPath, session_id: sessionId });
      expect(resumed.isError).toBe(false);
      const r = resumed.parsed as any;
      expect(r.status).toBe('resuming');
      expect(r.repo_name).toBe('new-repo');

      // No second repo was registered — config.json still has exactly the two repos.
      const config = JSON.parse(fs.readFileSync(path.join(fx.devmindPath, 'config.json'), 'utf-8'));
      expect(config.repos).toHaveLength(2);
    } finally {
      cleanupCachedDatabases(); // release the server's cached brain.db handle before rm (Windows locks it otherwise)
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
