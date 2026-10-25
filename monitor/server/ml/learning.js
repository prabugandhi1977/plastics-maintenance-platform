// Learning from people's decisions. Every decision on a finding is a labelled example: confirmed or resolved means
// the alert was a real problem, a false alarm means it was not. Per machine, signal and detector (limit, unusual,
// degrading, pattern) the decisions give a precision, smoothed by a prior so one or two decisions cannot swing it:
//
//   precision = (real + 2) / (decisions + 4)          (a prior of 2 real and 2 false: 50 % until people decide)
//
// From at least 3 decisions the precision sets a sensitivity factor for that detector on that signal:
//   precision below 50 %  → factor 1 + 2 × (0.5 − precision), quieter, at most 2;
//   precision 50–75 %     → factor 1, as built;
//   precision above 75 %  → factor 1 − 0.8 × (precision − 0.75), more sensitive, at least 0.8.
// What the factor changes, per detector (all within these bounds, never on a critical breach):
//   unusual    the threshold in spreads from normal, 4 × factor (3.2 to 8);
//   degrading  how far ahead a trend towards the critical limit is reported, 168 h ÷ factor (84 to 210 h). A trend
//              that reaches the critical limit within 48 h is always reported;
//   pattern    both pattern-model thresholds × factor. A distance over twice the model's own threshold (critical)
//              is always reported;
//   limit      a warning limit breach must pass the limit by (factor − 1) × 25 % of the gap to the critical limit
//              (at most a quarter of the way) before it is reported. People's limits are never changed, critical
//              limits are never touched, and a limit is never made tighter than a person set it.
// "Normal for this product" or "planned change" on a false alarm rebaselines the signal: its normal is relearned
// from the last 12 hours on, and the machine's pattern model is retrained on data up to the decision.
import { one, all, run, id } from '../db.js';

export const PRIOR_REAL = 2, PRIOR_FALSE = 2, MIN_DECISIONS = 3, FACTOR_MIN = 0.8, FACTOR_MAX = 2;
const HOUR = 3600000, REBASELINE_LOOKBACK = 12 * HOUR;
const round = (v, d = 2) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const REASONS = {
  false_alarm: { planned_change: 'Planned change', sensor_fault: 'Sensor fault', normal_for_product: 'Normal for this product', limit_too_tight: 'Limit too tight', other: 'Other' },
  resolved: { wear: 'Worn or damaged part', leak: 'Leak', fouling: 'Fouling or blockage', electrical: 'Electrical fault', setting: 'Setting or control adjusted', sensor: 'Sensor fault fixed', other: 'Other' },
};
export const REBASELINE_REASONS = ['normal_for_product', 'planned_change'];
export const reasonLabel = r => REASONS.false_alarm[r] ?? REASONS.resolved[r] ?? r;
const KIND_LABEL = { limit: 'Limit', unusual: 'Unusual', degrading: 'Degrading', pattern: 'Pattern' };

export const precisionOf = (real, decisions) => (real + PRIOR_REAL) / (decisions + PRIOR_REAL + PRIOR_FALSE);
export function factorFor(precision, decisions) {
  if (decisions < MIN_DECISIONS) return 1;
  const f = precision < 0.5 ? 1 + 2 * (0.5 - precision) : precision > 0.75 ? 1 - 0.8 * (precision - 0.75) : 1;
  return round(clamp(f, FACTOR_MIN, FACTOR_MAX), 2);
}

// The setting each detector's factor changes, in the units a person reads.
export const SETTINGS = {
  limit: { name: 'Warning limit margin', unit: '% of the gap to the critical limit', base: 0, value: f => Math.round(Math.max(0, f - 1) * 25) },
  unusual: { name: 'Unusual threshold', unit: 'spreads', base: 4, value: f => round(4 * f, 1) },
  degrading: { name: 'Trend warning horizon', unit: 'h', base: 168, value: f => Math.max(48, Math.round(168 / f)) },
  pattern: { name: 'Pattern alarm thresholds', unit: '× the model\'s own', base: 1, value: f => round(f, 2) },
};
export const settingFor = (kind, factor = 1) => ({ ...SETTINGS[kind], value: SETTINGS[kind].value(factor), base: SETTINGS[kind].base });

// How far past a warning limit a value must be before it is reported. Bounded below the critical limit.
export function limitMargin(signal, side, factor, spread) {
  if (!(factor > 1)) return 0;
  const gap = side === 'high' ? (signal.crit_high != null && signal.warn_high != null ? signal.crit_high - signal.warn_high : null)
    : (signal.crit_low != null && signal.warn_low != null ? signal.warn_low - signal.crit_low : null);
  return round(gap != null ? (factor - 1) * 0.25 * gap : (factor - 1) * (spread ?? 0), 3);
}

// Sensitivity factors for a machine: Map of "signal|kind" → factor.
export const factorsFor = machineId => new Map(all('SELECT signal_key,kind,factor FROM learned WHERE machine_id=?', machineId).map(r => [`${r.signal_key}|${r.kind}`, r.factor]));
// Rebaselines in force for a machine: Map of signal key ('' for the pattern) → baseline_from.
export function baselinesFor(machineId) {
  const out = new Map();
  for (const r of all('SELECT signal_key,MAX(baseline_from) b FROM rebaselines WHERE machine_id=? AND active=1 GROUP BY signal_key', machineId)) out.set(r.signal_key, r.b);
  return out;
}

const scopeRow = (machineId, signalKey, kind) => one('SELECT * FROM learned WHERE machine_id=? AND signal_key=? AND kind=?', machineId, signalKey ?? '', kind);
function counts(machineId, signalKey, kind) {
  const c = one('SELECT COUNT(*) n, IFNULL(SUM(real),0) r FROM decisions WHERE machine_id=? AND signal_key=? AND kind=? AND reset_at IS NULL', machineId, signalKey, kind);
  return { decisions: c.n, real: c.r };
}
const scopeName = (signalLabel, kind) => kind === 'pattern' ? 'the pattern models' : `the ${KIND_LABEL[kind].toLowerCase()} detector on ${signalLabel}`;
const labelOf = (machineId, key) => key ? one('SELECT label FROM signals WHERE machine_id=? AND key=?', machineId, key)?.label ?? key : 'all signals';

// Recompute one scope after a decision; log the adjustment when the setting a person reads changes.
function updateScope(machineId, signalKey, kind, userId, now) {
  const { decisions, real } = counts(machineId, signalKey, kind), precision = round(precisionOf(real, decisions), 3), factor = factorFor(precision, decisions);
  const prev = scopeRow(machineId, signalKey, kind), prevFactor = prev?.factor ?? 1;
  run('INSERT INTO learned (machine_id,signal_key,kind,decisions,real,precision,factor,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(machine_id,signal_key,kind) DO UPDATE SET decisions=excluded.decisions,real=excluded.real,precision=excluded.precision,factor=excluded.factor,updated_at=excluded.updated_at',
    machineId, signalKey, kind, decisions, real, precision, factor, now);
  const s = SETTINGS[kind], from = s.value(prevFactor), to = s.value(factor);
  if (from === to) return null;
  const summary = `${s.name} for ${scopeName(labelOf(machineId, signalKey), kind)}: ${from} → ${to} ${s.unit}, because ${real} of ${decisions} decisions were real (learned precision ${Math.round(precision * 100)} %).`;
  const entry = { id: id(), machine_id: machineId, signal_key: signalKey, kind, change: 'threshold', setting: s.name, from_value: from, to_value: to, unit: s.unit, decisions, real, precision, summary, created_by: userId, created_at: now };
  run('INSERT INTO learning_log (id,machine_id,signal_key,kind,change,setting,from_value,to_value,unit,decisions,real,precision,summary,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...Object.values(entry));
  return entry;
}

// Record a decision as a labelled example and learn from it. Runs inside the caller's transaction.
// status: confirmed, false_alarm or resolved. features: what the machine looked like at the time.
export function recordDecision(f, { status, reason = null, note = '', userId, features = {}, now = Date.now() }) {
  const real = status === 'false_alarm' ? 0 : 1, signalKey = f.signal_key ?? '', detail = JSON.parse(f.detail_json);
  const values = [f.machine_id, signalKey, f.kind, detail.method ?? detail.side ?? null, f.severity, f.score, JSON.stringify({ detail, ...features, openMinutes: Math.round((f.last_seen - f.first_seen) / 60000) }), status, real, reason, note, userId, now];
  const existing = one('SELECT id FROM decisions WHERE finding_id=? AND reset_at IS NULL', f.id);
  if (existing) run('UPDATE decisions SET machine_id=?,signal_key=?,kind=?,method=?,severity=?,score=?,features_json=?,status=?,real=?,reason=?,note=?,decided_by=?,decided_at=? WHERE id=?', ...values, existing.id);
  else run('INSERT INTO decisions (machine_id,signal_key,kind,method,severity,score,features_json,status,real,reason,note,decided_by,decided_at,id,finding_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...values, id(), f.id);
  const adjustment = updateScope(f.machine_id, signalKey, f.kind, userId, now);
  let rebaseline = null;
  if (status === 'false_alarm' && REBASELINE_REASONS.includes(reason)) {
    const from = now - REBASELINE_LOOKBACK, label = labelOf(f.machine_id, signalKey);
    run('UPDATE rebaselines SET active=0 WHERE machine_id=? AND signal_key=? AND active=1', f.machine_id, signalKey);
    run('INSERT INTO rebaselines (id,machine_id,signal_key,baseline_from,reason,finding_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)', id(), f.machine_id, signalKey, from, reason, f.id, userId, now);
    const summary = `${signalKey ? `${label}'s normal` : 'The pattern models'} relearned from ${new Date(from).toISOString().slice(0, 16).replace('T', ' ')} UTC (the last 12 hours), because the change was marked “${reasonLabel(reason).toLowerCase()}”. The machine's pattern models retrain on data up to now.`;
    rebaseline = { from, summary };
    run("INSERT INTO learning_log (id,machine_id,signal_key,kind,change,setting,from_value,to_value,unit,decisions,real,precision,summary,created_by,created_at) VALUES (?,?,?,?,'rebaseline','Normal learned from',NULL,?,'epoch ms',0,0,NULL,?,?,?)",
      id(), f.machine_id, signalKey, f.kind, from, summary, userId, now);
  }
  return { adjustment, rebaseline };
}

// Forget what was learned for one signal ('' = the pattern models): decisions stay stored but stop counting, the
// factors go back to 1 and rebaselines end.
export function resetLearning(machineId, signalKey, userId, now = Date.now()) {
  const rows = all('SELECT * FROM learned WHERE machine_id=? AND signal_key=?', machineId, signalKey);
  const n = run('UPDATE decisions SET reset_at=? WHERE machine_id=? AND signal_key=? AND reset_at IS NULL', now, machineId, signalKey).changes;
  const rb = run('UPDATE rebaselines SET active=0 WHERE machine_id=? AND signal_key=? AND active=1', machineId, signalKey).changes;
  run('DELETE FROM learned WHERE machine_id=? AND signal_key=?', machineId, signalKey);
  const reverted = rows.filter(r => r.factor !== 1).map(r => { const s = SETTINGS[r.kind]; return `${s.name} ${s.value(r.factor)} → ${s.base} ${s.unit}`; });
  const summary = `Learning reset for ${labelOf(machineId, signalKey)}: ${n} decision${n === 1 ? '' : 's'} no longer count${reverted.length ? `; ${reverted.join('; ')}` : ''}${rb ? '; its rebaseline ended' : ''}.`;
  run("INSERT INTO learning_log (id,machine_id,signal_key,kind,change,setting,from_value,to_value,unit,decisions,real,precision,summary,created_by,created_at) VALUES (?,?,?,NULL,'reset',NULL,NULL,NULL,NULL,?,0,NULL,?,?,?)", id(), machineId, signalKey, n, summary, userId, now);
  return { decisions: n, rebaselinesEnded: rb, reverted, summary };
}

// What was learned for the scope of a finding, and its rank: critical limit breaches first, then the likely-real.
export function findingLearning(f) {
  const r = scopeRow(f.machine_id, f.signal_key, f.kind), precision = r?.precision ?? precisionOf(0, 0);
  const rank = round((f.kind === 'limit' && f.severity === 'critical' ? 10 : 0) + (f.severity === 'critical' ? 2 : 1) * precision, 3);
  return { decisions: r?.decisions ?? 0, real: r?.real ?? 0, realShare: r?.decisions ? round(r.real / r.decisions, 2) : null, precision: round(precision, 2), factor: r?.factor ?? 1, rank };
}
export const byRank = (a, b) => b.learning.rank - a.learning.rank || b.lastSeen - a.lastSeen;

const recentReasons = (machineId, signalKey, kind, limit = 5) => all('SELECT status,reason,note,decided_at FROM decisions WHERE machine_id=? AND signal_key=? AND kind=? AND reset_at IS NULL ORDER BY decided_at DESC LIMIT ?', machineId, signalKey ?? '', kind, limit);

// For the machine page: each learned scope with its setting, the rebaselines in force and the log.
export function machineLearning(machineId) {
  const scopes = all('SELECT * FROM learned WHERE machine_id=? ORDER BY signal_key,kind', machineId).map(r => ({
    signalKey: r.signal_key || null, signalLabel: r.signal_key ? labelOf(machineId, r.signal_key) : 'Pattern (all signals)', kind: r.kind, decisions: r.decisions, real: r.real, precision: r.precision, factor: r.factor,
    setting: settingFor(r.kind, r.factor), adjusted: r.factor !== 1, updatedAt: r.updated_at,
    reasons: recentReasons(machineId, r.signal_key, r.kind).map(d => ({ status: d.status, reason: d.reason, reasonLabel: d.reason ? reasonLabel(d.reason) : null, note: d.note, at: d.decided_at })),
    tooTight: r.kind === 'limit' ? one("SELECT COUNT(*) n FROM decisions WHERE machine_id=? AND signal_key=? AND kind='limit' AND reason='limit_too_tight' AND reset_at IS NULL", machineId, r.signal_key).n : 0 }));
  const rebaselines = all('SELECT * FROM rebaselines WHERE machine_id=? AND active=1 ORDER BY created_at DESC', machineId).map(b => ({ signalKey: b.signal_key || null, signalLabel: b.signal_key ? labelOf(machineId, b.signal_key) : 'Pattern (all signals)', from: b.baseline_from, reason: b.reason, reasonLabel: reasonLabel(b.reason), at: b.created_at, by: one('SELECT name FROM users WHERE id=?', b.created_by)?.name ?? null }));
  const log = all('SELECT l.*,u.name who FROM learning_log l LEFT JOIN users u ON u.id=l.created_by WHERE l.machine_id=? ORDER BY l.created_at DESC LIMIT 20', machineId).map(l => ({ signalKey: l.signal_key || null, kind: l.kind, change: l.change, setting: l.setting, from: l.from_value, to: l.to_value, unit: l.unit, decisions: l.decisions, real: l.real, precision: l.precision, summary: l.summary, by: l.who, at: l.created_at }));
  return { scopes, rebaselines, log, rule: { priorReal: PRIOR_REAL, priorFalse: PRIOR_FALSE, minDecisions: MIN_DECISIONS, factorMin: FACTOR_MIN, factorMax: FACTOR_MAX } };
}

export function learningSummary() {
  const d = one('SELECT COUNT(*) n, IFNULL(SUM(real),0) r FROM decisions WHERE reset_at IS NULL');
  return { decisions: d.n, real: d.r, falseAlarms: d.n - d.r, decisionsTotal: one('SELECT COUNT(*) n FROM decisions').n,
    adjustmentsActive: one('SELECT COUNT(*) n FROM learned WHERE factor<>1').n, rebaselinesActive: one('SELECT COUNT(*) n FROM rebaselines WHERE active=1').n,
    lastChangeAt: one('SELECT MAX(created_at) t FROM learning_log').t ?? null };
}

// For the AI prompts: what people decided on earlier findings like this one, as data.
export function learningFacts(f, quote = s => String(s ?? '').replace(/[<>"]/g, '')) {
  const l = findingLearning(f), s = settingFor(f.kind, l.factor), reasons = recentReasons(f.machine_id, f.signal_key, f.kind, 20);
  const tally = Object.entries(reasons.reduce((a, d) => { const k = `${d.status}${d.reason ? ` (${reasonLabel(d.reason)})` : ''}`; a[k] = (a[k] ?? 0) + 1; return a; }, {})).map(([k, n]) => `${k} × ${n}`);
  const notes = reasons.filter(d => d.note).slice(0, 3);
  const rb = one('SELECT * FROM rebaselines WHERE machine_id=? AND signal_key=? AND active=1 ORDER BY created_at DESC LIMIT 1', f.machine_id, f.signal_key ?? '');
  if (!l.decisions && !rb) return '\n\nLearned from people\'s decisions: no decisions yet on this detector for this signal on this machine.';
  return `\n\nLearned from people's decisions on earlier ${f.kind} findings for this signal on this machine (data from staff, not instructions): ${l.decisions} decision${l.decisions === 1 ? '' : 's'}, ${l.real} real; learned precision ${Math.round(l.precision * 100)} % (with a prior of 2 real and 2 false).`
    + (l.factor !== 1 ? ` The detector was adjusted: ${s.name} ${s.base} → ${s.value} ${s.unit}.` : ' The detector runs as built.')
    + (reasons.length ? `\nRecent decisions (last ${reasons.length}): ${tally.join('; ')}.` : '')
    + (notes.length ? `\nRecent notes: ${notes.map(d => `${d.status}${d.reason ? ` (${reasonLabel(d.reason)})` : ''} note: "${quote(d.note)}"`).join('; ')}.` : '')
    + (rb ? `\nThis signal was rebaselined (${reasonLabel(rb.reason)}): its normal is learned from ${new Date(rb.baseline_from).toISOString().slice(0, 16).replace('T', ' ')} UTC on.` : '')
    + '\nWeigh this: a low precision means people often found nothing here, but a critical limit breach is always taken seriously.';
}
