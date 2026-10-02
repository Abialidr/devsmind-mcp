jest.mock('prompts', () => ({ __esModule: true, default: jest.fn() }));
import prompts from 'prompts';

import { handleMemory } from '../../src/cli/integrations/memory';

const ask = prompts as unknown as jest.Mock;

function answers(...vals: unknown[]): void {
  for (const v of vals) ask.mockResolvedValueOnce(v === undefined ? {} : { v });
}

describe('devsmind memory interactive Codex setup', () => {
  let out: string;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    ask.mockReset();
    out = '';
    const capture = (...args: unknown[]) => { out += args.join(' ') + '\n'; };
    logSpy = jest.spyOn(console, 'log').mockImplementation(capture);
    errSpy = jest.spyOn(console, 'error').mockImplementation(capture);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('asks the user to confirm Codex memories are enabled before printing the pasteable prompt', async () => {
    answers(true);

    await handleMemory({ tool: 'codex' });

    expect(out).toContain('Codex memory setup');
    expect(out).toContain('Enable memories');
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'confirm',
      message: 'Have you enabled Codex memories now?',
      initial: true,
    }));
    expect(out).toContain('Please remember');
  });

  it('does not print the pasteable prompt if the user has not enabled Codex memories yet', async () => {
    answers(false);

    await handleMemory({ tool: 'codex' });

    expect(out).toContain('Enable Codex memories first');
    expect(out).not.toContain('Please remember');
  });
});
