import * as fs from 'fs';
import * as path from 'path';
import prompts from 'prompts';
import { DevMindDatabase, formatReasoning } from '../db/database';
import { DbNode, DbHistory } from '../db/schema';

function findDevmindDir(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, '.devmind');
    if (fs.existsSync(path.join(candidate, 'config.json'))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function handlePrune(opts: { path?: string }) {
  const cwd = process.cwd();
  let devmindDir: string | null;

  if (opts.path) {
    const resolved = path.resolve(opts.path);
    devmindDir = fs.existsSync(path.join(resolved, 'config.json')) ? resolved : null;
  } else {
    devmindDir = findDevmindDir(cwd);
  }

  if (!devmindDir) {
    console.error(
      `❌ No .devmind directory found.\n` +
      `   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.`
    );
    process.exit(1);
  }

  const dbFile = path.join(devmindDir, 'brain.db');
  console.log(`\n🧠 Opening DevsMind database: ${dbFile}\n`);
  
  const db = new DevMindDatabase(dbFile);

  try {
    await runPruneLoop(db);
  } finally {
    // No catch here on purpose: index.ts's own action wrapper already catches, logs this
    // exact "Pruning failed" message, and calls process.exit(1) — swallowing the error here
    // (as this used to do) meant that outer handler never ran, so a genuine failure mid-prune
    // still exited 0. db.close() only needs guaranteed cleanup, not error interception.
    db.close();
  }
}

async function runPruneLoop(db: DevMindDatabase) {
  while (true) {
    const nodes = db.getAllNodes();
    
    if (nodes.length === 0) {
      console.log('📝 The database is empty. No nodes found.');
      return;
    }

    const deprecatedCount = nodes.filter(n => n.deprecated === 1).length;

    console.log(`📊 Database Stats: ${nodes.length} total node(s) (${deprecatedCount} deprecated)`);

    const choices = [
      {
        title: '❌ DELETE ALL NODES (Clear database permanently)',
        value: 'delete_all'
      },
      {
        title: `🧹 Prune all deprecated nodes (${deprecatedCount} node(s))`,
        value: 'prune_deprecated'
      },
      {
        title: '🚪 Exit Pruning',
        value: 'exit'
      },
      {
        title: '------------------------------------------------',
        value: 'divider',
        disabled: true
      }
    ];

    // Add nodes to choices
    for (const node of nodes) {
      const statusLabel = node.deprecated === 1 ? ' [DEPRECATED]' : '';
      choices.push({
        title: `${node.name} (${node.id})${statusLabel}`,
        value: `node:${node.id}`
      });
    }

    const response = await prompts({
      type: 'select',
      name: 'action',
      message: 'Select a node to inspect/delete, or choose a bulk action:',
      choices,
      initial: 2 // Exit is index 2
    });

    if (!response.action || response.action === 'exit') {
      console.log('🚪 Exiting pruning. Goodbye!');
      break;
    }

    if (response.action === 'delete_all') {
      const confirm = await prompts({
        type: 'confirm',
        name: 'yes',
        message: '🚨 WARNING: This will permanently delete ALL nodes, connections, and history records. Are you absolutely sure?',
        initial: false
      });

      if (confirm.yes) {
        const allNodes = db.getAllNodes();
        const tx = (db as any).db.transaction(() => {
          for (const n of allNodes) {
            db.deleteNode(n.id);
          }
        });
        tx();
        console.log('💥 All nodes and history records deleted successfully.');
      }
      continue;
    }

    if (response.action === 'prune_deprecated') {
      const deprecatedNodes = nodes.filter(n => n.deprecated === 1);
      if (deprecatedNodes.length === 0) {
        console.log('ℹ️ No deprecated nodes to prune.');
        continue;
      }

      const confirm = await prompts({
        type: 'confirm',
        name: 'yes',
        message: `Are you sure you want to permanently delete all ${deprecatedNodes.length} deprecated nodes and their history?`,
        initial: false
      });

      if (confirm.yes) {
        const tx = (db as any).db.transaction(() => {
          for (const n of deprecatedNodes) {
            db.deleteNode(n.id);
          }
        });
        tx();
        console.log(`🧹 Successfully pruned ${deprecatedNodes.length} deprecated node(s).`);
      }
      continue;
    }

    if (response.action.startsWith('node:')) {
      const nodeId = response.action.substring(5);
      const node = db.getNode(nodeId);
      if (node) {
        await handleNodeMenu(db, node);
      }
    }
  }
}

async function handleNodeMenu(db: DevMindDatabase, node: DbNode) {
  while (true) {
    const freshNode = db.getNode(node.id);
    if (!freshNode) {
      // Node was deleted
      break;
    }

    console.log(`\n==================================================`);
    console.log(`🔍 Node Details: ${freshNode.name}`);
    console.log(`==================================================`);
    console.log(`🆔 ID:          ${freshNode.id}`);
    console.log(`📁 File:        ${freshNode.file_path}`);
    console.log(`🏷️  Type:        ${freshNode.type}`);
    console.log(`📝 Signature:   ${freshNode.signature || 'None'}`);
    console.log(`⚠️  Status:      ${freshNode.deprecated === 1 ? '🔴 DEPRECATED' : '🟢 ACTIVE'}`);
    console.log(`📅 Created:     ${freshNode.created_at}`);

    const response = await prompts({
      type: 'select',
      name: 'action',
      message: 'What would you like to do with this node?',
      choices: [
        { title: '📄 View Current Code Snapshot', value: 'view_code' },
        { title: '📜 View Change History (Interactive)', value: 'view_history' },
        { title: '❌ Delete Node (Permanently prune)', value: 'delete' },
        { title: '⬅️ Back to list', value: 'back' }
      ]
    });

    if (!response.action || response.action === 'back') {
      break;
    }

    if (response.action === 'view_code') {
      const history = db.getFullHistory(freshNode.id);
      if (history.length === 0) {
        console.log('\n❌ No code snapshots found for this node.');
      } else {
        console.log(`\n💻 Latest Code Snapshot for ${freshNode.name}:\n`);
        console.log(history[0].code_snapshot);
      }
      await prompts({ type: 'text', name: 'ok', message: '\nPress Enter to continue...' });
    }

    if (response.action === 'view_history') {
      const history = db.getFullHistory(freshNode.id);
      if (history.length === 0) {
        console.log('\n❌ No history entries found for this node.');
        await prompts({ type: 'text', name: 'ok', message: '\nPress Enter to continue...' });
      } else {
        await runHistoryPager(history);
      }
    }

    if (response.action === 'delete') {
      const confirm = await prompts({
        type: 'confirm',
        name: 'yes',
        message: `🚨 Are you sure you want to permanently delete "${freshNode.name}" and all its history logs?`,
        initial: false
      });

      if (confirm.yes) {
        db.deleteNode(freshNode.id);
        console.log(`🗑️ Node "${freshNode.name}" deleted.`);
        break; // break node menu loop and return to list
      }
    }
  }
}

async function runHistoryPager(history: DbHistory[]) {
  let index = 0;
  while (true) {
    const entry = history[index];
    console.log(`\n==================================================`);
    console.log(`📜 History Entry ${index + 1} of ${history.length}`);
    console.log(`📅 Date: ${entry.created_at} (Updated: ${entry.updated_at})`);
    console.log(`🆔 Session: ${entry.session_id}`);
    console.log(`==================================================`);
    
    try {
      const parsedReasoning = JSON.parse(entry.reasoning);
      console.log(formatReasoning(parsedReasoning));
    } catch {
      console.log(entry.reasoning);
    }

    const choices = [
      { title: '📄 View Code Snapshot for this version', value: 'view_code' }
    ];

    if (index < history.length - 1) {
      choices.push({ title: '➡️ Next Entry', value: 'next' });
    }
    if (index > 0) {
      choices.push({ title: '⬅️ Previous Entry', value: 'prev' });
    }
    choices.push({ title: '🔙 Back to Node Details', value: 'back' });

    const response = await prompts({
      type: 'select',
      name: 'action',
      message: 'Choose navigation option:',
      choices
    });

    if (!response.action || response.action === 'back') {
      break;
    }

    if (response.action === 'view_code') {
      console.log(`\n💻 Code Snapshot (Version ${index + 1}):\n`);
      console.log(entry.code_snapshot);
      await prompts({ type: 'text', name: 'ok', message: '\nPress Enter to continue...' });
    } else if (response.action === 'next') {
      index++;
    } else if (response.action === 'prev') {
      index--;
    }
  }
}
