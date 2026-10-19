import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.MONITOR_DATA_DIR || join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(join(DATA_DIR, 'monitor.sqlite'));
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
const dir = join(ROOT, 'server', 'migrations');
for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(file)) continue;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(join(dir, file), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(file, new Date().toISOString());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw new Error(`Migration ${file} failed: ${e.message}`); }
}

export const id = () => crypto.randomUUID();
export const one = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
export function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
export const setting = (key, fallback = null) => { const r = one('SELECT value FROM settings WHERE key=?', key); return r ? JSON.parse(r.value) : fallback; };
export const saveSetting = (key, value) => run('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
export const audit = (userId, action, entity, entityId, detail = {}) => run('INSERT INTO audit VALUES (?,?,?,?,?,?,?)', id(), userId, action, entity, entityId, JSON.stringify(detail), Date.now());
