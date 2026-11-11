// Actions that change the plant or the data stream while it runs, and timelines of them (scenarios).
// The same actions are available live: POST /act on the control port, or `node src/cli.js act '{"action":"fault",...}'`.
import { FAULTS } from './machine.js';

// ctx: { plant, chaos, sender? }
export function act(ctx, a) {
  const { plant, chaos, sender } = ctx;
  const machine = () => { const m = plant.machine(a.machine); if (!m) throw new Error(`Unknown machine ${a.machine}`); return m; };
  switch (a.action) {
    case 'fault': machine().inject(a.kind, { rampS: a.rampS ?? 1800, holdS: a.holdS ?? null, recoverS: a.recoverS ?? 60, strength: a.strength ?? 1 }); return `fault ${a.kind} on ${a.machine}`;
    case 'repair': machine().repair(a.kind); return `repaired ${a.machine}`;
    case 'changeover': machine().changeOver({ partNumber: a.partNumber, cycleS: a.cycleS, cavities: a.cavities, freshMould: true }, a.minutes ?? 30); return `changeover on ${a.machine}`;
    case 'controller-reset': machine().resetCounters(); return `controller counters reset on ${a.machine}`;
    case 'meter-reset': plant.meters.get(machine().cfg.id).resetRegister(); return `energy meter register reset on ${a.machine}`;
    case 'chaos': return JSON.stringify(chaos.set(a.config ?? {}));
    case 'chaos-clear': chaos.clear(); return 'chaos cleared';
    case 'outage': if (!sender) throw new Error('no gateway uplink in this process'); sender.setPaused(a.on !== false); return `uplink ${a.on !== false ? 'paused' : 'resumed'}`;
    case 'skew': chaos.cfg.skewSeconds[a.deviceId ?? machine().cfg.id] = a.seconds ?? 600; return `clock skew ${a.seconds ?? 600}s on ${a.deviceId ?? a.machine}`;
    default: throw new Error(`Unknown action ${a.action}. Known: fault, repair, changeover, controller-reset, meter-reset, chaos, chaos-clear, outage, skew`);
  }
}

const faultKinds = Object.keys(FAULTS).filter(k => k !== 'power_failure');
export const SCENARIOS = {
  'normal-day': { about: 'A realistic day: cycles, minor stops, a lunch break, energy, scrap and camera events. No faults, clean data.', timeline: () => [] },
  'machine-faults': {
    about: 'Each machine in turn develops a different fault (bearing, cooling, heater, hydraulics, mould, oil, moisture): warning, critical, breakdown, auto-repair.',
    timeline: n => Array.from({ length: n }, (_, i) => ({ atMin: 20 + i * 25, action: 'fault', machine: `SIM-${String(i + 1).padStart(2, '0')}`, kind: faultKinds[i % faultKinds.length], rampS: 1800 }))
  },
  'data-faults': {
    about: 'Dirty data: duplicates, reordering, garbage values, unmapped devices, a 20 min uplink outage, a fast device clock, a controller counter reset and a replaced energy meter.',
    timeline: () => [
      { atMin: 1, action: 'chaos', config: { duplicateRate: 0.05, reorderRate: 0.05, garbageRate: 0.01, unmappedRate: 0.01 } },
      { atMin: 45, action: 'outage', on: true }, { atMin: 65, action: 'outage', on: false },
      { atMin: 80, action: 'skew', machine: 'SIM-01', seconds: 900 }, { atMin: 100, action: 'skew', machine: 'SIM-01', seconds: 0 },
      { atMin: 110, action: 'controller-reset', machine: 'SIM-01' }, { atMin: 125, action: 'meter-reset', machine: 'SIM-02' }
    ]
  },
  'power-cut': { about: 'Mains fails on every machine for 20 minutes, then the plant restarts.', timeline: n => Array.from({ length: n }, (_, i) => ({ atMin: 30, action: 'fault', machine: `SIM-${String(i + 1).padStart(2, '0')}`, kind: 'power_failure', rampS: 1, holdS: 1200 })) },
  load: { about: 'Nothing special happens; use with --machines 200 --speed 60 to see how the platform copes with volume.', timeline: () => [] }
};

// Runs a scenario's timeline against the simulated clock.
export class Timeline {
  constructor(ctx, name, startAt, machines, log = console.log) {
    const sc = SCENARIOS[name]; if (!sc) throw new Error(`Unknown scenario ${name}. Known: ${Object.keys(SCENARIOS).join(', ')}`);
    this.ctx = ctx; this.startAt = startAt; this.log = log; this.items = sc.timeline(machines).sort((a, b) => a.atMin - b.atMin); this.about = sc.about;
  }
  tick(now) { while (this.items.length && now >= this.startAt + this.items[0].atMin * 60000) { const it = this.items.shift(); try { this.log(`[scenario +${it.atMin}m] ${act(this.ctx, it)}`); } catch (e) { this.log(`[scenario +${it.atMin}m] FAILED: ${e.message}`); } } }
}
