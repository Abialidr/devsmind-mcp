import * as path from 'path';
import { parseNodeId, isAstParseable, normalizeFsPath, AST_PARSEABLE_EXTENSIONS } from '../../src/utils/ast';

describe('parseNodeId', () => {
  it('parses a simple {repo}/relpath#symbol node id', () => {
    const result = parseNodeId('{harrir-backend}/src/controllers/Search.ts#doSearch');
    expect(result).toEqual({
      repo: 'harrir-backend',
      filePath: 'src/controllers/Search.ts',
      symbolName: 'doSearch'
    });
    expect(result?.className).toBeUndefined();
    expect(result?.memberName).toBeUndefined();
  });

  it('parses a dotted Class.method symbol into className/memberName', () => {
    const result = parseNodeId('{repo}/src/controllers/SearchIndexController.ts#SearchIndexController.searchFiltersV2');
    expect(result).toEqual({
      repo: 'repo',
      filePath: 'src/controllers/SearchIndexController.ts',
      symbolName: 'SearchIndexController.searchFiltersV2',
      className: 'SearchIndexController',
      memberName: 'searchFiltersV2'
    });
  });

  it('does NOT split a symbol with more than 2 dot-separated parts', () => {
    const result = parseNodeId('{repo}/a.ts#Namespace.Class.method');
    expect(result?.symbolName).toBe('Namespace.Class.method');
    expect(result?.className).toBeUndefined();
    expect(result?.memberName).toBeUndefined();
  });

  it('handles a repo name containing dashes and the file path containing multiple slashes', () => {
    const result = parseNodeId('{my-repo-name}/a/b/c/d.tsx#Component');
    expect(result?.repo).toBe('my-repo-name');
    expect(result?.filePath).toBe('a/b/c/d.tsx');
  });

  it('returns null when the string has no braces', () => {
    expect(parseNodeId('src/a.ts#foo')).toBeNull();
  });

  it('returns null when the string has no "#"', () => {
    expect(parseNodeId('{repo}/src/a.ts')).toBeNull();
  });

  it('returns null when the braces are empty', () => {
    expect(parseNodeId('{}/src/a.ts#foo')).toBeNull();
  });

  it('returns null for a completely unrelated string', () => {
    expect(parseNodeId('not a node id at all')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseNodeId('')).toBeNull();
  });

  it('treats everything after the first "#" as the symbol name, including further "#" characters', () => {
    const result = parseNodeId('{repo}/a.ts#foo#bar');
    expect(result?.symbolName).toBe('foo#bar');
  });
});

describe('isAstParseable', () => {
  it('returns true for every extension in AST_PARSEABLE_EXTENSIONS', () => {
    for (const ext of AST_PARSEABLE_EXTENSIONS) {
      expect(isAstParseable(`file${ext}`)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isAstParseable('Component.TSX')).toBe(true);
    expect(isAstParseable('index.Js')).toBe(true);
  });

  it('returns false for a non-parseable extension', () => {
    expect(isAstParseable('data.json')).toBe(false);
    expect(isAstParseable('styles.css')).toBe(false);
    expect(isAstParseable('script.py')).toBe(false);
  });

  it('returns false for a file with no extension', () => {
    expect(isAstParseable('Makefile')).toBe(false);
  });

  it('works with a full path, not just a bare filename', () => {
    expect(isAstParseable('/repo/src/utils/foo.ts')).toBe(true);
    expect(isAstParseable('C:\\repo\\src\\utils\\foo.py')).toBe(false);
  });
});

describe('normalizeFsPath', () => {
  it('converts backslashes to forward slashes', () => {
    const result = normalizeFsPath('C:\\x\\y.ts');
    expect(result).not.toContain('\\');
    expect(result).toContain('/');
  });

  it('lowercases the whole path', () => {
    const result = normalizeFsPath('C:\\Users\\ABC\\File.TS');
    expect(result).toBe(result.toLowerCase());
  });

  it('produces the same result for equivalent paths spelled with different case/slash style', () => {
    const a = normalizeFsPath('C:\\x\\y\\File.TS');
    const b = normalizeFsPath('c:/x/y/file.ts');
    expect(a).toBe(b);
  });

  it('resolves a relative path against cwd, matching path.resolve', () => {
    const expected = path.resolve('relative/file.ts').replace(/\\/g, '/').toLowerCase();
    expect(normalizeFsPath('relative/file.ts')).toBe(expected);
  });
});
