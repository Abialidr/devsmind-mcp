import {
  isWindowsUnsafePath, findCaseCollisions, isForeignAbsolutePath, isForeignRootSegment,
} from '../../src/utils/safe-path';

describe('safe-path', () => {
  describe('isWindowsUnsafePath', () => {
    it.each([
      ['colon', 'vectors/a:b.json'],
      ['asterisk', 'vectors/a*b.json'],
      ['question mark', 'vectors/q?.json'],
      ['quote', 'vectors/a"b.json'],
      ['angle brackets', 'vectors/a<b>.json'],
      ['pipe', 'vectors/a|b.json'],
      ['backslash', 'vectors/a\\b.json'],
      ['control char', 'vectors/a\u0001b.json'],
      ['glued absolute paths', 'vectors/x.ts, /home/u/x.ts'],
      ['reserved name', 'vectors/con.json'],
      ['reserved name, mixed case', 'vectors/NuL'],
      ['reserved name with extension chain', 'vectors/com1.backup.json'],
      ['trailing dot', 'vectors/trail.'],
      ['trailing space', 'vectors/trail '],
      ['empty segment', 'vectors//x.json'],
      ['leading slash', '/vectors/x.json'],
      ['over the length limit', `vectors/${'d/'.repeat(100)}x.json`],
    ])('flags %s', (_label, p) => {
      expect(isWindowsUnsafePath(p)).toBe(true);
    });

    it.each([
      'vectors/app/(admin)/orders/page.json',
      'graph/harrir-web/app/[id]/page.json',
      'vectors/app/a,b.json',
      'history/0f1e2d3c-0000-4000-8000-000000000000.json',
      'vectors/app/console.json',
      'vectors/app/.hidden.json',
      `vectors/${'d/'.repeat(80)}x.json`,
    ])('leaves %s alone', p => {
      expect(isWindowsUnsafePath(p)).toBe(false);
    });
  });

  describe('findCaseCollisions', () => {
    it('keeps the first path in code-point order and returns the rest, whatever the input order', () => {
      // Code-point order is FOO < Foo < foo, so `a/FOO.json` survives.
      expect(findCaseCollisions(['a/foo.json', 'a/Foo.json', 'a/FOO.json']).sort()).toEqual(['a/Foo.json', 'a/foo.json']);
      expect(findCaseCollisions(['a/Foo.json', 'a/foo.json'])).toEqual(findCaseCollisions(['a/foo.json', 'a/Foo.json']));
      expect(findCaseCollisions(['a/foo.json', 'a/Foo.json'])).toEqual(['a/foo.json']);
    });

    it('treats a path that differs only by Unicode normalization form as a collision (macOS does)', () => {
      const nfc = 'a/caf\u00e9.json';
      const nfd = 'a/cafe\u0301.json';
      expect(findCaseCollisions([nfc, nfd])).toHaveLength(1);
    });

    it('ignores identical duplicates and genuinely different files', () => {
      expect(findCaseCollisions(['a/x.json', 'a/x.json', 'a/y.json', 'b/x.json'])).toEqual([]);
    });

    it('drops every file under the losing spelling of a directory that differs only by case', () => {
      // Both trees would pour into one folder on Windows/macOS and overwrite each other on any
      // repeated name; `App/` wins (code-point order) and everything under `app/` goes.
      expect(findCaseCollisions(['App/x.json', 'app/y.json', 'app/deep/z.json']).sort())
        .toEqual(['app/deep/z.json', 'app/y.json']);
      expect(findCaseCollisions(['app/y.json', 'App/x.json'])).toEqual(['app/y.json']);
    });

    it('drops a file whose name matches a directory\'s, which a case-insensitive filesystem cannot hold both of', () => {
      expect(findCaseCollisions(['a/foo', 'a/Foo/bar.json'])).toEqual(['a/foo']);
      expect(findCaseCollisions(['a/Foo', 'a/foo/bar.json'])).toEqual(['a/Foo']);
    });

    it('leaves a clean, differently-named tree completely alone', () => {
      expect(findCaseCollisions(['graph/app/a.json', 'graph/app/b/c.json', 'vectors/app/a.json', 'history/h1.json'])).toEqual([]);
    });
  });

  describe('isForeignRootSegment', () => {
    it.each(['home', 'Users', 'ROOT', 'mnt', 'Volumes', 'tmp', 'var', 'usr', 'opt', 'etc', 'srv'])('flags %s as an OS root', seg => {
      expect(isForeignRootSegment(seg)).toBe(true);
    });

    it('leaves real repo names alone, however they are spelled', () => {
      for (const seg of ['app', 'harrir-web', 'backend', 'Users-service', 'homepage', 'optimizer']) {
        expect(isForeignRootSegment(seg)).toBe(false);
      }
    });

    it('exempts a repo that genuinely carries an OS-root name', () => {
      expect(isForeignRootSegment('home', ['home', 'api'])).toBe(false);
      expect(isForeignRootSegment('Home', ['home'])).toBe(false);
      expect(isForeignRootSegment('home', ['api'])).toBe(true);
    });
  });

  describe('isWindowsUnsafePath with a measured prefix', () => {
    it('tightens the limit to what fits under the real checkout directory', () => {
      const p = 'd'.repeat(150);
      expect(isWindowsUnsafePath(p)).toBe(false);
      expect(isWindowsUnsafePath(p, { prefixLength: 50 })).toBe(false);
      expect(isWindowsUnsafePath(p, { prefixLength: 120 })).toBe(true);
    });

    it('never loosens past the conservative default', () => {
      expect(isWindowsUnsafePath('d'.repeat(201), { prefixLength: 0 })).toBe(true);
    });
  });

  describe('isForeignAbsolutePath — every platform branch, testable from any machine', () => {
    it('win32: a posix-rooted path is foreign; a drive path is native', () => {
      expect(isForeignAbsolutePath('/home/teammate/app/x.ts', 'win32')).toBe(true);
      expect(isForeignAbsolutePath('/Users/teammate/app/x.ts', 'win32')).toBe(true);
      expect(isForeignAbsolutePath('/c/work/x.ts', 'win32')).toBe(true);
      expect(isForeignAbsolutePath('c:\\work\\app\\x.ts', 'win32')).toBe(false);
      expect(isForeignAbsolutePath('C:/work/app/x.ts', 'win32')).toBe(false);
    });

    it('win32: an ordinary Windows profile path is native in either slash style — "Users" is not a tell on Windows', () => {
      expect(isForeignAbsolutePath('C:\\Users\\me\\app\\x.ts', 'win32')).toBe(false);
      expect(isForeignAbsolutePath('C:/Users/me/app/x.ts', 'win32')).toBe(false);
      expect(isForeignAbsolutePath('\\\\server\\share\\app\\x.ts', 'win32')).toBe(false);
      expect(isForeignAbsolutePath('//server/share/app/x.ts', 'win32')).toBe(false);
    });

    it('win32: a Linux path resolved against the current drive (c:\\home\\...) is still recognized as foreign', () => {
      expect(isForeignAbsolutePath('c:\\home\\teammate\\app\\x.ts', 'win32')).toBe(true);
      expect(isForeignAbsolutePath('C:/home/teammate/app/x.ts', 'win32')).toBe(true);
    });

    it('darwin: a Linux path and a Windows path are foreign; a Mac path is native', () => {
      expect(isForeignAbsolutePath('/home/teammate/app/x.ts', 'darwin')).toBe(true);
      expect(isForeignAbsolutePath('/root/app/x.ts', 'darwin')).toBe(true);
      expect(isForeignAbsolutePath('C:\\work\\x.ts', 'darwin')).toBe(true);
      expect(isForeignAbsolutePath('c:/work/x.ts', 'darwin')).toBe(true);
      expect(isForeignAbsolutePath('/Users/me/app/x.ts', 'darwin')).toBe(false);
      expect(isForeignAbsolutePath('/opt/app/x.ts', 'darwin')).toBe(false);
    });

    it('linux: a Mac path and a Windows path are foreign; a Linux path is native', () => {
      expect(isForeignAbsolutePath('/Users/teammate/app/x.ts', 'linux')).toBe(true);
      expect(isForeignAbsolutePath('C:\\work\\x.ts', 'linux')).toBe(true);
      expect(isForeignAbsolutePath('x\\y.ts', 'linux')).toBe(true);
      expect(isForeignAbsolutePath('/home/me/app/x.ts', 'linux')).toBe(false);
      expect(isForeignAbsolutePath('/srv/app/x.ts', 'linux')).toBe(false);
    });
  });
});
