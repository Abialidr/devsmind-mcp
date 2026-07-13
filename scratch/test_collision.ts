import * as path from 'path';
import * as fs from 'fs';
import { DevMindDatabase } from '../src/db/database';

const ROOT = path.resolve('scratch/collision-test');
const DBFILE = path.join(ROOT, '.devmind', 'brain.db');

function seed() {
  const db = new DevMindDatabase(DBFILE);
  for (const repo of ['repoX', 'repoY']) {
    const sym = repo === 'repoX' ? 'pageX' : 'pageY';
    const id = `{${repo}}/src/app/page.tsx#${sym}`;
    const fp = path.join(ROOT, repo, 'src', 'app', 'page.tsx');
    db.upsertNode({ id, name: sym, type: 'function', file_path: fp });
    db.updateHistory({ node_id: id, code_snapshot: `export function ${sym}(){}`, reasoning: { what_changed: 's', why: 's', goal: 's', developer: 's', model: 's' } });
  }
  db.close();
}

function report(label: string) {
  const db = new DevMindDatabase(DBFILE); // triggers syncFromDisk
  const nodes = db.listNodes();
  console.log(`\n[${label}] active nodes: ${nodes.length}`);
  nodes.forEach(n => console.log('   ', n.id));
  db.close();
  // check each repo's graph JSON contains only its own node
  for (const repo of ['repoX', 'repoY']) {
    const gj = path.join(ROOT, '.devmind', 'graph', repo, 'src', 'app', 'page.json');
    if (fs.existsSync(gj)) {
      const data = JSON.parse(fs.readFileSync(gj, 'utf-8'));
      const ids = (data.nodes || []).map((n: any) => n.id);
      const foreign = ids.filter((i: string) => !i.startsWith(`{${repo}}/`));
      console.log(`   graph/${repo}/.../page.json nodes: [${ids.join(', ')}]${foreign.length ? '  <-- FOREIGN: ' + foreign.join(',') : ''}`);
    } else {
      console.log(`   graph/${repo}/.../page.json MISSING`);
    }
  }
}

seed();
report('after seed');
report('after reopen #1 (syncFromDisk)');
report('after reopen #2 (syncFromDisk again)');
