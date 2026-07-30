/**
 * A shared renderer for `DevMindDatabase`'s `onSyncProgress` callback — used by any CLI command
 * that opens a (possibly large) `.devmind` folder and wants the user to see it's alive during
 * the constructor's silent `syncFromDisk()` pass, rather than staring at a blank terminal with
 * no way to tell "still working" from "hung".
 */

const PHASE_LABEL: Record<string, string> = {
  history: 'history',
  graph: 'graph',
  vectors: 'vectors'
};

let lastLineLength = 0;

export function renderSyncProgress(phase: string, done: number, total: number): void {
  const label = PHASE_LABEL[phase] || phase;
  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  const line = `   Syncing ${label} from disk: ${done}/${total} (${pct}%)...`;

  if (process.stdout.isTTY) {
    // Overwrite the same line in place — pad with spaces to clear any leftover tail from a
    // longer previous line (e.g. "vectors" -> "history" phase transitions are shorter/longer).
    process.stdout.write('\r' + line.padEnd(lastLineLength) );
    lastLineLength = line.length;
  } else {
    // Non-TTY (piped output, CI logs) — cursor control is meaningless there, so just print
    // one line per throttled update instead of spamming; still cheap since the caller already
    // throttles to ~100 updates regardless of scale.
    console.log(line);
  }
}

/** Call once after construction completes, so the next real console.log starts on a clean line. */
export function clearSyncProgressLine(): void {
  if (process.stdout.isTTY && lastLineLength > 0) {
    process.stdout.write('\r' + ' '.repeat(lastLineLength) + '\r');
  }
  lastLineLength = 0;
}
