// Hand-drawn SVG charts. Colours come from the theme tokens (CSS variables), so they follow light and dark mode.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0)), step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n + 0.5);
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6); return out;
}
const fmtTime = (t, long) => { const d = new Date(t); return long ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };

// points: [[t, v]]; limits: {warn_low, ...}; assessment: {baseline, spread, slopePerDay}; from/to: ms.
export function signalChart({ points, limits = {}, assessment = {}, unit = '', from, to, latest }) {
  const W = 640, H = 230, L = 46, R = 14, T = 12, B = 26;
  const projectTo = assessment.status === 'degrading' && assessment.slopePerDay ? to + (to - from) * 0.25 : to;
  const proj = projectTo > to && latest != null ? [[to, latest], [projectTo, latest + assessment.slopePerDay * (projectTo - to) / 86400000]] : null;
  const vals = points.map(p => p[1]);
  const band = assessment.baseline != null ? [assessment.baseline - 3 * assessment.spread, assessment.baseline + 3 * assessment.spread] : null;
  const lims = ['warn_low', 'warn_high', 'crit_low', 'crit_high'].map(k => limits[k]).filter(v => v != null);
  let lo = Math.min(...vals, ...(band || []), ...(proj ? proj.map(p => p[1]) : [])), hi = Math.max(...vals, ...(band || []), ...(proj ? proj.map(p => p[1]) : []));
  // Show the nearest limits only when they are reasonably close, so the data is not squashed flat.
  for (const l of lims) if (Math.abs(l - (lo + hi) / 2) <= (hi - lo) * 2 + Math.abs(hi) * 0.15) { lo = Math.min(lo, l); hi = Math.max(hi, l); }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const x = t => L + (t - from) / (projectTo - from) * (W - L - R), y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const ticks = niceTicks(lo, hi), long = to - from > 2 * 86400000;
  const xt = []; const stepX = long ? 86400000 : 4 * 3600000; for (let t = Math.ceil(from / stepX) * stepX; t <= to; t += stepX) xt.push(t);
  let path = '', gap = (to - from) / 120;
  points.forEach((p, i) => { path += (i && p[0] - points[i - 1][0] <= Math.max(gap, 180000) ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); });
  const limitLine = (v, cls, label) => v == null || v < lo || v > hi ? '' : `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--chart-${cls})" stroke-dasharray="${cls === 'crit' ? '0' : '5 4'}" stroke-width="1.3"/><text x="${W - R - 2}" y="${y(v) - 4}" text-anchor="end">${label} ${v}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Chart of readings with limits and normal range">
    ${ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--chart-grid)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    ${xt.map(t => `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${esc(fmtTime(t, long))}</text>`).join('')}
    ${band ? `<rect x="${L}" width="${x(to) - L}" y="${y(band[1])}" height="${Math.max(0, y(band[0]) - y(band[1]))}" fill="var(--chart-band)"/>` : ''}
    ${limitLine(limits.warn_high, 'warn', 'warn')}${limitLine(limits.warn_low, 'warn', 'warn')}${limitLine(limits.crit_high, 'crit', 'crit')}${limitLine(limits.crit_low, 'crit', 'crit')}
    <path d="${path}" fill="none" stroke="var(--chart-line)" stroke-width="1.6" stroke-linejoin="round"/>
    ${proj ? `<line x1="${x(proj[0][0])}" y1="${y(proj[0][1])}" x2="${x(proj[1][0])}" y2="${y(proj[1][1])}" stroke="var(--chart-crit)" stroke-width="1.6" stroke-dasharray="3 4"/><text x="${x(proj[1][0]) - 2}" y="${y(proj[1][1]) - 6}" text-anchor="end">trend</text>` : ''}
    ${points.length ? `<circle cx="${x(points.at(-1)[0])}" cy="${y(points.at(-1)[1])}" r="3.5" fill="var(--chart-line)"/>` : ''}
    ${!points.length ? `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">No readings in this period</text>` : ''}
    <text x="${L}" y="${T - 2}" dy="0">${esc(unit)}</text>
  </svg>`;
}

export function sparkline(points, status) {
  if (!points?.length) return '<svg class="spark" viewBox="0 0 200 38"></svg>';
  const vs = points.map(p => p[1]), lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1, t0 = points[0][0], t1 = points.at(-1)[0] || t0 + 1;
  const pts = points.map(p => `${((p[0] - t0) / (t1 - t0 || 1) * 196 + 2).toFixed(1)},${(34 - (p[1] - lo) / span * 30).toFixed(1)}`).join(' ');
  const color = status === 'critical' ? 'var(--chart-crit)' : ['warning', 'degrading', 'unusual'].includes(status) ? 'var(--chart-warn)' : 'var(--chart-line)';
  return `<svg class="spark" viewBox="0 0 200 38" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}
