import * as fs from 'fs';
import * as path from 'path';
import prompts from 'prompts';
import { resolveDevmindDir } from '../utils/config';
import { DevMindDatabase } from '../db/database';
import { DbWorkflow } from '../db/schema';
import { importWorkflowDocs } from '../db/workflow-import';

function openDb(pathOpt?: string): { db: DevMindDatabase; devmindDir: string } {
  const devmindDir = resolveDevmindDir(pathOpt);
  if (!devmindDir) {
    console.error(
      `❌ No .devmind directory found.\n` +
      `   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.`
    );
    process.exit(1);
  }
  return { db: new DevMindDatabase(path.join(devmindDir, 'brain.db')), devmindDir };
}

/** `devsmind workflow` — interactive list/view/pause/resume. Day-to-day creation and step-recording happens through the MCP tools the agent calls, not this command. */
export async function handleWorkflow(opts: { path?: string }): Promise<void> {
  const { db } = openDb(opts.path);
  try {
    await runWorkflowLoop(db);
  } finally {
    db.close();
  }
}

async function runWorkflowLoop(db: DevMindDatabase) {
  while (true) {
    const workflows = db.listWorkflows();
    if (workflows.length === 0) {
      console.log('📝 No workflows yet. Create one via the workflow_create MCP tool, or import existing docs with `devsmind workflow import <path>`.');
      return;
    }

    // No status column any more — which workflow anyone is "on" is per-session and local, so the
    // terminal (which is not a session) has nothing to show for it. Ordering by last-touched is
    // what replaced it: live threads sit at the top on their own.
    const choices = workflows.map(w => ({
      title: `${w.archived ? '📦' : '📋'} ${w.name}`,
      value: w.id
    }));
    choices.push({ title: '🚪 Exit', value: 'exit' });

    const response = await prompts({
      type: 'select',
      name: 'id',
      message: `Workflows (${workflows.length}):`,
      choices
    });

    if (!response.id || response.id === 'exit') {
      console.log('🚪 Goodbye!');
      break;
    }

    await showWorkflowMenu(db, response.id);
  }
}

async function showWorkflowMenu(db: DevMindDatabase, id: string) {
  while (true) {
    let workflow: DbWorkflow;
    let steps, artifacts;
    try {
      ({ workflow, steps, artifacts } = db.getWorkflowContext(id));
    } catch {
      return;
    }

    console.log(`\n==================================================`);
    console.log(`📋 ${workflow.name}${workflow.archived ? '  [archived]' : ''}`);
    console.log(`==================================================`);
    console.log(workflow.description);
    console.log(`\nSteps (${steps.length}):`);
    for (const s of steps) {
      const nodes = s.node_ids ? (JSON.parse(s.node_ids) as string[]) : [];
      console.log(`  ${s.step_index}. ${s.summary}${nodes.length ? `  (${nodes.length} node${nodes.length > 1 ? 's' : ''})` : ''}`);
    }
    console.log(`\nDocs (${artifacts.length}):`);
    for (const a of artifacts) {
      console.log(`  - [${a.type}] ${a.source_name} → ${a.file_path.replace(/\\/g, '/')}`);
    }

    // Resume/pause are gone from here on purpose: binding is per-SESSION now, and the terminal is
    // not a session. Archive is what remains, and it matters — without it a workflow could never
    // be retired at all, and the list would grow forever.
    const response = await prompts({
      type: 'select',
      name: 'action',
      message: 'Action:',
      choices: [
        workflow.archived
          ? { title: '📤 Unarchive (show in the list again)', value: 'unarchive' }
          : { title: '📦 Archive (hide from the list)', value: 'archive' },
        { title: '⬅️ Back to list', value: 'back' }
      ]
    });

    if (!response.action || response.action === 'back') return;
    if (response.action === 'archive') db.setWorkflowArchived(id, true);
    if (response.action === 'unarchive') db.setWorkflowArchived(id, false);
  }
}

/** `devsmind workflow import <path>` — imports a folder of .md flow docs, or a single file, as paused workflows. */
export async function handleWorkflowImport(pathArg: string, opts: { path?: string }): Promise<void> {
  const { db } = openDb(opts.path);
  try {
    const resolved = path.resolve(pathArg);
    const isDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
    const result = importWorkflowDocs(db, isDir ? resolved : undefined, isDir ? undefined : resolved);

    console.log(`\n📥 Import complete.`);
    if (result.created.length) console.log(`   Created (${result.created.length}): ${result.created.join(', ')}`);
    if (result.updated.length) console.log(`   Updated (${result.updated.length}): ${result.updated.join(', ')}`);
    if (result.skipped.length) console.log(`   Skipped (${result.skipped.length}): ${result.skipped.join(', ')}`);
    if (!result.created.length && !result.updated.length && !result.skipped.length) {
      console.log('   Nothing to import.');
    }
    console.log();
  } finally {
    db.close();
  }
}
