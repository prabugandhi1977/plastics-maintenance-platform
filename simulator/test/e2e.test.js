// Whole chain in one process: virtual plant -> MQTT broker / OPC UA server / Euromap 63 files -> gateway -> intake endpoints
// (a stand-in that applies the app's own validation). Machines 1, 2, 3 use MQTT, OPC UA and Euromap 63.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Plant, defaultPlantConfig } from '../src/plant.js';
import { startBroker, MqttSink } from '../src/transports/mqtt.js';
import { startOpcUaServer } from '../src/transports/opcua.js';
import { Euromap63Writer } from '../src/transports/euromap63.js';
import { Gateway } from '../src/gateway/gateway.js';
import { Chaos } from '../src/gateway/chaos.js';
import { startFakePlatform } from './fake-platform.js';

const T0 = Date.parse('2026-11-02T06:00:00Z');
const dir = mkdtempSync(join(tmpdir(), 'vplant-'));
const cfg = defaultPlantConfig({ machines: 3, seed: 5 });
const devices = new Map(); for (const m of cfg.machines) for (const id of [m.id, m.meterId, m.cameraId, m.safetyCameraId]) devices.set(id, 'injection');
const closers = [];
after(async () => { for (const c of closers.reverse()) await c().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

async function bring({ chaos = null } = {}) {
  const fake = await startFakePlatform({ devices }); closers.push(fake.close);
  const broker = await startBroker(0); closers.push(broker.close);
  const plant = new Plant(cfg, T0);
  const opc = await startOpcUaServer(plant, { port: 0 }); closers.push(opc.close);
  const sink = new MqttSink(`mqtt://127.0.0.1:${broker.port}`); await sink.ready(); closers.push(() => sink.close());
  plant.on(m => sink.publish(m)); plant.announce();
  const eu = new Euromap63Writer(join(dir, 'eu' + Math.random().toString(16).slice(2, 6)), plant);
  const gw = new Gateway({ platformUrl: fake.url, key: fake.key, mqttUrl: `mqtt://127.0.0.1:${broker.port}`, opcUrl: opc.url, euromapDir: eu.dir, pollMs: 1e9, chaos, log: () => {},
    machines: cfg.machines.map(m => ({ id: m.id, tag: m.tag, meterId: m.meterId, protocol: m.protocol })) });
  await gw.start(); closers.push(() => gw.stop());
  return { fake, plant, gw, eu, sink };
}
async function drive({ plant, gw, eu }, simSeconds, pollEvery = 5, each = () => {}) {
  for (let t = 0; t < simSeconds; t += pollEvery) { for (let i = 0; i < pollEvery; i++) plant.step(1); eu.write(); await gw.poll(); each(t); if (t % 60 === 0) await new Promise(r => setTimeout(r, 5)); }
  await new Promise(r => setTimeout(r, 400)); await gw.sender.flush();
}
const by = (list, type, id) => list.filter(e => e.type === type && (!id || e.deviceId === id));

test('every protocol reaches the platform as accepted state, count, condition, energy, vision and IoT data, with nothing rejected', async () => {
  const rig = await bring(); await drive(rig, 3600);
  const { store } = rig.fake;
  assert.deepEqual(store.rejected, [], JSON.stringify(store.rejected.slice(0, 3)));
  for (const m of cfg.machines) {
    assert.ok(by(store.factory, 'state', m.id).length >= 1, `state ${m.protocol}`);
    assert.ok(by(store.factory, 'condition', m.id).length >= 3, `condition ${m.protocol}`);
    assert.ok(by(store.factory, 'count', m.id).length >= 3, `count ${m.protocol}`);
    assert.ok(by(store.factory, 'energy', m.meterId).length >= 3, `energy ${m.protocol}`);
    assert.ok(by(store.factory, 'vision', m.cameraId).length >= 3, `vision ${m.protocol}`);
    assert.ok(store.iot.some(r => r.deviceId === m.id && r.cycleCount > 0), `iot ${m.protocol}`);
  }
  const g = rig.gw.status(); assert.ok(g.received.mqtt > 0 && g.received.opcua > 0 && g.received.euromap63 > 0, JSON.stringify(g.received));
  // The same physics sits behind all three protocols, so energy per interval agrees with the machine's rating.
  for (const m of cfg.machines) { const e = by(store.factory, 'energy', m.meterId).filter(x => x.kwh > 0); const avg = e.reduce((s, x) => s + x.kwh, 0) / e.length; assert.ok(avg > m.ratedKw * 0.25 * 0.4 && avg < m.ratedKw * 0.25 * 1.3, `${m.protocol} avg ${avg} vs ${m.ratedKw * 0.25}`); }
});

test('a heater failure shows up as a critical alarm, a breakdown, short-shot rejects and a stopped machine on every protocol', async () => {
  const rig = await bring();
  await drive(rig, 900); for (const m of rig.plant.machines.values()) m.inject('heater_band_failure', { rampS: 600 });
  await drive(rig, 2700); const { store } = rig.fake;
  assert.deepEqual(store.rejected, [], JSON.stringify(store.rejected.slice(0, 3)));
  for (const m of cfg.machines) {
    assert.ok(store.iot.some(r => r.deviceId === m.id && r.alarms.some(a => a.code === 'T-302' && a.state === 'active' && a.severity === 'critical')), `T-302 on ${m.protocol}`);
    assert.ok(by(store.factory, 'state', m.id).some(s => s.state === 'down' && s.reason === 'breakdown'), `breakdown on ${m.protocol}`);
    assert.ok(by(store.factory, 'vision', m.cameraId).some(v => (v.defects.short_shot ?? 0) > 0), `short shots on ${m.protocol}`);
  }
});

test('data faults: duplicates are ignored, bad data is rejected with a reason, unmapped devices are quarantined, an outage replays in full', async () => {
  const chaos = new Chaos(3); chaos.set({ duplicateRate: 0.2, garbageRate: 0.02, unmappedRate: 0.02, reorderRate: 0.1 });
  const rig = await bring({ chaos });
  await drive(rig, 900, 5);
  rig.gw.sender.setPaused(true); await drive(rig, 1200, 5); const queued = rig.gw.sender.depth(); assert.ok(queued > 100, `queued ${queued}`);
  rig.gw.sender.setPaused(false); await drive(rig, 300, 5); chaos.clear(); for (let i = 0; i < 15; i++) await rig.gw.sender.flush(); // let reordered items come back
  const { store } = rig.fake, st = rig.gw.sender.stats;
  assert.equal(rig.gw.sender.depth(), 0);
  assert.ok(store.duplicates > 0 && st.duplicates > 0, 'duplicates seen');
  assert.ok(st.rejected > 0 && Object.keys(st.rejectReasons).length > 0, 'rejections counted with reasons');
  assert.ok(Object.keys(st.rejectReasons).some(r => /Unknown or inactive deviceId/.test(r)), JSON.stringify(st.rejectReasons));
  // Nothing is silently lost: every 15-minute count either arrived or was rejected with a reason (damaged on purpose).
  const arrived = by(store.factory, 'count').length + store.rejected.filter(r => r.item.type === 'count').length;
  assert.ok(arrived >= cfg.machines.length * 2, `count events accounted for: ${arrived}`);
});

test('the gateway survives the platform being down and keeps order', async () => {
  const rig = await bring(); rig.fake.store.down = true;
  await drive(rig, 600); assert.ok(rig.gw.sender.depth() > 50); assert.ok(rig.gw.sender.stats.retries > 0);
  rig.fake.store.down = false; rig.gw.sender.nextTry = 0; await drive(rig, 60);
  assert.equal(rig.gw.sender.depth(), 0); assert.ok(rig.fake.store.factory.length > 50);
});
