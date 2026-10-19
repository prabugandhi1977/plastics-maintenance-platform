// Extended isolation forest (Hariri, Carrasco Kind and Brunner, 2019): an unsupervised anomaly detector that needs no
// labelled failures. Random trees cut the data with random hyperplanes; unusual points are isolated in few cuts, so a
// short average path means an anomaly. Cutting along random directions (rather than one signal at a time, as the
// original isolation forest does) also catches signals that stop moving together, such as motor current rising
// while pressure falls, even when each value alone is within its usual range.
// Scores are 0..1, around 0.5 for ordinary points and towards 1 for anomalies.
// Trees are stored as nested arrays: [normal, offset, left, right] for a cut, [size] for a leaf.

function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Average path length of an unsuccessful search in a binary search tree of n points.
const gauss = rnd => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
const dot = (x, n) => { let s = 0; for (let i = 0; i < n.length; i++) s += x[i] * n[i]; return s; };
export const avgPath = n => n <= 1 ? 0 : n === 2 ? 1 : 2 * (Math.log(n - 1) + 0.5772156649) - 2 * (n - 1) / n;

function build(rows, depth, maxDepth, rnd) {
  if (depth >= maxDepth || rows.length <= 1) return [rows.length];
  const dims = rows[0].length;
  for (let attempt = 0; attempt < 4; attempt++) {
    const normal = Array.from({ length: dims }, () => Math.round(gauss(rnd) * 1e4) / 1e4);
    const proj = rows.map(r => dot(r, normal));
    let lo = Infinity, hi = -Infinity; for (const v of proj) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi <= lo) continue;
    const offset = Math.round((lo + rnd() * (hi - lo)) * 1e4) / 1e4, left = [], right = [];
    rows.forEach((r, i) => (proj[i] < offset ? left : right).push(r));
    return [normal, offset, build(left, depth + 1, maxDepth, rnd), build(right, depth + 1, maxDepth, rnd)];
  }
  return [rows.length];
}

export function train(rows, { trees = 64, sample = 128, seed = 42 } = {}) {
  if (rows.length < 16) throw new Error('At least 16 rows are needed to train');
  const rnd = prng(seed), n = Math.min(sample, rows.length), maxDepth = Math.ceil(Math.log2(n));
  const forest = [];
  for (let t = 0; t < trees; t++) {
    const pick = []; for (let i = 0; i < n; i++) pick.push(rows[Math.floor(rnd() * rows.length)]);
    forest.push(build(pick, 0, maxDepth, rnd));
  }
  return { forest, sample: n };
}

function pathLength(x, node, depth) {
  if (node.length === 1) return depth + avgPath(node[0]);
  return pathLength(x, dot(x, node[0]) < node[1] ? node[2] : node[3], depth + 1);
}
export function score(model, x) {
  const mean = model.forest.reduce((a, tree) => a + pathLength(x, tree, 0), 0) / model.forest.length;
  return 2 ** (-mean / avgPath(model.sample));
}
