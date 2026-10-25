// Machine connectors: one supervisor runs every enabled connector, each in its own loop, so one machine that fails
// never holds up the others. A loop connects, reads every poll interval and queues one reading per poll; the queue
// goes through ingest() in batches, so validation and the unknown-device and unknown-signal rules are the same as
// for POST /api/ingest and MQTT. On an error the loop disconnects and tries again after a backoff (1 s doubling to
// 60 s). A connector whose settings change is restarted with them; a deleted or disabled one is stopped.
import { id, one, all, run, audit } from '../db.js';
import { HttpError, deny, missing, reply } from '../http.js';
import { can } from '../auth.js';
import { ingest } from '../ingest.js';
import { CONNECTOR_TYPES, connectorInput, connectorOut, runtimeOf, euromapRoot, ENV_NAME } from './config.js';
import { within, EUROMAP77_STATES } from './common.js';
import { opcuaDriver } from './opcua.js';
import { euromap63Driver } from './euromap63.js';
import { modbusDriver, FUNCTIONS, TYPES } from './modbus.js';

const DRIVERS = { opcua: opcuaDriver, euromap63: euromap63Driver, modbus: modbusDriver };
const KEEP_REASONS = 10, MAX_QUEUE = 20000;
const DEFAULTS = { minBackoffMs: 1000, maxBackoffMs: 60000, flushMs: 1000, batchSize: 500, syncMs: 30000, log: false };
export const backoff = (attempt, min = DEFAULTS.minBackoffMs, max = DEFAULTS.maxBackoffMs) => Math.min(max, min * 2 ** attempt);
export const connectorsEnabled = (env = process.env) => !/^(off|false|0|no)$/i.test(env.MONITOR_CONNECTORS?.trim() ?? '');

// Error text as it may be shown or logged: never the password, even if a library put it into a message.
const scrub = (msg, cfg) => { let m = String(msg ?? 'Unknown error').replace(/\s+/g, ' ').slice(0, 300); if (cfg?.password) m = m.split(cfg.password).join('***'); return m; };

let opts = { ...DEFAULTS }, started = false, syncTimer = null, queue = [], flushTimer = null;
const runners = new Map();
const freshStatus = () => ({ running: false, connected: false, mode: null, note: null, connectedAt: null, lastReadingAt: null, lastValues: null, lastState: null,
  readings: 0, accepted: 0, rejected: 0, reasons: [], lastError: null, lastErrorAt: null, failures: 0, retryInMs: null, restarts: 0 });
const say = (r, msg, err = false) => { if (opts.log) (err ? console.error : console.log)(`Connector ${r.label}: ${msg}`); };

class Runner {
  constructor(row, restarts = 0) {
    const m = one('SELECT tag FROM machines WHERE id=?', row.machine_id);
    Object.assign(this, { row, label: `${m?.tag ?? '?'} · ${row.name} (${CONNECTOR_TYPES[row.type]})`, stopped: false, attempt: 0, driver: null, wakeUp: null, lostError: null, cfg: null });
    this.status = { ...freshStatus(), running: true, restarts };
    this.done = this.loop();
  }
  wait(ms) { return new Promise(r => { const t = setTimeout(r, ms); this.wakeUp = () => { clearTimeout(t); r(); }; }).finally(() => { this.wakeUp = null; }); }
  wake() { this.wakeUp?.(); }
  async loop() {
    while (!this.stopped) {
      try {
        this.cfg = await runtimeOf(this.row); this.lostError = null;
        this.driver = DRIVERS[this.row.type](this.cfg, { onLost: e => { this.lostError ??= e; this.wake(); } });
        const timeout = (this.cfg.options.timeoutMs ?? 10000) + 5000;
        await within(timeout, this.driver.open(), 'Connecting');
        if (this.stopped) break;
        Object.assign(this.status, { connected: true, connectedAt: Date.now(), mode: this.driver.mode, note: this.driver.note ?? null });
        say(this, `connected${this.driver.mode === 'subscription' ? ' (subscription)' : ''}${this.driver.note ? ` · ${scrub(this.driver.note, this.cfg)}` : ''}`);
        while (!this.stopped) {
          if (this.lostError) throw this.lostError;
          const started = Date.now(), r = await within(timeout, this.driver.read(), 'Reading');
          if (this.lostError) throw this.lostError;
          if (this.stopped) break;
          this.attempt = 0; this.status.failures = 0; this.status.retryInMs = null;
          this.take(r);
          await this.wait(Math.max(0, this.cfg.pollMs - (Date.now() - started)));
        }
      } catch (e) {
        if (this.stopped) break;
        const msg = scrub(e.message, this.cfg), wait = backoff(this.attempt++, opts.minBackoffMs, opts.maxBackoffMs);
        if (msg !== this.status.lastError || this.status.connected) say(this, `${msg} · retrying in ${Math.round(wait / 100) / 10} s`, true);
        Object.assign(this.status, { connected: false, lastError: msg, lastErrorAt: Date.now(), failures: this.status.failures + 1, retryInMs: wait });
        await this.closeDriver();
        await this.wait(wait);
      }
    }
    await this.closeDriver();
    this.status.connected = false; this.status.running = false;
  }
  async closeDriver() { const d = this.driver; this.driver = null; if (d) await within(5000, d.close(), 'Disconnecting').catch(() => {}); }
  take(r) {
    const values = r.values ?? {}, s = this.status;
    if (r.skipped?.length) for (const why of r.skipped) note(this, why);
    if (!Object.keys(values).length && !r.state) return;
    const machine = one('SELECT device_id FROM machines WHERE id=?', this.row.machine_id);
    if (!machine) { this.stop(); return; }
    s.readings++; s.lastReadingAt = Date.now(); s.lastValues = values; s.lastState = r.state ?? null;
    enqueue(this, { device: machine.device_id, at: Date.now(), values, ...(r.state ? { state: r.state } : {}) });
  }
  stop() { this.stopped = true; this.wake(); return this.done; }
}
function note(runner, reason) {
  const s = runner.status;
  if (s.reasons[0]?.reason === reason) { s.reasons[0].at = Date.now(); return; }
  s.reasons.unshift({ at: Date.now(), reason }); s.reasons.length = Math.min(s.reasons.length, KEEP_REASONS);
}
function reject(runner, reason) { runner.status.rejected++; note(runner, reason); }

export function flush() {
  clearTimeout(flushTimer); flushTimer = null;
  while (queue.length) {
    const batch = queue.splice(0, opts.batchSize);
    let results;
    try { results = ingest(batch.map(x => x.item)); } catch (e) { for (const x of batch) reject(x.runner, e.message); continue; }
    for (const r of results) { const x = batch[r.index]; if (r.status === 'accepted') { x.runner.status.accepted++; for (const why of r.skipped ?? []) note(x.runner, why); } else reject(x.runner, r.reason); }
  }
}
function enqueue(runner, item) {
  if (queue.length >= MAX_QUEUE) return reject(runner, 'Intake queue is full');
  queue.push({ runner, item });
  if (queue.length >= opts.batchSize) flush();
  else if (!flushTimer) { flushTimer = setTimeout(flush, opts.flushMs); flushTimer.unref?.(); }
}

// Brings the running connectors in line with the table: starts new and enabled ones, stops deleted and disabled
// ones, restarts changed ones. Runs after every change through the API and every syncMs.
export function syncConnectors() {
  if (!started) return;
  const rows = new Map(all('SELECT * FROM connectors').map(r => [r.id, r]));
  for (const [cid, runner] of runners) {
    const row = rows.get(cid);
    if (!row || !row.enabled || row.version !== runner.row.version) {
      runner.stop(); runners.delete(cid);
      if (row?.enabled) { runners.set(cid, new Runner(row, runner.status.restarts + 1)); say(runners.get(cid), 'restarting with new settings'); }
    }
  }
  for (const row of rows.values()) if (row.enabled && !runners.has(row.id)) runners.set(row.id, new Runner(row));
}
export function startConnectors(options = {}) {
  if (started) return;
  opts = { ...DEFAULTS, ...options }; started = true;
  syncConnectors();
  syncTimer = setInterval(syncConnectors, opts.syncMs); syncTimer.unref?.();
}
// Stops every loop, waits for them to disconnect, and ingests what is still queued.
export async function stopConnectors() {
  started = false; clearInterval(syncTimer); syncTimer = null;
  const stopping = [...runners.values()].map(r => r.stop()); runners.clear();
  await Promise.all(stopping);
  flush();
}
export const connectorStatus = cid => runners.get(cid)?.status ?? { ...freshStatus() };

// Reads once with the given settings and returns what came back, without storing anything.
export async function testConnector(row) {
  const t0 = Date.now(); let cfg = null, driver = null;
  try {
    cfg = await runtimeOf(row);
    if (cfg.type === 'opcua') cfg.options = { ...cfg.options, readMode: 'poll' };
    const timeout = (cfg.options.timeoutMs ?? 10000) + 5000;
    driver = DRIVERS[row.type](cfg, {});
    await within(timeout, driver.open(), 'Connecting');
    const r = await within(timeout, driver.read(), 'Reading');
    return { ok: true, ms: Date.now() - t0, values: r.values, state: r.state ?? null, raw: r.raw, skipped: r.skipped ?? [] };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: scrub(e.message, cfg) }; }
  finally { if (driver) await within(5000, driver.close(), 'Disconnecting').catch(() => {}); }
}

// ---- API: Settings › Connections & models, super user only ----
const admin = u => { if (!can(u, 'admin')) deny('Only a super user (administrator) can manage machine connectors'); };
const rowOr404 = cid => one('SELECT * FROM connectors WHERE id=?', cid) ?? missing('Connector not found');
const out = row => connectorOut(row, connectorStatus(row.id));
const auditDetail = r => ({ name: r.name, type: r.type, machine: r.machine_id, endpoint: r.endpoint, enabled: !!r.enabled, signals: Object.keys(JSON.parse(r.mapping)) });

export function registerConnectors(r) {
  r.get('/connectors', ({ user }) => {
    admin(user);
    return { enabled: connectorsEnabled(), types: CONNECTOR_TYPES, euromap63Root: euromapRoot(), modbus: { functions: Object.keys(FUNCTIONS), types: Object.keys(TYPES) }, euromap77States: EUROMAP77_STATES, passwordEnvPattern: ENV_NAME.source,
      connectors: all('SELECT c.* FROM connectors c JOIN machines m ON m.id=c.machine_id ORDER BY m.tag, c.name').map(out) };
  });
  r.post('/connectors', ({ user, body }) => {
    admin(user); const v = connectorInput(body), cid = id(), now = Date.now();
    if (one('SELECT 1 FROM connectors WHERE machine_id=? AND name=?', v.machine_id, v.name)) throw new HttpError(409, 'This machine already has a connector with that name');
    run('INSERT INTO connectors (id,machine_id,name,type,endpoint,poll_ms,enabled,options,mapping,username,password_enc,password_env,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)',
      cid, v.machine_id, v.name, v.type, v.endpoint, v.poll_ms, v.enabled, v.options, v.mapping, v.username, v.password_enc, v.password_env, now, now);
    audit(user.id, 'connector.create', 'connector', cid, auditDetail(v)); syncConnectors();
    return reply(201, out(rowOr404(cid)));
  });
  r.patch('/connectors/:id', ({ user, params, body }) => {
    admin(user); const c = rowOr404(params.id), v = connectorInput(body, c);
    if (one('SELECT 1 FROM connectors WHERE machine_id=? AND name=? AND id<>?', v.machine_id, v.name, c.id)) throw new HttpError(409, 'This machine already has a connector with that name');
    run('UPDATE connectors SET machine_id=?,name=?,endpoint=?,poll_ms=?,enabled=?,options=?,mapping=?,username=?,password_enc=?,password_env=?,version=version+1,updated_at=? WHERE id=?',
      v.machine_id, v.name, v.endpoint, v.poll_ms, v.enabled, v.options, v.mapping, v.username, v.password_enc, v.password_env, Date.now(), c.id);
    audit(user.id, 'connector.update', 'connector', c.id, { ...auditDetail(v), passwordChanged: v.password_enc !== c.password_enc || v.password_env !== c.password_env }); syncConnectors();
    return out(rowOr404(c.id));
  });
  r.delete('/connectors/:id', ({ user, params }) => {
    admin(user); const c = rowOr404(params.id);
    run('DELETE FROM connectors WHERE id=?', c.id); audit(user.id, 'connector.delete', 'connector', c.id, auditDetail(c)); syncConnectors();
    return { deleted: c.id };
  });
  // Test connection: a saved connector, or settings from the form before saving (with id, the saved password is used
  // unless a new one is typed). Nothing read here is stored.
  r.post('/connectors/:id/test', async ({ user, params }) => { admin(user); return testConnector(rowOr404(params.id)); });
  r.post('/connectors/test', async ({ user, body }) => {
    admin(user); const current = body.id ? rowOr404(String(body.id)) : null;
    const v = connectorInput(body, current);
    return testConnector({ ...v, id: current?.id ?? 'test', version: 0 });
  });
}
