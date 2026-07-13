import Database from 'better-sqlite3';
import * as fs from 'fs';

const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const db = new Database(DEVMIND + '/brain.db', { readonly: true });

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function repoOf(fp: string): string {
  const parts = fp.split(/[\\/]/);
  const idx = parts.findIndex(p => p === 'lamda');
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  return 'unknown';
}

const allEdges: any[] = db.prepare('SELECT source_node_id, target_node_id FROM node_connections').all();
const getNode = db.prepare('SELECT id, name, type, file_path FROM nodes WHERE id = ?');

const byRepo = new Map<string, any[]>();
for (const e of allEdges) {
  const src = getNode.get(e.source_node_id) as any;
  if (!src) continue;
  const repo = repoOf(src.file_path);
  if (!byRepo.has(repo)) byRepo.set(repo, []);
  byRepo.get(repo)!.push(e);
}

const PER_REPO = 15;
const result: any = {};
let seed = 555;
for (const [repo, edges] of byRepo) {
  const sample = seededShuffle(edges, seed++).slice(0, PER_REPO);
  result[repo] = sample.map(e => {
    const source = getNode.get(e.source_node_id);
    const target = getNode.get(e.target_node_id);
    return { source, target, source_id: e.source_node_id, target_id: e.target_node_id };
  });
  console.log(repo, ': total edges', edges.length, ', sampled', result[repo].length);
}
fs.writeFileSync('scratch/audit/per_repo_edge_samples.json', JSON.stringify(result, null, 2));
