import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleSkill } from '../../src/cli/integrations/skill';
import { mergeRuleFile, writeConfigFile } from '../../src/cli/integrations/prompt';
import { AGENTS_SKILL_SCOPE, skillMdWrap, resolveScopeFile } from '../../src/cli/integrations/registry';
import { renderCombined } from '../../src/cli/integrations/memory-topics';

/**
 * `devsmind skill` writes exactly ONE file — `.agents/skills/devsmind/SKILL.md` — regardless of
 * which AI tool the user is on. There's no tool picker to drive here (unlike `rule`/`mcp`/the old
 * `memory`), so `handleSkill` itself is directly testable in --print mode; the actual write
 * mechanics (frontmatter, idempotence) are exercised the same way placement.test.ts exercises
 * mergeRuleFile/writeConfigFile directly, since the confirm-prompt layer above them can't be
 * driven from a test.
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

  describe('--print', () => {
    it('prints the resolved .agents/skills/devsmind/SKILL.md path and skill-md frontmatter, writing nothing', async () => {
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
      // Printed through no indent helper (unlike devsmind memory) — compare directly.
      expect(out).toContain(live.trim());
    });

    it('never prints an unresolved [[cross-link]] — a skill file is one document, links must be flattened', async () => {
      await handleSkill({ path: path.join(dir, '.devmind'), print: true });
      expect(out).not.toContain('[[');
    });
  });

  describe('write mechanics (direct, mirroring placement.test.ts)', () => {
    it('AGENTS_SKILL_SCOPE + skillMdWrap produce the exact file devsmind skill targets', () => {
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
});
