import * as path from 'path';
import * as os from 'os';
import { resolveDevmindDir } from '../../utils/config';
import { SkillScope, TARGETS, getTarget, skillMdWrap, resolveOsPath } from './registry';
import { renderCombined } from './memory-topics';
import { mergeRuleFile, writeConfigFile, confirmPrompt, selectPrompt, pickTarget, CancelledError } from './prompt';

const HEADER = '# DevsMind — AI Workflow Skill\n\n';

// ─── Scope picker ────────────────────────────────────────────────────────────

async function pickSkillScope(scopes: SkillScope[]): Promise<SkillScope> {
  if (scopes.length === 1) return scopes[0];
  const label: Record<string, string> = { project: 'This project only', global: 'Global (all your projects)' };
  return selectPrompt(
    'Which scope?',
    scopes.map(s => ({ title: label[s.scope] ?? s.scope, value: s })),
    0
  );
}

// ─── Path resolution ──────────────────────────────────────────────────────────

function resolveSkillFilePath(scope: SkillScope, workspaceRoot: string): string {
  const rawDir = resolveOsPath(scope.dir);
  const dir = scope.scope === 'global'
    ? rawDir                                           // absolute (may have been ~-expanded)
    : path.isAbsolute(rawDir)
      ? rawDir
      : path.join(workspaceRoot, rawDir);
  return path.join(dir, scope.file);
}

// ─── Public handler ──────────────────────────────────────────────────────────

/**
 * `devsmind skill` — writes a SKILL.md to the chosen agent's skill discovery path.
 *
 * Interactive (TTY) flow:
 *   1. Pick which agent/IDE you're using (same picker as `devsmind rule`/`mcp`).
 *   2. If that tool has both project and global scopes, pick one.
 *   3. Preview the file and confirm before writing.
 *
 * Non-interactive / scripted:
 *   `devsmind skill --tool cursor`               → project scope for Cursor
 *   `devsmind skill --tool antigravity --global` → global scope for Antigravity
 *   `devsmind skill --print`                     → print to stdout (no write, no prompts)
 *
 * Every tool produces identical file *content* (same SKILL.md frontmatter + body), only
 * the destination path differs. That means placing the file for Antigravity and Codex at
 * `.agents/skills/devsmind/SKILL.md` is still a single collision-free write for both tools.
 */
export async function handleSkill(opts: {
  path?: string;
  print?: boolean;
  tool?: string;
  global?: boolean;
}): Promise<void> {
  const devmindDir = resolveDevmindDir(opts.path);
  const workspaceRoot = devmindDir ? path.dirname(devmindDir) : process.cwd();
  const body = renderCombined(HEADER);

  // ── --print mode: no interaction, no tool required ────────────────────────
  if (opts.print || (!process.stdout.isTTY && !opts.tool)) {
    const scope = TARGETS.find(t => t.id === 'antigravity')!.skill.scopes[0]; // canonical default
    const filePath = resolveSkillFilePath(scope, workspaceRoot);
    const merged = mergeRuleFile(filePath, body, 'standalone', skillMdWrap);
    console.log(`\n📄 ${filePath.replace(/\\/g, '/')}\n`);
    console.log(merged.preview);
    printCoverageNote(null);
    return;
  }

  // ── Resolve target (interactive or --tool flag) ───────────────────────────
  let target;
  if (opts.tool) {
    target = getTarget(opts.tool);
    if (!target) {
      console.error(
        `\n❌ Unknown tool "${opts.tool}".\n` +
        `   Valid IDs: ${TARGETS.map(t => t.id).join(', ')}`
      );
      process.exit(1);
    }
  } else {
    try {
      target = await pickTarget();
    } catch (err) {
      if (err instanceof CancelledError) { console.log('\nCancelled.'); return; }
      throw err;
    }
  }

  // ── Resolve scope (interactive or --global flag) ──────────────────────────
  const scopes = target.skill.scopes;
  let scope: SkillScope;

  if (opts.global) {
    const globalScope = scopes.find(s => s.scope === 'global');
    if (!globalScope) {
      console.error(`\n❌ ${target.label} has no global skill scope.`);
      process.exit(1);
    }
    scope = globalScope;
  } else if (opts.tool) {
    // Non-interactive with --tool: prefer project scope (first), no prompt
    scope = scopes[0];
  } else {
    try {
      scope = await pickSkillScope(scopes);
    } catch (err) {
      if (err instanceof CancelledError) { console.log('\nCancelled.'); return; }
      throw err;
    }
  }

  const filePath = resolveSkillFilePath(scope, workspaceRoot);
  const merged = mergeRuleFile(filePath, body, 'standalone', skillMdWrap);
  if (merged.error) {
    console.error(`\n❌ ${merged.error}`);
    return;
  }

  // ── Non-TTY with --tool: write without confirmation ───────────────────────
  if (!process.stdout.isTTY && opts.tool) {
    writeConfigFile(filePath, merged.content);
    console.log(`\n✅ DevsMind skill written to ${filePath.replace(/\\/g, '/')}`);
    printCoverageNote(target.skill.note ?? null);
    return;
  }

  // ── Interactive: preview + confirm ────────────────────────────────────────
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
  printCoverageNote(target.skill.note ?? null);
}

function printCoverageNote(toolNote: string | null): void {
  if (toolNote) {
    console.log(`\nℹ️  ${toolNote}`);
  } else {
    console.log(
      `\nℹ️  The file content is identical for every agent — only the path differs.\n` +
      `   Antigravity and Codex share .agents/skills/devsmind/SKILL.md (invoke as /devsmind or $devsmind).\n` +
      `   Run \`devsmind skill --tool <id>\` or re-run without --print to target a specific agent.`
    );
  }
}

function indent(text: string): string {
  return text.split('\n').map(l => '   ' + l).join('\n');
}
