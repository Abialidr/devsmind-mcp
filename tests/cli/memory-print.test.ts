import { handleMemory } from '../../src/cli/integrations/memory';
import { MEMORY_TOPICS } from '../../src/cli/integrations/memory-topics';

/**
 * `devsmind memory` was interactive-only: on a non-TTY it exited 1, so there was no way to read
 * what it seeds, diff it against a store, or produce it from a script. These cover the `--print`
 * escape hatch `devsmind rule --print` always had.
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

  it('prints every topic file, and the index block that makes them findable', async () => {
    await handleMemory({ print: true, tool: 'claude-code' });

    for (const topic of MEMORY_TOPICS) {
      expect(out).toContain(`${topic.name}.md`);
      expect(out).toContain(`description: ${topic.description}`);
    }
    // Claude Code loads memory files on demand, ranked from an index — without that block
    // the files are written and never read, which is the failure worth naming in the output.
    expect(out).toContain('MEMORY.md');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints one combined document for a store that loads a single file', async () => {
    await handleMemory({ print: true, tool: 'antigravity' });

    expect(out).toContain('SKILL.md');
    // Combined shape resolves [[links]] to titles, since sibling files don't exist there.
    expect(out).not.toContain('[[devsmind-commit-changes-contract]]');
    expect(out).toContain('Tool playbook');
  });

  it('seeds Codex through the same skill file as Antigravity', async () => {
    await handleMemory({ print: true, tool: 'codex' });
    const antigravity = out;
    out = '';
    await handleMemory({ print: true, tool: 'antigravity' });

    expect(antigravity).toContain('.agents/skills/devsmind');
    expect(antigravity).toContain('SKILL.md');
    // Same path, same bytes — otherwise seeding one tool rewrites the other's file.
    expect(antigravity.split('SKILL.md').pop()).toBe(out.split('SKILL.md').pop());
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('defaults to a shape and says which, rather than picking one silently', async () => {
    await handleMemory({ print: true });

    expect(out).toContain('No --tool given');
    expect(out).toContain('claude-code');
  });

  it('rejects an unknown tool by name, listing what is valid', async () => {
    await handleMemory({ print: true, tool: 'notatool' });

    expect(out).toContain('Unknown tool "notatool"');
    expect(out).toContain('claude-code');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('explains why a real tool with no seedable store cannot be printed', async () => {
    // Cursor is a genuine target; it just has no store DevsMind can safely pre-seed.
    await handleMemory({ print: true, tool: 'cursor' });

    expect(out).toContain('Cursor');
    expect(out).toMatch(/no memory store DevsMind can pre-seed/i);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('carries the live tool contract, not a stale copy', async () => {
    await handleMemory({ print: true, tool: 'claude-code' });

    // The current surface...
    expect(out).toContain('workflow_bind');
    expect(out).toContain('workflow_sync');
    // ...and none of the workflow tools 3.0.0 removed, which would send an agent at a
    // tool the server no longer answers.
    for (const gone of [
      'workflow_pause', 'workflow_resume', 'workflow_search',
      'workflow_get_steps', 'workflow_add_artifact', 'workflow_sync_retroactive',
    ]) {
      expect(out).not.toContain(gone);
    }
  });

  it('names the folded-in read tools only to say they are gone', async () => {
    await handleMemory({ print: true, tool: 'claude-code' });

    // These three DO appear, deliberately — an agent that learned them earlier needs to be told
    // they were absorbed, not left to discover it via a failed call. What must not happen is a
    // mention that reads as an instruction to use one.
    for (const [name, retirement] of [
      ['get_node_graph', 'no separate get_node_graph tool anymore'],
      ['get_node_history', 'no separate get_node_graph or get_node_history tool exists anymore'],
      ['get_recent_changes', 'It replaced `get_recent_changes`'],
    ]) {
      expect(out).toContain(name);
      expect(out).toContain(retirement);
    }
  });
});
