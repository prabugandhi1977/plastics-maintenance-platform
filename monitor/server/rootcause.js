// Root-cause analysis, the data side: the evidence gathered for a finding, the deterministic ranking used without the
// AI ("standard rules, not AI", from the table in catalog.js), the mapping of cited evidence ids back to the real items,
// the stored result, and the engineer's recorded actual cause with the accuracy figures. The AI step is in ai/rootcause.js.
//
// Evidence is numbered by kind so an answer can cite it and the server can check every citation:
//   S1… signal windows    C1… correlations    H1 machine state history    P1 pattern model
//   F1… similar past findings    D1… manual passages    K1… tickets
// Which signal moved first: each signal's 15-minute medians (while running) are compared with its own normal, learned
// from the first 48 hours of the window (median and MAD). The onset is where it first stayed 3 spreads or more away for
// two windows in a row. For a slow drift, which crosses 3 spreads long after it began, the onset is the corner of the
// best "flat at the normal level, then a straight rise" fit to the whole window, so it is an estimate; an abrupt step is
// dated to its 15-minute window.
import { createHash } from 'node:crypto';
import { one, all, run } from './db.js';
import { bad, text } from './http.js';
import { analysisOf } from './ml/analyze.js';
import { runningPoints } from './ingest.js';
import { median, mad } from './ml/stats.js';
import { search, findingQuery } from './manuals.js';
import { MACHINE_TYPES, ROOT_CAUSE_RULES, KNOWLEDGE } from './catalog.js';
import { reasonLabel } from './ml/learning.js';

const MIN = 60000, HOUR = 3600000, DAY = 86400000, BUCKET = 15 * MIN;
const round = (v, d = 2) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d;
const iso = t => t == null ? '—' : new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const CONFIDENCE = ['low', 'medium', 'high'];

// ---- The window and the data version ----
// From five days before the finding started to twelve hours after (or now): enough healthy history to learn the
// signal's own normal, and enough after the start to see what moved.
export function evidenceWindow(f, now = Date.now()) {
  const to = Math.min(now, f.first_seen + 12 * HOUR), from = Math.floor((f.first_seen - 5 * DAY) / BUCKET) * BUCKET;
  return { from, to: Math.max(to, f.first_seen) };
}
// A short hash of everything the analysis reads that can change: the window (to the hour), decisions and recorded causes
// for this machine type, tickets, and the uploaded documents. A stored result is served while this is unchanged.
export function dataVersion(f, now = Date.now()) {
  const m = one('SELECT id,type FROM machines WHERE id=?', f.machine_id), w = evidenceWindow(f, now);
  const d = one('SELECT COUNT(*) n, IFNULL(MAX(d.decided_at),0) t FROM decisions d JOIN machines x ON x.id=d.machine_id WHERE x.type=? AND d.reset_at IS NULL', m.type);
  const a = one('SELECT COUNT(*) n, IFNULL(MAX(recorded_at),0) t FROM actual_causes WHERE machine_type=?', m.type);
  const t = one("SELECT COUNT(*) n, IFNULL(MAX(created_at),0) t FROM ticket_drafts WHERE machine_id=? AND status<>'discarded'", m.id);
  const p = one('SELECT COUNT(*) n FROM passages WHERE machine_id IN (SELECT id FROM machines WHERE type=?)', m.type);
  return createHash('sha1').update(JSON.stringify([f.id, f.kind, f.severity, f.first_seen, Math.floor(w.to / HOUR), d, a, t, p])).digest('hex').slice(0, 16);
}

// ---- Signals: which moved, when, and in which order ----
function buckets(points) {
  const g = new Map();
  for (const p of points) { const k = Math.floor(p.t / BUCKET); (g.get(k) || g.set(k, []).get(k)).push(p.v); }
  return [...g].filter(([, vs]) => vs.length >= 3).sort((a, b) => a[0] - b[0]).map(([k, vs]) => ({ t: k * BUCKET, v: median(vs) }));
}
const downsample = (series, max = 96) => { const step = Math.max(1, Math.ceil(series.length / max)), out = []; for (let i = 0; i < series.length; i += step) { const c = series.slice(i, i + step); out.push([c[0].t, round(c.reduce((a, b) => a + b.v, 0) / c.length)]); } return out; };

// The start of a drift: the corner of a "flat, then straight line" model that fits the window best. Null when that
// model is not clearly better than staying flat, or when the line does not rise in the direction the signal moved.
function driftStart(series, bm, sign, first) {
  const n = series.length, y = series.map(b => b.v - bm);
  const flat = y.reduce((a, v) => a + v * v, 0);
  let best = null;
  for (let c = 0; c <= first; c++) {
    const t0 = series[c].t; let num = 0, den = 0;
    for (let i = c; i < n; i++) { const d = series[i].t - t0; num += y[i] * d; den += d * d; }
    if (!den) continue;
    const slope = num / den; if (Math.sign(slope) !== sign) continue;
    let sse = 0;
    for (let i = 0; i < c; i++) sse += y[i] * y[i];
    for (let i = c; i < n; i++) { const e = y[i] - slope * (series[i].t - t0); sse += e * e; }
    if (!best || sse < best.sse) best = { sse, t0 };
  }
  return best && best.sse <= 0.5 * flat ? best.t0 : null;
}

export function assessWindow(series, from, to) {
  const baseEnd = from + Math.min(48 * HOUR, 0.4 * (to - from)), base = series.filter(b => b.t < baseEnd), rest = series.filter(b => b.t >= baseEnd);
  if (base.length < 24 || rest.length < 4) return { status: 'insufficient', points: series.length };
  const bm = median(base.map(b => b.v)), spread = Math.max(mad(base.map(b => b.v), bm), 0.02 * Math.abs(bm), 1e-6);
  const z = series.map(b => (b.v - bm) / spread);
  const first = series.findIndex((b, i) => b.t >= baseEnd && i + 1 < series.length && Math.abs(z[i]) >= 3 && Math.abs(z[i + 1]) >= 3 && Math.sign(z[i]) === Math.sign(z[i + 1]));
  const tail = series.slice(-8), current = median(tail.map(b => b.v)), deltaSpreads = round((current - bm) / spread, 1);
  const out = { status: 'ok', baseline: round(bm), spread: round(spread, 3), current: round(current), deltaSpreads, delta: round(current - bm), points: series.length, moved: first >= 0 };
  if (first < 0) return out;
  const sign = Math.sign(z[first]), tail8 = z.slice(-8), active = Math.abs(tail8.reduce((x, v) => x + v, 0) / tail8.length) >= 2;
  // Abrupt or gradual: how much of the whole shift happened at the moment it was first seen.
  const before = median(series.slice(Math.max(0, first - 4), first).map(b => b.v)) ?? bm, after = median(series.slice(first, first + 4).map(b => b.v));
  const step = Math.abs(after - before) >= 0.6 * Math.abs(current - bm);
  let onset = series[first].t, method = 'threshold';
  if (!active) { /* a short event that has passed */ }
  else if (!step) {
    // A drift crosses 3 spreads long after it began. Its start is found by fitting "flat at the normal level, then a
    // straight rise" to the whole window and taking the corner that fits best. A daily swing in the signal cannot move
    // the corner much, because the normal level was learned over whole days.
    const t0 = driftStart(series, bm, sign, first);
    if (t0 != null) { onset = Math.round(Math.min(series[first].t, Math.max(baseEnd, t0)) / BUCKET) * BUCKET; method = 'trend'; }
  }
  return { ...out, direction: sign > 0 ? 'up' : 'down', onset, onsetMethod: method, shape: !active ? 'transient' : step ? 'step' : 'drift', active };
}

const pearson = (xs, ys) => {
  const n = xs.length; if (n < 24) return null;
  const mx = xs.reduce((a, v) => a + v, 0) / n, my = ys.reduce((a, v) => a + v, 0) / n; let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx > 1e-12 && syy > 1e-12 ? sxy / Math.sqrt(sxx * syy) : null;
};
// r between two signals' window series; lag in 15-minute steps (±2 h), positive when b follows a.
function correlate(a, b) {
  const mb = new Map(b.map(x => [x.t, x.v])), at = (lag) => { const xs = [], ys = []; for (const p of a) { const q = mb.get(p.t + lag * BUCKET); if (q != null) { xs.push(p.v); ys.push(q); } } return pearson(xs, ys); };
  const r0 = at(0); if (r0 == null) return null;
  let best = { lag: 0, r: r0 };
  for (let lag = -8; lag <= 8; lag++) { const r = at(lag); if (r != null && Math.abs(r) > Math.abs(best.r)) best = { lag, r }; }
  return { r: round(r0), lagMinutes: Math.abs(best.r) - Math.abs(r0) >= 0.1 ? best.lag * 15 : 0, bestR: round(best.r) };
}

// ---- Gathering the evidence ----
function stateEvidence(machineId, ref, end) {
  const from = ref - 24 * HOUR, before = one('SELECT state FROM states WHERE machine_id=? AND ts<=? ORDER BY ts DESC LIMIT 1', machineId, from);
  const changes = all('SELECT ts,state FROM states WHERE machine_id=? AND ts>? AND ts<=? ORDER BY ts', machineId, from, end);
  const minutes = {}; let state = before?.state ?? null, t = from;
  for (const c of changes) { if (state) minutes[state] = (minutes[state] || 0) + (c.ts - t) / MIN; state = c.state; t = c.ts; }
  if (state) minutes[state] = (minutes[state] || 0) + (end - t) / MIN;
  const events = [...changes].sort((a, b) => Math.abs(a.ts - ref) - Math.abs(b.ts - ref)).slice(0, 12).sort((a, b) => a.ts - b.ts);
  const stoppedBefore = [...changes].reverse().find(c => c.ts <= ref && ref - c.ts <= 4 * HOUR && (c.state === 'down' || c.state === 'off'));
  return { from, to: end, stateBefore: before?.state ?? null, events, changes: changes.length, minutes: Object.fromEntries(Object.entries(minutes).map(([k, v]) => [k, Math.round(v)])), stoppedNearOnset: !!stoppedBefore };
}

function pastFindings(f, machine, keys) {
  const rows = all(`SELECT x.*, m.tag, m.type, s.label sig_label, d.status d_status, d.reason d_reason, d.note d_note, a.cause a_cause, a.detail a_detail
    FROM findings x JOIN machines m ON m.id=x.machine_id LEFT JOIN signals s ON s.machine_id=x.machine_id AND s.key=x.signal_key
    LEFT JOIN decisions d ON d.finding_id=x.id AND d.reset_at IS NULL LEFT JOIN actual_causes a ON a.finding_id=x.id
    WHERE x.id<>? AND x.status IN ('confirmed','false_alarm','resolved') AND (x.machine_id=? OR m.type=?) ORDER BY x.last_seen DESC LIMIT 300`, f.id, machine.id, machine.type);
  const score = r => (r.machine_id === machine.id ? 3 : 0) + (r.signal_key && keys.includes(r.signal_key) ? 2 : 0) + (r.kind === f.kind ? 1 : 0) + (r.a_cause ? 2 : 0) + (r.d_status ? 1 : 0);
  const ranked = rows.map(r => ({ r, s: score(r) })).filter(x => (x.r.signal_key && keys.includes(x.r.signal_key)) || (x.r.machine_id === machine.id && x.r.kind === f.kind)).sort((a, b) => b.s - a.s || b.r.last_seen - a.r.last_seen);
  const own = ranked.filter(x => x.r.machine_id === machine.id).slice(0, 6), other = ranked.filter(x => x.r.machine_id !== machine.id).slice(0, 6);
  return [...own, ...other].map(({ r }) => ({ type: 'finding', findingId: r.id, machineTag: r.tag, sameMachine: r.machine_id === machine.id, signalKey: r.signal_key, signalLabel: r.sig_label ?? null, kind: r.kind, severity: r.severity,
    outcome: r.d_status ?? r.status, reason: r.d_reason ? reasonLabel(r.d_reason) : null, note: clip(r.d_note || r.note, 300), actualCause: r.a_cause ?? null, actualDetail: r.a_detail || null, start: r.first_seen, end: r.resolved_at ?? r.last_seen,
    label: `${r.tag} · ${r.sig_label ?? 'signal pattern'} ${r.kind} · ${r.d_status ?? r.status}` }));
}

export function gatherEvidence(f, now = Date.now()) {
  const machine = one('SELECT * FROM machines WHERE id=?', f.machine_id), sigs = all('SELECT * FROM signals WHERE machine_id=? ORDER BY rowid', machine.id);
  const w = evidenceWindow(f, now), a = analysisOf(machine, now), items = new Map(), series = {};
  const signals = sigs.map((s, i) => {
    series[s.key] = buckets(runningPoints(machine.id, s.key, w.from, w.to + MIN));
    const x = assessWindow(series[s.key], w.from, w.to), live = a.signals.find(y => y.key === s.key);
    return { id: `S${i + 1}`, type: 'signal', key: s.key, label: s.label, unit: s.unit, ...x, moved: !!x.moved, latest: live?.latest ?? null,
      limits: { warn_low: s.warn_low, warn_high: s.warn_high, crit_low: s.crit_low, crit_high: s.crit_high }, from: w.from, to: w.to };
  });
  const movers = signals.filter(s => s.moved).sort((p, q) => p.onset - q.onset || p.key.localeCompare(q.key));
  movers.forEach((s, i) => { s.order = i + 1; s.leadMinutes = Math.round((s.onset - movers[0].onset) / MIN); });
  for (const s of signals) { s.spark = downsample(series[s.key] ?? []); items.set(s.id, s); }
  const firstMover = movers[0] ?? null, tied = firstMover ? movers.filter(s => s !== firstMover && s.onset - firstMover.onset <= BUCKET).map(s => s.key) : [];
  const ref = firstMover?.onset ?? f.first_seen;

  // Correlations: pairs where at least one signal moved, strongest first.
  const correlations = []; let c = 0;
  for (let i = 0; i < signals.length; i++) for (let j = i + 1; j < signals.length; j++) {
    const p = signals[i], q = signals[j]; if (!(p.moved || q.moved) || p.status === 'insufficient' || q.status === 'insufficient') continue;
    const r = correlate(series[p.key], series[q.key]);
    if (r && Math.abs(r.r) >= 0.6) correlations.push({ type: 'correlation', a: p.key, b: q.key, aLabel: p.label, bLabel: q.label, r: r.r, lagMinutes: r.lagMinutes, bestR: r.bestR });
  }
  correlations.sort((x, y) => Math.abs(y.r) - Math.abs(x.r)); correlations.length = Math.min(correlations.length, 8);
  correlations.forEach(x => { x.id = `C${++c}`; x.label = `${x.aLabel} ↔ ${x.bLabel}, r = ${x.r}`; items.set(x.id, x); });

  const states = { id: 'H1', type: 'state', label: 'Machine state history', ...stateEvidence(machine.id, ref, w.to) }; items.set('H1', states);

  const pat = a.model.pattern, fd = JSON.parse(f.detail_json || '{}');
  const labelOf = k => sigs.find(s => s.key === k)?.label ?? k;
  const model = { id: 'P1', type: 'model', label: 'Pattern model', trained: !!a.model.trainedAt, trainedAt: a.model.trainedAt, asOf: a.analyzedAt, distance: pat?.distance ?? null, distanceThreshold: a.model.distanceThreshold ?? null, score: pat?.score ?? null, threshold: a.model.threshold ?? null,
    anomaly: !!pat?.isAnomaly, method: pat?.method ?? null, contributors: (pat?.contributors ?? []).map(x => ({ key: x.key, label: labelOf(x.key), value: x.value, normal: x.normal, z: x.z, share: x.share })), explainedBy: pat?.explainedBy ?? null,
    atFinding: f.kind === 'pattern' ? { method: fd.method ?? null, distance: fd.distance ?? null, contributors: (fd.contributors ?? []).map(x => ({ key: x.key, label: labelOf(x.key), value: x.value, normal: x.normal, share: x.share })) } : null };
  items.set('P1', model);

  const keys = [...new Set([f.signal_key, firstMover?.key, ...movers.slice(0, 3).map(s => s.key)].filter(Boolean))];
  const past = pastFindings(f, machine, keys); past.forEach((x, i) => { x.id = `F${i + 1}`; items.set(x.id, x); });

  let passages = [];
  try {
    const sig = sigs.find(s => s.key === f.signal_key), q = [findingQuery(f, machine, sig), ...movers.slice(0, 3).map(s => `${s.label} ${s.direction === 'down' ? 'low' : 'high'}`)].join(' ');
    passages = search(machine.id, q, { limit: 5, signal: firstMover?.key ?? f.signal_key, related: true });
  } catch (e) { console.error('Root cause: manuals search failed:', e.message); }
  const manuals = passages.map((p, i) => ({ id: `D${i + 1}`, type: 'manual', fileId: p.fileId, document: p.document, filename: p.filename, page: p.page, machineTag: p.machineTag, signalKey: p.signalKey, text: clip(p.text, 900), label: `${p.document}${p.page ? `, page ${p.page}` : ''}` }));
  manuals.forEach(x => items.set(x.id, x));

  const tickets = all("SELECT * FROM ticket_drafts WHERE machine_id=? AND status<>'discarded' AND (status IN ('draft','approved') OR created_at>?) ORDER BY created_at DESC LIMIT 6", machine.id, now - 30 * DAY).map((t, i) => {
    const d = JSON.parse(t.draft_json); return { id: `K${i + 1}`, type: 'ticket', ticketId: t.id, findingId: t.finding_id, forThisFinding: t.finding_id === f.id, title: clip(d.title, 160), symptoms: clip(d.symptoms, 400), failureCategory: d.failureCategory, priority: d.priority, status: t.status, createdAt: t.created_at, label: clip(d.title, 80) };
  });
  tickets.forEach(x => items.set(x.id, x));
  return { machine, finding: f, window: w, ref, signals, movers, firstMover, tiedWithFirst: tied, correlations, states, model, past, manuals, tickets, items, byKey: Object.fromEntries(signals.map(s => [s.key, s])), findingDetail: fd };
}

// ---- Mapping an answer back to real evidence ----
const NOTE = { signal: s => s.moved ? `moved ${s.direction} from ${iso(s.onset)}` : s.status === 'insufficient' ? 'not enough history' : 'did not move' };
// The item as sent to the page: what a person needs to read and chart it; large or internal fields are left out.
export function viewOf(item) {
  const { type, id, label } = item;
  if (type === 'signal') return { id, type, label, key: item.key, unit: item.unit, moved: item.moved, status: item.status, direction: item.direction ?? null, onset: item.onset ?? null, shape: item.shape ?? null, order: item.order ?? null, leadMinutes: item.leadMinutes ?? null,
    baseline: item.baseline ?? null, current: item.current ?? null, deltaSpreads: item.deltaSpreads ?? null, from: item.from, to: item.to, spark: item.spark, note: NOTE.signal(item) };
  if (type === 'manual') return { id, type, label, fileId: item.fileId, document: item.document, filename: item.filename, page: item.page, machineTag: item.machineTag, text: clip(item.text, 400) };
  if (type === 'state') return { id, type, label, from: item.from, to: item.to, events: item.events, minutes: item.minutes, stoppedNearOnset: item.stoppedNearOnset };
  if (type === 'model') return { id, type, label, trained: item.trained, distance: item.distance, distanceThreshold: item.distanceThreshold, score: item.score, threshold: item.threshold, contributors: item.contributors, atFinding: item.atFinding };
  return { ...item };
}

const idList = (v, items) => { const given = Array.isArray(v) ? v.map(String) : [], valid = [...new Set(given.filter(i => items.has(i)))]; return { valid, dropped: given.length - valid.length }; };
const lines = (v, max, len) => (Array.isArray(v) ? v : []).map(s => clip(String(s ?? '').trim(), len)).filter(Boolean).slice(0, max);
const cites = (v, items, count) => (Array.isArray(v) ? v : []).slice(0, 8).map(e => { const { valid, dropped } = idList(e?.ids, items); count.dropped += dropped; return { text: clip(String(e?.text ?? '').trim(), 400), ids: valid }; }).filter(e => e.text);

// Turns a raw answer ({ summary, causes, cannotTell }, from the AI or the standard rules) into the stored result:
// citations checked against the evidence that exists (unknown ids dropped), strings and lists bounded, a cause with no
// valid evidence for it held to low confidence.
export function finalizeResult(raw, ev, { source, model = null, now = Date.now(), note = null }) {
  const count = { dropped: 0 }, cited = new Set();
  const causes = (Array.isArray(raw?.causes) ? raw.causes : []).slice(0, 5).map(c => {
    const evidenceFor = cites(c.evidenceFor, ev.items, count), evidenceAgainst = cites(c.evidenceAgainst, ev.items, count);
    let confidence = CONFIDENCE.includes(c.confidence) ? c.confidence : 'low', confidenceReason = clip(String(c.confidenceReason ?? '').trim(), 500), capped = false;
    if (!evidenceFor.some(e => e.ids.length) && confidence !== 'low') { confidence = 'low'; capped = true; confidenceReason = `${confidenceReason} (Held at low: no valid evidence is cited for it.)`.trim(); }
    for (const e of [...evidenceFor, ...evidenceAgainst]) e.ids.forEach(i => cited.add(i));
    return { cause: clip(String(c.cause ?? '').trim(), 200), mechanism: clip(String(c.mechanism ?? '').trim(), 700), confidence, confidenceReason, capped, evidenceFor, evidenceAgainst, checks: lines(c.checks, 6, 300), ruledOutBy: lines(c.ruledOutBy, 5, 300), basis: c.basis ?? undefined };
  }).filter(c => c.cause).map((c, i) => ({ rank: i + 1, ...c }));
  ev.movers.forEach(s => cited.add(s.id));
  const evidence = {}; for (const i of cited) evidence[i] = viewOf(ev.items.get(i));
  const fm = ev.firstMover;
  return { source, model, generatedAt: now, summary: clip(String(raw?.summary ?? '').trim(), 900), causes, cannotTell: lines(raw?.cannotTell, 8, 300), evidence,
    movers: ev.movers.map(s => s.id), firstMover: fm ? { id: fm.id, key: fm.key, label: fm.label, direction: fm.direction, onset: fm.onset, tiedWith: ev.tiedWithFirst } : null,
    window: { from: ev.window.from, to: ev.window.to }, considered: { signals: ev.signals.length, moved: ev.movers.length, correlations: ev.correlations.length, pastFindings: ev.past.length, manuals: ev.manuals.length, tickets: ev.tickets.length },
    droppedRefs: count.dropped, ...(note ? { note } : {}) };
}

// ---- The standard rules (no AI) ----
const WORD = /[\p{L}\p{N}]{4,}/gu;
const words = s => new Set((String(s ?? '').toLowerCase().match(WORD) ?? []));
const overlap = (a, b) => { const wb = words(b); return [...words(a)].filter(w => wb.has(w)).length; };
export function standardAnalysis(ev) {
  const { machine, firstMover, byKey } = ev, rules = ROOT_CAUSE_RULES[machine.type] ?? [];
  const sig = k => byKey[k], dirOf = s => s.moved ? s.direction : 'flat', tied = new Set([firstMover?.key, ...ev.tiedWithFirst]);
  const scored = [];
  rules.forEach((rule, order) => {
    const lead = sig(rule.lead.signal); if (!lead?.moved || lead.direction !== rule.lead.dir) return;
    let score = 0; const forE = [], against = [];
    if (tied.has(lead.key)) { score += 3; forE.push({ text: `${lead.label} moved ${lead.direction} first: ${lead.baseline} → ${lead.current} ${lead.unit} (${lead.deltaSpreads} spreads), from ${iso(lead.onset)}.`, ids: [lead.id] }); }
    else { score += 1.5; forE.push({ text: `${lead.label} moved ${lead.direction} (${lead.baseline} → ${lead.current} ${lead.unit}) but after ${firstMover.label}.`, ids: [lead.id, firstMover.id] }); }
    for (const w of rule.with) {
      const s = sig(w.signal); if (!s || s.status === 'insufficient') continue;
      const actual = dirOf(s);
      if (actual === w.dir) { score += w.w; forE.push({ text: w.dir === 'flat' ? `${s.label} did not move, as expected for this cause.` : `${s.label} also moved ${s.direction}, as expected for this cause.`, ids: [s.id] }); }
      else if (w.dir === 'flat' || (actual !== 'flat' && actual !== w.dir)) { score -= 1; against.push({ text: w.dir === 'flat' ? `${s.label} moved ${s.direction}, which this cause does not usually do.` : `${s.label} moved ${s.direction}, the opposite of what this cause usually shows.`, ids: [s.id] }); }
    }
    scored.push({ rule, order, score, forE, against });
  });
  // Causes confirmed on earlier findings of this type for the signals that moved: a second source of candidates.
  const hist = new Map();
  for (const p of ev.past) if (p.actualCause && p.signalKey && (p.signalKey === firstMover?.key || p.signalKey === ev.finding.signal_key)) {
    const k = p.actualCause.toLowerCase(); const h = hist.get(k) ?? { cause: p.actualCause, ids: [], n: 0 }; h.n++; h.ids.push(p.id); hist.set(k, h);
  }
  const candidates = scored.filter(s => s.score > 0).map(s => {
    const confirmed = ev.past.filter(p => p.actualCause && overlap(p.actualCause, s.rule.cause) >= 2);
    const bonus = confirmed.length ? 1 : 0;
    const manual = ev.manuals.find(m => overlap(m.text, s.rule.cause) >= 2);
    const forE = [...s.forE, ...(confirmed.length ? [{ text: `Found to be the cause on ${confirmed.length === 1 ? 'an earlier finding' : `${confirmed.length} earlier findings`} (${confirmed.map(p => p.machineTag).join(', ')}).`, ids: confirmed.map(p => p.id) }] : []), ...(manual ? [{ text: `A passage of the machine's documents mentions it.`, ids: [manual.id] }] : [])];
    return { total: s.score + bonus, order: s.order, raw: { cause: s.rule.cause, mechanism: `Standard rule for ${MACHINE_TYPES[machine.type].toLowerCase()}s: ${s.rule.lead.signal.replaceAll('_', ' ')} ${s.rule.lead.dir === 'up' ? 'rises' : 'falls'} first${s.rule.with.length ? `, with ${s.rule.with.map(w => `${w.signal.replaceAll('_', ' ')} ${w.dir === 'flat' ? 'unchanged' : w.dir === 'up' ? 'rising' : 'falling'}`).join(', ')}` : ''}.`,
      confidence: s.score + bonus >= 5 ? 'medium' : 'low', confidenceReason: `Standard rules, not AI: the first-moving signal fits (${s.score >= 4.5 ? 'with most companion signals behaving as expected' : 'with few companion signals confirming it'}). Rules know the machine type, not this machine, so confidence is capped at medium.`,
      evidenceFor: forE, evidenceAgainst: s.against, checks: s.rule.checks, ruledOutBy: s.rule.ruledOutBy, basis: 'rule' } };
  });
  for (const h of hist.values()) {
    if (candidates.some(c => overlap(c.raw.cause, h.cause) >= 2)) continue;
    candidates.push({ total: 2 + h.n, order: 99, raw: { cause: h.cause, mechanism: 'Recorded as the actual cause the last time this signal moved on this type of machine.', confidence: h.n >= 2 ? 'medium' : 'low', confidenceReason: `Standard rules, not AI: ${h.n === 1 ? 'one earlier finding' : `${h.n} earlier findings`} of this type ended with this cause.`,
      evidenceFor: [{ text: `Recorded as the cause on ${h.n === 1 ? 'an earlier finding' : `${h.n} earlier findings`}.`, ids: h.ids }], evidenceAgainst: [], checks: ['Check whether the same cause applies again: the repair that fixed it last time'], ruledOutBy: ['The earlier fix is intact and the symptoms differ'], basis: 'history' } });
  }
  candidates.sort((a, b) => b.total - a.total || a.order - b.order);
  let causes = candidates.slice(0, 4).map(c => c.raw);
  if (!causes.length) {
    // No rule fits: the catalogue's usual causes for the signal that moved first (or the finding's own signal).
    const key = firstMover?.key ?? ev.finding.signal_key, dir = firstMover?.direction ?? (ev.findingDetail.side === 'low' || ev.findingDetail.direction === 'down' ? 'down' : 'up'), k = KNOWLEDGE[key] ?? {};
    const list = (k[dir] ?? k.up ?? k.down ?? []).slice(0, 3), anchor = firstMover ?? byKey[key];
    causes = list.map((cause, i) => ({ cause, mechanism: `Usual cause when ${(anchor?.label ?? key ?? 'this signal').toString().toLowerCase()} goes ${dir}.`, confidence: 'low', confidenceReason: 'Standard rules, not AI: no failure pattern for this machine type fits the signals that moved, so this is the catalogue\'s usual list for the signal.',
      evidenceFor: anchor ? [{ text: `${anchor.label} ${anchor.moved ? `moved ${anchor.direction} from ${iso(anchor.onset)}` : 'is the signal of the finding'}.`, ids: [anchor.id] }] : [], evidenceAgainst: [], checks: (k.checks ?? []).slice(0, 3), ruledOutBy: [], basis: 'catalogue' }));
  }
  const m = ev.movers, name = s => s.label;
  const summary = firstMover
    ? `${name(firstMover)} moved first (${firstMover.direction}, from ${iso(firstMover.onset)})${m.length > 1 ? `, followed by ${m.slice(1, 4).map(s => `${name(s)} ${s.leadMinutes >= 60 ? `${round(s.leadMinutes / 60, 1)} h` : `${s.leadMinutes} min`} later`).join(', ')}` : '; no other signal moved'}. ${causes.length ? `The standard rules for this machine type rank "${causes[0].cause}" first.` : 'No standard rule fits.'}`
    : `No signal left its normal band persistently in the window, so the order of events cannot be read from the data. ${causes.length ? `The usual causes for the finding's signal are listed.` : ''}`;
  const cannotTell = ['Standard rules know the machine type and what moved, not this machine\'s service history or what was done to it. Only an inspection can confirm any of these causes.'];
  const thin = ev.signals.filter(s => s.status === 'insufficient'); if (thin.length) cannotTell.push(`Not enough history in the window for ${thin.map(s => s.label).join(', ')}, so whether they moved is unknown.`);
  if (!firstMover) cannotTell.push('No signal moved persistently in the window; the finding may rest on a short event, a limit that was already close, or a change older than five days.');
  if (ev.tiedWithFirst.length) cannotTell.push(`${name(firstMover)} and ${ev.tiedWithFirst.map(k => byKey[k].label).join(', ')} moved within 15 minutes of each other, so which came first cannot be told.`);
  if (ev.states.stoppedNearOnset) cannotTell.push('The machine was stopped shortly before the change began, so a start-up transient (H1) may explain part of it.');
  if (firstMover && (firstMover.shape === 'drift')) cannotTell.push('The first mover drifted slowly, so its start is estimated from its trend line: usually good to within a few hours, but it can be off by up to about half a day when the signal swings strongly over the day.');
  return { summary, causes, cannotTell };
}

// ---- Storing the result ----
export function storedRootCause(findingId) {
  const r = one('SELECT * FROM root_causes WHERE finding_id=?', findingId);
  return r ? { ...JSON.parse(r.result_json), dataVersion: r.data_version, generatedBy: r.generated_by ? one('SELECT name FROM users WHERE id=?', r.generated_by)?.name ?? null : null } : null;
}
export function saveRootCause(f, version, result, userId) {
  const top = result.causes[0];
  run('INSERT INTO root_causes (finding_id,machine_id,data_version,source,result_json,top_cause,top_confidence,generated_at,generated_by) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(finding_id) DO UPDATE SET data_version=excluded.data_version,source=excluded.source,result_json=excluded.result_json,top_cause=excluded.top_cause,top_confidence=excluded.top_confidence,generated_at=excluded.generated_at,generated_by=excluded.generated_by',
    f.id, f.machine_id, version, result.source, JSON.stringify(result), top?.cause ?? null, top?.confidence ?? null, result.generatedAt, userId ?? null);
}

// ---- The actual cause, recorded when a finding is resolved ----
export function actualCauseOf(findingId) {
  const a = one('SELECT a.*, u.name by_name FROM actual_causes a LEFT JOIN users u ON u.id=a.recorded_by WHERE a.finding_id=?', findingId);
  return a ? { cause: a.cause, detail: a.detail, pickedIndex: a.picked_index, by: a.by_name, at: a.recorded_at, topCause: a.top_cause, topSource: a.top_source, topWasRight: a.top_match == null ? null : !!a.top_match } : null;
}
// input: { pick } (the index of one of the suggested causes), { text } (their own words), or both (pick, with detail).
// Runs inside the caller's transaction when there is one. The finding must be resolved.
export function recordActualCause(f, input, userId, now = Date.now()) {
  const cur = one('SELECT status FROM findings WHERE id=?', f.id);
  if (cur?.status !== 'resolved') bad('The actual cause is recorded once the finding is resolved');
  const machine = one('SELECT type FROM machines WHERE id=?', f.machine_id), stored = storedRootCause(f.id), suggested = stored?.causes.map(c => c.cause) ?? [];
  const pick = input?.pick == null || input.pick === '' ? null : Number(input.pick), detail = String(input?.text ?? '').trim().slice(0, 1000);
  let cause;
  if (pick != null) { if (!Number.isInteger(pick) || pick < 0 || pick >= suggested.length) bad('That is not one of the suggested causes'); cause = suggested[pick]; }
  else cause = text(input?.text, 'The actual cause', 300);
  const top = suggested[0] ?? null, match = stored ? (pick === 0 ? 1 : 0) : null;
  run(`INSERT INTO actual_causes (finding_id,machine_id,machine_type,signal_key,cause,detail,picked_index,top_cause,top_source,top_match,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(finding_id) DO UPDATE SET cause=excluded.cause,detail=excluded.detail,picked_index=excluded.picked_index,top_cause=excluded.top_cause,top_source=excluded.top_source,top_match=excluded.top_match,recorded_by=excluded.recorded_by,recorded_at=excluded.recorded_at`,
  f.id, f.machine_id, machine.type, f.signal_key ?? '', cause, pick == null ? '' : detail, pick, top, stored?.source ?? null, match, userId, now);
  return actualCauseOf(f.id);
}

// Per machine type: how often the analysis' top cause was the one the engineer recorded, split by AI and standard rules.
export function rootCauseStats() {
  const rows = all('SELECT machine_type t, top_source s, top_match m, picked_index p FROM actual_causes');
  const blank = () => ({ recorded: 0, compared: 0, right: 0, wrong: 0, inList: 0, ai: { compared: 0, right: 0 }, standard: { compared: 0, right: 0 } });
  const by = {}, total = blank();
  for (const r of rows) for (const g of [by[r.t] ??= blank(), total]) {
    g.recorded++; if (r.p != null) g.inList++;
    if (r.m != null) { g.compared++; r.m ? g.right++ : g.wrong++; const src = g[r.s]; if (src) { src.compared++; if (r.m) src.right++; } }
  }
  const out = x => ({ ...x, rightShare: x.compared ? round(x.right / x.compared, 2) : null });
  return { total: out(total), types: Object.entries(by).map(([type, g]) => ({ type, label: MACHINE_TYPES[type] ?? type, ...out(g) })).sort((a, b) => b.recorded - a.recorded || a.label.localeCompare(b.label)) };
}

// What lists and prompts need about a finding's cause: the recorded one if there is one, else the analysis' first.
export function rootCauseBrief(findingId) {
  const r = one('SELECT source, top_cause, top_confidence, generated_at FROM root_causes WHERE finding_id=?', findingId), a = actualCauseOf(findingId);
  return { analysed: !!r, top: r?.top_cause ? { cause: r.top_cause, confidence: r.top_confidence, source: r.source, at: r.generated_at } : null, actual: a };
}
// The cause a ticket draft or report should state: confirmed (recorded), or the one picked from the analysis (pick: its
// index), or the most likely. Returns null when there is none.
export function rootCauseOf(findingId, pick = null, withChecks = false) {
  const a = actualCauseOf(findingId);
  if (a) return { cause: a.cause, detail: a.detail, confirmed: true, confidence: null, source: null, checks: [], by: a.by };
  const r = one('SELECT source, result_json, top_cause, top_confidence FROM root_causes WHERE finding_id=?', findingId); if (!r?.top_cause) return null;
  if (pick == null && !withChecks) return { cause: r.top_cause, confirmed: false, confidence: r.top_confidence, source: r.source, checks: [] };
  const c = JSON.parse(r.result_json).causes[pick == null ? 0 : Number(pick)]; if (!c) bad('That cause is not in the analysis');
  return { cause: c.cause, mechanism: c.mechanism, confirmed: false, confidence: c.confidence, source: r.source, checks: c.checks ?? [], chosen: pick != null };
}
export const rootCauseSentence = (rc, quote = s => s) => !rc ? '' : rc.confirmed ? `confirmed root cause "${quote(rc.cause)}"${rc.detail ? ` (${quote(rc.detail)})` : ''}` : `${rc.chosen ? 'working hypothesis' : 'most likely root cause'} "${quote(rc.cause)}" (${rc.confidence} confidence, ${rc.source === 'ai' ? 'AI analysis' : 'standard rules'})`;
