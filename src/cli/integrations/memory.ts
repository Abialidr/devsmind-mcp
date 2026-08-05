import { IdeTarget, TARGETS, getTarget } from './registry';
import { renderMemoryPrompt } from './memory-topics';
import { pickTarget, CancelledError } from './prompt';

/**
 * `devsmind memory` — prints ONE natural-language block to paste into any AI chat, framed as an
 * explicit "remember this" request. DevsMind writes nothing on your behalf.
 *
 * Why: research across all 9 tools DevsMind integrates with turned up the same finding stated
 * independently in several of those tools' own docs — background/automatic memory is
 * discretionary by design (Windsurf, Codex, and Qwen say so outright; e.g. "auto-memory is
 * best-effort, QWEN.md is guaranteed"), while an EXPLICIT in-chat request is the one thing that
 * reliably lands. A silently-written file never crosses that trigger at all. And 5 of the 9 tools
 * (Cursor, VS Code/Copilot, Windsurf, Kiro, Qwen) have no file DevsMind could safely write to in
 * the first place — hand-writing into an undocumented or auto-generated store risks corrupting
 * it. So instead of maintaining 9 different internal file formats, this hands the user one prompt
 * and lets each tool's own native memory feature do whatever it already does best with it.
 *
 * `--tool` only changes the framing line (which feature name to call out, e.g. "Cursor calls
 * this Memories") — the prompt itself, from `renderMemoryPrompt`, is the same for everyone.
 */
export async function handleMemory(opts: { path?: string; print?: boolean; tool?: string }): Promise<void> {
  const target = await resolveTarget(opts);
  if (!target) return; // already reported: unknown --tool, or the interactive picker was cancelled

  console.log(`\nℹ️  ${target.label} calls this "${target.memory.featureName}".`);
  if (target.memory.note) console.log(`   ${target.memory.note}`);
  console.log(`\n📋 Paste this into your ${target.label} chat and ask it to remember it:\n`);
  console.log(indent(renderMemoryPrompt()));
  console.log('');
}

/**
 * `--tool` resolves directly. Otherwise, an interactive TTY offers the same picker `devsmind
 * rule`/`devsmind mcp` use (purely for the framing line — nothing here depends on the answer
 * the way file placement used to); a non-interactive/piped run — or an explicit `--print` — falls
 * back to Claude Code's framing and says so, so scripted use never blocks on a prompt.
 */
async function resolveTarget(opts: { print?: boolean; tool?: string }): Promise<IdeTarget | undefined> {
  if (opts.tool) {
    const target = getTarget(opts.tool);
    if (!target) {
      console.error(`❌ Unknown tool "${opts.tool}". Valid values for --tool: ${TARGETS.map(t => t.id).join(', ')}`);
      process.exit(1);
      return undefined;
    }
    return target;
  }

  if (!opts.print && process.stdin.isTTY && process.stdout.isTTY) {
    try {
      return await pickTarget();
    } catch (err) {
      if (err instanceof CancelledError) {
        console.log('\nCancelled.');
        return undefined;
      }
      throw err;
    }
  }

  const fallback = getTarget('claude-code')!;
  console.log(`ℹ️  No --tool given — showing generic phrasing (the prompt itself is identical for every tool). Others: ${TARGETS.map(t => t.id).join(', ')}`);
  return fallback;
}

function indent(text: string): string {
  return text.split('\n').map(l => '   ' + l).join('\n');
}
