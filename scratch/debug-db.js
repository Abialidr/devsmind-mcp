const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, 'test-project/.devmind/brain.db');
console.log('Opening DB at:', dbPath);
const db = new Database(dbPath);

// Check tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

// Check foreign keys status
db.pragma('foreign_keys = ON');
console.log('Foreign keys: ON');

// Insert a node manually
try {
  db.prepare("INSERT INTO nodes (id, type, name, file_path) VALUES (?, ?, ?, ?)").run(
    'TestNode',
    'function',
    'TestNode',
    '/fake/path.ts'
  );
  console.log('Manual insert: success');
} catch(e) {
  console.log('Manual insert error:', e.message);
}

// Check if manual insert stuck
const nodes = db.prepare("SELECT * FROM nodes").all();
console.log('Nodes after manual insert:', nodes);

db.close();
