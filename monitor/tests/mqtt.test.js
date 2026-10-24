import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';

// A real broker in this process: readings published over MQTT in both formats must land in the database through the
// normal ingest path, with rejections counted, batching, the status in Settings, and reconnects.
const dir = mkdtempSync(join(tmpdir(), 'monitor-mqtt-'));
process.env.MONITOR_DATA_DIR = dir;
delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
const { seedDemo, DEMO_PASSWORD } = await import('../server/seed.js');
const { mqttConfig, mqttStatus, startMqtt, stopMqtt } = await import('../server/mqtt.js');
const { createServer } = await import('../server/index.js');
const { db, one } = await import('../server/db.js');
seedDemo();

const broker = await Aedes.createBroker();
broker.authenticate = (client, username, password, done) => done(null, username === 'monitor' && String(password) === 'broker-secret');
const brokerServer = net.createServer(broker.handle); await new Promise(r => brokerServer.listen(0, '127.0.0.1', r));
const url = `mqtt://127.0.0.1:${brokerServer.address().port}`;
const web = createServer(); await new Promise(r => web.listen(0, '127.0.0.1', r));
const pub = await mqtt.connectAsync(url, { username: 'monitor', password: 'broker-secret' });
after(async () => {
  await stopMqtt(); await pub.endAsync();
  await new Promise(r => web.close(r)); await new Promise(r => broker.close(r)); await new Promise(r => brokerServer.close(r));
  db.close(); rmSync(dir, { recursive: true, force: true });
});

async function until(check, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) assert.fail(`Timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 10)); }
}
const machine = device => one('SELECT id FROM machines WHERE device_id=?', device).id;
const reading = (device, key) => one('SELECT value FROM readings WHERE machine_id=? AND key=? ORDER BY ts DESC LIMIT 1', machine(device), key)?.value;

test('configuration: off without a URL, the default topic, and only MQTT or WebSocket URLs', () => {
  assert.equal(mqttConfig({}), null);
  assert.equal(mqttConfig({ MONITOR_MQTT_URL: 'mqtt://broker:1883' }).topic, 'mouldcare/#');
  assert.throws(() => mqttConfig({ MONITOR_MQTT_URL: 'http://broker' }), /must start with/);
  assert.equal(mqttStatus().enabled, false);
});

test('both payload formats land in readings and states; unknown devices and non-numbers are rejected and counted', async () => {
  startMqtt({ url: url.replace('://', '://monitor:broker-secret@'), username: 'monitor', password: 'broker-secret', topic: 'plant/#' }, { flushMs: 50 });
  await until(() => mqttStatus().connected, 'the connection');
  await new Promise(r => setTimeout(r, 50)); // the subscription follows the connection
  const at = new Date().toISOString();
  await pub.publishAsync('plant/hall-a/plc-imm-01', JSON.stringify({ device: 'plc-imm-01', at, state: 'running', values: { hydraulic_oil_temp: 44.4 } }), { qos: 1 });
  await pub.publishAsync('plant/gw1', JSON.stringify({ readings: [{ device: 'plc-imm-02', at, values: { hydraulic_oil_temp: 51.5 } }, { device: 'plc-nobody', at, values: { x: 1 } }] }), { qos: 1 });
  await pub.publishAsync('plant/plc-imm-01/pump_vibration', '2.75', { qos: 1 });
  await pub.publishAsync('plant/plc-ext-01/state', 'down', { qos: 1 });
  await pub.publishAsync('plant/plc-imm-01/pump_vibration', 'high', { qos: 1 });
  await pub.publishAsync('plant/plc-imm-01/pump_vibration', '{broken', { qos: 1 });
  await until(() => mqttStatus().accepted + mqttStatus().rejected >= 7, 'all readings');
  const s = mqttStatus();
  assert.equal(s.accepted, 4); assert.equal(s.rejected, 3);
  assert.equal(reading('plc-imm-01', 'hydraulic_oil_temp'), 44.4);
  assert.equal(reading('plc-imm-02', 'hydraulic_oil_temp'), 51.5);
  assert.equal(reading('plc-imm-01', 'pump_vibration'), 2.75);
  assert.equal(one('SELECT state FROM states WHERE machine_id=? ORDER BY ts DESC LIMIT 1', machine('plc-imm-01')).state, 'running');
  assert.equal(one('SELECT state FROM states WHERE machine_id=? ORDER BY ts DESC LIMIT 1', machine('plc-ext-01')).state, 'down');
  const reasons = s.reasons.map(x => x.reason).join(' | ');
  assert.match(reasons, /Unknown device "plc-nobody"/); assert.match(reasons, /pump_vibration: not a number/); assert.match(reasons, /not valid JSON/);

  // Settings › Connections shows the status to the super user, without the password.
  const base = `http://127.0.0.1:${web.address().port}/api`;
  const login = async email => (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) })).json()).token;
  const settings = token => fetch(`${base}/settings`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await settings(await login('viewer@monitor.test'))).status, 403);
  const res = await settings(await login('admin@monitor.test')), raw = await res.text(), m = JSON.parse(raw).mqtt;
  assert.equal(res.status, 200); assert.equal(m.connected, true); assert.equal(m.topic, 'plant/#'); assert.equal(m.accepted, 4); assert.ok(m.lastMessageAt);
  assert.equal(m.url, url); assert.ok(!raw.includes('broker-secret'), 'the password is never returned');
});

test('messages are ingested in batches: when the batch is full, and after the wait for the rest', async () => {
  await stopMqtt();
  startMqtt({ url, username: 'monitor', password: 'broker-secret', topic: 'plant/#' }, { batchSize: 3, flushMs: 400, minBackoffMs: 50 });
  await until(() => mqttStatus().connected, 'the connection');
  await new Promise(r => setTimeout(r, 50));
  for (let i = 0; i < 7; i++) await pub.publishAsync('plant/plc-dry-01/dew_point', String(-40 - i), { qos: 1 });
  await until(() => mqttStatus().messages === 7, 'all messages');
  assert.equal(mqttStatus().batches, 2); assert.equal(mqttStatus().queued, 1);
  await until(() => mqttStatus().queued === 0, 'the last batch');
  assert.equal(mqttStatus().batches, 3); assert.equal(mqttStatus().accepted, 7);
  assert.equal(reading('plc-dry-01', 'dew_point'), -46, 'a later value in the same minute replaces the earlier one');
});

test('reconnects after the broker drops the connection, and stops cleanly', async () => {
  const before = mqttStatus();
  for (const c of Object.values(broker.clients)) if (c.id !== pub.options.clientId) c.close();
  await until(() => !mqttStatus().connected, 'the disconnect');
  await until(() => mqttStatus().connected, 'the reconnect', 5000);
  assert.equal(mqttStatus().reconnects, before.reconnects + 1);
  await new Promise(r => setTimeout(r, 50));
  await pub.publishAsync('plant/plc-ch-01/supply_temp', '12.5', { qos: 1 });
  await until(() => mqttStatus().accepted > before.accepted, 'a reading after the reconnect');
  assert.equal(reading('plc-ch-01', 'supply_temp'), 12.5);
  await stopMqtt();
  assert.equal(mqttStatus().connected, false);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(Object.values(broker.clients).filter(c => c.id !== pub.options.clientId).length, 0, 'no client left on the broker');
});
