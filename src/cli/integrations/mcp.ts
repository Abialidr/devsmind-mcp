import * as path from 'path';
import { resolveDevmindDir } from '../../utils/config';
import { DEVSMIND_PORT } from '../../mcp/server';
import {
  EntryContext,
  McpScope,
  Transport,
  resolveScopeFile,
  resolveOsPath,
  ConfigFormat,
} from './registry';
import {
  pickTarget,
  pickTransport,
  pickMcpScope,
  pickMode,
  pickDirectory,
  confirmPrompt,
  mergeMcpConfig,
  writeConfigFile,
  CancelledError,
} from './prompt';

const SERVER_NAME = 'devsmind';

/**
 * `devsmind mcp` — guided walkthrough that adds DevsMind as an MCP server to a
 * chosen IDE or CLI, either by printing the exact snippet (manual) or by
 * creating/merging the tool's config file (automatic, with preview + confirm).
 */
export async function handleMcp(opts: { path?: string }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      `❌ \`devsmind mcp\` is interactive and needs a terminal.\n` +
      `   Run it directly in your shell (not piped/redirected).`
    );
    process.exit(1);
  }

  const devmindDir = resolveDevmindDir(opts.path);
  const workspaceRoot = devmindDir ? path.dirname(devmindDir) : process.cwd();

  if (!devmindDir) {
    console.log(
      `\n⚠️  No .devmind brain found here — you can still add the MCP config, but run` +
      ` \`devsmind init\` in your project so the server has a brain to serve.`
    );
  }

  const ctx: EntryContext = { devmindDir: devmindDir ?? workspaceRoot, port: DEVSMIND_PORT };

  try {
    const target = await pickTarget();
    const transport = await pickTransport(target);
    const scope = await pickMcpScope(target);
    const entry = target.mcp.entry(transport, ctx);

    if (target.mcp.note) console.log(`\nℹ️  ${target.mcp.note}`);

    const mode = await pickMode();
    if (mode === 'manual') {
      printManual(target.label, scope, workspaceRoot, entry);
      if (target.mcp.cliInstaller) {
        console.log(`\n💡 Or use the tool's own installer:`);
        console.log(`   ${target.mcp.cliInstaller(transport, ctx)}`);
      }
      printNudge(transport);
      return;
    }

    // Automatic mode.
    let filePath: string;
    if (scope.scope === 'project') {
      const base = await pickDirectory(workspaceRoot, `Where is the project root for ${target.label}?`);
      filePath = path.join(base, resolveOsPath(scope.file));
    } else {
      filePath = resolveScopeFile(scope.file, 'global', workspaceRoot);
    }

    const merged = mergeMcpConfig(filePath, scope.format, scope.serverMapPath, SERVER_NAME, entry);

    console.log(`\n📝 Target: ${filePath.replace(/\\/g, '/')}  (${merged.existed ? 'merge into existing' : 'create new'})`);
    if (scope.scope === 'global') {
      console.log(`   ⚠️  This is a GLOBAL config file affecting all your projects.`);
    }
    console.log(`\n${merged.existed ? 'The "devsmind" entry to be added:' : 'File contents to be written:'}\n`);
    console.log(indent(merged.preview));

    const ok = await confirmPrompt('Write this?', true);
    if (!ok) {
      console.log('\nAborted — nothing written.');
      return;
    }

    writeConfigFile(filePath, merged.content);
    console.log(`\n✅ DevsMind added to ${target.label} at ${filePath.replace(/\\/g, '/')}`);
    printNudge(transport);
  } catch (err) {
    if (err instanceof CancelledError) {
      console.log('\nCancelled.');
      return;
    }
    throw err;
  }
}

function printManual(label: string, scope: McpScope, workspaceRoot: string, entry: Record<string, unknown>): void {
  const filePath = resolveScopeFile(scope.file, scope.scope, workspaceRoot);
  const divider = '─'.repeat(70);
  console.log(`\n${divider}`);
  console.log(` Add DevsMind to ${label}`);
  console.log(`${divider}`);
  console.log(`\n1. Open (or create) this file:`);
  console.log(`   ${filePath.replace(/\\/g, '/')}${scope.scope === 'global' ? '   (global)' : ''}`);
  console.log(`\n2. Add this ${scope.format.toUpperCase()} entry (merge with anything already there):\n`);
  console.log(indent(renderSnippet(scope.format, scope.serverMapPath, entry)));
}

/** Render just the devsmind entry as a standalone snippet (no existing content). */
function renderSnippet(format: ConfigFormat, serverMapPath: string[], entry: Record<string, unknown>): string {
  if (format === 'toml') {
    const header = [...serverMapPath, SERVER_NAME].join('.');
    const lines = [`[${header}]`];
    for (const [k, v] of Object.entries(entry)) {
      lines.push(`${k} = ${tomlLiteral(v)}`);
    }
    return lines.join('\n');
  }
  // JSON: nest entry under the server map path.
  let obj: Record<string, unknown> = { [SERVER_NAME]: entry };
  for (let i = serverMapPath.length - 1; i >= 0; i--) {
    obj = { [serverMapPath[i]]: obj };
  }
  return JSON.stringify(obj, null, 2);
}

function tomlLiteral(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(tomlLiteral).join(', ') + ']';
  if (v && typeof v === 'object') {
    const inner = Object.entries(v as Record<string, unknown>)
      .map(([k, iv]) => `${k} = ${tomlLiteral(iv)}`)
      .join(', ');
    return `{ ${inner} }`;
  }
  return String(v);
}

function indent(text: string): string {
  return text.split('\n').map(l => '   ' + l).join('\n');
}

function printNudge(transport: Transport): void {
  if (transport === 'stdio') {
    console.log(`\n📌 stdio setup: your tool launches DevsMind itself. After you \`git pull\``);
    console.log(`   graph changes, run \`devsmind sync\` to load them into your local brain.`);
  } else {
    console.log(`\n📌 HTTP setup: start the server yourself with \`devsmind start\` (port ${DEVSMIND_PORT}).`);
  }
}
