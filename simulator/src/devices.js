// Devices that sit around a machine: a 3-phase energy meter, auxiliaries (chiller, dryer, compressed air) and two
// cameras (parts inspection and safety). Each one derives what it reports from the machine it watches.
import { clamp, round } from './rng.js';

export class EnergyMeter {
  constructor(id, machine, rnd) { this.id = id; this.m = machine; this.rnd = rnd; this.lastPf = 0.88; this.offsetKwh = 0; }
  snapshot() {
    const m = this.m, kw = m.v.powerKw, r = this.rnd, off = m.state === 'offline';
    const loadFrac = clamp(kw / m.cfg.ratedKw, 0, 2);
    const pf = off ? 0 : clamp(0.62 + 0.3 * Math.min(loadFrac, 1) + 0.01 * r.gauss(), 0.4, 0.99); this.lastPf = pf;
    const volt = [0, 1, 2].map(() => (off ? 0 : 400 + 3 * r.gauss()));
    const kva = pf > 0 ? kw / pf : 0;
    const amps = volt.map((v, i) => (v > 0 ? (kva * 1000) / (Math.sqrt(3) * v) * (1 + [0.012, -0.008, -0.004][i]) : 0));
    return { meterId: this.id, at: m.now, powerKw: round(kw, 3), apparentKva: round(kva, 3), reactiveKvar: round(Math.sqrt(Math.max(0, kva * kva - kw * kw)), 3), powerFactor: round(pf, 3), voltageV: volt.map(v => round(v, 1)), currentA: amps.map(a => round(a, 2)), frequencyHz: off ? 0 : round(50 + 0.02 * r.gauss(), 3), energyKwhTotal: round(m.counters.kwh + this.offsetKwh, 3) };
  }
  // A meter that was replaced or restarted starts counting from zero again.
  resetRegister() { this.offsetKwh = -this.m.counters.kwh; }
}

export function auxiliaries(m) {
  const v = m.v, on = m.state !== 'offline';
  return {
    chiller: { status: !on ? 'off' : m.hasFault('cooling_loss') ? 'degraded' : 'ok', supplyTempC: round(v.coolingWaterTempC, 2), returnTempC: round(v.coolingWaterTempC + (m.state === 'running' ? 4.5 : 0.8), 2), flowLpm: round(on ? 38 - m.sev('cooling_loss') * 9 : 0, 1) },
    dryer: { status: !on ? 'off' : m.hasFault('material_moisture') ? 'degraded' : 'ok', dewPointC: round(v.dryerDewPointC, 1), hopperTempC: round(on ? 80 : 25, 1) },
    air: { pressureBar: round(v.airPressureBar, 2) },
    hydraulics: m.cfg.driveType === 'electric' ? null : { oilTempC: round(v.hydraulicOilTempC, 2), oilLevelPct: round(v.oilLevelPct, 1) }
  };
}

// Inspection camera: sees every part the machine makes and reports counts per interval and defect type.
export class InspectionCamera {
  constructor(id, machine) { this.id = id; this.m = machine; this.station = 'Camera 1'; this.reset(); machine.on(e => { if (e.type === 'shot') this.add(e); }); }
  reset() { this.acc = { inspected: 0, rejected: 0, defects: {} }; }
  add(shot) { const a = this.acc; a.inspected += shot.good + shot.scrap + shot.escaped; a.rejected += shot.scrap; for (const [k, n] of Object.entries(shot.defects)) a.defects[k] = (a.defects[k] ?? 0) + n; }
  flush() { const a = this.acc; this.reset(); return a; }
}

// Safety camera: occasional people-related detections in the cell while it is staffed.
export class SafetyCamera {
  constructor(id, machine, rnd, perHour = 0.5) { this.id = id; this.m = machine; this.rnd = rnd; this.perHour = perHour; }
  step(dt) {
    if (this.m.state === 'offline' || !this.rnd.chance(this.perHour * dt / 3600)) return null;
    const eventType = this.rnd.weighted([['ppe_missing', 6], ['zone_intrusion', 3], ['unsafe_act', 2], ['near_miss', 1]]);
    return { eventType, description: { ppe_missing: `No safety glasses at ${this.m.cfg.id}`, zone_intrusion: `Person inside guarded area of ${this.m.cfg.id}`, unsafe_act: `Hand in mould area while ${this.m.cfg.id} was running`, near_miss: `Dropped insert near ${this.m.cfg.id}` }[eventType] };
  }
}
