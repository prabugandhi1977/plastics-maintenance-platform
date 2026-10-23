import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Users and service providers managed by the super user, and ticket allocation: suggested when drafted, assigned
// automatically by the rules or by Claude, set during approval and changed afterwards.
const dir = mkdtempSync(join(tmpdir(), 'monitor-people-'));
process.env.MONITOR_DATA_DIR = dir;
delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
const { seedDemo, DEMO_PASSWORD } = await import('../server/seed.js');
const { simulate } = await import('../server/simulator.js');
const { analyzeAll } = await import('../server/ml/analyze.js');
const ai = await import('../server/ai/claude.js');
const { createServer } = await import('../server/index.js');
const { db, one, run } = await import('../server/db.js');
seedDemo(); simulate(); analyzeAll();
const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(async () => { await new Promise(r => server.close(r)); db.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
const login = async (email, password = DEMO_PASSWORD) => (await call('/auth/login', { method: 'POST', body: { email, password } }));
const t = { admin: (await login('admin@monitor.test')).data.token, engineer: (await login('engineer@monitor.test')).data.token, viewer: (await login('viewer@monitor.test')).data.token };
const id = (sql, ...a) => one(sql, ...a).id;
const findingOf = (tag, kind) => id('SELECT f.id FROM findings f JOIN machines m ON m.id=f.machine_id WHERE m.tag=? AND f.kind=?', tag, kind);
const draft = async (tag, kind) => (await call(`/findings/${findingOf(tag, kind)}/ticket`, { method: 'POST', token: t.engineer, body: {} })).data;
const ravi = id("SELECT id FROM users WHERE email='engineer@monitor.test'"), coolServ = id("SELECT id FROM service_providers WHERE name='CoolServ Refrigeration'");

test('the super user adds, edits, deactivates and deletes users', async () => {
  const body = { name: 'Leela Fitter', email: 'Leela@plant.example', role: 'engineer', password: 'a-long-password-1', phone: '+91 98450 22003', jobTitle: 'Fitter', skills: { machineTypes: ['blow'], disciplines: ['mechanical', 'pneumatic'] } };
  assert.equal((await call('/users', { method: 'POST', token: t.engineer, body })).status, 403);
  assert.match((await call('/users', { method: 'POST', token: t.admin, body: { ...body, password: 'short' } })).data.error, /12 to 200/);
  assert.match((await call('/users', { method: 'POST', token: t.admin, body: { ...body, skills: { disciplines: ['juggling'] } } })).data.error, /disciplines must be one of/);
  assert.match((await call('/users', { method: 'POST', token: t.admin, body: { ...body, role: 'owner' } })).data.error, /role must be one of/);
  const created = await call('/users', { method: 'POST', token: t.admin, body });
  assert.equal(created.status, 201, JSON.stringify(created.data)); assert.equal(created.data.email, 'leela@plant.example'); assert.deepEqual(created.data.skills.disciplines, ['mechanical', 'pneumatic']);
  assert.equal((await call('/users', { method: 'POST', token: t.admin, body })).status, 409);
  const leela = (await login('leela@plant.example', 'a-long-password-1')).data.token; assert.ok(leela);
  // A new password signs the user out everywhere; deactivating blocks sign-in.
  await call(`/users/${created.data.id}/password`, { method: 'POST', token: t.admin, body: { password: 'another-long-password' } });
  assert.equal((await call('/me', { token: leela })).status, 401);
  const relogin = (await login('leela@plant.example', 'another-long-password')).data.token;
  assert.equal((await call(`/users/${created.data.id}`, { method: 'PATCH', token: t.admin, body: { active: false } })).data.active, false);
  assert.equal((await call('/me', { token: relogin })).status, 401);
  assert.equal((await login('leela@plant.example', 'another-long-password')).status, 403);
  // Never lock the plant out of its own settings.
  const me = id("SELECT id FROM users WHERE email='admin@monitor.test'");
  assert.match((await call(`/users/${me}`, { method: 'PATCH', token: t.admin, body: { role: 'engineer' } })).data.error, /your own/);
  assert.match((await call(`/users/${me}`, { method: 'DELETE', token: t.admin })).data.error, /your own/);
  // No history: deleted. History: kept, deactivate instead.
  assert.equal((await call(`/users/${created.data.id}`, { method: 'DELETE', token: t.admin })).data.deleted, 'leela@plant.example');
  run("UPDATE findings SET decided_by=? WHERE id=(SELECT id FROM findings LIMIT 1)", ravi);
  assert.match((await call(`/users/${ravi}`, { method: 'DELETE', token: t.admin })).data.error, /Deactivate it instead/);
  const list = (await call('/users', { token: t.admin })).data; assert.ok(list.some(u => u.email === 'tech@monitor.test' && u.skills.disciplines.includes('electrical')));
  assert.equal((await call('/users', { token: t.engineer })).status, 403);
});

test('the super user manages service providers', async () => {
  const body = { name: 'Volt Electricals', contactName: 'Imran', email: 'jobs@volt.example', phone: '+91 80 4100 9999', responseHours: 8, skills: { machineTypes: ['extrusion'], disciplines: ['electrical'] } };
  assert.equal((await call('/providers', { method: 'POST', token: t.engineer, body })).status, 403);
  assert.match((await call('/providers', { method: 'POST', token: t.admin, body: { ...body, responseHours: 0 } })).data.error, /responseHours/);
  const p = await call('/providers', { method: 'POST', token: t.admin, body }); assert.equal(p.status, 201); assert.equal(p.data.responseHours, 8);
  assert.equal((await call('/providers', { method: 'POST', token: t.admin, body: { ...body, name: 'volt electricals' } })).status, 409);
  assert.equal((await call(`/providers/${p.data.id}`, { method: 'PATCH', token: t.admin, body: { active: false } })).data.active, false);
  assert.equal((await call(`/providers/${p.data.id}`, { method: 'DELETE', token: t.admin })).data.deleted, 'Volt Electricals');
  assert.equal((await call('/providers', { token: t.admin })).data.length, 2);
});

test('drafting ranks candidates by skills and keeps the best as a suggestion', async () => {
  const d = await draft('IMM-02', 'degrading');
  assert.equal(d.assignee, null, 'suggest mode does not assign');
  assert.equal(d.suggestion.name, 'Ravi Engineer'); assert.match(d.suggestion.reason, /hydraulic skills/); assert.equal(d.suggestion.source, 'rules');
  const c = (await call(`/tickets/${d.id}/candidates`, { token: t.engineer })).data.candidates;
  assert.equal(c[0].id, ravi); assert.ok(c.some(x => x.kind === 'provider' && x.name === 'HydroFix Hydraulics'));
  assert.equal((await call(`/tickets/${d.id}/candidates`, { token: t.viewer })).status, 403);
  // A chiller fault goes to the refrigeration provider, not the hydraulics engineer.
  const chill = await draft('CH-01', 'limit');
  assert.equal(chill.suggestion.kind, 'provider'); assert.equal(chill.suggestion.id, coolServ);
});

test('automatic allocation by the rules, approval with an assignee, reassignment and my tasks', async () => {
  assert.equal((await call('/allocation', { method: 'PUT', token: t.engineer, body: { mode: 'auto_rules' } })).status, 403);
  assert.equal((await call('/allocation', { method: 'PUT', token: t.admin, body: { mode: 'auto_rules' } })).data.mode, 'auto_rules');
  const d = await draft('BM-01', 'unusual');
  assert.equal(d.assignee.id, ravi); assert.equal(d.assignmentSource, 'rules'); assert.equal(d.source, 'standard', 'the draft keeps its own source');
  // During approval: approve and hand it to the provider in one step.
  const hydro = id("SELECT id FROM service_providers WHERE name='HydroFix Hydraulics'");
  const approved = await call(`/tickets/${d.id}`, { method: 'PATCH', token: t.engineer, body: { status: 'approved', assignee: { kind: 'provider', id: hydro } } });
  assert.equal(approved.data.status, 'approved'); assert.equal(approved.data.assignee.name, 'HydroFix Hydraulics'); assert.equal(approved.data.assignmentSource, 'manual');
  // After approval: reassign; deactivated people cannot be chosen.
  const arjun = id("SELECT id FROM users WHERE email='tech@monitor.test'");
  const re = await call(`/tickets/${d.id}/assign`, { method: 'POST', token: t.engineer, body: { assignee: { kind: 'user', id: arjun }, reason: 'Heater wiring suspected' } });
  assert.equal(re.data.assignee.id, arjun); assert.equal(re.data.assignmentReason, 'Heater wiring suspected');
  await call(`/providers/${hydro}`, { method: 'PATCH', token: t.admin, body: { active: false } });
  assert.match((await call(`/tickets/${d.id}/assign`, { method: 'POST', token: t.engineer, body: { assignee: { kind: 'provider', id: hydro } } })).data.error, /deactivated/);
  assert.equal((await call(`/tickets/${d.id}/assign`, { method: 'POST', token: t.viewer, body: { assignee: null } })).status, 403);
  const arjunToken = (await login('tech@monitor.test')).data.token;
  assert.ok((await call('/tickets?assigned=me', { token: arjunToken })).data.every(x => x.assignee?.id === arjun));
  assert.ok((await call('/tickets?assigned=me', { token: arjunToken })).data.some(x => x.id === d.id));
  assert.ok((await call('/tickets?assigned=none', { token: t.engineer })).data.every(x => !x.assignee));
  assert.ok(one("SELECT 1 FROM audit WHERE action='ticket.assign' AND entity_id=?", d.id));
  await call(`/providers/${hydro}`, { method: 'PATCH', token: t.admin, body: { active: true } });
});

test('AI allocation picks among the ranked candidates, and the rules stand in when it cannot', async () => {
  const requests = [], answers = [];
  const reply = v => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(v) }] });
  const ticket = { title: 'CH-01 chilled water over limit', symptoms: 'Supply 17.4 °C', failureCategory: 'cooling', priority: 'high', machineState: 'running_degraded', suggestedActions: ['Check condenser fan'], partsToCheck: [] };
  // Each draft makes two requests: the ticket text, then the allocation.
  ai.setAiClient({ beta: { messages: { create: async p => { requests.push(p); return answers.shift(); } } } });
  await call('/allocation', { method: 'PUT', token: t.admin, body: { mode: 'auto_ai' } });
  answers.push(reply(ticket), reply({ kind: 'provider', id: coolServ, reason: 'Chilled water over its limit: a refrigeration specialist with a 4-hour response.', alternatives: [{ kind: 'user', id: ravi, reason: 'On site' }] }));
  // The finding's explanation is already cached, so drafting does not ask for it again.
  run("UPDATE findings SET explanation_json=?, explained_at=? WHERE id=?", JSON.stringify({ source: 'ai', summary: 'cached', likelyCauses: [], checkFirst: [], safety: [], urgency: 'this_shift' }), Date.now() + 3600000, findingOf('CH-01', 'limit'));
  const d = await draft('CH-01', 'limit');
  assert.equal(d.assignee?.id, coolServ, JSON.stringify(d)); assert.equal(d.assignmentSource, 'ai'); assert.match(d.assignmentReason, /refrigeration/);
  const req = requests.at(-1);
  assert.equal(req.output_config.format.type, 'json_schema'); assert.match(req.messages[0].content, /CoolServ Refrigeration/); assert.match(req.messages[0].content, /ruleScore/);
  // An answer naming someone who is not a candidate is ignored: the rules' choice is used.
  answers.push(reply(ticket), reply({ kind: 'user', id: 'not-a-candidate', reason: 'made up', alternatives: [] }));
  const d2 = await draft('CH-01', 'limit');
  assert.equal(d2.assignmentSource, 'rules'); assert.equal(d2.assignee.id, coolServ);
  // On demand from the assign dialog.
  answers.push(reply({ kind: 'user', id: ravi, reason: 'Knows this machine', alternatives: [] }));
  const pick = await call(`/tickets/${d2.id}/ai-pick`, { method: 'POST', token: t.engineer, body: {} });
  assert.equal(pick.data.id, ravi); assert.equal(pick.data.reason, 'Knows this machine');
  ai.setAiClient(null);
});
