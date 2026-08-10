import * as fs from 'fs';
import * as path from 'path';

/**
 * Write via temp file + rename, so a reader never observes a half-written source file and a
 * failed write leaves the original intact.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Create a file that does not exist yet, with its parent directories.
 *
 * Reported in the same shape as a replacement — one range spanning the whole file, against an
 * empty "before" — so a new file's contents trace exactly like any other edit, and every symbol
 * in it is new by construction. That keeps creating a file from being a special case the caller
 * has to route somewhere else.
 */
export function createFileWithContent(filePath: string, content: string): TextEditResult {
  if (fs.existsSync(filePath)) {
    return { ok: false, error: `${path.basename(filePath)} already exists — pass the exact old_string you want to replace inside it.` };
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomic(filePath, content);
  } catch (e: any) {
    return { ok: false, error: `could not create ${filePath}: ${e?.message || e}` };
  }
  return { ok: true, replacements: 1, ranges: [{ start: 0, end: content.length }], before: '', created: true };
}

export interface TextEditResult {
  ok: boolean;
  error?: string;
  replacements?: number;
  /** True when the file did not exist and this call brought it into being. */
  created?: boolean;
  /**
   * The span each replacement occupies in the NEW file content, and the content as it stood
   * BEFORE the write. Together these make the edit traceable: whatever code overlaps a span
   * and differs from `before` is, by construction, what this edit changed — no name matching,
   * and it holds for code that did not exist until this write.
   */
  ranges?: { start: number; end: number }[];
  before?: string;
}

/** Collapse CRLF and lone CR down to LF, so line-ending style never affects a text comparison. */
function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regex that matches `needle` against the file's ACTUAL bytes, treating "\n" and "\r\n" as
 * interchangeable at every line break. `needle` is assumed already EOL-normalized (see
 * `normalizeEol`), so every newline in it is a plain "\n" — each one is widened to accept an
 * optional leading "\r" in the source. Everything else is escaped literally.
 */
function buildEolTolerantPattern(needle: string): RegExp {
  const source = escapeRegExp(needle).replace(/\n/g, '\\r?\\n');
  return new RegExp(source, 'g');
}

/**
 * Re-express `text` (assumed to use plain "\n") using whichever EOL style `matchedOriginal`
 * — the literal bytes being replaced — actually used. Real files are sometimes inconsistent
 * line-to-line (e.g. edited on both Windows and Unix over time); this only asks "did the span
 * being touched lean CRLF," not "is the whole file CRLF," since that's the only span the
 * replacement's own line endings need to agree with.
 */
function adaptEol(text: string, matchedOriginal: string): string {
  return /\r\n/.test(matchedOriginal) ? normalizeEol(text).replace(/\n/g, '\r\n') : normalizeEol(text);
}

/**
 * Exact-match text replacement — the fallback for files no parser can address by symbol
 * (stylesheets, markup, config, and every non-TS/JS language).
 *
 * Deliberately mirrors the semantics of a standard editor edit tool, including the
 * single-occurrence requirement: a caller that meant one site and matched three would
 * otherwise silently corrupt two of them. `replaceAll` opts out of that check explicitly.
 *
 * Matching is tolerant of CRLF-vs-LF differences between `oldString` and the file on disk —
 * a caller (human or AI) working from a rendered view of the file has no reliable way to know
 * which EOL style a given line actually uses, and a file can mix both after being edited on
 * different platforms. Only the line-ending characters are forgiving; every other character,
 * including indentation, must still match exactly.
 */
export function replaceTextInFile(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll = false
): TextEditResult {
  if (oldString === newString) {
    return { ok: false, error: 'old_string and new_string are identical — nothing to do.' };
  }

  let original: string;
  try {
    original = fs.readFileSync(filePath, 'utf-8');
  } catch (e: any) {
    return { ok: false, error: `could not read ${filePath}: ${e?.message || e}` };
  }

  // An empty needle matches at every position and would advance the scan by zero — the loop
  // below would never terminate. Reserve it for the one case it can mean unambiguously: the
  // file exists but is genuinely empty, so "replace nothing" and "replace everything" coincide
  // and there is no other way to address that content. Any other file gets a real error instead
  // of hanging, and is told to supply the actual text to replace.
  if (oldString === '') {
    if (original.length === 0) {
      try {
        writeFileAtomic(filePath, newString);
      } catch (e: any) {
        return { ok: false, error: `write failed: ${e?.message || e}` };
      }
      return { ok: true, replacements: 1, ranges: [{ start: 0, end: newString.length }], before: '' };
    }
    return {
      ok: false,
      error: 'old_string is empty, but this file already exists and has content. An empty old_string only means "create this file" (or populate an EMPTY one); to change an existing non-empty file, give the exact text to replace.'
    };
  }

  const pattern = buildEolTolerantPattern(normalizeEol(oldString));

  // Collect every match up front (bounded by how many the file could plausibly contain), so
  // counting and building the replacement read from the same list — no risk of them disagreeing.
  const matches: RegExpExecArray[] = [];
  for (let m = pattern.exec(original); m !== null; m = pattern.exec(original)) {
    matches.push(m);
    if (!replaceAll && matches.length > 1) break;
  }

  if (matches.length === 0) {
    return {
      ok: false,
      error: 'old_string was not found in the file. Line-ending differences (CRLF vs LF) are tolerated, but every other character, including indentation, must match exactly. Re-read the file and copy the exact text.'
    };
  }
  if (matches.length > 1 && !replaceAll) {
    return {
      ok: false,
      error: `old_string matches more than one place in the file — nothing was written. Include surrounding lines to make it unique, or pass replace_all: true if every occurrence should change.`
    };
  }

  // Built by hand rather than via replace()/split-join, so each replacement's span in the NEW
  // content is known exactly — later replacements shift as earlier ones change length, and
  // only accumulating as we go accounts for that.
  const ranges: { start: number; end: number }[] = [];
  let updated = '';
  let cursor = 0;
  for (const match of matches) {
    updated += original.slice(cursor, match.index);
    const start = updated.length;
    updated += adaptEol(newString, match[0]);
    ranges.push({ start, end: updated.length });
    cursor = match.index + match[0].length;
  }
  updated += original.slice(cursor);

  try {
    writeFileAtomic(filePath, updated);
  } catch (e: any) {
    return { ok: false, error: `write failed: ${e?.message || e}` };
  }
  return { ok: true, replacements: ranges.length, ranges, before: original };
}

/**
 * Locate an edit that was already applied to the file by some OTHER tool (the caller's own
 * editor, not DevsMind) — the read-only counterpart to {@link replaceTextInFile}, used by
 * `stage_change` to catch up on a write `edit_node` never saw. Nothing is written here; `newString`
 * is expected to already be sitting on disk, and `oldString` exists only to reconstruct what came
 * before it, the same way `replaceTextInFile`'s `before` does.
 *
 * Semantics mirror `replaceTextInFile` with the roles of old/new reversed: `newString` is what
 * must be found in the CURRENT file content, byte-for-byte except EOL style, exactly once unless
 * `replaceAll`. `oldString` is substituted back into each matched span to reconstruct the
 * pre-edit content, which is what makes the change traceable and diffable exactly like a real
 * `edit_node` write.
 */
export function locateAppliedEdit(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll = false
): TextEditResult {
  if (oldString === newString) {
    return { ok: false, error: 'old_string and new_string are identical — nothing to record.' };
  }

  let current: string;
  try {
    current = fs.readFileSync(filePath, 'utf-8');
  } catch (e: any) {
    return { ok: false, error: `could not read ${filePath}: ${e?.message || e}` };
  }

  // An empty old_string means "this file did not exist before" — some other tool just created
  // it. There is nothing to search for: the whole current content IS the new state, and
  // whatever came before it is, by definition, nothing.
  if (oldString === '') {
    return { ok: true, replacements: 1, ranges: [{ start: 0, end: current.length }], before: '' };
  }

  const pattern = buildEolTolerantPattern(normalizeEol(newString));

  const matches: RegExpExecArray[] = [];
  for (let m = pattern.exec(current); m !== null; m = pattern.exec(current)) {
    matches.push(m);
    if (!replaceAll && matches.length > 1) break;
  }

  if (matches.length === 0) {
    return {
      ok: false,
      error: 'new_string was not found in the file. stage_change records an edit that has ALREADY landed on disk — if you have not made this change yet, call edit_node instead. Line-ending differences (CRLF vs LF) are tolerated, but every other character, including indentation, must match exactly.'
    };
  }
  if (matches.length > 1 && !replaceAll) {
    return {
      ok: false,
      error: `new_string matches more than one place in the file — nothing was recorded. Include surrounding lines to make it unique, or pass replace_all: true if every occurrence should be staged.`
    };
  }

  // Reconstruct the pre-edit content by substituting old_string back into each matched span —
  // the mirror image of how replaceTextInFile builds the NEW content from the old one.
  const ranges: { start: number; end: number }[] = [];
  let before = '';
  let cursor = 0;
  for (const match of matches) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
    before += current.slice(cursor, match.index);
    before += adaptEol(oldString, match[0]);
    cursor = match.index + match[0].length;
  }
  before += current.slice(cursor);

  return { ok: true, replacements: ranges.length, ranges, before };
}
