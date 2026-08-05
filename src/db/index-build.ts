import { DevMindDatabase } from './database';
import { IndexScratchpad, writeScratchpad } from './indexer';
import { enumerateFileCandidates, listFileImports, resolveConnectionsLocally } from '../utils/ast';
import { applyDeterministicAliases, createMissingCollector, finalizeMissingNodes } from './edges';

/**
 * How much of a node's code ships in an indexing batch response. Deliberately tighter than
 * `describe.ts`'s 2000-char one-shot-LLM budget: the chat model driving in-chat indexing already
 * has the surrounding conversation as context, so it needs less code per node to write a good
 * description, and every char here is repeated once per node across a whole repo.
 */
const CODE_CHARS_PER_NODE = 1200;

/** Default per-call extraction budgets — whichever trips first ends the batch. Files are always
 *  processed to completion once started, so `last_file_indexed` never points mid-file. */
const DEFAULT_FILE_BUDGET = 40;
const DEFAULT_NODE_BUDGET = 25;
const DEFAULT_CHAR_BUDGET = 30000;

/** Default wall-clock budget for one `resolveEdgesIncrementally` call. */
const DEFAULT_EDGE_TIME_BUDGET_MS = 25000;

/** One node in an indexing batch response — everything the AI needs to write a description,
 *  and nothing it needs to send back (no `code_snapshot` round-trip, unlike the old
 *  `stage_change` protocol). `start_line`/`end_line`/`exported` are only known at the moment
 *  a node is freshly extracted from source; a node re-served from {@link pendingDescriptionNodes}
 *  (created in an earlier, already-flushed batch) omits them rather than inventing values. */
export interface IndexBatchNode {
  node_id: string;
  name: string;
  type: string;
  signature: string | null;
  file_path: string;
  start_line?: number;
  end_line?: number;
  exported?: boolean;
  code: string;
  code_truncated: boolean;
}

/**
 * Extracts structure from `files` deterministically via local AST — no LLM, so nothing is
 * silently missed or hallucinated the way whole-file-to-an-LLM extraction could be. Writes each
 * candidate straight to the graph (`upsertNode` + `updateHistory`, deliberately with no
 * `code_before` — this is an index snapshot, not an edit, so it gets no diff/revert, exactly
 * like `devsmind index --run`'s own Phase 1 write in `runner.ts:781-802`). Stops once ANY of the
 * three budgets trips, but always finishes the file it's mid-way through first — the AI's cursor
 * (`files_done`/`last_file_indexed`) must only ever advance past a FULLY extracted file, or a
 * later `index_continue` silently skips whatever was left unprocessed in it.
 *
 * Node ids use the same `${repoRelPath}#${qualified}` formula as `runner.ts:778-779` and
 * `staging.ts`'s `resolveEntryId` — required so a node created here is the same node an
 * `edit_node` on the same symbol later resolves to, not a duplicate.
 */
export function extractFilesIntoGraph(
  db: DevMindDatabase,
  files: string[],
  opts: { fileBudget?: number; nodeBudget?: number; charBudget?: number; codeCharsPerNode?: number } = {}
): { filesExtracted: string[]; nodesCreated: number; nodes: IndexBatchNode[]; fileImports: Record<string, string[]>; cursor: string | null } {
  const fileBudget = opts.fileBudget ?? DEFAULT_FILE_BUDGET;
  const nodeBudget = opts.nodeBudget ?? DEFAULT_NODE_BUDGET;
  const charBudget = opts.charBudget ?? DEFAULT_CHAR_BUDGET;
  const codeCharsPerNode = opts.codeCharsPerNode ?? CODE_CHARS_PER_NODE;

  const filesExtracted: string[] = [];
  const nodes: IndexBatchNode[] = [];
  const fileImports: Record<string, string[]> = {};
  let nodesCreated = 0;
  let charsUsed = 0;
  let cursor: string | null = null;

  for (const filePath of files) {
    if (
      filesExtracted.length > 0 &&
      (filesExtracted.length >= fileBudget || nodes.length >= nodeBudget || charsUsed >= charBudget)
    ) {
      break;
    }

    // Never throws: returns [] for a non-parseable extension, an unreadable file, or a parse
    // failure — all three are legitimate "nothing to extract here" outcomes, not batch-aborting
    // errors. A file that yields nothing still counts as fully processed below.
    const candidates = enumerateFileCandidates(filePath);
    const repoRelPath = db.toRepoRelativePath(filePath);

    for (const c of candidates) {
      const nodeId = `${repoRelPath}#${c.qualified}`;
      db.upsertNode({ id: nodeId, name: c.name, type: c.type, file_path: filePath, signature: c.signature });
      db.updateHistory({
        node_id: nodeId,
        code_snapshot: c.codeSnapshot,
        reasoning: {
          what_changed: 'Initial code extraction during in-chat indexing',
          why: 'Initial index setup',
          goal: 'Establish baseline codebase knowledge graph',
          model: 'ast'
        }
      });
      nodesCreated++;

      const truncated = c.codeSnapshot.length > codeCharsPerNode;
      const code = truncated ? c.codeSnapshot.slice(0, codeCharsPerNode) : c.codeSnapshot;
      charsUsed += code.length;
      nodes.push({
        node_id: nodeId,
        name: c.name,
        type: c.type,
        signature: c.signature,
        file_path: filePath,
        start_line: c.startLine,
        end_line: c.endLine,
        exported: c.isExported,
        code,
        code_truncated: truncated
      });
    }

    if (candidates.length > 0) {
      const imports = listFileImports(filePath).map(i => i.moduleSpecifier);
      if (imports.length > 0) fileImports[repoRelPath] = [...new Set(imports)];
    }

    filesExtracted.push(filePath);
    cursor = filePath;
  }

  return { filesExtracted, nodesCreated, nodes, fileImports, cursor };
}

/**
 * Nodes with no description yet, oldest-created first — the same `WHERE description IS NULL`
 * predicate `describe.ts:67`'s backlog-clearing loop uses. Re-served by `index_continue` ahead of
 * a fresh batch so a still-undescribed node from an earlier batch is never silently dropped just
 * because the AI moved on to the next one; it grows the visible backlog instead of losing it.
 */
export function pendingDescriptionNodes(db: DevMindDatabase, limit: number): IndexBatchNode[] {
  const pending = db.getAllNodes().filter(n => !n.deprecated && !n.description).slice(0, limit);
  const nodes: IndexBatchNode[] = [];
  for (const n of pending) {
    const latest = db.getLatestCode(n.id);
    const full = latest?.code_snapshot ?? '';
    const truncated = full.length > CODE_CHARS_PER_NODE;
    nodes.push({
      node_id: n.id,
      name: n.name,
      type: n.type,
      signature: n.signature ?? null,
      file_path: n.file_path,
      code: truncated ? full.slice(0, CODE_CHARS_PER_NODE) : full,
      code_truncated: truncated
    });
  }
  return nodes;
}

/**
 * Resumable, time-budgeted full-graph connection pass — the same `phase`/`nodes_done`/
 * `nodes_total` state machine `runner.ts:834-839` and `runner.ts:604-661` already use for the
 * CLI's Phase 2. A node extracted in an early batch can be the TARGET of a node extracted much
 * later, so edges are never resolved per-batch during extraction — only here, once, over the
 * WHOLE graph, exactly as `runner.ts:1223-1231` documents for the same reason.
 *
 * Persists `nodes_done` to the scratchpad after every node (not just on return), so a crash mid
 * -pass loses at most one node's edges, not the whole call. Missing-node fill only runs once the
 * WHOLE pass completes within a single call — a `resolve` that keeps expiring its time budget
 * across many `index_complete` calls will still get every edge, just not missing-node fill until
 * the pass that finally finishes; this is the same characteristic `devsmind index --run` itself
 * has across a restarted process, not a new limitation introduced here.
 */
export function resolveEdgesIncrementally(
  db: DevMindDatabase,
  devmindPath: string,
  pad: IndexScratchpad,
  opts: { timeBudgetMs?: number } = {}
): { done: boolean; nodesDone: number; nodesTotal: number; edgesAdded: number; missingFilled: number } {
  const deadline = Date.now() + (opts.timeBudgetMs ?? DEFAULT_EDGE_TIME_BUDGET_MS);

  // Alias detection BEFORE the candidate pool is fetched, so this pass's own freshly-attached
  // aliases (RTK Query generated hook names, etc.) are visible to the resolver below in the SAME
  // pass rather than needing a second run — mirrors edges.ts's `resolveEdgesForNodes` ordering.
  applyDeterministicAliases(db, db.listNodes().map(n => n.id));
  const allNodes = db.listNodes();
  const allIds = new Set(allNodes.map(n => n.id));

  if (pad.phase !== 2) {
    pad.phase = 2;
    pad.nodes_done = 0;
    pad.nodes_total = allNodes.length;
    pad.connections_created = 0;
  } else {
    pad.nodes_total = allNodes.length;
  }

  const { missing, onMissing } = createMissingCollector();
  let i = pad.nodes_done;

  for (; i < allNodes.length; i++) {
    if (Date.now() > deadline) break;

    const node = allNodes[i];
    const latest = db.getLatestCode(node.id);
    if (latest?.code_snapshot && latest.code_snapshot.trim().length > 0) {
      for (const targetId of resolveConnectionsLocally(node.id, node.file_path, allNodes, devmindPath, onMissing)) {
        if (allIds.has(targetId)) {
          db.addConnection(node.id, targetId);
          pad.connections_created++;
        }
      }
    }

    pad.nodes_done = i + 1;
    pad.updated_at = new Date().toISOString();
    writeScratchpad(devmindPath, pad);
  }

  const done = i >= allNodes.length;
  const missingFilled = done ? finalizeMissingNodes(devmindPath, db, missing, { writeReport: false, quiet: true }) : 0;

  return { done, nodesDone: pad.nodes_done, nodesTotal: pad.nodes_total, edgesAdded: pad.connections_created, missingFilled };
}
