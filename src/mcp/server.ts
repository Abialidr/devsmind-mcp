import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';
import express from 'express';
import { DevMindDatabase } from '../db/database';
import { loadProjectContext } from '../utils/config';
import { VISUALIZER_2D_HTML, VISUALIZER_3D_HTML } from './visualizer';
import {
  readScratchpad,
  createScratchpad,
  updateScratchpad,
  completeScratchpad
} from '../db/indexer';
import { scanRepoFiles } from '../utils/scanner';
import { stageEntry, readStaged, clearStaged, commitStagedChanges, StagedEntry } from '../db/staging';

// â”€â”€â”€ Port: devsâ†’D(4)E(5)=45 + mindâ†’M(13)=13 â†’ 4513 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const DEVSMIND_PORT = 4513;

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
  'ORM â€” PRISMA: prisma_model | prisma_query | prisma_migration\n' +
  'ORM â€” TYPEORM: typeorm_entity | typeorm_repository | typeorm_migration\n' +
  'ORM â€” MONGOOSE: mongoose_model | mongoose_schema\n' +
  'ORM â€” SQLALCHEMY: sqlalchemy_model | sqlalchemy_query\n' +
  'ORM â€” SEQUELIZE: sequelize_model | sequelize_migration\n\n' +
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
  // Not provided â€” auto-detect from where devsmind start was run
  const autoDetected = findDevmindDir(process.cwd());
  if (autoDetected) return autoDetected;
  throw new Error(`devmind_path was not provided and no .devmind directory was found by walking up from: "${process.cwd()}". Pass devmind_path explicitly.`);
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
 * Stateless â€” every call receives devmind_path and opens the db from there.
 */
function createMcpServer(): Server {
  const server = new Server(
    { name: 'devsmind-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
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
            "Get a single node's CURRENT source code, parsed live from its file on disk — token-efficient, since it returns only that function/class/route rather than the whole file. Call this instead of reading a file whenever you need one specific entity. Response fields: `source: \"live\"` means the code was read from disk and is current. `source: \"cached\"` means the symbol could not be located in its file (not a TS/JS file, or it was renamed/moved/deleted) so a possibly-stale cached snapshot was returned — verify it against the file before relying on it. `snapshot_outdated: true` means the stored graph has drifted from disk; re-stage the node with stage_change + commit_changes to bring the brain back in sync. To fetch a whole call flow at once, prefer get_node_graph with include_code instead of calling this repeatedly.",
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
          name: 'stage_change',
          description:
            'Stage ONE changed code node (function/class/method/etc.) into a buffer without writing to the graph yet. Call this once for EVERY file/entity you touched during a task — passing only the code and reasoning; you do NOT reason about connections here. When you are done with all the files, call commit_changes ONCE — it creates every node, writes every history entry, and resolves all connections between them via local AST in a single pass (so a call from one changed file into another resolves correctly no matter which order you staged them). Staging is buffered on disk, so it survives a context reset. ⚠️ YOU MUST CALL commit_changes at the end, or nothing is written to the graph.',
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
                  developer: { type: 'string', description: 'Name of the developer' },
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
            'Commit all buffered stage_change entries in one atomic pass: creates/updates every staged node, writes every history snapshot, then resolves all connections between the staged nodes (and into the existing graph) via local AST — auto-creating any referenced-but-missing target nodes. Clears the buffer on success. Call this exactly once after you have finished staging every file you touched.',
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
          description: 'Get the full version history of a code node, including all past code snapshots and change reasoning.',
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
            'Get a node\'s dependency graph — connected nodes and the relationships between them. Set direction:"out" AND include_code:true to pull an ENTIRE CALL FLOW in a single call: the starting node plus everything it transitively calls, each with its current source code read from disk. Use that combination whenever you are tracing how a request, endpoint, or feature flows through the codebase — it replaces a long chain of get_node_code calls with one round trip. Use direction:"in" to find every caller of a node (impact analysis before a change). If `code_truncated` is true in the response, the character budget ran out and `nodes_without_code` nodes came back with metadata but no code — fetch those individually with get_node_code, or raise code_char_budget.',
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
          description: 'Search node names, identifiers, or reasoning logs matching a query.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              query: { type: 'string', description: 'Search term or query string' }
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
        {
          name: 'search_code',
          description: 'Regex or string search over cached codebase code snapshots. Returns matches grouped by DevsMind Node ID, file path, and matching lines, along with matching statistics (ratio, count). Prefer this over direct grep search.',
          inputSchema: {
            type: 'object',
            properties: {
              devmind_path: { type: 'string', description: 'Absolute path to the .devmind directory' },
              query: { type: 'string', description: 'Regex or substring pattern to search for in code' },
              is_regex: { type: 'boolean', description: 'Whether the query is a regex pattern (default: false)' },
              case_insensitive: { type: 'boolean', description: 'Perform case-insensitive search (default: true)' }
            },
            required: ['devmind_path', 'query']
          }
        },
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
          const nodeId = String(args.node_id);
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
          const nodeId = String(args.node_id);
          const db = getDatabase(devmindPath);
          const result = db.getLiveCode(nodeId);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        }

        case 'update_history': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const filePath = String(args.file_path);
          const db = getDatabase(devmindPath);

          // Single-shot path: stage one entry and commit it immediately, so a lone edit still
          // gets its node, history, AND outgoing edges resolved via the shared commit logic.
          const entry: StagedEntry = {
            node_id: String(args.node_id),
            file_path: filePath,
            code_snapshot: String(args.code_snapshot),
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

        case 'stage_change': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const entry: StagedEntry = {
            node_id: String(args.node_id),
            file_path: String(args.file_path),
            code_snapshot: String(args.code_snapshot),
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
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                committed: true,
                message: `✅ Committed ${summary.nodes} node(s), ${summary.history_entries} history entr(ies), ${summary.edges_added} connection(s) resolved` +
                  (summary.missing_filled > 0 ? `, ${summary.missing_filled} missing node(s) auto-created.` : '.'),
                ...summary
              }, null, 2)
            }]
          };
        }

        // ── Deprecated write handlers: NOT advertised in ListTools (superseded by
        //    stage_change/commit_changes), but retained so any direct/legacy call still works. ──
        case 'add_node': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const rawNodeId = String(args.node_id);
          const filePath = String(args.file_path);

          const db = getDatabase(devmindPath);
          const repoRelPath = db.toRepoRelativePath(filePath);
          const prefix = `${repoRelPath}#`;
          const nodeId = rawNodeId.includes('#') ? rawNodeId : `${prefix}${rawNodeId}`;

          db.upsertNode({
            id: nodeId,
            name: String(args.name),
            type: String(args.type),
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
          db.addConnection(String(args.source_node_id), String(args.target_node_id));
          return {
            content: [{ type: 'text', text: JSON.stringify({ added: true, source: args.source_node_id, target: args.target_node_id }) }]
          };
        }

        case 'recheck_graph': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const workspaceRoot = String(args.workspace_root);
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
          const nodeId = String(args.node_id);
          const db = getDatabase(devmindPath);
          const history = db.getFullHistory(nodeId);
          return {
            content: [{ type: 'text', text: JSON.stringify(history, null, 2) }]
          };
        }

        case 'get_node_graph': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const nodeId = String(args.node_id);
          const maxDepth = args.max_depth ? Number(args.max_depth) : 6;
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
          const query = String(args.query);
          const db = getDatabase(devmindPath);
          const results = db.searchNodes(query);
          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }]
          };
        }

        case 'rename_node': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const oldNodeId = String(args.old_node_id);
          const newNodeId = String(args.new_node_id);
          const newName = args.new_name ? String(args.new_name) : undefined;
          const db = getDatabase(devmindPath);
          db.renameNode(oldNodeId, newNodeId, newName);
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, old_node_id: oldNodeId, new_node_id: newNodeId }) }]
          };
        }

        case 'deprecate_node': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const nodeId = String(args.node_id);
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
          const developer = String(args.developer);
          const limit = args.limit ? Number(args.limit) : 50;
          const db = getDatabase(devmindPath);
          const activity = db.getDeveloperActivity(developer, limit);
          return {
            content: [{ type: 'text', text: JSON.stringify(activity, null, 2) }]
          };
        }

        case 'get_changes_by_requirement': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const requirementId = String(args.requirement_id);
          const db = getDatabase(devmindPath);
          const changes = db.getChangesByRequirement(requirementId);
          return {
            content: [{ type: 'text', text: JSON.stringify(changes, null, 2) }]
          };
        }

        case 'search_decisions': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const query = String(args.query);
          const db = getDatabase(devmindPath);
          const decisions = db.searchDecisions(query);
          return {
            content: [{ type: 'text', text: JSON.stringify(decisions, null, 2) }]
          };
        }

        case 'search_code': {
          const devmindPath = resolveDevmindPath(args.devmind_path);
          const query = String(args.query);
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

// â”€â”€ HTTP mode (default) â€” port 4500 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // MCP endpoint â€” stateless: each request gets its own server + transport pair
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

  console.log(`ðŸ§  DevsMind running  â†’  http://localhost:${port}/mcp`);
  console.log(`   press Ctrl+C to stop`);

  registerShutdownHandlers(httpServer);
}

// â”€â”€ Stdio mode â€” for direct IDE plugin injection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Start DevsMind as a stdio MCP server.
 * Used when an IDE manages the process directly (e.g. Cursor stdio plugin mode).
 */
export function runStdioMcpServer(): void {
  // NOTE: do NOT write to stdout here â€” it is the JSON-RPC pipe.

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

