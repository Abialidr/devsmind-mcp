const Database = require('better-sqlite3');
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });
const totalNodes = db.prepare("SELECT COUNT(*) n FROM nodes WHERE deprecated=0").get().n;
const nodesWithEdges = db.prepare("SELECT COUNT(DISTINCT source_node_id) n FROM node_connections").get().n;
console.log(`Active nodes:              ${totalNodes}`);
console.log(`Nodes that HAVE edges:     ${nodesWithEdges}`);
console.log(`Nodes with ZERO edges:     ${totalNodes - nodesWithEdges}  <-- never rebuilt after the interrupted run wiped them`);
