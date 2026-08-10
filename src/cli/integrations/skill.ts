import * as path from 'path';
import { resolveDevmindDir } from '../../utils/config';
import { AGENTS_SKILL_SCOPE, skillMdWrap, resolveScopeFile } from './registry';
import { renderCombined } from './memory-topics';
import { mergeRuleFile, writeConfigFile, confirmPrompt, CancelledError } from './prompt';

const HEADER = '# DevsMind — AI Workflow Skill\n\n';

/**
 * `devsmind skill` — writes ONE file, `.agents/skills/devsmind/SKILL.md`, holding the full
 * DevsMind workflow contract as a standalone, explicitly-invokable document. Deliberately a
 * single file at a single location, not a per-tool writer: Antigravity, Antigravity CLI, and
 * Codex all already discover exactly this path (`AGENTS_SKILL_SCOPE`, shared with the old
 * memory write path before `devsmind memory` went print-only), and Claude Code/Cursor are
 * documented to read the same `.agents/skills/` convention too — one file, several tools,
 * rather than juggling a different format/path per tool for a marginal reliability gain.
 *
 * Idempotent: re-running always regenerates the same content from the live `MEMORY_TOPICS`
 * (via `renderCombined`), so it never drifts from the retired-tool-name checks that content
 * already goes through.
 */
export async function handleSkill(opts: { path?: string; print?: boolean }): Promise<void> {
  const devmindDir = resolveDevmindDir(opts.path);
  const workspaceRoot = devmindDir ? path.dirname(devmindDir) : process.cwd();
  const relPath = `${AGENTS_SKILL_SCOPE.dir}/${AGENTS_SKILL_SCOPE.file}`;
  const filePath = resolveScopeFile(relPath, AGENTS_SKILL_SCOPE.scope, workspaceRoot);

  const body = renderCombined(HEADER);
  const merged = mergeRuleFile(filePath, body, 'standalone', skillMdWrap);
  if (merged.error) {
    console.error(`\n❌ ${merged.error}`);
    return;
  }

  if (opts.print || !process.stdout.isTTY) {
    console.log(`\n📄 ${filePath.replace(/\\/g, '/')}\n`);
    console.log(merged.preview);
    printCoverageNote();
    return;
  }

  console.log(`\n📝 Target: ${filePath.replace(/\\/g, '/')}  (${merged.existed ? 'overwrite' : 'create new'})`);
  console.log(`\nFile contents to be written:\n`);
  console.log(indent(merged.preview));

  try {
    const ok = await confirmPrompt('Write this?', true);
    if (!ok) {
      console.log('\nAborted — nothing written.');
      return;
    }
  } catch (err) {
    if (err instanceof CancelledError) {
      console.log('\nCancelled.');
      return;
    }
    throw err;
  }

  writeConfigFile(filePath, merged.content);
  console.log(`\n✅ DevsMind skill written to ${filePath.replace(/\\/g, '/')}`);
  printCoverageNote();
}

function printCoverageNote(): void {
  console.log(
    `\nℹ️  Discoverable today as a Skill by Antigravity, Antigravity CLI, and Codex ` +
    `(invoke as \`/devsmind\` — Codex uses \`$devsmind\`). Claude Code and Cursor are documented ` +
    `to read the same \`.agents/skills/\` convention and may pick it up too — check your tool's ` +
    `own skills docs to confirm.`
  );
}

function indent(text: string): string {
  return text.split('\n').map(l => '   ' + l).join('\n');
}
