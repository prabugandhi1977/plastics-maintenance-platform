// Energy audits: gathering the data of one audit from the database, running the analysis (analysis.js) and presenting the
// result with benchmark, drive, upgrade proposal, confidence and the assumptions that go with them.
import { one, all, mapSeq, now } from '../../common/db.js';
import { co2Factor } from '../factory/energy.js';
import { tariffOf } from '../factory/tariff.js';
import * as A from './analysis.js';
import { sampleRows, aggRows } from './ingest.js';

const H=3600000;
export const json=(text,fallback)=>{ try { return JSON.parse(text); } catch { return fallback; } };
export const iso=ms=>ms==null?null:new Date(ms).toISOString();

// ---------- Company settings: materials, benchmark table, saving factors ----------
export async function settingsOf(companyId) {
  const s=await one('SELECT * FROM energy_audit_settings WHERE company_id=?',companyId);
  const materials=s?.materials?json(s.materials,null):null, benchmarks=s?.benchmarks?json(s.benchmarks,null):null, custom=s?.factors?json(s.factors,null):null;
  const factors={}; for (const key of Object.keys(A.DEFAULT_FACTORS)) factors[key]={...A.DEFAULT_FACTORS[key],...(custom?.[key]||{})};
  return {materials:materials||A.DEFAULT_MATERIALS,benchmarks:benchmarks||A.DEFAULT_BENCHMARKS,factors,defaults:{materials:!materials,benchmarks:!benchmarks,factors:!custom},updatedAt:s?.updated_at||null};
}

// ---------- Data of one audit ----------
export const productOf=async (a)=>a.product_id?await one('SELECT * FROM products WHERE id=? AND company_id=?',a.product_id,a.company_id):null;
export async function templateOf(a) {
  if (!a.product_id) return null; const t=await one('SELECT * FROM energy_cycle_templates WHERE product_id=? AND company_id=?',a.product_id,a.company_id);
  return t&&{id:t.id,name:t.name,phases:json(t.phases,[]),updatedAt:t.updated_at};
}
export const windowOf=(a,at=Date.now())=>a.period_start_ms==null?null:{from:a.period_start_ms,to:a.period_end_ms??at};

async function outputOf(a,eq,product,from,to) {
  if (a.mass_mode==='manual') {
    const w=product?.part_weight_g, cav=product?.cavities||1;
    const kg=a.manual_kg??(a.manual_parts!=null&&w?a.manual_parts*w/1000:null), parts=a.manual_parts??(a.manual_kg!=null&&w?a.manual_kg*1000/w:null);
    return kg>0?{goodKg:kg,goodParts:parts,shots:parts!=null?parts/cav:null,basis:'manual'}:null;
  }
  const rows=await all(`SELECT c.period_start,c.period_minutes,c.total_qty,c.scrap_qty,c.unit,c.product_id,p.part_weight_g,p.cavities FROM production_counts c LEFT JOIN products p ON p.id=c.product_id WHERE c.equipment_id=? AND c.period_start>=? AND c.period_start<? ORDER BY c.period_start`,eq.id,iso(from-86400000),iso(to));
  let kg=0, parts=0, shots=0, n=0;
  for (const c of rows) {
    const s=Date.parse(c.period_start), e=s+c.period_minutes*60000, o=Math.min(e,to)-Math.max(s,from); if (o<=0) continue;
    const frac=o/(e-s), good=Math.max(0,c.total_qty-c.scrap_qty)*frac, w=c.part_weight_g??product?.part_weight_g; n++;
    if (c.unit==='kg') kg+=good; else if (c.unit==='parts'&&w) { kg+=good*w/1000; parts+=good; shots+=good/(c.cavities||product?.cavities||1); }
  }
  return n&&kg>0?{goodKg:kg,goodParts:parts||null,shots:shots||null,basis:'counts'}:null;
}
async function statesOf(eq,from,to) {
  const rows=await all('SELECT state,started_at,ended_at FROM machine_states WHERE equipment_id=? AND started_at<? AND (ended_at IS NULL OR ended_at>?) ORDER BY started_at',eq.id,iso(to),iso(from));
  return rows.map(s=>({state:s.state,a:Date.parse(s.started_at),b:s.ended_at?Date.parse(s.ended_at):to}));
}
export async function meterOf(a) { return a.meter_id?await one('SELECT * FROM energy_meters WHERE id=? AND company_id=?',a.meter_id,a.company_id):null; }
const meterCfg=(m,as={})=>({voltage:as.lineVoltage??m?.voltage_v??null,assumedPf:as.assumedPf??m?.assumed_pf??0.8,voltageBasis:m?.voltage_basis||'ll'});

// Live analysis of the audit's window.
export async function analyse(a,at=Date.now()) {
  const w=windowOf(a,at); if (!w||w.to<=w.from) return null;
  const eq=await one('SELECT * FROM equipment WHERE id=?',a.equipment_id), product=await productOf(a), tmpl=await templateOf(a), meter=await meterOf(a), as=json(a.assumptions,{});
  const input={fromMs:w.from,toMs:w.to,states:await statesOf(eq,w.from,w.to),output:await outputOf(a,eq,product,w.from,w.to),idealS:product?.ideal_cycle_s??null,phases:tmpl?.phases||null,assumptions:as,demandIntervalMin:15};
  if (meter) {
    const pad=Math.max(10000,3*meter.nominal_interval_ms);
    let rows=await sampleRows(meter.id,w.from-pad,w.to+pad), source='samples';
    if (!rows.length) { rows=await aggRows(meter.id,w.from,w.to); source='aggregates'; }
    input.series=A.resolveSeries(rows,meterCfg(meter,as)); input.source=source;
  } else {
    input.readings=await all('SELECT period_start,period_minutes,kwh,peak_kw,kva,pf FROM energy_readings WHERE equipment_id=? AND period_start>=? AND period_start<? ORDER BY period_start',eq.id,iso(w.from-86400000),iso(w.to));
  }
  const res=A.analyseWindow(input); res.meter=meter?{id:meter.id,measures:meter.measures}:null; res.computedAt=iso(at);
  return res;
}
export async function finalize(a,at=Date.now()) {
  const res=await analyse(a,at); return res&&JSON.stringify(res);
}

// ---------- Price, CO2 ----------
export async function priceOf(eq,company,at=Date.now()) {
  const co2=co2Factor(company), tariff=await tariffOf(eq.plant_id);
  if (tariff) {
    // The machine's own mix over the last 30 days when it has readings, else the 24-hour average of the slot rates.
    const rows=await all('SELECT period_start,period_minutes,kwh FROM energy_readings WHERE equipment_id=? AND period_start>=? AND period_start<?',eq.id,iso(at-30*86400000),iso(at));
    const plant=await one('SELECT timezone FROM plants WHERE id=?',eq.plant_id);
    if (rows.length>20) { const { splitBySlot, slotCost }=await import('../factory/tariff.js'); const k=splitBySlot(tariff,plant.timezone,rows), tot=k.reduce((n,x)=>n+x,0); if (tot>0) return {rate:slotCost(tariff,k)/tot,source:'tod_machine',co2,currency:company.currency}; }
    const mins=s=>Number(s.slice(0,2))*60+Number(s.slice(3)); let sum=0;
    for (const s of tariff.slots) { const len=(mins(s.end)-mins(s.start)+1440)%1440||1440; sum+=s.rate*len/1440; }
    return {rate:sum,source:'tod_average',co2,currency:company.currency};
  }
  return {rate:company.energy_price_per_kwh,source:company.energy_price_per_kwh!=null?'flat':null,co2,currency:company.currency};
}

// ---------- Presentation ----------
export async function present(a,{at=Date.now(),full=true}={}) {
  const eq=await one('SELECT * FROM equipment WHERE id=?',a.equipment_id), plant=await one('SELECT id,name,timezone FROM plants WHERE id=?',a.plant_id), company=await one('SELECT * FROM companies WHERE id=?',a.company_id);
  const product=await productOf(a), meter=await meterOf(a), set=await settingsOf(a.company_id), tmpl=await templateOf(a);
  const as=json(a.assumptions,{}), np=json(a.nameplate,{});
  const live=a.status==='running'||!a.analysis;
  const analysis=live?await analyse(a,at):json(a.analysis,null);
  const out={id:a.id,status:a.status,title:a.title,companyId:a.company_id,currency:company.currency,plant,machine:{id:eq.id,assetTag:eq.asset_tag,make:eq.make,model:eq.model,machineType:eq.machine_type,specs:json(eq.specs,{})},
    product:product&&{id:product.id,partNumber:product.part_number,name:product.name,material:product.material,partWeightG:product.part_weight_g,idealCycleS:product.ideal_cycle_s,cavities:product.cavities},
    material:a.material,meterNote:a.meter_note,meter:meter&&meterOut(meter),nameplate:np,assumptions:as,notes:a.notes,massMode:a.mass_mode,manualKg:a.manual_kg,manualParts:a.manual_parts,
    periodStart:iso(a.period_start_ms),periodEnd:iso(a.period_end_ms),createdAt:a.created_at,updatedAt:a.updated_at,completedAt:a.completed_at,keepRawUntil:iso(a.keep_raw_until_ms),frozen:!live,
    template:tmpl,settings:full?{benchmarks:set.benchmarks,defaults:set.defaults}:undefined};
  const readingMs=meter?null:((await one('SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY period_minutes) m FROM energy_readings WHERE equipment_id=?',eq.id))?.m||15)*60000;
  out.advice=A.pathAdvice(meter?{measures:meter.measures,intervalMs:meter.nominal_interval_ms,observedMs:meter.observed_interval_ms,transport:meter.transport}:{measures:'energy',intervalMs:readingMs,transport:'readings'});
  out.photos=await all("SELECT id,filename,mime,size_bytes,created_at FROM attachments WHERE entity_type='energy_audit' AND entity_id=? ORDER BY created_at",a.id);
  if (!analysis) { out.analysis=null; return out; }
  // Drive in effect: override, nameplate or inferred.
  const inferred=analysis.drive||null, start=A.startingDrive({override:as.driveOverride,nameplatePump:np.pumpType,inferred});
  let mismatch=null; if (inferred&&inferred.class!=='unknown'&&inferred.level==='high'&&start.source!=='inferred'&&start.class!==inferred.class) mismatch=inferred.class;
  const phaseRows=analysis.phases?A.markWaste(analysis.phases.rows,start.class):null;
  const sec=analysis.sec?.kwhPerKg??null, cyc=analysis.cycle;
  const kgPerCycle=product?.part_weight_g&&product?.cavities?product.part_weight_g*product.cavities/1000:(analysis.output?.goodKg&&analysis.output?.shots?analysis.output.goodKg/analysis.output.shots:null);
  const price=await priceOf(eq,company,at);
  const prop=A.proposal({drive:start,phases:phaseRows,cycleKwh:cyc?.cycleKwh,cycleTimeS:cyc?.cycleTimeS,kgPerCycle,sec,wholeKwhPerHour:analysis.energy?.avgKw,assumptions:as,factors:set.factors,price,inefficiencyPct:analysis.inefficiency?.scorePct});
  if (prop.status==='efficient') prop.remaining=A.remainingOpportunities({phases:phaseRows,idle:analysis.idle,pf:analysis.energy?.pf,cycleTimeS:cyc?.cycleTimeS,idealS:product?.ideal_cycle_s,standbyKw:analysis.energy?.standbyKw});
  const powerBasis=analysis.data?.power, hours=analysis.window?.hours;
  const conf=A.confidence({cycle:cyc,power:powerBasis,coveragePct:analysis.data?.coveragePct,hours,templateOk:!!phaseRows,mode:prop.options?.[0]?.mode,drive:start});
  out.analysis={...analysis,phases:analysis.phases&&{...analysis.phases,rows:phaseRows}};
  out.drive={inferred,effective:start,mismatch};
  out.benchmark=A.benchmarkPosition(sec,start.class==='unknown'?(inferred?.class!=='unknown'?inferred?.class:'unknown'):start.class,a.material,set.benchmarks);
  out.proposal=prop; out.confidence=conf; out.price=price;
  out.co2Factor=price.co2;
  return out;
}
export const meterOut=m=>({id:m.id,companyId:m.company_id,equipmentId:m.equipment_id,name:m.name,kind:m.kind,transport:m.transport,deviceId:m.device_id,measures:m.measures,nominalIntervalMs:m.nominal_interval_ms,voltageV:m.voltage_v,assumedPf:m.assumed_pf,voltageBasis:m.voltage_basis,
  mapping:json(m.mapping,{}),bleConfig:json(m.ble_config,{}),clockMode:m.clock_mode,active:!!m.active,lastSeenAt:m.last_seen_at,lastSampleAt:iso(m.last_sample_ts),clockOffsetMs:m.clock_offset_ms,observedIntervalMs:m.observed_interval_ms,createdAt:m.created_at,
  advice:A.pathAdvice({measures:m.measures,intervalMs:m.nominal_interval_ms,observedMs:m.observed_interval_ms,transport:m.transport}),
  ingest:{samples:'/api/integrations/energy-samples',payload:`/api/integrations/energy-payload/${m.id}`,lorawan:`/api/integrations/lorawan/${m.id}`,relay:`/api/energy-audit/meters/${m.id}/relay`}});

// One-line summary for the list: SEC, typical annual saving.
export async function summary(a) {
  const p=await present(a,{full:false}), opt=p.proposal?.options?.find(o=>o.target===(p.assumptions.target||'servo'))||p.proposal?.options?.[0], typ=opt?.scenarios?.[1];
  return {id:a.id,title:a.title,status:a.status,companyId:a.company_id,plantName:p.plant.name,machine:`${p.machine.assetTag||''} ${p.machine.make} ${p.machine.model}`.trim(),equipmentId:a.equipment_id,material:a.material,
    periodStart:p.periodStart,periodEnd:p.periodEnd,secKwhPerKg:p.analysis?.sec?.kwhPerKg??null,secEstimated:p.analysis?.data?.power&&p.analysis.data.power!=='measured',benchmarkPosition:p.benchmark?.position||null,
    drive:p.drive?.effective?.class||null,proposalStatus:p.proposal?.status||null,annualKwhTypical:typ?.annualKwh??null,annualMoneyTypical:typ?.annualMoney??null,paybackYears:typ?.paybackYears??null,currency:p.currency,confidence:p.confidence?.level||null,createdAt:a.created_at};
}
