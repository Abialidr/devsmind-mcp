const path = require('path');
const { DevMindDatabase } = require('../dist/db/database');

const dbPath = path.resolve(__dirname, 'test-project/.devmind/brain.db');
console.log('Initializing test database at:', dbPath);
const db = new DevMindDatabase(dbPath);
db.close();
console.log('Initialized test database successfully!');
