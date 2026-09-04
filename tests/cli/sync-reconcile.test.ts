import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('prompts', () => ({ __esModule: true, default: jest.fn() }));
import prompts from 'prompts';

jest.mock('../../src/cli/rule', () => ({ handleRule: jest.fn() }));
jest.mock('../../src/cli/integrations/skill', () => ({ handleSkill: jest.fn() }));
import { handleRule } from '../../src/cli/rule';
import { handleSkill } from '../../src/cli/integrations/skill';

import { reconcileRepoPaths } from '../../src/cli/sync';

const ask = prompts as unknown as jest.Mock;
const mockRule = handleRule as jest.Mock;
const mockSkill = handleSkill as jest.Mock;

/** Queue one answer per expected prompt — every prompts() call in prompt.ts uses `name: 'v'`. */
function answers(...vals: unknown[]): void {
  for (const v of vals) ask.mockResolvedValueOnce(v === undefined ? {} : { v });
}

function writeStandaloneBrain(repos: { name: string; path_key: string }[], env: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-reconcile-test-'));
  const devmindDir = path.join(root, '.devsmind');
  fs.mkdirSync(devmindDir, { recursive: true });
  fs.writeFileSync(path.join(devmindDir, 'config.json'), JSON.stringify({
    project_name: 'reconcile-test', mode: 'standalone', repos
  }, null, 2));
  const envLines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(path.join(devmindDir, '.env'), envLines.join('\n') + '\n');
  return devmindDir;
}

let logSpy: jest.SpyInstance;
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  ask.mockReset();
  mockRule.mockReset().mockResolvedValue(undefined);
  mockSkill.mockReset().mockResolvedValue(undefined);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  originalIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
});
afterEach(() => {
  logSpy.mockRestore();
  Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
});

describe('reconcileRepoPaths', () => {
  it('is a complete no-op when every repo already has a valid .env path — no prompts, no rule/skill calls', async () => {
    const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-reconcile-existing-'));
    try {
      const devmindDir = writeStandaloneBrain(
        [{ name: 'repo-a', path_key: 'REPO_A' }],
        { REPO_A: existing }
      );
      try {
        await reconcileRepoPaths(devmindDir);
        expect(ask).not.toHaveBeenCalled();
        expect(mockRule).not.toHaveBeenCalled();
        expect(mockSkill).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(path.dirname(devmindDir), { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(existing, { recursive: true, force: true });
    }
  });

  it('is a no-op in embedded mode regardless of .env state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-reconcile-embedded-'));
    const devmindDir = path.join(root, '.devsmind');
    fs.mkdirSync(devmindDir, { recursive: true });
    fs.writeFileSync(path.join(devmindDir, 'config.json'), JSON.stringify({
      project_name: 'x', mode: 'embedded', repos: [{ name: 'app', relative_path: '.' }]
    }, null, 2));
    try {
      await reconcileRepoPaths(devmindDir);
      expect(ask).not.toHaveBeenCalled();
      expect(mockRule).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('non-TTY: prints a warning and skips the prompt/rule/skill walkthrough entirely', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const devmindDir = writeStandaloneBrain([{ name: 'repo-a', path_key: 'REPO_A' }], {});
    try {
      await reconcileRepoPaths(devmindDir);
      expect(ask).not.toHaveBeenCalled();
      expect(mockRule).not.toHaveBeenCalled();
      expect(mockSkill).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Non-interactive session/);
    } finally {
      fs.rmSync(path.dirname(devmindDir), { recursive: true, force: true });
    }
  });

  it('missing repo path: prompts for it, writes .env, then walks rule/skill once each when confirmed', async () => {
    const devmindDir = writeStandaloneBrain([{ name: 'repo-a', path_key: 'REPO_A' }], {});
    const newLocalPath = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-reconcile-newpath-'));
    try {
      answers(
        'browse',            // "Browse for its local folder" vs "Skip"
        { action: 'use' },  // browseForDir's pickDirectory confirms the starting folder for repo-a
        true,                // "Update devsmind rule for a tool now?" -> yes
        false,               // "Update the rule for another tool too?" -> no
        true,                // "Update devsmind skill for a tool now?" -> yes
        false                // "Update the skill for another tool too?" -> no
      );

      // browseForDir's pickDirectory starts at process.cwd() by default, so make its "use current
      // folder" answer resolve to something real and known: chdir isn't practical mid-test, so
      // just accept whatever it resolves to and confirm .env got exactly one new entry instead.
      await reconcileRepoPaths(devmindDir);

      const env = fs.readFileSync(path.join(devmindDir, '.env'), 'utf-8');
      expect(env).toMatch(/REPO_A=/);
      expect(mockRule).toHaveBeenCalledTimes(1);
      expect(mockRule).toHaveBeenCalledWith({ path: devmindDir });
      expect(mockSkill).toHaveBeenCalledTimes(1);
      expect(mockSkill).toHaveBeenCalledWith({ path: devmindDir });
    } finally {
      fs.rmSync(path.dirname(devmindDir), { recursive: true, force: true });
      fs.rmSync(newLocalPath, { recursive: true, force: true });
    }
  });

  it('loops rule/skill for multiple tools when the user keeps confirming "another"', async () => {
    const devmindDir = writeStandaloneBrain([{ name: 'repo-a', path_key: 'REPO_A' }], {});
    try {
      answers(
        'browse',
        { action: 'use' },
        true, true, false,   // rule: yes, another, no
        true, true, true, false // skill: yes, another, another, no
      );

      await reconcileRepoPaths(devmindDir);

      expect(mockRule).toHaveBeenCalledTimes(2);
      expect(mockSkill).toHaveBeenCalledTimes(3);
    } finally {
      fs.rmSync(path.dirname(devmindDir), { recursive: true, force: true });
    }
  });

  it('declining both rule and skill updates still writes the resolved .env path', async () => {
    const devmindDir = writeStandaloneBrain([{ name: 'repo-a', path_key: 'REPO_A' }], {});
    try {
      answers(
        'browse',
        { action: 'use' },
        false, // rule: no
        false  // skill: no
      );

      await reconcileRepoPaths(devmindDir);

      const env = fs.readFileSync(path.join(devmindDir, '.env'), 'utf-8');
      expect(env).toMatch(/REPO_A=/);
      expect(mockRule).not.toHaveBeenCalled();
      expect(mockSkill).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(path.dirname(devmindDir), { recursive: true, force: true });
    }
  });

  it('an invalid (stale) path is re-prompted and replaced, preserving other already-valid entries', async () => {
    const goodRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-reconcile-good-'));
    try {
      const devmindDir = writeStandaloneBrain(
        [
          { name: 'repo-a', path_key: 'REPO_A' },
          { name: 'repo-b', path_key: 'REPO_B' }
        ],
        { REPO_A: goodRepo, REPO_B: path.join(goodRepo, 'gone') }
      );
      try {
        answers('browse', { action: 'use' }, false, false);

        await reconcileRepoPaths(devmindDir);

        const env = fs.readFileSync(path.join(devmindDir, '.env'), 'utf-8');
        expect(env).toMatch(new RegExp(`REPO_A=${goodRepo.replace(/\\/g, '\\\\')}`));
        expect(env).toMatch(/REPO_B=/);
        expect(env).not.toMatch(/gone/);
      } finally {
        fs.rmSync(path.dirname(devmindDir), { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(goodRepo, { recursive: true, force: true });
    }
  });

  // The counterpart to `devsmind init`, which DOES re-offer a skipped repo. Sync must not: it
  // runs routinely, and a developer working in one repo out of a dozen would answer eleven
  // prompts on every single sync — the exact friction the marker exists to remove.
  it('never re-prompts for a repo already marked skipped, however many times it runs', async () => {
    const devmindDir = writeStandaloneBrain(
      [{ name: 'mobile-only', path_key: 'REPO_MOBILE_ONLY' }],
      { REPO_MOBILE_ONLY: '__skip__' }
    );
    try {
      await reconcileRepoPaths(devmindDir);

      // Nothing was asked at all — not the path, not rule, not skill.
      expect(ask).not.toHaveBeenCalled();
      // ...and the marker survived the run rather than being dropped as "missing".
      expect(fs.readFileSync(path.join(devmindDir, '.env'), 'utf-8')).toMatch(/REPO_MOBILE_ONLY=__skip__/);
    } finally {
      fs.rmSync(devmindDir, { recursive: true, force: true });
    }
  });

  it('choosing "skip" writes the marker and never invokes the folder browser', async () => {
    const devmindDir = writeStandaloneBrain([{ name: 'mobile-only', path_key: 'REPO_MOBILE_ONLY' }], {});
    try {
      answers(
        'skip',
        false, // rule: no
        false  // skill: no
      );

      await reconcileRepoPaths(devmindDir);

      const env = fs.readFileSync(path.join(devmindDir, '.env'), 'utf-8');
      expect(env).toMatch(/REPO_MOBILE_ONLY=__skip__/);
      // Only 3 prompts total (skip choice + rule + skill) — no folder-navigator prompt in between.
      expect(ask).toHaveBeenCalledTimes(3);
    } finally {
      fs.rmSync(path.dirname(devmindDir), { recursive: true, force: true });
    }
  });

  it('a repo already marked skipped is not re-prompted on a later reconcile', async () => {
    // The whole point: a mobile developer answers "skip" once for each backend repo, and never
    // sees them again — this is what makes that durable across every future sync/pull.
    const devmindDir = writeStandaloneBrain(
      [
        { name: 'mobile-only', path_key: 'REPO_MOBILE_ONLY' },
        { name: 'newly-added', path_key: 'REPO_NEW' }
      ],
      { REPO_MOBILE_ONLY: '__skip__' }
    );
    try {
      answers(
        'browse', { action: 'use' }, // only the genuinely missing repo gets prompted
        false, false
      );

      await reconcileRepoPaths(devmindDir);

      const env = fs.readFileSync(path.join(devmindDir, '.env'), 'utf-8');
      expect(env).toMatch(/REPO_MOBILE_ONLY=__skip__/); // marker survives the rewrite
      expect(env).toMatch(/REPO_NEW=/);
    } finally {
      fs.rmSync(path.dirname(devmindDir), { recursive: true, force: true });
    }
  });
});
