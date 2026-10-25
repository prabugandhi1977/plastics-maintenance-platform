import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Custom dashboards: building, validating against real machines and signals, sharing by audience and role, the default
// landing dashboard, duplicates, templates, what happens to widgets when a machine or signal is deleted, and the data
// the widgets read being behind the same sign-in and roles as the rest of the API.
const dir = mkdtempSync(join(tmpdir(), 'monitor-dashboards-'));
process.env.MONITOR_DATA_DIR = dir;
delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
const { seedDemo, DEMO_PASSWORD, addMachine, addUser } = await import('../server/seed.js');
const { simulate } = await import('../server/simulator.js');
const { analyzeAll } = await import('../server/ml/analyze.js');
const { createServer } = await import('../server/index.js');
const { db, one, all } = await import('../server/db.js');
seedDemo(); simulate(); analyzeAll();
const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(async () => { await new Promise(r => server.close(r)); db.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
const login = async (email, password = DEMO_PASSWORD) => (await call('/auth/login', { method: 'POST', body: { email, password } })).data.token;
const t = { admin: await login('admin@monitor.test'), engineer: await login('engineer@monitor.test'), tech: await login('tech@monitor.test'), viewer: await login('viewer@monitor.test') };
const machine = tag => one('SELECT id FROM machines WHERE tag=?', tag).id;
const imm = machine('IMM-01'), ch = machine('CH-01');
const sig = mid => all('SELECT key FROM signals WHERE machine_id=? ORDER BY rowid', mid).map(s => s.key);
const create = async (token, body = {}) => (await call('/dashboards', { method: 'POST', token, body: { name: 'Mine', ...body } }));
const listOf = async token => (await call('/dashboards', { token })).data.dashboards;
const widget = (type, settings, extra = {}) => ({ type, settings, ...extra });

test('a dashboard is created, read, updated and deleted by its owner', async () => {
  assert.equal((await call('/dashboards')).status, 401);
  const w = [widget('signal_chart', { machineId: imm, signal: sig(imm)[0], hours: 168 }, { title: 'Oil temperature', size: { w: 3, h: 2 } }), widget('note', { text: 'Shift handover at 14:00' }), widget('kpi', { metric: 'open_findings' })];
  const c = await create(t.viewer, { name: '  Hall A  ', description: 'My view', widgets: w });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal(c.data.name, 'Hall A'); assert.equal(c.data.share, 'private'); assert.equal(c.data.mine, true); assert.equal(c.data.canEdit, true); assert.deepEqual(c.data.layout, { columns: 4 });
  assert.deepEqual(c.data.widgets.map(x => [x.type, x.title, x.size.w, x.size.h]), [['signal_chart', 'Oil temperature', 3, 2], ['note', 'Note', 2, 1], ['kpi', 'Open findings', 1, 1]]);
  assert.equal(c.data.widgets[0].settings.showLimits, true); assert.ok(c.data.widgets.every(x => x.id && x.problems.length === 0));
  const id = c.data.id;
  assert.equal((await call(`/dashboards/${id}`, { token: t.viewer })).data.widgets.length, 3);
  const u = await call(`/dashboards/${id}`, { method: 'PUT', token: t.viewer, body: { name: 'Hall A bays', widgets: c.data.widgets.slice(0, 2) } });
  assert.equal(u.status, 200); assert.equal(u.data.name, 'Hall A bays'); assert.equal(u.data.widgets.length, 2); assert.equal(u.data.description, 'My view');
  assert.equal(u.data.widgets[0].id, c.data.widgets[0].id, 'widget ids are kept across saves');
  assert.equal((await call(`/dashboards/${id}`, { method: 'PUT', token: t.viewer, body: { name: '  ' } })).status, 400);
  assert.equal((await call(`/dashboards/${id}`, { method: 'DELETE', token: t.viewer })).data.deleted, 'Hall A bays');
  assert.equal((await call(`/dashboards/${id}`, { token: t.viewer })).status, 404);
  assert.equal((await call('/dashboards', { method: 'POST', token: t.viewer, body: {} })).status, 400, 'a name is required');
});

test('widgets are validated against the machines and signals that exist', async () => {
  const bad = async (w, re) => { const r = await create(t.engineer, { widgets: [w] }); assert.equal(r.status, 400, JSON.stringify(w)); assert.match(r.data.error, re); };
  const key = sig(imm)[0];
  await bad(widget('signal_chart', { machineId: 'nope', signal: key }), /Unknown machine/);
  await bad(widget('signal_chart', { machineId: imm, signal: 'no_such_signal' }), /Unknown signal/);
  await bad(widget('signal_chart', { machineId: ch, signal: key }), /Unknown signal/); // a real signal, but not on that machine
  await bad(widget('signal_chart', { machineId: imm, signal: key, hours: 12 }), /hours must be 24 or 168/);
  await bad(widget('sparklines', { items: [] }), /1 to 12 signals/);
  await bad(widget('sparklines', { items: [{ machineId: imm, signal: 'x' }] }), /Unknown signal/);
  await bad(widget('machine_health', { machineIds: [imm, 'ghost'] }), /Unknown machine/);
  await bad(widget('findings', { machineId: 'ghost' }), /Unknown machine/);
  await bad(widget('findings', { severity: 'fatal' }), /severity must be one of/);
  await bad(widget('tickets', { assignee: 'user:ghost' }), /Unknown assignee/);
  await bad(widget('kpi', { metric: 'profit' }), /metric must be one of/);
  await bad(widget('note', { text: '   ' }), /text is required/);
  await bad(widget('chart3d', {}), /Widget type must be one of/);
  await bad(widget('kpi', { metric: 'open_findings' }, { size: { w: 5, h: 1 } }), /Width must be a whole number from 1 to 4/);
  await bad(widget('kpi', { metric: 'open_findings' }, { size: { w: 1, h: 4 } }), /Height must be a whole number from 1 to 3/);
  await bad(widget('kpi', { metric: 'open_findings' }, { size: { w: 1.5, h: 1 } }), /Width/);
  await bad(widget('kpi', { metric: 'open_findings' }, { title: 'x'.repeat(81) }), /too long/);
  // Errors name the widget so the editor can show which one.
  const named = await create(t.engineer, { widgets: [widget('findings', { severity: 'fatal' }, { title: 'Alarms' })] }); assert.match(named.data.error, /^Widget “Alarms”/);
  const tooMany = await create(t.engineer, { widgets: Array.from({ length: 25 }, () => widget('note', { text: 'x' })) }); assert.match(tooMany.data.error, /at most 24 widgets/);
  // Good settings are kept, unknown keys are dropped, a duplicate widget id is replaced.
  const ok = await create(t.engineer, { widgets: [widget('tickets', { status: 'draft', assignee: 'me', limit: 3, extra: 'x' }, { id: 'a1' }), widget('machine_grid', { machineIds: [imm, ch] }, { id: 'a1' }), widget('sparklines', { items: [{ machineId: imm, signal: sig(imm)[0] }, { machineId: imm, signal: sig(imm)[0] }, { machineId: ch, signal: sig(ch)[0] }] })] });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.widgets[0].settings, { status: 'draft', assignee: 'me', limit: 3 });
  assert.notEqual(ok.data.widgets[1].id, 'a1'); assert.equal(ok.data.widgets[2].settings.items.length, 2, 'a repeated signal is listed once');
  const person = (await call('/dashboards/catalog', { token: t.viewer })).data.people.find(p => p.kind === 'user');
  assert.equal((await create(t.viewer, { widgets: [widget('tickets', { assignee: person.id })] })).status, 201);
  // Machine and signal validation also applies on update.
  assert.equal((await call(`/dashboards/${ok.data.id}`, { method: 'PUT', token: t.engineer, body: { widgets: [widget('findings', { machineId: 'ghost' })] } })).status, 400);
});

test('dashboards are personal until shared, and shared ones reach only their audience', async () => {
  const mine = (await create(t.engineer, { name: 'Ravi private' })).data.id;
  const toAll = (await create(t.engineer, { name: 'Ravi for all' })).data.id, toViewers = (await create(t.engineer, { name: 'Ravi for viewers' })).data.id, toEngineers = (await create(t.engineer, { name: 'Ravi for engineers' })).data.id;
  const share = (did, body, token = t.engineer) => call(`/dashboards/${did}`, { method: 'PUT', token, body });
  assert.equal((await share(toAll, { share: 'all' })).data.share, 'all');
  const sv = await share(toViewers, { share: 'role', shareRole: 'viewer' }); assert.equal(sv.data.share, 'role'); assert.equal(sv.data.shareRole, 'viewer');
  await share(toEngineers, { share: 'role', shareRole: 'engineer' });
  assert.match((await share(toViewers, { share: 'role' })).data.error, /shareRole must be one of/);
  assert.match((await share(toViewers, { share: 'role', shareRole: 'admin' })).data.error, /shareRole must be one of/);
  assert.match((await share(toViewers, { share: 'everyone' })).data.error, /share must be one of/);
  const names = async token => (await listOf(token)).map(d => d.name).filter(n => n.startsWith('Ravi'));
  assert.deepEqual(await names(t.engineer), ['Ravi for all', 'Ravi for engineers', 'Ravi for viewers', 'Ravi private']);
  assert.deepEqual(await names(t.viewer), ['Ravi for all', 'Ravi for viewers']);
  assert.deepEqual(await names(t.tech), ['Ravi for all', 'Ravi for engineers']);
  assert.deepEqual(await names(t.admin), ['Ravi for all', 'Ravi for engineers', 'Ravi for viewers'], 'the super user sees what is shared, not what is private');
  // A dashboard outside the audience does not exist for the person (404, not 403).
  assert.equal((await call(`/dashboards/${mine}`, { token: t.viewer })).status, 404); assert.equal((await call(`/dashboards/${mine}`, { token: t.admin })).status, 404);
  assert.equal((await call(`/dashboards/${toEngineers}`, { token: t.viewer })).status, 404); assert.equal((await call(`/dashboards/${toViewers}`, { token: t.tech })).status, 404);
  assert.equal((await call(`/dashboards/${toViewers}/duplicate`, { method: 'POST', token: t.tech, body: {} })).status, 404);
  // A viewer reads a shared one but cannot change, share or delete it; other engineers cannot either.
  const read = (await call(`/dashboards/${toAll}`, { token: t.viewer })).data; assert.equal(read.canEdit, false); assert.equal(read.mine, false); assert.equal(read.ownerName, 'Ravi Engineer');
  for (const token of [t.viewer, t.tech]) {
    assert.equal((await share(toAll, { name: 'Hacked' }, token)).status, 403);
    assert.equal((await share(toAll, { share: 'private' }, token)).status, 403);
    assert.equal((await call(`/dashboards/${toAll}`, { method: 'DELETE', token })).status, 403);
  }
  assert.equal((await call(`/dashboards/${toAll}`, { token: t.engineer })).data.name, 'Ravi for all');
  // The super user can change or delete any dashboard they can see.
  assert.equal((await share(toViewers, { name: 'Ravi for viewers (checked)' }, t.admin)).status, 200);
  assert.equal((await call(`/dashboards/${toEngineers}`, { method: 'DELETE', token: t.admin })).status, 200);
  // Sharing back to private removes it from the audience at once.
  await share(toAll, { share: 'private' }); assert.deepEqual(await names(t.viewer), ['Ravi for viewers (checked)']);
});

test('the landing dashboard: own default, then the default for everyone, then the Overview', async () => {
  const landing = async token => (await call('/dashboards/default', { token })).data;
  assert.equal((await landing(t.viewer)).dashboard, null, 'with nothing set a user sees the Overview');
  const team = (await create(t.engineer, { name: 'Team board' })).data.id, secret = (await create(t.engineer, { name: 'Secret board' })).data.id;
  const put = (token, body) => call('/dashboards/default', { method: 'PUT', token, body });
  // Only the super user sets the default for everyone, and only from dashboards they can see.
  assert.equal((await put(t.engineer, { scope: 'everyone', dashboardId: team })).status, 403);
  assert.equal((await put(t.admin, { scope: 'everyone', dashboardId: secret })).status, 404);
  assert.equal((await put(t.admin, { scope: 'bogus', dashboardId: team })).status, 400);
  await call(`/dashboards/${team}`, { method: 'PUT', token: t.engineer, body: { share: 'role', shareRole: 'engineer' } }); // the super user sees what is shared
  const set = await put(t.admin, { scope: 'everyone', dashboardId: team }); assert.equal(set.data.dashboardId, team); assert.equal(set.data.source, 'everyone');
  assert.equal((await call(`/dashboards/${team}`, { token: t.viewer })).data.share, 'all', 'making it the default shares it with all users');
  for (const token of [t.viewer, t.tech, t.engineer, t.admin]) { const l = await landing(token); assert.equal(l.dashboard.id, team); assert.equal(l.source, 'everyone'); }
  assert.equal((await listOf(t.viewer)).find(d => d.id === team).isEveryoneDefault, true);
  // A person's own default wins; "overview" brings the built-in page back even though a default is set for everyone.
  const own = (await create(t.viewer, { name: 'My landing' })).data.id;
  assert.equal((await put(t.viewer, { scope: 'me', dashboardId: secret })).status, 404, 'cannot pick a dashboard they cannot see');
  assert.equal((await put(t.viewer, { scope: 'me', dashboardId: own })).data.source, 'user');
  assert.equal((await landing(t.viewer)).dashboard.id, own); assert.equal((await landing(t.tech)).dashboard.id, team);
  const ov = await put(t.viewer, { scope: 'me', dashboardId: 'overview' }); assert.equal(ov.data.dashboardId, null); assert.equal(ov.data.source, 'user'); assert.equal((await landing(t.viewer)).dashboard, null);
  await put(t.viewer, { scope: 'me', dashboardId: null }); assert.equal((await landing(t.viewer)).dashboard.id, team, 'clearing the choice falls back to the default for everyone');
  // Un-sharing or deleting the default for everyone clears it; a personal default that is no longer visible is ignored.
  await put(t.tech, { scope: 'me', dashboardId: team });
  await call(`/dashboards/${team}`, { method: 'PUT', token: t.engineer, body: { share: 'role', shareRole: 'viewer' } });
  assert.equal((await landing(t.viewer)).dashboard, null); assert.equal((await landing(t.tech)).dashboard, null);
  await put(t.admin, { scope: 'everyone', dashboardId: team }); assert.equal((await landing(t.tech)).dashboard.id, team);
  await call(`/dashboards/${team}`, { method: 'DELETE', token: t.engineer });
  assert.equal((await landing(t.tech)).dashboard, null); assert.equal((await landing(t.viewer)).dashboard, null, 'a deleted default leaves no landing page behind');
  assert.equal((await put(t.admin, { scope: 'everyone', dashboardId: null })).data.dashboardId, null);
});

test('duplicating makes a private copy owned by the person who copied it', async () => {
  const src = (await create(t.engineer, { name: 'Shared board', description: 'For all', widgets: [widget('note', { text: 'hello' }, { title: 'Hi' }), widget('kpi', { metric: 'tickets_awaiting_approval' })] })).data.id;
  await call(`/dashboards/${src}`, { method: 'PUT', token: t.engineer, body: { share: 'all' } });
  const copy = await call(`/dashboards/${src}/duplicate`, { method: 'POST', token: t.viewer, body: {} });
  assert.equal(copy.status, 201); assert.equal(copy.data.name, 'Copy of Shared board'); assert.equal(copy.data.share, 'private'); assert.equal(copy.data.mine, true); assert.equal(copy.data.canEdit, true); assert.equal(copy.data.description, 'For all');
  const orig = (await call(`/dashboards/${src}`, { token: t.engineer })).data;
  assert.deepEqual(copy.data.widgets.map(w => [w.type, w.title, w.size, w.settings]), orig.widgets.map(w => [w.type, w.title, w.size, w.settings]));
  assert.ok(copy.data.widgets.every((w, i) => w.id !== orig.widgets[i].id), 'the copy has its own widget ids');
  assert.equal((await call(`/dashboards/${copy.data.id}`, { method: 'PUT', token: t.viewer, body: { widgets: [] } })).data.widgets.length, 0);
  assert.equal((await call(`/dashboards/${src}`, { token: t.engineer })).data.widgets.length, 2, 'editing the copy leaves the original alone');
  assert.equal((await call(`/dashboards/${copy.data.id}`, { token: t.engineer })).status, 404, 'the copy is private to the copier');
  assert.equal((await call(`/dashboards/${src}/duplicate`, { method: 'POST', token: t.viewer, body: { name: 'Meera copy' } })).data.name, 'Meera copy');
});

test('templates build ready-made dashboards from the machines that exist', async () => {
  const cat = (await call('/dashboards/catalog', { token: t.viewer })).data;
  assert.deepEqual(cat.templates.map(x => x.key), ['plant-overview', 'machine-deep-dive', 'maintenance-desk']); assert.deepEqual(cat.templates.map(x => x.needsMachine), [false, true, false]);
  assert.equal((await call('/dashboards', { method: 'POST', token: t.viewer, body: { template: 'nope' } })).status, 400);
  const plant = (await call('/dashboards', { method: 'POST', token: t.viewer, body: { template: 'plant-overview' } })).data;
  assert.equal(plant.name, 'Plant overview'); assert.equal(plant.share, 'private'); assert.equal(plant.widgets.filter(w => w.type === 'kpi').length, 4); assert.ok(plant.widgets.some(w => w.type === 'machine_grid'));
  const desk = (await call('/dashboards', { method: 'POST', token: t.viewer, body: { template: 'maintenance-desk', name: 'Desk' } })).data;
  assert.equal(desk.name, 'Desk'); assert.ok(desk.widgets.filter(w => w.type === 'tickets').length >= 3); assert.ok(desk.widgets.some(w => w.settings.assignee === 'me'));
  const dive = (await call('/dashboards', { method: 'POST', token: t.viewer, body: { template: 'machine-deep-dive', machineId: ch } })).data;
  assert.equal(dive.name, 'Machine deep-dive'); assert.ok(dive.widgets.every(w => w.problems.length === 0));
  const spark = dive.widgets.find(w => w.type === 'sparklines'); assert.ok(spark.settings.items.every(i => i.machineId === ch));
  assert.equal(dive.widgets.filter(w => w.type === 'signal_chart').length, 2); assert.equal(dive.widgets.find(w => w.type === 'findings').settings.machineId, ch);
  assert.equal((await call('/dashboards', { method: 'POST', token: t.viewer, body: { template: 'machine-deep-dive', machineId: 'ghost' } })).status, 400);
  assert.ok((await call('/dashboards', { method: 'POST', token: t.viewer, body: { template: 'machine-deep-dive' } })).data.widgets.length, 'defaults to the first machine');
});

test('deleting a machine or signal flags the widgets that used it instead of removing them', async () => {
  const mid = addMachine({ tag: 'TMP-01', name: 'Temporary', type: 'chiller', make: '', model: '', line: '', device_id: 'plc-tmp-01' }), [k1, k2] = sig(mid);
  const d = (await create(t.engineer, { name: 'Temp board', widgets: [
    widget('signal_chart', { machineId: mid, signal: k1 }, { title: 'Chart' }), widget('sparklines', { items: [{ machineId: mid, signal: k1 }, { machineId: mid, signal: k2 }] }, { title: 'Spark' }),
    widget('machine_health', { machineIds: [mid, imm] }, { title: 'Health' }), widget('findings', { machineId: mid }, { title: 'Findings' }), widget('note', { text: 'unrelated' }, { title: 'Note' })] })).data;
  assert.ok(d.widgets.every(w => w.problems.length === 0));
  assert.equal((await call(`/machines/${mid}/signals/${k1}`, { method: 'DELETE', token: t.admin })).status, 200);
  let now = (await call(`/dashboards/${d.id}`, { token: t.engineer })).data;
  assert.equal(now.widgets.length, 5, 'no widget is removed');
  assert.deepEqual(now.widgets.map(w => w.problems.length), [1, 1, 0, 0, 0]); assert.match(now.widgets[0].problems[0], /signal .* was deleted/);
  // The owner cannot save it back as it is: the broken widget is named. Fixing it (here, removing it) saves.
  const stale = await call(`/dashboards/${d.id}`, { method: 'PUT', token: t.engineer, body: { widgets: now.widgets } });
  assert.equal(stale.status, 400); assert.match(stale.data.error, /^Widget “Chart”: Unknown signal/);
  assert.equal((await call(`/dashboards/${d.id}`, { method: 'PUT', token: t.engineer, body: { name: 'Temp board 2' } })).status, 200, 'changes that leave the widgets alone still save');
  assert.equal((await call(`/machines/${mid}`, { method: 'DELETE', token: t.admin })).status, 400, 'deleting needs the tag');
  assert.equal((await call(`/machines/${mid}?confirm=TMP-01`, { method: 'DELETE', token: t.admin })).status, 200);
  now = (await call(`/dashboards/${d.id}`, { token: t.engineer })).data;
  assert.deepEqual(now.widgets.map(w => w.problems.length), [1, 1, 1, 1, 0]); assert.match(now.widgets[3].problems[0], /machine .* was deleted/);
  assert.equal((await call(`/dashboards/${d.id}/duplicate`, { method: 'POST', token: t.engineer, body: {} })).data.widgets.filter(w => w.problems.length).length, 4, 'a copy keeps the flags');
  const fixed = await call(`/dashboards/${d.id}`, { method: 'PUT', token: t.engineer, body: { widgets: [now.widgets[2], now.widgets[4]].map(w => ({ ...w, settings: w.type === 'machine_health' ? { machineIds: [imm] } : w.settings })) } });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.data)); assert.ok(fixed.data.widgets.every(w => !w.problems.length));
  // Deleting a person a ticket widget points at is flagged the same way.
  addUser({ email: 'temp@monitor.test', name: 'Temp Tech', role: 'engineer' }, 'a-long-password-1');
  const uid = one("SELECT id FROM users WHERE email='temp@monitor.test'").id;
  const tk = (await create(t.engineer, { widgets: [widget('tickets', { assignee: `user:${uid}` })] })).data;
  assert.equal((await call(`/users/${uid}`, { method: 'DELETE', token: t.admin })).status, 200);
  assert.deepEqual((await call(`/dashboards/${tk.id}`, { token: t.engineer })).data.widgets[0].problems, ['The assignee was deleted']);
});

test('a dashboard goes when its owner is deleted, and the number of dashboards per person is capped', async () => {
  addUser({ email: 'gone@monitor.test', name: 'Gone', role: 'viewer' }, 'a-long-password-1');
  const gone = await login('gone@monitor.test', 'a-long-password-1');
  const g = (await create(gone, { name: 'Gone board' })).data.id; await call('/dashboards/default', { method: 'PUT', token: gone, body: { scope: 'me', dashboardId: g } });
  assert.equal((await call(`/users/${one("SELECT id FROM users WHERE email='gone@monitor.test'").id}`, { method: 'DELETE', token: t.admin })).status, 200);
  assert.equal(one('SELECT COUNT(*) n FROM dashboards WHERE id=?', g).n, 0); assert.equal(one('SELECT COUNT(*) n FROM dashboard_prefs').n >= 0, true);
  addUser({ email: 'busy@monitor.test', name: 'Busy', role: 'viewer' }, 'a-long-password-1'); const busy = await login('busy@monitor.test', 'a-long-password-1');
  for (let i = 0; i < 50; i++) assert.equal((await create(busy, { name: `D${i}` })).status, 201);
  assert.match((await create(busy, { name: 'One too many' })).data.error, /at most 50/);
});

test('the data widgets read is behind the same sign-in and roles as the rest of the API', async () => {
  const sigKey = sig(imm)[0];
  for (const path of ['/overview', '/findings', '/tickets', `/machines/${imm}/series?signal=${sigKey}&hours=24`, '/dashboards/kpis', '/dashboards/catalog', '/dashboards/default']) assert.equal((await call(path)).status, 401, path);
  // The same data for every signed-in role, and nothing that changes data is opened up by a dashboard.
  for (const token of [t.viewer, t.engineer, t.admin]) {
    assert.equal((await call('/overview', { token })).status, 200); assert.equal((await call('/findings', { token })).status, 200); assert.equal((await call('/tickets', { token })).status, 200);
    assert.equal((await call(`/machines/${imm}/series?signal=${sigKey}&hours=168`, { token })).status, 200);
  }
  assert.equal((await call(`/machines/${imm}/series?signal=nope`, { token: t.viewer })).status, 404);
  const finding = one("SELECT id FROM findings WHERE status='open' LIMIT 1").id;
  assert.equal((await call(`/findings/${finding}`, { method: 'PATCH', token: t.viewer, body: { status: 'acknowledged' } })).status, 403);
  assert.equal((await call(`/findings/${finding}/ticket`, { method: 'POST', token: t.viewer, body: {} })).status, 403);
  // KPI counts match the data behind them.
  const k = (await call('/dashboards/kpis', { token: t.viewer })).data, o = (await call('/overview', { token: t.viewer })).data;
  assert.equal(k.open_findings, o.counts.critical + o.counts.warning); assert.equal(k.machines_watch_risk, o.counts.watch + o.counts.atRisk);
  assert.equal(k.tickets_awaiting_approval, 0); assert.equal(k.tickets_sent_mouldcare, 0);
  await call(`/findings/${finding}/ticket`, { method: 'POST', token: t.engineer, body: {} });
  assert.equal((await call('/dashboards/kpis', { token: t.viewer })).data.tickets_awaiting_approval, 1);
  // Viewing a dashboard grants nothing: widgets carry settings only, never data.
  const shared = (await create(t.engineer, { widgets: [widget('findings', {})] })).data.id; await call(`/dashboards/${shared}`, { method: 'PUT', token: t.engineer, body: { share: 'all' } });
  assert.deepEqual(Object.keys((await call(`/dashboards/${shared}`, { token: t.viewer })).data.widgets[0]).sort(), ['id', 'problems', 'settings', 'size', 'title', 'type']);
});
