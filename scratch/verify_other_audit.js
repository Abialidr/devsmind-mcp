const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const graphDir = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/graph';
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}
const files = walk(graphDir, []);
const graphIds = new Set();
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
  for (const n of (data.nodes || [])) graphIds.add(n.id);
}

const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });
const dbIds = new Set(db.prepare('SELECT id FROM nodes').all().map(r => r.id));

const inGraphNotDb = [...graphIds].filter(id => !dbIds.has(id));
const inDbNotGraph = [...dbIds].filter(id => !graphIds.has(id));
console.log('graph/ unique ids:', graphIds.size, '   DB ids:', dbIds.size);
console.log('in graph/ but not DB:', inGraphNotDb.length);
inGraphNotDb.slice(0, 10).forEach(id => console.log('  ', id));
console.log('in DB but not graph/:', inDbNotGraph.length);
inDbNotGraph.slice(0, 10).forEach(id => console.log('  ', id));
