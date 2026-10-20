import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Adding, editing and deleting machines and signals from the dashboard, with parameters, photos and documents.
const dir = mkdtempSync(join(tmpdir(), 'monitor-setup-'));
process.env.MONITOR_DATA_DIR = dir;
process.env.MONITOR_INGEST_KEY = 'test-ingest-key';
const { seedDemo, DEMO_PASSWORD } = await import('../server/seed.js');
const { createServer } = await import('../server/index.js');
const { db, one } = await import('../server/db.js');
seedDemo();
const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(async () => { await new Promise(r => server.close(r)); db.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(path, { method = 'GET', body, token, raw, headers = {} } = {}) {
  const r = await fetch(base + path, { method, headers: { ...(raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body == null ? undefined : JSON.stringify(body)) });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const login = async email => (await call('/auth/login', { method: 'POST', body: { email, password: DEMO_PASSWORD } })).data.token;
const t = { admin: await login('admin@monitor.test'), engineer: await login('engineer@monitor.test'), viewer: await login('viewer@monitor.test') };
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const machine = { tag: 'imm-07', name: 'Haitian Mars 280', type: 'injection', make: 'Haitian', model: 'MA2800', line: 'Hall C', deviceId: 'plc-imm-07', serialNumber: 'HT-2800-1187', yearBuilt: 2021,
  specs: { clampForceKn: 2800, driveType: 'hybrid', screwDiameterMm: 50, unknownField: 1 }, notes: 'Bought used in 2024' };
let mid;

test('administrators add a machine with its parameters and the standard signals', async () => {
  assert.equal((await call('/machines', { method: 'POST', body: machine, token: t.engineer })).status, 403);
  assert.match((await call('/machines', { method: 'POST', body: { ...machine, specs: { driveType: 'hybrid' } }, token: t.admin })).data.error, /Clamp force is required/);
  assert.match((await call('/machines', { method: 'POST', body: { ...machine, specs: { ...machine.specs, clampForceKn: 5 } }, token: t.admin })).data.error, /Clamp force must be a number from 50/);
  assert.match((await call('/machines', { method: 'POST', body: { ...machine, specs: { ...machine.specs, driveType: 'steam' } }, token: t.admin })).data.error, /Drive must be one of/);
  assert.match((await call('/machines', { method: 'POST', body: { ...machine, tag: 'IMM 07' }, token: t.admin })).data.error, /tag may use/);
  assert.equal((await call('/machines', { method: 'POST', body: { ...machine, tag: 'IMM-01' }, token: t.admin })).status, 409, 'tags are unique');
  assert.equal((await call('/machines', { method: 'POST', body: { ...machine, deviceId: 'plc-imm-01' }, token: t.admin })).status, 409, 'device IDs are unique');
  const r = await call('/machines', { method: 'POST', body: machine, token: t.admin });
  assert.equal(r.status, 201, JSON.stringify(r.data)); mid = r.data.id;
  assert.equal(r.data.tag, 'IMM-07'); assert.equal(r.data.yearBuilt, 2021); assert.deepEqual(r.data.specs, { clampForceKn: 2800, driveType: 'hybrid', screwDiameterMm: 50 });
  assert.deepEqual(r.data.specList.map(p => p.label), ['Clamp force', 'Screw diameter', 'Drive']);
  assert.equal(r.data.signals.length, 6); assert.equal(r.data.signals.find(s => s.key === 'pump_vibration').sensorType, 'accelerometer');
  assert.equal(r.data.signals.find(s => s.key === 'hydraulic_oil_temp').warn_high, 55);
  const bare = await call('/machines', { method: 'POST', body: { tag: 'DRY-09', name: 'Spare dryer', type: 'dryer', deviceId: 'plc-dry-09', specs: { dryerType: 'desiccant' }, standardSignals: false }, token: t.admin });
  assert.equal(bare.data.signals.length, 0);
  const list = (await call('/machines', { token: t.viewer })).data;
  assert.ok(list.some(m => m.tag === 'IMM-07' && m.signalCount === 6)); assert.equal(list.length, 8);
});

test('editing a machine keeps its type and its unique tag and device ID', async () => {
  assert.equal((await call(`/machines/${mid}`, { method: 'PATCH', body: { name: 'x' }, token: t.engineer })).status, 403);
  assert.match((await call(`/machines/${mid}`, { method: 'PATCH', body: { type: 'blow' }, token: t.admin })).data.error, /cannot be changed/);
  assert.equal((await call(`/machines/${mid}`, { method: 'PATCH', body: { deviceId: 'plc-imm-02' }, token: t.admin })).status, 409);
  const r = await call(`/machines/${mid}`, { method: 'PATCH', body: { line: 'Hall C · Bay 4', specs: { clampForceKn: 2800, driveType: 'electric' } }, token: t.admin });
  assert.equal(r.data.line, 'Hall C · Bay 4'); assert.equal(r.data.specs.driveType, 'electric'); assert.equal(r.data.serialNumber, 'HT-2800-1187', 'fields not sent stay');
});

test('signals: add with sensor details and limits, take readings, edit, delete', async () => {
  const sig = { key: 'mould_temp_fixed', label: 'Mould temperature, fixed half', unit: '°C', sensorType: 'thermocouple', sensorMake: 'Omega type J', rangeMin: 0, rangeMax: 200, sourceAddress: 'ns=2;s=IMM07.Mould.T1', warn_high: 70, crit_high: 80 };
  assert.equal((await call(`/machines/${mid}/signals`, { method: 'POST', body: sig, token: t.engineer })).status, 403);
  assert.match((await call(`/machines/${mid}/signals`, { method: 'POST', body: { ...sig, key: 'Mould Temp' }, token: t.admin })).data.error, /key must start/);
  assert.match((await call(`/machines/${mid}/signals`, { method: 'POST', body: { ...sig, crit_high: 60 }, token: t.admin })).data.error, /critical high limit/);
  assert.match((await call(`/machines/${mid}/signals`, { method: 'POST', body: { ...sig, rangeMin: 300 }, token: t.admin })).data.error, /measuring range/);
  assert.match((await call(`/machines/${mid}/signals`, { method: 'POST', body: { ...sig, sensorType: 'magic' }, token: t.admin })).data.error, /sensorType must be one of/);
  const r = await call(`/machines/${mid}/signals`, { method: 'POST', body: sig, token: t.admin });
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.sensorTypeLabel, 'Thermocouple'); assert.equal(r.data.rangeMax, 200); assert.equal(r.data.sourceAddress, sig.sourceAddress);
  assert.equal((await call(`/machines/${mid}/signals`, { method: 'POST', body: sig, token: t.admin })).status, 409);
  // A gateway can send the new signal straight away.
  const ing = await call('/ingest', { method: 'POST', headers: { 'x-ingest-key': 'test-ingest-key' }, body: { readings: [{ device: 'plc-imm-07', at: Date.now(), state: 'running', values: { mould_temp_fixed: 55.5 } }] } });
  assert.equal(ing.data.accepted, 1); assert.equal(one('SELECT value FROM readings WHERE machine_id=? AND key=?', mid, 'mould_temp_fixed').value, 55.5);
  assert.match((await call(`/machines/${mid}/signals/mould_temp_fixed`, { method: 'PATCH', body: { key: 'other' }, token: t.admin })).data.error, /cannot be changed/);
  const edited = await call(`/machines/${mid}/signals/mould_temp_fixed`, { method: 'PATCH', body: { warn_high: 65, sensorType: 'rtd', notes: 'Replaced 2026-10' }, token: t.admin });
  assert.equal(edited.data.warn_high, 65); assert.equal(edited.data.crit_high, 80, 'limits not sent stay'); assert.equal(edited.data.sensorType, 'rtd'); assert.equal(edited.data.sensorMake, 'Omega type J');
  assert.match((await call(`/machines/${mid}/signals/mould_temp_fixed`, { method: 'PATCH', body: { warn_high: 90 }, token: t.admin })).data.error, /critical high/);
  const del = await call(`/machines/${mid}/signals/mould_temp_fixed`, { method: 'DELETE', token: t.admin });
  assert.equal(del.data.deleted, 'mould_temp_fixed');
  assert.equal(one('SELECT COUNT(*) n FROM readings WHERE machine_id=? AND key=?', mid, 'mould_temp_fixed').n, 0);
  assert.equal((await call(`/machines/${mid}/signals/mould_temp_fixed`, { method: 'DELETE', token: t.admin })).status, 404);
});

test('photos and documents for machines and signals, checked by their content', async () => {
  const up = (q, raw, token = t.engineer) => call(`/machines/${mid}/files?${new URLSearchParams(q)}`, { method: 'POST', raw, token });
  assert.equal((await up({ kind: 'photo', name: 'm.png' }, PNG, t.viewer)).status, 403);
  assert.match((await up({ kind: 'photo', name: 'm.png' }, PDF)).data.error, /JPEG, PNG or WebP/);
  assert.match((await up({ kind: 'document', name: 'x.exe' }, Buffer.from([0x4d, 0x5a, 0, 0]))).data.error, /Documents may be/);
  assert.match((await up({ kind: 'document', name: 'macro.docm' }, Buffer.from('504b030414000000', 'hex'))).data.error, /Word \(\.docx\)/);
  assert.equal((await up({ kind: 'photo', name: 'big.png' }, Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]))).status, 413);
  const p1 = await up({ kind: 'photo', name: 'front.png' }, PNG); assert.equal(p1.status, 201, JSON.stringify(p1.data)); assert.equal(p1.data.mime, 'image/png');
  const p2 = await up({ kind: 'photo', name: 'side.png' }, PNG);
  const doc = await up({ kind: 'document', name: 'Operating manual <v2>.pdf', title: 'Operating manual' }, PDF);
  assert.equal(doc.data.filename, 'Operating manual _v2_.pdf'); assert.equal(doc.data.mime, 'application/pdf');
  const csv = await up({ kind: 'document', name: 'calibration.csv', signal: 'hydraulic_oil_temp' }, Buffer.from('date,offset\n2026-09-01,0.2\n')); assert.equal(csv.data.mime, 'text/csv');
  assert.equal((await up({ kind: 'document', name: 'a.pdf', signal: 'nope' }, PDF)).status, 404);
  const setup = (await call(`/machines/${mid}/setup`, { token: t.viewer })).data;
  assert.equal(setup.photoId, p2.data.id, 'a new photo replaces the old one'); assert.equal(one('SELECT COUNT(*) n FROM files WHERE id=?', p1.data.id).n, 0);
  assert.deepEqual(setup.documents.map(d => d.title), ['Operating manual']);
  assert.equal(setup.signals.find(s => s.key === 'hydraulic_oil_temp').documents[0].filename, 'calibration.csv');
  const got = await call(`/files/${doc.data.id}`, { token: t.viewer });
  assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'application/pdf'); assert.match(got.headers.get('content-security-policy'), /sandbox/); assert.ok(got.data.equals(PDF));
  assert.match((await call(`/files/${csv.data.id}`, { token: t.viewer })).headers.get('content-disposition'), /^attachment/);
  assert.equal((await call(`/files/${doc.data.id}`)).status, 401);
  assert.equal((await call(`/files/${doc.data.id}`, { method: 'DELETE', token: t.viewer })).status, 403);
  assert.equal((await call(`/files/${doc.data.id}`, { method: 'DELETE', token: t.engineer })).data.deleted, doc.data.id);
});

test('deleting a machine needs its tag and removes everything that belongs to it', async () => {
  await call('/ingest', { method: 'POST', headers: { 'x-ingest-key': 'test-ingest-key' }, body: { readings: [{ device: 'plc-imm-07', at: Date.now(), state: 'running', values: { hydraulic_oil_temp: 44 } }] } });
  assert.equal((await call(`/machines/${mid}`, { method: 'DELETE', token: t.engineer })).status, 403);
  assert.match((await call(`/machines/${mid}`, { method: 'DELETE', token: t.admin })).data.error, /confirm with its tag \(IMM-07\)/);
  const r = await call(`/machines/${mid}?confirm=imm-07`, { method: 'DELETE', token: t.admin });
  assert.equal(r.data.deleted, 'IMM-07'); assert.ok(r.data.readings >= 1);
  for (const table of ['readings', 'states', 'signals', 'files', 'findings']) assert.equal(one(`SELECT COUNT(*) n FROM ${table} WHERE machine_id=?`, mid).n, 0, table);
  assert.equal((await call(`/machines/${mid}`, { token: t.admin })).status, 404);
  assert.ok(one("SELECT 1 FROM audit WHERE action='machine.delete' AND entity_id=?", mid));
});
