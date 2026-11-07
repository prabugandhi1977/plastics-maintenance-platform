// Serves MouldCare Monitor (monitor/) under /monitor on this server, so both apps can run in one container and one
// Render service. Off unless MOULDCARE_MONITOR_URL names where the Monitor listens (docker-entrypoint.sh sets it when
// MONITOR_EMBED=true). The Monitor keeps its own database, sign-in and API; this only forwards requests, so
// /monitor/api/ingest is the gateway address and everything else behaves as when it runs on its own.
import http from 'node:http';
import { API_HEADERS } from './http.js';

const PREFIX = '/monitor';
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

export function monitorTarget(env = process.env) {
  const raw = (env.MOULDCARE_MONITOR_URL || '').trim();
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'http:' && u.hostname ? u : null; } catch { return null; }
}

// True when the request was for the Monitor (and has been answered, or is being forwarded).
export function monitorProxy(req, res, url, target = monitorTarget()) {
  if (!target || (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/'))) return false;
  if (url.pathname === PREFIX) { res.writeHead(308, { location: PREFIX + '/' + url.search, 'cache-control': 'no-cache' }); res.end(); return true; }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  headers['x-forwarded-prefix'] = PREFIX;
  const up = http.request({ hostname: target.hostname, port: target.port || 80, method: req.method, path: url.pathname.slice(PREFIX.length) + url.search, headers, timeout: 120000 }, r => {
    const out = {}; for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
    res.writeHead(r.statusCode || 502, out); r.pipe(res);
  });
  const fail = e => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, API_HEADERS); res.end(JSON.stringify({ error: 'MouldCare Monitor is not running', detail: e?.code || e?.message }));
  };
  up.on('timeout', () => up.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  up.on('error', fail); res.on('close', () => up.destroy());
  req.pipe(up);
  return true;
}
