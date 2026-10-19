// The analysis behind every screen. Per machine:
//  1. each signal against its limits (limit), its own learned normal (unusual) and its trend (degrading);
//  2. all signals together (pattern), against two models trained on the machine's own older history: a Mahalanobis
//     distance for signals that stop moving together, and an isolation forest for operating states never seen before;
//  3. findings opened, updated and resolved to match, respecting what people decided (a false alarm stays quiet
//     for 24 h), and a health score from what is open.
import { one, all, run, id, transaction } from '../db.js';
import { runningPoints, currentState } from '../ingest.js';
import { assessSignal, limitStatus, median, mad, quantile } from './stats.js';
import { train, score } from './iforest.js';
import { fit, distance } from './mahalanobis.js';

const MIN = 60000, HOUR = 3600000, DAY = 86400000, WINDOW = 15 * MIN;
const RETRAIN_MS = 6 * HOUR, QUIET_AFTER_FALSE_ALARM = DAY;
const round = (v, d = 2) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d;

// 15-minute windows: the median of each signal, only where every signal has enough running points.
export function windows(pointsByKey, keys, from, to) {
  const buckets = new Map();
  keys.forEach((k, i) => { for (const p of pointsByKey[k] || []) if (p.t >= from && p.t < to) { const w = Math.floor(p.t / WINDOW); (buckets.get(w) || buckets.set(w, keys.map(() => [])).get(w))[i].push(p.v); } });
  const out = [];
  for (const [w, cols] of [...buckets].sort((a, b) => a[0] - b[0])) if (cols.every(c => c.length >= 8)) out.push({ t: w * WINDOW, x: cols.map(median) });
  return out;
}

export function trainModel(pointsByKey, keys, now) {
  const rows = windows(pointsByKey, keys, now - 7 * DAY, now - DAY);
  if (rows.length < 96) return null;
  const center = keys.map((_, i) => median(rows.map(r => r.x[i])));
  const scale = keys.map((_, i) => Math.max(mad(rows.map(r => r.x[i]), center[i]), 0.02 * Math.abs(center[i]), 1e-6));
  const z = rows.map(r => r.x.map((v, i) => (v - center[i]) / scale[i]));
  // Windows far outside normal on any signal are left out of the pattern so a past upset does not become "normal".
  const clean = z.filter(x => x.every(v => Math.abs(v) <= 6));
  const model = { keys, center, scale, ...train(clean, { seed: 7 }), mahalanobis: fit(clean) };
  model.threshold = round(Math.max(0.6, quantile(clean.map(x => score(model, x)), 0.995) + 0.02), 3);
  model.distanceThreshold = round(Math.max(3, quantile(clean.map(x => distance(model.mahalanobis, x).d), 0.995) * 1.3), 2);
  model.trainedFrom = rows[0].t; model.trainedTo = rows.at(-1).t + WINDOW;
  return { model, rows: clean.length };
}

// The last two windows both beyond a model's threshold count as an unusual pattern, with the signals that drive it.
export function scorePattern(model, pointsByKey, now) {
  const recent = windows(pointsByKey, model.keys, now - 45 * MIN, now).slice(-2);
  if (recent.length < 2 || !model.mahalanobis) return null;
  const scored = recent.map(r => { const z = r.x.map((v, i) => (v - model.center[i]) / model.scale[i]); return { s: score(model, z), m: distance(model.mahalanobis, z), z, x: r.x }; });
  const last = scored.at(-1), byDistance = scored.every(r => r.m.d > model.distanceThreshold), byForest = scored.every(r => r.s > model.threshold);
  const total = last.m.shares.reduce((a, v) => a + Math.max(0, v), 0) || 1;
  const contributors = model.keys.map((k, i) => ({ key: k, z: round(last.z[i], 1), value: round(last.x[i]), normal: round(model.center[i]), share: round(Math.max(0, last.m.shares[i]) / total, 2) }))
    .sort((a, b) => b.share - a.share || Math.abs(b.z) - Math.abs(a.z)).slice(0, 3);
  return { score: round(last.s, 3), threshold: model.threshold, distance: round(last.m.d, 2), distanceThreshold: model.distanceThreshold,
    isAnomaly: byDistance || byForest, method: byDistance ? 'relationship' : byForest ? 'new_state' : null, contributors };
}

const SEVERITY_PENALTY = { limit: { critical: 55, warning: 30 }, degrading: { critical: 40, warning: 25 }, unusual: { critical: 20, warning: 15 }, pattern: { critical: 20, warning: 15 } };
export function healthOf(findings) {
  const score = Math.max(0, 100 - findings.reduce((a, f) => a + SEVERITY_PENALTY[f.kind][f.severity], 0));
  // Any open finding means at least "watch"; a critical one, or a low score, means "at risk".
  return { score, status: score < 50 || findings.some(f => f.severity === 'critical') ? 'at_risk' : findings.length ? 'watch' : 'good' };
}

const ACTIVE = "status IN ('open','acknowledged','confirmed')";
function syncFindings(machineId, desired, hasData, now) {
  const active = all(`SELECT * FROM findings WHERE machine_id=? AND ${ACTIVE}`, machineId);
  const keyOf = f => `${f.signal_key ?? f.signalKey ?? ''}|${f.kind}`;
  const wanted = new Map(desired.map(d => [keyOf(d), d]));
  for (const f of active) {
    const d = wanted.get(keyOf(f));
    if (d) { run('UPDATE findings SET last_seen=?,severity=?,score=?,detail_json=? WHERE id=?', now, d.severity, d.score ?? null, JSON.stringify(d.detail), f.id); wanted.delete(keyOf(f)); }
    else if (hasData) run("UPDATE findings SET status='resolved',resolved_at=? WHERE id=?", now, f.id);
  }
  for (const d of wanted.values()) {
    const quiet = one("SELECT 1 FROM findings WHERE machine_id=? AND IFNULL(signal_key,'')=? AND kind=? AND status='false_alarm' AND last_seen>?", machineId, d.signalKey ?? '', d.kind, now - QUIET_AFTER_FALSE_ALARM);
    if (!quiet) run("INSERT INTO findings (id,machine_id,signal_key,kind,severity,status,score,detail_json,first_seen,last_seen) VALUES (?,?,?,?,?,'open',?,?,?,?)", id(), machineId, d.signalKey ?? null, d.kind, d.severity, d.score ?? null, JSON.stringify(d.detail), now, now);
  }
}

const cache = new Map();
export function analyzeMachine(machine, now = Date.now()) {
  const sigs = all('SELECT * FROM signals WHERE machine_id=? ORDER BY rowid', machine.id);
  const pointsByKey = Object.fromEntries(sigs.map(s => [s.key, runningPoints(machine.id, s.key, now - 7 * DAY, now + MIN)]));
  const lastPoint = Math.max(0, ...sigs.map(s => pointsByKey[s.key].at(-1)?.t ?? 0));
  const hasData = now - lastPoint <= 30 * MIN;
  const desired = [], signals = [];
  for (const s of sigs) {
    const pts = pointsByKey[s.key];
    const latestPts = pts.filter(p => p.t >= now - 10 * MIN);
    const latest = latestPts.length ? round(median(latestPts.map(p => p.v))) : null;
    const assessment = assessSignal(pts, { limits: s, now });
    const lim = limitStatus(latest, s);
    const base = { signalKey: s.key, label: s.label, unit: s.unit };
    if (lim) desired.push({ ...base, kind: 'limit', severity: lim.severity, score: latest, detail: { latest, ...lim, unit: s.unit } });
    if (assessment.status === 'degrading') desired.push({ ...base, kind: 'degrading', severity: assessment.hoursToCritical <= 48 ? 'critical' : 'warning', score: assessment.hoursToCritical, detail: { ...assessment, latest, unit: s.unit } });
    else if (assessment.status === 'unusual' && !lim) desired.push({ ...base, kind: 'unusual', severity: 'warning', score: assessment.score, detail: { ...assessment, latest, unit: s.unit } });
    signals.push({ key: s.key, label: s.label, unit: s.unit, latest, limitStatus: lim, assessment, limits: { warn_low: s.warn_low, warn_high: s.warn_high, crit_low: s.crit_low, crit_high: s.crit_high } });
  }
  // Machine-level pattern model: retrain every 6 h from the machine's own history.
  const keys = sigs.map(s => s.key);
  let stored = one('SELECT * FROM models WHERE machine_id=?', machine.id), model = stored ? JSON.parse(stored.model_json) : null;
  if (keys.length >= 2 && (!model || now - stored.trained_at > RETRAIN_MS || model.keys.join() !== keys.join() || !model.mahalanobis)) {
    const trained = trainModel(pointsByKey, keys, now);
    if (trained) { model = trained.model; run('INSERT INTO models (machine_id,trained_at,rows,model_json) VALUES (?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET trained_at=excluded.trained_at,rows=excluded.rows,model_json=excluded.model_json', machine.id, now, trained.rows, JSON.stringify(model)); stored = { trained_at: now, rows: trained.rows }; }
  }
  const pattern = model && model.keys.join() === keys.join() ? scorePattern(model, pointsByKey, now) : null;
  // A pattern driven mostly by one signal that already has its own finding is the same problem; report it once.
  const lead = pattern?.contributors[0], explained = lead && lead.share >= 0.6 && desired.some(d => d.signalKey === lead.key);
  if (pattern) pattern.explainedBy = explained ? lead.key : null;
  if (pattern?.isAnomaly && !explained) desired.push({ signalKey: null, kind: 'pattern', severity: pattern.distance > 2 * model.distanceThreshold ? 'critical' : 'warning', score: pattern.distance, detail: pattern });
  transaction(() => syncFindings(machine.id, desired, hasData, now));
  const open = all(`SELECT kind,severity FROM findings WHERE machine_id=? AND ${ACTIVE}`, machine.id);
  const result = {
    machineId: machine.id, analyzedAt: now, hasData, lastData: lastPoint || null, state: currentState(machine.id)?.state ?? 'off',
    health: healthOf(open), signals,
    model: stored ? { trainedAt: stored.trained_at, rows: stored.rows, threshold: model?.threshold ?? null, distanceThreshold: model?.distanceThreshold ?? null, pattern } : { trainedAt: null, rows: 0, pattern: null, note: 'Needs about a day of running data before it can learn this machine.' },
  };
  cache.set(machine.id, result);
  return result;
}

export function analyzeAll(now = Date.now()) { return all('SELECT * FROM machines ORDER BY tag').map(m => analyzeMachine(m, now)); }
// Recent analysis from memory, recomputed when older than five minutes.
export function analysisOf(machine, now = Date.now()) { const c = cache.get(machine.id); return c && now - c.analyzedAt < 5 * MIN ? c : analyzeMachine(machine, now); }
export const forgetAnalysis = machineId => cache.delete(machineId);
