import * as fs from 'fs';
import * as path from 'path';
import { DevMindDatabase } from './database';
import { resolveRepoPath, canonicalizePath } from '../utils/config';
import { getRenamedFilesSince, getChangedFilesSince } from '../utils/git';
import { INDEXABLE_EXTENSIONS } from '../utils/scanner';

export interface AnalysisOptions {
  fix?: boolean;
  godEntityThreshold?: number;
}

export interface AnalysisReport {
  fixed: boolean;
  summary: Record<string, number>;
  god_entities: { id: string; name: string; file_path: string; degree: number }[];
  circular_dependencies: string[][];
  orphaned_nodes: { id: string; name: string; file_path: string }[];
  dangling_edges: { source_node_id: string; target_node_id: string }[];
  duplicate_ids: { lower_id: string; ids: string[] }[];
  missing_developer_attribution: { id: string; node_id: string; updated_at: string }[];
  empty_code_snapshots: { id: string; node_id: string; updated_at: string }[];
  spurious_nodes: { id: string; name: string; file_path: string }[];
  missing_files: { id: string; name: string; file_path: string }[];
  renamed_files: { repo: string; from: string; to: string; migrated: boolean }[];
  untracked_files: { repo: string; file: string }[];
}

const LAST_ANALYSIS_KEY = 'last_analysis_at';
const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * Runs every local, zero-AI health check against the graph and — when `fix` is true —
 * applies only the safe/reversible fixes (soft-deprecate dead nodes, delete dangling
 * edges, migrate renames). Everything else is report-only: god entities, cycles,
 * duplicate ids, missing developer attribution, empty snapshots, and untracked files
 * all need human/AI judgement a mechanical fixer shouldn't make on its own.
 */
export function runAnalysis(db: DevMindDatabase, workspaceRoot: string, opts: AnalysisOptions = {}): AnalysisReport {
  const fix = opts.fix === true;
  const godEntityThreshold = opts.godEntityThreshold ?? 15;

  const god_entities = db.getGodEntities(godEntityThreshold);
  const circular_dependencies = db.getCircularDependencies();
  const orphaned_nodes = db.getOrphanedNodes().map(n => ({ id: n.id, name: n.name, file_path: n.file_path }));
  const dangling_edges = db.getDanglingEdges().map(c => ({ source_node_id: c.source_node_id, target_node_id: c.target_node_id }));
  const duplicate_ids = db.getDuplicateNodeIds().map(d => ({ lower_id: d.lowerId, ids: d.ids }));
  const missing_developer_attribution = db.getHistoryMissingDeveloper();
  const empty_code_snapshots = db.getEmptyCodeSnapshots();
  const { spurious: spurious_nodes, missingFile: missing_files } = db.findSpuriousAndMissingFileNodes(workspaceRoot);

  const lastAnalysisAt = db.getSystemMeta(LAST_ANALYSIS_KEY);
  const lookbackIso = lastAnalysisAt || new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const renamed_files: AnalysisReport['renamed_files'] = [];
  const untracked_files: AnalysisReport['untracked_files'] = [];

  const context = db.getContext();
  if (context) {
    for (const repo of context.config.repos) {
      const repoPath = resolveRepoPath(context, repo.name);
      if (!repoPath || !fs.existsSync(repoPath)) continue;

      for (const r of getRenamedFilesSince(repoPath, lookbackIso)) {
        renamed_files.push({ repo: repo.name, from: r.from, to: r.to, migrated: false });
      }

      const changed = getChangedFilesSince(repoPath, lookbackIso);
      // Canonicalized on the way in: a raw path.resolve() comparison misses on Windows whenever
      // the two sides disagree on drive-letter case (a stored node path vs. one freshly resolved
      // from cwd), which silently reported every file in the repo as untracked — same bug class
      // already fixed for getNodesByFilePath, not previously applied here.
      const knownFiles = new Set(
        db.listNodes({ include_deprecated: true }).flatMap(n =>
          (n.file_path || '').split(',').map(p => canonicalizePath(p.trim())).filter(Boolean)
        )
      );
      for (const relFile of changed) {
        const ext = path.extname(relFile).toLowerCase();
        if (!INDEXABLE_EXTENSIONS.has(ext)) continue;
        const absFile = canonicalizePath(path.resolve(repoPath, relFile));
        if (!fs.existsSync(absFile)) continue; // deleted since — not a blind spot
        const hasNode = knownFiles.has(absFile);
        if (!hasNode) untracked_files.push({ repo: repo.name, file: relFile });
      }
    }
  }

  if (fix) {
    for (const n of [...orphaned_nodes, ...spurious_nodes, ...missing_files]) {
      db.deprecateNode(n.id);
    }
    for (const e of dangling_edges) {
      db.deleteDanglingEdge(e.source_node_id, e.target_node_id);
    }
    if (context) {
      for (const r of renamed_files) {
        const migrated = migrateRename(db, context, r.repo, r.from, r.to);
        r.migrated = migrated;
      }
    }
    db.setSystemMeta(LAST_ANALYSIS_KEY, new Date().toISOString());
  }

  const summary: Record<string, number> = {
    god_entities: god_entities.length,
    circular_dependencies: circular_dependencies.length,
    orphaned_nodes: orphaned_nodes.length,
    dangling_edges: dangling_edges.length,
    duplicate_ids: duplicate_ids.length,
    missing_developer_attribution: missing_developer_attribution.length,
    empty_code_snapshots: empty_code_snapshots.length,
    spurious_nodes: spurious_nodes.length,
    missing_files: missing_files.length,
    renamed_files: renamed_files.length,
    untracked_files: untracked_files.length,
  };

  return {
    fixed: fix,
    summary,
    god_entities,
    circular_dependencies,
    orphaned_nodes,
    dangling_edges,
    duplicate_ids,
    missing_developer_attribution,
    empty_code_snapshots,
    spurious_nodes,
    missing_files,
    renamed_files,
    untracked_files,
  };
}

/** Migrates every node whose file_path resolves to `from` onto `to`, cascading the id/connections/history via `renameNode`. Returns true if anything was migrated. */
function migrateRename(db: DevMindDatabase, context: ReturnType<DevMindDatabase['getContext']>, repoName: string, from: string, to: string): boolean {
  if (!context) return false;
  const repoPath = resolveRepoPath(context, repoName);
  if (!repoPath) return false;

  const oldAbs = path.resolve(repoPath, from);
  const newAbs = path.resolve(repoPath, to);
  // Deliberately excludes deprecated nodes — renameNode's insert doesn't preserve the
  // deprecated flag, so migrating a dead node would silently resurrect it as active.
  // A deprecated node's file_path accuracy doesn't matter once it's already excluded
  // from use.
  const affected = db.listNodes().filter(n =>
    (n.file_path || '').split(',').map(p => p.trim()).some(p => path.resolve(p) === oldAbs)
  );

  let migrated = false;
  for (const node of affected) {
    const newId = node.id.replace(from, to);
    if (newId === node.id) continue;
    try {
      db.renameNode(node.id, newId, undefined, newAbs);
      migrated = true;
    } catch {
      // Leave this node untouched — analyze reports it again next run rather than failing the whole batch.
    }
  }
  return migrated;
}
