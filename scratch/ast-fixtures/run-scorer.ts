import * as path from 'path';
import { resolveConnectionsLocally } from '../../src/utils/ast';

const ROOT = __dirname; // scratch/ast-fixtures
const DEVMIND = path.join(ROOT, '.devmind');

function abs(rel: string): string {
  return path.join(ROOT, rel);
}

// node: [id-suffix (repo-relative path#symbol), name, type, repo-relative-file]
interface N { id: string; name: string; type: string; file_path: string; }

function node(relFile: string, symbol: string, type = 'function'): N {
  return {
    id: `{fix}/${relFile}#${symbol}`,
    name: symbol.split('.').pop()!,
    type,
    file_path: abs(relFile),
  };
}

const nodes: N[] = [
  node('src/utils/dates.ts', 'convertStringToDate'),
  node('src/utils/dates.ts', 'formatDate'),
  node('src/utils/dates.ts', 'capitalize'),
  node('src/utils/math.ts', 'addNumbers'),
  node('src/app/pricing.ts', 'computeTotal'),
  node('src/services/UserService.ts', 'UserService.createUser', 'method'),
  node('src/services/UserService.ts', 'UserService.deleteUser', 'method'),
  node('src/services/OrderService.ts', 'OrderService.status', 'method'),
  node('src/app/userHandler.ts', 'handleCreate'),
  node('src/app/statusHandler.ts', 'respond'),
  node('src/schema.ts', 'AddSchema', 'object'),
  node('src/app/cartController.ts', 'addToCart'),
  node('src/components/Button.tsx', 'Button', 'component'),
  node('src/app/page.tsx', 'Page', 'component'),
  node('src/validators.ts', 'validateEmailAddress'),
  node('src/app/form.ts', 'buildForm'),
  node('src/components/Cart.tsx', 'Cart.handleRemove', 'method'),
  node('src/app/register.ts', 'registerUser'),
  node('src/app/report.ts', 'makeReport'),
  node('src/app/audit.ts', 'auditService'),
  // default-export cap
  node('src/services/FatController.ts', 'FatController', 'class'),
  node('src/services/FatController.ts', 'FatController.listThings', 'method'),
  node('src/services/FatController.ts', 'FatController.removeThing', 'method'),
  node('src/services/FatController.ts', 'INTERNAL_RANK', 'constant'),
  node('src/services/FatController.ts', 'internalHelper', 'function'),
  // route-handler isolation
  node('src/routes/things.ts', 'router.get("/things")', 'route_handler'),
  node('src/routes/things.ts', 'router.get("/things/remove")', 'route_handler'),
  // framework-container isolation
  node('src/components/widget.js', 'WidgetComponent.methods.onRefresh', 'method'),
  node('src/components/widget.js', 'WidgetComponent.methods.onReset', 'method'),
  // anonymous-default small file (schema) with a garbage node name
  node('src/schemas/thing.schema.ts', 'default', 'object'),
  node('src/app/thingHandler.ts', 'handleThing'),
  // free-function vs same-named method collision (member over-link guard)
  node('src/utils/mixed.ts', 'formatStamp'),
  node('src/utils/mixed.ts', 'Stamper', 'class'),
  node('src/utils/mixed.ts', 'Stamper.formatStamp', 'method'),
  node('src/app/useStamp.ts', 'useStamp'),
];

// Answer key: complete expected target set per source id (by symbol suffix).
const expected: Record<string, string[]> = {
  'src/utils/dates.ts#convertStringToDate': [],
  'src/utils/dates.ts#formatDate': ['src/utils/dates.ts#convertStringToDate'],
  'src/utils/dates.ts#capitalize': [],
  'src/utils/math.ts#addNumbers': [],
  'src/app/pricing.ts#computeTotal': ['src/utils/math.ts#addNumbers'],
  'src/services/UserService.ts#UserService.createUser': [],
  'src/services/UserService.ts#UserService.deleteUser': [],
  'src/services/OrderService.ts#OrderService.status': [],
  'src/app/userHandler.ts#handleCreate': ['src/services/UserService.ts#UserService.createUser'],
  'src/app/statusHandler.ts#respond': [],
  'src/schema.ts#AddSchema': [],
  'src/app/cartController.ts#addToCart': ['src/schema.ts#AddSchema'],
  'src/components/Button.tsx#Button': [],
  'src/app/page.tsx#Page': ['src/components/Button.tsx#Button'],
  'src/validators.ts#validateEmailAddress': [],
  'src/app/form.ts#buildForm': [],
  'src/components/Cart.tsx#Cart.handleRemove': ['src/utils/dates.ts#formatDate'],
  'src/app/register.ts#registerUser': ['src/validators.ts#validateEmailAddress'],
  'src/app/report.ts#makeReport': ['src/utils/dates.ts#formatDate'],
  'src/app/audit.ts#auditService': [],
  // default-export cap: default import links only to the default export, not internals
  'src/services/FatController.ts#FatController': ['src/services/FatController.ts#internalHelper'],
  'src/services/FatController.ts#FatController.listThings': ['src/services/FatController.ts#internalHelper'],
  'src/services/FatController.ts#FatController.removeThing': [],
  'src/services/FatController.ts#INTERNAL_RANK': [],
  'src/services/FatController.ts#internalHelper': ['src/services/FatController.ts#INTERNAL_RANK'],
  // route handlers: each links only to the method it registers (+ the controller it references)
  'src/routes/things.ts#router.get("/things")': [
    'src/services/FatController.ts#FatController.listThings',
    'src/services/FatController.ts#FatController',
  ],
  'src/routes/things.ts#router.get("/things/remove")': [
    'src/services/FatController.ts#FatController.removeThing',
    'src/services/FatController.ts#FatController',
  ],
  // framework container: method links only to what it calls
  'src/components/widget.js#WidgetComponent.methods.onRefresh': ['src/utils/dates.ts#formatDate'],
  'src/components/widget.js#WidgetComponent.methods.onReset': [],
  // anonymous-default schema: consumer links to it despite the alias/name mismatch
  'src/schemas/thing.schema.ts#default': [],
  'src/app/thingHandler.ts#handleThing': ['src/schemas/thing.schema.ts#default'],
  // member over-link guard: useStamp links to the free function only, not the method
  'src/utils/mixed.ts#formatStamp': [],
  'src/utils/mixed.ts#Stamper': [],
  'src/utils/mixed.ts#Stamper.formatStamp': [],
  'src/app/useStamp.ts#useStamp': ['src/utils/mixed.ts#formatStamp'],
};

function suffix(id: string): string {
  return id.replace(/^\{fix\}\//, '');
}

let tp = 0, fp = 0, fn = 0;
const problems: string[] = [];

for (const src of nodes) {
  const got = resolveConnectionsLocally(src.id, src.file_path, nodes, DEVMIND)
    .map(suffix)
    .sort();
  const want = (expected[suffix(src.id)] ?? []).slice().sort();
  const wantSet = new Set(want);
  const gotSet = new Set(got);

  const falsePos = got.filter(g => !wantSet.has(g));
  const falseNeg = want.filter(w => !gotSet.has(w));

  tp += got.filter(g => wantSet.has(g)).length;
  fp += falsePos.length;
  fn += falseNeg.length;

  if (falsePos.length || falseNeg.length) {
    problems.push(`\n  ${suffix(src.id)}`);
    for (const f of falsePos) problems.push(`     FALSE POSITIVE  + ${f}`);
    for (const f of falseNeg) problems.push(`     FALSE NEGATIVE  - ${f}`);
  }
}

const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

console.log('=== AST edge resolver — fixture scorecard ===');
console.log(`TP=${tp}  FP=${fp}  FN=${fn}`);
console.log(`Precision: ${(precision * 100).toFixed(1)}%   Recall: ${(recall * 100).toFixed(1)}%   F1: ${(f1 * 100).toFixed(1)}%`);
if (problems.length) {
  console.log('\nMismatches:' + problems.join(''));
} else {
  console.log('\n✅ All fixtures resolved exactly as expected.');
}
