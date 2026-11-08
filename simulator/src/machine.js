// A virtual injection-moulding machine. It runs real cycles (phases, pressures, temperatures, power), wears slowly,
// can be given faults that develop over time, makes good and bad parts according to how far its process has drifted,
// and reports everything through discrete events plus a snapshot() of current values. It knows nothing about MQTT,
// OPC UA or the platform: transports and the gateway only read from it.
import { clamp, round } from './rng.js';

export const PHASES = [['clamp_close', 0.08], ['injection', 0.10], ['hold', 0.17], ['cooling', 0.47], ['mould_open', 0.08], ['eject', 0.10]];
// Power in each phase relative to the machine's average running power (hydraulic profile; mean over a cycle is ~1).
const PHASE_POWER = { clamp_close: 1.6, injection: 2.4, hold: 0.9, cooling: 0.55, mould_open: 1.5, eject: 0.8 };
const MEAN_FACTOR = PHASES.reduce((s, [p, f]) => s + PHASE_POWER[p] * f, 0);
const STATE_POWER = { idle: 0.30, setup: 0.25, down: 0.12, planned_stop: 0.20, offline: 0 };
export const FAULTS = {
  hydraulic_pressure_loss: 'Injection/hold pressure cannot be reached (worn pump, leaking valve).',
  heater_band_failure: 'A barrel heater band fails; melt temperature falls, short shots follow.',
  cooling_loss: 'Chiller or cooling circuit loses capacity; water, mould and oil temperatures rise.',
  bearing_wear: 'Pump or motor bearing wears; vibration climbs towards damage level.',
  mould_wear: 'Mould parting line wears; flash grows.',
  oil_overheat: 'Hydraulic oil cooler fouled; oil temperature rises.',
  material_moisture: 'Dryer fault; wet resin causes splay.',
  power_failure: 'Mains supply lost; the whole cell goes dark.'
};
const BREAKDOWN_AFTER_S = 180;

export class Machine {
  constructor(cfg, rnd, now) {
    this.cfg = { clampKn: 1800, driveType: 'hydraulic', ratedKw: 25, cycleS: 20, cavities: 4, partWeightG: 12, ...cfg };
    this.cfg.setpoints = { meltTempC: 230, mouldTempC: 40, injectionPressureBar: 950, holdPressureBar: 520, ...cfg.setpoints };
    this.rnd = rnd; this.now = now; this.listeners = [];
    this.state = 'idle'; this.reason = 'waiting for operator'; this.stateSince = now;
    this.phase = 'clamp_close'; this.phaseLeft = 0; this.cycleElapsed = 0; this.cycleLength = this.cfg.cycleS;
    this.counters = { cycleCount: cfg.startCycleCount ?? 0, runningHours: cfg.startHours ?? 0, good: 0, scrap: 0, escaped: 0, kwh: cfg.startKwh ?? 0 };
    this.wear = { bearing: 0, mould: 0, heater: 0, cooling: 0, hydraulic: 0, oilCooler: 0, moisture: 0 };
    this.faults = []; this.alarms = new Map(); this.criticalSince = null; this.stopUntil = null; this.nextMinorStop = now + this.expo(4 * 3600) * 1000;
    const sp = this.cfg.setpoints;
    this.v = { meltTempC: sp.meltTempC, mouldTempC: sp.mouldTempC, injectionPressureBar: 0, holdPressureBar: 0, cycleTimeS: this.cfg.cycleS, cushionMm: 5, hydraulicOilTempC: 38, coolingWaterTempC: 16, vibrationMmS: 0.3, screwRpm: 0, powerKw: 0, dryerDewPointC: -40, airPressureBar: 6.5, oilLevelPct: 92 };
    this.shot = null; this.batch = null; this.order = null; this.breaks = cfg.breaks ?? [];
    if (cfg.startRunning !== false) this.setState('running', null);
  }
  on(fn) { this.listeners.push(fn); return this; }
  emit(type, data) { for (const fn of this.listeners) fn({ type, deviceId: this.cfg.id, at: this.now, ...data }); }
  expo(mean) { return -Math.log(1 - this.rnd.next()) * mean; }

  setState(state, reason) {
    if (this.state === state && this.reason === reason) return;
    const previous = this.state; this.state = state; this.reason = reason; this.stateSince = this.now;
    if (state === 'running') { this.phase = 'clamp_close'; this.cycleElapsed = 0; this.cycleLength = this.nextCycleLength(); this.phaseLeft = this.cycleLength * PHASES[0][1]; }
    this.emit('state', { state, reason, previous });
  }
  nextCycleLength() { return Math.max(1, this.cfg.cycleS * (1 + 0.012 * this.rnd.gauss()) * (1 + 0.25 * this.sev('cooling_loss')) * (1 + this.wear.cooling * 0.1)); }

  // ---- faults -----------------------------------------------------------------------------------------------
  // A fault develops over rampS seconds, stays for holdS (null = until repaired), then recovers over recoverS.
  inject(kind, { rampS = 1800, holdS = null, recoverS = 60, strength = 1 } = {}) {
    if (!FAULTS[kind]) throw new Error(`Unknown fault ${kind}. Known: ${Object.keys(FAULTS).join(', ')}`);
    const f = { kind, start: this.now, rampS: Math.max(1, rampS), holdS, recoverS: Math.max(1, recoverS), strength: clamp(strength, 0, 1), repairedAt: null };
    this.faults.push(f); this.emit('fault', { kind, action: 'started', rampS });
    if (kind === 'power_failure') { this.setState('offline', 'power failure'); this.emit('safety', { eventType: 'unsafe_condition', description: 'Power failure on machine' }); }
    return f;
  }
  repair(kind) { for (const f of this.faults) if ((!kind || f.kind === kind) && f.repairedAt == null) { f.repairedAt = this.now; f.holdS = Math.min(f.holdS ?? Infinity, Math.max(0, this.age(f) - f.rampS)); this.emit('fault', { kind: f.kind, action: 'repaired' }); } }
  age(f) { return (this.now - f.start) / 1000; }
  sev(kind) {
    let s = 0;
    for (const f of this.faults) {
      if (f.kind !== kind) continue;
      const age = this.age(f); let k;
      if (age < f.rampS) k = age / f.rampS;
      else if (f.holdS == null || age < f.rampS + f.holdS) k = 1;
      else k = 1 - (age - f.rampS - f.holdS) / f.recoverS;
      s = Math.max(s, clamp(k, 0, 1) * f.strength);
    }
    return s;
  }
  activeFaults() { return this.faults.filter(f => this.sev(f.kind) > 0 || (f.holdS == null && f.repairedAt == null)); }
  faultOpen(kind) { return this.faults.some(f => f.kind === kind && (f.holdS == null ? f.repairedAt == null : this.age(f) < f.rampS + f.holdS)); }
  hasFault(kind) { return this.sev(kind) > 0; }

  // ---- time -------------------------------------------------------------------------------------------------
  step(dt, now = this.now + dt * 1000) {
    this.now = now;
    this.faults = this.faults.filter(f => f.holdS == null || f.repairedAt == null || this.age(f) < f.rampS + f.holdS + f.recoverS);
    this.schedule();
    if (this.state === 'running') this.runCycle(dt);
    this.thermal(dt); this.power(dt); this.evaluateAlarms(dt);
    if (this.state !== 'offline') this.counters.runningHours += this.state === 'running' ? dt / 3600 : 0;
  }
  localHour() { const d = new Date(this.now + (this.cfg.tzOffsetH ?? 0) * 3600000); return d.getUTCHours() + d.getUTCMinutes() / 60; }

  schedule() {
    const s = this.state;
    if (s === 'offline') { if (!this.faultOpen('power_failure')) { this.setState('down', 'power failure'); this.stopUntil = this.now + 60000; } return; }
    if (s === 'down') {
      const hold = this.activeFaults().some(f => f.kind !== 'power_failure' && f.holdS == null && f.repairedAt == null);
      const waitingRepair = this.cfg.autoRepairMin != null && this.now - this.stateSince >= this.cfg.autoRepairMin * 60000;
      if (waitingRepair && hold) this.repair();
      if (!this.hasBlockingFault() && (!this.stopUntil || this.now >= this.stopUntil)) { this.criticalSince = null; this.setState('setup', 'start-up'); this.stopUntil = this.now + 5 * 60000; }
      return;
    }
    if (s === 'setup' || s === 'idle' || s === 'planned_stop') {
      if (this.stopUntil && this.now < this.stopUntil) return;
      if (this.hasBlockingFault()) { this.stopUntil = null; this.setState('down', 'breakdown'); return; }
      if (s === 'planned_stop' || s === 'setup' || s === 'idle') { this.stopUntil = null; this.setState('running', null); }
      return;
    }
    // running
    if (this.criticalSince != null && this.now - this.criticalSince >= BREAKDOWN_AFTER_S * 1000) { this.setState('down', 'breakdown'); return; }
    const h = this.localHour();
    for (const [start, mins] of this.breaks) if (h >= start && h < start + mins / 60 && this.now - this.stateSince > 1000) { this.stopUntil = this.now + mins * 60000; this.setState('planned_stop', 'break'); return; }
    if (this.now >= this.nextMinorStop) {
      this.nextMinorStop = this.now + this.expo(5 * 3600) * 1000;
      const [reason, lo, hi] = this.rnd.weighted([[['minor stop', 2, 6], 5], [['waiting for material', 5, 20], 2], [['waiting for operator', 3, 12], 2], [['waiting for quality approval', 10, 30], 1]]);
      this.stopUntil = this.now + this.rnd.between(lo, hi) * 60000; this.setState('idle', reason);
    }
  }
  hasBlockingFault() { return ['heater_band_failure', 'hydraulic_pressure_loss', 'bearing_wear', 'oil_overheat'].some(k => this.sev(k) >= 0.95) || this.faultOpen('power_failure'); }

  // A controller restart or replacement: its counters start again from zero.
  resetCounters() { this.counters.cycleCount = 0; this.counters.runningHours = 0; this.emit('fault', { kind: 'controller_reset', action: 'started' }); }

  changeOver(order, minutes = 30) {
    this.order = order; if (order?.cycleS) this.cfg.cycleS = order.cycleS; if (order?.cavities) this.cfg.cavities = order.cavities; if (order?.partWeightG) this.cfg.partWeightG = order.partWeightG;
    if (order?.partNumber) this.cfg.partNumber = order.partNumber; if (order?.setpoints) Object.assign(this.cfg.setpoints, order.setpoints);
    this.wear.mould = order?.freshMould ? 0 : this.wear.mould; this.stopUntil = this.now + minutes * 60000; this.setState('setup', 'mould change');
  }

  // ---- cycle ------------------------------------------------------------------------------------------------
  runCycle(dt) {
    let left = dt;
    while (left > 0 && this.state === 'running') {
      const use = Math.min(left, this.phaseLeft); this.phaseLeft -= use; this.cycleElapsed += use; left -= use;
      if (this.phaseLeft <= 1e-9) {
        const i = PHASES.findIndex(([p]) => p === this.phase);
        if (i === PHASES.length - 1) { this.completeShot(); this.cycleLength = this.nextCycleLength(); this.cycleElapsed = 0; this.phase = PHASES[0][0]; this.phaseLeft = this.cycleLength * PHASES[0][1]; }
        else { this.phase = PHASES[i + 1][0]; this.phaseLeft = this.cycleLength * PHASES[i + 1][1]; }
      }
    }
  }
  achieved() {
    const sp = this.cfg.setpoints, hyd = clamp(this.sev('hydraulic_pressure_loss') * 0.30 + this.wear.hydraulic * 0.05, 0, 0.6), n = () => 1 + 0.008 * this.rnd.gauss();
    return { injectionPressureBar: sp.injectionPressureBar * (1 - hyd) * n(), holdPressureBar: sp.holdPressureBar * (1 - hyd * 0.9) * n() };
  }
  defectWeights() {
    const sp = this.cfg.setpoints, v = this.v, w = {};
    const melt = v.meltTempC - sp.meltTempC, hold = v.holdPressureBar / sp.holdPressureBar - 1, inj = v.injectionPressureBar / sp.injectionPressureBar - 1;
    w.short_shot = Math.max(0, -melt - 6) * 0.0035 + Math.max(0, -inj - 0.06) * 0.5;
    w.flash = this.wear.mould * 0.12 + this.sev('mould_wear') * 0.16 + Math.max(0, hold - 0.05) * 0.6;
    w.burn_mark = Math.max(0, melt - 12) * 0.004;
    w.sink_mark = Math.max(0, v.mouldTempC - sp.mouldTempC - 4) * 0.006 + Math.max(0, -hold - 0.08) * 0.4;
    w.warpage = Math.max(0, v.mouldTempC - sp.mouldTempC - 8) * 0.004;
    w.splay = this.sev('material_moisture') * 0.12 + this.wear.moisture * 0.05;
    w.black_spot = 0.0015; w.weld_line = Math.max(0, -melt - 12) * 0.0015 + 0.0008; w.dimensional = 0.001 + this.wear.mould * 0.01; w.colour_variation = 0.0006;
    return w;
  }
  completeShot() {
    const c = this.cfg, w = this.defectWeights(), total = Object.values(w).reduce((s, x) => s + x, 0), pDefect = clamp(total, 0, 0.9);
    let good = 0, scrap = 0, escaped = 0; const defects = {};
    for (let i = 0; i < c.cavities; i++) {
      if (this.rnd.chance(pDefect)) {
        if (this.rnd.chance(0.97)) { scrap++; const d = this.rnd.weighted(Object.entries(w).filter(([, x]) => x > 0)); defects[d] = (defects[d] ?? 0) + 1; } else escaped++;
      } else if (this.rnd.chance(0.002)) { scrap++; defects.black_spot = (defects.black_spot ?? 0) + 1; } // camera false reject
      else good++;
    }
    this.counters.cycleCount++; this.counters.good += good; this.counters.scrap += scrap; this.counters.escaped += escaped;
    this.wear.bearing += 1e-7; this.wear.mould += 4e-7; this.wear.hydraulic += 2e-7; this.wear.cooling += 1.5e-7;
    this.shot = { n: this.counters.cycleCount, at: this.now, cycleTimeS: round(this.cycleLength, 2), meltTempC: round(this.v.meltTempC, 1), mouldTempC: round(this.v.mouldTempC, 1), injectionPressureBar: round(this.v.injectionPressureBar, 0), holdPressureBar: round(this.v.holdPressureBar, 0), cushionMm: round(this.v.cushionMm, 2), good, scrap, escaped, defects, partNumber: c.partNumber ?? null };
    this.emit('shot', this.shot);
    if (this.cfg.guardBypassRate && this.rnd.chance(this.cfg.guardBypassRate)) this.emit('safety', { eventType: 'guard_bypassed', description: `Operator gate bypass detected on ${c.id}` });
  }

  // ---- physics ----------------------------------------------------------------------------------------------
  thermal(dt) {
    const sp = this.cfg.setpoints, v = this.v, r = this.rnd, running = this.state === 'running', powered = this.state !== 'offline';
    const load = clamp(v.powerKw / this.cfg.ratedKw, 0, 3), hydraulic = this.cfg.driveType !== 'electric';
    const lag = (cur, target, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
    const heaterLoss = this.sev('heater_band_failure') * 42 + this.wear.heater * 6;
    v.meltTempC = powered ? lag(v.meltTempC, sp.meltTempC - heaterLoss + 0.8 * r.gauss(), this.sev('heater_band_failure') > 0 ? 120 : 30) : lag(v.meltTempC, 25, 3600);
    const cool = 16 + 1.0 * r.gauss() * 0.3 + this.sev('cooling_loss') * 15 + this.wear.cooling * 3;
    v.coolingWaterTempC = powered ? lag(v.coolingWaterTempC, cool, 120) : lag(v.coolingWaterTempC, 28, 3600);
    v.mouldTempC = lag(v.mouldTempC, powered ? sp.mouldTempC + (v.coolingWaterTempC - 16) * 0.55 + (running ? 0.4 * r.gauss() : -2) : 25, 240);
    const oilTarget = 38 + 14 * Math.min(load, 1.4) + this.sev('oil_overheat') * 30 + this.sev('cooling_loss') * 6 + this.wear.oilCooler * 4;
    v.hydraulicOilTempC = powered ? lag(v.hydraulicOilTempC, hydraulic ? oilTarget : 30, 900) : lag(v.hydraulicOilTempC, 25, 3600);
    const vib = this.state === 'running' ? 1.7 + 0.25 * r.gauss() + this.sev('bearing_wear') * 8 + this.wear.bearing * 1.5 : this.state === 'offline' || this.state === 'down' ? 0.1 : 0.4;
    v.vibrationMmS = Math.max(0.05, lag(v.vibrationMmS, vib, 5));
    if (running) {
      const a = this.achieved(); const into = this.phase === 'injection' ? a.injectionPressureBar : this.phase === 'hold' ? a.holdPressureBar : 0;
      v.injectionPressureBar = this.phase === 'injection' ? a.injectionPressureBar : v.injectionPressureBar; v.holdPressureBar = this.phase === 'hold' ? a.holdPressureBar : v.holdPressureBar;
      v.screwRpm = this.phase === 'cooling' ? 140 : 0; void into;
      v.cushionMm = 5 + 0.12 * r.gauss() + this.sev('hydraulic_pressure_loss') * 1.4;
    } else v.screwRpm = 0;
    v.cycleTimeS = this.cycleLength;
    v.dryerDewPointC = -40 + this.sev('material_moisture') * 32 + 0.5 * r.gauss();
    v.airPressureBar = 6.5 + 0.05 * r.gauss(); v.oilLevelPct = 92 - this.wear.hydraulic * 100;
  }
  power(dt) {
    const R = this.cfg.ratedKw, s = this.state, r = this.rnd;
    let kw;
    if (s === 'running') { const f = PHASE_POWER[this.phase] / MEAN_FACTOR; kw = R * (0.25 + 0.75 * f); } else kw = R * (STATE_POWER[s] ?? 0.2);
    if (s !== 'offline') kw *= 1 + 0.015 * r.gauss() + this.sev('cooling_loss') * 0.05 + this.sev('hydraulic_pressure_loss') * 0.06;
    this.v.powerKw = kw; this.counters.kwh += kw * dt / 3600;
  }
  evaluateAlarms(dt) {
    const sp = this.cfg.setpoints, v = this.v, running = this.state === 'running', defs = [];
    if (running) {
      const inj = v.injectionPressureBar / sp.injectionPressureBar;
      defs.push(['E-204', 'warning', 'Hydraulic pressure below setpoint', inj < 0.92 && this.phase !== 'clamp_close'], ['E-205', 'critical', 'Hydraulic pressure far below setpoint', inj < 0.80 && this.phase !== 'clamp_close'], ['T-301', 'warning', 'Barrel temperature below setpoint', v.meltTempC < sp.meltTempC - 10], ['T-302', 'critical', 'Barrel heater zone 3 temperature low', v.meltTempC < sp.meltTempC - 25]);
    }
    const on = this.state !== 'offline';
    defs.push(['C-110', 'warning', 'Cooling water temperature high', on && v.coolingWaterTempC > 22], ['C-111', 'critical', 'Cooling water temperature very high', on && v.coolingWaterTempC > 28], ['V-410', 'warning', 'Pump vibration high', on && v.vibrationMmS > 4.5], ['V-411', 'critical', 'Pump vibration critical', on && v.vibrationMmS > 7.1], ['O-120', 'warning', 'Hydraulic oil temperature high', on && this.cfg.driveType !== 'electric' && v.hydraulicOilTempC > 55], ['O-121', 'critical', 'Hydraulic oil temperature critical', on && this.cfg.driveType !== 'electric' && v.hydraulicOilTempC > 65], ['D-210', 'warning', 'Dryer dew point high', on && v.dryerDewPointC > -25]);
    let critical = false;
    for (const [code, severity, message, active] of defs) {
      const has = this.alarms.has(code);
      if (active && !has) { this.alarms.set(code, { code, severity, message, since: this.now }); this.emit('alarm', { code, severity, message, alarmState: 'active' }); }
      if (!active && has && !(code.startsWith('T-30') && !running)) { this.alarms.delete(code); this.emit('alarm', { code, severity, message, alarmState: 'cleared' }); }
      if (active && severity === 'critical') critical = true;
    }
    if (running) this.criticalSince = critical ? (this.criticalSince ?? this.now) : null;
  }

  snapshot() {
    const v = this.v, c = this.counters;
    return { deviceId: this.cfg.id, at: this.now, state: this.state, reason: this.reason, phase: this.state === 'running' ? this.phase : null, values: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x, 2)])), counters: { ...c, runningHours: round(c.runningHours, 3), kwh: round(c.kwh, 3) }, alarms: [...this.alarms.values()], faults: this.activeFaults().map(f => f.kind), partNumber: this.cfg.partNumber ?? null, driveType: this.cfg.driveType, setpoints: { ...this.cfg.setpoints }, cycleS: this.cfg.cycleS, shot: this.shot };
  }
}
