import Database from 'better-sqlite3';
import * as fs from 'fs';

const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const db = new Database(DEVMIND + '/brain.db', { readonly: true });

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Sample 1: 20 files across 8 repos, spread evenly ----
const filesByRepo: any = db.prepare(`
  SELECT file_path, GROUP_CONCAT(id, '|||') as ids, COUNT(*) as node_count,
         GROUP_CONCAT(type, '|||') as types
  FROM nodes WHERE deprecated = 0
  GROUP BY file_path
`).all();

const repoOf = (fp: string) => {
  const m = fp.match(/lamda[\\/]([^\\\/]+)[\\/]/);
  return m ? m[1] : 'unknown';
};
const grouped = new Map<string, any[]>();
for (const f of filesByRepo) {
  const repo = repoOf(f.file_path);
  if (!grouped.has(repo)) grouped.set(repo, []);
  grouped.get(repo)!.push(f);
}
console.log('Repos found:', [...grouped.keys()]);

const fileSample: any[] = [];
let seed = 42;
for (const [repo, files] of grouped) {
  const shuffled = seededShuffle(files, seed++);
  const pick = shuffled.slice(0, 3); // up to 3 per repo, will trim to 20 total
  for (const f of pick) fileSample.push({ repo, ...f });
}
const finalFileSample = seededShuffle(fileSample, 7).slice(0, 20);
fs.writeFileSync('scratch/audit/sample_files.json', JSON.stringify(finalFileSample, null, 2));
console.log('File sample size:', finalFileSample.length);

// ---- Sample 4: 40 random edges ----
const allEdges: any[] = db.prepare('SELECT source_node_id, target_node_id FROM node_connections').all();
console.log('Total edges:', allEdges.length);
const edgeSample = seededShuffle(allEdges, 99).slice(0, 40);
// enrich with source/target node info
const getNode = db.prepare('SELECT id, name, type, file_path FROM nodes WHERE id = ?');
const enriched = edgeSample.map(e => ({
  source: getNode.get(e.source_node_id),
  target: getNode.get(e.target_node_id),
  source_id: e.source_node_id,
  target_id: e.target_node_id
}));
fs.writeFileSync('scratch/audit/sample_edges.json', JSON.stringify(enriched, null, 2));
console.log('Edge sample size:', enriched.length);

// ---- Sample 5: orphans ----
const orphans: any[] = db.prepare(`
  SELECT n.id, n.name, n.type, n.file_path FROM nodes n
  WHERE n.deprecated = 0
  AND n.id NOT IN (SELECT source_node_id FROM node_connections)
  AND n.id NOT IN (SELECT target_node_id FROM node_connections)
`).all();
const totalActive = db.prepare('SELECT COUNT(*) c FROM nodes WHERE deprecated=0').get() as any;
console.log('Orphan count:', orphans.length, '/', totalActive.c, '=', (100*orphans.length/totalActive.c).toFixed(2), '%');
const orphanSample = seededShuffle(orphans, 123).slice(0, 50);
fs.writeFileSync('scratch/audit/sample_orphans.json', JSON.stringify(orphanSample, null, 2));
console.log('Orphan sample size:', orphanSample.length);

// ---- Per-repo breakdown: orphan rate + edge density ----
const allNodes: any[] = db.prepare('SELECT id, file_path FROM nodes WHERE deprecated = 0').all();
const orphanIdSet = new Set(orphans.map((o: any) => o.id));
const perRepo = new Map<string, { nodes: number; orphans: number; edgesOut: number }>();
for (const n of allNodes) {
  const repo = repoOf(n.file_path);
  if (!perRepo.has(repo)) perRepo.set(repo, { nodes: 0, orphans: 0, edgesOut: 0 });
  const r = perRepo.get(repo)!;
  r.nodes++;
  if (orphanIdSet.has(n.id)) r.orphans++;
}
// count all edges (both directions) per repo based on source node's repo
const idToRepo = new Map<string, string>();
for (const n of allNodes) idToRepo.set(n.id, repoOf(n.file_path));
for (const e of allEdges) {
  const r = idToRepo.get(e.source_node_id);
  if (r && perRepo.has(r)) perRepo.get(r)!.edgesOut++;
}
const breakdown = [...perRepo.entries()].map(([repo, v]) => ({
  repo,
  nodes: v.nodes,
  orphans: v.orphans,
  orphan_rate_pct: +(100 * v.orphans / v.nodes).toFixed(2),
  edges_out: v.edgesOut,
  edge_density_per_node: +(v.edgesOut / v.nodes).toFixed(3)
}));
fs.writeFileSync('scratch/audit/per_repo_breakdown.json', JSON.stringify(breakdown, null, 2));
console.log(JSON.stringify(breakdown, null, 2));

const FRONTEND = new Set(['harrir-web', 'harrir-web-admin', 'harrir-mini-app']);
let fe = { nodes: 0, orphans: 0, edges: 0 };
let be = { nodes: 0, orphans: 0, edges: 0 };
for (const b of breakdown) {
  const bucket = FRONTEND.has(b.repo) ? fe : be;
  bucket.nodes += b.nodes;
  bucket.orphans += b.orphans;
  bucket.edges += b.edges_out;
}
console.log('Frontend:', fe, 'orphan_rate:', (100*fe.orphans/fe.nodes).toFixed(2), 'density:', (fe.edges/fe.nodes).toFixed(3));
console.log('Backend:', be, 'orphan_rate:', (100*be.orphans/be.nodes).toFixed(2), 'density:', (be.edges/be.nodes).toFixed(3));
