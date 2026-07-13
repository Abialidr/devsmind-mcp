import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { scanRepoFiles } from '../src/utils/scanner';

const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const db = new Database(DEVMIND + '/brain.db', { readonly: true });
const nodes = db.prepare("SELECT id, file_path FROM nodes WHERE deprecated=0").all() as any[];
const norm = (p: string) => path.resolve(p).split(path.sep).join('/').toLowerCase();
const filesWithNodes = new Set<string>(
  nodes.flatMap(n => String(n.file_path).split(',').map((p: string) => norm(p.trim())))
);

const { repos } = scanRepoFiles(DEVMIND);
console.log('=== Phase 1 RECALL: indexable files vs files that produced >=1 node ===');
let totOnDisk = 0, totCovered = 0;
for (const r of repos) {
  const onDisk = r.files.filter((f: string) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
  const covered = onDisk.filter((f: string) => filesWithNodes.has(norm(f)));
  totOnDisk += onDisk.length; totCovered += covered.length;
  const pct = onDisk.length ? (100 * covered.length / onDisk.length).toFixed(0) : '-';
  console.log(`  ${r.repo_name}: ${covered.length}/${onDisk.length} files (${pct}%)`);
}
console.log(`  TOTAL: ${totCovered}/${totOnDisk} (${(100 * totCovered / totOnDisk).toFixed(1)}%) - missing ${totOnDisk - totCovered} files`);

const hist = db.prepare("SELECT node_id, code_snapshot FROM history WHERE code_snapshot IS NOT NULL AND length(code_snapshot)>20 ORDER BY node_id LIMIT 6000").all() as any[];
const step = Math.max(1, Math.floor(hist.length / 80));
const sample = hist.filter((_, i) => i % step === 0).slice(0, 80);
const nodeById = new Map(nodes.map(n => [n.id, n]));
let checked = 0, match = 0;
for (const h of sample) {
  const n = nodeById.get(h.node_id);
  if (!n) continue;
  const fp = String(n.file_path).split(',')[0].trim();
  if (!fs.existsSync(fp)) continue;
  const src = fs.readFileSync(fp, 'utf-8').replace(/\s+/g, ' ');
  const firstLine = (String(h.code_snapshot).split('\n').find((l: string) => l.trim().length > 10) || '').trim().replace(/\s+/g, ' ').slice(0, 45);
  if (!firstLine) continue;
  checked++;
  if (src.includes(firstLine)) match++;
}
console.log(`\n=== code_snapshot fidelity: ${match}/${checked} snapshots' first line found verbatim in source (${(100 * match / checked).toFixed(0)}%) ===`);
