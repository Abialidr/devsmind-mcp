import Database from 'better-sqlite3';
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('TABLES:', JSON.stringify(tables));
for (const t of tables as any[]) {
  console.log('\n== ' + t.name + ' ==');
  console.log(JSON.stringify(db.prepare(`PRAGMA table_info(${t.name})`).all().map((c:any)=>c.name)));
}
