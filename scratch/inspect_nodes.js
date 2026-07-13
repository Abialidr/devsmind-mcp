const Database = require('better-sqlite3');
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });
function show(label, like) {
  console.log(`\n=== ${label} ===`);
  const rows = db.prepare("SELECT id, name, type, file_path FROM nodes WHERE id LIKE ? AND deprecated=0").all(like);
  rows.forEach(r => console.log(`  ${r.id.split('#')[1]}   [${r.type}]`));
  console.log(`  (${rows.length} nodes)`);
}
show('routes/orders.ts', '%routes/orders.ts#%');
show('OrderController.ts', '%controllers/OrderController.ts#%');
