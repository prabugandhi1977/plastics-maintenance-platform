// Energy audit demo data (demo databases only, run from seed.js):
//   1. a clamp-on analyzer reporting every 100 ms on the Arburg (eq-a): 40 minutes of a fixed-pump hydraulic machine with an
//      HMI-style cycle template, one skipped cycle and one pause, and a finished audit with SEC, cycle map and upgrade case;
//   2. a LoRaWAN current clamp (10-minute uplinks, current only) on the Engel (eq-a2) with a finished audit that shows the
//      interval path: SEC yes (estimated), cycle map no, and "no upgrade case" for an all-electric machine.
// The traces are generated, not measured. They sit 8–9 days back, before the factory simulator's week of history.
import { id, now, one, run, rawQuery } from '../common/db.js';
import { genTrace, templateOf, FIXED_PUMP_PHASES } from '../services/energy-audit/synthetic.js';
import { finalize } from '../services/energy-audit/audits.js';
import { RAW_KEEP_DAYS } from '../services/energy-audit/ingest.js';

const HOUR=3600000, DAY=24*HOUR;
async function insertSamples(meterId,rows,rx) {
  for (let i=0;i<rows.length;i+=5000) {
    const c=rows.slice(i,i+5000), col=k=>c.map(r=>r[k]??null);
    await rawQuery(`INSERT INTO energy_samples (meter_id,ts,rx,kw,kva,kvar,pf,volts,amps,thd,kwh_total,cyc) SELECT $1,* FROM unnest($2::bigint[],$3::bigint[],$4::float8[],$5::float8[],$6::float8[],$7::float8[],$8::float8[],$9::float8[],$10::float8[],$11::float8[],$12::bigint[]) ON CONFLICT DO NOTHING`,
      [meterId,c.map(r=>r.ts),c.map(()=>rx),col('kw'),col('kva'),col('kvar'),col('pf'),col('volts'),col('amps'),col('thd'),col('kwh_total'),col('cyc')]);
  }
}
const stamp=()=>now();

export async function seedEnergyAudit() {
  if (await one('SELECT 1 FROM energy_audits LIMIT 1')||!await one("SELECT 1 FROM equipment WHERE id='eq-a'")||!await one("SELECT 1 FROM products WHERE id='pr-hsg'")||!await one("SELECT 1 FROM users WHERE id='u-acme'")) return false;
  const t0=Math.floor((Date.now()-8*DAY)/HOUR)*HOUR;
  // ---------- 1. Analyzer at 10 Hz on the hydraulic press ----------
  const m1=id();
  await run("INSERT INTO energy_meters (id,company_id,equipment_id,name,kind,transport,measures,nominal_interval_ms,voltage_basis,clock_mode,observed_interval_ms,clock_offset_ms,last_seen_at,last_sample_ts,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    m1,'c-acme','eq-a','Clamp-on analyzer (demo)','analyzer','http','power',100,'ll','device',100,180,stamp(),t0,'u-acme',stamp());
  const trace=genTrace({startMs:t0,cycles:66,plan:FIXED_PUMP_PHASES,warmupS:40,missing:[20],pauses:[{afterCycle:45,seconds:60}],seed:7,restS:2});
  await insertSamples(m1,trace,trace[trace.length-1].ts);
  const end1=trace[trace.length-1].ts+100;
  // Machine states over the window (the pause follows the 46th slot: 45 cycles run plus one skipped): set-up while warming up, idle for the skipped cycle and the pause, running otherwise.
  const cycleMs=(FIXED_PUMP_PHASES.reduce((n,p)=>n+p[1],0)+2)*1000;
  const pauseStart=t0+40000+46*cycleMs, segments=[]; let at=t0;
  for (const [a,b,state] of [[t0,t0+40000,'setup'],[t0+40000+20*cycleMs,t0+40000+21*cycleMs,'idle'],[pauseStart,pauseStart+60000,'idle']].sort((x,y)=>x[0]-y[0])) { if (a>at) segments.push([at,a,'running']); segments.push([a,b,state]); at=b; }
  if (end1>at) segments.push([at,end1,'running']);
  for (const [a,b,state] of segments) await run('INSERT INTO machine_states (id,company_id,equipment_id,state,reason_code,started_at,ended_at,source) VALUES (?,?,?,?,?,?,?,?)',id(),'c-acme','eq-a',state,state==='setup'?'start_up':state==='idle'?'waiting_material':null,new Date(a).toISOString(),new Date(b).toISOString(),'energy-audit-demo');
  const phases=templateOf(FIXED_PUMP_PHASES);
  await run('INSERT INTO energy_cycle_templates (id,company_id,product_id,name,phases,updated_by,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT (product_id) DO NOTHING',id(),'c-acme','pr-hsg','HMI cycle, housing mould',JSON.stringify(phases),'u-acme',stamp());
  const a1=id();
  await run(`INSERT INTO energy_audits (id,company_id,plant_id,equipment_id,product_id,meter_id,meter_note,title,material,status,period_start_ms,period_end_ms,mass_mode,manual_parts,nameplate,assumptions,notes,keep_raw_until_ms,created_by,created_at,updated_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,a1,'c-acme','plant-a','eq-a','pr-hsg',m1,'Clamp-on analyzer, 3 phases, 100 ms','Fixed-pump press: SEC test and upgrade case (demo)','PC/ABS','completed',t0,end1,'manual',120,
    JSON.stringify({motorKw:30,pumpType:'fixed',clampTonnes:200,screwDiameterMm:50,yearBuilt:2019}),JSON.stringify({annualHours:5500,retrofitCost:22000,target:'servo',fixedLoadKw:2,years:5}),
    'Demo audit with a generated trace. Good parts counted at the end of the run (rejects removed).',Date.now()+RAW_KEEP_DAYS*DAY,'u-acme',stamp(),stamp(),stamp());
  await run('UPDATE energy_audits SET analysis=? WHERE id=?',await finalize(await one('SELECT * FROM energy_audits WHERE id=?',a1)),a1);

  // ---------- 2. LoRaWAN current clamp on the electric press ----------
  const m2=id(), t1=Math.floor((Date.now()-9*DAY)/HOUR)*HOUR, up=[];
  await run("INSERT INTO energy_meters (id,company_id,equipment_id,name,kind,transport,device_id,measures,nominal_interval_ms,voltage_v,assumed_pf,voltage_basis,mapping,clock_mode,observed_interval_ms,last_seen_at,last_sample_ts,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    m2,'c-acme','eq-a2','LoRaWAN current clamp (demo)','lorawan_ct','lorawan','0004a30b00demo01','current',600000,400,0.8,'ll',JSON.stringify({amps:{path:'current_avg'}}),'device',600000,stamp(),t1+6*HOUR,'u-acme',stamp());
  for (let i=0;i<=36;i++) up.push({ts:t1+i*600000,amps:Math.round((15+3.5*Math.sin(i/5)+(i%7===0?-5:0))*10)/10});
  await insertSamples(m2,up.map(u=>({ts:u.ts,amps:u.amps})),t1+6*HOUR);
  for (let q=0;q<24;q++) { const s=new Date(t1+q*900000).toISOString(), total=Math.round(52+6*Math.sin(q/3)); await run('INSERT INTO production_counts (id,company_id,equipment_id,product_id,period_start,period_minutes,total_qty,scrap_qty,unit,ideal_rate_per_hour,source) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',id(),'c-acme','eq-a2','pr-hsg',s,15,total,total%9===0?1:0,'parts',225,'energy-audit-demo'); }
  const a2=id();
  await run(`INSERT INTO energy_audits (id,company_id,plant_id,equipment_id,product_id,meter_id,meter_note,title,material,status,period_start_ms,period_end_ms,mass_mode,nameplate,assumptions,notes,keep_raw_until_ms,created_by,created_at,updated_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,a2,'c-acme','plant-a','eq-a2','pr-hsg',m2,'LoRaWAN current clamp (current only, 10-minute uplinks)','Electric press: interval path (demo)','PC/ABS','completed',t1,t1+6*HOUR,'counts',
    JSON.stringify({motorKw:22,pumpType:'all_electric',clampTonnes:180,screwDiameterMm:40,yearBuilt:2022}),JSON.stringify({annualHours:6000,lineVoltage:400,assumedPf:0.8}),
    'Demo audit: current only, so power is estimated and there is no cycle map.',Date.now()+RAW_KEEP_DAYS*DAY,'u-acme',stamp(),stamp(),stamp());
  await run('UPDATE energy_audits SET analysis=? WHERE id=?',await finalize(await one('SELECT * FROM energy_audits WHERE id=?',a2)),a2);
  return true;
}
