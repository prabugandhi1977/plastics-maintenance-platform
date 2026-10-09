// PostgreSQL access shared by every service. Same small API the SQLite version had (one, all, run, transaction),
// now async. Queries keep `?` placeholders; they are rewritten to $1..$n once per distinct statement.
//
// Concurrency model (matches what SQLite gave the code, without its global read lock):
//   - transaction(fn) runs fn on one pooled client and takes a transaction-level advisory lock, so writers are
//     serialised exactly as with SQLite's single writer. Nested calls join the outer transaction.
//   - readOnly(fn) runs fn in a READ ONLY, REPEATABLE READ transaction: a consistent snapshot, fully concurrent.
//   - Outside either, each statement autocommits on any pooled connection.
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = process.env.MOULDCARE_DATA_DIR || join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

// BIGINT and NUMERIC come back as JS numbers (values here stay well inside 2^53).
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const SCHEMA = process.env.MOULDCARE_DB_SCHEMA || 'public';
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) throw new Error('MOULDCARE_DB_SCHEMA must be a lowercase identifier');
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://mouldcare:mouldcare@localhost:5432/mouldcare',
  max: Number(process.env.DB_POOL_MAX || 10),
  ...(SCHEMA !== 'public' ? { options: `-c search_path=${SCHEMA}` } : {}),
});
pool.on('error', (e) => console.error('PostgreSQL pool error:', e.message));

const store = new AsyncLocalStorage();
const WRITER_LOCK = 734001; // arbitrary constant shared by all writers

// `?` → `$n`, skipping quoted strings and identifiers. Cached per statement text.
const cache = new Map();
export function toPg(sql) {
  let out = cache.get(sql);
  if (out) return out;
  let n = 0, q = null; out = '';
  for (const ch of sql) {
    if (q) { if (ch === q) q = null; out += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; out += ch; continue; }
    out += ch === '?' ? `$${++n}` : ch;
  }
  if (cache.size > 5000) cache.clear();
  cache.set(sql, out);
  return out;
}

const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));
const exec = (sql, args) => (store.getStore() ?? pool).query(toPg(sql), norm(args));

export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const one = async (sql, ...args) => (await exec(sql, args)).rows[0];
export const all = async (sql, ...args) => (await exec(sql, args)).rows;
export const run = async (sql, ...args) => ({ changes: (await exec(sql, args)).rowCount ?? 0 });
// Multi-statement script without parameters (test fixtures, maintenance).
export const execSql = async (sql) => { await (store.getStore() ?? pool).query(sql); };
export const inTransaction = () => Boolean(store.getStore());

async function withClient(begin, fn) {
  if (store.getStore()) return fn(); // join the outer transaction
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await store.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}
export const transaction = (fn) => withClient(`BEGIN; SELECT pg_advisory_xact_lock(${WRITER_LOCK})`, fn);
export const readOnly = (fn) => withClient('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', fn);

// Sequential versions of array helpers, for callbacks that query the database (order and side effects preserved).
export async function mapSeq(xs, fn) { const out = []; let i = 0; for (const x of xs ?? []) out.push(await fn(x, i++, xs)); return out; }
export async function forEachSeq(xs, fn) { let i = 0; for (const x of xs ?? []) await fn(x, i++, xs); }
export async function filterSeq(xs, fn) { const out = []; let i = 0; for (const x of xs ?? []) if (await fn(x, i++, xs)) out.push(x); return out; }
export async function someSeq(xs, fn) { let i = 0; for (const x of xs ?? []) if (await fn(x, i++, xs)) return true; return false; }
export async function everySeq(xs, fn) { let i = 0; for (const x of xs ?? []) if (!(await fn(x, i++, xs))) return false; return true; }
export async function findSeq(xs, fn) { let i = 0; for (const x of xs ?? []) if (await fn(x, i++, xs)) return x; return undefined; }
export async function flatMapSeq(xs, fn) { return (await mapSeq(xs, fn)).flat(); }
export async function reduceSeq(xs, fn, init) { let acc = init, i = 0; for (const x of xs ?? []) acc = await fn(acc, x, i++, xs); return acc; }

// Migrations: numbered *.sql files in backend/migrations, each applied once in its own transaction.
export async function migrate() {
  if (SCHEMA !== 'public') await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = join(ROOT, 'backend', 'migrations');
  for (const file of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if ((await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file])).rowCount) continue;
    await transaction(async () => {
      try {
        await store.getStore().query(readFileSync(join(dir, file), 'utf8'));
        await run('INSERT INTO schema_migrations VALUES (?,?)', file, now());
      } catch (e) { throw new Error(`Migration ${file} failed: ${e.message}`); }
    });
  }
}
await migrate();

// Kept so existing call sites (tests, scripts) can close the pool; dropSchema is for test isolation only.
export const db = {
  close: async ({ dropSchema = false } = {}) => {
    if (dropSchema && SCHEMA !== 'public') await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  },
};
