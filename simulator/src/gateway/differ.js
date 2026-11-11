// Polled protocols (OPC UA, Euromap 63 files) give a picture of the machine now, not a stream of events. The differ
// compares each picture with the last one and rebuilds the events a push protocol would have sent: state changes,
// alarms raised and cleared, new shots, telemetry, and the 15-minute production interval.
const INTERVAL_MS = 15 * 60000;
export class SnapshotDiffer {
  constructor({ site, machineId, meterId, protocol }) { this.base = { site, machineId, protocol }; this.meterId = meterId; this.last = null; this.boundary = null; this.part = null; }
  feed(s) {
    const out = [], msg = (kind, extra, at = s.at) => out.push({ kind, ...this.base, at, ...extra });
    const prev = this.last;
    if (!prev || prev.state !== s.state || prev.reason !== s.reason) msg('state', { deviceId: s.deviceId, state: s.state, reason: s.reason, previous: prev?.state });
    const had = new Set((prev?.alarms ?? []).map(a => a.code)), has = new Set(s.alarms.map(a => a.code));
    for (const a of s.alarms) if (!had.has(a.code)) msg('alarm', { deviceId: s.deviceId, code: a.code, severity: a.severity, message: a.message, alarmState: 'active' });
    for (const a of prev?.alarms ?? []) if (!has.has(a.code)) msg('alarm', { deviceId: s.deviceId, code: a.code, severity: a.severity, message: a.message, alarmState: 'cleared' });
    // Counters can go backwards after a controller reset: start counting again from the new value.
    const dGood = prev ? (s.counters.good >= prev.counters.good ? s.counters.good - prev.counters.good : s.counters.good) : 0;
    const dScrap = prev ? (s.counters.scrap >= prev.counters.scrap ? s.counters.scrap - prev.counters.scrap : s.counters.scrap) : 0;
    if (s.shot && (!prev?.shot || s.shot.n !== prev.shot.n)) msg('shot', { deviceId: s.deviceId, ...s.shot }, s.shot.at ?? s.at);
    msg('telemetry', { deviceId: s.deviceId, ...s });
    this.pending = (this.pending ?? { good: 0, scrap: 0 }); this.pending.good += dGood; this.pending.scrap += dScrap; this.part = s.partNumber ?? this.part;
    const slot = Math.floor(s.at / INTERVAL_MS);
    if (this.boundary == null) this.boundary = slot;
    while (slot > this.boundary) {
      msg('interval', { deviceId: s.deviceId, meterId: this.meterId, periodStart: this.boundary * INTERVAL_MS, periodMinutes: 15, good: this.pending.good, scrap: this.pending.scrap, partNumber: this.part, state: s.state }, (this.boundary + 1) * INTERVAL_MS);
      this.pending = { good: 0, scrap: 0 }; this.boundary++;
    }
    this.last = s; return out;
  }
}
