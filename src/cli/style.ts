import { resolveDevmindDir } from '../utils/config';
import {
  RESPONSE_STYLES,
  RESPONSE_STYLE_ENV_KEY,
  ResponseStyle,
  parseResponseStyle,
  resolveResponseStyle,
  writeResponseStyle,
} from '../utils/response-style';

const DESCRIPTIONS: Record<ResponseStyle, string> = {
  normal: 'agent replies as usual (default)',
  lite: 'no filler or hedging, ordinary sentences',
  full: 'caveman: fragments, no articles, answer first — biggest saving',
};

/**
 * `devsmind style [level]` — show or set how tersely the agent writes its chat replies.
 *
 * Personal and local: stored in this brain's gitignored `.env`, never in the shared `config.json`,
 * so it changes only YOUR agent. Takes effect on the next MCP connection — the instruction rides on
 * the handshake text DevsMind already sends, so there is no rule file to rewrite.
 */
export async function handleStyle(level: string | undefined, opts: { path?: string }): Promise<void> {
  const devmindDir = resolveDevmindDir(opts.path);
  if (!devmindDir) {
    console.error(
      `❌ No .devsmind directory found.\n` +
      `   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.`
    );
    process.exit(1);
  }

  const current = resolveResponseStyle(devmindDir);

  if (level === undefined) {
    console.log(`\nResponse style: ${current} — ${DESCRIPTIONS[current]}\n`);
    for (const s of RESPONSE_STYLES) {
      console.log(`   ${s === current ? '●' : '○'} ${s.padEnd(7)} ${DESCRIPTIONS[s]}`);
    }
    console.log(`\nChange it:  devsmind style <normal|lite|full>   (also: on, off, caveman)\n`);
    return;
  }

  const next = parseResponseStyle(level);
  if (!next) {
    console.error(`❌ Unknown style "${level}". Choose one of: ${RESPONSE_STYLES.join(', ')} (also: on, off, caveman).`);
    process.exit(1);
  }

  writeResponseStyle(devmindDir, next);

  // The process environment outranks the brain's .env — say so rather than let the setting look
  // like it did nothing.
  const overridden = parseResponseStyle(process.env[RESPONSE_STYLE_ENV_KEY]);
  console.log(`\n✅ Response style: ${next} — ${DESCRIPTIONS[next]}`);
  if (overridden && overridden !== next) {
    console.log(`⚠️  ${RESPONSE_STYLE_ENV_KEY}=${process.env[RESPONSE_STYLE_ENV_KEY]} is set in your environment and overrides this.`);
  }
  console.log(`   Applies to new MCP connections — restart a \`devsmind start --stdio\` server or open a new chat.`);
  console.log(`   Saved in ${devmindDir.replace(/\\/g, '/')}/.env (personal, gitignored — teammates are unaffected).\n`);
}
