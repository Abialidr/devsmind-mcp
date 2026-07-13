import Database from 'better-sqlite3';
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });
function repoOf(id:string){ const m=id.match(/^\{([^}]+)\}/); return m?m[1]:'?'; }
const nmeta = new Map<string,any>();
for (const n of db.prepare('SELECT id,name,type,file_path FROM nodes').all() as any[]) nmeta.set(n.id,n);
const edges = db.prepare('SELECT source_node_id s, target_node_id t FROM node_connections').all() as any[];
// seeded PRNG
let seed = 1234567;
function rnd(){ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; }
function sample(repo:string,k:number){
  const pool = edges.filter(e=>repoOf(e.s)===repo && repoOf(e.t)===repo); // same-repo edges (the risky ones)
  const idx=[...pool.keys()]; for(let i=idx.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[idx[i],idx[j]]=[idx[j],idx[i]];}
  const pick=idx.slice(0,k).map(i=>pool[i]);
  console.log(`\n### ${repo}  (same-repo pool ${pool.length}, cross-repo ${edges.filter(e=>repoOf(e.s)===repo&&repoOf(e.t)!==repo).length})`);
  for(const e of pick){
    const sm=nmeta.get(e.s), tm=nmeta.get(e.t);
    console.log(JSON.stringify({src:e.s, srcType:sm?.type, tgt:tm?.name, tgtType:tm?.type, tgtFile:(tm?.file_path||'').replace(/.*harrir/,'harrir')}));
  }
}
sample('harrir-express-backend',10);
sample('harrir-mini-app',10);
sample('harrir-backend-order-service',5);
sample('harrir-backend-products-service',5);
sample('harrir-backend-user-service',5);
sample('harrir-backend-zoho-service',5);
