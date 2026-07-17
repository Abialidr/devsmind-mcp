import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';
import express from 'express';
import { DevMindDatabase, parseReasoningBlocks } from '../db/database';
import { loadProjectContext } from '../utils/config';
import { VISUALIZER_2D_HTML, VISUALIZER_3D_HTML } from './visualizer';
import {
  readScratchpad,
  createScratchpad,
  updateScratchpad,
  completeScratchpad
} from '../db/indexer';
import { scanRepoFiles, INDEXABLE_EXTENSIONS } from '../utils/scanner';
import { parseNodeId, isAstParseable, findTouchedSymbols, invalidateParsedFile } from '../utils/ast';
import { replaceTextInFile, createFileWithContent } from '../utils/edit';
import { stageEntry, readStaged, clearStaged, commitStagedChanges, summarizeEntriesForWorkflow, StagedEntry } from '../db/staging';
import { runAnalysis } from '../db/analyze';
import { importWorkflowDocs } from '../db/workflow-import';

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

If you skip recording a change, you are not skipping a formality. You are leaving the whole team's graph stale for every other AI agent that queries this code later — tomorrow, on a different task, in a different session. And the reasoning behind your change (why it was made, what ticket drove it, what was broken before, what you tried and rejected) exists ONLY in this conversation, right now. It is not in the diff. It is not in the commit message. If it isn't captured this turn, it is gone forever — no reindex, no log, no git blame can recover it later.

Non-negotiable workflow:
1. Before any filesystem search or file read: call search_nodes first. It searches names/reasoning and automatically falls back to a full code-content search if nothing matches — one call covers both, never start with grep.
2. To read one function/class: call get_node_code instead of opening the file. It parses live from disk, so it's cheaper and always current.
3. Before touching any function's signature: call get_node_graph. Git shows you what changed; it never shows you what depends on it. Find out before you break something, not after.
4. Before refactoring: call get_node_history. Git blame tells you who and when; it never tells you why. The actual decision context only exists here.
5. Write EVERY file with edit_node — .ts, .vue, .css, .json, .xml, .md, anything — and never your editor's own edit/write tools. It takes file_path + old_string + new_string exactly like an ordinary edit tool and never refuses a file type; to create a file that doesn't exist yet, pass old_string: "" and the whole file as new_string. Because it knows where your text landed, it works out which function/class you changed and records your reasoning against it automatically: no node_id to look up, no code_snapshot to send back, and no stage_change call. It answers with every caller of what you changed. Writes landing outside any function (markup, config, an import) record nothing — normal and expected, not a failure.
6. stage_change is now only for what no parser can read: a language with no AST support (.py, .go, .java, .cs, .rb, .php, .rs, .swift, .kt, .dart). edit_node still writes those files, and its response tells you when it couldn't trace one — so never guess. One call per node, not per file, never batched for later. On a long task, call commit_changes at natural checkpoints too (not only once at the very end) — waiting until the whole task is "done" is how staged work gets left uncommitted when a session runs long.
7. Scope: the graph is source code only (functions/classes/logic). stage_change will be REJECTED for stylesheets, markup, JSON/config, docs, images, or any other non-code asset. Do not stage those files — they have no callers/callees to resolve and only bloat the graph.
8. When you start work that might relate to a multi-session feature, call workflow_list first. If a paused workflow's description looks related to what you're about to do, ask the user whether to resume it (workflow_resume) instead of starting fresh and silently losing its decision history — git blame never shows you a paused feature's prior context, only this does.
9. If a workflow is active, commit_changes already logs a step for you from what you staged — you do NOT need a separate workflow_add_step call for the normal case. Only call workflow_add_step directly for something a commit doesn't cover (a decision with no code change, or a pending_tasks note).`;

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

// Cache database connections by their resolved path to avoid re-opening constantly
const dbCache = new Map<string, DevMindDatabase>();

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

function getDatabase(devmindPath: string): DevMindDatabase {
  const dbFile = path.join(devmindPath, 'brain.db');
  if (!dbCache.has(dbFile)) {
    dbCache.set(dbFile, new DevMindDatabase(dbFile));
  }
  return dbCache.get(dbFile)!;
}


function cleanup() {
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
 * Creates and wires up a DevsMind MCP Server instance.
 * Stateless — every call receives devmind_path and opens the db from there.
 */
function createMcpServer(): Server {
  const server = new Server(
    { name: 'devsmind-server', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: DEVSMIND_INSTRUCTIONS
    }
  );

  // â”€â”€ Tool Definitions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'get_node_summary',
          description:
            'Get a quick summary of a specific code node (existence, file location, connections count, history count, and last update timestamp).',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: {
                type: 'string',
                description: 'Absolute path to the .devmind directory'
              },
              node_id: {
                type: 'string',
                description:
                  'Unique identifier for the node (e.g. function or class name)'
              }
            },
            required: ['devmind_path', 'node_id']
          }
        },
        {
          name: 'list_nodes',
          description:
            'List all nodes matching optional type and file path filters. Useful to discover all entities in a component, package, or directory.',
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
              }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'get_node_code',
          description:
            "Get a single node's CURRENT source code, parsed live from its file on disk — token-efficient, since it returns only that function/class/route rather than the whole file. Call this instead of reading a file whenever you need one specific entity: reading the raw file instead means the graph never learns you looked at it, so drift between what's recorded and what's actually on disk goes undetected. Response fields: `source: \"live\"` means the code was read from disk and is current. `source: \"cached\"` means the symbol could not be located in its file (not a TS/JS file, or it was renamed/moved/deleted) so a possibly-stale cached snapshot was returned — verify it against the file before relying on it. `snapshot_outdated: true` means the stored graph has drifted from disk. If you're about to edit this node anyway, an edit_node call re-syncs it as a side effect. To force a resync with no real code change, edit_node can't help (it requires old_string to actually differ from new_string) — use stage_change instead, passing the current on-disk code as code_snapshot, then commit_changes. To fetch a whole call flow at once, prefer get_node_graph with include_code instead of calling this repeatedly.",
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: {
                type: 'string',
                description: 'Absolute path to the .devmind directory'
              },
              node_id: {
                type: 'string',
                description: 'Unique identifier for the node'
              }
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
            "What it does that a plain edit tool cannot: it knows WHERE your text landed, so it works out which function/class you actually changed and records your `reasoning` against it automatically — no node_id to look up, no code_snapshot to send back, no follow-up stage_change call. That covers code you just added and files you just created, since the code is on disk by the time it looks. In return it tells you every CALLER of what you changed (i.e. what you may have just broken), what it calls out to, and the reasoning previously recorded against it.\n\n" +
            "Writes that don't land inside any function — markup, config, an import line, a stylesheet — simply record nothing. That is a normal, expected outcome, not a failure: the file is still written and the response says so. So there is never a reason to reach for another edit or write tool.\n\n" +
            "Nothing reaches the graph until commit_changes. For renames use rename_node.",
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              file_path: { type: 'string', description: 'The file to write. It does not need to exist yet.' },
              old_string: { type: 'string', description: 'The exact text to replace, matched byte-for-byte including indentation. Must appear exactly once in the file unless replace_all is true. Pass "" to CREATE a file that does not exist yet.' },
              new_string: { type: 'string', description: 'The text to put in its place — or, when creating a file, its entire contents. Pass an empty string to delete the matched text.' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match (default false). Every occurrence is traced, so an edit hitting three functions records all three.' },
              reasoning: {
                type: 'object',
                description: 'Why you are making this edit. Recorded automatically against whatever function/class the edit turns out to touch — you do not need to know which one. This is the only record of it that will ever exist: the diff shows what changed, never why. Ignored when the edit touches no code (a stylesheet, a config value).',
                properties: {
                  what_changed: { type: 'string', description: 'Brief description of the modified code' },
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
              session_id: { type: 'string', description: 'Session identifier to associate with this change (optional)' }
            },
            required: ['devmind_path', 'file_path', 'old_string', 'new_string', 'reasoning']
          }
        },
        {
          name: 'stage_change',
          description:
            `Stage ONE changed code node (function/class/method/etc.) into a buffer, right after you finish editing it — don't wait until the whole task is done. Call once per NODE, not once per file: a file with 3 changed functions is 3 calls. SCOPE: source code only — ${Array.from(INDEXABLE_EXTENSIONS).sort().join(', ')}. Rejected for stylesheets, markup, JSON/config, docs, or other non-code assets (no callers/callees to resolve). Pass only code + reasoning; connections are resolved automatically by commit_changes, not by you. The \`reasoning\` (why, goal, what was broken, what ticket) exists nowhere else — capture it now, while it's still in context, not after the fact. Staging is buffered on disk and survives a context reset, but is inert until commit_changes runs.`,
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              node_id: { type: 'string', description: 'Unique identifier for the node (e.g. "CartService.applyPromoCode" or "calculateDiscount")' },
              file_path: { type: 'string', description: 'Source file path where the node is located' },
              code_snapshot: { type: 'string', description: 'Full source code content of the node at this moment' },
              reasoning: {
                type: 'object',
                description: 'Structured details about this change',
                properties: {
                  what_changed: { type: 'string', description: 'Brief description of the modified code' },
                  why: { type: 'string', description: 'The reason this change was made' },
                  goal: { type: 'string', description: 'What was being achieved' },
                  requirement: { type: 'string', description: 'Ticket / issue / user request ID if applicable' },
                  previous_state: { type: 'string', description: 'What the code looked like before and why it was a problem' },
                  decision: { type: 'string', description: 'Architectural or implementation decision and why' },
                  developer: { type: 'string', description: 'Name of the developer (optional — if this project has a configured developer identity from `devsmind init`, it always overrides whatever is passed here, since the agent has no reliable way to know who the human actually is)' },
                  model: { type: 'string', description: 'AI model name used' }
                },
                required: ['what_changed', 'why', 'goal']
              },
              name: { type: 'string', description: 'Display name of the node (optional, inferred if omitted)' },
              type: { type: 'string', description: '(optional, defaults to function) ' + NODE_TYPE_DESCRIPTION },
              signature: { type: 'string', description: 'Parameter types + return type signature (optional)' },
              session_id: { type: 'string', description: 'Session identifier to associate with this change (optional)' }
            },
            required: ['devmind_path', 'node_id', 'file_path', 'code_snapshot', 'reasoning']
          }
        },
        {
          name: 'commit_changes',
          description:
            'Flush all buffered stage_change entries in one atomic pass: creates/updates every staged node, writes every history snapshot, resolves all connections via local AST (auto-creating any referenced-but-missing nodes), then clears the buffer. If a workflow is currently active, this ALSO auto-records a step on its timeline from the staged entries\' reasoning — you do not need a separate workflow_add_step call for the normal case. Call commit_changes at natural checkpoints — after a batch of related nodes, or when switching context — not only once at the very end of a long task; a checkpoint commit can\'t be forgotten the way a single end-of-task one can. Always call it again before ending the turn if anything is still staged: an uncommitted turn leaves the whole team\'s graph stale, not just yours.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' }
            },
            required: ['devmind_path']
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
        {
          name: 'get_node_history',
          description: 'Get the full version history of a code node, including all past code snapshots and change reasoning. Git blame tells you who and when; it never tells you why — the actual decision, ticket, and what was rejected only exists here. Skip this before refactoring and you risk re-breaking a bug that was already fixed once, or undoing a decision made for a reason you never saw.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              node_id: { type: 'string', description: 'Unique identifier for the node (e.g. function or class name)' }
            },
            required: ['devmind_path', 'node_id']
          }
        },
        {
          name: 'get_node_graph',
          description:
            'Get a node\'s dependency graph — connected nodes and the relationships between them. Set direction:"out" AND include_code:true to pull an ENTIRE CALL FLOW in a single call: the starting node plus everything it transitively calls, each with its current source code read from disk. Use that combination whenever you are tracing how a request, endpoint, or feature flows through the codebase — it replaces a long chain of get_node_code calls with one round trip. Use direction:"in" to find every caller of a node before you change its signature — git shows you what changed, never what depends on it, so this is the only way to know what breaks before a teammate hits it. If `code_truncated` is true in the response, the character budget ran out and `nodes_without_code` nodes came back with metadata but no code — fetch those individually with get_node_code, or raise code_char_budget.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              node_id: { type: 'string', description: 'Unique identifier for the starting node (e.g. function or class name)' },
              max_depth: { type: 'number', description: 'Maximum depth to traverse (optional, default 6). For a call flow with include_code, 2-3 is usually right.' },
              direction: {
                type: 'string',
                enum: ['out', 'in', 'both'],
                description: '"out" = only what this node calls, transitively (a call flow — use this for tracing). "in" = only what calls this node (impact analysis). "both" = the surrounding neighborhood in both directions (default).'
              },
              include_code: {
                type: 'boolean',
                description: 'Attach each node\'s current source code, read live from disk (default: false). Combine with direction:"out" to retrieve a whole call flow in one call.'
              },
              code_char_budget: {
                type: 'number',
                description: 'Max total characters of code to return, spent on the nodes nearest the starting node first (default: 60000). Only applies when include_code is true.'
              }
            },
            required: ['devmind_path', 'node_id']
          }
        },
        {
          name: 'search_nodes',
          description:
            'Search for code by name/id/reasoning first; if nothing matches, falls back to a full code-content search (regex or substring); if that also finds nothing, falls back further to a word-split relevance search that breaks the query into individual words and ranks every node by how many of those words appear in its file_path, name/id, reasoning, or code — so a natural-language, multi-word query (e.g. "product detail page") still finds a match like `pages/product-detail/index.js` even though the phrase never appears verbatim anywhere. This is the ONE search tool to call, in ONE turn, whether the term is an exact identifier, only appears in the code body, or is just a rough natural-language description. Each result is tagged `matched_via: "identifier"`, `"code"`, or `"fuzzy"` so you know how it was found; code matches include line-level `matches`/`match_count`/`match_ratio`, fuzzy matches include `matched_terms`/`score`. If nothing matches at all, the response includes a `hint` suggesting next steps (e.g. list_nodes with a file_path filter). Prefer this over grep/filesystem search — a raw grep finds text, but misses every bit of recorded reasoning behind why that code looks the way it does.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              query: { type: 'string', description: 'Search term, substring, or (with is_regex) regex pattern' },
              is_regex: { type: 'boolean', description: 'Treat query as a regex pattern when falling back to code search (default: false)' },
              case_insensitive: { type: 'boolean', description: 'Case-insensitive code-fallback search (default: true)' }
            },
            required: ['devmind_path', 'query']
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
        {
          name: 'get_recent_changes',
          description: 'Get team modifications and history updates over the last N hours, with optional downstream impact analysis.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              hours: { type: 'number', description: 'Lookback window in hours (optional, default 24)' },
              analyze_impact: { type: 'boolean', description: 'If true, checks for downstream callers of changed nodes (optional, default true)' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'get_developer_activity',
          description: 'List recent history logs and changes made by a specific developer.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              developer: { type: 'string', description: 'Name or email of the developer' },
              limit: { type: 'number', description: 'Maximum logs to return (optional, default 50)' }
            },
            required: ['devmind_path', 'developer']
          }
        },
        {
          name: 'get_changes_by_requirement',
          description: 'List all modifications linked to a specific requirement, ticket, or issue ID.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              requirement_id: { type: 'string', description: 'The requirement, ticket, or issue ID' }
            },
            required: ['devmind_path', 'requirement_id']
          }
        },
        {
          name: 'search_decisions',
          description: 'Search reasoning logs for specific architectural or implementation decisions.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              query: { type: 'string', description: 'Term or keyword to search' }
            },
            required: ['devmind_path', 'query']
          }
        },
        // NOTE: `search_code` is intentionally NOT listed here anymore. `search_nodes` now
        // falls back to the same code-content search automatically when the identifier
        // match is empty, so there is no longer a reason to advertise two search tools.
        // The handler below is retained so any direct/legacy call still works.
        {
          name: 'get_orphaned_nodes',
          description: 'Find disconnected code nodes in the graph that have no incoming or outgoing connections.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'get_visualizer_url',
          description: 'Get local URLs to open the interactive 2D and 3D code graph visualizer pages.',
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
        {
          name: 'workflow_create',
          description: 'Start a new persistent, cross-session workflow for a multi-day feature (e.g. "Wallet Integration"). Becomes the active workflow — call workflow_add_step as you make progress so the timeline survives session/context resets. Auto-pauses whatever workflow was previously active.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              name: { type: 'string', description: 'Short human-readable name for the feature/workflow' },
              description: { type: 'string', description: 'Brief description of the goal — used by you (the agent) to judge whether a later task relates to this workflow' }
            },
            required: ['devmind_path', 'name', 'description']
          }
        },
        {
          name: 'workflow_add_step',
          description: 'Record a step in the currently active (or specified) workflow\'s timeline — a short note of progress, linked to the history_ids already created via edit_node/stage_change + commit_changes rather than duplicating any code or reasoning. NOTE: commit_changes already auto-records a step from its staged entries whenever a workflow is active — you do NOT need to call this after every commit. Only call it directly for something a commit doesn\'t cover: a decision made without a code change, a note on what\'s still pending (pending_tasks), or a custom summary richer than the auto-generated one.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              workflow_id: { type: 'string', description: 'Workflow to add this step to (optional — defaults to the currently active workflow)' },
              summary: { type: 'string', description: 'Short summary of what this step accomplished' },
              pending_tasks: { type: 'string', description: 'Optional note on what is still left to do' },
              history_ids: { type: 'array', items: { type: 'string' }, description: 'Optional history row ids (from stage_change/commit_changes results) this step covers' },
              session_id: { type: 'string', description: 'Optional session id grouping this step with related history entries' }
            },
            required: ['devmind_path', 'summary']
          }
        },
        {
          name: 'workflow_pause',
          description: 'Pauses the currently active workflow and clears the active pointer — use when switching to unrelated work, so the next workflow_list call surfaces it as resumable instead of leaving it silently abandoned.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'workflow_resume',
          description: 'Resumes a paused workflow, making it active again (auto-pausing whatever was active before).',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              workflow_id: { type: 'string', description: 'The workflow id to resume' }
            },
            required: ['devmind_path', 'workflow_id']
          }
        },
        {
          name: 'workflow_list',
          description: 'List workflows (optionally filtered by status). Call this when starting work that MIGHT relate to a paused, multi-session feature — if a description looks related to the current task, ask the user whether to resume it (workflow_resume) instead of silently starting fresh and losing its prior decision history.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              status: { type: 'string', enum: ['active', 'paused', 'completed'], description: 'Optional status filter (default: all)' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'workflow_get_context',
          description: 'Get a workflow\'s full timeline in one call — every step (in order) plus every reference artifact\'s metadata (and optionally content). Call this right after resuming a workflow to instantly regain the feature\'s full context. For large/long-running workflows, prefer workflow_get_steps (paginated) + workflow_read_artifact (per artifact) instead.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              workflow_id: { type: 'string', description: 'The workflow id to fetch context for' },
              include_artifact_content: { type: 'boolean', description: 'If true, embeds each artifact\'s file content inline in the response (default: false). Only use for small/short workflows — large workflows should use workflow_read_artifact per artifact instead.' }
            },
            required: ['devmind_path', 'workflow_id']
          }
        },
        {
          name: 'workflow_add_artifact',
          description: 'Save reference material (a spec excerpt, ticket description, API doc, search-result snippet) to a workflow — written to disk under .devmind/workflows/<id>/ and linked in the DB. Use this for material that informed the work but isn\'t part of the code graph itself.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              workflow_id: { type: 'string', description: 'The target workflow id' },
              step_id: { type: 'string', description: 'Optional step id this artifact relates to' },
              type: { type: 'string', description: 'Artifact type, e.g. pm_doc, api_spec, web_snippet' },
              source_name: { type: 'string', description: 'Title/filename of the artifact source' },
              content: { type: 'string', description: 'Text or markdown content to save' }
            },
            required: ['devmind_path', 'workflow_id', 'type', 'source_name', 'content']
          }
        },
        {
          name: 'workflow_sync_retroactive',
          description: 'Backfill a workflow\'s timeline after a whole session went by without using workflow_add_step. You already have the session\'s transcript in your own context — extract the steps yourself and pass them here as structured data. This does NOT accept raw transcript text; DevsMind never runs its own LLM calls, so extraction has to happen on your side, which you can already do for free since you already read it.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              workflow_id: { type: 'string', description: 'The workflow id to sync into' },
              steps: {
                type: 'array',
                description: 'Steps you extracted from the session, oldest first',
                items: {
                  type: 'object',
                  properties: {
                    summary: { type: 'string' },
                    pending_tasks: { type: 'string' },
                    history_ids: { type: 'array', items: { type: 'string' } }
                  },
                  required: ['summary']
                }
              }
            },
            required: ['devmind_path', 'workflow_id', 'steps']
          }
        },
        {
          name: 'workflow_import',
          description: 'Import existing flow/architecture docs (markdown files describing a feature — title, summary, implementation details) as paused, resumable workflows, so reference material a team already wrote lives where you already look (workflow_get_context) instead of scattered elsewhere. Re-importing the same file updates its workflow in place rather than duplicating it.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              folder_path: { type: 'string', description: 'Folder to import every .md file from (one workflow per file)' },
              file_path: { type: 'string', description: 'A single .md file to import instead of a folder' }
            },
            required: ['devmind_path']
          }
        },
        {
          name: 'workflow_search',
          description: 'Search across ALL workflows\' step summaries, pending_tasks notes, and artifact source names for a keyword or phrase. Returns matching steps and artifacts grouped by workflow. Use this when you don\'t know which workflow to look in — one call finds relevant context across the entire project history. Set include_artifact_content:true to also scan inside artifact files (slower but more thorough).',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              query: { type: 'string', description: 'Keyword or phrase to search for' },
              status: { type: 'string', enum: ['active', 'paused', 'completed'], description: 'Optional: only search within workflows of this status' },
              include_artifact_content: { type: 'boolean', description: 'If true, also searches inside artifact file contents and includes a snippet of the matching text (default: false)' }
            },
            required: ['devmind_path', 'query']
          }
        },
        {
          name: 'workflow_read_artifact',
          description: 'Read the full content of a single workflow artifact file. Use this after workflow_get_context or workflow_search returns an artifact you want to read — pass the artifact id. This avoids loading the full context dump just to read one reference doc.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              workflow_id: { type: 'string', description: 'The workflow id that owns the artifact' },
              artifact_id: { type: 'string', description: 'The artifact id to read (from workflow_get_context or workflow_search results)' }
            },
            required: ['devmind_path', 'workflow_id', 'artifact_id']
          }
        },
        {
          name: 'workflow_get_steps',
          description: 'Read steps from a workflow with pagination support. Use last_n to get only the most recent N steps (recommended when resuming a long-running workflow — read the tail to catch up, not the full history). Alternatively use limit+offset for forward pagination.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              workflow_id: { type: 'string', description: 'The workflow id to read steps from' },
              last_n: { type: 'number', description: 'Return only the last N steps (most recent). Recommended for catching up on long workflows.' },
              limit: { type: 'number', description: 'Max steps to return (for forward pagination with offset)' },
              offset: { type: 'number', description: 'Step offset for forward pagination (default: 0)' }
            },
            required: ['devmind_path', 'workflow_id']
          }
        }
      ]
    };
  });

  // â”€â”€ Tool Execution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error('Arguments are required');
    }

    try {
      switch (name) {
        case 'get_node_summary': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const nodeId = requireStr(args, 'node_id', 'get_node_summary');
          const db = getDatabase(devmindPath);

          const node = db.getNode(nodeId);
          if (!node) {
            return {
              content: [
                { type: 'text', text: JSON.stringify({ exists: false, node_id: nodeId }) }
              ]
            };
          }

          const connections = db.getConnections(nodeId);
          const connectionCount = connections.uses.length + connections.usedBy.length;
          const historyList = db.listHistory(nodeId);
          const latestHistory = db.getLatestHistory(nodeId);

          const summary = {
            exists: true,
            node_id: node.id,
            name: node.name,
            type: node.type,
            file_path: node.file_path,
            signature: node.signature,
            connection_count: connectionCount,
            history_count: historyList.length,
            last_updated: latestHistory ? latestHistory.updated_at : node.created_at
          };

          return {
            content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }]
          };
        }

        case 'list_nodes': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const type = args.type ? String(args.type) : undefined;
          const filePath = args.file_path ? String(args.file_path) : undefined;
          const includeDeprecated = args.include_deprecated === true;

          const db = getDatabase(devmindPath);
          const nodes = db.listNodes({ type, file_path: filePath, include_deprecated: includeDeprecated });

          return {
            content: [{ type: 'text', text: JSON.stringify(nodes, null, 2) }]
          };
        }

        case 'get_node_code': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const nodeId = requireStr(args, 'node_id', 'get_node_code');
          const db = getDatabase(devmindPath);
          const result = db.getLiveCode(nodeId);
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
            reasoning: args.reasoning as any,
            name: args.name ? String(args.name) : undefined,
            type: args.type ? String(args.type) : undefined,
            signature: args.signature ? String(args.signature) : undefined,
            session_id: args.session_id ? String(args.session_id) : undefined
          };
          const summary = commitStagedChanges(db, devmindPath, [entry]);
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
                  '2. Call stage_change for EVERY entity found — pass its node_id, file_path, code_snapshot, reasoning, and the most specific taxonomy type. You do NOT need to figure out connections; commit_changes resolves them from the code via AST.',
                  '3. Call index_checkpoint every 10 files to save progress.',
                  '4. Every ~50 entities (or at the end of a repo), call commit_changes to flush the staged buffer — it creates all nodes, writes all history, and resolves all connections (including into already-committed nodes) in one pass. Committing in batches keeps the buffer small.',
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
                remaining_repos: remaining
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
          if (!args.reasoning) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  edited: false,
                  error: 'edit_node needs reasoning (what_changed, why, goal). It is recorded against whatever code this edit turns out to touch, and exists nowhere else once this turn ends.'
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

          let pending = readStaged(devmindPath).length;
          const staged: any[] = [];
          for (const t of touched) {
            const nodeId = t.node_id || `${editDb.toRepoRelativePath(filePath)}#${t.symbolName}`;
            pending = stageEntry(devmindPath, {
              node_id: nodeId,
              file_path: filePath,
              code_snapshot: t.codeSnapshot,
              reasoning: args.reasoning as any,
              name: t.name,
              type: t.type,
              signature: t.signature || undefined,
              session_id: args.session_id ? String(args.session_id) : undefined
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
              callers: conns.usedBy.slice(0, 10).map(n => ({ id: n.id, name: n.name, file_path: n.file_path })),
              callers_total: conns.usedBy.length,
              calls_out: conns.uses.slice(0, 10).map(n => ({ id: n.id, name: n.name })),
              prior_history: priorHistory
            });
          }

          const ext = path.extname(filePath).toLowerCase();
          const callerCount = staged.reduce((sum, s) => sum + s.callers_total, 0);
          const what = result.created ? 'Created the file and recorded' : 'Recorded';
          let reminder: string;
          if (staged.length) {
            reminder = callerCount
              ? `${what} ${staged.length} node(s). ${callerCount} node(s) call what you changed — if you altered a signature or contract, check them before moving on. Nothing reaches the graph until commit_changes.`
              : `${what} ${staged.length} node(s). Nothing reaches the graph until commit_changes.`;
          } else if (!INDEXABLE_EXTENSIONS.has(ext)) {
            reminder = `${ext || 'This file type'} is intentionally out of scope for the graph — there is nothing to record. You are done with this edit.`;
          } else if (isAstParseable(filePath)) {
            reminder = result.created
              ? 'The file was created, but it declares no function or class, so there was nothing to record. You are done with this edit.'
              : 'This edit did not land inside any function or class (an import, a top-level constant, or similar), so there was nothing to record. You are done with this edit.';
          } else {
            reminder = `${ext} cannot be parsed for symbols, so this could not be traced automatically. If you wrote a function or class, record it with stage_change yourself.`;
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                edited: true,
                created: !!result.created,
                file_path: filePath,
                replacements: result.replacements,
                recorded: staged.length,
                pending_count: pending,
                touched: staged,
                reminder
              }, null, 2)
            }]
          };
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
          if (!args.reasoning) {
            return {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ staged: false, error: "stage_change needs 'reasoning' (what_changed, why, goal) — it is the only record of this change that will ever exist." }) }]
            };
          }
          const entry: StagedEntry = {
            node_id: requireStr(args, 'node_id', 'stage_change'),
            file_path: filePath,
            code_snapshot: requireStr(args, 'code_snapshot', 'stage_change'),
            reasoning: args.reasoning as any,
            name: args.name ? String(args.name) : undefined,
            type: args.type ? String(args.type) : undefined,
            signature: args.signature ? String(args.signature) : undefined,
            session_id: args.session_id ? String(args.session_id) : undefined
          };
          const pendingCount = stageEntry(devmindPath, entry);
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

        case 'commit_changes': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const entries = readStaged(devmindPath);
          if (entries.length === 0) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ committed: false, message: 'Nothing staged. Call stage_change first.' }) }]
            };
          }
          const summary = commitStagedChanges(db, devmindPath, entries);
          clearStaged(devmindPath);

          // If a workflow is active, auto-record this commit as a step — the agent doesn't
          // need a separate workflow_add_step call for the common case. Call workflow_add_step
          // directly only when you want to attach pending_tasks or a richer custom summary.
          let workflowStepId: string | null = null;
          const activeWorkflow = db.getActiveWorkflow();
          if (activeWorkflow) {
            const step = db.addWorkflowStep(activeWorkflow.id, {
              summary: summarizeEntriesForWorkflow(entries),
              historyIds: summary.history_ids
            });
            workflowStepId = step.id;
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                committed: true,
                message: `✅ Committed ${summary.nodes} node(s), ${summary.history_entries} history entr(ies), ${summary.edges_added} connection(s) resolved` +
                  (summary.missing_filled > 0 ? `, ${summary.missing_filled} missing node(s) auto-created.` : '.') +
                  (workflowStepId ? ` Logged as a step on active workflow "${activeWorkflow!.name}".` : ''),
                ...summary,
                workflow_step_id: workflowStepId
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
            codeCharBudget: args.code_char_budget ? Number(args.code_char_budget) : undefined
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(graph, null, 2) }]
          };
        }

        case 'search_nodes': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const query = requireStr(args, 'query', 'search_nodes');
          const isRegex = args.is_regex === true;
          const caseInsensitive = args.case_insensitive !== false;
          const db = getDatabase(devmindPath);
          const results = db.searchNodes(query, { is_regex: isRegex, case_insensitive: caseInsensitive });
          const payload =
            results.length > 0
              ? results
              : {
                  results: [],
                  hint:
                    'No match in name/reasoning, code, file_path, or partial word matches. Try list_nodes with a file_path filter, or a shorter/more literal query term.'
                };
          return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
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

        case 'get_recent_changes': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const hours = args.hours ? Number(args.hours) : 24;
          const analyzeImpact = args.analyze_impact !== false;
          const db = getDatabase(devmindPath);
          const changes = db.getRecentChanges(hours, analyzeImpact);
          return {
            content: [{ type: 'text', text: JSON.stringify(changes, null, 2) }]
          };
        }

        case 'get_developer_activity': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const developer = requireStr(args, 'developer', 'get_developer_activity');
          const limit = args.limit ? Number(args.limit) : 50;
          const db = getDatabase(devmindPath);
          const activity = db.getDeveloperActivity(developer, limit);
          return {
            content: [{ type: 'text', text: JSON.stringify(activity, null, 2) }]
          };
        }

        case 'get_changes_by_requirement': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const requirementId = requireStr(args, 'requirement_id', 'get_changes_by_requirement');
          const db = getDatabase(devmindPath);
          const changes = db.getChangesByRequirement(requirementId);
          return {
            content: [{ type: 'text', text: JSON.stringify(changes, null, 2) }]
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
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                visualizer_2d: `http://localhost:${DEVSMIND_PORT}/?path=${devmindPathEscaped}`,
                visualizer_3d: `http://localhost:${DEVSMIND_PORT}/3d?path=${devmindPathEscaped}`
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
          const workflowId = args.workflow_id ? String(args.workflow_id) : db.getActiveWorkflow()?.id;
          if (!workflowId) {
            return {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ error: 'No active workflow and no workflow_id given. Call workflow_create or workflow_resume first, or pass workflow_id explicitly.' }) }]
            };
          }
          const step = db.addWorkflowStep(workflowId, {
            summary: requireStr(args, 'summary', 'workflow_add_step'),
            pendingTasks: args.pending_tasks ? String(args.pending_tasks) : undefined,
            historyIds: Array.isArray(args.history_ids) ? args.history_ids.map(String) : undefined,
            sessionId: args.session_id ? String(args.session_id) : undefined
          });
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'added', step }, null, 2) }] };
        }

        case 'workflow_pause': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const paused = db.pauseWorkflow();
          return {
            content: [{ type: 'text', text: JSON.stringify(paused ? { status: 'paused', workflow: paused } : { status: 'no_active_workflow' }, null, 2) }]
          };
        }

        case 'workflow_resume': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const workflow = db.resumeWorkflow(requireStr(args, 'workflow_id', 'workflow_resume'));
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'active', workflow }, null, 2) }] };
        }

        case 'workflow_list': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const status = args.status === 'active' || args.status === 'paused' || args.status === 'completed' ? args.status : undefined;
          const workflows = db.listWorkflows(status);
          return { content: [{ type: 'text', text: JSON.stringify({ workflows }, null, 2) }] };
        }

        case 'workflow_get_context': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const context = db.getWorkflowContext(requireStr(args, 'workflow_id', 'workflow_get_context'), {
            includeArtifactContent: args.include_artifact_content === true
          });
          return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] };
        }

        case 'workflow_add_artifact': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const artifact = db.addWorkflowArtifact(requireStr(args, 'workflow_id', 'workflow_add_artifact'), {
            stepId: args.step_id ? String(args.step_id) : undefined,
            type: requireStr(args, 'type', 'workflow_add_artifact'),
            sourceName: requireStr(args, 'source_name', 'workflow_add_artifact'),
            content: requireStr(args, 'content', 'workflow_add_artifact')
          });
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'added', artifact }, null, 2) }] };
        }

        case 'workflow_sync_retroactive': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const workflowId = requireStr(args, 'workflow_id', 'workflow_sync_retroactive');
          const stepsInput = Array.isArray(args.steps) ? args.steps : [];

          // Unlike workflow_import (idempotent by file name), this has no natural retry key —
          // an agent re-sending the same backfill after an ambiguous timeout/error would
          // otherwise double every step. Fingerprint against what's ALREADY on the timeline
          // (summary + pending_tasks + history_ids) and skip exact repeats, mirroring the
          // protection workflow_import already has for the same "did this already happen"
          // problem.
          const existing = new Set(
            db.getWorkflowSteps(workflowId).map(s => `${s.summary} ${s.pending_tasks || ''} ${s.history_ids || ''}`)
          );
          const added: ReturnType<typeof db.addWorkflowStep>[] = [];
          let skipped = 0;
          for (const s of stepsInput) {
            const summary = requireStr(s, 'summary', 'workflow_sync_retroactive step');
            const pendingTasks = s.pending_tasks ? String(s.pending_tasks) : undefined;
            const historyIds = Array.isArray(s.history_ids) ? s.history_ids.map(String) : undefined;
            const fingerprint = `${summary} ${pendingTasks || ''} ${historyIds && historyIds.length ? JSON.stringify(historyIds) : ''}`;
            if (existing.has(fingerprint)) { skipped++; continue; }
            existing.add(fingerprint);
            added.push(db.addWorkflowStep(workflowId, { summary, pendingTasks, historyIds }));
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'synced', steps_added: added.length, steps_skipped_as_duplicate: skipped, steps: added
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

        case 'workflow_search': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const status = args.status === 'active' || args.status === 'paused' || args.status === 'completed' ? args.status : undefined;
          const results = db.searchWorkflows(requireStr(args, 'query', 'workflow_search'), {
            include_artifact_content: args.include_artifact_content === true,
            status
          });
          return { content: [{ type: 'text', text: JSON.stringify({ results, total_workflows_matched: results.length }, null, 2) }] };
        }

        case 'workflow_read_artifact': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const result = db.readWorkflowArtifact(
            requireStr(args, 'workflow_id', 'workflow_read_artifact'),
            requireStr(args, 'artifact_id', 'workflow_read_artifact')
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'workflow_get_steps': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const db = getDatabase(devmindPath);
          const steps = db.getWorkflowSteps(requireStr(args, 'workflow_id', 'workflow_get_steps'), {
            last_n: args.last_n ? Number(args.last_n) : undefined,
            limit: args.limit ? Number(args.limit) : undefined,
            offset: args.offset ? Number(args.offset) : undefined
          });
          return { content: [{ type: 'text', text: JSON.stringify({ workflow_id: args.workflow_id, steps, count: steps.length }, null, 2) }] };
        }

        default:
          throw new Error(`Tool not found: ${name}`);
      }
    } catch (err) {
      console.error(`[DevsMind Error] Tool execution failed: ${(err as Error).message}`);
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }]
      };
    }
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

// â”€â”€ HTTP mode (default) — port 4500 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Start DevsMind as an HTTP MCP server on port 4500.
 * IDEs connect via: http://localhost:4500/mcp
 *
 * Port mnemonic: devsâ†’45 (D=4,E=5)  +  mindâ†’13 (M=13)  =  4513
 */
export async function runHttpMcpServer(port: number = DEVSMIND_PORT): Promise<void> {
  const app = express();
  app.use(express.json());

  // Health-check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      name: 'devsmind-mcp-server',
      version: '1.0.0',
      port,
      transport: 'http+streamable',
      endpoint: `http://localhost:${port}/mcp`
    });
  });

  // Visualizer Page endpoint (2D)
  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(VISUALIZER_2D_HTML);
  });

  // Visualizer Page endpoint (3D)
  app.get('/3d', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(VISUALIZER_3D_HTML);
  });

  // Temporary UMD Test endpoint
  app.get('/test-umd', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html>
<head>
  <script src="https://unpkg.com/three@0.128.0/build/three.min.js"></script>
  <script src="https://unpkg.com/3d-force-graph@1.72.0/dist/3d-force-graph.min.js"></script>
</head>
<body>
  <div id="3d-graph"></div>
  <script>
    const graph = ForceGraph3D()(document.getElementById('3d-graph'));
    console.log("ForceGraph3D keys:", Object.keys(ForceGraph3D));
    console.log("Graph instance keys:", Object.keys(graph));
    console.log("Graph scene constructor:", graph.scene().constructor.name);
    console.log("window.THREE exists:", typeof window.THREE);
  </script>
</body>
</html>`);
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
      const history = db.getAllHistory();
      res.json({ nodes, connections, history });
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

  const httpServer = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, '127.0.0.1', () => resolve());
    httpServer.once('error', reject);
  });

  console.log(`🧠 DevsMind running  →  http://localhost:${port}/mcp`);
  console.log(`   press Ctrl+C to stop`);

  registerShutdownHandlers(httpServer);
}

// â”€â”€ Stdio mode — for direct IDE plugin injection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Start DevsMind as a stdio MCP server.
 * Used when an IDE manages the process directly (e.g. Cursor stdio plugin mode).
 */
export function runStdioMcpServer(): void {
  // NOTE: do NOT write to stdout here — it is the JSON-RPC pipe.

  const server = createMcpServer();

  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    // connected
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

