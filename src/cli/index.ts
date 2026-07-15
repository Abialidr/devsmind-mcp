#!/usr/bin/env node

import { Command } from 'commander';
import { handleInit } from './init';
import { handleRule } from './rule';
import { handleView } from './view';
import { handlePrune } from './prune';
import { handleSync } from './sync';
import { handleMcp } from './integrations/mcp';
import { handleMemory } from './integrations/memory';
import { runBackgroundIndexing, runBackgroundReindexing } from './runner';
import { runHttpMcpServer, runStdioMcpServer, DEVSMIND_PORT } from '../mcp/server';

const program = new Command();

program
  .name('devsmind')
  .description('DevsMind — Team AI Brain CLI')
  .version('1.0.0', '-v, --version');

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
  .action(async (opts: { stdio?: boolean; port: string }) => {
    if (opts.stdio) {
      // Stdio mode: IDE manages the process directly
      runStdioMcpServer();
    } else {
      // HTTP mode: IDE connects over the network
      const port = parseInt(opts.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`❌ Invalid port: ${opts.port}`);
        process.exit(1);
      }
      try {
        await runHttpMcpServer(port);
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
  .action(async (opts: { path?: string; print?: boolean }) => {
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
  .description('Seed a tool\'s own persistent agent-memory/skills store (guided, per-tool)')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .action(async (opts: { path?: string }) => {
    try {
      await handleMemory(opts);
    } catch (err) {
      console.error(`❌ Memory setup failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('sync')
  .description('Sync the committed graph + history from disk into the local brain.db')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .action(async (opts: { path?: string }) => {
    try {
      await handleSync(opts);
    } catch (err) {
      console.error(`❌ Sync failed: ${(err as Error).message}`);
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
      console.log(`   "Then read every file it returns and call stage_change for each entity, then commit_changes."`);
      console.log(`   "Checkpoint every 10 files. Call index_complete when done."`);
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

