import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('prompts', () => ({ __esModule: true, default: jest.fn() }));
import prompts from 'prompts';

import { handleSkill } from '../../src/cli/integrations/skill';
import { getTarget } from '../../src/cli/integrations/registry';

const ask = prompts as unknown as jest.Mock;

function answers(...vals: unknown[]): void {
  for (const v of vals) ask.mockResolvedValueOnce(v === undefined ? {} : { v });
}

describe('devsmind skill interactive placement', () => {
  let dir: string;
  let out: string;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let stdoutTTY: boolean | undefined;
  let stdinTTY: boolean | undefined;

  beforeEach(() => {
    ask.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-skill-interactive-'));
    fs.mkdirSync(path.join(dir, '.devmind'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'chosen-project'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.devmind', 'config.json'),
      JSON.stringify({ project_name: 'skill-fixture', mode: 'embedded', repos: [{ name: 'app', relative_path: '.' }] })
    );

    out = '';
    const capture = (...args: unknown[]) => { out += args.join(' ') + '\n'; };
    logSpy = jest.spyOn(console, 'log').mockImplementation(capture);
    errSpy = jest.spyOn(console, 'error').mockImplementation(capture);

    stdoutTTY = process.stdout.isTTY;
    stdinTTY = process.stdin.isTTY;
    (process.stdout as any).isTTY = true;
    (process.stdin as any).isTTY = true;
  });

  afterEach(() => {
    (process.stdout as any).isTTY = stdoutTTY;
    (process.stdin as any).isTTY = stdinTTY;
    logSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('asks for a project root after selecting This project only, like rule and mcp do', async () => {
    const target = getTarget('antigravity')!;
    const projectScope = target.skill.scopes.find(s => s.scope === 'project')!;
    answers(
      target,
      projectScope,
      { action: 'into', dir: 'chosen-project' },
      { action: 'use' },
      true
    );

    await handleSkill({ path: path.join(dir, '.devmind') });

    const chosenSkillPath = path.join(dir, 'chosen-project', '.agents', 'skills', 'devsmind', 'SKILL.md');
    const defaultSkillPath = path.join(dir, '.agents', 'skills', 'devsmind', 'SKILL.md');
    expect(fs.existsSync(chosenSkillPath)).toBe(true);
    expect(fs.existsSync(defaultSkillPath)).toBe(false);
    expect(out).toContain(chosenSkillPath.replace(/\\/g, '/'));
    expect(out).toContain('Where is the project root');
  });
});