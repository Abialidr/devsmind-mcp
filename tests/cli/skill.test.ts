import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleSkill } from '../../src/cli/integrations/skill';
import { mergeRuleFile, writeConfigFile } from '../../src/cli/integrations/prompt';
import { AGENTS_SKILL_SCOPE, skillMdWrap, resolveScopeFile, TARGETS } from '../../src/cli/integrations/registry';
import { renderCombined } from '../../src/cli/integrations/memory-topics';

/**
 * `devsmind skill` now picks the target agent interactively (like `devsmind rule`/`mcp`).
 * These tests cover:
 *   - --print mode (no tool picker; prints the canonical .agents/skills path, writes nothing)
 *   - --tool mode (non-interactive write to a specific tool's skill path)
 *   - direct mergeRuleFile/writeConfigFile mechanics for the .agents/skills scope
 *   - registry invariants: every target has a skill field with at least one scope
 */
describe('devsmind skill', () => {
  let dir: string;
  let out: string;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-skill-'));
    fs.mkdirSync(path.join(dir, '.devmind'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.devmind', 'config.json'),
      JSON.stringify({ project_name: 'skill-fixture', mode: 'embedded', repos: [{ name: 'app', relative_path: '.' }] })
    );
    out = '';
    const capture = (...args: unknown[]) => { out += args.join(' ') + '\n'; };
    logSpy = jest.spyOn(console, 'log').mockImplementation(capture);
    errSpy = jest.spyOn(console, 'error').mockImplementation(capture);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── --print ────────────────────────────────────────────────────────────────

  describe('--print', () => {
    it('prints the canonical .agents/skills/devsmind/SKILL.md path and skill-md frontmatter, writing nothing', async () => {
      await handleSkill({ path: path.join(dir, '.devmind'), print: true });

      const expectedPath = path.join(dir, '.agents', 'skills', 'devsmind', 'SKILL.md').replace(/\\/g, '/');
      expect(out).toContain(expectedPath);
      expect(out).toContain('name: devsmind');
      expect(out).toContain('description: DevsMind team code-graph MCP server');
      expect(fs.existsSync(path.join(dir, '.agents', 'skills', 'devsmind', 'SKILL.md'))).toBe(false);
    });

    it('carries the live renderCombined contract, not a stale copy', async () => {
      await handleSkill({ path: path.join(dir, '.devmind'), print: true });

      const live = renderCombined('# DevsMind — AI Workflow Skill\n\n');
      expect(out).toContain(live.trim());
    });

    it('never prints an unresolved [[cross-link]] — a skill file is one document, links must be flattened', async () => {
      await handleSkill({ path: path.join(dir, '.devmind'), print: true });
      expect(out).not.toContain('[[');
    });
  });

  // ── --tool (non-interactive write) ─────────────────────────────────────────

  describe('--tool (non-interactive write)', () => {
    // Simulate a non-TTY environment so the path skips the confirm prompt.
    let isTTY: boolean | undefined;
    beforeEach(() => { isTTY = process.stdout.isTTY; (process.stdout as any).isTTY = false; });
    afterEach(() => { (process.stdout as any).isTTY = isTTY; });

    it('writes antigravity skill to .agents/skills/devsmind/SKILL.md', async () => {
      await handleSkill({ path: path.join(dir, '.devmind'), tool: 'antigravity' });
      const skillPath = path.join(dir, '.agents', 'skills', 'devsmind', 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
      const content = fs.readFileSync(skillPath, 'utf-8');
      expect(content.startsWith('---\nname: devsmind\n')).toBe(true);
    });

    it('writes claude-code skill to .claude/devsmind/SKILL.md', async () => {
      await handleSkill({ path: path.join(dir, '.devmind'), tool: 'claude-code' });
      const skillPath = path.join(dir, '.claude', 'devsmind', 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
      const content = fs.readFileSync(skillPath, 'utf-8');
      expect(content.startsWith('---\nname: devsmind\n')).toBe(true);
    });

    it('writes codex skill to .agents/skills/devsmind/SKILL.md (same path as antigravity)', async () => {
      await handleSkill({ path: path.join(dir, '.devmind'), tool: 'codex' });
      const skillPath = path.join(dir, '.agents', 'skills', 'devsmind', 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
    });

    it('all tools produce byte-identical SKILL.md content regardless of path', async () => {
      const tools = ['antigravity', 'claude-code', 'cursor', 'codex'];
      const contents = new Map<string, string>();
      for (const tool of tools) {
        // Fresh tempdir per tool so paths don't collide
        const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), `devsmind-skill-${tool}-`));
        fs.mkdirSync(path.join(toolDir, '.devmind'), { recursive: true });
        fs.writeFileSync(path.join(toolDir, '.devmind', 'config.json'), JSON.stringify({
          project_name: 'test', mode: 'embedded', repos: [{ name: 'app', relative_path: '.' }]
        }));
        try {
          await handleSkill({ path: path.join(toolDir, '.devmind'), tool });
          const target = TARGETS.find(t => t.id === tool)!;
          const scope = target.skill.scopes[0];
          const rawDir = scope.dir as string;
          const skillPath = path.join(toolDir, rawDir.replace('~', os.homedir()), scope.file);
          if (fs.existsSync(skillPath)) {
            contents.set(tool, fs.readFileSync(skillPath, 'utf-8'));
          }
        } finally {
          fs.rmSync(toolDir, { recursive: true, force: true });
        }
      }
      // All content values that were written should be identical
      const unique = new Set(contents.values());
      expect(unique.size).toBe(1);
      expect([...unique][0]).toContain('name: devsmind');
    });

    it('errors and exits for an unknown tool id', async () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      await expect(handleSkill({ path: path.join(dir, '.devmind'), tool: 'nonexistent-tool' }))
        .rejects.toThrow('exit');
      expect(out + errSpy.mock.calls.join('')).toContain('Unknown tool');
      exitSpy.mockRestore();
    });
  });

  // ── Write mechanics (direct) ───────────────────────────────────────────────

  describe('write mechanics (direct, mirroring placement.test.ts)', () => {
    it('AGENTS_SKILL_SCOPE + skillMdWrap produce the expected .agents/skills/devsmind/SKILL.md path and content', () => {
      const relPath = `${AGENTS_SKILL_SCOPE.dir}/${AGENTS_SKILL_SCOPE.file}`;
      const filePath = resolveScopeFile(relPath, AGENTS_SKILL_SCOPE.scope, dir);
      expect(filePath).toBe(path.join(dir, '.agents', 'skills', 'devsmind', 'SKILL.md'));

      const body = renderCombined('# DevsMind — AI Workflow Skill\n\n');
      const merged = mergeRuleFile(filePath, body, 'standalone', skillMdWrap);
      expect(merged.error).toBeUndefined();
      expect(merged.content.startsWith('---\nname: devsmind\n')).toBe(true);
      expect(merged.content).toContain('description: DevsMind team code-graph MCP server');

      writeConfigFile(filePath, merged.content);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(merged.content);
    });

    it('is idempotent — writing twice produces byte-identical content, no growth', () => {
      const relPath = `${AGENTS_SKILL_SCOPE.dir}/${AGENTS_SKILL_SCOPE.file}`;
      const filePath = resolveScopeFile(relPath, AGENTS_SKILL_SCOPE.scope, dir);
      const body = renderCombined('# DevsMind — AI Workflow Skill\n\n');

      const first = mergeRuleFile(filePath, body, 'standalone', skillMdWrap);
      writeConfigFile(filePath, first.content);
      const second = mergeRuleFile(filePath, body, 'standalone', skillMdWrap);
      expect(second.existed).toBe(true);
      expect(second.content).toBe(first.content);
    });
  });

  // ── Registry invariants ────────────────────────────────────────────────────

  describe('registry invariants', () => {
    it('every target has a skill field with at least one scope', () => {
      for (const t of TARGETS) {
        expect(t.skill).toBeDefined();
        expect(t.skill.scopes.length).toBeGreaterThan(0);
        for (const s of t.skill.scopes) {
          expect(s.dir).toBeTruthy();
          expect(s.file).toBe('SKILL.md');
          expect(['project', 'global']).toContain(s.scope);
        }
      }
    });

    it('every tool with a project skill scope points to a valid relative path (no absolute paths in project scope)', () => {
      for (const t of TARGETS) {
        for (const s of t.skill.scopes) {
          if (s.scope === 'project') {
            const dir = typeof s.dir === 'string' ? s.dir : (s.dir as any).win32 ?? (s.dir as any).linux;
            expect(dir.startsWith('~') || path.isAbsolute(dir)).toBe(false);
          }
        }
      }
    });

    it('antigravity, antigravity-cli, and codex all share the .agents/skills/devsmind project scope', () => {
      const sharing = TARGETS.filter(t =>
        t.skill.scopes.some(s => s.scope === 'project' && (s.dir as string).includes('.agents/skills'))
      );
      expect(sharing.map(t => t.id).sort()).toEqual(['antigravity', 'antigravity-cli', 'codex']);
    });
  });
});
