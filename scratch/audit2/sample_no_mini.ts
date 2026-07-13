import Database from 'better-sqlite3';
import * as fs from 'fs';
const db = new Database("C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db", { readonly: true });
function repoOf(fp: string) {
  const m = fp.match(/lamda\\([^\\]+)/i);
  return m ? m[1] : '(unknown)';
}
const nodes = db.prepare("select id, type, name, file_path, signature from nodes").all() as any[];
const nodeMap = new Map(nodes.map(n=>[n.id, n]));
const edges = db.prepare("select source_node_id, target_node_id from node_connections").all() as any[];
const filtered = edges.filter(e => {
  const s = nodeMap.get(e.source_node_id);
  const t = nodeMap.get(e.target_node_id);
  const sr = s ? repoOf(s.file_path||'') : '(missing)';
  const tr = t ? repoOf(t.file_path||'') : '(missing)';
  return sr !== 'harrir-mini-app' && tr !== 'harrir-mini-app';
});
console.log('filtered edge pool size (non-mini-app)', filtered.length);

function shuffle<T>(a:T[]) { for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
const sample = shuffle([...filtered]).slice(0,40);
const out = sample.map(e => {
  const s = nodeMap.get(e.source_node_id);
  const t = nodeMap.get(e.target_node_id);
  return {
    source_id: e.source_node_id, target_id: e.target_node_id,
    source_name: s?.name, source_type: s?.type, source_file: s?.file_path, source_sig: s?.signature,
    target_name: t?.name, target_type: t?.type, target_file: t?.file_path
  };
});
fs.writeFileSync('scratch/audit2/sample40.json', JSON.stringify(out, null, 2));
console.log('wrote sample of', out.length);
