import Database from 'better-sqlite3';
import { resolveConnectionsLocally } from '../src/utils/ast';
const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const db = new Database(DEVMIND + '/brain.db', { readonly: true });
const all = db.prepare("SELECT id, name, type, file_path FROM nodes WHERE deprecated=0").all() as any[];

// 1. order-service: OrderController.createOrder SHOULD now link to CreateOrderSchema
const oc = all.find(n => n.id.includes('order-service') && n.id.endsWith('OrderController.createOrder'));
if (oc) {
  const edges = resolveConnectionsLocally(oc.id, oc.file_path, all, DEVMIND);
  const schemaEdges = edges.filter(e => e.includes('/schema.ts#'));
  console.log('createOrder → schema edges:', schemaEdges.map(e => e.split('#')[1]).join(', ') || 'NONE');
}

// 2. express OrderController class must NOT re-explode (was 87, should stay ~that, not 141)
const ex = all.find(n => n.id === '{harrir-express-backend}/src/controllers/OrderController.ts#OrderController');
if (ex) {
  const edges = resolveConnectionsLocally(ex.id, ex.file_path, all, DEVMIND);
  console.log('express OrderController class fan-out:', edges.length, '(should be ~87, NOT 141)');
}

// 3. express route still isolated
const rt = all.find(n => n.id.includes('routes/orders.ts#router.get("/boxy/regions")'));
if (rt) {
  console.log('/boxy/regions fan-out:', resolveConnectionsLocally(rt.id, rt.file_path, all, DEVMIND).length, '(should be ~3)');
}
