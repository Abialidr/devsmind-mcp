import Database from 'better-sqlite3';
import { resolveConnectionsLocally } from '../src/utils/ast';

const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const db = new Database(DEVMIND + '/brain.db', { readonly: true });
const all = db.prepare("SELECT id, name, type, file_path FROM nodes WHERE deprecated=0").all() as any[];
const oldEdge = db.prepare("SELECT COUNT(*) n FROM node_connections WHERE source_node_id=?");

function report(repo: string) {
  const srcs = all.filter(n => n.id.startsWith(`{${repo}}/`));
  let oldTotal = 0, newTotal = 0, oldMax = 0, newMax = 0;
  for (const s of srcs) {
    const o = (oldEdge.get(s.id) as any).n;
    const nw = resolveConnectionsLocally(s.id, s.file_path, all, DEVMIND).length;
    oldTotal += o; newTotal += nw;
    oldMax = Math.max(oldMax, o); newMax = Math.max(newMax, nw);
  }
  console.log(`=== ${repo}  (${srcs.length} nodes) ===`);
  console.log(`  OLD (live):  total ${oldTotal}  avg ${(oldTotal/srcs.length).toFixed(1)}/node  max ${oldMax}`);
  console.log(`  NEW (fixed): total ${newTotal}  avg ${(newTotal/srcs.length).toFixed(1)}/node  max ${newMax}`);
}
report('harrir-express-backend');
report('harrir-mini-app');
console.log('DONE');
