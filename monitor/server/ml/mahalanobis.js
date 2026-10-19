// Mahalanobis distance: how far a set of readings is from a machine's usual pattern, measured in a way that knows
// which signals normally move together. Ten degrees above normal is ordinary when the motor current is also up (more
// load), and suspicious when the current is not. Each signal's share of the distance says which ones broke pattern.

// Inverse of a small symmetric matrix by Gauss-Jordan elimination.
function invert(m) {
  const n = m.length, a = m.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c]; if (Math.abs(d) < 1e-12) throw new Error('Signals are perfectly redundant');
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = a[r][c]; for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j]; }
  }
  return a.map(row => row.slice(n));
}

// rows: standardised feature vectors. A small ridge keeps nearly redundant signals stable.
export function fit(rows, { ridge = 0.01 } = {}) {
  const n = rows.length, d = rows[0].length;
  const mean = Array.from({ length: d }, (_, j) => rows.reduce((s, r) => s + r[j], 0) / n);
  const cov = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => rows.reduce((s, r) => s + (r[i] - mean[i]) * (r[j] - mean[j]), 0) / (n - 1) + (i === j ? ridge : 0)));
  return { mean, inv: invert(cov).map(r => r.map(v => Math.round(v * 1e6) / 1e6)) };
}

// Distance and each feature's share of the squared distance (the shares add up to distance²).
export function distance(model, x) {
  const c = x.map((v, i) => v - model.mean[i]);
  const w = model.inv.map(row => row.reduce((s, v, j) => s + v * c[j], 0));
  const shares = c.map((v, i) => v * w[i]);
  return { d: Math.sqrt(Math.max(0, shares.reduce((s, v) => s + v, 0))), shares };
}
