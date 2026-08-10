#!/usr/bin/env node

import { Command } from 'commander';
import { handleInit } from './init';
import { handleRule } from './rule';
import { handleView } from './view';
import { handlePrune } from './prune';
import { handleSync } from './sync';
import { handleAnalyze } from './analyze';
import { handleDiff, handleRevert } from './diff';
import { handleActivity } from './activity';
import { handleFeedback } from './feedback';
import { handleWorkflow, handleWorkflowImport } from './workflow';
import { handleMcp } from './integrations/mcp';
import { handleMemory } from './integrations/memory';
import { handleSkill } from './integrations/skill';
import { runBackgroundIndexing, runBackgroundReindexing } from './runner';
import { handleDescribe } from './describe';
import { handleEmbed } from './embed';
import { runHttpMcpServer, runStdioMcpServer, DEVSMIND_PORT } from '../mcp/server';
import { recoverSpaceSplitPath } from '../utils/config';
import { DEVSMIND_VERSION } from '../utils/version';

const program = new Command();

program
  .name('devsmind')
  .description('DevsMind — Team AI Brain CLI')
  .version(DEVSMIND_VERSION, '-v, --version');

program
  .command('init')
  .description('Initialize a new DevsMind brain or update repository paths')
  .action(async () => {
    try {
      await handleInit();
    } catch (err) {
      console.error(`❌ Initialization failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('start')
  .description(
    `Start the DevsMind MCP server\n` +
    `  Default: HTTP on port ${DEVSMIND_PORT}  (devs→45, mind→M=13 → 4513)\n` +
    `  IDEs connect via: http://localhost:${DEVSMIND_PORT}/mcp`
  )
  .option('--stdio', 'Use stdio transport instead of HTTP (for direct IDE process injection)')
  .option('-p, --port <number>', `HTTP port to listen on (default: ${DEVSMIND_PORT})`, String(DEVSMIND_PORT))
  .option('--path <devmind_path>', 'Explicit path to the .devmind directory the server binds to (auto-detected from cwd by default). The server serves this one project, so callers never pass a path.')
  .option('--sync', 'Run devsmind sync before starting the server')
  .option('--analyze', 'Run devsmind analyze before starting the server')
  .option('--fix', 'With --analyze, also apply safe automatic fixes')
  .action(async (opts: { stdio?: boolean; port: string; path?: string; sync?: boolean; analyze?: boolean; fix?: boolean }, cmd: Command) => {
    // A shell-spawning MCP client hands us a space-containing --path pre-split across argv; the
    // tail sits in the leftover operands. Put it back together before anything reads opts.path.
    opts.path = recoverSpaceSplitPath(opts.path, cmd.args);
    if (opts.sync || opts.analyze) {
      try {
        // Both flags share the same "sync" entrypoint — --analyze without --sync still
        // needs a synced DB to analyze against, and handleSync's own syncFromDisk() is a
        // no-op cost-wise if the DB is already current, so requesting either one syncs.
        await handleSync({ path: opts.path, analyze: opts.analyze, fix: opts.fix });
      } catch (err) {
        console.error(`❌ Pre-start ${opts.analyze ? 'analyze' : 'sync'} failed: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    if (opts.stdio) {
      // Stdio mode: IDE manages the process directly. Errors here (e.g. a bad --path) must not
      // be an unhandled throw — same clean-exit treatment as the HTTP branch below, just via
      // stderr since stdout is the JSON-RPC pipe.
      try {
        runStdioMcpServer(opts.path);
      } catch (err) {
        console.error(`❌ MCP Server failed to start: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      // HTTP mode: IDE connects over the network
      const port = parseInt(opts.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`❌ Invalid port: ${opts.port}`);
        process.exit(1);
      }
      try {
        await runHttpMcpServer(port, opts.path);
      } catch (err) {
        const msg = (err as NodeJS.ErrnoException).message;
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          console.error(`❌ Port ${port} is already in use. Try: devsmind start --port <other>`);
        } else {
          console.error(`❌ MCP Server failed to start: ${msg}`);
        }
        process.exit(1);
      }
    }
  });

program
  .command('rule')
  .description('Get the AI workspace rule and place it in your tool (guided), or print it')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .option('--print', 'Just print the rule to stdout (no interactive placement)')
  .option('--manual', 'Manual workflow style: AI searches/reads freely but only stages or commits when explicitly asked (default is automatic — stages and commits without being asked). Only needed with --print/non-interactive; the interactive flow asks.')
  .action(async (opts: { path?: string; print?: boolean; manual?: boolean }) => {
    try {
      await handleRule(opts);
    } catch (err) {
      console.error(`❌ Rule failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('mcp')
  .description('Add DevsMind as an MCP server to your IDE or CLI (guided, per-tool)')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .action(async (opts: { path?: string }) => {
    try {
      await handleMcp(opts);
    } catch (err) {
      console.error(`❌ MCP setup failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('memory')
  .description('Print one paste-able prompt asking your AI to remember the DevsMind workflow — writes nothing to disk. Skips tools with no real memory feature (points at `devsmind skill` instead).')
  .option('--print', 'Skip the interactive tool picker and print immediately (non-interactive use)')
  .option('--tool <id>', 'Which tool to print for (claude-code, cursor, antigravity, ...) — changes the framing AND, for tools with a real memory mechanism, a tool-specific hint on how it actually saves. Only used with --print/non-interactive; the interactive flow asks.')
  .action(async (opts: { print?: boolean; tool?: string }) => {
    try {
      await handleMemory(opts);
    } catch (err) {
      console.error(`❌ Memory setup failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('skill')
  .description('Write the DevsMind workflow contract as an explicitly-invokable skill file (.agents/skills/devsmind/SKILL.md)')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .option('--print', 'Just print the file contents to stdout (no interactive write)')
  .action(async (opts: { path?: string; print?: boolean }) => {
    try {
      await handleSkill(opts);
    } catch (err) {
      console.error(`❌ Skill write failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('sync')
  .description('Sync the committed graph + history from disk into the local brain.db')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .option('--analyze', 'Run devsmind analyze immediately after syncing')
  .option('--fix', 'With --analyze, also apply safe automatic fixes')
  .option('--god-entity-threshold <n>', 'With --analyze, degree threshold for god-entity detection (default 15)')
  .action(async (opts: { path?: string; analyze?: boolean; fix?: boolean; godEntityThreshold?: string }) => {
    try {
      await handleSync(opts);
    } catch (err) {
      console.error(`❌ Sync failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('analyze')
  .description('Local, zero-AI graph health check (god entities, cycles, orphans, dangling edges, renames, and more)')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .option('--fix', 'Apply safe automatic fixes (deprecate dead nodes, delete dangling edges, migrate renames)')
  .option('--god-entity-threshold <n>', 'Degree threshold for god-entity detection (default 15)')
  .action(async (opts: { path?: string; fix?: boolean; godEntityThreshold?: string }) => {
    try {
      await handleAnalyze(opts);
    } catch (err) {
      console.error(`❌ Analyze failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('describe')
  .description('Backfill natural-language descriptions for existing nodes that predate the description requirement — what search_nodes needs to find code by natural language. Always safe to re-run (work queue is just "nodes with no description yet"); new nodes going forward get described via commit_changes\' gate + add_description instead, not this command.')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .option('--provider <provider>', 'LLM provider: "gemini", "vertex", or "ollama"', 'gemini')
  .option('--model <name>', 'Model identifier (default: "gemini-2.0-flash", "gemini-1.5-flash", or "qwen2.5-coder")')
  .option('--key <api_key>', 'API Key or Service Account file path (overrides GEMINI_API_KEY / GOOGLE_APPLICATION_CREDENTIALS)')
  .option('--url <url>', 'Ollama server endpoint (default: "http://localhost:11434")')
  .option('--rpm <number>', 'Max LLM requests per minute, proactively paced (default: unthrottled)')
  .option('--batch-size <number>', 'Nodes described per LLM call (default: 25)')
  .option('--dry-run', 'List pending nodes without calling the LLM or writing anything')
  .action(async (opts: {
    path?: string;
    provider: 'gemini' | 'vertex' | 'ollama';
    model?: string;
    key?: string;
    url?: string;
    rpm?: string;
    batchSize?: string;
    dryRun?: boolean;
  }) => {
    try {
      await handleDescribe({
        path: opts.path,
        provider: opts.provider,
        model: opts.model,
        key: opts.key,
        url: opts.url,
        rpm: opts.rpm ? parseInt(opts.rpm, 10) : undefined,
        batchSize: opts.batchSize ? parseInt(opts.batchSize, 10) : undefined,
        dryRun: !!opts.dryRun
      });
    } catch (err) {
      console.error(`❌ Describe failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('embed')
  .description('Compute semantic (vector) search embeddings for every described node that lacks a current one. Fully local/offline — no LLM credentials needed, inference runs on-device. Always safe to re-run (work queue is "needs a vector"); new/edited descriptions going forward get auto-embedded via commit_changes/add_description/describe instead, not this command — it\'s only for clearing an existing backlog or a model upgrade (--force).')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .option('--batch-size <number>', 'Nodes embedded per inference call (default: 32)')
  .option('--dry-run', 'List pending nodes without running inference or writing anything')
  .option('--force', 'Re-embed every described node regardless of current vector state (use after a model upgrade)')
  .action(async (opts: {
    path?: string;
    batchSize?: string;
    dryRun?: boolean;
    force?: boolean;
  }) => {
    try {
      await handleEmbed({
        path: opts.path,
        batchSize: opts.batchSize ? parseInt(opts.batchSize, 10) : undefined,
        dryRun: !!opts.dryRun,
        force: !!opts.force
      });
    } catch (err) {
      console.error(`❌ Embed failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('diff <node_id>')
  .description('Show what changed in an entity, red/green, with the reasoning recorded for it')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .action(async (nodeId: string, opts: { path?: string }) => {
    try {
      await handleDiff(nodeId, opts);
    } catch (err) {
      console.error(`❌ Diff failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('revert <node_id>')
  .description('Undo an entity\'s most recent recorded edit and erase it from history')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(async (nodeId: string, opts: { path?: string; yes?: boolean }) => {
    try {
      await handleRevert(nodeId, opts);
    } catch (err) {
      console.error(`❌ Revert failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('activity')
  .description('Show your local activity timeline — sessions and messages by day (local only, never pushed)')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .option('--since <days>', 'Only show messages from the last N days')
  .action(async (opts: { path?: string; since?: string }) => {
    try {
      await handleActivity(opts);
    } catch (err) {
      console.error(`❌ Activity failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('feedback')
  .description('Show feedback recorded from commit_changes — graph problems, product feedback, and indexer rule candidates (local only, never pushed)')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .option('--since <days>', 'Only show entries from the last N days')
  .option('--all', 'Include graph-feedback entries already marked processed (default: unprocessed only)')
  .action(async (opts: { path?: string; since?: string; all?: boolean }) => {
    try {
      await handleFeedback(opts);
    } catch (err) {
      console.error(`❌ Feedback failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('workflow')
  .description('List, view, pause, and resume persistent feature workflows (interactive)')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .action(async (opts: { path?: string }) => {
    try {
      await handleWorkflow(opts);
    } catch (err) {
      console.error(`❌ Workflow command failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('workflow-import <path>')
  .description('Import a folder of .md flow docs (or a single file) as paused, resumable workflows')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .action(async (pathArg: string, opts: { path?: string }) => {
    try {
      await handleWorkflowImport(pathArg, opts);
    } catch (err) {
      console.error(`❌ Workflow import failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('view')
  .description('Open the interactive D3.js code graph visualizer in your browser')
  .option('-p, --path <devmind_path>', 'Path to the .devmind directory (auto-detected from cwd by default)')
  .option('-P, --port <number>', `HTTP port to listen on (default: ${DEVSMIND_PORT})`, String(DEVSMIND_PORT))
  .action(async (opts: { path?: string; port: string }) => {
    await handleView(opts);
  });

program
  .command('index')
  .description('Kick off the first-time graph indexing of all configured repos')
  .option('-p, --path <devmind_path>', 'Path to the .devmind directory (default: .devmind in cwd)')
  .option('--run', 'Start/resume background indexing using a local or cloud LLM')
  .option('--provider <provider>', 'LLM provider: "gemini", "vertex", or "ollama"', 'gemini')
  .option('--model <name>', 'Model identifier (default: "gemini-2.0-flash", "gemini-1.5-flash", or "qwen2.5-coder")')
  .option('--key <api_key>', 'API Key or Service Account file path (overrides GEMINI_API_KEY / GOOGLE_APPLICATION_CREDENTIALS)')
  .option('--url <url>', 'Ollama server endpoint (default: "http://localhost:11434")')
  .option('--chunk-size <lines>', 'Max lines per chunk sent to the LLM (default: off — whole file in one call). Set this for very large files or smaller-context models.')
  .option('--chunk-overlap <lines>', 'Overlap lines between chunks, only used when --chunk-size is set (default: 50)')
  .option('--local-edges', '[Deprecated] Connections are always resolved locally via AST now — this flag is a no-op, kept for backward compatibility.')
  .option('--from-scratch', 'Wipe ALL nodes, connections, history, and graph/history folders, then reindex from zero. Asks for confirmation unless --yes is passed.')
  .option('--nodes-only', 'Only run Phase 1 (node/code extraction). No connections are built or touched.')
  .option('--edges-only', 'Only run Phase 2 (connection resolution). Wipes existing connections and rebuilds them fresh across all current nodes. Requires nodes to already exist.')
  .option('--describe', 'Only meaningful with --nodes-only: also run Phase 3 (description backfill) right after that structure-only extraction, using the SAME credentials — an optional extension when you want a --nodes-only run to be searchable immediately instead of running `devsmind describe` separately later. On a FULL run (neither --nodes-only nor --edges-only), Phase 3 always runs regardless of this flag — descriptions are mandatory there, since Phase 1/2 never write one and an undescribed "finished" index is not actually searchable by search_nodes\' description/vector layers. Not allowed with --edges-only (which never extracts nodes or resolves credentials).')
  .option('--describe-batch-size <number>', 'Nodes described per LLM call during Phase 3 (default: 25)')
  .option('--repos <names>', 'Comma-separated repo names to restrict this run to (standalone mode only). Composes with --nodes-only / --edges-only, or full. Not allowed with --from-scratch.')
  .option('--rpm <number>', 'Max LLM requests per minute, paced proactively to avoid 429s (default: unthrottled — fires as fast as possible)')
  .option('--yes', 'Skip the confirmation prompt for --from-scratch')
  .action(async (opts: {
    path?: string;
    run?: boolean;
    provider: 'gemini' | 'vertex' | 'ollama';
    model?: string;
    key?: string;
    url?: string;
    chunkSize?: string;
    chunkOverlap?: string;
    localEdges?: boolean;
    fromScratch?: boolean;
    nodesOnly?: boolean;
    edgesOnly?: boolean;
    describe?: boolean;
    describeBatchSize?: string;
    repos?: string;
    rpm?: string;
    yes?: boolean;
  }) => {
    const devmindPath = opts.path ?? '.devmind';
    const resolved = require('path').resolve(devmindPath);

    if (opts.run) {
      if (opts.nodesOnly && opts.edgesOnly) {
        console.error('❌ Error: --nodes-only and --edges-only cannot be used together. Omit both to run the full index.');
        process.exit(1);
      }
      if (opts.fromScratch && opts.edgesOnly) {
        console.error('❌ Error: --from-scratch and --edges-only cannot be used together — --from-scratch wipes nodes, so there would be nothing to build edges from. Use --from-scratch alone, or --from-scratch --nodes-only, then --edges-only separately.');
        process.exit(1);
      }
      if (opts.describe && opts.edgesOnly) {
        console.error('❌ Error: --describe and --edges-only cannot be used together — --edges-only never extracts nodes or resolves LLM credentials, so there is nothing new to describe. Run `devsmind describe` separately if you need to backfill descriptions after an --edges-only run.');
        process.exit(1);
      }
      try {
        await runBackgroundIndexing({
          devmindPath,
          provider: opts.provider,
          model: opts.model,
          key: opts.key,
          url: opts.url,
          chunkSize: opts.chunkSize ? parseInt(opts.chunkSize, 10) : undefined,
          chunkOverlap: opts.chunkOverlap ? parseInt(opts.chunkOverlap, 10) : undefined,
          localEdges: !!opts.localEdges,
          fromScratch: !!opts.fromScratch,
          nodesOnly: !!opts.nodesOnly,
          edgesOnly: !!opts.edgesOnly,
          describe: !!opts.describe,
          describeBatchSize: opts.describeBatchSize ? parseInt(opts.describeBatchSize, 10) : undefined,
          repos: opts.repos ? opts.repos.split(',').map(s => s.trim()).filter(Boolean) : undefined,
          rpm: opts.rpm ? parseInt(opts.rpm, 10) : undefined,
          yes: !!opts.yes
        });
      } catch (err) {
        console.error(`❌ Background indexing failed: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      console.log(`\n🧠 DevsMind — Graph Indexing`);
      console.log(`   Brain : ${resolved}`);
      console.log(`\n📋 To index your codebase, tell your AI assistant:\n`);
      console.log(`   "Call devsmind.index_start with devmind_path = ${resolved}"`);
      console.log(`   "It already parses the code itself — describe each node it hands you with add_description, then call index_continue."`);
      console.log(`   "Repeat index_continue until every file is extracted and described, then call index_complete."`);
      console.log(`   "NEVER use or write external scripts (like Python) to index files."\n`);
      console.log(`   Or run it locally in the background using:\n`);
      console.log(`   devsmind index --run --provider gemini --key YOUR_GEMINI_KEY`);
      console.log(`   devsmind index --run --provider gemini --model gemini-2.5-flash --key YOUR_GEMINI_KEY --chunk-size 1500 --chunk-overlap 100`);
      console.log(`   devsmind index --run --provider ollama --model qwen2.5-coder`);
      console.log(`   devsmind index --run --provider gemini --key YOUR_GEMINI_KEY --nodes-only`);
      console.log(`   devsmind index --run --edges-only`);
      console.log(`   devsmind index --run --provider gemini --key YOUR_GEMINI_KEY --from-scratch`);
      console.log(`   devsmind index --run --edges-only --repos harrir-web,harrir-web-admin`);
      console.log(`   devsmind index --run --provider gemini --key YOUR_GEMINI_KEY --repos harrir-mini-app\n`);
    }
  });

program
  .command('reindex')
  .description('Synchronize the graph with manual changes (incremental parsing of modified/new files)')
  .option('-p, --path <devmind_path>', 'Path to the .devmind directory (default: .devmind in cwd)')
  .option('--provider <provider>', 'LLM provider: "gemini", "vertex", or "ollama"', 'gemini')
  .option('--model <name>', 'Model identifier (default: "gemini-2.0-flash", "gemini-1.5-flash", or "qwen2.5-coder")')
  .option('--key <api_key>', 'API Key or Service Account file path (overrides GEMINI_API_KEY / GOOGLE_APPLICATION_CREDENTIALS)')
  .option('--url <url>', 'Ollama server endpoint (default: "http://localhost:11434")')
  .option('--chunk-size <lines>', 'Max lines per chunk sent to the LLM (default: off — whole file in one call). Set this for very large files or smaller-context models.')
  .option('--chunk-overlap <lines>', 'Overlap lines between chunks, only used when --chunk-size is set (default: 50)')
  .option('--local-edges', '[Deprecated] Connections are always resolved locally via AST now — this flag is a no-op, kept for backward compatibility.')
  .option('--rpm <number>', 'Max LLM requests per minute, paced proactively to avoid 429s (default: unthrottled — fires as fast as possible)')
  .option('--fill-gaps', 'Instead of the normal mtime-based diff, back-fill only files that currently have zero graph nodes (never indexed, or dropped by a prior crashed run). Per-file failures are skipped (not fatal) and edges are rebuilt across the whole graph afterward. Safe to re-run repeatedly until no gaps remain.')
  .action(async (opts: {
    path?: string;
    provider: 'gemini' | 'vertex' | 'ollama';
    model?: string;
    key?: string;
    url?: string;
    chunkSize?: string;
    chunkOverlap?: string;
    localEdges?: boolean;
    rpm?: string;
    fillGaps?: boolean;
  }) => {
    const devmindPath = opts.path ?? '.devmind';
    try {
      await runBackgroundReindexing({
        devmindPath,
        provider: opts.provider,
        model: opts.model,
        key: opts.key,
        url: opts.url,
        chunkSize: opts.chunkSize ? parseInt(opts.chunkSize, 10) : undefined,
        chunkOverlap: opts.chunkOverlap ? parseInt(opts.chunkOverlap, 10) : undefined,
        localEdges: !!opts.localEdges,
        rpm: opts.rpm ? parseInt(opts.rpm, 10) : undefined,
        fillGaps: !!opts.fillGaps
      });
    } catch (err) {
      console.error(`❌ Reindexing failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('prune')
  .description('Interactively review, inspect, and permanently prune nodes and history')
  .option('-p, --path <devmind_path>', 'Path to the .devmind directory (auto-detected from cwd by default)')
  .action(async (opts: { path?: string }) => {
    try {
      await handlePrune(opts);
    } catch (err) {
      console.error(`❌ Pruning failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);

