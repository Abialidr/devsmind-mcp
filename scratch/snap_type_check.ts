import * as fs from 'fs';
import Database from 'better-sqlite3';

const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const db = new Database(DEVMIND + '/brain.db', { readonly: true });

// how is history stored?
const hcount = db.prepare("SELECT COUNT(*) n FROM history").get() as any;
const hsnap = db.prepare("SELECT COUNT(*) n FROM history WHERE code_snapshot IS NOT NULL AND length(code_snapshot)>20").get() as any;
console.log(`history rows: ${hcount.n}, with code_snapshot>20 chars: ${hsnap.n}`);
const oneH = db.prepare("SELECT node_id, substr(code_snapshot,1,80) s FROM history WHERE code_snapshot IS NOT NULL LIMIT 3").all() as any[];
oneH.forEach(h => console.log(`  hist node_id=${h.node_id ? h.node_id.slice(0,60) : 'NULL'}  snap="${(h.s||'').replace(/\n/g,' ')}"`));

// snapshot fidelity, corrected
const nodes = db.prepare("SELECT id, file_path FROM nodes WHERE deprecated=0").all() as any[];
const nodeById = new Map(nodes.map(n => [n.id, n]));
const hist = db.prepare("SELECT node_id, code_snapshot FROM history WHERE code_snapshot IS NOT NULL AND length(code_snapshot)>30").all() as any[];
const step = Math.max(1, Math.floor(hist.length / 100));
let checked = 0, match = 0, noNode = 0, noFile = 0;
for (let i = 0; i < hist.length; i += step) {
  const h = hist[i];
  const n = nodeById.get(h.node_id);
  if (!n) { noNode++; continue; }
  const fp = String(n.file_path).split(',')[0].trim();
  if (!fs.existsSync(fp)) { noFile++; continue; }
  const src = fs.readFileSync(fp, 'utf-8').replace(/\s+/g, ' ');
  const line = (String(h.code_snapshot).split('\n').find((l: string) => l.trim().length > 12) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!line) continue;
  checked++;
  if (src.includes(line)) match++;
}
console.log(`\ncode_snapshot fidelity: ${match}/${checked} verbatim (${checked ? (100 * match / checked).toFixed(0) : '-'}%)  [skipped: noNode=${noNode}, noFile=${noFile}]`);
