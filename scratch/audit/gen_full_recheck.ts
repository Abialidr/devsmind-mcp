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

console.log('total edges:', db.prepare('SELECT COUNT(*) c FROM node_connections').get());
console.log('total active nodes:', db.prepare('SELECT COUNT(*) c FROM nodes WHERE deprecated=0').get());

const getNode = db.prepare('SELECT id, name, type, file_path FROM nodes WHERE id = ?');

// ---------- EDGES: 15 per repo ----------
const allEdges: any[] = db.prepare('SELECT source_node_id, target_node_id FROM node_connections').all();
const edgesByRepo = new Map<string, any[]>();
for (const e of allEdges) {
  const src = getNode.get(e.source_node_id) as any;
  if (!src) continue;
  const repo = repoOf(src.file_path);
  if (!edgesByRepo.has(repo)) edgesByRepo.set(repo, []);
  edgesByRepo.get(repo)!.push(e);
}

const EDGE_PER_REPO = 15;
const edgeResult: any = {};
let seed = 777001;
for (const [repo, edges] of edgesByRepo) {
  const sample = seededShuffle(edges, seed++).slice(0, EDGE_PER_REPO);
  edgeResult[repo] = sample.map(e => {
    const source = getNode.get(e.source_node_id);
    const target = getNode.get(e.target_node_id);
    return { source, target, source_id: e.source_node_id, target_id: e.target_node_id };
  });
  console.log('EDGES', repo, ': total', edges.length, ', sampled', edgeResult[repo].length);
}
fs.writeFileSync('scratch/audit/final_recheck_edges.json', JSON.stringify(edgeResult, null, 2));

// ---------- ORPHANS: up to 12 per repo ----------
const orphans: any[] = db.prepare(`
  SELECT n.id, n.name, n.type, n.file_path FROM nodes n
  WHERE n.deprecated = 0
  AND n.id NOT IN (SELECT source_node_id FROM node_connections)
  AND n.id NOT IN (SELECT target_node_id FROM node_connections)
`).all();
console.log('total orphans:', orphans.length);

const orphansByRepo = new Map<string, any[]>();
for (const o of orphans) {
  const repo = repoOf(o.file_path);
  if (!orphansByRepo.has(repo)) orphansByRepo.set(repo, []);
  orphansByRepo.get(repo)!.push(o);
}

const ORPHAN_PER_REPO = 12;
const orphanResult: any = {};
seed = 888002;
for (const [repo, list] of orphansByRepo) {
  const sample = seededShuffle(list, seed++).slice(0, ORPHAN_PER_REPO);
  orphanResult[repo] = { total_orphans: list.length, sample };
  console.log('ORPHANS', repo, ': total', list.length, ', sampled', sample.length);
}
fs.writeFileSync('scratch/audit/final_recheck_orphans.json', JSON.stringify(orphanResult, null, 2));

// per-repo node totals for orphan rate context
const allNodes: any[] = db.prepare('SELECT id, file_path FROM nodes WHERE deprecated=0').all();
const nodeCountByRepo = new Map<string, number>();
for (const n of allNodes) {
  const repo = repoOf(n.file_path);
  nodeCountByRepo.set(repo, (nodeCountByRepo.get(repo) || 0) + 1);
}
console.log('--- node counts per repo ---');
for (const [repo, count] of nodeCountByRepo) {
  const orphanCount = orphansByRepo.get(repo)?.length || 0;
  console.log(repo, 'nodes:', count, 'orphans:', orphanCount, 'rate:', (100*orphanCount/count).toFixed(2)+'%');
}
