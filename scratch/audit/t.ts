import Database from 'better-sqlite3';
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', {readonly:true});
console.log(JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()));
