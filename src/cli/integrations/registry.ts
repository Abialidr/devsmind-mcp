import * as os from 'os';
import * as path from 'path';

/**
 * Registry of AI coding tools DevsMind can integrate with. This single table
 * drives both `devsmind mcp` (add the MCP server) and `devsmind rule` (write the
 * workspace rule). To fix or add a tool, edit an entry here — nothing else.
 */

export type Transport = 'stdio' | 'http';
export type ConfigFormat = 'json' | 'toml';
export type Scope = 'project' | 'global';

/** A path that may differ per-OS. Strings may contain a leading `~` for the home dir. */
export type OsPath = string | { win32: string; darwin: string; linux: string };

export interface McpScope {
  scope: Scope;
  /** Project paths are relative to the workspace root; global paths are absolute (may start with `~`). */
  file: OsPath;
  format: ConfigFormat;
  /** Key-path to the server map, e.g. ['mcpServers'] or ['servers'] or ['mcp_servers']. */
  serverMapPath: string[];
}

export interface RuleScope {
  scope: Scope;
  file: OsPath;
}

export interface IdeTarget {
  id: string;
  label: string;
  kind: 'ide' | 'cli';
  mcp: {
    scopes: McpScope[];
    /** Supported transports; first is the preferred default. */
    transports: Transport[];
    /** The value object placed under serverMap['devsmind'] for a given transport. */
    entry: (t: Transport, ctx: EntryContext) => Record<string, unknown>;
    /** Optional CLI one-liner installer (e.g. `claude mcp add ...`). */
    cliInstaller?: (t: Transport, ctx: EntryContext) => string;
    /** Extra guidance printed in manual mode. */
    note?: string;
  };
  rules: {
    scopes: RuleScope[];
    /** `standalone` = dedicated devsmind file; `append-section` = merge a delimited block into a shared file. */
    style: 'standalone' | 'append-section';
    /** Optional transform of the rule body before writing (e.g. Cursor .mdc frontmatter). */
    wrap?: (body: string) => string;
  };
}

/** Context available when rendering a server entry. */
export interface EntryContext {
  devmindDir: string;   // absolute .devmind path
  port: number;         // DEVSMIND_PORT
}

// ─── Shared entry payloads ───────────────────────────────────────────────────

/** Standard stdio entry: the IDE spawns `devsmind start --stdio`. */
export function stdioEntry(): Record<string, unknown> {
  return { command: 'devsmind', args: ['start', '--stdio'] };
}

/** Standard HTTP entry: connect to the already-running server. */
export function httpEntry(ctx: EntryContext): Record<string, unknown> {
  return { url: `http://localhost:${ctx.port}/mcp` };
}

// ─── OS-aware path resolution ────────────────────────────────────────────────

/** Resolve an {@link OsPath} to a concrete string for the current platform, expanding a leading `~`. */
export function resolveOsPath(p: OsPath): string {
  const raw = typeof p === 'string' ? p : (p as Record<string, string>)[process.platform] ?? (p as any).linux;
  if (raw.startsWith('~')) {
    return path.join(os.homedir(), raw.slice(1));
  }
  return raw;
}

/**
 * Resolve the absolute file path for a config/rule scope.
 * Project scopes are joined onto `workspaceRoot`; global scopes are absolute.
 */
export function resolveScopeFile(file: OsPath, scope: Scope, workspaceRoot: string): string {
  const resolved = resolveOsPath(file);
  if (scope === 'project') {
    return path.isAbsolute(resolved) ? resolved : path.join(workspaceRoot, resolved);
  }
  return path.resolve(resolved);
}

// ─── Transport-specific entry helpers ────────────────────────────────────────
// Different tools key the HTTP endpoint differently (url / serverUrl / httpUrl)
// and some require an explicit `type`. These builders capture each tool's shape.

const httpUrl = (ctx: EntryContext) => `http://localhost:${ctx.port}/mcp`;

/** Cursor / Kiro: bare `url`, no type. */
const entryUrl = (t: Transport, ctx: EntryContext) =>
  t === 'stdio' ? stdioEntry() : { url: httpUrl(ctx) };

/** VS Code / Claude Code: explicit `type` + url. */
const entryTyped = (t: Transport, ctx: EntryContext) =>
  t === 'stdio'
    ? { type: 'stdio', ...stdioEntry() }
    : { type: 'http', url: httpUrl(ctx) };

/** Windsurf / Antigravity: HTTP endpoint keyed as `serverUrl`. */
const entryServerUrl = (t: Transport, ctx: EntryContext) =>
  t === 'stdio' ? stdioEntry() : { serverUrl: httpUrl(ctx) };

/** Qwen Code: Streamable-HTTP endpoint keyed as `httpUrl`. */
const entryHttpUrl = (t: Transport, ctx: EntryContext) =>
  t === 'stdio' ? stdioEntry() : { httpUrl: httpUrl(ctx) };

const cursorMdcWrap = (body: string): string =>
  `---\ndescription: DevsMind — Team AI Brain workspace rule\nalwaysApply: true\n---\n\n${body}\n`;

// VS Code user-profile mcp.json lives in the platform user-data dir.
const VSCODE_GLOBAL: OsPath = {
  win32: '~/AppData/Roaming/Code/User/mcp.json',
  darwin: '~/Library/Application Support/Code/User/mcp.json',
  linux: '~/.config/Code/User/mcp.json',
};

// ─── The registry ────────────────────────────────────────────────────────────
// IDEs first, then CLIs, for the picker menu. Each tool's HTTP-key quirk and
// rules location are encoded here — the rest of the code is tool-agnostic.

export const TARGETS: IdeTarget[] = [
  // ── IDEs ──────────────────────────────────────────────────────────────────
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'ide',
    mcp: {
      scopes: [
        { scope: 'project', file: '.cursor/mcp.json', format: 'json', serverMapPath: ['mcpServers'] },
        { scope: 'global', file: '~/.cursor/mcp.json', format: 'json', serverMapPath: ['mcpServers'] },
      ],
      transports: ['stdio', 'http'],
      entry: entryUrl,
    },
    rules: {
      scopes: [{ scope: 'project', file: '.cursor/rules/devsmind.mdc' }],
      style: 'standalone',
      wrap: cursorMdcWrap,
    },
  },
  {
    id: 'vscode',
    label: 'VS Code (GitHub Copilot)',
    kind: 'ide',
    mcp: {
      scopes: [
        { scope: 'project', file: '.vscode/mcp.json', format: 'json', serverMapPath: ['servers'] },
        { scope: 'global', file: VSCODE_GLOBAL, format: 'json', serverMapPath: ['servers'] },
      ],
      transports: ['stdio', 'http'],
      entry: entryTyped,
      note: 'VS Code uses the "servers" key (not "mcpServers").',
    },
    rules: {
      scopes: [{ scope: 'project', file: '.github/copilot-instructions.md' }],
      style: 'append-section',
    },
  },
  {
    id: 'windsurf',
    label: 'Windsurf (Cascade)',
    kind: 'ide',
    mcp: {
      scopes: [
        { scope: 'global', file: '~/.codeium/windsurf/mcp_config.json', format: 'json', serverMapPath: ['mcpServers'] },
      ],
      transports: ['stdio', 'http'],
      entry: entryServerUrl,
      note: 'Windsurf keys the remote endpoint as "serverUrl". Config is global-only.',
    },
    rules: {
      scopes: [{ scope: 'project', file: '.windsurf/rules/devsmind.md' }],
      style: 'standalone',
    },
  },
  {
    id: 'kiro',
    label: 'Kiro',
    kind: 'ide',
    mcp: {
      scopes: [
        { scope: 'project', file: '.kiro/settings/mcp.json', format: 'json', serverMapPath: ['mcpServers'] },
        { scope: 'global', file: '~/.kiro/settings/mcp.json', format: 'json', serverMapPath: ['mcpServers'] },
      ],
      transports: ['stdio', 'http'],
      entry: entryUrl,
    },
    rules: {
      scopes: [{ scope: 'project', file: '.kiro/steering/devsmind.md' }],
      style: 'standalone',
    },
  },
  {
    id: 'antigravity',
    label: 'Google Antigravity (IDE)',
    kind: 'ide',
    mcp: {
      scopes: [
        { scope: 'global', file: '~/.gemini/config/mcp_config.json', format: 'json', serverMapPath: ['mcpServers'] },
        { scope: 'project', file: '.agents/mcp_config.json', format: 'json', serverMapPath: ['mcpServers'] },
      ],
      transports: ['stdio', 'http'],
      entry: entryServerUrl,
      note: 'Antigravity keys the remote endpoint as "serverUrl".',
    },
    rules: {
      scopes: [{ scope: 'project', file: 'AGENTS.md' }],
      style: 'append-section',
    },
  },

  // ── CLI tools ───────────────────────────────────────────────────────────────
  {
    id: 'claude-code',
    label: 'Claude Code (claude CLI / IDE extension)',
    kind: 'cli',
    mcp: {
      scopes: [
        { scope: 'project', file: '.mcp.json', format: 'json', serverMapPath: ['mcpServers'] },
      ],
      transports: ['stdio', 'http'],
      entry: entryTyped,
      cliInstaller: (t, ctx) =>
        t === 'stdio'
          ? 'claude mcp add --transport stdio devsmind -- devsmind start --stdio'
          : `claude mcp add --transport http devsmind ${httpUrl(ctx)}`,
    },
    rules: {
      scopes: [{ scope: 'project', file: 'CLAUDE.md' }],
      style: 'append-section',
    },
  },
  {
    id: 'antigravity-cli',
    label: 'Antigravity CLI',
    kind: 'cli',
    mcp: {
      scopes: [
        { scope: 'project', file: '.agents/mcp_config.json', format: 'json', serverMapPath: ['mcpServers'] },
        { scope: 'global', file: '~/.gemini/config/mcp_config.json', format: 'json', serverMapPath: ['mcpServers'] },
      ],
      transports: ['stdio', 'http'],
      entry: entryServerUrl,
      note: 'Shares config with the Antigravity IDE; keys the remote endpoint as "serverUrl".',
    },
    rules: {
      scopes: [{ scope: 'project', file: 'AGENTS.md' }],
      style: 'append-section',
    },
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    kind: 'cli',
    mcp: {
      scopes: [
        { scope: 'global', file: '~/.codex/config.toml', format: 'toml', serverMapPath: ['mcp_servers'] },
        { scope: 'project', file: '.codex/config.toml', format: 'toml', serverMapPath: ['mcp_servers'] },
      ],
      transports: ['stdio', 'http'],
      entry: entryUrl,
      cliInstaller: (t) =>
        t === 'stdio'
          ? 'codex mcp add devsmind -- devsmind start --stdio'
          : '# Codex: add the [mcp_servers.devsmind] url entry to ~/.codex/config.toml (no CLI flag for remote)',
      note: 'Codex config is TOML. Remote (url) servers must be added by editing config.toml.',
    },
    rules: {
      scopes: [{ scope: 'project', file: 'AGENTS.md' }],
      style: 'append-section',
    },
  },
  {
    id: 'qwen',
    label: 'Qwen Code CLI',
    kind: 'cli',
    mcp: {
      scopes: [
        { scope: 'project', file: '.qwen/settings.json', format: 'json', serverMapPath: ['mcpServers'] },
        { scope: 'global', file: '~/.qwen/settings.json', format: 'json', serverMapPath: ['mcpServers'] },
      ],
      transports: ['stdio', 'http'],
      entry: entryHttpUrl,
      cliInstaller: (t, ctx) =>
        t === 'stdio'
          ? 'qwen mcp add devsmind devsmind start --stdio'
          : `qwen mcp add --transport http devsmind ${httpUrl(ctx)}`,
      note: 'Qwen keys the Streamable-HTTP endpoint as "httpUrl".',
    },
    rules: {
      scopes: [{ scope: 'project', file: 'QWEN.md' }],
      style: 'append-section',
    },
  },
];

export function getTarget(id: string): IdeTarget | undefined {
  return TARGETS.find(t => t.id === id);
}
