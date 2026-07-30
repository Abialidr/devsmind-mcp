import { extractJsonBlock, repairJson, safeJsonParse } from '../../src/utils/json';

describe('extractJsonBlock', () => {
  it('strips a ```json fenced block', () => {
    const text = '```json\n{"a":1}\n```';
    expect(extractJsonBlock(text)).toBe('{"a":1}');
  });

  it('strips a plain ``` fenced block (no language tag)', () => {
    const text = '```\n{"a":1}\n```';
    expect(extractJsonBlock(text)).toBe('{"a":1}');
  });

  it('handles a fence with no newline after the opening backticks', () => {
    const text = '```{"a":1}```';
    // substring(3) after the opening fence, then trailing ``` stripped
    expect(extractJsonBlock(text)).toBe('{"a":1}');
  });

  it('extracts JSON object with surrounding prose', () => {
    const text = 'Sure, here is the JSON: {"a":1,"b":2} Hope that helps!';
    expect(extractJsonBlock(text)).toBe('{"a":1,"b":2}');
  });

  it('extracts the outermost object when braces are nested', () => {
    const text = 'prefix {"a":{"b":2}} suffix';
    expect(extractJsonBlock(text)).toBe('{"a":{"b":2}}');
  });

  it('extracts an array when it appears before any object', () => {
    const text = 'result: [1,2,3] done';
    expect(extractJsonBlock(text)).toBe('[1,2,3]');
  });

  it('picks the object when { appears before [', () => {
    const text = '{"a":[1,2]}';
    expect(extractJsonBlock(text)).toBe('{"a":[1,2]}');
  });

  it('picks the array when [ appears before {', () => {
    const text = '[{"a":1}]';
    expect(extractJsonBlock(text)).toBe('[{"a":1}]');
  });

  it('falls back to the raw (trimmed) text when no { or [ is found', () => {
    expect(extractJsonBlock('  just some text  ')).toBe('just some text');
  });

  it('returns from the start index to end when there is no matching closing char', () => {
    const text = '{"a":1, "b":2';
    expect(extractJsonBlock(text)).toBe('{"a":1, "b":2');
  });

  it('handles an empty string', () => {
    expect(extractJsonBlock('')).toBe('');
  });
});

describe('repairJson', () => {
  it('returns "{}" for an empty/whitespace-only string', () => {
    expect(repairJson('')).toBe('{}');
    expect(repairJson('   ')).toBe('{}');
  });

  it('closes an unterminated string', () => {
    expect(repairJson('{"a":"hello')).toBe('{"a":"hello"}');
  });

  it('closes missing closing braces', () => {
    expect(repairJson('{"a":1')).toBe('{"a":1}');
  });

  it('closes missing closing brackets', () => {
    expect(repairJson('[1,2,3')).toBe('[1,2,3]');
  });

  it('closes nested unclosed structures in the correct (reverse) order', () => {
    expect(repairJson('{"a":[1,2,{"b":3')).toBe('{"a":[1,2,{"b":3}]}');
  });

  it('drops a dangling escape backslash before closing the string', () => {
    expect(repairJson('{"a":"hello\\')).toBe('{"a":"hello"}');
  });

  it('handles a valid escape sequence inside a string without corrupting it', () => {
    expect(repairJson('{"a":"line1\\nline2"}')).toBe('{"a":"line1\\nline2"}');
  });

  it('leaves already-valid JSON untouched (well-formed input)', () => {
    expect(repairJson('{"a":1,"b":[1,2]}')).toBe('{"a":1,"b":[1,2]}');
  });

  it('ignores an extra closing brace/bracket with nothing on the stack', () => {
    expect(repairJson('{"a":1}}')).toBe('{"a":1}}');
  });

  it('ignores a mismatched closer (bracket closing a brace scope)', () => {
    // ']' seen while top of stack is '{' -> no-op per the implementation
    const result = repairJson('{"a":1]');
    expect(result).toBe('{"a":1]}');
  });
});

describe('safeJsonParse', () => {
  it('direct-parses valid JSON (tier 1)', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
  });

  it('extracts then parses when direct parse fails but extraction yields valid JSON (tier 2)', () => {
    const text = 'Here you go: {"a":1} thanks';
    expect(safeJsonParse(text, {})).toEqual({ a: 1 });
  });

  it('extracts and repairs when both direct parse and plain extraction fail (tier 3)', () => {
    const text = '```json\n{"a":1, "b":"unterminated\n```';
    const result = safeJsonParse<{ a: number; b: string }>(text, { a: -1, b: '' });
    expect(result.a).toBe(1);
    expect(typeof result.b).toBe('string');
  });

  it('returns the fallback on total failure without throwing', () => {
    const fallback = { ok: false };
    expect(() => safeJsonParse('!!!not json at all!!!', fallback)).not.toThrow();
  });

  it('returns the fallback for non-string input', () => {
    // @ts-expect-error - intentionally passing a non-string to exercise the type guard
    expect(safeJsonParse(null, 'fallback')).toBe('fallback');
    // @ts-expect-error
    expect(safeJsonParse(undefined, 'fallback')).toBe('fallback');
  });

  it('returns the fallback for an empty string', () => {
    expect(safeJsonParse('', 'fallback')).toBe('fallback');
  });

  it('logs a warning and returns fallback when repair still cannot produce valid JSON', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // A string with mismatched brace/bracket type that repairJson cannot fix into valid JSON:
    // e.g. valid-looking but semantically broken JSON (a bare comma) with no braces to extract.
    const text = ',,,';
    const result = safeJsonParse(text, 'fallback-value');
    expect(result).toBe('fallback-value');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
