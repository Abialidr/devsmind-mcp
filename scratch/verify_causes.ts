import * as path from 'path';
import Database from 'better-sqlite3';
import { resolveConnectionsLocally, parseNodeId } from '../src/utils/ast';

const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const db = new Database(path.join(DEVMIND, 'brain.db'), { readonly: true });

function nodesForRepo(repo: string) {
  return db.prepare("SELECT id, name, type, file_path FROM nodes WHERE id LIKE ? AND deprecated=0")
    .all(`{${repo}}/%`) as any[];
}

function test(label: string, repo: string, sourceIdLike: string, targetFileSubstr: string) {
  const nodes = nodesForRepo(repo);
  const src = nodes.find(n => n.id.includes(sourceIdLike));
  if (!src) { console.log(`\n${label}: source not found`); return; }
  const edges = resolveConnectionsLocally(src.id, src.file_path, nodes, DEVMIND);
  const toTarget = edges.filter(e => e.includes(targetFileSubstr));
  console.log(`\n=== ${label} ===`);
  console.log(`SOURCE: ${src.id.split('#')[1]}`);
  console.log(`Total edges produced: ${edges.length}   (to ${targetFileSubstr}: ${toTarget.length})`);
  console.log('Edges into target file:');
  toTarget.slice(0, 25).forEach(e => console.log('   →', e.split('#')[1]));
  if (toTarget.length > 25) console.log(`   … +${toTarget.length - 25} more`);
}

// express-backend: /boxy/regions SHOULD link ONLY to OrderController.listBoxyRegions
test('express-backend route /boxy/regions', 'harrir-express-backend',
  'routes/orders.ts#router.get("/boxy/regions")', 'OrderController.ts');

// mini-app: a single method SHOULD link only to what IT calls
test('mini-app HomePageComponent.methods._getLang', 'harrir-mini-app',
  'home-page.js#HomePageComponent.methods._getLang', 'home-page.js');
