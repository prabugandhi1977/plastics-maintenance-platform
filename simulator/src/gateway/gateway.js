// The gateway: collects data from every transport (MQTT subscription, OPC UA polling, Euromap 63 file polling),
// translates it to platform intake events and uplinks it with store-and-forward. This is the piece that would run
// at the plant next to the real machines; the virtual plant just feeds it.
import mqtt from 'mqtt';
import { Translator } from './translate.js';
import { SnapshotDiffer } from './differ.js';
import { Sender } from './sender.js';
import { SUBSCRIBE } from '../transports/mqtt.js';
import { OpcUaReader } from '../transports/opcua.js';
import { readEuromap63 } from '../transports/euromap63.js';

export class Gateway {
  // machines: [{ id, tag, meterId, protocol }]
  constructor({ platformUrl, key, mqttUrl, opcUrl = null, euromapDir = null, machines, chaos = null, spoolFile = null, pollMs = 2000, log = console.log, site = 'sim-plant', translator = {} }) {
    this.log = log; this.machines = machines; this.mqttUrl = mqttUrl; this.opcUrl = opcUrl; this.euromapDir = euromapDir; this.pollMs = pollMs; this.site = site;
    this.translator = new Translator(translator); this.sender = new Sender({ baseUrl: platformUrl, key, chaos, spoolFile, log });
    this.received = { mqtt: 0, opcua: 0, euromap63: 0 }; this.differs = new Map();
    for (const m of machines) if (m.protocol !== 'mqtt') this.differs.set(m.id, new SnapshotDiffer({ site, machineId: m.id, meterId: m.meterId, protocol: m.protocol }));
  }
  handle(msg, via) { this.received[via]++; for (const o of this.translator.handle(msg)) this.sender.push(o.route, o.item); }
  async start() {
    this.client = mqtt.connect(this.mqttUrl, { reconnectPeriod: 1000, clientId: `gateway-${Math.random().toString(16).slice(2, 8)}` });
    this.client.on('error', e => this.log(`gateway mqtt: ${e.message}`));
    await new Promise(res => this.client.once('connect', res));
    await new Promise((res, rej) => this.client.subscribe(SUBSCRIBE, { qos: 1 }, e => (e ? rej(e) : res())));
    this.client.on('message', (_t, buf) => { try { this.handle(JSON.parse(buf.toString()), 'mqtt'); } catch (e) { this.log(`bad MQTT message: ${e.message}`); } });
    const opcMachines = this.machines.filter(m => m.protocol === 'opcua').map(m => ({ id: m.id, tag: m.tag, deviceId: m.id }));
    if (this.opcUrl && opcMachines.length) { this.opc = new OpcUaReader(this.opcUrl, opcMachines, (m, s) => this.polled(m.id, s, 'opcua'), { log: this.log }); await this.opc.connect(); }
    this.timer = setInterval(() => this.poll().catch(e => this.log(`poll: ${e.message}`)), this.pollMs);
    this.sender.start(); return this;
  }
  polled(id, snapshot, via) { for (const msg of this.differs.get(id).feed(snapshot)) this.handle(msg, via); }
  async poll() {
    if (this.opc) await this.opc.poll();
    if (this.euromapDir) for (const m of this.machines) if (m.protocol === 'euromap63') { const s = readEuromap63(this.euromapDir, m.tag, m.id); if (s) this.polled(m.id, s, 'euromap63'); }
  }
  async stop() { clearInterval(this.timer); await this.opc?.close(); await new Promise(r => this.client.end(false, {}, r)); await this.sender.stop(); }
  status() { return { received: this.received, queued: this.sender.depth(), uplink: this.sender.stats }; }
}
