// The virtual plant: machines with their energy meters, auxiliaries and cameras, all advanced on one simulated clock.
// Everything the devices "say" leaves the plant as bus messages { kind, deviceId, machineId, protocol, at, ...payload };
// transports (MQTT, OPC UA, Euromap 63 files) carry them, and the gateway turns them into platform events.
import { Machine } from './machine.js';
import { EnergyMeter, InspectionCamera, SafetyCamera, auxiliaries } from './devices.js';
import { rng } from './rng.js';

export const INTERVAL_MS = 15 * 60000;
const MODELS = [
  { make: 'Arburg', model: 'Allrounder 570', controller: 'Selogica', clampKn: 2000, shotVolumeCm3: 442, screwDiameterMm: 50, driveType: 'hydraulic', ratedKw: 38 },
  { make: 'Engel', model: 'e-mac 180', controller: 'CC300', clampKn: 1800, shotVolumeCm3: 301, screwDiameterMm: 40, driveType: 'electric', ratedKw: 14 },
  { make: 'KraussMaffei', model: 'CX 160', controller: 'MC6', clampKn: 1600, shotVolumeCm3: 280, screwDiameterMm: 45, driveType: 'hybrid', ratedKw: 22 },
  { make: 'Haitian', model: 'MA 2500', controller: 'Okano', clampKn: 2500, shotVolumeCm3: 560, screwDiameterMm: 55, driveType: 'hydraulic', ratedKw: 44 }
];
const PRODUCTS = [
  { partNumber: 'SIM-CAP-28', name: 'Simulated 28 mm closure', material: 'PP', partWeightG: 2.1, cycleS: 6.5, cavities: 24 },
  { partNumber: 'SIM-HSG-180', name: 'Simulated housing', material: 'PC/ABS', partWeightG: 38, cycleS: 32, cavities: 2 },
  { partNumber: 'SIM-LID-60', name: 'Simulated lid', material: 'PP', partWeightG: 9, cycleS: 14, cavities: 8 },
  { partNumber: 'SIM-GEAR-12', name: 'Simulated gear', material: 'POM', partWeightG: 3.4, cycleS: 18, cavities: 4 }
];
const PROTOCOLS = ['mqtt', 'opcua', 'euromap63'];

// Default plant: n machines, protocols rotating mqtt/opcua/euromap63, so every path is exercised.
export function defaultPlantConfig({ machines = 6, site = 'sim-plant', seed = 1, tzOffsetH = 0 } = {}) {
  const list = Array.from({ length: machines }, (_, i) => {
    const m = MODELS[i % MODELS.length], p = PRODUCTS[i % PRODUCTS.length], tag = `SIM-${String(i + 1).padStart(2, '0')}`;
    return { tag, id: `plc-${tag.toLowerCase()}`, meterId: `meter-${tag.toLowerCase()}`, cameraId: `cam-${tag.toLowerCase()}`, safetyCameraId: `safety-${tag.toLowerCase()}`,
      protocol: PROTOCOLS[i % PROTOCOLS.length], ...m, ...p, partNumber: `${p.partNumber}-${String(i + 1).padStart(2, '0')}`, serialNumber: `SIM-${m.model.replace(/\W+/g, '')}-${1000 + i}`, location: `Virtual bay ${1 + (i >> 2)}`, tzOffsetH, breaks: [[12, 30]],
      guardBypassRate: 0.0002, autoRepairMin: 90, setpoints: { meltTempC: 200 + (i % 4) * 15, mouldTempC: 30 + (i % 3) * 15, injectionPressureBar: 900 + (i % 4) * 50, holdPressureBar: 500 + (i % 3) * 40 } };
  });
  return { site, seed, machines: list };
}

export class Plant {
  constructor(config, startAt = Date.now()) {
    this.config = config; this.site = config.site; this.now = startAt; this.rnd = rng(config.seed ?? 1); this.listeners = [];
    this.machines = new Map(); this.meters = new Map(); this.inspect = new Map(); this.safety = new Map(); this.lastTelemetry = new Map();
    this.nextBoundary = (Math.floor(startAt / INTERVAL_MS) + 1) * INTERVAL_MS; this.intervalStart = this.nextBoundary - INTERVAL_MS;
    this.acc = new Map();
    for (const cfg of config.machines) {
      const r = rng(`${config.seed}:${cfg.id}`), m = new Machine(cfg, r, startAt);
      this.machines.set(cfg.id, m); this.meters.set(cfg.id, new EnergyMeter(cfg.meterId, m, r)); this.inspect.set(cfg.id, new InspectionCamera(cfg.cameraId, m)); this.safety.set(cfg.id, new SafetyCamera(cfg.safetyCameraId, m, r));
      this.acc.set(cfg.id, this.freshAcc(m));
      m.on(e => this.fromMachine(cfg, e));
    }
  }
  on(fn) { this.listeners.push(fn); return this; }
  // Devices tell the system their current state when a connection is made; call once the listeners are attached.
  announce() { for (const m of this.machines.values()) this.say('state', m.cfg, { deviceId: m.cfg.id, state: m.state, reason: m.reason, previous: null }); return this; }
  say(kind, cfg, payload, at = this.now) { const msg = { kind, site: this.site, machineId: cfg.id, protocol: cfg.protocol, at, ...payload }; for (const fn of this.listeners) fn(msg); }
  freshAcc(m) { return { good: 0, scrap: 0, kwh0: m.counters.kwh, peakKw: 0, partNumber: m.cfg.partNumber, runSeconds: 0 }; }

  fromMachine(cfg, e) {
    if (e.type === 'state') this.say('state', cfg, { deviceId: cfg.id, state: e.state, reason: e.reason, previous: e.previous }, e.at);
    else if (e.type === 'alarm') this.say('alarm', cfg, { deviceId: cfg.id, code: e.code, severity: e.severity, message: e.message, alarmState: e.alarmState }, e.at);
    else if (e.type === 'shot') { const a = this.acc.get(cfg.id); a.good += e.good; a.scrap += e.scrap; a.partNumber = e.partNumber ?? a.partNumber; this.say('shot', cfg, { deviceId: cfg.id, ...e }, e.at); }
    else if (e.type === 'safety') this.say('safety', cfg, { deviceId: cfg.safetyCameraId, eventType: e.eventType, description: e.description, source: 'sensor' }, e.at);
    else if (e.type === 'fault') this.say('fault', cfg, { deviceId: cfg.id, faultKind: e.kind, action: e.action }, e.at);
  }

  step(dt = 1) {
    this.now += dt * 1000;
    for (const [id, m] of this.machines) {
      m.step(dt, this.now); const cfg = m.cfg, a = this.acc.get(id);
      a.peakKw = Math.max(a.peakKw, m.v.powerKw);
      const cam = this.safety.get(id).step(dt); if (cam) this.say('safety', cfg, { deviceId: cfg.safetyCameraId, ...cam, source: 'camera' });
      const last = this.lastTelemetry.get(id) ?? 0;
      if (this.now - last >= 10000) {
        this.lastTelemetry.set(id, this.now);
        this.say('telemetry', cfg, { deviceId: cfg.id, ...m.snapshot() });
        this.say('meter', cfg, { deviceId: cfg.meterId, ...this.meters.get(id).snapshot() });
        if ((Math.floor(this.now / 10000) % 3) === 0) this.say('aux', cfg, { deviceId: cfg.id, ...auxiliaries(m) });
      }
    }
    while (this.now >= this.nextBoundary) this.closeInterval();
  }

  closeInterval() {
    const periodStart = this.intervalStart, end = this.nextBoundary;
    for (const [id, m] of this.machines) {
      const cfg = m.cfg, a = this.acc.get(id), cam = this.inspect.get(id).flush();
      this.say('interval', cfg, { deviceId: cfg.id, periodStart, periodMinutes: 15, meterId: cfg.meterId, good: a.good, scrap: a.scrap, partNumber: a.partNumber, kwh: m.counters.kwh - a.kwh0, peakKw: a.peakKw, state: m.state }, end);
      this.say('inspection', cfg, { deviceId: cfg.cameraId, station: this.inspect.get(id).station, periodStart, periodMinutes: 15, ...cam }, end);
      this.acc.set(id, this.freshAcc(m));
    }
    this.intervalStart = end; this.nextBoundary = end + INTERVAL_MS;
  }

  machine(idOrTag) { return this.machines.get(idOrTag) ?? [...this.machines.values()].find(m => m.cfg.tag === idOrTag || m.cfg.tag?.toLowerCase() === String(idOrTag).toLowerCase()); }
  status() { return { site: this.site, at: new Date(this.now).toISOString(), machines: [...this.machines.values()].map(m => { const s = m.snapshot(); return { id: m.cfg.id, tag: m.cfg.tag, protocol: m.cfg.protocol, state: s.state, reason: s.reason, partNumber: s.partNumber, cycleCount: s.counters.cycleCount, kwh: s.counters.kwh, powerKw: s.values.powerKw, alarms: s.alarms.map(a => a.code), faults: s.faults }; }) }; }
}
