import * as path from 'path';
import { resolveDevmindDir } from '../../utils/config';
import { IdeTarget, MemoryScope, TARGETS, getTarget, resolveOsPath, resolveScopeFile } from './registry';
import { MEMORY_TOPICS, renderCombined, renderIndexLine, renderTopicFile } from './memory-topics';
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

/** One file DevsMind intends to write, resolved down to a name + final content. */
interface PlannedDoc {
  /** Filename within the target directory. */
  file: string;
  content: string;
  /** Shown instead of the body in the multi-file preview, where dumping every body would bury the paths. */
  summary?: string;
}

/**
 * `devsmind memory` — seed a tool's own persistent agent-memory/skills store
 * (distinct from `devsmind rule`'s static rule file) with the workflow contract
 * carried by the MCP `instructions` field, for the handful of tools confirmed to
 * actually read back a file they didn't create themselves. For every other tool
 * this prints honest guidance instead of writing a file that might silently do
 * nothing (or get overwritten by the tool's own background job).
 *
 * The contract is seeded as one file per fact where the store loads files on
 * demand (Claude Code), and as one combined document where it doesn't
 * (Antigravity Skills) — see memory-topics.ts for why.
 */
export async function handleMemory(opts: { path?: string; print?: boolean; tool?: string }): Promise<void> {
  const devmindDir = resolveDevmindDir(opts.path);
  const workspaceRoot = devmindDir ? path.dirname(devmindDir) : process.cwd();

  // Piped/redirected output or an explicit --print: print what WOULD be written and stop, the
  // same escape hatch `devsmind rule --print` has. Without it there was no way to read the
  // seeded contract, diff it against what's already in a store, or produce it from a script —
  // the content existed but the only route to it was a series of interactive prompts.
  if (opts.print || !process.stdin.isTTY || !process.stdout.isTTY) {
    printNonInteractive(opts.tool, workspaceRoot);
    return;
  }

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
    const docs = buildDocs(target, scope);

    if (mode === 'manual') {
      printManual(target.label, scope, workspaceRoot, docs, mem.pointerFile?.file);
      return;
    }

    // Automatic mode.
    const targetDir = await resolveMemoryDir(scope, target.label, workspaceRoot);

    const merged = docs.map(doc => {
      const filePath = path.join(targetDir, doc.file);
      return { doc, filePath, ...mergeRuleFile(filePath, doc.content, 'standalone') };
    });

    console.log(`\n📝 Target: ${targetDir.replace(/\\/g, '/')}`);
    if (merged.length === 1) {
      console.log(`   ${merged[0].doc.file}  (${merged[0].existed ? 'overwrite our own file' : 'create new'})`);
      console.log(`\nContent to be written:\n`);
      console.log(indent(merged[0].content));
    } else {
      const fresh = merged.filter(m => !m.existed).length;
      console.log(`   ${merged.length} files — ${fresh} new, ${merged.length - fresh} overwritten (all DevsMind's own):\n`);
      for (const m of merged) {
        console.log(`   ${m.existed ? '↻' : '+'} ${m.doc.file}`);
        if (m.doc.summary) console.log(`     ${m.doc.summary}`);
      }
    }

    const indexLines = mem.pointerFile && docs.length > 1 ? MEMORY_TOPICS.map(renderIndexLine).join('\n') : null;
    if (indexLines && mem.pointerFile) {
      console.log(`\n   …plus an index block in ${mem.pointerFile.file} (that file is what loads every session — without it these are never found):\n`);
      console.log(indent(indexLines));
    }

    const ok = await confirmPrompt('Write this?', true);
    if (!ok) {
      console.log('\nAborted — nothing written.');
      return;
    }
    for (const m of merged) writeConfigFile(m.filePath, m.content);
    console.log(
      `\n✅ Seeded ${target.label}'s ${mem.featureName} — ` +
      `${merged.length === 1 ? merged[0].filePath.replace(/\\/g, '/') : `${merged.length} files in ${targetDir.replace(/\\/g, '/')}`}`
    );

    if (mem.pointerFile) {
      const pointerPath = path.join(targetDir, mem.pointerFile.file);
      const body = indexLines ?? singlePointerLine(docs[0].file);
      const pointerConfirm = await confirmPrompt(
        `\nAlso write the ${indexLines ? 'index block' : 'pointer line'} into ${mem.pointerFile.file}, so this gets found ` +
        `(it only loads "on demand" otherwise)?`,
        true
      );
      if (pointerConfirm) {
        const pointerMerged = mergeRuleFile(pointerPath, body, mem.pointerFile.style);
        if (pointerMerged.error) {
          console.error(`❌ ${pointerMerged.error}`);
        } else {
          writeConfigFile(pointerPath, pointerMerged.content);
          console.log(`✅ ${indexLines ? 'Index' : 'Pointer'} written to ${pointerPath.replace(/\\/g, '/')}`);
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

/** The tools that have a memory/skills store DevsMind can safely write to — the only valid `--tool` values. */
function memoryCapableTargets(): IdeTarget[] {
  return TARGETS.filter(t => t.memory.supported && (t.memory.scopes?.length ?? 0) > 0);
}

/**
 * The `--print` / non-TTY path: resolve a target without prompting, then reuse the same manual
 * rendering the interactive flow already offers. Defaults to Claude Code's one-file-per-fact
 * shape rather than picking arbitrarily — it is the richest of the two (a store that ranks files
 * individually gets every topic separately), so it is the one worth seeing when you haven't said
 * which tool you mean. `--tool` prints exactly what that tool would receive instead.
 */
function printNonInteractive(toolId: string | undefined, workspaceRoot: string): void {
  const capable = memoryCapableTargets();
  const valid = capable.map(t => t.id).join(', ');

  let target: IdeTarget | undefined;
  if (toolId) {
    target = getTarget(toolId);
    if (!target) {
      console.error(`❌ Unknown tool "${toolId}". Valid values for --tool: ${valid}`);
      process.exit(1);
      return;
    }
    if (!target.memory.supported || !target.memory.scopes?.length) {
      console.error(
        `❌ ${target.label} has no memory store DevsMind can pre-seed.\n` +
        `   ${target.memory.note}\n` +
        `   Tools that do: ${valid}`
      );
      process.exit(1);
      return;
    }
  } else {
    target = capable.find(t => t.id === 'claude-code') ?? capable[0];
    console.log(`ℹ️  No --tool given — showing the ${target.label} shape. Others: ${valid}\n`);
  }

  const scope = target.memory.scopes![0];
  printManual(target.label, scope, workspaceRoot, buildDocs(target, scope), target.memory.pointerFile?.file);
}

/**
 * Turn the shared topics into the file shape this particular store reads:
 * one file per topic when it ranks files individually, one combined document
 * otherwise. The tool's own `wrap` (e.g. Skills frontmatter) applies only to the
 * combined shape — per-topic files carry their own frontmatter already.
 */
function buildDocs(target: IdeTarget, scope: MemoryScope): PlannedDoc[] {
  if (scope.format === 'memory-files') {
    return MEMORY_TOPICS.map(topic => ({
      file: `${topic.name}.md`,
      content: renderTopicFile(topic, MEMORY_FILE_HEADER),
      summary: topic.description,
    }));
  }

  const combined = renderCombined(MEMORY_FILE_HEADER);
  const content = scope.format === 'skill-md' && target.memory.wrap ? target.memory.wrap(combined) : combined;
  return [{ file: scope.file ?? 'devsmind.md', content }];
}

/** Fallback for a single-file store whose index still wants one line pointing at it. */
function singlePointerLine(file: string): string {
  return `See \`${file}\` in this folder for the DevsMind workflow contract — \`start_session\` before your ` +
    `first write (every write call requires that session_id; reads don't), \`search_nodes\` (query and/or a ` +
    `real-regex \`pattern\`) before any grep, \`edit_node\` for every file you write, ` +
    `\`commit_changes\` (with \`message\`, \`reasoning\`, and \`feedback\`) before the turn ends.`;
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

function printManual(
  label: string,
  scope: MemoryScope,
  workspaceRoot: string,
  docs: PlannedDoc[],
  pointerFile?: string
): void {
  const divider = '─'.repeat(70);
  const dirHint = scope.needsUserConfirmedDir
    ? `${resolveOsPath(scope.dir)}/<your-project-hash>/...`
    : scope.scope === 'project'
      ? path.join(workspaceRoot, resolveOsPath(scope.dir)).replace(/\\/g, '/')
      : resolveOsPath(scope.dir);
  const dir = String(dirHint).replace(/\\/g, '/');

  console.log(`\n${divider}`);
  console.log(` Seed DevsMind into ${label}`);
  console.log(`${divider}`);
  console.log(`\n1. Create ${docs.length === 1 ? 'this file' : `these ${docs.length} files`} under:`);
  console.log(`   ${dir}/`);

  for (const doc of docs) {
    console.log(`\n${divider}`);
    console.log(` ${dir}/${doc.file}`);
    console.log(`${divider}\n`);
    console.log(indent(doc.content));
  }

  if (pointerFile) {
    console.log(`\n${divider}`);
    console.log(` 2. Add to ${dir}/${pointerFile} — without this they only load "on demand" and are never found:`);
    console.log(`${divider}\n`);
    console.log(indent(docs.length > 1 ? MEMORY_TOPICS.map(renderIndexLine).join('\n') : singlePointerLine(docs[0].file)));
    console.log('');
  }
}

function indent(text: string): string {
  return text.split('\n').map(l => '   ' + l).join('\n');
}
