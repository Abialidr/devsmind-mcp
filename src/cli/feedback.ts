import { resolveDevmindDir } from '../utils/config';
import {
  readGraphFeedback,
  readProductFeedback,
  readIndexerRuleCandidates,
  clusterGraphFeedback,
  GraphFeedbackCluster,
  ProductFeedbackEntry
} from '../db/feedback';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function sinceCutoff(sinceDays?: string): number | null {
  const n = sinceDays ? parseInt(sinceDays, 10) : undefined;
  return n !== undefined && !Number.isNaN(n) ? Date.now() - n * 24 * 60 * 60 * 1000 : null;
}

function printGraphCluster(c: GraphFeedbackCluster): void {
  const confidenceTag = c.confidence === 'confirmed' ? `${GREEN}confirmed${RESET}` : `${YELLOW}suspected${RESET}`;
  console.log(`  ${BOLD}${c.count}x${RESET}  ${c.category}  ${DIM}${c.node_id}${RESET}  (${confidenceTag})`);
  // One representative line of text per cluster keeps this readable even when the same report
  // repeated 30 times — the individual entries (with evidence) are what read_graph_feedback
  // exposes to the AI's own batch graph-fix session, not what a human skim needs here.
  console.log(`      ${c.entries[0].text}`);
  if (c.entries[0].evidence) {
    const e = c.entries[0].evidence;
    console.log(`      ${DIM}evidence: ${e.file}${e.line ? ':' + e.line : ''}${RESET}`);
  }
}

function printProductEntries(entries: ProductFeedbackEntry[], category: ProductFeedbackEntry['category']): void {
  const filtered = entries.filter(e => e.category === category);
  if (!filtered.length) return;
  const label = { tools_used: 'What helped', dropped_and_why: 'What got dropped', devsmind_better: 'How to improve' }[category];
  console.log(`  ${BOLD}${label}${RESET}`);
  for (const e of filtered) {
    console.log(`    ${DIM}${new Date(e.ts).toLocaleDateString()}${RESET}  ${e.text}`);
  }
}

/**
 * `devsmind feedback` — the human-facing read of the local, gitignored feedback log that
 * `commit_changes`' `feedback` param writes to (see db/feedback.ts). Read-only, same store
 * `read_graph_feedback` (an agent's own batch graph-fix session) and the AI-only product log
 * draw from — this is the first surface a person has ever had to actually see any of it.
 */
export async function handleFeedback(opts: { path?: string; since?: string; all?: boolean }): Promise<void> {
  const devmindDir = resolveDevmindDir(opts.path);
  if (!devmindDir) {
    console.error(
      `❌ No .devmind directory found.\n` +
      `   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.`
    );
    process.exit(1);
  }

  const cutoff = sinceCutoff(opts.since);
  const inWindow = (ts: string) => cutoff === null || new Date(ts).getTime() >= cutoff;

  const graphEntries = readGraphFeedback(devmindDir, { includeProcessed: !!opts.all }).filter(e => inWindow(e.ts));
  const productEntries = readProductFeedback(devmindDir).filter(e => inWindow(e.ts));
  const ruleCandidates = readIndexerRuleCandidates(devmindDir).filter(e => inWindow(e.ts));

  if (!graphEntries.length && !productEntries.length && !ruleCandidates.length) {
    console.log(
      `\n📭  No feedback recorded${cutoff !== null ? ` in the last ${opts.since} day(s)` : ''}.\n` +
      `   commit_changes asks for feedback on every commit — "none" is a valid answer and writes\n` +
      `   nothing here, so an empty log usually just means every recent commit answered "none".\n`
    );
    return;
  }

  console.log('');

  if (graphEntries.length) {
    const clusters = clusterGraphFeedback(graphEntries);
    console.log(`${BOLD}Graph feedback${RESET}  ${DIM}${graphEntries.length} report(s) in ${clusters.length} cluster(s)${opts.all ? '' : ' — unprocessed only, pass --all to include processed'}${RESET}`);
    for (const c of clusters) printGraphCluster(c);
    console.log('');
  }

  if (productEntries.length) {
    console.log(`${BOLD}Product feedback${RESET}  ${DIM}${productEntries.length} entries — never read by an agent, for you to act on${RESET}`);
    printProductEntries(productEntries, 'devsmind_better');
    printProductEntries(productEntries, 'dropped_and_why');
    printProductEntries(productEntries, 'tools_used');
    console.log('');
  }

  if (ruleCandidates.length) {
    console.log(`${BOLD}Indexer rule candidates${RESET}  ${DIM}recurring patterns worth a permanent detector${RESET}`);
    for (const r of ruleCandidates) {
      console.log(`  ${BOLD}${r.evidence_count}x${RESET}  ${r.pattern}`);
      for (const ex of r.examples.slice(0, 3)) console.log(`      ${DIM}${ex}${RESET}`);
    }
    console.log('');
  }

  if (graphEntries.length) {
    console.log(`${DIM}Graph feedback is meant to be resolved by an AI agent's own batch graph-fix session`);
    console.log(`(ask it to "run a graph-fix session" — it calls read_graph_feedback / mark_graph_feedback_processed).${RESET}\n`);
  }
}
