import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { loadProjectContext, resolveRepoPath } from './config';

interface ParsedNodeId {
  repo: string;
  filePath: string;
  symbolName: string;
  className?: string;
  memberName?: string;
}

interface ImportInfo {
  importedName: string;
  moduleSpecifier: string;
  isDefault: boolean;
  isNamespace?: boolean; // `import * as X from '...'`
}

/**
 * Parses a DevsMind node ID into constituent parts
 */
export function parseNodeId(id: string): ParsedNodeId | null {
  // Matches e.g., "{harrir-backend-products-service}/src/controllers/SearchIndexController.ts#SearchIndexController.searchFiltersV2"
  const match = id.match(/^\{([^}]+)\}\/([^#]+)#(.+)$/);
  if (!match) return null;
  const [, repo, filePath, symbolName] = match;
  const parts = symbolName.split('.');
  if (parts.length === 2) {
    return { repo, filePath, symbolName, className: parts[0], memberName: parts[1] };
  }
  return { repo, filePath, symbolName };
}

/**
 * Resolves path aliases and relative paths to match target files
 */
function matchPaths(resolvedImport: string, targetFile: string): boolean {
  const cleanImport = resolvedImport.replace(/\\/g, '/').toLowerCase();
  const cleanTarget = targetFile.replace(/\\/g, '/').toLowerCase();
  
  // Strip extensions and standard index file conventions
  const importBase = cleanImport.replace(/\.(d\.)?[jt]sx?$/, '').replace(/\/index$/, '');
  const targetBase = cleanTarget.replace(/\.(d\.)?[jt]sx?$/, '').replace(/\/index$/, '');
  
  return importBase === targetBase || cleanImport === cleanTarget;
}

/**
 * Extracts imports from a TypeScript AST SourceFile
 */
function getFileImports(sourceFile: ts.SourceFile): ImportInfo[] {
  const imports: ImportInfo[] = [];

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const moduleSpecifier = node.moduleSpecifier.text;
        if (node.importClause) {
          // Default import: import X from 'y'
          if (node.importClause.name) {
            imports.push({
              importedName: node.importClause.name.text,
              moduleSpecifier,
              isDefault: true
            });
          }
          // Named imports: import { A, B as C } from 'y'
          if (node.importClause.namedBindings) {
            const bindings = node.importClause.namedBindings;
            if (ts.isNamedImports(bindings)) {
              for (const element of bindings.elements) {
                imports.push({
                  importedName: element.name.text,
                  moduleSpecifier,
                  isDefault: false
                });
              }
            } else if (ts.isNamespaceImport(bindings)) {
              // import * as X from 'y'
              imports.push({
                importedName: bindings.name.text,
                moduleSpecifier,
                isDefault: false,
                isNamespace: true
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return imports;
}

/**
 * True when this identifier sits in a *definition* position (the name being
 * declared) rather than a *usage* position (a reference to something else).
 * Counting definitions as references is the main false-positive source: an
 * object-literal key `{ validateEmailAddress: false }`, a parameter name, or a
 * local declaration name would otherwise "match" an unrelated target node that
 * happens to share that name. Requires parent pointers (createSourceFile(..., true)).
 */
function isDefinitionName(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return false;

  // The declared name of a declaration (function foo, class Foo, const foo, param foo, foo() {} …)
  if (
    (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) ||
     ts.isClassDeclaration(parent) || ts.isClassExpression(parent) ||
     ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) ||
     ts.isEnumDeclaration(parent) || ts.isEnumMember(parent) ||
     ts.isModuleDeclaration(parent) ||
     ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) ||
     ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) ||
     ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) ||
     ts.isParameter(parent) || ts.isVariableDeclaration(parent) ||
     ts.isBindingElement(parent)) &&
    (parent as unknown as { name?: ts.Node }).name === node
  ) {
    return true;
  }

  // Object-literal key: `{ foo: ... }` — a definition. (Shorthand `{ foo }` is a
  // real read, so it is intentionally NOT excluded here.)
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;

  // Import/export binding names (the local aliases, not usages of the target)
  if (
    ts.isImportSpecifier(parent) || ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent)
  ) {
    return true;
  }

  return false;
}

/**
 * Traverses a TypeScript AST node to collect names *referenced* (used) within it,
 * excluding definition/declaration positions (see isDefinitionName).
 */
function collectReferencedNames(root: ts.Node): Set<string> {
  const names = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      if (!isDefinitionName(node)) names.add(node.text);
    } else if (ts.isPropertyAccessExpression(node)) {
      if (node.name && ts.isIdentifier(node.name)) {
        names.add(node.name.text);
      }
    } else if (ts.isJsxOpeningElement(node)) {
      if (node.tagName && ts.isIdentifier(node.tagName)) {
        names.add(node.tagName.text);
      }
    } else if (ts.isJsxSelfClosingElement(node)) {
      if (node.tagName && ts.isIdentifier(node.tagName)) {
        names.add(node.tagName.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(root, visit);
  return names;
}

/**
 * Searches an arbitrary subtree for a member matching propName — at any nesting depth.
 * Covers two shapes findNodeInAst's top-level scan can't reach on its own:
 *  - object-literal properties/methods, e.g.
 *    `const api = createApi({ endpoints: (builder) => ({ myEndpoint: builder.mutation(...) }) })`
 *  - nested function/const declarations inside another function's body, e.g. a React
 *    component's locally-defined handlers: `function CartSidebar() { function handleX() {} }`
 * In both cases the target isn't a class member or a standalone top-level declaration —
 * it's a member sitting somewhere inside another declaration's body/initializer.
 */
function findPropertyInContainer(containerNode: ts.Node, propName: string): ts.Node | null {
  let found: ts.Node | null = null;

  function visit(node: ts.Node) {
    if (found) return;
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === propName
    ) {
      found = node;
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === propName
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(containerNode, visit);
  return found;
}

/**
 * Framework-route adapter. Node IDs like `router.get("/boxy/regions")` refer to a
 * specific call `router.get("/boxy/regions", handler)`, not a declared symbol. Find that
 * exact call by its method (`get`) + first string-literal argument (the route path), so
 * we isolate just that registration instead of scanning the whole (multi-route) file.
 */
function findRouteCall(sourceFile: ts.SourceFile, method: string, arg: string): ts.Node | null {
  let found: ts.Node | null = null;
  function visit(node: ts.Node) {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === method &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === arg
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);
  return found;
}

/** Navigate a dotted path through nested object-literal properties. */
function navigateObjectPath(obj: ts.ObjectLiteralExpression, segments: string[]): ts.Node | null {
  let current: ts.ObjectLiteralExpression | null = obj;
  for (let i = 0; i < segments.length; i++) {
    if (!current) return null;
    const seg = segments[i];
    const prop: ts.ObjectLiteralElementLike | undefined = current.properties.find(
      p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === seg
    );
    if (!prop) return null;
    if (i === segments.length - 1) return prop;
    if (ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
      current = prop.initializer;
    } else {
      current = null;
    }
  }
  return null;
}

/**
 * Framework-container adapter. Node IDs like `HomePageComponent.methods._getLang` come
 * from `Component({ methods: { _getLang() {} } })` factories (WeChat/Alipay mini-programs,
 * and similar object-config frameworks) where the container name isn't a real declaration.
 * Navigate the dotted path (minus the synthetic container name) inside a top-level
 * factory call's object-literal argument, so we isolate just that method.
 */
function findInFrameworkContainer(sourceFile: ts.SourceFile, segments: string[]): ts.Node | null {
  if (segments.length === 0) return null;
  const objArgs: ts.ObjectLiteralExpression[] = [];
  for (const stmt of sourceFile.statements) {
    let expr: ts.Expression | undefined;
    if (ts.isExpressionStatement(stmt)) expr = stmt.expression;
    else if (ts.isExportAssignment(stmt)) expr = stmt.expression;
    if (expr && ts.isCallExpression(expr)) {
      for (const a of expr.arguments) {
        if (ts.isObjectLiteralExpression(a)) objArgs.push(a);
      }
    }
  }
  // Precise: navigate the full path (e.g. methods -> _getLang).
  for (const obj of objArgs) {
    const node = navigateObjectPath(obj, segments);
    if (node) return node;
  }
  // Fallback: the last segment anywhere inside a factory object (handles path shapes
  // whose middle segments don't map cleanly to nested object literals).
  const last = segments[segments.length - 1];
  for (const obj of objArgs) {
    const node = findPropertyInContainer(obj, last);
    if (node) return node;
  }
  return null;
}

/**
 * Searches for a class method, function, or block inside the file AST matching our symbol name
 */
function findNodeInAst(sourceFile: ts.SourceFile, className: string | undefined, symbolName: string): ts.Node | null {
  // Framework-route adapter: `router.get("/path")` → the specific registration call.
  const routeMatch = symbolName.match(/^\w+\.\w+\((['"])(.+)\1\)$/);
  if (routeMatch) {
    const method = symbolName.slice(symbolName.indexOf('.') + 1, symbolName.indexOf('('));
    const routeCall = findRouteCall(sourceFile, method, routeMatch[2]);
    if (routeCall) return routeCall;
  }

  let foundNode: ts.Node | null = null;
  let containerCandidate: ts.Node | null = null;

  function visit(node: ts.Node) {
    if (foundNode) return;

    if (className) {
      if (ts.isClassDeclaration(node) && node.name && node.name.text === className) {
        // Search methods / properties of the class
        for (const member of node.members) {
          if (member.name && ts.isIdentifier(member.name) && member.name.text === symbolName.split('.').pop()) {
            foundNode = member;
            return;
          }
        }
      }
      // Track any declaration named `className` that isn't a class — a const object
      // (`const api = createApi({...})`) or a function/component (`function CartSidebar() {}`,
      // `const CartSidebar = () => {}`) — in case the class-member lookup above never
      // matches. Used as a fallback below to search inside it for the member.
      //
      // Also covers frameworks (e.g. WeChat/Alipay mini-programs) where the "class"
      // isn't a local declaration at all — it's a bare call to a global framework
      // function whose object-literal argument holds the members:
      //   Component({ data: {...}, methods: { onTap() {...} }, didMount() {...} })
      // Without this, `className` ("Component") never resolves to anything declared
      // in the file, findNodeInAst falls back to scanning the WHOLE file's identifiers
      // for every single member, and every property/method in the file gets wrongly
      // cross-linked to every other one.
      if (
        !containerCandidate &&
        ((ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.name.text === className) ||
         (ts.isFunctionDeclaration(node) && node.name && node.name.text === className) ||
         (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === className))
      ) {
        containerCandidate = node;
      }
    } else {
      if (
        (ts.isFunctionDeclaration(node) ||
         ts.isClassDeclaration(node) ||
         ts.isInterfaceDeclaration(node) ||
         ts.isTypeAliasDeclaration(node) ||
         ts.isEnumDeclaration(node)) &&
        node.name && node.name.text === symbolName
      ) {
        foundNode = node;
        return;
      }
      if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.name.text === symbolName) {
        foundNode = node;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  // Fallback: className resolved to a non-class declaration (object literal, factory call,
  // etc). Search inside it for a property/method matching the member name, at any depth.
  if (!foundNode && className && containerCandidate) {
    const memberName = symbolName.includes('.') ? symbolName.split('.').pop()! : symbolName;
    foundNode = findPropertyInContainer(containerCandidate, memberName);
  }

  // Framework-container adapter: dotted IDs like `HomePageComponent.methods._getLang`
  // whose container name isn't a real declaration. Navigate the path (minus the leading
  // synthetic container segment) inside a top-level factory call's object literal.
  if (!foundNode && symbolName.includes('.')) {
    const segments = symbolName.split('.');
    foundNode = findInFrameworkContainer(sourceFile, segments.slice(1));
  }

  return foundNode;
}

/**
 * Generically extracts identifiers from non-JS/TS code files using regex
 */
function collectRegexNames(code: string): Set<string> {
  const names = new Set<string>();
  
  // Strip block/line comments and string literals to reduce noise
  const cleanCode = code
    .replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '') // C-style comments
    .replace(/#.*$/gm, '') // Scripting-style comments
    .replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, ''); // String literals

  // Match words that look like identifiers/variables/method names (alphanumeric + underscores)
  const matches = cleanCode.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g);
  if (matches) {
    for (const m of matches) {
      names.add(m);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Caches (keyed by path + mtime so a long-lived server picks up edited files).
// ---------------------------------------------------------------------------
const sourceFileCache = new Map<string, { mtimeMs: number; sf: ts.SourceFile }>();
const tsPathsCache = new Map<string, TsPathConfig | null>();
const barrelCache = new Map<string, { mtimeMs: number; reexports: BarrelReexport[] } | null>();
// Paths we've already determined have no index/barrel file — avoids repeating 8
// fs.existsSync probes for the (very common) non-barrel import case.
const barrelMissCache = new Set<string>();

interface TsPathConfig {
  baseUrl: string; // absolute
  paths: Record<string, string[]>;
}
interface BarrelReexport {
  name: string | null; // null === `export * from '...'`
  resolvedBase: string; // absolute path of the re-exported module (no extension)
}
interface ResolvedImport {
  importedName: string;
  isDefault: boolean;
  isNamespace: boolean;
  paths: string[]; // candidate absolute module paths this import could resolve to
  barrels: BarrelReexport[]; // re-exports found in any index/barrel among `paths`
}

function statMtime(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** Parse (and cache) a TS/JS source file with parent pointers set. */
function getSourceFile(filePath: string, content?: string): ts.SourceFile {
  const mtimeMs = statMtime(filePath) ?? -1;
  const cached = sourceFileCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && content === undefined) return cached.sf;
  const text = content ?? fs.readFileSync(filePath, 'utf-8');
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  sourceFileCache.set(filePath, { mtimeMs, sf });
  return sf;
}

/** Load (and cache) tsconfig/jsconfig baseUrl + paths for a repo root. */
function loadTsPaths(repoRoot: string): TsPathConfig | null {
  if (!repoRoot) return null;
  if (tsPathsCache.has(repoRoot)) return tsPathsCache.get(repoRoot)!;

  let result: TsPathConfig | null = null;
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const cfgPath = path.join(repoRoot, name);
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const text = fs.readFileSync(cfgPath, 'utf-8');
      const parsed = ts.parseConfigFileTextToJson(cfgPath, text);
      const opts = parsed.config?.compilerOptions;
      if (opts && (opts.paths || opts.baseUrl)) {
        const baseUrl = path.resolve(repoRoot, opts.baseUrl ?? '.');
        result = { baseUrl, paths: opts.paths ?? {} };
      } else {
        result = { baseUrl: repoRoot, paths: {} };
      }
    } catch {
      /* ignore malformed config */
    }
    break;
  }

  tsPathsCache.set(repoRoot, result);
  return result;
}

/** Expand a module specifier to every plausible absolute base path it could resolve to. */
function resolveImportToPaths(
  moduleSpecifier: string,
  sourceDir: string,
  repoRoot: string,
  tsPaths: TsPathConfig | null
): string[] {
  const out: string[] = [];

  if (moduleSpecifier.startsWith('.')) {
    out.push(path.resolve(sourceDir, moduleSpecifier));
    return out;
  }

  // tsconfig `paths` aliases (e.g. "@utils/*": ["src/utils/*"])
  if (tsPaths) {
    for (const [pattern, targets] of Object.entries(tsPaths.paths)) {
      const starPattern = pattern.includes('*');
      if (starPattern) {
        const [prefix, suffix] = pattern.split('*');
        if (moduleSpecifier.startsWith(prefix) && moduleSpecifier.endsWith(suffix)) {
          const middle = moduleSpecifier.slice(prefix.length, moduleSpecifier.length - suffix.length);
          for (const t of targets) {
            out.push(path.resolve(tsPaths.baseUrl, t.replace('*', middle)));
          }
        }
      } else if (moduleSpecifier === pattern) {
        for (const t of targets) out.push(path.resolve(tsPaths.baseUrl, t));
      }
    }
    // baseUrl-relative bare import (e.g. baseUrl "src", import "utils/math")
    if (tsPaths.baseUrl) out.push(path.resolve(tsPaths.baseUrl, moduleSpecifier));
  }

  // Legacy hardcoded aliases, kept for repos without tsconfig paths
  if (moduleSpecifier.startsWith('@/') || moduleSpecifier.startsWith('~/')) {
    const cleanSpec = moduleSpecifier.substring(2);
    if (repoRoot) {
      out.push(path.resolve(repoRoot, cleanSpec));
      out.push(path.resolve(repoRoot, 'src', cleanSpec));
    }
  } else if (repoRoot) {
    out.push(path.resolve(repoRoot, moduleSpecifier));
  }

  return out;
}

/** Parse (and cache) an index/barrel file's re-export declarations. */
function getBarrelReexports(resolvedImportPath: string): BarrelReexport[] {
  const indexCandidates = [
    path.join(resolvedImportPath, 'index.ts'),
    path.join(resolvedImportPath, 'index.tsx'),
    path.join(resolvedImportPath, 'index.js'),
    path.join(resolvedImportPath, 'index.jsx'),
    resolvedImportPath + '.ts',
    resolvedImportPath + '.tsx',
    resolvedImportPath + '.js',
    resolvedImportPath + '.jsx',
  ];
  if (barrelMissCache.has(resolvedImportPath)) return [];
  const indexPath = indexCandidates.find(p => fs.existsSync(p));
  if (!indexPath) {
    barrelMissCache.add(resolvedImportPath);
    return [];
  }

  const mtimeMs = statMtime(indexPath) ?? -1;
  const cached = barrelCache.get(indexPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.reexports;

  const reexports: BarrelReexport[] = [];
  try {
    const sf = getSourceFile(indexPath);
    const dir = path.dirname(indexPath);
    sf.forEachChild(n => {
      if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const spec = n.moduleSpecifier.text;
        if (!spec.startsWith('.')) return; // only follow local re-exports
        const resolvedBase = path.resolve(dir, spec);
        if (n.exportClause && ts.isNamedExports(n.exportClause)) {
          for (const el of n.exportClause.elements) {
            reexports.push({ name: el.name.text, resolvedBase });
          }
        } else {
          reexports.push({ name: null, resolvedBase }); // export * from '...'
        }
      }
    });
  } catch {
    /* ignore */
  }
  barrelCache.set(indexPath, { mtimeMs, reexports });
  return reexports;
}

// Resolve a file's `export default` so a default import (`import X from './y'`) can be
// linked to the ONE node it binds to — not every symbol in the file. Returns:
//   - the export's NAME for a named default (`export default OrderController`),
//   - ANON_DEFAULT for an anonymous default (`export default Joi.object({...})`) — the
//     file HAS a default export but it has no source-level name; callers bridge it to the
//     import alias by (case-insensitive) node name,
//   - null when there is no default export at all.
const ANON_DEFAULT = ' anon';
const defaultExportCache = new Map<string, { mtimeMs: number; name: string | null }>();
function getDefaultExportName(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return null;
  const mtimeMs = statMtime(filePath) ?? -1;
  const cached = defaultExportCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.name;

  let name: string | null = null;
  try {
    const sf = getSourceFile(filePath);
    for (const stmt of sf.statements) {
      // `export default <expr>`
      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        const expr = stmt.expression;
        if (ts.isIdentifier(expr)) name = expr.text;
        else if ((ts.isClassExpression(expr) || ts.isFunctionExpression(expr)) && expr.name) name = expr.name.text;
        else name = ANON_DEFAULT; // `export default Joi.object({...})`, `{...}`, `() => …`
        break;
      }
      // `export default class X {}` / `export default function X() {}`
      if (
        (ts.isClassDeclaration(stmt) || ts.isFunctionDeclaration(stmt)) &&
        stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) &&
        stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)
      ) {
        name = stmt.name ? stmt.name.text : ANON_DEFAULT;
        break;
      }
      // `export { X as default }`
      if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.name.text === 'default') { name = (el.propertyName ?? el.name).text; break; }
        }
        if (name) break;
      }
    }
  } catch {
    /* ignore */
  }
  defaultExportCache.set(filePath, { mtimeMs, name });
  return name;
}

/**
 * Locally analyzes the source file and resolves references to candidate nodes
 */
export function resolveConnectionsLocally(
  sourceNodeId: string,
  sourceFilePath: string,
  candidateNodes: { id: string; name: string; type: string; file_path: string }[],
  devmindPath: string
): string[] {
  const parsedSource = parseNodeId(sourceNodeId);
  if (!parsedSource) return [];

  const connections = new Set<string>();

  // Determine repository root path for non-relative imports
  let repoRoot = '';
  try {
    const context = loadProjectContext(devmindPath);
    repoRoot = resolveRepoPath(context, parsedSource.repo) || '';
  } catch (err) {
    // Fallback if config loading fails
  }

  // Check if file exists
  if (!fs.existsSync(sourceFilePath)) {
    return [];
  }

  const fileContent = fs.readFileSync(sourceFilePath, 'utf-8');
  const ext = path.extname(sourceFilePath).toLowerCase();
  const isTsOrJs = ['.ts', '.tsx', '.js', '.jsx'].includes(ext);
  const tsPaths = loadTsPaths(repoRoot);

  let referencedNames = new Set<string>();
  let imports: ImportInfo[] = [];
  // True when we could NOT isolate this symbol's own AST subtree and fell back to
  // scanning the whole file. In that mode every identifier in the file is in scope,
  // so same-file links become meaningless — we suppress them to avoid cross-linking
  // every symbol in the file to every other one (the worst false-positive source).
  let isolationFailed = false;

  if (isTsOrJs) {
    try {
      const sourceFile = getSourceFile(sourceFilePath);
      imports = getFileImports(sourceFile);

      // Locate the AST node for this class/method/function
      const astNode = findNodeInAst(sourceFile, parsedSource.className, parsedSource.symbolName);
      if (astNode) {
        referencedNames = collectReferencedNames(astNode);
      } else {
        // Fallback: scan the whole file, but mark isolation as failed so downstream
        // matching stays conservative (cross-file, import-gated links only).
        referencedNames = collectReferencedNames(sourceFile);
        isolationFailed = true;
      }
    } catch (err) {
      // TS AST fallback to regex in case of parsing failures
      referencedNames = collectRegexNames(fileContent);
      isolationFailed = true;
    }
  } else {
    // Non-JS/TS code uses regex identifier matching
    referencedNames = collectRegexNames(fileContent);
    isolationFailed = true;
  }

  const sourceDir = path.dirname(sourceFilePath);
  const commonNames = new Set([
    'constructor', 'properties', 'description', 'connections', 'environment', 
    'milliseconds', 'get', 'set', 'find', 'create', 'update', 'delete', 
    'handle', 'process', 'init', 'main', 'config', 'data', 'response', 'request',
    'metadata', 'options', 'headers', 'params', 'payload', 'result', 'status',
    'message', 'details', 'values', 'service', 'controller', 'repository', 'helper',
    'utils', 'constant', 'constants', 'default', 'export', 'import', 'index',
    'keys', 'types', 'validate', 'resolve', 'reject', 'execute', 'loading', 'active'
  ]);

  // Resolve every import's candidate paths + barrel re-exports ONCE per source node.
  // This is candidate-independent, so doing it inside the candidate loop (7000+ nodes)
  // was re-running filesystem probes thousands of times per source node.
  const resolvedImports: ResolvedImport[] = [];
  if (isTsOrJs) {
    for (const imp of imports) {
      const paths = resolveImportToPaths(imp.moduleSpecifier, sourceDir, repoRoot, tsPaths);
      const barrels: BarrelReexport[] = [];
      for (const p of paths) {
        if (!p) continue;
        const rx = getBarrelReexports(p);
        if (rx.length) barrels.push(...rx);
      }
      resolvedImports.push({
        importedName: imp.importedName,
        isDefault: !!imp.isDefault,
        isNamespace: !!imp.isNamespace,
        paths,
        barrels
      });
    }
  }

  // How many nodes each file contributes — used to safely link default imports of tiny,
  // single-purpose files (Joi schemas, configs) whose anonymous default export the
  // extractor named inconsistently (`default`, `Foo.schema`), so name matching fails.
  const nodesPerFile = new Map<string, number>();
  const normFile = (fp: string) => path.resolve(fp).replace(/\\/g, '/').toLowerCase();
  for (const n of candidateNodes) {
    const k = normFile(n.file_path);
    nodesPerFile.set(k, (nodesPerFile.get(k) ?? 0) + 1);
  }

  for (const targetNode of candidateNodes) {
    if (targetNode.id === sourceNodeId) continue;

    const parsedTarget = parseNodeId(targetNode.id);
    if (!parsedTarget) continue;

    const isSameFile = 
      path.resolve(targetNode.file_path).replace(/\\/g, '/').toLowerCase() === 
      path.resolve(sourceFilePath).replace(/\\/g, '/').toLowerCase();
    const symbolName = parsedTarget.symbolName;
    const memberName = parsedTarget.memberName;
    const className = parsedTarget.className;

    if (isSameFile) {
      // Local dependency within same file. Skip when isolation failed — in
      // whole-file-scan mode every symbol would link to every other one.
      if (isolationFailed) continue;
      const nameToCheck = memberName || symbolName;
      if (referencedNames.has(nameToCheck)) {
        connections.add(targetNode.id);
      }
      continue;
    }

    // Different files: cross-file reference validation
    let isImported = false;
    let importedAsNames: string[] = [];
    // Default imports can be renamed to anything by the importer (e.g.
    // `import addToCartSchema from "./schema"` where the target's own declared name is
    // "AddOrUpdateCartItemSchema"). Track these separately — matching them requires
    // checking the LOCAL ALIAS was referenced, not the target's original name, since the
    // original name may never appear anywhere in the importing file at all.
    let importedAsDefaultNames: string[] = [];
    // Whether the target's file was pulled in via `import * as ns from '...'`. With a
    // namespace import the whole module is in scope, so a `ns.symbol` property access
    // is the real usage signal (the target's own name, not a local alias).
    let importedViaNamespace = false;

    // Match the precomputed imports against this candidate's file (cheap string ops only).
    if (isTsOrJs && resolvedImports.length > 0) {
      for (const ri of resolvedImports) {
        let matched = ri.paths.some(p => p && matchPaths(p, targetNode.file_path));
        // Barrel hit: an index re-exports the target's file. Only accept when the
        // re-exported name matches the import binding (or it's an `export *`).
        if (!matched && ri.barrels.length > 0) {
          matched = ri.barrels.some(rx =>
            (rx.name === null || rx.name === ri.importedName) &&
            matchPaths(rx.resolvedBase, targetNode.file_path)
          );
        }
        if (matched) {
          isImported = true;
          importedAsNames.push(ri.importedName);
          if (ri.isDefault) importedAsDefaultNames.push(ri.importedName);
          if (ri.isNamespace) importedViaNamespace = true;
        }
      }
    }

    if (isImported) {
      if (memberName) {
        // Reference-based member matching relies on the subtree being isolated. When
        // isolation failed we're scanning the whole file, so EVERY method of an imported
        // class would match — the explosive false-positive case. Suppress those here and
        // keep only the reliable explicit-import match below.
        if (!isolationFailed) {
          // e.g. Class.method: the class must be imported AND actually referenced in
          // this subtree (e.g. `new UserService()`), and the method name referenced.
          // Requiring the class be referenced — not just imported at file level —
          // prevents `res.status(...)` from matching an imported `OrderService.status`.
          if (
            className &&
            importedAsNames.includes(className) &&
            referencedNames.has(className) &&
            referencedNames.has(memberName)
          ) {
            connections.add(targetNode.id);
            continue;
          }
          // Class was a renamed default export — match on the (possibly aliased) import
          // binding instead of the original class name, which may not appear in the file.
          // Gate on the class actually BEING the target file's default export, so a
          // default import doesn't link to every symbol in a large file.
          if (className && referencedNames.has(memberName)) {
            const defName = getDefaultExportName(targetNode.file_path);
            if (
              defName !== null &&
              importedAsDefaultNames.some(alias =>
                referencedNames.has(alias) &&
                (className === defName ||
                  (defName === ANON_DEFAULT && alias.toLowerCase() === className.toLowerCase()))
              )
            ) {
              connections.add(targetNode.id);
              continue;
            }
          }
          // Namespace import: `ns.Class.method` / `ns.member` — the class/member is
          // reached through the namespace object, so its name appears as a reference.
          if (importedViaNamespace && referencedNames.has(memberName)) {
            connections.add(targetNode.id);
            continue;
          }
        }
        // NOTE: we intentionally do NOT match `Class.method` on `importedAsNames.includes(memberName)`.
        // A class method is never importable by name, so that only ever fires on a name
        // collision with a same-named FREE function import (e.g. `import { formatDate }`
        // matching a `Utils.formatDate` method) — a pure false positive.
      } else {
        // Top-level function/variable imported & referenced
        if (importedAsNames.includes(symbolName) && referencedNames.has(symbolName)) {
          connections.add(targetNode.id);
          continue;
        }
        // Renamed default export: the target's own declared name may never appear in
        // this file at all — only the local alias the importer chose. Only link to the
        // node that IS the file's default export, not every symbol in that file. For an
        // anonymous default (`export default Joi.object({...})`) there's no source name,
        // so bridge the alias to the extractor's node name case-insensitively
        // (`createOrderSchema` → `CreateOrderSchema`).
        const defName = getDefaultExportName(targetNode.file_path);
        if (
          defName !== null &&
          importedAsDefaultNames.some(alias =>
            referencedNames.has(alias) &&
            (symbolName === defName ||
              (defName === ANON_DEFAULT && alias.toLowerCase() === symbolName.toLowerCase()))
          )
        ) {
          connections.add(targetNode.id);
          continue;
        }
        // Namespace import: `ns.symbol(...)` — the target's own name appears as a
        // property access on the namespace object. Requires isolation (whole-file scan
        // would match every member of the namespaced module).
        if (!isolationFailed && importedViaNamespace && referencedNames.has(symbolName)) {
          connections.add(targetNode.id);
          continue;
        }
      }
    }

    // Tiny single-purpose file with an ANONYMOUS default export (Joi schemas, config
    // objects): the extractor names these nodes inconsistently (`default`, `Foo.schema`,
    // dotted/3-part), so every name-based branch above misses them. If the file was
    // default-imported and its alias is referenced here, and the file is small enough that
    // its default export is unambiguous, link it. The node-count gate keeps this from
    // re-exploding on large files (whose default export is virtually always named anyway).
    if (
      isImported &&
      importedAsDefaultNames.some(alias => referencedNames.has(alias)) &&
      getDefaultExportName(targetNode.file_path) === ANON_DEFAULT &&
      (nodesPerFile.get(normFile(targetNode.file_path)) ?? 99) <= 3
    ) {
      connections.add(targetNode.id);
      continue;
    }

    // Fallback: Only allow for top-level, non-class symbols (no className)
    // within the same repository, and require it to be very specific/long (length >= 16).
    // Skip when isolation failed — this is the only branch that links with NO import
    // relationship, so under a whole-file/regex scan it would connect any long token
    // (even in non-JS files) to a same-named node across files.
    if (!isolationFailed && !className && parsedSource.repo === parsedTarget.repo) {
      const nameToCheck = symbolName;
      if (nameToCheck.length >= 16 && referencedNames.has(nameToCheck)) {
        if (!commonNames.has(nameToCheck.toLowerCase())) {
          connections.add(targetNode.id);
        }
      }
    }
  }

  return Array.from(connections);
}
