// Shared by the connector drivers: turning raw machine values into numbers for ingest(), and machine states.
import { STATES } from '../ingest.js';

// A raw value as a number, or null when it is not one (true/false count as 1/0; Int64 comes as [high, low]).
export function numberOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v) && v.length === 2 && v.every(x => Number.isInteger(x))) return v[0] * 2 ** 32 + (v[1] >>> 0);
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v.trim().replace(',', '.')); return Number.isFinite(n) ? n : null; }
  return null;
}
// value × scale + offset, rounded to remove float noise (0.1 × 3 = 0.30000000000000004).
export const scaled = (v, m = {}) => { const n = v * (m.scale ?? 1) + (m.offset ?? 0); return Math.round(n * 1e9) / 1e9; };

// The text of a raw state value: numbers as they are, LocalizedText by its text, enumerations by value.
export function stateText(v) {
  if (v == null) return '';
  if (typeof v === 'object' && 'text' in v) return String(v.text ?? '');
  if (typeof v === 'object' && 'value' in v) return String(v.value);
  return String(v).trim();
}
// Monitor state for a raw value, using the connector's map (keys compared without case); null when not mapped.
export function mapState(raw, map = {}) {
  const t = stateText(raw).toLowerCase();
  for (const [k, s] of Object.entries(map)) if (String(k).toLowerCase() === t) return s;
  if (STATES.includes(t)) return t;
  return null;
}

// Euromap 77 / OPC 40083: MachineModeEnumeration (0 Other, 1 Automatic, 2 Semi-automatic, 3 Manual, 4 Setup, 5 Sleep),
// by number and by name. Automatic production counts as running; manual and setup as idle; sleep as off. A machine
// that reports a separate alarm or error flag can map it to "down" with its own map.
export const EUROMAP77_STATES = { 0: 'idle', 1: 'running', 2: 'running', 3: 'idle', 4: 'idle', 5: 'off',
  other: 'idle', automatic: 'running', semi_automatic: 'running', manual: 'idle', setup: 'idle', sleep: 'off',
  error: 'down', alarm: 'down', fault: 'down', stopped: 'idle', production: 'running', off: 'off' };

// A timeout around a promise, with a message that says what took too long.
export function within(ms, promise, what) {
  let t; const timeout = new Promise((_, no) => { t = setTimeout(() => no(new Error(`${what} timed out after ${ms / 1000} s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
