import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.MOULDCARE_DATA_DIR || join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(process.env.MOULDCARE_DB || join(DATA_DIR, 'mouldcare.sqlite'));
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
for (const file of readdirSync(join(ROOT, 'api', 'migrations')).filter(x => x.endsWith('.sql')).sort()) {
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(file)) {
    // All-or-nothing per migration, so a failure never leaves a half-applied schema that blocks the next start.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(readFileSync(join(ROOT, 'api', 'migrations', file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(file, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw new Error(`Migration ${file} failed: ${e.message}`); }
  }
}
export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const one = (sql, ...args) => db.prepare(sql).get(...args);
export const all = (sql, ...args) => db.prepare(sql).all(...args);
export const run = (sql, ...args) => db.prepare(sql).run(...args);
export function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result=fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
