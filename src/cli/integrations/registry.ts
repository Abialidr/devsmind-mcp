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

/**
 * Where to seed a tool's own persistent agent-memory/skills store — distinct
 * from `rules`, which is a static file a human maintains. Only populated for
 * tools where research confirmed the tool actually reads back a file it didn't
 * create itself (see `memory.supported` below); everything else gets manual
 * guidance instead of a write that might silently do nothing or get clobbered.
 */
export interface MemoryScope {
  scope: Scope;
  /** Directory to seed. For tools whose exact path includes an undocumented
   *  per-project hash (Claude Code), this is the nearest KNOWN parent — the
   *  user confirms the rest via the folder navigator. */
  dir: OsPath;
  /** Filename DevsMind owns within that directory — never the tool's own index/log file.
   *  Unused (and omitted) for `memory-files`, where the filenames come from the topics. */
  file?: string;
  /** `markdown`/`skill-md` = one file holding the whole contract. `memory-files` = one file
   *  per topic, for a store that loads files ON DEMAND ranked by their own `description`
   *  frontmatter — there a single blob either loads whole or not at all. */
  format: 'markdown' | 'skill-md' | 'memory-files';
  /** True when `dir` is only a starting point and the user must navigate to the real folder. */
  needsUserConfirmedDir?: boolean;
}

export interface IdeTarget {
  id: string;
  label: string;
  kind: 'ide' | 'cli';
  mcp: {
    scopes: McpScope[];
    /** Supported transports; first is the preferred default. */
    transports: Transport[];
    /** The value object placed under serverMap['devsmind'] for a given transport and scope. */
    entry: (t: Transport, ctx: EntryContext, scope: Scope) => Record<string, unknown>;
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
  memory: {
    /** `devsmind memory` writes nothing for any tool (see integrations/memory.ts) — this and the
     *  fields below are read only for their FRAMING value (the tool's own feature name + a short
     *  caveat), not to decide whether or how to write. `scopes`/`wrap`/`pointerFile` describe a
     *  write path that no longer exists; kept only as still-accurate research about each tool's
     *  own store, in case a genuinely safe write target ever becomes available again. */
    supported: boolean;
    /** The tool's own name for this feature — use it verbatim in prompts, not a generic "memory". */
    featureName: string;
    scopes?: MemoryScope[];
    wrap?: (body: string) => string;
    /** The one-line caveat shown alongside the printed prompt. */
    note: string;
    /** Unused by `devsmind memory` (see above) — retained only alongside `scopes` as research. */
    pointerFile?: { file: string; style: 'append-section' };
  };
}

/** Context available when rendering a server entry. */
export interface EntryContext {
  devmindDir: string;   // absolute .devmind path
  port: number;         // DEVSMIND_PORT
}

// ─── Shared entry payloads ───────────────────────────────────────────────────

/**
 * Standard stdio entry: the IDE spawns `devsmind start --stdio [--path <devmindDir>]`.
 *
 * `--path` is included for `project` scope only. A project-scoped config file lives inside — and
 * so only ever serves — the one project it was written for, so baking in the absolute brain path
 * (which the registration flow already knows via `ctx.devmindDir`) makes binding deterministic
 * regardless of what cwd the IDE happens to spawn from.
 *
 * A `global` config is different: ONE file, read by every project on the machine. Baking a single
 * project's path into it would silently point every other project at that same brain — the exact
 * bug this scope split exists to avoid. So a global entry omits `--path` entirely and leans on the
 * server's own auto-detect (`bindServerToProject` walks up from its cwd looking for `.devmind`),
 * which works because the IDE spawns the stdio server from whichever workspace is actually open.
 * If an IDE spawns from somewhere else instead (not the common case), the server starts unbound and
 * falls back to per-call `devmind_path` — degraded, but never silently wrong.
 *
 * Path may contain spaces; it's a separate argv element, so no quoting needed.
 */
export function stdioEntry(ctx: EntryContext, scope: Scope): Record<string, unknown> {
  const args = ['start', '--stdio'];
  if (scope === 'project') args.push('--path', ctx.devmindDir);
  return { command: 'devsmind', args };
}

/** Standard HTTP entry: connect to the already-running server. Scope-independent — the URL never
 *  names a project, since the server itself is single-project no matter which config points at it. */
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
const entryUrl = (t: Transport, ctx: EntryContext, scope: Scope) =>
  t === 'stdio' ? stdioEntry(ctx, scope) : { url: httpUrl(ctx) };

/** VS Code / Claude Code: explicit `type` + url. */
const entryTyped = (t: Transport, ctx: EntryContext, scope: Scope) =>
  t === 'stdio'
    ? { type: 'stdio', ...stdioEntry(ctx, scope) }
    : { type: 'http', url: httpUrl(ctx) };

/** Windsurf / Antigravity: HTTP endpoint keyed as `serverUrl`. */
const entryServerUrl = (t: Transport, ctx: EntryContext, scope: Scope) =>
  t === 'stdio' ? stdioEntry(ctx, scope) : { serverUrl: httpUrl(ctx) };

/** Qwen Code: Streamable-HTTP endpoint keyed as `httpUrl`. */
const entryHttpUrl = (t: Transport, ctx: EntryContext, scope: Scope) =>
  t === 'stdio' ? stdioEntry(ctx, scope) : { httpUrl: httpUrl(ctx) };

const cursorMdcWrap = (body: string): string =>
  `---\ndescription: DevsMind — Team AI Brain workspace rule\nalwaysApply: true\n---\n\n${body}\n`;

/**
 * Skill format: YAML frontmatter (name + description) + markdown body.
 *
 * Shared by every target that reads `.agents/skills/` — Antigravity (IDE + CLI) and Codex all
 * discover the SAME `.agents/skills/devsmind/SKILL.md`. One wrap, deliberately: these writes are
 * whole-file (`standalone`), so per-tool frontmatter would mean whichever command ran last
 * silently rewrote the others' file. Identical bytes make that collision a no-op instead.
 */
const skillMdWrap = (body: string): string =>
  `---\nname: devsmind\ndescription: DevsMind team code-graph MCP server — when and how to use it\n---\n\n${body}\n`;

/** The one skill location all `.agents/skills/` readers share. See {@link skillMdWrap}. */
const AGENTS_SKILL_SCOPE: MemoryScope = {
  scope: 'project',
  dir: '.agents/skills/devsmind',
  file: 'SKILL.md',
  format: 'skill-md',
};

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
    memory: {
      supported: false,
      featureName: 'Memories',
      note: 'Cursor\'s Memories are stored in an internal, undocumented database and only save after the agent proposes one and you approve it — there is no file DevsMind can safely write to. Ask the agent to remember the DevsMind workflow in conversation (e.g. "remember to always search_nodes before grep, and edit_node + commit_changes after every change") and approve the memory Cursor proposes.',
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
    memory: {
      supported: false,
      featureName: 'Copilot Memory',
      note: 'Copilot Memory has no documented write API and its file format has changed shape multiple times through 2026 — writing into it directly risks corrupting it. It should pick up the DevsMind workflow itself after a few real sessions using the tools; check what it has learned with the "Chat: Show Memory Files" command.',
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
    memory: {
      supported: false,
      featureName: 'Cascade Memories',
      note: 'Cascade Memories are stored at ~/.codeium/windsurf/memories/, keyed per-workspace by a mechanism Windsurf doesn\'t document — there\'s no confirmed evidence a manually-placed file there is ever discovered. Ask Cascade directly to "create a memory of the DevsMind workflow" and it will generate one through its own supported path.',
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
    memory: {
      supported: false,
      featureName: 'Knowledge / PR-comment learning',
      note: 'Kiro has no file-based memory: its manual "Knowledge" store uses JSON + embeddings (not something safe to hand-write), and its autonomous agent\'s PR-comment-driven learning is an undocumented, AWS-internal, non-file-based store. The one thing DevsMind CAN influence — steering docs — is already handled by `devsmind rule`. To also engage the autonomous agent\'s learning, leave a PR review comment once, e.g. "always call search_nodes before grep, and edit_node + commit_changes after every change."',
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
    memory: {
      supported: true,
      featureName: 'Skills (/learn)',
      scopes: [AGENTS_SKILL_SCOPE],
      wrap: skillMdWrap,
      note: 'Antigravity discovers skills by scanning .agents/skills/ for any SKILL.md — same mechanism whether it was created via /learn or placed here directly. Codex reads this same file.',
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
        // User-scope entries live at the TOP LEVEL of ~/.claude.json under `mcpServers` — not
        // nested under that file's `projects` map (that's "local" scope, which this registry
        // doesn't model). Same JSON shape as project scope, so the generic merge/write path
        // handles it unchanged; confirmed against Claude Code's own MCP quickstart docs.
        { scope: 'global', file: '~/.claude.json', format: 'json', serverMapPath: ['mcpServers'] },
      ],
      transports: ['stdio', 'http'],
      entry: entryTyped,
      cliInstaller: (t, ctx) =>
        t === 'stdio'
          ? `claude mcp add --transport stdio devsmind -- devsmind start --stdio --path "${ctx.devmindDir}"`
          : `claude mcp add --transport http devsmind ${httpUrl(ctx)}`,
    },
    rules: {
      scopes: [{ scope: 'project', file: 'CLAUDE.md' }],
      style: 'append-section',
    },
    memory: {
      supported: true,
      featureName: 'Auto Memory',
      scopes: [
        { scope: 'global', dir: '~/.claude/projects', format: 'memory-files', needsUserConfirmedDir: true },
      ],
      note: 'Auto Memory saves reliably from an EXPLICIT in-chat request ("remember this") — that\'s exactly what the prompt below is. A silently-written file never triggers that path at all, which is why `devsmind memory` no longer writes one.',
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
    memory: {
      supported: true,
      featureName: 'Skills (/learn)',
      scopes: [AGENTS_SKILL_SCOPE],
      wrap: skillMdWrap,
      note: 'Same Skills mechanism as the Antigravity IDE — the CLI\'s /skills command browses this same .agents/skills/ directory.',
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
      cliInstaller: (t, ctx) =>
        t === 'stdio'
          ? `codex mcp add devsmind -- devsmind start --stdio --path "${ctx.devmindDir}"`
          : '# Codex: add the [mcp_servers.devsmind] url entry to ~/.codex/config.toml (no CLI flag for remote)',
      note: 'Codex config is TOML. Remote (url) servers must be added by editing config.toml.',
    },
    rules: {
      scopes: [{ scope: 'project', file: 'AGENTS.md' }],
      style: 'append-section',
    },
    memory: {
      supported: true,
      featureName: 'Skills',
      scopes: [AGENTS_SKILL_SCOPE],
      wrap: skillMdWrap,
      // Codex has two stores and only one of them is ours to write. `~/.codex/memories/` is
      // generated state its own docs warn against hand-editing ("don't rely on editing them by
      // hand") and a background job regenerates — untouched, here and everywhere else. Skills are
      // the human-authored surface, and Codex scans the same `.agents/skills/` directory
      // Antigravity does, so this is one file serving both tools rather than a new integration.
      note: 'Codex discovers skills by scanning .agents/skills/ for any SKILL.md — the same file Antigravity reads, so seeding once covers both. Codex\'s own ~/.codex/memories/ is generated state and is never touched. Pair this with `devsmind rule` (AGENTS.md): a skill loads only when the task matches its description, while AGENTS.md is read every turn.',
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
          ? `qwen mcp add devsmind devsmind start --stdio --path "${ctx.devmindDir}"`
          : `qwen mcp add --transport http devsmind ${httpUrl(ctx)}`,
      note: 'Qwen keys the Streamable-HTTP endpoint as "httpUrl".',
    },
    rules: {
      scopes: [{ scope: 'project', file: 'QWEN.md' }],
      style: 'append-section',
    },
    memory: {
      supported: false,
      featureName: 'Memory (background) / QWEN.md',
      note: 'QWEN.md itself is confirmed safe to write to, but that\'s already the exact file `devsmind rule` places its block in for Qwen — no separate action needed. The newer, separate ~/.qwen/projects/<project>/memory/ background auto-memory directory has the same undocumented, auto-generated pattern as Codex\'s Memories, with no source confirming a manually-placed file survives — nothing is written there.',
    },
  },
];

export function getTarget(id: string): IdeTarget | undefined {
  return TARGETS.find(t => t.id === id);
}
