// Connector settings: checking what the super user enters, keeping the OPC UA password safe, and the shape the API
// returns (never with a password, encrypted or not).
//
// Passwords: either typed in Settings and stored encrypted (AES-256-GCM with a key derived from MONITOR_SECRET, so a
// copy of the database alone does not reveal them), or the name of an environment variable that holds it. Only
// variables named MONITOR_CONNECTOR_* may be used, so a connector can never be pointed at another secret on the
// server (such as ANTHROPIC_API_KEY) and send it to a machine.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { one, all, DATA_DIR } from '../db.js';
import { bad, text } from '../http.js';
import { keyFor } from '../auth.js';
import { STATES } from '../ingest.js';
import { FUNCTIONS, TYPES, hostPort } from './modbus.js';
import { PARAM } from './euromap63.js';
import { SECURITY, POLICIES, validNodeId } from './opcua.js';

export const CONNECTOR_TYPES = { opcua: 'OPC UA / Euromap 77', euromap63: 'Euromap 63 (file exchange)', modbus: 'Modbus TCP' };
export const MAX_SIGNALS = 40;
export const euromapRoot = () => resolve(process.env.MONITOR_EUROMAP63_ROOT?.trim() || join(DATA_DIR, 'euromap63'));

// ---- Credentials ----
let key = null;
const cryptoKey = () => key ??= keyFor('connector-credentials');
export function encrypt(plain) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', cryptoKey(), iv), data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join(':');
}
export function decrypt(sealed) {
  const [v, iv, tag, data] = String(sealed).split(':');
  if (v !== 'v1') throw new Error('The stored password is in an unknown format. Enter it again.');
  try { const d = createDecipheriv('aes-256-gcm', cryptoKey(), Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url')); return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8'); }
  catch { throw new Error('The stored password cannot be read (MONITOR_SECRET changed?). Enter it again.'); }
}
export const ENV_NAME = /^MONITOR_CONNECTOR_[A-Z0-9_]{1,60}$/;
export function passwordOf(row) {
  if (row.password_env) { const v = process.env[row.password_env]; if (v == null) throw new Error(`The environment variable ${row.password_env} is not set on the server`); return v; }
  return row.password_enc ? decrypt(row.password_enc) : '';
}

// ---- Validation ----
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v, name, min, max, { int = false, fallback } = {}) => {
  if (v == null || v === '') { if (fallback !== undefined) return fallback; bad(`${name} is required`); }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) bad(`${name} must be ${int ? 'a whole number' : 'a number'} from ${min} to ${max}`);
  return n;
};
const optional = (v, name) => v == null || v === '' ? undefined : num(v, name, -1e12, 1e12);
const pick = (v, name, options, fallback) => { if (v == null || v === '') return fallback; if (!options.includes(v)) bad(`${name} must be one of: ${options.join(', ')}`); return v; };
const scaleOf = (m, where) => { const out = {}; const s = optional(m.scale, `${where}: scale`), o = optional(m.offset, `${where}: offset`); if (s !== undefined) out.scale = s; if (o !== undefined) out.offset = o; return out; };

export function stateMapOf(map, where = 'state map') {
  if (map == null) return {};
  if (!isObj(map)) bad(`${where} must be an object of value → state, e.g. {"1": "running", "0": "off"}`);
  const out = {}, entries = Object.entries(map);
  if (entries.length > 50) bad(`${where} can have at most 50 values`);
  for (const [k, s] of entries) { if (String(k).length > 60) bad(`${where}: "${k}" is too long`); if (!STATES.includes(s)) bad(`${where}: "${k}" must map to one of ${STATES.join(', ')}`); out[String(k)] = s; }
  return out;
}

// Each type: endpoint, mapping entry and the state source.
const RULES = {
  opcua: {
    endpoint(v) {
      const e = text(v, 'endpoint', 300);
      if (!/^opc\.tcp:\/\/[^\s/@]+(\/\S*)?$/i.test(e)) bad('An OPC UA endpoint looks like opc.tcp://192.168.10.20:4840 (no user name or password in it)');
      return e;
    },
    entry(m, where) { const node = typeof m === 'string' ? m : m?.node; if (typeof node !== 'string' || !validNodeId(node.trim())) bad(`${where}: node must be an OPC UA node ID, e.g. ns=2;s=Machine.OilTemp`); return { node: node.trim(), ...(isObj(m) ? scaleOf(m, where) : {}) }; },
    state(s) { if (!s.node) return null; return { node: RULES.opcua.entry(s.node, 'state').node, map: stateMapOf(s.map) }; },
    options(o) {
      const securityMode = pick(o.securityMode, 'securityMode', Object.keys(SECURITY), 'None');
      return { securityMode, securityPolicy: pick(o.securityPolicy, 'securityPolicy', Object.keys(POLICIES), securityMode === 'None' ? 'None' : 'Basic256Sha256'),
        readMode: pick(o.readMode, 'readMode', ['subscription', 'poll'], 'subscription'), timeoutMs: num(o.timeoutMs, 'timeoutMs', 1000, 60000, { int: true, fallback: 10000 }),
        acceptUnknownCertificates: o.acceptUnknownCertificates !== false };
    },
  },
  euromap63: {
    endpoint(v) {
      const e = text(v, 'folder', 300), root = euromapRoot(), full = isAbsolute(e) ? resolve(e) : resolve(root, e), rel = relative(root, full);
      if (rel.startsWith('..') || isAbsolute(rel)) bad(`The Euromap 63 folder must be inside ${root} (set MONITOR_EUROMAP63_ROOT to change it)`);
      return e;
    },
    entry(m, where) { const p = typeof m === 'string' ? m : m?.param; if (typeof p !== 'string' || !PARAM.test(p.trim())) bad(`${where}: param must be a Euromap 63 parameter name, e.g. @ActCycTim`); return { param: p.trim(), ...(isObj(m) ? scaleOf(m, where) : {}) }; },
    state(s) { if (!s.param) return null; return { param: RULES.euromap63.entry(s.param, 'state').param, map: stateMapOf(s.map) }; },
    options(o) { return { timeoutMs: num(o.timeoutMs, 'timeoutMs', 200, 120000, { int: true, fallback: 10000 }), machineFolder: typeof o.machineFolder === 'string' ? o.machineFolder.slice(0, 200) : '' }; },
  },
  modbus: {
    endpoint(v) { const e = text(v, 'endpoint', 300); try { hostPort(e); } catch (x) { bad(x.message); } return e; },
    entry(m, where) {
      if (!isObj(m)) bad(`${where} must be an object like {"address": 100, "function": "holding", "type": "float32"}`);
      const fn = pick(m.function, `${where}: function`, Object.keys(FUNCTIONS), 'holding'), bits = fn === 'coil' || fn === 'discrete';
      return { address: num(m.address, `${where}: address`, 0, 65535, { int: true }), function: fn, type: bits ? 'uint16' : pick(m.type, `${where}: type`, Object.keys(TYPES), 'uint16'),
        wordOrder: pick(m.wordOrder, `${where}: wordOrder`, ['big', 'little'], 'big'), ...scaleOf(m, where) };
    },
    state(s) { if (s.address == null || s.address === '') return null; const e = RULES.modbus.entry(s, 'state'); return { address: e.address, function: e.function, type: e.type, wordOrder: e.wordOrder, map: stateMapOf(s.map) }; },
    options(o) { return { unitId: num(o.unitId, 'unitId', 0, 255, { int: true, fallback: 1 }), timeoutMs: num(o.timeoutMs, 'timeoutMs', 500, 60000, { int: true, fallback: 3000 }) }; },
  },
};

// The checked settings from a request body, on top of the current row when editing.
export function connectorInput(body, current = null) {
  const has = k => body[k] !== undefined;
  const type = current ? current.type : pick(body.type, 'type', Object.keys(CONNECTOR_TYPES));
  if (current && has('type') && body.type !== current.type) bad('The connector type cannot be changed. Add a new connector instead.');
  const machineId = has('machineId') ? text(body.machineId, 'machineId', 100) : current?.machine_id;
  if (!machineId) bad('machineId is required');
  if (!one('SELECT 1 FROM machines WHERE id=?', machineId)) bad('Unknown machine');
  const R = RULES[type];
  const options = has('options') ? (isObj(body.options) ? body.options : bad('options must be an object')) : JSON.parse(current?.options ?? '{}');
  const opts = R.options(options), state = isObj(options.state) ? R.state(options.state) : null;
  if (state) opts.state = state;
  const mappingIn = has('mapping') ? body.mapping : JSON.parse(current?.mapping ?? '{}');
  if (!isObj(mappingIn)) bad('mapping must be an object of signal key → address');
  const signals = new Set(all('SELECT key FROM signals WHERE machine_id=?', machineId).map(s => s.key)), mapping = {};
  if (Object.keys(mappingIn).length > MAX_SIGNALS) bad(`A connector can read at most ${MAX_SIGNALS} signals`);
  for (const [k, m] of Object.entries(mappingIn)) { if (!signals.has(k)) bad(`mapping: "${k}" is not a signal of this machine`); mapping[k] = R.entry(m, `mapping.${k}`); }
  if (!Object.keys(mapping).length && !state) bad('Map at least one signal, or the machine state');
  const pollSeconds = has('pollSeconds') ? num(body.pollSeconds, 'pollSeconds', 1, 3600) : current ? current.poll_ms / 1000 : 60;
  if (type === 'euromap63' && opts.timeoutMs > pollSeconds * 1000) bad('The Euromap 63 timeout must not be longer than the poll interval');
  const out = { machine_id: machineId, type, name: has('name') ? text(body.name, 'name', 100) : current?.name ?? text(body.name, 'name', 100),
    endpoint: has('endpoint') ? R.endpoint(body.endpoint) : current?.endpoint ?? R.endpoint(body.endpoint), poll_ms: Math.round(pollSeconds * 1000),
    enabled: has('enabled') ? (body.enabled ? 1 : 0) : current?.enabled ?? 1, options: JSON.stringify(opts), mapping: JSON.stringify(mapping),
    username: current?.username ?? '', password_enc: current?.password_enc ?? null, password_env: current?.password_env ?? null };
  // Credentials: OPC UA only. password: undefined keeps it, '' removes it, text replaces it.
  if (type === 'opcua') {
    if (has('username')) out.username = body.username == null ? '' : String(body.username).trim().slice(0, 200);
    if (has('passwordEnv') && body.passwordEnv) { if (!ENV_NAME.test(body.passwordEnv)) bad('passwordEnv must be the name of an environment variable starting with MONITOR_CONNECTOR_'); out.password_env = body.passwordEnv; out.password_enc = null; }
    else if (has('passwordEnv') && !body.passwordEnv) out.password_env = null;
    if (has('password') && body.password != null) {
      if (typeof body.password !== 'string' || body.password.length > 200) bad('password must be text up to 200 characters');
      out.password_enc = body.password ? encrypt(body.password) : null; if (body.password) out.password_env = null;
    }
  } else if (has('username') || has('password') || has('passwordEnv')) { if (body.username || body.password || body.passwordEnv) bad('Only OPC UA connectors take a user name and password'); }
  return out;
}

// What a driver needs at run time: the folder resolved (and checked again after following links), the password.
export async function runtimeOf(row) {
  const cfg = { id: row.id, type: row.type, endpoint: row.endpoint, pollMs: row.poll_ms, options: JSON.parse(row.options), mapping: JSON.parse(row.mapping), username: row.username || '', password: '' };
  if (row.type === 'opcua' && row.username) cfg.password = passwordOf(row);
  if (row.type === 'euromap63') {
    const root = euromapRoot(), full = isAbsolute(row.endpoint) ? resolve(row.endpoint) : resolve(root, row.endpoint);
    const [r, f] = await Promise.all([realpath(root).catch(() => root), realpath(full).catch(() => { throw new Error('The Euromap 63 session folder does not exist'); })]);
    const rel = relative(r, f); if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('The Euromap 63 folder is outside the allowed root');
    cfg.endpoint = f;
  }
  return cfg;
}

export function connectorOut(row, status) {
  const m = one('SELECT tag,name FROM machines WHERE id=?', row.machine_id);
  return { id: row.id, machineId: row.machine_id, machineTag: m?.tag ?? null, machineName: m?.name ?? null, name: row.name, type: row.type, typeLabel: CONNECTOR_TYPES[row.type],
    endpoint: row.endpoint, pollSeconds: row.poll_ms / 1000, enabled: !!row.enabled, options: JSON.parse(row.options), mapping: JSON.parse(row.mapping),
    username: row.username || '', passwordSet: !!(row.password_enc || row.password_env), passwordEnv: row.password_env || null,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, status };
}
