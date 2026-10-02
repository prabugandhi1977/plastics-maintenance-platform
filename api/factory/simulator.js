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
import { recordVision } from './quality.js';
import { recordSafety } from './safety.js';
import { recordSighting } from './assets.js';
import { DEFECT_TYPES } from '../catalog.js';

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
        const scrap=product.unit==='parts'?Math.round(total*scrapShare):Math.round(total*scrapShare*10)/10;
        // Camera station at the machine outlet: parts are inspected one by one; extruded product by an inline gauge
        // taking a measurement every 15 seconds. Rejects are split over the defects typical for the process.
        const inspected=product.unit==='parts'?total:60, rejected=product.unit==='parts'?scrap:Math.round(60*scrapShare);
        recordVision(e,{station:'Camera 1',periodStart:at,periodMinutes:SLOT_MIN,inspected,rejected,defects:splitDefects(e,slot,rejected)},'simulator',{evaluate:t>=recentFrom});
        recordCount(e,{periodStart:at,periodMinutes:SLOT_MIN,totalQty:total,scrapQty:scrap,unit:product.unit,idealRatePerHour:product.ideal_rate_per_hour,productId:product.id},'simulator');
      }
      const kw=ratedKw(e)*(state==='planned_stop'&&reason==='break'?0.35:STATE_POWER[state])*(0.92+rand(e.id,slot,'kw')*0.16);
      recordEnergy(e,{periodStart:at,periodMinutes:SLOT_MIN,kwh:Math.round(kw*SLOT_MIN/60*100)/100,peakKw:Math.round(kw*(state==='running'?1.35:1.1)*10)/10},'simulator');
      // Readings are judged against limits only for recent slots, so a first backfill does not raise old alerts.
      for (const p of params) recordCondition(e,p.key,signal(e,p.key,t,state),at,'simulator',{evaluate:t>=recentFrom});
      // Safety camera over the machine: occasional PPE or guarding events while people work at it.
      if (['running','setup','down'].includes(state)&&rand(e.id,slot,'safety')<(state==='running'?0.003:0.03)) simulatedSafety(e,plant,t,until,state);
      afterSetup=state==='setup'; prev={state,reason_code:reason||null};
    }
    run("INSERT INTO factory_cursors (equipment_id,stream,until) VALUES (?,'production',?) ON CONFLICT(equipment_id,stream) DO UPDATE SET until=excluded.until",e.id,new Date(end).toISOString());
  });
  return slots;
}
// Each machine has two or three typical defects (a mould with a worn vent burns, a hot one sinks…).
function splitDefects(e,slot,rejected) {
  const types=DEFECT_TYPES[e.machine_type]||[], out={}; if (!rejected||!types.length) return out;
  const own=[0,1,2].map(i=>types[Math.floor(rand(e.id,'defect',i)*types.length)%types.length]), weights=[0.6,0.28,0.12];
  for (let i=0,left=rejected; i<3&&left>0; i++) { const n=i===2?left:Math.min(left,Math.round(rejected*weights[i]*(0.7+rand(e.id,slot,'d',i)*0.6))); if (n>0) { out[own[i]]=(out[own[i]]||0)+n; left-=n; } }
  return out;
}
function simulatedSafety(e,plant,t,until,state) {
  const r=rand(e.id,String(t),'stype'), eventType=state==='setup'?(r<0.5?'ppe_missing':'guard_bypassed'):(r<0.6?'ppe_missing':r<0.9?'zone_intrusion':'unsafe_act');
  const text={ppe_missing:'Person without safety glasses or gloves at the machine',guard_bypassed:'Safety gate open while the machine was cycling during setup',zone_intrusion:'Person entered the robot or take-off area while the machine was in automatic',unsafe_act:'Reaching into the mould area without lock-out'}[eventType];
  const occurredAt=new Date(t+Math.floor(rand(e.id,String(t),'smin')*SLOT_MIN)*60000).toISOString(), recent=t>=until-2*3600000;
  const key=recordSafety({companyId:e.company_id,plantId:plant.id,equipmentId:e.id,eventType,source:'camera',description:`${text} (${e.asset_tag||e.model})`,occurredAt},{alert:recent});
  // Older simulated events were already handled by the shift supervisor.
  if (!recent) run("UPDATE safety_events SET status='closed',root_cause=?,corrective_action=?,closed_by='u-system',closed_at=? WHERE id=?",'Behaviour: rule known but not followed under time pressure','Discussed at the shift huddle; reminder posted at the machine',new Date(t+8*3600000).toISOString(),key);
}

// Asset tags: every 30 minutes each gateway reports which tags it hears. Assets mostly stay in their home zone and
// move between the zones their kind uses; trolleys occasionally go outside, one gauge is "lost" (stops reporting).
const ASSET_SLOT=30*60000, ASSET_BACKFILL=2*86400000;
const ROUTES={mould:['tool_room','production','production','maintenance','storage'],tool:['tool_room','tool_room','production','maintenance'],gauge:['tool_room','production'],trolley:['production','storage','storage','dock','production','outside'],forklift:['storage','dock','production','outside'],fixture:['tool_room','production'],container:['storage','production','dock'],other:['production','storage']};
export function simulateAssets(until=Date.now()) {
  const cursor=one("SELECT value FROM settings WHERE key='sim_assets_until'"), end=Math.floor(until/ASSET_SLOT)*ASSET_SLOT;
  let t=cursor?Date.parse(JSON.parse(cursor.value)):Math.floor((until-ASSET_BACKFILL)/ASSET_SLOT)*ASSET_SLOT; if (t>=end) return 0;
  const assets=all('SELECT * FROM tracked_assets'), zones=all('SELECT * FROM zones'); let n=0;
  transaction(()=>{
    for (; t<end; t+=ASSET_SLOT) for (const a of assets) {
      // A gauge that someone took home: its tag stops reporting 30 hours ago, so it shows as missing.
      if (a.kind==='gauge'&&rand(a.id,'lost')<0.5&&t>until-30*3600000) continue;
      const own=zones.filter(z=>z.plant_id===a.plant_id); if (!own.length) continue;
      const home=own.find(z=>z.id===a.home_zone_id), slot=String(Math.floor(t/ASSET_SLOT/4)); // moves at most every 2 hours
      let kind=rand(a.id,slot,'stay')<0.6&&home?home.kind:ROUTES[a.kind][Math.floor(rand(a.id,slot,'zone')*ROUTES[a.kind].length)%ROUTES[a.kind].length];
      if (kind==='outside'&&rand(a.id,slot,'out')<0.7) kind='dock';
      const zone=(kind===home?.kind?home:null)||own.find(z=>z.kind===kind)||home||own[0];
      const battery=Math.max(3,Math.round(100-rand(a.id,'bat')*90));
      if (recordSighting({tagId:a.tag_id,readerId:zone.reader_id,at:new Date(t).toISOString(),rssi:-50-Math.round(rand(a.id,String(t),'rssi')*40),batteryPct:battery},{alerts:t>=until-2*3600000})==='accepted') n++;
    }
    run("INSERT INTO settings (key,value,updated_at) VALUES ('sim_assets_until',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",JSON.stringify(new Date(end).toISOString()),new Date().toISOString());
  });
  return n;
}
export function simulateAll(until=Date.now()) {
  const machines=all(`SELECT * FROM equipment WHERE status='in_service' AND machine_type IN (${PRODUCTION_MACHINES.map(()=>'?').join(',')})`,...PRODUCTION_MACHINES);
  const slots=machines.reduce((n,e)=>n+simulateMachine(e,until),0);
  simulateAssets(until);
  return slots;
}
