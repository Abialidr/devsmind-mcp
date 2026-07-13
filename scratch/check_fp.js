const Database = require('better-sqlite3');
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });
const r = db.prepare("SELECT id, file_path FROM nodes WHERE id LIKE '%routes/orders.ts#router.get(\"/boxy/regions\")%' LIMIT 1").get();
console.log(JSON.stringify(r, null, 2));
const m = db.prepare("SELECT id, file_path FROM nodes WHERE id LIKE '%HomePageComponent%' AND id LIKE '%.methods.%' LIMIT 3").all();
console.log(JSON.stringify(m, null, 2));
