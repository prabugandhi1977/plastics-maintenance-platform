// MouldCare Monitor: machine and condition monitoring with machine learning and an AI assistant. One Node process
// serves the dashboard (web/), the JSON API for it, and the intake gateways post readings to.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { ROOT, one, all, run, audit } from './db.js';
import { HttpError, createRouter, bodyOf, rawOf, json, Reply, reply, bad, deny, missing, text, choice, optNumber } from './http.js';
import { authenticate, tokenFor, verifyPassword, checkLockout, recordFailure, clearFailures, ingestKeyOk, can } from './auth.js';
import { ingest } from './ingest.js';
import { mqttConfig, mqttStatus, startMqtt, stopMqtt } from './mqtt.js';
import { MACHINE_TYPES } from './catalog.js';
import { analysisOf, analyzeAll, analyzeMachine, forgetAnalysis } from './ml/analyze.js';
import { median } from './ml/stats.js';
import { simulate, simulatorEnabled, FAULTS } from './simulator.js';
import { seedDemo, bootstrapAdmin } from './seed.js';
import { registerSetup } from './setup.js';
import { registerPeople, allocateOnDraft, assignmentOut, assign } from './people.js';
import { sendDraft, retryPending, mouldcareOut, mouldcareStatus } from './mouldcare.js';
import { aiEnabled, AI_MODEL, explainFinding, draftTicket, writeReport, chat, chatView, newConversation, findingTitle, askManuals } from './ai/claude.js';
import { indexPending } from './manuals.js';

const r = createRouter();
// Demo accounts come with demo data unless MONITOR_DEMO_ACCOUNTS=false (a public site with simulated machines).
const demoAccounts = () => process.env.MONITOR_SEED_DEMO === 'true' && process.env.MONITOR_DEMO_ACCOUNTS !== 'false';
const HOUR = 3600000, DAY = 24 * HOUR;
const write = u => { if (!can(u, 'admin', 'engineer')) deny('Your role can view but not change anything'); };
const admin = u => { if (!can(u, 'admin')) deny('Only an administrator can do this'); };
const machineOr404 = mid => one('SELECT * FROM machines WHERE id=?', mid) ?? missing('Machine not found');
const findingOr404 = fid => one('SELECT * FROM findings WHERE id=?', fid) ?? missing('Finding not found');

function findingOut(f, sigs) {
  const sig = sigs?.find?.(s => s.key === f.signal_key) ?? one('SELECT label,unit FROM signals WHERE machine_id=? AND key=?', f.machine_id, f.signal_key ?? '');
  const m = one('SELECT tag,name FROM machines WHERE id=?', f.machine_id);
  return { id: f.id, machineId: f.machine_id, machineTag: m.tag, machineName: m.name, signalKey: f.signal_key, signalLabel: sig?.label ?? null, unit: sig?.unit ?? null,
    kind: f.kind, severity: f.severity, status: f.status, title: findingTitle(f, sig), score: f.score, detail: JSON.parse(f.detail_json),
    firstSeen: f.first_seen, lastSeen: f.last_seen, resolvedAt: f.resolved_at, note: f.note, explanation: f.explanation_json ? JSON.parse(f.explanation_json) : null };
}
const ACTIVE = "status IN ('open','acknowledged','confirmed')";

r.get('/health', () => ({ ok: true, time: new Date().toISOString() }), { public: true });
r.get('/config', () => ({ ai: aiEnabled(), aiModel: aiEnabled() ? AI_MODEL : null, simulator: simulatorEnabled(), demo: demoAccounts() }), { public: true });

r.post('/auth/login', ({ body }) => {
  const email = text(body.email, 'email', 200).toLowerCase(); checkLockout(email);
  const u = one('SELECT * FROM users WHERE email=?', email);
  if (!u || typeof body.password !== 'string' || !verifyPassword(body.password, u.password_hash)) { recordFailure(email); throw new HttpError(401, 'Email or password is wrong'); }
  if (!u.active) throw new HttpError(403, 'This account is deactivated. Ask your super user to reactivate it.');
  clearFailures(email); audit(u.id, 'auth.login', 'user', u.id);
  return { token: tokenFor(u), user: { id: u.id, email: u.email, name: u.name, role: u.role } };
}, { public: true });
r.get('/me', ({ user }) => user);

// Gateways: readings with the ingest key. Body: { readings: [{ device, at, values: { signal: number }, state? }] }.
r.post('/ingest', ({ req, body }) => {
  if (!ingestKeyOk(req)) throw new HttpError(401, 'A valid X-Ingest-Key header is required');
  const results = ingest(body.readings);
  return { accepted: results.filter(x => x.status === 'accepted').length, rejected: results.filter(x => x.status === 'rejected').length, results };
}, { public: true });

function sparkOf(machineId, key, now) {
  const rows = all('SELECT ts,value FROM readings WHERE machine_id=? AND key=? AND ts>=? ORDER BY ts', machineId, key, now - 6 * HOUR);
  const g = new Map(); for (const x of rows) { const k = Math.floor(x.ts / 600000); (g.get(k) || g.set(k, []).get(k)).push(x.value); }
  return [...g].map(([k, vs]) => [k * 600000, Math.round(median(vs) * 100) / 100]);
}
const RANK = { critical: 3, warning: 2, degrading: 2, unusual: 1, normal: 0, learning: 0 };
r.get('/overview', () => {
  const now = Date.now();
  const machines = all('SELECT * FROM machines ORDER BY tag').map(m => {
    const a = analysisOf(m, now), sigs = a.signals;
    const top = one(`SELECT * FROM findings WHERE machine_id=? AND ${ACTIVE} ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, CASE kind WHEN 'limit' THEN 0 WHEN 'degrading' THEN 1 WHEN 'pattern' THEN 2 ELSE 3 END LIMIT 1`, m.id);
    const focus = [...sigs].sort((x, y) => (RANK[y.limitStatus?.severity] ?? RANK[y.assessment.status] ?? 0) - (RANK[x.limitStatus?.severity] ?? RANK[x.assessment.status] ?? 0))[0];
    return { id: m.id, tag: m.tag, name: m.name, type: m.type, typeLabel: MACHINE_TYPES[m.type], line: m.line, state: a.state, hasData: a.hasData, lastData: a.lastData, health: a.health,
      activeFindings: one(`SELECT COUNT(*) n FROM findings WHERE machine_id=? AND ${ACTIVE}`, m.id).n, topFinding: top ? findingOut(top, sigs) : null,
      focus: focus ? { key: focus.key, label: focus.label, unit: focus.unit, latest: focus.latest, status: focus.limitStatus?.severity ?? focus.assessment.status, spark: sparkOf(m.id, focus.key, now) } : null };
  });
  machines.sort((a, b) => a.health.score - b.health.score || a.tag.localeCompare(b.tag));
  const findings = all(`SELECT severity,COUNT(*) n FROM findings WHERE ${ACTIVE} GROUP BY severity`);
  return { machines, counts: { good: machines.filter(m => m.health.status === 'good').length, watch: machines.filter(m => m.health.status === 'watch').length, atRisk: machines.filter(m => m.health.status === 'at_risk').length,
    critical: findings.find(f => f.severity === 'critical')?.n ?? 0, warning: findings.find(f => f.severity === 'warning')?.n ?? 0 }, at: now };
});

r.get('/machines/:id', ({ params }) => {
  const m = machineOr404(params.id), a = analysisOf(m), now = Date.now();
  const findings = all(`SELECT * FROM findings WHERE machine_id=? AND (${ACTIVE} OR last_seen>?) ORDER BY CASE WHEN ${ACTIVE} THEN 0 ELSE 1 END, last_seen DESC LIMIT 30`, m.id, now - 14 * DAY).map(f => findingOut(f, a.signals));
  return { machine: { ...m, typeLabel: MACHINE_TYPES[m.type] }, analysis: a, findings };
});

// Ask the manuals: an answer from this machine's documents with the passages it used, for everyone signed in.
r.post('/machines/:id/ask', async ({ params, body }) => askManuals(machineOr404(params.id), text(body.question, 'question', 500)));

r.get('/machines/:id/series', ({ params, query }) => {
  const m = machineOr404(params.id), sig = one('SELECT * FROM signals WHERE machine_id=? AND key=?', m.id, query.get('signal') ?? '') ?? missing('Signal not found');
  const hours = query.get('hours') === '168' ? 168 : 24, now = Date.now();
  const rows = all('SELECT ts,value FROM readings WHERE machine_id=? AND key=? AND ts>=? ORDER BY ts', m.id, sig.key, now - hours * HOUR);
  let points = rows.map(x => [x.ts, x.value]);
  if (hours === 168) { const g = new Map(); for (const x of rows) { const k = Math.floor(x.ts / 1800000); (g.get(k) || g.set(k, []).get(k)).push(x.value); } points = [...g].map(([k, vs]) => [k * 1800000, Math.round(median(vs) * 100) / 100]); }
  const s = analysisOf(m).signals.find(x => x.key === sig.key);
  return { signal: { key: sig.key, label: sig.label, unit: sig.unit }, hours, points, limits: s.limits, assessment: s.assessment, latest: s.latest, from: now - hours * HOUR, to: now };
});

// Admin: limits per signal. Body: { limits: [{ key, warn_low, warn_high, crit_low, crit_high }] }.
r.put('/machines/:id/limits', ({ user, params, body }) => {
  admin(user); const m = machineOr404(params.id);
  if (!Array.isArray(body.limits)) bad('limits must be an array');
  for (const l of body.limits) {
    if (!one('SELECT 1 FROM signals WHERE machine_id=? AND key=?', m.id, String(l.key))) bad(`Unknown signal ${l.key}`);
    const v = Object.fromEntries(['warn_low', 'warn_high', 'crit_low', 'crit_high'].map(k => [k, optNumber(l[k], k)]));
    if (v.warn_high != null && v.crit_high != null && v.crit_high < v.warn_high) bad(`${l.key}: the critical high limit must be at or above the warning high limit`);
    if (v.warn_low != null && v.crit_low != null && v.crit_low > v.warn_low) bad(`${l.key}: the critical low limit must be at or below the warning low limit`);
    if (v.warn_low != null && v.warn_high != null && v.warn_low >= v.warn_high) bad(`${l.key}: the low warning must be below the high warning`);
    run('UPDATE signals SET warn_low=?,warn_high=?,crit_low=?,crit_high=? WHERE machine_id=? AND key=?', v.warn_low, v.warn_high, v.crit_low, v.crit_high, m.id, l.key);
  }
  audit(user.id, 'limits.update', 'machine', m.id, { limits: body.limits });
  forgetAnalysis(m.id); return analyzeMachine(m).signals.map(s => ({ key: s.key, limits: s.limits }));
});

r.get('/findings', ({ query }) => {
  const status = query.get('status') || 'active', mid = query.get('machine') || null;
  const where = status === 'active' ? ACTIVE : status === 'all' ? '1' : `status='${choice(status, 'status', ['open', 'acknowledged', 'confirmed', 'false_alarm', 'resolved'])}'`;
  return all(`SELECT * FROM findings WHERE ${where} AND (? IS NULL OR machine_id=?) ORDER BY CASE WHEN ${ACTIVE} THEN 0 ELSE 1 END, CASE severity WHEN 'critical' THEN 0 ELSE 1 END, last_seen DESC LIMIT 200`, mid, mid).map(f => findingOut(f));
});
// People decide: acknowledged (seen), confirmed (real problem), false_alarm (quiet for 24 h), resolved (fixed).
r.patch('/findings/:id', ({ user, params, body }) => {
  write(user); const f = findingOr404(params.id);
  const status = choice(body.status, 'status', ['acknowledged', 'confirmed', 'false_alarm', 'resolved']);
  const note = body.note == null ? f.note : String(body.note).slice(0, 1000);
  run('UPDATE findings SET status=?,note=?,decided_by=?,resolved_at=CASE WHEN ? IN (\'resolved\',\'false_alarm\') THEN ? ELSE resolved_at END WHERE id=?', status, note, user.id, status, Date.now(), f.id);
  audit(user.id, `finding.${status}`, 'finding', f.id, { note });
  forgetAnalysis(f.machine_id);
  return findingOut(findingOr404(f.id));
});
r.post('/findings/:id/explain', async ({ user, params, body }) => { const f = findingOr404(params.id); if (body.refresh) write(user); return explainFinding(f, { refresh: !!body.refresh }); });
// Drafting also ranks who could take the ticket: the best is kept as a suggestion, or assigned in an automatic mode.
r.post('/findings/:id/ticket', async ({ user, params }) => {
  write(user); const ticketId = await draftTicket(findingOr404(params.id), user); audit(user.id, 'ticket.draft', 'ticket', ticketId);
  await allocateOnDraft(ticketId, user);
  return reply(201, ticketOut(one('SELECT * FROM ticket_drafts WHERE id=?', ticketId)));
});

const ticketOut = t => ({ id: t.id, findingId: t.finding_id, machineId: t.machine_id, source: t.source, draft: JSON.parse(t.draft_json), status: t.status, createdAt: t.created_at, createdBy: one('SELECT name FROM users WHERE id=?', t.created_by)?.name, decidedAt: t.decided_at, ...assignmentOut(t), ...mouldcareOut(t) });
// ?assigned=me (my tasks) or none (still to allocate).
r.get('/tickets', ({ user, query }) => {
  const f = query.get('assigned'), where = f === 'me' ? 'assigned_user_id=?' : f === 'none' ? "assigned_user_id IS NULL AND assigned_provider_id IS NULL AND status<>'discarded'" : '1';
  return all(`SELECT * FROM ticket_drafts WHERE ${where} ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END, created_at DESC LIMIT 100`, ...(f === 'me' ? [user.id] : [])).map(ticketOut);
});
r.patch('/tickets/:id', async ({ user, params, body }) => {
  write(user); const t = one('SELECT * FROM ticket_drafts WHERE id=?', params.id) ?? missing('Ticket draft not found');
  if (t.status !== 'draft') bad('Only a draft can be changed');
  const draft = JSON.parse(t.draft_json);
  if (body.draft) for (const k of ['title', 'symptoms']) if (body.draft[k] != null) draft[k] = text(body.draft[k], k, 4000);
  if (body.draft?.priority != null) draft.priority = choice(body.draft.priority, 'priority', ['low', 'medium', 'high', 'critical']);
  const status = body.status == null ? 'draft' : choice(body.status, 'status', ['approved', 'discarded']);
  run('UPDATE ticket_drafts SET draft_json=?,status=?,decided_by=?,decided_at=? WHERE id=?', JSON.stringify(draft), status, status === 'draft' ? null : user.id, status === 'draft' ? null : Date.now(), t.id);
  // Approval can set the assignee in the same step (body.assignee: { kind, id }, or null to approve unassigned).
  if (status === 'approved' && body.assignee !== undefined) assign(one('SELECT * FROM ticket_drafts WHERE id=?', t.id), body.assignee, { source: choice(body.assignSource ?? 'manual', 'assignSource', ['manual', 'rules', 'ai']), reason: String(body.assignReason ?? '').slice(0, 500), by: user.id });
  audit(user.id, `ticket.${status}`, 'ticket', t.id);
  // An approved draft goes to MouldCare at once. The approval stands whatever happens there; the outcome is on the draft.
  if (status === 'approved') await sendDraft(t.id, { by: user.id });
  return ticketOut(one('SELECT * FROM ticket_drafts WHERE id=?', t.id));
});
// Send to MouldCare, or Retry after a failed send. Sending again is safe: MouldCare finds the ticket by the draft id.
r.post('/tickets/:id/mouldcare', async ({ user, params }) => {
  write(user); const t = one('SELECT * FROM ticket_drafts WHERE id=?', params.id) ?? missing('Ticket draft not found');
  if (t.status !== 'approved') bad('Only an approved ticket can be sent to MouldCare');
  await sendDraft(t.id, { by: user.id });
  return ticketOut(one('SELECT * FROM ticket_drafts WHERE id=?', t.id));
});

r.get('/reports', () => all('SELECT r.*,u.name author FROM reports r JOIN users u ON u.id=r.created_by ORDER BY r.created_at DESC LIMIT 50').map(x => ({ id: x.id, period: x.period, from: x.from_ts, to: x.to_ts, source: x.source, body: x.body, author: x.author, createdAt: x.created_at })));
r.post('/reports', async ({ user, body }) => { write(user); const rid = await writeReport(choice(body.period, 'period', ['shift', 'week']), user); audit(user.id, 'report.create', 'report', rid); return reply(201, { id: rid }); });

r.get('/chat', ({ user }) => ({ ...chatView(user.id), enabled: aiEnabled() }));
r.post('/chat', async ({ user, body }) => {
  write(user); if (!aiEnabled()) throw new HttpError(503, 'The AI assistant is off. An administrator switches it on by setting ANTHROPIC_API_KEY on the server.');
  const out = await chat(user, text(body.text, 'question', 4000));
  if (out.error) bad(out.error);
  return { ...chatView(user.id), notice: out.notice };
});
r.delete('/chat', ({ user }) => { newConversation(user.id); return chatView(user.id); });

r.post('/models/retrain', ({ user }) => { admin(user); run('DELETE FROM models'); const res = analyzeAll(); audit(user.id, 'models.retrain', 'models', null); return res.map(a => ({ machineId: a.machineId, model: a.model })); });
r.get('/settings', ({ user }) => { admin(user); return { ingestKeySet: !!process.env.MONITOR_INGEST_KEY, mouldcare: mouldcareStatus(), mqtt: mqttStatus(), ai: aiEnabled(), aiModel: AI_MODEL, simulator: simulatorEnabled(), faults: simulatorEnabled() ? FAULTS.map(f => ({ tag: f.tag, signal: f.key, story: f.story })) : [],
  machines: all('SELECT * FROM machines ORDER BY tag').map(m => ({ id: m.id, tag: m.tag, name: m.name, deviceId: m.device_id, signals: all('SELECT key,label,unit,warn_low,warn_high,crit_low,crit_high FROM signals WHERE machine_id=? ORDER BY rowid', m.id) })) }; });

registerSetup(r);
registerPeople(r);

// ---- HTTP plumbing ----
const STATIC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'" };
const MIME = { '.ico': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function api(req, res, url) {
  const { route, params, pathExists } = r.match(req.method, url.pathname);
  if (!route) throw new HttpError(pathExists ? 405 : 404, pathExists ? 'Method not allowed' : 'Endpoint not found');
  // Routes marked raw take the request body as bytes (file uploads), up to their limit.
  const body = route.raw ? await rawOf(req, route.raw) : ['POST', 'PATCH', 'PUT'].includes(req.method) ? await bodyOf(req) : {};
  const user = route.public ? null : authenticate(req);
  if (!route.public && !user) throw new HttpError(401, 'Sign in required');
  const out = await route.handler({ user, body, params, query: url.searchParams, req, res });
  if (res.writableEnded) return; // the handler sent a file itself
  if (out instanceof Reply) return json(res, out.status, out.value);
  json(res, 200, out);
}
function serveStatic(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  const safe = path === '/' ? 'index.html' : path.slice(1);
  if (!/^[\w./-]+$/.test(safe) || safe.includes('..')) throw new HttpError(404, 'Not found');
  const file = join(ROOT, 'web', safe); if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'Not found');
  res.writeHead(200, { ...STATIC_HEADERS, 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
}
export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      serveStatic(req, res, url.pathname);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      if (String(e.message).includes('UNIQUE constraint failed')) return json(res, 409, { error: 'Record already exists' });
      console.error(e); json(res, 500, { error: 'Internal server error' });
    }
  });
}

if (process.argv[1]?.endsWith('index.js')) {
  if (process.env.MONITOR_SEED_DEMO === 'true') console.log(`Demo data: ${seedDemo({ accounts: demoAccounts() })} records added${demoAccounts() ? '' : ' (demo machines only, no demo accounts)'}`);
  if (bootstrapAdmin()) console.log('First administrator created');
  const port = Number(process.env.PORT || 3300);
  const job = (name, fn) => () => { try { fn(); } catch (e) { console.error(`${name} failed:`, e.message); } };
  if (simulatorEnabled()) { job('Simulator', () => console.log(`Simulator: ${simulate()} readings`))(); setInterval(job('Simulator', simulate), 60000).unref(); }
  job('Analysis', analyzeAll)();
  job('Document text', () => { const n = indexPending(); if (n) console.log(`Reading the text of ${n} document${n === 1 ? '' : 's'}`); })();
  setInterval(job('Analysis', analyzeAll), 5 * 60000).unref();
  const keepDays = Number(process.env.MONITOR_RETENTION_DAYS || 30);
  setInterval(job('Retention', () => run('DELETE FROM readings WHERE ts<?', Date.now() - keepDays * DAY)), 6 * HOUR).unref();
  // Failed hand-offs to MouldCare (and drafts approved before it was set up) are sent again every 5 minutes.
  setInterval(() => retryPending().then(x => { if (x.tried) console.log(`MouldCare hand-off: ${x.sent} of ${x.tried} sent`); }).catch(e => console.error('MouldCare hand-off failed:', e.message)), 5 * 60000).unref();
  const server = createServer().listen(port, () => console.log(`MouldCare Monitor listening on port ${port}`));
  const mqttCfg = mqttConfig();
  if (mqttCfg) {
    let lastError = null;
    startMqtt(mqttCfg).on('connect', () => { lastError = null; console.log(`MQTT: subscribed to ${mqttCfg.topic} on ${mqttStatus().url}`); })
      .on('error', e => { if (e.message !== lastError) console.error(`MQTT: ${(lastError = e.message)}`); });
    const shutdown = async () => { server.close(); try { await stopMqtt(); } finally { process.exit(0); } };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  }
}
