import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveConnectionsLocally, MissingRef } from '../../src/utils/ast';

const CORPUS = path.join(__dirname, '../fixtures/sampleCorpus');

/** Candidate-node shape resolveConnectionsLocally expects (mirrors src/db/edges.ts's usage). */
interface CandidateNode {
  id: string;
  name: string;
  type: string;
  file_path: string;
  aliases?: string[];
}

/**
 * Copies the sample corpus into a throwaway temp dir with a minimal `.devmind/config.json`
 * (embedded mode, one repo named "app" at `<root>/src`) so the tests are isolated from each
 * other and never write into tests/fixtures. Returns the paths resolveConnectionsLocally needs.
 */
function setupCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-edges-'));
  const srcDir = path.join(root, 'src');
  fs.cpSync(CORPUS, srcDir, { recursive: true });
  const devmindPath = path.join(root, '.devmind');
  fs.mkdirSync(devmindPath, { recursive: true });
  fs.writeFileSync(
    path.join(devmindPath, 'config.json'),
    JSON.stringify(
      { project_name: 'edges-fixture', mode: 'embedded', repos: [{ name: 'app', relative_path: 'src' }] },
      null,
      2
    )
  );
  return {
    root,
    srcDir,
    devmindPath,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    file: (rel: string) => path.join(srcDir, rel)
  };
}

describe('resolveConnectionsLocally', () => {
  let ctx: ReturnType<typeof setupCorpus>;
  let nodes: CandidateNode[];

  beforeEach(() => {
    ctx = setupCorpus();
    nodes = [
      { id: '{app}/exported.ts#publicFn', name: 'publicFn', type: 'function', file_path: ctx.file('exported.ts') },
      { id: '{app}/exported.ts#PublicClass', name: 'PublicClass', type: 'class', file_path: ctx.file('exported.ts') },
      { id: '{app}/exported.ts#PublicClass.getValue', name: 'getValue', type: 'method', file_path: ctx.file('exported.ts') },
      { id: '{app}/exported.ts#PublicClass.setValue', name: 'setValue', type: 'method', file_path: ctx.file('exported.ts') },
      { id: '{app}/exported.ts#PublicInterface', name: 'PublicInterface', type: 'interface', file_path: ctx.file('exported.ts') },
      { id: '{app}/notExported.ts#privateHelper', name: 'privateHelper', type: 'function', file_path: ctx.file('notExported.ts') },
      { id: '{app}/notExported.ts#InternalThing', name: 'InternalThing', type: 'class', file_path: ctx.file('notExported.ts') },
      { id: '{app}/notExported.ts#usesPrivateHelper', name: 'usesPrivateHelper', type: 'function', file_path: ctx.file('notExported.ts') },
      { id: '{app}/consumer.ts#consumeExported', name: 'consumeExported', type: 'function', file_path: ctx.file('consumer.ts') },
      { id: '{app}/lib/impl.ts#barrelFn', name: 'barrelFn', type: 'function', file_path: ctx.file('lib/impl.ts') },
      { id: '{app}/lib/impl.ts#BarrelClass', name: 'BarrelClass', type: 'class', file_path: ctx.file('lib/impl.ts') },
      { id: '{app}/lib/impl.ts#BarrelClass.op', name: 'op', type: 'method', file_path: ctx.file('lib/impl.ts') },
      { id: '{app}/lib/extra.ts#extraFn', name: 'extraFn', type: 'function', file_path: ctx.file('lib/extra.ts') },
      { id: '{app}/barrelConsumer.ts#useBarrel', name: 'useBarrel', type: 'function', file_path: ctx.file('barrelConsumer.ts') },
      {
        id: '{app}/rtkApi.ts#getUser',
        name: 'getUser',
        type: 'rtk_endpoint',
        file_path: ctx.file('rtkApi.ts'),
        aliases: ['useGetUserQuery', 'useLazyGetUserQuery']
      },
      {
        id: '{app}/rtkApi.ts#updateUser',
        name: 'updateUser',
        type: 'rtk_endpoint',
        file_path: ctx.file('rtkApi.ts'),
        aliases: ['useUpdateUserMutation']
      }
    ];
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('returns [] when the source node id cannot be parsed', () => {
    const result = resolveConnectionsLocally('not-a-valid-id', ctx.file('notExported.ts'), nodes, ctx.devmindPath);
    expect(result).toEqual([]);
  });

  it('returns [] when the source file does not exist on disk', () => {
    const result = resolveConnectionsLocally(
      '{app}/ghost.ts#ghostFn',
      ctx.file('ghost.ts'),
      nodes,
      ctx.devmindPath
    );
    expect(result).toEqual([]);
  });

  it('same-file reference: usesPrivateHelper links to the non-exported privateHelper it calls', () => {
    const result = resolveConnectionsLocally(
      '{app}/notExported.ts#usesPrivateHelper',
      ctx.file('notExported.ts'),
      nodes,
      ctx.devmindPath
    );
    expect(result).toEqual(['{app}/notExported.ts#privateHelper']);
  });

  it('same-file: a symbol not referenced anywhere in scope gets no same-file link', () => {
    // InternalThing is declared in notExported.ts but never touched by usesPrivateHelper.
    const result = resolveConnectionsLocally(
      '{app}/notExported.ts#usesPrivateHelper',
      ctx.file('notExported.ts'),
      nodes,
      ctx.devmindPath
    );
    expect(result).not.toContain('{app}/notExported.ts#InternalThing');
  });

  it('cross-file import: consumeExported links to publicFn and PublicClass (imported and referenced)', () => {
    const result = resolveConnectionsLocally(
      '{app}/consumer.ts#consumeExported',
      ctx.file('consumer.ts'),
      nodes,
      ctx.devmindPath
    );
    expect(result).toEqual(
      expect.arrayContaining(['{app}/exported.ts#publicFn', '{app}/exported.ts#PublicClass'])
    );
  });

  it('cross-file class-member gating: PublicClass.setValue/getValue link because the class is both imported+referenced AND each method is referenced', () => {
    // consumeExported does `new PublicClass(x)` then `inst.setValue(...)` / `inst.getValue()` —
    // both the class name and each member name appear as free references, so the source's real
    // gating rule (see resolveConnectionsLocally's className/memberName branch) is satisfied.
    const result = resolveConnectionsLocally(
      '{app}/consumer.ts#consumeExported',
      ctx.file('consumer.ts'),
      nodes,
      ctx.devmindPath
    );
    expect(result).toEqual(
      expect.arrayContaining(['{app}/exported.ts#PublicClass.setValue', '{app}/exported.ts#PublicClass.getValue'])
    );
  });

  it('cross-file class-member gating: an imported-but-unreferenced class member does NOT link', () => {
    // PublicInterface is not imported/referenced by consumer.ts at all.
    const result = resolveConnectionsLocally(
      '{app}/consumer.ts#consumeExported',
      ctx.file('consumer.ts'),
      nodes,
      ctx.devmindPath
    );
    expect(result).not.toContain('{app}/exported.ts#PublicInterface');
  });

  it('barrel re-export: useBarrel links to lib/impl.ts\'s barrelFn and BarrelClass, resolved through the lib/index.ts barrel', () => {
    const result = resolveConnectionsLocally(
      '{app}/barrelConsumer.ts#useBarrel',
      ctx.file('barrelConsumer.ts'),
      nodes,
      ctx.devmindPath
    );
    expect(result).toEqual(
      expect.arrayContaining(['{app}/lib/impl.ts#barrelFn', '{app}/lib/impl.ts#BarrelClass'])
    );
  });

  it('barrel re-export: does not link the OTHER barrel file\'s (extra.ts) unrelated export', () => {
    const result = resolveConnectionsLocally(
      '{app}/barrelConsumer.ts#useBarrel',
      ctx.file('barrelConsumer.ts'),
      nodes,
      ctx.devmindPath
    );
    expect(result).not.toContain('{app}/lib/extra.ts#extraFn');
  });

  it('RTK hook alias: a caller importing/calling useGetUserQuery links to the getUser endpoint node via its alias', () => {
    const consumerFile = ctx.file('rtkConsumer.ts');
    fs.writeFileSync(
      consumerFile,
      [
        "import { useGetUserQuery } from './rtkApi';",
        '',
        'export function useUserWidget(id: string) {',
        '  const { data } = useGetUserQuery(id);',
        '  return data;',
        '}',
        ''
      ].join('\n')
    );

    const result = resolveConnectionsLocally(
      '{app}/rtkConsumer.ts#useUserWidget',
      consumerFile,
      nodes,
      ctx.devmindPath
    );
    expect(result).toEqual(['{app}/rtkApi.ts#getUser']);
  });

  it('RTK hook alias: does not also link the sibling updateUser mutation endpoint', () => {
    const consumerFile = ctx.file('rtkConsumer.ts');
    fs.writeFileSync(
      consumerFile,
      [
        "import { useGetUserQuery } from './rtkApi';",
        '',
        'export function useUserWidget(id: string) {',
        '  const { data } = useGetUserQuery(id);',
        '  return data;',
        '}',
        ''
      ].join('\n')
    );

    const result = resolveConnectionsLocally(
      '{app}/rtkConsumer.ts#useUserWidget',
      consumerFile,
      nodes,
      ctx.devmindPath
    );
    expect(result).not.toContain('{app}/rtkApi.ts#updateUser');
  });

  describe('isolation-failure conservatism', () => {
    it('suppresses the same-file link when the source symbol cannot be isolated (whole-file scan)', () => {
      // `NoSuchSymbol` does not exist in notExported.ts, so findNodeInAst returns null and the
      // resolver falls back to a whole-file scan with isolationFailed=true. Even though
      // "privateHelper" is textually present in the file, same-file links must be suppressed.
      const result = resolveConnectionsLocally(
        '{app}/notExported.ts#NoSuchSymbol',
        ctx.file('notExported.ts'),
        nodes,
        ctx.devmindPath
      );
      expect(result).not.toContain('{app}/notExported.ts#privateHelper');
      expect(result).not.toContain('{app}/notExported.ts#InternalThing');
    });

    it('suppresses the no-import "long name, same repo" fallback link when isolation fails, but allows it when isolation succeeds', () => {
      const callerFile = ctx.file('fallbackCaller.ts');
      fs.writeFileSync(
        callerFile,
        [
          'export function fallbackCaller(): void {',
          '  doSomethingLongNamed();',
          '}',
          ''
        ].join('\n')
      );
      const fallbackTarget: CandidateNode = {
        id: '{app}/lib/impl.ts#doSomethingLongNamed',
        name: 'doSomethingLongNamed',
        type: 'function',
        file_path: ctx.file('lib/impl.ts')
      };
      const localNodes = [...nodes, fallbackTarget];

      // Isolation succeeds (fallbackCaller is found): the >=16-char, same-repo, no-import
      // fallback branch fires.
      const okResult = resolveConnectionsLocally(
        '{app}/fallbackCaller.ts#fallbackCaller',
        callerFile,
        localNodes,
        ctx.devmindPath
      );
      expect(okResult).toEqual(['{app}/lib/impl.ts#doSomethingLongNamed']);

      // Isolation fails (symbol not found -> whole-file scan): the same fallback branch is
      // gated off entirely, so nothing links even though the name is textually present.
      const failedResult = resolveConnectionsLocally(
        '{app}/fallbackCaller.ts#NoSuchSymbol',
        callerFile,
        localNodes,
        ctx.devmindPath
      );
      expect(failedResult).toEqual([]);
    });
  });

  describe('onMissing callback', () => {
    it('fires with the target file + symbol when an imported, referenced name has no matching candidate node', () => {
      // Drop PublicClass (and its members) from the candidate set entirely: consumeExported
      // still imports + references PublicClass, and exported.ts really exists on disk, so this
      // is exactly the Phase-1 gap finalizeMissingNodes exists to fill.
      const nodesWithoutPublicClass = nodes.filter(n => !n.id.includes('#PublicClass'));
      const missing: MissingRef[] = [];

      const result = resolveConnectionsLocally(
        '{app}/consumer.ts#consumeExported',
        ctx.file('consumer.ts'),
        nodesWithoutPublicClass,
        ctx.devmindPath,
        rec => missing.push(rec)
      );

      expect(result).toEqual(['{app}/exported.ts#publicFn']);
      expect(missing).toHaveLength(1);
      expect(missing[0].sourceNodeId).toBe('{app}/consumer.ts#consumeExported');
      expect(missing[0].name).toBe('PublicClass');
      expect(path.resolve(missing[0].targetFile)).toBe(path.resolve(ctx.file('exported.ts')));
    });

    it('does not fire when every imported, referenced name already has a matching candidate node', () => {
      const missing: MissingRef[] = [];
      resolveConnectionsLocally(
        '{app}/consumer.ts#consumeExported',
        ctx.file('consumer.ts'),
        nodes, // full node set — publicFn AND PublicClass both present
        ctx.devmindPath,
        rec => missing.push(rec)
      );
      expect(missing).toEqual([]);
    });

    it('is never called when isolation failed', () => {
      const nodesWithoutPublicClass = nodes.filter(n => !n.id.includes('#PublicClass'));
      const missing: MissingRef[] = [];
      resolveConnectionsLocally(
        '{app}/consumer.ts#NoSuchSymbol',
        ctx.file('consumer.ts'),
        nodesWithoutPublicClass,
        ctx.devmindPath,
        rec => missing.push(rec)
      );
      expect(missing).toEqual([]);
    });
  });

  it('gracefully falls back to an empty repo root when devmindPath has no config.json (loadProjectContext throws)', () => {
    const badDevmindPath = path.join(ctx.root, 'no-such-devmind');
    // Relative imports (as used throughout the sample corpus) don't depend on repoRoot at all,
    // so resolution should still succeed even though the config load internally fails and is
    // swallowed.
    const result = resolveConnectionsLocally(
      '{app}/notExported.ts#usesPrivateHelper',
      ctx.file('notExported.ts'),
      nodes,
      badDevmindPath
    );
    expect(result).toEqual(['{app}/notExported.ts#privateHelper']);
  });

  it('ignores a candidate whose id equals the source node id', () => {
    const selfNode: CandidateNode = {
      id: '{app}/notExported.ts#usesPrivateHelper',
      name: 'usesPrivateHelper',
      type: 'function',
      file_path: ctx.file('notExported.ts')
    };
    const result = resolveConnectionsLocally(
      '{app}/notExported.ts#usesPrivateHelper',
      ctx.file('notExported.ts'),
      [...nodes, selfNode],
      ctx.devmindPath
    );
    expect(result).not.toContain('{app}/notExported.ts#usesPrivateHelper');
  });

  it('skips a candidate node whose own id is unparseable', () => {
    const badNode: CandidateNode = {
      id: 'totally-invalid',
      name: 'privateHelper',
      type: 'function',
      file_path: ctx.file('notExported.ts')
    };
    const result = resolveConnectionsLocally(
      '{app}/notExported.ts#usesPrivateHelper',
      ctx.file('notExported.ts'),
      [...nodes, badNode],
      ctx.devmindPath
    );
    expect(result).not.toContain('totally-invalid');
    // The real privateHelper candidate should still resolve normally.
    expect(result).toContain('{app}/notExported.ts#privateHelper');
  });

  it('handles a non-AST-parseable source file via the regex-fallback path without throwing', () => {
    const pyFile = ctx.file('regex_fallback.py');
    expect(() =>
      resolveConnectionsLocally('{app}/regex_fallback.py#compute_total', pyFile, nodes, ctx.devmindPath)
    ).not.toThrow();
    // Non-JS/TS sources always fail isolation (regex, whole-file) — same-file/no-import links
    // are suppressed just like the TS isolation-failure case.
    const result = resolveConnectionsLocally('{app}/regex_fallback.py#compute_total', pyFile, nodes, ctx.devmindPath);
    expect(result).toEqual([]);
  });

  describe('JSX fallback scan (collectReferencedNames on a .tsx whole-file isolation-failure scan)', () => {
    it('does not throw when the whole-file scan walks JSX opening and self-closing elements', () => {
      const file = ctx.file('comp.tsx');
      fs.writeFileSync(
        file,
        [
          "import React from 'react';",
          '',
          'export function Widget() {',
          '  return <Foo bar={1}><Baz /></Foo>;',
          '}',
          ''
        ].join('\n')
      );
      // "NoSuchSymbol" doesn't exist -> findNodeInAst fails -> collectReferencedNames scans the
      // whole file, which is the only path that visits JsxOpeningElement/JsxSelfClosingElement.
      expect(() =>
        resolveConnectionsLocally('{app}/comp.tsx#NoSuchSymbol', file, nodes, ctx.devmindPath)
      ).not.toThrow();
      const result = resolveConnectionsLocally('{app}/comp.tsx#NoSuchSymbol', file, nodes, ctx.devmindPath);
      expect(result).toEqual([]);
    });
  });

  describe('this.<member> sibling-method matching', () => {
    it('links a method to a sibling method it calls via this.<member>()', () => {
      const file = ctx.file('thisSibling.ts');
      fs.writeFileSync(
        file,
        [
          'export class Widget {',
          '  run(): number {',
          '    return this.helper();',
          '  }',
          '  helper(): number {',
          '    return 1;',
          '  }',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/thisSibling.ts#Widget.run', name: 'run', type: 'method', file_path: file },
        { id: '{app}/thisSibling.ts#Widget.helper', name: 'helper', type: 'method', file_path: file }
      ];
      const result = resolveConnectionsLocally('{app}/thisSibling.ts#Widget.run', file, localNodes, ctx.devmindPath);
      expect(result).toEqual(['{app}/thisSibling.ts#Widget.helper']);
    });
  });

  describe('qualified type names and namespace-import matching', () => {
    it('a qualified type reference (NS.Thing) is a free reference, matching a namespace-imported top-level symbol', () => {
      const typesFile = ctx.file('nsTypes.ts');
      fs.writeFileSync(typesFile, 'export interface Thing { id: string; }\n');
      const consumerFile = ctx.file('nsConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import * as NS from './nsTypes';",
          '',
          'export function useThing(): NS.Thing {',
          '  return {} as NS.Thing;',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/nsTypes.ts#Thing', name: 'Thing', type: 'interface', file_path: typesFile }
      ];
      const result = resolveConnectionsLocally('{app}/nsConsumer.ts#useThing', consumerFile, localNodes, ctx.devmindPath);
      expect(result).toContain('{app}/nsTypes.ts#Thing');
    });

    it('namespace import: `NS.method` matches a class-member target purely on the member name (no class reference required)', () => {
      const consumerFile = ctx.file('nsClassConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import * as NS from './exported';",
          '',
          'export function useNsClass() {',
          '  return NS.getValue;',
          '}',
          ''
        ].join('\n')
      );
      const result = resolveConnectionsLocally('{app}/nsClassConsumer.ts#useNsClass', consumerFile, nodes, ctx.devmindPath);
      expect(result).toContain('{app}/exported.ts#PublicClass.getValue');
    });
  });

  describe('default-export matching: all getDefaultExportName shapes', () => {
    it('named identifier default export (`export default Base;`), renamed import matches the declared name', () => {
      const targetFile = ctx.file('defaultIdentifier.ts');
      fs.writeFileSync(targetFile, ['function Base() { return 1; }', 'export default Base;', ''].join('\n'));
      const consumerFile = ctx.file('defaultIdentifierConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import runBase from './defaultIdentifier';",
          '',
          'export function useRunBase() {',
          '  return runBase();',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/defaultIdentifier.ts#Base', name: 'Base', type: 'function', file_path: targetFile }
      ];
      const result = resolveConnectionsLocally(
        '{app}/defaultIdentifierConsumer.ts#useRunBase',
        consumerFile,
        localNodes,
        ctx.devmindPath
      );
      expect(result).toEqual(['{app}/defaultIdentifier.ts#Base']);
    });

    it('anonymous default export (object literal), alias matches the node name case-insensitively', () => {
      const targetFile = ctx.file('defaultAnonExpr.ts');
      fs.writeFileSync(targetFile, "export default { greeting: 'hi' };\n");
      const consumerFile = ctx.file('defaultAnonExprConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import config from './defaultAnonExpr';",
          '',
          'export function useConfig() {',
          '  return config;',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/defaultAnonExpr.ts#Config', name: 'Config', type: 'variable', file_path: targetFile }
      ];
      const result = resolveConnectionsLocally(
        '{app}/defaultAnonExprConsumer.ts#useConfig',
        consumerFile,
        localNodes,
        ctx.devmindPath
      );
      expect(result).toEqual(['{app}/defaultAnonExpr.ts#Config']);
    });

    it('named default class declaration, renamed import + method reference matches the class-scoped renamed-default branch', () => {
      const targetFile = ctx.file('defaultClassDecl.ts');
      fs.writeFileSync(targetFile, ['export default class Foo {', '  bar() { return 1; }', '}', ''].join('\n'));
      const consumerFile = ctx.file('defaultClassDeclConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import Widget from './defaultClassDecl';",
          '',
          'export function useWidget() {',
          '  const w = new Widget();',
          '  return w.bar();',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/defaultClassDecl.ts#Foo.bar', name: 'bar', type: 'method', file_path: targetFile }
      ];
      const result = resolveConnectionsLocally(
        '{app}/defaultClassDeclConsumer.ts#useWidget',
        consumerFile,
        localNodes,
        ctx.devmindPath
      );
      expect(result).toEqual(['{app}/defaultClassDecl.ts#Foo.bar']);
    });

    it('anonymous default class declaration, alias matches the node\'s className case-insensitively', () => {
      const targetFile = ctx.file('defaultAnonClassDecl.ts');
      fs.writeFileSync(targetFile, ['export default class {', '  bar() { return 1; }', '}', ''].join('\n'));
      const consumerFile = ctx.file('defaultAnonClassDeclConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import handler from './defaultAnonClassDecl';",
          '',
          'export function useHandler() {',
          '  const h = new handler();',
          '  return h.bar();',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/defaultAnonClassDecl.ts#Handler.bar', name: 'bar', type: 'method', file_path: targetFile }
      ];
      const result = resolveConnectionsLocally(
        '{app}/defaultAnonClassDeclConsumer.ts#useHandler',
        consumerFile,
        localNodes,
        ctx.devmindPath
      );
      expect(result).toEqual(['{app}/defaultAnonClassDecl.ts#Handler.bar']);
    });

    it('`export { X as default }` resolves the default export to X\'s declared name', () => {
      const targetFile = ctx.file('defaultExportSpecifier.ts');
      fs.writeFileSync(
        targetFile,
        ['function Widget2() { return 1; }', 'export { Widget2 as default };', ''].join('\n')
      );
      const consumerFile = ctx.file('defaultExportSpecifierConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import w2 from './defaultExportSpecifier';",
          '',
          'export function useW2() {',
          '  return w2();',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/defaultExportSpecifier.ts#Widget2', name: 'Widget2', type: 'function', file_path: targetFile }
      ];
      const result = resolveConnectionsLocally(
        '{app}/defaultExportSpecifierConsumer.ts#useW2',
        consumerFile,
        localNodes,
        ctx.devmindPath
      );
      expect(result).toEqual(['{app}/defaultExportSpecifier.ts#Widget2']);
    });

    it('tiny anon-default file heuristic: links even when the alias does NOT match the node name, as long as the file has <=3 nodes', () => {
      const targetFile = ctx.file('joiSchema.ts');
      fs.writeFileSync(targetFile, 'export default { min: 1, max: 10 };\n');
      const consumerFile = ctx.file('joiSchemaConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import mySchema from './joiSchema';",
          '',
          'export function useSchema() {',
          '  return mySchema;',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/joiSchema.ts#default', name: 'default', type: 'variable', file_path: targetFile }
      ];
      const result = resolveConnectionsLocally(
        '{app}/joiSchemaConsumer.ts#useSchema',
        consumerFile,
        localNodes,
        ctx.devmindPath
      );
      expect(result).toEqual(['{app}/joiSchema.ts#default']);
    });

    it('the tiny-file heuristic does NOT fire once the file has more than 3 nodes', () => {
      const targetFile = ctx.file('bigJoiSchema.ts');
      fs.writeFileSync(targetFile, 'export default { min: 1, max: 10 };\n');
      const consumerFile = ctx.file('bigJoiSchemaConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import mySchema from './bigJoiSchema';",
          '',
          'export function useSchema() {',
          '  return mySchema;',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/bigJoiSchema.ts#default', name: 'default', type: 'variable', file_path: targetFile },
        { id: '{app}/bigJoiSchema.ts#a', name: 'a', type: 'variable', file_path: targetFile },
        { id: '{app}/bigJoiSchema.ts#b', name: 'b', type: 'variable', file_path: targetFile },
        { id: '{app}/bigJoiSchema.ts#c', name: 'c', type: 'variable', file_path: targetFile }
      ];
      const result = resolveConnectionsLocally(
        '{app}/bigJoiSchemaConsumer.ts#useSchema',
        consumerFile,
        localNodes,
        ctx.devmindPath
      );
      expect(result).not.toContain('{app}/bigJoiSchema.ts#default');
    });
  });

  describe('tsconfig/jsconfig path-alias resolution', () => {
    it('resolves both a wildcard `paths` pattern and an exact (non-wildcard) `paths` pattern from tsconfig.json', () => {
      fs.writeFileSync(
        path.join(ctx.srcDir, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              baseUrl: '.',
              paths: { '@utils/*': ['utils/*'], '@const': ['constants/index'] }
            }
          },
          null,
          2
        )
      );
      fs.mkdirSync(path.join(ctx.srcDir, 'utils'), { recursive: true });
      fs.writeFileSync(path.join(ctx.srcDir, 'utils', 'helper.ts'), 'export function helperFn() { return 1; }\n');
      fs.mkdirSync(path.join(ctx.srcDir, 'constants'), { recursive: true });
      fs.writeFileSync(path.join(ctx.srcDir, 'constants', 'index.ts'), 'export const CONST_VALUE = 1;\n');

      const consumerFile = ctx.file('tsPathsConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import { helperFn } from '@utils/helper';",
          "import { CONST_VALUE } from '@const';",
          '',
          'export function useAliases() {',
          '  return helperFn() + CONST_VALUE;',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/utils/helper.ts#helperFn', name: 'helperFn', type: 'function', file_path: path.join(ctx.srcDir, 'utils', 'helper.ts') },
        { id: '{app}/constants/index.ts#CONST_VALUE', name: 'CONST_VALUE', type: 'variable', file_path: path.join(ctx.srcDir, 'constants', 'index.ts') }
      ];
      const result = resolveConnectionsLocally('{app}/tsPathsConsumer.ts#useAliases', consumerFile, localNodes, ctx.devmindPath);
      expect(result).toEqual(
        expect.arrayContaining(['{app}/utils/helper.ts#helperFn', '{app}/constants/index.ts#CONST_VALUE'])
      );
    });

    it('falls back to {baseUrl: repoRoot, paths: {}} when tsconfig.json has neither baseUrl nor paths', () => {
      fs.writeFileSync(path.join(ctx.srcDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'es2020' } }));
      const consumerFile = ctx.file('noPathsConsumer.ts');
      fs.writeFileSync(consumerFile, ["export function noop() { return 1; }", ''].join('\n'));
      expect(() =>
        resolveConnectionsLocally('{app}/noPathsConsumer.ts#noop', consumerFile, nodes, ctx.devmindPath)
      ).not.toThrow();
    });

    it('swallows a malformed tsconfig.json (JSON parse failure) rather than throwing', () => {
      fs.writeFileSync(path.join(ctx.srcDir, 'tsconfig.json'), '{ this is not valid json ][');
      const consumerFile = ctx.file('malformedConfigConsumer.ts');
      fs.writeFileSync(consumerFile, ["export function noop2() { return 1; }", ''].join('\n'));
      expect(() =>
        resolveConnectionsLocally('{app}/malformedConfigConsumer.ts#noop2', consumerFile, nodes, ctx.devmindPath)
      ).not.toThrow();
    });

    it('resolves the legacy `@/` alias directly against the repo root when no tsconfig paths apply', () => {
      fs.writeFileSync(path.join(ctx.srcDir, 'aliasTarget.ts'), 'export default function aliasedFn() { return 1; }\n');
      const consumerFile = ctx.file('legacyAliasConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import aliasedFn from '@/aliasTarget';",
          '',
          'export function useLegacyAlias() {',
          '  return aliasedFn();',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/aliasTarget.ts#aliasedFn', name: 'aliasedFn', type: 'function', file_path: path.join(ctx.srcDir, 'aliasTarget.ts') }
      ];
      const result = resolveConnectionsLocally('{app}/legacyAliasConsumer.ts#useLegacyAlias', consumerFile, localNodes, ctx.devmindPath);
      expect(result).toContain('{app}/aliasTarget.ts#aliasedFn');
    });
  });

  describe('barrel-miss cache and resolveToExistingFile edge cases', () => {
    it('does not throw when an import resolves to nothing on disk at all (e.g. a bare node_modules package)', () => {
      const consumerFile = ctx.file('bareImportConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        ["import { useState } from 'react';", '', 'export function useBareImport() {', '  return useState(1);', '}', ''].join('\n')
      );
      expect(() =>
        resolveConnectionsLocally('{app}/bareImportConsumer.ts#useBareImport', consumerFile, nodes, ctx.devmindPath)
      ).not.toThrow();
    });

    it('onMissing: finds the target through an index.ts barrel (resolveToExistingFile\'s /index.* candidates)', () => {
      fs.mkdirSync(path.join(ctx.srcDir, 'dirmod'), { recursive: true });
      fs.writeFileSync(path.join(ctx.srcDir, 'dirmod', 'index.ts'), 'export function dirModFn() { return 1; }\n');
      const consumerFile = ctx.file('missingDirImport.ts');
      fs.writeFileSync(
        consumerFile,
        ["import { dirModFn } from './dirmod';", '', 'export function useDirMod() {', '  return dirModFn();', '}', ''].join('\n')
      );
      const missing: MissingRef[] = [];
      resolveConnectionsLocally(
        '{app}/missingDirImport.ts#useDirMod',
        consumerFile,
        nodes,
        ctx.devmindPath,
        rec => missing.push(rec)
      );
      expect(missing).toHaveLength(1);
      expect(missing[0].name).toBe('dirModFn');
      expect(path.resolve(missing[0].targetFile)).toBe(path.resolve(path.join(ctx.srcDir, 'dirmod', 'index.ts')));
    });

    it('onMissing: finds the target via a direct extensionless file match (resolveToExistingFile\'s final fs.existsSync fallback)', () => {
      fs.writeFileSync(path.join(ctx.srcDir, 'data.json'), '{"a":1}\n');
      const consumerFile = ctx.file('missingJsonImport.ts');
      fs.writeFileSync(
        consumerFile,
        ["import data from './data.json';", '', 'export function useData() {', '  return data;', '}', ''].join('\n')
      );
      const missing: MissingRef[] = [];
      resolveConnectionsLocally(
        '{app}/missingJsonImport.ts#useData',
        consumerFile,
        nodes,
        ctx.devmindPath,
        rec => missing.push(rec)
      );
      expect(missing).toHaveLength(1);
      expect(missing[0].name).toBe('data');
      expect(path.resolve(missing[0].targetFile)).toBe(path.resolve(path.join(ctx.srcDir, 'data.json')));
    });
  });

  describe('tsconfig.json paths/baseUrl independent presence', () => {
    it('handles paths present without an explicit baseUrl (defaults baseUrl to ".")', () => {
      fs.writeFileSync(
        path.join(ctx.srcDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { paths: { '@x/*': ['xdir/*'] } } })
      );
      fs.mkdirSync(path.join(ctx.srcDir, 'xdir'), { recursive: true });
      fs.writeFileSync(path.join(ctx.srcDir, 'xdir', 'thing.ts'), 'export function xThing() { return 1; }\n');
      const consumerFile = ctx.file('noBaseUrlConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        ["import { xThing } from '@x/thing';", '', 'export function useX() {', '  return xThing();', '}', ''].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/xdir/thing.ts#xThing', name: 'xThing', type: 'function', file_path: path.join(ctx.srcDir, 'xdir', 'thing.ts') }
      ];
      const result = resolveConnectionsLocally('{app}/noBaseUrlConsumer.ts#useX', consumerFile, localNodes, ctx.devmindPath);
      expect(result).toContain('{app}/xdir/thing.ts#xThing');
    });

    it('handles baseUrl present without paths (paths defaults to {})', () => {
      fs.writeFileSync(path.join(ctx.srcDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.' } }));
      fs.writeFileSync(path.join(ctx.srcDir, 'bareBaseUrlTarget.ts'), 'export function bareFn() { return 1; }\n');
      const consumerFile = ctx.file('baseUrlOnlyConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import { bareFn } from 'bareBaseUrlTarget';",
          '',
          'export function useBare() {',
          '  return bareFn();',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/bareBaseUrlTarget.ts#bareFn', name: 'bareFn', type: 'function', file_path: path.join(ctx.srcDir, 'bareBaseUrlTarget.ts') }
      ];
      const result = resolveConnectionsLocally('{app}/baseUrlOnlyConsumer.ts#useBare', consumerFile, localNodes, ctx.devmindPath);
      expect(result).toContain('{app}/bareBaseUrlTarget.ts#bareFn');
    });
  });

  it('falls back to an empty repoRoot when the source node\'s repo name is not in config.json (resolveRepoPath returns null)', () => {
    const result = resolveConnectionsLocally(
      '{unknownrepo}/notExported.ts#usesPrivateHelper',
      ctx.file('notExported.ts'),
      nodes,
      ctx.devmindPath
    );
    // Relative (same-file) resolution doesn't depend on repoRoot at all.
    expect(result).toEqual(['{app}/notExported.ts#privateHelper']);
  });

  describe('getDefaultExportName on a non-TS/JS target file', () => {
    it('a candidate whose file is a .vue SFC never matches via the default-export branches (extension gate short-circuits)', () => {
      const targetFile = ctx.file('widgetDefault.vue');
      fs.writeFileSync(
        targetFile,
        ['<script lang="ts">', "export default { name: 'X' };", '</script>', ''].join('\n')
      );
      const consumerFile = ctx.file('widgetDefaultConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import cfg from './widgetDefault.vue';",
          '',
          'export function useCfg() {',
          '  return cfg;',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/widgetDefault.vue#Config', name: 'Config', type: 'variable', file_path: targetFile }
      ];
      expect(() =>
        resolveConnectionsLocally('{app}/widgetDefaultConsumer.ts#useCfg', consumerFile, localNodes, ctx.devmindPath)
      ).not.toThrow();
      const result = resolveConnectionsLocally('{app}/widgetDefaultConsumer.ts#useCfg', consumerFile, localNodes, ctx.devmindPath);
      expect(result).not.toContain('{app}/widgetDefault.vue#Config');
    });
  });

  describe('getDefaultExportName: `export { default } from` re-export form', () => {
    it('resolves the literal re-exported "default" binding name (no "as" rename, so propertyName is undefined)', () => {
      const upstreamFile = ctx.file('upstreamDefault.ts');
      fs.writeFileSync(upstreamFile, 'export default function upstreamFn() { return 1; }\n');
      const targetFile = ctx.file('reexportDefault.ts');
      fs.writeFileSync(targetFile, "export { default } from './upstreamDefault';\n");
      const consumerFile = ctx.file('reexportDefaultConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import whatever from './reexportDefault';",
          '',
          'export function useWhatever() {',
          '  return whatever();',
          '}',
          ''
        ].join('\n')
      );
      // getDefaultExportName(reexportDefault.ts) resolves the name to the literal string
      // "default" (see the `export { default }` branch) — a node whose symbolName IS "default"
      // is exactly what the extractor would name such a re-export.
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/reexportDefault.ts#default', name: 'default', type: 'variable', file_path: targetFile }
      ];
      expect(() =>
        resolveConnectionsLocally('{app}/reexportDefaultConsumer.ts#useWhatever', consumerFile, localNodes, ctx.devmindPath)
      ).not.toThrow();
    });
  });

  describe('onMissing: remaining branch coverage', () => {
    it('skips a namespace import entirely (the specific missing symbol cannot be attributed)', () => {
      const consumerFile = ctx.file('nsMissingConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import * as NS from './exported';",
          '',
          'export function useNs() {',
          '  return NS.publicFn();',
          '}',
          ''
        ].join('\n')
      );
      const missing: MissingRef[] = [];
      resolveConnectionsLocally(
        '{app}/nsMissingConsumer.ts#useNs',
        consumerFile,
        nodes,
        ctx.devmindPath,
        rec => missing.push(rec)
      );
      expect(missing).toEqual([]);
    });

    it('does not fire when the import cannot be resolved to any file on disk at all', () => {
      const consumerFile = ctx.file('unresolvableMissingConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        ["import { useState } from 'react';", '', 'export function useReact() {', '  return useState(1);', '}', ''].join(
          '\n'
        )
      );
      const missing: MissingRef[] = [];
      resolveConnectionsLocally(
        '{app}/unresolvableMissingConsumer.ts#useReact',
        consumerFile,
        nodes,
        ctx.devmindPath,
        rec => missing.push(rec)
      );
      // resolveToExistingFile finds nothing for the bogus "react" path -> the missing-detection
      // loop skips it (there's no real file to report as the gap's target).
      expect(missing).toEqual([]);
    });

    it('a default import is considered satisfied by ANY node in its target file, even one with a different name', () => {
      const targetFile = ctx.file('mismatchedDefault.ts');
      fs.writeFileSync(targetFile, 'export default function actualName() { return 1; }\n');
      const consumerFile = ctx.file('mismatchedDefaultConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import differentAlias from './mismatchedDefault';",
          '',
          'export function useMismatched() {',
          '  return differentAlias();',
          '}',
          ''
        ].join('\n')
      );
      // One node exists for the file (named "actualName", unrelated to "differentAlias"). Since
      // this is a default import and the file has >0 nodes, missing-detection should treat it as
      // satisfied rather than reporting a Phase-1 gap.
      const localNodes: CandidateNode[] = [
        ...nodes,
        { id: '{app}/mismatchedDefault.ts#actualName', name: 'actualName', type: 'function', file_path: targetFile }
      ];
      const missing: MissingRef[] = [];
      resolveConnectionsLocally(
        '{app}/mismatchedDefaultConsumer.ts#useMismatched',
        consumerFile,
        localNodes,
        ctx.devmindPath,
        rec => missing.push(rec)
      );
      expect(missing).toEqual([]);
    });
  });

  describe('isDefinitionName: object-literal property KEY vs VALUE position', () => {
    it('an identifier used as an object-literal VALUE (not its key) is a real reference, not a definition', () => {
      const file = ctx.file('objLiteralKeyValue.ts');
      fs.writeFileSync(
        file,
        [
          'export function useObj() {',
          '  const helper = someLongHelperFunctionName();',
          '  return { helper: helper };',
          '}',
          ''
        ].join('\n')
      );
      const fallbackTarget: CandidateNode = {
        id: '{app}/lib/impl.ts#someLongHelperFunctionName',
        name: 'someLongHelperFunctionName',
        type: 'function',
        file_path: ctx.file('lib/impl.ts')
      };
      const result = resolveConnectionsLocally(
        '{app}/objLiteralKeyValue.ts#useObj',
        file,
        [...nodes, fallbackTarget],
        ctx.devmindPath
      );
      // Both the "helper:" KEY and the "helper" VALUE are visited by isDefinitionName during free
      // reference collection; this just needs to resolve without throwing or misfiring.
      expect(result).toContain('{app}/lib/impl.ts#someLongHelperFunctionName');
    });
  });

  describe('collectScopeBindings: catch-clause bindings and skipping nested function scopes', () => {
    it('binds a catch-clause variable in its own scope and does not descend into a nested function\'s own locals', () => {
      const file = ctx.file('tryCatchNested.ts');
      fs.writeFileSync(
        file,
        [
          'export function useTryCatch() {',
          '  try {',
          '    doSomethingLongNamedHere();',
          '  } catch (err) {',
          '    console.log(err);',
          '  }',
          '  function nested() {',
          "    const err = 'shadow';",
          '    return err;',
          '  }',
          '  return nested();',
          '}',
          ''
        ].join('\n')
      );
      const fallbackTarget: CandidateNode = {
        id: '{app}/lib/impl.ts#doSomethingLongNamedHere',
        name: 'doSomethingLongNamedHere',
        type: 'function',
        file_path: ctx.file('lib/impl.ts')
      };
      const result = resolveConnectionsLocally(
        '{app}/tryCatchNested.ts#useTryCatch',
        file,
        [...nodes, fallbackTarget],
        ctx.devmindPath
      );
      expect(result).toContain('{app}/lib/impl.ts#doSomethingLongNamedHere');
    });
  });

  describe('barrel re-export resolution: a non-relative (bare-package) re-export specifier is skipped', () => {
    it('still resolves the local re-export in the same barrel that also re-exports from a bare package', () => {
      fs.mkdirSync(path.join(ctx.srcDir, 'extBarrel'), { recursive: true });
      fs.writeFileSync(path.join(ctx.srcDir, 'extBarrel', 'local.ts'), 'export function localBarrelFn() { return 1; }\n');
      fs.writeFileSync(
        path.join(ctx.srcDir, 'extBarrel', 'index.ts'),
        ["export * from './local';", "export { something } from 'external-package';", ''].join('\n')
      );
      const consumerFile = ctx.file('extBarrelConsumer.ts');
      fs.writeFileSync(
        consumerFile,
        [
          "import { localBarrelFn } from './extBarrel';",
          '',
          'export function useExtBarrel() {',
          '  return localBarrelFn();',
          '}',
          ''
        ].join('\n')
      );
      const localNodes: CandidateNode[] = [
        ...nodes,
        {
          id: '{app}/extBarrel/local.ts#localBarrelFn',
          name: 'localBarrelFn',
          type: 'function',
          file_path: path.join(ctx.srcDir, 'extBarrel', 'local.ts')
        }
      ];
      const result = resolveConnectionsLocally('{app}/extBarrelConsumer.ts#useExtBarrel', consumerFile, localNodes, ctx.devmindPath);
      expect(result).toContain('{app}/extBarrel/local.ts#localBarrelFn');
    });
  });

  describe('AST parse-failure fallback to regex reference collection', () => {
    it('falls back to collectRegexNames + isolationFailed when the AST parse step itself throws (pathologically deep nesting overflows the parser\'s recursive descent)', () => {
      const file = ctx.file('raceFile.ts');
      // TS's parser is recursive-descent with no depth guard; a few thousand nested parens is
      // enough to blow the call stack (verified: 5000 reliably throws RangeError here). This is
      // a real failure mode (a generated/minified file, or adversarial input) rather than a
      // contrived mock, and it throws from inside getSourceFile's try block exactly like any
      // other AST-parse failure would.
      const depth = 5000;
      fs.writeFileSync(file, `const x = ${'('.repeat(depth)}1${')'.repeat(depth)};\n`);

      let result: string[] = [];
      expect(() => {
        result = resolveConnectionsLocally('{app}/raceFile.ts#x', file, nodes, ctx.devmindPath);
      }).not.toThrow();
      // isolationFailed suppresses every link (same-file, no-import fallback) even though the
      // regex-collected names still textually include "x".
      expect(result).toEqual([]);
    });
  });
});
