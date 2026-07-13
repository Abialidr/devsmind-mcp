import Database from 'better-sqlite3';
import { resolveConnectionsLocally } from '../src/utils/ast';
const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const db = new Database(DEVMIND + '/brain.db', { readonly: true });
const all = db.prepare("SELECT id, name, type, file_path FROM nodes WHERE deprecated=0").all() as any[];
// find nodes that reference createOrder in order-service OrderController
const cands = all.filter(n => n.id.includes('order-service') && n.id.includes('OrderController.ts#') && /createOrder/i.test(n.id));
console.log('candidate createOrder nodes:');
cands.forEach(n => console.log('  ', n.id.split('#')[1]));
const oc = cands.find(n => n.id.endsWith('#OrderController.createOrder')) || cands[0];
if (oc) {
  const edges = resolveConnectionsLocally(oc.id, oc.file_path, all, DEVMIND);
  const schemaEdges = edges.filter(e => e.includes('/schema.ts#'));
  console.log(`\n${oc.id.split('#')[1]} → ${edges.length} total edges`);
  console.log('schema edges:', schemaEdges.map(e => e.replace(/^\{[^}]+\}\//,'')).join('\n   ') || 'NONE');
}
