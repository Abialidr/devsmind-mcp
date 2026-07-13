import * as path from 'path';
import { resolveConnectionsLocally } from '../src/utils/ast';

const ROOT = path.join(__dirname, 'ast-fixtures');
const DEVMIND = path.join(ROOT, '.devmind');
const abs = (r: string) => path.join(ROOT, r);

// Source: pricing.ts in repo "fix" does `import { addNumbers } from '@utils/math'`.
const srcId = '{fix}/src/app/pricing.ts#computeTotal';
const srcFile = abs('src/app/pricing.ts');

// Candidates: the REAL target plus decoys that share the identical symbol name and
// identical relative path, but live in DIFFERENT repos (different absolute paths).
const candidates = [
  { id: '{fix}/src/utils/math.ts#addNumbers', name: 'addNumbers', type: 'fn', file_path: abs('src/utils/math.ts') },              // correct
  { id: '{harrir-web}/src/utils/math.ts#addNumbers', name: 'addNumbers', type: 'fn', file_path: 'C:/repos/harrir-web/src/utils/math.ts' },         // decoy
  { id: '{harrir-web-admin}/src/utils/math.ts#addNumbers', name: 'addNumbers', type: 'fn', file_path: 'C:/repos/harrir-web-admin/src/utils/math.ts' }, // decoy (prefix collision)
];

const got = resolveConnectionsLocally(srcId, srcFile, candidates, DEVMIND);
console.log('Resolved edges from computeTotal:');
got.forEach(g => console.log('   →', g));
const wrong = got.filter(g => !g.startsWith('{fix}/'));
console.log(wrong.length === 0
  ? '\n✅ PASS — only the correct repo linked; no harrir-web / harrir-web-admin mixing.'
  : `\n❌ FAIL — cross-repo mixing: ${wrong.join(', ')}`);
