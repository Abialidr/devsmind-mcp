import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isAstParseable,
  normalizeFsPath,
  invalidateParsedFile,
  parseNodeId,
  enumerateFileCandidates,
  locateNodeInFile,
  extractNodeFromFile,
  findTouchedSymbols,
  listFileImports,
  detectRtkEndpointAliases,
  detectRtkEndpointNodes,
  outlineFile
} from '../../src/utils/ast';

const CORPUS = path.join(__dirname, '../fixtures/sampleCorpus');
const exportedPath = path.join(CORPUS, 'exported.ts');
const notExportedPath = path.join(CORPUS, 'notExported.ts');
const consumerPath = path.join(CORPUS, 'consumer.ts');
const rtkApiPath = path.join(CORPUS, 'rtkApi.ts');
const widgetPath = path.join(CORPUS, 'Widget.vue');
const pyPath = path.join(CORPUS, 'regex_fallback.py');

describe('isAstParseable', () => {
  it('accepts every extension in AST_PARSEABLE_EXTENSIONS', () => {
    expect(isAstParseable('a.ts')).toBe(true);
    expect(isAstParseable('a.tsx')).toBe(true);
    expect(isAstParseable('a.js')).toBe(true);
    expect(isAstParseable('a.jsx')).toBe(true);
    expect(isAstParseable('a.mjs')).toBe(true);
    expect(isAstParseable('a.cjs')).toBe(true);
    expect(isAstParseable('a.vue')).toBe(true);
    expect(isAstParseable('a.svelte')).toBe(true);
  });

  it('rejects a non-JS/TS extension like .py', () => {
    expect(isAstParseable(pyPath)).toBe(false);
  });

  it('is case-insensitive on the extension', () => {
    expect(isAstParseable('a.TS')).toBe(true);
  });
});

describe('normalizeFsPath', () => {
  it('lowercases and forward-slashes an absolute path', () => {
    const normalized = normalizeFsPath(exportedPath);
    expect(normalized).not.toMatch(/\\/);
    expect(normalized).toBe(normalized.toLowerCase());
  });

  it('resolves a relative path to an absolute one', () => {
    const normalized = normalizeFsPath('./tests/fixtures/sampleCorpus/exported.ts');
    expect(path.isAbsolute(normalized) || /^[a-z]:\//.test(normalized)).toBe(true);
  });
});

describe('invalidateParsedFile', () => {
  it('does not throw for a path never cached', () => {
    expect(() => invalidateParsedFile(path.join(CORPUS, 'never-parsed.ts'))).not.toThrow();
  });

  it('drops the cache so a subsequent read reflects a rewritten file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-invalidate-'));
    const file = path.join(tmp, 'x.ts');
    try {
      fs.writeFileSync(file, `export function original(): number { return 1; }\n`);
      expect(locateNodeInFile(file, 'original')).not.toBeNull();

      // Overwrite with different content but keep it plausible that mtime resolution could
      // coincide; explicit invalidation must make the change visible regardless.
      fs.writeFileSync(file, `export function replaced(): number { return 2; }\n`);
      invalidateParsedFile(file);
      expect(locateNodeInFile(file, 'replaced')).not.toBeNull();
      expect(locateNodeInFile(file, 'original')).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('parseNodeId', () => {
  it('parses a simple top-level id', () => {
    expect(parseNodeId('{app}/src/foo.ts#bar')).toEqual({
      repo: 'app',
      filePath: 'src/foo.ts',
      symbolName: 'bar'
    });
  });

  it('parses a dotted Class.method id into className/memberName', () => {
    expect(parseNodeId('{app}/src/foo.ts#Foo.bar')).toEqual({
      repo: 'app',
      filePath: 'src/foo.ts',
      symbolName: 'Foo.bar',
      className: 'Foo',
      memberName: 'bar'
    });
  });

  it('does not split a 3+ segment dotted id into className/memberName', () => {
    const parsed = parseNodeId('{app}/src/foo.ts#Foo.methods.bar');
    expect(parsed).toEqual({
      repo: 'app',
      filePath: 'src/foo.ts',
      symbolName: 'Foo.methods.bar'
    });
    expect(parsed?.className).toBeUndefined();
  });

  it('returns null for a malformed id', () => {
    expect(parseNodeId('not-a-valid-id')).toBeNull();
    expect(parseNodeId('{app}/src/foo.ts')).toBeNull(); // missing '#'
  });
});

describe('enumerateFileCandidates', () => {
  it('returns [] for a non-AST-parseable file', () => {
    expect(enumerateFileCandidates(pyPath)).toEqual([]);
  });

  it('returns [] for a file that does not exist', () => {
    expect(enumerateFileCandidates(path.join(CORPUS, 'does-not-exist.ts'))).toEqual([]);
  });

  it('enumerates exported.ts: every candidate is isExported:true with the correct type', () => {
    const candidates = enumerateFileCandidates(exportedPath);
    const byQualified = new Map(candidates.map(c => [c.qualified, c]));

    expect(byQualified.get('publicFn')).toMatchObject({ name: 'publicFn', type: 'function', isExported: true });
    expect(byQualified.get('PublicClass')).toMatchObject({ name: 'PublicClass', type: 'class', isExported: true });
    expect(byQualified.get('PublicClass.getValue')).toMatchObject({ name: 'getValue', type: 'method', isExported: true });
    expect(byQualified.get('PublicClass.setValue')).toMatchObject({ name: 'setValue', type: 'method', isExported: true });
    expect(byQualified.get('PublicInterface')).toMatchObject({ name: 'PublicInterface', type: 'interface', isExported: true });
    expect(byQualified.get('PublicAlias')).toMatchObject({ name: 'PublicAlias', type: 'type_alias', isExported: true });
    expect(byQualified.get('PublicEnum')).toMatchObject({ name: 'PublicEnum', type: 'enum', isExported: true });
    expect(byQualified.get('publicConst')).toMatchObject({ name: 'publicConst', type: 'variable', isExported: true });

    // Every candidate in this file is exported — nothing should have slipped through false.
    expect(candidates.every(c => c.isExported)).toBe(true);
  });

  it('gives every candidate a startLine <= endLine and a non-empty codeSnapshot', () => {
    for (const c of enumerateFileCandidates(exportedPath)) {
      expect(c.startLine).toBeLessThanOrEqual(c.endLine);
      expect(c.codeSnapshot.length).toBeGreaterThan(0);
    }
  });

  it('enumerates notExported.ts with a mix of isExported true/false', () => {
    const candidates = enumerateFileCandidates(notExportedPath);
    const byQualified = new Map(candidates.map(c => [c.qualified, c]));

    expect(byQualified.get('privateHelper')).toMatchObject({ type: 'function', isExported: false });
    expect(byQualified.get('InternalThing')).toMatchObject({ type: 'class', isExported: false });
    expect(byQualified.get('InternalThing.run')).toMatchObject({ type: 'method', isExported: false });
    expect(byQualified.get('localConst')).toMatchObject({ type: 'variable', isExported: false });
    // The one exported function in this file — same-file caller of the private helper.
    expect(byQualified.get('usesPrivateHelper')).toMatchObject({ type: 'function', isExported: true });

    const exportedFlags = candidates.map(c => c.isExported);
    expect(exportedFlags).toContain(true);
    expect(exportedFlags).toContain(false);
  });

  it('does not surface a declaration nested inside a function body as its own candidate', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-nested-'));
    try {
      const file = path.join(tmp, 'nested.ts');
      fs.writeFileSync(
        file,
        [
          'export function outer(): number {',
          '  const innerLocal = 5;',
          '  function innerFn() { return innerLocal; }',
          '  return innerFn();',
          '}'
        ].join('\n')
      );
      const candidates = enumerateFileCandidates(file);
      const qualifiedNames = candidates.map(c => c.qualified);
      expect(qualifiedNames).toEqual(['outer']);
      expect(qualifiedNames).not.toContain('innerLocal');
      expect(qualifiedNames).not.toContain('innerFn');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('isNodeExported: transitive case — a member of an exported const object literal is exported', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-transitive-'));
    try {
      const file = path.join(tmp, 'transitive.ts');
      fs.writeFileSync(
        file,
        [
          'export const api = {',
          '  foo() { return 1; }',
          '};',
          '',
          'const unexportedApi = {',
          '  bar() { return 2; }',
          '};'
        ].join('\n')
      );
      const candidates = enumerateFileCandidates(file);
      const byQualified = new Map(candidates.map(c => [c.qualified, c]));

      expect(byQualified.get('api')).toMatchObject({ isExported: true });
      // The transitive case: `foo` isn't itself marked `export`, but its container is.
      expect(byQualified.get('api.foo')).toMatchObject({ isExported: true });

      expect(byQualified.get('unexportedApi')).toMatchObject({ isExported: false });
      expect(byQualified.get('unexportedApi.bar')).toMatchObject({ isExported: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('finds widgetHelper inside a Vue SFC <script> block', () => {
    const candidates = enumerateFileCandidates(widgetPath);
    const widgetHelper = candidates.find(c => c.qualified === 'widgetHelper');
    expect(widgetHelper).toMatchObject({ type: 'function', isExported: true });
  });

  it('returns [] for regex_fallback.py (not in AST_PARSEABLE_EXTENSIONS)', () => {
    expect(enumerateFileCandidates(pyPath)).toEqual([]);
  });

  it('folds in RTK endpoint candidates alongside normal declarations', () => {
    const candidates = enumerateFileCandidates(rtkApiPath);
    const byQualified = new Map(candidates.map(c => [c.qualified, c]));
    expect(byQualified.get('getUser')).toMatchObject({ type: 'rtk_endpoint', isExported: true });
    expect(byQualified.get('updateUser')).toMatchObject({ type: 'rtk_endpoint', isExported: true });
    // The enclosing `api` const is still enumerated by the general declaration walk.
    expect(byQualified.get('api')).toMatchObject({ type: 'variable', isExported: true });
  });
});

describe('outlineFile', () => {
  it('lists every top-level declaration with a one-line signature and real line span', () => {
    const outline = outlineFile(exportedPath);
    expect(outline.length).toBeGreaterThan(0);
    const pub = outline.find(e => e.qualified === 'publicFn')!;
    expect(pub).toBeTruthy();
    expect(pub.exported).toBe(true);
    // The signature is derived from a bounded text slice, not the node's full source — the whole
    // point of outlineFile over enumerateFileCandidates is that it never materializes bodies.
    expect(pub.signature).not.toContain('\n');
    expect(pub.signature!.length).toBeLessThanOrEqual(200);
    expect(pub.start_line).toBeGreaterThan(0);
    expect(pub.end_line).toBeGreaterThanOrEqual(pub.start_line);
  });

  it('returns [] for a file no parser handles (.py), rather than claiming the file is empty', () => {
    expect(outlineFile(pyPath)).toEqual([]);
  });

  it('returns [] when the file cannot be read at all, instead of throwing', () => {
    // A .ts path that passes the extension check but does not exist — the outline is one section
    // of a composite get_node_code response, so a missing file must degrade, not fail the call.
    expect(outlineFile(path.join(CORPUS, 'no-such-file.ts'))).toEqual([]);
  });

  it('folds RTK endpoints in, which the general declaration walk structurally cannot see', () => {
    const outline = outlineFile(rtkApiPath);
    const byQualified = new Map(outline.map(e => [e.qualified, e]));
    expect(byQualified.get('getUser')).toMatchObject({ type: 'rtk_endpoint' });
    expect(byQualified.get('updateUser')).toMatchObject({ type: 'rtk_endpoint' });
    // The enclosing const is still there from the ordinary walk, and is not duplicated.
    expect(byQualified.get('api')).toBeTruthy();
    expect(outline.filter(e => e.qualified === 'getUser')).toHaveLength(1);
  });

  it('does not double-list a name the ordinary walk already found, when an RTK endpoint shares it', () => {
    // The two sources genuinely can collide — a file often exports a plain helper next to an
    // endpoint of the same concept name. The declaration walk wins, since it carries the real
    // line span; without the guard the outline would report one name twice with different spans.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-outline-'));
    const file = path.join(dir, 'collide.ts');
    try {
      fs.writeFileSync(file, [
        "import { createApi } from '@reduxjs/toolkit/query/react';",
        '',
        'export const getUser = (id: string) => id;',
        '',
        'export const api = createApi({',
        '  reducerPath: "api",',
        '  endpoints: (builder) => ({',
        '    getUser: builder.query({ query: (id: string) => `/users/${id}` })',
        '  })',
        '});',
        ''
      ].join('\n'));
      invalidateParsedFile(file);

      const outline = outlineFile(file);
      const getUserEntries = outline.filter(e => e.qualified === 'getUser');
      expect(getUserEntries).toHaveLength(1);
      // The declaration walk's entry is the one kept — not the RTK-derived one.
      expect(getUserEntries[0].type).not.toBe('rtk_endpoint');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('locateNodeInFile', () => {
  it('locates a top-level function and its span matches the real source substring', () => {
    const loc = locateNodeInFile(exportedPath, 'publicFn');
    expect(loc).not.toBeNull();
    expect(loc!.name).toBe('publicFn');
    expect(loc!.type).toBe('function');
    expect(loc!.start).toBeLessThan(loc!.end);
    expect(loc!.startLine).toBeLessThanOrEqual(loc!.endLine);

    const raw = fs.readFileSync(exportedPath, 'utf-8');
    expect(raw.slice(loc!.start, loc!.end)).toBe(loc!.codeSnapshot);
    expect(loc!.codeSnapshot).toContain('function publicFn');
  });

  it('locates a class method via a dotted Class.method symbol name', () => {
    const loc = locateNodeInFile(exportedPath, 'PublicClass.getValue');
    expect(loc).not.toBeNull();
    expect(loc!.name).toBe('getValue');
    expect(loc!.type).toBe('method');
    expect(loc!.start).toBeLessThan(loc!.end);
    // Indented inside the class body.
    expect(loc!.indent.length).toBeGreaterThan(0);

    const raw = fs.readFileSync(exportedPath, 'utf-8');
    expect(raw.slice(loc!.start, loc!.end)).toBe(loc!.codeSnapshot);
    expect(loc!.codeSnapshot).toContain('getValue()');
  });

  it('returns null when the symbol cannot be found', () => {
    expect(locateNodeInFile(exportedPath, 'noSuchSymbol')).toBeNull();
  });

  it('returns null for a non-AST-parseable file', () => {
    expect(locateNodeInFile(pyPath, 'compute_total')).toBeNull();
  });

  it('returns null (via catch) when the file does not exist on disk', () => {
    expect(locateNodeInFile(path.join(CORPUS, 'nope.ts'), 'anything')).toBeNull();
  });

  it('finds widgetHelper inside the masked Vue SFC script block, indexing the REAL file', () => {
    const loc = locateNodeInFile(widgetPath, 'widgetHelper');
    expect(loc).not.toBeNull();
    expect(loc!.name).toBe('widgetHelper');
    expect(loc!.type).toBe('function');

    const raw = fs.readFileSync(widgetPath, 'utf-8');
    // The span must index the untouched, real file content (masking only affects what the
    // parser sees, never the offsets it reports).
    expect(raw.slice(loc!.start, loc!.end)).toBe(loc!.codeSnapshot);
    expect(loc!.codeSnapshot).toContain('widgetHelper');
    expect(loc!.codeSnapshot).not.toContain('<template>');
  });
});

describe('extractNodeFromFile', () => {
  it('is a thin wrapper returning name/type/signature/codeSnapshot', () => {
    const extracted = extractNodeFromFile(exportedPath, 'publicFn');
    const loc = locateNodeInFile(exportedPath, 'publicFn')!;
    expect(extracted).toEqual({
      name: loc.name,
      type: loc.type,
      signature: loc.signature,
      codeSnapshot: loc.codeSnapshot
    });
  });

  it('returns null when the underlying location cannot be found', () => {
    expect(extractNodeFromFile(exportedPath, 'noSuchSymbol')).toBeNull();
    expect(extractNodeFromFile(pyPath, 'compute_total')).toBeNull();
  });
});

describe('findTouchedSymbols', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-touched-'));
    file = path.join(tmp, 'touched.ts');
    fs.writeFileSync(
      file,
      ['export function foo(): number {', '  return 1;', '}', '', 'export function bar(): number {', '  return 2;', '}', ''].join('\n')
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns [] for a non-AST-parseable file', () => {
    expect(findTouchedSymbols(path.join(tmp, 'x.py'), [{ start: 0, end: 5 }])).toEqual([]);
  });

  it('returns [] when ranges is empty', () => {
    expect(findTouchedSymbols(file, [])).toEqual([]);
  });

  it('reports isNew:true and codeBefore:null when the symbol is absent from beforeContent', () => {
    const loc = locateNodeInFile(file, 'foo')!;
    const beforeContent = ['export function bar(): number {', '  return 2;', '}', ''].join('\n');
    const touched = findTouchedSymbols(file, [{ start: loc.start, end: loc.end }], [], beforeContent);

    expect(touched).toHaveLength(1);
    expect(touched[0]).toMatchObject({
      symbolName: 'foo',
      name: 'foo',
      type: 'function',
      isNew: true,
      codeBefore: null
    });
    expect(touched[0].node_id).toBeUndefined();
  });

  it('reports isNew:false and the real diff when the before content already had a DIFFERENT version, matched via knownSymbols', () => {
    const loc = locateNodeInFile(file, 'foo')!;
    const beforeContent = [
      'export function foo(): number {',
      '  return 999;',
      '}',
      '',
      'export function bar(): number {',
      '  return 2;',
      '}',
      ''
    ].join('\n');
    const touched = findTouchedSymbols(
      file,
      [{ start: loc.start, end: loc.end }],
      [{ id: 'app#foo', symbolName: 'foo' }],
      beforeContent
    );

    expect(touched).toHaveLength(1);
    expect(touched[0]).toMatchObject({
      node_id: 'app#foo',
      symbolName: 'foo',
      isNew: false
    });
    expect(touched[0].codeBefore).toContain('999');
    expect(touched[0].codeBefore).not.toEqual(touched[0].codeSnapshot);
  });

  it('drops a declaration that is intersected but unchanged (before === after)', () => {
    const loc = locateNodeInFile(file, 'foo')!;
    const fullContent = fs.readFileSync(file, 'utf-8');
    const touched = findTouchedSymbols(file, [{ start: loc.start, end: loc.end }], [], fullContent);
    expect(touched).toEqual([]);
  });

  it('treats an omitted beforeContent as "nothing to compare against" — reports as new', () => {
    const loc = locateNodeInFile(file, 'foo')!;
    const touched = findTouchedSymbols(file, [{ start: loc.start, end: loc.end }]);
    expect(touched).toHaveLength(1);
    expect(touched[0].isNew).toBe(true);
    expect(touched[0].codeBefore).toBeNull();
  });

  it('collapses INNERMOST: a range spanning the whole class reports only the inner method that changed', () => {
    const classFile = path.join(tmp, 'cls.ts');
    fs.writeFileSync(
      classFile,
      ['export class Widget {', '  run(): number {', '    return 1;', '  }', '}', ''].join('\n')
    );
    const full = fs.readFileSync(classFile, 'utf-8');
    const touched = findTouchedSymbols(classFile, [{ start: 0, end: full.length }], [], '');
    // Both Widget and Widget.run overlap the full-file range; INNERMOST keeps only the method.
    const names = touched.map(t => t.symbolName);
    expect(names).toContain('Widget.run');
    expect(names).not.toContain('Widget');
  });
});

describe('listFileImports', () => {
  it('returns [] for a non-AST-parseable file', () => {
    expect(listFileImports(pyPath)).toEqual([]);
  });

  it('returns [] for a file that does not exist', () => {
    expect(listFileImports(path.join(CORPUS, 'nope.ts'))).toEqual([]);
  });

  it('extracts named imports from consumer.ts ({publicFn, PublicClass} from ./exported)', () => {
    const imports = listFileImports(consumerPath);
    expect(imports).toEqual([
      { importedName: 'publicFn', moduleSpecifier: './exported', isDefault: false },
      { importedName: 'PublicClass', moduleSpecifier: './exported', isDefault: false }
    ]);
  });

  it('distinguishes default, renamed-named, and namespace import shapes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-imports-'));
    try {
      const file = path.join(tmp, 'imports.ts');
      fs.writeFileSync(
        file,
        [
          "import DefaultThing from './x';",
          "import { NamedA, NamedB as Renamed } from './y';",
          "import * as NS from './z';"
        ].join('\n')
      );
      const imports = listFileImports(file);
      expect(imports).toEqual([
        { importedName: 'DefaultThing', moduleSpecifier: './x', isDefault: true },
        { importedName: 'NamedA', moduleSpecifier: './y', isDefault: false },
        { importedName: 'Renamed', moduleSpecifier: './y', isDefault: false },
        { importedName: 'NS', moduleSpecifier: './z', isDefault: false, isNamespace: true }
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('detectRtkEndpointAliases', () => {
  it('returns [] for a non-AST-parseable file', () => {
    expect(detectRtkEndpointAliases(pyPath)).toEqual([]);
  });

  it('returns [] for a file with no createApi/injectEndpoints call', () => {
    expect(detectRtkEndpointAliases(exportedPath)).toEqual([]);
  });

  it('derives getUser -> useGetUserQuery/useLazyGetUserQuery and updateUser -> useUpdateUserMutation', () => {
    const aliases = detectRtkEndpointAliases(rtkApiPath);
    expect(aliases).toEqual([
      { endpointName: 'getUser', aliases: ['useGetUserQuery', 'useLazyGetUserQuery'] },
      { endpointName: 'updateUser', aliases: ['useUpdateUserMutation'] }
    ]);
  });
});

describe('detectRtkEndpointNodes', () => {
  it('returns [] for a non-AST-parseable file', () => {
    expect(detectRtkEndpointNodes(pyPath)).toEqual([]);
  });

  it('produces rtk_endpoint candidates, isExported:true, for both endpoints', () => {
    const nodes = detectRtkEndpointNodes(rtkApiPath);
    expect(nodes).toHaveLength(2);
    const byQualified = new Map(nodes.map(n => [n.qualified, n]));

    expect(byQualified.get('getUser')).toMatchObject({ name: 'getUser', type: 'rtk_endpoint', isExported: true });
    expect(byQualified.get('updateUser')).toMatchObject({ name: 'updateUser', type: 'rtk_endpoint', isExported: true });
    for (const n of nodes) {
      expect(n.codeSnapshot.length).toBeGreaterThan(0);
      expect(n.startLine).toBeLessThanOrEqual(n.endLine);
    }
  });
});

describe('astBaseType: variable-declaration initializer shapes', () => {
  it('recognizes a function-expression initializer and a class-expression initializer, not just arrow functions', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-basetype-'));
    try {
      const file = path.join(tmp, 'initShapes.ts');
      fs.writeFileSync(
        file,
        [
          'export const fn = function () { return 1; };',
          'export const Cls = class { m() { return 1; } };',
          ''
        ].join('\n')
      );
      const candidates = enumerateFileCandidates(file);
      const byQualified = new Map(candidates.map(c => [c.qualified, c]));
      expect(byQualified.get('fn')).toMatchObject({ type: 'function' });
      expect(byQualified.get('Cls')).toMatchObject({ type: 'class' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('declarationNameOf: names the walk can\'t produce', () => {
  it('excludes an anonymous default-exported function (no name to enumerate under)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-anon-default-fn-'));
    try {
      const file = path.join(tmp, 'anonDefaultFn.ts');
      fs.writeFileSync(file, 'export default function () { return 1; }\n');
      expect(enumerateFileCandidates(file)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('excludes a top-level destructuring declaration (its `name` is a binding pattern, not an identifier)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-destructure-'));
    try {
      const file = path.join(tmp, 'destructure.ts');
      fs.writeFileSync(
        file,
        ['function getStuff() { return { a: 1, b: 2 }; }', 'export const { a, b } = getStuff();', ''].join('\n')
      );
      const candidates = enumerateFileCandidates(file);
      expect(candidates.map(c => c.qualified)).toEqual(['getStuff']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('excludes a class method with a computed name (no static name to enumerate under)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-computed-method-'));
    try {
      const file = path.join(tmp, 'computedMethod.ts');
      fs.writeFileSync(
        file,
        [
          "const key = 'dynamic';",
          'export class Foo {',
          '  [key]() { return 1; }',
          '  normal() { return 2; }',
          '}',
          ''
        ].join('\n')
      );
      const candidates = enumerateFileCandidates(file);
      const qualifiedNames = candidates.map(c => c.qualified);
      expect(qualifiedNames).toContain('Foo');
      expect(qualifiedNames).toContain('Foo.normal');
      expect(qualifiedNames).not.toContain('Foo.undefined');
      expect(qualifiedNames.filter(q => q.startsWith('Foo.'))).toEqual(['Foo.normal']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('locateNodeInFile: symbolName whose last dotted segment is empty', () => {
  it('falls back to the full symbolName as the reported `name` when the target is keyed by an empty string', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-emptykey-'));
    try {
      const file = path.join(tmp, 'emptyKey.ts');
      fs.writeFileSync(file, "const Foo = { '': function () { return 1; } };\n");
      // "Foo." (trailing dot) splits to ['Foo', ''] -> className 'Foo', member ''.
      const loc = locateNodeInFile(file, 'Foo.');
      expect(loc).not.toBeNull();
      expect(loc!.name).toBe('Foo.'); // parts[parts.length-1] ('') is falsy -> falls back to symbolName
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('navigateObjectPath: string-literal object keys', () => {
  it('navigates a segment keyed by a string literal, not just an identifier', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-strkey-'));
    try {
      const file = path.join(tmp, 'strKeyContainer.ts');
      fs.writeFileSync(
        file,
        ['Component({', "  'my-key': {", '    onTap() { return 1; }', '  }', '});', ''].join('\n')
      );
      const loc = locateNodeInFile(file, 'Component.my-key.onTap');
      expect(loc).not.toBeNull();
      expect(loc!.codeSnapshot).toContain('onTap() { return 1; }');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('findNodeInAst: a later same-named container candidate does not overwrite the first (still resolved via findInFrameworkContainer)', () => {
  it('keeps the first containerCandidate match, and still finds the member through the framework-container fallback', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-container-precedence-'));
    try {
      const file = path.join(tmp, 'precedence.ts');
      // An unrelated call (`otherCall()`) is visited first: it's a CallExpression with an
      // identifier callee, but the callee name doesn't match `className` ("Foo") — exercising
      // the mismatch case of the CallExpression containerCandidate clause. "Foo" the (empty)
      // function declaration is visited next and becomes containerCandidate; the later
      // `Foo({...})` call also matches by name but is skipped since containerCandidate is
      // already set. The member is still found because findInFrameworkContainer scans ALL
      // top-level factory calls independently of which declaration containerCandidate settled on.
      fs.writeFileSync(
        file,
        ['otherCall();', '', 'function Foo() {}', '', 'Foo({', '  bar() { return 1; }', '});', ''].join('\n')
      );
      const loc = locateNodeInFile(file, 'Foo.bar');
      expect(loc).not.toBeNull();
      expect(loc!.codeSnapshot).toContain('bar() { return 1; }');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('RTK endpoint detection: remaining loop branches', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-rtk-branches-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('toPascal leaves an empty-string endpoint key as-is (falsy-length branch)', () => {
    const file = path.join(tmp, 'emptyKeyEndpoint.ts');
    fs.writeFileSync(
      file,
      [
        "import { createApi } from '@reduxjs/toolkit/query/react';",
        'const api = createApi({',
        '  endpoints: (builder) => ({',
        "    '': builder.query(() => '/root')",
        '  })',
        '});',
        ''
      ].join('\n')
    );
    expect(detectRtkEndpointAliases(file)).toEqual([{ endpointName: '', aliases: ['useQuery', 'useLazyQuery'] }]);
  });

  it('skips a concise-body endpoints arrow whose expression is not an object literal', () => {
    const file = path.join(tmp, 'nonObjectArrow.ts');
    fs.writeFileSync(
      file,
      [
        "import { createApi } from '@reduxjs/toolkit/query/react';",
        'const api = createApi({',
        '  endpoints: (builder) => builder.thisIsNotAnObjectLiteral',
        '});',
        ''
      ].join('\n')
    );
    expect(detectRtkEndpointAliases(file)).toEqual([]);
  });

  it('skips an `endpoints` property whose initializer is neither an arrow function nor a function expression', () => {
    const file = path.join(tmp, 'nonFunctionEndpoints.ts');
    fs.writeFileSync(
      file,
      [
        "import { createApi } from '@reduxjs/toolkit/query/react';",
        'const notAFunction = {};',
        'const api = createApi({',
        '  endpoints: notAFunction',
        '});',
        ''
      ].join('\n')
    );
    expect(detectRtkEndpointAliases(file)).toEqual([]);
  });

  it('skips an endpoint with a computed property name, a method-shorthand endpoint, a call to a non-property-access, and a non-query/mutation builder method, while still finding the valid one', () => {
    const file = path.join(tmp, 'weirdEndpoints.ts');
    fs.writeFileSync(
      file,
      [
        "import { createApi } from '@reduxjs/toolkit/query/react';",
        "const dynamicKey = 'computed';",
        "function helperCall() { return null as any; }",
        'const api = createApi({',
        '  endpoints: (builder) => ({',
        "    [dynamicKey]: builder.query(() => '/computed'),",
        '    methodShorthand(builder) { return builder.query(() => \'/shorthand\'); },',
        '    callsHelper: helperCall(),',
        "    subscribes: builder.subscription(() => '/sub'),",
        "    getUser: builder.query(() => '/user')",
        '  })',
        '});',
        ''
      ].join('\n')
    );
    expect(detectRtkEndpointAliases(file)).toEqual([
      { endpointName: 'getUser', aliases: ['useGetUserQuery', 'useLazyGetUserQuery'] }
    ]);
  });
});

describe('findTouchedSymbols: additional branch coverage', () => {
  let tmp: string;
  let file: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-touched-branches-'));
    file = path.join(tmp, 'touched2.ts');
    fs.writeFileSync(file, ['// a leading comment', 'export function foo() {', '  return 1;', '}', ''].join('\n'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns [] when the edited range overlaps no declaration at all (e.g. just a comment)', () => {
    expect(findTouchedSymbols(file, [{ start: 0, end: 5 }])).toEqual([]);
  });

  it('dedupes two ranges that both land inside the same symbol into a single entry', () => {
    const loc = locateNodeInFile(file, 'foo')!;
    const midpoint = loc.start + Math.floor((loc.end - loc.start) / 2);
    const touched = findTouchedSymbols(file, [
      { start: loc.start, end: midpoint },
      { start: midpoint, end: loc.end }
    ]);
    expect(touched).toHaveLength(1);
    expect(touched[0].symbolName).toBe('foo');
  });

  it('dedupes two DIFFERENT symbols that resolve to the same known-symbol id (defensive: a caller-supplied knownSymbols collision), keeping only the first', () => {
    const twoFnFile = path.join(tmp, 'twoFns.ts');
    fs.writeFileSync(
      twoFnFile,
      ['export function foo() { return 1; }', '', 'export function bar() { return 2; }', ''].join('\n')
    );
    const fooLoc = locateNodeInFile(twoFnFile, 'foo')!;
    const barLoc = locateNodeInFile(twoFnFile, 'bar')!;
    // Both known-symbol entries share the same id — a shape a caller shouldn't normally produce,
    // but the "key" dedup guard exists precisely to keep this from yielding two TouchedSymbols
    // for what the caller's own bookkeeping considers a single graph node.
    const touched = findTouchedSymbols(
      twoFnFile,
      [
        { start: fooLoc.start, end: fooLoc.end },
        { start: barLoc.start, end: barLoc.end }
      ],
      [
        { id: 'shared-id', symbolName: 'foo' },
        { id: 'shared-id', symbolName: 'bar' }
      ]
    );
    expect(touched).toHaveLength(1);
    expect(touched[0].node_id).toBe('shared-id');
  });
});

describe('findNodeInAst: framework-route adapter (router.get("/path") style ids)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-route-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('locates the exact route registration call by method + path literal', () => {
    const file = path.join(tmp, 'routes.ts');
    fs.writeFileSync(
      file,
      [
        "router.get('/boxy/regions', (req, res) => { res.send('regions'); });",
        "router.get('/boxy/other', (req, res) => { res.send('other'); });",
        "router.post('/boxy/regions', (req, res) => { res.send('created'); });",
        ''
      ].join('\n')
    );
    const loc = locateNodeInFile(file, 'router.get("/boxy/regions")');
    expect(loc).not.toBeNull();
    expect(loc!.codeSnapshot).toContain("res.send('regions')");
    expect(loc!.codeSnapshot).not.toContain('other');
    expect(loc!.codeSnapshot).not.toContain('created');
  });

  it('falls through to the normal lookup when no route call matches the path literal', () => {
    const file = path.join(tmp, 'routes2.ts');
    fs.writeFileSync(file, "router.get('/boxy/regions', () => {});\n");
    // Well-formed route-id syntax, but no call registers this exact path -> findRouteCall
    // returns null and the general declaration walk (which also finds nothing) takes over.
    expect(locateNodeInFile(file, 'router.get("/no/such/path")')).toBeNull();
  });
});

describe('findNodeInAst: framework-container adapter (Component({...}) factory calls)', () => {
  let tmp: string;
  let file: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-container-'));
    file = path.join(tmp, 'miniprogram.ts');
    fs.writeFileSync(
      file,
      [
        'Component({',
        '  data: [1, 2, 3],',
        '  methods: {',
        '    onTap() { return 1; }',
        '  },',
        '  foo() { return 2; }',
        '});',
        ''
      ].join('\n')
    );
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('navigates the full dotted path through a nested object literal (methods.onTap)', () => {
    const loc = locateNodeInFile(file, 'Component.methods.onTap');
    expect(loc).not.toBeNull();
    expect(loc!.codeSnapshot).toContain('onTap() { return 1; }');
  });

  it('falls back to searching the whole container by last segment when a middle segment is not an object literal', () => {
    // "data" resolves but is an array, not a nested object literal, so navigateObjectPath
    // can't continue down to "foo" -> findInFrameworkContainer falls back to scanning the
    // whole container for a member literally named "foo".
    const loc = locateNodeInFile(file, 'Component.data.foo');
    expect(loc).not.toBeNull();
    expect(loc!.codeSnapshot).toContain('foo() { return 2; }');
  });

  it('returns null when neither the path nor the fallback last-segment search finds anything', () => {
    expect(locateNodeInFile(file, 'Component.missingKey.sub')).toBeNull();
  });

  it('also finds the container when the factory call is the expression of an `export default` (3+ segment id, forcing the findInFrameworkContainer path rather than the containerCandidate shortcut)', () => {
    const exportDefaultFile = path.join(tmp, 'exportdefault.ts');
    fs.writeFileSync(
      exportDefaultFile,
      ['export default Page({', '  methods: {', '    onLoad() { return 1; }', '  }', '});', ''].join('\n')
    );
    const loc = locateNodeInFile(exportDefaultFile, 'Page.methods.onLoad');
    expect(loc).not.toBeNull();
    expect(loc!.codeSnapshot).toContain('onLoad() { return 1; }');
  });
});

describe('findNodeInAst: non-class container fallback (containerCandidate via variable/function declarations)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-noncls-container-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('finds a member of a plain object assigned to a const (variable-declaration container), including a shorthand property', () => {
    const file = path.join(tmp, 'utils.ts');
    fs.writeFileSync(
      file,
      ['const shared = 5;', 'const utils = { shared, helper() { return 1; } };', ''].join('\n')
    );
    expect(locateNodeInFile(file, 'utils.shared')?.codeSnapshot).toBe('shared');
    expect(locateNodeInFile(file, 'utils.helper')?.codeSnapshot).toContain('helper() { return 1; }');
  });

  it('finds a nested function declared inside another top-level function (function-declaration container)', () => {
    const file = path.join(tmp, 'cartSidebar.ts');
    fs.writeFileSync(
      file,
      [
        'function CartSidebar() {',
        '  function handleClick() { return 1; }',
        '  return handleClick();',
        '}',
        ''
      ].join('\n')
    );
    const loc = locateNodeInFile(file, 'CartSidebar.handleClick');
    expect(loc).not.toBeNull();
    expect(loc!.codeSnapshot).toContain('function handleClick() { return 1; }');
  });
});

describe('findNodeInAst: plain top-level variable lookup (no className)', () => {
  it('locates a top-level const via a bare symbol name', () => {
    const loc = locateNodeInFile(exportedPath, 'publicConst');
    expect(loc).not.toBeNull();
    expect(loc!.type).toBe('variable');
  });
});

describe('RTK endpoint detection: additional AST shapes', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-rtk-extra-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('finds endpoints when the builder arrow function has a block body with a return statement', () => {
    const file = path.join(tmp, 'blockBody.ts');
    fs.writeFileSync(
      file,
      [
        "import { createApi } from '@reduxjs/toolkit/query/react';",
        'const api = createApi({',
        '  endpoints: (builder) => {',
        '    return {',
        "      getThing: builder.query(() => '/thing')",
        '    };',
        '  }',
        '});',
        ''
      ].join('\n')
    );
    const aliases = detectRtkEndpointAliases(file);
    expect(aliases).toEqual([{ endpointName: 'getThing', aliases: ['useGetThingQuery', 'useLazyGetThingQuery'] }]);
  });

  it('finds no endpoints when the block-bodied builder never returns an object literal', () => {
    const file = path.join(tmp, 'blockBodyNoObject.ts');
    fs.writeFileSync(
      file,
      [
        "import { createApi } from '@reduxjs/toolkit/query/react';",
        'const api = createApi({',
        '  endpoints: (builder) => {',
        '    const noop = 1;',
        '    return noop;',
        '  }',
        '});',
        ''
      ].join('\n')
    );
    expect(detectRtkEndpointAliases(file)).toEqual([]);
  });

  it('skips a non-property-assignment entry (e.g. a spread) inside the endpoints object without crashing', () => {
    const file = path.join(tmp, 'spread.ts');
    fs.writeFileSync(
      file,
      [
        "import { createApi } from '@reduxjs/toolkit/query/react';",
        'const extra = {};',
        'const api = createApi({',
        '  endpoints: (builder) => ({',
        "    getUser: builder.query(() => '/user'),",
        '    ...extra',
        '  })',
        '});',
        ''
      ].join('\n')
    );
    const aliases = detectRtkEndpointAliases(file);
    expect(aliases).toEqual([{ endpointName: 'getUser', aliases: ['useGetUserQuery', 'useLazyGetUserQuery'] }]);
  });

  it('detectRtkEndpointAliases/Nodes swallow a parse failure (e.g. reading a directory) and return []', () => {
    const dirAsFile = path.join(tmp, 'weird.ts');
    fs.mkdirSync(dirAsFile);
    expect(() => detectRtkEndpointAliases(dirAsFile)).not.toThrow();
    expect(detectRtkEndpointAliases(dirAsFile)).toEqual([]);
    expect(() => detectRtkEndpointNodes(dirAsFile)).not.toThrow();
    expect(detectRtkEndpointNodes(dirAsFile)).toEqual([]);
  });
});

describe('isNodeExported: additional cases', () => {
  it('a member whose only container is a bare factory call (no variable/export anywhere) is not exported', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-notexported-container-'));
    try {
      const file = path.join(tmp, 'miniprogram.ts');
      fs.writeFileSync(file, ['Component({', '  methods: {', '    onTap() { return 1; }', '  }', '});', ''].join('\n'));
      const candidates = enumerateFileCandidates(file);
      const byQualified = new Map(candidates.map(c => [c.qualified, c]));
      // declarationNameOf qualifies by the nearest named container reached while walking up
      // (the CallExpression `Component(...)`), not the full dotted path a lookup would use.
      expect(byQualified.get('Component.onTap')).toMatchObject({ isExported: false, name: 'onTap' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('recognizes a declaration exported via a renamed `export { local as public }` statement', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-renamed-export-'));
    try {
      const file = path.join(tmp, 'renamed.ts');
      fs.writeFileSync(
        file,
        [
          'function secretHelper() { return 1; }',
          'function anotherFn() { return 2; }',
          'export { secretHelper as publicHelper, anotherFn };',
          ''
        ].join('\n')
      );
      const candidates = enumerateFileCandidates(file);
      const byQualified = new Map(candidates.map(c => [c.qualified, c]));
      expect(byQualified.get('secretHelper')).toMatchObject({ isExported: true });
      expect(byQualified.get('anotherFn')).toMatchObject({ isExported: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('declarationNameOf: walk-up-to-container edge cases', () => {
  it('qualifies a method nested inside a class-FIELD object literal by walking up to the enclosing class (not just a direct class-member)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-classfield-'));
    try {
      const file = path.join(tmp, 'classFieldContainer.ts');
      fs.writeFileSync(
        file,
        ['export class Widget {', '  handlers = {', '    onTap() { return 1; }', '  };', '}', ''].join('\n')
      );
      const candidates = enumerateFileCandidates(file);
      const byQualified = new Map(candidates.map(c => [c.qualified, c]));
      // "onTap" isn't a direct class member (it's nested one object-literal level below the
      // `handlers` field), so declarationNameOf reaches it via the walk-up-to-container loop's
      // isClassLike(cur) branch, not the direct node.parent-is-ClassLike check.
      expect(byQualified.get('Widget.onTap')).toMatchObject({ name: 'onTap', type: 'method' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('qualifies a method by its own name alone when no named container is found anywhere up the tree', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-unnamed-container-'));
    try {
      const file = path.join(tmp, 'unnamedContainer.ts');
      fs.writeFileSync(file, ['({', '  nested: {', '    helper() { return 1; }', '  }', '});', ''].join('\n'));
      const candidates = enumerateFileCandidates(file);
      const byQualified = new Map(candidates.map(c => [c.qualified, c]));
      // The bare object literal is never assigned, called, or classed — walking all the way up
      // finds no named container, so the qualified name falls back to the member name alone.
      expect(byQualified.get('helper')).toMatchObject({ name: 'helper', type: 'method', isExported: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('findTouchedSymbols: parse-failure catch', () => {
  it('returns [] rather than throwing when the file cannot be read (e.g. does not exist)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-touched-catch-'));
    try {
      const ghost = path.join(tmp, 'ghost.ts');
      expect(() => findTouchedSymbols(ghost, [{ start: 0, end: 5 }])).not.toThrow();
      expect(findTouchedSymbols(ghost, [{ start: 0, end: 5 }])).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('regex_fallback.py — non-JS/TS fallback path behaves sanely', () => {
  it('is not AST-parseable', () => {
    expect(isAstParseable(pyPath)).toBe(false);
  });

  it('enumerateFileCandidates / locateNodeInFile / extractNodeFromFile / listFileImports all return empty/null rather than throwing', () => {
    expect(() => enumerateFileCandidates(pyPath)).not.toThrow();
    expect(enumerateFileCandidates(pyPath)).toEqual([]);

    expect(() => locateNodeInFile(pyPath, 'compute_total')).not.toThrow();
    expect(locateNodeInFile(pyPath, 'compute_total')).toBeNull();

    expect(() => extractNodeFromFile(pyPath, 'compute_total')).not.toThrow();
    expect(extractNodeFromFile(pyPath, 'compute_total')).toBeNull();

    expect(() => listFileImports(pyPath)).not.toThrow();
    expect(listFileImports(pyPath)).toEqual([]);
  });
});
