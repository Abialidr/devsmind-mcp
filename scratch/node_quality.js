const Database = require('better-sqlite3');
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });
const nodes = db.prepare("SELECT id, name, type FROM nodes WHERE deprecated=0").all();
const sym = id => id.split('#').slice(1).join('#');
let malformed = { call_syntax:0, three_plus_dots:0, literal_default:0, has_space:0, has_quotes:0, empty_or_weird:0 };
const examples = { call_syntax:[], three_plus_dots:[], literal_default:[], has_space:[] };
for (const n of nodes) {
  const s = sym(n.id);
  if (/[()]/.test(s)) { malformed.call_syntax++; if(examples.call_syntax.length<3)examples.call_syntax.push(s); }
  else if ((s.match(/\./g)||[]).length >= 2) { malformed.three_plus_dots++; if(examples.three_plus_dots.length<3)examples.three_plus_dots.push(s); }
  if (s === 'default' || /\.default$/.test(s)) { malformed.literal_default++; if(examples.literal_default.length<3)examples.literal_default.push(s); }
  if (/\s/.test(s)) { malformed.has_space++; if(examples.has_space.length<3)examples.has_space.push(s); }
  if (/["']/.test(s)) malformed.has_quotes++;
}
console.log('Total active nodes:', nodes.length);
console.log('\n=== Malformed / fragile node_ids ===');
for (const [k,v] of Object.entries(malformed)) console.log(`  ${k}: ${v}  (${(100*v/nodes.length).toFixed(1)}%)`);
console.log('\nExamples:');
for (const [k,arr] of Object.entries(examples)) if(arr.length) console.log(`  ${k}: ${arr.join('  |  ')}`);
// duplicate names within same repo (collision risk)
const byName = {};
for (const n of nodes) { const repo = n.id.match(/^\{([^}]+)\}/)[1]; const key = repo+'::'+n.name; byName[key]=(byName[key]||0)+1; }
const dups = Object.entries(byName).filter(([,c])=>c>1);
console.log(`\n=== Name collisions (same name, same repo): ${dups.length} names, ${dups.reduce((a,[,c])=>a+c,0)} nodes ===`);
console.log('  worst:', dups.sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,c])=>`${k.split('::')[1]}(${c})`).join(', '));
// type distribution top
const byType={}; for(const n of nodes) byType[n.type]=(byType[n.type]||0)+1;
console.log('\n=== Top node types ===');
Object.entries(byType).sort((a,b)=>b[1]-a[1]).slice(0,12).forEach(([t,c])=>console.log(`  ${t}: ${c}`));
