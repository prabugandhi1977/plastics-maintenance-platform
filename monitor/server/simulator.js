// Realistic machine data until real gateways are connected: each signal sits at its own level with noise and a
// daily swing (hall temperature), machines stop now and then, and three developing faults give the analysis
// something real to find. Values are deterministic per machine and minute, so a restart never rewrites history.
// Local demos only (MONITOR_SIMULATOR=true); never on a site with real machine data.
import { all, setting, saveSetting } from './db.js';
import { ingest, minute } from './ingest.js';

const DAY = 86400000, HOUR = 3600000;
// base, noise (standard deviation), daily swing amplitude
const LEVELS = {
  hydraulic_oil_temp: [45, 0.6, 1.5], pump_vibration: [2.1, 0.15, 0], barrel_zone3_temp: [230, 0.8, 0], injection_pressure: [1200, 20, 0],
  cooling_water_temp: [16, 0.3, 0.8], motor_current: [82, 3, 0], melt_pressure: [245, 5, 0], gearbox_oil_temp: [58, 0.7, 1.5],
  gearbox_vibration: [1.8, 0.12, 0], motor_load: [72, 2.5, 0], die_temp: [205, 0.6, 0], compressed_air: [7.4, 0.08, 0],
  parison_head_temp: [195, 0.6, 0], supply_temp: [12, 0.25, 0.6], compressor_current: [38, 1.5, 0], discharge_pressure: [15, 0.4, 0.6],
  dew_point: [-42, 0.8, 0], air_temp: [80, 0.5, 0], outlet_pressure: [7.5, 0.08, 0], motor_temp: [70, 1.2, 2], vibration: [1.9, 0.15, 0],
};

// Developing faults, timed from the moment the simulator first ran (the anchor).
export const FAULTS = [
  { tag: 'IMM-02', key: 'hydraulic_oil_temp', story: 'Oil cooler fouling: oil temperature rising about 2.6 °C a day', from: -3 * DAY, effect: (dt) => Math.min(23, 2.6 * dt / DAY) },
  { tag: 'BM-01', key: 'pump_vibration', story: 'Pump bearing wear: vibration stepped up and stays higher, still under the limit', from: -18 * HOUR, effect: () => 1.5 },
  { tag: 'CH-01', key: 'supply_temp', story: 'Condenser fan stopped for 90 minutes: chilled water above its limit', from: -50 * 60000, to: 40 * 60000, effect: () => 4.6 },
];

// Hash of (text, number) to a uniform number in [0,1).
function rand(seed, n) {
  let h = 2166136261 ^ n;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const gauss = (seed, n) => Math.sqrt(-2 * Math.log(rand(seed, n) || 1e-9)) * Math.cos(2 * Math.PI * rand(seed + '#', n));

// Machine state per 30-minute slot: about 2 % down, 5 % idle, the rest running. Utilities run around the clock.
const UTILITIES = ['chiller', 'dryer', 'compressor'];
export function stateAt(machine, ts) {
  if (UTILITIES.includes(machine.type)) return 'running';
  const r = rand(machine.tag + ':state', Math.floor(ts / (30 * 60000)));
  return r < 0.02 ? 'down' : r < 0.07 ? 'idle' : 'running';
}

export function valueAt(machine, key, ts, anchor) {
  const [base, sd, swing] = LEVELS[key] ?? [0, 1, 0];
  const n = Math.floor(ts / 60000);
  let v = base + sd * gauss(`${machine.tag}:${key}`, n) + swing * Math.sin(2 * Math.PI * ((ts % DAY) / DAY - 0.25));
  for (const f of FAULTS) {
    if (f.tag !== machine.tag || f.key !== key) continue;
    const dt = ts - (anchor + f.from);
    if (dt >= 0 && (f.to == null || ts < anchor + f.to)) v += f.effect(dt) * (key.includes('vibration') ? 1 + 0.1 * gauss(`${machine.tag}:f`, n) : 1);
  }
  return Math.round(v * 100) / 100;
}

function machinesWithSignals() {
  const ms = all('SELECT id,tag,type,device_id FROM machines');
  const sig = all('SELECT machine_id,key FROM signals');
  return ms.map(m => ({ ...m, keys: sig.filter(s => s.machine_id === m.id).map(s => s.key) }));
}

// Generates every minute from the last generated one up to now (7 days on the first run). Returns readings stored.
export function simulate(now = Date.now()) {
  const machines = machinesWithSignals(); if (!machines.length) return 0;
  let anchor = setting('sim_anchor');
  if (!anchor) { anchor = minute(now); saveSetting('sim_anchor', anchor); }
  const last = setting('sim_last'), end = minute(now);
  let t = last ? last + 60000 : end - 7 * DAY, stored = 0;
  const start = t;
  while (t <= end) {
    const batchEnd = Math.min(end, t + 6 * HOUR);
    const items = [];
    for (; t <= batchEnd; t += 60000) {
      for (const m of machines) {
        const state = stateAt(m, t), prev = stateAt(m, t - 60000);
        const item = { device: m.device_id, at: t };
        if (state !== prev || t === start) item.state = state;
        if (state === 'running') item.values = Object.fromEntries(m.keys.map(k => [k, valueAt(m, k, t, anchor)]));
        if (item.state || item.values) items.push(item);
      }
    }
    for (let i = 0; i < items.length; i += 2000) stored += ingest(items.slice(i, i + 2000)).reduce((a, r) => a + (r.stored || 0), 0);
  }
  saveSetting('sim_last', end);
  return stored;
}

export const simulatorEnabled = () => process.env.MONITOR_SIMULATOR === 'true';
