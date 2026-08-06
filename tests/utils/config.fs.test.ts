import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findDevmindDir,
  resolveDevmindDir,
  loadProjectContext,
  recoverSpaceSplitPath,
  DevMindConfig
} from '../../src/utils/config';

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-config-test-'));
}

function writeConfig(devmindDir: string, config: DevMindConfig): void {
  fs.mkdirSync(devmindDir, { recursive: true });
  fs.writeFileSync(path.join(devmindDir, 'config.json'), JSON.stringify(config, null, 2));
}

const sampleConfig: DevMindConfig = {
  project_name: 'sample',
  mode: 'embedded',
  repos: [{ name: 'app', relative_path: 'src' }]
};

describe('findDevmindDir', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('finds .devmind immediately in the start dir', () => {
    writeConfig(path.join(dir, '.devmind'), sampleConfig);
    expect(findDevmindDir(dir)).toBe(path.join(dir, '.devmind'));
  });

  it('walks up parent directories to find .devmind', () => {
    writeConfig(path.join(dir, '.devmind'), sampleConfig);
    const nested = path.join(dir, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    expect(findDevmindDir(nested)).toBe(path.join(dir, '.devmind'));
  });

  it('returns null when no .devmind is found walking up to the filesystem root', () => {
    const nested = path.join(dir, 'lonely');
    fs.mkdirSync(nested, { recursive: true });
    expect(findDevmindDir(nested)).toBeNull();
  });
});

describe('resolveDevmindDir', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('resolves an explicit path that contains config.json', () => {
    const devmindDir = path.join(dir, '.devmind');
    writeConfig(devmindDir, sampleConfig);
    expect(resolveDevmindDir(devmindDir)).toBe(path.resolve(devmindDir));
  });

  it('returns null for an explicit path without config.json', () => {
    const devmindDir = path.join(dir, '.devmind');
    fs.mkdirSync(devmindDir, { recursive: true });
    expect(resolveDevmindDir(devmindDir)).toBeNull();
  });

  it('falls back to walking up from process.cwd() when no explicit path is given', () => {
    writeConfig(path.join(dir, '.devmind'), sampleConfig);
    const nested = path.join(dir, 'sub');
    fs.mkdirSync(nested, { recursive: true });
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(nested);
    try {
      expect(resolveDevmindDir()).toBe(path.join(dir, '.devmind'));
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('returns null via the cwd fallback when nothing is found', () => {
    const nested = path.join(dir, 'sub');
    fs.mkdirSync(nested, { recursive: true });
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(nested);
    try {
      expect(resolveDevmindDir()).toBeNull();
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

describe('recoverSpaceSplitPath', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  /** Splits a path the way a shell does when argv is concatenated unquoted: on every space. */
  function splitLikeShell(p: string): { head: string; extras: string[] } {
    const [head, ...extras] = p.split(' ');
    return { head, extras };
  }

  it('rejoins a --path the shell tore apart at a space', () => {
    const devmindDir = path.join(dir, 'work 2', 'devsmind', '.devmind');
    fs.mkdirSync(devmindDir, { recursive: true });
    const { head, extras } = splitLikeShell(devmindDir);
    expect(head).not.toBe(devmindDir); // the fragment the CLI would otherwise bind to
    expect(recoverSpaceSplitPath(head, extras)).toBe(devmindDir);
  });

  it('rejoins across several spaces', () => {
    const devmindDir = path.join(dir, 'a b c d', '.devmind');
    fs.mkdirSync(devmindDir, { recursive: true });
    const { head, extras } = splitLikeShell(devmindDir);
    expect(extras.length).toBe(3);
    expect(recoverSpaceSplitPath(head, extras)).toBe(devmindDir);
  });

  it('prefers the longest existing candidate when a shorter prefix also exists', () => {
    const shorter = path.join(dir, 'a b');
    const longer = path.join(dir, 'a b c');
    fs.mkdirSync(shorter, { recursive: true });
    fs.mkdirSync(longer, { recursive: true });
    const { head, extras } = splitLikeShell(longer);
    expect(recoverSpaceSplitPath(head, extras)).toBe(longer);
  });

  it('leaves an intact path alone even when unrelated operands follow', () => {
    const devmindDir = path.join(dir, '.devmind');
    fs.mkdirSync(devmindDir, { recursive: true });
    expect(recoverSpaceSplitPath(devmindDir, ['--sync'])).toBe(devmindDir);
  });

  it('returns a genuinely bad path unchanged, so it still fails loudly', () => {
    const bogus = path.join(dir, 'nope');
    expect(recoverSpaceSplitPath(bogus, ['also', 'nope'])).toBe(bogus);
  });

  it('passes through when there is nothing to rejoin', () => {
    expect(recoverSpaceSplitPath(undefined, [])).toBeUndefined();
    expect(recoverSpaceSplitPath(undefined, ['x'])).toBeUndefined();
    expect(recoverSpaceSplitPath('', ['x'])).toBe('');
    const only = path.join(dir, 'missing');
    expect(recoverSpaceSplitPath(only, [])).toBe(only);
  });
});

describe('loadProjectContext', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('throws a clear error when config.json is missing', () => {
    expect(() => loadProjectContext(dir)).toThrow(/config\.json not found/);
  });

  it('loads config.json with no .env, leaving developer undefined', () => {
    writeConfig(dir, sampleConfig);
    const ctx = loadProjectContext(dir);
    expect(ctx.config).toEqual(sampleConfig);
    expect(ctx.env).toEqual({});
    expect(ctx.developer).toBeUndefined();
    expect(ctx.devmind_path).toBe(path.resolve(dir));
  });

  it('loads .env and extracts developer name/email when present', () => {
    writeConfig(dir, sampleConfig);
    fs.writeFileSync(path.join(dir, '.env'), 'DEVELOPER_NAME=Ada\nDEVELOPER_EMAIL=ada@example.com\nOTHER=1\n');
    const ctx = loadProjectContext(dir);
    expect(ctx.env.OTHER).toBe('1');
    expect(ctx.developer).toEqual({ name: 'Ada', email: 'ada@example.com' });
  });

  it('leaves developer undefined when DEVELOPER_NAME is absent from .env', () => {
    writeConfig(dir, sampleConfig);
    fs.writeFileSync(path.join(dir, '.env'), 'SOMETHING=else\n');
    const ctx = loadProjectContext(dir);
    expect(ctx.developer).toBeUndefined();
  });

  it('defaults email to empty string when DEVELOPER_NAME is present but DEVELOPER_EMAIL is not', () => {
    writeConfig(dir, sampleConfig);
    fs.writeFileSync(path.join(dir, '.env'), 'DEVELOPER_NAME=Ada\n');
    const ctx = loadProjectContext(dir);
    expect(ctx.developer).toEqual({ name: 'Ada', email: '' });
  });
});
