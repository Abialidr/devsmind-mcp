import * as path from 'path';
import { resolveDevmindDir } from '../utils/config';
import { DevMindDatabase } from '../db/database';
import { runAnalysis, AnalysisReport } from '../db/analyze';
import { renderSyncProgress, clearSyncProgressLine } from './sync-progress';

/**
 * `devsmind analyze` — local, zero-AI graph health check (Phase 1 of the roadmap's
 * `analyze_graph`). Pure SQLite queries, filesystem checks, and `git log` — no LLM
 * calls, no tokens spent. `--fix` applies only the safe/reversible fixes; everything
 * else is report-only and needs a human or AI to decide what to do about it.
 */
export async function handleAnalyze(opts: { path?: string; fix?: boolean; godEntityThreshold?: string }): Promise<void> {
  const devmindDir = resolveDevmindDir(opts.path);
  if (!devmindDir) {
    console.error(
      `❌ No .devmind directory found.\n` +
      `   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.`
    );
    process.exit(1);
  }

  const workspaceRoot = path.dirname(devmindDir);
  const dbPath = path.join(devmindDir, 'brain.db');
  const godEntityThreshold = opts.godEntityThreshold ? parseInt(opts.godEntityThreshold, 10) : undefined;

  console.log(`\n🩺 DevsMind — Analyze graph health${opts.fix ? ' (--fix)' : ''}`);
  console.log(`   Brain : ${devmindDir.replace(/\\/g, '/')}`);

  // Opening the DB runs a full syncFromDisk() pass — on a large brain that reads every
  // graph/history/vectors/workflows JSON file back into SQLite, and was previously silent here
  // (unlike `sync`/`describe`/`embed`, which already wire this same progress line), so it looked
  // hung instead of working on a many-thousand-node brain.
  const db = new DevMindDatabase(dbPath, { onSyncProgress: renderSyncProgress });
  clearSyncProgressLine();
  try {
    console.log('   Running health checks...');
    const report = runAnalysis(db, workspaceRoot, { fix: opts.fix === true, godEntityThreshold });
    printReport(report);
  } finally {
    db.close();
  }
}

const SECTIONS: { key: keyof AnalysisReport['summary']; label: string; fixable: boolean }[] = [
  { key: 'god_entities', label: 'God entities (high fan-in/out)', fixable: false },
  { key: 'circular_dependencies', label: 'Circular dependency cycles', fixable: false },
  { key: 'orphaned_nodes', label: 'Orphaned nodes (zero connections)', fixable: true },
  { key: 'dangling_edges', label: 'Dangling edges (broken references)', fixable: true },
  { key: 'duplicate_ids', label: 'Duplicate/case-collision node ids', fixable: false },
  { key: 'missing_developer_attribution', label: 'History missing developer attribution', fixable: false },
  { key: 'empty_code_snapshots', label: 'Empty code snapshots', fixable: false },
  { key: 'spurious_nodes', label: 'Spurious/built-in nodes', fixable: true },
  { key: 'missing_files', label: 'Nodes with missing files', fixable: true },
  { key: 'renamed_files', label: 'Renamed files (git-detected)', fixable: true },
  { key: 'untracked_files', label: 'Git-tracked files with zero graph nodes', fixable: false },
  { key: 'stray_output_dirs', label: 'Stray .devmind output directories blocking sync', fixable: true },
];

const MAX_ROWS = 20;

export function printReport(report: AnalysisReport) {
  const totalIssues = Object.values(report.summary).reduce((a, b) => a + b, 0);

  console.log(`\n${totalIssues === 0 ? '✅ Graph is clean — no issues found.' : `Found ${totalIssues} issue(s):`}\n`);

  for (const s of SECTIONS) {
    const count = report.summary[s.key];
    if (count === 0) continue;
    const fixNote = s.fixable ? (report.fixed ? ' — fixed' : ' (fixable with --fix)') : ' (report only — needs human/AI review)';
    console.log(`   ${s.label}: ${count}${fixNote}`);
  }

  if (totalIssues === 0) {
    console.log();
    return;
  }

  console.log(`\n${'─'.repeat(60)}`);
  for (const s of SECTIONS) {
    const rows = (report as any)[s.key] as any[];
    if (!rows || rows.length === 0) continue;
    console.log(`\n${s.label} (${rows.length}):`);
    for (const row of rows.slice(0, MAX_ROWS)) {
      console.log(`   ${formatRow(s.key, row)}`);
    }
    if (rows.length > MAX_ROWS) {
      console.log(`   … +${rows.length - MAX_ROWS} more`);
    }
  }
  console.log();

  if (!report.fixed) {
    const anyFixable = SECTIONS.some(s => s.fixable && report.summary[s.key] > 0);
    if (anyFixable) {
      console.log(`Run with --fix to soft-deprecate dead nodes, remove dangling edges, and migrate detected renames.\n`);
    }
  }
}

function formatRow(key: string, row: any): string {
  switch (key) {
    case 'god_entities':
      return `${row.name} (${row.id}) — degree ${row.degree}`;
    case 'circular_dependencies':
      return (row as string[]).join(' → ');
    case 'orphaned_nodes':
    case 'spurious_nodes':
    case 'missing_files':
      return `${row.name} (${row.id}) — ${row.file_path || 'no file'}`;
    case 'dangling_edges':
      return `${row.source_node_id} → ${row.target_node_id}`;
    case 'duplicate_ids':
      return row.ids.join(' | ');
    case 'missing_developer_attribution':
    case 'empty_code_snapshots':
      return `${row.node_id} (history ${row.id}, ${row.updated_at})`;
    case 'renamed_files':
      return `[${row.repo}] ${row.from} → ${row.to}${row.migrated ? ' (migrated)' : ''}`;
    case 'untracked_files':
      return `[${row.repo}] ${row.file}`;
    case 'stray_output_dirs':
      return `${row.kind} — ${row.target} (blocked writes for ${row.file_path})`;
    default:
      return JSON.stringify(row);
  }
}
