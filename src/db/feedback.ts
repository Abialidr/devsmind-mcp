import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { localDir, ensureGitignored } from './activity';

/**
 * Compulsory-but-cheap feedback captured on every `commit_changes` call — the graph only earns
 * trust if agents that discover it's wrong can say so, and the whole point is capturing that
 * signal WITHOUT disrupting the working agent's flow: this module only appends, synchronously,
 * to a local file. No extra round-trip, no live graph mutation, no agent ever blocked on this.
 *
 * Two files, two audiences, both under the gitignored `.devmind/local/` tree (same convention as
 * activity.ts — private per-developer working state, never pushed):
 *  - `feedback_graph.jsonl`   — machine-actionable. Read later by a supervised batch session
 *                               (graph-fix tools) that verifies each entry against current code
 *                               before writing anything to the graph. Never auto-applied live.
 *  - `feedback_product.jsonl` — human-actionable. Aggregated by a person into "how do we make
 *                               DevsMind better", never read by an agent to mutate anything.
 *
 * `"none"` is a first-class, legitimate, expected answer on every field — a required field is
 * required to be ANSWERED, not required to contain a problem. Making "none" cheap is what stops a
 * compulsory field from pressuring an agent into inventing issues just to fill it in.
 */

export type GraphFeedbackCategory = 'graph_problem' | 'edge_problem';
export type ProductFeedbackCategory = 'tools_used' | 'dropped_and_why' | 'devsmind_better';

/** How sure the reporting agent is. Only `confirmed` entries with evidence are strong candidates
 * for the batch session to act on directly; `suspected` entries need the batch session to verify
 * first (or are low priority until corroborated by a repeat report). */
export type FeedbackConfidence = 'suspected' | 'confirmed';

export interface FeedbackEvidence {
  file: string;
  line?: number;
  snippet?: string;
}

export interface GraphFeedbackEntry {
  /** Stable identity, minted at append time — what {@link markGraphFeedbackProcessed} targets. */
  id: string;
  ts: string;
  session_id: string;
  category: GraphFeedbackCategory;
  text: string;
  node_id?: string;
  confidence: FeedbackConfidence;
  evidence?: FeedbackEvidence;
  /** Set by the batch graph-fix session once it has verified/applied this entry, so repeated
   * batch runs don't re-chew the same report. Absent/false = not yet processed. */
  processed?: boolean;
}

export interface ProductFeedbackEntry {
  ts: string;
  session_id: string;
  category: ProductFeedbackCategory;
  text: string;
}

function graphFeedbackPath(devmindPath: string): string {
  return path.join(localDir(devmindPath), 'feedback_graph.jsonl');
}

function productFeedbackPath(devmindPath: string): string {
  return path.join(localDir(devmindPath), 'feedback_product.jsonl');
}

function indexerRuleCandidatesPath(devmindPath: string): string {
  return path.join(localDir(devmindPath), 'indexer_rule_candidates.jsonl');
}

/**
 * A recurring pattern the batch graph-fix session noticed while resolving feedback — e.g. "every
 * one of these 12 reports was the same framework's generated-binding pattern" — worth turning
 * into a PERMANENT deterministic rule (a detector like Phase C's RTK one) instead of fixing the
 * same class of miss by hand forever. This is a candidate log for a human to review, not something
 * an agent acts on automatically — writing an actual detector is real engineering work.
 */
export interface IndexerRuleCandidate {
  ts: string;
  /** Short description of the pattern, e.g. "Vue computed() properties never get aliased". */
  pattern: string;
  /** How many feedback entries this pattern was inferred from — the priority signal. */
  evidence_count: number;
  /** A few representative examples (file:line style strings), not every occurrence. */
  examples: string[];
}

function appendJsonl(devmindPath: string, target: string, entry: unknown): void {
  ensureGitignored(devmindPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Appends one graph-correction report. Evidence is required to mark an entry `confirmed` — an
 * unevidenced report is downgraded to `suspected` regardless of what the caller claimed, since a
 * "graph problem" with no `file:line` to check is not reconstructable once the code has moved on
 * (this may be read weeks later, in the batch session — see the module doc).
 */
export function appendGraphFeedback(
  devmindPath: string,
  entry: { session_id: string; category: GraphFeedbackCategory; text: string; node_id?: string; evidence?: FeedbackEvidence }
): void {
  const confidence: FeedbackConfidence = entry.evidence ? 'confirmed' : 'suspected';
  const record: GraphFeedbackEntry = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    session_id: entry.session_id,
    category: entry.category,
    text: entry.text,
    node_id: entry.node_id,
    confidence,
    evidence: entry.evidence
  };
  appendJsonl(devmindPath, graphFeedbackPath(devmindPath), record);
}

/** Appends one product-improvement report — never read by an agent, only aggregated for a human. */
export function appendProductFeedback(
  devmindPath: string,
  entry: { session_id: string; category: ProductFeedbackCategory; text: string }
): void {
  const record: ProductFeedbackEntry = {
    ts: new Date().toISOString(),
    session_id: entry.session_id,
    category: entry.category,
    text: entry.text
  };
  appendJsonl(devmindPath, productFeedbackPath(devmindPath), record);
}

function readJsonl<T>(target: string): T[] {
  if (!fs.existsSync(target)) return [];
  const lines = fs.readFileSync(target, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A partially-written line (crash mid-append) — skip it rather than fail the whole read.
    }
  }
  return out;
}

/**
 * Reads graph-feedback entries — the batch graph-fix session's input. Unprocessed only by
 * default (`opts.includeProcessed` to see everything, e.g. for an audit/report).
 */
export function readGraphFeedback(devmindPath: string, opts: { includeProcessed?: boolean } = {}): GraphFeedbackEntry[] {
  const all = readJsonl<GraphFeedbackEntry>(graphFeedbackPath(devmindPath));
  return opts.includeProcessed ? all : all.filter(e => !e.processed);
}

/** Reads every product-feedback entry recorded so far — for human aggregation/reporting. */
export function readProductFeedback(devmindPath: string): ProductFeedbackEntry[] {
  return readJsonl<ProductFeedbackEntry>(productFeedbackPath(devmindPath));
}

/**
 * Marks graph-feedback entries as processed by id — rewrites the whole file (atomic temp+rename,
 * same convention as `staging.ts`'s `writeBuffer`), since JSONL is append-only and a past line
 * can't be edited in place. Idempotent: marking an already-processed or unknown id is a no-op for
 * that id. Called by the batch graph-fix session once it has verified and applied (or explicitly
 * rejected) an entry, so a later batch run never re-chews the same report.
 */
export function markGraphFeedbackProcessed(devmindPath: string, ids: string[]): void {
  if (ids.length === 0) return;
  const target = graphFeedbackPath(devmindPath);
  const all = readJsonl<GraphFeedbackEntry>(target);
  const idSet = new Set(ids);
  const updated = all.map(e => (idSet.has(e.id) ? { ...e, processed: true } : e));

  ensureGitignored(devmindPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, updated.map(e => JSON.stringify(e)).join('\n') + (updated.length ? '\n' : ''), 'utf-8');
  fs.renameSync(tmp, target);
}

/** One node/category's worth of graph feedback, grouped together — frequency is the priority
 * signal: the same report surfacing many times means it's worth acting on first, and a single
 * `record_alias`/`link_nodes` call can resolve every entry in the cluster at once. */
export interface GraphFeedbackCluster {
  node_id: string;
  category: GraphFeedbackCategory;
  count: number;
  entries: GraphFeedbackEntry[];
  /** Highest confidence among the cluster's entries — one `confirmed` report is enough to make
   * the whole cluster worth verifying first, even alongside otherwise-`suspected` duplicates. */
  confidence: FeedbackConfidence;
}

/**
 * Groups graph-feedback entries by `(node_id, category)` and sorts by frequency (most-reported
 * first) — the clustering the batch session's `read_graph_feedback` tool exposes, so 30 identical
 * reports of the same RTK miss show up as ONE cluster of size 30, not 30 things to individually
 * re-investigate.
 */
export function clusterGraphFeedback(entries: GraphFeedbackEntry[]): GraphFeedbackCluster[] {
  const groups = new Map<string, GraphFeedbackEntry[]>();
  for (const e of entries) {
    const key = `${e.node_id ?? 'unknown'}::${e.category}`;
    const arr = groups.get(key);
    if (arr) arr.push(e);
    else groups.set(key, [e]);
  }

  const clusters: GraphFeedbackCluster[] = [];
  for (const [key, es] of groups) {
    const sep = key.lastIndexOf('::');
    clusters.push({
      node_id: key.slice(0, sep),
      category: key.slice(sep + 2) as GraphFeedbackCategory,
      count: es.length,
      entries: es,
      confidence: es.some(e => e.confidence === 'confirmed') ? 'confirmed' : 'suspected'
    });
  }
  return clusters.sort((a, b) => b.count - a.count);
}

/** Appends one indexer-rule candidate — see {@link IndexerRuleCandidate}. */
export function appendIndexerRuleCandidate(
  devmindPath: string,
  entry: { pattern: string; evidence_count: number; examples: string[] }
): void {
  const record: IndexerRuleCandidate = {
    ts: new Date().toISOString(),
    pattern: entry.pattern,
    evidence_count: entry.evidence_count,
    examples: entry.examples
  };
  appendJsonl(devmindPath, indexerRuleCandidatesPath(devmindPath), record);
}

/** Reads every indexer-rule candidate recorded so far — for a human to review/prioritize. */
export function readIndexerRuleCandidates(devmindPath: string): IndexerRuleCandidate[] {
  return readJsonl<IndexerRuleCandidate>(indexerRuleCandidatesPath(devmindPath));
}
