import Database from 'better-sqlite3';
import { resolveConnectionsLocally } from '../src/utils/ast';
const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const db = new Database(DEVMIND + '/brain.db', { readonly: true });
const all = db.prepare("SELECT id, name, type, file_path FROM nodes WHERE deprecated=0").all() as any[];
const ocNodes = all.filter(n => n.id.includes('order-service') && n.id.includes('controllers/OrderController.ts#'));
console.log(`order-service OrderController.ts has ${ocNodes.length} nodes:`);
ocNodes.forEach(n => console.log(`  ${n.id.split('#')[1]}  [${n.type}]`));
// pick the one whose isolated body references createOrderSchema
console.log('\nTesting which node links to CreateOrderSchema:');
for (const n of ocNodes) {
  const edges = resolveConnectionsLocally(n.id, n.file_path, all, DEVMIND);
  const s = edges.filter(e => /schema\.ts#/.test(e));
  if (s.length) console.log(`  ${n.id.split('#')[1]} → ${s.map(e=>e.split('#')[1]).join(', ')}`);
}
