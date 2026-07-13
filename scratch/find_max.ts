import Database from 'better-sqlite3';
import { resolveConnectionsLocally } from '../src/utils/ast';
const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const db = new Database(DEVMIND + '/brain.db', { readonly: true });
const all = db.prepare("SELECT id, name, type, file_path FROM nodes WHERE deprecated=0").all() as any[];
const ex = all.filter(n => n.id.startsWith('{harrir-express-backend}/'));
let worst: any = null, worstN = 0;
for (const s of ex) {
  const n = resolveConnectionsLocally(s.id, s.file_path, all, DEVMIND).length;
  if (n > worstN) { worstN = n; worst = s; }
}
console.log(`Worst express node: ${worst.id.replace(/^\{[^}]+\}\//,'')}  [${worst.type}]  → ${worstN} edges`);
const edges = resolveConnectionsLocally(worst.id, worst.file_path, all, DEVMIND);
const byFile: Record<string, number> = {};
edges.forEach(e => { const f = e.split('#')[0].replace(/^\{[^}]+\}\//,''); byFile[f] = (byFile[f]||0)+1; });
Object.entries(byFile).sort((a,b)=>b[1]-a[1]).slice(0,6).forEach(([f,c])=>console.log(`   ${c}  ${f}`));
