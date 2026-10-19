import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A public demo site gets the demo machines without the demo accounts, whose password is published.
const dir = mkdtempSync(join(tmpdir(), 'monitor-seed-'));
process.env.MONITOR_DATA_DIR = dir;
const { seedDemo, bootstrapAdmin, DEMO_MACHINES } = await import('../server/seed.js');
const { db, one } = await import('../server/db.js');
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test('demo machines without demo accounts, then the first admin from the environment', () => {
  assert.equal(seedDemo({ accounts: false }), DEMO_MACHINES.length);
  assert.equal(one('SELECT COUNT(*) n FROM machines').n, 6);
  assert.equal(one('SELECT COUNT(*) n FROM users').n, 0);
  assert.equal(seedDemo({ accounts: false }), 0, 'repeating it adds nothing');
  process.env.MONITOR_ADMIN_EMAIL = 'owner@plant.example'; process.env.MONITOR_ADMIN_PASSWORD = 'a-long-admin-password';
  assert.equal(bootstrapAdmin(), true);
  assert.equal(one('SELECT role FROM users WHERE email=?', 'owner@plant.example').role, 'admin');
  assert.equal(bootstrapAdmin(), false, 'created once');
});
