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

/**
 * Exact-match text replacement — the fallback for files no parser can address by symbol
 * (stylesheets, markup, config, and every non-TS/JS language).
 *
 * Deliberately mirrors the semantics of a standard editor edit tool, including the
 * single-occurrence requirement: a caller that meant one site and matched three would
 * otherwise silently corrupt two of them. `replaceAll` opts out of that check explicitly.
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

  // Count occurrences without regex, so the needle is never interpreted as a pattern.
  let count = 0;
  for (let i = original.indexOf(oldString); i !== -1; i = original.indexOf(oldString, i + oldString.length)) {
    count++;
    if (!replaceAll && count > 1) break;
  }

  if (count === 0) {
    return {
      ok: false,
      error: 'old_string was not found in the file. It must match the file byte-for-byte, including indentation. Re-read the file and copy the exact text.'
    };
  }
  if (count > 1 && !replaceAll) {
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
  for (let i = original.indexOf(oldString); i !== -1; i = original.indexOf(oldString, cursor)) {
    updated += original.slice(cursor, i);
    const start = updated.length;
    updated += newString;
    ranges.push({ start, end: updated.length });
    cursor = i + oldString.length;
    if (!replaceAll) break;
  }
  updated += original.slice(cursor);

  try {
    writeFileAtomic(filePath, updated);
  } catch (e: any) {
    return { ok: false, error: `write failed: ${e?.message || e}` };
  }
  return { ok: true, replacements: ranges.length, ranges, before: original };
}
