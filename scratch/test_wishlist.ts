import Database from 'better-sqlite3';
import { resolveConnectionsLocally } from '../src/utils/ast';
const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const db = new Database(DEVMIND + '/brain.db', { readonly: true });
const all = db.prepare("SELECT id, name, type, file_path FROM nodes WHERE deprecated=0").all() as any[];
const wl = all.filter(n => n.id.includes('order-service') && n.id.includes('WishListController.ts#'));
console.log(`WishListController nodes: ${wl.length}`);
let total = 0;
for (const n of wl) {
  const edges = resolveConnectionsLocally(n.id, n.file_path, all, DEVMIND);
  const s = edges.filter(e => /WishList\/schema|WishListItem\/schema/.test(e) || /Schema$/.test(e.split('#')[1]||''));
  if (s.length) { console.log(`  ${n.id.split('#')[1]} → ${s.map(e=>e.split('#')[1]).join(', ')}`); total += s.length; }
}
console.log(`\nNEW schema edges from WishListController: ${total}`);
// live (old) incoming edges to those schema nodes
const schemaIds = all.filter(n => /AddWishListItem\/schema|BulkUpdateWishList\/schema|RemoveWishListItem\/schema/.test(n.id));
console.log('\nSchema nodes + their CURRENT live incoming edge count:');
for (const s of schemaIds) {
  const inc = db.prepare("SELECT COUNT(*) n FROM node_connections WHERE target_node_id=?").get(s.id) as any;
  console.log(`  ${s.id.split('#')[1]}: ${inc.n} incoming (live)`);
}
