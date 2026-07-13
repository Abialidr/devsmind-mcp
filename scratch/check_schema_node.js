const Database = require('better-sqlite3');
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });
console.log('=== nodes in CreateOrder/schema.ts ===');
db.prepare("SELECT id, name, type FROM nodes WHERE id LIKE '%functions/CreateOrder/schema.ts#%' AND deprecated=0").all()
  .forEach(r => console.log(`  ${r.id.split('#')[1]}   [${r.type}]  name=${r.name}`));
console.log('\n=== incoming edges TO that schema node (who links to it) ===');
const rows = db.prepare("SELECT DISTINCT source_node_id FROM node_connections WHERE target_node_id LIKE '%functions/CreateOrder/schema.ts#%'").all();
console.log(`  incoming edges: ${rows.length}`);
rows.slice(0,10).forEach(r => console.log('   ←', r.source_node_id.replace(/^\{[^}]+\}\//,'')));
