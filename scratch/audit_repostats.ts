import Database from 'better-sqlite3';
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });

const repos = ['harrir-backend-order-service','harrir-backend-products-service','harrir-backend-user-service','harrir-backend-zoho-service','harrir-express-backend','harrir-mini-app','harrir-web','harrir-web-admin'];

function repoOf(id:string){ const m=id.match(/^\{([^}]+)\}/); return m?m[1]:'?'; }

const nodes = db.prepare('SELECT id FROM nodes').all() as any[];
const edges = db.prepare('SELECT source_node_id s, target_node_id t FROM node_connections').all() as any[];

const nodesByRepo: Record<string,Set<string>> = {};
for (const n of nodes){ const r=repoOf(n.id); (nodesByRepo[r]||(nodesByRepo[r]=new Set())).add(n.id); }

const outByRepo: Record<string,number> = {};
const connected: Record<string,Set<string>> = {}; // nodes with any connection
for (const e of edges){
  const rs=repoOf(e.s);
  outByRepo[rs]=(outByRepo[rs]||0)+1;
  (connected[rs]||(connected[rs]=new Set())).add(e.s);
  const rt=repoOf(e.t);
  (connected[rt]||(connected[rt]=new Set())).add(e.t);
}

console.log('repo | nodes | outEdges | orphans | orphan% | density');
for (const r of repos){
  const n = nodesByRepo[r]?.size||0;
  const oe = outByRepo[r]||0;
  const conn = connected[r]?.size||0;
  const orph = n-conn;
  console.log(`${r} | ${n} | ${oe} | ${orph} | ${(100*orph/n).toFixed(1)}% | ${(oe/n).toFixed(2)}`);
}
