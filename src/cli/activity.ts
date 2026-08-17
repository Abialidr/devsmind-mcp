import { resolveDevmindDir } from '../utils/config';
import { listMessages, ActivityMessage } from '../db/activity';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function dayLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

/**
 * `devsmind activity` — the local, gitignored timeline in the terminal: read-only, same store
 * `devsmind view` → Activity reads. Revert/un-revert stays on the page, where the diff and the
 * confirmation live together; this is for a quick "what did I do" check without a browser.
 */
export async function handleActivity(opts: { path?: string; since?: string }): Promise<void> {
  const devmindDir = resolveDevmindDir(opts.path);
  if (!devmindDir) {
    console.error(
      `❌ No .devsmind directory found (nor a legacy .devmind one).\n` +
      `   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.`
    );
    process.exit(1);
  }

  const sinceDays = opts.since ? parseInt(opts.since, 10) : undefined;
  const cutoff = sinceDays !== undefined && !Number.isNaN(sinceDays)
    ? Date.now() - sinceDays * 24 * 60 * 60 * 1000
    : null;

  let messages = listMessages(devmindDir); // newest-created-first
  if (cutoff !== null) {
    messages = messages.filter(m => new Date(m.created_at).getTime() >= cutoff);
  }

  if (!messages.length) {
    console.log(
      `\n🗓️  No activity recorded${cutoff !== null ? ` in the last ${sinceDays} day(s)` : ''}.\n` +
      `   This fills in as edit_node + commit_changes run. Pass ${BOLD}message${RESET} on commit_changes\n` +
      `   so requests get titled here instead of just summarized.\n`
    );
    return;
  }

  const byDay = new Map<string, ActivityMessage[]>();
  for (const m of messages) {
    const key = new Date(m.created_at).toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(m);
  }

  console.log('');
  for (const [, dayMessages] of byDay) {
    console.log(`${BOLD}${dayLabel(dayMessages[0].created_at)}${RESET}  ${DIM}${dayMessages.length} message(s)${RESET}`);
    for (const m of dayMessages) {
      const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const title = m.request || m.summary || '(untitled change)';
      const revertedTag = m.status === 'reverted' ? `  ${RED}[reverted]${RESET}` : '';
      console.log(`  ${DIM}${time}${RESET}  ${title}${revertedTag}`);
      console.log(`  ${DIM}${' '.repeat(time.length)}  ${m.edits.length} change(s) · ${m.id}${RESET}`);
    }
    console.log('');
  }
  console.log(`${DIM}Full diffs + revert: devsmind view → Activity${RESET}\n`);
}
