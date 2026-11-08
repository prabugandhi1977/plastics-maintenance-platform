// Seeded random numbers: the same seed always produces the same plant, so a bug found in a run can be replayed.
export function rng(seed = 1) {
  let a = (typeof seed === 'string' ? hash(seed) : seed) >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    next,
    between: (lo, hi) => lo + next() * (hi - lo),
    // Roughly normal (sum of three uniforms), mean 0, sd ~1.
    gauss: () => (next() + next() + next() - 1.5) * 2,
    chance: p => next() < p,
    pick: list => list[Math.floor(next() * list.length)],
    weighted(entries) { const total = entries.reduce((s, [, w]) => s + w, 0); let r = next() * total; for (const [k, w] of entries) { r -= w; if (r <= 0) return k; } return entries.at(-1)[0]; }
  };
}
export function hash(text) { let h = 2166136261; for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round = (v, d = 2) => { const f = 10 ** d; return Math.round(v * f) / f; };
