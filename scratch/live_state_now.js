const Database = require('better-sqlite3');
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });
const boxyId = '{harrir-express-backend}/src/routes/orders.ts#router.get("/boxy/regions")';
console.log('LIVE edges from /boxy/regions RIGHT NOW:', db.prepare("SELECT COUNT(*) n FROM node_connections WHERE source_node_id=?").get(boxyId).n, '  (fixed code should give ~3)');
const total = db.prepare("SELECT COUNT(*) n FROM node_connections").get().n;
const nodes = db.prepare("SELECT COUNT(*) n FROM nodes WHERE deprecated=0").get().n;
const withEdges = db.prepare("SELECT COUNT(DISTINCT source_node_id) n FROM node_connections").get().n;
console.log('Total edges:', total, '| active nodes:', nodes, '| nodes with zero edges:', nodes - withEdges);
// top over-linked nodes = signature of the old explosion bug still present
console.log('\nMost over-linked source nodes (fan-out):');
db.prepare("SELECT source_node_id, COUNT(*) c FROM node_connections GROUP BY source_node_id ORDER BY c DESC LIMIT 8").all()
  .forEach(r => console.log(`  ${r.c}  ${r.source_node_id.replace(/^\{[^}]+\}\//,'')}`));
