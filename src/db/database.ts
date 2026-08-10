import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { INIT_SCHEMA_SQL, DbNode, DbHistory, HistoryEdit, DbConnection, DbWorkflow, DbWorkflowStep, DbWorkflowArtifact } from './schema';
import { loadProjectContext, resolveRepoPath, ProjectContext, canonicalizePath } from '../utils/config';
import { parseNodeId, extractNodeFromFile, normalizeFsPath, locateNodeInFile, isAstParseable } from '../utils/ast';
import { tokenizeText } from '../utils/tokenize';
import { tokenizeNodeField, scoreCandidate, TokenField, FieldMatch, DEFAULT_FIELD_WEIGHTS, reciprocalRankFusion } from './search-index';
import { EMBEDDING_MODEL_ID, EMBEDDING_DIM, hashDescription, cosineInt8, embedTextInt8 } from './embedder';
import { grepRepos, rankGrepHits, escapeRegExp, isDefaultIgnoredFile, GrepHit, RankedFile } from './grep';

export interface ReasoningObject {
  what_changed: string;
  why: string;
  goal: string;
  requirement?: string;
  previous_state?: string;
  decision?: string;
  developer?: string;
  model?: string;
}

/** Where a returned code body came from: parsed off disk, or served from the cached snapshot. */
export type CodeSource = 'live' | 'cached';

export interface LiveCodeResult {
  exists: boolean;
  node_id: string;
  file_path?: string;
  code?: string;
  source?: CodeSource;
  /** True when the cached snapshot disagrees with disk, or could not be checked against it. */
  snapshot_outdated?: boolean;
  updated_at?: string;
  message?: string;
}

/** `depth` is hops from the root IN THE TRAVERSAL THAT FOUND IT, not a call-stack distance — with
 * `direction:"both"` a path can alternate caller→callee, so it is not a directional "N calls
 * deep" number. Absent only for the synthetic case where a node id was never resolvable
 * (see `getGraph`'s dangling-edge handling), which never reaches the returned `nodes` array. */
export type GraphNode = DbNode & { code?: string; code_source?: CodeSource; depth?: number };

/** One matching code-body line attached to a node found (or corroborated) by the grep layer. */
export interface CodeMatchLine {
  line_number: number;
  line_content: string;
}

/** Which search layer(s) surfaced a node — the honest trust signal. A node found by several
 * independent layers is far more likely right than one found by a single weak one. */
export type SearchLayer = 'name' | 'keyword' | 'meaning' | 'code';

/** How much to trust a result, in plain terms — NOT the raw RRF fusion float, which is a tiny,
 * uninterpretable number (a #1-ranked hit tops out around 0.03) that made every good match look
 * like a weak guess. `high` = an exact identifier, ≥2 layers agreeing, or a strong semantic match;
 * `low` = a single weak signal near the floor. */
export type Confidence = 'high' | 'medium' | 'low';

/** A confident "0 callers" is a false negative on dynamic-dispatch/generated-binding code (RTK
 * hooks, DI containers) — the AST resolver can't see those calls at all. Shared between
 * `search_nodes`' drill-in hooks and `get_node_code`'s `used_by_note` so the two tools can never
 * say this in two slightly different ways. */
/** How many budget-dropped node ids `getGraph` will name before it stops listing them — enough to
 * act on, not so many that the omission list becomes its own oversized payload. */
const OMITTED_NODE_ID_CAP = 20;

/** Bumped when the shape written to `.devmind/workflows/<id>/workflow.json` changes. v2 replaced
 * per-step `history_ids`/`pending_tasks` with `reasoning`/`node_ids`/`doc_paths`, and workflow
 * `status`/`is_active` with `archived`. */
export const WORKFLOW_SCHEMA_VERSION = 2;

/** The half of a workflow a v1 client has no field for, and therefore cannot overwrite when it
 * rewrites `workflow.json` from its own columns. See `writeWorkflowToDisk`. */
export const WORKFLOW_SIDECAR_FILE = 'v2.json';

export const NO_STATIC_CALLERS_NOTE ='no static callers found — may be used via dynamic dispatch or a generated binding; verify before assuming unused';

/** Drill-in hooks attached to every search result — the signal that tells the caller whether it's
 * worth pulling in more graph/history in the same `get_node_code` call before this result is a
 * dead end. */
export interface DrillInHooks {
  /** Outgoing connection count (what this node calls/uses). */
  uses: number;
  /** Incoming connection count (who calls/uses this node). A found-by-static-AST count only — see
   * `used_by_note`. */
  used_by: number;
  /** Total history/revision entries for this node. */
  history_count: number;
  /** Most recent history update timestamp, if any. */
  last_updated?: string;
  /** Present ONLY when `used_by === 0` — a confident "0 callers" on dynamic-dispatch or
   * generated-binding code (RTK hooks, DI containers) is a false negative, not a real answer. This
   * turns a misleading zero into an honest "unverified" instead of silently asserting "unused". */
  used_by_note?: string;
}

/** A node in the primary `nodes` bucket of {@link DevMindDatabase.searchNodes}. Either an exact
 * identifier hit, or a ranked hit fused from the BM25 / vector / code layers. */
export type RankedNode =
  | (DbNode & DrillInHooks & { matched_via: 'identifier'; found_by: SearchLayer[]; confidence: 'high'; relevance: number })
  | (DbNode & DrillInHooks & {
      matched_via: 'fuzzy' | 'semantic' | 'code';
      /** Every layer that matched this node — corroboration across layers is the real confidence. */
      found_by: SearchLayer[];
      /** Plain-language trust level; replaces the old opaque `score`/`low_confidence` pair. */
      confidence: Confidence;
      /** 0-100, relative to the top hit in THIS response — an intuitive ordering aid, not an
       * absolute probability (that's what `confidence` is for). */
      relevance: number;
      matched_terms: string[];
      /** Present when the node's code body matched — the lines that did, for eyeballing. */
      code_matches?: CodeMatchLine[];
    });

/**
 * The two-bucket result of {@link DevMindDatabase.searchNodes}: `nodes` (the indexed graph,
 * primary) and `files` (raw filesystem grep hits, last resort — the coverage for CSS/JSON/config
 * and anything the graph doesn't model). `hint` is set only when BOTH buckets are empty;
 * `truncated` when the grep walk hit its deadline and returned partial file results.
 *
 * `files`/`nodes` stay BARE ARRAYS (never wrapped in `{total, items}`) — an empty search must
 * still return `files: []`, not `files: {items: [], total: 0}`. The true counts before either
 * bucket's cap ship as SIBLING fields instead, so a capped result stays distinguishable from a
 * complete one without changing the shape of the arrays themselves.
 */
export interface SearchNodesResult {
  nodes: RankedNode[];
  files: RankedFile[];
  /** True total distinct files that matched, before the `files_offset`/page-size cap — lets the
   * caller tell "that's everything" from "more exists, ask for the next page". */
  files_total: number;
  /** The offset this page of `files` started at (echoes back what was requested; default 0). */
  files_offset: number;
  /** True total ranked nodes found across all layers, before the top-20 fusion cap. */
  nodes_total: number;
  hint?: string;
  truncated?: boolean;
  /** Set only when an explicit `path` scope pointed AT a file excluded from search by default
   * (a lockfile or build artifact). Distinct from `hint`, which means "nothing matched anywhere":
   * this means "nothing was SCANNED", and no amount of re-querying will change that. */
  scope_note?: string;
}

/** A `search_nodes` node after compaction — everything needed to decide "is this the one?" and
 * nothing else. Field ORDER is deliberate and mirrors the full shape: trust signals first. */
export interface CompactRankedNode {
  id: string;
  name: string;
  type: string;
  confidence: Confidence;
  relevance: number;
  found_by: SearchLayer[];
  file_path: string;
  signature: string | null;
  description: string | null;
  uses: number;
  used_by: number;
  history_count: number;
  code_matches?: CodeMatchLine[];
}

/** A `search_nodes` file after compaction. `match_counts` is the big drop: a map keyed by every
 * distinct lowercased substring that matched, which is bulk without being a decision input. */
export interface CompactRankedFile {
  file_path: string;
  total_matches: number;
  sample_lines?: { line_number: number; line_content: string; symbol?: string }[];
}

/**
 * The compacted form of {@link SearchNodesResult}. Every COUNT survives untouched — a trimmed
 * result must never be mistakable for a complete one, the same contract the buckets already keep.
 */
export interface CompactSearchNodesResult {
  nodes: CompactRankedNode[];
  files: CompactRankedFile[];
  files_total: number;
  files_offset: number;
  nodes_total: number;
  hint?: string;
  truncated?: boolean;
  scope_note?: string;
  /** Which tier was applied, and what it cost — always present when compaction ran, so the caller
   * can never mistake a trimmed response for the full one. */
  compacted?: string;
}

/** Tier 1 keeps a couple of sample lines; anything past this is bulk, not evidence. */
const COMPACT_SAMPLE_CAP = 2;
/** Tier 1 line truncation. 200 chars is enough to read a matching line in context; the full
 * 400-char lines are the single biggest contributor to an oversized files bucket. */
const COMPACT_LINE_CAP = 200;

/**
 * Shrink a search result to fit, in two tiers.
 *
 * Why two rather than an on/off switch: the sample lines and `code_matches` are genuinely the
 * most useful part of a result — real agent feedback credits them with catching a live bug — so
 * throwing all of them away at the first byte over a threshold overcorrects. Tier 1 drops what is
 * bulk-without-signal (`match_counts`, `matched_terms`, `aliases`, `created_at`, `deprecated`, and
 * the repeated `used_by_note` boilerplate) and thins the rest; only tier 2 gives up the evidence
 * lines entirely and becomes a pure triage list.
 *
 * `confidence`/`relevance`/`found_by` and the `uses`/`used_by`/`history_count` drill-in hooks
 * survive BOTH tiers on purpose. They are a handful of bytes each and they are precisely what a
 * caller uses to decide which result to open next — dropping them would make a compact response
 * smaller and useless at the same time.
 *
 * Pure: no DB access, no I/O. Kept here rather than in the MCP handler so it is unit-testable
 * directly, and so it sits inside the coverage gate.
 */
export function toCompactSearchResult(result: SearchNodesResult, tier: 1 | 2): CompactSearchNodesResult {
  const keepEvidence = tier === 1;
  const trimLines = <T extends { line_content: string }>(lines: T[]): T[] =>
    lines.slice(0, COMPACT_SAMPLE_CAP).map(l => ({ ...l, line_content: l.line_content.slice(0, COMPACT_LINE_CAP) }));

  return {
    nodes: result.nodes.map(n => {
      // Cast rather than narrow the RankedNode union: `code_matches` exists only on the fuzzy
      // variant, and the identifier variant simply has no evidence lines to trim.
      const src = n as typeof n & { code_matches?: CodeMatchLine[] };
      return {
        id: src.id,
        name: src.name,
        type: src.type,
        confidence: src.confidence,
        relevance: src.relevance,
        found_by: src.found_by,
        file_path: src.file_path,
        signature: src.signature,
        description: src.description,
        uses: src.uses,
        used_by: src.used_by,
        history_count: src.history_count,
        code_matches: keepEvidence && src.code_matches ? trimLines(src.code_matches) : undefined
      };
    }),
    files: result.files.map(f => ({
      file_path: f.file_path,
      total_matches: f.total_matches,
      sample_lines: keepEvidence ? trimLines(f.sample_lines) : undefined
    })),
    files_total: result.files_total,
    files_offset: result.files_offset,
    nodes_total: result.nodes_total,
    hint: result.hint,
    truncated: result.truncated,
    scope_note: result.scope_note
  };
}

export interface GraphOptions {
  /** 'out' = callees only (call-flow trace), 'in' = callers only, 'both' = neighborhood. */
  direction?: 'out' | 'in' | 'both';
  includeCode?: boolean;
  codeCharBudget?: number;
  /** Node-count safety valve for the BFS walk (default 500). Callers embedding a graph inside a
   * cheaper response (get_node_code) pass a smaller cap than a dedicated graph call would. */
  maxNodes?: number;
}

export interface GraphResult {
  nodes: GraphNode[];
  connections: DbConnection[];
  /** Total characters of code attached (only set when includeCode is true). */
  code_chars?: number;
  /** Set when some nodes came back without code — for EITHER reason below. */
  code_truncated?: boolean;
  /** Total nodes without code, both causes combined. Kept for callers that only need the count;
   * the two fields below are what tell you which cause, and whether acting on it is possible. */
  nodes_without_code?: number;
  /** Nodes whose code genuinely could not be found (symbol gone from disk, no cached snapshot).
   * Raising `codeCharBudget` will NOT bring these back — that's the point of splitting them out. */
  nodes_no_code_available?: number;
  /** Nodes whose code EXISTS but was dropped to stay inside `codeCharBudget`, by id (capped).
   * Reported as ids rather than a count so the caller can fetch exactly these — an id stays valid
   * across calls, where a positional cursor into a re-derived BFS array does not. */
  code_omitted_node_ids?: string[];
  /** True when the walk hit `maxNodes` before the queue emptied — more of the graph exists than
   * was returned. Previously this happened silently; a capped result was indistinguishable from
   * a complete one. */
  nodes_truncated?: boolean;
  /** True when one or more discovered edges were dropped because an endpoint could not be
   * resolved to a real node (a connections row surviving a deleted/renamed node) — never a
   * dangling reference into `nodes` for an id that isn't actually there. */
  connections_truncated?: boolean;
}

export function formatReasoning(r: string | ReasoningObject): string {
  if (typeof r === 'string') {
    return r;
  }
  const lines = [
    `What changed: ${r.what_changed || ''}`,
    `Why: ${r.why || ''}`,
    `Goal: ${r.goal || ''}`,
    `Requirement: ${r.requirement || ''}`,
    `Previous state: ${r.previous_state || ''}`,
    `Decision: ${r.decision || ''}`,
    `Developer: ${r.developer || ''}`,
    `Model: ${r.model || ''}`
  ];
  return lines.join('\n');
}

/** Matches the `── Update @ … ──` separator `updateHistory` appends each same-session update under. */
const REASONING_SEPARATOR = /(\n*── Update @ [^\n]*──\n)/g;

/**
 * Removes one block from an accumulated reasoning log, matched by its exact text and searched
 * from the newest end.
 *
 * Not simply "drop the last block": an update that carries no code change (a bare
 * `update_history`, or an initial index snapshot) appends reasoning without recording an edit,
 * so blocks and edits are not one-to-one and positional removal would take the wrong one.
 * Matching on content is exact when
 * the block is there, and when it isn't the log is returned untouched — leaving a stale line is
 * recoverable, mangling someone else's reasoning is not.
 *
 * Splitting on a capturing group keeps the separators in the result, so every block that stays
 * keeps its original timestamp rather than being re-stamped on the way out.
 */
function dropReasoningBlock(raw: string, block: string): string {
  if (!raw || !block) return raw;
  const target = block.trim();
  if (!target) return raw;

  // [block, sep, block, sep, block, …] — blocks at even indices, separators at odd.
  const parts = raw.split(REASONING_SEPARATOR);
  for (let i = parts.length - 1; i >= 0; i -= 2) {
    if (parts[i].trim() !== target) continue;
    // Drop the block with the separator that introduced it. The first block has none, so it
    // takes the separator that follows instead — whatever came after now leads the log.
    if (i > 0) parts.splice(i - 1, 2);
    else parts.splice(0, 2);
    return parts.join('').replace(/^\n+/, '');
  }
  return raw;
}

/**
 * Inverse of `formatReasoning`. A single history row accumulates every later update appended
 * under a `── Update @ … ──` separator, so one stored blob can hold several changes — this
 * splits them back apart and returns them NEWEST FIRST.
 *
 * Reasoning written before the structured format (or by a caller passing a bare string) has no
 * labels to read; rather than drop it, the whole chunk is surfaced as `what_changed`.
 */
export function parseReasoningBlocks(raw: string): ReasoningObject[] {
  if (!raw || typeof raw !== 'string') return [];
  const chunks = raw
    .split(/\n*── Update @ [^\n]*──\n/g)
    .map(c => c.trim())
    .filter(Boolean);

  const parsed = chunks.map(chunk => {
    const field = (label: string): string | undefined => {
      const m = chunk.match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'm'));
      const v = m?.[1]?.trim();
      return v ? v : undefined;
    };
    const what = field('What changed');
    const why = field('Why');
    const goal = field('Goal');
    // No recognised labels → free-text reasoning; keep it rather than return an empty shell.
    if (!what && !why && !goal) {
      return { what_changed: chunk, why: '', goal: '' } as ReasoningObject;
    }
    return {
      what_changed: what || '',
      why: why || '',
      goal: goal || '',
      requirement: field('Requirement'),
      previous_state: field('Previous state'),
      decision: field('Decision'),
      developer: field('Developer'),
      model: field('Model')
    } as ReasoningObject;
  });

  return parsed.reverse();
}

/** One reasoning block recovered from an accumulated history blob, with the time it was written. */
export interface TimedReasoningBlock {
  /**
   * The block's verbatim trimmed text. This is the GROUPING KEY for reconstructing a commit from
   * history: `commitStagedChanges` passes one `reasoning` object to `updateHistory` for every node
   * in the batch, so every node touched by a single commit_changes call ends up carrying a
   * byte-identical block. Nothing else in the shared record identifies a commit — `history.id` is
   * per-node, and the timestamps differ by milliseconds because each node's `updateHistory` call
   * stamps its own `new Date()`.
   */
  text: string;
  /** When this block was written — the `── Update @ … ──` separator's own timestamp, or the row's
   * `created_at` for the first block, which has no separator preceding it. */
  at: string;
  parsed: ReasoningObject;
}

/**
 * {@link parseReasoningBlocks} plus the one thing it throws away: each block's timestamp.
 *
 * The separator that `updateHistory` writes between merged blocks embeds the moment of the update,
 * so an accumulated blob is already a dated log — but the existing parser splits on a
 * non-capturing pattern and returns bare objects, which is all `get_node_code` ever needed.
 * Reconstructing per-commit activity from shared history does need the dates (that's the whole
 * time-filter), hence a sibling rather than a breaking change to a parser with other callers.
 *
 * Returned OLDEST FIRST — accumulation order, the opposite of `parseReasoningBlocks` — because the
 * caller here regroups across rows by timestamp rather than reading "the latest" off the front.
 */
export function parseReasoningBlocksTimed(raw: string, createdAt: string): TimedReasoningBlock[] {
  if (!raw || typeof raw !== 'string') return [];
  // Capturing the timestamp (not the whole separator) means split() interleaves it into the
  // result: [block0, ts1, block1, ts2, block2, …] — blocks even, timestamps odd.
  const parts = raw.split(/\n*── Update @ ([^\n]*?)\s*──\n/g);
  const out: TimedReasoningBlock[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = (parts[i] || '').trim();
    if (!text) continue;
    const at = i === 0 ? createdAt : ((parts[i - 1] || '').trim() || createdAt);
    // parseReasoningBlocks on a separator-free chunk always yields exactly one entry; the fallback
    // mirrors its own "unlabelled text is still reasoning" rule rather than dropping the block.
    const parsed = parseReasoningBlocks(text)[0] || ({ what_changed: text, why: '', goal: '' } as ReasoningObject);
    out.push({ text, at, parsed });
  }
  return out;
}

export class DevMindDatabase {
  private db: Database.Database;
  private dbPath: string;
  private context: ProjectContext | null = null;

  /**
   * `onSyncProgress`: optional, fires during the constructor's initial `syncFromDisk()` pass —
   * the one silent stretch every CLI command pays on `new DevMindDatabase(...)` before it can
   * print anything else. Large `.devmind` folders (mainly `history/`, which grows one file per
   * edit — much faster than node count) can make that pass take minutes; without this, a caller
   * has no way to tell "still working" from "hung". Omit it for silent construction (the MCP
   * server's normal path, where per-open console spam would be noise, not signal).
   */
  constructor(dbPath: string, opts?: { onSyncProgress?: (phase: string, done: number, total: number) => void }) {
    this.dbPath = dbPath;
    // Open SQLite database
    this.db = new Database(dbPath);

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Initialize schema
    this.initSchema();

    // Load project context from .devmind directory path
    try {
      this.context = loadProjectContext(path.dirname(dbPath));
    } catch (err) {
      // Ignore context errors (e.g. running from scratch scripts)
    }

    // Auto-sync history and graph from disk JSONs
    this.syncFromDisk(opts?.onSyncProgress);
  }

  /** Throttles progress callbacks to ~100 updates across `total` items, regardless of scale —
   * so a 500-file sync and a 500,000-file sync both report about as often, and the callback
   * itself (a stdout write) never becomes the bottleneck it was being added to diagnose. */
  private static shouldReport(done: number, total: number): boolean {
    const every = Math.max(1, Math.floor(total / 100));
    return done === total || done % every === 0;
  }

  private initSchema() {
    this.db.exec(INIT_SCHEMA_SQL);
    try {
      this.db.exec('ALTER TABLE nodes ADD COLUMN deprecated INTEGER DEFAULT 0');
    } catch {
      // Column already exists, ignore
    }
    try {
      this.db.exec('ALTER TABLE nodes ADD COLUMN description TEXT');
    } catch {
      // Column already exists, ignore
    }
    try {
      this.db.exec("ALTER TABLE nodes ADD COLUMN aliases TEXT DEFAULT '[]'");
    } catch {
      // Column already exists, ignore
    }
    // Workflow v2 columns. Same additive, idempotent shape as the three above: on a fresh brain
    // INIT_SCHEMA_SQL already created them so the ALTER throws and the catch absorbs it; on a brain
    // created before v2 the ALTER is what actually adds them. Deliberately NOT paired with a
    // DROP COLUMN for the fields they replace — `status`/`pending_tasks`/`history_ids` stay as
    // vestigial columns, because dropping them buys nothing (they are nullable or defaulted, so
    // nothing has to write them) and would break an older globally-installed CLI opening the same
    // brain.db with "no such column".
    for (const ddl of [
      'ALTER TABLE workflow_steps ADD COLUMN reasoning TEXT',
      'ALTER TABLE workflow_steps ADD COLUMN node_ids TEXT',
      'ALTER TABLE workflow_steps ADD COLUMN doc_paths TEXT',
      'ALTER TABLE workflows ADD COLUMN archived INTEGER NOT NULL DEFAULT 0'
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        // Column already exists, ignore
      }
    }
    this.backfillWorkflowStepNodeIds();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  getContext(): ProjectContext | null {
    return this.context;
  }

  getSystemMeta(key: string): string | null {
    try {
      const stmt = this.db.prepare('SELECT value FROM system_meta WHERE key = ?');
      const row = stmt.get(key) as { value: string } | undefined;
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  setSystemMeta(key: string, value: string) {
    const stmt = this.db.prepare(`
      INSERT INTO system_meta (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(key, value, value);
  }

  /**
   * Nodes declared in one file. Both sides are folded to a canonical form before comparing:
   * a stored `c:\x\y.ts` and a caller's `C:/x/y.ts` are the same file on Windows, and a raw
   * `=` match silently returns nothing — which reads as "this file has no nodes" rather than
   * as an error. There is no index on file_path, so this was already a full scan; normalizing
   * in SQL costs nothing extra.
   */
  getNodesByFilePath(filePath: string): DbNode[] {
    const stmt = this.db.prepare(
      `SELECT * FROM nodes WHERE deprecated = 0 AND REPLACE(LOWER(file_path), '\\', '/') = ?`
    );
    return DevMindDatabase.parseNodeRows(stmt.all(normalizeFsPath(filePath)) as DbNode[]);
  }

  close() {
    this.db.close();
  }

  /** Snapshot of active-node / connection / history row counts (used by `devsmind sync`). */
  getCounts(): { nodes: number; connections: number; history: number; vectors: number; workflows: number } {
    const one = (sql: string): number => {
      try {
        const row = this.db.prepare(sql).get() as { c: number } | undefined;
        /* istanbul ignore next -- every call site here is a `SELECT COUNT(*) AS c FROM ...`,
           which always returns exactly one row; `row` can only be undefined if this helper is
           ever repurposed for a query that can return zero rows. Kept as a real guard, not
           because today's call sites can hit it. */
        return row ? row.c : 0;
      } catch {
        return 0;
      }
    };
    return {
      nodes: one('SELECT COUNT(*) AS c FROM nodes WHERE deprecated = 0'),
      connections: one('SELECT COUNT(*) AS c FROM node_connections'),
      history: one('SELECT COUNT(*) AS c FROM history'),
      vectors: one('SELECT COUNT(*) AS c FROM node_vectors'),
      workflows: one('SELECT COUNT(*) AS c FROM workflows'),
    };
  }

  vacuum() {
    try {
      this.db.exec('VACUUM');
    } catch (err) {
      console.warn('⚠️ SQLite VACUUM failed:', err);
    }
  }

  /**
   * Wipes all nodes, connections, history, and system_meta from the DB, and clears
   * the committed graph/ and history/ JSON directories on disk. Used by `--from-scratch`
   * reindexing. This is destructive and irreversible from within the app — callers are
   * responsible for confirming with the user first.
   */
  resetAll(): void {
    this.db.exec('DELETE FROM node_connections');
    this.db.exec('DELETE FROM history');
    this.db.exec('DELETE FROM nodes');
    this.db.exec('DELETE FROM node_vectors');
    this.db.exec('DELETE FROM system_meta');

    const workspaceRoot = path.dirname(this.dbPath);
    for (const dir of ['graph', 'history', 'vectors']) {
      const p = path.join(workspaceRoot, dir);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
      fs.mkdirSync(p, { recursive: true });
    }
    // NOTE: 'workflows/' is intentionally NOT wiped — workflow data is long-lived
    // cross-session state that survives a node/history reindex. It will be
    // restored from workflows/*/workflow.json on the next syncFromDisk().

    this.vacuum();
  }

  /**
   * Deletes every connection from both the DB and (by rewriting each affected file's
   * graph JSON) from disk. Used by `--edges-only` to rebuild the edge graph from
   * scratch without touching nodes or history.
   */
  clearAllConnections(): void {
    const rows = this.db.prepare('SELECT DISTINCT file_path FROM nodes WHERE deprecated = 0').all() as { file_path: string }[];
    const affectedFilePaths = new Set<string>();
    for (const row of rows) {
      for (const p of row.file_path.split(',').map(s => s.trim()).filter(Boolean)) {
        affectedFilePaths.add(p);
      }
    }
    this.db.exec('DELETE FROM node_connections');
    for (const filePath of affectedFilePaths) {
      this.writeGraphToDisk(filePath);
    }
  }

  /**
   * Deletes only the OUTGOING connections of the given source nodes (and re-syncs the
   * affected files' graph JSON). Used by repo-scoped `--edges-only` so that rebuilding
   * one repo's edges doesn't wipe every other repo's edges.
   */
  clearConnectionsForSources(nodeIds: string[]): void {
    if (nodeIds.length === 0) return;
    const affectedFilePaths = new Set<string>();
    const del = this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ?');
    const getFp = this.db.prepare('SELECT file_path FROM nodes WHERE id = ?');
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        const row = getFp.get(id) as { file_path?: string } | undefined;
        if (row?.file_path) {
          for (const p of row.file_path.split(',').map(s => s.trim()).filter(Boolean)) {
            affectedFilePaths.add(p);
          }
        }
        del.run(id);
      }
    });
    tx(nodeIds);
    for (const filePath of affectedFilePaths) {
      this.writeGraphToDisk(filePath);
    }
  }

  // --- Node Operations ---

  upsertNode(node: { id: string; type: string; name: string; file_path: string; signature?: string | null; description?: string | null; aliases?: string[] }) {
    const canonicalFp = canonicalizePath(node.file_path);
    const existing = this.getNode(node.id);
    // aliases JSON is only computed when the caller actually passed some — an ordinary
    // edit/re-index of a node that ISN'T alias-bearing must not blank out aliases a prior
    // detector pass (or Phase E's record_alias) already attached, same COALESCE idiom as
    // description/signature below.
    const aliasesJson = node.aliases ? JSON.stringify(Array.from(new Set(node.aliases))) : null;
    if (existing) {
      let finalPath = existing.file_path;
      const paths = existing.file_path.split(',').map(p => p.trim()).filter(Boolean);
      const incoming = canonicalFp.trim();
      if (!paths.includes(incoming)) {
        paths.push(incoming);
        finalPath = paths.join(', ');
      }

      // description follows the same COALESCE idiom as signature: an unspecified description
      // on an ordinary edit must never blank out one already written — only an explicit new
      // value (from add_description, or a description passed alongside this edit) overwrites it.
      const stmt = this.db.prepare(`
        UPDATE nodes
        SET type = ?,
            name = ?,
            file_path = ?,
            signature = COALESCE(?, signature),
            description = COALESCE(?, description),
            aliases = COALESCE(?, aliases),
            deprecated = 0
        WHERE id = ?
      `);
      stmt.run(node.type, node.name, finalPath, node.signature || null, node.description || null, aliasesJson, node.id);
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO nodes (id, type, name, file_path, signature, description, aliases)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(node.id, node.type, node.name, canonicalFp, node.signature || null, node.description || null, aliasesJson ?? '[]');
    }
    this.writeGraphToDisk(canonicalFp);
  }

  /**
   * Adds one alias to a node WITHOUT touching any it already has — the merge-safe counterpart to
   * `upsertNode`'s replace-if-given aliases. This is what the batch graph-fix session's
   * `record_alias` correction tool (Phase E) uses: it should never be able to accidentally drop an
   * alias a deterministic detector pass already attached.
   */
  addAlias(nodeId: string, alias: string): void {
    const node = this.getNode(nodeId);
    if (!node) return;
    if (node.aliases.includes(alias)) return;
    const next = [...node.aliases, alias];
    this.db.prepare('UPDATE nodes SET aliases = ? WHERE id = ?').run(JSON.stringify(next), node.id);
    this.writeGraphToDisk(node.file_path);
  }

  /**
   * Stores a node's semantic vector and writes it to the committed `vectors/*.json` tree.
   * `vector` must already be int8-quantized (`embedTextInt8`/`embedTextsInt8` in embedder.ts) and
   * `descriptionHash` must be `hashDescription()` of the exact description it was computed from —
   * this is the staleness key `getNodesNeedingEmbedding` checks against.
   */
  upsertNodeVector(nodeId: string, vector: Int8Array, descriptionHash: string) {
    const node = this.getNode(nodeId);
    if (!node) return;
    const stmt = this.db.prepare(`
      INSERT INTO node_vectors (node_id, model_id, dim, description_hash, vector)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        model_id = excluded.model_id,
        dim = excluded.dim,
        description_hash = excluded.description_hash,
        vector = excluded.vector
    `);
    stmt.run(node.id, EMBEDDING_MODEL_ID, EMBEDDING_DIM, descriptionHash, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
    this.writeVectorsToDisk(node.file_path);
  }

  getNodeVector(nodeId: string): { modelId: string; dim: number; descriptionHash: string; vector: Int8Array } | null {
    const stmt = this.db.prepare('SELECT model_id, dim, description_hash, vector FROM node_vectors WHERE node_id = ?');
    const row = stmt.get(nodeId) as { model_id: string; dim: number; description_hash: string; vector: Buffer } | undefined;
    if (!row) return null;
    return {
      modelId: row.model_id,
      dim: row.dim,
      descriptionHash: row.description_hash,
      vector: new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength)
    };
  }

  /**
   * Every non-deprecated, described node whose vector is missing, from a different model
   * (`model_id` mismatch — e.g. a mismatched vector ignored during `syncFromDisk`), or stale
   * (its description changed since the vector was computed). This is the work queue for both
   * `devsmind embed` and the auto-embed hooks in `describe`/`add_description` — resumable and
   * idempotent by construction, same shape as `describe.ts`'s own `WHERE description IS NULL`.
   * `force: true` returns every described node regardless of vector state (model upgrades).
   */
  getNodesNeedingEmbedding(force: boolean = false): DbNode[] {
    const described = this.getAllNodes().filter(n => !n.deprecated && n.description);
    if (force) return described;
    const vecRows = this.db.prepare('SELECT node_id, model_id, description_hash FROM node_vectors').all() as
      { node_id: string; model_id: string; description_hash: string }[];
    const vecMap = new Map(vecRows.map(r => [r.node_id, r]));
    return described.filter(n => {
      const v = vecMap.get(n.id);
      if (!v) return true;
      if (v.model_id !== EMBEDDING_MODEL_ID) return true;
      if (v.description_hash !== hashDescription(n.description as string)) return true;
      return false;
    });
  }

  /**
   * The `nodes.aliases` column is a JSON-array-in-TEXT blob — better-sqlite3 hands it back as a
   * raw string, not a parsed array, on every `stmt.all()`/`stmt.get()`. A JSON string masquerading
   * as `string[]` is a silent-wrong-answer hazard (both have `.length`, so a bug here would not
   * throw, just quietly misbehave — e.g. counting characters instead of aliases). EVERY raw SQL
   * read of the `nodes` table must route its rows through {@link parseNodeRow}/{@link
   * parseNodeRows}, never cast `as DbNode`/`as DbNode[]` directly.
   */
  private static parseNodeAliases(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.filter(a => typeof a === 'string');
    if (typeof raw !== 'string' || raw.length === 0) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(a => typeof a === 'string') : [];
    } catch {
      return [];
    }
  }

  private static parseNodeRow<T extends { aliases?: unknown }>(row: T): T & { aliases: string[] } {
    return { ...row, aliases: DevMindDatabase.parseNodeAliases(row.aliases) };
  }

  private static parseNodeRows<T extends { aliases?: unknown }>(rows: T[]): (T & { aliases: string[] })[] {
    return rows.map(DevMindDatabase.parseNodeRow);
  }

  getNode(id: string): DbNode | null {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    const direct = stmt.get(id) as DbNode | undefined;
    if (direct) return DevMindDatabase.parseNodeRow(direct);

    if (!id.includes('#')) {
      const suffixStmt = this.db.prepare("SELECT * FROM nodes WHERE id LIKE ? ESCAPE '\\' AND deprecated = 0");
      const matches = suffixStmt.all(`%#${this.likeEscape(id)}`) as DbNode[];
      if (matches.length === 1) {
        return DevMindDatabase.parseNodeRow(matches[0]);
      }
    }
    return null;
  }

  deleteNode(id: string) {
    const node = this.getNode(id);
    const resolvedId = node ? node.id : id;
    // Capture caller files, and delete the node's history JSONs, BEFORE the row (and its
    // cascade-deleted history rows / edges) is gone. Without the JSON cleanup, syncFromDisk()
    // would resurrect the node from its lingering history/[id].json on the next server start.
    const inboundSourceFiles = this.collectInboundSourceFiles(resolvedId);
    this.deleteHistoryFilesForNode(resolvedId);
    const stmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    stmt.run(resolvedId);
    // node_vectors has no FK to nodes (see schema.ts) so this doesn't cascade — delete it
    // explicitly rather than waiting for the next syncFromDisk() orphan sweep, or a vector
    // search could keep surfacing a node that no longer exists until the next server restart.
    this.db.prepare('DELETE FROM node_vectors WHERE node_id = ?').run(resolvedId);
    if (node && node.file_path) {
      this.writeGraphToDisk(node.file_path);
      this.writeVectorsToDisk(node.file_path);
    }
    for (const p of inboundSourceFiles) {
      this.writeGraphToDisk(p);
    }
  }

  deprecateNode(id: string) {
    const node = this.getNode(id);
    const resolvedId = node ? node.id : id;
    // Capture the caller files BEFORE we delete the inbound edges — afterwards the join
    // that finds them returns nothing.
    const inboundSourceFiles = this.collectInboundSourceFiles(resolvedId);
    const updateStmt = this.db.prepare('UPDATE nodes SET deprecated = 1 WHERE id = ?');
    const deleteConnStmt = this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ? OR target_node_id = ?');
    // A deprecated node's vector is pure dead weight (writeVectorsToDisk already excludes
    // deprecated nodes from the JSON) — drop it now rather than leaving an unused row behind.
    const deleteVectorStmt = this.db.prepare('DELETE FROM node_vectors WHERE node_id = ?');
    const tx = this.db.transaction(() => {
      updateStmt.run(resolvedId);
      deleteConnStmt.run(resolvedId, resolvedId);
      deleteVectorStmt.run(resolvedId);
    });
    tx();
    // Rewrite the node's own file (now carrying deprecated:1) and every caller file (so their
    // stale inbound edges don't resurrect the connection on the next syncFromDisk()).
    if (node && node.file_path) {
      this.writeVectorsToDisk(node.file_path);
      this.writeGraphToDisk(node.file_path);
    }
    for (const p of inboundSourceFiles) {
      this.writeGraphToDisk(p);
    }
  }

  /** `newFilePath`: pass when the rename is a file move (analyze's rename migration), leave undefined for a pure symbol-id rename where the file itself is unchanged. */
  renameNode(oldId: string, newId: string, newName?: string, newFilePath?: string) {
    const node = this.getNode(oldId);
    if (!node) {
      throw new Error(`Node not found: ${oldId}`);
    }
    // getNode() resolves a bare/unqualified id (e.g. "createCart") to the node's fully-qualified
    // one via a suffix match — but node_connections/history are keyed by the FULLY-QUALIFIED id
    // only. Every statement below must use node.id, not the raw oldId parameter: using oldId
    // directly makes each UPDATE a silent no-op whenever the caller passed a bare id (matching
    // no rows, throwing no error), leaving the new id's row empty/disconnected while the old
    // node's history and edges stay put under the id that was supposedly just renamed away.
    const resolvedOldId = node.id;

    const name = newName || (node.name === resolvedOldId ? newId : node.name);
    const filePath = newFilePath || node.file_path;

    this.db.pragma('foreign_keys = OFF');

    try {
      const runTx = this.db.transaction(() => {
        const insertStmt = this.db.prepare(`
          INSERT INTO nodes (id, type, name, file_path, signature, description, aliases, created_at, deprecated)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertStmt.run(newId, node.type, name, filePath, node.signature, node.description, JSON.stringify(node.aliases), node.created_at, node.deprecated ? 1 : 0);

        const updateSourceStmt = this.db.prepare(`
          UPDATE node_connections SET source_node_id = ? WHERE source_node_id = ?
        `);
        updateSourceStmt.run(newId, resolvedOldId);

        const updateTargetStmt = this.db.prepare(`
          UPDATE node_connections SET target_node_id = ? WHERE target_node_id = ?
        `);
        updateTargetStmt.run(newId, resolvedOldId);

        const updateHistoryStmt = this.db.prepare(`
          UPDATE history SET node_id = ? WHERE node_id = ?
        `);
        updateHistoryStmt.run(newId, resolvedOldId);

        // Carry any existing vector row to the new id — same reasoning as description above:
        // a rename shouldn't force a re-embed. No-op if the node had no vector yet.
        const updateVectorStmt = this.db.prepare(`
          UPDATE node_vectors SET node_id = ? WHERE node_id = ?
        `);
        updateVectorStmt.run(newId, resolvedOldId);

        const deleteOldStmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
        deleteOldStmt.run(resolvedOldId);
      });

      runTx();
      if (node.file_path) {
        // Rewrite the OLD file's graph JSON too when the file itself moved, so the
        // stale node entry doesn't linger under the old path's JSON on disk.
        this.writeGraphToDisk(node.file_path);
        this.writeVectorsToDisk(node.file_path);
      }
      if (filePath && filePath !== node.file_path) {
        this.writeGraphToDisk(filePath);
        this.writeVectorsToDisk(filePath);
      }

      // Edges pointing INTO the renamed node live in the SOURCE nodes' files' graph JSONs
      // (which still reference oldId on disk). The DB was already repointed to newId above,
      // so rewrite each such file — otherwise syncFromDisk reloads the stale oldId edge and
      // the renamed node silently loses all its inbound ("used-by") edges.
      this.rewriteInboundSourceFiles(newId);

      // Keep the committed history/*.json files in sync with the rename. Without this,
      // syncFromDisk() on the next server start would find the old node_id (which no
      // longer exists in the DB) and re-insert it right back, undoing the rename.
      const historyIds = this.db.prepare('SELECT id FROM history WHERE node_id = ?').all(newId) as { id: string }[];
      for (const row of historyIds) {
        this.patchHistoryDiskIdentity(row.id, newId, name, node.type, filePath, node.signature);
      }
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  /**
   * Merges `fromId` into `intoId` — the batch graph-fix session's `merge_nodes` correction, for
   * when curation (or a human reviewing feedback) decides two node candidates were never really
   * distinct entities. Unlike `renameNode` (which moves everything to a FRESH id), `intoId`
   * already exists with its own rows here: `fromId`'s connections (both directions) and history
   * are reassigned onto it, `fromId`'s aliases (plus its own name, so old references by that name
   * still resolve) are folded into `intoId`'s alias set, and `fromId` is deprecated — not hard
   * deleted, so its history stays reachable and the merge itself stays a reversible correction,
   * not a destructive one.
   */
  mergeNodes(fromId: string, intoId: string): void {
    const fromNode = this.getNode(fromId);
    const intoNode = this.getNode(intoId);
    if (!fromNode) throw new Error(`mergeNodes: source node not found: ${fromId}`);
    if (!intoNode) throw new Error(`mergeNodes: target node not found: ${intoId}`);
    const resolvedFrom = fromNode.id;
    const resolvedInto = intoNode.id;
    if (resolvedFrom === resolvedInto) return; // already the same node — no-op, not an error

    this.db.pragma('foreign_keys = OFF');
    try {
      const runTx = this.db.transaction(() => {
        // Reassign fromId's connections onto intoId in both directions. INSERT OR IGNORE
        // absorbs a duplicate-PK conflict when both nodes already shared a target/source; the
        // `!== resolvedInto` guard drops what would otherwise become a self-referencing edge.
        const outRows = this.db.prepare('SELECT target_node_id FROM node_connections WHERE source_node_id = ?').all(resolvedFrom) as { target_node_id: string }[];
        for (const r of outRows) {
          if (r.target_node_id === resolvedInto) continue;
          this.db.prepare('INSERT OR IGNORE INTO node_connections (source_node_id, target_node_id) VALUES (?, ?)').run(resolvedInto, r.target_node_id);
        }
        const inRows = this.db.prepare('SELECT source_node_id FROM node_connections WHERE target_node_id = ?').all(resolvedFrom) as { source_node_id: string }[];
        for (const r of inRows) {
          if (r.source_node_id === resolvedInto) continue;
          this.db.prepare('INSERT OR IGNORE INTO node_connections (source_node_id, target_node_id) VALUES (?, ?)').run(r.source_node_id, resolvedInto);
        }
        this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ? OR target_node_id = ?').run(resolvedFrom, resolvedFrom);

        this.db.prepare('UPDATE history SET node_id = ? WHERE node_id = ?').run(resolvedInto, resolvedFrom);

        const mergedAliases = Array.from(new Set([...intoNode.aliases, ...fromNode.aliases, fromNode.name]));
        this.db.prepare('UPDATE nodes SET aliases = ? WHERE id = ?').run(JSON.stringify(mergedAliases), resolvedInto);

        this.db.prepare('UPDATE nodes SET deprecated = 1 WHERE id = ?').run(resolvedFrom);
      });
      runTx();

      if (fromNode.file_path) this.writeGraphToDisk(fromNode.file_path);
      if (intoNode.file_path && intoNode.file_path !== fromNode.file_path) this.writeGraphToDisk(intoNode.file_path);
      // Edges that pointed INTO fromId now point at intoId in the DB, but the SOURCE files'
      // on-disk JSON still says fromId until rewritten — same reasoning as renameNode's own use
      // of this helper. Queried AFTER the transaction, so it reflects the already-repointed state.
      this.rewriteInboundSourceFiles(resolvedInto);

      const historyIds = this.db.prepare('SELECT id FROM history WHERE node_id = ?').all(resolvedInto) as { id: string }[];
      for (const row of historyIds) {
        this.patchHistoryDiskIdentity(row.id, resolvedInto, intoNode.name, intoNode.type, intoNode.file_path, intoNode.signature);
      }
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  /**
   * Rewrites a history/[id].json file's identifying fields (node_id, node_metadata) in
   * place, leaving code_snapshot/reasoning/timestamps untouched. Used after a rename so
   * disk stays consistent with the DB without needing the full code_snapshot/reasoning
   * to be re-passed in.
   */
  private patchHistoryDiskIdentity(
    historyId: string,
    nodeId: string,
    name: string,
    type: string,
    filePath: string,
    signature: string | null
  ): void {
    try {
      const historyDir = path.join(path.dirname(this.dbPath), 'history');
      const filePathOnDisk = path.join(historyDir, `${historyId}.json`);
      if (!fs.existsSync(filePathOnDisk)) return;

      const data = JSON.parse(fs.readFileSync(filePathOnDisk, 'utf-8'));
      data.node_id = nodeId;
      data.node_metadata = {
        name,
        type,
        file_path: this.toRepoRelativePath(filePath),
        signature
      };

      fs.writeFileSync(filePathOnDisk, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('⚠️ SQLite warning: Failed to patch history JSON identity on disk:', err);
    }
  }

  /**
   * Collects the distinct file paths of every SOURCE node that has an OUTGOING edge pointing
   * INTO `nodeId` (i.e. this node's "used-by" callers). Those inbound edges live on disk in the
   * source nodes' files, not in the target's own file. Callers that DELETE the inbound edges
   * (deprecate/delete) must call this BEFORE the deletion to capture the affected files;
   * callers that merely repoint them (rename) can rewrite after the fact.
   */
  private collectInboundSourceFiles(nodeId: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT n.file_path AS file_path
      FROM node_connections c JOIN nodes n ON n.id = c.source_node_id
      WHERE c.target_node_id = ?
    `).all(nodeId) as { file_path: string }[];
    const files = new Set<string>();
    for (const row of rows) {
      if (!row.file_path) continue;
      for (const p of row.file_path.split(',').map(s => s.trim()).filter(Boolean)) {
        files.add(p);
      }
    }
    return Array.from(files);
  }

  /**
   * Re-syncs each given source file's graph JSON. Used after the DB has been mutated so that
   * syncFromDisk() won't reload a stale inbound ("used-by") edge on the next server start.
   */
  private rewriteInboundSourceFiles(nodeId: string) {
    for (const p of this.collectInboundSourceFiles(nodeId)) {
      this.writeGraphToDisk(p);
    }
  }

  /**
   * Deletes the committed history/[id].json files for every history record of `nodeId`.
   * Used on HARD delete so that syncFromDisk()'s history pass can't resurrect the node
   * (and its metadata) from a lingering JSON on the next server start. Reads the history
   * ids BEFORE the DB rows are removed, so call this while they still exist (or pass ids in).
   */
  private deleteHistoryFilesForNode(nodeId: string) {
    try {
      const historyDir = path.join(path.dirname(this.dbPath), 'history');
      const rows = this.db.prepare('SELECT id FROM history WHERE node_id = ?').all(nodeId) as { id: string }[];
      for (const row of rows) {
        const filePath = path.join(historyDir, `${row.id}.json`);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.warn('⚠️ SQLite warning: Failed to delete history JSON(s) on disk:', err);
    }
  }

  // --- Connection Operations ---

  addConnection(sourceNodeId: string, targetNodeId: string) {
    const srcNode = this.getNode(sourceNodeId);
    const tgtNode = this.getNode(targetNodeId);
    const resolvedSrc = srcNode ? srcNode.id : sourceNodeId;
    const resolvedTgt = tgtNode ? tgtNode.id : targetNodeId;
    
    // The on-disk graph format is node-anchored: each file's JSON lists its nodes and their
    // OUTGOING edges. An edge whose SOURCE node doesn't exist has nowhere to be written on
    // disk, so it would live only in brain.db and be silently dropped by syncFromDisk() on the
    // next server start. Rather than leak that DB-only orphan, refuse the edge and tell the
    // caller to add the source node first (the two-phase indexing protocol already does this).
    if (!srcNode) {
      console.warn(
        `⚠️ DevsMind: connection skipped — source node "${sourceNodeId}" does not exist in ` +
        `the graph. Add it (edit_node / update_history) before connecting it, otherwise the edge ` +
        `cannot be persisted to disk and would not survive a restart.`
      );
      return;
    }

    this.db.pragma('foreign_keys = OFF');
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO node_connections (source_node_id, target_node_id)
        VALUES (?, ?)
      `);
      stmt.run(resolvedSrc, resolvedTgt);
      if (srcNode.file_path) {
        this.writeGraphToDisk(srcNode.file_path);
      }
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  removeConnection(sourceNodeId: string, targetNodeId: string) {
    const srcNode = this.getNode(sourceNodeId);
    const tgtNode = this.getNode(targetNodeId);
    const resolvedSrc = srcNode ? srcNode.id : sourceNodeId;
    const resolvedTgt = tgtNode ? tgtNode.id : targetNodeId;
    const stmt = this.db.prepare(`
      DELETE FROM node_connections
      WHERE source_node_id = ? AND target_node_id = ?
    `);
    stmt.run(resolvedSrc, resolvedTgt);
    if (srcNode && srcNode.file_path) {
      this.writeGraphToDisk(srcNode.file_path);
    }
  }

  /**
   * `opts.limit`/`opts.offset` page a hub node's caller/callee list deterministically —
   * `ORDER BY file_path, name` so a repeated call with the same offset returns the same slice,
   * and so the local/nearby callers a reader actually wants tend to sort ahead of a scattered
   * cross-repo tail (same file_path groups together). Omitting `opts` returns every row, exactly
   * as before — every pre-existing call site keeps working unchanged.
   */
  getConnections(nodeId: string, opts: { limit?: number; offset?: number } = {}): { uses: DbNode[]; usedBy: DbNode[] } {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const paging = opts.limit !== undefined ? ' ORDER BY n.file_path, n.name LIMIT ? OFFSET ?' : '';
    const usesStmt = this.db.prepare(`
      SELECT n.* FROM nodes n
      JOIN node_connections c ON n.id = c.target_node_id
      WHERE c.source_node_id = ?${paging}
    `);
    const usedByStmt = this.db.prepare(`
      SELECT n.* FROM nodes n
      JOIN node_connections c ON n.id = c.source_node_id
      WHERE c.target_node_id = ?${paging}
    `);
    const args = opts.limit !== undefined ? [resolvedId, opts.limit, opts.offset ?? 0] : [resolvedId];

    return {
      uses: DevMindDatabase.parseNodeRows(usesStmt.all(...args) as DbNode[]),
      usedBy: DevMindDatabase.parseNodeRows(usedByStmt.all(...args) as DbNode[])
    };
  }

  /**
   * Batched, COUNT-only connection degree for many nodes at once — the search-result drill-in
   * hooks need this for ~20 nodes per call, and `getConnections` per-node would mean 20 pairs of
   * full-row-fetching queries. One grouped COUNT each way instead (same shape as the degree
   * subquery in {@link getGodEntities}). IDs not present in `node_connections` still get a
   * `{uses:0, usedBy:0}` entry so callers never need an existence check.
   */
  getConnectionCounts(ids: string[]): Map<string, { uses: number; usedBy: number }> {
    const result = new Map<string, { uses: number; usedBy: number }>();
    if (ids.length === 0) return result;
    for (const id of ids) result.set(id, { uses: 0, usedBy: 0 });

    const placeholders = ids.map(() => '?').join(',');
    const usesStmt = this.db.prepare(`
      SELECT source_node_id AS id, COUNT(*) AS n FROM node_connections
      WHERE source_node_id IN (${placeholders}) GROUP BY source_node_id
    `);
    const usedByStmt = this.db.prepare(`
      SELECT target_node_id AS id, COUNT(*) AS n FROM node_connections
      WHERE target_node_id IN (${placeholders}) GROUP BY target_node_id
    `);
    for (const row of usesStmt.all(...ids) as { id: string; n: number }[]) {
      const e = result.get(row.id);
      if (e) e.uses = row.n;
    }
    for (const row of usedByStmt.all(...ids) as { id: string; n: number }[]) {
      const e = result.get(row.id);
      if (e) e.usedBy = row.n;
    }
    return result;
  }

  /** Batched history-entry count for many nodes at once — metadata only, no disk reads. */
  getHistoryCounts(ids: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT node_id AS id, COUNT(*) AS n FROM history
      WHERE node_id IN (${placeholders}) GROUP BY node_id
    `);
    for (const row of stmt.all(...ids) as { id: string; n: number }[]) {
      result.set(row.id, row.n);
    }
    return result;
  }

  /**
   * Batched most-recent history timestamp for many nodes at once. Deliberately SQL-only (`MAX`
   * over the indexed `updated_at` column) — unlike {@link getLatestHistory}, this never touches
   * `populateHistoryFromDisk`, so it costs nothing beyond the query itself.
   */
  getLastUpdatedMap(ids: string[]): Map<string, string> {
    const result = new Map<string, string>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT node_id AS id, MAX(updated_at) AS last FROM history
      WHERE node_id IN (${placeholders}) GROUP BY node_id
    `);
    for (const row of stmt.all(...ids) as { id: string; last: string }[]) {
      result.set(row.id, row.last);
    }
    return result;
  }

  // --- History Operations ---

  getLatestHistory(nodeId: string): DbHistory | null {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const stmt = this.db.prepare(`
      SELECT id, node_id, session_id, created_at, updated_at FROM history
      WHERE node_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    const row = stmt.get(resolvedId) as any;
    if (!row) return null;
    return this.populateHistoryFromDisk(row);
  }

  listHistory(nodeId: string): Omit<DbHistory, 'code_snapshot' | 'reasoning' | 'edits'>[] {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const stmt = this.db.prepare(`
      SELECT id, node_id, session_id, created_at, updated_at
      FROM history
      WHERE node_id = ?
      ORDER BY updated_at DESC
    `);
    return stmt.all(resolvedId) as Omit<DbHistory, 'code_snapshot' | 'reasoning' | 'edits'>[];
  }

  getHistoryEntry(id: string): DbHistory | null {
    const stmt = this.db.prepare('SELECT id, node_id, session_id, created_at, updated_at FROM history WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return this.populateHistoryFromDisk(row);
  }

  getFullHistory(nodeId: string): DbHistory[] {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const stmt = this.db.prepare(`
      SELECT id, node_id, session_id, created_at, updated_at
      FROM history
      WHERE node_id = ?
      ORDER BY updated_at DESC
    `);
    const rows = stmt.all(resolvedId) as any[];
    return rows.map(row => this.populateHistoryFromDisk(row));
  }

  /**
   * The last `limit` history entries' reasoning + timestamps only — no `code_snapshot`/`edits`.
   * Built for `get_node_code`'s default `history:"recent"` mode, which already returns the
   * CURRENT code: repeating past snapshots inline would just duplicate what's already in the
   * response. The full trail (snapshots + diffable edits) is `history:"full"`, served by
   * {@link getHistoryPage}. This answers "why does this look the way it does" cheaply enough to
   * attach to every get_node_code call by default, instead of leaving that as a round trip an AI
   * has to remember to make (or skip, and re-break a decision it never saw).
   */
  getRecentHistorySummaries(nodeId: string, limit: number): Array<Pick<DbHistory, 'id' | 'session_id' | 'created_at' | 'updated_at' | 'reasoning'>> {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const stmt = this.db.prepare(`
      SELECT id, node_id, session_id, created_at, updated_at
      FROM history
      WHERE node_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(resolvedId, limit) as any[];
    return rows.map(row => {
      const full = this.populateHistoryFromDisk(row);
      return { id: full.id, session_id: full.session_id, created_at: full.created_at, updated_at: full.updated_at, reasoning: full.reasoning };
    });
  }

  /**
   * `history:"full"`'s backing query — the same full-fidelity payload as {@link getFullHistory}
   * (code_snapshot + diffable edits per entry), but LIMIT/OFFSET applied IN SQL before any disk
   * read happens, not by slicing an already-fully-loaded array. `getFullHistory` reads every
   * revision's JSON off disk unconditionally; for a node with dozens of revisions that is dozens
   * of synchronous file reads to serve a request for the newest 5. `total` is the true count
   * before paging, same honesty contract as `nodes_total`/`files_total` elsewhere.
   */
  getHistoryPage(nodeId: string, limit: number, offset: number): { entries: DbHistory[]; total: number } {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const totalRow = this.db.prepare('SELECT COUNT(*) AS c FROM history WHERE node_id = ?').get(resolvedId) as { c: number };
    const stmt = this.db.prepare(`
      SELECT id, node_id, session_id, created_at, updated_at
      FROM history
      WHERE node_id = ?
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(resolvedId, limit, offset) as any[];
    return { entries: rows.map(row => this.populateHistoryFromDisk(row)), total: totalRow.c };
  }

  /**
   * Every history row in a time/session window, joined to its node's file path — the SHARED
   * counterpart to the local activity log, and the backing query for `get_activity_log`'s graph
   * fallback (see db/activity-graph.ts).
   *
   * Deliberately reads SQLite ONLY, never `populateHistoryFromDisk`. Everything the fallback needs
   * — reasoning (which carries developer + requirement, see formatReasoning), both timestamps,
   * session_id, and the file path — is already in columns; the disk JSON adds only `code_snapshot`
   * and `edits`, neither of which an activity listing reports. That matters because this scans
   * ROWS, not one node's history: routing it through the per-row file read would turn a single
   * indexed query into one synchronous readFileSync per revision in the window.
   *
   * The date bounds test the row's [created_at, updated_at] span against the window rather than a
   * single point. One row accumulates blocks for up to an hour past `created_at` (the merge rule),
   * so `created_at >= since` would silently drop a row whose in-window blocks were appended to an
   * out-of-window row. This over-selects instead, and the caller filters per block, where the real
   * timestamps live.
   *
   * `file_path` is null when the node is gone (history outlives its node — a hard delete leaves
   * rows behind). Nulls are the caller's to skip; dropping them here would silently shrink the
   * edit counts a fallback entry reports.
   */
  queryHistoryForActivity(opts: {
    sessionId?: string;
    since?: string;
    until?: string;
    /** Hard cap on rows scanned, newest-updated first. Bounds a full-table scan on a mature repo;
     * the caller reports when it bites rather than passing off a truncated log as complete. */
    limit?: number;
  } = {}): { id: string; node_id: string; session_id: string; created_at: string; updated_at: string; reasoning: string; file_path: string | null }[] {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.sessionId) {
      where.push('h.session_id = ?');
      params.push(opts.sessionId);
    }
    if (opts.since) {
      where.push('h.updated_at >= ?');
      params.push(opts.since);
    }
    if (opts.until) {
      where.push('h.created_at <= ?');
      params.push(opts.until);
    }
    const sql = `
      SELECT h.id, h.node_id, h.session_id, h.created_at, h.updated_at, h.reasoning, n.file_path
      FROM history h
      LEFT JOIN nodes n ON n.id = h.node_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY h.updated_at DESC
      LIMIT ?
    `;
    params.push(opts.limit ?? 5000);
    return this.db.prepare(sql).all(...params) as any[];
  }

  /** Distinct source node ids of edges pointing INTO this node (its "used-by" callers). */
  getInboundSources(nodeId: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT source_node_id FROM node_connections WHERE target_node_id = ?')
      .all(nodeId) as { source_node_id: string }[];
    return rows.map(r => r.source_node_id);
  }

  getLatestCode(nodeId: string): { code_snapshot: string; updated_at: string } | null {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const history = this.getLatestHistory(resolvedId);
    if (!history || !history.code_snapshot || history.code_snapshot.trim() === '') return null;
    return {
      updated_at: history.updated_at,
      code_snapshot: history.code_snapshot
    };
  }

  /**
   * Parse a node's CURRENT source straight off disk via the AST, bypassing the stored snapshot.
   * `nodes.file_path` is already absolute, and may be a ", "-joined list when a symbol spans
   * files — try each until one resolves. Returns null for non-TS/JS files, or when the symbol
   * no longer exists in the file (renamed / moved / deleted).
   */
  private extractLiveCode(node: DbNode): string | null {
    const parsed = parseNodeId(node.id);
    // Pass the FULL symbol name ("Foo.bar") — extractNodeFromFile re-derives the class itself.
    const symbol = parsed ? parsed.symbolName : node.id.split('#').pop() || node.name;
    if (!symbol) return null;

    for (const p of String(node.file_path).split(',').map(s => s.trim()).filter(Boolean)) {
      const derived = extractNodeFromFile(p, symbol);
      if (derived) return derived.codeSnapshot;
    }
    return null;
  }

  /**
   * Current code for a node, read from the file on disk (the source of truth) rather than the
   * cached snapshot. Falls back to the snapshot only when the file can't be parsed for this
   * symbol, and flags that fallback as unverified. When live code IS available, comparing it to
   * the snapshot is free — so drift between the graph and disk is reported rather than hidden.
   */
  getLiveCode(nodeId: string): LiveCodeResult {
    const node = this.getNode(nodeId);
    const resolvedId = node ? node.id : nodeId;
    const snapshot = this.getLatestCode(resolvedId);

    if (node) {
      const live = this.extractLiveCode(node);
      if (live !== null) {
        const outdated = snapshot ? snapshot.code_snapshot !== live : undefined;
        return {
          exists: true,
          node_id: node.id,
          file_path: node.file_path,
          code: live,
          source: 'live',
          // Snapshot exists but disagrees with disk → the RECORDED HISTORY has drifted, not the
          // `code` above — that was just read fresh from disk this call. Worth a message, not
          // just a bare flag: without it, this reads as "don't trust what you were just handed,"
          // which is backwards — it's the opposite thing (the graph's history) that's behind.
          snapshot_outdated: outdated,
          updated_at: snapshot?.updated_at,
          message: outdated
            ? 'The code above is current — read live from disk this call. Only the recorded history snapshot is stale (it predates this edit); no need to re-read the file to double-check.'
            : undefined
        };
      }
    }

    if (snapshot) {
      return {
        exists: true,
        node_id: resolvedId,
        file_path: node?.file_path,
        code: snapshot.code_snapshot,
        source: 'cached',
        // Could not confirm against disk (non-TS/JS file, or symbol gone) — treat as suspect.
        snapshot_outdated: true,
        updated_at: snapshot.updated_at,
        message:
          'Could not locate this symbol in its source file — the file may not be TS/JS, or the symbol was renamed, moved, or deleted. Returning the last cached snapshot, which may be out of date. Verify against the file before relying on it.'
      };
    }

    return {
      exists: false,
      node_id: resolvedId,
      message:
        'No code found on disk or in cache. Read the source file, then edit_node + commit_changes so future agents skip the file read entirely.'
    };
  }

  getGraph(nodeId: string, maxDepth: number = 6, opts: GraphOptions = {}): GraphResult {
    const direction = opts.direction ?? 'both';
    const codeCharBudget = opts.codeCharBudget ?? 60_000;

    const maxNodesLimit = opts.maxNodes ?? 500;
    const visited = new Set<string>();
    const nodes: GraphNode[] = [];
    const connections: DbConnection[] = [];
    const connSet = new Set<string>();

    const rootNode = this.getNode(nodeId);
    if (!rootNode) {
      return { nodes, connections };
    }

    // Seed with the CANONICAL id. getNode() resolves a bare, unqualified symbol name, but
    // node_connections is keyed by the fully-qualified id — seeding the queue with the raw
    // argument would find zero edges and return a lone root.
    const queue: { id: string; depth: number }[] = [{ id: rootNode.id, depth: 0 }];
    visited.add(rootNode.id);
    (rootNode as GraphNode).depth = 0;
    nodes.push(rootNode);

    // ORDER BY on both directions so the walk is REPRODUCIBLE: without it, sibling order within a
    // depth is whatever physical row order SQLite happens to return, which shifts after inserts,
    // deletes, or a VACUUM. That made two identical getGraph calls able to disagree about which
    // nodes got code when the budget ran out — the same query returning a different answer for no
    // visible reason. Both are index-ordered already (the PK autoindex outbound,
    // idx_node_connections_target inbound), so the planner elides the sort and this costs nothing.
    const usesStmt = this.db.prepare(`
      SELECT target_node_id FROM node_connections WHERE source_node_id = ? ORDER BY target_node_id
    `);
    const usedByStmt = this.db.prepare(`
      SELECT source_node_id FROM node_connections WHERE target_node_id = ? ORDER BY source_node_id
    `);

    while (queue.length > 0 && nodes.length < maxNodesLimit) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) {
        continue;
      }

      // Outbound — what this node uses (callees). Skipped when tracing callers only.
      if (direction !== 'in') {
        const outbound = usesStmt.all(current.id) as { target_node_id: string }[];
        for (const row of outbound) {
          const targetId = row.target_node_id;
          const connKey = `${current.id}->${targetId}`;
          if (!connSet.has(connKey)) {
            connSet.add(connKey);
            connections.push({ source_node_id: current.id, target_node_id: targetId });
          }
          if (!visited.has(targetId)) {
            visited.add(targetId);
            const targetNode = this.getNode(targetId);
            if (targetNode) {
              (targetNode as GraphNode).depth = current.depth + 1;
              nodes.push(targetNode);
              if (nodes.length >= maxNodesLimit) break;
            }
            // targetNode === null means `target_node_id` no longer resolves to a real node (the
            // node was deleted/renamed but the connections row survived). It still goes on the
            // queue/visited so a stale id is never re-processed, but — deliberately — no entry
            // is added to `nodes` for it. The edge pushed above therefore references an id that
            // will never appear in `nodes`; the dedup pass after the loop (see below) strips it.
            queue.push({ id: targetId, depth: current.depth + 1 });
          }
        }
      }

      if (nodes.length >= maxNodesLimit) break;

      // Inbound — what uses this node (callers). Skipped when tracing a call flow outward.
      if (direction !== 'out') {
        const inbound = usedByStmt.all(current.id) as { source_node_id: string }[];
        for (const row of inbound) {
          const sourceId = row.source_node_id;
          const connKey = `${sourceId}->${current.id}`;
          if (!connSet.has(connKey)) {
            connSet.add(connKey);
            connections.push({ source_node_id: sourceId, target_node_id: current.id });
          }
          if (!visited.has(sourceId)) {
            visited.add(sourceId);
            const sourceNode = this.getNode(sourceId);
            if (sourceNode) {
              (sourceNode as GraphNode).depth = current.depth + 1;
              nodes.push(sourceNode);
              if (nodes.length >= maxNodesLimit) break;
            }
            queue.push({ id: sourceId, depth: current.depth + 1 });
          }
        }
      }
    }

    // Two kinds of "more exists than was returned", reported honestly instead of silently:
    //  1. The node cap cut the walk short with the queue still non-empty.
    //  2. A connections row survives referencing a node this walk never added (deleted/renamed
    //     node, or — same shape — a node dropped for being past the cap on a LATER queue entry
    //     than the one whose edge pointed at it). Filtering here, once, after the walk, is
    //     simpler and more certainly correct than trying to prevent every path that could create
    //     one during the BFS itself.
    const nodesTruncated = nodes.length >= maxNodesLimit && queue.length > 0;
    const nodeIds = new Set(nodes.map(n => n.id));
    const cleanConnections = connections.filter(c => nodeIds.has(c.source_node_id) && nodeIds.has(c.target_node_id));
    const connectionsTruncated = cleanConnections.length < connections.length;

    const result: GraphResult = { nodes, connections: cleanConnections };
    if (nodesTruncated) result.nodes_truncated = true;
    if (connectionsTruncated) result.connections_truncated = true;

    if (opts.includeCode) {
      let spent = 0;
      let noCodeAvailable = 0;
      const omittedForBudget: string[] = [];
      // `nodes` is in BFS order (nearest the root first), so the budget is spent on the most
      // relevant code before anything is dropped.
      for (const [i, n] of nodes.entries()) {
        const live = this.extractLiveCode(n);
        const code = live ?? this.getLatestCode(n.id)?.code_snapshot ?? null;
        if (!code) {
          // Nothing to attach — a node whose symbol no longer resolves on disk and has no cached
          // snapshot. Counted SEPARATELY from a budget drop: these two used to share one
          // `nodes_without_code` counter, which meant a graph full of unresolvable nodes reported
          // `code_truncated: true` on a completely unspent budget. Raising the budget would then
          // do nothing, and the caller had no way to tell that from the response.
          noCodeAvailable++;
          continue;
        }
        // The root always gets its code — it is what was asked for, and dropping it would make
        // the response useless. Every other node must fit in the REMAINING budget, so a single
        // large node can't blow past the cap (it is skipped and counted, not truncated).
        if (i > 0 && spent + code.length > codeCharBudget) {
          // Recorded BY ID, not merely counted. An id is a valid argument to get_node_code, so a
          // caller who needs the rest can fetch exactly those nodes — where a bare count, or an
          // array index into a graph that gets re-derived on every call, tells them nothing they
          // can act on. Capped so a wide graph can't turn the omission list into its own payload.
          if (omittedForBudget.length < OMITTED_NODE_ID_CAP) omittedForBudget.push(n.id);
          continue;
        }
        n.code = code;
        n.code_source = live !== null ? 'live' : 'cached';
        spent += code.length;
      }
      result.code_chars = spent;
      if (noCodeAvailable > 0 || omittedForBudget.length > 0) {
        result.code_truncated = true;
        result.nodes_without_code = noCodeAvailable + omittedForBudget.length;
      }
      if (noCodeAvailable > 0) result.nodes_no_code_available = noCodeAvailable;
      if (omittedForBudget.length > 0) result.code_omitted_node_ids = omittedForBudget;
    }

    return result;
  }

  updateHistory(params: {
    node_id: string;
    code_snapshot: string;
    /**
     * The entity's text before this edit, when the caller knows it (`edit_node` does; it holds
     * the pre-edit file). `null` means the entity did not exist yet — a pure addition. `undefined`
     * means the caller has no before-state at all (the legacy `update_history` path, or an
     * initial index snapshot), and no edit is recorded to
     * the trail: an entry with nothing to compare against gets no diff and no revert.
     */
    code_before?: string | null;
    reasoning: string | ReasoningObject;
    session_id?: string;
  }): DbHistory {
    const { node_id, code_snapshot } = params;
    let reasoning = params.reasoning;
    // The calling AI has no reliable way to know who the human running this
    // machine actually is -- it can only guess ("Claude Code", "AI Assistant",
    // etc). Whenever this project has a configured developer identity (from
    // .env's DEVELOPER_NAME, set by `devsmind init`), that's authoritative and
    // always overrides whatever the agent supplied, so history is attributed
    // to the real developer regardless of what the agent wrote in this field.
    if (typeof reasoning === 'object' && this.context?.developer?.name) {
      reasoning = { ...reasoning, developer: this.context.developer.name };
    }
    const node = this.getNode(node_id);
    const resolvedId = node ? node.id : node_id;
    const formattedReasoning = formatReasoning(reasoning);
    const nowStr = new Date().toISOString();

    const newEdit: HistoryEdit | null = params.code_before === undefined
      ? null
      : { at: nowStr, before: params.code_before ?? '', after: code_snapshot, reasoning: formattedReasoning };

    // 1-hour session boundary rule check
    const latest = this.getLatestHistory(resolvedId);
    if (latest) {
      const lastUpdate = new Date(latest.updated_at).getTime();
      const nowTime = new Date(nowStr).getTime();
      const diffMs = nowTime - lastUpdate;

      // If updated < 1 hour ago, update the same record IN PLACE (no new row — this is what
      // keeps db/graph/history from bloating with one entry per commit during an active editing
      // session). code_snapshot is always the latest state (git already owns version history for
      // code). reasoning is APPENDED, not overwritten — an earlier commit's "why" in this same
      // session is still real and still worth keeping; losing it silently is worse than a few
      // extra lines in one file.
      if (diffMs < 3600000) {
        /* istanbul ignore next -- `latest` came from `getLatestHistory()` -> `populateHistoryFromDisk()`,
           which always returns a STRING `reasoning` (either the disk JSON's string field, or the
           result of `formatReasoning(...)`, itself always a string) — so the `: ''` fallback here
           can never actually run. Kept as a real guard against a future change to
           `populateHistoryFromDisk`'s return shape, not because today's flow can reach it. */
        const previousReasoning = typeof latest.reasoning === 'string' ? latest.reasoning : '';
        const mergedReasoning = previousReasoning.trim().length > 0
          ? `${previousReasoning}\n\n── Update @ ${nowStr} ──\n${formattedReasoning}`
          : formattedReasoning;

        const updateStmt = this.db.prepare(`
          UPDATE history
          SET code_snapshot = '', reasoning = ?, updated_at = ?
          WHERE id = ?
        `);
        updateStmt.run(mergedReasoning, nowStr, latest.id);

        // The edit trail APPENDS for the same reason reasoning does: this row now covers several
        // edits, and only a per-edit before/after lets a revert undo the last one rather than the
        // whole session's work — the window slides off updated_at, so one row can span hours.
        const mergedEdits = newEdit ? [...latest.edits, newEdit] : latest.edits;

        // Write/Update on disk
        this.writeHistoryToDisk(latest.id, resolvedId, latest.session_id, latest.created_at, nowStr, code_snapshot, mergedReasoning, mergedEdits);

        return {
          ...latest,
          code_snapshot,
          reasoning: mergedReasoning,
          edits: mergedEdits,
          updated_at: nowStr
        };
      }
    }

    // Otherwise (or if no record exists), insert new history block
    const newId = crypto.randomUUID();
    const sessionId = params.session_id || crypto.randomUUID();

    const insertStmt = this.db.prepare(`
      INSERT INTO history (id, node_id, session_id, created_at, updated_at, code_snapshot, reasoning)
      VALUES (?, ?, ?, ?, ?, '', ?)
    `);
    insertStmt.run(newId, resolvedId, sessionId, nowStr, nowStr, formattedReasoning);

    const newEdits = newEdit ? [newEdit] : [];

    // Write to disk
    this.writeHistoryToDisk(newId, resolvedId, sessionId, nowStr, nowStr, code_snapshot, formattedReasoning, newEdits);

    return {
      id: newId,
      node_id: resolvedId,
      session_id: sessionId,
      created_at: nowStr,
      updated_at: nowStr,
      code_snapshot,
      reasoning: formattedReasoning,
      edits: newEdits
    };
  }

  /**
   * Removes the newest recorded edit from a history entry, leaving no trace of it.
   *
   * There used to be a citation guard here: a history row cited by a workflow step was emptied
   * rather than deleted, so the step was not left pointing at nothing. Workflow steps record
   * `node_ids` now, not history ids, so nothing cites a history row any more and the guard had
   * nothing left to check. Keeping it would have meant keeping the `history_ids` column alive
   * purely to protect a reference nothing makes.
   *
   * Callers are expected to have restored the file already; this only unwinds what was written
   * about it.
   */
  eraseLastEdit(historyId: string): { erased: boolean; entry_deleted: boolean; reason?: string } {
    const entry = this.getHistoryEntry(historyId);
    if (!entry) return { erased: false, entry_deleted: false, reason: 'history entry not found' };
    if (!entry.edits.length) return { erased: false, entry_deleted: false, reason: 'entry has no recorded edits' };

    const remaining = entry.edits.slice(0, -1);
    const dropped = entry.edits[entry.edits.length - 1];

    if (!remaining.length) {
      // Nothing left to keep the row for — no workflow step references a history id any more.
      this.db.prepare('DELETE FROM history WHERE id = ?').run(historyId);
      try {
        const f = path.join(path.dirname(this.dbPath), 'history', `${historyId}.json`);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch { /* ignore */ }
      return { erased: true, entry_deleted: true };
    }

    const nowStr = new Date().toISOString();
    const newSnapshot = remaining[remaining.length - 1].after;
    const newReasoning = dropReasoningBlock(entry.reasoning, dropped.reasoning);

    this.db.prepare('UPDATE history SET reasoning = ?, updated_at = ? WHERE id = ?')
      .run(newReasoning, nowStr, historyId);
    this.writeHistoryToDisk(historyId, entry.node_id, entry.session_id, entry.created_at, nowStr, newSnapshot, newReasoning, remaining);

    return { erased: true, entry_deleted: false };
  }


  // --- Search Operations ---

  /**
   * The one search tool, covering both worlds in a single call:
   *  - a primary `nodes` bucket — the indexed graph, found by exact identifier, then by three
   *    fused rankers (BM25 over metadata, vector over descriptions, and code-body match), and
   *  - a last-resort `files` bucket — a real filesystem grep of the configured repos, so files
   *    the graph never models (CSS, JSON, config, markup, un-indexed code) are finally covered
   *    in the same call instead of sending the caller off to an external grep.
   *
   * Inputs play to each layer's strength: the natural-language `query` drives the semantic vector
   * layer (and BM25); `opts.keywords` (literal, OR) drive grep and the code-body match, and also
   * feed BM25. If no keywords are given they're derived from the query's significant tokens, so a
   * natural-only call still gets code + file coverage.
   *
   * Speed is the point — the two slow layers (vector, grep) run concurrently, and the old ~9k
   * per-node snapshot read (the tool's former ~10-30s cost) is gone: code-body matching now rides
   * the single grep walk. See `grep.ts` and Phase 4 of the plan.
   */
  /**
   * Attaches the drill-in hooks (`uses`/`used_by`/`history_count`/`last_updated`) to a batch of
   * search results in place, via ONE grouped query per hook instead of per-node fetches — see
   * {@link getConnectionCounts}/{@link getHistoryCounts}/{@link getLastUpdatedMap}. This is the
   * signal that turns a search result from a dead end into something worth drilling into with
   * `get_node_graph`/`get_node_history` — without it, nothing hints there's more to find.
   */
  private attachDrillInHooks<T extends RankedNode>(nodes: T[]): T[] {
    if (nodes.length === 0) return nodes;
    const ids = nodes.map(n => n.id);
    const connCounts = this.getConnectionCounts(ids);
    const historyCounts = this.getHistoryCounts(ids);
    const lastUpdated = this.getLastUpdatedMap(ids);
    for (const n of nodes) {
      /* istanbul ignore next -- `connCounts` is built from `getConnectionCounts(ids)` on this
         SAME `ids` array a few lines up, and that helper pre-seeds a {uses:0,usedBy:0} entry for
         every id it's given before querying — so `connCounts.get(n.id)` can never miss here.
         Kept as a real guard against a future refactor decoupling the two, not because today's
         flow can reach the fallback. */
      const conn = connCounts.get(n.id) ?? { uses: 0, usedBy: 0 };
      n.uses = conn.uses;
      n.used_by = conn.usedBy;
      n.history_count = historyCounts.get(n.id) ?? 0;
      const lu = lastUpdated.get(n.id);
      if (lu) n.last_updated = lu;
      // Say so instead of asserting "unused", or this hook actively misleads instead of helping.
      if (conn.usedBy === 0) {
        n.used_by_note = NO_STATIC_CALLERS_NOTE;
      }
    }
    return nodes;
  }

  async searchNodes(
    query: string | undefined,
    opts: { pattern?: string; path?: string; case_insensitive?: boolean; offset?: number; limit?: number; compact?: boolean } = {}
  ): Promise<SearchNodesResult> {
    const trimmedQuery = query?.trim();
    const hasQuery = !!trimmedQuery;
    const trimmedPattern = opts.pattern?.trim();
    const hasPattern = !!trimmedPattern;
    if (!hasQuery && !hasPattern) {
      throw new Error('searchNodes requires at least one of `query` or `pattern`.');
    }

    const caseInsensitive = opts.case_insensitive !== false;
    const scopePath = this.resolveSearchScopePath(opts.path);
    // Scoping `path` straight AT a lockfile or build artifact is honored, not overridden — the
    // same rule that has always applied to scoping at an ignored directory. What makes that
    // confusing is the SILENCE, not the exclusion: an empty result is indistinguishable from
    // "the pattern isn't in that file". Say so instead, so the agent stops rather than retrying
    // variations of a search that can never return anything.
    const scopeNote = scopePath && isDefaultIgnoredFile(scopePath)
      ? `path "${scopePath}" is a lockfile or generated artifact, excluded from search by default — no file content was scanned. Read the file directly if you genuinely need it.`
      : undefined;
    const filesOffset = opts.offset ?? 0;
    const filesLimit = opts.limit ?? 25;
    // `compact` is not just a projection flag — it SKIPS work. `annotateSampleLinesWithSymbol` is
    // the AST path (the same per-node span resolution that was 8.2s of a 9.6s query before its
    // file cap), and its only product is the `symbol` field ON the sample lines. A compact result
    // drops those lines entirely, so resolving them first would be pure waste. This is exactly
    // why compaction can't live wholly in the MCP handler: a projection applied after the fact
    // can trim the response, but it cannot un-spend the time that produced it.
    const compact = opts.compact === true;
    const grepOpts = { ignoredPaths: this.context?.config.ignored_paths, caseInsensitive, scopePath };

    // The pattern actually handed to the filesystem grep: the caller's own regex when given, else
    // a literal (escaped) OR of the query's own significant tokens — the same "derive from query"
    // fallback as before, just built from a real regex now instead of a keyword array. This is the
    // ONLY layer that ever runs — everything meaning-driven below is gated on `hasQuery`.
    const grepPattern = hasPattern
      ? trimmedPattern!
      : Array.from(new Set(tokenizeText(trimmedQuery!))).map(escapeRegExp).join('|');

    // BM25/vector/the identifier short-circuit are all driven by natural-language MEANING — a bare
    // regex has no meaning for them to tokenize or embed, so none of them run without a `query`.
    // Grep (and the code-match nodes it feeds via mapGrepHitsToNodes) is unconditional.
    const bm25Tokens = hasQuery ? Array.from(new Set(tokenizeText(trimmedQuery!))) : [];

    if (hasQuery) {
      // Deliberately name/id ONLY — NOT description/reasoning. Those are free-text natural-language
      // fields (a description is a whole sentence); matching the query as a raw substring against
      // them turns "any short natural-language query that happens to appear inside some node's
      // description" into a false "exact identifier hit," which then skipped vector search AND the
      // grep-derived code layer entirely (see the comment below) for what was never actually an
      // identifier lookup. description/reasoning are already covered properly — with real ranking,
      // not a blind substring guess — by BM25 (`tokenSearchNodes`/`search-index.ts`) on the path
      // below, so nothing is lost by dropping them here; queries that used to wrongly short-circuit
      // now correctly fall through to BM25 + vector + code instead.
      //
      // Gated on `hasQuery` for a second, sharper reason too: this LIKE builds `%<query>%`, and an
      // ABSENT query would make that `%%` — matching every node in the database. A regex-only
      // search on a small repo (≤10 nodes) would then wrongly "short-circuit" and hand back the
      // ENTIRE graph as high-confidence identifier hits. Never reachable when `query` is empty.
      const stmt = this.db.prepare(`
        SELECT DISTINCT n.* FROM nodes n
        WHERE n.name LIKE ? ESCAPE '\\' OR n.id LIKE ? ESCAPE '\\'
        LIMIT 50
      `);
      const wildcard = `%${this.likeEscape(trimmedQuery!)}%`;
      const identifierMatches = DevMindDatabase.parseNodeRows(stmt.all(wildcard, wildcard) as DbNode[]);

      // Exact-identifier short-circuit: a small, unambiguous set of literal name/id hits is trusted
      // outright and skips the rankers (semantic blur only hurts an exact symbol lookup). Grep
      // always runs here too (using `grepPattern`, the same derive-from-query-if-absent value the
      // main path below uses), so an agent that only ever sends `query` still gets a populated
      // `files` bucket instead of an empty one for no reason.
      if (identifierMatches.length > 0 && identifierMatches.length <= 10) {
        // An exact identifier hit is the most trustworthy result there is → high confidence, top
        // relevance, found by name.
        // Trust signals FIRST, before `description`. JSON.stringify preserves insertion order and
        // an agent reads a result top-down; with the plain `{...n, confidence}` spread these
        // landed after a full sentence of description, and real session feedback was that they got
        // skipped in favour of eyeballing node names. Ordering is the whole fix — the fields were
        // always there. Applied at BOTH construction sites (see the fused path below); doing only
        // one would leave the two paths disagreeing, and this identifier path is the more common
        // one for a symbol lookup.
        const nodes: RankedNode[] = identifierMatches.map(({ id, name, type, ...rest }) => ({
          id, name, type,
          confidence: 'high' as const, relevance: 100, found_by: ['name'] as SearchLayer[], matched_via: 'identifier' as const,
          ...rest,
          uses: 0, used_by: 0, history_count: 0
        }));
        this.attachDrillInHooks(nodes);
        const grep = await grepRepos(this.repoRoots(), grepPattern, grepOpts);
        const filesResult = rankGrepHits(grep.hits, { offset: filesOffset, maxFiles: filesLimit });
        if (!compact) this.annotateSampleLinesWithSymbol(filesResult.files);
        return {
          nodes,
          files: filesResult.files,
          files_total: filesResult.total,
          files_offset: filesOffset,
          nodes_total: nodes.length,
          truncated: grep.truncated || undefined,
          scope_note: scopeNote
        };
      }
    }

    // The two slow layers run CONCURRENTLY — vector inference and the filesystem grep walk. BM25
    // is synchronous indexed SQL, so it runs inline for free. Wall-clock ≈ max(vector, grep).
    //
    // Timed at every stage, opt-in via DEVSMIND_PERF_DEBUG — kept permanently (not stripped after
    // this pass) because it's how the mapGrepHitsToNodes bottleneck below was actually found: on a
    // real 8-repo query it was 8.2s of a 9.6s total, invisible from the outside since the tool
    // just looked uniformly slow. Zero cost when unset (`process.hrtime.bigint()` calls only;
    // the env check gates the one string-building/console.error).
    const perfDebug = !!process.env.DEVSMIND_PERF_DEBUG;
    const ms = (a: bigint, b: bigint) => (Number(b - a) / 1e6).toFixed(0);
    const perfStart = process.hrtime.bigint();
    const bm25Ranked = this.tokenSearchNodes(bm25Tokens);
    const perfAfterBm25 = process.hrtime.bigint();
    // Timed individually (not just the combined Promise.all) so a slow run can be attributed to
    // ONE of the two instead of leaving both under suspicion.
    let vectorMs = '?', grepMs = '?';
    const [vectorIds, grep] = await Promise.all([
      (hasQuery ? this.vectorSearchNodes(trimmedQuery!) : Promise.resolve([])).then(r => { if (perfDebug) vectorMs = hasQuery ? ms(perfAfterBm25, process.hrtime.bigint()) : 'skipped(no query)'; return r; }),
      grepRepos(this.repoRoots(), grepPattern, grepOpts).then(r => { if (perfDebug) grepMs = ms(perfAfterBm25, process.hrtime.bigint()); return r; })
    ]);
    const perfAfterVectorGrep = process.hrtime.bigint();

    // The single grep walk feeds BOTH buckets: raw hits → the files bucket, and hits landing in
    // indexed source files → code-match nodes (this is the "code search that returns nodes").
    const filesResult = rankGrepHits(grep.hits, { offset: filesOffset, maxFiles: filesLimit });
    const perfAfterRank = process.hrtime.bigint();
    const codeMatches = this.mapGrepHitsToNodes(grep.hits);
    const perfAfterCodeMatch = process.hrtime.bigint();
    const codeLinesById = new Map(codeMatches.map(c => [c.nodeId, c.lines]));
    // Bounded annotation (only the page actually returned — see the doc comment on the helper for
    // why this must NOT run over every raw hit). Timed and logged BEFORE the [perf] line below,
    // not after — it shares `locateNodeInFile`, the exact primitive mapGrepHitsToNodes' own doc
    // comment identifies as the historical bottleneck, so leaving it unmeasured would silently
    // exempt a real cost from the one line this file's instrumentation exists to catch it with.
    if (!compact) this.annotateSampleLinesWithSymbol(filesResult.files);
    const perfAfterAnnotate = process.hrtime.bigint();
    if (perfDebug) {
      console.error(`[perf] bm25=${ms(perfStart, perfAfterBm25)}ms vector=${vectorMs}ms grep=${grepMs}ms (combined=${ms(perfAfterBm25, perfAfterVectorGrep)}ms) rankGrepHits=${ms(perfAfterVectorGrep, perfAfterRank)}ms mapGrepHitsToNodes=${ms(perfAfterRank, perfAfterCodeMatch)}ms annotateSampleLinesWithSymbol=${ms(perfAfterCodeMatch, perfAfterAnnotate)}ms grepHits=${grep.hits.length} truncated=${grep.truncated}`);
    }

    if (bm25Ranked.length === 0 && vectorIds.length === 0 && codeMatches.length === 0) {
      // Neither the graph (metadata, meaning, code body) nor grep found anything meaningful.
      const base: SearchNodesResult = {
        nodes: [],
        files: filesResult.files,
        files_total: filesResult.total,
        files_offset: filesOffset,
        nodes_total: 0,
        truncated: grep.truncated || undefined,
        scope_note: scopeNote
      };
      if (filesResult.files.length === 0) {
        base.hint = 'No meaningful match anywhere — not in any node\'s name, description, reasoning, or code body, and no file on disk contains this pattern. If you expected this to exist, retry with a broader pattern or different query terms; if it genuinely isn\'t in this codebase, that\'s a real answer — don\'t keep re-querying variations.';
      }
      return base;
    }

    // Fuse the THREE node rankings by rank (RRF) — BM25 (metadata), vector (meaning), code-match
    // (body). Each is strong at something the others miss; rank-fusion needs no score calibration.
    // But the RAW RRF float is a terrible thing to hand back (a #1-ranked hit tops out near 0.03,
    // which reads like "3% confident"), so it drives ORDER only — every node is then re-described
    // with human-meaningful signals: which layers found it, a high/medium/low confidence, and a
    // 0-100 relevance relative to the top hit.
    const bm25ById = new Map(bm25Ranked.map(n => [n.id, n]));
    const simById = new Map(vectorIds.map(v => [v.id, v.sim]));
    const fused = reciprocalRankFusion([bm25Ranked.map(n => n.id), vectorIds.map(v => v.id), codeMatches.map(c => c.nodeId)]);
    /* istanbul ignore next -- unreachable here: reaching this line already required at least one
       of bm25Ranked/vectorIds/codeMatches to be non-empty (the `if (... .length === 0 && ...)`
       guard above returns early otherwise), and reciprocalRankFusion's output is the union of its
       input rankings — so `fused` is always non-empty by the time this runs. Kept as a real guard
       against a future change decoupling that invariant, not because today's flow can reach it. */
    const topScore = fused.length ? fused[0].score : 1;

    const nodes: RankedNode[] = [];
    for (const { id, score } of fused.slice(0, 20)) {
      const bm25Hit = bm25ById.get(id);
      const sim = simById.get(id);
      const codeLines = codeLinesById.get(id);

      // Reconstruct a clean DbNode — never spread bm25Hit wholesale, or its internal fields leak.
      const src = bm25Hit ?? this.getNode(id);
      /* istanbul ignore next -- `fused`'s ids are drawn only from tokenSearchNodes/vectorSearchNodes/
         mapGrepHitsToNodes, all three of which query `nodes` directly (deprecated = 0) at call time
         a few lines above; nothing mutates the DB between those queries and this synchronous loop,
         so `this.getNode(id)` (the fallback when `bm25Hit` is absent) always finds a row here today.
         Kept as a real guard against a future async gap or query decoupling, not because today's
         flow can reach it. */
      if (!src) continue; // orphaned vector row surviving between sweeps — skip, don't crash
      /* istanbul ignore next -- `src` is always either a `tokenSearchNodes` row or a
         `getNode()` result, both of which route through `parseNodeRow`/`parseNodeAliases` and
         so always carry a real `string[]` aliases — the `?? []` fallback is unreachable in
         practice, kept only as a type-level safety net. */
      const srcAliases = src.aliases ?? [];
      const node: DbNode = {
        id: src.id, type: src.type, name: src.name, file_path: src.file_path,
        signature: src.signature, description: src.description,
        aliases: srcAliases,
        deprecated: src.deprecated, created_at: src.created_at
      };

      const found_by: SearchLayer[] = [];
      if (bm25Hit) found_by.push('keyword');
      if (sim !== undefined) found_by.push('meaning');
      if (codeLines) found_by.push('code');

      // Confidence from real evidence, not the fused float. Corroboration across ≥2 independent
      // layers is the strongest signal there is → high. A lone semantic match is graded by its
      // actual cosine (0.6+ is genuinely close; 0.35-0.45 is borderline). A lone keyword or code
      // hit already cleared its own floor, so it's real-but-uncorroborated → medium.
      let confidence: Confidence;
      if (found_by.length >= 2) {
        confidence = 'high';
      } else if (found_by.length === 1 && found_by[0] === 'meaning' && sim !== undefined) {
        confidence = sim >= 0.6 ? 'high' : sim >= 0.45 ? 'medium' : 'low';
      } else {
        confidence = 'medium';
      }

      const matched_via = bm25Hit ? 'fuzzy' as const : (codeLines ? 'code' as const : 'semantic' as const);
      const relevance = Math.max(1, Math.round((score / topScore) * 100));
      // Trust signals ahead of `description` — see the identifier short-circuit above for why.
      const { id: nodeId, name: nodeName, type: nodeType, ...nodeRest } = node;
      nodes.push({
        id: nodeId, name: nodeName, type: nodeType,
        confidence,
        relevance,
        found_by,
        matched_via,
        ...nodeRest,
        matched_terms: bm25Hit ? bm25Hit.matched_terms : [],
        code_matches: codeLines,
        uses: 0, used_by: 0, history_count: 0
      });
    }
    this.attachDrillInHooks(nodes);
    return {
      nodes,
      files: filesResult.files,
      files_total: filesResult.total,
      files_offset: filesOffset,
      nodes_total: fused.length,
      truncated: grep.truncated || undefined,
      scope_note: scopeNote
    };
  }

  /**
   * The token-ranked (BM25) half of {@link searchNodes}. Looks up every query/keyword token in
   * the local `node_tokens` index (rebuilding it first if stale — see {@link ensureSearchIndexFresh}),
   * scores each candidate with {@link scoreCandidate} (IDF-weighted, saturating TF, per-field
   * weights favoring `description`), and applies the noise floor. Metadata only — identifier / id
   * / path / description / reasoning. Code-body matching is NO LONGER folded in here: it used to
   * read one history-JSON per node (~9k serial reads = the tool's ~10-30s cost), and is now
   * served far faster by the real filesystem grep in `searchNodes` (see `mapGrepHitsToNodes`).
   * Returns nodes tagged `matched_via:'fuzzy'`, ranked; `searchNodes` re-fuses them by RRF.
   */
  private tokenSearchNodes(
    tokens: string[]
  ): Array<DbNode & { matched_via: 'fuzzy'; matched_terms: string[]; score: number; low_confidence: true }> {
    const uniq = Array.from(new Set(tokens));
    if (uniq.length === 0) return [];
    this.ensureSearchIndexFresh();

    const totalNodesRow = this.db.prepare('SELECT COUNT(*) as c FROM nodes WHERE deprecated = 0').get() as { c: number };
    const totalNodes = Math.max(totalNodesRow.c, 1);

    const placeholders = uniq.map(() => '?').join(',');
    // Document frequency per (token, field) computed ONCE via a grouped aggregate, not as a
    // per-ROW correlated subquery — that used to re-scan node_tokens once for EVERY matching row
    // (thousands, for a common word across an 8k-node/468k-token real corpus), which alone
    // measured at 9-10 SECONDS on a real production graph. One aggregate query + an in-memory
    // lookup does the identical computation in a few milliseconds.
    const docFreqRows = this.db.prepare(`
      SELECT token, field, COUNT(DISTINCT node_id) AS doc_freq
      FROM node_tokens
      WHERE token IN (${placeholders})
      GROUP BY token, field
    `).all(...uniq) as { token: string; field: TokenField; doc_freq: number }[];
    const docFreqByKey = new Map<string, number>();
    for (const r of docFreqRows) docFreqByKey.set(`${r.token} ${r.field}`, r.doc_freq);

    const rows = this.db.prepare(`
      SELECT node_id, token, field, tf
      FROM node_tokens
      WHERE token IN (${placeholders})
    `).all(...uniq) as { node_id: string; token: string; field: TokenField; tf: number }[];

    const byNode = new Map<string, { matches: FieldMatch[]; terms: Set<string> }>();
    for (const row of rows) {
      const entry = byNode.get(row.node_id) || { matches: [], terms: new Set<string>() };
      /* istanbul ignore next -- `rows` and `docFreqRows` are both filtered from `node_tokens` by
         the exact same `WHERE token IN (...)`, and `docFreqRows` is a `GROUP BY token, field` over
         that identical row set — so every (token, field) pair appearing in `rows` necessarily has
         a matching aggregate entry already. The `?? 1` fallback is unreachable in practice, kept
         only as a defensive default if the two queries are ever edited out of lockstep. */
      const docFreq = docFreqByKey.get(`${row.token} ${row.field}`) ?? 1;
      entry.matches.push({ field: row.field, tf: row.tf, docFreq, totalNodes });
      entry.terms.add(row.token);
      byNode.set(row.node_id, entry);
    }
    if (byNode.size === 0) return [];

    // Reject the thinnest possible "match" instead of letting anything with one shared token
    // through: a query like "pending-orders/process-order" sharing only the generic word "order"
    // with an unrelated node is weak evidence, not a real hit. Two tunable gates:
    //  (1) coverage — a multi-token query must match more than a single one of its distinct tokens
    //      (a single-token query has nothing more to require, so this is a no-op for it);
    //  (2) a minimum absolute score, since even one match CAN be strong (a rare word in the
    //      description field) and shouldn't be discarded just for being one token.
    const minCoverage = Math.min(2, uniq.length);
    const MIN_BM25_SCORE = 0.75;

    const out: Array<DbNode & { matched_via: 'fuzzy'; matched_terms: string[]; score: number; low_confidence: true }> = [];
    const nodeIds = Array.from(byNode.keys());
    const nodePlaceholders = nodeIds.map(() => '?').join(',');
    const nodeRows = DevMindDatabase.parseNodeRows(this.db.prepare(`SELECT * FROM nodes WHERE id IN (${nodePlaceholders}) AND deprecated = 0`).all(...nodeIds) as DbNode[]);
    for (const node of nodeRows) {
      const entry = byNode.get(node.id)!;
      if (entry.terms.size < minCoverage) continue;
      const score = scoreCandidate(entry.matches, DEFAULT_FIELD_WEIGHTS);
      if (score < MIN_BM25_SCORE) continue;
      out.push({ ...node, matched_via: 'fuzzy', matched_terms: Array.from(entry.terms), score, low_confidence: true });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 20);
  }

  /** Absolute filesystem roots for every configured repo — the search space for `grepRepos`. */
  private repoRoots(): string[] {
    if (!this.context) return [];
    const roots: string[] = [];
    for (const repo of this.context.config.repos) {
      const root = resolveRepoPath(this.context, repo.name);
      if (root) roots.push(root);
    }
    return roots;
  }

  /**
   * Resolves and validates `search_nodes`' optional `path` scope — a single folder or file the
   * grep walk restricts to, instead of always walking every configured repo. A path outside every
   * repo root is REJECTED (thrown, not silently widened to "search everything") — a scope that
   * can't be honored should fail loudly, since silently ignoring it would search far more than
   * the caller asked for. `canonicalizePath` (already used throughout this file for path
   * comparisons) lowercases the Windows drive letter so `C:\...` and `c:\...` compare equal.
   */
  private resolveSearchScopePath(rawPath: string | undefined): string | undefined {
    if (!rawPath || !rawPath.trim()) return undefined;
    const resolved = canonicalizePath(rawPath.trim());
    const roots = this.repoRoots().map(canonicalizePath);
    const contained = roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
    if (!contained) {
      throw new Error(`search_nodes: path "${rawPath}" is outside every configured repo (${roots.join(', ') || 'none configured'}).`);
    }
    return resolved;
  }

  /**
   * Maps raw grep hits back to graph nodes — this is "code search that returns nodes", rebuilt
   * on top of the single filesystem walk instead of the old ~9k per-node snapshot reads. For each
   * file that had hits AND contains indexed nodes: an AST-parseable file is resolved precisely
   * (each hit line → the one node whose line-range contains it, via {@link locateNodeInFile}), so
   * a keyword hitting one method in a 10-method file surfaces THAT node, not all ten. A non-AST
   * indexed file (a staged `.py`/`.go` node) falls back to coarse file→node. Returns node ids in
   * match-strength order (files with more hits first) plus the matching lines, for RRF + display.
   *
   * Only the top {@link CODE_MATCH_FILE_CAP} files by hit count are AST-resolved — measured on a
   * real 8-repo, 15k-grep-hit query, this step alone was 8.2s of a 9.6s total before the cap, one
   * `locateNodeInFile` AST walk per node per matched file with no bound on how many files that
   * could be. It doesn't cost result quality: the fused ranking downstream keeps only the top ~20
   * nodes anyway, and files with more hits are exactly the ones most likely to place there — files
   * past the cap would almost never have survived to the final result even fully resolved.
   */
  private mapGrepHitsToNodes(hits: GrepHit[]): { nodeId: string; lines: { line_number: number; line_content: string }[] }[] {
    if (hits.length === 0) return [];
    // Group hit line numbers (+ content) by file, and rank files by hit count so the strongest
    // code matches come first in the returned order (which becomes their RRF rank).
    const byFile = new Map<string, { line_number: number; line_content: string }[]>();
    for (const h of hits) {
      let arr = byFile.get(h.file_path);
      if (!arr) { arr = []; byFile.set(h.file_path, arr); }
      arr.push({ line_number: h.line_number, line_content: h.line_content });
    }
    const CODE_MATCH_FILE_CAP = 30;
    const filesByStrength = Array.from(byFile.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, CODE_MATCH_FILE_CAP);

    const perNode = new Map<string, { line_number: number; line_content: string }[]>();
    for (const [filePath, lines] of filesByStrength) {
      const nodes = this.getNodesByFilePath(filePath);
      if (nodes.length === 0) continue; // an un-indexed file — lives in the files bucket only

      if (isAstParseable(filePath)) {
        // Precise: resolve each node's line span once, assign every hit line to its container.
        const spans = this.computeSymbolSpans(filePath, nodes);

        for (const line of lines) {
          const containing = spans.find(s => line.line_number >= s.startLine && line.line_number <= s.endLine);
          if (!containing) continue; // hit was between symbols (an import, a top-level const) — file bucket has it
          let acc = perNode.get(containing.id);
          if (!acc) { acc = []; perNode.set(containing.id, acc); }
          if (acc.length < 5) acc.push(line);
        }
      } else {
        // Coarse fallback for indexed but non-AST files (staged .py/.go/etc): every node in the file.
        for (const n of nodes) {
          if (!perNode.has(n.id)) perNode.set(n.id, lines.slice(0, 5));
        }
      }
    }

    // perNode preserves insertion order = file-strength order, which is the ranking we want.
    return Array.from(perNode.entries()).map(([nodeId, lines]) => ({ nodeId, lines }));
  }

  /**
   * Resolves every indexed node's line span within one AST-parseable file — extracted out of
   * `mapGrepHitsToNodes` so `annotateSampleLinesWithSymbol` can reuse the identical span logic
   * instead of re-deriving it. Computed ONCE per file (not per line/hit): a file with several
   * sample lines would otherwise repeat the same `locateNodeInFile` AST walk once per line.
   * `nodes` is accepted rather than re-fetched so an existing `getNodesByFilePath` result (as
   * `mapGrepHitsToNodes` already has) isn't queried twice.
   */
  private computeSymbolSpans(filePath: string, nodes: DbNode[]): { id: string; name: string; startLine: number; endLine: number }[] {
    return nodes.map(n => {
      const parsed = parseNodeId(n.id);
      const symbol = parsed ? parsed.symbolName : (n.id.split('#').pop() || n.name);
      const loc = symbol ? locateNodeInFile(filePath, symbol) : null;
      return loc ? { id: n.id, name: n.name, startLine: loc.startLine, endLine: loc.endLine } : null;
    }).filter((s): s is { id: string; name: string; startLine: number; endLine: number } => s !== null);
  }

  /**
   * Mutates each `RankedFile`'s `sample_lines` in place, tagging every line with the function/class
   * that contains it — the insight a plain filesystem grep can never give: not just "line 87
   * matched" but "line 87, inside `onLikeTap`". This is the annotation `search_nodes` offers that
   * makes it worth more than grep for a hit that lands inside real source.
   *
   * Deliberately bounded to the ALREADY-CAPPED page (`files`, ≤`maxFiles` entries × ≤5 sample
   * lines each — at most ~125 lookups) rather than every raw grep hit. `mapGrepHitsToNodes` is
   * measured at 8.2s of a 9.6s query on a real 8-repo search (see its doc comment) precisely from
   * unbounded per-hit AST resolution; annotating only what's actually returned keeps this at a
   * small, constant added cost regardless of how broad the pattern was or how many total hits it
   * produced. Silently no-ops for a file that isn't indexed or isn't AST-parseable — a `symbol` on
   * a sample line is a bonus, never a requirement.
   */
  private annotateSampleLinesWithSymbol(files: RankedFile[]): void {
    for (const file of files) {
      if (!isAstParseable(file.file_path)) continue;
      const nodes = this.getNodesByFilePath(file.file_path);
      if (nodes.length === 0) continue;
      const spans = this.computeSymbolSpans(file.file_path, nodes);
      if (spans.length === 0) continue;
      for (const line of file.sample_lines) {
        const containing = spans.find(s => line.line_number >= s.startLine && line.line_number <= s.endLine);
        if (containing) line.symbol = containing.name;
      }
    }
  }

  /**
   * The semantic half of hybrid search: embeds the query with the same vendored ONNX model used
   * to embed every node's description (see embedder.ts), then linear-scans `node_vectors` for
   * cosine similarity. Linear is fine at this scale — ~9k nodes × 384 int8 dims is a few million
   * integer multiplications, well under a millisecond, far below the model's own inference time
   * for the query itself; revisit only past ~100k nodes. Returns each surviving node's raw cosine
   * alongside its id — the ORDER drives RRF, but the cosine value is kept so `searchNodes` can turn
   * it into a human-meaningful confidence (a 0.7 cosine is a strong match; a 0.36 is a weak one —
   * the fused RRF float can't express that). Returns [] — never throws — if the embedder is
   * unavailable, so `searchNodes` degrades to BM25+grep exactly as before.
   */
  private async vectorSearchNodes(query: string): Promise<{ id: string; sim: number }[]> {
    const queryVector = await embedTextInt8(query);
    if (!queryVector) return [];

    const rows = this.db.prepare(`
      SELECT nv.node_id AS node_id, nv.vector AS vector
      FROM node_vectors nv
      JOIN nodes n ON n.id = nv.node_id
      WHERE n.deprecated = 0 AND nv.model_id = ?
    `).all(EMBEDDING_MODEL_ID) as { node_id: string; vector: Buffer }[];
    if (rows.length === 0) return [];

    const scored = rows.map(r => ({
      id: r.node_id,
      sim: cosineInt8(queryVector, new Int8Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength))
    }));
    scored.sort((a, b) => b.sim - a.sim);
    // A floor, not just a top-N cut: padding the ranking with genuinely unrelated nodes just to
    // fill a quota would inject noise into the RRF fusion. A low cosine here means "nothing is
    // semantically close" — that's a real signal that vector search found nothing, not a reason
    // to return its least-bad guesses. 0.35, not 0.2: MiniLM-class sentence embeddings commonly
    // put two UNRELATED short texts around 0.1-0.25 just from shared sentence structure/English
    // baseline, not real similarity — 0.2 was letting that noise floor through as if it meant
    // something. Tunable; revisit against real query/result pairs if this starts rejecting
    // matches that should have passed.
    const MIN_COSINE_SIMILARITY = 0.35;
    return scored.filter(s => s.sim > MIN_COSINE_SIMILARITY).slice(0, 50);
  }

  /**
   * Cheap, single-pass signal for "has the graph changed since node_tokens was last built":
   * how many non-deprecated nodes exist, the total length of every description (catches a
   * description being added OR edited — length almost never stays identical), and how many
   * history rows exist (catches new reasoning). Deliberately NOT based on an `updated_at`
   * column on `nodes` — there isn't one, and `syncFromDisk`'s destructive graph-rebuild pass
   * writes nodes via raw SQL, not through a single method that could easily be hooked, so a
   * write-path-by-write-path invalidation scheme would silently miss that path (and did, in an
   * earlier draft of this). A fingerprint checked lazily at query time can't be missed the same
   * way — it doesn't matter HOW the data changed, only THAT it did.
   */
  private searchIndexFingerprint(): string {
    const row = this.db.prepare(`
      SELECT COUNT(*) as node_count, COALESCE(SUM(LENGTH(description)), 0) as desc_len_sum
      FROM nodes WHERE deprecated = 0
    `).get() as { node_count: number; desc_len_sum: number };
    const historyRow = this.db.prepare('SELECT COUNT(*) as c FROM history').get() as { c: number };
    return `${row.node_count}:${row.desc_len_sum}:${historyRow.c}`;
  }

  /** Rebuilds `node_tokens` from scratch for every non-deprecated node's current
   * identifier/id/path/description and EVERY revision's reasoning (not just the latest — a
   * decision recorded three revisions ago must stay findable by `search_nodes`, since there is
   * no separate decisions-only search tool anymore; `GROUP_CONCAT` folds every history row's
   * reasoning into one field before tokenizing, so an older "Decision: …" is searchable exactly
   * like the newest one). Cheap at realistic node counts (hundreds to low-thousands) — a single
   * scan plus one batched transaction, not something that needs to be avoided; simplicity here
   * is worth more than incremental upkeep that a bypassed write path could silently defeat. */
  private rebuildSearchIndex(): void {
    const nodes = this.db.prepare(`
      SELECT n.*, (
        SELECT GROUP_CONCAT(h.reasoning, ' ') FROM history h WHERE h.node_id = n.id
      ) AS all_reasoning
      FROM nodes n
      WHERE n.deprecated = 0
    `).all() as (DbNode & { all_reasoning: string | null })[];

    const del = this.db.prepare('DELETE FROM node_tokens');
    const ins = this.db.prepare('INSERT OR REPLACE INTO node_tokens (node_id, token, field, tf) VALUES (?, ?, ?, ?)');

    const tx = this.db.transaction(() => {
      del.run();
      for (const node of nodes) {
        const rows = [
          ...tokenizeNodeField(node.name, 'identifier'),
          ...tokenizeNodeField(node.id, 'identifier'),
          ...tokenizeNodeField(node.file_path, 'path'),
          ...tokenizeNodeField(node.description, 'description'),
          ...tokenizeNodeField(node.all_reasoning, 'reasoning')
        ];
        // Merge duplicate (field,token) pairs from the multiple sources above (e.g. name and id
        // both contributing the same word) into one summed tf, rather than letting the LATER
        // INSERT OR REPLACE silently discard the earlier one's count.
        const merged = new Map<string, { token: string; field: TokenField; tf: number }>();
        for (const r of rows) {
          const key = `${r.field}:${r.token}`;
          const existing = merged.get(key);
          if (existing) existing.tf += r.tf; else merged.set(key, { ...r });
        }
        for (const r of merged.values()) ins.run(node.id, r.token, r.field, r.tf);
      }
    });
    tx();
  }

  /** Compares the current fingerprint against what `node_tokens` was last built from, stored in
   * `system_meta`; rebuilds and updates the stored fingerprint only on a mismatch. A momentarily
   * stale index (between a real change and the next search call) only costs ranking quality on
   * that one call, never correctness — the next call rebuilds it. */
  private ensureSearchIndexFresh(): void {
    const current = this.searchIndexFingerprint();
    const row = this.db.prepare(`SELECT value FROM system_meta WHERE key = 'search_index_fingerprint'`).get() as { value: string } | undefined;
    if (row && row.value === current) return;
    this.rebuildSearchIndex();
    this.db.prepare(`INSERT OR REPLACE INTO system_meta (key, value, updated_at) VALUES ('search_index_fingerprint', ?, CURRENT_TIMESTAMP)`).run(current);
  }

  searchDecisions(query: string): { node_id: string; node_name: string; updated_at: string; reasoning: string }[] {
    const stmt = this.db.prepare(`
      SELECT h.node_id, n.name as node_name, h.updated_at, h.reasoning
      FROM history h
      JOIN nodes n ON h.node_id = n.id
      WHERE h.reasoning LIKE ? ESCAPE '\\'
      ORDER BY h.updated_at DESC
    `);
    const wildcard = `%Decision: %${this.likeEscape(query)}%`;
    return stmt.all(wildcard) as { node_id: string; node_name: string; updated_at: string; reasoning: string }[];
  }

  searchCode(params: {
    query: string;
    is_regex?: boolean;
    case_insensitive?: boolean;
  }): {
    node_id: string;
    node_name: string;
    file_path: string;
    matches: { line_number: number; line_content: string }[];
    match_count: number;
    total_lines: number;
    match_ratio: number;
  }[] {
    const { query, is_regex = false, case_insensitive = true } = params;
    const historyDir = path.join(path.dirname(this.dbPath), 'history');
    
    const stmt = this.db.prepare(`
      SELECT h.id, n.id AS node_id, n.name AS node_name, n.file_path
      FROM nodes n
      JOIN history h ON h.node_id = n.id
      WHERE n.deprecated = 0
        AND h.id = (
          SELECT id FROM history
          WHERE node_id = n.id
          ORDER BY updated_at DESC
          LIMIT 1
        )
    `);
    const rows = stmt.all() as { id: string; node_id: string; node_name: string; file_path: string }[];

    let matcher: RegExp;
    if (is_regex) {
      try {
        matcher = new RegExp(query, case_insensitive ? 'i' : '');
      } catch (err) {
        throw new Error(`Invalid regex pattern: ${(err as Error).message}`);
      }
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matcher = new RegExp(escaped, case_insensitive ? 'i' : '');
    }

    const results: any[] = [];

    for (const row of rows) {
      const filePath = path.join(historyDir, `${row.id}.json`);
      if (!fs.existsSync(filePath)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const code = data.code_snapshot || '';
        if (!code) continue;

        const lines = code.split('\n');
        const nodeMatches: { line_number: number; line_content: string }[] = [];

        lines.forEach((line: string, idx: number) => {
          if (matcher.test(line)) {
            nodeMatches.push({
              line_number: idx + 1,
              line_content: line
            });
          }
        });

        if (nodeMatches.length > 0) {
          results.push({
            node_id: row.node_id,
            node_name: row.node_name,
            file_path: row.file_path,
            matches: nodeMatches,
            match_count: nodeMatches.length,
            total_lines: lines.length,
            match_ratio: parseFloat((nodeMatches.length / lines.length).toFixed(4))
          });
        }
      } catch {
        // Skip corrupted or unreadable history files
      }
    }

    return results.sort((a, b) => b.match_count - a.match_count);
  }

  getOrphanedNodes(): DbNode[] {
    const stmt = this.db.prepare(`
      SELECT * FROM nodes
      WHERE deprecated = 0
        AND id NOT IN (SELECT DISTINCT source_node_id FROM node_connections)
        AND id NOT IN (SELECT DISTINCT target_node_id FROM node_connections)
    `);
    return DevMindDatabase.parseNodeRows(stmt.all() as DbNode[]);
  }

  getAllNodes(): DbNode[] {
    const stmt = this.db.prepare('SELECT * FROM nodes');
    return DevMindDatabase.parseNodeRows(stmt.all() as DbNode[]);
  }

  /**
   * The shared WHERE clause behind {@link listNodes} and {@link countNodes}. Extracted so the page
   * and its total can never drift apart — a `total` computed from even slightly different criteria
   * than the rows it describes is worse than no total at all, since it reads as authoritative.
   */
  private buildNodeFilterSql(filter?: { type?: string; file_path?: string; include_deprecated?: boolean }): { where: string; params: any[] } {
    let sql = ' WHERE 1=1';
    const params: any[] = [];

    if (filter?.type) {
      sql += ' AND type = ?';
      params.push(filter.type);
    }

    if (filter?.file_path) {
      // file_path is stored with OS-native separators (backslashes on Windows), but the tool's
      // own schema example is forward-slash ("src/components") — a raw LIKE against the
      // unmodified column means that exact example returns nothing on Windows unless the
      // caller happens to pass backslashes instead. Normalize both sides to forward slashes
      // (getNodesByFilePath a few hundred lines up already does the equivalent for exact
      // matches; this just extends the same fix to the substring-filter path) and escape LIKE
      // metacharacters so a literal '%' or '_' in a path segment can't be misread as a wildcard.
      sql += " AND REPLACE(file_path, '\\', '/') LIKE ? ESCAPE '\\'";
      params.push(`%${this.likeEscape(filter.file_path.replace(/\\/g, '/'))}%`);
    }

    if (!filter?.include_deprecated) {
      sql += ' AND deprecated = 0';
    }

    return { where: sql, params };
  }

  /**
   * Total nodes matching a filter, independent of any page. Exists so `list_nodes` can tell
   * "that's everything" from "there is more" — the same honesty contract `nodes_total` and
   * `files_total` already keep for search.
   */
  countNodes(filter?: { type?: string; file_path?: string; include_deprecated?: boolean }): number {
    const { where, params } = this.buildNodeFilterSql(filter);
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM nodes${where}`).get(...params) as { c: number };
    return row.c;
  }

  /**
   * `limit`/`offset` are OPTIONAL and, when omitted, this returns every matching row exactly as
   * before — the internal analysis callers (`analyze.ts`, `edges.ts`) legitimately need the whole
   * graph, so paging is opt-in rather than a default that would silently truncate them. Ordering
   * is applied only when paging, since an unordered LIMIT is a lottery: without it, "page 2" is
   * not guaranteed to exclude what "page 1" already returned.
   */
  listNodes(filter?: { type?: string; file_path?: string; include_deprecated?: boolean; limit?: number; offset?: number }): DbNode[] {
    const { where, params } = this.buildNodeFilterSql(filter);
    let sql = `SELECT * FROM nodes${where}`;
    const args = [...params];

    if (filter?.limit !== undefined) {
      sql += ' ORDER BY file_path, name LIMIT ? OFFSET ?';
      args.push(filter.limit, filter.offset ?? 0);
    }

    return DevMindDatabase.parseNodeRows(this.db.prepare(sql).all(...args) as DbNode[]);
  }

  getAllConnections(): DbConnection[] {
    const stmt = this.db.prepare('SELECT * FROM node_connections');
    return stmt.all() as DbConnection[];
  }

  getAllHistory(): DbHistory[] {
    const stmt = this.db.prepare('SELECT * FROM history ORDER BY updated_at DESC');
    const rows = stmt.all() as any[];
    return rows.map(row => this.populateHistoryFromDisk(row));
  }

  // ─── `devsmind analyze` read-only health checks ────────────────────────────
  // All pure queries/graph traversal, no mutation, no LLM calls.

  /** Nodes whose total (in + out) connection degree meets/exceeds `threshold` — architectural bottleneck candidates. */
  getGodEntities(threshold = 15): { id: string; name: string; file_path: string; degree: number }[] {
    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT n.id, n.name, n.file_path, (
          (SELECT COUNT(*) FROM node_connections c WHERE c.source_node_id = n.id) +
          (SELECT COUNT(*) FROM node_connections c WHERE c.target_node_id = n.id)
        ) AS degree
        FROM nodes n
        WHERE n.deprecated = 0
      )
      WHERE degree >= ?
      ORDER BY degree DESC
    `);
    return stmt.all(threshold) as { id: string; name: string; file_path: string; degree: number }[];
  }

  /** DFS cycle detection over the connection graph, capped at `maxCycles` reported paths. */
  getCircularDependencies(maxCycles = 50): string[][] {
    const edges = this.getAllConnections();
    const adjacency = new Map<string, string[]>();
    for (const e of edges) {
      if (!adjacency.has(e.source_node_id)) adjacency.set(e.source_node_id, []);
      adjacency.get(e.source_node_id)!.push(e.target_node_id);
    }

    const cycles: string[][] = [];
    const visited = new Set<string>();
    const stack: string[] = [];
    const onStack = new Set<string>();

    const dfs = (node: string) => {
      /* istanbul ignore if -- both of dfs's call sites (the outer `for` loop below, and the
         `for (const next of ...)` loop a few lines down) already check `cycles.length >=
         maxCycles` immediately before every single call to `dfs(...)`, so this repeats a guard
         that has always already passed by the time control reaches here. Kept as a real guard
         against a future call site that skips that pre-check, not because today's two call
         sites can reach it. */
      if (cycles.length >= maxCycles) return;
      if (onStack.has(node)) {
        const start = stack.indexOf(node);
        cycles.push([...stack.slice(start), node]);
        return;
      }
      if (visited.has(node)) return;
      visited.add(node);
      stack.push(node);
      onStack.add(node);
      for (const next of adjacency.get(node) || []) {
        if (cycles.length >= maxCycles) break;
        dfs(next);
      }
      stack.pop();
      onStack.delete(node);
    };

    for (const node of adjacency.keys()) {
      if (cycles.length >= maxCycles) break;
      if (!visited.has(node)) dfs(node);
    }
    return cycles;
  }

  /** node_connections rows whose source or target no longer exists in `nodes` (broken by a non-transactional delete, or a sync race). */
  getDanglingEdges(): DbConnection[] {
    const stmt = this.db.prepare(`
      SELECT * FROM node_connections
      WHERE source_node_id NOT IN (SELECT id FROM nodes)
         OR target_node_id NOT IN (SELECT id FROM nodes)
    `);
    return stmt.all() as DbConnection[];
  }

  /** Deletes a single dangling `node_connections` row. The edge itself is invalid data — no history/graph JSON to rewrite. */
  deleteDanglingEdge(sourceId: string, targetId: string) {
    this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ? AND target_node_id = ?').run(sourceId, targetId);
  }

  /** Node ids that differ only by case — a real collision risk on Windows's case-insensitive filesystem. */
  getDuplicateNodeIds(): { lowerId: string; ids: string[] }[] {
    const stmt = this.db.prepare(`
      SELECT LOWER(id) AS lower_id, GROUP_CONCAT(id, '|') AS ids
      FROM nodes
      WHERE deprecated = 0
      GROUP BY lower_id
      HAVING COUNT(*) > 1
    `);
    const rows = stmt.all() as { lower_id: string; ids: string }[];
    return rows.map(r => ({ lowerId: r.lower_id, ids: r.ids.split('|') }));
  }

  /** History rows whose flattened `reasoning` text has no non-empty `Developer:` line — can't be attributed to anyone. */
  getHistoryMissingDeveloper(): { id: string; node_id: string; updated_at: string }[] {
    const stmt = this.db.prepare('SELECT id, node_id, updated_at, reasoning FROM history');
    const rows = stmt.all() as { id: string; node_id: string; updated_at: string; reasoning: string }[];
    return rows
      .filter(r => {
        // [ \t]* (not \s*) so the match can't swallow the newline and bleed into the
        // next "Model:" line when Developer is blank, which would wrongly capture
        // "Model: <value>" as if it were the developer's name.
        const match = /Developer:[ \t]*([^\n]*)/i.exec(r.reasoning || '');
        return !match || !match[1].trim();
      })
      .map(({ id, node_id, updated_at }) => ({ id, node_id, updated_at }));
  }

  /**
   * History rows with a blank code snapshot — usually a silent AST extraction failure.
   * The `history.code_snapshot` DB column is always written as `''` (the real content
   * lives only in the per-row JSON on disk, see `populateHistoryFromDisk`), so this
   * must read through the populated rows rather than querying the column directly.
   */
  getEmptyCodeSnapshots(): { id: string; node_id: string; updated_at: string }[] {
    return this.getAllHistory()
      .filter(h => !h.code_snapshot || h.code_snapshot.trim() === '')
      .map(({ id, node_id, updated_at }) => ({ id, node_id, updated_at }));
  }

  // ─── Workflow Context Vault ─────────────────────────────────────────────
  // Persistent, cross-session feature memory. Steps link to existing `history`
  // rows rather than duplicating code/reasoning; artifacts are plain files on
  // disk under `.devmind/workflows/<id>/`, with only the path stored in the DB.

  private workflowsDir(): string {
    return path.join(path.dirname(this.dbPath), 'workflows');
  }

  /**
   * One-time backfill of `node_ids`/`reasoning` for steps written before v2, resolving each old
   * `history_ids` entry to the node it belongs to. Runs at open, right after the ALTERs, and is
   * self-limiting: it only touches rows where `node_ids IS NULL AND history_ids IS NOT NULL`, so
   * the second open finds nothing and the query costs one indexed scan.
   *
   * Best-effort by nature. Because of the 1-hour history merge, an old step's `history_ids` can
   * include rows an ADJACENT commit created, so a backfilled node list can be broader than what
   * that step actually touched. That is acceptable for pre-v2 rows — they were already imprecise,
   * which is exactly why the format changed — but it is why nothing presents backfilled data as
   * exact. A step whose history rows have since been pruned keeps its `summary` and gets an empty
   * list rather than being skipped, so it still appears on the timeline.
   */
  private backfillWorkflowStepNodeIds(): void {
    try {
      const stale = this.db
        .prepare(`SELECT id, history_ids FROM workflow_steps WHERE node_ids IS NULL AND history_ids IS NOT NULL`)
        .all() as { id: string; history_ids: string }[];
      if (stale.length === 0) return;

      const lookup = this.db.prepare('SELECT node_id, reasoning FROM history WHERE id = ?');
      const update = this.db.prepare('UPDATE workflow_steps SET node_ids = ?, reasoning = COALESCE(reasoning, ?) WHERE id = ?');
      const run = this.db.transaction((rows: { id: string; history_ids: string }[]) => {
        for (const row of rows) {
          let ids: unknown;
          try {
            ids = JSON.parse(row.history_ids);
          } catch {
            ids = [];
          }
          const nodeIds: string[] = [];
          let reasoning: string | null = null;
          if (Array.isArray(ids)) {
            for (const historyId of ids) {
              const hit = lookup.get(String(historyId)) as { node_id: string; reasoning: string } | undefined;
              if (!hit) continue;
              if (!nodeIds.includes(hit.node_id)) nodeIds.push(hit.node_id);
              if (reasoning === null && hit.reasoning) reasoning = hit.reasoning;
            }
          }
          update.run(JSON.stringify(nodeIds), reasoning, row.id);
        }
      });
      run(stale);
    } catch {
      // A brain mid-migration (or a workflow_steps table that predates history_ids entirely)
      // must not block opening the DB — the steps simply stay on their old shape.
    }
  }

  /**
   * Serializes the workflow + its steps + artifact index to disk so teammates can sync it via git.
   *
   * Written as TWO files, and the split is the whole point:
   *
   * - `workflow.json` keeps the shape a v1 client understands, so an older build reading it loses
   *   nothing it ever had.
   * - `v2.json` holds everything v1 has no field for (`archived`, and per-step `reasoning` /
   *   `node_ids` / `doc_paths`).
   *
   * A single file could not be made safe. `devsmind sync` calls `syncToDisk`, which re-serializes
   * every workflow.json from whatever columns the local build knows about — so a teammate who
   * pulls on an older version and syncs would rewrite every workflow and silently strip the new
   * fields, then commit that loss for everyone. An older build has no idea `v2.json` exists, so it
   * cannot rewrite it; the data survives the round trip and is merged back on the next read.
   */
  private writeWorkflowToDisk(workflowId: string): void {
    try {
      const workflow = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as DbWorkflow | undefined;
      if (!workflow) return;
      const steps = this.db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_index ASC').all(workflowId) as DbWorkflowStep[];
      const artifacts = this.db.prepare('SELECT * FROM workflow_artifacts WHERE workflow_id = ? ORDER BY created_at ASC').all(workflowId) as DbWorkflowArtifact[];
      const data = {
        schema_version: WORKFLOW_SCHEMA_VERSION,
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        archived: workflow.archived ? 1 : 0,
        created_at: workflow.created_at,
        updated_at: workflow.updated_at,
        steps: steps.map(s => ({
          id: s.id,
          step_index: s.step_index,
          summary: s.summary,
          reasoning: s.reasoning,
          node_ids: s.node_ids,
          doc_paths: s.doc_paths,
          session_id: s.session_id,
          created_at: s.created_at
        })),
        artifact_index: artifacts.map(a => ({
          id: a.id,
          step_id: a.step_id,
          type: a.type,
          source_name: a.source_name,
          file_path: a.file_path,
          created_at: a.created_at
        }))
      };
      const dir = path.join(this.workflowsDir(), workflowId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify(data, null, 2), 'utf-8');

      // The v1-invisible half. Keyed by step id rather than positional, so it still merges
      // correctly onto a workflow.json an older build reordered or rewrote.
      const sidecar = {
        schema_version: WORKFLOW_SCHEMA_VERSION,
        archived: workflow.archived ? 1 : 0,
        steps: Object.fromEntries(
          steps
            .filter(s => s.reasoning || s.node_ids || s.doc_paths)
            .map(s => [s.id, { reasoning: s.reasoning, node_ids: s.node_ids, doc_paths: s.doc_paths }])
        )
      };
      fs.writeFileSync(path.join(dir, WORKFLOW_SIDECAR_FILE), JSON.stringify(sidecar, null, 2), 'utf-8');
    } catch (err) {
      console.warn('⚠️ DevsMind: Failed to write workflow JSON to disk:', err);
    }
  }

  /**
   * Creates a workflow. Note what it deliberately does NOT do any more: set a global "active"
   * pointer. Which workflow you are working on is a property of YOUR session, held locally — a
   * workflow is a shared record, and one shared pointer meant two sessions (or two teammates,
   * since the pointer synced through git) silently stole it from each other mid-work.
   */
  createWorkflow(name: string, description: string): DbWorkflow {
    const id = `wf_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workflows (id, name, description, archived, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(id, name, description, now, now);
    this.writeWorkflowToDisk(id);
    return { id, name, description, archived: 0, created_at: now, updated_at: now };
  }

  getWorkflow(id: string): DbWorkflow | null {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as DbWorkflow | undefined;
    return row || null;
  }

  /**
   * Workflows newest-touched first — which is the ordering that replaces the old `status` field.
   * Live work floats up and abandoned threads sink on their own, so nothing has to be marked
   * "completed" by hand (nobody ever did, and a lifecycle field nobody maintains just lies).
   *
   * `query` matches name AND description, the search `searchWorkflows` never actually did: it
   * scanned step summaries and artifact names only, so looking a workflow up by its own name
   * returned nothing. Paging mirrors `listNodes` — `total` is the true count before the page.
   */
  listWorkflows(opts?: { query?: string; includeArchived?: boolean; limit?: number; offset?: number }): DbWorkflow[] {
    const { where, params } = this.buildWorkflowFilterSql(opts);
    let sql = `SELECT * FROM workflows${where} ORDER BY updated_at DESC`;
    const args = [...params];
    if (opts?.limit !== undefined) {
      sql += ' LIMIT ? OFFSET ?';
      args.push(opts.limit, opts.offset ?? 0);
    }
    return this.db.prepare(sql).all(...args) as DbWorkflow[];
  }

  countWorkflows(opts?: { query?: string; includeArchived?: boolean }): number {
    const { where, params } = this.buildWorkflowFilterSql(opts);
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM workflows${where}`).get(...params) as { c: number };
    return row.c;
  }

  /** Shared WHERE builder, so a page and its `total` can never describe different criteria. */
  private buildWorkflowFilterSql(opts?: { query?: string; includeArchived?: boolean }): { where: string; params: any[] } {
    let where = ' WHERE 1=1';
    const params: any[] = [];
    if (!opts?.includeArchived) where += ' AND archived = 0';
    if (opts?.query && opts.query.trim()) {
      where += " AND (LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(description) LIKE ? ESCAPE '\\')";
      const like = `%${this.likeEscape(opts.query.trim().toLowerCase())}%`;
      params.push(like, like);
    }
    return { where, params };
  }

  /**
   * Hides a workflow from the default listing. Deliberately NOT called "complete": a feature is
   * never finished, it just stops being worked on, and the old `completed` status promised a
   * lifecycle nobody maintained. Archiving claims only what it delivers, and is reversible.
   */
  setWorkflowArchived(id: string, archived: boolean): DbWorkflow {
    const workflow = this.getWorkflow(id);
    if (!workflow) throw new Error(`Workflow not found: ${id}`);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE workflows SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, now, id);
    this.writeWorkflowToDisk(id);
    return { ...workflow, archived: archived ? 1 : 0, updated_at: now };
  }

  /**
   * Appends one step. A step is either a COMMIT (summary + reasoning + the node ids it touched) or
   * a RESEARCH finding (summary + reasoning + the docs behind it, no nodes) — the second is the
   * only record of work that produced a decision but no code, which nothing else in DevsMind
   * captures: git has the diff and history has the per-node reasoning, but neither can tell you
   * what was evaluated and rejected.
   *
   * `reasoning` is stored, not joined from `history`, deliberately — see DbWorkflowStep.
   */
  addWorkflowStep(
    workflowId: string,
    opts: { summary: string; reasoning?: string; nodeIds?: string[]; docPaths?: string[]; sessionId?: string }
  ): DbWorkflowStep {
    if (!this.getWorkflow(workflowId)) throw new Error(`Workflow not found: ${workflowId}`);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const nextIndex = ((this.db.prepare('SELECT MAX(step_index) AS m FROM workflow_steps WHERE workflow_id = ?').get(workflowId) as { m: number | null }).m ?? 0) + 1;
    // Empty arrays store as NULL rather than "[]" so "this step touched nothing" and "this step
    // predates the column" read the same downstream — neither is a list worth rendering.
    const nodeIdsJson = opts.nodeIds && opts.nodeIds.length ? JSON.stringify(opts.nodeIds) : null;
    const docPathsJson = opts.docPaths && opts.docPaths.length ? JSON.stringify(opts.docPaths) : null;
    const reasoning = opts.reasoning || null;
    this.db.prepare(`
      INSERT INTO workflow_steps (id, workflow_id, step_index, summary, reasoning, node_ids, doc_paths, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, workflowId, nextIndex, opts.summary, reasoning, nodeIdsJson, docPathsJson, opts.sessionId || null, now);
    this.db.prepare(`UPDATE workflows SET updated_at = ? WHERE id = ?`).run(now, workflowId);
    this.writeWorkflowToDisk(workflowId);
    return {
      id, workflow_id: workflowId, step_index: nextIndex, summary: opts.summary,
      reasoning, node_ids: nodeIdsJson, doc_paths: docPathsJson,
      session_id: opts.sessionId || null, created_at: now
    };
  }

  /** Writes `content` to `.devmind/workflows/<workflowId>/<artifactId>_<sourceName>` and records the DB row. */
  addWorkflowArtifact(workflowId: string, opts: { stepId?: string; type: string; sourceName: string; content: string }): DbWorkflowArtifact {
    if (!this.getWorkflow(workflowId)) throw new Error(`Workflow not found: ${workflowId}`);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const safeName = opts.sourceName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'artifact.md';
    const dir = path.join(this.workflowsDir(), workflowId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${id}_${safeName}`);
    fs.writeFileSync(filePath, opts.content, 'utf-8');
    this.db.prepare(`
      INSERT INTO workflow_artifacts (id, workflow_id, step_id, type, source_name, file_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, workflowId, opts.stepId || null, opts.type, opts.sourceName, filePath, now);
    this.db.prepare(`UPDATE workflows SET updated_at = ? WHERE id = ?`).run(now, workflowId);
    this.writeWorkflowToDisk(workflowId);
    return { id, workflow_id: workflowId, step_id: opts.stepId || null, type: opts.type, source_name: opts.sourceName, file_path: filePath, created_at: now };
  }

  /**
   * The workflow's story: its steps in order, plus the docs attached to it.
   *
   * Paged, because this is now the ONLY read (it absorbed the old `workflow_get_steps`) and steps
   * carry their own reasoning, so an unbounded version of it would be the largest response the
   * server can produce. `steps_total` is exact regardless of the page — a short page must never
   * read as "that is the whole story".
   *
   * Artifact CONTENT is deliberately not returned. It used to be inlined whole, which on an
   * imported architecture doc is trivially tens of KB; the file path is enough, since the file is
   * on disk and the caller can read exactly the part it needs.
   */
  getWorkflowContext(
    id: string,
    opts?: { limit?: number; offset?: number; last_n?: number }
  ): { workflow: DbWorkflow; steps: DbWorkflowStep[]; steps_total: number; steps_offset: number; artifacts: DbWorkflowArtifact[] } {
    const workflow = this.getWorkflow(id);
    if (!workflow) throw new Error(`Workflow not found: ${id}`);
    const steps_total = (this.db.prepare('SELECT COUNT(*) AS c FROM workflow_steps WHERE workflow_id = ?').get(id) as { c: number }).c;
    const steps = this.getWorkflowSteps(id, opts);
    // `last_n` walks backwards from the end, so its offset is wherever that tail begins.
    const steps_offset = opts?.last_n && opts.last_n > 0
      ? Math.max(0, steps_total - steps.length)
      : (opts?.offset ?? 0);
    const artifacts = this.db.prepare('SELECT * FROM workflow_artifacts WHERE workflow_id = ? ORDER BY created_at ASC').all(id) as DbWorkflowArtifact[];
    return { workflow, steps, steps_total, steps_offset, artifacts };
  }

  /**
   * Returns steps for a workflow with optional pagination.
   * Use `last_n` to get only the most recent N steps (tail), or `limit`/`offset` for
   * arbitrary pagination. Without any option, all steps are returned.
   */
  getWorkflowSteps(
    workflowId: string,
    opts?: { limit?: number; offset?: number; last_n?: number }
  ): DbWorkflowStep[] {
    if (!this.getWorkflow(workflowId)) throw new Error(`Workflow not found: ${workflowId}`);
    if (opts?.last_n && opts.last_n > 0) {
      // Fetch the last N steps by descending step_index, then reverse to chronological
      const rows = this.db.prepare(
        'SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_index DESC LIMIT ?'
      ).all(workflowId, opts.last_n) as DbWorkflowStep[];
      return rows.reverse();
    }
    if (opts?.limit) {
      return this.db.prepare(
        'SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_index ASC LIMIT ? OFFSET ?'
      ).all(workflowId, opts.limit, opts.offset ?? 0) as DbWorkflowStep[];
    }
    return this.db.prepare(
      'SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_index ASC'
    ).all(workflowId) as DbWorkflowStep[];
  }

  // NOTE: `readWorkflowArtifact` and `searchWorkflows` were removed here.
  // Artifacts are referenced by PATH now (workflow_add_step's doc_paths, plus the file paths
  // getWorkflowContext already returns), so nothing needs the DB to read a file back for it —
  // and inlining whole imported docs was the single largest thing a workflow response could emit.
  // searchWorkflows was replaced by listWorkflows({ query }): it scanned step summaries and
  // artifact names but NOT workflow name/description, so looking a workflow up by its own name
  // returned nothing — the one search anybody actually tries.

  /**
   * Imports an existing flow/architecture doc as a paused workflow (not active — importing
   * a doc isn't the same as declaring active work). Idempotent on `name`: re-importing the
   * same doc overwrites its existing `imported_doc` artifact file in place instead of
   * creating a duplicate workflow every time the source docs are re-imported.
   */
  importWorkflowDoc(name: string, description: string, content: string, sourceFileName: string): { workflow: DbWorkflow; created: boolean } {
    const existing = this.db.prepare('SELECT * FROM workflows WHERE name = ?').get(name) as DbWorkflow | undefined;
    const now = new Date().toISOString();

    if (existing) {
      this.db.prepare(`UPDATE workflows SET description = ?, updated_at = ? WHERE id = ?`).run(description, now, existing.id);
      const existingArtifact = this.db.prepare(
        `SELECT * FROM workflow_artifacts WHERE workflow_id = ? AND type = 'imported_doc' ORDER BY created_at ASC LIMIT 1`
      ).get(existing.id) as DbWorkflowArtifact | undefined;
      if (existingArtifact) {
        fs.writeFileSync(existingArtifact.file_path, content, 'utf-8');
      } else {
        this.addWorkflowArtifact(existing.id, { type: 'imported_doc', sourceName: sourceFileName, content });
      }
      this.writeWorkflowToDisk(existing.id);
      return { workflow: { ...existing, description, updated_at: now }, created: false };
    }

    const id = `wf_${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO workflows (id, name, description, archived, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(id, name, description, now, now);
    this.addWorkflowStep(id, { summary: `Imported existing flow documentation: ${sourceFileName}` });
    this.addWorkflowArtifact(id, { type: 'imported_doc', sourceName: sourceFileName, content });
    // writeWorkflowToDisk is already called inside addWorkflowArtifact/addWorkflowStep above
    return { workflow: { id, name, description, archived: 0, created_at: now, updated_at: now }, created: true };
  }

  private static readonly SPURIOUS_NODE_NAMES = new Set([
    'promise', 'map', 'set', 'json', 'console', 'error', 'object', 'function', 'array', 'string', 'number', 'boolean', 'regexp', 'date', 'math',
    'any', 'void', 'unknown', 'never', 'null', 'undefined', 'dict', 'list',
    'data', 'useeffect', 'val', 'temp', 'result', 'item', 'key', 'value', 'err', 'req', 'res', 'args', 'params', 'response', 'request'
  ]);

  /**
   * Read-only detection shared by `pruneSpuriousNodes` (which acts on it) and `devsmind
   * analyze`'s dry-run report (which just lists it). Never mutates the DB.
   */
  findSpuriousAndMissingFileNodes(workspaceRoot: string): {
    spurious: { id: string; name: string; file_path: string }[];
    missingFile: { id: string; name: string; file_path: string }[];
  } {
    const stmt = this.db.prepare(`
      SELECT id, name, file_path FROM nodes
      WHERE deprecated = 0
    `);
    const candidates = stmt.all() as { id: string; name: string; file_path: string }[];

    const spurious: { id: string; name: string; file_path: string }[] = [];
    const missingFile: { id: string; name: string; file_path: string }[] = [];

    for (const node of candidates) {
      const lowerName = node.name.toLowerCase();
      if (DevMindDatabase.SPURIOUS_NODE_NAMES.has(lowerName)) {
        spurious.push(node);
        continue;
      }

      if (node.file_path) {
        const paths = node.file_path.split(',').map(p => p.trim()).filter(Boolean);
        if (paths.length > 0) {
          // "Missing" also covers a file_path that resolves to a DIRECTORY rather than a real
          // file — plain fs.existsSync() alone says a directory "exists", so a node corrupted
          // this way (its file_path IS a repo or workspace root, from some earlier bug) sailed
          // through this check indefinitely; it only ever surfaced as an EISDIR crash when
          // writeGraphToDisk/writeVectorsToDisk later tried to write a JSON file at that same
          // path. statSync().isFile() catches both "doesn't exist" and "exists but isn't a file"
          // in one check — a node deprecated for either reason has no real source to hold anyway.
          const allMissing = paths.every(p => {
            const resolvedPath = path.isAbsolute(p) ? p : path.resolve(workspaceRoot, p);
            try {
              return !fs.statSync(resolvedPath).isFile();
            } catch {
              return true;
            }
          });
          if (allMissing) missingFile.push(node);
        }
      }
    }

    return { spurious, missingFile };
  }

  pruneSpuriousNodes(workspaceRoot: string): { prunedCount: number; prunedNodes: string[] } {
    const { spurious, missingFile } = this.findSpuriousAndMissingFileNodes(workspaceRoot);
    const candidates = [...spurious, ...missingFile];

    const idsToDelete: string[] = [];
    const namesDeleted: string[] = [];
    const affectedFilePaths = new Set<string>();

    for (const node of candidates) {
      idsToDelete.push(node.id);
      namesDeleted.push(`${node.name} (${node.id})`);
      if (node.file_path) {
        for (const p of node.file_path.split(',').map(s => s.trim()).filter(Boolean)) {
          affectedFilePaths.add(p);
        }
      }
    }

    if (idsToDelete.length > 0) {
      // Capture caller files and drop the pruned nodes' history JSONs BEFORE the tx: the
      // inbound-edge join goes empty once edges are deleted, and the history rows (whose ids
      // name the JSON files) are removed by deleteHistoryStmt. Without the JSON cleanup, a
      // pruned node would resurrect from its history/[id].json on the next syncFromDisk().
      for (const id of idsToDelete) {
        for (const p of this.collectInboundSourceFiles(id)) {
          affectedFilePaths.add(p);
        }
        this.deleteHistoryFilesForNode(id);
      }

      const updateStmt = this.db.prepare('UPDATE nodes SET deprecated = 1 WHERE id = ?');
      const deleteConnStmt = this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ? OR target_node_id = ?');
      const deleteHistoryStmt = this.db.prepare('DELETE FROM history WHERE node_id = ?');
      const deprecateTx = this.db.transaction((ids: string[]) => {
        for (const id of ids) {
          updateStmt.run(id);
          deleteConnStmt.run(id, id);
          deleteHistoryStmt.run(id);
        }
      });
      deprecateTx(idsToDelete);

      // Keep the committed graph/*.json files in sync with the DB. Pruned nodes are written
      // with deprecated:1 (so they don't come back as active), and every caller file is
      // rewritten so its stale inbound edge doesn't resurrect the connection on next start.
      for (const filePath of affectedFilePaths) {
        this.writeGraphToDisk(filePath);
      }
    }

    return {
      prunedCount: idsToDelete.length,
      prunedNodes: namesDeleted
    };
  }

  private populateHistoryFromDisk(row: any): DbHistory {
    try {
      const historyDir = path.join(path.dirname(this.dbPath), 'history');
      const filePath = path.join(historyDir, `${row.id}.json`);
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return {
          ...row,
          code_snapshot: data.code_snapshot || '',
          reasoning: typeof data.reasoning === 'string' ? data.reasoning : formatReasoning(data.reasoning || ''),
          // Absent in every entry written before the edit trail existed — an empty trail is the
          // honest answer there: nothing to diff, nothing to revert.
          edits: Array.isArray(data.edits) ? data.edits : []
        };
      }
    } catch (err) {
      // ignore errors
    }
    return {
      ...row,
      code_snapshot: '',
      reasoning: '',
      edits: []
    };
  }

  private writeHistoryToDisk(
    id: string,
    nodeId: string,
    sessionId: string,
    createdAt: string,
    updatedAt: string,
    codeSnapshot: string,
    reasoning: string,
    edits: HistoryEdit[] = []
  ) {
    try {
      const historyDir = path.join(path.dirname(this.dbPath), 'history');
      if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir, { recursive: true });
      }

      const node = this.getNode(nodeId);
      const nodeMetadata = node ? {
        name: node.name,
        type: node.type,
        file_path: this.toRepoRelativePath(node.file_path),
        signature: node.signature
      } : null;

      const data = {
        id,
        node_id: nodeId,
        node_metadata: nodeMetadata,
        session_id: sessionId,
        created_at: createdAt,
        updated_at: updatedAt,
        code_snapshot: codeSnapshot,
        reasoning,
        edits
      };

      const filePath = path.join(historyDir, `${id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('⚠️ SQLite warning: Failed to write history JSON to disk:', err);
    }
  }

  /** The configured developer identity (`.devmind/.env`'s DEVELOPER_NAME), or null if unset. */
  public getDeveloperName(): string | null {
    return this.context?.developer?.name || null;
  }

  public toRepoRelativePath(absolutePath: string): string {
    if (!absolutePath || !this.context) return absolutePath;
    const abs = canonicalizePath(absolutePath).replace(/\\/g, '/');
    const absLower = abs.toLowerCase();
    
    for (const repo of this.context.config.repos) {
      const repoPath = resolveRepoPath(this.context, repo.name);
      if (repoPath) {
        const normalizedRepoPath = canonicalizePath(repoPath).replace(/\\/g, '/');
        const normalizedRepoPathLower = normalizedRepoPath.toLowerCase();
        if (absLower === normalizedRepoPathLower || absLower.startsWith(normalizedRepoPathLower + '/')) {
          const relative = path.relative(normalizedRepoPath, abs).replace(/\\/g, '/');
          return `{${repo.name}}/${relative}`;
        }
      }
    }
    
    // Fallback: resolve relative to workspace root
    const workspaceRoot = canonicalizePath(path.dirname(this.dbPath));
    return path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
  }

  /**
   * Rejects a resolved path that escapes its expected root (e.g. via a stored
   * `{repo}/../../..` path traveling outside the repo) by clamping it back to
   * the root itself. node_id/file_path values flow in from AI-supplied tool
   * calls, so a resolve must never be trusted to stay inside root on its own.
   */
  private clampToRoot(root: string, resolved: string): string {
    const normalizedRoot = canonicalizePath(root);
    const normalizedResolved = canonicalizePath(resolved);
    const rootLower = normalizedRoot.toLowerCase();
    const resolvedLower = normalizedResolved.toLowerCase();
    if (resolvedLower === rootLower || resolvedLower.startsWith(rootLower + path.sep)) {
      return normalizedResolved;
    }
    console.warn(`⚠️ Path traversal blocked: "${resolved}" escapes root "${root}"`);
    return normalizedRoot;
  }

  /**
   * True if `absPath` sits inside a configured repo root or the workspace root itself.
   * Used to reject `edit_node`/`update_history` file paths that would otherwise let a
   * tool call read/write any file on disk (absolute path, or a `../` escape) instead of
   * just repo source — nothing upstream of this validates that the AI-supplied path is
   * actually inside the project.
   */
  /**
   * Gate for every AI-facing write (edit_node, the legacy update_history): true only for
   * paths inside a configured repo. `.devmind` itself — this project's OWN
   * config, brain.db, and cached graph JSON — is never writable through these tools, even
   * though it sits next to (and, before this check, was indistinguishable from) real source:
   * without this, a write tool built to "never refuse a file type" would just as happily
   * rewrite devsmind's own config.json as it would application source.
   */
  public isPathAllowed(absPath: string): boolean {
    const abs = canonicalizePath(absPath);
    const absLower = abs.toLowerCase();
    const devmindDirLower = canonicalizePath(path.dirname(this.dbPath)).toLowerCase();
    if (absLower === devmindDirLower || absLower.startsWith(devmindDirLower + path.sep)) return false;
    if (this.context) {
      for (const repo of this.context.config.repos) {
        const repoPath = resolveRepoPath(this.context, repo.name);
        if (repoPath) {
          const normalizedRepoPath = canonicalizePath(repoPath);
          const normalizedRepoPathLower = normalizedRepoPath.toLowerCase();
          if (absLower === normalizedRepoPathLower || absLower.startsWith(normalizedRepoPathLower + path.sep)) return true;
        }
      }
    }
    return false;
  }

  public toAbsolutePath(repoRelativePath: string): string {
    if (!repoRelativePath) return repoRelativePath;
    const workspaceRoot = canonicalizePath(path.dirname(this.dbPath));

    const match = repoRelativePath.match(/^\{([^}]+)\}\/(.*)$/);
    if (match && this.context) {
      const repoName = match[1];
      const relativePath = match[2];
      const repoPath = resolveRepoPath(this.context, repoName);
      if (repoPath) {
        return canonicalizePath(this.clampToRoot(repoPath, path.resolve(repoPath, relativePath)));
      }
    }

    // Heuristic: if it doesn't start with {repoName} but contains a configured repo name in the path
    if (this.context) {
      for (const repo of this.context.config.repos) {
        // Find if repo.name appears as a folder in the path, e.g. "harrir-express-backend/tests/..."
        const escapedRepoName = repo.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp('(?:^|/|\\\\)' + escapedRepoName + '(?:/|\\\\)(.*)$', 'i');
        const m = repoRelativePath.match(regex);
        if (m) {
          const repoPath = resolveRepoPath(this.context, repo.name);
          if (repoPath) {
            const relativePath = m[1];
            return canonicalizePath(path.resolve(repoPath, relativePath));
          }
        }
      }
    }

    // Fallback: resolve relative to workspace root
    return canonicalizePath(this.clampToRoot(workspaceRoot, path.resolve(workspaceRoot, repoRelativePath)));
  }

  syncFromDisk(onProgress?: (phase: string, done: number, total: number) => void) {
    this.db.pragma('foreign_keys = OFF');
    // Captured BEFORE the walk starts (not after it finishes) so a file touched WHILE this sync
    // is running is still mtime >= this timestamp and gets correctly picked up on the NEXT sync,
    // rather than silently missed by a checkpoint that raced ahead of it.
    const syncStartedAtMs = Date.now();
    // 0 (never synced before, or system_meta was wiped by resetAll) disables every mtime skip
    // below unconditionally — every real file's mtimeMs is a large positive epoch value, so
    // `mtimeMs < 0` is never true and the first pass always processes everything, as before.
    const lastSyncedAtMs = Number(this.getSystemMeta('last_sync_checkpoint_ms')) || 0;
    try {
      const workspaceRoot = path.dirname(this.dbPath);

      // 0. Auto-heal any legacy relative path records in SQLite.
      //
      // Runs on every server start, so getting "already absolute" wrong is not a one-time
      // migration slip — it recurs forever. The original check only recognized the C: drive
      // and POSIX roots ('c:%'/'C:%'/'/%'); SQL LIKE has no character-range syntax, so it could
      // not express "any drive letter" or a UNC path (\\server\share\...) in one pattern. Every
      // node on a D:, E:, ... drive or a UNC path was misclassified as relative, run through
      // toAbsolutePath() -> clampToRoot(), and silently rewritten to the workspace root — i.e.
      // real file_paths for an entire class of valid Windows paths got destroyed on restart.
      // path.isAbsolute() classifies all of these correctly in one call.
      try {
        const legacyNodes = (this.db.prepare('SELECT id, file_path FROM nodes').all() as { id: string; file_path: string }[])
          .filter(n => n.file_path && !path.isAbsolute(n.file_path));
        if (legacyNodes.length > 0) {
          const updateStmt = this.db.prepare('UPDATE nodes SET file_path = ? WHERE id = ?');
          const healTx = this.db.transaction(() => {
            for (const n of legacyNodes) {
              const abs = this.toAbsolutePath(n.file_path);
              updateStmt.run(abs, n.id);
            }
          });
          healTx();
        }
      } catch (err) {
        // ignore legacy errors
      }
      
      // 1. Sync History JSONs
      const historyDir = path.join(workspaceRoot, 'history');
      if (fs.existsSync(historyDir)) {
        const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
        if (files.length > 0) {
          const checkHistoryStmt = this.db.prepare('SELECT id FROM history WHERE id = ?');
          const checkNodeStmt = this.db.prepare('SELECT id FROM nodes WHERE id = ?');
          const insertNodeStmt = this.db.prepare(`
            INSERT INTO nodes (id, type, name, file_path, signature, deprecated)
            VALUES (?, ?, ?, ?, ?, 0)
          `);
          const insertHistoryStmt = this.db.prepare(`
            INSERT INTO history (id, node_id, session_id, created_at, updated_at, code_snapshot, reasoning)
            VALUES (?, ?, ?, ?, ?, '', ?)
          `);

          const syncHistoryTx = this.db.transaction(() => {
            let done = 0;
            for (const file of files) {
              done++;
              if (onProgress && DevMindDatabase.shouldReport(done, files.length)) onProgress('history', done, files.length);
              try {
                // History files are immutable and always named `${id}.json` (every writer uses
                // this convention — see updateHistory/eraseLastEdit/etc.), so an already-synced
                // file can be identified from its NAME alone, before ever reading it. This is the
                // single biggest cost in syncFromDisk: history/ grows one file per edit forever,
                // so on a mature repo the overwhelming majority of files here are already synced
                // and this check-before-read turns them from a readFileSync+JSON.parse into a
                // single indexed SQLite lookup.
                if (checkHistoryStmt.get(file.slice(0, -'.json'.length))) continue;

                const filePath = path.join(historyDir, file);
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                if (!data.id || !data.node_id) continue;

                // Kept as a safety net in case a hand-written/legacy file's internal `id` ever
                // differs from its filename — the fast path above is an optimization, not a
                // replacement for this correctness check.
                if (checkHistoryStmt.get(data.id)) continue;

                if (!checkNodeStmt.get(data.node_id) && data.node_metadata) {
                  insertNodeStmt.run(
                    data.node_id,
                    data.node_metadata.type,
                    data.node_metadata.name,
                    this.toAbsolutePath(data.node_metadata.file_path),
                    data.node_metadata.signature
                  );
                }

                const formattedReasoning = typeof data.reasoning === 'string'
                  ? data.reasoning
                  : formatReasoning(data.reasoning || '');

                insertHistoryStmt.run(
                  data.id,
                  data.node_id,
                  data.session_id,
                  data.created_at,
                  data.updated_at,
                  formattedReasoning
                );
              } catch (err) {
                // ignore
              }
            }
          });
          syncHistoryTx();
        }
      }

      // 2. Sync Graph JSONs
      const graphDir = path.join(workspaceRoot, 'graph');
      if (fs.existsSync(graphDir)) {
        // Recursively find all JSON files in graphDir
        const walkSync = (dir: string, fileList: string[] = []): string[] => {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            const filePath = path.join(dir, file);
            if (fs.statSync(filePath).isDirectory()) {
              walkSync(filePath, fileList);
            } else if (file.endsWith('.json')) {
              fileList.push(filePath);
            }
          }
          return fileList;
        };

        const jsonFiles = walkSync(graphDir);
        if (jsonFiles.length > 0) {
          const deleteNodesForFileStmt = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
          const deleteConnsForNodesStmt = this.db.prepare('DELETE FROM node_connections WHERE source_node_id = ?');
          const insertNodeStmt = this.db.prepare(`
            INSERT OR REPLACE INTO nodes (id, type, name, file_path, signature, description, aliases, deprecated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          const insertConnStmt = this.db.prepare(`
            INSERT OR IGNORE INTO node_connections (source_node_id, target_node_id)
            VALUES (?, ?)
          `);

          // Transaction for fast batch syncing
          const syncGraphTx = this.db.transaction(() => {
            let done = 0;
            for (const file of jsonFiles) {
              done++;
              if (onProgress && DevMindDatabase.shouldReport(done, jsonFiles.length)) onProgress('graph', done, jsonFiles.length);
              try {
                // Unlike history/, a graph JSON gets REWRITTEN in place on every edit to its
                // source file (same path, new content) — so identity alone can't tell us "already
                // synced." mtime can: if this file hasn't changed since the last successful sync,
                // the DB is already current for it (a `git pull`/checkout always bumps the mtime
                // of every file it actually changed, so this correctly still processes exactly
                // what came in on a pull). Skips the readFileSync+JSON.parse+delete+reinsert
                // entirely for the — typically overwhelming — majority of untouched files.
                if (fs.statSync(file).mtimeMs < lastSyncedAtMs) continue;

                const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
                if (!data.file_path) continue;

                const fileRelPath = data.file_path; // E.g. "{harrir-web}/app/page.tsx" or relative path
                const fileAbsPath = this.toAbsolutePath(fileRelPath);

                // Clean existing nodes in SQLite for this file BEFORE re-inserting from
                // the JSON (so removed/renamed symbols are cleared). Match ONLY the exact
                // absolute path: the previous suffix `LIKE '%<relpath>'` matched the same
                // relative path in EVERY repo, so syncing one repo's file deleted another
                // repo's same-named file nodes (cross-repo data loss).
                deleteNodesForFileStmt.run(fileAbsPath);

                // Insert nodes
                const nodes = data.nodes || [];
                for (const n of nodes) {
                  deleteConnsForNodesStmt.run(n.id);
                  const aliasesJson = Array.isArray(n.aliases) ? JSON.stringify(n.aliases) : '[]';
                  insertNodeStmt.run(n.id, n.type, n.name, fileAbsPath, n.signature || null, n.description || null, aliasesJson, n.deprecated ? 1 : 0);
                }

                // Insert connections
                const connections = data.connections || [];
                for (const c of connections) {
                  insertConnStmt.run(c.source_node_id, c.target_node_id);
                }
              } catch (err) {
                // ignore
              }
            }
          });
          syncGraphTx();
        }
      }

      // 2.5. Sync Vector JSONs — MUST run after the graph pass (2), since that pass just
      // deleted and re-inserted the current node set; vectors are reconciled against nodes as
      // they now stand, not as they stood before this sync. Model-mismatched vectors (a
      // teammate on a different devsmind version) are ignored on import, never partially
      // trusted — those nodes simply fall back into the local `devsmind embed` queue. Then an
      // explicit orphan sweep, since node_vectors has no FK (this whole method runs with
      // foreign_keys=OFF, so a cascade would silently never fire during the graph pass anyway).
      const vectorsDir = path.join(workspaceRoot, 'vectors');
      if (fs.existsSync(vectorsDir)) {
        const walkSyncVec = (dir: string, fileList: string[] = []): string[] => {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            const filePath = path.join(dir, file);
            if (fs.statSync(filePath).isDirectory()) {
              walkSyncVec(filePath, fileList);
            } else if (file.endsWith('.json')) {
              fileList.push(filePath);
            }
          }
          return fileList;
        };

        const vectorJsonFiles = walkSyncVec(vectorsDir);
        if (vectorJsonFiles.length > 0) {
          const insertVectorStmt = this.db.prepare(`
            INSERT OR REPLACE INTO node_vectors (node_id, model_id, dim, description_hash, vector)
            VALUES (?, ?, ?, ?, ?)
          `);

          const syncVectorsTx = this.db.transaction(() => {
            let done = 0;
            for (const file of vectorJsonFiles) {
              done++;
              if (onProgress && DevMindDatabase.shouldReport(done, vectorJsonFiles.length)) onProgress('vectors', done, vectorJsonFiles.length);
              try {
                // Same reasoning as the graph pass above: a vectors/*.json is rewritten in place
                // whenever its node's vector changes, so mtime — not identity — is what tells us
                // whether the DB is still current for this file.
                if (fs.statSync(file).mtimeMs < lastSyncedAtMs) continue;

                const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
                if (!data.model_id || data.model_id !== EMBEDDING_MODEL_ID) continue;
                const vectors = data.vectors || {};
                for (const nodeId of Object.keys(vectors)) {
                  const entry = vectors[nodeId];
                  if (!entry || !entry.v || !entry.h) continue;
                  const buf = Buffer.from(entry.v, 'base64');
                  insertVectorStmt.run(nodeId, EMBEDDING_MODEL_ID, data.dim || EMBEDDING_DIM, entry.h, buf);
                }
              } catch (err) {
                // ignore malformed vectors JSON
              }
            }
          });
          syncVectorsTx();
        }
      }
      // Orphan sweep — always runs, even with no vectors/ dir, to catch nodes deleted or
      // renamed by the graph pass above that still had a (now-dangling) vector row.
      this.db.exec('DELETE FROM node_vectors WHERE node_id NOT IN (SELECT id FROM nodes)');

      // 3. Sync Workflow JSONs
      const workflowsDir = this.workflowsDir();
      if (fs.existsSync(workflowsDir)) {
        const upsertWorkflow = this.db.prepare(`
          INSERT INTO workflows (id, name, description, archived, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            archived = excluded.archived,
            updated_at = excluded.updated_at
        `);
        // DO UPDATE, not INSERT OR IGNORE. A teammate who already has a step row would otherwise
        // never pick up `reasoning`/`node_ids`/`doc_paths` from a newer workflow.json — the row
        // exists, so the insert is ignored, and their brain stays permanently half-migrated with
        // no sign anything went wrong. Safe to overwrite because steps are append-only: nothing
        // edits one locally after it is written, so incoming disk state is always authoritative.
        const upsertStep = this.db.prepare(`
          INSERT INTO workflow_steps (id, workflow_id, step_index, summary, reasoning, node_ids, doc_paths, session_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            summary = excluded.summary,
            reasoning = COALESCE(excluded.reasoning, workflow_steps.reasoning),
            node_ids = COALESCE(excluded.node_ids, workflow_steps.node_ids),
            doc_paths = COALESCE(excluded.doc_paths, workflow_steps.doc_paths)
        `);
        const upsertArtifact = this.db.prepare(`
          INSERT OR IGNORE INTO workflow_artifacts (id, workflow_id, step_id, type, source_name, file_path, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const syncWorkflowsTx = this.db.transaction(() => {
          const subdirs = fs.readdirSync(workflowsDir);
          for (const subdir of subdirs) {
            const jsonPath = path.join(workflowsDir, subdir, 'workflow.json');
            if (!fs.existsSync(jsonPath)) continue;
            try {
              const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
              if (!data.id || !data.name) continue;

              // The sidecar is authoritative for the fields v1 has no place for. It matters most
              // in exactly the case that looks fine: a teammate on an older build rewrote
              // workflow.json from their own columns, so it came back v1-shaped — but they could
              // not touch v2.json, so `archived` and every step's reasoning/node_ids/doc_paths are
              // still here to merge back on top.
              let sidecar: { archived?: number; steps?: Record<string, { reasoning?: string | null; node_ids?: string | null; doc_paths?: string | null }> } = {};
              try {
                const sidecarPath = path.join(workflowsDir, subdir, WORKFLOW_SIDECAR_FILE);
                if (fs.existsSync(sidecarPath)) sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8')) || {};
              } catch { /* a corrupt sidecar degrades to the v1 shape rather than losing the workflow */ }

              upsertWorkflow.run(
                data.id, data.name, data.description || '',
                (sidecar.archived ?? data.archived) ? 1 : 0,
                data.created_at || new Date().toISOString(),
                data.updated_at || new Date().toISOString()
              );

              for (const s of (data.steps || [])) {
                if (!s.id) continue;
                // A genuinely v1 workflow (never written by this version) has no sidecar entry
                // either — those fields land as NULL and the step shows its summary alone, which
                // is all v1 ever stored. Nothing is lost that the old format ever held.
                const extra = sidecar.steps?.[s.id] || {};
                upsertStep.run(
                  s.id, data.id, s.step_index, s.summary || '',
                  extra.reasoning ?? s.reasoning ?? null,
                  extra.node_ids ?? s.node_ids ?? null,
                  extra.doc_paths ?? s.doc_paths ?? null,
                  s.session_id || null,
                  s.created_at || new Date().toISOString()
                );
              }

              for (const a of (data.artifact_index || [])) {
                if (!a.id) continue;
                upsertArtifact.run(
                  a.id, data.id, a.step_id || null, a.type || 'unknown',
                  a.source_name || '', a.file_path || '', a.created_at || new Date().toISOString()
                );
              }

              // A v1 JSON's `is_active` is deliberately ignored. That flag is exactly how one
              // developer's "currently working on" state used to travel through git and take over
              // everyone else's — which workflow you are on is now local to your session and never
              // synced.
            } catch { /* skip malformed */ }
          }
        });
        syncWorkflowsTx();
      }

      // Only advance the checkpoint after every step above completed without throwing — an
      // exception anywhere earlier jumps straight to `catch` below, so this line is never
      // reached, and the NEXT sync correctly retries a full pass from the old (or absent)
      // checkpoint instead of wrongly believing a failed run succeeded.
      this.setSystemMeta('last_sync_checkpoint_ms', String(syncStartedAtMs));
    } catch (err) {
      console.warn('⚠️ SQLite warning: Failed to sync from disk:', err);
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  /** Escape LIKE metacharacters so a path is matched literally (use with ESCAPE '\\'). */
  private likeEscape(s: string): string {
    return s.replace(/[\\%_]/g, ch => '\\' + ch);
  }

  /**
   * True when `targetPath` (a computed `graph/`/`vectors/` JSON path) does NOT land strictly
   * inside `containerDir` as a real file — i.e. writing there would be writing to a directory,
   * not a file inside one. Guards `writeGraphToDisk`/`writeVectorsToDisk` against a malformed
   * node whose `file_path` IS a directory (the workspace root, or a repo root itself): observed
   * in production as an EISDIR crash on `devsmind sync`, because `toRepoRelativePath` collapses
   * to `''` (workspace root) or `'{repo}/'` (a repo root) for those, which `diskRelPath` then
   * turns into `''`/a trailing-slash string/`'..'` depending on which branch collapsed — every
   * one of which makes `path.join(containerDir, diskRelPath)` resolve to `containerDir` itself
   * or some directory already inside it, never a fresh `.json` file. Multiple checks on purpose:
   * the empty/trailing-slash/`..`-relative cases catch it structurally (works even on a brand
   * new brain where nothing exists on disk yet, where an EISDIR would instead be a silent
   * file-where-directory-belongs corruption); the existsSync+isDirectory check is a catch-all
   * for any other collapse shape not foreseen above (existsSync is checked first specifically so
   * a normal not-yet-written target — the common case — never reaches statSync at all). Callers
   * already wrap their whole body in a try/catch that logs and returns, so nothing extra is
   * needed here for a statSync that throws for some other reason (a permission error, a race).
   * `devsmind analyze --fix` deprecates the node actually causing this; this only ever refuses
   * the write, never touches the node.
   */
  private isDegenerateDiskJsonPath(containerDir: string, diskRelPath: string, targetPath: string): boolean {
    if (!diskRelPath || diskRelPath.endsWith('/') || diskRelPath.endsWith('\\')) return true;
    const relToContainer = path.relative(containerDir, targetPath);
    if (relToContainer === '' || relToContainer.startsWith('..')) return true;
    return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
  }

  writeGraphToDisk(filePath: string) {
    try {
      if (!filePath) return;
      const workspaceRoot = canonicalizePath(path.dirname(this.dbPath));
      // Clean/resolve the file path
      const absPath = canonicalizePath(filePath);
      const repoRelPath = this.toRepoRelativePath(absPath);

      // E.g., "{harrir-web}/app/page.tsx" -> "graph/harrir-web/app/page.json"
      const diskRelPath = repoRelPath.replace(/^\{([^}]+)\}/, '$1').replace(/\.[^/.]+$/, '.json');
      const graphDir = path.join(workspaceRoot, 'graph');
      const graphJsonPath = path.join(graphDir, diskRelPath);
      if (this.isDegenerateDiskJsonPath(graphDir, diskRelPath, graphJsonPath)) {
        console.warn(`⚠️ Skipped writing graph JSON: a node's file_path resolves to a directory, not a file (${absPath}) — run \`devsmind analyze --fix\` to clean it up.`);
        return;
      }

      // Get all nodes in this file (active AND deprecated). A node's file_path is either
      // exactly this absolute path, or (for the rare node spanning multiple files) a ", "-joined
      // list containing it. We anchor on the FULL absolute path with ", " boundaries and escape
      // LIKE metacharacters — the old `%<relpath>%` / `%<relpath>` matched short relative
      // suffixes shared across repos, pulling in (and later corrupting) other repos' nodes.
      // Deprecated nodes are INCLUDED (and carry deprecated:1 in the JSON) so that deprecation
      // is durable across a syncFromDisk() restart and propagates to teammates via git —
      // otherwise the node's history JSON would resurrect it as active on the next start.
      const absEsc = this.likeEscape(absPath);
      const absLower = absPath.toLowerCase();
      const absEscLower = absEsc.toLowerCase();
      const stmtNodes = this.db.prepare(`
        SELECT * FROM nodes
        WHERE (
          LOWER(file_path) = ? OR
          LOWER(file_path) LIKE ? ESCAPE '\\' OR
          LOWER(file_path) LIKE ? ESCAPE '\\' OR
          LOWER(file_path) LIKE ? ESCAPE '\\'
        )
      `);
      const nodes = DevMindDatabase.parseNodeRows(stmtNodes.all(
        absLower,
        `${absEscLower}, %`,
        `%, ${absEscLower}`,
        `%, ${absEscLower}, %`
      ) as DbNode[]);

      if (nodes.length === 0) {
        // If no nodes left, delete the JSON file if it exists
        if (fs.existsSync(graphJsonPath)) {
          fs.unlinkSync(graphJsonPath);
        }
        return;
      }

      // Collect all connections where source node is one of these nodes
      const nodeIds = nodes.map(n => n.id);
      const connections: DbConnection[] = [];
      
      if (nodeIds.length > 0) {
        const stmtConn = this.db.prepare(`
          SELECT * FROM node_connections
          WHERE source_node_id = ?
        `);
        for (const id of nodeIds) {
          const conns = stmtConn.all(id) as DbConnection[];
          connections.push(...conns);
        }
      }

      // Format data
      const data = {
        file_path: repoRelPath,
        nodes: nodes.map(n => ({
          id: n.id,
          name: n.name,
          type: n.type,
          signature: n.signature,
          description: n.description || undefined,
          aliases: n.aliases.length > 0 ? n.aliases : undefined,
          deprecated: n.deprecated ? 1 : 0
        })),
        connections: connections.map(c => ({
          source_node_id: c.source_node_id,
          target_node_id: c.target_node_id
        }))
      };

      fs.mkdirSync(path.dirname(graphJsonPath), { recursive: true });
      fs.writeFileSync(graphJsonPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('⚠️ SQLite warning: Failed to write graph JSON to disk:', err);
    }
  }

  /**
   * Mirrors `writeGraphToDisk` exactly (same file-matching logic, same directory shape) but into
   * a separate `vectors/` tree rather than inside `graph/*.json` — deliberately, so opaque base64
   * blobs never pollute the human-readable, merge-friendly graph JSON. Deprecated nodes are
   * skipped here (unlike the graph, which keeps them): `searchNodes` never queries a deprecated
   * node's vector, so writing one is pure dead weight.
   */
  writeVectorsToDisk(filePath: string) {
    try {
      if (!filePath) return;
      const workspaceRoot = canonicalizePath(path.dirname(this.dbPath));
      const absPath = canonicalizePath(filePath);
      const repoRelPath = this.toRepoRelativePath(absPath);
      const diskRelPath = repoRelPath.replace(/^\{([^}]+)\}/, '$1').replace(/\.[^/.]+$/, '.json');
      const vectorsDir = path.join(workspaceRoot, 'vectors');
      const vectorsJsonPath = path.join(vectorsDir, diskRelPath);
      // Same guard as writeGraphToDisk — see isDegenerateDiskJsonPath's comment for why this
      // happens and what it means.
      if (this.isDegenerateDiskJsonPath(vectorsDir, diskRelPath, vectorsJsonPath)) {
        console.warn(`⚠️ Skipped writing vectors JSON: a node's file_path resolves to a directory, not a file (${absPath}) — run \`devsmind analyze --fix\` to clean it up.`);
        return;
      }

      const absLower = absPath.toLowerCase();
      const absEscLower = this.likeEscape(absPath).toLowerCase();
      const stmt = this.db.prepare(`
        SELECT nv.node_id AS node_id, nv.description_hash AS description_hash, nv.vector AS vector
        FROM node_vectors nv
        JOIN nodes n ON n.id = nv.node_id
        WHERE n.deprecated = 0 AND (
          LOWER(n.file_path) = ? OR
          LOWER(n.file_path) LIKE ? ESCAPE '\\' OR
          LOWER(n.file_path) LIKE ? ESCAPE '\\' OR
          LOWER(n.file_path) LIKE ? ESCAPE '\\'
        ) AND nv.model_id = ?
      `);
      const rows = stmt.all(
        absLower, `${absEscLower}, %`, `%, ${absEscLower}`, `%, ${absEscLower}, %`, EMBEDDING_MODEL_ID
      ) as { node_id: string; description_hash: string; vector: Buffer }[];

      if (rows.length === 0) {
        if (fs.existsSync(vectorsJsonPath)) fs.unlinkSync(vectorsJsonPath);
        return;
      }

      const vectors: Record<string, { h: string; v: string }> = {};
      for (const r of rows) {
        vectors[r.node_id] = { h: r.description_hash, v: Buffer.from(r.vector).toString('base64') };
      }
      const data = { file_path: repoRelPath, model_id: EMBEDDING_MODEL_ID, dim: EMBEDDING_DIM, vectors };

      fs.mkdirSync(path.dirname(vectorsJsonPath), { recursive: true });
      fs.writeFileSync(vectorsJsonPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('⚠️ SQLite warning: Failed to write vectors JSON to disk:', err);
    }
  }

  /**
   * Force-syncs all database nodes, vectors, and workflows to disk JSON files. This is the
   * write-back half of `devsmind sync` (paired with `syncFromDisk`, which reads `vectors/*.json`
   * into `node_vectors` — see its comment). Vectors are re-written here for the same reason
   * graph JSON is: normal operation already keeps `vectors/` current (`writeVectorsToDisk` runs
   * immediately alongside every embedding write), but `sync` exists precisely for the abnormal
   * case — recovering a `.devmind` after `vectors/*.json` was deleted/corrupted independently of
   * the DB, or after a past write silently failed (e.g. the directory-typed file_path bug
   * `isDegenerateDiskJsonPath` now catches) — so leaving vectors out of the force-resync
   * defeated half the point of running it.
   */
  syncToDisk(): void {
    try {
      const rows = this.db.prepare('SELECT DISTINCT file_path FROM nodes').all() as { file_path: string }[];
      const filePaths = new Set<string>();
      for (const row of rows) {
        if (row.file_path) {
          for (const p of row.file_path.split(',').map(s => s.trim()).filter(Boolean)) {
            filePaths.add(p);
          }
        }
      }

      for (const filePath of filePaths) {
        this.writeGraphToDisk(filePath);
        this.writeVectorsToDisk(filePath);
      }

      const workflowRows = this.db.prepare('SELECT id FROM workflows').all() as { id: string }[];
      for (const row of workflowRows) {
        this.writeWorkflowToDisk(row.id);
      }
    } catch (err) {
      console.warn('⚠️ DevsMind: Failed to sync database to disk:', err);
    }
  }
}
