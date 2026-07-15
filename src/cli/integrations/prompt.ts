import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import prompts from 'prompts';
import {
  IdeTarget,
  TARGETS,
  Transport,
  Scope,
  McpScope,
  RuleScope,
  MemoryScope,
  ConfigFormat,
} from './registry';

/** Thrown when the user cancels a prompt (Esc / Ctrl-C). Callers treat it as a clean abort. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

function assertAnswer<T>(value: T | undefined): T {
  if (value === undefined) throw new CancelledError();
  return value;
}

// ─── Basic prompt wrappers (abort on cancel) ─────────────────────────────────

export async function selectPrompt<T>(
  message: string,
  choices: Array<{ title: string; value: T; description?: string }>,
  initial = 0
): Promise<T> {
  const res = await prompts({ type: 'select', name: 'v', message, choices, initial });
  return assertAnswer(res.v as T | undefined);
}

export async function confirmPrompt(message: string, initial = true): Promise<boolean> {
  const res = await prompts({ type: 'confirm', name: 'v', message, initial });
  return assertAnswer(res.v as boolean | undefined);
}

// ─── Target / transport / scope / mode pickers ───────────────────────────────

export async function pickTarget(): Promise<IdeTarget> {
  const ides = TARGETS.filter(t => t.kind === 'ide');
  const clis = TARGETS.filter(t => t.kind === 'cli');
  const choices: Array<{ title: string; value: IdeTarget | null }> = [];

  if (ides.length) {
    choices.push({ title: '── IDEs ──', value: null });
    for (const t of ides) choices.push({ title: `  ${t.label}`, value: t });
  }
  if (clis.length) {
    choices.push({ title: '── CLI tools ──', value: null });
    for (const t of clis) choices.push({ title: `  ${t.label}`, value: t });
  }

  // Skip the non-selectable header rows if one is chosen.
  const picked = await selectPrompt('What are you working in?', choices, 1);
  if (!picked) {
    // Header row selected — re-ask.
    return pickTarget();
  }
  return picked;
}

export async function pickTransport(target: IdeTarget): Promise<Transport> {
  const transports = target.mcp.transports;
  if (transports.length === 1) return transports[0];

  const describe: Record<Transport, string> = {
    stdio: 'stdio — the tool launches DevsMind itself. Run `devsmind sync` after pulling graph changes.',
    http: 'HTTP — connect to a server you start with `devsmind start`.',
  };
  return selectPrompt(
    'Which connection type?',
    transports.map(t => ({ title: t.toUpperCase(), value: t, description: describe[t] })),
    0
  );
}

export async function pickMcpScope(target: IdeTarget): Promise<McpScope> {
  const scopes = target.mcp.scopes;
  if (scopes.length === 1) return scopes[0];
  return pickScopeGeneric(scopes, s => s.scope);
}

export async function pickRuleScope(target: IdeTarget): Promise<RuleScope> {
  const scopes = target.rules.scopes;
  if (scopes.length === 1) return scopes[0];
  return pickScopeGeneric(scopes, s => s.scope);
}

/** Assumes `target.memory.supported` and `scopes` are already checked by the caller. */
export async function pickMemoryScope(target: IdeTarget): Promise<MemoryScope> {
  const scopes = target.memory.scopes ?? [];
  if (scopes.length === 1) return scopes[0];
  return pickScopeGeneric(scopes, s => s.scope);
}

async function pickScopeGeneric<T>(scopes: T[], scopeOf: (s: T) => Scope): Promise<T> {
  const label: Record<Scope, string> = {
    project: 'This project only',
    global: 'Global (all your projects)',
  };
  return selectPrompt(
    'Which scope?',
    scopes.map(s => ({ title: label[scopeOf(s)], value: s })),
    0
  );
}

export type Mode = 'auto' | 'manual';

export async function pickMode(): Promise<Mode> {
  return selectPrompt<Mode>('How do you want to do this?', [
    { title: '🤖 Let the terminal set it up for me', value: 'auto', description: 'Creates/merges the config file for you (with a preview + confirmation).' },
    { title: '📋 Just show me what to add (manual)', value: 'manual', description: 'Prints the exact file path and snippet to copy-paste.' },
  ]);
}

// ─── Directory navigator ("cd around, use this folder") ──────────────────────

/**
 * Interactive directory browser. Lets the user cd up/down from `startDir`,
 * type/paste a path (handy for other drives or far-away folders), and confirm a
 * folder. Returns the chosen absolute directory. Only existing directories can
 * be confirmed. Throws {@link CancelledError} if the user aborts.
 */
export async function pickDirectory(
  startDir: string,
  purpose: string,
  opts: { allowTyped?: boolean; showHidden?: boolean } = {}
): Promise<string> {
  const allowTyped = opts.allowTyped !== false;
  let currentDir = path.resolve(startDir);
  if (!existsDir(currentDir)) currentDir = process.cwd();

  // Defensive cap: a human never navigates thousands of steps; this only trips
  // if the prompt stream is misbehaving (e.g. non-interactive), and prevents a hang.
  let guard = 0;
  while (guard++ < 5000) {
    console.log(`\n📂 ${purpose}`);
    console.log(`   Current: ${currentDir.replace(/\\/g, '/')}`);

    const choices: Array<{ title: string; value: { action: string; dir?: string } }> = [];
    choices.push({ title: `✅ Use this folder`, value: { action: 'use' } });

    const parent = path.dirname(currentDir);
    if (parent !== currentDir) {
      choices.push({ title: '⬆  Go up (..)', value: { action: 'up' } });
    }
    if (allowTyped) {
      choices.push({ title: '⌨️  Type / paste a path…', value: { action: 'type' } });
    }

    let subdirs: string[] = [];
    try {
      subdirs = fs.readdirSync(currentDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && (opts.showHidden || !d.name.startsWith('.') || d.name === '.devmind'))
        .map(d => d.name)
        .sort();
    } catch {
      subdirs = [];
    }
    for (const name of subdirs) {
      choices.push({ title: `📁 ${name}/`, value: { action: 'into', dir: name } });
    }

    const res = await selectPrompt('Navigate or select:', choices, 0);
    if (res.action === 'use') return currentDir;
    if (res.action === 'up') currentDir = parent;
    if (res.action === 'into' && res.dir) currentDir = path.join(currentDir, res.dir);
    if (res.action === 'type') {
      const typed = await prompts({ type: 'text', name: 'v', message: 'Enter a folder path:', initial: currentDir });
      const v = typed.v as string | undefined;
      if (typeof v === 'string' && v.trim()) {
        const resolved = path.resolve(v.trim().replace(/^~(?=[\\/]|$)/, os.homedir()));
        if (existsDir(resolved)) {
          currentDir = resolved;
        } else {
          console.log(`   ⚠️  Not an existing folder: ${resolved.replace(/\\/g, '/')}`);
        }
      }
    }
  }
  throw new CancelledError();
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ─── Config merging ──────────────────────────────────────────────────────────

export interface MergeResult {
  /** Full new file content to write. */
  content: string;
  /** True if the file already existed (we merged) vs. created fresh. */
  existed: boolean;
  /** Human-readable preview of what will be written (for confirmation). */
  preview: string;
}

/**
 * Merge a single named server entry into an MCP config file, without clobbering
 * any existing servers. Supports JSON (nested serverMapPath) and TOML (Codex).
 */
export function mergeMcpConfig(
  filePath: string,
  format: ConfigFormat,
  serverMapPath: string[],
  serverName: string,
  entry: Record<string, unknown>
): MergeResult {
  const existed = fs.existsSync(filePath);

  if (format === 'toml') {
    return mergeTomlServer(filePath, serverMapPath, serverName, entry, existed);
  }

  // JSON (and JSONC-tolerant tools — we emit clean JSON).
  let root: Record<string, unknown> = {};
  if (existed) {
    try {
      const txt = fs.readFileSync(filePath, 'utf-8').trim();
      root = txt ? (JSON.parse(txt) as Record<string, unknown>) : {};
    } catch {
      throw new Error(
        `${filePath} exists but is not valid JSON. Fix or remove it, then re-run (or use manual mode).`
      );
    }
  }

  // Walk/create the nested server-map container.
  let container = root;
  for (const key of serverMapPath) {
    if (typeof container[key] !== 'object' || container[key] === null || Array.isArray(container[key])) {
      container[key] = {};
    }
    container = container[key] as Record<string, unknown>;
  }
  container[serverName] = entry;

  const content = JSON.stringify(root, null, 2) + '\n';
  return { content, existed, preview: content };
}

// ─── Minimal TOML section writer (for Codex ~/.codex/config.toml) ─────────────

function tomlValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v); // TOML basic strings match JSON string escaping
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(tomlValue).join(', ') + ']';
  // Nested tables are not expected in our entries; fall back to JSON-ish inline.
  return JSON.stringify(v);
}

/**
 * Render a `[header]` table for the given entry. Only flat key/value pairs and
 * arrays of primitives are expected (command/args/url/headers-as-inline).
 */
function renderTomlTable(header: string, entry: Record<string, unknown>): string {
  const lines = [`[${header}]`];
  for (const [k, v] of Object.entries(entry)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // Inline table for objects like env/headers.
      const inner = Object.entries(v as Record<string, unknown>)
        .map(([ik, iv]) => `${ik} = ${tomlValue(iv)}`)
        .join(', ');
      lines.push(`${k} = { ${inner} }`);
    } else {
      lines.push(`${k} = ${tomlValue(v)}`);
    }
  }
  return lines.join('\n') + '\n';
}

function mergeTomlServer(
  filePath: string,
  serverMapPath: string[],
  serverName: string,
  entry: Record<string, unknown>,
  existed: boolean
): MergeResult {
  // Header e.g. "mcp_servers.devsmind"
  const header = [...serverMapPath, serverName].join('.');
  const table = renderTomlTable(header, entry);

  let existing = '';
  if (existed) {
    try {
      existing = fs.readFileSync(filePath, 'utf-8');
    } catch {
      existing = '';
    }
  }

  let content: string;
  const headerLine = `[${header}]`;
  if (existing.includes(headerLine)) {
    // Replace the existing table (from its header to the next table header or EOF).
    const lines = existing.split(/\r?\n/);
    const start = lines.findIndex(l => l.trim() === headerLine);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) { end = i; break; }
    }
    const before = lines.slice(0, start).join('\n').replace(/\s*$/, '');
    const after = lines.slice(end).join('\n').replace(/^\s*/, '');
    content = [before, table.trimEnd(), after].filter(s => s.length).join('\n\n') + '\n';
  } else {
    const base = existing.trimEnd();
    content = (base ? base + '\n\n' : '') + table;
  }

  return { content, existed, preview: table };
}

/** Write merged content, creating parent dirs as needed. */
export function writeConfigFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

// ─── Rule file merging ───────────────────────────────────────────────────────

export const RULE_START = '<!-- devsmind:rule:start -->';
export const RULE_END = '<!-- devsmind:rule:end -->';

/**
 * Produce the new contents of a rules file.
 * - `standalone`: the file is dedicated to DevsMind — write the (optionally
 *   wrapped) rule body outright.
 * - `append-section`: merge a delimited DevsMind block into a shared file,
 *   replacing any prior block so re-runs update in place instead of duplicating.
 */
export function mergeRuleFile(
  filePath: string,
  ruleBody: string,
  style: 'standalone' | 'append-section',
  wrap?: (body: string) => string
): MergeResult {
  const existed = fs.existsSync(filePath);

  if (style === 'standalone') {
    const body = wrap ? wrap(ruleBody) : ruleBody;
    const content = body.replace(/\n*$/, '\n');
    return { content, existed, preview: content };
  }

  const block = `${RULE_START}\n${ruleBody}\n${RULE_END}`;
  const existing = existed ? safeRead(filePath) : '';
  const startIdx = existing.indexOf(RULE_START);
  const endIdx = existing.indexOf(RULE_END);

  let content: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    content = existing.slice(0, startIdx) + block + existing.slice(endIdx + RULE_END.length);
  } else {
    const base = existing.replace(/\n*$/, '');
    content = (base ? base + '\n\n' : '') + block;
  }
  if (!content.endsWith('\n')) content += '\n';
  return { content, existed, preview: block };
}

function safeRead(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}
