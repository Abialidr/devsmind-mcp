import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseResponseStyle,
  buildResponseStyleBlock,
  buildResponseStyleReminder,
  withResponseStyle,
  resolveResponseStyle,
  writeResponseStyle,
  RESPONSE_STYLE_ENV_KEY,
} from '../../src/utils/response-style';

describe('response-style', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-style-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const envFile = () => path.join(dir, '.env');
  const readEnv = () => fs.readFileSync(envFile(), 'utf-8');

  describe('parseResponseStyle', () => {
    it.each([
      ['normal', 'normal'], ['off', 'normal'], ['Default', 'normal'], ['0', 'normal'], ['false', 'normal'],
      ['lite', 'lite'], ['light', 'lite'], ['SHORT', 'lite'],
      ['full', 'full'], ['on', 'full'], ['caveman', 'full'], ['terse', 'full'], ['1', 'full'], [' ultra ', 'full'],
    ])('reads %s as %s', (input, expected) => {
      expect(parseResponseStyle(input)).toBe(expected);
    });

    it.each(['', 'loud', 'fulll', undefined, null, 5, {}])('reads %p as nothing, never an error', v => {
      expect(parseResponseStyle(v)).toBeNull();
    });
  });

  describe('the instruction block', () => {
    it('is empty for normal, so the default text is never touched', () => {
      expect(buildResponseStyleBlock('normal')).toBe('');
      expect(withResponseStyle('BASE', 'normal')).toBe('BASE');
    });

    it.each(['lite', 'full'] as const)('%s goes FIRST — so a client that truncates long instructions cannot cut it off — and leaves the base intact', style => {
      const out = withResponseStyle('BASE TEXT', style);
      expect(out.startsWith('## Response style')).toBe(true);
      expect(out.endsWith('\n\nBASE TEXT')).toBe(true);
      expect(out).toContain(`(${style})`);
    });

    it.each(['lite', 'full'] as const)('%s survives a client that keeps only the first 2000 characters of a long handshake', style => {
      const out = withResponseStyle('x'.repeat(11000), style);
      const kept = out.slice(0, 2000);
      expect(kept).toContain('INTO DevsMind');
      expect(kept).toContain(`(${style})`);
      expect(kept).toMatch(/go into detail/);
    });

    it.each(['lite', 'full'] as const)('%s keeps shared-graph writes and exact text out of its reach', style => {
      const block = buildResponseStyleBlock(style);
      // What must never be shortened: what teammates and future agents read, and exact artifacts.
      expect(block).toContain('INTO DevsMind');
      for (const field of ['description', 'message', 'reasoning', 'feedback', 'commit_changes']) {
        expect(block).toContain(field);
      }
      expect(block).toMatch(/code, commands, file paths, identifiers, error messages/i);
      expect(block).toMatch(/destructive or irreversible/);
      expect(block).toMatch(/go into detail/);
    });

    it('full is the stronger one: it asks for fragments and dropped articles, lite does not', () => {
      expect(buildResponseStyleBlock('full')).toMatch(/caveman/i);
      expect(buildResponseStyleBlock('full')).toMatch(/Drop articles/);
      expect(buildResponseStyleBlock('lite')).not.toMatch(/caveman/i);
      expect(buildResponseStyleBlock('lite')).toMatch(/ordinary full sentences/);
    });

    it.each(['lite', 'full'] as const)('%s opens with a bold MANDATORY line that names the "brief"/"report" trap the setting was once lost to', style => {
      const block = buildResponseStyleBlock(style);
      expect(block).toMatch(/\*\*MANDATORY on EVERY reply, starting with the first/);
      expect(block).toMatch(/even when the user asks for a "brief", "report" or "summary"/);
    });

    it('stays small — it must survive a truncating client, and a token-saving setting must not cost many tokens', () => {
      expect(buildResponseStyleBlock('full').length).toBeLessThan(900);
      expect(buildResponseStyleBlock('lite').length).toBeLessThan(900);
    });
  });

  describe('buildResponseStyleReminder', () => {
    it('is empty for normal, so the default adds nothing to any tool result', () => {
      expect(buildResponseStyleReminder('normal')).toBe('');
    });

    it.each(['lite', 'full'] as const)('%s is one short bold line that names the style and says it applies to the next reply', style => {
      const line = buildResponseStyleReminder(style);
      expect(line.startsWith('**TERSE REPLY (' + style + ')')).toBe(true);
      expect(line.endsWith('**')).toBe(true);
      expect(line).toContain('next reply');
      expect(line).not.toContain('\n');
      // It is repeated on every tool call, so it has to stay cheap.
      expect(line.length).toBeLessThan(130);
    });
  });

  describe('resolveResponseStyle', () => {
    it('is normal with no .env and no override', () => {
      expect(resolveResponseStyle(dir, {})).toBe('normal');
      expect(resolveResponseStyle(null, {})).toBe('normal');
    });

    it('reads the brain .env', () => {
      fs.writeFileSync(envFile(), `OTHER=1\n${RESPONSE_STYLE_ENV_KEY}=lite\n`);
      expect(resolveResponseStyle(dir, {})).toBe('lite');
    });

    it('lets the process environment override the brain .env', () => {
      fs.writeFileSync(envFile(), `${RESPONSE_STYLE_ENV_KEY}=lite\n`);
      expect(resolveResponseStyle(dir, { [RESPONSE_STYLE_ENV_KEY]: 'full' })).toBe('full');
      expect(resolveResponseStyle(dir, { [RESPONSE_STYLE_ENV_KEY]: 'off' })).toBe('normal');
    });

    it('ignores a nonsense value instead of failing — a dotfile typo must not stop the server', () => {
      fs.writeFileSync(envFile(), `${RESPONSE_STYLE_ENV_KEY}=shouty\n`);
      expect(resolveResponseStyle(dir, {})).toBe('normal');
      fs.writeFileSync(envFile(), `${RESPONSE_STYLE_ENV_KEY}=lite\n`);
      expect(resolveResponseStyle(dir, { [RESPONSE_STYLE_ENV_KEY]: 'shouty' })).toBe('lite');
    });
  });

  describe('writeResponseStyle', () => {
    it('adds its own line to a .env that already holds other keys, leaving them exactly as they were', () => {
      fs.writeFileSync(envFile(), 'DEVELOPER_NAME=Ada\nREPO_APP=/work/app\n');
      writeResponseStyle(dir, 'full');
      expect(readEnv()).toBe(`DEVELOPER_NAME=Ada\nREPO_APP=/work/app\n${RESPONSE_STYLE_ENV_KEY}=full\n`);
      expect(resolveResponseStyle(dir, {})).toBe('full');
    });

    it('creates the .env when there is none', () => {
      writeResponseStyle(dir, 'lite');
      expect(readEnv()).toBe(`${RESPONSE_STYLE_ENV_KEY}=lite\n`);
    });

    it('replaces rather than duplicates on a second write, and tolerates CRLF', () => {
      fs.writeFileSync(envFile(), `A=1\r\n${RESPONSE_STYLE_ENV_KEY}=lite\r\nB=2\r\n`);
      writeResponseStyle(dir, 'full');
      const lines = readEnv().split('\n').filter(Boolean);
      expect(lines.filter(l => l.startsWith(RESPONSE_STYLE_ENV_KEY))).toEqual([`${RESPONSE_STYLE_ENV_KEY}=full`]);
      expect(lines).toContain('A=1');
      expect(lines).toContain('B=2');
    });

    it('normal removes only its own line, so turning it off leaves the file as if it had never been on', () => {
      fs.writeFileSync(envFile(), 'DEVELOPER_NAME=Ada\n');
      writeResponseStyle(dir, 'full');
      writeResponseStyle(dir, 'normal');
      expect(readEnv()).toBe('DEVELOPER_NAME=Ada\n');
      expect(resolveResponseStyle(dir, {})).toBe('normal');
    });

    it('normal on a brain with no .env creates nothing', () => {
      writeResponseStyle(dir, 'normal');
      expect(fs.existsSync(envFile())).toBe(false);
    });
  });
});
