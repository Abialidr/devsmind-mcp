import Database from 'better-sqlite3';
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });

// sample nodes
console.log('SAMPLE NODES:');
for (const r of db.prepare('SELECT id,type,name,file_path FROM nodes LIMIT 15').all() as any[]) {
  console.log(JSON.stringify(r));
}
console.log('\nTOTAL nodes:', (db.prepare('SELECT count(*) c FROM nodes').get() as any).c);
console.log('TOTAL edges:', (db.prepare('SELECT count(*) c FROM node_connections').get() as any).c);

// distinct file_path prefixes
console.log('\nDISTINCT top dirs:');
const rows = db.prepare('SELECT file_path FROM nodes').all() as any[];
const buckets: Record<string,number> = {};
for (const r of rows) {
  const p = (r.file_path||'').replace(/\\/g,'/');
  const seg = p.split('/').slice(0,3).join('/');
  buckets[seg]=(buckets[seg]||0)+1;
}
for (const [k,v] of Object.entries(buckets).sort((a,b)=>b[1]-a[1]).slice(0,30)) console.log(v, k);
