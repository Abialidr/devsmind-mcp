const Database = require('better-sqlite3');
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });

// schema of node_connections
const cols = db.prepare("PRAGMA table_info(node_connections)").all();
console.log('node_connections columns:', cols.map(c => c.name).join(', '));

const boxyId = '{harrir-express-backend}/src/routes/orders.ts#router.get("/boxy/regions")';
// try both directions
const c1 = db.prepare("SELECT COUNT(*) n FROM node_connections WHERE source_node_id = ?").get(boxyId);
console.log(`LIVE edges FROM /boxy/regions (source_node_id): ${c1.n}`);

// scratchpad build time
const meta = db.prepare("SELECT * FROM system_meta").all();
console.log('\nsystem_meta:', JSON.stringify(meta));

// total live edges
const tot = db.prepare("SELECT COUNT(*) n FROM node_connections").get();
console.log('Total live edges in DB:', tot.n);
