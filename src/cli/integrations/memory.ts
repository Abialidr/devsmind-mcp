import * as path from 'path';
import { resolveDevmindDir } from '../../utils/config';
import { DEVSMIND_INSTRUCTIONS } from '../../mcp/server';
import { MemoryScope, resolveOsPath, resolveScopeFile } from './registry';
import {
  pickTarget,
  pickMode,
  pickMemoryScope,
  pickDirectory,
  confirmPrompt,
  mergeRuleFile,
  writeConfigFile,
  CancelledError,
} from './prompt';

const MEMORY_FILE_HEADER = '<!-- Seeded by `devsmind memory` — the DevsMind team code-graph MCP server -->\n\n';

/**
 * `devsmind memory` — seed a tool's own persistent agent-memory/skills store
 * (distinct from `devsmind rule`'s static rule file) with the same workflow
 * contract carried by the MCP `instructions` field, for the handful of tools
 * confirmed to actually read back a file they didn't create themselves. For
 * every other tool this prints honest guidance instead of writing a file that
 * might silently do nothing (or get overwritten by the tool's own background job).
 */
export async function handleMemory(opts: { path?: string }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      `❌ \`devsmind memory\` is interactive and needs a terminal.\n` +
      `   Run it directly in your shell (not piped/redirected).`
    );
    process.exit(1);
  }

  const devmindDir = resolveDevmindDir(opts.path);
  const workspaceRoot = devmindDir ? path.dirname(devmindDir) : process.cwd();

  try {
    const target = await pickTarget();
    const mem = target.memory;

    if (!mem.supported) {
      const divider = '─'.repeat(70);
      console.log(`\n${divider}`);
      console.log(` ${target.label} — ${mem.featureName}`);
      console.log(`${divider}\n`);
      console.log(`⚠️  Nothing written — there's no safe way to pre-seed this.\n`);
      console.log(mem.note);
      console.log('');
      return;
    }

    console.log(`\nℹ️  ${target.label} calls this "${mem.featureName}".`);
    console.log(`   ${mem.note}`);

    const mode = await pickMode();
    const scope = await pickMemoryScope(target);
    const content = MEMORY_FILE_HEADER + DEVSMIND_INSTRUCTIONS;
    const wrapped = scope.format === 'skill-md' && target.memory.wrap ? target.memory.wrap(content) : content;

    if (mode === 'manual') {
      printManual(target.label, scope, workspaceRoot);
      console.log(`\nContent to place in that file:\n`);
      console.log(indent(wrapped));
      if (mem.pointerFile) {
        console.log(`\n💡 Also add one pointer line into ${mem.pointerFile.file} in the same folder`);
        console.log(`   (e.g. "See devsmind.md for the DevsMind workflow.") — it loads on demand only.`);
      }
      return;
    }

    // Automatic mode.
    const targetDir = await resolveMemoryDir(scope, target.label, workspaceRoot);
    const filePath = path.join(targetDir, scope.file);

    const merged = mergeRuleFile(filePath, wrapped, 'standalone');
    console.log(`\n📝 Target: ${filePath.replace(/\\/g, '/')}  (${merged.existed ? 'overwrite our own file' : 'create new'})`);
    console.log(`\nContent to be written:\n`);
    console.log(indent(merged.content));

    const ok = await confirmPrompt('Write this?', true);
    if (!ok) {
      console.log('\nAborted — nothing written.');
      return;
    }
    writeConfigFile(filePath, merged.content);
    console.log(`\n✅ Seeded ${target.label}'s ${mem.featureName} at ${filePath.replace(/\\/g, '/')}`);

    if (mem.pointerFile) {
      const pointerConfirm = await confirmPrompt(
        `\nAlso append a one-line pointer into ${mem.pointerFile.file} in the same folder, so this gets found ` +
        `(it only loads "on demand" otherwise)?`,
        true
      );
      if (pointerConfirm) {
        const pointerPath = path.join(targetDir, mem.pointerFile.file);
        const pointerBody = `See \`${scope.file}\` in this folder for the DevsMind workflow contract — search before grep, ` +
          `\`edit_node\` to change existing TS/JS code, \`stage_change\` to record every other edit, ` +
          `\`commit_changes\` before the turn ends.`;
        const pointerMerged = mergeRuleFile(pointerPath, pointerBody, 'append-section');
        if (pointerMerged.error) {
          console.error(`❌ ${pointerMerged.error}`);
        } else {
          writeConfigFile(pointerPath, pointerMerged.content);
          console.log(`✅ Pointer added to ${pointerPath.replace(/\\/g, '/')}`);
        }
      }
    }
  } catch (err) {
    if (err instanceof CancelledError) {
      console.log('\nCancelled.');
      return;
    }
    throw err;
  }
}

/** Resolve the directory to write into, prompting the user to navigate when the exact path isn't knowable. */
async function resolveMemoryDir(scope: MemoryScope, label: string, workspaceRoot: string): Promise<string> {
  if (scope.needsUserConfirmedDir) {
    const start = resolveOsPath(scope.dir);
    return pickDirectory(
      start,
      `Navigate to the correct folder for ${label} (e.g. .../projects/<your-project-hash>/memory)`
    );
  }
  if (scope.scope === 'project') {
    const base = await pickDirectory(workspaceRoot, `Where is the project root for ${label}?`);
    return path.join(base, resolveOsPath(scope.dir));
  }
  return resolveScopeFile(scope.dir, 'global', workspaceRoot);
}

function printManual(label: string, scope: MemoryScope, workspaceRoot: string): void {
  const divider = '─'.repeat(70);
  const dirHint = scope.needsUserConfirmedDir
    ? `${resolveOsPath(scope.dir)}/<your-project-hash>/...`
    : scope.scope === 'project'
      ? path.join(workspaceRoot, resolveOsPath(scope.dir)).replace(/\\/g, '/')
      : resolveOsPath(scope.dir);

  console.log(`\n${divider}`);
  console.log(` Seed DevsMind into ${label}`);
  console.log(`${divider}`);
  console.log(`\n1. Create this file:`);
  console.log(`   ${dirHint.replace(/\\/g, '/')}/${scope.file}`);
}

function indent(text: string): string {
  return text.split('\n').map(l => '   ' + l).join('\n');
}
