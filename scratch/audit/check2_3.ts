import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const GRAPH = path.join(DEVMIND, 'graph');
const db = new Database(path.join(DEVMIND, 'brain.db'), { readonly: true });

// ---------- Check 2: graph folder integrity ----------
function walk(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.json')) out.push(p);
  }
}
const files: string[] = [];
walk(GRAPH, files);
console.log('Total graph JSON files:', files.length);

let malformed: any[] = [];
let dupIdsWithinFile: any[] = [];
let danglingConns: any[] = [];
const graphNodeIds = new Set<string>();
const graphNodeIdToFile = new Map<string, string>();
let totalGraphNodes = 0;
let totalGraphConns = 0;
let parseErrors: any[] = [];

for (const f of files) {
  let j: any;
  try {
    j = JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (e: any) {
    parseErrors.push({ file: f, error: e.message });
    continue;
  }
  const nodes = j.nodes || [];
  const seenInFile = new Set<string>();
  for (const n of nodes) {
    totalGraphNodes++;
    const issues: string[] = [];
    if (!n.id || typeof n.id !== 'string' || n.id.trim() === '') issues.push('missing/empty id');
    if (!n.name || typeof n.name !== 'string' || n.name.trim() === '') issues.push('missing/empty name');
    if (!n.type || typeof n.type !== 'string' || n.type.trim() === '') issues.push('missing/empty type');
    if (n.id === 'undefined' || n.name === 'undefined' || n.type === 'undefined') issues.push('literal "undefined"');
    if (n.name === 'null' || n.type === 'null') issues.push('literal "null"');
    if (issues.length) malformed.push({ file: f, node: n, issues });
    if (n.id) {
      if (seenInFile.has(n.id)) dupIdsWithinFile.push({ file: f, id: n.id });
      seenInFile.add(n.id);
      graphNodeIds.add(n.id);
      graphNodeIdToFile.set(n.id, f);
    }
  }
  const conns = j.connections || [];
  for (const c of conns) {
    totalGraphConns++;
    const srcOk = c.source_node_id && seenInFile.has(c.source_node_id) || (c.source_node_id && graphNodeIds.has(c.source_node_id));
    // defer full dangling check to after all files loaded (target may be in another file)
    if (!c.source_node_id || !c.target_node_id) {
      danglingConns.push({ file: f, conn: c, reason: 'missing source/target' });
    }
  }
}

// second pass: dangling target/source refs against full graphNodeIds set
let danglingTargets: any[] = [];
let danglingSources: any[] = [];
for (const f of files) {
  let j: any;
  try { j = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { continue; }
  for (const c of j.connections || []) {
    if (c.source_node_id && !graphNodeIds.has(c.source_node_id)) danglingSources.push({ file: f, conn: c });
    if (c.target_node_id && !graphNodeIds.has(c.target_node_id)) danglingTargets.push({ file: f, conn: c });
  }
}

console.log('\n=== CHECK 2: Graph folder integrity ===');
console.log('Parse errors:', parseErrors.length, parseErrors.slice(0, 5));
console.log('Total nodes in graph/:', totalGraphNodes, ' unique ids:', graphNodeIds.size);
console.log('Total connections in graph/:', totalGraphConns);
console.log('Malformed nodes:', malformed.length);
console.log(JSON.stringify(malformed.slice(0, 20), null, 2));
console.log('Duplicate IDs within same file:', dupIdsWithinFile.length);
console.log(JSON.stringify(dupIdsWithinFile.slice(0, 20), null, 2));
console.log('Dangling connection target refs (target id not in any graph file):', danglingTargets.length);
console.log(JSON.stringify(danglingTargets.slice(0, 15), null, 2));
console.log('Dangling connection source refs:', danglingSources.length);
console.log(JSON.stringify(danglingSources.slice(0, 15), null, 2));

// DB diff
const dbIds: string[] = db.prepare('SELECT id FROM nodes').all().map((r: any) => r.id);
const dbIdSet = new Set(dbIds);
console.log('\nDB node count:', dbIds.length, 'unique:', dbIdSet.size);

const inGraphNotDb: string[] = [];
for (const id of graphNodeIds) if (!dbIdSet.has(id)) inGraphNotDb.push(id);
const inDbNotGraph: string[] = [];
for (const id of dbIdSet) if (!graphNodeIds.has(id)) inDbNotGraph.push(id);

console.log('IDs in graph/ but NOT in brain.db:', inGraphNotDb.length);
console.log(JSON.stringify(inGraphNotDb.slice(0, 20), null, 2));
console.log('IDs in brain.db but NOT in graph/:', inDbNotGraph.length);
console.log(JSON.stringify(inDbNotGraph.slice(0, 20), null, 2));

// deprecated flag check for the DB-not-graph set
if (inDbNotGraph.length) {
  const placeholders = inDbNotGraph.slice(0, 500).map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, deprecated, type, file_path FROM nodes WHERE id IN (${placeholders})`).all(...inDbNotGraph.slice(0, 500));
  const deprecatedCount = rows.filter((r: any) => r.deprecated === 1).length;
  console.log('Of DB-not-graph sample (', rows.length, '): deprecated=1 count:', deprecatedCount, 'deprecated=0 count:', rows.length - deprecatedCount);
  console.log('Sample non-deprecated DB-not-graph rows:', JSON.stringify(rows.filter((r:any)=>r.deprecated!==1).slice(0,10), null, 2));
}

// ---------- Check 3: taxonomy conformance ----------
const TAXONOMY = new Set([
  'function','method','class','abstract_class','interface','type_alias','enum','constant','variable','module','namespace','decorator',
  'nest_module','nest_controller','nest_service','nest_provider','nest_guard','nest_interceptor','nest_pipe','nest_filter','nest_decorator','nest_middleware','nest_gateway','nest_resolver','nest_schema','nest_dto',
  'route_handler','middleware','router',
  'spring_controller','spring_service','spring_repository','spring_component','spring_bean','spring_config','spring_entity',
  'django_view','django_model','django_serializer','django_form','django_signal','fastapi_router','fastapi_dependency',
  'go_handler','go_middleware','go_struct','go_interface','go_func',
  'rust_struct','rust_impl','rust_trait','rust_enum','rust_fn','rust_macro',
  'react_component','react_hook','react_context','react_hoc','react_page','next_page','next_layout','next_api_route','next_server_action',
  'prisma_model','typeorm_entity','mongoose_model','sqlalchemy_model',
  'api_endpoint','rest_controller','graphql_resolver','graphql_query','graphql_mutation','graphql_schema',
  'cli_command','cli_option',
  'util_function','helper','validator','formatter'
]);

console.log('\n=== CHECK 3: Node type taxonomy conformance ===');
const activeNodes: any[] = db.prepare('SELECT id, type FROM nodes WHERE deprecated = 0 OR deprecated IS NULL').all();
console.log('Active nodes:', activeNodes.length);
const typeCounts = new Map<string, number>();
let conform = 0;
for (const n of activeNodes) {
  typeCounts.set(n.type, (typeCounts.get(n.type) || 0) + 1);
  if (TAXONOMY.has(n.type)) conform++;
}
console.log('Conforming:', conform, '/', activeNodes.length, '=', (100 * conform / activeNodes.length).toFixed(2), '%');
const offTaxonomy = [...typeCounts.entries()].filter(([t]) => !TAXONOMY.has(t)).sort((a, b) => b[1] - a[1]);
console.log('Distinct off-taxonomy types:', offTaxonomy.length);
console.log(JSON.stringify(offTaxonomy, null, 2));
console.log('\nAll type distribution:');
console.log(JSON.stringify([...typeCounts.entries()].sort((a,b)=>b[1]-a[1]), null, 2));
