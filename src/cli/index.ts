#!/usr/bin/env node

import { Command } from 'commander';
import { handleInit } from './init';
import { handleRule } from './rule';
import { handleView } from './view';
import { handlePrune } from './prune';
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
  .description('Print the ready-to-paste AI workspace rule for this brain')
  .option('-p, --path <devmind_path>', 'Explicit path to the .devmind directory (auto-detected from cwd by default)')
  .action((opts: { path?: string }) => {
    handleRule(opts);
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
  .action(async (opts: {
    path?: string;
    run?: boolean;
    provider: 'gemini' | 'vertex' | 'ollama';
    model?: string;
    key?: string;
    url?: string;
  }) => {
    const devmindPath = opts.path ?? '.devmind';
    const resolved = require('path').resolve(devmindPath);

    if (opts.run) {
      try {
        await runBackgroundIndexing({
          devmindPath,
          provider: opts.provider,
          model: opts.model,
          key: opts.key,
          url: opts.url
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
      console.log(`   "Then read every file it returns and call add_node + add_connection for each entity."`);
      console.log(`   "Checkpoint every 10 files. Call index_complete when done."`);
      console.log(`   "NEVER use or write external scripts (like Python) to index files."\n`);
      console.log(`   Or run it locally in the background using:\n`);
      console.log(`   devsmind index --run --provider gemini --key YOUR_GEMINI_KEY`);
      console.log(`   devsmind index --run --provider ollama --model qwen2.5-coder\n`);
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
  .action(async (opts: {
    path?: string;
    provider: 'gemini' | 'vertex' | 'ollama';
    model?: string;
    key?: string;
    url?: string;
  }) => {
    const devmindPath = opts.path ?? '.devmind';
    try {
      await runBackgroundReindexing({
        devmindPath,
        provider: opts.provider,
        model: opts.model,
        key: opts.key,
        url: opts.url
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

