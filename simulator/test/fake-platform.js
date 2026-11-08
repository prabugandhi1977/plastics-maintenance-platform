// A stand-in for the platform's two intake endpoints, for tests that cannot (or should not) start the real server.
// Validation reuses the app's own code where it can: the IoT contract is imported directly, and the factory-event
// enumerations (states, reasons, parameters, defects, safety types) are read from backend/common/catalog.js source,
// so this fake cannot silently drift from the real rules. Behaviour it mirrors: unknown devices are rejected, repeated
// state/count/energy/vision/readings are duplicates, process events need a running batch.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeRecord } from '../../backend/services/iot/contract.js';

const catalogSrc = readFileSync(fileURLToPath(new URL('../../backend/common/catalog.js', import.meta.url)), 'utf8');
export function catalogConst(name) {
  const m = catalogSrc.match(new RegExp(`export const ${name}=([\\s\\S]*?);\\n`)); if (!m) throw new Error(`catalog constant ${name} not found`);
  return new Function(`return (${m[1]})`)();
}
const LIVE_STATES = catalogConst('LIVE_STATES'), REASONS = catalogConst('DOWNTIME_REASONS'), PARAMS = catalogConst('CONDITION_PARAMETERS'), DEFECTS = catalogConst('DEFECT_TYPES'), SAFETY = catalogConst('SAFETY_EVENTS');

export async function startFakePlatform({ key = 'test-key', devices = new Map(), batchRunning = true, port = 0 } = {}) {
  // devices: Map deviceId -> machineType ('injection')
  const store = { factory: [], iot: [], rejected: [], duplicates: 0, calls: 0, down: false, seen: new Set() };
  const ts = v => { const t = Date.parse(v); if (!Number.isFinite(t)) throw new Error('timestamp must be ISO 8601'); return t; };
  const num = (v, k) => { if (!Number.isFinite(v)) throw new Error(`${k} must be a number`); return v; };
  function factory(ev) {
    if (ev?.type === 'safety' && ev.readerId != null) throw new Error('Unknown readerId');
    const type = devices.get(ev?.deviceId); if (typeof ev?.deviceId !== 'string' || !type) throw new Error('Unknown or inactive deviceId');
    const dedupe = k => { if (store.seen.has(k)) { store.duplicates++; return 'duplicate'; } store.seen.add(k); return null; };
    switch (ev.type) {
      case 'state': { if (!LIVE_STATES.includes(ev.state)) throw new Error('bad state'); if (ev.reason != null && !(REASONS[ev.state] || []).includes(ev.reason)) throw new Error(`reason must be one of: ${(REASONS[ev.state] || []).join(', ')}`); ts(ev.at); return dedupe(`s|${ev.deviceId}|${ev.at}`) ?? 'accepted'; }
      case 'count': { num(ev.totalQty, 'totalQty'); const s = num(ev.scrapQty ?? 0, 'scrapQty'); if (s > ev.totalQty) throw new Error('scrapQty cannot exceed totalQty'); if (!ev.periodMinutes || ev.periodMinutes > 1440) throw new Error('periodMinutes'); return dedupe(`c|${ev.deviceId}|${ev.periodStart}`) ?? 'accepted'; }
      case 'condition': { if (!PARAMS[ev.parameter]) throw new Error('bad parameter'); num(ev.value, 'value'); ts(ev.at); return dedupe(`k|${ev.deviceId}|${ev.parameter}|${ev.at}`) ?? 'accepted'; }
      case 'energy': { if (num(ev.kwh, 'kwh') < 0) throw new Error('kwh must be a non-negative number'); if (ev.peakKw != null && ev.peakKw < 0) throw new Error('peakKw'); return dedupe(`e|${ev.deviceId}|${ev.periodStart}`) ?? 'accepted'; }
      case 'vision': { if (!Number.isInteger(ev.inspected) || !Number.isInteger(ev.rejected) || ev.rejected > ev.inspected) throw new Error('rejected cannot exceed inspected'); for (const k of Object.keys(ev.defects ?? {})) if (!DEFECTS[type].includes(k)) throw new Error('defect must be one of: ' + DEFECTS[type].join(', ')); return dedupe(`v|${ev.deviceId}|${ev.station}|${ev.periodStart}`) ?? 'accepted'; }
      case 'safety': { if (!SAFETY[ev.eventType]) throw new Error('bad eventType'); ts(ev.at); return dedupe(`f|${ev.deviceId}|${ev.eventType}|${ev.at}`) ?? 'accepted'; }
      case 'process': { if (!batchRunning) throw new Error('No batch is running on this machine'); if (!ev.values || typeof ev.values !== 'object') throw new Error('values'); ts(ev.at); return 'accepted'; }
      default: throw new Error('type must be state, count, condition, energy, vision, safety, process or sighting');
    }
  }
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => (raw += c));
    req.on('end', () => {
      store.calls++;
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (store.down) return send(503, { error: 'down' });
      if (req.headers['x-integration-key'] !== key) return send(401, { error: 'Invalid integration key' });
      let body; try { body = JSON.parse(raw); } catch { return send(400, { error: 'bad json' }); }
      if (req.url === '/api/integrations/factory/events') {
        const list = body.events; if (!Array.isArray(list) || !list.length || list.length > 1000) return send(400, { error: 'Send 1-1000 events per request' });
        const results = list.map((ev, index) => { try { const status = factory(ev); if (status === 'accepted') store.factory.push(ev); return { index, status }; } catch (e) { store.rejected.push({ route: 'factory', item: ev, error: e.message }); return { index, status: 'rejected', error: e.message }; } });
        const c = s => results.filter(r => r.status === s).length; return send(200, { accepted: c('accepted'), unchanged: 0, duplicates: c('duplicate'), rejected: c('rejected'), results });
      }
      if (req.url === '/api/integrations/iot/records') {
        const list = body.records; if (!Array.isArray(list) || !list.length || list.length > 500) return send(400, { error: 'Send 1-500 records' });
        const results = list.map((rec, index) => {
          const n = normalizeRecord(rec); if (n.errors) { store.rejected.push({ route: 'iot', item: rec, error: n.errors.join('; ') }); return { index, status: 'rejected', errors: n.errors }; }
          if (!devices.has(n.record.deviceId)) { store.rejected.push({ route: 'iot', item: rec, error: 'unmapped' }); return { index, status: 'rejected', errors: ['Unknown or inactive deviceId'] }; }
          const k = `i|${n.record.deviceId}|${n.record.observedAt}`; if (store.seen.has(k)) { store.duplicates++; return { index, status: 'duplicate' }; }
          store.seen.add(k); store.iot.push(n.record); return { index, status: 'accepted' };
        });
        const c = s => results.filter(r => r.status === s).length; return send(200, { accepted: c('accepted'), duplicates: c('duplicate'), rejected: c('rejected'), results });
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, key, store, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}
