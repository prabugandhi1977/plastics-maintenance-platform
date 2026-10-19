// Robust statistics for condition monitoring. Median and MAD give a "normal" that a few outliers cannot distort; a
// straight-line fit over hourly medians gives the trend and the time left before a limit. Every result carries the
// numbers behind it, so a person can check why a signal was flagged.
export const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// Median absolute deviation, scaled to match a standard deviation for normally distributed data.
export const mad = (xs, med = median(xs)) => xs.length ? 1.4826 * median(xs.map(x => Math.abs(x - med))) : null;
export const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const round = (v, d = 2) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d;

export function linearFit(points) {
  const n = points.length; if (n < 3) return null;
  const mx = points.reduce((a, p) => a + p.x, 0) / n, my = points.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0, sxy = 0, syy = 0; for (const p of points) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2; }
  if (!sxx) return null;
  const slope = sxy / sxx; return { slope, r2: syy ? sxy * sxy / (sxx * syy) : 0, at: x => my + slope * (x - mx) };
}

const HOUR = 3600000;
// Judge one signal from its running points [{t, v}], oldest first. Baseline: everything before the last `recentHours`.
// Unusual: the recent median sits `threshold` spreads or more from the baseline median. Degrading: a steady trend
// (hourly medians over 48 h, a good straight-line fit) that reaches the critical limit within 7 days.
export function assessSignal(points, { limits = {}, recentHours = 12, minBaseline = 120, minRecent = 30, threshold = 4, now = Date.now() } = {}) {
  const cut = now - recentHours * HOUR;
  const base = points.filter(p => p.t < cut).map(p => p.v), recent = points.filter(p => p.t >= cut).map(p => p.v);
  if (base.length < minBaseline || recent.length < minRecent) return { status: 'learning', baselinePoints: base.length, recentPoints: recent.length };
  const bm = median(base), rm = median(recent), spread = Math.max(mad(base, bm), 0.02 * Math.abs(bm), 1e-6), score = (rm - bm) / spread;
  const out = { status: Math.abs(score) >= threshold ? 'unusual' : 'normal', score: round(score, 1), baseline: round(bm), recent: round(rm), spread: round(spread, 3), direction: score >= 0 ? 'up' : 'down' };
  const buckets = new Map();
  for (const p of points) if (p.t >= now - 48 * HOUR) { const k = Math.floor(p.t / HOUR); (buckets.get(k) || buckets.set(k, []).get(k)).push(p.v); }
  const hourly = [...buckets].map(([k, vs]) => ({ x: k, y: median(vs) }));
  const fit = linearFit(hourly);
  // A sudden shift (a bearing that stepped up, a valve that changed) also fits a line, but it is not a trend to project.
  if (fit && isStep(hourly, fit)) out.shape = 'step';
  else if (fit && buckets.size >= 12 && fit.r2 >= 0.5 && Math.abs(fit.slope) * 24 >= spread * 0.5) {
    out.slopePerDay = round(fit.slope * 24); out.trendFit = round(fit.r2);
    const nowFit = fit.at(Math.floor(now / HOUR));
    const hoursTo = bound => bound == null || (fit.slope > 0) !== (bound > nowFit) ? null : Math.max(0, Math.round((bound - nowFit) / fit.slope));
    out.hoursToWarning = hoursTo(fit.slope > 0 ? limits.warn_high : limits.warn_low);
    out.hoursToCritical = hoursTo(fit.slope > 0 ? limits.crit_high : limits.crit_low);
    if (out.hoursToCritical != null && out.hoursToCritical <= 7 * 24) out.status = 'degrading';
  }
  return out;
}

// True when two flat levels with one break explain the series clearly better than a straight line.
export function isStep(points, fit = linearFit(points)) {
  if (!fit || points.length < 12) return false;
  const sse = (xs, f) => xs.reduce((a, p) => a + (p.y - f(p)) ** 2, 0);
  const lineSse = sse(points, p => fit.at(p.x));
  let best = Infinity;
  for (let i = 3; i <= points.length - 3; i++) {
    const a = points.slice(0, i), b = points.slice(i), ma = a.reduce((s, p) => s + p.y, 0) / a.length, mb = b.reduce((s, p) => s + p.y, 0) / b.length;
    best = Math.min(best, sse(a, () => ma) + sse(b, () => mb));
  }
  return best < 0.6 * lineSse;
}

// Where a value stands against its limits: 'critical', 'warning' or null, and which side.
export function limitStatus(v, l) {
  if (v == null) return null;
  if (l.crit_high != null && v >= l.crit_high) return { severity: 'critical', side: 'high', limit: l.crit_high };
  if (l.crit_low != null && v <= l.crit_low) return { severity: 'critical', side: 'low', limit: l.crit_low };
  if (l.warn_high != null && v >= l.warn_high) return { severity: 'warning', side: 'high', limit: l.warn_high };
  if (l.warn_low != null && v <= l.warn_low) return { severity: 'warning', side: 'low', limit: l.warn_low };
  return null;
}
