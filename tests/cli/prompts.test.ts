import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('prompts', () => ({ __esModule: true, default: jest.fn() }));
import prompts from 'prompts';

import {
  selectPrompt,
  confirmPrompt,
  pickTarget,
  pickTransport,
  pickMcpScope,
  pickRuleScope,
  pickMemoryScope,
  pickMode,
  pickWorkflowStyle,
  pickDirectory,
  CancelledError,
} from '../../src/cli/integrations/prompt';
import { TARGETS, getTarget, EntryContext } from '../../src/cli/integrations/registry';

/**
 * The pickers are the layer that decides WHICH tool gets configured and WHERE the file lands —
 * `pickDirectory` in particular is what turns a menu into an absolute path on disk. None of it
 * had ever been executed by a test, because it reads from a TTY. Mocking the one `prompts` call
 * it all funnels through makes the whole layer drivable.
 */

const ask = prompts as unknown as jest.Mock;

/** Queue one answer per expected prompt, in order. `undefined` simulates Esc/Ctrl-C. */
function answers(...vals: unknown[]): void {
  for (const v of vals) ask.mockResolvedValueOnce(v === undefined ? {} : { v });
}

let logSpy: jest.SpyInstance;
beforeEach(() => {
  ask.mockReset();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
});

// ── The two primitives everything else is built on ───────────────────────────

describe('selectPrompt / confirmPrompt', () => {
  it('returns the chosen value and forwards the message and choices', async () => {
    answers('picked');

    const result = await selectPrompt('Which one?', [{ title: 'A', value: 'picked' }], 1);

    expect(result).toBe('picked');
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'select',
      message: 'Which one?',
      initial: 1,
      choices: [{ title: 'A', value: 'picked' }],
    }));
  });

  it('turns a cancelled select into CancelledError, not undefined', async () => {
    // `prompts` resolves to {} on abort rather than rejecting — the trap this guards against is
    // an undefined answer flowing on and being written somewhere as a real choice.
    answers(undefined);

    await expect(selectPrompt('Which?', [{ title: 'A', value: 'a' }])).rejects.toThrow(CancelledError);
  });

  it.each([true, false])('returns %p from a confirm', async value => {
    answers(value);
    await expect(confirmPrompt('Sure?')).resolves.toBe(value);
  });

  it('turns a cancelled confirm into CancelledError rather than a silent false', async () => {
    answers(undefined);

    // This matters: a cancel read as `false` would look like "user said no" and abort quietly,
    // which is indistinguishable from a deliberate decline.
    await expect(confirmPrompt('Write this?')).rejects.toThrow(CancelledError);
  });
});

// ── Target picker ────────────────────────────────────────────────────────────

describe('pickTarget', () => {
  it('returns the selected target', async () => {
    const cursor = getTarget('cursor')!;
    answers(cursor);

    await expect(pickTarget()).resolves.toBe(cursor);
  });

  it('offers every registered tool, grouped under non-selectable headers', async () => {
    answers(getTarget('cursor')!);

    await pickTarget();

    const { choices } = ask.mock.calls[0][0];
    const titles = choices.map((c: { title: string }) => c.title);
    expect(titles).toContain('── IDEs ──');
    expect(titles).toContain('── CLI tools ──');
    for (const t of TARGETS) {
      expect(titles).toContain(`  ${t.label}`);
    }
    // Headers carry a null value, so they can't be returned as a target.
    expect(choices.filter((c: { value: unknown }) => c.value === null)).toHaveLength(2);
  });

  it('re-asks when a header row comes back instead of a tool', async () => {
    const codex = getTarget('codex')!;
    answers(null, null, codex);

    await expect(pickTarget()).resolves.toBe(codex);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('gives up rather than looping forever when only headers ever come back', async () => {
    // A non-interactive stdin that keeps yielding the same value would otherwise spin.
    ask.mockResolvedValue({ v: null });

    await expect(pickTarget()).rejects.toThrow(CancelledError);
  });
});

// ── Transport / scope pickers: skip the prompt when there's nothing to choose ──

describe('pickTransport', () => {
  it('does not prompt when a tool supports exactly one transport', async () => {
    const single = { mcp: { transports: ['stdio'] } } as never;

    await expect(pickTransport(single)).resolves.toBe('stdio');
    expect(ask).not.toHaveBeenCalled();
  });

  it('prompts with a description per transport when there is a real choice', async () => {
    answers('http');

    await expect(pickTransport(getTarget('cursor')!)).resolves.toBe('http');
    const { choices } = ask.mock.calls[0][0];
    expect(choices.map((c: { value: string }) => c.value)).toEqual(['stdio', 'http']);
    for (const c of choices) expect(c.description).toBeTruthy();
  });
});

describe('scope pickers', () => {
  it('skips the prompt for a single-scope tool', async () => {
    // Claude Code has exactly one rule scope and one memory scope.
    const cc = getTarget('claude-code')!;

    await expect(pickRuleScope(cc)).resolves.toBe(cc.rules.scopes[0]);
    await expect(pickMemoryScope(cc)).resolves.toBe(cc.memory.scopes![0]);
    expect(ask).not.toHaveBeenCalled();
  });

  it('skips the MCP scope prompt for a tool with only a global config file', async () => {
    const windsurf = getTarget('windsurf')!;
    expect(windsurf.mcp.scopes).toHaveLength(1);   // guards the premise, not just the behavior

    await expect(pickMcpScope(windsurf)).resolves.toBe(windsurf.mcp.scopes[0]);
    expect(ask).not.toHaveBeenCalled();
  });

  it('labels project vs global when a tool offers both', async () => {
    const cursor = getTarget('cursor')!;
    answers(cursor.mcp.scopes[1]);

    await expect(pickMcpScope(cursor)).resolves.toBe(cursor.mcp.scopes[1]);
    const titles = ask.mock.calls[0][0].choices.map((c: { title: string }) => c.title);
    expect(titles).toEqual(['This project only', 'Global (all your projects)']);
  });

  it('prompts for a rule scope when a tool offers more than one', async () => {
    // No registered tool has two rule scopes today — this is the branch that keeps working when
    // one is added, rather than silently returning the first and writing to the wrong file.
    const twoScoped = {
      rules: { scopes: [{ scope: 'project', file: 'A.md' }, { scope: 'global', file: 'B.md' }] },
    } as never;
    answers({ scope: 'global', file: 'B.md' });

    await expect(pickRuleScope(twoScoped)).resolves.toEqual({ scope: 'global', file: 'B.md' });
    const titles = ask.mock.calls[0][0].choices.map((c: { title: string }) => c.title);
    expect(titles).toEqual(['This project only', 'Global (all your projects)']);
  });

  it('treats a target with no memory scopes as an empty choice list', async () => {
    const noScopes = { memory: {} } as never;
    answers('whatever');

    await pickMemoryScope(noScopes);

    expect(ask.mock.calls[0][0].choices).toEqual([]);
  });
});

describe('mode and workflow-style pickers', () => {
  it.each(['auto', 'manual'] as const)('returns %s from pickMode', async mode => {
    answers(mode);
    await expect(pickMode()).resolves.toBe(mode);
  });

  it.each(['automatic', 'manual'] as const)('returns %s from pickWorkflowStyle', async style => {
    answers(style);
    await expect(pickWorkflowStyle()).resolves.toBe(style);
  });

  it('defaults workflow style to automatic and describes both options', async () => {
    answers('automatic');

    await pickWorkflowStyle();

    const call = ask.mock.calls[0][0];
    expect(call.initial).toBe(0);
    expect(call.choices[0].value).toBe('automatic');
    for (const c of call.choices) expect(c.description).toBeTruthy();
  });
});

// ── The directory navigator ──────────────────────────────────────────────────

describe('pickDirectory', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-nav-')));
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.mkdirSync(path.join(root, '.devmind'));
    fs.writeFileSync(path.join(root, 'a-file.txt'), '', 'utf-8');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns the starting folder when the user confirms it immediately', async () => {
    answers({ action: 'use' });

    await expect(pickDirectory(root, 'Pick one')).resolves.toBe(root);
  });

  it('walks into a subdirectory and confirms there', async () => {
    answers({ action: 'into', dir: 'src' }, { action: 'use' });

    await expect(pickDirectory(root, 'Pick one')).resolves.toBe(path.join(root, 'src'));
  });

  it('goes back up to the parent', async () => {
    answers({ action: 'up' }, { action: 'use' });

    await expect(pickDirectory(root, 'Pick one')).resolves.toBe(path.dirname(root));
  });

  it('lists subdirectories but not files, and hides dotfolders except .devmind', async () => {
    answers({ action: 'use' });

    await pickDirectory(root, 'Pick one');

    const titles = ask.mock.calls[0][0].choices.map((c: { title: string }) => c.title);
    expect(titles).toContain('📁 src/');
    expect(titles).toContain('📁 .devmind/');   // the one dotfolder worth navigating to
    expect(titles).not.toContain('📁 .hidden/');
    expect(titles.join()).not.toContain('a-file.txt');
  });

  it('includes hidden folders when asked to', async () => {
    answers({ action: 'use' });

    await pickDirectory(root, 'Pick one', { showHidden: true });

    const titles = ask.mock.calls[0][0].choices.map((c: { title: string }) => c.title);
    expect(titles).toContain('📁 .hidden/');
  });

  it('omits the type-a-path option when it is disabled', async () => {
    answers({ action: 'use' });

    await pickDirectory(root, 'Pick one', { allowTyped: false });

    const actions = ask.mock.calls[0][0].choices.map((c: { value: { action: string } }) => c.value.action);
    expect(actions).not.toContain('type');
  });

  it('jumps to a typed path — the escape hatch for another drive', async () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-far-')));
    answers({ action: 'type' });
    ask.mockResolvedValueOnce({ v: elsewhere });      // the typed path
    ask.mockResolvedValueOnce({ v: { action: 'use' } });

    await expect(pickDirectory(root, 'Pick one')).resolves.toBe(elsewhere);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it('expands a leading ~ in a typed path', async () => {
    answers({ action: 'type' });
    ask.mockResolvedValueOnce({ v: '~' });
    ask.mockResolvedValueOnce({ v: { action: 'use' } });

    await expect(pickDirectory(root, 'Pick one')).resolves.toBe(path.resolve(os.homedir()));
  });

  it('warns and stays put when a typed path does not exist', async () => {
    answers({ action: 'type' });
    ask.mockResolvedValueOnce({ v: path.join(root, 'no-such-folder') });
    ask.mockResolvedValueOnce({ v: { action: 'use' } });

    // Refusing a non-existent folder is the point — writing a rule file into a path the user
    // mistyped would "succeed" and then never be read by their tool.
    await expect(pickDirectory(root, 'Pick one')).resolves.toBe(root);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Not an existing folder');
  });

  it('stays put when a typed path is a file rather than a directory', async () => {
    answers({ action: 'type' });
    ask.mockResolvedValueOnce({ v: path.join(root, 'a-file.txt') });
    ask.mockResolvedValueOnce({ v: { action: 'use' } });

    await expect(pickDirectory(root, 'Pick one')).resolves.toBe(root);
  });

  it.each([['blank', '   '], ['cancelled', undefined]])(
    'ignores a %s typed path and keeps browsing',
    async (_label, typed) => {
      answers({ action: 'type' });
      ask.mockResolvedValueOnce(typed === undefined ? {} : { v: typed });
      ask.mockResolvedValueOnce({ v: { action: 'use' } });

      await expect(pickDirectory(root, 'Pick one')).resolves.toBe(root);
    }
  );

  it('falls back to cwd when the starting folder does not exist', async () => {
    answers({ action: 'use' });

    await expect(pickDirectory(path.join(root, 'gone'), 'Pick one')).resolves.toBe(path.resolve(process.cwd()));
  });

  it('offers no children when the folder cannot be read, instead of failing', async () => {
    // Descending is not existence-checked, so a caller can land on a non-directory — here a
    // file, which makes readdirSync throw ENOTDIR. The navigator must degrade to "no children"
    // and stay usable rather than take the whole command down.
    answers({ action: 'into', dir: 'a-file.txt' }, { action: 'up' }, { action: 'use' });

    await expect(pickDirectory(root, 'Pick one')).resolves.toBe(root);
    const secondMenu = ask.mock.calls[1][0].choices;
    expect(secondMenu.map((c: { value: { action: string } }) => c.value.action)).not.toContain('into');
  });

  it('drops the "go up" option at the filesystem root, where there is no parent', async () => {
    answers({ action: 'use' });
    const fsRoot = path.parse(root).root;

    await pickDirectory(fsRoot, 'Pick one');

    const actions = ask.mock.calls[0][0].choices.map((c: { value: { action: string } }) => c.value.action);
    expect(actions).not.toContain('up');
  });

  it('gives up rather than looping forever on an unproductive answer', async () => {
    ask.mockResolvedValue({ v: { action: 'nonsense' } });

    await expect(pickDirectory(root, 'Pick one')).rejects.toThrow(CancelledError);
  });

  it('cancels cleanly when the navigator prompt is aborted', async () => {
    answers(undefined);

    await expect(pickDirectory(root, 'Pick one')).rejects.toThrow(CancelledError);
  });
});

// ── The one-liner installers some tools offer instead of a config file ────────

describe('cliInstaller commands', () => {
  const ctx: EntryContext = { devmindDir: 'C:/my project/.devmind', port: 4513 };
  const withInstaller = TARGETS.filter(t => t.mcp.cliInstaller);

  it('is offered by at least one tool', () => {
    expect(withInstaller.length).toBeGreaterThan(0);
  });

  it.each(withInstaller.map(t => [t.id, t] as const))(
    '%s renders a runnable command for each transport',
    (_id, target) => {
      for (const transport of target.mcp.transports) {
        const cmd = target.mcp.cliInstaller!(transport, ctx);
        expect(cmd).toContain('devsmind');
        if (transport === 'stdio') {
          // A path with spaces must be quoted here — unlike the config-file entry, this is a
          // shell string, so an unquoted path would split into two arguments.
          expect(cmd).toContain(`"${ctx.devmindDir}"`);
        } else {
          // Not every tool HAS a remote-add flag (Codex doesn't). Where one is missing the
          // string must say so as a comment rather than hand back a command that fails.
          const isGuidance = cmd.trimStart().startsWith('#');
          expect(isGuidance || cmd.includes(`localhost:${ctx.port}/mcp`)).toBe(true);
        }
      }
    }
  );
});
