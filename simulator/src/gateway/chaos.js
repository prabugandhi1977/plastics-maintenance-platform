// Deliberate damage to the data stream, to see how the platform copes: duplicates, reordering, clock skew,
// garbage values, devices nobody mapped. (An outage is Sender.setPaused; counter resets are machine/meter faults.)
import { rng } from '../rng.js';

export class Chaos {
  constructor(seed = 99) { this.rnd = rng(seed); this.cfg = { duplicateRate: 0, reorderRate: 0, garbageRate: 0, unmappedRate: 0, skewSeconds: {} }; this.held = []; this.counts = { duplicated: 0, reordered: 0, garbage: 0, unmapped: 0, skewed: 0 }; }
  set(cfg) { Object.assign(this.cfg, cfg); return this.cfg; }
  clear() { this.cfg = { duplicateRate: 0, reorderRate: 0, garbageRate: 0, unmappedRate: 0, skewSeconds: {} }; }
  apply(route, item) {
    const c = this.cfg, r = this.rnd; let it = item;
    const skew = c.skewSeconds[it.deviceId]; if (skew) { it = skewTime(it, skew); this.counts.skewed++; }
    if (c.unmappedRate && r.chance(c.unmappedRate)) { it = { ...it, deviceId: `ghost-${Math.floor(r.next() * 5)}` }; this.counts.unmapped++; }
    if (c.garbageRate && r.chance(c.garbageRate)) { it = garble(it); this.counts.garbage++; }
    const out = [it];
    if (c.duplicateRate && r.chance(c.duplicateRate)) { out.push(structuredClone(it)); this.counts.duplicated++; }
    if (c.reorderRate && r.chance(c.reorderRate)) { this.held.push({ route, it: out.pop(), after: 3 + Math.floor(r.next() * 10) }); this.counts.reordered++; }
    return out;
  }
  // Held items come back later than newer ones: out of order.
  release(queues) { const still = []; for (const h of this.held) { if (--h.after <= 0) queues[h.route].push(h.it); else still.push(h); } this.held = still; }
}
function skewTime(it, s) { const shift = v => (v ? new Date(Date.parse(v) + s * 1000).toISOString() : v); return { ...it, ...(it.at ? { at: shift(it.at) } : {}), ...(it.observedAt ? { observedAt: shift(it.observedAt) } : {}), ...(it.periodStart ? { periodStart: shift(it.periodStart) } : {}) }; }
function garble(it) {
  if (it.temperatureC != null) return { ...it, temperatureC: 9999 };
  if (it.kwh != null) return { ...it, kwh: -5 };
  if (it.value != null) return { ...it, value: 'NaN' };
  if (it.totalQty != null) return { ...it, scrapQty: it.totalQty + 10 };
  if (it.inspected != null) return { ...it, rejected: it.inspected + 1 };
  return { ...it, deviceId: '' };
}
