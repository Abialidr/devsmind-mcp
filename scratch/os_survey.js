const Database = require('better-sqlite3');
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });
const q = (sql,...a)=>db.prepare(sql).all(...a);
console.log('order-service total nodes:', q("SELECT id FROM nodes WHERE id LIKE '{harrir-backend-order-service}/%' AND deprecated=0").length);
console.log('\ndistinct files under controllers/:');
const files = q("SELECT DISTINCT file_path FROM nodes WHERE id LIKE '{harrir-backend-order-service}/%controllers/%' AND deprecated=0");
files.forEach(f=>console.log('  ', f.file_path));
console.log('\nany node id containing controllers/OrderController:');
q("SELECT id FROM nodes WHERE id LIKE '{harrir-backend-order-service}/%OrderController%' AND deprecated=0").slice(0,15).forEach(r=>console.log('  ', r.id.replace(/^\{[^}]+\}\//,'')));
