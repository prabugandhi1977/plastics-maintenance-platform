// Factory simulator: realistic machine states and output for production machines, generated in 15-minute slots and
// written through the same recordState/recordCount path real PLC and sensor adapters will use. Deterministic per
// machine and slot, so a re-run produces the same history. Enabled with FACTORY_SIMULATOR=true (off by default, so it
// never invents data for real customers on a live site).
import { one, all, run, transaction } from '../db.js';
import { recordState, recordCount, currentProduct, plantOf, stateAlerts } from './production.js';
import { shiftWindows, inShift } from './time.js';
import { PRODUCTION_MACHINES, parametersFor } from '../catalog.js';
import { recordEnergy } from './energy.js';
import { recordCondition } from './condition.js';

export const SLOT_MIN=15, SLOT=SLOT_MIN*60000, BACKFILL_DAYS=7;
export const simulatorEnabled=()=>process.env.FACTORY_SIMULATOR==='true';
// Small deterministic hash → [0,1).
export function rand(...parts) { let h=2166136261; for (const ch of parts.join('|')) { h^=ch.charCodeAt(0); h=Math.imul(h,16777619); } h^=h>>>13; h=Math.imul(h,0x5bd1e995); h^=h>>>15; return (h>>>0)/4294967296; }
const pick=(list,r)=>list[Math.floor(r*list.length)%list.length];
// Each machine gets a stable character: how reliable it is, how close to ideal speed it runs, how much scrap it makes.
const character=e=>({reliability:0.6+rand(e.id,'rel')*0.8, speed:0.8+rand(e.id,'spd')*0.17, scrap:0.008+rand(e.id,'scr')*0.03});

// Average electrical power when running, from the machine's data sheet (all-electric presses use far less).
function ratedKw(e) {
  const s=JSON.parse(e.specs||'{}');
  if (e.machine_type==='injection') return (s.clampForceKn||1500)/1000*({hydraulic:22,hybrid:12,electric:4}[s.driveType]||18);
  if (e.machine_type==='extrusion') return (s.outputKgH||200)*0.28;
  if (e.machine_type==='blow') return 20+(s.clampForceKn||200)*0.08;
  return 20;
}
const STATE_POWER={running:1,setup:0.45,idle:0.4,down:0.15,planned_stop:0.05};
// Condition signal model: [mean while on, daily swing, noise, value when off, drift span when degrading].
const SIGNALS={hydraulic_oil_temp:[46,3,1.2,30,24],pump_vibration:[2.1,0.2,0.35,0.3,6],cooling_water_temp:[16,2.5,0.6,15,14],gearbox_oil_temp:[58,3,1.5,30,32],melt_pressure:[230,8,10,0,140],air_pressure:[7.2,0.1,0.15,7.4,-2.6]};
// Some machines have one slowly failing part: its signal drifts over a repeating 10-day cycle (then is "repaired"),
// so the demo shows readings crossing warning and critical limits and tickets being raised.
const degrading=e=>{ const params=parametersFor(e.machine_type); return rand(e.id,'degr')<0.6&&params.length?params[Math.floor(rand(e.id,'dparam')*params.length)%params.length].key:null; };
function signal(e,key,t,state) {
  const [mean,swing,noiseAmp,off,span]=SIGNALS[key], on=['running','setup','idle'].includes(state), noise=(rand(e.id,key,String(t))-0.5)*2;
  if (!on) return Math.round((off+noise*noiseAmp*0.5)*100)/100;
  let v=mean+swing*Math.sin(2*Math.PI*((t/3600000)%24)/24)+noise*noiseAmp;
  if (degrading(e)===key) { const phase=(((t/86400000)+rand(e.id,'phase')*10)%10)/10; v+=span*phase*phase; }
  return Math.round(v*100)/100;
}

function nextState(prev,e,slot,ch) {
  const r=rand(e.id,slot,'state'), r2=rand(e.id,slot,'reason');
  if (!prev||prev.state==='planned_stop'&&prev.reason_code==='no_production_planned') return ['setup','start_up'];
  switch (prev.state) {
    case 'running': {
      const down=0.012/ch.reliability, setup=0.012, idle=0.025, brk=0.012;
      if (r<down) return ['down',pick(['breakdown','breakdown','mould_fault','auxiliary_fault','quality_stop'],r2)];
      if (r<down+setup) return ['setup',pick(['mould_change','colour_change','material_change'],r2)];
      if (r<down+setup+idle) return ['idle',pick(['waiting_material','waiting_operator','minor_stop','waiting_quality_approval'],r2)];
      if (r<down+setup+idle+brk) return ['planned_stop','break'];
      return ['running',null];
    }
    case 'down': return r<0.3*ch.reliability?['running',null]:[prev.state,prev.reason_code];
    case 'setup': return r<(prev.reason_code==='start_up'?0.7:0.33)?['running',null]:[prev.state,prev.reason_code];
    case 'idle': return r<0.6?['running',null]:[prev.state,prev.reason_code];
    case 'planned_stop': return r<0.85?['running',null]:[prev.state,prev.reason_code];
    default: return ['running',null];
  }
}

// Generates slots for one machine from its cursor (or BACKFILL_DAYS ago) up to `until`.
export function simulateMachine(e,until=Date.now()) {
  const plant=plantOf(e), ch=character(e), product=currentProduct(e), params=parametersFor(e.machine_type);
  const cursor=one("SELECT until FROM factory_cursors WHERE equipment_id=? AND stream='production'",e.id);
  let t=cursor?Date.parse(cursor.until):Math.floor((until-BACKFILL_DAYS*86400000)/SLOT)*SLOT;
  const end=Math.floor(until/SLOT)*SLOT; if (t>=end) return 0;
  const windows=shiftWindows(plant,t,end), recentFrom=until-2*3600000;
  let slots=0, prev=one('SELECT state,reason_code FROM machine_states WHERE equipment_id=? AND ended_at IS NULL',e.id), afterSetup=false;
  transaction(()=>{
    for (; t<end; t+=SLOT, slots++) {
      const at=new Date(t).toISOString(), slot=String(t/SLOT);
      const [state,reason]=inShift(windows,t)?nextState(prev,e,slot,ch):['planned_stop','no_production_planned'];
      const change=recordState(e,state,reason,at,'simulator');
      // Alerts only for recent events, so the first backfill does not flood the alert list.
      if (t>=recentFrom) stateAlerts(e,state,reason,change,at);
      if (state==='running') {
        const rate=product.ideal_rate_per_hour*ch.speed*(0.96+rand(e.id,slot,'rate')*0.06), totalRaw=rate*SLOT_MIN/60;
        const total=product.unit==='parts'?Math.round(totalRaw):Math.round(totalRaw*10)/10;
        const scrapShare=ch.scrap*(0.5+rand(e.id,slot,'scrap'))+(afterSetup?0.05:0);
        recordCount(e,{periodStart:at,periodMinutes:SLOT_MIN,totalQty:total,scrapQty:product.unit==='parts'?Math.round(total*scrapShare):Math.round(total*scrapShare*10)/10,unit:product.unit,idealRatePerHour:product.ideal_rate_per_hour,productId:product.id},'simulator');
      }
      const kw=ratedKw(e)*(state==='planned_stop'&&reason==='break'?0.35:STATE_POWER[state])*(0.92+rand(e.id,slot,'kw')*0.16);
      recordEnergy(e,{periodStart:at,periodMinutes:SLOT_MIN,kwh:Math.round(kw*SLOT_MIN/60*100)/100,peakKw:Math.round(kw*(state==='running'?1.35:1.1)*10)/10},'simulator');
      // Readings are judged against limits only for recent slots, so a first backfill does not raise old alerts.
      for (const p of params) recordCondition(e,p.key,signal(e,p.key,t,state),at,'simulator',{evaluate:t>=recentFrom});
      afterSetup=state==='setup'; prev={state,reason_code:reason||null};
    }
    run("INSERT INTO factory_cursors (equipment_id,stream,until) VALUES (?,'production',?) ON CONFLICT(equipment_id,stream) DO UPDATE SET until=excluded.until",e.id,new Date(end).toISOString());
  });
  return slots;
}
export function simulateAll(until=Date.now()) {
  const machines=all(`SELECT * FROM equipment WHERE status='in_service' AND machine_type IN (${PRODUCTION_MACHINES.map(()=>'?').join(',')})`,...PRODUCTION_MACHINES);
  return machines.reduce((n,e)=>n+simulateMachine(e,until),0);
}
