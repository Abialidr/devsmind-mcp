import Database from 'better-sqlite3';
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', {readonly:true});
const rows = db.prepare('SELECT source_node_id FROM node_connections LIMIT 3').all();
console.log(rows);
const n = db.prepare('SELECT id, file_path FROM nodes WHERE id = ?').get((rows[0] as any).source_node_id);
console.log(n);
const repoOf = (fp: string) => {
  const m = fp.match(/lamda[\/]([^\\/]+)[\/]/);
  return m ? m[1] : 'unknown-' + fp;
};
console.log(repoOf('C:\work\Hanoot\backend\lamda\harrir-backend-order-service\src\controllers\BoxyOrderController.ts'));
