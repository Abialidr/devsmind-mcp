import Database from 'better-sqlite3';
const db = new Database("C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db", { readonly: true });
function repoOf(fp: string) {
  const m = fp.match(/lamda\\([^\\]+)/i);
  return m ? m[1] : '(unknown)';
}
const nodes = db.prepare("select id, file_path from nodes").all() as any[];
const nodeRepo = new Map(nodes.map(n=>[n.id, repoOf(n.file_path||'')]));
const edges = db.prepare("select source_node_id, target_node_id from node_connections").all() as any[];

const nodesPerRepo: Record<string, number> = {};
for (const n of nodes) {
  const r = nodeRepo.get(n.id)!;
  nodesPerRepo[r] = (nodesPerRepo[r]||0)+1;
}

// degree per node (in+out), counting edges where repo matches source's repo (edge attributed to source repo)
const edgesPerRepo: Record<string, number> = {};
const touchedNodes = new Set<string>();
for (const e of edges) {
  const sr = nodeRepo.get(e.source_node_id);
  if (sr) { edgesPerRepo[sr] = (edgesPerRepo[sr]||0)+1; }
  touchedNodes.add(e.source_node_id);
  touchedNodes.add(e.target_node_id);
}

// orphan = node with no edges at all (not touched as source or target)
const orphansPerRepo: Record<string, number> = {};
for (const n of nodes) {
  if (!touchedNodes.has(n.id)) {
    const r = nodeRepo.get(n.id)!;
    orphansPerRepo[r] = (orphansPerRepo[r]||0)+1;
  }
}

const repos = Object.keys(nodesPerRepo).sort();
console.log('repo | nodes | edges(by source) | edge_density(edges/node) | orphans | orphan_rate%');
for (const r of repos) {
  const nodeCt = nodesPerRepo[r];
  const edgeCt = edgesPerRepo[r] || 0;
  const orphanCt = orphansPerRepo[r] || 0;
  console.log(r, nodeCt, edgeCt, (edgeCt/nodeCt).toFixed(2), orphanCt, (100*orphanCt/nodeCt).toFixed(1)+'%');
}

// backend vs frontend split, mini-app excluded, and included for comparison
const backendRepos = ['harrir-backend-order-service','harrir-backend-products-service','harrir-backend-user-service','harrir-backend-zoho-service','harrir-express-backend'];
const frontendReposExclMini = ['harrir-web','harrir-web-admin'];
const frontendReposInclMini = ['harrir-web','harrir-web-admin','harrir-mini-app'];

function agg(repoList: string[]) {
  let nodeCt=0, edgeCt=0, orphanCt=0;
  for (const r of repoList) { nodeCt += nodesPerRepo[r]||0; edgeCt += edgesPerRepo[r]||0; orphanCt += orphansPerRepo[r]||0; }
  return { nodeCt, edgeCt, density: edgeCt/nodeCt, orphanRate: 100*orphanCt/nodeCt };
}
console.log('backend agg', agg(backendRepos));
console.log('frontend excl mini agg', agg(frontendReposExclMini));
console.log('frontend incl mini agg', agg(frontendReposInclMini));
