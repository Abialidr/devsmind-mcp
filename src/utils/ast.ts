import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { loadProjectContext, resolveRepoPath } from './config';
import { writeFileAtomic } from './edit';

/**
 * Extensions the TypeScript parser can read, and therefore the only ones where a symbol's exact
 * span is knowable — live code extraction, AST edge resolution, and in-place editing are all
 * limited to these. Every other indexed language falls back to regex reference matching.
 *
 * `.mjs`/`.cjs` are plain JavaScript and parse fine (TS understands both script kinds); they are
 * listed for the same reason `.js` is. Template-based formats (`.vue`, `.svelte`) are NOT here —
 * their files aren't valid JS, so the parser would choke on the markup.
 */
export const AST_PARSEABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']);

/** Single-file-component formats: real JS, but only inside their `<script>` block. */
const SFC_EXTENSIONS = new Set(['.vue', '.svelte']);

/**
 * For a single-file component, blank every character outside its `<script>` block(s) while
 * preserving the file's exact length and line breaks. The parser then sees only JavaScript,
 * yet every offset it reports still indexes the REAL file — which is what lets the rest of
 * this module treat `.vue`/`.svelte` like any other source file. Other extensions pass through.
 */
function maskNonScript(text: string, filePath: string): string {
  if (!SFC_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return text;
  const masked = text.replace(/[^\n]/g, ' ').split('');
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const innerStart = m.index + m[0].indexOf('>') + 1;
    for (let i = 0; i < m[1].length; i++) masked[innerStart + i] = text[innerStart + i];
  }
  return masked.join('');
}

/** Parse `text` as the JS/TS belonging to `filePath`, masking SFC markup first. */
function parseText(filePath: string, text: string): ts.SourceFile {
  const isSfc = SFC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  return ts.createSourceFile(
    filePath,
    maskNonScript(text, filePath),
    ts.ScriptTarget.Latest,
    true,
    // An SFC's extension tells TS nothing; its <script> may be either language, and TS is a
    // superset of JS, so parsing as TS reads both.
    isSfc ? ts.ScriptKind.TS : undefined
  );
}

/** True when `filePath` can be parsed for exact symbol spans. */
export function isAstParseable(filePath: string): boolean {
  return AST_PARSEABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Canonical form for COMPARING two filesystem paths — absolute, forward slashes, lower case.
 *
 * Windows reaches the same file through several spellings (`c:\x` vs `C:/x`), so any exact
 * match against a stored path silently misses unless both sides are folded first. Comparison
 * only: never write this back to disk or store it as a node's file_path.
 */
export function normalizeFsPath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

/**
 * Drop a file's cached AST. The cache is mtime-keyed, but mtime resolution is coarse enough
 * that a write followed immediately by a read can still be served the pre-write tree, so a
 * writer must invalidate explicitly rather than trust the timestamp to have moved.
 */
export function invalidateParsedFile(filePath: string): void {
  sourceFileCache.delete(filePath);
}

interface ParsedNodeId {
  repo: string;
  filePath: string;
  symbolName: string;
  className?: string;
  memberName?: string;
}

export interface ImportInfo {
  importedName: string;
  moduleSpecifier: string;
  isDefault: boolean;
  isNamespace?: boolean; // `import * as X from '...'`
}

/** A used reference that resolves to a real repo file but has no node — a Phase-1 gap. */
export interface MissingRef {
  sourceNodeId: string;
  name: string;
  targetFile: string;
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
  /* istanbul ignore if -- defensive: every node from a tree parsed with setParentNodes=true
     (see parseText) has a parent except the SourceFile itself, which is never an Identifier. */
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

/** Nodes that introduce their own variable scope (for free-variable analysis). */
function isFunctionLikeScope(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * Names bound directly in `scopeNode`'s own scope: its parameters plus every
 * declaration anywhere in its body EXCEPT those inside nested function scopes (which
 * own their bindings). Collected up front so forward references (a function that calls
 * a sibling declared later) resolve as bound, not free.
 */
function collectScopeBindings(scopeNode: ts.Node): Set<string> {
  const bound = new Set<string>();
  const add = (name: ts.Node | undefined) => {
    if (name && ts.isIdentifier(name)) bound.add(name.text);
  };
  function collect(n: ts.Node) {
    if (ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) add(n.name);
    else if (ts.isParameter(n) && ts.isIdentifier(n.name)) add(n.name);
    else if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) add(n.name);
    else if (ts.isCatchClause(n) && n.variableDeclaration) add(n.variableDeclaration.name);
    // Do not descend into nested function scopes — their params/locals belong to them.
    if (n !== scopeNode && isFunctionLikeScope(n)) return;
    ts.forEachChild(n, collect);
  }
  ts.forEachChild(scopeNode, collect);
  return bound;
}

/**
 * Scope-aware free-variable analysis. Returns the names a node USES that are NOT declared
 * within its own scope (its genuine external dependencies) — plus the set of `this.<member>`
 * accesses. Locally-declared names, parameters, and nested-closure bindings are excluded,
 * which removes the name-collision noise that the flat collectReferencedNames produced (a
 * local `const total` no longer matches an unrelated node named `total`). Property-access
 * member names and JSX tags are kept (used for member/namespace matching downstream).
 */
function collectFreeReferences(root: ts.Node): { free: Set<string>; thisMembers: Set<string> } {
  const free = new Set<string>();
  const thisMembers = new Set<string>();

  function walk(node: ts.Node, stack: Set<string>[]) {
    const scope = isFunctionLikeScope(node) ? [...stack, collectScopeBindings(node)] : stack;

    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isIdentifier(node.name)
    ) {
      thisMembers.add(node.name.text);
    }

    if (ts.isIdentifier(node)) {
      const parent = node.parent as ts.Node | undefined;
      if (isDefinitionName(node)) {
        // definition position — not a reference
      } else if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
        free.add(node.text); // member name of `a.b` — kept for member/namespace matching
      } else if (parent && ts.isQualifiedName(parent) && parent.right === node) {
        free.add(node.text); // qualified type name RHS
      } else {
        // genuine value/type reference — free iff not bound in any enclosing scope
        if (!scope.some(s => s.has(node.text))) free.add(node.text);
      }
    }

    ts.forEachChild(node, child => walk(child, scope));
  }

  walk(root, []);
  return { free, thisMembers };
}

/** Best-effort structural node type from an AST declaration (no framework subtype). */
function astBaseType(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return 'function';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type_alias';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isVariableDeclaration(node)) {
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return 'function';
    if (init && ts.isClassExpression(init)) return 'class';
    return 'variable';
  }
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) return 'variable';
  return 'variable';
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

/** One RTK Query endpoint found by {@link detectRtkEndpointAliases} — the endpoint's own declared
 * key, plus the hook names RTK Query's codegen convention derives from it. */
export interface RtkEndpointAlias {
  /** The endpoint key as written inside `endpoints: (builder) => ({ ... })` — expected to match
   * an existing node's declared name (the extractor names the node after this same key). */
  endpointName: string;
  /** Generated hook names this endpoint is ALSO referenceable by — `useLazy...` only applies to
   * `.query(...)` endpoints (RTK Query never generates a lazy variant for a mutation). */
  aliases: string[];
}

/**
 * Detects RTK Query `createApi`/`injectEndpoints` endpoint definitions in a file and synthesizes
 * the hook names RTK Query's code generator derives from each endpoint key — pure naming
 * convention (`getAdminOrders` + `.query(...)` → `useGetAdminOrdersQuery` + `useLazyGetAdminOrdersQuery`;
 * `.mutation(...)` → `useGetAdminOrdersMutation`), no AI involved, and exactly as reliable as
 * reading RTK Query's own source for that convention.
 *
 * This exists because those hook names are NEVER a symbol the AST can see declared anywhere —
 * they're manufactured at runtime by `createApi`, so a component importing/calling
 * `useGetAdminOrdersQuery` has no declaration to resolve against, and the caller edge to the
 * `getAdminOrders` endpoint simply cannot exist without this. Feed the result into each matching
 * node's `aliases` (see `DbNode.aliases`) and {@link resolveConnectionsLocally}'s alias-aware
 * matching picks the edge up like any other reference.
 */
/** One `key: builder.query(...)`/`key: builder.mutation(...)` property found inside a
 * `createApi`/`injectEndpoints` `endpoints: (builder) => ({...})` object — the shared match both
 * {@link detectRtkEndpointAliases} and {@link detectRtkEndpointNodes} build on. */
interface RtkEndpointMatch {
  propNode: ts.PropertyAssignment;
  epName: string;
  method: 'query' | 'mutation';
}

/**
 * Walks a source file for RTK Query endpoint definitions. Endpoint keys live inside
 * `endpoints: (builder) => ({ ... })` — an ARROW FUNCTION BODY — so they are structurally
 * invisible to the general declaration walk ({@link declarationsOverlapping}/`findNodeInAst`
 * both explicitly stop at function-body boundaries, since a local const or a helper defined
 * inside a function body is never a graph entity). RTK endpoints are the one exception to that
 * rule this codebase knows about, which is why they need their own dedicated walk rather than
 * being reachable by the general "find a declaration by name" machinery.
 */
function findRtkEndpointMatches(sourceFile: ts.SourceFile): RtkEndpointMatch[] {
  const results: RtkEndpointMatch[] = [];

  function findEndpointsObject(fnBody: ts.ConciseBody): ts.ObjectLiteralExpression | null {
    const unwrap = (e: ts.Expression): ts.Expression =>
      ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
    if (ts.isBlock(fnBody)) {
      for (const stmt of fnBody.statements) {
        if (ts.isReturnStatement(stmt) && stmt.expression) {
          const expr = unwrap(stmt.expression);
          if (ts.isObjectLiteralExpression(expr)) return expr;
        }
      }
      return null;
    }
    const expr = unwrap(fnBody);
    return ts.isObjectLiteralExpression(expr) ? expr : null;
  }

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'createApi' || node.expression.text === 'injectEndpoints') &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const configObj = node.arguments[0];
      for (const prop of configObj.properties) {
        if (
          !ts.isPropertyAssignment(prop) ||
          !ts.isIdentifier(prop.name) ||
          prop.name.text !== 'endpoints' ||
          !(ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer))
        ) continue;

        const endpointsObj = findEndpointsObject(prop.initializer.body);
        if (!endpointsObj) continue;

        for (const epProp of endpointsObj.properties) {
          if (
            !(ts.isPropertyAssignment(epProp) || ts.isMethodDeclaration(epProp)) ||
            !(ts.isIdentifier(epProp.name) || ts.isStringLiteral(epProp.name))
          ) continue;
          const epName = epProp.name.text;

          // `.query(...)` / `.mutation(...)` may appear either as `key: builder.query(...)`
          // (property assignment) or `key(builder) { return builder.query(...) }` (method) —
          // only the property-assignment shape is RTK Query's documented form, so that's all we
          // match; a method-shorthand endpoint falls through and simply isn't found.
          if (!ts.isPropertyAssignment(epProp) || !ts.isCallExpression(epProp.initializer)) continue;
          const callExpr = epProp.initializer;
          if (!ts.isPropertyAccessExpression(callExpr.expression)) continue;
          const method = callExpr.expression.name.text;
          if (method !== 'query' && method !== 'mutation') continue;

          results.push({ propNode: epProp, epName, method });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

export function detectRtkEndpointAliases(filePath: string): RtkEndpointAlias[] {
  if (!isAstParseable(filePath)) return [];
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = getSourceFile(filePath);
  } catch {
    return [];
  }

  const toPascal = (name: string): string => (name.length ? name[0].toUpperCase() + name.slice(1) : name);
  return findRtkEndpointMatches(sourceFile).map(({ epName, method }) => {
    const pascal = toPascal(epName);
    const aliases = method === 'query'
      ? [`use${pascal}Query`, `useLazy${pascal}Query`]
      : [`use${pascal}Mutation`];
    return { endpointName: epName, aliases };
  });
}

/**
 * The candidate-enumeration counterpart to {@link detectRtkEndpointAliases}: produces full
 * {@link ExtractionCandidate}s for each RTK endpoint, so {@link enumerateFileCandidates} doesn't
 * silently skip them (see {@link findRtkEndpointMatches} for why the general declaration walk
 * can't see them). Always `isExported:true` — an endpoint reached only through its generated hook
 * is, for every practical purpose, part of the file's export surface; nothing about whether it
 * "counts" as a node is a judgment call, so this feeds the SAME auto-accept path as a normal
 * exported declaration.
 */
export function detectRtkEndpointNodes(filePath: string): ExtractionCandidate[] {
  if (!isAstParseable(filePath)) return [];
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = getSourceFile(filePath);
  } catch {
    return [];
  }

  return findRtkEndpointMatches(sourceFile).map(({ propNode, epName }) => {
    const start = propNode.getStart(sourceFile);
    const end = propNode.getEnd();
    const code = propNode.getText(sourceFile);
    return {
      qualified: epName,
      name: epName,
      type: 'rtk_endpoint',
      signature: code.split('\n')[0].slice(0, 200),
      codeSnapshot: code,
      startLine: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
      endLine: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
      isExported: true
    };
  });
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
  /* istanbul ignore next -- unreachable: every iteration of the loop above returns (either
     `null` via a missing prop, or `prop` on the last segment), so control can only fall past
     the loop when `segments` is empty. The sole caller (findInFrameworkContainer) already
     guards `segments.length === 0` before ever calling this function. */
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
  /* istanbul ignore if -- defensive: the sole caller (findNodeInAst) only reaches here when
     `symbolName.includes('.')`, so `segments` (symbolName.split('.').slice(1)) always has at
     least one element. */
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
    /* istanbul ignore next -- defensive: every current caller sets `className` from a symbolName
       that included a '.' in the first place (locateNodeInFile/codeOfSymbol split on 2 parts,
       resolveConnectionsLocally's className comes from parseNodeId, which only sets it alongside
       a dotted symbolName), so the ": symbolName" (no-dot) fallback is never exercised. */
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
  const sf = parseText(filePath, text);
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

// Resolve a set of extension-less base paths to the first actual source file on disk
// (tries .ts/.tsx/.js/.jsx and /index.*). Returns null for bare/node_modules specifiers
// that don't map to a repo file. Cached — file existence is stable within an indexing run.
const existingFileCache = new Map<string, string | null>();
function resolveToExistingFile(basePaths: string[]): string | null {
  const key = basePaths.join('|');
  const cached = existingFileCache.get(key);
  if (cached !== undefined) return cached;
  let result: string | null = null;
  outer: for (const base of basePaths) {
    /* istanbul ignore if -- defensive: every entry basePaths can contain comes from
       resolveImportToPaths, which only ever pushes path.resolve(...) results (always a
       non-empty string) or pushes nothing at all — never a falsy element. */
    if (!base) continue;
    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      if (fs.existsSync(base + ext)) { result = base + ext; break outer; }
    }
    for (const idx of ['/index.ts', '/index.tsx', '/index.js', '/index.jsx']) {
      if (fs.existsSync(base + idx)) { result = base + idx; break outer; }
    }
    try {
      if (fs.existsSync(base) && fs.statSync(base).isFile()) { result = base; break outer; }
    } catch { /* ignore */ }
  }
  existingFileCache.set(key, result);
  return result;
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

  /* istanbul ignore next -- defensive TOCTOU guard: `indexPath` was confirmed to exist one line
     above via fs.existsSync; the `?? -1` only matters if the file is deleted in the instant
     between that check and this statSync, a race not worth simulating in a unit test. */
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
/**
 * The name for a non-identifier `export default <expr>` (an ExportAssignment): a named class or
 * function expression's own name, or the ANON_DEFAULT marker for anything else.
 */
function anonOrNamedExpressionDefaultName(expr: ts.Expression): string {
  /* istanbul ignore next -- unreachable: `export default class Foo {}` / `export default
     function foo() {}`, named or anonymous, always parse as a ClassDeclaration/FunctionDeclaration
     (getDefaultExportName's other, `stmt.name ? ... : ANON_DEFAULT`, branch), never as this
     ExportAssignment's `expression`. The only way a ClassExpression/FunctionExpression can reach
     here at all is wrapped (`export default (class Foo {})`), and then `expr` is the
     ParenthesizedExpression, not the class/function expression itself — so this never matches in
     practice, verified directly against the TS parser. */
  if ((ts.isClassExpression(expr) || ts.isFunctionExpression(expr)) && expr.name) return expr.name.text;
  return ANON_DEFAULT; // `export default Joi.object({...})`, `{...}`, `() => …`
}

const defaultExportCache = new Map<string, { mtimeMs: number; name: string | null }>();
function getDefaultExportName(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return null;
  /* istanbul ignore next -- defensive TOCTOU guard: every caller passes a `targetNode.file_path`
     it already has from a live candidate-node list, i.e. a file that exists; the `?? -1` only
     matters if it's deleted in the instant before this statSync. */
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
        name = ts.isIdentifier(expr) ? expr.text : anonOrNamedExpressionDefaultName(expr);
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
  candidateNodes: { id: string; name: string; type: string; file_path: string; aliases?: string[] }[],
  devmindPath: string,
  onMissing?: (rec: MissingRef) => void
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
  const isTsOrJs = isAstParseable(sourceFilePath);
  const tsPaths = loadTsPaths(repoRoot);

  let referencedNames = new Set<string>();
  let thisMembers = new Set<string>();
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

      // Locate the AST node for this class/method/function, then collect its FREE
      // variables (names used but not declared in its own scope). Scope-awareness means
      // locals/params are excluded, so they can no longer collide with unrelated nodes.
      const astNode = findNodeInAst(sourceFile, parsedSource.className, parsedSource.symbolName);
      if (astNode) {
        const fr = collectFreeReferences(astNode);
        referencedNames = fr.free;
        thisMembers = fr.thisMembers;
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

  // Resolve every import's candidate paths + barrel re-exports ONCE per source node.
  // This is candidate-independent, so doing it inside the candidate loop (7000+ nodes)
  // was re-running filesystem probes thousands of times per source node.
  const resolvedImports: ResolvedImport[] = [];
  if (isTsOrJs) {
    for (const imp of imports) {
      const paths = resolveImportToPaths(imp.moduleSpecifier, sourceDir, repoRoot, tsPaths);
      const barrels: BarrelReexport[] = [];
      for (const p of paths) {
        /* istanbul ignore if -- defensive: see the matching guard in resolveToExistingFile —
           resolveImportToPaths never pushes a falsy path. */
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
  // Names present per file — used for missing-node detection (does an imported symbol
  // actually have a node in its file?). Includes each node's name plus its id's symbol parts.
  const nodeNamesByFile = onMissing ? new Map<string, Set<string>>() : null;
  for (const n of candidateNodes) {
    for (const p of String(n.file_path).split(',').map(s => s.trim()).filter(Boolean)) {
      const k = normFile(p);
      nodesPerFile.set(k, (nodesPerFile.get(k) ?? 0) + 1);
      if (nodeNamesByFile) {
        let set = nodeNamesByFile.get(k);
        if (!set) { set = new Set<string>(); nodeNamesByFile.set(k, set); }
        set.add(n.name);
        const parsed = parseNodeId(n.id);
        if (parsed) {
          set.add(parsed.symbolName);
          if (parsed.className) set.add(parsed.className);
          if (parsed.memberName) set.add(parsed.memberName);
        }
      }
    }
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
      // For a sibling method in the SAME class, prefer a `this.<member>` access (precise)
      // but still accept a bare free reference to the member name.
      if (
        memberName && className && className === parsedSource.className && thisMembers.has(memberName)
      ) {
        connections.add(targetNode.id);
        continue;
      }
      // Check the target's own name AND any alias it's exported under (e.g. an RTK-generated
      // hook name for its endpoint) — one implementation, several referenceable handles.
      const nameToCheck = memberName || symbolName;
      const targetNames = [nameToCheck, ...(targetNode.aliases ?? [])];
      if (targetNames.some(n => referencedNames.has(n))) {
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
        // Top-level function/variable imported & referenced — check the target's own declared
        // name AND any alias it's exported under. This is the RTK fix: a caller importing
        // `useGetAdminOrdersQuery` (generated by createApi, never a name that appears in the
        // endpoint's own declaration) still resolves to the `getAdminOrders` endpoint node, as
        // long as that alias was attached to it (see the RTK detector / Phase C).
        const targetNames = [symbolName, ...(targetNode.aliases ?? [])];
        if (targetNames.some(n => importedAsNames.includes(n) && referencedNames.has(n))) {
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
    // `?? 99` is defensive only: `nodesPerFile` is built from `candidateNodes`, which always
    // includes `targetNode` itself, so its own file is always present with count >= 1; the
    // `?? 99` fallback can never actually be taken.
    /* istanbul ignore next */
    const targetFileNodeCount = nodesPerFile.get(normFile(targetNode.file_path)) ?? 99;
    if (
      isImported &&
      importedAsDefaultNames.some(alias => referencedNames.has(alias)) &&
      getDefaultExportName(targetNode.file_path) === ANON_DEFAULT &&
      targetFileNodeCount <= 3
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
      // Free-variable analysis already excludes locals, so the old `commonNames` denylist
      // (which existed to blunt local-var noise) is no longer needed.
      if (nameToCheck.length >= 16 && referencedNames.has(nameToCheck)) {
        connections.add(targetNode.id);
      }
    }
  }

  // Missing-node detection: a name imported from a real repo file and actually used here,
  // but with no node in that file, is a Phase-1 extraction gap. (Namespace imports are
  // skipped — the specific missing symbol can't be attributed. node_modules/bare specifiers
  // resolve to no repo file and are ignored.)
  if (onMissing && nodeNamesByFile && isTsOrJs && !isolationFailed) {
    for (const ri of resolvedImports) {
      if (ri.isNamespace || !referencedNames.has(ri.importedName)) continue;
      const file = resolveToExistingFile(ri.paths);
      if (!file) continue;
      const names = nodeNamesByFile.get(normFile(file));
      const satisfied = !!names && (names.has(ri.importedName) || (ri.isDefault && names.size > 0));
      if (!satisfied) {
        onMissing({ sourceNodeId, name: ri.importedName, targetFile: file });
      }
    }
  }

  return Array.from(connections);
}

/**
 * Derive a node's identity/type/code directly from its declaration in a file — deterministic,
 * no LLM. Used by `--fill-missing` to create nodes that Phase-1 extraction skipped. Returns
 * null when the file isn't TS/JS or the symbol can't be located.
 */
/** A symbol's exact span in its file — everything needed to splice it in place. */
export interface NodeLocation {
  name: string;
  type: string;
  signature: string | null;
  codeSnapshot: string;
  /** Offset of the symbol's first token. Excludes leading JSDoc/comments, so they survive a replace. */
  start: number;
  /** Offset just past the symbol's last token. */
  end: number;
  /** 1-based line of `start`. */
  startLine: number;
  /** 1-based line of `end`. */
  endLine: number;
  /** Whitespace `start` is indented by, or '' when the symbol doesn't begin its line. */
  indent: string;
}

/**
 * Locate a symbol's span in a file via the AST. This is the write-side counterpart to
 * `extractNodeFromFile`: same lookup, but it also surfaces the offsets, so a caller can
 * replace the symbol without the caller ever having to read the file or reproduce its
 * text byte-exactly.
 */
export function locateNodeInFile(filePath: string, symbolName: string): NodeLocation | null {
  if (!isAstParseable(filePath)) return null;
  try {
    const sf = getSourceFile(filePath);
    const parts = symbolName.split('.');
    const className = parts.length === 2 ? parts[0] : undefined;
    const node = findNodeInAst(sf, className, symbolName);
    if (!node) return null;

    const start = node.getStart(sf); // skips leading trivia → a JSDoc block above stays put
    const end = node.getEnd();
    const code = node.getText(sf);
    const full = sf.getFullText();

    // Indent is only meaningful when nothing but whitespace precedes the symbol on its line;
    // for an inline symbol (`const x = function () {}`) there is no indent to re-apply.
    const lineStart = full.lastIndexOf('\n', start - 1) + 1;
    const prefix = full.slice(lineStart, start);
    return {
      name: parts[parts.length - 1] || symbolName,
      type: astBaseType(node),
      signature: code.split('\n')[0].slice(0, 200),
      codeSnapshot: code,
      start,
      end,
      startLine: sf.getLineAndCharacterOfPosition(start).line + 1,
      endLine: sf.getLineAndCharacterOfPosition(end).line + 1,
      indent: /^[ \t]*$/.test(prefix) ? prefix : ''
    };
  } catch {
    return null;
  }
}

export function extractNodeFromFile(
  filePath: string,
  symbolName: string
): { name: string; type: string; signature: string | null; codeSnapshot: string } | null {
  const loc = locateNodeInFile(filePath, symbolName);
  if (!loc) return null;
  const { name, type, signature, codeSnapshot } = loc;
  return { name, type, signature, codeSnapshot };
}

/** A symbol an edit landed inside — what actually changed, derived from where the write went. */
export interface TouchedSymbol {
  /** Set only when the edit fell inside a symbol the graph already knows. */
  node_id?: string;
  /** Qualified symbol name, e.g. "Cart.applyPromo" or "calculateTax". */
  symbolName: string;
  name: string;
  type: string;
  signature: string | null;
  codeSnapshot: string;
  /**
   * The symbol's text before this edit, or null when there is nothing to compare against —
   * a brand-new symbol, or a caller that passed no before-content. Feeds the diff/revert path.
   */
  codeBefore: string | null;
  startLine: number;
  endLine: number;
  /** True when no existing node covered this edit — a symbol that did not exist before. */
  isNew: boolean;
}

/**
 * The name a declaration contributes to a node id, or null if it isn't one the graph models.
 *
 * Mirrors the shapes `findNodeInAst` resolves in the opposite direction, including the
 * object-literal factory form (`Page({ onShopLook() {} })` → `Page.onShopLook`) used by
 * mini-program style frameworks.
 */
function declarationNameOf(node: ts.Node): { name: string; qualified: string } | null {
  const plain = (n: ts.Node & { name?: ts.Node }): string | null =>
    n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) ? n.name.text : null;

  // Nothing declared inside a function body is a graph entity: a local `const`, a helper
  // function, an object literal built in a return statement. Only declarations reachable from
  // the file without passing through a function qualify — which still admits class members and
  // factory-call members, since a class or a call is not a function body.
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isSourceFile(p)) break;
    if (isFunctionLikeScope(p)) return null;
  }

  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) {
    const n = plain(node as any);
    return n ? { name: n, qualified: n } : null;
  }

  // Class members carry their class name. A method may also live in an object literal rather
  // than a class, so membership is decided by the parent, not by the node kind.
  if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node) || ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node)) {
    const member = ts.isConstructorDeclaration(node) ? 'constructor' : plain(node as any);
    if (!member) return null;

    if (node.parent && ts.isClassLike(node.parent) && node.parent.name) {
      return { name: member, qualified: `${node.parent.name.text}.${member}` };
    }

    // A plain key is only a symbol when its object is itself named — `Page({ data: {...} })`
    // or `const api = { timeout: 30 }`. Keys nested deeper (`data: { n: 1 }` → `n`) are that
    // object's CONTENTS, not entities of their own: the graph models `Page.data`, never
    // `Page.n`. Methods are exempt — a function nested at any depth is still a real symbol.
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      /* istanbul ignore next -- defensive: by grammar, a PropertyAssignment/
         ShorthandPropertyAssignment's parent is always its containing ObjectLiteralExpression, so
         the `: undefined` (not-an-object-literal-parent) side of this ternary is unreachable. */
      const owner = node.parent && ts.isObjectLiteralExpression(node.parent) ? node.parent.parent : undefined;
      const namedObject = owner && (ts.isCallExpression(owner) || ts.isVariableDeclaration(owner));
      if (!namedObject) return null;
    }

    // Otherwise it sits inside an object literal. Walk out to whatever names that object:
    // a factory call (`Page({...})` → `Page.onShopLook`) or a variable (`const api = {...}`).
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression)) {
        return { name: member, qualified: `${cur.expression.text}.${member}` };
      }
      if (ts.isVariableDeclaration(cur) && cur.name && ts.isIdentifier(cur.name)) {
        return { name: member, qualified: `${cur.name.text}.${member}` };
      }
      if (ts.isClassLike(cur) && cur.name) {
        return { name: member, qualified: `${cur.name.text}.${member}` };
      }
    }
    return { name: member, qualified: member };
  }

  if (ts.isVariableDeclaration(node)) {
    const n = plain(node as any);
    return n ? { name: n, qualified: n } : null;
  }

  return null;
}

/** Every declaration whose span overlaps one of `ranges`, innermost-first ordering not implied. */
function declarationsOverlapping(
  sf: ts.SourceFile,
  ranges: { start: number; end: number }[]
): { node: ts.Node; name: string; qualified: string; start: number; end: number }[] {
  // A zero-width range (a pure deletion) still has to intersect something, so give it width 1.
  const spans = ranges.map(r => ({ start: r.start, end: Math.max(r.end, r.start + 1) }));
  const hits: { node: ts.Node; name: string; qualified: string; start: number; end: number }[] = [];

  const visit = (n: ts.Node) => {
    const start = n.getStart(sf);
    const end = n.getEnd();
    if (!spans.some(s => start < s.end && s.start < end)) return; // disjoint — skip its subtree
    const named = declarationNameOf(n);
    if (named) hits.push({ node: n, name: named.name, qualified: named.qualified, start, end });
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return hits;
}

/**
 * Whether a declaration is part of the file's export surface — directly (`export function foo`,
 * `export const foo = ...`), via a separate `export { foo }` statement, or transitively (a method
 * of an exported class, a member of an object literal assigned to an exported variable). This is
 * the auto-accept signal for {@link enumerateFileCandidates}: an exported, named declaration is
 * unambiguously a real entity — nothing about its EXISTENCE is a judgment call, only an
 * unexported/anonymous one needs curation.
 */
function isNodeExported(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  // Class/object-literal members inherit their container's export status — a method isn't
  // separately "exported", it's reachable (or not) through whatever names its class/object.
  if (
    ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node) ||
    ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)
  ) {
    if (node.parent && ts.isClassLike(node.parent)) return isNodeExported(node.parent, sourceFile);
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if (ts.isVariableStatement(cur)) return isNodeExported(cur, sourceFile);
      if (ts.isSourceFile(cur)) break;
    }
    return false;
  }

  const hasExportModifier = (n: ts.Node): boolean =>
    !!(n as { modifiers?: readonly ts.ModifierLike[] }).modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);

  // `export const foo = ...`: the `export` modifier sits on the enclosing VariableStatement, not
  // on the VariableDeclaration itself.
  const modifierHost = ts.isVariableDeclaration(node) && node.parent && ts.isVariableDeclarationList(node.parent)
    ? node.parent.parent
    : node;
  if (hasExportModifier(modifierHost)) return true;

  // `export { foo, bar }` as its own statement elsewhere in the file, not a modifier at all.
  const declaredName =
    (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) ? node.name.text :
    ((node as { name?: ts.Node }).name && ts.isIdentifier((node as { name?: ts.Node }).name as ts.Node))
      ? ((node as { name?: ts.Identifier }).name as ts.Identifier).text
      : null;
  if (!declaredName) return false;

  for (const stmt of sourceFile.statements) {
    if (
      ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier &&
      stmt.exportClause && ts.isNamedExports(stmt.exportClause)
    ) {
      if (stmt.exportClause.elements.some(el => el.name.text === declaredName || el.propertyName?.text === declaredName)) {
        return true;
      }
    }
  }
  return false;
}

/** One deterministically-enumerated candidate entity from {@link enumerateFileCandidates}. */
export interface ExtractionCandidate {
  /** Graph node-id name — `Class.method` for a member, a bare name at top level. */
  qualified: string;
  name: string;
  type: string;
  signature: string | null;
  codeSnapshot: string;
  startLine: number;
  endLine: number;
  /** See {@link isNodeExported} — the auto-accept signal. */
  isExported: boolean;
}

/**
 * Enumerates every graph-eligible declaration in a file, deterministically — no LLM, so nothing
 * gets silently missed the way the old whole-file-to-an-LLM extraction could. A named, EXPORTED
 * declaration (`isExported:true`) is unambiguous: whether it "counts" as a node requires no
 * judgment, so the caller can auto-accept it with zero LLM turns. Everything else — unexported
 * helpers, anonymous default exports, tiny inline callbacks, object-literal factory members whose
 * significance is genuinely a judgment call — is still enumerated (nothing is dropped silently)
 * but flagged `isExported:false`, so an agentic curation pass only has to spend turns on THOSE.
 */
export function enumerateFileCandidates(filePath: string): ExtractionCandidate[] {
  if (!isAstParseable(filePath)) return [];
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = getSourceFile(filePath);
  } catch {
    return [];
  }

  const fullText = sourceFile.getFullText();
  const hits = declarationsOverlapping(sourceFile, [{ start: 0, end: fullText.length }]);

  // A single declaration can surface more than once under different matching rules (e.g. a
  // property assignment's own span, and — if it were itself a match — an initializer nested
  // inside it). Keep the FIRST hit per qualified name: `declarationsOverlapping` walks
  // parent-before-child, so the first hit is always the outermost, correct one.
  const byQualified = new Map<string, (typeof hits)[number]>();
  for (const h of hits) {
    if (!byQualified.has(h.qualified)) byQualified.set(h.qualified, h);
  }

  const results: ExtractionCandidate[] = [];
  for (const h of byQualified.values()) {
    const code = h.node.getText(sourceFile);
    results.push({
      qualified: h.qualified,
      name: h.name,
      type: astBaseType(h.node),
      signature: code.split('\n')[0].slice(0, 200),
      codeSnapshot: code,
      startLine: sourceFile.getLineAndCharacterOfPosition(h.start).line + 1,
      endLine: sourceFile.getLineAndCharacterOfPosition(h.end).line + 1,
      isExported: isNodeExported(h.node, sourceFile)
    });
  }

  // RTK Query endpoints live inside a function body (`endpoints: (builder) => ({...})`), so the
  // general declaration walk above structurally cannot see them — see `findRtkEndpointMatches`.
  // Folded in here (not called separately by every consumer) so `enumerateFileCandidates` really
  // is the complete candidate list for a file, RTK or not.
  for (const rtkNode of detectRtkEndpointNodes(filePath)) {
    if (!byQualified.has(rtkNode.qualified)) results.push(rtkNode);
  }

  return results;
}

/** One entry in {@link outlineFile}'s "what else is declared in this file" list. Deliberately
 * lean — no `codeSnapshot` — see the function doc for why. */
export interface FileOutlineEntry {
  qualified: string;
  name: string;
  type: string;
  signature: string | null;
  start_line: number;
  end_line: number;
  exported: boolean;
}

/**
 * Every OTHER top-level declaration in a file — functions, classes, consts, types, interfaces —
 * the "what else is here" a raw file read used to be the only way to answer. Reuses
 * {@link enumerateFileCandidates}'s own declaration walk (`declarationsOverlapping` /
 * `astBaseType` / `isNodeExported`), but deliberately does NOT call `node.getText()` per hit the
 * way that function does: `enumerateFileCandidates` materializes each declaration's FULL source
 * just to build a one-line signature and then discards it, which is an extra copy of potentially
 * the whole file in string allocations — on every single `get_node_code` call, this is squarely
 * the wrong trade. A short slice of the already-loaded full text plus a line split gets the same
 * signature far cheaper. The parse itself is free either way: `getSourceFile` is mtime-cached
 * ({@link getSourceFile}), and by the time `get_node_code` calls this the file has usually already
 * been parsed once this same request via `getLiveCode`/`extractLiveCode`.
 */
export function outlineFile(filePath: string): FileOutlineEntry[] {
  if (!isAstParseable(filePath)) return [];
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = getSourceFile(filePath);
  } catch {
    return [];
  }

  const fullText = sourceFile.getFullText();
  const hits = declarationsOverlapping(sourceFile, [{ start: 0, end: fullText.length }]);

  // Same "keep the first (outermost) hit per qualified name" rule as enumerateFileCandidates —
  // declarationsOverlapping walks parent-before-child, so the first hit is always correct.
  const byQualified = new Map<string, (typeof hits)[number]>();
  for (const h of hits) {
    if (!byQualified.has(h.qualified)) byQualified.set(h.qualified, h);
  }

  const results: FileOutlineEntry[] = [];
  for (const h of byQualified.values()) {
    /* istanbul ignore next -- the `|| null` arm is unreachable: `declarationsOverlapping` takes
       each hit's start from `node.getStart(sf)`, which skips leading trivia, so the slice always
       begins at a real token character and its first line is never the empty string. Kept as a
       type-level guarantee that `signature` is `string | null` rather than `string | undefined`. */
    const signature = fullText.slice(h.start, h.start + 200).split('\n')[0] || null;
    results.push({
      qualified: h.qualified,
      name: h.name,
      type: astBaseType(h.node),
      signature,
      start_line: sourceFile.getLineAndCharacterOfPosition(h.start).line + 1,
      end_line: sourceFile.getLineAndCharacterOfPosition(h.end).line + 1,
      exported: isNodeExported(h.node, sourceFile)
    });
  }

  // RTK Query endpoints live inside a function body and the general walk above structurally
  // cannot see them (see detectRtkEndpointNodes) — folded in here so the outline is genuinely
  // complete, RTK or not, same as enumerateFileCandidates. Its own codeSnapshot is dropped; these
  // are individual endpoint bodies (small), not a whole-file cost, but the outline never carries
  // code regardless of source.
  for (const rtk of detectRtkEndpointNodes(filePath)) {
    if (byQualified.has(rtk.qualified)) continue;
    results.push({
      qualified: rtk.qualified,
      name: rtk.name,
      type: rtk.type,
      signature: rtk.signature,
      start_line: rtk.startLine,
      end_line: rtk.endLine,
      exported: rtk.isExported
    });
  }

  return results;
}

/**
 * A file's own import list — file-path entry point for {@link getFileImports} (which needs an
 * already-parsed `ts.SourceFile`). Used by the Phase D curation agent's `get_file_imports` tool:
 * whether an ambiguous candidate is worth keeping is often decided by whether it's ever imported
 * anywhere, and the file's OWN imports are the cheap first signal (e.g. a candidate that mirrors
 * a re-exported name, or that only makes sense alongside a specific imported dependency).
 */
export function listFileImports(filePath: string): ImportInfo[] {
  if (!isAstParseable(filePath)) return [];
  try {
    return getFileImports(getSourceFile(filePath));
  } catch {
    return [];
  }
}

/** A symbol's current source in `sf`, or null when it isn't there. */
function codeOfSymbol(sf: ts.SourceFile, symbolName: string): string | null {
  const parts = symbolName.split('.');
  const className = parts.length === 2 ? parts[0] : undefined;
  const node = findNodeInAst(sf, className, symbolName);
  return node ? node.getText(sf) : null;
}

/**
 * Work out which symbols an edit actually changed, from where the edit landed.
 *
 * Position beats name matching: a span is unambiguous where a name is not (fifty classes can
 * each have a `run`), it survives the symbol being renamed by the very edit being traced, and
 * it finds code that did not exist until this write.
 *
 * Three passes, each removing a specific kind of wrong answer:
 *   1. OVERLAP — every declaration intersecting the written span. A point would not do: text
 *      appended after an anchor (`}` → `}\n\nfunction added() {}`) begins inside the PREVIOUS
 *      function, so a point attributes the new function to its neighbour.
 *   2. INNERMOST — drop any declaration that contains another hit, so inserting a method
 *      reports the method and not its whole class.
 *   3. CHANGED — compare each survivor against `beforeContent` and keep only what actually
 *      differs. Overlap alone over-reports: the anchor's own function is intersected by an
 *      append yet is untouched by it, and re-recording it would invent history for a change
 *      that never happened. A symbol absent from `beforeContent` is new.
 *
 * Symbols already in the graph are matched by span against their RECORDED ids, never by
 * re-deriving a name — a container name may have been chosen at index time and be absent from
 * the source (`Component({...})` recorded as `ProductImageGalleryComponent`).
 *
 * `knownSymbols` should be the graph's nodes for this file; empty is fine, everything is then
 * reported as new. An edit touching no symbol at all (an import, markup, a config value) yields
 * nothing — a normal outcome, not an error.
 */
export function findTouchedSymbols(
  filePath: string,
  ranges: { start: number; end: number }[],
  knownSymbols: { id: string; symbolName: string }[] = [],
  beforeContent?: string
): TouchedSymbol[] {
  if (!isAstParseable(filePath) || !ranges.length) return [];

  try {
    const sf = getSourceFile(filePath);
    const before = beforeContent === undefined ? null : parseText(filePath, beforeContent);

    // 1. overlap
    const hits = declarationsOverlapping(sf, ranges);
    if (!hits.length) return [];

    // Prefer the graph's own id wherever a hit is the same span as a node it already knows.
    const byId = new Map<string, { id: string; symbolName: string }>();
    for (const k of knownSymbols) {
      const loc = locateNodeInFile(filePath, k.symbolName);
      if (loc) byId.set(`${loc.start}-${loc.end}`, k);
    }

    // 2. innermost: discard anything that strictly contains another hit
    const innermost = hits.filter(h =>
      !hits.some(o => o !== h && o.start >= h.start && o.end <= h.end && (o.end - o.start) < (h.end - h.start))
    );

    // 3. changed-only
    const out = new Map<string, TouchedSymbol>();
    for (const h of innermost) {
      const known = byId.get(`${h.start}-${h.end}`);
      const symbolName = known ? known.symbolName : h.qualified;
      const newCode = h.node.getText(sf);
      const oldCode = before ? codeOfSymbol(before, symbolName) : null;
      if (oldCode !== null && oldCode === newCode) continue; // intersected but untouched

      const key = known ? known.id : symbolName;
      if (out.has(key)) continue;
      out.set(key, {
        node_id: known?.id,
        symbolName,
        name: h.name,
        type: astBaseType(h.node),
        signature: newCode.split('\n')[0].slice(0, 200),
        codeSnapshot: newCode,
        codeBefore: oldCode,
        startLine: sf.getLineAndCharacterOfPosition(h.start).line + 1,
        endLine: sf.getLineAndCharacterOfPosition(h.end).line + 1,
        isNew: !known
      });
    }
    return Array.from(out.values());
  } catch {
    return [];
  }
}
