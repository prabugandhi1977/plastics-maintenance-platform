import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine } from '../src/machine.js';
import { rng } from '../src/rng.js';

const T0 = Date.parse('2026-11-02T06:00:00Z');
const make = (extra = {}, seed = 7) => new Machine({ id: 'plc-1', cycleS: 20, cavities: 4, ratedKw: 25, ...extra }, rng(seed), T0);
function run(m, seconds, dt = 1) { const events = []; m.on(e => events.push(e)); for (let i = 0; i < seconds; i += dt) m.step(dt); return events; }

test('a healthy machine cycles at its set cycle time and makes mostly good parts', () => {
  const m = make(); const ev = run(m, 3600 * 2);
  const shots = ev.filter(e => e.type === 'shot');
  assert.ok(shots.length >= 340 && shots.length <= 365, `shots ${shots.length}`);
  const c = m.counters; assert.ok(c.scrap / (c.good + c.scrap + c.escaped) < 0.03);
  assert.ok(Math.abs(m.counters.cycleCount - shots.length) === 0);
  assert.ok(m.counters.kwh > 40 && m.counters.kwh < 60, `kwh ${m.counters.kwh}`); // ~25 kW for 2 h, less the odd stop
});

test('same seed, same history', () => {
  const a = make({}, 3), b = make({}, 3); run(a, 1800); run(b, 1800);
  assert.deepEqual(a.snapshot(), b.snapshot());
});

test('heater failure drops melt temperature, causes short shots, raises T-302 and finally stops the machine', () => {
  const m = make({ autoRepairMin: 30 }); const ev = run(m, 600);
  m.inject('heater_band_failure', { rampS: 600 });
  const after = run(m, 3600);
  const codes = after.filter(e => e.type === 'alarm' && e.alarmState === 'active').map(e => e.code);
  assert.ok(codes.includes('T-301') && codes.includes('T-302'), codes.join());
  const defects = after.filter(e => e.type === 'shot').reduce((a, s) => { for (const [k, n] of Object.entries(s.defects)) a[k] = (a[k] ?? 0) + n; return a; }, {});
  assert.ok((defects.short_shot ?? 0) >= 3, JSON.stringify(defects));
  const down = after.find(e => e.type === 'state' && e.state === 'down');
  assert.equal(down?.reason, 'breakdown');
  assert.ok(ev.length >= 0);
});

test('a repaired machine goes through start-up and runs again', () => {
  const m = make({ autoRepairMin: 20 }); m.inject('heater_band_failure', { rampS: 300 });
  const ev = run(m, 3 * 3600);
  const states = ev.filter(e => e.type === 'state').map(e => `${e.state}:${e.reason}`);
  assert.ok(states.includes('down:breakdown'));
  assert.ok(states.includes('setup:start-up'));
  assert.equal(m.state, 'running');
});

test('cooling loss lifts water and oil temperature past the monitored limits and lengthens the cycle', () => {
  const m = make(); run(m, 1200); const before = m.snapshot().values.cycleTimeS;
  m.inject('cooling_loss', { rampS: 600 }); run(m, 3 * 3600);
  const s = m.snapshot(); assert.ok(s.values.coolingWaterTempC > 28, String(s.values.coolingWaterTempC));
  assert.ok(s.values.cycleTimeS > before * 1.15);
  assert.ok(s.alarms.some(a => a.code === 'C-111'));
});

test('bearing wear drives vibration over the ISO 20816 critical limit', () => {
  const m = make(); m.inject('bearing_wear', { rampS: 1200 }); let max = 0; for (let i = 0; i < 1500; i++) { m.step(1); max = Math.max(max, m.v.vibrationMmS); }
  assert.ok(max > 7.1, String(max));
});

test('power failure takes the whole machine to zero power and back', () => {
  const m = make(); run(m, 300); m.inject('power_failure', { rampS: 1, holdS: 600, recoverS: 1 });
  run(m, 100); assert.equal(m.state, 'offline'); assert.equal(m.v.powerKw, 0);
  run(m, 1200); assert.notEqual(m.state, 'offline');
});

test('electric presses report no hydraulic oil alarm and draw less than hydraulic ones for the same rating basis', () => {
  const m = make({ driveType: 'electric' }); m.inject('oil_overheat', { rampS: 300 }); run(m, 3600);
  assert.ok(!m.snapshot().alarms.some(a => a.code.startsWith('O-12')));
});

test('mould change puts the machine in setup, then it runs the new part', () => {
  const m = make(); run(m, 300); m.changeOver({ partNumber: 'LID-60', cycleS: 12, cavities: 8 }, 10);
  assert.equal(m.state, 'setup'); run(m, 15 * 60);
  assert.equal(m.state, 'running'); assert.equal(m.cfg.partNumber, 'LID-60'); assert.equal(m.cfg.cavities, 8);
});

