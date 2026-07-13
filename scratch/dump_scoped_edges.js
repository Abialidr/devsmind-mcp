const Database = require('better-sqlite3');
const db = new Database('scratch/scoped-test/.devmind/brain.db', { readonly: true });
const rows = db.prepare("SELECT source_node_id, target_node_id FROM node_connections ORDER BY source_node_id").all();
console.log('edges:', rows.length);
rows.forEach(r => console.log(`  ${r.source_node_id.replace(/\{|\}/g,'')} -> ${r.target_node_id.replace(/\{|\}/g,'')}`));
