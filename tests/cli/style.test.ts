import * as fs from 'fs';
import * as path from 'path';
import { handleStyle } from '../../src/cli/style';
import { makeFixture } from '../helpers/fixture';
import { RESPONSE_STYLE_ENV_KEY, resolveResponseStyle } from '../../src/utils/response-style';

describe('devsmind style', () => {
  let fx: ReturnType<typeof makeFixture>;
  let out: string;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  const saved = process.env[RESPONSE_STYLE_ENV_KEY];

  beforeEach(() => {
    delete process.env[RESPONSE_STYLE_ENV_KEY];
    fx = makeFixture();
    out = '';
    logSpy = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out += a.join(' ') + '\n'; });
    errSpy = jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out += a.join(' ') + '\n'; });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (saved === undefined) delete process.env[RESPONSE_STYLE_ENV_KEY];
    else process.env[RESPONSE_STYLE_ENV_KEY] = saved;
    fx.cleanup();
  });

  it('with no argument, shows the current style and every choice', async () => {
    await handleStyle(undefined, { path: fx.devmindPath });
    expect(out).toContain('Response style: normal');
    for (const s of ['normal', 'lite', 'full']) expect(out).toContain(s);
    expect(out).toMatch(/caveman/);
  });

  it.each([['full', 'full'], ['caveman', 'full'], ['on', 'full'], ['lite', 'lite']])('sets %s', async (input, expected) => {
    await handleStyle(input, { path: fx.devmindPath });
    expect(resolveResponseStyle(fx.devmindPath, {})).toBe(expected);
    expect(out).toContain(`Response style: ${expected}`);
    // Personal: lives in the gitignored .env, never the shared config.json.
    expect(fs.readFileSync(path.join(fx.devmindPath, '.env'), 'utf-8')).toContain(`${RESPONSE_STYLE_ENV_KEY}=${expected}`);
    expect(fs.readFileSync(path.join(fx.devmindPath, 'config.json'), 'utf-8')).not.toContain('response_style');
  });

  it('off puts it back and the status reflects it', async () => {
    await handleStyle('full', { path: fx.devmindPath });
    await handleStyle('off', { path: fx.devmindPath });
    expect(resolveResponseStyle(fx.devmindPath, {})).toBe('normal');
    out = '';
    await handleStyle(undefined, { path: fx.devmindPath });
    expect(out).toContain('Response style: normal');
  });

  it('rejects an unknown level without writing anything', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    try {
      await expect(handleStyle('shouty', { path: fx.devmindPath })).rejects.toThrow('exit');
    } finally {
      exit.mockRestore();
    }
    expect(out).toContain('Unknown style "shouty"');
    expect(fs.existsSync(path.join(fx.devmindPath, '.env'))).toBe(false);
  });

  it('says so when the process environment will override what was just saved', async () => {
    process.env[RESPONSE_STYLE_ENV_KEY] = 'lite';
    await handleStyle('full', { path: fx.devmindPath });
    expect(out).toMatch(/overrides this/);
  });
});
