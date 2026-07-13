import Database from 'better-sqlite3';
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', {readonly:true});
for (const t of ['nodes','node_connections','history','system_meta']) {
  console.log('---', t, '---');
  console.log(db.prepare(`PRAGMA table_info(${t})`).all());
  console.log('count:', db.prepare(`SELECT COUNT(*) c FROM ${t}`).get());
}
console.log('sample node:', db.prepare('SELECT * FROM nodes LIMIT 2').all());
console.log('sample conn:', db.prepare('SELECT * FROM node_connections LIMIT 2').all());
