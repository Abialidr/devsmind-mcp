import Database from 'better-sqlite3';
import { resolveConnectionsLocally } from '../src/utils/ast';
const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const db = new Database(DEVMIND + '/brain.db', { readonly: true });
const all = db.prepare("SELECT id, name, type, file_path FROM nodes WHERE deprecated=0").all() as any[];
// find CartController nodes and any schema edges they now produce
const cart = all.filter(n => n.id.includes('order-service') && n.id.includes('CartController.ts#'));
let found = 0;
for (const n of cart) {
  const edges = resolveConnectionsLocally(n.id, n.file_path, all, DEVMIND);
  const s = edges.filter(e => /\/schema\.ts#/.test(e) || /Schema$/.test(e.split('#')[1]||''));
  if (s.length) { console.log(`${n.id.split('#')[1]} → ${s.map(e=>e.replace(/^\{[^}]+\}\//,'')).join(', ')}`); found += s.length; }
}
console.log(`\nCartController schema edges found: ${found}`);
// count how many schema nodes exist and how many are anonymous-default
const schemas = all.filter(n => /\/schema\.ts$/.test(n.file_path) && n.id.includes('order-service'));
console.log(`order-service schema.ts nodes: ${schemas.length}`);
