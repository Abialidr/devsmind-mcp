import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const HIST = path.join(DEVMIND, 'history');
const db = new Database(DEVMIND + '/brain.db', { readonly: true });
const nodes = db.prepare("SELECT id, name, type, file_path FROM nodes WHERE deprecated=0").all() as any[];
const nodeById = new Map(nodes.map(n => [n.id, n]));

// snapshot fidelity from disk history JSON
const files = fs.readdirSync(HIST).filter(f => f.endsWith('.json'));
const step = Math.max(1, Math.floor(files.length / 120));
let checked = 0, match = 0;
for (let i = 0; i < files.length; i += step) {
  let j: any;
  try { j = JSON.parse(fs.readFileSync(path.join(HIST, files[i]), 'utf-8')); } catch { continue; }
  const snap = String(j.code_snapshot || '');
  if (snap.length < 25) continue;
  const n = nodeById.get(j.node_id);
  if (!n) continue;
  const fp = String(n.file_path).split(',')[0].trim();
  if (!fs.existsSync(fp)) continue;
  const src = fs.readFileSync(fp, 'utf-8').replace(/\s+/g, ' ');
  const line = (snap.split('\n').find((l: string) => l.trim().length > 12) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!line) continue;
  checked++;
  if (src.includes(line)) match++;
}
console.log(`code_snapshot fidelity (from disk): ${match}/${checked} verbatim (${(100 * match / checked).toFixed(0)}%)`);

// import / builtin extracted as node (precision junk)
const BUILTINS = new Set(['fs', 'path', 'os', 'crypto', 'http', 'https', 'util', 'stream', 'events', 'url', 'execSync', 'exec', 'spawn', 'axios', 'express', 'router', 'dotenv', 'joi', 'mongoose', 'lodash', 'moment', 'dayjs', 'React', 'useState', 'useEffect', 'z', 'zod']);
const junk = nodes.filter(n => BUILTINS.has(n.name));
console.log(`\nNodes named after common imports/builtins (likely junk): ${junk.length}`);
const counts: Record<string, number> = {};
junk.forEach(n => counts[n.name] = (counts[n.name] || 0) + 1);
console.log('  ' + Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}(${v})`).join(', '));

// single-letter / trivial names
const trivial = nodes.filter(n => /^[a-z_$]$/i.test(n.name) || n.name.length <= 1);
console.log(`\nSingle-char / trivial names: ${trivial.length}`);
