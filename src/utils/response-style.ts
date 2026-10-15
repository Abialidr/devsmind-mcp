import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

/**
 * How tersely the agent writes its CHAT replies — a personal token-saving switch.
 *
 *  - `normal`: no extra instruction; the agent writes as it always did. The default.
 *  - `lite`:   no filler, pleasantries, hedging or restating the question; ordinary sentences.
 *  - `full`:   "caveman" — fragments, no articles, short words, answer first. Biggest saving.
 *
 * It rides on the instructions DevsMind already sends every MCP client at connect, so it needs no
 * rule/skill file and follows the developer rather than the repo. It is stored in the brain's
 * `.env` (per-developer and gitignored), NOT `config.json`, which is committed and shared: one
 * teammate's wish to read less must never change how everyone else's agent talks.
 */
export type ResponseStyle = 'normal' | 'lite' | 'full';

export const RESPONSE_STYLES: readonly ResponseStyle[] = ['normal', 'lite', 'full'];
export const RESPONSE_STYLE_ENV_KEY = 'DEVSMIND_RESPONSE_STYLE';

const ALIASES: Record<string, ResponseStyle> = {
  normal: 'normal', off: 'normal', default: 'normal', none: 'normal', '0': 'normal', false: 'normal',
  lite: 'lite', light: 'lite', short: 'lite',
  full: 'full', on: 'full', terse: 'full', caveman: 'full', ultra: 'full', '1': 'full', true: 'full',
};

/** Maps a user-typed value (`on`, `off`, `caveman`, ...) to a style, or null if it means nothing. */
export function parseResponseStyle(value: unknown): ResponseStyle | null {
  if (typeof value !== 'string') return null;
  return ALIASES[value.trim().toLowerCase()] ?? null;
}

const BLOCK_HEADER = '## Response style';

/**
 * The instruction appended to the handshake text. Empty for `normal`, so the default text — which
 * tests hold identical across every surface — is never touched.
 *
 * The carve-outs are the point, not decoration. Shortening chat is a pure win; shortening what gets
 * WRITTEN INTO the shared graph is a loss every teammate and every future agent pays: a node
 * description is what `search_nodes` matches on, and a commit's reasoning is what a later reader
 * uses to understand why. So the block confines itself to the reply the developer reads.
 */
export function buildResponseStyleBlock(style: ResponseStyle): string {
  if (style === 'normal') return '';

  const how = style === 'lite'
    ? 'Cut filler: no greetings, no restating the question, no closing recap of what you did, no hedging. Keep ordinary full sentences, just fewer of them.'
    : 'Talk like caveman: short fragments, answer first. Drop articles, filler, pleasantries, hedging, recaps. Short words ("use" not "utilize"). One line beats a paragraph. E.g. "Fixed. Null case handled."';

  // Kept deliberately short (under 900 characters): some clients truncate long server instructions,
  // and this has to survive that. See withResponseStyle for why it also goes FIRST. The bold line is
  // there because the setting was ignored once on a long first reply that asked for a "brief":
  // the model read "brief" as a request for content, not as a cue about its own style.
  return [
    `${BLOCK_HEADER}: terse (${style})`,
    '',
    '**MANDATORY on EVERY reply, starting with the first, even when the user asks for a "brief", "report" or "summary". Check it before you send.**',
    '',
    `The developer wants short chat replies to save tokens (replies to them only). ${how}`,
    '',
    'Never shorten: code, commands, file paths, identifiers, error messages, quotes; anything you write INTO DevsMind (node `description`, `commit_changes` `message`/`reasoning`/`feedback`, workflow steps, `edit_node` content) — teammates read those, so keep full clear sentences; warnings about destructive or irreversible actions or security. If asked to explain or "go into detail", expand for that reply.',
  ].join('\n');
}

/**
 * One bold line appended to every tool result while a style is on. The handshake note is read once,
 * far up a long context; this lands immediately before the agent writes its reply, which is where an
 * instruction has the best chance of actually being followed. Empty for `normal`, so the default
 * adds nothing to any result.
 */
export function buildResponseStyleReminder(style: ResponseStyle): string {
  if (style === 'normal') return '';
  return style === 'lite'
    ? '**TERSE REPLY (lite): no filler, no recap. Applies to your next reply to the user.**'
    : '**TERSE REPLY (full): caveman fragments, answer first, no filler. Applies to your next reply to the user.**';
}

/**
 * `base` with the style block placed FIRST; `base` untouched for `normal`.
 *
 * First, not last, on purpose. The handshake text is ~11,000 characters and MCP clients are free to
 * truncate server instructions — at least one agent reported receiving its copy "cut off partway
 * through". Appended at the end, the style note was exactly the part that got cut, so the setting
 * silently did nothing. At the front it survives any cap that still lets the start through.
 */
export function withResponseStyle(base: string, style: ResponseStyle): string {
  const block = buildResponseStyleBlock(style);
  return block ? `${block}\n\n${base}` : base;
}

function readEnvFile(devmindDir: string): Record<string, string> {
  try {
    return dotenv.parse(fs.readFileSync(path.join(devmindDir, '.env'), 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * The style in effect for this brain: the process environment wins (a one-off override), then the
 * brain's `.env`, then `normal`. An unrecognised value is ignored, never an error — a typo in a
 * dotfile must not stop the MCP server from starting.
 */
export function resolveResponseStyle(devmindDir: string | null, processEnv: NodeJS.ProcessEnv = process.env): ResponseStyle {
  const fromProcess = parseResponseStyle(processEnv[RESPONSE_STYLE_ENV_KEY]);
  if (fromProcess) return fromProcess;
  if (devmindDir) {
    const fromFile = parseResponseStyle(readEnvFile(devmindDir)[RESPONSE_STYLE_ENV_KEY]);
    if (fromFile) return fromFile;
  }
  return 'normal';
}

/**
 * Persists the style in the brain's `.env`, replacing only its own line and leaving every other key
 * (repo paths, developer name) exactly as it was. `normal` removes the line instead of writing
 * `normal`, so turning it off leaves the file as if it had never been on.
 */
export function writeResponseStyle(devmindDir: string, style: ResponseStyle): void {
  const envPath = path.join(devmindDir, '.env');
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  } catch {
    // no .env yet
  }
  const isOurs = (l: string): boolean => new RegExp(`^\\s*${RESPONSE_STYLE_ENV_KEY}\\s*=`).test(l);
  const kept = lines.filter(l => !isOurs(l));
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  if (style !== 'normal') kept.push(`${RESPONSE_STYLE_ENV_KEY}=${style}`);
  if (kept.length === 0 && !fs.existsSync(envPath)) return;
  fs.writeFileSync(envPath, kept.length ? kept.join('\n') + '\n' : '', 'utf-8');
}
