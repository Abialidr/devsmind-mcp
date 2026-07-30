import { diffSnapshots, renderUnifiedDiff, diffEdits } from '../../src/utils/diff';
import { HistoryEdit } from '../../src/db/schema';

describe('diffSnapshots', () => {
  it('produces only ctx lines for identical before/after', () => {
    const lines = diffSnapshots('a\nb\nc', 'a\nb\nc');
    expect(lines.every(l => l.type === 'ctx')).toBe(true);
  });

  it('produces add lines for pure insertion', () => {
    // Insertion in the middle (not at the very end) so the trailing line stays a clean common
    // suffix — diffLines treats a final line with no trailing newline as distinct from the same
    // text mid-string, so an end-of-string insertion doesn't isolate as a single 'add' part.
    const lines = diffSnapshots('a\nc', 'a\nb\nc');
    const adds = lines.filter(l => l.type === 'add');
    expect(adds.length).toBe(1);
    expect(adds[0].text).toBe('b');
    expect(adds[0].new_line).toBeDefined();
    expect(adds[0].old_line).toBeUndefined();
  });

  it('produces del lines for pure deletion', () => {
    const lines = diffSnapshots('a\nb\nc', 'a\nc');
    const dels = lines.filter(l => l.type === 'del');
    expect(dels.length).toBe(1);
    expect(dels[0].text).toBe('b');
    expect(dels[0].old_line).toBeDefined();
    expect(dels[0].new_line).toBeUndefined();
  });

  it('numbers old/new lines correctly through a simple mixed change', () => {
    const before = 'line1\nline2\nline3';
    const after = 'line1\nlineX\nline3';
    const lines = diffSnapshots(before, after, 3);
    // Expect a del for line2 and an add for lineX, surrounded by ctx for line1/line3.
    const del = lines.find(l => l.type === 'del');
    const add = lines.find(l => l.type === 'add');
    expect(del?.text).toBe('line2');
    expect(add?.text).toBe('lineX');
    const ctx1 = lines.find(l => l.type === 'ctx' && l.text === 'line1');
    expect(ctx1?.old_line).toBe(1);
    expect(ctx1?.new_line).toBe(1);
  });

  it('trims unchanged runs to `context` lines at start/middle/end, keeping correct old/new numbering for the surviving lines', () => {
    // 3 changes separated by unchanged runs of 5 / 6 / 5 lines, context=2:
    //  - the FIRST run (before any change) keeps only its trailing `context` lines
    //  - a MIDDLE run (between two changes) keeps both leading and trailing `context` lines
    //  - the LAST run (after the final change) keeps only its leading `context` lines
    const before = ['H1', 'H2', 'H3', 'H4', 'H5', 'DEL1', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'DEL2', 'T1', 'T2', 'T3', 'T4', 'T5'].join('\n');
    const after = ['H1', 'H2', 'H3', 'H4', 'H5', 'ADD1', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'ADD2', 'T1', 'T2', 'T3', 'T4', 'T5'].join('\n');
    const lines = diffSnapshots(before, after, 2);
    const byText = (t: string) => lines.find(l => l.text === t);

    // First run: only the trailing 2 lines survive, numbered by true position (4,5) not (1,2).
    expect(byText('H1')).toBeUndefined();
    expect(byText('H3')).toBeUndefined();
    expect(byText('H4')).toMatchObject({ type: 'ctx', old_line: 4, new_line: 4 });
    expect(byText('H5')).toMatchObject({ type: 'ctx', old_line: 5, new_line: 5 });

    expect(byText('DEL1')).toMatchObject({ type: 'del', old_line: 6 });
    expect(byText('ADD1')).toMatchObject({ type: 'add', new_line: 6 });

    // Middle run: leading 2 AND trailing 2 survive; the middle 2 (M3, M4) are dropped.
    expect(byText('M1')).toMatchObject({ type: 'ctx', old_line: 7, new_line: 7 });
    expect(byText('M2')).toMatchObject({ type: 'ctx', old_line: 8, new_line: 8 });
    expect(byText('M3')).toBeUndefined();
    expect(byText('M4')).toBeUndefined();
    expect(byText('M5')).toMatchObject({ type: 'ctx', old_line: 11, new_line: 11 });
    expect(byText('M6')).toMatchObject({ type: 'ctx', old_line: 12, new_line: 12 });

    expect(byText('DEL2')).toMatchObject({ type: 'del', old_line: 13 });
    expect(byText('ADD2')).toMatchObject({ type: 'add', new_line: 13 });

    // Last run: only the leading 2 lines survive; T3/T4/T5 are dropped even though they are
    // valid, correctly-numbered lines that were counted through on the way there.
    expect(byText('T1')).toMatchObject({ type: 'ctx', old_line: 14, new_line: 14 });
    expect(byText('T2')).toMatchObject({ type: 'ctx', old_line: 15, new_line: 15 });
    expect(byText('T3')).toBeUndefined();
    expect(byText('T5')).toBeUndefined();
  });

  it('keeps a short unchanged run (<= context*2) entirely, unmodified', () => {
    const before = 'a\nb\nc\nX\nd\ne\nf';
    const after = 'a\nb\nc\nY\nd\ne\nf';
    // context default 3, run length around the change is 3 (a,b,c) and 3 (d,e,f) <= 2*3
    const lines = diffSnapshots(before, after);
    const ctxTexts = lines.filter(l => l.type === 'ctx').map(l => l.text);
    expect(ctxTexts).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('handles empty before and after', () => {
    expect(diffSnapshots('', '')).toEqual([]);
  });

  it('handles empty before with non-empty after (all additions)', () => {
    const lines = diffSnapshots('', 'a\nb');
    expect(lines.every(l => l.type === 'add')).toBe(true);
    expect(lines.map(l => l.text)).toEqual(['a', 'b']);
  });
});

describe('renderUnifiedDiff', () => {
  it('renders +/-/space prefixed lines joined by newline', () => {
    const before = 'a\nb';
    const after = 'a\nc';
    const rendered = renderUnifiedDiff(before, after);
    const lines = rendered.split('\n');
    expect(lines.some(l => l.startsWith('-b'))).toBe(true);
    expect(lines.some(l => l.startsWith('+c'))).toBe(true);
    expect(lines.some(l => l === ' a')).toBe(true);
  });

  it('produces an empty string for identical, empty inputs', () => {
    expect(renderUnifiedDiff('', '')).toBe('');
  });
});

describe('diffEdits', () => {
  function makeEdit(at: string, before: string, after: string, reasoning: string): HistoryEdit {
    return { at, before, after, reasoning };
  }

  it('builds one EditDiff per edit, in the given order', () => {
    const edits: HistoryEdit[] = [
      makeEdit('t1', 'a', 'b', 'first change'),
      makeEdit('t2', 'b', 'c', 'second change')
    ];
    const result = diffEdits(edits, { revertableIndex: 1 });
    expect(result.length).toBe(2);
    expect(result[0].at).toBe('t1');
    expect(result[0].reasoning).toBe('first change');
    expect(result[1].at).toBe('t2');
  });

  it('counts added/removed lines per edit', () => {
    const edits: HistoryEdit[] = [makeEdit('t1', 'a\nb', 'a\nX\nY', 'r')];
    const result = diffEdits(edits, { revertableIndex: 0 });
    expect(result[0].added).toBeGreaterThan(0);
    expect(result[0].removed).toBeGreaterThan(0);
  });

  it('marks only the edit at revertableIndex as revertable', () => {
    const edits: HistoryEdit[] = [
      makeEdit('t1', 'a', 'b', 'r1'),
      makeEdit('t2', 'b', 'c', 'r2'),
      makeEdit('t3', 'c', 'd', 'r3')
    ];
    const result = diffEdits(edits, { revertableIndex: 2 });
    expect(result[0].revertable).toBe(false);
    expect(result[1].revertable).toBe(false);
    expect(result[2].revertable).toBe(true);
  });

  it('sets blocked_reason only on the LAST edit when it is not revertable', () => {
    const edits: HistoryEdit[] = [
      makeEdit('t1', 'a', 'b', 'r1'),
      makeEdit('t2', 'b', 'c', 'r2')
    ];
    // revertableIndex out of range -> nothing is revertable
    const result = diffEdits(edits, { revertableIndex: -1, blockedReason: 'drifted' });
    expect(result[0].revertable).toBe(false);
    expect(result[0].blocked_reason).toBeUndefined(); // not the last edit
    expect(result[1].revertable).toBe(false);
    expect(result[1].blocked_reason).toBe('drifted'); // last edit, blocked
  });

  it('leaves blocked_reason undefined on the last edit when it IS revertable', () => {
    const edits: HistoryEdit[] = [makeEdit('t1', 'a', 'b', 'r1')];
    const result = diffEdits(edits, { revertableIndex: 0, blockedReason: 'should not appear' });
    expect(result[0].revertable).toBe(true);
    expect(result[0].blocked_reason).toBeUndefined();
  });

  it('handles an empty edits array', () => {
    expect(diffEdits([], { revertableIndex: 0 })).toEqual([]);
  });
});
