// Readings from gateways (PLC, OPC UA or MQTT bridges) and from the simulator take the same path. Each reading is
// one machine at one moment, any number of signal values, and optionally the machine state. Times are rounded to
// the minute; a later value for the same minute replaces the earlier one, so a gateway can safely resend.
import { db, one, all, transaction } from './db.js';
import { bad } from './http.js';

export const STATES = ['running', 'idle', 'down', 'off'];
const MAX_ITEMS = 2000, FUTURE_MS = 5 * 60000, PAST_MS = 30 * 86400000;
export const minute = ts => Math.floor(ts / 60000) * 60000;

function instant(at) {
  const ts = typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(ts)) bad('at must be an ISO time or epoch milliseconds');
  const now = Date.now();
  if (ts > now + FUTURE_MS) bad('at is in the future');
  if (ts < now - PAST_MS) bad('at is more than 30 days old');
  return minute(ts);
}

const putReading = () => db.prepare('INSERT INTO readings (machine_id,key,ts,value) VALUES (?,?,?,?) ON CONFLICT(machine_id,key,ts) DO UPDATE SET value=excluded.value');
export function setState(machineId, ts, state) {
  const last = one('SELECT state FROM states WHERE machine_id=? AND ts<=? ORDER BY ts DESC LIMIT 1', machineId, ts);
  if (last?.state === state) return false;
  db.prepare('INSERT INTO states (machine_id,ts,state) VALUES (?,?,?) ON CONFLICT(machine_id,ts) DO UPDATE SET state=excluded.state').run(machineId, ts, state);
  return true;
}

// Returns one result per item: accepted (with how many values were stored) or rejected with the reason.
export function ingest(items) {
  if (!Array.isArray(items) || !items.length) bad('readings must be a non-empty array');
  if (items.length > MAX_ITEMS) bad(`At most ${MAX_ITEMS} readings per request`);
  const machines = new Map(all('SELECT id,device_id FROM machines').map(m => [m.device_id, m.id]));
  const signals = new Map();
  for (const s of all('SELECT machine_id,key FROM signals')) (signals.get(s.machine_id) || signals.set(s.machine_id, new Set()).get(s.machine_id)).add(s.key);
  const stmt = putReading();
  return transaction(() => items.map((item, index) => {
    try {
      if (!item || typeof item !== 'object') bad('each reading must be an object');
      const machineId = machines.get(String(item.device ?? ''));
      if (!machineId) bad(`Unknown device "${item.device}"`);
      const ts = instant(item.at);
      let stored = 0; const skipped = [];
      if (item.state != null) { if (!STATES.includes(item.state)) bad(`state must be one of: ${STATES.join(', ')}`); setState(machineId, ts, item.state); }
      for (const [key, value] of Object.entries(item.values || {})) {
        if (!signals.get(machineId)?.has(key)) { skipped.push(`${key}: unknown signal`); continue; }
        if (typeof value !== 'number' || !Number.isFinite(value)) { skipped.push(`${key}: not a number`); continue; }
        stmt.run(machineId, key, ts, value); stored++;
      }
      if (!stored && item.state == null) bad(skipped.length ? `No valid values (${skipped.join('; ')})` : 'No values');
      return { index, status: 'accepted', stored, ...(skipped.length ? { skipped } : {}) };
    } catch (e) { return { index, status: 'rejected', reason: e.message }; }
  }));
}

// Running intervals [from, to) for a machine inside a window, from its state changes.
export function runningIntervals(machineId, from, to) {
  const before = one('SELECT state FROM states WHERE machine_id=? AND ts<=? ORDER BY ts DESC LIMIT 1', machineId, from);
  const changes = all('SELECT ts,state FROM states WHERE machine_id=? AND ts>? AND ts<? ORDER BY ts', machineId, from, to);
  // A machine that never reported a state is treated as running whenever it sends values.
  let state = before?.state ?? (changes.length ? null : 'running'), start = from; const out = [];
  for (const c of changes) { if (state === 'running') out.push([start, c.ts]); state = c.state; start = c.ts; }
  if (state === 'running') out.push([start, to]);
  return out;
}
export const currentState = machineId => one('SELECT state,ts FROM states WHERE machine_id=? ORDER BY ts DESC LIMIT 1', machineId) ?? null;

// Readings of one signal while the machine was running, oldest first: [{t, v}].
export function runningPoints(machineId, key, from, to = Date.now()) {
  const rows = all('SELECT ts,value FROM readings WHERE machine_id=? AND key=? AND ts>=? AND ts<? ORDER BY ts', machineId, key, from, to);
  const spans = runningIntervals(machineId, from, to); let i = 0; const out = [];
  for (const r of rows) {
    while (i < spans.length && spans[i][1] <= r.ts) i++;
    if (i < spans.length && spans[i][0] <= r.ts) out.push({ t: r.ts, v: r.value });
  }
  return out;
}
