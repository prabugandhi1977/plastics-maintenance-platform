import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { monitorProxy, monitorTarget } from '../common/monitor-proxy.js';

// A stand-in for MouldCare Monitor that echoes what it was asked, so the forwarding can be checked without a database.
const seen = [];
const upstream = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url === '/redirect') { res.writeHead(302, { location: '/somewhere' }); return res.end(); }
    res.writeHead(201, { 'content-type': 'application/json', 'x-from-monitor': 'yes' }); res.end(JSON.stringify({ url: req.url }));
  });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const target = new URL(`http://127.0.0.1:${upstream.address().port}`);
const front = http.createServer((req, res) => { if (!monitorProxy(req, res, new URL(req.url, 'http://x'), target)) { res.writeHead(404); res.end('not proxied'); } });
await new Promise(r => front.listen(0, '127.0.0.1', r));
const at = path => `http://127.0.0.1:${front.address().port}${path}`;
after(() => { front.close(); upstream.close(); });

test('only a configured http address turns the Monitor on', () => {
  assert.equal(monitorTarget({}), null);
  assert.equal(monitorTarget({ MOULDCARE_MONITOR_URL: 'not a url' }), null);
  assert.equal(monitorTarget({ MOULDCARE_MONITOR_URL: 'https://example.com' }), null, 'only plain http to the local process');
  assert.equal(monitorTarget({ MOULDCARE_MONITOR_URL: 'http://127.0.0.1:3300' }).port, '3300');
});

test('/monitor/... is forwarded with the prefix removed, body, query and status intact', async () => {
  const r = await fetch(at('/monitor/api/ingest?x=1'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-key': 'k' }, body: '{"a":1}' });
  assert.equal(r.status, 201); assert.equal(r.headers.get('x-from-monitor'), 'yes'); assert.deepEqual(await r.json(), { url: '/api/ingest?x=1' });
  const s = seen.at(-1); assert.equal(s.method, 'POST'); assert.equal(s.body, '{"a":1}'); assert.equal(s.headers['x-ingest-key'], 'k'); assert.equal(s.headers['x-forwarded-prefix'], '/monitor');
  assert.equal((await fetch(at('/monitor/'))).status, 201); assert.equal(seen.at(-1).url, '/');
});

test('/monitor goes to /monitor/, and other paths are left alone', async () => {
  const r = await fetch(at('/monitor?a=1'), { redirect: 'manual' }); assert.equal(r.status, 308); assert.equal(r.headers.get('location'), '/monitor/?a=1');
  for (const p of ['/', '/api/health', '/monitorx/a', '/mobile/']) { const x = await fetch(at(p)); assert.equal(x.status, 404, p); assert.equal(await x.text(), 'not proxied'); }
});

test('a redirect from the Monitor is passed on as it is, and a Monitor that is down gives 502', async () => {
  const r = await fetch(at('/monitor/redirect'), { redirect: 'manual' }); assert.equal(r.status, 302);
  const dead = http.createServer(); await new Promise(x => dead.listen(0, '127.0.0.1', x)); const port = dead.address().port; await new Promise(x => dead.close(x));
  const f2 = http.createServer((req, res) => monitorProxy(req, res, new URL(req.url, 'http://x'), new URL(`http://127.0.0.1:${port}`))); await new Promise(x => f2.listen(0, '127.0.0.1', x));
  const x = await fetch(`http://127.0.0.1:${f2.address().port}/monitor/api/health`); assert.equal(x.status, 502); assert.match((await x.json()).error, /not running/); f2.close();
});

test('with no address configured the platform does not answer /monitor', () => {
  let ended = false; const res = { writeHead() { ended = true; }, end() { ended = true; } };
  assert.equal(monitorProxy({ headers: {} }, res, new URL('http://x/monitor/'), null), false); assert.equal(ended, false);
});
