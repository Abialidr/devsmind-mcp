import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findDevmindDir,
  findBrainDir,
  resolveBrainDir,
  brainDirOrDefault,
  resolveDevmindDir,
  loadProjectContext,
  recoverSpaceSplitPath,
  BRAIN_DIR_NAME,
  LEGACY_BRAIN_DIR_NAME,
  BRAIN_DIR_NAMES,
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

// ── 4.2.0: `.devsmind` is the created name, `.devmind` is read forever ───────────────────────
//
// The whole rename rests on one claim: a brain resolves identically under either name, from every
// entry point. These are the tests for the resolver every entry point now calls — if they hold,
// an existing `.devmind/` brain cannot be orphaned by the rename, and a new `.devsmind/` one
// cannot be missed.
describe('brain directory name resolution (4.2.0 rename)', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('exposes the two names in lookup order — current first, legacy second', () => {
    expect(BRAIN_DIR_NAME).toBe('.devsmind');
    expect(LEGACY_BRAIN_DIR_NAME).toBe('.devmind');
    expect(BRAIN_DIR_NAMES).toEqual(['.devsmind', '.devmind']);
  });

  describe('resolveBrainDir', () => {
    it('finds a .devsmind brain', () => {
      writeConfig(path.join(dir, '.devsmind'), sampleConfig);
      expect(resolveBrainDir(dir)).toBe(path.join(dir, '.devsmind'));
    });

    it('finds a legacy .devmind brain — an existing brain is never orphaned', () => {
      writeConfig(path.join(dir, '.devmind'), sampleConfig);
      expect(resolveBrainDir(dir)).toBe(path.join(dir, '.devmind'));
    });

    it('prefers .devsmind when both exist', () => {
      writeConfig(path.join(dir, '.devmind'), sampleConfig);
      writeConfig(path.join(dir, '.devsmind'), sampleConfig);
      expect(resolveBrainDir(dir)).toBe(path.join(dir, '.devsmind'));
    });

    it('ignores a directory with no config.json, so an empty leftover cannot shadow the real brain', () => {
      fs.mkdirSync(path.join(dir, '.devsmind'), { recursive: true });
      writeConfig(path.join(dir, '.devmind'), sampleConfig);
      expect(resolveBrainDir(dir)).toBe(path.join(dir, '.devmind'));
    });

    it('returns null when neither name is present', () => {
      expect(resolveBrainDir(dir)).toBeNull();
    });

    it('does NOT walk up — it answers only about the directory it was given', () => {
      writeConfig(path.join(dir, '.devsmind'), sampleConfig);
      const nested = path.join(dir, 'a', 'b');
      fs.mkdirSync(nested, { recursive: true });
      expect(resolveBrainDir(nested)).toBeNull();
    });
  });

  describe('findBrainDir', () => {
    it('walks up to a legacy .devmind brain', () => {
      writeConfig(path.join(dir, '.devmind'), sampleConfig);
      const nested = path.join(dir, 'a', 'b', 'c');
      fs.mkdirSync(nested, { recursive: true });
      expect(findBrainDir(nested)).toBe(path.join(dir, '.devmind'));
    });

    it('walks up to a .devsmind brain', () => {
      writeConfig(path.join(dir, '.devsmind'), sampleConfig);
      const nested = path.join(dir, 'a', 'b', 'c');
      fs.mkdirSync(nested, { recursive: true });
      expect(findBrainDir(nested)).toBe(path.join(dir, '.devsmind'));
    });

    it('takes the NEAREST brain, even when the far one uses the current name', () => {
      // Both names are tried at each level before moving up, so a nested legacy brain still wins
      // over a `.devsmind` further up — "my project's brain" means the closest one.
      writeConfig(path.join(dir, '.devsmind'), sampleConfig);
      const inner = path.join(dir, 'sub');
      writeConfig(path.join(inner, '.devmind'), sampleConfig);
      const nested = path.join(inner, 'a', 'b');
      fs.mkdirSync(nested, { recursive: true });
      expect(findBrainDir(nested)).toBe(path.join(inner, '.devmind'));
    });

    it('returns null walking up to the filesystem root with no brain anywhere', () => {
      const nested = path.join(dir, 'lonely');
      fs.mkdirSync(nested, { recursive: true });
      expect(findBrainDir(nested)).toBeNull();
    });

    it('is what the deprecated findDevmindDir alias resolves to', () => {
      expect(findDevmindDir).toBe(findBrainDir);
    });
  });

  describe('brainDirOrDefault', () => {
    it('returns an existing .devsmind brain', () => {
      writeConfig(path.join(dir, '.devsmind'), sampleConfig);
      expect(brainDirOrDefault(dir)).toBe(path.join(dir, '.devsmind'));
    });

    it('returns an existing legacy .devmind brain', () => {
      writeConfig(path.join(dir, '.devmind'), sampleConfig);
      expect(brainDirOrDefault(dir)).toBe(path.join(dir, '.devmind'));
    });

    it('falls back to the CURRENT name when there is no brain yet', () => {
      // Never the legacy name: a fresh project would be pointed at a directory that will never
      // exist. This is the value the web-view routes and the CLI `--path` defaults hand onward.
      expect(brainDirOrDefault(dir)).toBe(path.join(dir, '.devsmind'));
    });

    it('always returns an absolute path, even from a relative input', () => {
      const result = brainDirOrDefault('.');
      expect(path.isAbsolute(result)).toBe(true);
    });
  });

  it('resolveDevmindDir auto-detect finds a legacy brain by walking up', () => {
    writeConfig(path.join(dir, '.devmind'), sampleConfig);
    const nested = path.join(dir, 'a');
    fs.mkdirSync(nested, { recursive: true });
    const spy = jest.spyOn(process, 'cwd').mockReturnValue(nested);
    try {
      expect(resolveDevmindDir()).toBe(path.join(dir, '.devmind'));
    } finally {
      spy.mockRestore();
    }
  });

  it('resolveDevmindDir auto-detect finds a .devsmind brain by walking up', () => {
    writeConfig(path.join(dir, '.devsmind'), sampleConfig);
    const nested = path.join(dir, 'a');
    fs.mkdirSync(nested, { recursive: true });
    const spy = jest.spyOn(process, 'cwd').mockReturnValue(nested);
    try {
      expect(resolveDevmindDir()).toBe(path.join(dir, '.devsmind'));
    } finally {
      spy.mockRestore();
    }
  });
});

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
