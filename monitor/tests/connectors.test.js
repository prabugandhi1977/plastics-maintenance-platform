import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { OPCUAServer } from 'node-opcua-server';
import { OPCUACertificateManager } from 'node-opcua-certificate-manager';
import { Variant, DataType } from 'node-opcua-client';

// Machine connectors against real servers in this process: an OPC UA server (node-opcua), a Modbus TCP server
// written here over node:net, and a folder that answers Euromap 63 sessions the way a machine does. Values must land
// in readings through the normal intake, states must be mapped, errors must back off and recover, and the API must
// be for the super user only and never show a password.
const dir = mkdtempSync(join(tmpdir(), 'monitor-connectors-'));
process.env.MONITOR_DATA_DIR = dir;
process.env.MONITOR_EUROMAP63_ROOT = join(dir, 'em63');
process.env.MONITOR_CONNECTOR_TEST_UA_PASSWORD = 'env-ua-secret';
delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
const { seedDemo, DEMO_PASSWORD } = await import('../server/seed.js');
const { createServer } = await import('../server/index.js');
const { db, one, all } = await import('../server/db.js');
const C = await import('../server/connectors/index.js');
const { decode, plan } = await import('../server/connectors/modbus.js');
const { parseReport, csvLine, jobText, requestText } = await import('../server/connectors/euromap63.js');
const { encrypt, decrypt } = await import('../server/connectors/config.js');
const { mapState, EUROMAP77_STATES, scaled } = await import('../server/connectors/common.js');
seedDemo();

const until = async (check, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) assert.fail(`Timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 20)); }
};
const machineId = device => one('SELECT id FROM machines WHERE device_id=?', device).id;
const latest = (device, key) => one('SELECT value FROM readings WHERE machine_id=? AND key=? ORDER BY ts DESC LIMIT 1', machineId(device), key)?.value;
const stateOf = device => one('SELECT state FROM states WHERE machine_id=? ORDER BY ts DESC LIMIT 1', machineId(device))?.state;

// ---- The web app ----
const web = createServer(); await new Promise(r => web.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${web.address().port}/api`;
async function call(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
  const raw = await r.text(); return { status: r.status, raw, data: raw ? JSON.parse(raw) : null };
}
const login = async email => (await call('/auth/login', { method: 'POST', body: { email, password: DEMO_PASSWORD } })).data.token;
const t = { admin: await login('admin@monitor.test'), engineer: await login('engineer@monitor.test'), viewer: await login('viewer@monitor.test') };
const status = async cid => (await call('/connectors', { token: t.admin })).data.connectors.find(c => c.id === cid).status;

// ---- OPC UA server: an injection moulding machine with Euromap 77-style variables ----
const ua = { oil: 47.25, pressure: 12345, mode: 1 };
async function uaServer(port = 0) {
  const s = new OPCUAServer({ port, serverCertificateManager: new OPCUACertificateManager({ rootFolder: join(dir, 'ua-server-pki'), automaticallyAcceptUnknownCertificate: true }),
    userManager: { isValidUser: (u, p) => u === 'monitor' && (p === 'ua-secret' || p === 'env-ua-secret') }, allowAnonymous: true });
  await s.initialize();
  const ns = s.engine.addressSpace.getOwnNamespace();
  const imm = ns.addObject({ organizedBy: s.engine.addressSpace.rootFolder.objects, browseName: 'IMM01' });
  const v = (name, dataType, get) => ns.addVariable({ componentOf: imm, nodeId: `s=IMM01.${name}`, browseName: name, dataType, minimumSamplingInterval: 100, value: { get: () => new Variant({ dataType, value: get() }) } });
  v('OilTemp', DataType.Double, () => ua.oil);
  v('InjPressureRaw', DataType.Int32, () => ua.pressure);
  v('MachineMode', DataType.Int32, () => ua.mode);
  await s.start();
  return s;
}
let uaSrv = await uaServer();
const uaPort = uaSrv.endpoints[0].port, uaUrl = `opc.tcp://127.0.0.1:${uaPort}`;

// ---- Modbus TCP server: holding and input registers, coils; can be told to fail ----
const mb = { holding: new Uint16Array(200), input: new Uint16Array(200), coils: new Uint8Array(64), fail: false, sockets: new Set(), requests: 0 };
const mbServer = net.createServer(sock => {
  mb.sockets.add(sock); sock.on('close', () => mb.sockets.delete(sock)); sock.on('error', () => {});
  let buf = Buffer.alloc(0);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 12) {
      const req = buf.subarray(0, 12); buf = buf.subarray(12); mb.requests++;
      const tid = req.readUInt16BE(0), unit = req[6], fn = req[7], start = req.readUInt16BE(8), count = req.readUInt16BE(10);
      let pdu;
      if (mb.fail) pdu = Buffer.from([fn | 0x80, 4]);
      else if (fn === 3 || fn === 4) { const regs = fn === 3 ? mb.holding : mb.input; pdu = Buffer.alloc(2 + count * 2); pdu[0] = fn; pdu[1] = count * 2; for (let i = 0; i < count; i++) pdu.writeUInt16BE(regs[start + i] ?? 0, 2 + i * 2); }
      else if (fn === 1 || fn === 2) { const n = Math.ceil(count / 8); pdu = Buffer.alloc(2 + n); pdu[0] = fn; pdu[1] = n; for (let i = 0; i < count; i++) if (mb.coils[start + i]) pdu[2 + (i >> 3)] |= 1 << (i & 7); }
      else pdu = Buffer.from([fn | 0x80, 1]);
      const head = Buffer.alloc(7); head.writeUInt16BE(tid, 0); head.writeUInt16BE(0, 2); head.writeUInt16BE(pdu.length + 1, 4); head[6] = unit;
      sock.write(Buffer.concat([head, pdu]));
    }
  });
});
await new Promise(r => mbServer.listen(0, '127.0.0.1', r));
const mbEndpoint = `127.0.0.1:${mbServer.address().port}`;
const putFloat = (regs, addr, v, little = false) => { const b = Buffer.alloc(4); b.writeFloatBE(v); const hi = b.readUInt16BE(0), lo = b.readUInt16BE(2); regs[addr] = little ? lo : hi; regs[addr + 1] = little ? hi : lo; };

// ---- Euromap 63 machine: answers SESSnnnn.REQ in its session folder ----
const emFolder = join(dir, 'em63', 'imm-02'); mkdirSync(emFolder, { recursive: true });
const em = { values: { ActCycTim: '24.85', ActTimCyc: '3.2', ActStsMach: '0A000' }, paused: false, sessions: 0, jobs: [] };
const emTimer = setInterval(() => {
  if (em.paused) return;
  for (const f of readdirSync(emFolder).filter(f => /^SESS\d{4}\.REQ$/.test(f))) {
    const req = readFileSync(join(emFolder, f), 'latin1'), jobFile = /EXECUTE "([^"]+)"/.exec(req)?.[1];
    if (!jobFile || !existsSync(join(emFolder, jobFile))) continue;
    const job = readFileSync(join(emFolder, jobFile), 'latin1'); em.jobs.push(job);
    const log = /RESPONSE "([^"]+)"/.exec(job)[1], dat = /REWRITE "([^"]+)"/.exec(job)[1], params = /PARAMETERS\s+([^;]+);/.exec(job)[1].split(',').map(p => p.trim());
    const value = p => p === 'DATE' ? '20261025' : p === 'TIME' ? '10:15:00' : em.values[p.replace(/^@/, '')];
    const unknown = params.filter(p => value(p) == null);
    if (unknown.length) { writeFileSync(join(emFolder, log), `ERROR 0001 unknown parameter ${unknown[0]}\r\n`); writeFileSync(join(emFolder, f.replace('.REQ', '.RSP')), `00000001 ERROR "${jobFile}";\r\n`); }
    else {
      writeFileSync(join(emFolder, dat), `${params.join(',')}\r\n${params.map(p => /^[\d.]+$/.test(value(p)) ? value(p) : `"${value(p)}"`).join(',')}\r\n`);
      writeFileSync(join(emFolder, log), 'COMMAND 1 PROCESSED\r\n');
      writeFileSync(join(emFolder, f.replace('.REQ', '.RSP')), `00000001 PROCESSED "EXECUTE ${jobFile}";\r\n`);
    }
    unlinkSync(join(emFolder, f)); em.sessions++;
  }
}, 25);

C.startConnectors({ minBackoffMs: 50, maxBackoffMs: 400, flushMs: 30, syncMs: 60000 });
after(async () => {
  await C.stopConnectors(); clearInterval(emTimer);
  await uaSrv?.shutdown(0); await new Promise(r => mbServer.close(r)); await new Promise(r => web.close(r));
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test('decoding: Modbus types and word order, request planning, Euromap 63 files, states, scaling and stored passwords', () => {
  const f = Buffer.alloc(4); f.writeFloatBE(-12.5); const [hi, lo] = [f.readUInt16BE(0), f.readUInt16BE(2)];
  assert.equal(decode([hi, lo], 'float32', 'big'), -12.5);
  assert.equal(decode([lo, hi], 'float32', 'little'), -12.5);
  assert.equal(decode([0xffff], 'int16'), -1); assert.equal(decode([0xffff], 'uint16'), 65535);
  assert.equal(decode([0x0001, 0x0000], 'int32'), 65536); assert.equal(decode([0x0000, 0x0001], 'uint32', 'little'), 65536);
  const p = plan([{ key: 'a', address: 0, function: 'holding', type: 'float32' }, { key: 'b', address: 4, function: 'holding', type: 'int16' }, { key: 'c', address: 100, function: 'holding', type: 'int16' }, { key: 'd', address: 0, function: 'input', type: 'uint16' }]);
  assert.deepEqual(p.map(r => [r.function, r.start, r.end, r.entries.length]), [['holding', 0, 5, 2], ['holding', 100, 101, 1], ['input', 0, 1, 1]], 'neighbours are read in one request');
  assert.deepEqual(csvLine('"0A000",24.85,"say ""hi"""'), ['0A000', '24.85', 'say "hi"']);
  assert.deepEqual(parseReport('DATE,TIME,@ActCycTim\r\n20261025,10:15:00,24.85\r\n'), { date: '20261025', time: '10:15:00', actcyctim: '24.85' });
  assert.match(jobText('0042', ['@ActCycTim', 'ActTimCyc']), /^JOB SESS0042 RESPONSE "SESS0042.LOG";\r\nREPORT REP0042 REWRITE "SESS0042.DAT"\r\n {2}PARAMETERS\r\n {4}DATE, TIME, @ActCycTim, ActTimCyc;/);
  assert.equal(requestText('0042', 'C:\\EM63\\'), '00000001 EXECUTE "C:\\EM63\\SESS0042.JOB";\r\n');
  assert.equal(mapState(1, EUROMAP77_STATES), 'running'); assert.equal(mapState('SLEEP', EUROMAP77_STATES), 'off'); assert.equal(mapState({ text: 'Manual' }, EUROMAP77_STATES), 'idle');
  assert.equal(mapState('7', { 7: 'down' }), 'down'); assert.equal(mapState('9', { 7: 'down' }), null);
  assert.equal(scaled(1234, { scale: 0.1 }), 123.4); assert.equal(scaled(100, { scale: 0.5, offset: -10 }), 40);
  assert.deepEqual([0, 1, 2, 5, 6, 10].map(a => C.backoff(a)), [1000, 2000, 4000, 32000, 60000, 60000], '1 s doubling to 60 s');
  const sealed = encrypt('ua-secret'); assert.ok(!sealed.includes('ua-secret')); assert.notEqual(encrypt('ua-secret'), sealed, 'a new IV each time'); assert.equal(decrypt(sealed), 'ua-secret');
  assert.throws(() => decrypt(sealed.slice(0, -2) + 'xx'), /cannot be read/);
  assert.equal(C.connectorsEnabled({}), true); assert.equal(C.connectorsEnabled({ MONITOR_CONNECTORS: 'off' }), false);
});

const imm01 = () => machineId('plc-imm-01');
const uaBody = (extra = {}) => ({ machineId: imm01(), name: 'Euromap 77', type: 'opcua', endpoint: uaUrl, pollSeconds: 1, username: 'monitor', password: 'ua-secret',
  options: { readMode: 'subscription', state: { node: 'ns=1;s=IMM01.MachineMode' } },
  mapping: { hydraulic_oil_temp: { node: 'ns=1;s=IMM01.OilTemp' }, injection_pressure: { node: 'ns=1;s=IMM01.InjPressureRaw', scale: 0.1 } }, ...extra });
let uaId;

test('the connector API is for the super user only, checks its input, and never returns a password', async () => {
  for (const who of ['viewer', 'engineer']) {
    assert.equal((await call('/connectors', { token: t[who] })).status, 403);
    assert.equal((await call('/connectors', { method: 'POST', body: uaBody(), token: t[who] })).status, 403);
    assert.equal((await call('/connectors/test', { method: 'POST', body: uaBody(), token: t[who] })).status, 403);
  }
  assert.equal((await call('/connectors')).status, 401);
  const bad = async (body, re) => { const r = await call('/connectors', { method: 'POST', body, token: t.admin }); assert.equal(r.status, 400, JSON.stringify(r.data)); assert.match(r.data.error, re); };
  await bad(uaBody({ endpoint: 'http://plc' }), /opc\.tcp:\/\//);
  await bad(uaBody({ endpoint: 'opc.tcp://user:pw@plc:4840' }), /no user name or password/);
  await bad(uaBody({ mapping: { hydraulic_oil_temp: { node: 'not a node' } } }), /OPC UA node ID/);
  await bad(uaBody({ mapping: { dew_point: { node: 'ns=1;s=X' } } }), /not a signal of this machine/);
  await bad(uaBody({ passwordEnv: 'ANTHROPIC_API_KEY', password: undefined }), /MONITOR_CONNECTOR_/);
  await bad(uaBody({ pollSeconds: 0.2 }), /pollSeconds/);
  await bad(uaBody({ options: { state: { node: 'ns=1;s=IMM01.MachineMode', map: { 1: 'producing' } } } }), /must map to one of/);
  await bad({ machineId: imm01(), name: 'EM63', type: 'euromap63', endpoint: '../../etc', mapping: { hydraulic_oil_temp: '@ActOilTmp' } }, /must be inside/);
  await bad({ machineId: imm01(), name: 'MB', type: 'modbus', endpoint: mbEndpoint, mapping: { hydraulic_oil_temp: { address: 70000 } } }, /address must be/);
  await bad({ machineId: imm01(), name: 'MB', type: 'modbus', endpoint: mbEndpoint, username: 'x', password: 'y', mapping: { hydraulic_oil_temp: { address: 1 } } }, /Only OPC UA/);

  const r = await call('/connectors', { method: 'POST', body: uaBody(), token: t.admin });
  assert.equal(r.status, 201, r.raw); uaId = r.data.id;
  assert.equal(r.data.passwordSet, true); assert.equal(r.data.username, 'monitor'); assert.equal(r.data.machineTag, 'IMM-01');
  const list = await call('/connectors', { token: t.admin });
  for (const raw of [r.raw, list.raw]) { assert.ok(!raw.includes('ua-secret'), 'no password in replies'); assert.ok(!/password_enc|v1:/.test(raw), 'not even encrypted'); }
  const row = one('SELECT * FROM connectors WHERE id=?', uaId);
  assert.ok(row.password_enc.startsWith('v1:') && !row.password_enc.includes('ua-secret'), 'stored encrypted');
  const auditRows = all("SELECT detail FROM audit WHERE action LIKE 'connector.%'").map(a => a.detail).join(' ');
  assert.ok(!auditRows.includes('ua-secret') && !auditRows.includes('v1:'), 'nor in the audit log');
  assert.equal((await call('/connectors', { method: 'POST', body: uaBody(), token: t.admin })).status, 409, 'names are unique per machine');
});

test('OPC UA: subscribed values and the Euromap 77 machine mode land in readings and states, scaled', async () => {
  await until(async () => (await status(uaId)).accepted >= 1, 'the first OPC UA reading');
  const s = await status(uaId);
  assert.equal(s.connected, true); assert.equal(s.mode, 'subscription'); assert.ok(s.lastReadingAt);
  assert.equal(latest('plc-imm-01', 'hydraulic_oil_temp'), 47.25);
  assert.equal(latest('plc-imm-01', 'injection_pressure'), 1234.5, 'raw 12345 × 0.1');
  assert.equal(stateOf('plc-imm-01'), 'running', 'Automatic (1) is running');
  ua.oil = 51.5; ua.mode = 5;
  await until(() => latest('plc-imm-01', 'hydraulic_oil_temp') === 51.5 && stateOf('plc-imm-01') === 'off', 'the changed value and Sleep (5) as off');
});

test('Test connection reads once and shows the values without storing them', async () => {
  const saved = await call(`/connectors/${uaId}/test`, { method: 'POST', token: t.admin });
  assert.equal(saved.status, 200); assert.equal(saved.data.ok, true, saved.raw);
  assert.deepEqual(saved.data.values, { hydraulic_oil_temp: 51.5, injection_pressure: 1234.5 }); assert.equal(saved.data.state, 'off'); assert.equal(saved.data.raw.$state, 5);
  // From the form before saving, with the saved password (none typed) and an extra node that does not exist.
  const form = await call('/connectors/test', { method: 'POST', token: t.admin, body: { ...uaBody({ password: undefined }), id: uaId, mapping: { ...uaBody().mapping, motor_current: { node: 'ns=1;s=IMM01.Missing' } } } });
  assert.equal(form.data.ok, true, form.raw); assert.equal(form.data.values.hydraulic_oil_temp, 51.5); assert.match(form.data.skipped.join(), /motor_current: BadNodeIdUnknown/);
  const wrong = await call('/connectors/test', { method: 'POST', token: t.admin, body: uaBody({ name: 'other', password: 'nope-wrong-pass' }) });
  assert.equal(wrong.data.ok, false); assert.ok(wrong.data.error); assert.ok(!wrong.raw.includes('nope-wrong-pass'), 'the password is not echoed in the error');
  assert.equal(all('SELECT * FROM connectors').length, 1, 'testing saves nothing');
  // Nothing read by a test is stored: a machine with no other source keeps no readings.
  mb.holding[10] = 125;
  const mbTest = await call('/connectors/test', { method: 'POST', token: t.admin, body: { machineId: machineId('plc-bm-01'), name: 'test', type: 'modbus', endpoint: mbEndpoint, mapping: { compressed_air: { address: 10, scale: 0.05 } } } });
  assert.equal(mbTest.data.ok, true, mbTest.raw); assert.equal(mbTest.data.values.compressed_air, 6.25);
  assert.equal(one("SELECT COUNT(*) n FROM readings WHERE machine_id=? AND key='compressed_air' AND ts>=?", machineId('plc-bm-01'), Date.now() - 120000).n, 0);
});

test('OPC UA: a wrong password backs off, the fix restarts the connector, and a server restart is recovered', async () => {
  let r = await call(`/connectors/${uaId}`, { method: 'PATCH', token: t.admin, body: { password: 'wrong-password-1' } });
  assert.equal(r.status, 200); assert.ok(!r.raw.includes('wrong-password-1'));
  await until(async () => (await status(uaId)).failures >= 2, 'repeated failures');
  let s = await status(uaId);
  assert.equal(s.connected, false); assert.ok(s.lastError); assert.ok(!s.lastError.includes('wrong-password-1')); assert.ok(s.restarts >= 1, 'restarted with the new settings');
  assert.ok(s.retryInMs >= 100 && s.retryInMs <= 400, `backoff grows within its limit (${s.retryInMs})`);
  // The password from an environment variable, and polling instead of a subscription.
  r = await call(`/connectors/${uaId}`, { method: 'PATCH', token: t.admin, body: { passwordEnv: 'MONITOR_CONNECTOR_TEST_UA_PASSWORD', options: { ...uaBody().options, readMode: 'poll' } } });
  assert.equal(r.data.passwordEnv, 'MONITOR_CONNECTOR_TEST_UA_PASSWORD'); assert.ok(!r.raw.includes('env-ua-secret'));
  assert.equal(one('SELECT password_enc FROM connectors WHERE id=?', uaId).password_enc, null, 'the typed password is dropped');
  await until(async () => (await status(uaId)).connected && (await status(uaId)).mode === 'poll', 'the reconnect in poll mode');
  ua.oil = 44.4; ua.mode = 1;
  await until(() => latest('plc-imm-01', 'hydraulic_oil_temp') === 44.4 && stateOf('plc-imm-01') === 'running', 'polled values');

  assert.equal((await status(uaId)).failures, 0, 'failures reset after a good read');
  await uaSrv.shutdown(0); uaSrv = null;
  await until(async () => !(await status(uaId)).connected, 'the lost connection');
  assert.ok((await status(uaId)).lastError);
  uaSrv = await uaServer(uaPort); ua.oil = 45.5;
  await until(async () => (await status(uaId)).connected && latest('plc-imm-01', 'hydraulic_oil_temp') === 45.5, 'recovery after the server restart', 15000);
});

let mbId;
test('Modbus TCP: word order, types, scaling and a state from a register; device errors back off and recover', async () => {
  putFloat(mb.holding, 0, 12.75); putFloat(mb.holding, 2, 31.5, true);
  mb.holding[4] = 0xffec; // int16 −20 → −2.0 with scale 0.1
  mb.input[0] = 0x0001; mb.input[1] = 0x86a0; // int32 100000 → 100.0 with scale 0.001
  mb.holding[20] = 2;
  const r = await call('/connectors', { method: 'POST', token: t.admin, body: { machineId: machineId('plc-ch-01'), name: 'Energy meter', type: 'modbus', endpoint: mbEndpoint, pollSeconds: 1, options: { unitId: 3, timeoutMs: 1000, state: { address: 20, map: { 0: 'off', 1: 'idle', 2: 'running', 3: 'down' } } },
    mapping: { supply_temp: { address: 0, type: 'float32' }, compressor_current: { address: 2, type: 'float32', wordOrder: 'little' }, discharge_pressure: { address: 0, function: 'input', type: 'int32', scale: 0.001 } } } });
  assert.equal(r.status, 201, r.raw); mbId = r.data.id;
  await until(() => latest('plc-ch-01', 'supply_temp') === 12.75, 'Modbus readings');
  assert.equal(latest('plc-ch-01', 'compressor_current'), 31.5, 'little-endian word order');
  assert.equal(latest('plc-ch-01', 'discharge_pressure'), 100, 'int32 from input registers, scaled');
  assert.equal(stateOf('plc-ch-01'), 'running');
  // A signed register with a scale, added by editing: the connector restarts with the new map.
  const before = (await status(mbId)).restarts;
  await call(`/connectors/${mbId}`, { method: 'PATCH', token: t.admin, body: { mapping: { ...r.data.mapping, supply_temp: { address: 4, type: 'int16', scale: 0.1 } } } });
  await until(() => latest('plc-ch-01', 'supply_temp') === -2, 'the new mapping');
  assert.equal((await status(mbId)).restarts, before + 1);

  mb.fail = true;
  await until(async () => (await status(mbId)).failures >= 3, 'repeated Modbus errors');
  let s = await status(mbId);
  assert.match(s.lastError, /Modbus exception 4 \(device failure\)/); assert.equal(s.connected, false);
  assert.ok(s.retryInMs >= 200, `the wait doubles (${s.retryInMs} ms)`);
  mb.fail = false; mb.holding[4] = 0xfff6; mb.holding[20] = 3;
  await until(() => latest('plc-ch-01', 'supply_temp') === -1 && stateOf('plc-ch-01') === 'down', 'recovery');
  assert.equal((await status(mbId)).failures, 0);
  assert.ok((await status(uaId)).connected, 'the failing Modbus connector did not affect the OPC UA one');
});

let emId;
test('Euromap 63: session and job files are answered, values and state stored, files cleaned up, and timeouts recover', async () => {
  const add = await call('/machines/' + machineId('plc-imm-02') + '/signals', { method: 'POST', token: t.admin, body: { key: 'cycle_time', label: 'Cycle time', unit: 's' } });
  assert.equal(add.status, 201);
  const stale = join(emFolder, 'SESS9999.RSP'); writeFileSync(stale, 'old'); utimesSync(stale, new Date(Date.now() - 3600000), new Date(Date.now() - 3600000));
  writeFileSync(join(emFolder, 'PRODUCTION.CSV'), 'not ours');
  const r = await call('/connectors', { method: 'POST', token: t.admin, body: { machineId: machineId('plc-imm-02'), name: 'EM63', type: 'euromap63', endpoint: 'imm-02', pollSeconds: 1,
    options: { timeoutMs: 600, state: { param: 'ActStsMach', map: { '0A000': 'running', '0I000': 'idle', '0E000': 'down' } } },
    mapping: { cycle_time: { param: '@ActCycTim' }, injection_pressure: { param: 'ActTimCyc', scale: 100 } } } });
  assert.equal(r.status, 201, r.raw); emId = r.data.id;
  await until(() => latest('plc-imm-02', 'cycle_time') === 24.85, 'Euromap 63 readings');
  assert.equal(latest('plc-imm-02', 'injection_pressure'), 320); assert.equal(stateOf('plc-imm-02'), 'running');
  assert.match(em.jobs[0], /REPORT REP\d{4} REWRITE "SESS\d{4}\.DAT"/); assert.match(em.jobs[0], /DATE, TIME, @ActCycTim, ActTimCyc, ActStsMach;/);
  assert.ok(!existsSync(stale), 'stale session files are removed'); assert.ok(existsSync(join(emFolder, 'PRODUCTION.CSV')), 'other files are left alone');
  await until(() => readdirSync(emFolder).filter(f => f.startsWith('SESS')).length === 0, 'no session files left between polls', 3000);

  em.paused = true;
  await until(async () => (await status(emId)).failures >= 1, 'the timeout');
  assert.match((await status(emId)).lastError, /did not answer the Euromap 63 session within 0.6 s/);
  assert.equal(readdirSync(emFolder).filter(f => f.startsWith('SESS')).length, 0, 'the unanswered request is withdrawn');
  em.paused = false; em.values.ActCycTim = '25.10'; em.values.ActStsMach = '0E000';
  await until(() => latest('plc-imm-02', 'cycle_time') === 25.1 && stateOf('plc-imm-02') === 'down', 'recovery after the timeout');
  // A parameter the machine does not know: it refuses the job and says why.
  await call(`/connectors/${emId}`, { method: 'PATCH', token: t.admin, body: { mapping: { cycle_time: { param: '@ActCycTim' }, motor_current: { param: '@ActUnknown' } } } });
  await until(async () => /refused the Euromap 63 job: ERROR 0001 unknown parameter @ActUnknown/.test((await status(emId)).lastError ?? '') && (await status(emId)).failures >= 1, 'the refusal');
});

test('disabling and deleting stop a connector; readings follow a changed device ID; stopping is clean', async () => {
  await call(`/connectors/${emId}`, { method: 'PATCH', token: t.admin, body: { enabled: false } });
  assert.equal((await status(emId)).running, false);
  const sessions = em.sessions; await new Promise(r => setTimeout(r, 1300)); assert.equal(em.sessions, sessions, 'a disabled connector polls no more');
  // A machine whose device ID changes keeps its connector: the reading uses the current ID.
  db.prepare("UPDATE machines SET device_id='plc-ch-01b' WHERE device_id='plc-ch-01'").run();
  mb.holding[4] = 0xffd8;
  await until(() => latest('plc-ch-01b', 'supply_temp') === -4, 'the reading under the new device ID');
  assert.equal((await call(`/connectors/${mbId}`, { method: 'DELETE', token: t.admin })).status, 200);
  assert.equal((await status(uaId)).connected, true);
  await until(() => mb.sockets.size === 0, 'the Modbus connection closed after delete');
  await C.stopConnectors();
  await until(() => uaSrv.engine.currentSessionCount === 0, 'no OPC UA session left');
  assert.equal(C.connectorStatus(uaId).running, false);
});
