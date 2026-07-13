import * as path from 'path';
import { DevMindDatabase } from '../src/db/database';
const ROOT = path.resolve('scratch/rename-test');
const DBFILE = path.join(ROOT, '.devmind', 'brain.db');
const A = '{repo}/src/a.ts#caller';
const B = '{repo}/src/b.ts#target';
const B2 = '{repo}/src/b.ts#renamedTarget';
const fpA = path.join(ROOT,'repo','src','a.ts');
const fpB = path.join(ROOT,'repo','src','b.ts');

let db = new DevMindDatabase(DBFILE);
db.upsertNode({id:A,name:'caller',type:'function',file_path:fpA});
db.upsertNode({id:B,name:'target',type:'function',file_path:fpB});
db.updateHistory({node_id:A,code_snapshot:'a',reasoning:{what_changed:'x',why:'x',goal:'x',developer:'x',model:'x'}});
db.updateHistory({node_id:B,code_snapshot:'b',reasoning:{what_changed:'x',why:'x',goal:'x',developer:'x',model:'x'}});
db.addConnection(A, B);
const before = db.getInboundSources(B);
console.log('inbound sources of B before rename:', before);
db.renameNode(B, B2, 'renamedTarget');
console.log('inbound sources of B2 after rename (in DB):', db.getInboundSources(B2));
db.close();

// reopen -> syncFromDisk reconciles disk into a fresh DB
db = new DevMindDatabase(DBFILE);
const inboundAfterSync = db.getInboundSources(B2);
const oldStillThere = db.getInboundSources(B);
console.log('\nAFTER REOPEN (syncFromDisk):');
console.log('  A -> B2 inbound preserved:', inboundAfterSync.length === 1 && inboundAfterSync[0] === A ? 'YES ✅' : 'NO ❌ ' + JSON.stringify(inboundAfterSync));
console.log('  stale A -> B present:', oldStillThere.length ? 'YES ❌' : 'no ✅');
db.close();
