import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('prompts', () => ({ __esModule: true, default: jest.fn() }));
import prompts from 'prompts';

jest.mock('../../src/cli/runner', () => ({ runBackgroundIndexing: jest.fn() }));
import { runBackgroundIndexing } from '../../src/cli/runner';

import { handleAddRepo } from '../../src/cli/add-repo';

const ask = prompts as unknown as jest.Mock;
const runIndex = runBackgroundIndexing as jest.Mock;

/** Queue one answer per expected prompt, in order — every prompts() call in prompt.ts uses
 *  `name: 'v'`, so the mocked resolved value must be `{ v: <answer> }` (or `{}` for Esc/cancel). */
function answers(...vals: unknown[]): void {
  for (const v of vals) ask.mockResolvedValueOnce(v === undefined ? {} : { v });
}

function writeStandaloneBrain(repos: { name: string; path_key: string }[] = []): { root: string; devmindDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-add-repo-test-'));
  const devmindDir = path.join(root, '.devsmind');
  fs.mkdirSync(devmindDir, { recursive: true });
  fs.writeFileSync(path.join(devmindDir, 'config.json'), JSON.stringify({
    project_name: 'add-repo-test',
    mode: 'standalone',
    repos
  }, null, 2));
  fs.writeFileSync(path.join(devmindDir, '.env'), 'DEVELOPER_NAME=Test\nDEVELOPER_EMAIL=test@test.com\n');
  return { root, devmindDir };
}

let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

beforeEach(() => {
  ask.mockReset();
  runIndex.mockReset();
  runIndex.mockResolvedValue(undefined);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
});

describe('handleAddRepo', () => {
  it('refuses in embedded mode with a clear error, no prompts asked', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-add-repo-embedded-'));
    const devmindDir = path.join(root, '.devsmind');
    fs.mkdirSync(devmindDir, { recursive: true });
    fs.writeFileSync(path.join(devmindDir, 'config.json'), JSON.stringify({
      project_name: 'embedded-test', mode: 'embedded', repos: [{ name: 'app', relative_path: '.' }]
    }, null, 2));
    fs.writeFileSync(path.join(devmindDir, '.env'), 'DEVELOPER_NAME=Test\nDEVELOPER_EMAIL=test@test.com\n');

    try {
      await expect(handleAddRepo({ path: devmindDir })).rejects.toThrow('process.exit(1)');
      expect(errSpy.mock.calls.join(' ')).toMatch(/only available in standalone mode/);
      expect(ask).not.toHaveBeenCalled();
      expect(runIndex).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fresh flow: prompts name + path, writes config.json and .env, writes a pending marker, and indexes scoped to the new repo', async () => {
    const { root, devmindDir } = writeStandaloneBrain();
    try {
      answers('new-repo', { action: 'use' }); // name prompt, then pickDirectory confirms the start dir
      runIndex.mockImplementation(async (opts: { devmindPath: string; padFile?: string }) => {
        fs.writeFileSync(path.join(opts.devmindPath, opts.padFile!), JSON.stringify({ status: 'complete' }));
      });

      await handleAddRepo({ path: devmindDir });

      const config = JSON.parse(fs.readFileSync(path.join(devmindDir, 'config.json'), 'utf-8'));
      expect(config.repos).toEqual([{ name: 'new-repo', path_key: 'REPO_NEW_REPO' }]);

      const env = fs.readFileSync(path.join(devmindDir, '.env'), 'utf-8');
      expect(env).toMatch(/REPO_NEW_REPO=/);

      expect(runIndex).toHaveBeenCalledTimes(1);
      const callArgs = runIndex.mock.calls[0][0];
      expect(callArgs.repos).toEqual(['new-repo']);
      expect(callArgs.padFile).toBe('add_repo_scratchpad.json');

      // Completed successfully — the pending marker should be cleaned up.
      expect(fs.existsSync(path.join(devmindDir, 'add_repo_pending.json'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a name that already exists in config.json, without writing anything', async () => {
    const { root, devmindDir } = writeStandaloneBrain([{ name: 'existing', path_key: 'REPO_EXISTING' }]);
    try {
      // First answer is rejected by validate(); prompts() itself doesn't re-ask in this mock —
      // simulate a user who cancels (Esc) after seeing the validation message.
      ask.mockImplementationOnce(async (config: { validate?: (v: string) => true | string }) => {
        expect(config.validate!('existing')).toBe('A repo named "existing" already exists in this brain.');
        return {}; // Esc — no `v` key, same as the real `prompts` package on cancel
      });

      await handleAddRepo({ path: devmindDir });

      const config = JSON.parse(fs.readFileSync(path.join(devmindDir, 'config.json'), 'utf-8'));
      expect(config.repos).toEqual([{ name: 'existing', path_key: 'REPO_EXISTING' }]);
      expect(runIndex).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resume flow: a leftover pending marker skips name/path prompts entirely and continues that repo', async () => {
    const { root, devmindDir } = writeStandaloneBrain([{ name: 'in-progress-repo', path_key: 'REPO_IN_PROGRESS_REPO' }]);
    try {
      fs.writeFileSync(path.join(devmindDir, 'add_repo_pending.json'), JSON.stringify({ repo_name: 'in-progress-repo' }));
      runIndex.mockImplementation(async (opts: { devmindPath: string; padFile?: string }) => {
        fs.writeFileSync(path.join(opts.devmindPath, opts.padFile!), JSON.stringify({ status: 'complete' }));
      });

      await handleAddRepo({ path: devmindDir });

      expect(ask).not.toHaveBeenCalled();
      expect(runIndex).toHaveBeenCalledTimes(1);
      expect(runIndex.mock.calls[0][0].repos).toEqual(['in-progress-repo']);
      expect(fs.existsSync(path.join(devmindDir, 'add_repo_pending.json'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the pending marker in place when indexing does not finish (so a later run can resume)', async () => {
    const { root, devmindDir } = writeStandaloneBrain();
    try {
      answers('slow-repo', { action: 'use' });
      runIndex.mockImplementation(async (opts: { devmindPath: string; padFile?: string }) => {
        fs.writeFileSync(path.join(opts.devmindPath, opts.padFile!), JSON.stringify({ status: 'in_progress' }));
      });

      await handleAddRepo({ path: devmindDir });

      expect(fs.existsSync(path.join(devmindDir, 'add_repo_pending.json'))).toBe(true);
      const pending = JSON.parse(fs.readFileSync(path.join(devmindDir, 'add_repo_pending.json'), 'utf-8'));
      expect(pending.repo_name).toBe('slow-repo');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
