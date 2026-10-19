import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The whole app on a fresh database: demo plant, a simulated week with three developing faults, then the API as the
// dashboard and gateways use it. No AI key: every AI feature must fall back to its standard version.
const dir = mkdtempSync(join(tmpdir(), 'monitor-test-'));
process.env.MONITOR_DATA_DIR = dir;
process.env.MONITOR_INGEST_KEY = 'test-ingest-key';
delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
const { seedDemo, DEMO_PASSWORD } = await import('../server/seed.js');
const { simulate } = await import('../server/simulator.js');
const { analyzeAll } = await import('../server/ml/analyze.js');
const { createServer } = await import('../server/index.js');
const { db, one, all, run } = await import('../server/db.js');
seedDemo(); simulate(); analyzeAll();
const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(async () => { await new Promise(r => server.close(r)); db.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body == null ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
const tokens = {};
const machineId = tag => one('SELECT id FROM machines WHERE tag=?', tag).id;

test('sign in, roles and lockout', async () => {
  for (const who of ['admin', 'engineer', 'viewer']) { const r = await call('/auth/login', { method: 'POST', body: { email: `${who}@monitor.test`, password: DEMO_PASSWORD } }); assert.equal(r.status, 200); tokens[who] = r.data.token; }
  assert.equal((await call('/overview')).status, 401);
  assert.equal((await call('/me', { token: tokens.viewer })).data.role, 'viewer');
  for (let i = 0; i < 5; i++) assert.equal((await call('/auth/login', { method: 'POST', body: { email: 'nobody@monitor.test', password: 'wrong' } })).status, 401);
  assert.equal((await call('/auth/login', { method: 'POST', body: { email: 'nobody@monitor.test', password: 'wrong' } })).status, 429);
});

test('the analysis finds the three developing faults and nothing on the healthy machines', async () => {
  const o = await call('/overview', { token: tokens.viewer });
  assert.equal(o.status, 200); assert.equal(o.data.machines.length, 6);
  const byTag = Object.fromEntries(o.data.machines.map(m => [m.tag, m]));
  assert.equal(byTag['IMM-02'].topFinding.kind, 'degrading'); assert.equal(byTag['IMM-02'].topFinding.signalKey, 'hydraulic_oil_temp');
  assert.equal(byTag['BM-01'].topFinding.kind, 'unusual'); assert.equal(byTag['BM-01'].topFinding.signalKey, 'pump_vibration');
  assert.equal(byTag['CH-01'].topFinding.kind, 'limit'); assert.equal(byTag['CH-01'].topFinding.signalKey, 'supply_temp');
  for (const tag of ['IMM-01', 'EXT-01', 'DRY-01']) { assert.equal(byTag[tag].topFinding, null, tag); assert.equal(byTag[tag].health.status, 'good'); }
  assert.ok(byTag['IMM-02'].health.score < 100);
  const m = await call(`/machines/${machineId('IMM-02')}`, { token: tokens.viewer });
  assert.ok(m.data.analysis.model.trainedAt, 'pattern model trained'); assert.ok(m.data.analysis.model.rows >= 96);
  const s = await call(`/machines/${machineId('IMM-02')}/series?signal=hydraulic_oil_temp&hours=168`, { token: tokens.viewer });
  assert.ok(s.data.points.length > 200 && s.data.points.length <= 340); assert.equal(s.data.limits.crit_high, 65);
});

test('gateway intake: key required, bad items rejected with a reason, good values stored', async () => {
  const at = new Date().toISOString();
  assert.equal((await call('/ingest', { method: 'POST', body: { readings: [] } })).status, 401);
  const r = await call('/ingest', { method: 'POST', headers: { 'x-ingest-key': 'test-ingest-key' }, body: { readings: [
    { device: 'plc-imm-01', at, state: 'running', values: { hydraulic_oil_temp: 46.1, nonsense: 1 } },
    { device: 'plc-unknown', at, values: { x: 1 } },
    { device: 'plc-imm-01', at: Date.now() + 3600000, values: { hydraulic_oil_temp: 1 } },
    { device: 'plc-imm-01', at, values: { pump_vibration: 'high' } },
  ] } });
  assert.equal(r.status, 200); assert.equal(r.data.accepted, 1); assert.equal(r.data.rejected, 3);
  assert.deepEqual(r.data.results[0].skipped, ['nonsense: unknown signal']);
  assert.match(r.data.results[1].reason, /Unknown device/); assert.match(r.data.results[2].reason, /future/); assert.match(r.data.results[3].reason, /not a number/);
  assert.equal(one('SELECT value FROM readings WHERE machine_id=? AND key=? ORDER BY ts DESC LIMIT 1', machineId('IMM-01'), 'hydraulic_oil_temp').value, 46.1);
});

test('people decide: a viewer cannot, a false alarm is closed and stays quiet on the next analysis', async () => {
  const f = one("SELECT * FROM findings WHERE machine_id=? AND status='open'", machineId('BM-01'));
  assert.equal((await call(`/findings/${f.id}`, { method: 'PATCH', token: tokens.viewer, body: { status: 'false_alarm' } })).status, 403);
  const r = await call(`/findings/${f.id}`, { method: 'PATCH', token: tokens.engineer, body: { status: 'false_alarm', note: 'Coupling insert replaced yesterday' } });
  assert.equal(r.data.status, 'false_alarm'); assert.equal(r.data.note, 'Coupling insert replaced yesterday');
  analyzeAll();
  assert.equal(one("SELECT COUNT(*) n FROM findings WHERE machine_id=? AND kind='unusual' AND status='open'", machineId('BM-01')).n, 0);
  assert.ok(one("SELECT 1 FROM audit WHERE action='finding.false_alarm' AND entity_id=?", f.id));
  const active = await call('/findings', { token: tokens.viewer });
  assert.ok(active.data.every(x => ['open', 'acknowledged', 'confirmed'].includes(x.status)));
  assert.equal((await call('/findings?status=false_alarm', { token: tokens.viewer })).data.length, 1);
});

test('without an AI key: standard explanation, ticket draft and report; the chat says it is off', async () => {
  const f = one("SELECT * FROM findings WHERE machine_id=? AND kind='degrading'", machineId('IMM-02'));
  const e = await call(`/findings/${f.id}/explain`, { method: 'POST', token: tokens.viewer, body: {} });
  assert.equal(e.status, 200); assert.equal(e.data.source, 'standard');
  assert.match(e.data.summary, /IMM-02/); assert.match(e.data.summary, /critical limit in about \d+ hours/);
  assert.match(e.data.likelyCauses[0].cause, /cooler/i); assert.equal(e.data.urgency, 'this_week');
  const t = await call(`/findings/${f.id}/ticket`, { method: 'POST', token: tokens.engineer, body: {} });
  assert.equal(t.status, 201); assert.equal(t.data.source, 'standard'); assert.equal(t.data.draft.failureCategory, 'hydraulic'); assert.equal(t.data.draft.machineTag, 'IMM-02');
  assert.equal((await call(`/findings/${f.id}/ticket`, { method: 'POST', token: tokens.viewer, body: {} })).status, 403);
  const approved = await call(`/tickets/${t.data.id}`, { method: 'PATCH', token: tokens.engineer, body: { status: 'approved' } });
  assert.equal(approved.data.status, 'approved');
  assert.equal((await call(`/tickets/${t.data.id}`, { method: 'PATCH', token: tokens.engineer, body: { status: 'discarded' } })).status, 400);
  const rep = await call('/reports', { method: 'POST', token: tokens.engineer, body: { period: 'week' } });
  assert.equal(rep.status, 201);
  const body = (await call('/reports', { token: tokens.viewer })).data[0].body;
  assert.match(body, /## Needs attention/); assert.match(body, /IMM-02/); assert.match(body, /critical limit in about \d+ h/);
  const c = await call('/chat', { method: 'POST', token: tokens.engineer, body: { text: 'Hi' } });
  assert.equal(c.status, 503); assert.match(c.data.error, /ANTHROPIC_API_KEY/);
});

test('limits: admin only, validated, and the analysis uses them at once', async () => {
  const mid = machineId('IMM-01');
  assert.equal((await call(`/machines/${mid}/limits`, { method: 'PUT', token: tokens.engineer, body: { limits: [] } })).status, 403);
  assert.equal((await call(`/machines/${mid}/limits`, { method: 'PUT', token: tokens.admin, body: { limits: [{ key: 'hydraulic_oil_temp', warn_high: 60, crit_high: 50 }] } })).status, 400);
  // A warning limit below today's oil temperature raises a limit finding straight away.
  const r = await call(`/machines/${mid}/limits`, { method: 'PUT', token: tokens.admin, body: { limits: [{ key: 'hydraulic_oil_temp', warn_high: 20, crit_high: 90 }] } });
  assert.equal(r.status, 200);
  assert.ok(one("SELECT 1 FROM findings WHERE machine_id=? AND signal_key='hydraulic_oil_temp' AND kind='limit' AND status='open'", mid));
  await call(`/machines/${mid}/limits`, { method: 'PUT', token: tokens.admin, body: { limits: [{ key: 'hydraulic_oil_temp', warn_high: 55, crit_high: 65 }] } });
  assert.equal(one("SELECT status FROM findings WHERE machine_id=? AND signal_key='hydraulic_oil_temp' AND kind='limit'", mid).status, 'resolved');
});

test('static files carry security headers and refuse path tricks', async () => {
  const r = await fetch(base.replace('/api', '/'));
  assert.equal(r.status, 200); assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(base.replace('/api', '/..%2Fpackage.json'))).status, 404);
  assert.equal((await call('/nope', { token: tokens.viewer })).status, 404);
});
