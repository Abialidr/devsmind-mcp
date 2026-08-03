import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as crypto from 'crypto';
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';
import express from 'express';
import {
  DevMindDatabase, parseReasoningBlocks, NO_STATIC_CALLERS_NOTE, toCompactSearchResult,
  SearchNodesResult, CompactSearchNodesResult
} from '../db/database';
import { loadProjectContext } from '../utils/config';
import { getViewHtml, ASSETS_DIR, DEVSMIND_TOKEN } from './visualizer';
import { diffEdits, renderUnifiedDiff, diffSnapshots } from '../utils/diff';
import { revertLastEdit } from '../db/revert';
import {
  readSessions, listMessages, readMessage, createSession, queryActivityLog,
  bindSessionWorkflow, readSessionWorkflow, lastBoundWorkflowId, saveMessage, ActivityMessage
} from '../db/activity';
import { resolveActivityLog, ActivitySourceMode } from '../db/activity-graph';
import { revertMessage, unrevertMessage, revertMessageFile, unrevertMessageFile, revertMessageEdit, unrevertMessageEdit } from '../db/message-revert';
import { fileDiffForMessage } from '../db/file-diff';
import {
  readScratchpad,
  createScratchpad,
  updateScratchpad,
  completeScratchpad
} from '../db/indexer';
import { scanRepoFiles, INDEXABLE_EXTENSIONS } from '../utils/scanner';
import { parseNodeId, isAstParseable, findTouchedSymbols, invalidateParsedFile, extractNodeFromFile, listFileImports, outlineFile } from '../utils/ast';
import { replaceTextInFile, createFileWithContent } from '../utils/edit';
import { validateDescription } from '../utils/tokenize';
import { DEVSMIND_VERSION } from '../utils/version';
import { stageEntry, readStaged, clearStaged, commitStagedChanges, summarizeEntriesForWorkflow, StagedEntry, stageFileEdit, readStagedFileEdits, overwriteStaged, resolveEntryId, partitionStagedForSession, clearStagedForSession } from '../db/staging';
import { recordMessage } from '../db/activity';
import { runAnalysis } from '../db/analyze';
import {
  appendGraphFeedback, appendProductFeedback, readGraphFeedback, clusterGraphFeedback,
  markGraphFeedbackProcessed, appendIndexerRuleCandidate
} from '../db/feedback';
import { splitNode } from '../db/edges';
import { importWorkflowDocs } from '../db/workflow-import';
import { embedTextInt8, hashDescription, isEmbedderAvailable } from '../db/embedder';

// â”€â”€â”€ Port: devsâ†’D(4)E(5)=45 + mindâ†’M(13)=13 â†’ 4513 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const DEVSMIND_PORT = 4513;

/**
 * Sent to every MCP client at connection time via the protocol's `instructions`
 * field (part of the initialize handshake) — the single source of truth for the
 * cross-cutting workflow contract, independent of whatever the user did or didn't
 * paste into a `devsmind rule` output. Keep this crisp: unlike a tool's own
 * `description` (resent every call), this is easy for a long session to lose
 * track of too, so it should carry only what's genuinely cross-cutting.
 */
export const DEVSMIND_INSTRUCTIONS = `DevsMind is this team's persistent shared code memory — not a personal tool you reach for only when asked to search something. Every teammate's AI agent, in every session, reads from the SAME graph you are about to write to. There is no "your copy."

If you skip recording a change, you are not skipping a formality. You are leaving the whole team's graph stale for every other AI agent that queries this code later — tomorrow, on a different task, in a different session. And the reasoning behind your change (why it was made, what ticket drove it, what was broken before, what you tried and rejected) exists ONLY in this conversation, right now. It is not in the diff. It is not in the commit message. If it isn't captured at commit_changes this turn, it is gone forever — no reindex, no log, no git blame can recover it later.

Non-negotiable workflow:
1. Call start_session once, before your first WRITE of the conversation (edit_node/stage_change/commit_changes and the other mutating tools). It mints a session_id that every write REQUIRES — it ties a request's edits together on the local Activity log and makes them revertable as a unit — and every response echoes it back so it stays in front of you, including after a context compaction. Read-only tools (search_nodes, get_node_code, list_nodes, and the other getters) do NOT need it: search and read freely from the very first call. Never invent a session_id yourself; if a write errors saying session_id is required, start_session was skipped — call it now, then retry. If you are resuming a conversation that already called start_session earlier (visible in the reloaded history), reuse that same session_id instead of starting a new one.
2. Before any filesystem search, grep, or file read: call search_nodes FIRST — it is now the one call for both "find this node" AND "find where X lives across files", so you should not need an external grep. Two inputs, pass either or both: a natural-language query (a real phrase — drives meaning-matching, so "authentication" finds a node described only as "sign-in") and/or pattern, a REAL regex used exactly as you'd give it to grep (e.g. "heartRed|onLikeTap|item\.liked" — nothing is re-escaped or split for you). Pattern-only is a precision mode: exact grep + code-body matches, no semantic blur. It returns two buckets: nodes (the indexed graph — the primary answer for "which function/class", with a true nodes_total before the top-20 cap) and files (a real grep of every repo, or just the path scope if given — the answer for things the graph does not index: CSS, JSON, config, .env, markup, wiring like "where is CORS configured" or "what mounts this middleware" — each sample line reports which function/class it falls inside, and files_total tells you honestly whether there's more than the page shown; pass a bigger offset for the next page). Triage by each node's confidence and relevance, NOT by which name looks right to you — confidence reflects how many independent layers corroborated the hit, which your own reading of a name cannot. Lockfiles and build artifacts are excluded by default, so what comes back is real source. If the response carries a compacted field, it was trimmed to fit and says exactly what was dropped — all counts stay exact, and compact:false gets you the untrimmed payload. It only returns real evidence — genuinely-absent things come back empty with a hint; if so, retry once with a different pattern/query before concluding it is not there. Only drop to a manual grep/read if search_nodes itself says truncated, or you need full file context after it points you at the file.
3. To read one function/class: call get_node_code instead of opening the file, and do not follow it with a file read for context — this is the ONE node-read call, not a lean summary. It already includes the file's imports, the node's own name/type/signature/description, up to 20 named callers AND callees per direction (with exact uses/used_by counts even when the lists are capped), and up to 40 other declarations from the same file (file_outline — this is how you tell "was this renamed?" or "what else lives here" without opening the file). Reach further in the SAME call instead of a second tool: graph_depth + graph_direction walks the transitive graph past the direct neighbors already included (add graph_code:true for a whole call flow's source in one round trip — if some nodes' code doesn't fit the budget they are named in graph.code_omitted_node_ids, so fetch exactly those rather than re-running blind), and history:"full" returns every revision with diffable edits, pageable with history_limit/history_offset. Every capped section is honest about it (*_truncated, *_hint) — a hint means more is reachable in this same call, not a dead end.
4. Before touching any function's signature: get_node_code already includes its direct callers by name (used_by_nodes) — for the FULL transitive blast radius, pass graph_direction:"in" with a graph_depth of 2-3 in that same call. Git shows you what changed; it never shows you what depends on it. Find out before you break something, not after.
5. Before refactoring: get_node_code already includes the last 3 changes' reasoning by default — for the full revision trail with diffable before/after edits, pass history:"full" in that same call. Git blame tells you who and when; it never tells you why. The actual decision context only exists here.
6. Write EVERY file with edit_node — .ts, .vue, .css, .json, .xml, .md, anything — and never your editor's own edit/write tools. It takes file_path + old_string + new_string exactly like an ordinary edit tool and never refuses a file type; to create a file that doesn't exist yet, pass old_string: "" and the whole file as new_string. Because it knows where your text landed, it works out which function/class you changed automatically: no node_id to look up, no code_snapshot to send back, and no stage_change call. It answers with every caller of what you changed. Writes landing outside any function (markup, config, an import) get no graph node — normal and expected, not a failure — but the whole-file change is still staged for the local activity log, so commit_changes makes it revertable there like any other edit.
7. stage_change is now only for what no parser can read: a language with no AST support (.py, .go, .java, .cs, .rb, .php, .rs, .swift, .kt, .dart). edit_node still writes those files, and its response tells you when it couldn't trace one — so never guess. One call per node, not per file, never batched for later. On a long task, call commit_changes at natural checkpoints too (not only once at the very end) — waiting until the whole task is "done" is how staged work gets left uncommitted when a session runs long.
8. Scope: the graph is source code only (functions/classes/logic). stage_change will be REJECTED for stylesheets, markup, JSON/config, docs, images, or any other non-code asset. Do not stage those files — they have no callers/callees to resolve and only bloat the graph.
9. commit_changes REQUIRES a message AND a reasoning — the call fails without either. message is the user's request, verbatim, that led to this commit; it builds a local, private, never-pushed activity log (devsmind view → Activity) grouping your work by request and letting the user revert a request as a whole. Pass the exact same text again on a later commit that's still answering the same request — that merges them into one entry instead of splitting it. reasoning (what_changed/why/goal) is ONE object covering everything staged since the last commit — a commit is one logical change, so it gets one why, recorded against every node it touches, not one per edit_node/stage_change call.
10. commit_changes also REFUSES any batch containing a brand-NEW node with no description — a description is what makes that node findable later by a natural-language search_nodes query instead of only by its exact identifier. If edit_node or stage_change just created a node, call add_description with it (1-3 sentences of what it does and the domain concepts involved — never a restatement of the name) before commit_changes will accept it. Nothing staged is lost by the refusal; retry the same commit_changes call once it's described. Existing nodes are never gated by this — only ones new this commit.
11. A workflow is a named log of how ONE piece of functionality grew, across many sessions — read it to learn how the code got this way. start_session tells you if there is a recent one worth continuing; otherwise, when starting work that might belong to an existing multi-session feature, call workflow_list. If a description matches, ask the user before continuing it, then workflow_bind to attach THIS session. Binding is local to you: it never moves, pauses, or steals anyone else's workflow, and two sessions can work different ones at the same time.
12. Once bound, commit_changes logs a step for you automatically — you do NOT need workflow_add_step for ordinary code work. Call it for the thing a commit cannot express: a DECISION OR RESEARCH FINDING THAT CHANGED NO CODE ("evaluated X, rejected it because Y"), attaching the docs behind it via doc_paths. That is the one kind of knowledge nothing else keeps — git has the diff, history has the per-node reasoning, but neither records what was considered and rejected. If you did work while unbound, or on the wrong workflow, workflow_sync attaches it afterwards from your local activity log: it previews first and only writes when you pass confirm:true, so nothing has to be got right in the moment.
13. commit_changes also REQUIRES a feedback object (5 fields) — this is the only channel that improves DevsMind over time, so answer it for real, not as a formality. Before writing "none" on any field, actually check: did anything in THIS task take an extra tool call, a guess, a re-read, or a wrong turn? There almost always is something, even on an easy task — a specific one-line answer with evidence (file:line) is far more useful than a reflexive "none". "none" is correct only when you genuinely paid attention and nothing applies. Noticed something worth reporting but aren't committing right now (or don't want to wait until you are)? Call add_feedback directly — same 5 categories, but any one or more, nothing required, no commit needed. Passing evidence (file + snippet) on a graph_problem/edge_problem gets it verified fresh at call time and marked confirmed instead of suspected.`;

// Shared node-type taxonomy description, reused by update_history and stage_change.
const NODE_TYPE_DESCRIPTION =
  'The type of node. Be highly specific and framework-aware. Choose from the taxonomy below (or use a custom value if nothing fits).\n\n' +
  'UNIVERSAL: function | method | class | abstract_class | interface | type_alias | enum | constant | variable | module | namespace | decorator\n\n' +
  'NESTJS: nest_module | nest_controller | nest_service | nest_provider | nest_guard | nest_interceptor | nest_pipe | nest_filter | nest_decorator | nest_middleware | nest_gateway | nest_resolver | nest_schema | nest_dto\n\n' +
  'EXPRESS/FASTIFY/KOA/HONO: route_handler | middleware | router\n\n' +
  'SPRING (Java): spring_controller | spring_service | spring_repository | spring_component | spring_bean | spring_config | spring_entity\n\n' +
  'DJANGO/FASTAPI (Python): django_view | django_model | django_serializer | django_form | django_signal | fastapi_router | fastapi_dependency\n\n' +
  'GO: go_handler | go_middleware | go_struct | go_interface | go_func\n\n' +
  'RUST: rust_struct | rust_impl | rust_trait | rust_enum | rust_fn | rust_macro\n\n' +
  'REACT: react_component | react_hook | react_context | react_hoc | react_page\n\n' +
  'NEXT.JS: next_page | next_layout | next_api_route | next_server_action | next_middleware\n\n' +
  'VUE: vue_component | vue_composable | vue_directive | vue_store_module\n\n' +
  'ANGULAR: ng_component | ng_service | ng_directive | ng_pipe | ng_module | ng_guard | ng_interceptor | ng_resolver\n\n' +
  'SVELTE: svelte_component | svelte_store | svelte_action\n\n' +
  'ORM — PRISMA: prisma_model | prisma_query | prisma_migration\n' +
  'ORM — TYPEORM: typeorm_entity | typeorm_repository | typeorm_migration\n' +
  'ORM — MONGOOSE: mongoose_model | mongoose_schema\n' +
  'ORM — SQLALCHEMY: sqlalchemy_model | sqlalchemy_query\n' +
  'ORM — SEQUELIZE: sequelize_model | sequelize_migration\n\n' +
  'REST/API: api_endpoint | rest_controller\n' +
  'GRAPHQL: graphql_resolver | graphql_query | graphql_mutation | graphql_subscription | graphql_schema | graphql_directive\n' +
  'GRPC/PROTO: grpc_service | grpc_method | proto_message\n' +
  'WEBSOCKET: ws_gateway | ws_handler\n' +
  'MESSAGE QUEUE: mq_producer | mq_consumer | mq_handler\n\n' +
  'CONFIG/AUTH: config_loader | env_config | feature_flag | auth_guard | auth_strategy | jwt_util | permission_policy\n' +
  'OBSERVABILITY: logger | metric | trace_span\n' +
  'CLI: cli_command | cli_option\n' +
  'SCRIPTS: build_script | migration_script | seed_script\n' +
  'TESTS: test_suite | test_case | test_helper | mock | fixture\n' +
  'UTILITY: util_function | helper | transformer | validator | formatter';

// Shared `description` field schema, reused by stage_change and add_description. This is what
// makes search_nodes findable by natural language — an identifier alone is a handful of words;
// this is where the domain vocabulary (login/auth/sign-in, cart/basket, ...) actually lives.
const DESCRIPTION_FIELD_SCHEMA = {
  type: 'string',
  description:
    '1-3 sentences of PURPOSE, not a restatement of the name — what this does and the domain concepts involved, using the words a developer would actually search by. "verifyCredentials verifies credentials" is rejected: it adds no vocabulary beyond the identifier itself. "Checks a user\'s email and password against stored hashes during login/sign-in, issuing a session token on success" is the shape wanted — it surfaces user, email, password, login, sign-in, session, token, none of which appear in the identifier.'
};

// Cache database connections by their resolved path to avoid re-opening constantly
const dbCache = new Map<string, DevMindDatabase>();

/**
 * The single project this server process is bound to, resolved ONCE at startup from `devsmind
 * start`'s `--path` (or auto-detected from its cwd). When set, the server is "stateful" in the
 * only sense that matters to a caller: it already knows which brain it serves, so every tool
 * stops requiring a `devmind_path` arg and `resolveDevmindPath` short-circuits to this. Left null
 * only for the legacy/unbound modes (in-process tests, or a server started somewhere with no
 * brain to auto-detect), where the old per-call `devmind_path` behavior is preserved unchanged.
 */
let boundDevmindPath: string | null = null;

/** Binds this process to one project's `.devmind` dir. Called once at server startup. */
export function bindDevmindPath(devmindPath: string): void {
  boundDevmindPath = path.resolve(devmindPath);
}

/** The bound project path, or null if this server is running unbound (tests / legacy). */
export function getBoundDevmindPath(): string | null {
  return boundDevmindPath;
}

// Walk up from a start directory to find a .devmind folder containing config.json
function findDevmindDir(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, '.devmind');
    if (fs.existsSync(path.join(candidate, 'config.json'))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Resolve devmind_path from args, falling back to auto-detect from cwd
function resolveDevmindPath(rawPath: unknown): string {
  // Bound (stateful) server: it already knows which brain it serves, resolved once at startup.
  // Whatever `devmind_path` a caller still sends is ignored — a single-project server has exactly
  // one correct answer, and honoring a stray arg would just reintroduce the cross-project mistakes
  // this binding exists to remove.
  if (boundDevmindPath) return boundDevmindPath;

  const given = rawPath != null && String(rawPath) !== 'undefined' ? String(rawPath).trim() : '';
  if (given) {
    const resolved = path.resolve(given);
    if (fs.existsSync(resolved)) return resolved;
    // Try forward-slash variant (AI sometimes sends forward slashes on Windows)
    const normalized = path.resolve(given.replace(/\//g, path.sep));
    if (fs.existsSync(normalized)) return normalized;
    throw new Error(`devmind_path does not exist: "${resolved}". Make sure you pass the exact DEVMIND_PATH from your workspace rules.`);
  }
  // Not provided — auto-detect from where devsmind start was run
  const autoDetected = findDevmindDir(process.cwd());
  if (autoDetected) return autoDetected;
  throw new Error(`devmind_path was not provided and no .devmind directory was found by walking up from: "${process.cwd()}". Pass devmind_path explicitly.`);
}

/**
 * A required string argument, or a thrown error naming exactly what's missing.
 *
 * `String(args.x)` alone turns a missing/omitted field into the literal 4-character string
 * "undefined" instead of failing — the call "succeeds" and that garbage gets permanently
 * written wherever the field goes (a workflow's `name`, a step's `summary`, ...). Route every
 * genuinely required string field through this instead; the top-level try/catch in the tool
 * dispatcher turns the throw into a clean `isError` response.
 */
function requireStr(args: Record<string, unknown>, field: string, tool: string): string {
  const v = args[field];
  if (v === undefined || v === null || v === '') {
    throw new Error(`${tool} needs '${field}' — it was not provided.`);
  }
  return String(v);
}

/**
 * Coerce an agent-supplied number into a sane range, falling back when it isn't one at all.
 *
 * Module-scoped rather than local to a handler because the alternative has already bitten us:
 * this used to live inside `case 'get_node_code'`'s `if (live.exists)` branch, so every OTHER
 * numeric param was left on a bare `Number(...)`. That is not a cosmetic gap — `Number('abc')`
 * is `NaN`, and `NaN` poisons whatever it flows into. A budget of `NaN` makes every
 * `spent + len > budget` comparison false, i.e. an UNLIMITED budget; a `limit` of `NaN` makes
 * `slice(0, NaN)` return an empty array, which reads to the agent as "nothing found" while the
 * sibling `*_total` field says otherwise. `??` does not catch either case — only an explicit
 * `Number.isFinite` check does.
 */
function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Node-count safety valve for a graph embedded in a `get_node_code` response — deliberately far
 * below `getGraph`'s own 500 default, since this graph rides along with code, imports, neighbors
 * and history rather than being the whole payload. */
const GRAPH_MAX_NODES = 120;

/**
 * Default char budget for `graph_code` on the `get_node_code` path, well under `getGraph`'s own
 * 60000 fallback for the same reason `GRAPH_MAX_NODES` is: it is one section of a composite
 * response, not the response. 60000 chars is ~15k tokens, which on an ordinary 3-hop chain
 * overflowed the client's inline limit — the response then got spilled to a file that ALSO
 * truncated on read, turning the tool's headline feature into a dead end. Passing this
 * explicitly means `getGraph`'s 60000 only ever applies to the legacy `get_node_graph` caller.
 */
const GRAPH_CODE_BUDGET_DEFAULT = 24_000;

/**
 * Serialized size past which a `search_nodes` response gets trimmed. A heuristic on characters,
 * not on the client's real token limit — which we cannot see. It does not make a dead end
 * impossible; it makes one much less likely, and (via the `compacted` note) never silent. The
 * failure it targets: a ~56KB result exceeded the client's inline cap, spilled to a file, and
 * that file then truncated on read too, leaving the agent hand-writing regexes against a
 * single-line JSON blob to recover fields.
 */
const SEARCH_COMPACT_THRESHOLD = 24_000;

const COMPACT_NOTE_TIER1 =
  'Response was trimmed to fit: per-file match_counts, matched_terms, aliases and created_at were dropped, and sample lines were cut to 2 per file/node at 200 chars. All COUNTS (nodes_total, files_total) are exact and untrimmed. Pass compact:false for the full payload, or narrow with path/limit/offset.';
const COMPACT_NOTE_TIER2 =
  'Response was trimmed hard to fit: this is a triage list only — sample lines and code_matches were dropped entirely. All COUNTS (nodes_total, files_total) are exact and untrimmed. Pick the nodes that matter from confidence/relevance and call get_node_code on them, or re-run narrowed with path/limit for the evidence lines.';
/** Default page size for `list_nodes`. Sized so a page of full node rows (description included)
 * comfortably clears the threshold above, since discovery is usually a scan-and-pick, not a dump. */
const LIST_NODES_DEFAULT_LIMIT = 100;

/** Max characters of reasoning copied onto a workflow step — a timeline of 200 steps has to stay
 * readable in one response, and the full text is always still on the history rows. */
const STEP_REASONING_CAP = 2000;

/**
 * The part of a commit's reasoning worth carrying onto a workflow step: WHY it was done, what it
 * was for, and what was decided.
 *
 * Deliberately not `formatReasoning`, which emits all eight labels unconditionally — including the
 * usually-empty `Requirement:`/`Previous state:` and a `Developer:`/`Model:` pair already recorded
 * on both the history row and the activity message. On a timeline those are pure noise repeated
 * once per step. `what_changed` is skipped too: it is what `summary` already says.
 */
function workflowReasoningText(reasoning: unknown): string | undefined {
  if (typeof reasoning === 'string') return reasoning.slice(0, STEP_REASONING_CAP) || undefined;
  if (!reasoning || typeof reasoning !== 'object') return undefined;
  const r = reasoning as Record<string, unknown>;
  const parts = [
    r.why ? `Why: ${String(r.why)}` : '',
    r.goal ? `Goal: ${String(r.goal)}` : '',
    r.decision ? `Decision: ${String(r.decision)}` : ''
  ].filter(Boolean);
  return parts.length ? parts.join('\n').slice(0, STEP_REASONING_CAP) : undefined;
}

const LIST_NODES_COMPACT_NOTE =
  'Page was trimmed to fit: only id, name, type and file_path are shown per node. `total` is exact. Call get_node_code on whichever node you want the details of, or re-request a smaller page with a lower limit.';

const COMPACT_NOTE_FORCED =
  'Compact requested: triage fields only — no sample lines or code_matches. All COUNTS are exact. Call get_node_code on whichever node you pick, or re-run with compact:false for the full payload.';

/**
 * The "verify before write" gate every batch graph-fix correction tool goes through — evidence
 * captured weeks earlier by a working agent may have gone stale (the file moved, the line no
 * longer says what it said), and a correction tool must never trust a claim it can't still check.
 * Cheap by design (existence + substring, not a full re-resolve): a full AST re-resolution would
 * be circular — if the resolver could already prove the link, this correction tool wouldn't be
 * needed in the first place.
 */
function verifyEvidence(evidenceFile: string, evidenceSnippet?: string): { ok: boolean; reason?: string } {
  if (!fs.existsSync(evidenceFile)) {
    return { ok: false, reason: `evidence file no longer exists on disk: ${evidenceFile}` };
  }
  if (evidenceSnippet) {
    let content: string;
    try {
      content = fs.readFileSync(evidenceFile, 'utf-8');
    } catch (err) {
      return { ok: false, reason: `could not read evidence file: ${(err as Error).message}` };
    }
    if (!content.includes(evidenceSnippet)) {
      return { ok: false, reason: `evidence snippet no longer found in ${evidenceFile} — it may have gone stale since it was reported; re-verify against the current code before retrying` };
    }
  }
  return { ok: true };
}

function getDatabase(devmindPath: string): DevMindDatabase {
  const dbFile = path.join(devmindPath, 'brain.db');
  if (!dbCache.has(dbFile)) {
    dbCache.set(dbFile, new DevMindDatabase(dbFile));
  }
  return dbCache.get(dbFile)!;
}


/**
 * Closes every cached DB connection (best-effort) and clears the cache. Normally only reached via
 * the SIGINT/SIGTERM shutdown handlers below; exported so tests can release a fixture's cached
 * connection between cases instead of leaking a locked `brain.db` handle until the test process exits.
 */
export function cleanup() {
  for (const [dbPath, db] of dbCache.entries()) {
    try {
      db.close();
    } catch (err) {
      // best-effort close
    }
  }
  dbCache.clear();
}

/**
 * Read-only tools that DON'T require a session_id. A session exists to tie a request's writes
 * together on the local activity log and make them revertable as a unit — reads mutate nothing,
 * so gating them buys nothing and only adds friction to the very first thing an agent does in a
 * conversation (usually a search). Their handlers never touch `sessionId`, verified case-by-case;
 * they neither get session_id injected into their schema nor get rejected when it's absent.
 *
 * `get_activity_log` is here too, but for a subtler reason: it declares its OWN optional
 * `session_id` (a filter — "show me just this session's activity"), so exempting it stops the
 * injection loop from force-promoting that optional filter into a required gate.
 *
 * NOTE: every entry here is a read. Adding a WRITE tool to this set would let it run without a
 * session and silently drop its edits out of the revert/grouping model — do not.
 *
 * `get_node_history`, `get_node_graph`, `search_decisions`, `get_orphaned_nodes` are retired —
 * unadvertised in ListTools, folded into `get_node_code`/`search_nodes`/`analyze_graph`. They
 * MUST stay in this set anyway: the runtime session gate below consults it for every call
 * including unlisted ones, so removing them here would make their still-live retained handlers
 * start failing on a missing session_id for any direct/legacy caller.
 */
const SESSION_EXEMPT_READ_TOOLS = new Set<string>([
  'list_nodes',
  'get_node_code',
  'get_node_history',
  'get_node_graph',
  'search_nodes',
  'search_decisions',
  'get_orphaned_nodes',
  'get_visualizer_url',
  'read_graph_feedback',
  'workflow_get_context',
  // `workflow_search`/`workflow_read_artifact`/`workflow_get_steps` are retired and their handlers
  // are gone, so they no longer belong here. `workflow_list` is NOT exempt any more either: it
  // reports `bound_workflow_id`, which is a per-session fact — without a session_id it could only
  // ever answer null, which reads as "you are on nothing" rather than "I cannot tell".
  'get_activity_log'
]);

/**
 * Creates and wires up a DevsMind MCP Server instance.
 * When the process is bound to one project (`bindDevmindPath`, the normal `devsmind start` path),
 * every tool serves that brain and no `devmind_path` arg is required or advertised. Unbound (the
 * in-process test path, or a server started with no brain to auto-detect), it falls back to the
 * legacy behavior: each call carries `devmind_path` and opens the db from there.
 * Exported so tests can drive tools in-process (e.g. via an InMemoryTransport pair) without
 * binding a real port.
 */
export function createMcpServer(): Server {
  const server = new Server(
    { name: 'devsmind-server', version: DEVSMIND_VERSION },
    {
      capabilities: { tools: {} },
      instructions: DEVSMIND_INSTRUCTIONS
    }
  );

  // â”€â”€ Tool Definitions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [
        {
          name: 'start_session',
          description:
            'Call this ONCE, as the very first DevsMind call of a conversation — before any search, read, or edit. It mints a session_id that you must then pass on every other DevsMind call for the rest of this conversation (every tool requires it). Sessions are what ties a whole request\'s edits together on the local Activity log (`devsmind view` → Activity) and what makes a request revertable as one unit. Do not invent a session_id yourself and do not reuse one from a different conversation — if you are resuming a conversation that already called start_session earlier (visible in the reloaded history), reuse that same id instead of starting a new one; otherwise always start fresh.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              label: { type: 'string', description: 'Optional short human-readable name for this session (e.g. what the user asked for), shown on the Activity page.' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'list_nodes',
          description:
            'Enumerate the nodes matching optional type and file-path filters — the "what exists here" call for a component, package, or directory (use search_nodes when the question is "find the thing that does X"). PAGED: it answers with `{nodes, total, offset}`, where `total` is the TRUE number of matches and `nodes` is one page of at most `limit` (default 100). If `total` is larger than what you got back, `truncated` and a `hint` say so and name the exact next call — never read a short page as "that is all of it". Prefer narrowing with `type`/`file_path` over paging through a whole repo. A page that is still oversized comes back with only id/name/type/file_path per node plus a `compacted` note; `total` stays exact regardless.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: {
                type: 'string',
                description: 'Absolute path to the .devmind directory'
              },
              type: {
                type: 'string',
                description: 'Optional filter by exact node type (e.g. nest_controller, react_component, function)'
              },
              file_path: {
                type: 'string',
                description: 'Optional filter by file path substring (e.g. "src/components" or specific file name)'
              },
              include_deprecated: {
                type: 'boolean',
                description: 'Optional flag to include deprecated nodes (default: false)'
              },
              limit: {
                type: 'number',
                description: 'Max nodes in this page (default 100, max 500). `total` always reports the true match count regardless.'
              },
              offset: {
                type: 'number',
                description: 'Skip this many nodes before the returned page (default 0). Use with `total` to page through everything; results are stably ordered by file path then name, so pages never overlap or skip.'
              }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'get_node_code',
          description:
            "The ONE node-read call — a single function/class's CURRENT source code plus everything around it that a raw file read used to be the only way to get. Call this instead of reading a file whenever you need one specific entity: reading the raw file instead means the graph never learns you looked at it, AND misses everything this call adds on top of the raw text. The code is current and can be trusted as-is; if the symbol can no longer be found in its file (renamed/moved/deleted, or not a TS/JS file), the last known snapshot is returned instead so you still get something usable. `exists: false` means there is no code on file for this node at all.\n" +
            "ALWAYS included, at no extra cost — do not re-open the file for any of this: `name`/`type`/`signature`/`description`/`deprecated` (the node's own metadata — `description` especially is the highest-signal field there is, a human-written summary of purpose); `imports` (the file's ES `import` lines — does NOT capture `require()`/dynamic `import()`/`export…from` re-exports — what an unqualified identifier resolves to, e.g. is `formatDate` from `date-fns` or a local util); `uses_nodes`/`used_by_nodes` (up to 20 named callees/callers per direction, with `uses`/`used_by` always reporting the TRUE total even when the list is capped — page a hub node's full list with `neighbors_offset`); `file_outline` (up to 40 OTHER declarations in this file — consts, types, sibling helpers, whether or not they're graph nodes — so you can tell 'was this renamed?' or 'what else is nearby' without opening the file); `recent_history` (the last 3 changes' reasoning ONLY, no code, since the code above already IS current).\n" +
            "Reach further in the SAME call instead of a separate tool: `graph_depth`/`graph_direction` (1-10, default off) walks the TRANSITIVE graph past the always-included direct neighbors — use `graph_direction:\"in\"` before changing this node's signature to see the full blast radius, or `graph_direction:\"out\"` to trace a call flow; add `graph_code:true` to pull that whole flow's source in one round trip. `history:\"full\"` (default `\"recent\"`) returns every revision with diffable before/after edits, pageable with `history_limit`/`history_offset` — this is what used to be a separate get_node_history call. `history:\"none\"` skips history entirely. `file_outline:false` omits the outline. Every capped section says so honestly (`*_truncated`, `*_hint`) — a hint means there is more, reachable in this same call, not a dead end.",
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              node_id: { type: 'string', description: 'Unique identifier for the node' },
              neighbors_limit: { type: 'number', description: 'Max named callers AND max named callees returned, each direction (default 20, max 200). `uses`/`used_by` counts are always exact regardless of this cap. Pass 0 to skip the name lists and get counts only — useful on a node you already know is a hub.' },
              neighbors_offset: { type: 'number', description: 'Skip this many named neighbors (each direction) before the returned page (default 0). Pairs with `used_by_truncated`/`used_by_hint` to page a hub node\'s full caller list without a separate tool call.' },
              graph_depth: { type: 'number', description: 'Walk the TRANSITIVE dependency graph this many hops past the node itself (default 0 = off; 1-10). Depth 1 adds nothing over the always-included direct neighbors — use 2-3 to trace a real call flow or a deep blast radius. Same traversal the old get_node_graph tool ran.' },
              graph_direction: { type: 'string', enum: ['out', 'in', 'both'], description: '"out" = callees only, transitively (a call flow — use for tracing). "in" = callers only (impact analysis / blast radius before a signature change). "both" = neighborhood in both directions (default). Only applies when graph_depth >= 1.' },
              graph_code: { type: 'boolean', description: 'Attach each graph node\'s current source, read live from disk (default false). graph_depth:3 + graph_direction:"out" + graph_code:true pulls an entire call flow\'s code in this same call — this is the direct replacement for get_node_graph include_code:true.' },
              graph_code_budget: { type: 'number', description: 'Max total characters of graph-node code, spent nearest-the-root first (default 24000, max 200000). Only applies when graph_code is true. When the budget runs out, the nodes that missed out are named in `graph.code_omitted_node_ids` — fetch those with get_node_code, or re-issue with a bigger budget. Raising this is what gets you MORE code; it will not resurrect `graph.nodes_no_code_available` nodes, whose source genuinely could not be found.' },
              history: { type: 'string', enum: ['none', 'recent', 'full'], description: '"recent" (default) = up to `history_limit` past changes\' REASONING only, no code — cheap enough to always look at. "full" = the same entries but with each revision\'s code_snapshot AND diffable before/after edits attached — the complete payload the old get_node_history tool returned, call it here before refactoring instead of a separate tool. "none" = skip history entirely.' },
              history_limit: { type: 'number', description: 'History entries to return, newest first (default 3 for "recent", 5 for "full"; max 25). `history_count` always reports the true total regardless.' },
              history_offset: { type: 'number', description: 'Skip this many history entries before the page (default 0) — how you reach revision 12 of 40 without an unbounded dump.' },
              file_outline: { type: 'boolean', description: 'Every OTHER declaration in this file — name, kind, line range, node_id where one exists — up to 40, nearest this node first (default true). Answers "what else is here" and "was this renamed out from under me" without opening the file. Turn off only when genuinely token-tight; for a COMPLETE enumeration of a whole file or directory instead, use list_nodes with file_path.' }
            },
            required: ['devmind_path', 'node_id']
          }
        },
        // NOTE: `update_history`, `add_node`, and `add_connection` are intentionally NOT listed
        // here. They are deprecated in favour of `stage_change` + `commit_changes` (to avoid
        // confusing the AI with overlapping write tools), but their handlers are retained below
        // so any direct/legacy call still works.
        // ────────────────── Indexing tools ─────────────────────────────────────────
        {
          name: 'index_start',
          description:
            'Initialize an indexing session. Scans all configured repos, counts files, creates a scratchpad to track progress. Returns the full file list per repo so the AI can begin reading and indexing files. IMPORTANT: You must index natively in-chat using MCP tools. NEVER write or execute external scripts (like Python or custom scripts) to index files.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'index_checkpoint',
          description:
            'Save current indexing progress to the scratchpad. Call this every ~10 files so progress survives a context reset.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              last_file_indexed: { type: 'string', description: 'Absolute path to the last file that was fully indexed' },
              files_done: { type: 'number', description: 'Total files indexed so far' },
              nodes_created: { type: 'number', description: 'Total nodes created so far' },
              connections_created: { type: 'number', description: 'Total connections created so far' },
              current_repo: { type: 'string', description: 'Name of the repo currently being indexed' },
              repos_done: {
                type: 'array',
                items: { type: 'string' },
                description: 'Names of repos fully indexed so far'
              }
            },
            required: ['devmind_path', 'files_done', 'nodes_created']
          }
        },
        {
          name: 'index_continue',
          description:
            'Read the scratchpad and return exactly where indexing left off. Use this to resume after a context reset. IMPORTANT: You must index natively in-chat using MCP tools. NEVER write or execute external scripts (like Python or custom scripts) to index files.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'index_complete',
          description:
            'Mark the indexing session as complete. Call this when all files in all repos have been indexed.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'edit_node',
          description:
            "Write ANY file in this project. Use this for EVERY edit AND every new file, in place of your editor's own edit/write tools — .ts, .js, .vue, .css, .json, .xml, .md, .py, anything. It never refuses a file for being the wrong type, and it works exactly like an ordinary edit tool: pass `file_path`, the exact `old_string` to find, and the `new_string` to put there. To CREATE a file that doesn't exist yet, pass `old_string: \"\"` and the whole file as `new_string` (parent directories are made for you).\n\n" +
            "What it does that a plain edit tool cannot: it knows WHERE your text landed, so it works out which function/class you actually changed — no node_id to look up, no code_snapshot to send back, no follow-up stage_change call. That covers code you just added and files you just created, since the code is on disk by the time it looks. In return it tells you every CALLER of what you changed (i.e. what you may have just broken), what it calls out to, and the reasoning previously recorded against it.\n\n" +
            "Writes that don't land inside any function — markup, config, an import line, a stylesheet — get no graph node. That is a normal, expected outcome, not a failure: the file is still written, and the whole-file change is staged for the local activity log regardless, so `commit_changes` still makes it individually revertable in `devsmind view` -> Chat. So there is never a reason to reach for another edit or write tool.\n\n" +
            "Nothing reaches the graph — or the activity log — until commit_changes, where you give ONE `reasoning` covering everything staged since the last commit. For renames use rename_node.\n\n" +
            "If this edit creates exactly ONE new function/class (the common case), pass `description` in this same call — you already know what you just wrote, so there is no reason to wait for commit_changes to refuse it and make a separate add_description round trip. When an edit touches more than one symbol, `description` is ignored (ambiguous which one it's for); use add_description for those after this call.",
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              file_path: { type: 'string', description: 'The file to write. It does not need to exist yet.' },
              old_string: { type: 'string', description: 'The exact text to replace, matched byte-for-byte including indentation. Must appear exactly once in the file unless replace_all is true. Pass "" to CREATE a file that does not exist yet.' },
              new_string: { type: 'string', description: 'The text to put in its place — or, when creating a file, its entire contents. Pass an empty string to delete the matched text.' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match (default false). Every occurrence is traced, so an edit hitting three functions records all three.' },
              description: {
                ...DESCRIPTION_FIELD_SCHEMA,
                description: DESCRIPTION_FIELD_SCHEMA.description + ' Only applies when this edit touches exactly one function/class — ignored otherwise, since it would be ambiguous which touched symbol it describes.'
              }
            },
            required: ['devmind_path', 'file_path', 'old_string', 'new_string']
          }
        },
        {
          name: 'stage_change',
          description:
            `Stage ONE changed code node (function/class/method/etc.) into a buffer, right after you finish editing it — don't wait until the whole task is done. Call once per NODE, not once per file: a file with 3 changed functions is 3 calls. SCOPE: source code only — ${Array.from(INDEXABLE_EXTENSIONS).sort().join(', ')}. Rejected for stylesheets, markup, JSON/config, docs, or other non-code assets (no callers/callees to resolve). Pass only the code; connections are resolved automatically by commit_changes, not by you. Staging is buffered on disk and survives a context reset, but is inert until commit_changes runs — that's also where you give the one \`reasoning\` covering everything staged since the last commit.`,
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              node_id: { type: 'string', description: 'Unique identifier for the node (e.g. "CartService.applyPromoCode" or "calculateDiscount")' },
              file_path: { type: 'string', description: 'Source file path where the node is located' },
              code_snapshot: { type: 'string', description: 'Full source code content of the node at this moment' },
              name: { type: 'string', description: 'Display name of the node (optional, inferred if omitted)' },
              type: { type: 'string', description: '(optional, defaults to function) ' + NODE_TYPE_DESCRIPTION },
              signature: { type: 'string', description: 'Parameter types + return type signature (optional)' },
              description: DESCRIPTION_FIELD_SCHEMA
            },
            required: ['devmind_path', 'node_id', 'file_path', 'code_snapshot']
          }
        },
        {
          name: 'add_description',
          description:
            'Give a natural-language description to one or more nodes that don\'t have one yet. This is what `search_nodes` matches against, so it is the ONLY way a teammate\'s natural-language question ("where do we handle X") finds this code later — an identifier alone rarely does. Two situations call for this: (1) `commit_changes` refused because a NEW node from this turn has no description — call this with exactly those node_ids, then call commit_changes again; (2) you noticed an EXISTING committed node has no description (or a poor one) and want to add/fix it directly, which writes immediately with no commit needed. Write 1-3 sentences describing PURPOSE — what it does and the domain concepts involved — using the words a developer would actually search by (e.g. mention "login"/"sign-in"/"authentication" together, not just whichever one the identifier happens to use). Never just restate the identifier: "verifyCredentials verifies credentials" is rejected — it adds no findable vocabulary.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              descriptions: {
                type: 'array',
                description: 'One entry per node needing a description.',
                items: {
                  type: 'object',
                  properties: {
                    node_id: { type: 'string', description: 'The exact node_id, as given in the commit_changes rejection or from search/list_nodes.' },
                    description: DESCRIPTION_FIELD_SCHEMA
                  },
                  required: ['node_id', 'description']
                }
              }
            },
            required: ['devmind_path', 'descriptions']
          }
        },
        {
          name: 'add_feedback',
          description:
            'Record feedback ON DEMAND, outside of commit_changes — for when you notice something worth reporting (a wrong/stale graph node, a missing connection, a tool that helped or didn\'t, a rough edge) but are not committing anything right now, or don\'t want to wait until you are. `commit_changes` still collects the same 5 categories as a REQUIRED part of every commit — use this instead when there is nothing to commit, or the moment you notice something is not the moment you are about to commit.\n' +
            'Pass ANY ONE OR MORE of the five fields — unlike `commit_changes`\' `feedback`, none are required here, only that at least one is present. `graph_problem`/`edge_problem` take an object (`text` + optional `node_id` + optional `evidence`); `tools_used`/`dropped_and_why`/`devsmind_better` are plain strings, same meaning as their `commit_changes` counterparts.\n' +
            'Evidence matters here more than in `commit_changes`: pass `evidence` (`file` + optional `line`/`snippet`) on a graph/edge problem and it is VERIFIED FRESH at call time (the file must exist; if you gave a snippet, it must still be found in it) — a verified report is marked `confirmed` and is a strong candidate for the batch graph-fix session to act on directly. Omit evidence and it is still recorded, just `suspected` (lower priority, needs corroboration). A bad/stale evidence claim is REJECTED outright, not silently downgraded — re-check against current code and retry.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              graph_problem: {
                type: 'object',
                description: 'A node that was wrong, stale, missing, or wrongly split/merged.',
                properties: {
                  text: { type: 'string', description: 'What was wrong, specifically.' },
                  node_id: { type: 'string', description: 'The node this is about, if there is one exact node.' },
                  evidence: {
                    type: 'object',
                    description: 'Verified fresh at call time — see the tool description.',
                    properties: {
                      file: { type: 'string', description: 'Absolute path to the file that shows this is real.' },
                      line: { type: 'number', description: 'Line number, if useful (not itself verified — the snippet is).' },
                      snippet: { type: 'string', description: 'Exact text that must still be found in `file` for this to verify as confirmed.' }
                    },
                    required: ['file']
                  }
                },
                required: ['text']
              },
              edge_problem: {
                type: 'object',
                description: 'A missing or wrong connection between two nodes — e.g. get_node_code reported 0 used_by for something you found a real caller of.',
                properties: {
                  text: { type: 'string', description: 'What connection was missing or wrong, specifically.' },
                  node_id: { type: 'string', description: 'The node this is about, if there is one exact node.' },
                  evidence: {
                    type: 'object',
                    description: 'Verified fresh at call time — see the tool description.',
                    properties: {
                      file: { type: 'string', description: 'Absolute path to the file that shows this is real.' },
                      line: { type: 'number', description: 'Line number, if useful (not itself verified — the snippet is).' },
                      snippet: { type: 'string', description: 'Exact text that must still be found in `file` for this to verify as confirmed.' }
                    },
                    required: ['file']
                  }
                },
                required: ['text']
              },
              tools_used: { type: 'string', description: 'Which DevsMind tools actually helped and how — specific enough to be useful, not a restatement of the tool list.' },
              dropped_and_why: { type: 'string', description: 'Something you reached for instead of a DevsMind tool (raw grep, reading a whole file, guessing) and why the DevsMind tool did not do the job.' },
              devsmind_better: { type: 'string', description: 'One concrete way DevsMind could have made this easier — a missing field, a confusing description, a search that should have found something and did not.' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'commit_changes',
          description:
            'Flush THIS SESSION\'s buffered edit_node/stage_change entries in one atomic pass: creates/updates every staged node, writes every history snapshot with the ONE `reasoning` you give here, resolves all connections via local AST (auto-creating any referenced-but-missing nodes), then clears only this session\'s share of the buffer. Every entity staged since your last commit gets the SAME reasoning — a commit is one logical change, so it needs one why, not one per node. The staging buffer is shared by every session pointed at this .devmind directory, but a commit only ever touches entries YOUR session staged — another session\'s still-pending work (possibly in an unrelated file or repo) is never included and is never cleared out from under it; `other_sessions_pending` in the response tells you if any exist. If a workflow is currently active, this ALSO auto-records a step on its timeline from that reasoning — you do not need a separate workflow_add_step call for the normal case. Call commit_changes at natural checkpoints — after a batch of related nodes, or when switching context — not only once at the very end of a long task; a checkpoint commit can\'t be forgotten the way a single end-of-task one can. Always call it again before ending the turn if anything is still staged: an uncommitted turn leaves your own work out of the graph.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              message: { type: 'string', description: 'REQUIRED — the user\'s original request that led to this commit, verbatim. Powers a local, private-to-this-machine activity log (`devsmind view` → Activity) that groups your work by request and lets a request be reverted as a whole. Pass the SAME text again on a later commit that continues answering the same request — that merges them into one entry instead of two. Never pushed; nothing here reaches the shared graph.' },
              reasoning: {
                type: 'object',
                description: 'REQUIRED — why every entity staged since the last commit changed. This is the only record of it that will ever exist: the diff shows what changed, never why. Recorded against EVERY node this commit touches, not just one.',
                properties: {
                  what_changed: { type: 'string', description: 'Brief description of the change' },
                  why: { type: 'string', description: 'The reason this change was made' },
                  goal: { type: 'string', description: 'What was being achieved' },
                  requirement: { type: 'string', description: 'Ticket / issue / user request ID if applicable' },
                  previous_state: { type: 'string', description: 'What the code looked like before and why it was a problem' },
                  decision: { type: 'string', description: 'Architectural or implementation decision and why' },
                  developer: { type: 'string', description: 'Name of the developer (optional — a configured developer identity from `devsmind init` always overrides this)' },
                  model: { type: 'string', description: 'AI model name used' }
                },
                required: ['what_changed', 'why', 'goal']
              },
              feedback: {
                type: 'object',
                description:
                  'REQUIRED, every commit — this is the ONLY mechanism that makes DevsMind better over time instead of staying frozen at index time; nobody is reading your transcript, this field is the entire signal. Before writing "none" anywhere, actually pause and check each field against what just happened in THIS task — not "was there a catastrophe" but "was there one moment that took an extra tool call, a guess, a re-read, or a wrong turn". There almost always is one, even on an easy task, and a single honest sentence about it ("get_node_code showed 0 used_by for X but I found a real caller via grep at foo.ts:12" / "had to read the raw file because search_nodes missed the CSS class") is far more useful than a reflexive "none" — "none" is for when you genuinely paid attention and nothing applies, not the path of least resistance. A vague or fabricated entry helps nobody either — evidence (file:line) is what makes a report actionable weeks later. Never blocks or slows the commit; a thoughtful "none" is fine when it is true. `graph_problems`/`edge_problems` route to a local graph-fix queue a supervised session drains later. `tools_used`/`dropped_and_why`/`devsmind_better` route to a product-feedback log read by the DevsMind maintainers, not by any agent — `devsmind feedback` (CLI) surfaces both logs for a human to read.',
                properties: {
                  graph_problems: { type: 'string', description: 'A node that was wrong, stale, missing, or wrongly split/merged — with evidence (file:line or similar) if you have it. Genuinely "none" if the graph was accurate for everything you touched.' },
                  edge_problems: { type: 'string', description: 'A missing or wrong connection — e.g. get_node_code reported 0 used_by for something you found a real caller of via grep/reading code. Name the caller (file:line). Genuinely "none" if every connection you checked was correct.' },
                  tools_used: { type: 'string', description: 'Which DevsMind tools actually helped this task and how — specific enough to be useful (e.g. "get_node_code with graph_depth:3 + graph_code saved reading 4 files to trace the call flow"), not a restatement of the tool list.' },
                  dropped_and_why: { type: 'string', description: 'Anything you reached for instead of a DevsMind tool (raw grep, reading a whole file, guessing) and why the DevsMind tool did not do the job. If you never once stepped outside DevsMind this task, say so — that is a real, useful "none".' },
                  devsmind_better: { type: 'string', description: 'One concrete way DevsMind could have made this task easier — a missing field, a confusing tool description, a search that should have found something and did not. Specific beats generic; "none" only if you truly cannot think of one.' }
                },
                required: ['graph_problems', 'edge_problems', 'tools_used', 'dropped_and_why', 'devsmind_better']
              }
            },
            required: ['devmind_path', 'message', 'reasoning', 'feedback']
          }
        },
        {
          name: 'recheck_graph',
          description:
            'Recheck and prune spurious nodes/connections from the code graph. Removes primitives, language globals/built-ins, and nodes pointing to deleted/missing files, provided they have zero history entries (preserving change logs).',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              workspace_root: { type: 'string', description: 'Absolute path to the workspace root directory to resolve relative paths and verify files exist' }
            },
            required: ['devmind_path', 'workspace_root']
          }
        },
        // NOTE: `get_node_history` and `get_node_graph` are intentionally NOT listed here anymore.
        // `get_node_code` absorbed both: `history:"full"` (+ history_limit/history_offset) returns
        // exactly what get_node_history did, and `graph_depth`/`graph_direction`/`graph_code`
        // (+ graph_code_budget) run the identical BFS get_node_graph did — direct callers/callees
        // are now included in every get_node_code response by default, so the common case that
        // used to need a second tool call needs none. Their handlers are retained below so any
        // direct/legacy call still works.
        {
          name: 'search_nodes',
          description:
            'The ONE search call — it covers both the indexed graph AND the raw filesystem, so you never need to fall back to an external grep. Two independent inputs, pass either or both:\n' +
            '• `query` — a natural-language phrase (e.g. "where do we handle user login"). Drives the semantic/meaning layer and BM25. Use this for a concept you can describe but don\'t have exact terms for.\n' +
            '• `pattern` — a REAL regex, used exactly as you\'d give it to grep (alternation, escaped literals, character classes — nothing is re-escaped or split for you). Drives the file grep and code-body matching directly. Use this when you already know identifiers, an error string, or a structural shape (e.g. "heartRed|onLikeTap|item\\.liked" or "on\\w+Tap").\n' +
            'Passing only `pattern` is a first-class PRECISION mode: the semantic layer and the exact-identifier short-circuit are both skipped (a regex has no meaning to embed), so results are exact grep + code-body matches only — nothing ranked or blurred. Passing only `query` derives a literal OR-pattern from its significant words automatically, same as before. Passing both engages everything at once. At least one is required.\n' +
            'It returns TWO buckets:\n' +
            '• `nodes` (PRIMARY): the indexed graph — functions/classes found by exact identifier, then by three fused rankers: word-match (BM25 over name/id/path/description/reasoning), meaning-match (vectors over descriptions, so "authentication" finds a node described only as "sign-in"), and code-body-match (your pattern appearing inside a node\'s code, with the matching lines in `code_matches`). Each node leads with `confidence` (high/medium/low), `relevance` (0-100 relative to the top hit) and `found_by` (which layers matched it) — TRIAGE ON THOSE, not on which node name reads plausibly to you. `confidence` is corroboration across independent layers, which is evidence you cannot reconstruct by eye; a name that merely looks right is the single easiest way to pick the wrong node. `nodes_total` is the TRUE count found before the top-20 cap.\n' +
            '• `files` (LAST RESORT): a real grep of every configured repo (or just `path`, if given), ranked by relevance — this is how you find things the graph does NOT model: CSS, JSON, config, `.env`, markup, and any un-indexed code. Each entry has the file path, per-match counts, and sample matching lines — each sample line carries `symbol` when it falls inside a known function/class (the insight a plain grep can\'t give you: not just "line 87 matched" but "line 87, inside onLikeTap"). `files_total` is the TRUE count of matching files; `files_total` bigger than the number of entries returned means there\'s more — pass a bigger `offset` for the next page, don\'t assume "not there" from a capped list.\n' +
            'Every `nodes` entry also carries drill-in hooks: `uses`/`used_by` (outgoing/incoming connection counts) and `history_count` (revision count). If you are about to change this node\'s signature or behavior and `used_by` is non-trivial, call `get_node_code` on it FIRST — its `used_by_nodes` already names the direct callers, and `graph_depth`/`graph_direction:"in"` in that same call gets the full transitive blast radius. `used_by: 0` carries a `used_by_note` when the graph could not statically prove any caller (generated bindings, dynamic dispatch) — treat that as "unverified", not "unused".\n' +
            'Lockfiles (package-lock.json, yarn.lock, Podfile.lock, go.sum…) and build artifacts (*.min.js, *.map) are excluded by default, along with anything in this project\'s configured ignored_paths — a lockfile names every dependency in the tree, so it used to match almost any product term and crowd out the real source. `.env`, JSON and config are NOT excluded; those are what the files bucket is for. Scoping `path` straight at an excluded file returns nothing and says so in `scope_note` — read it directly rather than re-querying.\n' +
            'If a response would be too large it is trimmed automatically and a `compacted` field says exactly what was dropped; every COUNT stays exact, so a trimmed result is never mistakable for a complete one. Pass `compact:false` to demand the full payload, or `compact:true` to ask for a lean triage list up front.\n' +
            'It only surfaces real evidence: a search for something genuinely not in the codebase comes back with empty buckets + a `hint`, not padded guesses. `truncated: true` means the grep walk hit its time budget and results are partial.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              query: { type: 'string', description: 'Natural-language description of what you are looking for (a real phrase, e.g. "where do we handle user login"). Drives the semantic/meaning layer and BM25. Optional if `pattern` is given.' },
              pattern: { type: 'string', description: 'A real regex, used exactly as-is (not escaped, not split) — pass the same string you would give grep, e.g. "heartRed|onLikeTap|item\\.liked". Drives the file grep and code-body matching. Optional if `query` is given; when omitted, one is derived from `query`\'s own significant words. Passing this WITHOUT `query` is a precision-only mode: exact matches, no semantic ranking.' },
              path: { type: 'string', description: 'Optional: restrict the search to one folder or a single file (absolute path), instead of every configured repo. Rejected if it falls outside every configured repo — narrows the search space, never widens it.' },
              case_insensitive: { type: 'boolean', description: 'Case-insensitive matching (default: true) — the equivalent of grep -i. Prefer this over an inline (?i) regex flag: JavaScript throws on the leading (?i) form most tools use.' },
              offset: { type: 'number', description: 'Files-bucket pagination: how many matched files to skip before the returned page (default 0). Use with `files_total` to page through results beyond the default page size.' },
              limit: { type: 'number', description: 'Files-bucket pagination: max files to return in this page (default 25, max 200).' },
              compact: { type: 'boolean', description: 'Leave this OFF unless you have a reason. Omitted (the default) means AUTO: the full payload comes back when it fits, and is trimmed only if it would be too large — either way a `compacted` field says exactly what happened, so you are never guessing. Pass true to force a lean triage list up front (ids, names, paths, descriptions, confidence, drill-in counts — no sample lines or code_matches) when you already know you only need to pick a node. Pass false to demand the untrimmed payload regardless of size. Counts (`nodes_total`, `files_total`) are exact in every mode.' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'rename_node',
          description: 'Rename a code node ID (and optionally its display name), updating all its associations (connections and history).',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              old_node_id: { type: 'string', description: 'Current unique identifier for the node' },
              new_node_id: { type: 'string', description: 'New unique identifier for the node' },
              new_name: { type: 'string', description: 'Optional new display name for the node' }
            },
            required: ['devmind_path', 'old_node_id', 'new_node_id']
          }
        },
        {
          name: 'deprecate_node',
          description: 'Mark a code node as deprecated, removing all its connection mappings while retaining its entry and evolution history in the database. Use this if a function/class is deleted/removed from the codebase.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              node_id: { type: 'string', description: 'Unique identifier for the node to deprecate' }
            },
            required: ['devmind_path', 'node_id']
          }
        },
        // ── Batch graph-fix session tools ─────────────────────────────────────────────────
        // NOT for the normal working flow — these read/apply the graph-problem reports
        // `commit_changes`'s `feedback` param accumulates over time (see feedback.ts). Meant to
        // be run as a separate, deliberate session (days/weeks after the reports accumulate),
        // never live during ordinary edit/commit work. Every mutating tool here is
        // evidence-gated (re-verified against current code, not just trusted) and additive —
        // the graph only ever gets MORE complete from these, never silently pruned.
        {
          name: 'read_graph_feedback',
          description:
            'Reads every unprocessed graph-problem report accumulated from commit_changes\' `feedback` param, clustered by (node_id, category) and sorted by frequency — the SAME report surfacing many times means it is worth fixing first, and one correction (e.g. record_alias) often resolves an entire cluster at once. Start a batch graph-fix session with this call. Each entry carries `confidence` ("confirmed" = evidence was given, "suspected" = none) but treat confidence as a PRIORITY signal only — always re-verify against the current code before acting, since a report may be stale by the time this runs. After acting on a cluster (or explicitly deciding it does not apply), call mark_graph_feedback_processed with its entries\' ids so a later run does not re-surface it.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              include_processed: { type: 'boolean', description: 'Include already-processed entries too (default: false — normally you only want unprocessed ones).' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'mark_graph_feedback_processed',
          description: 'Marks graph-feedback entries as processed by id, so a later read_graph_feedback call does not re-surface them. Call this after you have acted on a cluster (applied a fix) OR explicitly decided it does not apply — either way, mark it done so the queue actually drains.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              feedback_ids: { type: 'array', items: { type: 'string' }, description: 'The `id` field of each feedback entry to mark processed (from read_graph_feedback\'s output).' }
            },
            required: ['devmind_path', 'feedback_ids']
          }
        },
        {
          name: 'link_nodes',
          description:
            'Adds a missing edge between two EXISTING nodes — the correction for a report like "get_node_code showed 0 used_by but X really calls Y". Evidence-gated: the evidence file must still exist and (if you give a snippet) must still contain it, checked fresh at call time — a stale claim is refused, not trusted. Prefer record_alias instead when the root cause is a generated/aliased binding (e.g. a framework hook) referencing many callers at once — one alias fixes them all, this fixes one edge.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              from_node_id: { type: 'string', description: 'The caller/source node id' },
              to_node_id: { type: 'string', description: 'The callee/target node id' },
              evidence_file: { type: 'string', description: 'Absolute path to the file proving this edge is real — checked to still exist.' },
              evidence_snippet: { type: 'string', description: 'A short excerpt from evidence_file proving the reference — checked to still be present in the file\'s CURRENT content.' }
            },
            required: ['devmind_path', 'from_node_id', 'to_node_id', 'evidence_file']
          }
        },
        {
          name: 'record_alias',
          description:
            'Attaches an alias to a node — one implementation, another exported handle it is ALSO referenced by (a generated hook, a renamed default-export import, a re-export). This is the preferred fix over link_nodes when the report is about a generated/aliased binding: ONE alias makes every caller of that name resolve correctly, not just the one you happened to find. Evidence-gated the same way as link_nodes. Additive only — merges with any aliases already on the node (from a deterministic detector, e.g. the RTK Query one, or an earlier correction), never overwrites them.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              node_id: { type: 'string', description: 'The node this alias belongs to' },
              alias: { type: 'string', description: 'The alternate name callers actually reference (e.g. a generated hook name)' },
              evidence_file: { type: 'string', description: 'Absolute path to the file proving this alias is real — checked to still exist.' },
              evidence_snippet: { type: 'string', description: 'A short excerpt proving the alias name is actually referenced there — checked to still be present in the file\'s CURRENT content.' }
            },
            required: ['devmind_path', 'node_id', 'alias', 'evidence_file']
          }
        },
        {
          name: 'merge_nodes',
          description: 'Merges from_node_id into into_node_id — for when a graph-problem report (or your own review) shows two node candidates were never really distinct entities. Reassigns all connections and history from from_node_id onto into_node_id, folds from_node_id\'s aliases (and its own name) into into_node_id\'s alias set, then deprecates from_node_id — nothing is hard-deleted, so this stays reversible.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              from_node_id: { type: 'string', description: 'The node to merge away' },
              into_node_id: { type: 'string', description: 'The node it should be merged into (this one survives)' }
            },
            required: ['devmind_path', 'from_node_id', 'into_node_id']
          }
        },
        {
          name: 'split_node',
          description: 'Splits an over-coarse node into several new ones — for when one node was extracted too broadly (e.g. a whole class where each method deserved its own node). Each name in new_symbols must be a REAL, separately-locatable declaration already in the ORIGINAL node\'s file (re-extracted deterministically via the AST, same as the indexer\'s own gap-fill path) — this carves out symbols that already exist, it never fabricates new code. A name that cannot be located is reported in `failed`, not silently dropped; the original node is only deprecated once at least one split actually succeeds.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              node_id: { type: 'string', description: 'The over-coarse node to split' },
              new_symbols: { type: 'array', items: { type: 'string' }, description: 'Exact symbol names to carve out of the node\'s file (e.g. method names of a class node)' }
            },
            required: ['devmind_path', 'node_id', 'new_symbols']
          }
        },
        {
          name: 'create_missing_node',
          description: 'Deterministically creates a node from a real declaration the indexer never extracted — for when a graph-problem report points at a symbol that genuinely exists in the code but has no node. Reuses the same AST-derived, no-LLM extraction the indexer\'s own gap-fill path uses; refuses (no node created) if the symbol cannot actually be located in the given file.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              file_path: { type: 'string', description: 'Absolute path to the file containing the symbol' },
              symbol_name: { type: 'string', description: 'The exact symbol name (or Class.method) to locate and create a node for' }
            },
            required: ['devmind_path', 'file_path', 'symbol_name']
          }
        },
        {
          name: 'flag_indexer_rule',
          description:
            'Records a candidate for a PERMANENT deterministic indexer rule (like the RTK Query hook detector) — for when several graph-problem reports turn out to be the same recurring pattern (e.g. "every report was this framework\'s generated-binding convention"). This does not change the graph itself; it is a note for a human to review and, if it recurs often enough, turn into a real detector so the same class of miss stops needing hand-fixes forever. Use evidence_count to reflect how many feedback entries this pattern explains — that is the priority signal for whoever reviews the log.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              pattern: { type: 'string', description: 'Short description of the recurring pattern' },
              evidence_count: { type: 'number', description: 'How many feedback entries this pattern was inferred from' },
              examples: { type: 'array', items: { type: 'string' }, description: 'A few representative examples (e.g. "file.ts:42"), not every occurrence' }
            },
            required: ['devmind_path', 'pattern', 'evidence_count', 'examples']
          }
        },
        {
          name: 'get_activity_log',
          description:
            'The one tool for "what changed" — replaces get_recent_changes/get_developer_activity/get_changes_by_requirement (all three removed; this covers everything they did, plus what none of them did: the actual FILES touched). One entry per commit_changes call, filterable by developer, a time window, one session, and/or requirement/ticket text — all filters compose (AND together). Each entry reports `files` (every file that commit touched — this is what "show me all the files you changed" needs, e.g. before writing tests against recent work), `node_ids`, `developer`/`created_at`/`request`/`summary`/`status`, and `source`. The response also includes `all_files` (every distinct file across the returned entries, flattened) and `total_matched` (how many matched BEFORE `limit` — compare with `total_messages` to detect truncation). TWO STORES: the local activity log is rich but gitignored, so it is empty on a teammate\'s clone or your second machine; committed graph history is shared by everyone but lossier. `source` picks between them and DEFAULTS TO AUTO — local first, shared history only if local has nothing, so a fresh clone still gets an answer. Use source:"both" for a team-wide view (your own local entries plus every session that did not run on this machine — no double-counting). Graph-backed responses carry a `caveats` array; read it before acting on them.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              source: {
                type: 'string',
                enum: ['auto', 'local', 'graph', 'both'],
                description: 'Which store to read. "auto" (default): local activity log, falling back to shared graph history only when local returns nothing — the right choice on a fresh clone. "both": local PLUS shared history for every session that did not happen on this machine — the only way to see TEAMMATES\' work when you also have local activity of your own, since auto stops at the first non-empty store. "local": this machine only (full fidelity — verbatim request text, revert status, whole-file edits). "graph": committed history only (shared, but status is always "applied", `request` degrades to the reasoning\'s Requirement field, and untraced whole-file edits are absent).'
              },
              developer: { type: 'string', description: 'Case-insensitive substring match on developer name/email (e.g. "AbialiDr"). Omit for all developers. On graph-backed entries this reads the Developer field recorded in the commit reasoning, and is null for commits made before a DEVELOPER_NAME was configured.' },
              session_id: { type: 'string', description: 'Restrict to one session id (from start_session).' },
              since_hours: { type: 'number', description: 'Lookback window in hours — e.g. 48 for "the past 2 days". Ignored if `since` is also given.' },
              since: { type: 'string', description: 'ISO timestamp lower bound (inclusive). Takes priority over since_hours.' },
              until: { type: 'string', description: 'ISO timestamp upper bound (inclusive).' },
              requirement_contains: { type: 'string', description: 'Case-insensitive substring match against the request text or summary — for finding changes tied to a ticket/requirement.' },
              limit: { type: 'number', description: 'Maximum entries to return, most recent first (optional, default 100). Check `total_matched` to see how many were dropped.' }
            },
            required: ['devmind_path']
          }
        },
        // NOTE: `search_decisions` is intentionally NOT listed here anymore. `search_nodes`'s BM25
        // layer indexes reasoning text from EVERY history revision now (not just the latest — see
        // rebuildSearchIndex), so a decision from any revision is findable there. The handler below
        // is retained so any direct/legacy call still works.
        // NOTE: `search_code` is intentionally NOT listed here anymore. `search_nodes` now
        // falls back to the same code-content search automatically when the identifier
        // match is empty, so there is no longer a reason to advertise two search tools.
        // The handler below is retained so any direct/legacy call still works.
        // NOTE: `get_orphaned_nodes` is intentionally NOT listed here anymore. `analyze_graph`
        // already computes and reports the identical data (`orphaned_nodes`) as one section of
        // its broader health check — this tool had no capability `analyze_graph` didn't already
        // have. The handler below is retained so any direct/legacy call still works.
        {
          name: 'get_visualizer_url',
          description: 'Get the local URL for the interactive code-graph view — one page with Chat and Graph tabs (the Graph tab has its own 2D/3D toggle). Same thing `devsmind view` opens.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'analyze_graph',
          description:
            'Run a local, zero-token health check on the graph: god entities (high fan-in/out), circular dependency cycles, orphaned nodes, dangling edges, duplicate/case-collision ids, history missing developer attribution, empty code snapshots, spurious/built-in nodes, missing files, git-detected renames, and git-tracked code files with zero graph nodes. Purely local SQLite/filesystem/git queries — no LLM calls. Call this periodically (or when the graph feels stale/wrong) instead of guessing why context looks off. Set fix:true to auto-apply only the SAFE fixes (soft-deprecate dead nodes, remove dangling edges, migrate detected renames) — everything else is report-only and needs a human or agent decision.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              fix: { type: 'boolean', description: 'If true, applies safe automatic fixes (default: false — dry run/report only)' },
              god_entity_threshold: { type: 'number', description: 'Connection-degree threshold to flag a god entity (default: 15)' }
            },
            required: ['devmind_path']
          }
        },
        // NOTE: `workflow_pause`, `workflow_resume`, `workflow_get_steps`, `workflow_search`,
        // `workflow_add_artifact`, `workflow_read_artifact` and `workflow_sync_retroactive` are
        // intentionally NOT listed here anymore. pause/resume became `workflow_bind` — the pointer
        // they moved was project-wide AND synced through git, so one session (or one teammate)
        // silently took a workflow from another mid-work. get_steps folded into
        // `workflow_get_context`, which is paged now. search folded into `workflow_list`'s `query`,
        // which finally matches name/description — the old one scanned step summaries only, so
        // looking a workflow up by its own name returned nothing. The artifact pair became
        // `workflow_add_step`'s `doc_paths` plus the file paths `workflow_get_context` returns.
        // sync_retroactive became `workflow_sync`, which reads the activity log instead of being
        // handed a list the agent assembled itself. pause/resume keep working as bind aliases
        // below; the rest are gone.
        {
          name: 'workflow_create',
          description: 'Start a named thread for a piece of functionality you will build over more than one session (e.g. "Wallet Integration"). A workflow is a BACKWARD-LOOKING log of how that functionality grew — read later to understand how the code got this way. It is not a task list. Creating one does NOT bind you to it: call workflow_bind next if you want this session\'s commits recorded on it.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              name: { type: 'string', description: 'Short human-readable name for the feature/workflow' },
              description: { type: 'string', description: 'Brief description of the goal — this is what a later session matches against to decide whether new work belongs here' }
            },
            required: ['devmind_path', 'name', 'description']
          }
        },
        {
          name: 'workflow_bind',
          description: 'Attach THIS session to a workflow, so every commit_changes from here automatically adds a step to it. Pass no workflow_id to detach. Binding is local to your session and is never shared: it does not move, pause, or steal anyone else\'s workflow, and two sessions can work different workflows — or the same one — at once without interfering. Replaces workflow_pause/workflow_resume, which moved one project-wide pointer that every session and every teammate shared.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              workflow_id: { type: 'string', description: 'The workflow to work on. OMIT THIS to unbind — later commits then attach to nothing, which workflow_sync can fix afterwards.' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'workflow_list',
          description: 'List workflows, newest-touched first. Call this when starting work that MIGHT belong to an existing multi-session feature — if a description matches, ask the user whether to continue it (workflow_bind) rather than starting fresh and losing its history. Pass `query` to match on name AND description. Archived workflows are hidden unless include_archived is set. `total` is the true count before the page, and `bound_workflow_id` tells you what this session is already on.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              query: { type: 'string', description: 'Optional: match this text against workflow name and description' },
              include_archived: { type: 'boolean', description: 'Include archived (retired) workflows (default: false)' },
              limit: { type: 'number', description: 'Max workflows in this page (default 25, max 200)' },
              offset: { type: 'number', description: 'Skip this many before the returned page (default 0)' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'workflow_get_context',
          description: 'Read a workflow\'s story: its steps in order, each with the reasoning behind it and the node ids it touched, plus any docs attached. This is what you call after binding, to understand how the feature reached its current shape — the decisions in sequence, including ones that produced no code. PAGED: `steps_total` is exact; a `truncated` flag plus a `hint` name the next call. Use `last_n` to read the most recent steps, which is usually what catching up means. Docs come back as file paths — read the file yourself if you need its contents.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              workflow_id: { type: 'string', description: 'The workflow to read' },
              last_n: { type: 'number', description: 'Read only the most recent N steps (max 500). Best way to catch up on a long thread — takes precedence over limit/offset.' },
              limit: { type: 'number', description: 'Max steps in this page when paging forward (default 50, max 500)' },
              offset: { type: 'number', description: 'Skip this many steps before the returned page (default 0)' }
            },
            required: ['devmind_path', 'workflow_id']
          }
        },
        {
          name: 'workflow_add_step',
          description: 'Record ONE step on a workflow, with the docs behind it, in the same call. You do NOT need this for ordinary code work — commit_changes already adds a step automatically whenever the session is bound. Call it for the thing a commit cannot express: A DECISION OR RESEARCH FINDING THAT CHANGED NO CODE (e.g. "evaluated Razorpay, no split settlements, going with Stripe"). That is the one kind of knowledge nothing else in DevsMind keeps — git has the diff and history has the per-node reasoning, but neither records what was considered and rejected. Attach the docs it came from via doc_paths.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              workflow_id: { type: 'string', description: 'Workflow to add this step to (optional — defaults to whatever this session is bound to)' },
              summary: { type: 'string', description: 'One line: what was decided or found' },
              reasoning: { type: 'string', description: 'The why behind it — what was considered, what was rejected, and on what grounds. This is the part nobody can reconstruct later from the code that survived.' },
              node_ids: { type: 'array', items: { type: 'string' }, description: 'Optional node ids this step relates to. Leave empty for a pure research/decision step.' },
              doc_paths: { type: 'array', items: { type: 'string' }, description: 'Optional paths to research/spec docs behind this step, relative to the repo. Stored as PATHS, never copies, so they stay current and are already shared with your team — a path outside the configured repos is rejected, since it would not exist for anyone else.' }
            },
            required: ['devmind_path', 'summary']
          }
        },
        {
          name: 'workflow_sync',
          description: 'Attach work you already did onto a workflow, after the fact — for when you were unbound, or bound to the wrong thread. Reads your LOCAL activity log (this machine only) and proposes one step per request you worked on. DRY RUN BY DEFAULT: the first call writes nothing and returns what it would attach, so show that to the user and call again with confirm:true. Safe to re-run — the edits behind each created step are marked consumed, so nothing is ever attached twice.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              workflow_id: { type: 'string', description: 'The workflow to attach the work to' },
              confirm: { type: 'boolean', description: 'Must be true to actually write. Leave unset to preview first (recommended — a wrong sync edits a shared, committed record).' },
              message_ids: { type: 'array', items: { type: 'string' }, description: 'Optional: attach only these messages (ids from a previous dry run) instead of everything in scope' },
              since_hours: { type: 'number', description: 'Optional: only consider work from the last N hours' },
              all_sessions: { type: 'boolean', description: 'Look across all local sessions rather than just this one (default false) — use when attaching work from an earlier day.' }
            },
            required: ['devmind_path', 'workflow_id']
          }
        },
        {
          name: 'workflow_archive',
          description: 'Hide a workflow from the default list, or bring it back with archived:false. Deliberately not called "complete" — a feature is never finished, it just stops being worked on, and the old completed/paused status was a lifecycle nobody maintained. Archiving is reversible and keeps every step intact.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              workflow_id: { type: 'string', description: 'The workflow to archive' },
              archived: { type: 'boolean', description: 'false to unarchive (default: true)' }
            },
            required: ['devmind_path', 'workflow_id']
          }
        },
        {
          name: 'workflow_import',
          description: 'Import existing flow/architecture docs (markdown describing a feature) as workflows, so material a team already wrote lives where you already look. Re-importing the same file updates its workflow in place rather than duplicating it.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              folder_path: { type: 'string', description: 'Folder to import every .md file from (one workflow per file)' },
              file_path: { type: 'string', description: 'A single .md file to import instead of a folder' }
            },
            required: ['devmind_path']
          }
        }
    ];

    // Every tool except start_session (the one tool that CREATES a session) requires
    // session_id — injected here once instead of duplicated on all ~35 schemas above.
    const SESSION_ID_PROP = {
      type: 'string',
      description: 'The DevsMind session token for THIS conversation, from start_session. Required. Pass the exact value start_session returned on every call; never invent one.'
    };
    for (const t of tools) {
      if (t.name === 'start_session') continue;
      // Read-only tools don't require a session (see SESSION_EXEMPT_READ_TOOLS) — don't inject it.
      if (SESSION_EXEMPT_READ_TOOLS.has(t.name)) continue;
      const schema = t.inputSchema as any;
      if (schema.properties && !schema.properties.session_id) schema.properties.session_id = SESSION_ID_PROP;
      if (Array.isArray(schema.required) && !schema.required.includes('session_id')) schema.required.push('session_id');
    }

    // Bound (stateful) server: the process already knows its one brain, so drop `devmind_path`
    // from every advertised schema. The AI never has to discover, remember, or re-send a path —
    // the single biggest source of per-call noise and cross-project mistakes. `resolveDevmindPath`
    // ignores the arg anyway when bound, so a stray one from an old client still works; this just
    // stops us ASKING for it. Unbound (tests/legacy) leaves the schemas exactly as they were.
    if (boundDevmindPath) {
      for (const t of tools) {
        const schema = t.inputSchema as any;
        if (schema.properties?.devmind_path) delete schema.properties.devmind_path;
        if (Array.isArray(schema.required)) {
          schema.required = schema.required.filter((r: string) => r !== 'devmind_path');
        }
      }
    }

    return { tools };
  });

  // â”€â”€ Tool Execution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error('Arguments are required');
    }

    // start_session mints the id; every WRITE call must carry it back. This is the sole minting
    // point — no auto-mint fallback — and the resolved id is echoed on every response below so it
    // survives context compaction. Read-only tools (SESSION_EXEMPT_READ_TOOLS) run without one:
    // sessionId stays '' for them, which is falsy so the trailing echo is skipped, and no write
    // handler is exempt so none ever sees the empty value.
    let sessionId: string;
    if (name === 'start_session') {
      sessionId = crypto.randomUUID();
    } else if (args.session_id) {
      sessionId = String(args.session_id);
    } else if (SESSION_EXEMPT_READ_TOOLS.has(name)) {
      sessionId = '';
    } else {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'session_id is required. Call start_session once at the start of this conversation, then pass the session_id it returns on every DevsMind write call, including this one. Never invent a session_id.'
          })
        }]
      };
    }

    const run = async () => {
      switch (name) {
        case 'list_nodes': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const type = args.type ? String(args.type) : undefined;
          const filePath = args.file_path ? String(args.file_path) : undefined;
          const includeDeprecated = args.include_deprecated === true;

          // Paged, because this used to return EVERY matching node with no bound of any kind — on a
          // real backend that was ~600KB in one response, which blew past the client's inline limit,
          // spilled to a file, and truncated on read from there too. An enumeration tool is exactly
          // the one that must be paged: the whole point of asking is that you don't know how many
          // there are.
          const limit = clampInt(args.limit, LIST_NODES_DEFAULT_LIMIT, 1, 500);
          const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);

          const db = getDatabase(devmindPath);
          const filter = { type, file_path: filePath, include_deprecated: includeDeprecated };
          const total = db.countNodes(filter);
          const nodes = db.listNodes({ ...filter, limit, offset });

          const payload: Record<string, unknown> = { nodes, total, offset };
          if (offset + nodes.length < total) {
            payload.truncated = true;
            payload.hint = `${total} nodes match; showing ${offset + 1}-${offset + nodes.length}. Pass offset:${offset + nodes.length} for the next page, or narrow with type/file_path.`;
          }

          // Backstop for a page that is still oversized because the nodes themselves are heavy
          // (long descriptions). Same threshold and the same "say what you dropped" contract as
          // search_nodes — a caller must never have to guess whether it got the whole field set.
          let text = JSON.stringify(payload);
          if (text.length > SEARCH_COMPACT_THRESHOLD) {
            payload.nodes = nodes.map(n => ({ id: n.id, name: n.name, type: n.type, file_path: n.file_path }));
            payload.compacted = LIST_NODES_COMPACT_NOTE;
            text = JSON.stringify(payload);
          }

          return {
            content: [{ type: 'text', text }]
          };
        }

        case 'get_node_code': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const nodeId = requireStr(args, 'node_id', 'get_node_code');
          const db = getDatabase(devmindPath);
          const live = db.getLiveCode(nodeId);
          // Internally getLiveCode() also reports source/snapshot_outdated (used by revertability()
          // below) — deliberately not forwarded here. Surfacing "cached"/"outdated" to the AI just
          // made it distrust code that was in fact current, for no actionable benefit.
          let result: Record<string, unknown>;
          if (live.exists) {
            const RECENT_HISTORY_LIMIT = 3;
            const NEIGHBOR_SIGNATURE_CAP = 120;
            const FILE_OUTLINE_CAP = 40;

            // Always-on node metadata — `description` especially: it's the highest-signal field
            // there is (a human-written summary of purpose), and it was already stored, already
            // fetched-adjacent, and simply never returned before.
            const node = db.getNode(live.node_id);

            // ES `import` lines only — does NOT capture require()/dynamic import()/`export…from`
            // re-exports (see listFileImports' own doc comment). Attached unconditionally: this
            // is the direct fix for the #1 recurring complaint, that a bare function body doesn't
            // say what its identifiers resolve to, so every AI ended up re-opening the whole file
            // just to read its import lines.
            const imports = live.file_path ? listFileImports(live.file_path) : [];

            const connCounts = db.getConnectionCounts([live.node_id]).get(live.node_id) ?? { uses: 0, usedBy: 0 };
            const historyCount = db.getHistoryCounts([live.node_id]).get(live.node_id) ?? 0;

            result = {
              exists: true,
              node_id: live.node_id,
              file_path: live.file_path,
              code: live.code,
              updated_at: live.updated_at
            };

            if (node) {
              result.name = node.name;
              result.type = node.type;
              if (node.signature) result.signature = node.signature;
              if (node.description) result.description = node.description;
              if (node.aliases && node.aliases.length > 0) result.aliases = node.aliases;
              if (node.deprecated) result.deprecated = true;
            }

            result.imports = imports;
            result.uses = connCounts.uses;
            result.used_by = connCounts.usedBy;
            if (connCounts.usedBy === 0) result.used_by_note = NO_STATIC_CALLERS_NOTE;

            // Named direct neighbors — always on unless explicitly zeroed. This is what turns
            // `used_by: 213` into actual leads, and is exactly what closes the depth-1
            // turn-stacking complaint: the common "who calls this" question no longer needs a
            // second tool call at all. Deterministically ordered (file_path, name) — see
            // getConnections' own doc comment — so a capped slice on a hub node is a stable,
            // meaningful page, not a lottery over unordered SQL rows.
            const neighborsLimit = clampInt(args.neighbors_limit, 20, 0, 200);
            const neighborsOffset = clampInt(args.neighbors_offset, 0, 0, Number.MAX_SAFE_INTEGER);
            if (neighborsLimit > 0) {
              const conn = db.getConnections(live.node_id, { limit: neighborsLimit, offset: neighborsOffset });
              const toSummary = (n: (typeof conn.uses)[number]) => ({
                node_id: n.id,
                name: n.name,
                type: n.type,
                file_path: n.file_path,
                signature: n.signature ? n.signature.slice(0, NEIGHBOR_SIGNATURE_CAP) : n.signature
              });
              result.uses_nodes = conn.uses.map(toSummary);
              result.used_by_nodes = conn.usedBy.map(toSummary);
              // Counts stay exact (`uses`/`used_by` above); these arrays are a possibly-capped
              // PAGE of them — never let the array length be mistaken for the count.
              if (neighborsOffset + conn.uses.length < connCounts.uses) {
                result.uses_truncated = true;
                result.uses_hint = `${connCounts.uses} callees, ${neighborsOffset + conn.uses.length} shown — pass neighbors_offset:${neighborsOffset + conn.uses.length} for the next page, or graph_depth:2 + graph_direction:"out" for the transitive call flow.`;
              }
              if (neighborsOffset + conn.usedBy.length < connCounts.usedBy) {
                result.used_by_truncated = true;
                result.used_by_hint = `${connCounts.usedBy} callers, ${neighborsOffset + conn.usedBy.length} shown — pass neighbors_offset:${neighborsOffset + conn.usedBy.length} for the next page, or graph_depth:2 + graph_direction:"in" for the transitive blast radius.`;
              }
            }

            // Everything ELSE declared in this file — the "was this renamed out from under me" /
            // "what's nearby" answer a raw file read used to be the only way to get. Omitted (not
            // an empty array) for a non-AST-parseable file, so that reads as "cannot tell", never
            // as "this file is empty".
            const includeOutline = args.file_outline !== false;
            if (includeOutline && live.file_path) {
              if (!isAstParseable(live.file_path)) {
                result.file_outline_unavailable = 'not an AST-parseable file';
              } else {
                const allEntries = outlineFile(live.file_path);
                const ownSymbol = parseNodeId(live.node_id)?.symbolName;
                const anchor = ownSymbol ? allEntries.find(e => e.qualified === ownSymbol) : undefined;
                const others = ownSymbol ? allEntries.filter(e => e.qualified !== ownSymbol) : allEntries;

                const fileNodes = db.getNodesByFilePath(live.file_path);
                const nodeIdBySymbol = new Map<string, string>();
                for (const n of fileNodes) {
                  const parsed = parseNodeId(n.id);
                  if (parsed) nodeIdBySymbol.set(parsed.symbolName, n.id);
                }

                let page = others;
                const truncated = others.length > FILE_OUTLINE_CAP;
                if (truncated) {
                  // Nearest the target node by line distance, then re-sorted back into file
                  // order — what's relevant in a 3000-line file is what shares a section with
                  // the node just returned, not whatever happens to sit at the top.
                  const anchorLine = anchor?.start_line ?? 0;
                  page = [...others]
                    .sort((a, b) => Math.abs(a.start_line - anchorLine) - Math.abs(b.start_line - anchorLine))
                    .slice(0, FILE_OUTLINE_CAP)
                    .sort((a, b) => a.start_line - b.start_line);
                }

                result.file_outline = page.map(e => {
                  const entryNodeId = nodeIdBySymbol.get(e.qualified);
                  return {
                    name: e.name,
                    qualified: e.qualified,
                    type: e.type,
                    start_line: e.start_line,
                    end_line: e.end_line,
                    exported: e.exported,
                    ...(entryNodeId ? { node_id: entryNodeId } : {})
                  };
                });
                result.file_outline_total = others.length;
                if (truncated) result.file_outline_truncated = true;
              }
            }

            // recent_history's shape/limit is UNCHANGED regardless of `history` — always the last
            // RECENT_HISTORY_LIMIT reasoning-only summaries, never code — so every existing
            // consumer of this field keeps working unchanged. `history:"full"` ADDS `full_history`
            // alongside it; it never replaces it.
            const historyMode = args.history === 'none' || args.history === 'full' ? args.history : 'recent';
            result.recent_history = historyMode === 'none'
              ? []
              : (historyCount > 0 ? db.getRecentHistorySummaries(live.node_id, RECENT_HISTORY_LIMIT) : []);
            result.history_count = historyCount;

            if (historyMode === 'recent' && historyCount > RECENT_HISTORY_LIMIT) {
              result.history_hint = `${historyCount} revisions recorded, ${RECENT_HISTORY_LIMIT} shown (reasoning only). Pass history:"full" in this same call for the code snapshots and diffable edits.`;
            }

            if (historyMode === 'full') {
              const limit = clampInt(args.history_limit, 5, 0, 25);
              const offset = clampInt(args.history_offset, 0, 0, Number.MAX_SAFE_INTEGER);
              const page = db.getHistoryPage(live.node_id, limit, offset);
              result.full_history = page.entries;
              if (offset + page.entries.length < page.total) {
                result.history_truncated = true;
                result.history_hint = `${page.total} revisions total, showing ${offset + 1}-${offset + page.entries.length}. Pass history_offset:${offset + page.entries.length} in this same call for the next page.`;
              }
            }

            // Transitive graph — off by default (depth 0). The direct neighbors above already
            // answer the common case; this is the explicit "go further" escape hatch, same BFS
            // the old get_node_graph tool ran, just embedded in the same call instead of a
            // separate one.
            const graphDepth = clampInt(args.graph_depth, 0, 0, 10);
            if (graphDepth >= 1) {
              const graphDirection =
                args.graph_direction === 'out' || args.graph_direction === 'in' || args.graph_direction === 'both'
                  ? args.graph_direction
                  : 'both';
              // Clamped, not `Number(...)`: an unparseable budget used to become NaN, and since
              // every `spent + len > NaN` is false, that silently meant an UNLIMITED budget —
              // the exact opposite of what passing a budget asks for. `0` is now a real value
              // (root code only), distinct from omitting the param.
              const graphCodeBudget = clampInt(args.graph_code_budget, GRAPH_CODE_BUDGET_DEFAULT, 0, 200_000);
              const graph = db.getGraph(live.node_id, graphDepth, {
                direction: graphDirection,
                includeCode: args.graph_code === true,
                codeCharBudget: graphCodeBudget,
                maxNodes: GRAPH_MAX_NODES
              });

              // The root's code is already on `result.code` above, read live from disk. getGraph
              // attaches it a second time (its root is budget-exempt), so leaving it would spend
              // a chunk of the budget on a byte-identical duplicate — on a 3KB root inside a 24KB
              // budget that's 12% of it, buying nothing.
              if (graph.nodes.length > 0 && graph.nodes[0].id === live.node_id) {
                delete graph.nodes[0].code;
                delete graph.nodes[0].code_source;
              }
              result.graph = graph;

              // Name what didn't fit, so "the rest" is reachable. Deliberately NOT a positional
              // cursor: the BFS is re-derived per call and the cut-off also depends on file
              // contents, so an index would silently skip or repeat nodes after any edit. An id
              // survives both, and is directly usable as the next call's argument.
              if (graph.code_omitted_node_ids?.length) {
                result.graph_code_hint =
                  `${graph.code_omitted_node_ids.length} node(s) had their code dropped to stay inside graph_code_budget (${graphCodeBudget} chars). ` +
                  `They are listed by id in graph.code_omitted_node_ids — call get_node_code on those directly, or re-issue with a larger graph_code_budget.`;
              }
            }
          } else {
            result = { exists: false, node_id: live.node_id, message: live.message };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        }

        case 'update_history': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const rawFilePath = requireStr(args, 'file_path', 'update_history');
          const db = getDatabase(devmindPath);
          const workspaceRoot = path.dirname(devmindPath);
          const filePath = path.isAbsolute(rawFilePath) ? path.resolve(rawFilePath) : path.resolve(workspaceRoot, rawFilePath);
          if (!db.isPathAllowed(filePath)) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: `file_path resolves outside the project's configured repos — nothing was written.`,
                  resolved_path: filePath
                })
              }]
            };
          }

          // Single-shot path: stage one entry and commit it immediately, so a lone edit still
          // gets its node, history, AND outgoing edges resolved via the shared commit logic.
          const entry: StagedEntry = {
            node_id: requireStr(args, 'node_id', 'update_history'),
            file_path: filePath,
            code_snapshot: requireStr(args, 'code_snapshot', 'update_history'),
            name: args.name ? String(args.name) : undefined,
            type: args.type ? String(args.type) : undefined,
            signature: args.signature ? String(args.signature) : undefined,
            session_id: sessionId
          };
          const summary = await commitStagedChanges(db, devmindPath, [entry], args.reasoning as any);
          const nodeId = entry.node_id.includes('#') ? entry.node_id : `${db.toRepoRelativePath(filePath)}#${entry.node_id}`;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    message: 'History updated and connections resolved.',
                    node: { id: nodeId },
                    edges_added: summary.edges_added,
                    missing_nodes_filled: summary.missing_filled
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        // ————————————————————————————————— Indexing tool handlers —————————————————————————————————
        case 'index_start': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const { repos, total_files } = scanRepoFiles(devmindPath);
          const pad = createScratchpad(devmindPath, total_files);

          const repoSummaries = repos.map(r => ({
            repo_name: r.repo_name,
            repo_path: r.repo_path,
            file_count: r.file_count,
            files: r.files // full list so AI can iterate
          }));

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                message: 'Indexing session started. Extract nodes with stage_change (one call per entity), then call commit_changes to write them all and resolve connections automatically via AST. Call index_checkpoint every 10 files.',
                scratchpad: pad,
                repos: repoSummaries,
                total_files,
                instructions: [
                  '⚠️⚠️⚠️  CRITICAL INSTRUCTION FOR THE INDEXING AGENT — MUST READ ⚠️⚠️⚠️ ',
                  'YOU MUST EXPLICITLY CALL THE "stage_change" MCP TOOL FOR EVERY ENTITY YOU EXTRACT, THEN "commit_changes" TO WRITE THEM.',
                  'DO NOT JUST PRINT THE RESULTS AS TEXT IN THE CHAT WINDOW. PRINTING RESULTS WITHOUT CALLING THE MCP TOOLS DOES NOT WRITE THEM TO THE DATABASE AND MAKES THE ENTIRE INDEXING RUN A WASTE OF TIME AND TOKENS.',
                  'NEVER WRITE OR EXECUTE EXTERNAL SCRIPTS (like Python, Node.js, Bash, etc.) to automate or lazy load indexing. You must read files and call the MCP tools step-by-step natively in the chat. This ensures progress is tracked in the SQLite scratchpad database and can be resumed/continued in subsequent chats if context limits are hit.',
                  'ONCE YOU START INDEXING, DO NOT STOP or pause to ask for confirmation between checkpoints. Keep executing and indexing files continuously until the codebase is fully indexed or your context token limit is reached.',
                  'IF YOU ENCOUNTER CONTEXT RESETS, RESUME WORK BY CALLING "index_continue" AND CONTINUOUSLY COMMIT PROGRESS BY CALLING "index_checkpoint" EVERY 10 FILES.',
                  '',
                  '📋 CODE EXCLUSION & PRECISION RULES:',
                  '1. EXCLUDE Language Globals / Built-ins: Do NOT stage nodes for Promise, Map, Set, JSON, console, Error, Object, Array, RegExp, Date, Math, etc.',
                  '2. EXCLUDE Primitive/Native Types: Do NOT stage nodes for string, number, boolean, any, void, unknown, never, null, undefined, dict, list, etc.',
                  '3. EXCLUDE External / Third-party Modules: Do NOT stage nodes for lodash, express, react, @nestjs/common, etc.',
                  '4. INTERNAL ENTITIES ONLY: Only stage nodes for constructs defined inside this codebase.',
                  '',
                  '📋 STAGE → COMMIT INDEXING PROTOCOL:',
                  '1. For each file in each repo: read it, extract ALL defined nodes — functions, methods, classes, interfaces, types, DTOs, routing handlers, schemas, resolvers, etc.',
                  '2. Call stage_change for EVERY entity found — pass its node_id, file_path, code_snapshot, the most specific taxonomy type, AND a `description`: 1-3 sentences of what it actually DOES and the domain concepts involved, using words a developer would search by later — NOT a restatement of the name ("verifyCredentials verifies credentials" is rejected). You are reading the whole file right now, with maximum context — this is the cheapest moment this description will ever be to write; skipping it here means commit_changes will refuse the node later and you will have to come back to it anyway. You do NOT need to figure out connections; commit_changes resolves them from the code via AST.',
                  '3. Call index_checkpoint every 10 files to save progress.',
                  '4. Every ~50 entities (or at the end of a repo), call commit_changes to flush the staged buffer — it creates all nodes, writes all history, and resolves all connections (including into already-committed nodes) in one pass. Committing in batches keeps the buffer small. Pass ONE `reasoning` per commit_changes call describing this batch (e.g. "Initial index of <repo>") — it is required, and applies to every entity in that batch. commit_changes REFUSES any batch containing a new node with no description — if that happens, call add_description with the node_ids it lists, then call commit_changes again; nothing staged is lost by the rejection.',
                  '5. When the whole codebase is staged and committed, call index_complete.',
                  '6. AFTER index_complete, CALL "recheck_graph" to automatically prune any spurious, built-in, or orphaned nodes and ensure high graph precision.'
                ]
              }, null, 2)
            }]
          };
        }

        case 'index_checkpoint': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const pad = updateScratchpad(devmindPath, {
            last_file_indexed: args.last_file_indexed ? String(args.last_file_indexed) : undefined,
            files_done: typeof args.files_done === 'number' ? args.files_done : 0,
            nodes_created: typeof args.nodes_created === 'number' ? args.nodes_created : 0,
            connections_created: typeof args.connections_created === 'number' ? args.connections_created : 0,
            current_repo: args.current_repo ? String(args.current_repo) : undefined,
            repos_done: Array.isArray(args.repos_done) ? (args.repos_done as string[]) : undefined
          });
          const pct = pad.files_total > 0
            ? Math.round((pad.files_done / pad.files_total) * 100)
            : 0;
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ saved: true, progress: `${pad.files_done}/${pad.files_total} files (${pct}%)`, scratchpad: pad }, null, 2)
            }]
          };
        }

        case 'index_continue': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const pad = readScratchpad(devmindPath);
          if (!pad) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'No indexing session found. Call index_start first.' }) }]
            };
          }
          if (pad.status === 'complete') {
            return {
              content: [{ type: 'text', text: JSON.stringify({ status: 'complete', message: 'Indexing already completed.', scratchpad: pad }, null, 2) }]
            };
          }
          // Re-scan to get file lists so AI knows which files are left
          const { repos } = scanRepoFiles(devmindPath);
          const reposDone = new Set(pad.repos_done);
          const remaining = repos
            .filter(r => !reposDone.has(r.repo_name))
            .map(r => ({ repo_name: r.repo_name, repo_path: r.repo_path, files: r.files, file_count: r.file_count }));

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                message: 'Resume indexing from where you left off.',
                scratchpad: pad,
                last_file_indexed: pad.last_file_indexed,
                repos_done: pad.repos_done,
                remaining_repos: remaining,
                // Repeated here because a context reset means the original index_start
                // instructions are gone from view — without this, a resumed session silently
                // stops writing descriptions on every node from here on.
                instructions: [
                  'Continue the STAGE → COMMIT INDEXING PROTOCOL exactly as before, for remaining_repos only.',
                  'Every stage_change call still needs a `description`: 1-3 sentences of what the entity does and its domain concepts, not a restatement of its name.',
                  'commit_changes still REFUSES a batch containing a new node with no description — call add_description with the listed node_ids, then retry the commit.',
                  'Call index_checkpoint every 10 files, commit_changes every ~50 entities, index_complete when done, then recheck_graph.'
                ]
              }, null, 2)
            }]
          };
        }

        case 'index_complete': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const pad = completeScratchpad(devmindPath);
          const db = getDatabase(devmindPath);
          db.vacuum();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                message: '✅ Indexing complete! Full graph is now available.',
                summary: {
                  files_indexed: pad.files_done,
                  nodes_created: pad.nodes_created,
                  connections_created: pad.connections_created,
                  started_at: pad.started_at,
                  completed_at: pad.updated_at
                }
              }, null, 2)
            }]
          };
        }

        case 'edit_node': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const editDb = getDatabase(devmindPath);
          const workspaceRoot = path.dirname(devmindPath);

          if (!args.file_path || args.old_string === undefined || args.new_string === undefined) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  edited: false,
                  error: 'edit_node needs file_path, old_string and new_string (pass an empty new_string to delete).'
                })
              }]
            };
          }
          const rawPath = String(args.file_path);
          const filePath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(workspaceRoot, rawPath);
          if (!editDb.isPathAllowed(filePath)) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  edited: false,
                  error: "file_path resolves outside the project's configured repos — nothing was written.",
                  resolved_path: filePath
                })
              }]
            };
          }

          // An empty old_string means "this file does not exist yet — create it". Anything else
          // is a replacement. Creating through the same call is what keeps a new file from being
          // the one case that sends the caller back to a write tool that records nothing.
          const oldString = String(args.old_string);
          const fileExists = fs.existsSync(filePath);
          if (!fileExists && oldString !== '') {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  edited: false,
                  file_path: filePath,
                  error: `${path.basename(filePath)} does not exist, so there is no old_string to match.`,
                  hint: 'To CREATE this file, call edit_node again with old_string: "" and the full file contents as new_string.'
                })
              }]
            };
          }

          const result = fileExists
            ? replaceTextInFile(filePath, oldString, String(args.new_string), args.replace_all === true)
            : createFileWithContent(filePath, String(args.new_string));
          if (!result.ok) {
            return {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ edited: false, file_path: filePath, error: result.error }) }]
            };
          }
          invalidateParsedFile(filePath);

          // Trace the write back to the code it landed in, and record that automatically.
          // Anything not traceable (markup, config, a top-level import) is a normal outcome:
          // the file is still edited, there is simply nothing for the graph to hold.
          const knownHere = editDb.getNodesByFilePath(filePath).map(n => {
            const parsed = parseNodeId(n.id);
            return { id: n.id, symbolName: parsed ? parsed.symbolName : (n.id.split('#').pop() || n.name) };
          });
          const touched = findTouchedSymbols(filePath, result.ranges || [], knownHere, result.before);

          // Only meaningful when exactly one symbol was touched — otherwise there is no way to
          // know which one it describes. The file write above already succeeded regardless of
          // what happens here: an invalid or inapplicable description never blocks the edit
          // itself, only whether commit_changes will later need a separate add_description call.
          let singleSymbolDescription: string | undefined;
          let descriptionNote: string | undefined;
          if (args.description !== undefined) {
            if (touched.length !== 1) {
              descriptionNote = touched.length === 0
                ? 'description was ignored: this edit touched no function/class, so there was nothing to describe.'
                : `description was ignored: this edit touched ${touched.length} symbols, which one it describes is ambiguous — use add_description for each after this call.`;
            } else {
              const check = validateDescription(String(args.description), touched[0].name);
              if (check.ok) {
                singleSymbolDescription = String(args.description);
              } else {
                descriptionNote = `description was rejected and ignored: ${check.error}`;
              }
            }
          }

          const staged: any[] = [];
          const diffBlocks: string[] = [];
          for (const t of touched) {
            const nodeId = t.node_id || `${editDb.toRepoRelativePath(filePath)}#${t.symbolName}`;
            stageEntry(devmindPath, {
              node_id: nodeId,
              file_path: filePath,
              code_snapshot: t.codeSnapshot,
              code_before: t.codeBefore,
              name: t.name,
              type: t.type,
              signature: t.signature || undefined,
              description: singleSymbolDescription,
              session_id: sessionId
            });

            const conns = t.node_id ? editDb.getConnections(t.node_id) : { uses: [], usedBy: [] };
            const priorHistory = (t.node_id ? editDb.getFullHistory(t.node_id) : [])
              .flatMap(h => parseReasoningBlocks(h.reasoning).map(r => ({ updated_at: h.updated_at, r })))
              .slice(0, 2)
              .map(({ updated_at, r }) => ({ updated_at, developer: r.developer, what_changed: r.what_changed, why: r.why }));

            staged.push({
              node_id: nodeId,
              name: t.name,
              type: t.type,
              lines: `${t.startLine}-${t.endLine}`,
              is_new_to_graph: t.isNew,
              described: singleSymbolDescription !== undefined,
              callers: conns.usedBy.slice(0, 10).map(n => ({ id: n.id, name: n.name, file_path: n.file_path })),
              callers_total: conns.usedBy.length,
              calls_out: conns.uses.slice(0, 10).map(n => ({ id: n.id, name: n.name })),
              prior_history: priorHistory
            });

            // Human-facing view of this same edit, so the change is visible in the session as a
            // fenced diff — kept separate from the JSON above so the text isn't shipped twice.
            // The +/- lines already show add-vs-modify; no "new" tag, which would read as "new
            // code" when it only ever meant "not yet in the graph".
            diffBlocks.push(`### ${t.name}  \`${path.basename(filePath)}:${t.startLine}-${t.endLine}\`\n\`\`\`diff\n${renderUnifiedDiff(t.codeBefore ?? '', t.codeSnapshot)}\n\`\`\``);
          }

          // Nothing traced into the code graph doesn't mean nothing worth keeping: a non-code file
          // (CSS, XML, JSON, ...) or an edit landing outside any function (an import line, a
          // top-level constant) still gets its whole-file before/after staged for the LOCAL
          // activity log, so it shows up and is individually revertable in `devsmind view` -> Chat
          // right alongside traced code edits — the graph stays code-only, the activity log doesn't.
          let fileEditStaged = false;
          if (touched.length === 0) {
            const afterContent = fs.readFileSync(filePath, 'utf-8');
            stageFileEdit(devmindPath, {
              file_path: filePath,
              before: result.before ?? '',
              after: afterContent,
              session_id: sessionId
            });
            fileEditStaged = true;
          }

          // Scoped to THIS session — the buffer is shared by every session pointed at this
          // .devmind directory, so counting the raw buffer length here would inflate the "pending"
          // total with other sessions' unrelated in-flight work and mislead this agent about how
          // much IT still needs to commit. See partitionStagedForSession.
          const { entries: myPendingEntries, fileEdits: myPendingFileEdits } = partitionStagedForSession(devmindPath, sessionId);
          const pending = myPendingEntries.length + myPendingFileEdits.length;

          const ext = path.extname(filePath).toLowerCase();
          const callerCount = staged.reduce((sum, s) => sum + s.callers_total, 0);
          const newUndescribedCount = staged.filter(s => s.is_new_to_graph && !s.described).length;
          const newDescribedCount = staged.filter(s => s.is_new_to_graph && s.described).length;
          const what = result.created ? 'Created the file and recorded' : 'Recorded';
          let reminder: string;
          if (staged.length) {
            reminder = callerCount
              ? `${what} ${staged.length} node(s). ${callerCount} node(s) call what you changed — if you altered a signature or contract, check them before moving on. Nothing reaches the graph until commit_changes.`
              : `${what} ${staged.length} node(s). Nothing reaches the graph until commit_changes.`;
            if (newUndescribedCount > 0) {
              reminder += ` ${newUndescribedCount} of these are NEW and undescribed — commit_changes will refuse the batch without a description for each (call add_description before you commit, while this code is still fresh in context, or pass description directly to edit_node next time when it's a single new symbol).`;
            }
            if (newDescribedCount > 0) {
              reminder += ` ${newDescribedCount} new node(s) already described via this call — no add_description round trip needed for those.`;
            }
            if (descriptionNote) {
              reminder += ` ${descriptionNote}`;
            }
          } else if (!INDEXABLE_EXTENSIONS.has(ext)) {
            reminder = `${ext || 'This file type'} is intentionally out of scope for the code graph — no node was recorded. The whole-file change is staged for the local activity log though, so commit_changes will still make it revertable there.`;
          } else if (isAstParseable(filePath)) {
            reminder = result.created
              ? 'The file was created, but it declares no function or class, so no graph node was recorded. The whole-file change is staged for the local activity log, so commit_changes will still make it revertable there.'
              : 'This edit did not land inside any function or class (an import, a top-level constant, or similar), so no graph node was recorded. The whole-file change is staged for the local activity log, so commit_changes will still make it revertable there.';
          } else {
            reminder = `${ext} cannot be parsed for symbols, so this could not be traced into the graph. The whole-file change is staged for the local activity log though, so commit_changes will still make it revertable there — call stage_change yourself only if you also want a graph node for it.`;
          }

          // Two blocks on purpose: a rendered diff for the human watching the session (clients
          // that highlight markdown colour the ```diff fence; the rest show plain +/- lines), and
          // the JSON the agent parses. The diff is not embedded in the JSON, so it ships once.
          const content: { type: 'text'; text: string }[] = [];
          if (diffBlocks.length) {
            content.push({ type: 'text', text: `${result.created ? 'Created' : 'Edited'} ${path.basename(filePath)}\n\n${diffBlocks.join('\n\n')}` });
          }
          content.push({
            type: 'text',
            text: JSON.stringify({
              edited: true,
              created: !!result.created,
              file_path: filePath,
              replacements: result.replacements,
              recorded: staged.length,
              pending_count: pending,
              touched: staged,
              file_edit_staged: fileEditStaged,
              reminder
            }, null, 2)
          });
          return { content };
        }

        case 'stage_change': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const rawFilePath = requireStr(args, 'file_path', 'stage_change');
          const ext = path.extname(rawFilePath).toLowerCase();
          if (!INDEXABLE_EXTENSIONS.has(ext)) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  staged: false,
                  error: `'${ext || '(no extension)'}' is not a supported node file type — nothing was staged.`,
                  reason:
                    'DevsMind models functions, classes, and logic entities in source code. Stylesheets (.css/.scss/.less), markup, JSON/config, docs, and other non-code assets are intentionally out of scope, not oversights — staging them would only bloat the graph with nodes that have no callers/callees to resolve. Do not retry this file.',
                  supported_extensions: Array.from(INDEXABLE_EXTENSIONS).sort()
                })
              }]
            };
          }
          const workspaceRoot = path.dirname(devmindPath);
          const filePath = path.isAbsolute(rawFilePath) ? path.resolve(rawFilePath) : path.resolve(workspaceRoot, rawFilePath);
          const stageDb = getDatabase(devmindPath);
          if (!stageDb.isPathAllowed(filePath)) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  staged: false,
                  error: `file_path resolves outside the project's configured repos — nothing was staged.`,
                  reason: 'stage_change only accepts paths inside a repo this project knows about, to prevent staging/reading files outside the project.',
                  resolved_path: filePath
                })
              }]
            };
          }
          const stageNodeId = requireStr(args, 'node_id', 'stage_change');
          let stageDescription: string | undefined;
          if (args.description !== undefined) {
            const check = validateDescription(String(args.description), (args.name ? String(args.name) : stageNodeId));
            if (!check.ok) {
              return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify({ staged: false, error: check.error }) }]
              };
            }
            stageDescription = String(args.description);
          }
          const entry: StagedEntry = {
            node_id: stageNodeId,
            file_path: filePath,
            code_snapshot: requireStr(args, 'code_snapshot', 'stage_change'),
            name: args.name ? String(args.name) : undefined,
            type: args.type ? String(args.type) : undefined,
            signature: args.signature ? String(args.signature) : undefined,
            description: stageDescription,
            session_id: sessionId
          };
          stageEntry(devmindPath, entry);
          // Scoped to THIS session, not the raw buffer length — see partitionStagedForSession.
          // The shared buffer can also hold another session's unrelated staged work, which must
          // never be counted as "yours to commit".
          const scoped = partitionStagedForSession(devmindPath, sessionId);
          const pendingCount = scoped.entries.length + scoped.fileEdits.length;
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                staged: true,
                node_id: entry.node_id,
                pending_count: pendingCount,
                reminder: 'Call commit_changes once you have staged every touched file, or nothing is written to the graph.'
              })
            }]
          };
        }

        case 'add_description': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const rawList = Array.isArray(args.descriptions) ? args.descriptions : [];
          if (rawList.length === 0) {
            return {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ described: false, error: 'add_description needs a non-empty descriptions array.' }) }]
            };
          }

          const staged = readStaged(devmindPath);
          const results: { node_id: string; ok: boolean; error?: string; target: 'staged' | 'committed' | 'unknown' }[] = [];

          for (const item of rawList) {
            const nodeId = item && item.node_id ? String(item.node_id) : '';
            const description = item && item.description ? String(item.description) : '';
            if (!nodeId) {
              results.push({ node_id: nodeId, ok: false, error: 'missing node_id', target: 'unknown' });
              continue;
            }

            const check = validateDescription(description, nodeId);
            if (!check.ok) {
              results.push({ node_id: nodeId, ok: false, error: check.error, target: 'unknown' });
              continue;
            }

            // A staged-but-not-yet-committed entry takes priority: this is the normal path after
            // a commit_changes rejection, and the description must land in the buffer so it
            // reaches upsertNode when the AI retries the commit — writing straight to the DB here
            // would do nothing, since that node doesn't exist there yet.
            //
            // Restricted to entries THIS session owns (see belongsToSession in staging.ts) — the
            // buffer is shared by every session pointed at this .devmind directory, so without
            // this check one session could write a description onto another session's still
            // uncommitted node, which then ships with that commit under the OTHER session's
            // reasoning even though the describing session never touched or reviewed that change.
            const matchesNodeId = (e: StagedEntry) => e.node_id === nodeId || `${db.toRepoRelativePath(e.file_path)}#${e.node_id}` === nodeId;
            const stagedEntry = staged.find(e => matchesNodeId(e) && (!e.session_id || e.session_id === sessionId));
            if (stagedEntry) {
              stagedEntry.description = description;
              results.push({ node_id: nodeId, ok: true, target: 'staged' });
              continue;
            }
            if (staged.some(matchesNodeId)) {
              results.push({
                node_id: nodeId, ok: false,
                error: 'staged by another session, not this one — that session must add the description (or commit first, then use add_description on the committed node).',
                target: 'unknown'
              });
              continue;
            }

            // Otherwise this is a backfill/refresh on an already-committed node — write directly,
            // no commit needed. upsertNode's COALESCE means every other field is left untouched.
            const existing = db.getNode(nodeId);
            if (!existing) {
              results.push({ node_id: nodeId, ok: false, error: 'no such node — not staged, and not in the committed graph', target: 'unknown' });
              continue;
            }
            db.upsertNode({
              id: existing.id,
              type: existing.type,
              name: existing.name,
              file_path: existing.file_path,
              signature: existing.signature,
              description
            });
            // Embed only on the COMMITTED path — a staged entry above mutates a JSON buffer with
            // nowhere to put a vector yet; those nodes get embedded once commit_changes lands
            // them in the DB via commitStagedChanges. No-op (returns null) if the optional ONNX
            // dependency is unavailable — the node just falls into the `devsmind embed` queue.
            const vector = await embedTextInt8(description);
            if (vector) db.upsertNodeVector(existing.id, vector, hashDescription(description));
            results.push({ node_id: nodeId, ok: true, target: 'committed' });
          }

          // Persist any staged-entry description writes back to the buffer.
          if (staged.some(e => e.description !== undefined)) {
            overwriteStaged(devmindPath, staged);
          }

          const failed = results.filter(r => !r.ok);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                described: failed.length === 0,
                results,
                reminder: failed.length === 0
                  ? 'If these were for a commit_changes rejection, call commit_changes again now.'
                  : `${failed.length} description(s) rejected — fix and retry just those.`
              }, null, 2)
            }]
          };
        }

        case 'add_feedback': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const graphProblem = args.graph_problem as { text?: unknown; node_id?: unknown; evidence?: { file?: unknown; line?: unknown; snippet?: unknown } } | undefined;
          const edgeProblem = args.edge_problem as { text?: unknown; node_id?: unknown; evidence?: { file?: unknown; line?: unknown; snippet?: unknown } } | undefined;
          const toolsUsed = args.tools_used !== undefined ? String(args.tools_used) : undefined;
          const droppedAndWhy = args.dropped_and_why !== undefined ? String(args.dropped_and_why) : undefined;
          const devsmindBetter = args.devsmind_better !== undefined ? String(args.devsmind_better) : undefined;

          if (!graphProblem && !edgeProblem && toolsUsed === undefined && droppedAndWhy === undefined && devsmindBetter === undefined) {
            return {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ error: 'add_feedback needs at least one of: graph_problem, edge_problem, tools_used, dropped_and_why, devsmind_better.' }) }]
            };
          }

          // Both graph/edge shapes are handled identically apart from the category label, so one
          // helper does both instead of duplicating the evidence-verification + append logic.
          const recordGraphSide = (
            category: 'graph_problem' | 'edge_problem',
            entry: { text?: unknown; node_id?: unknown; evidence?: { file?: unknown; line?: unknown; snippet?: unknown } }
          ): { ok: true } | { ok: false; error: string } => {
            const text = entry.text ? String(entry.text) : '';
            if (!text.trim()) return { ok: false, error: `${category}.text is required` };
            const nodeId = entry.node_id ? String(entry.node_id) : undefined;
            let evidence: { file: string; line?: number; snippet?: string } | undefined;
            if (entry.evidence) {
              const file = entry.evidence.file ? String(entry.evidence.file) : '';
              if (!file) return { ok: false, error: `${category}.evidence.file is required when evidence is given` };
              const snippet = entry.evidence.snippet ? String(entry.evidence.snippet) : undefined;
              // Verified fresh at call time, same evidence-gating as link_nodes/record_alias — a
              // stale or fabricated claim is refused outright, not silently trusted or downgraded.
              const verified = verifyEvidence(file, snippet);
              if (!verified.ok) return { ok: false, error: `${category} evidence verification failed — ${verified.reason}` };
              const line = typeof entry.evidence.line === 'number' ? entry.evidence.line : undefined;
              evidence = { file, line, snippet };
            }
            appendGraphFeedback(devmindPath, { session_id: sessionId, category, text, node_id: nodeId, evidence });
            return { ok: true };
          };

          const recorded: string[] = [];
          const rejected: { field: string; error: string }[] = [];

          if (graphProblem) {
            const r = recordGraphSide('graph_problem', graphProblem);
            if (r.ok) recorded.push('graph_problem'); else rejected.push({ field: 'graph_problem', error: r.error });
          }
          if (edgeProblem) {
            const r = recordGraphSide('edge_problem', edgeProblem);
            if (r.ok) recorded.push('edge_problem'); else rejected.push({ field: 'edge_problem', error: r.error });
          }
          if (toolsUsed !== undefined) {
            appendProductFeedback(devmindPath, { session_id: sessionId, category: 'tools_used', text: toolsUsed });
            recorded.push('tools_used');
          }
          if (droppedAndWhy !== undefined) {
            appendProductFeedback(devmindPath, { session_id: sessionId, category: 'dropped_and_why', text: droppedAndWhy });
            recorded.push('dropped_and_why');
          }
          if (devsmindBetter !== undefined) {
            appendProductFeedback(devmindPath, { session_id: sessionId, category: 'devsmind_better', text: devsmindBetter });
            recorded.push('devsmind_better');
          }

          // A rejected evidence claim fails the WHOLE call (nothing partially recorded from THAT
          // field) rather than silently downgrading it — same "refused, not trusted" stance as
          // link_nodes/record_alias. Fields that verified fine are still recorded; only the ones
          // that failed are reported back for a retry.
          if (rejected.length > 0) {
            return {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ recorded, rejected }, null, 2) }]
            };
          }

          return {
            content: [{ type: 'text', text: JSON.stringify({ recorded }, null, 2) }]
          };
        }

        case 'commit_changes': {
          const requestText = requireStr(args, 'message', 'commit_changes');
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          // Scoped to THIS session's own staged work — the buffer is shared by every session
          // pointed at this .devmind directory, so a plain commit must never sweep up another
          // session's still-in-progress edits (possibly from an unrelated file or repo) just
          // because they happened to be pending at the same time. See partitionStagedForSession.
          const { entries, fileEdits, otherSessionsPending } = partitionStagedForSession(devmindPath, sessionId);
          if (entries.length === 0 && fileEdits.length === 0) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  committed: false,
                  message: otherSessionsPending > 0
                    ? `Nothing staged by this session. ${otherSessionsPending} entr(y/ies) from another session are pending but left untouched — call stage_change/edit_node first.`
                    : 'Nothing staged. Call stage_change first.'
                })
              }]
            };
          }
          if (!args.reasoning) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  committed: false,
                  error: 'commit_changes needs reasoning (what_changed, why, goal). It is recorded against EVERY node staged since the last commit, and exists nowhere else once this turn ends.'
                })
              }]
            };
          }

          // Compulsory but never a real obstacle: every field just needs to be a string, and
          // "none" is a fully legitimate, expected value — this only rejects a call that omitted
          // the param entirely or answered with the wrong shape, never one that reported nothing
          // wrong. See the tool description for why "none" everywhere is fine.
          const feedback = args.feedback as {
            graph_problems?: unknown; edge_problems?: unknown; tools_used?: unknown; dropped_and_why?: unknown; devsmind_better?: unknown;
          } | undefined;
          const feedbackFields = ['graph_problems', 'edge_problems', 'tools_used', 'dropped_and_why', 'devsmind_better'] as const;
          const feedbackValid = !!feedback && typeof feedback === 'object'
            && feedbackFields.every(f => typeof feedback[f] === 'string');
          if (!feedbackValid) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  committed: false,
                  error: 'commit_changes needs feedback (graph_problems, edge_problems, tools_used, dropped_and_why, devsmind_better), each a string. This is how DevsMind improves over time — every field must be ANSWERED but none needs to contain a problem: pass "none" wherever nothing applies. Do not invent an issue just to fill a field in.'
                })
              }]
            };
          }
          const fb = feedback as Record<typeof feedbackFields[number], string>;

          // Every NEW node needs a description before it can ever be committed — that's what
          // makes search_nodes findable by natural language later, and it's the one thing that
          // reliably gets skipped if it's ever optional. Only NEW nodes are gated: a node
          // already in the graph (even if it was never described) is never blocked by an
          // unrelated later edit, or the backlog would stop every future commit. Checked BEFORE
          // any write — staging is untouched by a rejection here, so retrying costs nothing.
          //
          // Deduped by resolved node id, NOT checked entry-by-entry: a symbol can be staged
          // multiple times before one commit (edit it, edit it again — trail-check.ts covers
          // this accumulation deliberately), and an earlier entry with no description must not
          // block the commit when a LATER entry for that same node already carries one — e.g.
          // edit_node's own `description` param satisfying the gate on a second call after a
          // first call's description was rejected. A node counts as described if ANY of its
          // staged entries has one.
          const describedNodeIds = new Set(
            entries.filter(e => e.description).map(e => resolveEntryId(db, e))
          );
          const undescribed = Array.from(new Set(entries.map(e => resolveEntryId(db, e))))
            .filter(nodeId => !describedNodeIds.has(nodeId))
            .map(nodeId => ({ nodeId }))
            .filter(({ nodeId }) => !db.getNode(nodeId));
          if (undescribed.length > 0) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  committed: false,
                  error: `${undescribed.length} new node(s) staged in this commit have no description. Call add_description with these node_ids, then call commit_changes again — nothing staged has been lost.`,
                  undescribed_node_ids: undescribed.map(u => u.nodeId),
                  example: {
                    tool: 'add_description',
                    descriptions: undescribed.slice(0, 3).map(u => ({
                      node_id: u.nodeId,
                      description: '1-3 sentences of what this does and the domain concepts involved — not a restatement of the name.'
                    }))
                  }
                }, null, 2)
              }]
            };
          }

          const reasoning = args.reasoning as any;
          const summary = await commitStagedChanges(db, devmindPath, entries, reasoning); // no-ops cleanly when entries is empty
          clearStagedForSession(devmindPath, sessionId);

          // A summary for both the workflow step and the activity message — the commit's own
          // reasoning takes priority when it has a what_changed; a commit that only touched
          // non-code files (CSS, XML, ...) falls back to naming the file(s) instead.
          const changeSummary = entries.length
            ? summarizeEntriesForWorkflow(entries, reasoning)
            : fileEdits.length === 1
              ? path.basename(fileEdits[0].file_path)
              : `${fileEdits.length} file(s) updated`;

          // When THIS SESSION is bound to a workflow, auto-record the commit as a step — the agent
          // never needs a separate call for ordinary development work. The binding is read from the
          // local session rather than a global pointer, which is what stops two concurrent sessions
          // writing onto each other's timeline.
          //
          // `sessionId` and `node_ids` are both passed now. Neither used to be: the step's
          // session_id column existed and sat null on the path that creates nearly every step, and
          // `history_ids` was stored instead of node ids even though it cannot identify a commit
          // (two commits on one node within an hour merge into a single history row).
          let workflowStepId: string | null = null;
          const boundWorkflowId = readSessionWorkflow(devmindPath, sessionId);
          const boundWorkflow = boundWorkflowId ? db.getWorkflow(boundWorkflowId) : null;
          if (boundWorkflow) {
            const step = db.addWorkflowStep(boundWorkflow.id, {
              summary: changeSummary,
              reasoning: workflowReasoningText(reasoning),
              nodeIds: Array.from(new Set(summary.node_ids)),
              sessionId
            });
            workflowStepId = step.id;
          }

          // Local, gitignored activity log — never reaches the shared graph. entries/node_ids are
          // 1:1 in order (commitStagedChanges pushes both from the same loop), so index-matching
          // recovers each edit's resolved node id. Entries with no code_before (stage_change, which
          // takes a snapshot with nothing to diff against) contribute nothing here: there is no
          // "before" to back up, so recording one would make revert restore a guess. Whole-file
          // edits (fileEdits — nothing traced into the graph) are folded in alongside them, so
          // every file edit_node touched shows up here, not just the ones that became graph nodes.
          //
          // Sorted by staged_at (real edit_node call order), not left as "all node edits, then all
          // file edits": the same file can pick up both kinds across separate edit_node calls
          // before one commit, and the whole-file reconstruction (fileDiffForMessage) undoes a
          // file's edits newest-first — true chronological order is what makes that undo chain
          // correct instead of unwinding a state that was never actually current.
          const activityEdits = [
            ...entries
              .map((e, i) => ({ entry: e, nodeId: summary.node_ids[i] }))
              .filter(({ entry }) => entry.code_before !== undefined)
              .map(({ entry, nodeId }) => ({
                id: crypto.randomUUID(),
                node_id: nodeId,
                file_path: entry.file_path,
                at: entry.staged_at || new Date().toISOString(),
                before: entry.code_before ?? '',
                after: entry.code_snapshot
              })),
            ...fileEdits.map(fe => ({
              id: crypto.randomUUID(),
              node_id: db.toRepoRelativePath(fe.file_path),
              file_path: fe.file_path,
              at: fe.staged_at || new Date().toISOString(),
              before: fe.before,
              after: fe.after
            }))
          ].sort((a, b) => a.at.localeCompare(b.at));

          const activityMessage = recordMessage(devmindPath, {
            session_id: sessionId,
            developer: db.getDeveloperName(),
            request: requestText,
            summary: changeSummary,
            edits: activityEdits
          });

          // Mark these edits as already accounted for on the workflow. Without this, work that was
          // recorded automatically (because the session was bound) looks unattached to
          // `workflow_sync` later, and a well-meaning sync duplicates every step that was already
          // there. Both paths keep the same bookkeeping, so they can't disagree about what has
          // been attached.
          if (workflowStepId && boundWorkflow) {
            const consumed = activityEdits.map(e => e.id);
            const record = activityMessage.workflow_sync || [];
            const existing = record.find(w => w.workflow_id === boundWorkflow.id);
            if (existing) {
              existing.step_ids.push(workflowStepId);
              existing.synced_edit_ids.push(...consumed);
            } else {
              record.push({ workflow_id: boundWorkflow.id, step_ids: [workflowStepId], synced_edit_ids: consumed });
            }
            activityMessage.workflow_sync = record;
            saveMessage(devmindPath, activityMessage);
          }

          // Route feedback to its two local, gitignored logs — "none" is skipped, not recorded, so
          // the logs only ever contain something an agent actually noticed. Never blocks or slows
          // the commit response: this is a synchronous local append, already done by the time the
          // response below is built.
          const isNone = (s: string) => s.trim().toLowerCase() === 'none';
          if (!isNone(fb.graph_problems)) {
            appendGraphFeedback(devmindPath, { session_id: sessionId, category: 'graph_problem', text: fb.graph_problems });
          }
          if (!isNone(fb.edge_problems)) {
            appendGraphFeedback(devmindPath, { session_id: sessionId, category: 'edge_problem', text: fb.edge_problems });
          }
          if (!isNone(fb.tools_used)) {
            appendProductFeedback(devmindPath, { session_id: sessionId, category: 'tools_used', text: fb.tools_used });
          }
          if (!isNone(fb.dropped_and_why)) {
            appendProductFeedback(devmindPath, { session_id: sessionId, category: 'dropped_and_why', text: fb.dropped_and_why });
          }
          if (!isNone(fb.devsmind_better)) {
            appendProductFeedback(devmindPath, { session_id: sessionId, category: 'devsmind_better', text: fb.devsmind_better });
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                committed: true,
                message: `✅ Committed ${summary.nodes} node(s), ${summary.history_entries} history entr(ies), ${summary.edges_added} connection(s) resolved` +
                  (summary.missing_filled > 0 ? `, ${summary.missing_filled} missing node(s) auto-created.` : '.') +
                  (fileEdits.length ? ` ${fileEdits.length} non-code file(s) recorded to the activity log only.` : '') +
                  (workflowStepId ? ` Logged as a step on workflow "${boundWorkflow!.name}".` : '') +
                  (otherSessionsPending > 0 ? ` ${otherSessionsPending} entr(y/ies) staged by another session were left pending, untouched by this commit.` : ''),
                ...summary,
                file_edits_recorded: fileEdits.length,
                workflow_step_id: workflowStepId,
                activity_message_id: activityMessage.id,
                session_id: sessionId,
                other_sessions_pending: otherSessionsPending
              }, null, 2)
            }]
          };
        }

        // ── Deprecated write handlers: NOT advertised in ListTools (superseded by
        //    stage_change/commit_changes), but retained so any direct/legacy call still works. ──
        case 'add_node': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const rawNodeId = requireStr(args, 'node_id', 'add_node');
          const filePath = requireStr(args, 'file_path', 'add_node');

          const db = getDatabase(devmindPath);
          const repoRelPath = db.toRepoRelativePath(filePath);
          const prefix = `${repoRelPath}#`;
          const nodeId = rawNodeId.includes('#') ? rawNodeId : `${prefix}${rawNodeId}`;

          db.upsertNode({
            id: nodeId,
            name: requireStr(args, 'name', 'add_node'),
            type: requireStr(args, 'type', 'add_node'),
            file_path: filePath,
            signature: args.signature ? String(args.signature) : null
          });
          return {
            content: [{ type: 'text', text: JSON.stringify({ added: true, node_id: nodeId }) }]
          };
        }

        case 'add_connection': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          db.addConnection(requireStr(args, 'source_node_id', 'add_connection'), requireStr(args, 'target_node_id', 'add_connection'));
          return {
            content: [{ type: 'text', text: JSON.stringify({ added: true, source: args.source_node_id, target: args.target_node_id }) }]
          };
        }

        case 'recheck_graph': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const workspaceRoot = requireStr(args, 'workspace_root', 'recheck_graph');
          const db = getDatabase(devmindPath);
          const result = db.pruneSpuriousNodes(workspaceRoot);
          db.vacuum();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `✅ Graph recheck completed. Pruned ${result.prunedCount} spurious node(s) and their connections.`,
                pruned_count: result.prunedCount,
                pruned_nodes: result.prunedNodes
              }, null, 2)
            }]
          };
        }

        case 'get_node_history': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const nodeId = requireStr(args, 'node_id', 'get_node_history');
          const db = getDatabase(devmindPath);
          const history = db.getFullHistory(nodeId);
          return {
            content: [{ type: 'text', text: JSON.stringify(history, null, 2) }]
          };
        }

        case 'get_node_graph': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const nodeId = requireStr(args, 'node_id', 'get_node_graph');
          const rawMaxDepth = args.max_depth ? Number(args.max_depth) : 6;
          const maxDepth = Number.isFinite(rawMaxDepth) ? Math.min(10, Math.max(1, Math.trunc(rawMaxDepth))) : 6;
          const direction =
            args.direction === 'out' || args.direction === 'in' || args.direction === 'both'
              ? args.direction
              : 'both';
          const db = getDatabase(devmindPath);
          const graph = db.getGraph(nodeId, maxDepth, {
            direction,
            includeCode: args.include_code === true,
            // Same NaN-means-unlimited hole this tool's replacement had; fixed here too even though
            // the tool is unadvertised, since the retained handler still serves legacy callers.
            // Keeps getGraph's own 60000 default — only the get_node_code path gets the lower one.
            codeCharBudget: args.code_char_budget !== undefined
              ? clampInt(args.code_char_budget, 60_000, 0, 200_000)
              : undefined
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(graph, null, 2) }]
          };
        }

        case 'search_nodes': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          // `query` and `pattern` are each optional individually — `db.searchNodes` itself throws
          // a clear error if BOTH are absent, which the outer try/catch below turns into a clean
          // isError response, so no duplicate validation here.
          const query = args.query ? String(args.query) : undefined;
          const pattern = args.pattern ? String(args.pattern) : undefined;
          const searchPath = args.path ? String(args.path) : undefined;
          const caseInsensitive = args.case_insensitive !== false;
          // Clamped, because the unvalidated version failed in the most misleading way available:
          // `limit:"abc"` became NaN, `slice(0, NaN)` returned [], and the agent saw an empty
          // `files` bucket sitting next to a `files_total` of 40 — indistinguishable from "grep
          // found nothing". A negative offset paged from the END of the ranking; a huge limit was
          // an uncapped firehose, which is the very payload size this change set exists to bound.
          const offset = args.offset !== undefined ? clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
          const limit = args.limit !== undefined ? clampInt(args.limit, 25, 1, 200) : undefined;
          const db = getDatabase(devmindPath);
          // Returns the two-bucket `{ nodes, files, files_total, files_offset, nodes_total, hint?,
          // truncated? }` shape directly — including the empty+hint case when nothing matched
          // anywhere. Async: vector inference and the filesystem grep walk run concurrently inside
          // (a no-op vector fallback if ONNX absent; vector is skipped entirely when `query` is
          // absent — a regex has no meaning to embed).
          // `compact` is tri-state on purpose: true = always trim, false = never trim (give me
          // everything, I'll deal with it), omitted = decide from the actual size. Auto is the
          // default because the failure this fixes is one the caller can't predict — they don't
          // know a query will produce 56KB until it already has.
          const forceCompact = args.compact === true;
          const forbidCompact = args.compact === false;
          const payload = await db.searchNodes(query, { pattern, path: searchPath, case_insensitive: caseInsensitive, offset, limit, compact: forceCompact });

          // Note the absence of `null, 2`. Pretty-printing a payload whose bulk is deeply-nested
          // arrays of short strings spends 20-30% of the response on indentation that buys the
          // reader nothing — MCP clients parse this, they don't read it. Free size reduction with
          // zero semantic loss, applied before any tier is even considered.
          let text = JSON.stringify(payload);
          let out: SearchNodesResult | CompactSearchNodesResult = payload;

          if (forceCompact) {
            out = { ...toCompactSearchResult(payload, 2), compacted: COMPACT_NOTE_FORCED };
            text = JSON.stringify(out);
          } else if (!forbidCompact && text.length > SEARCH_COMPACT_THRESHOLD) {
            // Tier 1 first — it drops what is bulk without being evidence, and usually that alone
            // is enough. Only fall through to the triage-only tier if the result is STILL too big,
            // rather than throwing away the sample lines (the part agents actually credit with
            // catching real bugs) the moment the payload crosses a line.
            out = { ...toCompactSearchResult(payload, 1), compacted: COMPACT_NOTE_TIER1 };
            text = JSON.stringify(out);
            if (text.length > SEARCH_COMPACT_THRESHOLD) {
              out = { ...toCompactSearchResult(payload, 2), compacted: COMPACT_NOTE_TIER2 };
              text = JSON.stringify(out);
            }
          }

          return {
            content: [{ type: 'text', text }]
          };
        }

        case 'rename_node': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const oldNodeId = requireStr(args, 'old_node_id', 'rename_node');
          const newNodeId = requireStr(args, 'new_node_id', 'rename_node');
          const newName = args.new_name ? String(args.new_name) : undefined;
          const db = getDatabase(devmindPath);
          db.renameNode(oldNodeId, newNodeId, newName);
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, old_node_id: oldNodeId, new_node_id: newNodeId }) }]
          };
        }

        case 'deprecate_node': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const nodeId = requireStr(args, 'node_id', 'deprecate_node');
          const db = getDatabase(devmindPath);
          db.deprecateNode(nodeId);
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, deprecated: nodeId }) }]
          };
        }

        case 'read_graph_feedback': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const includeProcessed = args.include_processed === true;
          const entries = readGraphFeedback(devmindPath, { includeProcessed });
          const clusters = clusterGraphFeedback(entries);
          return {
            content: [{ type: 'text', text: JSON.stringify({ total_entries: entries.length, clusters }, null, 2) }]
          };
        }

        case 'mark_graph_feedback_processed': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const ids = Array.isArray(args.feedback_ids) ? args.feedback_ids.map(String) : [];
          if (ids.length === 0) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'mark_graph_feedback_processed needs a non-empty feedback_ids array.' }) }] };
          }
          markGraphFeedbackProcessed(devmindPath, ids);
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, marked_processed: ids }) }]
          };
        }

        case 'link_nodes': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const fromNodeId = requireStr(args, 'from_node_id', 'link_nodes');
          const toNodeId = requireStr(args, 'to_node_id', 'link_nodes');
          const evidenceFile = requireStr(args, 'evidence_file', 'link_nodes');
          const evidenceSnippet = args.evidence_snippet ? String(args.evidence_snippet) : undefined;
          const db = getDatabase(devmindPath);

          const fromNode = db.getNode(fromNodeId);
          const toNode = db.getNode(toNodeId);
          if (!fromNode) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `link_nodes: from_node_id not found: ${fromNodeId}` }) }] };
          }
          if (!toNode) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `link_nodes: to_node_id not found: ${toNodeId}` }) }] };
          }
          const verified = verifyEvidence(evidenceFile, evidenceSnippet);
          if (!verified.ok) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `link_nodes: evidence verification failed — ${verified.reason}` }) }] };
          }

          db.addConnection(fromNode.id, toNode.id);
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, from_node_id: fromNode.id, to_node_id: toNode.id }) }]
          };
        }

        case 'record_alias': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const nodeId = requireStr(args, 'node_id', 'record_alias');
          const alias = requireStr(args, 'alias', 'record_alias');
          const evidenceFile = requireStr(args, 'evidence_file', 'record_alias');
          const evidenceSnippet = args.evidence_snippet ? String(args.evidence_snippet) : undefined;
          const db = getDatabase(devmindPath);

          const node = db.getNode(nodeId);
          if (!node) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `record_alias: node_id not found: ${nodeId}` }) }] };
          }
          const verified = verifyEvidence(evidenceFile, evidenceSnippet);
          if (!verified.ok) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `record_alias: evidence verification failed — ${verified.reason}` }) }] };
          }

          db.addAlias(node.id, alias);
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, node_id: node.id, alias }) }]
          };
        }

        case 'merge_nodes': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const fromNodeId = requireStr(args, 'from_node_id', 'merge_nodes');
          const intoNodeId = requireStr(args, 'into_node_id', 'merge_nodes');
          const db = getDatabase(devmindPath);
          try {
            db.mergeNodes(fromNodeId, intoNodeId);
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }] };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, from_node_id: fromNodeId, into_node_id: intoNodeId }) }]
          };
        }

        case 'split_node': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const nodeId = requireStr(args, 'node_id', 'split_node');
          const newSymbols = Array.isArray(args.new_symbols) ? args.new_symbols.map(String) : [];
          if (newSymbols.length === 0) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'split_node needs a non-empty new_symbols array.' }) }] };
          }
          const db = getDatabase(devmindPath);
          const result = splitNode(db, nodeId, newSymbols);
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: result.created.length > 0, ...result }) }]
          };
        }

        case 'create_missing_node': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const filePath = requireStr(args, 'file_path', 'create_missing_node');
          const symbolName = requireStr(args, 'symbol_name', 'create_missing_node');
          const db = getDatabase(devmindPath);

          const derived = extractNodeFromFile(filePath, symbolName);
          if (!derived) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `create_missing_node: could not locate '${symbolName}' in ${filePath} — not a parseable file, or the symbol does not exist there.` }) }] };
          }
          const nodeId = `${db.toRepoRelativePath(filePath)}#${symbolName}`;
          db.upsertNode({ id: nodeId, name: derived.name, type: derived.type, file_path: filePath, signature: derived.signature });
          db.updateHistory({
            node_id: nodeId,
            code_snapshot: derived.codeSnapshot,
            reasoning: {
              what_changed: 'Created from a batch graph-fix session correction (create_missing_node)',
              why: 'A graph-problem report pointed at a real symbol the indexer never extracted',
              goal: 'Fill an indexing gap deterministically from the AST',
              model: 'ast'
            }
          });
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, node_id: nodeId }) }]
          };
        }

        case 'flag_indexer_rule': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const pattern = requireStr(args, 'pattern', 'flag_indexer_rule');
          const evidenceCount = typeof args.evidence_count === 'number' ? args.evidence_count : Number(args.evidence_count) || 0;
          const examples = Array.isArray(args.examples) ? args.examples.map(String) : [];
          appendIndexerRuleCandidate(devmindPath, { pattern, evidence_count: evidenceCount, examples });
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, pattern }) }]
          };
        }

        case 'get_activity_log': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const rawSource = args.source ? String(args.source) : 'auto';
          if (!['auto', 'local', 'graph', 'both'].includes(rawSource)) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `get_activity_log: source must be one of auto|local|graph|both, got "${rawSource}"` }) }] };
          }
          const result = resolveActivityLog(db, devmindPath, rawSource as ActivitySourceMode, {
            developer: args.developer ? String(args.developer) : undefined,
            sessionId: args.session_id ? String(args.session_id) : undefined,
            sinceHours: args.since_hours !== undefined ? Number(args.since_hours) : undefined,
            since: args.since ? String(args.since) : undefined,
            until: args.until ? String(args.until) : undefined,
            requirementContains: args.requirement_contains ? String(args.requirement_contains) : undefined,
            limit: args.limit !== undefined ? Number(args.limit) : undefined
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        }

        case 'search_decisions': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const query = requireStr(args, 'query', 'search_decisions');
          const db = getDatabase(devmindPath);
          const decisions = db.searchDecisions(query);
          return {
            content: [{ type: 'text', text: JSON.stringify(decisions, null, 2) }]
          };
        }

        case 'search_code': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const query = requireStr(args, 'query', 'search_code');
          const isRegex = args.is_regex === true;
          const caseInsensitive = args.case_insensitive !== false;
          const db = getDatabase(devmindPath);
          const results = db.searchCode({ query, is_regex: isRegex, case_insensitive: caseInsensitive });
          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }]
          };
        }

        case 'get_orphaned_nodes': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const nodes = db.getOrphanedNodes();
          return {
            content: [{ type: 'text', text: JSON.stringify(nodes, null, 2) }]
          };
        }

        case 'get_visualizer_url': {
          const devmindPath = path.resolve(resolveDevmindPath(args.devmind_path));
          const devmindPathEscaped = encodeURIComponent(devmindPath);
          // ONE url. This used to also advertise `/3d?path=…`, left over from when 2D and 3D were
          // separate pages — that route no longer exists, so anything following it got a 404. The
          // 3D toggle lives inside the Graph tab of the single-page app now.
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                url: `http://localhost:${DEVSMIND_PORT}/?path=${devmindPathEscaped}`,
                note: 'One page: Chat and Graph tabs. The Graph tab has a 2D/3D toggle and a whole-graph overlay — there are no separate 2D/3D URLs.'
              }, null, 2)
            }]
          };
        }

        case 'analyze_graph': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const workspaceRoot = path.dirname(devmindPath);
          const db = getDatabase(devmindPath);
          const godEntityThreshold = args.god_entity_threshold ? Number(args.god_entity_threshold) : undefined;
          const report = runAnalysis(db, workspaceRoot, {
            fix: args.fix === true,
            godEntityThreshold: Number.isFinite(godEntityThreshold) ? godEntityThreshold : undefined
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(report, null, 2) }]
          };
        }

        case 'workflow_create': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const workflow = db.createWorkflow(
            requireStr(args, 'name', 'workflow_create'),
            requireStr(args, 'description', 'workflow_create')
          );
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'created', workflow }, null, 2) }] };
        }

        case 'workflow_add_step': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const workflowId = args.workflow_id ? String(args.workflow_id) : readSessionWorkflow(devmindPath, sessionId);
          if (!workflowId) {
            return {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ error: 'This session is not bound to a workflow and no workflow_id was given. Call workflow_bind first, or pass workflow_id explicitly.' }) }]
            };
          }

          // `doc_paths` are validated, not trusted. A step is committed and read by teammates, so a
          // path outside the configured repos is worse than useless — it resolves to nothing on
          // anyone else's machine. Rejected outright rather than stored and quietly broken later.
          const rawDocs = Array.isArray(args.doc_paths) ? args.doc_paths.map(String) : [];
          const workspaceRoot = path.dirname(devmindPath);
          const docPaths: string[] = [];
          for (const raw of rawDocs) {
            const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspaceRoot, raw);
            if (!db.isPathAllowed(abs)) {
              return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify({ error: `doc_path resolves outside this project's configured repos, so it would not exist for anyone else: ${raw}` }) }]
              };
            }
            if (!fs.existsSync(abs)) {
              return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify({ error: `doc_path does not exist on disk: ${raw}` }) }]
              };
            }
            docPaths.push(db.toRepoRelativePath(abs));
          }

          const step = db.addWorkflowStep(workflowId, {
            summary: requireStr(args, 'summary', 'workflow_add_step'),
            reasoning: args.reasoning ? String(args.reasoning).slice(0, STEP_REASONING_CAP) : undefined,
            nodeIds: Array.isArray(args.node_ids) ? args.node_ids.map(String) : undefined,
            docPaths: docPaths.length ? docPaths : undefined,
            sessionId
          });
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'added', step }, null, 2) }] };
        }

        case 'workflow_bind': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const rawId = args.workflow_id ? String(args.workflow_id) : null;
          if (rawId) {
            const workflow = db.getWorkflow(rawId);
            if (!workflow) {
              return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `workflow_bind: workflow_id not found: ${rawId}` }) }] };
            }
            bindSessionWorkflow(devmindPath, sessionId, workflow.id, db.getDeveloperName());
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'bound',
                  workflow,
                  message: `This session is now on "${workflow.name}". Every commit_changes from here adds a step to it, until you unbind (call workflow_bind with no workflow_id). Binding is local to this session — it does not move anyone else's.`
                }, null, 2)
              }]
            };
          }
          bindSessionWorkflow(devmindPath, sessionId, null, db.getDeveloperName());
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'unbound',
                message: 'This session is no longer on a workflow. Later commits attach to nothing — if that turns out to be wrong, workflow_sync can attach them afterwards.'
              }, null, 2)
            }]
          };
        }

        case 'workflow_list': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const query = args.query ? String(args.query) : undefined;
          const includeArchived = args.include_archived === true;
          const limit = clampInt(args.limit, 25, 1, 200);
          const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
          const total = db.countWorkflows({ query, includeArchived });
          const workflows = db.listWorkflows({ query, includeArchived, limit, offset });
          const payload: Record<string, unknown> = {
            workflows,
            total,
            offset,
            bound_workflow_id: readSessionWorkflow(devmindPath, sessionId)
          };
          if (offset + workflows.length < total) {
            payload.truncated = true;
            payload.hint = `${total} workflows match; showing ${offset + 1}-${offset + workflows.length}. Pass offset:${offset + workflows.length} for the next page, or narrow with query.`;
          }
          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
        }

        case 'workflow_get_context': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const lastN = clampInt(args.last_n, 0, 0, 500);
          const context = db.getWorkflowContext(requireStr(args, 'workflow_id', 'workflow_get_context'), {
            last_n: lastN > 0 ? lastN : undefined,
            limit: lastN > 0 ? undefined : clampInt(args.limit, 50, 1, 500),
            offset: lastN > 0 ? undefined : clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)
          });

          const payload: Record<string, unknown> = { ...context };
          if (context.steps_offset + context.steps.length < context.steps_total) {
            payload.truncated = true;
            payload.hint = `${context.steps_total} steps total, showing ${context.steps_offset + 1}-${context.steps_offset + context.steps.length}. Pass offset:${context.steps_offset + context.steps.length} for the next page, or last_n to read the most recent steps instead.`;
          }

          // Same shrink-to-fit contract as search_nodes/list_nodes: trim the biggest field first
          // (per-step reasoning), then the node lists, and always say which happened. Counts are
          // never touched, so a trimmed story can't be mistaken for the whole one.
          let text = JSON.stringify(payload);
          if (text.length > SEARCH_COMPACT_THRESHOLD) {
            payload.steps = context.steps.map(({ reasoning, ...rest }) => rest);
            payload.compacted = 'Per-step reasoning was dropped to fit. Counts are exact. Read fewer steps at a time (last_n, or limit/offset) to get the reasoning back.';
            text = JSON.stringify(payload);
            if (text.length > SEARCH_COMPACT_THRESHOLD) {
              payload.steps = context.steps.map(s => ({ step_index: s.step_index, summary: s.summary, created_at: s.created_at }));
              payload.compacted = 'Trimmed hard to fit: step index, summary and date only. Counts are exact. Read fewer steps at a time (last_n, or limit/offset) for reasoning and node lists.';
              text = JSON.stringify(payload);
            }
          }
          return { content: [{ type: 'text', text }] };
        }

        case 'workflow_archive': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const workflow = db.setWorkflowArchived(
            requireStr(args, 'workflow_id', 'workflow_archive'),
            args.archived !== false
          );
          return { content: [{ type: 'text', text: JSON.stringify({ status: workflow.archived ? 'archived' : 'unarchived', workflow }, null, 2) }] };
        }

        case 'workflow_sync': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const workflowId = requireStr(args, 'workflow_id', 'workflow_sync');
          const workflow = db.getWorkflow(workflowId);
          if (!workflow) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `workflow_sync: workflow_id not found: ${workflowId}` }) }] };
          }

          // Reads the LOCAL activity log — which is what makes this a real sync rather than the
          // old version, where the agent hand-assembled a `steps` array from its own context and
          // the server just wrote whatever it was handed.
          const sinceHours = clampInt(args.since_hours, 0, 0, 24 * 90);
          const scopeSession = args.all_sessions === true ? undefined : sessionId;
          const log = queryActivityLog(devmindPath, {
            sessionId: scopeSession,
            sinceHours: sinceHours > 0 ? sinceHours : undefined,
            limit: 200
          });
          if (log.entries.length === 0) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'nothing_to_sync',
                  message: 'No local activity found for this scope. The activity log lives in .devmind/local/ and is not shared, so there is nothing to attach if it was cleared or the work happened on another machine.'
                }, null, 2)
              }]
            };
          }

          const explicitIds = Array.isArray(args.message_ids) ? new Set(args.message_ids.map(String)) : null;
          const proposals: { message_id: string; summary: string; node_ids: string[]; edit_ids: string[]; created_at: string }[] = [];

          for (const entry of log.entries) {
            if (explicitIds && !explicitIds.has(entry.id)) continue;
            const message = readMessage(devmindPath, entry.id);
            if (!message) continue;
            // Already-consumed edits are skipped rather than whole messages: a message keeps
            // growing after it is first synced, so "have I seen this message" would strand
            // everything appended later.
            const alreadySynced = new Set(
              (message.workflow_sync || []).filter(w => w.workflow_id === workflowId).flatMap(w => w.synced_edit_ids)
            );
            const fresh = message.edits.filter(e => !alreadySynced.has(e.id));
            if (fresh.length === 0) continue;
            // A whole-file edit stores a repo-relative PATH in node_id, not a node id — keeping
            // those would put strings in the step that get_node_code can never resolve.
            const nodeIds = Array.from(new Set(fresh.map(e => e.node_id))).filter(id => !!db.getNode(id));
            proposals.push({
              message_id: message.id,
              // `summary` deliberately, never `request`: request is the developer's verbatim
              // prompt, and .devmind/local/ is gitignored precisely because that text is private.
              // Workflow steps are committed and read by the whole team.
              summary: message.summary,
              node_ids: nodeIds,
              edit_ids: fresh.map(e => e.id),
              created_at: message.created_at
            });
          }

          if (proposals.length === 0) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ status: 'nothing_to_sync', message: `Everything in scope is already on "${workflow.name}".` }, null, 2)
              }]
            };
          }

          // Dry run by default. MCP has no interactive primitive, so "show, then confirm" is two
          // calls — and defaulting to the safe one means a mis-scoped sync costs a turn rather
          // than silently rewriting a shared timeline.
          if (args.confirm !== true) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'proposed',
                  workflow: { id: workflow.id, name: workflow.name },
                  proposed_steps: proposals.map(p => ({ message_id: p.message_id, summary: p.summary, node_ids: p.node_ids, created_at: p.created_at })),
                  message: `Nothing written yet. Show these ${proposals.length} step(s) to the user, then call again with confirm:true (optionally narrowing with message_ids) to attach them.`
                }, null, 2)
              }]
            };
          }

          const created: { step_id: string; message_id: string }[] = [];
          for (const p of proposals) {
            const step = db.addWorkflowStep(workflowId, {
              summary: p.summary,
              nodeIds: p.node_ids.length ? p.node_ids : undefined,
              sessionId
            });
            const message = readMessage(devmindPath, p.message_id);
            if (message) {
              const record = message.workflow_sync || [];
              const existing = record.find(w => w.workflow_id === workflowId);
              if (existing) {
                existing.step_ids.push(step.id);
                existing.synced_edit_ids.push(...p.edit_ids);
              } else {
                record.push({ workflow_id: workflowId, step_ids: [step.id], synced_edit_ids: [...p.edit_ids] });
              }
              message.workflow_sync = record;
              saveMessage(devmindPath, message);
            }
            created.push({ step_id: step.id, message_id: p.message_id });
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'synced',
                workflow: { id: workflow.id, name: workflow.name },
                steps_added: created.length,
                steps: created,
                message: 'Re-running this is a no-op — the edits behind these steps are marked as consumed.'
              }, null, 2)
            }]
          };
        }

        case 'workflow_import': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const result = importWorkflowDocs(db, args.folder_path ? String(args.folder_path) : undefined, args.file_path ? String(args.file_path) : undefined);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        // NOTE: `workflow_pause` and `workflow_resume` are retained as thin aliases for
        // `workflow_bind`. Their old meaning — move a single global pointer, pausing whoever else
        // held it — no longer exists, and could not be reproduced without reintroducing the bug
        // that made two sessions overwrite each other. Binding this session is the honest
        // equivalent of what a caller wanted from them.
        case 'workflow_pause':
        case 'workflow_resume': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          if (name === 'workflow_pause') {
            bindSessionWorkflow(devmindPath, sessionId, null, db.getDeveloperName());
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'unbound', message: 'workflow_pause now unbinds THIS session only — use workflow_bind.' }, null, 2) }] };
          }
          const workflow = db.getWorkflow(requireStr(args, 'workflow_id', 'workflow_resume'));
          if (!workflow) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'workflow_resume: workflow_id not found.' }) }] };
          }
          bindSessionWorkflow(devmindPath, sessionId, workflow.id, db.getDeveloperName());
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'bound', workflow, message: 'workflow_resume now binds THIS session only — use workflow_bind.' }, null, 2) }] };
        }

        case 'start_session': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const label = args.label ? String(args.label) : undefined;
          const session = createSession(devmindPath, sessionId, db.getDeveloperName(), label);

          // Offer to continue whatever was last worked on — but ONLY when there is something to
          // offer. Asking every session "are you continuing a workflow?" would put friction on the
          // large majority that are not, so when nothing recent exists these keys are simply
          // absent and the agent has nothing to raise.
          const payload: Record<string, unknown> = {
            session_id: session.id,
            started_at: session.started_at,
            label: session.label ?? null,
            message: 'Session started — pass this session_id on every DevsMind call for the rest of this conversation.'
          };
          const lastId = lastBoundWorkflowId(devmindPath, sessionId);
          const resumable = lastId ? db.getWorkflow(lastId) : null;
          if (resumable && !resumable.archived) {
            payload.resumable_workflow = { id: resumable.id, name: resumable.name, description: resumable.description, updated_at: resumable.updated_at };
            payload.resumable_prompt = `The last workflow worked on here was "${resumable.name}" (${resumable.updated_at.slice(0, 10)}). Ask the user whether this session continues it — if yes call workflow_bind with that id, if no just carry on unbound.`;
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
          };
        }

        default:
          throw new Error(`Tool not found: ${name}`);
      }
    };

    let result: any;
    try {
      result = await run();
    } catch (err) {
      console.error(`[DevsMind Error] Tool execution failed: ${(err as Error).message}`);
      result = {
        isError: true,
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }]
      };
    }

    // Echo the session id so it survives context compaction — but only when there IS one. Exempt
    // read-only tools run with sessionId '' (falsy); appending a "reuse this" line for a session
    // that was never minted would be misleading, so skip it for them.
    return {
      ...result,
      content: [
        ...(result.content ?? []),
        ...(sessionId
          ? [{ type: 'text', text: `devsmind_session_id: ${sessionId}  (required on every DevsMind write call for the rest of this conversation — reuse this exact value)` }]
          : [])
      ]
    };
  });

  return server;
}

// â”€â”€ Graceful shutdown helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function registerShutdownHandlers(httpServer?: http.Server) {
  const shutdown = () => {
    cleanup();
    if (httpServer) {
      httpServer.close(() => process.exit(0));
    } else {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// â”€â”€ HTTP mode (default) — port 4513 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Start DevsMind as an HTTP MCP server on port 4513.
 * IDEs connect via: http://localhost:4513/mcp
 *
 * Port mnemonic: devsâ†’45 (D=4,E=5)  +  mindâ†’13 (M=13)  =  4513
 */

/** True only for an Origin this server could itself have served — it binds loopback only. */
function isLocalOrigin(origin: string, port: number): boolean {
  try {
    const u = new URL(origin);
    return (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
      && u.port === String(port);
  } catch {
    return false;
  }
}

/**
 * Which edit of an entry can be reverted, and why the newest one can't when it can't.
 *
 * Only the newest qualifies: every edit after an older one was written against the code it
 * produced, so restoring its "before" would silently drop that later work. It also has to still
 * match the file — comparing directly rather than reading `snapshot_outdated`, which conflates
 * "drifted" with "couldn't be checked" and would wave through a symbol that no longer parses.
 */
function revertability(db: DevMindDatabase, entry: { node_id: string; edits: { after: string }[] }):
  { revertableIndex: number; blockedReason?: string } {
  if (!entry.edits.length) return { revertableIndex: -1 };
  const last = entry.edits[entry.edits.length - 1];
  const live = db.getLiveCode(entry.node_id);

  if (live.source !== 'live' || live.code === undefined) {
    return { revertableIndex: -1, blockedReason: 'Could not read this symbol from its file to confirm what is there now — it may have been renamed, moved, or deleted. Use git to restore it.' };
  }
  if (live.code !== last.after) {
    return { revertableIndex: -1, blockedReason: 'The code has changed since this was recorded — reverting would discard the newer change. Use git to restore it.' };
  }
  return { revertableIndex: entry.edits.length - 1 };
}

/**
 * Builds the Express app (view UI + activity/revert APIs + the stateless /mcp endpoint) without
 * binding a port. Exported so tests can drive it in-process via supertest; `runHttpMcpServer`
 * below is the only caller that actually `listen()`s on it.
 */
export function createHttpApp(port: number = DEVSMIND_PORT): express.Application {
  const app = express();
  app.use(express.json());

  // Health-check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      name: 'devsmind-mcp-server',
      version: DEVSMIND_VERSION,
      port,
      transport: 'http+streamable',
      endpoint: `http://localhost:${port}/mcp`
    });
  });

  // View app — one page, Chat + Graph sections, fully offline (no CDN dependencies). Never
  // cached: this shell (and the app JS below) can change between server restarts during
  // development, and a stale cached copy paired with a fresh one would break silently.
  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    res.send(getViewHtml());
  });

  // Static app JS/CSS, served from ASSETS_DIR (src/mcp under tsx dev, dist/mcp once built).
  // Whitelisted by exact basename — this is the only thing these two routes ever read off disk.
  const APP_FILES: Record<string, string> = {
    'view.css': 'text/css; charset=utf-8',
    'view.js': 'application/javascript; charset=utf-8',
    'view_chat.js': 'application/javascript; charset=utf-8',
    'view_graph.js': 'application/javascript; charset=utf-8'
  };
  app.get('/app/:file', (req, res) => {
    const contentType = APP_FILES[req.params.file];
    if (!contentType) return res.status(404).end();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(ASSETS_DIR, req.params.file));
  });

  // Vendored graph libraries — committed, served locally so the view works with no internet.
  const VENDOR_FILES = new Set(['three.min.js', '3d-force-graph.min.js', 'force-graph.min.js']);
  app.get('/vendor/:file', (req, res) => {
    if (!VENDOR_FILES.has(req.params.file)) return res.status(404).end();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(path.join(ASSETS_DIR, 'vendor', req.params.file));
  });

  // Graph Data API endpoint
  app.get('/api/graph-data', (req, res) => {
    try {
      const devmindPath = req.query.path ? String(req.query.path) : path.join(process.cwd(), '.devmind');
      if (!fs.existsSync(devmindPath)) {
        return res.status(400).json({ error: `Brain directory not found at: ${devmindPath}` });
      }
      const db = getDatabase(devmindPath);
      const nodes = db.getAllNodes();
      const connections = db.getAllConnections();
      // This payload already carries a full snapshot per entry for the whole repo; the edit trail
      // holds a before AND an after per edit on top of that, so it is summarized to a count here
      // and fetched per entry from /api/node-diff only when someone actually opens one.
      const history = db.getAllHistory().map(h => {
        const { edits, ...rest } = h;
        return { ...rest, edit_count: edits.length };
      });
      res.json({ nodes, connections, history });
    } catch (err) {
      console.error('[DevsMind API Error]:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Per-edit diffs for one history entry.
  app.get('/api/node-diff', (req, res) => {
    try {
      const devmindPath = req.query.path ? String(req.query.path) : path.join(process.cwd(), '.devmind');
      const historyId = req.query.history_id ? String(req.query.history_id) : '';
      if (!historyId) return res.status(400).json({ error: 'history_id is required' });
      if (!fs.existsSync(devmindPath)) {
        return res.status(400).json({ error: `Brain directory not found at: ${devmindPath}` });
      }

      const db = getDatabase(devmindPath);
      const entry = db.getHistoryEntry(historyId);
      if (!entry) return res.status(404).json({ error: 'history entry not found' });

      const { revertableIndex, blockedReason } = revertability(db, entry);
      res.json({
        history_id: entry.id,
        node_id: entry.node_id,
        edits: diffEdits(entry.edits, { revertableIndex, blockedReason })
      });
    } catch (err) {
      console.error('[DevsMind API Error]:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // The only route that writes to source files. Loopback binding keeps the network out, but not
  // another site in this browser — hence the token, which only a page this server rendered has.
  app.post('/api/revert', (req, res) => {
    try {
      if (req.get('X-Devsmind-Token') !== DEVSMIND_TOKEN) {
        return res.status(403).json({ error: 'forbidden' });
      }
      const origin = req.get('Origin');
      if (origin && !isLocalOrigin(origin, port)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      if (!req.is('application/json')) {
        return res.status(415).json({ error: 'expected application/json' });
      }

      const devmindPath = req.body?.path ? String(req.body.path) : path.join(process.cwd(), '.devmind');
      const historyId = req.body?.history_id ? String(req.body.history_id) : '';
      if (!historyId) return res.status(400).json({ error: 'history_id is required' });
      if (!fs.existsSync(devmindPath)) {
        return res.status(400).json({ error: `Brain directory not found at: ${devmindPath}` });
      }

      const db = getDatabase(devmindPath);
      const entry = db.getHistoryEntry(historyId);
      if (!entry) return res.status(404).json({ error: 'history entry not found' });

      const result = revertLastEdit(db, devmindPath, entry.node_id, historyId);
      if (!result.ok) return res.status(409).json({ ok: false, error: result.error });
      res.json(result);
    } catch (err) {
      console.error('[DevsMind API Error]:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Local activity timeline — sessions/messages, read from .devmind/local/ (gitignored, never
  // committed). Diffs are NOT shipped here (see /api/message-diff), same reasoning as
  // /api/graph-data: this is one developer's whole history, fetched on every page load.
  app.get('/api/activity', (req, res) => {
    try {
      const devmindPath = req.query.path ? String(req.query.path) : path.join(process.cwd(), '.devmind');
      if (!fs.existsSync(devmindPath)) {
        return res.status(400).json({ error: `Brain directory not found at: ${devmindPath}` });
      }

      const db = getDatabase(devmindPath);
      const allMessages = listMessages(devmindPath);
      // Ascending, so index position doubles as "how many messages come after this one" — the
      // basis for both `can_unrevert` (must be the OLDEST reverted one) and `later_applied_count`
      // (the revert cascade preview), matching the rules message-revert.ts enforces server-side.
      const ascending = allMessages.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
      const oldestReverted = ascending.find(m => m.status === 'reverted');

      const messageView = (m: (typeof allMessages)[number]) => {
        const idx = ascending.findIndex(x => x.id === m.id);
        // Not-fully-reverted later messages — what a revert of THIS message would also cascade
        // into (revertMessage sweeps up 'applied' and 'partial' alike, only 'reverted' is skipped).
        const laterApplied = ascending.slice(idx + 1).filter(x => x.status !== 'reverted').length;
        return {
          id: m.id,
          session_id: m.session_id,
          request: m.request,
          summary: m.summary,
          status: m.status,
          created_at: m.created_at,
          updated_at: m.updated_at,
          edit_count: m.edits.length,
          reverted_edit_count: m.edits.filter(e => e.reverted).length,
          node_ids: m.edits.map(e => e.node_id),
          // A fully-reverted message can only un-revert if it's the oldest one in that state
          // (the stack's ordering rule); a `partial` message was touched by a surgical file/edit
          // revert instead, so it can un-revert independently, no ordering constraint.
          can_unrevert: (m.status === 'reverted' && oldestReverted?.id === m.id) || m.status === 'partial',
          later_applied_count: m.status !== 'reverted' ? laterApplied : undefined
        };
      };

      const byId = new Map(allMessages.map(m => [m.id, m]));
      const sessions = readSessions(devmindPath)
        .map(s => ({
          id: s.id,
          label: s.label ?? null,
          started_at: s.started_at,
          last_active: s.last_active,
          messages: s.message_ids.map(id => byId.get(id)).filter((m): m is NonNullable<typeof m> => !!m).map(messageView)
        }))
        .filter(s => s.messages.length > 0);

      res.json({ developer: db.getDeveloperName(), sessions });
    } catch (err) {
      console.error('[DevsMind API Error]:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Per-edit diffs for one message, fetched only when a human expands it in the Activity page.
  app.get('/api/message-diff', (req, res) => {
    try {
      const devmindPath = req.query.path ? String(req.query.path) : path.join(process.cwd(), '.devmind');
      const messageId = req.query.message_id ? String(req.query.message_id) : '';
      if (!messageId) return res.status(400).json({ error: 'message_id is required' });
      if (!fs.existsSync(devmindPath)) {
        return res.status(400).json({ error: `Brain directory not found at: ${devmindPath}` });
      }

      const message = readMessage(devmindPath, messageId);
      if (!message) return res.status(404).json({ error: 'message not found' });

      res.json({
        message_id: message.id,
        edits: message.edits.map(e => ({
          node_id: e.node_id,
          file_path: e.file_path,
          lines: diffSnapshots(e.before, e.after)
        }))
      });
    } catch (err) {
      console.error('[DevsMind API Error]:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Whole-file, git-style diff for a message — collapses every edit the message made to one file
  // into a single diff, even when several functions in that file changed. Reconstructs the
  // pre-message file in memory (never writes to disk); a drifted file (hand-edited since, or a
  // later message touched the same text) falls back to the per-node diffs /api/message-diff
  // already ships, so the message still renders something rather than a guessed-at diff.
  app.get('/api/message-file-diff', (req, res) => {
    try {
      const devmindPath = req.query.path ? String(req.query.path) : path.join(process.cwd(), '.devmind');
      const messageId = req.query.message_id ? String(req.query.message_id) : '';
      if (!messageId) return res.status(400).json({ error: 'message_id is required' });
      if (!fs.existsSync(devmindPath)) {
        return res.status(400).json({ error: `Brain directory not found at: ${devmindPath}` });
      }

      const message = readMessage(devmindPath, messageId);
      if (!message) return res.status(404).json({ error: 'message not found' });

      const byFile = new Map<string, typeof message.edits>();
      for (const e of message.edits) {
        const arr = byFile.get(e.file_path) || [];
        arr.push(e);
        byFile.set(e.file_path, arr);
      }

      // Per-edit metadata (id, node_id, at, reverted, a mini diff) so the client can offer
      // whole-file AND single-edit revert/un-revert buttons from this one lazy-loaded call,
      // without a separate round trip per edit. `lines` is computed here (not shipped as raw
      // before/after) since the diff algorithm itself only exists server-side.
      const editMeta = (edits: typeof message.edits) =>
        edits.map(e => ({ id: e.id, node_id: e.node_id, at: e.at, reverted: !!e.reverted, lines: diffSnapshots(e.before, e.after) }));

      const files = Array.from(byFile.entries()).map(([filePath, edits]) => {
        const result = fileDiffForMessage(filePath, edits);
        if (result.drifted) {
          return {
            file_path: filePath,
            drifted: true,
            drift_reason: result.drift_reason,
            per_node: edits.map(e => ({ node_id: e.node_id, lines: diffSnapshots(e.before, e.after) })),
            edits: editMeta(edits)
          };
        }
        return {
          file_path: filePath,
          drifted: false,
          // `hunks` is trimmed to a few lines of context per change (the PR view); `full_hunks`
          // re-runs the same diff with no trimming, so the client's "view full file" toggle has
          // every line of the file, changed lines already tagged, with no second diff algorithm
          // needed on the client.
          hunks: result.hunks,
          full_hunks: diffSnapshots(result.before_file, result.after_file, 1_000_000),
          before_file: result.before_file,
          after_file: result.after_file,
          edits: editMeta(edits)
        };
      });

      res.json({ message_id: message.id, files });
    } catch (err) {
      console.error('[DevsMind API Error]:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Message-level revert/un-revert — same write-route threat model as /api/revert (source files
  // change on disk), so the same token + Origin gate applies.
  app.post('/api/message-revert', (req, res) => {
    try {
      if (req.get('X-Devsmind-Token') !== DEVSMIND_TOKEN) {
        return res.status(403).json({ error: 'forbidden' });
      }
      const origin = req.get('Origin');
      if (origin && !isLocalOrigin(origin, port)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      if (!req.is('application/json')) {
        return res.status(415).json({ error: 'expected application/json' });
      }

      const devmindPath = req.body?.path ? String(req.body.path) : path.join(process.cwd(), '.devmind');
      const messageId = req.body?.message_id ? String(req.body.message_id) : '';
      if (!messageId) return res.status(400).json({ error: 'message_id is required' });
      if (!fs.existsSync(devmindPath)) {
        return res.status(400).json({ error: `Brain directory not found at: ${devmindPath}` });
      }

      const result = revertMessage(devmindPath, messageId);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (err) {
      console.error('[DevsMind API Error]:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/message-unrevert', (req, res) => {
    try {
      if (req.get('X-Devsmind-Token') !== DEVSMIND_TOKEN) {
        return res.status(403).json({ error: 'forbidden' });
      }
      const origin = req.get('Origin');
      if (origin && !isLocalOrigin(origin, port)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      if (!req.is('application/json')) {
        return res.status(415).json({ error: 'expected application/json' });
      }

      const devmindPath = req.body?.path ? String(req.body.path) : path.join(process.cwd(), '.devmind');
      const messageId = req.body?.message_id ? String(req.body.message_id) : '';
      if (!messageId) return res.status(400).json({ error: 'message_id is required' });
      if (!fs.existsSync(devmindPath)) {
        return res.status(400).json({ error: `Brain directory not found at: ${devmindPath}` });
      }

      const result = unrevertMessage(devmindPath, messageId);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (err) {
      console.error('[DevsMind API Error]:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Finer-grained revert/un-revert — same write-route threat model as the whole-message routes
  // above, so the same token + Origin gate applies. These target one file's edits within a
  // message, or one single edit, rather than the whole message.
  app.post('/api/message-file-revert', (req, res) => {
    try {
      if (req.get('X-Devsmind-Token') !== DEVSMIND_TOKEN) return res.status(403).json({ error: 'forbidden' });
      const origin = req.get('Origin');
      if (origin && !isLocalOrigin(origin, port)) return res.status(403).json({ error: 'forbidden' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'expected application/json' });

      const devmindPath = req.body?.path ? String(req.body.path) : path.join(process.cwd(), '.devmind');
      const messageId = req.body?.message_id ? String(req.body.message_id) : '';
      const filePath = req.body?.file_path ? String(req.body.file_path) : '';
      if (!messageId) return res.status(400).json({ error: 'message_id is required' });
      if (!filePath) return res.status(400).json({ error: 'file_path is required' });
      if (!fs.existsSync(devmindPath)) return res.status(400).json({ error: `Brain directory not found at: ${devmindPath}` });

      const result = revertMessageFile(devmindPath, messageId, filePath);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (err) {
      console.error('[DevsMind API Error]:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/message-file-unrevert', (req, res) => {
    try {
      if (req.get('X-Devsmind-Token') !== DEVSMIND_TOKEN) return res.status(403).json({ error: 'forbidden' });
      const origin = req.get('Origin');
      if (origin && !isLocalOrigin(origin, port)) return res.status(403).json({ error: 'forbidden' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'expected application/json' });

      const devmindPath = req.body?.path ? String(req.body.path) : path.join(process.cwd(), '.devmind');
      const messageId = req.body?.message_id ? String(req.body.message_id) : '';
      const filePath = req.body?.file_path ? String(req.body.file_path) : '';
      if (!messageId) return res.status(400).json({ error: 'message_id is required' });
      if (!filePath) return res.status(400).json({ error: 'file_path is required' });
      if (!fs.existsSync(devmindPath)) return res.status(400).json({ error: `Brain directory not found at: ${devmindPath}` });

      const result = unrevertMessageFile(devmindPath, messageId, filePath);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (err) {
      console.error('[DevsMind API Error]:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/message-edit-revert', (req, res) => {
    try {
      if (req.get('X-Devsmind-Token') !== DEVSMIND_TOKEN) return res.status(403).json({ error: 'forbidden' });
      const origin = req.get('Origin');
      if (origin && !isLocalOrigin(origin, port)) return res.status(403).json({ error: 'forbidden' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'expected application/json' });

      const devmindPath = req.body?.path ? String(req.body.path) : path.join(process.cwd(), '.devmind');
      const messageId = req.body?.message_id ? String(req.body.message_id) : '';
      const editId = req.body?.edit_id ? String(req.body.edit_id) : '';
      if (!messageId) return res.status(400).json({ error: 'message_id is required' });
      if (!editId) return res.status(400).json({ error: 'edit_id is required' });
      if (!fs.existsSync(devmindPath)) return res.status(400).json({ error: `Brain directory not found at: ${devmindPath}` });

      const result = revertMessageEdit(devmindPath, messageId, editId);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (err) {
      console.error('[DevsMind API Error]:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/message-edit-unrevert', (req, res) => {
    try {
      if (req.get('X-Devsmind-Token') !== DEVSMIND_TOKEN) return res.status(403).json({ error: 'forbidden' });
      const origin = req.get('Origin');
      if (origin && !isLocalOrigin(origin, port)) return res.status(403).json({ error: 'forbidden' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'expected application/json' });

      const devmindPath = req.body?.path ? String(req.body.path) : path.join(process.cwd(), '.devmind');
      const messageId = req.body?.message_id ? String(req.body.message_id) : '';
      const editId = req.body?.edit_id ? String(req.body.edit_id) : '';
      if (!messageId) return res.status(400).json({ error: 'message_id is required' });
      if (!editId) return res.status(400).json({ error: 'edit_id is required' });
      if (!fs.existsSync(devmindPath)) return res.status(400).json({ error: `Brain directory not found at: ${devmindPath}` });

      const result = unrevertMessageEdit(devmindPath, messageId, editId);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (err) {
      console.error('[DevsMind API Error]:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // MCP endpoint — stateless: each request gets its own server + transport pair
  app.all('/mcp', async (req, res) => {
    try {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined // stateless mode
      });

      // Clean up this transport's server on close
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[DevsMind] HTTP request error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  return app;
}

/**
 * Resolves the one project this server will serve and binds to it, so callers never pass a
 * `devmind_path`. Explicit `devmindPath` (from `devsmind start --path`) wins; otherwise auto-detect
 * by walking up from the cwd `devsmind start` was run in — the normal case, since you start it
 * inside your project. Errors on an explicit path that doesn't exist (a typo should fail loudly,
 * not silently fall back). A missing auto-detect is a soft warning, not fatal: the server still
 * starts unbound and the legacy per-call `devmind_path` path keeps working, so nothing regresses.
 */
function bindServerToProject(devmindPath?: string): void {
  const explicit = devmindPath && String(devmindPath).trim();
  if (explicit) {
    // Reuse resolveDevmindPath's own existence checks / slash-normalization by resolving BEFORE
    // binding — but it short-circuits on boundDevmindPath, so bind only after it returns cleanly.
    const resolved = resolveDevmindPath(explicit);
    bindDevmindPath(resolved);
    return;
  }
  const autoDetected = findDevmindDir(process.cwd());
  if (autoDetected) {
    bindDevmindPath(autoDetected);
  } else {
    console.error(
      `⚠️  DevsMind: no .devmind directory found from ${process.cwd()} — starting UNBOUND. ` +
      `Callers must pass devmind_path, or run 'devsmind start' from inside your project (or pass --path).`
    );
  }
}

export async function runHttpMcpServer(port: number = DEVSMIND_PORT, devmindPath?: string): Promise<void> {
  bindServerToProject(devmindPath);

  const app = createHttpApp(port);
  const httpServer = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, '127.0.0.1', () => resolve());
    httpServer.once('error', reject);
  });

  console.log(`🧠 DevsMind running  →  http://localhost:${port}/mcp`);
  if (boundDevmindPath) console.log(`   serving project: ${boundDevmindPath}`);
  console.log(`   press Ctrl+C to stop`);

  // Pre-warm the ONNX embedder off the critical path: loading the model is a one-time ~hundreds
  // of ms cost that would otherwise land on the FIRST search_nodes call and make it feel slow.
  // Fire-and-forget — a failure just means search degrades to BM25+grep, which is already handled.
  prewarmEmbedder();

  registerShutdownHandlers(httpServer);
}

/** Kicks off ONNX model load in the background so the first search_nodes doesn't pay the cold cost. */
function prewarmEmbedder(): void {
  isEmbedderAvailable().catch(() => { /* absent/failed → search falls back, nothing to do here */ });
}

// â”€â”€ Stdio mode — for direct IDE plugin injection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Start DevsMind as a stdio MCP server.
 * Used when an IDE manages the process directly (e.g. Cursor stdio plugin mode).
 */
export function runStdioMcpServer(devmindPath?: string): void {
  // NOTE: do NOT write to stdout here — it is the JSON-RPC pipe.
  bindServerToProject(devmindPath);

  const server = createMcpServer();

  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    // connected — pre-warm the embedder in the background (safe: it never writes to stdout).
    prewarmEmbedder();
  }).catch((err) => {
    console.error(`âŒ Stdio connection failed: ${(err as Error).message}`);
    process.exit(1);
  });
}

// â”€â”€ Backward-compat alias (used by existing CLI index.ts) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/** @deprecated Use runHttpMcpServer() or runStdioMcpServer() directly */
export function runMcpServer(): void {
  runStdioMcpServer();
}

