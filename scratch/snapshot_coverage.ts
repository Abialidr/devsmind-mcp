import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const HIST = path.join(DEVMIND, 'history');
const db = new Database(DEVMIND + '/brain.db', { readonly: true });
const activeNodes = db.prepare("SELECT id FROM nodes WHERE deprecated=0").all() as any[];
const diskFiles = new Set(fs.readdirSync(HIST).filter(f => f.endsWith('.json')));
// latest history row per node
const latest = db.prepare("SELECT node_id, id FROM history h1 WHERE updated_at = (SELECT MAX(updated_at) FROM history h2 WHERE h2.node_id=h1.node_id)").all() as any[];
const latestByNode = new Map<string,string>();
latest.forEach(r => latestByNode.set(r.node_id, r.id));
let noHistory=0, missingDisk=0, emptySnap=0, ok=0;
for (const n of activeNodes) {
  const hid = latestByNode.get(n.id);
  if (!hid) { noHistory++; continue; }
  if (!diskFiles.has(hid + '.json')) { missingDisk++; continue; }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HIST, hid + '.json'),'utf-8'));
    if (!j.code_snapshot || String(j.code_snapshot).trim()==='') emptySnap++; else ok++;
  } catch { missingDisk++; }
}
console.log('active nodes:', activeNodes.length);
console.log('  with usable disk snapshot (get edges):', ok);
console.log('  NO history row at all (skipped in edges):', noHistory);
console.log('  history row but disk JSON missing (skipped):', missingDisk);
console.log('  disk JSON present but snapshot empty (skipped):', emptySnap);
console.log('  => TOTAL skipped in edges-only:', noHistory+missingDisk+emptySnap, `(${(100*(noHistory+missingDisk+emptySnap)/activeNodes.length).toFixed(1)}%)`);
