// Turns what the devices say (bus messages, however they arrived) into the platform's intake events:
//   route 'factory' → POST /api/integrations/factory/events   (state, count, condition, energy, vision, safety, process)
//   route 'iot'     → POST /api/integrations/iot/records       (runningHours, cycleCount, temperature, alarms)
// It is deliberately independent of the transport, so MQTT, OPC UA and Euromap 63 data take the same path.
const REASON = { 'minor stop': 'minor_stop', 'waiting for material': 'waiting_material', 'waiting for operator': 'waiting_operator', 'waiting for quality approval': 'waiting_quality_approval',
  breakdown: 'breakdown', 'start-up': 'start_up', 'mould change': 'mould_change', break: 'break', 'power failure': 'power_failure' };
const iso = t => new Date(t).toISOString();
const r2 = v => Math.round(v * 100) / 100;

export class Translator {
  constructor({ conditionEveryS = 60, iotEveryS = 300, processEveryShots = 10 } = {}) {
    this.opt = { conditionEveryS, iotEveryS, processEveryShots }; this.dev = new Map(); this.meter = new Map(); this.alarmsPending = new Map();
  }
  d(id) { let s = this.dev.get(id); if (!s) { s = { lastCondition: 0, lastIot: 0, shots: 0 }; this.dev.set(id, s); } return s; }

  handle(msg) {
    const out = [], f = item => out.push({ route: 'factory', item }), i = item => out.push({ route: 'iot', item });
    switch (msg.kind) {
      case 'state': {
        // A dead supply is "offline" with no reason; a machine that is down for it reports power_failure.
        const state = msg.state, reason = state === 'offline' ? null : msg.reason ? (REASON[msg.reason] ?? null) : null;
        f({ type: 'state', deviceId: msg.deviceId, at: iso(msg.at), state, ...(reason ? { reason } : {}) }); break;
      }
      case 'alarm': {
        const list = this.alarmsPending.get(msg.deviceId) ?? []; list.push({ code: msg.code, state: msg.alarmState, severity: msg.severity, message: msg.message }); this.alarmsPending.set(msg.deviceId, list);
        i({ deviceId: msg.deviceId, observedAt: iso(msg.at), alarms: this.alarmsPending.get(msg.deviceId).splice(0) }); break;
      }
      case 'telemetry': {
        const s = this.d(msg.deviceId), t = msg.at, v = msg.values;
        if (t - s.lastCondition >= this.opt.conditionEveryS * 1000) {
          s.lastCondition = t;
          if (msg.driveType !== 'electric') f({ type: 'condition', deviceId: msg.deviceId, at: iso(t), parameter: 'hydraulic_oil_temp', value: r2(v.hydraulicOilTempC) });
          f({ type: 'condition', deviceId: msg.deviceId, at: iso(t), parameter: 'pump_vibration', value: r2(v.vibrationMmS) });
          f({ type: 'condition', deviceId: msg.deviceId, at: iso(t), parameter: 'cooling_water_temp', value: r2(v.coolingWaterTempC) });
        }
        if (t - s.lastIot >= this.opt.iotEveryS * 1000) {
          s.lastIot = t;
          i({ deviceId: msg.deviceId, observedAt: iso(t), runningHours: msg.counters.runningHours, cycleCount: msg.counters.cycleCount, temperatureC: r2(v.meltTempC) });
        }
        break;
      }
      case 'shot': {
        const s = this.d(msg.deviceId); s.shots++;
        if (s.shots % this.opt.processEveryShots === 0) f({ type: 'process', deviceId: msg.deviceId, at: iso(msg.at), values: { meltTempC: msg.meltTempC, mouldTempC: msg.mouldTempC, injectionPressureBar: msg.injectionPressureBar, holdPressureBar: msg.holdPressureBar, cycleTimeS: msg.cycleTimeS } });
        break;
      }
      case 'meter': {
        const m = this.meter.get(msg.deviceId) ?? { last: null, boundary: null, peakKw: 0, seen: 0 };
        m.last = msg.energyKwhTotal; m.peakKw = Math.max(m.peakKw, msg.powerKw); m.seen++; if (m.boundary == null) m.boundary = msg.energyKwhTotal; this.meter.set(msg.deviceId, m); break;
      }
      case 'interval': {
        const total = msg.good + msg.scrap;
        if (total > 0) f({ type: 'count', deviceId: msg.deviceId, periodStart: iso(msg.periodStart), periodMinutes: msg.periodMinutes, totalQty: total, scrapQty: msg.scrap, ...(msg.partNumber ? { partNumber: msg.partNumber } : {}) });
        const meterId = msg.meterId, m = meterId && this.meter.get(meterId);
        if (m && m.seen > 0) {
          // A register that went backwards means the meter was replaced or reset: the interval is measured from zero.
          let kwh = m.last - m.boundary; if (kwh < 0) kwh = m.last;
          f({ type: 'energy', deviceId: meterId, periodStart: iso(msg.periodStart), periodMinutes: msg.periodMinutes, kwh: r2(kwh), peakKw: r2(m.peakKw) });
          m.boundary = m.last; m.peakKw = 0; m.seen = 0;
        }
        break;
      }
      case 'inspection': {
        if (msg.inspected > 0) f({ type: 'vision', deviceId: msg.deviceId, station: msg.station, periodStart: iso(msg.periodStart), periodMinutes: msg.periodMinutes, inspected: msg.inspected, rejected: msg.rejected, defects: msg.defects });
        break;
      }
      case 'safety': f({ type: 'safety', deviceId: msg.deviceId, eventType: msg.eventType, source: msg.source ?? 'sensor', at: iso(msg.at), description: msg.description }); break;
      default: break; // fault, aux: simulator-internal or not part of the platform contract yet
    }
    return out;
  }
}
