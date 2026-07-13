import * as path from 'path';
import { DevMindDatabase } from '../src/db/database';
const ROOT = path.resolve('scratch/scoped-test');
const db = new DevMindDatabase(path.join(ROOT, '.devmind', 'brain.db'));
function seed(repo: string, file: string, sym: string, code: string) {
  const id = `{${repo}}/src/${file}#${sym}`;
  const fp = path.join(ROOT, repo, 'src', file);
  db.upsertNode({ id, name: sym, type: 'function', file_path: fp });
  db.updateHistory({ node_id: id, code_snapshot: code, reasoning: { what_changed: 'seed', why: 't', goal: 't', developer: 't', model: 't' } });
}
seed('repoA','util.ts','aHelper','export function aHelper(x:number){return x+1;}');
seed('repoA','main.ts','aMain','import { aHelper } from "./util";\nexport function aMain(){return aHelper(1);}');
seed('repoB','util.ts','bHelper','export function bHelper(x:number){return x+2;}');
seed('repoB','main.ts','bMain','import { bHelper } from "./util";\nexport function bMain(){return bHelper(2);}');
db.close();
console.log('seeded 4 nodes');
