import Database from 'better-sqlite3';
import * as fs from 'fs';
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', { readonly: true });
function repoOf(id:string){ const m=id.match(/^\{([^}]+)\}/); return m?m[1]:'?'; }
const nmeta = new Map<string,any>();
for (const n of db.prepare('SELECT id,name,type,file_path,signature FROM nodes').all() as any[]) nmeta.set(n.id,n);
const edges = db.prepare('SELECT source_node_id s, target_node_id t FROM node_connections').all() as any[];
let seed = 1234567;
function rnd(){ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; }
function sample(repo:string,k:number){
  const pool = edges.filter(e=>repoOf(e.s)===repo && repoOf(e.t)===repo);
  const idx=[...pool.keys()]; for(let i=idx.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[idx[i],idx[j]]=[idx[j],idx[i]];}
  return idx.slice(0,k).map(i=>pool[i]);
}
const plan:[string,number][]=[['harrir-express-backend',10],['harrir-mini-app',10],['harrir-backend-order-service',5],['harrir-backend-products-service',5],['harrir-backend-user-service',5],['harrir-backend-zoho-service',5]];

// extract body of source symbol from file
function leafName(id:string){ const sym=id.split('#')[1]; return sym; }
function findBody(text:string, sm:any){
  // leaf simple name = last identifier segment of node.name
  const name = sm.name;
  // try to find a plausible declaration line for this name, then brace-match
  // collect candidate indices where name appears as a word
  const re = new RegExp('\\b'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','g');
  let m; const cands:number[]=[];
  while((m=re.exec(text))) cands.push(m.index);
  // prefer a candidate that is followed (soon) by '(' ... '{' or '=>' or '= function'
  for(const c of cands){
    const after = text.slice(c, c+400);
    if(/^\S*\s*[:=]?\s*(async\s+)?(function\b|\()/.test(after) || /=>/.test(after.slice(0,120))){
      // brace match from first { after c
      const bi = text.indexOf('{', c);
      const arrowSemi = text.indexOf('=>', c);
      let start = bi;
      if(arrowSemi>-1 && (bi<0||arrowSemi<bi)){ start = text.indexOf('{', arrowSemi); }
      if(start<0) continue;
      let depth=0; let i=start;
      for(; i<text.length; i++){ const ch=text[i]; if(ch==='{')depth++; else if(ch==='}'){depth--; if(depth===0){i++;break;}} }
      return {body:text.slice(c,i), declPos:c};
    }
  }
  // fallback: first candidate, take 1500 chars
  if(cands.length) return {body:text.slice(cands[0], cands[0]+1500), declPos:cands[0]};
  return null;
}
function lineNo(text:string,pos:number){ return text.slice(0,pos).split('\n').length; }

for(const [repo,k] of plan){
  console.log('\n========== '+repo+' ==========');
  for(const e of sample(repo,k)){
    const sm=nmeta.get(e.s), tm=nmeta.get(e.t);
    const tgt=tm.name;
    const file=sm.file_path;
    let verdict='?'; let detail='';
    try{
      const text=fs.readFileSync(file,'utf8');
      const b=findBody(text,sm);
      if(!b){ verdict='SRC-NOTFOUND'; }
      else{
        const tre=new RegExp('\\b'+tgt.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b');
        const inBody=tre.test(b.body);
        verdict = inBody?'IN-BODY':'NOT-IN-BODY';
        detail=`declLine~${lineNo(text,b.declPos)} bodyLen${b.body.length}`;
        const sameFile = sm.file_path===tm.file_path;
        detail+= sameFile?' [SAME-FILE]':' [cross-file]';
      }
    }catch(err:any){ verdict='ERR'; detail=err.message; }
    console.log(`${verdict} | ${sm.name} -> ${tgt} | ${detail}`);
    console.log(`     src=${e.s.replace(/^\{[^}]+\}/,'')}`);
  }
}
