import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  mergeRuleFile,
  mergeMcpConfig,
  writeConfigFile,
  RULE_START,
  RULE_END,
} from '../../src/cli/integrations/prompt';
import {
  TARGETS,
  getTarget,
  resolveOsPath,
  resolveScopeFile,
  stdioEntry,
  httpEntry,
  EntryContext,
} from '../../src/cli/integrations/registry';
import { buildRule } from '../../src/cli/rule';
import { DevMindConfig } from '../../src/utils/config';

/**
 * This is the half of `devsmind rule` / `mcp` / `memory` that touches files the DEVELOPER owns —
 * a Cursor rules file, `AGENTS.md`, `~/.codex/config.toml`, `MEMORY.md`. The prompts above it
 * can't be driven from a test, but everything below them is pure enough to exercise directly,
 * and it's the part where a bug is silent: it doesn't fail, it mangles a config someone wrote.
 */

const CONFIG: DevMindConfig = {
  project_name: 'Placement',
  mode: 'embedded',
  tech_stack: { languages: ['TypeScript'], frameworks: [] },
  environments: {},
  repos: [{ name: 'app', relative_path: '.' }],
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-placement-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = (name: string) => path.join(dir, name);
const write = (name: string, content: string) => {
  fs.mkdirSync(path.dirname(file(name)), { recursive: true });
  fs.writeFileSync(file(name), content, 'utf-8');
  return file(name);
};

// ── mergeRuleFile: standalone ────────────────────────────────────────────────

describe('mergeRuleFile — standalone (a file dedicated to DevsMind)', () => {
  it('creates the file and reports it did not exist', () => {
    const res = mergeRuleFile(file('rule.md'), 'RULE BODY', 'standalone');

    expect(res.existed).toBe(false);
    expect(res.content).toBe('RULE BODY\n');
    expect(res.error).toBeUndefined();
  });

  it('normalizes to exactly one trailing newline, however the body ended', () => {
    for (const body of ['RULE', 'RULE\n', 'RULE\n\n\n']) {
      expect(mergeRuleFile(file('r.md'), body, 'standalone').content).toBe('RULE\n');
    }
  });

  it('overwrites a dedicated file wholesale — it is ours, not shared', () => {
    write('rule.md', 'STALE RULE FROM AN OLDER VERSION\n');

    const res = mergeRuleFile(file('rule.md'), 'NEW RULE', 'standalone');

    expect(res.existed).toBe(true);
    expect(res.content).toBe('NEW RULE\n');
    expect(res.content).not.toContain('STALE');
  });

  it('applies a tool-specific wrapper (e.g. Cursor .mdc frontmatter) around the body', () => {
    const wrap = (b: string) => `---\nalwaysApply: true\n---\n\n${b}\n`;

    const res = mergeRuleFile(file('r.mdc'), 'RULE', 'standalone', wrap);

    expect(res.content.startsWith('---\n')).toBe(true);
    expect(res.content).toContain('alwaysApply: true');
    expect(res.content).toContain('RULE');
    expect(res.content.endsWith('\n')).toBe(true);
    expect(res.content.endsWith('\n\n')).toBe(false);
  });
});

// ── mergeRuleFile: append-section ────────────────────────────────────────────

describe('mergeRuleFile — append-section (merging into a file the developer owns)', () => {
  const USER_CONTENT = [
    '# My project rules',
    '',
    'Always run the linter before committing.',
    '',
  ].join('\n');

  it('appends a delimited block, leaving the existing content untouched', () => {
    write('AGENTS.md', USER_CONTENT);

    const res = mergeRuleFile(file('AGENTS.md'), 'RULE', 'append-section');

    expect(res.existed).toBe(true);
    expect(res.content.startsWith('# My project rules')).toBe(true);
    expect(res.content).toContain('Always run the linter before committing.');
    expect(res.content).toContain(`${RULE_START}\nRULE\n${RULE_END}`);
  });

  it('replaces a prior block IN PLACE on re-run, rather than stacking a second one', () => {
    write('AGENTS.md', USER_CONTENT);
    const first = mergeRuleFile(file('AGENTS.md'), 'RULE v1', 'append-section');
    write('AGENTS.md', first.content);

    const second = mergeRuleFile(file('AGENTS.md'), 'RULE v2', 'append-section');

    expect(second.content).toContain('RULE v2');
    expect(second.content).not.toContain('RULE v1');
    expect(second.content.match(new RegExp(RULE_START, 'g'))).toHaveLength(1);
    expect(second.content.match(new RegExp(RULE_END, 'g'))).toHaveLength(1);
  });

  it('keeps the developer\'s lines on BOTH sides of the block', () => {
    write('AGENTS.md', `BEFORE\n\n${RULE_START}\nold\n${RULE_END}\n\nAFTER\n`);

    const res = mergeRuleFile(file('AGENTS.md'), 'new', 'append-section');

    expect(res.content).toContain('BEFORE');
    expect(res.content).toContain('AFTER');
    expect(res.content).toContain('new');
    expect(res.content).not.toContain('old');
    // Order preserved — the block didn't migrate to the end of the file.
    expect(res.content.indexOf('BEFORE')).toBeLessThan(res.content.indexOf('new'));
    expect(res.content.indexOf('new')).toBeLessThan(res.content.indexOf('AFTER'));
  });

  it('is idempotent — merging the same rule twice changes nothing the second time', () => {
    write('AGENTS.md', USER_CONTENT);
    const once = mergeRuleFile(file('AGENTS.md'), 'RULE', 'append-section');
    write('AGENTS.md', once.content);

    const twice = mergeRuleFile(file('AGENTS.md'), 'RULE', 'append-section');

    expect(twice.content).toBe(once.content);
  });

  it('creates the file with just the block when it does not exist yet', () => {
    const res = mergeRuleFile(file('nested/AGENTS.md'), 'RULE', 'append-section');

    expect(res.existed).toBe(false);
    expect(res.content).toBe(`${RULE_START}\nRULE\n${RULE_END}\n`);
  });

  // The safety valve: a half-written or hand-edited block must not be "fixed" by appending
  // a fresh one, or the orphaned marker survives forever and the file grows every run.
  it('refuses to write when a start marker has no matching end', () => {
    write('AGENTS.md', `KEEP ME\n\n${RULE_START}\nhalf-written`);
    const before = fs.readFileSync(file('AGENTS.md'), 'utf-8');

    const res = mergeRuleFile(file('AGENTS.md'), 'RULE', 'append-section');

    expect(res.error).toMatch(/looks corrupted/);
    expect(res.error).toContain('AGENTS.md');
    expect(res.content).toBe(before); // caller must not write this — it's the file as-is
    expect(res.preview).toBe('');
  });

  it('refuses when the end marker appears BEFORE the start marker', () => {
    write('AGENTS.md', `${RULE_END}\nscrambled\n${RULE_START}\n`);

    const res = mergeRuleFile(file('AGENTS.md'), 'RULE', 'append-section');

    expect(res.error).toMatch(/looks corrupted/);
  });

  it('does not reflow or reindent the developer\'s formatting', () => {
    const fussy = ['# Rules', '', '   indented line', '\t\ttabbed line', '', ''].join('\n');
    write('AGENTS.md', fussy);

    const res = mergeRuleFile(file('AGENTS.md'), 'RULE', 'append-section');

    expect(res.content).toContain('   indented line');
    expect(res.content).toContain('\t\ttabbed line');
  });

  it('reads an unreadable existing path as empty rather than throwing', () => {
    // A directory where a file is expected: readFileSync throws, and the merge degrades
    // to "no prior block" instead of taking the whole command down.
    fs.mkdirSync(file('AGENTS.md'));

    const res = mergeRuleFile(file('AGENTS.md'), 'RULE', 'append-section');

    expect(res.existed).toBe(true);
    expect(res.content).toContain('RULE');
    expect(res.error).toBeUndefined();
  });
});

// ── mergeMcpConfig: JSON ─────────────────────────────────────────────────────

describe('mergeMcpConfig — JSON', () => {
  const ENTRY = { type: 'http', url: 'http://localhost:4513/mcp' };

  it('creates the nested server map when the file does not exist', () => {
    const res = mergeMcpConfig(file('mcp.json'), 'json', ['mcpServers'], 'devsmind', ENTRY);

    expect(res.existed).toBe(false);
    expect(JSON.parse(res.content)).toEqual({ mcpServers: { devsmind: ENTRY } });
  });

  it('never clobbers another tool\'s servers — the whole point of merging', () => {
    write('mcp.json', JSON.stringify({ mcpServers: { other: { url: 'http://x' } }, unrelatedTopLevel: 1 }));

    const res = mergeMcpConfig(file('mcp.json'), 'json', ['mcpServers'], 'devsmind', ENTRY);
    const parsed = JSON.parse(res.content);

    expect(parsed.mcpServers.other).toEqual({ url: 'http://x' });
    expect(parsed.mcpServers.devsmind).toEqual(ENTRY);
    expect(parsed.unrelatedTopLevel).toBe(1);
  });

  it('replaces our own prior entry instead of duplicating it', () => {
    write('mcp.json', JSON.stringify({ mcpServers: { devsmind: { url: 'http://stale' } } }));

    const parsed = JSON.parse(
      mergeMcpConfig(file('mcp.json'), 'json', ['mcpServers'], 'devsmind', ENTRY).content
    );

    expect(parsed.mcpServers.devsmind).toEqual(ENTRY);
    expect(Object.keys(parsed.mcpServers)).toEqual(['devsmind']);
  });

  it('walks and creates a deeper server map path', () => {
    const res = mergeMcpConfig(file('s.json'), 'json', ['a', 'b', 'servers'], 'devsmind', ENTRY);

    expect(JSON.parse(res.content).a.b.servers.devsmind).toEqual(ENTRY);
  });

  it.each([
    ['a string', '"not an object"'],
    ['an array', '[1,2]'],
    ['null', 'null'],
  ])('replaces a %s sitting where the server map belongs, rather than crashing', (_label, bad) => {
    write('mcp.json', `{"mcpServers": ${bad}}`);

    const res = mergeMcpConfig(file('mcp.json'), 'json', ['mcpServers'], 'devsmind', ENTRY);

    expect(JSON.parse(res.content).mcpServers.devsmind).toEqual(ENTRY);
  });

  it('treats an empty file as an empty object', () => {
    write('mcp.json', '   \n');

    const res = mergeMcpConfig(file('mcp.json'), 'json', ['mcpServers'], 'devsmind', ENTRY);

    expect(JSON.parse(res.content).mcpServers.devsmind).toEqual(ENTRY);
  });

  it('throws a fixable message on malformed JSON rather than overwriting it', () => {
    write('mcp.json', '{ this is not json');

    expect(() => mergeMcpConfig(file('mcp.json'), 'json', ['mcpServers'], 'devsmind', ENTRY))
      .toThrow(/not valid JSON/);
    // The bad file is still there for the user to fix — nothing was written.
    expect(fs.readFileSync(file('mcp.json'), 'utf-8')).toBe('{ this is not json');
  });

  it('emits a trailing newline so the file is not concatenated onto by other tools', () => {
    expect(mergeMcpConfig(file('m.json'), 'json', ['mcpServers'], 'devsmind', ENTRY).content)
      .toMatch(/\n$/);
  });
});

// ── mergeMcpConfig: TOML (Codex) ─────────────────────────────────────────────

describe('mergeMcpConfig — TOML', () => {
  const STDIO = { command: 'devsmind', args: ['start', '--stdio', '--path', 'C:/my brain/.devmind'] };

  it('renders a dotted table header for a new file', () => {
    const res = mergeMcpConfig(file('config.toml'), 'toml', ['mcp_servers'], 'devsmind', STDIO);

    expect(res.existed).toBe(false);
    expect(res.content).toContain('[mcp_servers.devsmind]');
    expect(res.content).toContain('command = "devsmind"');
    expect(res.content).toContain('args = ["start", "--stdio", "--path", "C:/my brain/.devmind"]');
  });

  it('preserves unrelated tables above and below ours', () => {
    write('config.toml', [
      'model = "gpt-5"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
      '[tui]',
      'theme = "dark"',
      '',
    ].join('\n'));

    const res = mergeMcpConfig(file('config.toml'), 'toml', ['mcp_servers'], 'devsmind', STDIO);

    expect(res.content).toContain('model = "gpt-5"');
    expect(res.content).toContain('[mcp_servers.other]');
    expect(res.content).toContain('[tui]');
    expect(res.content).toContain('theme = "dark"');
    expect(res.content).toContain('[mcp_servers.devsmind]');
  });

  it('replaces our own table in place, keeping what follows it', () => {
    write('config.toml', [
      '[mcp_servers.devsmind]',
      'command = "stale"',
      '',
      '[tui]',
      'theme = "dark"',
      '',
    ].join('\n'));

    const res = mergeMcpConfig(file('config.toml'), 'toml', ['mcp_servers'], 'devsmind', STDIO);

    expect(res.content).not.toContain('stale');
    expect(res.content).toContain('command = "devsmind"');
    expect(res.content).toContain('[tui]');
    expect(res.content.match(/\[mcp_servers\.devsmind\]/g)).toHaveLength(1);
  });

  it('replaces our table when it is the last thing in the file', () => {
    write('config.toml', 'model = "x"\n\n[mcp_servers.devsmind]\ncommand = "stale"\n');

    const res = mergeMcpConfig(file('config.toml'), 'toml', ['mcp_servers'], 'devsmind', STDIO);

    expect(res.content).toContain('model = "x"');
    expect(res.content).not.toContain('stale');
    expect(res.content.match(/\[mcp_servers\.devsmind\]/g)).toHaveLength(1);
  });

  it('is idempotent across repeated runs', () => {
    let content = mergeMcpConfig(file('c.toml'), 'toml', ['mcp_servers'], 'devsmind', STDIO).content;
    write('c.toml', content);
    const again = mergeMcpConfig(file('c.toml'), 'toml', ['mcp_servers'], 'devsmind', STDIO).content;

    expect(again).toBe(content);
  });

  it('renders an object value as a TOML inline table', () => {
    const res = mergeMcpConfig(file('c.toml'), 'toml', ['mcp_servers'], 'devsmind', {
      url: 'http://localhost:4513/mcp',
      headers: { Authorization: 'Bearer t', 'X-Trace': '1' },
    });

    expect(res.content).toContain('headers = { Authorization = "Bearer t", X-Trace = "1" }');
  });

  it('renders numbers and booleans unquoted, strings quoted and escaped', () => {
    const res = mergeMcpConfig(file('c.toml'), 'toml', ['mcp_servers'], 'devsmind', {
      port: 4513,
      enabled: true,
      quoted: 'a "b" c',
    });

    expect(res.content).toContain('port = 4513');
    expect(res.content).toContain('enabled = true');
    expect(res.content).toContain('quoted = "a \\"b\\" c"');
  });

  it('replaces our table when it is the FIRST thing in the file', () => {
    write('config.toml', '[mcp_servers.devsmind]\ncommand = "stale"\n\n[tui]\ntheme = "dark"\n');

    const res = mergeMcpConfig(file('config.toml'), 'toml', ['mcp_servers'], 'devsmind', STDIO);

    expect(res.content.startsWith('[mcp_servers.devsmind]')).toBe(true);
    expect(res.content).not.toContain('stale');
    expect(res.content).toContain('[tui]');
    expect(res.content.match(/\[tui\]/g)).toHaveLength(1);
  });

  // A file that merely MENTIONS the header (a comment, a doc link) used to pass a substring
  // test, match no actual line, and send the slicing negative — duplicating every table after
  // the mention. A duplicate table is a TOML parse error, so the merge handed back a config
  // Codex could no longer read.
  it('does not treat a comment mentioning the header as an existing table', () => {
    write('config.toml', '# see [mcp_servers.devsmind] docs\nmodel = "x"\n\n[tui]\ntheme = "dark"\n');

    const res = mergeMcpConfig(file('config.toml'), 'toml', ['mcp_servers'], 'devsmind', STDIO);

    expect(res.content.match(/\[tui\]/g)).toHaveLength(1);
    expect(res.content.match(/theme = "dark"/g)).toHaveLength(1);
    expect(res.content).toContain('# see [mcp_servers.devsmind] docs');
    expect(res.content).toContain('model = "x"');
    // And our table is genuinely added, exactly once.
    expect(res.content.match(/^\[mcp_servers\.devsmind\]$/gm)).toHaveLength(1);
  });

  it('ignores a header mentioned inside a string value', () => {
    write('config.toml', 'note = "configure [mcp_servers.devsmind] later"\n\n[tui]\ntheme = "dark"\n');

    const res = mergeMcpConfig(file('config.toml'), 'toml', ['mcp_servers'], 'devsmind', STDIO);

    expect(res.content.match(/\[tui\]/g)).toHaveLength(1);
    expect(res.content).toContain('note = "configure [mcp_servers.devsmind] later"');
  });

  it('still matches a header line that carries trailing whitespace', () => {
    write('config.toml', '[mcp_servers.devsmind]   \ncommand = "stale"\n');

    const res = mergeMcpConfig(file('config.toml'), 'toml', ['mcp_servers'], 'devsmind', STDIO);

    expect(res.content).not.toContain('stale');
    expect(res.content.match(/^\[mcp_servers\.devsmind\]$/gm)).toHaveLength(1);
  });

  it('falls back to a JSON-ish rendering for a shape TOML has no syntax for', () => {
    // An object nested inside an array. Our own entries never contain this, but rendering it as
    // something readable beats emitting "[object Object]" into a user's config.
    const res = mergeMcpConfig(file('c.toml'), 'toml', ['mcp_servers'], 'devsmind', {
      nested: [{ deep: 1 }],
    });

    expect(res.content).toContain('nested = [{"deep":1}]');
  });

  it('reads an unreadable existing path as empty rather than throwing', () => {
    fs.mkdirSync(file('c.toml'));

    const res = mergeMcpConfig(file('c.toml'), 'toml', ['mcp_servers'], 'devsmind', STDIO);

    expect(res.content).toContain('[mcp_servers.devsmind]');
  });
});

// ── writeConfigFile ──────────────────────────────────────────────────────────

describe('writeConfigFile', () => {
  it('creates missing parent directories', () => {
    const target = file('a/b/c/rules.md');

    writeConfigFile(target, 'BODY\n');

    expect(fs.readFileSync(target, 'utf-8')).toBe('BODY\n');
  });

  it('overwrites an existing file completely', () => {
    const target = write('rules.md', 'OLD LONGER CONTENT\n');

    writeConfigFile(target, 'NEW\n');

    expect(fs.readFileSync(target, 'utf-8')).toBe('NEW\n');
  });
});

// ── registry path/entry helpers ──────────────────────────────────────────────

describe('registry path resolution', () => {
  it('expands a leading ~ to the home directory', () => {
    expect(resolveOsPath('~/.codex/config.toml')).toBe(path.join(os.homedir(), '.codex/config.toml'));
  });

  it('leaves a path without ~ alone', () => {
    expect(resolveOsPath('.cursor/mcp.json')).toBe('.cursor/mcp.json');
  });

  it('picks the current platform from an OS-keyed path', () => {
    const p = { win32: 'W', darwin: 'D', linux: 'L' };
    expect(resolveOsPath(p)).toBe({ win32: 'W', darwin: 'D', linux: 'L' }[process.platform as 'win32'] ?? 'L');
  });

  it('falls back to the linux path on a platform with no entry of its own', () => {
    // freebsd/aix/etc. get the POSIX layout rather than crashing on an undefined lookup.
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
    try {
      expect(resolveOsPath({ win32: 'W', darwin: 'D', linux: '~/.config/x' }))
        .toBe(path.join(os.homedir(), '/.config/x'));
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('joins a relative project scope onto the workspace root', () => {
    expect(resolveScopeFile('.cursor/rules/devsmind.mdc', 'project', '/ws'))
      .toBe(path.join('/ws', '.cursor/rules/devsmind.mdc'));
  });

  it('leaves an absolute project scope absolute', () => {
    const abs = path.resolve('/elsewhere/rules.md');
    expect(resolveScopeFile(abs, 'project', '/ws')).toBe(abs);
  });

  it('resolves a global scope independently of the workspace root', () => {
    expect(resolveScopeFile('~/.claude/CLAUDE.md', 'global', '/ws'))
      .toBe(path.resolve(path.join(os.homedir(), '.claude/CLAUDE.md')));
  });

  it('looks a target up by id, and answers undefined for an unknown one', () => {
    expect(getTarget('claude-code')?.label).toContain('Claude Code');
    expect(getTarget('nope')).toBeUndefined();
  });
});

describe('MCP server entries', () => {
  const ctx: EntryContext = { devmindDir: 'C:/my project/.devmind', port: 4513 };

  it('bakes the absolute brain path into a PROJECT stdio entry as its own argv element', () => {
    const entry = stdioEntry(ctx, 'project');

    // The IDE spawns this with a cwd we don't control, so the path can't be implied — but a
    // project-scoped config file lives inside (and so only ever serves) this one project, so
    // baking the path in is safe. A separate argv element means a path with spaces needs no
    // quoting.
    expect(entry.args).toEqual(['start', '--stdio', '--path', 'C:/my project/.devmind']);
    expect(entry.command).toBe('devsmind');
  });

  it('omits the path from a GLOBAL stdio entry — one file read by every project', () => {
    const entry = stdioEntry(ctx, 'global');

    // A global config is shared by every project on the machine. Baking in one project's path
    // would silently point every OTHER project at this same brain, which is exactly the bug
    // this scope split exists to prevent — so global relies on the server's own cwd auto-detect.
    expect(entry.args).toEqual(['start', '--stdio']);
    expect(entry.command).toBe('devsmind');
  });

  it('points an http entry at the running server', () => {
    expect(httpEntry(ctx)).toEqual({ url: 'http://localhost:4513/mcp' });
  });

  it.each(TARGETS.map(t => [t.id, t] as const))(
    '%s builds a usable PROJECT-scoped entry for every transport it advertises',
    (_id, target) => {
      for (const transport of target.mcp.transports) {
        const entry = target.mcp.entry(transport, ctx, 'project');
        expect(Object.keys(entry).length).toBeGreaterThan(0);
        if (transport === 'stdio') {
          expect(entry.command).toBe('devsmind');
          expect(entry.args).toContain(ctx.devmindDir);
        } else {
          // Tools key the endpoint differently (url / serverUrl / httpUrl) — whichever it is,
          // it must carry the real port, not a placeholder.
          expect(JSON.stringify(entry)).toContain(`localhost:${ctx.port}/mcp`);
        }
      }
    }
  );

  it.each(TARGETS.map(t => [t.id, t] as const))(
    '%s builds a usable GLOBAL-scoped entry that never bakes in this one project\'s path',
    (_id, target) => {
      for (const transport of target.mcp.transports) {
        const entry = target.mcp.entry(transport, ctx, 'global');
        expect(Object.keys(entry).length).toBeGreaterThan(0);
        if (transport === 'stdio') {
          expect(entry.command).toBe('devsmind');
          expect(entry.args).not.toContain(ctx.devmindDir);
          expect(entry.args).not.toContain('--path');
        } else {
          expect(JSON.stringify(entry)).toContain(`localhost:${ctx.port}/mcp`);
          expect(JSON.stringify(entry)).not.toContain(ctx.devmindDir);
        }
      }
    }
  );
});

// ── The registry itself ──────────────────────────────────────────────────────

describe('TARGETS registry integrity', () => {
  it('has unique ids', () => {
    const ids = TARGETS.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(TARGETS.map(t => [t.id, t] as const))('%s is structurally complete', (_id, t) => {
    expect(t.label).toBeTruthy();
    expect(['ide', 'cli']).toContain(t.kind);
    expect(t.mcp.scopes.length).toBeGreaterThan(0);
    expect(t.mcp.transports.length).toBeGreaterThan(0);
    expect(t.rules.scopes.length).toBeGreaterThan(0);
    // Every target must explain its memory story either way — a write path, or why not.
    expect(t.memory.featureName).toBeTruthy();
    expect(t.memory.note).toBeTruthy();
    if (t.memory.supported) {
      expect(t.memory.scopes?.length).toBeGreaterThan(0);
    }
  });

  /**
   * Antigravity (IDE + CLI) and Codex all discover `.agents/skills/devsmind/SKILL.md`. Writes
   * there are `standalone` — whole-file — so if their wrappers ever diverge, seeding for one tool
   * silently rewrites the file the others read, and the last command run wins. Identical bytes are
   * what make that collision harmless.
   */
  it('every target sharing the .agents/skills path writes identical bytes', () => {
    const sharing = TARGETS.filter(t =>
      t.memory.scopes?.some(s => resolveOsPath(s.dir).includes('.agents/skills')));
    expect(sharing.map(t => t.id).sort()).toEqual(['antigravity', 'antigravity-cli', 'codex']);

    const rendered = sharing.map(t => {
      const scope = t.memory.scopes!.find(s => resolveOsPath(s.dir).includes('.agents/skills'))!;
      expect(scope.file).toBe('SKILL.md');
      expect(scope.format).toBe('skill-md');
      return t.memory.wrap!('BODY');
    });
    expect(new Set(rendered).size).toBe(1);
    expect(rendered[0]).toContain('name: devsmind');
  });

  /**
   * Codex's `~/.codex/memories/` is generated state its own docs warn against hand-editing, and a
   * background job rewrites it. Supporting Codex means writing a SKILL.md, never that directory —
   * this fails if any future scope drifts into it.
   */
  it('no memory scope ever targets a tool-generated store', () => {
    const forbidden = ['.codex/memories', '.qwen/projects', 'codeium/windsurf/memories'];
    for (const t of TARGETS) {
      for (const scope of t.memory.scopes ?? []) {
        const dir = resolveOsPath(scope.dir).replace(/\\/g, '/');
        for (const bad of forbidden) {
          expect(`${t.id}:${dir}`).not.toContain(bad);
        }
      }
    }
  });
});

// ── Integration: the real placement path, for every real target ──────────────

/**
 * The closest a test can get to `devsmind rule`'s automatic mode without a TTY: take each
 * target's OWN scope config out of the registry, resolve it, merge the REAL generated rule
 * through it, and write it. A malformed registry entry, a wrapper that produces broken
 * frontmatter, or a scope whose path can't be resolved fails here instead of on a user's machine.
 */
describe('placing the real rule into every target (integration)', () => {
  it.each(TARGETS.map(t => [t.id, t] as const))('%s accepts the generated rule', (_id, target) => {
    const rule = buildRule(CONFIG, path.join(dir, '.devmind'));
    const scope = target.rules.scopes[0];
    const resolved = resolveScopeFile(scope.file, scope.scope, dir);
    // Global scopes point at the real home dir — redirect into the temp dir so the test
    // never touches the developer's actual config files.
    const target_path = path.join(dir, 'out', path.basename(resolved));

    const merged = mergeRuleFile(target_path, rule, target.rules.style, target.rules.wrap);
    expect(merged.error).toBeUndefined();
    writeConfigFile(target_path, merged.content);

    const written = fs.readFileSync(target_path, 'utf-8');
    expect(written).toContain('DevsMind');
    expect(written).toContain('search_nodes');
    expect(written).toContain('commit_changes');
    if (target.rules.style === 'append-section') {
      expect(written).toContain(RULE_START);
      expect(written).toContain(RULE_END);
    }
    if (target.rules.wrap) {
      // A wrapper means frontmatter — it has to open the file and close cleanly.
      expect(written.startsWith('---\n')).toBe(true);
      expect(written.split('\n---').length).toBeGreaterThan(1);
    }
  });

  it.each(TARGETS.map(t => [t.id, t] as const))('%s accepts an MCP registration', (_id, target) => {
    const ctx: EntryContext = { devmindDir: path.join(dir, '.devmind'), port: 4513 };

    for (const scope of target.mcp.scopes) {
      for (const transport of target.mcp.transports) {
        const out = path.join(dir, 'mcp', `${target.id}-${scope.scope}-${transport}.${scope.format}`);
        const entry = target.mcp.entry(transport, ctx, scope.scope);
        const merged = mergeMcpConfig(
          out, scope.format, scope.serverMapPath, 'devsmind', entry
        );
        writeConfigFile(out, merged.content);

        const written = fs.readFileSync(out, 'utf-8');
        if (transport === 'stdio') {
          // The bug this scope split exists to prevent: a global config must never bake in the
          // one project's absolute path, since that same file is read by every other project.
          if (scope.scope === 'global') {
            expect(written).not.toContain(ctx.devmindDir.replace(/\\/g, '/'));
          } else {
            expect(entry.args).toContain(ctx.devmindDir);
          }
        }
        if (scope.format === 'json') {
          // Must parse back, and the entry must land exactly where the tool looks for it.
          let node: any = JSON.parse(written);
          for (const key of scope.serverMapPath) node = node[key];
          expect(node.devsmind).toBeDefined();
        } else {
          expect(written).toContain(`[${[...scope.serverMapPath, 'devsmind'].join('.')}]`);
        }
      }
    }
  });
});
