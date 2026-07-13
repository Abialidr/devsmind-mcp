import * as path from 'path';
import * as fs from 'fs';
import * as ts from 'typescript';
import Database from 'better-sqlite3';

const DEVMIND = 'C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind';
const db = new Database(DEVMIND + '/brain.db', { readonly: true });
const nodes = db.prepare("SELECT id, name, file_path FROM nodes WHERE deprecated=0").all() as any[];
const norm = (p: string) => path.resolve(p).split(path.sep).join('/').toLowerCase();

// nodes grouped by file
const byFile = new Map<string, number>();
for (const n of nodes) {
  const fp = norm(String(n.file_path).split(',')[0].trim());
  byFile.set(fp, (byFile.get(fp) ?? 0) + 1);
}

// count "real" declarations in a file via AST
function countDecls(file: string): number {
  const text = fs.readFileSync(file, 'utf-8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visitTop = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) count++;
    else if (ts.isClassDeclaration(node)) {
      count++;
      node.members.forEach(m => { if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.name) count++; });
    }
    else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) count++;
    else if (ts.isVariableStatement(node)) {
      node.declarationList.declarations.forEach(d => {
        if (ts.isIdentifier(d.name) && d.initializer &&
            (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer) || ts.isClassExpression(d.initializer) ||
             ts.isObjectLiteralExpression(d.initializer) || ts.isCallExpression(d.initializer))) count++;
      });
    }
  };
  sf.statements.forEach(s => {
    visitTop(s);
    // unwrap `export ...`
    if ((s as any).declarationList || ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) return;
  });
  return count;
}

// sample covered TS/JS files
const coveredFiles = [...byFile.keys()].filter(f => /\.(ts|tsx|js|jsx)$/.test(f) && fs.existsSync(f));
const step = Math.max(1, Math.floor(coveredFiles.length / 120));
const sample = coveredFiles.filter((_, i) => i % step === 0).slice(0, 120);

let totDecls = 0, totNodes = 0, ratios: number[] = [];
for (const f of sample) {
  let decls = 0;
  try { decls = countDecls(f); } catch { continue; }
  if (decls === 0) continue;
  const extracted = byFile.get(f) ?? 0;
  totDecls += decls; totNodes += Math.min(extracted, decls);
  ratios.push(Math.min(1, extracted / decls));
}
ratios.sort((a, b) => a - b);
const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
console.log(`Sampled ${ratios.length} covered files.`);
console.log(`Mean intra-file capture ratio (nodes extracted / real declarations): ${(avg * 100).toFixed(0)}%`);
console.log(`Median: ${(ratios[Math.floor(ratios.length / 2)] * 100).toFixed(0)}%`);
console.log(`Files where <50% of declarations were captured: ${ratios.filter(r => r < 0.5).length}/${ratios.length}`);
console.log(`Files where >=90% captured: ${ratios.filter(r => r >= 0.9).length}/${ratios.length}`);
