import * as path from 'path';
import prompts from 'prompts';
import { resolveDevmindDir } from '../utils/config';
import { DevMindDatabase } from '../db/database';
import { diffSnapshots, DiffLine } from '../utils/diff';
import { revertLastEdit } from '../db/revert';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function openBrain(optPath?: string): { db: DevMindDatabase; devmindDir: string } {
  const devmindDir = resolveDevmindDir(optPath);
  if (!devmindDir) {
    console.error(
      `❌ No .devmind directory found.\n` +
      `   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.`
    );
    process.exit(1);
  }
  return { db: new DevMindDatabase(path.join(devmindDir, 'brain.db')), devmindDir };
}

function printLines(lines: DiffLine[]): void {
  for (const l of lines) {
    if (l.type === 'add') console.log(`${GREEN}+ ${l.text}${RESET}`);
    else if (l.type === 'del') console.log(`${RED}- ${l.text}${RESET}`);
    else console.log(`${DIM}  ${l.text}${RESET}`);
  }
}

/** `devsmind diff <node_id>` — what the agent changed about one entity, newest last. */
export async function handleDiff(nodeId: string, opts: { path?: string }): Promise<void> {
  const { db } = openBrain(opts.path);
  try {
    const node = db.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const entry = db.getLatestHistory(resolvedId);

    if (!entry) {
      console.log(`\n${BOLD}${resolvedId}${RESET}\n   No history recorded.`);
      return;
    }
    if (!entry.edits.length) {
      console.log(
        `\n${BOLD}${resolvedId}${RESET}\n` +
        `   ${DIM}No diff available — this change was recorded without a before-state.${RESET}\n` +
        `   ${DIM}Entries predating diff tracking, and stage_change entries (non-TS/JS), have none.${RESET}`
      );
      return;
    }

    console.log(`\n${BOLD}${resolvedId}${RESET}  ${DIM}${entry.edits.length} edit(s) this session${RESET}`);
    entry.edits.forEach((e, i) => {
      const lines = diffSnapshots(e.before, e.after);
      const added = lines.filter(l => l.type === 'add').length;
      const removed = lines.filter(l => l.type === 'del').length;
      console.log(`\n${DIM}── ${new Date(e.at).toLocaleString()}  ${RESET}${GREEN}+${added}${RESET} ${RED}-${removed}${RESET}`);
      const what = e.reasoning.split('\n').find(l => /^What changed:/i.test(l));
      if (what) console.log(`${DIM}   ${what.replace(/^What changed:\s*/i, '')}${RESET}`);
      console.log('');
      printLines(lines);
      if (i === entry.edits.length - 1) {
        console.log(`\n${DIM}   devsmind revert ${resolvedId}   ${RESET}${DIM}undoes this one${RESET}`);
      }
    });
    console.log('');
  } finally {
    db.close();
  }
}

/**
 * `devsmind revert <node_id>` — restore an entity to before its newest recorded edit.
 *
 * Confirms first, and shows the diff being undone: this erases the change and its recorded
 * reasoning, and nothing here can bring either back.
 */
export async function handleRevert(nodeId: string, opts: { path?: string; yes?: boolean }): Promise<void> {
  const { db, devmindDir } = openBrain(opts.path);
  try {
    const node = db.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;

    if (!opts.yes) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(`❌ devsmind revert needs an interactive terminal to confirm. Pass --yes to skip the prompt.`);
        process.exit(1);
      }

      const entry = db.getLatestHistory(resolvedId);
      if (entry?.edits.length) {
        const last = entry.edits[entry.edits.length - 1];
        console.log(`\n${BOLD}${resolvedId}${RESET} — about to undo:\n`);
        printLines(diffSnapshots(last.before, last.after));
      }

      const { go } = await prompts({
        type: 'confirm',
        name: 'go',
        message: 'Restore the code and erase this change from history?',
        initial: false
      });
      if (!go) {
        console.log('   Cancelled — nothing changed.');
        return;
      }
    }

    const result = revertLastEdit(db, devmindDir, resolvedId);
    if (!result.ok) {
      console.error(`\n❌ ${result.error}`);
      process.exit(1);
    }

    console.log(`\n✅ Reverted ${resolvedId}`);
    console.log(`   File    : ${String(result.file_path).replace(/\\/g, '/')}`);
    if (result.was_staged) console.log(`   ${DIM}The change was still staged, so there was no history to erase.${RESET}`);
    else if (result.entry_deleted) console.log(`   ${DIM}History entry deleted.${RESET}`);
    if (result.note) console.log(`   ${DIM}${result.note}${RESET}`);
    console.log('');
  } finally {
    db.close();
  }
}
