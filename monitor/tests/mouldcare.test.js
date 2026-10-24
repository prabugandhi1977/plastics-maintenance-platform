import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hand-off to MouldCare: approving a draft posts it to MouldCare's ticket intake (a stand-in server here). Failures
// are recorded and retried, an unset connection is recorded as not_configured, and the key never leaves the server.
const dir = mkdtempSync(join(tmpdir(), 'monitor-mouldcare-'));
process.env.MONITOR_DATA_DIR = dir;
delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN; delete process.env.MONITOR_MOULDCARE_URL; delete process.env.MONITOR_MOULDCARE_KEY;
const KEY = 'mck_test-key-that-must-never-leak-0001';
const { seedDemo, DEMO_PASSWORD } = await import('../server/seed.js');
const { simulate } = await import('../server/simulator.js');
const { analyzeAll } = await import('../server/ml/analyze.js');
const { createServer } = await import('../server/index.js');
const { sendDraft, retryPending } = await import('../server/mouldcare.js');
const { db, one, all, run } = await import('../server/db.js');
seedDemo(); simulate(); analyzeAll();
const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

// Stand-in MouldCare: mode 'ok' raises a ticket once per reference (like the real intake), 'down' answers 503,
// 'reject' 400, 'hang' never answers.
const mc = { mode: 'ok', requests: [], tickets: new Map(), hung: [] };
const stand = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); mc.requests.push({ path: req.url, key: req.headers['x-integration-key'], body });
  if (mc.mode === 'hang') return mc.hung.push(res);
  const send = (s, v) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (req.headers['x-integration-key'] !== KEY) return send(401, { error: 'A valid company integration key is required in X-Integration-Key' });
  if (mc.mode === 'down') return send(503, { error: 'Service unavailable' });
  if (mc.mode === 'reject') return send(400, { error: 'failureCategory must be one of: mechanical, hydraulic' });
  const existing = mc.tickets.get(body.externalId);
  if (existing) return send(200, { created: false, ticket: existing });
  const ticket = { id: `mc-${mc.tickets.size + 1}`, status: 'open' }; mc.tickets.set(body.externalId, ticket); send(201, { created: true, ticket });
});
await new Promise(r => stand.listen(0, '127.0.0.1', r));
const connect = (key = KEY) => { process.env.MONITOR_MOULDCARE_URL = `http://127.0.0.1:${stand.address().port}/`; process.env.MONITOR_MOULDCARE_KEY = key; };
const disconnect = () => { delete process.env.MONITOR_MOULDCARE_URL; delete process.env.MONITOR_MOULDCARE_KEY; };
after(async () => { for (const r of mc.hung) r.destroy(); await new Promise(r => stand.close(r)); await new Promise(r => server.close(r)); db.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
  return { status: r.status, text: await r.clone().text(), data: await r.json() };
}
const login = async email => (await call('/auth/login', { method: 'POST', body: { email, password: DEMO_PASSWORD } })).data.token;
const t = { admin: await login('admin@monitor.test'), engineer: await login('engineer@monitor.test'), viewer: await login('viewer@monitor.test') };
const finding = one('SELECT f.id FROM findings f JOIN machines m ON m.id=f.machine_id ORDER BY f.first_seen LIMIT 1').id;
const newDraft = async (patch = {}) => {
  const d = (await call(`/findings/${finding}/ticket`, { method: 'POST', token: t.engineer, body: {} })).data;
  const row = one('SELECT draft_json FROM ticket_drafts WHERE id=?', d.id); run('UPDATE ticket_drafts SET draft_json=? WHERE id=?', JSON.stringify({ ...JSON.parse(row.draft_json), ...patch }), d.id);
  return d;
};
const approve = (id, body = {}) => call(`/tickets/${id}`, { method: 'PATCH', token: t.engineer, body: { status: 'approved', ...body } });

test('not configured: the approval stands and the draft records not_configured', async () => {
  disconnect();
  const s = await call('/settings', { token: t.admin }); assert.equal(s.data.mouldcare.configured, false); assert.match(s.data.mouldcare.problem, /MONITOR_MOULDCARE_URL/);
  const d = await newDraft(), a = await approve(d.id);
  assert.equal(a.status, 200); assert.equal(a.data.status, 'approved'); assert.equal(a.data.mouldcare.status, 'not_configured'); assert.equal(mc.requests.length, 0);
  process.env.MONITOR_MOULDCARE_URL = 'ftp://mouldcare.example'; process.env.MONITOR_MOULDCARE_KEY = KEY;
  assert.match((await call(`/tickets/${d.id}/mouldcare`, { method: 'POST', token: t.engineer })).data.mouldcare.error, /not an http\(s\) address/);
  // Once it is set up, the background job sends drafts approved in the meantime.
  connect(); const r = await retryPending();
  assert.ok(r.sent >= 1); assert.equal(one('SELECT mouldcare_status s FROM ticket_drafts WHERE id=?', d.id).s, 'sent');
});

test('approving posts the draft to MouldCare with the mapped fields and the assignee', async () => {
  connect(); mc.mode = 'ok'; mc.requests = [];
  const ravi = one("SELECT id,name FROM users WHERE email='engineer@monitor.test'");
  const d = await newDraft({ failureCategory: 'control', machineState: 'running_degraded', priority: 'high', suggestedActions: ['Check the PLC I/O card'], partsToCheck: ['I/O card'] });
  const a = await approve(d.id, { assignee: { kind: 'user', id: ravi.id } });
  assert.equal(a.status, 200); assert.equal(a.data.mouldcare.status, 'sent'); assert.match(a.data.mouldcare.ticketId, /^mc-/); assert.ok(a.data.mouldcare.sentAt); assert.equal(a.data.mouldcare.error, null);
  assert.equal(mc.requests.length, 1); const req = mc.requests[0];
  assert.equal(req.path, '/api/integrations/tickets'); assert.equal(req.key, KEY);
  const tag = one('SELECT m.tag FROM ticket_drafts t JOIN machines m ON m.id=t.machine_id WHERE t.id=?', d.id).tag;
  assert.equal(req.body.source, 'monitor'); assert.equal(req.body.externalId, d.id); assert.equal(req.body.assetTag, tag);
  assert.equal(req.body.failureCategory, 'controls'); assert.equal(req.body.machineState, 'reduced_output'); assert.equal(req.body.priority, 'high'); assert.equal(req.body.safetyIssue, false);
  assert.equal(req.body.assigneeName, ravi.name); assert.deepEqual(req.body.suggestedActions, ['Check the PLC I/O card', 'Parts to check: I/O card']);
  assert.ok(req.body.title && req.body.symptoms && req.body.productionImpact); assert.ok(Date.parse(req.body.occurredAt) <= Date.now());
  // Sending again does not post twice once it is sent.
  assert.equal((await call(`/tickets/${d.id}/mouldcare`, { method: 'POST', token: t.engineer })).data.mouldcare.ticketId, a.data.mouldcare.ticketId); assert.equal(mc.requests.length, 1);
  assert.equal((await call(`/tickets/${d.id}/mouldcare`, { method: 'POST', token: t.viewer })).status, 403);
  const draft = await newDraft(); assert.match((await call(`/tickets/${draft.id}/mouldcare`, { method: 'POST', token: t.engineer })).data.error, /Only an approved ticket/);
});

test('a failed send is recorded, the approval stands, and a retry succeeds', async () => {
  connect(); mc.mode = 'down';
  const d = await newDraft(), a = await approve(d.id);
  assert.equal(a.status, 200); assert.equal(a.data.status, 'approved'); assert.equal(a.data.mouldcare.status, 'failed'); assert.match(a.data.mouldcare.error, /503: Service unavailable/); assert.equal(a.data.mouldcare.attempts, 1);
  // A rejected ticket shows MouldCare's reason; a wrong key says which setting to check.
  mc.mode = 'reject'; assert.match((await call(`/tickets/${d.id}/mouldcare`, { method: 'POST', token: t.engineer })).data.mouldcare.error, /400: failureCategory must be one of/);
  connect('mck_wrong-key-000000000000000000'); mc.mode = 'ok';
  assert.match((await call(`/tickets/${d.id}/mouldcare`, { method: 'POST', token: t.engineer })).data.mouldcare.error, /refused the integration key\. Check MONITOR_MOULDCARE_KEY/);
  // MouldCare not running at all.
  process.env.MONITOR_MOULDCARE_URL = 'http://127.0.0.1:1'; assert.match((await sendDraft(d.id)).error, /Could not reach MouldCare/);
  // The fetch has a timeout.
  connect(); mc.mode = 'hang'; const started = Date.now(), slow = await sendDraft(d.id, { timeoutMs: 300 });
  assert.equal(slow.status, 'failed'); assert.match(slow.error, /did not answer within/); assert.ok(Date.now() - started < 3000);
  const s = await call('/settings', { token: t.admin }); assert.ok(s.data.mouldcare.failed >= 1); assert.match(s.data.mouldcare.lastError, /did not answer/);
  // The background job retries it; Retry on the card does the same.
  mc.mode = 'ok'; const r = await retryPending({ timeoutMs: 2000 }); assert.ok(r.sent >= 1);
  const after = (await call('/tickets', { token: t.engineer })).data.find(x => x.id === d.id);
  assert.equal(after.mouldcare.status, 'sent'); assert.match(after.mouldcare.ticketId, /^mc-/); assert.equal(after.mouldcare.error, null);
  // A draft that keeps failing stops being retried automatically after the limit.
  mc.mode = 'down'; const stuck = await newDraft(); await approve(stuck.id); run('UPDATE ticket_drafts SET mouldcare_attempts=10 WHERE id=?', stuck.id);
  assert.equal((await call('/tickets', { token: t.engineer })).data.find(x => x.id === stuck.id).mouldcare.autoRetry, false);
  const sends = () => mc.requests.filter(x => x.body.externalId === stuck.id).length, before = sends(); await retryPending(); assert.equal(sends(), before);
  mc.mode = 'ok'; assert.equal((await call(`/tickets/${stuck.id}/mouldcare`, { method: 'POST', token: t.engineer })).data.mouldcare.status, 'sent');
});

test('the key is never exposed', async () => {
  connect(); mc.mode = 'down'; const d = await newDraft(); await approve(d.id);
  const s = await call('/settings', { token: t.admin });
  assert.equal(s.data.mouldcare.configured, true); assert.equal(s.data.mouldcare.keySet, true); assert.ok(s.data.mouldcare.url.startsWith('http://127.0.0.1'));
  for (const r of [s, await call('/tickets', { token: t.admin }), await call('/config'), await call(`/tickets/${d.id}/mouldcare`, { method: 'POST', token: t.engineer })]) assert.ok(!r.text.includes(KEY), 'key in an API reply');
  const stored = ['ticket_drafts', 'audit', 'settings'].flatMap(tb => all(`SELECT * FROM ${tb}`)).map(x => JSON.stringify(x)).join('\n');
  assert.ok(!stored.includes(KEY), 'key stored in the database'); assert.ok(!stored.includes('mck_wrong-key'), 'a wrong key stored in the database');
  mc.mode = 'ok';
});
