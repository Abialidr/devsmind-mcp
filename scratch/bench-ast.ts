import * as path from 'path';
import { resolveConnectionsLocally } from '../src/utils/ast';

const ROOT = path.join(__dirname, 'ast-fixtures');
const DEVMIND = path.join(ROOT, '.devmind');
const abs = (r: string) => path.join(ROOT, r);

// Replicate the fixture nodes but blow the candidate list up to 7270 with synthetic
// entries to mimic harrir-brains scale (each source node loops the whole list).
const base = [
  ['src/utils/dates.ts', 'formatDate'], ['src/app/pricing.ts', 'computeTotal'],
  ['src/app/userHandler.ts', 'handleCreate'], ['src/app/report.ts', 'makeReport'],
  ['src/components/Cart.tsx', 'Cart.handleRemove'], ['src/app/page.tsx', 'Page'],
] as const;
const nodes: any[] = base.map(([f, s]) => ({ id: `{fix}/${f}#${s}`, name: s, type: 'x', file_path: abs(f) }));
for (let i = 0; i < 7270; i++) {
  nodes.push({ id: `{fix}/src/synthetic/mod${i}.ts#sym${i}`, name: `sym${i}`, type: 'x', file_path: abs(`src/synthetic/mod${i}.ts`) });
}

const t0 = Date.now();
let total = 0;
for (const src of base) {
  const id = `{fix}/${src[0]}#${src[1]}`;
  const fp = abs(src[0]);
  const conns = resolveConnectionsLocally(id, fp, nodes, DEVMIND);
  total += conns.length;
}
const ms = Date.now() - t0;
console.log(`Resolved ${base.length} source nodes against ${nodes.length} candidates in ${ms}ms`);
console.log(`= ${(ms / base.length).toFixed(1)} ms/source-node  (total edges: ${total})`);
