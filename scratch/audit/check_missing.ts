import Database from 'better-sqlite3';
const db = new Database('C:/work/Hanoot/backend/lamda/harrir-docs-information/harrir-brains/.devmind/brain.db', {readonly:true});
const ids = [
"{harrir-web}/app/api/get-link-criteria/route.ts#getErrorMessage",
"{harrir-web}/app/layout.tsx#RootLayout",
"{harrir-web}/components/ui/button.tsx#Button",
"{harrir-web}/components/ui/dropdown-menu.tsx#DropdownMenu"
];
for (const id of ids) {
  console.log(id, '-> node:', db.prepare('SELECT id,deprecated FROM nodes WHERE id=?').get(id));
  console.log('   history:', db.prepare('SELECT node_id FROM history WHERE node_id=?').get(id));
}
// check file_path stored for a sibling node in same file that DOES exist in db
console.log(db.prepare("SELECT id,file_path FROM nodes WHERE id LIKE '%layout.tsx%' AND file_path LIKE '%harrir-web%' LIMIT 5").all());
