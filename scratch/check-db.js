const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, 'test-project/.devmind/brain.db');
console.log('Opening DB at:', dbPath);
const db = new Database(dbPath);

console.log('\n--- TABLES ---');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(tables);

console.log('\n--- RAW NODES ---');
console.log(db.prepare("SELECT * FROM nodes").all());

console.log('\n--- RAW CONNECTIONS ---');
console.log(db.prepare("SELECT * FROM node_connections").all());

console.log('\n--- RAW HISTORY ---');
console.log(db.prepare("SELECT * FROM history").all());

db.close();
