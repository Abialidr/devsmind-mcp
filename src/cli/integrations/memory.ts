import { IdeTarget, TARGETS, getTarget } from './registry';
import { renderMemoryPrompt } from './memory-topics';
import { pickTarget, confirmPrompt, CancelledError } from './prompt';

/**
 * `devsmind memory` — for a tool with a real memory mechanism, prints ONE natural-language block
 * to paste into any AI chat, framed as an explicit "remember this" request. DevsMind writes
 * nothing on your behalf. For a tool with NO real memory mechanism, prints a short explanation
 * instead — asking it to "remember" has nothing to attach to, so there's no prompt to give.
 *
 * Why print at all instead of writing a file: research across all 9 tools DevsMind integrates
 * with turned up the same finding stated independently in several of those tools' own docs —
 * background/automatic memory is discretionary by design (Windsurf, Codex, and Qwen say so
 * outright; e.g. "auto-memory is best-effort, QWEN.md is guaranteed"), while an EXPLICIT in-chat
 * request is the one thing that reliably lands. A silently-written file never crosses that
 * trigger at all. So instead of maintaining 9 different internal file formats, this hands the
 * user one prompt and lets each tool's own native memory feature do whatever it does best with it.
 *
 * Why skip some tools entirely: Antigravity (IDE + CLI) and Kiro have no genuine background-memory
 * concept to ask anything of, so they get pointed at `devsmind skill` instead. Codex does have
 * Memories once the user enables them in Settings > Personalization > Memory, so its flow first
 * prints those setup steps and then prints the pasteable prompt.
 *
 * `--tool` changes both the framing line (e.g. "Cursor calls this Memories") AND, for tools
 * with a real mechanism, a short tool-specific hint on how that tool's memory actually
 * gets saved (`target.memory.askHint`) — the core two-rule-lead-in + full contract stays the same.
 */
export async function handleMemory(opts: { path?: string; print?: boolean; tool?: string }): Promise<void> {
  const target = await resolveTarget(opts);
  if (!target) return; // already reported: unknown --tool, or the interactive picker was cancelled

  console.log(`\nℹ️  ${target.label} calls this "${target.memory.featureName}".`);
  if (target.memory.note) console.log(`   ${target.memory.note}`);

  if (!target.memory.hasRealMechanism) {
    console.log(`\n🚫 ${target.label} has no real background-memory mechanism to ask anything of — there's nothing to paste here.`);
    console.log(`   Run \`devsmind skill --tool ${target.id}\` instead - it writes an explicitly-invokable command file for ${target.label}.`);
    console.log('');
    return;
  }

  if (target.id === 'codex') {
    const ready = await ensureCodexMemoryEnabled(!!opts.print);
    if (!ready) return;
  }

  console.log(`\nPaste this into your ${target.label} chat and ask it to remember it:\n`);
  console.log(indent(renderMemoryPrompt(target)));
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

async function ensureCodexMemoryEnabled(nonInteractive: boolean): Promise<boolean> {
  console.log('\nCodex memory setup:');
  console.log('   1. Open Codex from the left sidebar.');
  console.log('   2. Click the gear icon, then choose Codex settings.');
  console.log('   3. Open Personalization.');
  console.log('   4. Under Memory, turn on Enable memories.');
  console.log('   5. Also turn on Allow memory generation from tool-assisted chats if you want Codex to learn from MCP/tool-assisted work.');

  if (nonInteractive) {
    console.log('\nAfter those toggles are on, paste the prompt below into Codex chat.');
    return true;
  }

  try {
    const ok = await confirmPrompt('Have you enabled Codex memories now?', true);
    if (!ok) {
      console.log('\nNo problem. Enable Codex memories first, then re-run `devsmind memory --tool codex`.');
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof CancelledError) {
      console.log('\nCancelled.');
      return false;
    }
    throw err;
  }
}
