// Time-of-day (ToD) tariffs and maximum demand, as on Indian industrial (HT) electricity bills. One tariff per plant:
//   - ToD slots: wall-clock bands in the plant's time zone (an end at or before the start crosses midnight), each
//     with its own rate per kWh. Together they cover the 24 hours exactly once.
//   - Maximum demand (MD): the highest average kVA over one demand interval (15 or 30 min, aligned to the clock),
//     summed over every metered machine of the plant. kVAh per reading comes from kva, else from kW and kvar,
//     else from kW ÷ pf; readings with none of these count at unity power factor.
//   - Billed demand = max(MD of the month, billing % × contract demand), charged per kVA per month.
//   - Power factor (PF) of the month = kWh ÷ kVAh. Each full 0.01 below the target adds the penalty % of the energy
//     charges; each full 0.01 above it takes off the incentive %.
// Without a tariff the plant keeps the company's flat price per kWh (energy.js).
import { one, all, run, now } from '../../common/db.js';
import { array, bad, choice, zonedToUtc } from '../../common/validate.js';
import { localDate } from './time.js';
import { raiseAlert, escalateAlert, resolveAlertKey } from './alerts.js';

export const BANDS=['peak','normal','off_peak'];
const DAY=86400000, TIME=/^([01]\d|2[0-3]):[0-5]\d$/;
const mins=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
const hhmm=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const addDays=(date,n)=>{ const d=new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); };

// Slots must cover 00:00–24:00 with no gap and no overlap; the first problem found is named.
export function checkSlots(slots) {
  if (!slots.length) bad('Add at least one time-of-day slot');
  if (slots.length>12) bad('At most 12 time-of-day slots');
  const pieces=slots.flatMap((s,i)=>{ const a=mins(s.start), b=mins(s.end); return b>a?[[a,b,i]]:[[a,1440,i],...(b>0?[[0,b,i]]:[])]; }).sort((x,y)=>x[0]-y[0]);
  let at=0;
  for (const [a,b,i] of pieces) {
    if (a<at) bad(`Slot ${i+1} (${slots[i].start}–${slots[i].end}) overlaps another slot at ${hhmm(a)}`);
    if (a>at) bad(`No slot covers ${hhmm(at)}–${hhmm(a)}. The slots must cover all 24 hours`);
    at=b;
  }
  if (at<1440) bad(`No slot covers ${hhmm(at)}–24:00. The slots must cover all 24 hours`);
  return slots;
}
const num=(v,name,min,max)=>{ const x=typeof v==='string'&&v.trim()!==''?Number(v):v; if (typeof x!=='number'||!Number.isFinite(x)||x<min||x>max) bad(`${name} must be a number from ${min} to ${max}`); return x; };
export function tariffBody(body) {
  const slots=checkSlots(array(body.slots,'slots').map((s,i)=>{
    const t=(v,n)=>{ if (typeof v!=='string'||!TIME.test(v)) bad(`Slot ${i+1}: ${n} must be a time like 06:00`); return v; };
    const start=t(s?.start,'start'), end=t(s?.end,'end'); if (start===end) bad(`Slot ${i+1} must not start and end at the same time`);
    return {band:choice(s.band,`Slot ${i+1} band`,BANDS),start,end,rate:num(s.rate,`Slot ${i+1} rate`,0,1000)};
  }));
  const interval=Number(body.demandIntervalMinutes??15); if (![15,30].includes(interval)) bad('demandIntervalMinutes must be 15 or 30');
  return {slots,contractDemandKva:num(body.contractDemandKva,'contractDemandKva',1,1000000),demandChargePerKva:num(body.demandChargePerKva,'demandChargePerKva',0,100000),
    billingDemandPct:num(body.billingDemandPct??75,'billingDemandPct',0,100),demandIntervalMinutes:interval,pfTarget:num(body.pfTarget??0.95,'pfTarget',0.5,1),
    pfPenaltyPct:num(body.pfPenaltyPct??1,'pfPenaltyPct',0,10),pfIncentivePct:num(body.pfIncentivePct??0,'pfIncentivePct',0,10)};
}
export async function saveTariff(plant,t,u) {
  await run(`INSERT INTO energy_tariffs (plant_id,company_id,slots,contract_demand_kva,demand_charge_per_kva,billing_demand_pct,demand_interval_minutes,pf_target,pf_penalty_pct,pf_incentive_pct,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (plant_id) DO UPDATE SET slots=EXCLUDED.slots,contract_demand_kva=EXCLUDED.contract_demand_kva,demand_charge_per_kva=EXCLUDED.demand_charge_per_kva,billing_demand_pct=EXCLUDED.billing_demand_pct,demand_interval_minutes=EXCLUDED.demand_interval_minutes,pf_target=EXCLUDED.pf_target,pf_penalty_pct=EXCLUDED.pf_penalty_pct,pf_incentive_pct=EXCLUDED.pf_incentive_pct,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,
    plant.id,plant.company_id,JSON.stringify(t.slots),t.contractDemandKva,t.demandChargePerKva,t.billingDemandPct,t.demandIntervalMinutes,t.pfTarget,t.pfPenaltyPct,t.pfIncentivePct,u.id,now());
  return await tariffOf(plant.id);
}
export async function tariffOf(plantId) {
  const r=await one('SELECT * FROM energy_tariffs WHERE plant_id=?',plantId); if (!r) return null;
  const c=await one('SELECT currency FROM companies WHERE id=?',r.company_id);
  return {plantId:r.plant_id,slots:JSON.parse(r.slots),contractDemandKva:r.contract_demand_kva,demandChargePerKva:r.demand_charge_per_kva,billingDemandPct:r.billing_demand_pct,demandIntervalMinutes:r.demand_interval_minutes,
    pfTarget:r.pf_target,pfPenaltyPct:r.pf_penalty_pct,pfIncentivePct:r.pf_incentive_pct,currency:c.currency,updatedAt:r.updated_at};
}

// Slot occurrences over [from,to) in epoch ms, sorted and back to back: [{slot,start,end}].
export function slotWindows(tariff,zone,from,to) {
  const out=[];
  for (let date=addDays(localDate(from,zone),-1), last=localDate(to,zone); date<=last; date=addDays(date,1))
    tariff.slots.forEach((s,slot)=>{ const start=Date.parse(zonedToUtc(`${date}T${s.start}`,zone)), end=Date.parse(zonedToUtc(`${s.end<=s.start?addDays(date,1):date}T${s.end}`,zone)); if (end>from&&start<to) out.push({slot,start,end}); });
  return out.sort((a,b)=>a.start-b.start);
}
// kWh of each reading split over the slots by time (a reading across a slot boundary is shared pro rata).
export function splitBySlot(tariff,zone,readings) {
  const kwh=tariff.slots.map(()=>0); if (!readings.length) return kwh;
  const span=readings.map(r=>[Date.parse(r.period_start),Date.parse(r.period_start)+r.period_minutes*60000]);
  const windows=slotWindows(tariff,zone,Math.min(...span.map(s=>s[0])),Math.max(...span.map(s=>s[1])));
  readings.forEach((r,i)=>{ const [s,e]=span[i]; for (const w of windows) { const o=Math.min(e,w.end)-Math.max(s,w.start); if (o>0) kwh[w.slot]+=r.kwh*o/(e-s); } });
  return kwh;
}
export const slotCost=(tariff,kwh)=>kwh.reduce((n,k,i)=>n+k*tariff.slots[i].rate,0);

// Apparent energy of a reading, and whether it came from measured kVA/kvar/PF (else unity PF is assumed).
export function kvahOf(r) {
  const h=r.period_minutes/60, v=r.kva!=null?r.kva*h:r.kvar!=null?Math.hypot(r.kwh,r.kvar*h):r.pf>0?r.kwh/r.pf:null;
  return v==null?{kvah:r.kwh,measured:false}:{kvah:Math.max(v,r.kwh),measured:true};
}
// Plant readings overlapping [from,to) (starting up to `lookback` earlier), every metered machine of the plant (auxiliaries included).
async function plantReadings(plantId,from,to,lookback=DAY) {
  return await all('SELECT r.* FROM energy_readings r JOIN equipment e ON e.id=r.equipment_id WHERE e.plant_id=? AND r.period_start>=? AND r.period_start<? ORDER BY r.period_start',plantId,new Date(from-lookback).toISOString(),new Date(to).toISOString());
}
// kVAh per demand interval (clock-aligned), each reading clipped to [from,to) and spread pro rata: Map start → {kvah,covered}.
// covered: the latest reading end in the interval, so a running interval can be projected.
export function demandIntervals(readings,intervalMinutes,from,to) {
  const len=intervalMinutes*60000, out=new Map();
  for (const r of readings) {
    const s0=Date.parse(r.period_start), e0=s0+r.period_minutes*60000, s=Math.max(s0,from), e=Math.min(e0,to); if (e<=s) continue;
    const {kvah}=kvahOf(r);
    for (let b=Math.floor(s/len)*len; b<e; b+=len) { const o=Math.min(e,b+len)-Math.max(s,b); if (o<=0) continue; const x=out.get(b)??{kvah:0,covered:b}; x.kvah+=kvah*o/(e0-s0); x.covered=Math.max(x.covered,Math.min(e,b+len)); out.set(b,x); }
  }
  return out;
}
// Highest average kVA over a whole interval in [from,to): {kva,at} (a running interval counts with what it has so far).
export function maxDemand(readings,intervalMinutes,from,to) {
  let best={kva:0,at:null};
  for (const [b,x] of demandIntervals(readings,intervalMinutes,from,to)) { const kva=x.kvah/(intervalMinutes/60); if (kva>best.kva) best={kva,at:new Date(b).toISOString()}; }
  return best;
}
export function monthPf(readings) {
  let kwh=0,kvah=0,n=0; for (const r of readings) { const k=kvahOf(r); if (!k.measured) continue; kwh+=r.kwh; kvah+=k.kvah; n++; }
  return {pf:kvah?kwh/kvah:null,coveragePct:readings.length?n/readings.length*100:null};
}
// Signed % of the energy charges: + penalty below target, − incentive above it, per full 0.01.
export function pfAdjustmentPct(tariff,pf) {
  if (pf==null) return 0;
  const steps=Math.floor(Math.abs(tariff.pfTarget-pf)*100+1e-9);
  return !steps?0:pf<tariff.pfTarget?steps*tariff.pfPenaltyPct:-steps*tariff.pfIncentivePct;
}
const monthBounds=(zone,at)=>{ const m=localDate(at,zone).slice(0,7), [y,mo]=m.split('-').map(Number), next=mo===12?`${y+1}-01`:`${y}-${String(mo+1).padStart(2,'0')}`;
  return {month:m,start:Date.parse(zonedToUtc(`${m}-01T00:00`,zone)),end:Date.parse(zonedToUtc(`${next}-01T00:00`,zone))}; };

// Today's and this month's figures and the month's projected bill. Energy is projected to the whole month at the rate
// since the month's first reading (a plant that starts metering mid-month is not under-projected); the demand charge
// uses the month's maximum demand so far (it can only rise).
export async function energyBill(plant,at=Date.now()) {
  const tariff=await tariffOf(plant.id); if (!tariff) return {plantId:plant.id,tariff:null};
  const zone=plant.timezone, mon=monthBounds(zone,at), dayStart=Date.parse(zonedToUtc(`${localDate(at,zone)}T00:00`,zone));
  const readings=(await plantReadings(plant.id,mon.start,at)).filter(r=>Date.parse(r.period_start)+r.period_minutes*60000>mon.start);
  const inMonth=readings.map(r=>{ const s=Date.parse(r.period_start), e=s+r.period_minutes*60000, part=(Math.min(e,at)-Math.max(s,mon.start))/(e-s); return part>=1?r:{...r,kwh:r.kwh*part,period_start:new Date(Math.max(s,mon.start)).toISOString(),period_minutes:(Math.min(e,at)-Math.max(s,mon.start))/60000}; });
  const kwh=splitBySlot(tariff,zone,inMonth), basis=inMonth.length?Date.parse(inMonth[0].period_start):mon.start, scale=(mon.end-mon.start)/Math.max(at-basis,60000), round=x=>Math.round(x*100)/100;
  const slots=tariff.slots.map((s,i)=>({...s,kwh:round(kwh[i]),cost:round(kwh[i]*s.rate),projectedKwh:round(kwh[i]*scale),projectedCost:round(kwh[i]*s.rate*scale)}));
  const iv=tariff.demandIntervalMinutes, today=maxDemand(readings,iv,dayStart,at), month=maxDemand(readings,iv,mon.start,at);
  const floorKva=tariff.billingDemandPct/100*tariff.contractDemandKva, billedKva=Math.max(month.kva,floorKva), pf=monthPf(inMonth);
  const energy=slotCost(tariff,kwh)*scale, demandCharge=billedKva*tariff.demandChargePerKva, adjPct=pfAdjustmentPct(tariff,pf.pf), pfAdjustment=energy*adjPct/100;
  const pct=x=>Math.round(x/tariff.contractDemandKva*1000)/10;
  return {plantId:plant.id,timezone:zone,month:mon.month,at:new Date(at).toISOString(),currency:tariff.currency,tariff,slots,
    demand:{intervalMinutes:iv,contractKva:tariff.contractDemandKva,todayKva:round(today.kva),todayAt:today.at,todayPct:pct(today.kva),monthKva:round(month.kva),monthAt:month.at,monthPct:pct(month.kva),floorKva:round(floorKva),billedKva:round(billedKva),billedOnFloor:month.kva<floorKva},
    pf:{month:pf.pf==null?null:Math.round(pf.pf*1000)/1000,target:tariff.pfTarget,coveragePct:pf.coveragePct==null?null:Math.round(pf.coveragePct),adjustmentPct:adjPct},
    toDate:{kwh:round(kwh.reduce((a,b)=>a+b,0)),energy:round(slotCost(tariff,kwh)),since:new Date(basis).toISOString()},
    bill:{energy:round(energy),demand:round(demandCharge),pfAdjustment:round(pfAdjustment),total:round(energy+demandCharge+pfAdjustment)}};
}

// Running demand: the latest interval with data in the last two intervals, projected from the average so far.
export async function runningDemand(plant,tariff,at=Date.now()) {
  const len=tariff.demandIntervalMinutes*60000, from=Math.floor(at/len)*len-len;
  const ivs=[...demandIntervals(await plantReadings(plant.id,from,at,2*3600000),tariff.demandIntervalMinutes,from,at)].sort((a,b)=>b[0]-a[0]);
  if (!ivs.length) return null;
  const [start,x]=ivs[0], covered=Math.max(x.covered-start,60000);
  return {intervalStart:new Date(start).toISOString(),kva:x.kvah/(covered/3600000),complete:x.covered>=start+len};
}
// Background check for every plant with a tariff: demand at 90 % (warning) and 100 % (critical) of contract demand,
// and the month's PF below target. Each alert resolves when its condition clears.
export async function checkEnergyAlerts(at=Date.now()) {
  for (const p of await all('SELECT p.* FROM plants p JOIN energy_tariffs t ON t.plant_id=p.id ORDER BY p.id')) {
    const tariff=await tariffOf(p.id), d=await runningDemand(p,tariff,at), share=d?d.kva/tariff.contractDemandKva:0, key=`energy-demand:${p.id}`;
    if (share>=0.9) {
      const severity=share>=1?'critical':'warning', title=`Demand ${share>=1?'over':'near'} contract at ${p.name}: ${Math.round(d.kva)} kVA (${Math.round(share*100)} % of ${tariff.contractDemandKva} kVA)`;
      const detail=`${d.complete?'Average':'Projected average'} demand for the ${tariff.demandIntervalMinutes}-minute interval from ${d.intervalStart}. Stagger start-ups or shed load to stay under contract demand.`;
      const open=await one("SELECT * FROM alerts WHERE dedupe_key=? AND status<>'resolved'",key);
      if (!open) await raiseAlert({companyId:p.company_id,plantId:p.id,module:'energy',severity,title,detail,dedupeKey:key,at:new Date(at).toISOString()});
      else if (severity==='critical'&&open.severity!=='critical') await escalateAlert(open.id,{severity,title,detail});
    } else await resolveAlertKey(key,new Date(at).toISOString());
    // The month's PF in SQL (same rule as kvahOf), so the minute-by-minute check does not load a month of readings.
    const mon=monthBounds(p.timezone,at), pfKey=`energy-pf:${p.id}`;
    const agg=await one(`SELECT sum(r.kwh) kwh, sum(CASE WHEN r.kva IS NOT NULL THEN GREATEST(r.kva*r.period_minutes/60.0,r.kwh) WHEN r.kvar IS NOT NULL THEN GREATEST(sqrt(r.kwh*r.kwh+power(r.kvar*r.period_minutes/60.0,2)),r.kwh) ELSE r.kwh/r.pf END) kvah
      FROM energy_readings r JOIN equipment e ON e.id=r.equipment_id WHERE e.plant_id=? AND r.period_start>=? AND r.period_start<? AND (r.kva IS NOT NULL OR r.kvar IS NOT NULL OR r.pf IS NOT NULL)`,p.id,new Date(mon.start).toISOString(),new Date(at).toISOString());
    const pf=agg?.kvah?agg.kwh/agg.kvah:null;
    if (pf!=null&&pf<tariff.pfTarget) await raiseAlert({companyId:p.company_id,plantId:p.id,module:'energy',severity:'warning',title:`Power factor below target at ${p.name}: ${pf.toFixed(3)} (target ${tariff.pfTarget})`,
      detail:`Power factor so far in ${mon.month}. Each 0.01 below target adds ${tariff.pfPenaltyPct} % of the energy charges. Check the capacitor bank or APFC panel.`,dedupeKey:pfKey,at:new Date(at).toISOString()});
    else await resolveAlertKey(pfKey,new Date(at).toISOString());
  }
}
