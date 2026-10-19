// One-time move of an existing SQLite deployment into PostgreSQL.
//   DATABASE_URL=postgres://… node backend/scripts/import-sqlite.js /data/mouldcare.sqlite [--force]
// Safe by default: refuses an out-of-date SQLite file, refuses a PostgreSQL database that already holds customer data
// (unless --force), copies everything in one transaction (all or nothing), keeps insertion order, then verifies counts.
// Uploaded files are not in the database: copy the uploads folder (MOULDCARE_DATA_DIR/uploads) across separately.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { db, ROOT, transaction, execSql, rawQuery, all, one } from '../common/db.js';

const file = process.argv[2];
const force = process.argv.includes('--force');
if (!file || !existsSync(file)) { console.error('Usage: node backend/scripts/import-sqlite.js <path to mouldcare.sqlite> [--force]'); process.exit(2); }

const src = new DatabaseSync(file, { readOnly: true });
const legacy = readdirSync(join(ROOT, 'backend', 'migrations', 'sqlite-legacy')).filter((f) => f.endsWith('.sql')).sort();
const applied = new Set(src.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
const missing = legacy.filter((v) => !applied.has(v));
if (missing.length) {
  console.error(`The SQLite database is behind (missing ${missing.join(', ')}). Start the last SQLite release once to migrate it, then import.`);
  process.exit(1);
}
if (!force && (await one('SELECT 1 FROM companies LIMIT 1'))) {
  console.error('The PostgreSQL database already has companies. Import into an empty database, or pass --force to replace its data.');
  process.exit(1);
}

const pgTables = (await all(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()
  AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY table_name`)).map((r) => r.table_name);
const sqliteTables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
const counts = {};

await transaction(async () => {
  await execSql('SET CONSTRAINTS ALL DEFERRED');
  await execSql(`TRUNCATE ${pgTables.map((t) => `"${t}"`).join(', ')} CASCADE`); // also clears migration reference rows; the file's copy wins
  for (const table of pgTables) {
    if (!sqliteTables.has(table)) { counts[table] = 0; continue; }
    const pgCols = new Set((await all('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?', table)).map((r) => r.column_name));
    const rows = src.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
    counts[table] = rows.length;
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]).filter((c) => pgCols.has(c));
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const values = chunk.map((_, r) => `(${cols.map((_, c) => `$${r * cols.length + c + 1}`).join(',')})`).join(',');
      const params = chunk.flatMap((row) => cols.map((c) => row[c]));
      await rawQuery(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES ${values}`, params);
    }
  }
  await execSql('SET CONSTRAINTS ALL IMMEDIATE'); // every foreign key is checked here, before commit
});

// Verify
let bad = 0;
for (const table of pgTables) {
  const n = (await one(`SELECT count(*) AS n FROM "${table}"`)).n;
  if (n !== counts[table]) { bad++; console.error(`  ${table}: SQLite ${counts[table]}, PostgreSQL ${n}`); }
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(bad ? `Import finished with ${bad} mismatched tables (see above).` : `Imported ${total} rows across ${pgTables.length} tables; counts match.`);
console.log('Next: copy the uploads folder, then start the server with DATABASE_URL set.');
await db.close();
process.exit(bad ? 1 : 0);

