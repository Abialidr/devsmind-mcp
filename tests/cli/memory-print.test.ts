import { handleMemory } from '../../src/cli/integrations/memory';
import { DEVSMIND_INSTRUCTIONS } from '../../src/mcp/server';

/**
 * `devsmind memory` writes nothing to disk. For the 5 tools with a real memory mechanism
 * (claude-code, cursor, vscode, windsurf, qwen), it prints ONE natural-language block, framed as
 * an explicit "remember this" request, meant to be pasted into any AI chat — `--tool` changes the
 * framing line AND a short tool-specific hint on how that tool's memory actually saves, but the
 * full contract underneath (from `DEVSMIND_INSTRUCTIONS`) never varies. For the 4 tools with no
 * real memory mechanism at all (antigravity, antigravity-cli, codex, kiro — confirmed by direct
 * testing and research, see registry.ts's `hasRealMechanism` doc comment), it skips the prompt
 * entirely and points at `devsmind skill` instead, since asking those to "remember" has nothing
 * to attach to.
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

  it('names the tool\'s own memory feature in the framing line, and tailors the ask-hint per tool — but the full contract stays identical', async () => {
    await handleMemory({ print: true, tool: 'claude-code' });
    const claudeOut = out;
    expect(claudeOut).toContain('Auto Memory');
    expect(claudeOut).toContain('saves reliably from');

    out = '';
    await handleMemory({ print: true, tool: 'cursor' });
    const cursorOut = out;
    expect(cursorOut).toContain('Memories');
    expect(cursorOut).toContain('PROPOSE it as a Cursor Memory');

    // The tool-specific hint differs, so the pasted block itself now differs too — but both
    // still carry the SAME full contract from "The full contract, so nothing gets missed:" on.
    const claudeContract = claudeOut.slice(claudeOut.indexOf('The full contract'));
    const cursorContract = cursorOut.slice(cursorOut.indexOf('The full contract'));
    expect(claudeContract).toBe(cursorContract);
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

  it('prints the pasteable prompt for the 5 tools with a real memory mechanism', async () => {
    for (const tool of ['claude-code', 'cursor', 'vscode', 'windsurf', 'qwen']) {
      out = '';
      await handleMemory({ print: true, tool });
      expect(out).toContain('Please remember');
      expect(exitSpy).not.toHaveBeenCalled();
    }
  });

  it('skips straight to a "nothing to ask" message and points at devsmind skill for the 4 tools with no real memory mechanism', async () => {
    // Antigravity (IDE + CLI), Codex, and Kiro have no genuine background-memory concept at
    // all — confirmed by direct testing and research (see registry.ts's hasRealMechanism doc
    // comment). Printing the same "remember this" prompt there would just get acknowledged and
    // dropped with nothing actually saved.
    for (const tool of ['antigravity', 'antigravity-cli', 'codex', 'kiro']) {
      out = '';
      await handleMemory({ print: true, tool });
      expect(out).not.toContain('Please remember');
      expect(out).toContain('has no real background-memory mechanism');
      expect(out).toContain('devsmind skill');
      expect(exitSpy).not.toHaveBeenCalled();
    }
  });
});
