#!/usr/bin/env node
// Virtual plant command line.
//   provision   create the plant's machines, devices, products and batch in the platform (needs an admin login)
//   run         start the virtual plant (MQTT broker, OPC UA server, Euromap 63 files, control port); add --gateway to also uplink
//   gateway     start only the gateway (use with a plant started elsewhere, e.g. in another container)
//   act '{...}' send an action to a running plant's control port
//   scenarios   list scenarios and fault kinds
import http from 'node:http';
import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { Plant, defaultPlantConfig } from './plant.js';
import { startBroker, MqttSink } from './transports/mqtt.js';
import { startOpcUaServer } from './transports/opcua.js';
import { Euromap63Writer } from './transports/euromap63.js';
import { Gateway } from './gateway/gateway.js';
import { Chaos } from './gateway/chaos.js';
import { SCENARIOS, Timeline, act } from './scenarios.js';
import { FAULTS } from './machine.js';
import { Api, provision } from './provision.js';

const opts = {
  'platform-url': { type: 'string', default: process.env.PLATFORM_URL ?? 'http://localhost:3100' },
  key: { type: 'string', default: process.env.MOULDCARE_INTEGRATION_KEY ?? '' },
  email: { type: 'string', default: process.env.PLATFORM_EMAIL ?? 'admin@demo.test' }, password: { type: 'string', default: process.env.PLATFORM_PASSWORD ?? '' },
  plant: { type: 'string', default: 'plant-a' }, company: { type: 'string' },
  machines: { type: 'string', default: process.env.VPLANT_MACHINES ?? '6' }, seed: { type: 'string', default: '1' }, site: { type: 'string', default: 'sim-plant' },
  speed: { type: 'string', default: process.env.VPLANT_SPEED ?? '1' }, backfill: { type: 'string', default: '0' }, scenario: { type: 'string', default: 'normal-day' },
  'mqtt-url': { type: 'string', default: process.env.MQTT_URL ?? '' }, 'mqtt-port': { type: 'string', default: '1883' },
  'opcua-port': { type: 'string', default: '4840' }, 'opcua-url': { type: 'string', default: process.env.OPCUA_URL ?? '' },
  'euromap-dir': { type: 'string', default: process.env.EUROMAP_DIR ?? './data/euromap63' }, 'control-port': { type: 'string', default: '4850' },
  gateway: { type: 'boolean', default: false }, 'no-batches': { type: 'boolean', default: false }, spool: { type: 'string' }, tz: { type: 'string', default: '0' }
};
const { values: o, positionals } = parseArgs({ options: opts, allowPositionals: true });
const cmd = positionals[0] ?? 'help';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const config = () => defaultPlantConfig({ machines: Number(o.machines), seed: Number(o.seed), site: o.site, tzOffsetH: Number(o.tz) });
const descriptors = cfg => cfg.machines.map(m => ({ id: m.id, tag: m.tag, meterId: m.meterId, protocol: m.protocol }));
const needKey = () => { if (!o.key) { console.error('Set --key (or MOULDCARE_INTEGRATION_KEY): the platform\'s integration key.'); process.exit(2); } };

async function main() {
  if (cmd === 'scenarios') {
    for (const [k, v] of Object.entries(SCENARIOS)) console.log(`${k.padEnd(16)} ${v.about}`);
    console.log('\nFault kinds:'); for (const [k, v] of Object.entries(FAULTS)) console.log(`  ${k.padEnd(26)} ${v}`);
    return;
  }
  if (cmd === 'act') {
    const res = await fetch(`http://127.0.0.1:${o['control-port']}/act`, { method: 'POST', body: positionals[1] }); console.log(res.status, await res.text()); return;
  }
  if (cmd === 'provision') {
    if (!o.password) { console.error('Set --password (or PLATFORM_PASSWORD) for the admin account.'); process.exit(2); }
    const api = new Api(o['platform-url']); await api.login(o.email, o.password);
    log(`provisioning ${o.machines} machines into plant ${o.plant} at ${o['platform-url']}`);
    const r = await provision({ api, plantId: o.plant, companyId: o.company, config: config(), log, batches: !o['no-batches'] }); log('done', JSON.stringify(r)); return;
  }
  if (cmd === 'gateway') return runGateway();
  if (cmd === 'run') return runPlant();
  console.log(readmeHelp());
}

async function runPlant() {
  const cfg = config(), speed = Number(o.speed), startAt = Date.now() - Number(o.backfill) * 3600000;
  const plant = new Plant(cfg, startAt), chaos = new Chaos(), closers = [];
  let broker = null; if (!o['mqtt-url']) { broker = await startBroker(Number(o['mqtt-port'])); closers.push(broker.close); log(`MQTT broker on :${broker.port}`); }
  const mqttUrl = o['mqtt-url'] || `mqtt://127.0.0.1:${broker.port}`;
  const sink = new MqttSink(mqttUrl, { log }); await sink.ready(); closers.push(() => sink.close()); plant.on(m => sink.publish(m));
  const opc = await startOpcUaServer(plant, { port: Number(o['opcua-port']), log }); closers.push(opc.close);
  mkdirSync(o['euromap-dir'], { recursive: true }); const eu = new Euromap63Writer(o['euromap-dir'], plant); log(`Euromap 63-style files in ${o['euromap-dir']}`);
  let gw = null; if (o.gateway) { needKey(); gw = new Gateway({ platformUrl: o['platform-url'], key: o.key, mqttUrl, opcUrl: opc.url, euromapDir: o['euromap-dir'], machines: descriptors(cfg), chaos, spoolFile: o.spool, log, site: cfg.site }); await gw.start(); closers.push(() => gw.stop()); log(`gateway uplink to ${o['platform-url']}`); }
  plant.announce();
  const ctx = { plant, chaos, sender: gw?.sender }, tl = new Timeline(ctx, o.scenario, startAt, cfg.machines.length, log); log(`scenario ${o.scenario}: ${tl.about}`);

  const control = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => (raw += c));
    req.on('end', () => {
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)); };
      try {
        if (req.method === 'GET' && req.url === '/status') return send(200, { ...plant.status(), speed, chaos: chaos.counts, gateway: gw?.status() ?? null });
        if (req.method === 'GET' && req.url === '/scenarios') return send(200, { scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.about])), faults: FAULTS });
        if (req.method === 'POST' && req.url === '/act') return send(200, { ok: act(ctx, JSON.parse(raw)) });
        send(404, { error: 'GET /status, GET /scenarios, POST /act' });
      } catch (e) { send(400, { error: e.message }); }
    });
  });
  await new Promise(r => control.listen(Number(o['control-port']), r)); closers.push(() => new Promise(r => control.close(r))); log(`control port :${o['control-port']}  (GET /status, POST /act)`);

  let stopping = false; const stop = async () => { if (stopping) return; stopping = true; log('stopping'); for (const c of closers.reverse()) await c().catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);

  let lastReport = Date.now();
  const tick = () => {
    const wall = Date.now(), behind = wall - plant.now;
    sink.fast = speed > 10 || behind > 120000; // polled protocols cannot follow a fast clock, so everything rides MQTT
    // Real time by default; with --backfill the clock starts in the past and runs at --speed until it catches up with now.
    const steps = Math.min(Math.floor(behind / 1000), Math.max(1, Math.ceil(speed * 0.1)));
    for (let i = 0; i < steps; i++) { plant.step(1); if (i % 30 === 0) tl.tick(plant.now); }
    tl.tick(plant.now); if (steps > 0) eu.write();
    if (wall - lastReport > 30000) {
      lastReport = wall; const s = plant.status().machines, c = st => s.filter(m => m.state === st).length;
      log(`sim ${new Date(plant.now).toISOString().slice(0, 16)}Z${behind > 5000 ? ` (${Math.round(behind / 60000)} min behind)` : ''}  running ${c('running')}/${s.length}  down ${c('down')}  idle ${c('idle')}${gw ? `  queued ${gw.sender.depth()} sent ${gw.sender.stats.sent} rejected ${gw.sender.stats.rejected}` : ''}`);
    }
  };
  setInterval(tick, 100);
}

async function runGateway() {
  needKey(); const cfg = config(), chaos = new Chaos();
  const mqttUrl = o['mqtt-url'] || `mqtt://127.0.0.1:${o['mqtt-port']}`;
  const gw = new Gateway({ platformUrl: o['platform-url'], key: o.key, mqttUrl, opcUrl: o['opcua-url'] || `opc.tcp://127.0.0.1:${o['opcua-port']}/UA/MouldCare`, euromapDir: o['euromap-dir'], machines: descriptors(cfg), chaos, spoolFile: o.spool, log, site: cfg.site });
  await gw.start(); log(`gateway running -> ${o['platform-url']}`);
  setInterval(() => log(JSON.stringify(gw.status().uplink)), 30000);
  const stop = async () => { await gw.stop(); process.exit(0); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
const readmeHelp = () => 'Commands: provision | run [--gateway] | gateway | act \'{"action":"fault","machine":"SIM-01","kind":"heater_band_failure"}\' | scenarios\nSee simulator/README.md.';

main().catch(e => { console.error(e.message); process.exit(1); });
