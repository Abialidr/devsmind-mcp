import { diffLines } from 'diff';
import { HistoryEdit } from '../db/schema';

/** One line of a rendered diff. `ctx` lines are unchanged and shown for orientation. */
export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
  /** 1-based line number in the "before" text. Absent for a pure `add` line — it has no old position. */
  old_line?: number;
  /** 1-based line number in the "after" text. Absent for a pure `del` line — it has no new position. */
  new_line?: number;
}

export interface EditDiff {
  at: string;
  reasoning: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  /**
   * True only for the newest edit whose recorded `after` still matches what is on disk.
   * Anything else is unsafe to restore — see `revert.ts` for the check that actually gates it;
   * this flag only decides whether the UI offers the button.
   */
  revertable: boolean;
  /** Why it isn't revertable, when it isn't. Shown to the user rather than a dead button. */
  blocked_reason?: string;
}

/**
 * Line diff between two snapshots, trimmed to `context` unchanged lines around each change.
 * Collapsed runs are dropped rather than summarized: the panel shows one entity, not a file,
 * so there is rarely enough untouched code for a "…N lines…" marker to earn its space.
 */
export function diffSnapshots(before: string, after: string, context = 3): DiffLine[] {
  const parts = diffLines(before, after);
  const out: DiffLine[] = [];
  let oldLine = 1, newLine = 1;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const lines = p.value.split('\n');
    // split('\n') on a trailing newline yields a final empty element that is not a line.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    if (p.added || p.removed) {
      const type = p.added ? 'add' : 'del';
      for (const text of lines) {
        if (type === 'add') out.push({ type, text, new_line: newLine++ });
        else out.push({ type, text, old_line: oldLine++ });
      }
      continue;
    }

    // Unchanged: number every line as we pass through it (both counters always advance
    // together here, since it's the same text in both), THEN decide which of those numbered
    // lines are worth keeping — counting through a trimmed-away line still has to happen, or
    // every line number after the first trim would be wrong.
    const numbered = lines.map(text => ({ type: 'ctx' as const, text, old_line: oldLine++, new_line: newLine++ }));

    const isFirst = i === 0;
    const isLast = i === parts.length - 1;
    if (numbered.length <= context * 2) {
      out.push(...numbered);
      continue;
    }
    if (!isFirst) out.push(...numbered.slice(0, context));
    if (!isLast) out.push(...numbered.slice(-context));
  }

  return out;
}

/**
 * A unified `+`/`-`/` ` diff as a single string, for showing an edit back in the chat session.
 *
 * Fenced as ```diff by the caller, it renders red/green in any client that highlights markdown,
 * and stays readable as plain text in one that doesn't — which is the whole point of returning it
 * from a tool call: the change is visible where it happened, without opening the graph.
 */
export function renderUnifiedDiff(before: string, after: string, context = 3): string {
  return diffSnapshots(before, after, context)
    .map(l => (l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text)
    .join('\n');
}

/** Builds the per-edit diffs for one history entry, newest last — the order they happened in. */
export function diffEdits(
  edits: HistoryEdit[],
  opts: { revertableIndex: number; blockedReason?: string }
): EditDiff[] {
  return edits.map((e, i) => {
    const lines = diffSnapshots(e.before, e.after);
    const revertable = i === opts.revertableIndex;
    return {
      at: e.at,
      reasoning: e.reasoning,
      lines,
      added: lines.filter(l => l.type === 'add').length,
      removed: lines.filter(l => l.type === 'del').length,
      revertable,
      blocked_reason: !revertable && i === edits.length - 1 ? opts.blockedReason : undefined
    };
  });
}
