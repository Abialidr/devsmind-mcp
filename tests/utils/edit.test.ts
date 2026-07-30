import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  writeFileAtomic,
  createFileWithContent,
  replaceTextInFile
} from '../../src/utils/edit';

// `import * as fs` (under esModuleInterop) produces a non-configurable namespace wrapper that
// jest.spyOn cannot redefine. A plain `require('fs')` returns the real, mutable Node module
// object — the same singleton the source files' `fs.xxx` getters proxy back to — so spying here
// still intercepts calls made from src/utils/edit.ts.
const fsReal: typeof fs = require('fs');

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-edit-test-'));
}

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes content via temp file + rename, leaving no temp file behind', () => {
    const target = path.join(dir, 'out.txt');
    writeFileAtomic(target, 'hello world');
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello world');
    const leftover = fs.readdirSync(dir).filter(f => f.includes('.tmp'));
    expect(leftover).toEqual([]);
  });

  it('overwrites an existing file completely (no half-written state possible)', () => {
    const target = path.join(dir, 'out.txt');
    fs.writeFileSync(target, 'this is a much longer original content string');
    writeFileAtomic(target, 'short');
    expect(fs.readFileSync(target, 'utf-8')).toBe('short');
  });

  it('throws and leaves no temp file when the initial write fails', () => {
    const target = path.join(dir, 'missingdir', 'out.txt');
    expect(() => writeFileAtomic(target, 'content')).toThrow();
    const tmp = `${target}.${process.pid}.tmp`;
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('cleans up the temp file when rename fails after a successful write', () => {
    const target = path.join(dir, 'out.txt');
    const tmp = `${target}.${process.pid}.tmp`;
    const renameSpy = jest.spyOn(fsReal, 'renameSync').mockImplementation(() => { throw new Error('boom'); });
    try {
      expect(() => writeFileAtomic(target, 'content')).toThrow('boom');
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.existsSync(tmp)).toBe(false);
  });
});

describe('createFileWithContent', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('creates a new file including missing parent directories', () => {
    const target = path.join(dir, 'a', 'b', 'c.txt');
    const result = createFileWithContent(target, 'hello');
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.replacements).toBe(1);
    expect(result.ranges).toEqual([{ start: 0, end: 5 }]);
    expect(result.before).toBe('');
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello');
  });

  it('errors when the file already exists', () => {
    const target = path.join(dir, 'exists.txt');
    fs.writeFileSync(target, 'already here');
    const result = createFileWithContent(target, 'new content');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('already exists');
    expect(fs.readFileSync(target, 'utf-8')).toBe('already here');
  });

  it('reports an error instead of throwing when the parent cannot be created', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, "im a file, not a dir");
    const target = path.join(blocker, 'sub', 'file.txt');
    const result = createFileWithContent(target, 'content');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('could not create');
  });

  it('falls back to the thrown value itself when the failure has no .message', () => {
    const target = path.join(dir, 'a', 'file.txt');
    const mkdirSpy = jest.spyOn(fsReal, 'mkdirSync').mockImplementation(() => { throw 'mkdir exploded'; });
    try {
      const result = createFileWithContent(target, 'content');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('could not create ' + target + ': mkdir exploded');
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});

describe('replaceTextInFile', () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('errors when old_string and new_string are identical', () => {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, 'same');
    const result = replaceTextInFile(target, 'same text', 'same text');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('identical');
  });

  it('errors when the file cannot be read', () => {
    const target = path.join(dir, 'missing.txt');
    const result = replaceTextInFile(target, 'foo', 'bar');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('could not read');
  });

  it('falls back to the thrown value itself when a read failure has no .message', () => {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, 'hello world');
    const readSpy = jest.spyOn(fsReal, 'readFileSync').mockImplementation(() => { throw 'read exploded'; });
    try {
      const result = replaceTextInFile(target, 'foo', 'bar');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('could not read ' + target + ': read exploded');
    } finally {
      readSpy.mockRestore();
    }
  });

  it('replaces a single occurrence and reports the correct range and before', () => {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, 'hello world');
    const result = replaceTextInFile(target, 'world', 'there');
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(1);
    expect(result.before).toBe('hello world');
    expect(result.ranges).toEqual([{ start: 6, end: 11 }]);
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello there');
  });

  it('errors when old_string is not found', () => {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, 'hello world');
    const result = replaceTextInFile(target, 'nope', 'x');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('was not found');
  });

  it('errors when old_string matches more than once and replace_all is false', () => {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, 'foo bar foo baz foo');
    const result = replaceTextInFile(target, 'foo', 'qux');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('more than one place');
    expect(fs.readFileSync(target, 'utf-8')).toBe('foo bar foo baz foo'); // untouched
  });

  it('replaceAll replaces every occurrence and reports every range', () => {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, 'foo bar foo baz foo');
    const result = replaceTextInFile(target, 'foo', 'qux', true);
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(3);
    const newContent = fs.readFileSync(target, 'utf-8');
    expect(newContent).toBe('qux bar qux baz qux');
    for (const r of result.ranges!) {
      expect(newContent.slice(r.start, r.end)).toBe('qux');
    }
  });

  it('correctly computes ranges for replacements whose length differs from the original', () => {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, 'aXbXc');
    const result = replaceTextInFile(target, 'X', 'YYY', true);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('aYYYbYYYc');
    expect(result.ranges).toEqual([{ start: 1, end: 4 }, { start: 5, end: 8 }]);
  });

  it('tolerates CRLF in the file when old_string uses LF, and re-expresses the replacement as CRLF', () => {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, 'line1\r\nline2\r\nline3');
    const result = replaceTextInFile(target, 'line1\nline2', 'lineA\nlineB');
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('lineA\r\nlineB\r\nline3');
  });

  it('keeps LF when the matched span used LF', () => {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, 'line1\nline2\nline3');
    const result = replaceTextInFile(target, 'line1\nline2', 'lineA\nlineB');
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('lineA\nlineB\nline3');
  });

  it('treats regex special characters in old_string literally', () => {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, 'value = a.b(c) + 1;');
    const result = replaceTextInFile(target, 'a.b(c)', 'a.b(d)');
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('value = a.b(d) + 1;');
  });

  it('allows an empty old_string to populate a genuinely empty file', () => {
    const target = path.join(dir, 'empty.txt');
    fs.writeFileSync(target, '');
    const result = replaceTextInFile(target, '', 'new content');
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(1);
    expect(result.before).toBe('');
    expect(result.ranges).toEqual([{ start: 0, end: 'new content'.length }]);
    expect(fs.readFileSync(target, 'utf-8')).toBe('new content');
  });

  it('errors when old_string is empty but the file already has content', () => {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, 'not empty');
    const result = replaceTextInFile(target, '', 'new content');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('old_string is empty');
    expect(fs.readFileSync(target, 'utf-8')).toBe('not empty');
  });

  it('errors when the write fails on an ordinary replacement', () => {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, 'hello world');
    const renameSpy = jest.spyOn(fsReal, 'renameSync').mockImplementation(() => { throw new Error('disk full'); });
    try {
      const result = replaceTextInFile(target, 'world', 'there');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('write failed');
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('errors when the write fails while populating an empty file via empty old_string', () => {
    const target = path.join(dir, 'empty.txt');
    fs.writeFileSync(target, '');
    const renameSpy = jest.spyOn(fsReal, 'renameSync').mockImplementation(() => { throw new Error('disk full'); });
    try {
      const result = replaceTextInFile(target, '', 'new content');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('write failed');
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('falls back to the thrown value itself when the empty-file write failure has no .message', () => {
    const target = path.join(dir, 'empty.txt');
    fs.writeFileSync(target, '');
    const renameSpy = jest.spyOn(fsReal, 'renameSync').mockImplementation(() => { throw 'rename exploded'; });
    try {
      const result = replaceTextInFile(target, '', 'new content');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('write failed: rename exploded');
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('falls back to the thrown value itself when an ordinary write failure has no .message', () => {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, 'hello world');
    const renameSpy = jest.spyOn(fsReal, 'renameSync').mockImplementation(() => { throw 'rename exploded'; });
    try {
      const result = replaceTextInFile(target, 'world', 'there');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('write failed: rename exploded');
    } finally {
      renameSpy.mockRestore();
    }
  });
});
