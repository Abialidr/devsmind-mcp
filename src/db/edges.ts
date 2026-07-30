import * as fs from 'fs';
import * as path from 'path';
import { DevMindDatabase } from './database';
import { resolveConnectionsLocally, extractNodeFromFile, MissingRef, detectRtkEndpointAliases } from '../utils/ast';

/** Aggregated missing-node record (deduped by target file + symbol). */
export interface MissingAgg { file: string; symbol: string; referenced_by: Set<string>; }

/** Builds a MissingRef -> MissingAgg collector (dedupes by target file + symbol). */
export function createMissingCollector(): { missing: Map<string, MissingAgg>; onMissing: (rec: MissingRef) => void } {
  const missing = new Map<string, MissingAgg>();
  const onMissing = (rec: MissingRef) => {
    const key = rec.targetFile + ' ' + rec.name;
    let e = missing.get(key);
    if (!e) { e = { file: rec.targetFile, symbol: rec.name, referenced_by: new Set() }; missing.set(key, e); }
    e.referenced_by.add(rec.sourceNodeId);
  };
  return { missing, onMissing };
}

/**
 * Deterministically creates nodes for used-but-unextracted references (Phase-1 gaps) from
 * the AST — no LLM — re-resolves edges for the new nodes and their callers so the edges
 * appear. Returns the number of nodes auto-created. This is inbuilt behaviour of every
 * edge-resolution run.
 *
 * @param opts.writeReport  write `missing_nodes_report.json` (CLI indexer wants this; the MCP
 *                          commit path does not — defaults true).
 * @param opts.quiet        suppress console output (MCP path; defaults false).
 */
export function finalizeMissingNodes(
  resolvedDevmind: string,
  db: DevMindDatabase,
  missing: Map<string, MissingAgg>,
  opts: { writeReport?: boolean; quiet?: boolean } = {}
): number {
  const writeReport = opts.writeReport !== false;
  const quiet = opts.quiet === true;
  const filledIds = new Set<string>();

  if (missing.size > 0) {
    const reresolve = new Set<string>();
    for (const e of missing.values()) {
      const derived = extractNodeFromFile(e.file, e.symbol);
      if (!derived) continue; // can't locate the declaration — leave in report only
      const id = `${db.toRepoRelativePath(e.file)}#${e.symbol}`;
      db.upsertNode({ id, name: derived.name, type: derived.type, file_path: e.file, signature: derived.signature });
      db.updateHistory({
        node_id: id,
        code_snapshot: derived.codeSnapshot,
        reasoning: {
          what_changed: 'Auto-created from a used-but-unextracted reference (--fill-missing)',
          why: 'Fill a Phase-1 extraction gap detected during edge resolution',
          goal: 'Complete the node graph deterministically from the AST',
          developer: 'devsmind fill-missing',
          model: 'ast'
        }
      });
      filledIds.add(id);
      for (const s of e.referenced_by) reresolve.add(s);
    }
    if (filledIds.size > 0) {
      const allNodes = db.listNodes();
      const allIds = new Set(allNodes.map(n => n.id));
      for (const id of new Set<string>([...filledIds, ...reresolve])) {
        const n = db.getNode(id);
        if (!n || !n.file_path) continue;
        for (const t of resolveConnectionsLocally(id, n.file_path, allNodes, resolvedDevmind)) {
          if (allIds.has(t)) db.addConnection(id, t);
        }
      }
    }
  }

  if (writeReport) {
    const report = [...missing.values()].map(e => {
      const id = `${db.toRepoRelativePath(e.file)}#${e.symbol}`;
      return {
        file: db.toRepoRelativePath(e.file),
        symbol: e.symbol,
        count: e.referenced_by.size,
        referenced_by: [...e.referenced_by],
        filled: filledIds.has(id)
      };
    }).sort((a, b) => b.count - a.count);

    try {
      fs.writeFileSync(
        path.join(resolvedDevmind, 'missing_nodes_report.json'),
        JSON.stringify({ total: report.length, filled: filledIds.size, missing: report }, null, 2),
        'utf-8'
      );
    } catch { /* ignore */ }

    if (!quiet) {
      console.log(`\n  🔍 Missing-node references: ${report.length} — auto-created ${filledIds.size}`);
      console.log(`  └─ ${path.join(resolvedDevmind, 'missing_nodes_report.json')}`);
    }
  }

  return filledIds.size;
}

/**
 * Deterministic alias detection over every file touched by this batch — currently RTK Query's
 * `createApi`/`injectEndpoints` generated-hook-name convention (see `detectRtkEndpointAliases`),
 * but the shape generalizes to future framework detectors the same way. Runs BEFORE edge
 * resolution so the endpoint gets the alias in the SAME pass a caller of its generated hook is
 * resolved — no second indexing round needed. Additive only (`db.addAlias`): never overwrites an
 * alias a previous detector run, or a Phase E `record_alias` correction, already attached.
 */
export function applyDeterministicAliases(db: DevMindDatabase, sourceNodeIds: string[]): void {
  const filePaths = new Set<string>();
  for (const id of sourceNodeIds) {
    const n = db.getNode(id);
    if (!n || !n.file_path) continue;
    for (const p of n.file_path.split(',').map(s => s.trim()).filter(Boolean)) filePaths.add(p);
  }

  for (const filePath of filePaths) {
    let detected: ReturnType<typeof detectRtkEndpointAliases>;
    try {
      detected = detectRtkEndpointAliases(filePath);
    } catch {
      continue; // a detector failure on one file must never abort the whole edge-resolution batch
    }
    if (detected.length === 0) continue;

    const nodesInFile = db.getNodesByFilePath(filePath);
    for (const { endpointName, aliases } of detected) {
      const match = nodesInFile.find(n => n.name === endpointName);
      if (!match) continue; // the endpoint itself wasn't extracted as a node (yet) — nothing to alias
      for (const alias of aliases) db.addAlias(match.id, alias);
    }
  }
}

/**
 * Resolves outgoing connections for a batch of source nodes via the local AST resolver, adding
 * each resolved edge additively (INSERT OR IGNORE), then auto-creating any missing target nodes.
 * Shared by the CLI indexer and the MCP commit_changes flow.
 *
 * @param opts.clearSources  delete the source nodes' existing OUTGOING edges before re-resolving
 *   (drops edges the code no longer has) while leaving every other node's edges intact. Off by
 *   default (pure-additive) to match the CLI's per-node loop.
 */
export function resolveEdgesForNodes(
  db: DevMindDatabase,
  devmindPath: string,
  sourceNodeIds: string[],
  opts: { clearSources?: boolean } = {}
): { edgesAdded: number; missingFilled: number } {
  if (sourceNodeIds.length === 0) return { edgesAdded: 0, missingFilled: 0 };

  if (opts.clearSources) {
    db.clearConnectionsForSources(sourceNodeIds);
  }

  applyDeterministicAliases(db, sourceNodeIds);

  const { missing, onMissing } = createMissingCollector();
  // Fetched AFTER alias detection so this batch's own newly-attached aliases are visible to the
  // resolver below in the SAME pass, not just on the next run.
  const allNodes = db.listNodes();
  const allIds = new Set(allNodes.map(n => n.id));

  let edgesAdded = 0;
  for (const rawId of sourceNodeIds) {
    const n = db.getNode(rawId);
    if (!n || !n.file_path) continue;
    for (const targetId of resolveConnectionsLocally(n.id, n.file_path, allNodes, devmindPath, onMissing)) {
      if (allIds.has(targetId)) {
        db.addConnection(n.id, targetId);
        edgesAdded++;
      }
    }
  }

  const missingFilled = finalizeMissingNodes(devmindPath, db, missing, { writeReport: false, quiet: true });
  return { edgesAdded, missingFilled };
}

/**
 * Splits an over-coarse node into several new ones — the batch graph-fix session's `split_node`
 * correction, for when one node was extracted too coarsely (e.g. a whole class where each method
 * deserved its own node). Each entry in `newSymbols` must be a REAL, separately-locatable
 * declaration in the ORIGINAL node's file, deterministically re-extracted via `extractNodeFromFile`
 * — the exact same AST-derived, no-LLM path `finalizeMissingNodes` already uses for its gap-fill
 * case. This is for carving out symbols that already exist in the code, never for fabricating new
 * ones: a name that can't be located in the file is reported in `failed`, not silently skipped.
 * The original node is deprecated once at least one split succeeds — if every target fails to
 * locate, the original is left untouched rather than deprecating a node with nothing to replace it.
 */
export function splitNode(
  db: DevMindDatabase,
  nodeId: string,
  newSymbols: string[]
): { created: string[]; failed: string[] } {
  const node = db.getNode(nodeId);
  if (!node || !node.file_path) return { created: [], failed: [...newSymbols] };

  const created: string[] = [];
  const failed: string[] = [];
  const repoRelPath = db.toRepoRelativePath(node.file_path);

  for (const symbolName of newSymbols) {
    const derived = extractNodeFromFile(node.file_path, symbolName);
    if (!derived) {
      failed.push(symbolName);
      continue;
    }
    const id = `${repoRelPath}#${symbolName}`;
    db.upsertNode({ id, name: derived.name, type: derived.type, file_path: node.file_path, signature: derived.signature });
    db.updateHistory({
      node_id: id,
      code_snapshot: derived.codeSnapshot,
      reasoning: {
        what_changed: `Split out of ${nodeId} by the batch graph-fix session`,
        why: 'The original node was extracted too coarsely — this symbol deserves its own node',
        goal: 'Improve graph precision from real agent feedback',
        model: 'ast'
      }
    });
    created.push(id);
  }

  if (created.length > 0) db.deprecateNode(nodeId);
  return { created, failed };
}
