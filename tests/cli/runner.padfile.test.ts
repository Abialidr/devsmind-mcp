import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBackgroundIndexing } from '../../src/cli/runner';
import { readScratchpad } from '../../src/db/indexer';

/**
 * `runBackgroundIndexing`'s scoped (`--repos`) runs always started a fresh scratchpad before
 * this change — deliberate, since every ad-hoc `--repos` invocation shares ONE file
 * (`index_scratchpad.scoped.json`), so resuming it blindly could resume the WRONG repo's
 * leftover run. A caller with its OWN dedicated `padFile` (like `devsmind add-repo`) doesn't
 * have that ambiguity, so it should be resumable. `--nodes-only` with no `--describe` skips
 * Phase 3 entirely, so these runs never need real LLM credentials — pure local AST extraction.
 */

function writeStandaloneFixture(): { devmindDir: string; repoADir: string; repoBDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-runner-padfile-'));
  const devmindDir = path.join(root, '.devsmind');
  const repoADir = path.join(root, 'repo-a');
  const repoBDir = path.join(root, 'repo-b');
  fs.mkdirSync(devmindDir, { recursive: true });
  fs.mkdirSync(repoADir, { recursive: true });
  fs.mkdirSync(repoBDir, { recursive: true });

  fs.writeFileSync(path.join(repoADir, 'a.ts'), 'export function fromA() { return 1; }\n');
  fs.writeFileSync(path.join(repoBDir, 'b.ts'), 'export function fromB() { return 2; }\n');

  fs.writeFileSync(path.join(devmindDir, 'config.json'), JSON.stringify({
    project_name: 'padfile-test',
    mode: 'standalone',
    repos: [
      { name: 'repo-a', path_key: 'REPO_REPO_A' },
      { name: 'repo-b', path_key: 'REPO_REPO_B' }
    ]
  }, null, 2));
  fs.writeFileSync(path.join(devmindDir, '.env'),
    `DEVELOPER_NAME=Test\nDEVELOPER_EMAIL=test@test.com\nREPO_REPO_A=${repoADir}\nREPO_REPO_B=${repoBDir}\n`
  );

  return { devmindDir, repoADir, repoBDir };
}

describe('runBackgroundIndexing — scoped scratchpad resumability (padFile)', () => {
  let fx: { devmindDir: string; repoADir: string; repoBDir: string };

  beforeEach(() => {
    fx = writeStandaloneFixture();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(fx.devmindDir), { recursive: true, force: true });
  });

  it('a scoped run with an explicit padFile resumes an in-progress scratchpad instead of restarting', async () => {
    const padFile = 'my_dedicated_scratchpad.json';

    // First call: index repo-a only, nodes-only (no LLM). Completes fully in one call since the
    // fixture is tiny — so simulate "interrupted" by hand-editing the scratchpad back to in_progress
    // with a used-up files_done count that would be WRONG if a second call force-recreated it.
    await runBackgroundIndexing({
      devmindPath: fx.devmindDir,
      provider: 'ollama',
      repos: ['repo-a'],
      nodesOnly: true,
      padFile
    });

    const padPath = path.join(fx.devmindDir, padFile);
    const completedPad = JSON.parse(fs.readFileSync(padPath, 'utf-8'));
    expect(completedPad.status).toBe('complete');

    // Force it back to in_progress with an implausible files_total that only survives if the
    // second call actually READS this scratchpad rather than recreating one from a fresh scan.
    fs.writeFileSync(padPath, JSON.stringify({ ...completedPad, status: 'in_progress', files_total: 999999 }, null, 2));

    await runBackgroundIndexing({
      devmindPath: fx.devmindDir,
      provider: 'ollama',
      repos: ['repo-a'],
      nodesOnly: true,
      padFile
    });

    // If the run had force-recreated the scratchpad, files_total would be reset to the real
    // scan count (1) instead of staying at the implausible sentinel — proving it resumed the
    // existing (forced in_progress) pad rather than starting over. It then runs Phase 1 to
    // completion again on the same tiny fixture and marks it complete.
    const secondPad = JSON.parse(fs.readFileSync(padPath, 'utf-8'));
    expect(secondPad.files_total).toBe(999999);
    expect(secondPad.status).toBe('complete');
  });

  it('a scoped run with NO explicit padFile still always starts fresh (unchanged default behavior)', async () => {
    const defaultScopedFile = 'index_scratchpad.scoped.json';

    await runBackgroundIndexing({
      devmindPath: fx.devmindDir,
      provider: 'ollama',
      repos: ['repo-a'],
      nodesOnly: true
    });

    const padPath = path.join(fx.devmindDir, defaultScopedFile);
    const completedPad = JSON.parse(fs.readFileSync(padPath, 'utf-8'));
    expect(completedPad.status).toBe('complete');

    // Same tamper as above, but WITHOUT an explicit padFile this time.
    fs.writeFileSync(padPath, JSON.stringify({ ...completedPad, status: 'in_progress', files_total: 999999 }, null, 2));

    await runBackgroundIndexing({
      devmindPath: fx.devmindDir,
      provider: 'ollama',
      repos: ['repo-b'],
      nodesOnly: true
    });

    // A DIFFERENT repo (repo-b) scoped run must not resume repo-a's leftover state — confirms
    // the shared default file still force-recreates every time, exactly as before this change.
    const secondPad = JSON.parse(fs.readFileSync(padPath, 'utf-8'));
    expect(secondPad.files_total).not.toBe(999999);
    expect(secondPad.status).toBe('complete');
  });

  it('readScratchpad with a custom fileName reads the same dedicated file runBackgroundIndexing wrote', async () => {
    const padFile = 'add_repo_scratchpad.json';
    await runBackgroundIndexing({
      devmindPath: fx.devmindDir,
      provider: 'ollama',
      repos: ['repo-b'],
      nodesOnly: true,
      padFile
    });

    const pad = readScratchpad(fx.devmindDir, padFile);
    expect(pad).not.toBeNull();
    expect(pad!.status).toBe('complete');
    expect(pad!.current_repo).toBe('repo-b');
  });
});
