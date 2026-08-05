import { handleMemory } from '../../src/cli/integrations/memory';
import { DEVSMIND_INSTRUCTIONS } from '../../src/mcp/server';

/**
 * `devsmind memory` writes nothing to disk — it prints ONE natural-language block, framed as an
 * explicit "remember this" request, meant to be pasted into any AI chat. See memory.ts's own doc
 * comment for why: background/automatic memory across every tool DevsMind integrates with turned
 * out to be discretionary by design, while an explicit in-chat ask is what actually lands. `--tool`
 * only changes the one-line framing (which feature name to call out) — the prompt itself, from
 * `renderMemoryPrompt`, is identical for every tool, so there's no per-tool file shape left to test.
 */
describe('devsmind memory --print', () => {
  let out: string;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    out = '';
    const capture = (...args: unknown[]) => { out += args.join(' ') + '\n'; };
    logSpy = jest.spyOn(console, 'log').mockImplementation(capture);
    errSpy = jest.spyOn(console, 'error').mockImplementation(capture);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints the two non-negotiables ahead of the full contract, framed as an explicit "remember this" ask', async () => {
    await handleMemory({ print: true, tool: 'claude-code' });

    expect(out).toContain('Please remember the following');
    expect(out).toContain('Always write files with the');
    expect(out).toContain('edit_node');
    expect(out).toContain('Prefer');
    expect(out).toContain('search_nodes');
    // The two non-negotiables appear BEFORE the full contract dump.
    expect(out.indexOf('Always write files with the')).toBeLessThan(out.indexOf('Non-negotiable workflow'));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('carries the live server contract verbatim, not a stale copy', async () => {
    await handleMemory({ print: true, tool: 'claude-code' });
    // The whole block is printed through a 3-space indent helper; undo it before comparing.
    const dedented = out.split('\n').map(l => l.startsWith('   ') ? l.slice(3) : l).join('\n');
    expect(dedented).toContain(DEVSMIND_INSTRUCTIONS);
  });

  it('names the tool\'s own memory feature in the framing line, but the prompt itself is identical across tools', async () => {
    await handleMemory({ print: true, tool: 'claude-code' });
    const claudeOut = out;
    expect(claudeOut).toContain('Auto Memory');

    out = '';
    await handleMemory({ print: true, tool: 'cursor' });
    const cursorOut = out;
    expect(cursorOut).toContain('Memories');

    // Different framing line, but the pasted block itself — from "Please remember" onward — is
    // byte-identical, since nothing about the prompt content is tool-specific.
    const claudePrompt = claudeOut.slice(claudeOut.indexOf('Please remember'));
    const cursorPrompt = cursorOut.slice(cursorOut.indexOf('Please remember'));
    expect(claudePrompt).toBe(cursorPrompt);
  });

  it('defaults to claude-code framing and says so, rather than picking one silently', async () => {
    await handleMemory({ print: true });

    expect(out).toContain('No --tool given');
    expect(out).toContain('claude-code');
    expect(out).toContain('Please remember');
  });

  it('rejects an unknown tool by name, listing what is valid', async () => {
    await handleMemory({ print: true, tool: 'notatool' });

    expect(out).toContain('Unknown tool "notatool"');
    expect(out).toContain('claude-code');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints for every registered tool, including the 5 with no writable memory store of their own', async () => {
    // Cursor/VS Code/Windsurf/Kiro/Qwen have no safe write target — that used to mean
    // `devsmind memory` refused them outright. Nothing is written now, so there's nothing to
    // refuse: every tool gets the same prompt.
    for (const tool of ['cursor', 'vscode', 'windsurf', 'kiro', 'qwen']) {
      out = '';
      await handleMemory({ print: true, tool });
      expect(out).toContain('Please remember');
      expect(exitSpy).not.toHaveBeenCalled();
    }
  });
});
