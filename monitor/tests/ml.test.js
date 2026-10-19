import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { median, mad, assessSignal, limitStatus, isStep, linearFit } from '../server/ml/stats.js';
import { train, score, avgPath } from '../server/ml/iforest.js';
import { fit, distance } from '../server/ml/mahalanobis.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'monitor-ml-'));
process.env.MONITOR_DATA_DIR = dir;
const { trainModel, scorePattern } = await import('../server/ml/analyze.js');
const { db } = await import('../server/db.js');
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const HOUR = 3600000, NOW = Date.parse('2026-10-19T12:00:00Z');
// Deterministic noise.
let seed = 1; const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 2; };
const series = (fn, days = 7) => { const pts = []; for (let t = NOW - days * 24 * HOUR; t < NOW; t += 60000) pts.push({ t, v: fn(t) }); return pts; };

test('median and MAD are robust to outliers', () => {
  assert.equal(median([1, 2, 3, 100]), 2.5);
  assert.ok(Math.abs(mad([10, 10.1, 9.9, 10, 500]) - 1.4826 * 0.1) < 1e-9);
});

test('a steady signal is normal; a sudden step is unusual and recognised as a step, not a trend', () => {
  const steady = series(() => 45 + noise() * 0.5);
  assert.equal(assessSignal(steady, { now: NOW, limits: { warn_high: 55, crit_high: 65 } }).status, 'normal');
  const stepped = series(t => 2.1 + noise() * 0.15 + (t > NOW - 18 * HOUR ? 1.5 : 0));
  const a = assessSignal(stepped, { now: NOW, limits: { warn_high: 4.5, crit_high: 7.1 } });
  assert.equal(a.status, 'unusual'); assert.equal(a.direction, 'up'); assert.equal(a.shape, 'step'); assert.equal(a.hoursToCritical, undefined);
});

test('a steady rise is degrading, with the hours left before each limit', () => {
  const rising = series(t => 45 + noise() * 0.6 + Math.max(0, (t - (NOW - 3 * 24 * HOUR)) / (24 * HOUR)) * 2.6);
  const a = assessSignal(rising, { now: NOW, limits: { warn_high: 55, crit_high: 65 } });
  assert.equal(a.status, 'degrading');
  assert.ok(a.slopePerDay > 2 && a.slopePerDay < 3.2, `slope ${a.slopePerDay}`);
  assert.ok(a.hoursToCritical > 60 && a.hoursToCritical < 130, `hours ${a.hoursToCritical}`);
  assert.ok(a.hoursToWarning < a.hoursToCritical);
  assert.equal(isStep([...Array(48)].map((_, i) => ({ x: i, y: i * 0.1 }))), false);
});

test('too little history means learning, never an alarm', () => {
  const short = series(() => 99, 0.05);
  assert.equal(assessSignal(short, { now: NOW }).status, 'learning');
});

test('limits: critical wins over warning, on either side', () => {
  const l = { warn_low: 6, crit_low: 5, warn_high: 55, crit_high: 65 };
  assert.deepEqual(limitStatus(66, l), { severity: 'critical', side: 'high', limit: 65 });
  assert.deepEqual(limitStatus(5.5, l), { severity: 'warning', side: 'low', limit: 6 });
  assert.equal(limitStatus(30, l), null);
  assert.equal(linearFit([{ x: 1, y: 1 }]), null);
});

test('pattern models: the distance catches signals that stop moving together; the forest catches a state never seen', () => {
  // Two signals that move together (motor current follows pressure) plus an independent one.
  const rows = []; for (let i = 0; i < 600; i++) { const p = noise() * 2; rows.push([p + noise() * 0.15, p + noise() * 0.15, noise()]); }
  const m = fit(rows), forest = train(rows, { seed: 3 });
  const trainD = rows.map(r => distance(m, r).d).sort((a, b) => a - b), q995 = trainD[597];
  const broken = distance(m, [0.8, -0.8, 0]);
  assert.ok(broken.d > 3 * q995, `broken relationship ${broken.d} vs normal q99.5 ${q995}`);
  assert.ok(distance(m, [1.8, 1.8, 0]).d < q995 * 1.3, 'the far end of normal operation is not an anomaly');
  assert.ok(broken.shares[0] > 0.3 * broken.d ** 2 && broken.shares[1] > 0.3 * broken.d ** 2, 'both related signals carry the distance');
  const trainS = rows.map(r => score(forest, r)).sort((a, b) => a - b);
  assert.ok(score(forest, [9, 9, 6]) > trainS[597], 'a state far outside the history isolates quickly');
  assert.ok(score(forest, [0, 0, 0]) < 0.55);
  assert.equal(avgPath(1), 0);
  assert.throws(() => train([[1]]), /16 rows/);
});

test('end to end: a relationship break between two signals is flagged as a pattern, with the signals named', () => {
  const pointsByKey = { pressure: [], current: [] }, from = NOW - 7 * 24 * HOUR;
  for (let t = from; t < NOW; t += 60000) {
    const load = Math.sin(t / (5 * HOUR)) * 3 + noise() * 0.3, broken = t > NOW - 40 * 60000;
    pointsByKey.pressure.push({ t, v: 1200 + load * 20 + noise() * 3 });
    pointsByKey.current.push({ t, v: 82 + (broken ? -load : load) * 2 + noise() * 0.3 });
  }
  const { model } = trainModel(pointsByKey, ['pressure', 'current'], NOW);
  const p = scorePattern(model, pointsByKey, NOW);
  assert.equal(p.isAnomaly, true); assert.equal(p.method, 'relationship');
  assert.ok(p.distance > model.distanceThreshold);
  const quiet = scorePattern(model, pointsByKey, NOW - 3 * HOUR);
  assert.equal(quiet.isAnomaly, false);
});
