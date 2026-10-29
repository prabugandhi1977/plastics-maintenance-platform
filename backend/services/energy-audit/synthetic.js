// Deterministic synthetic power traces of an injection moulding machine, for the demo and the tests. No clock, no
// Math.random: the same arguments always give the same samples.
function rng(seed) { let a=seed>>>0; return ()=>{ a=(a+0x6D2B79F5)>>>0; let t=a; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; }

// HMI-style phase plan of a fixed-pump hydraulic machine: [name, seconds, kW, category]. Peak at mould close, a high plateau in
// holding, moderate cooling, spikes at open and eject, a short rest at the end.
export const FIXED_PUMP_PHASES=[['Mould close',2.5,15,'close'],['Lock up',1,19,'lockup'],['Filling',2,26,'injection'],['Holding',6,20,'holding'],['Charge',5.5,14,'charge'],['Cooling',12,11,'cooling'],['Unlock',0.8,11,'open'],['Mould open',2.2,14,'open'],['Eject',1.5,16,'eject'],['Take-out',1.5,8,'other']];
// A servo-driven pump: same work, far lower power while holding and cooling and a low standby.
export const SERVO_PHASES=[['Mould close',2.5,13,'close'],['Lock up',1,14,'lockup'],['Filling',2,24,'injection'],['Holding',6,5.5,'holding'],['Charge',5.5,10,'charge'],['Cooling',12,3.2,'cooling'],['Unlock',0.8,6,'open'],['Mould open',2.2,9,'open'],['Eject',1.5,8,'eject'],['Take-out',1.5,3,'other']];
export const templateOf=plan=>plan.map(([name,seconds,,category])=>({name,seconds,category}));

// opts: {startMs, stepMs=100, cycles=60, plan, restS=2, restKw, spike:{kw,s}, noise=0.03, jitterS=0.3, warmupS=0, standbyKw, pauses:[{afterCycle,seconds}], missing:[cycleIndex], seed=1, withPf=true, counter=false}
export function genTrace(o={}) {
  const rnd=rng(o.seed??1), plan=o.plan||FIXED_PUMP_PHASES, step=o.stepMs??100, noise=o.noise??0.03, standby=o.standbyKw??8, restKw=o.restKw??standby, pfFloor=o.pfFloor??0.35;
  const spike=o.spike===undefined?{kw:24,s:0.6}:o.spike, peak=Math.max(...plan.map(p=>p[2]),spike?spike.kw:0), out=[];
  let t=o.startMs, n=0, cyc=0;
  const emit=(kw,counter)=>{ const v=Math.max(0,kw*(1+noise*(rnd()*2-1))); const s={ts:t,kw:Math.round(v*1000)/1000}; if (o.withPf!==false) s.pf=Math.round(Math.min(0.97,pfFloor+(0.97-pfFloor)*Math.min(1,v/peak))*1000)/1000; if (o.counter) s.cyc=counter; out.push(s); t+=step; n++; };
  const hold=(seconds,kw)=>{ for (let i=0;i<Math.round(seconds*1000/step);i++) emit(kw,cyc); };
  hold(o.warmupS||0,standby);
  for (let c=0;c<(o.cycles??60);c++) {
    if ((o.missing||[]).includes(c)) { hold(plan.reduce((n,p)=>n+p[1],0)+(o.restS??2),standby); continue; }
    cyc++;
    const jitter=(rnd()*2-1)*(o.jitterS??0.3);
    plan.forEach(([name,s,kw],i)=>{ const secs=name==='Cooling'?s+jitter:s; if (i===0&&spike) { hold(spike.s,spike.kw); hold(secs-spike.s,kw); } else hold(secs,kw); });
    hold(o.restS??2,restKw);
    for (const p of o.pauses||[]) if (p.afterCycle===c) hold(p.seconds,standby);
  }
  return out;
}
export const rowsOf=samples=>samples.map(s=>({ts:s.ts,kw:s.kw,pf:s.pf??null,amps:null,volts:null,kva:null,thd:null,kwh_total:null,cyc:s.cyc??null}));
