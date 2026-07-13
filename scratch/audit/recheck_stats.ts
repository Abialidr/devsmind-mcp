import Database from 'better-sqlite3';
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });
console.log('total edges now:', db.prepare('SELECT COUNT(*) c FROM node_connections').get());
console.log('total nodes now:', db.prepare('SELECT COUNT(*) c FROM nodes WHERE deprecated=0').get());
