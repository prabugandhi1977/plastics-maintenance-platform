// Mould process fingerprint: what a good run looks like for one mould on one machine making one product, and how far the
// recent run has moved away from it.
//
// What counts as "good" (the label), in order of evidence:
//   - batch level: the batch is finished (completed or released); its scrap share (scrap / (good + scrap), from the
//     counts entered at completion) is within the limit; no quality gate's latest result is a fail; no process deviation
//     on it was rejected. Batches without counts are used if nothing speaks against them and are reported as such.
//   - reading level: readings taken during a process deviation, or in a 15-minute slot where the machine's production
//     count or the camera station shows a reject share above the slot limit, are left out.
// Not used as labels: field returns (they arrive late and are often not a process matter) and running batches.
// Shots are not stored individually; the unit of data is the process reading (all settings at one moment of a batch).
import { id, now as nowIso, one, all, run } from '../../common/db.js';
import { bad } from '../../common/validate.js';
import { audit } from '../../common/access.js';
import { PROCESS_PARAMS } from '../../common/catalog.js';
import { raiseAlert, resolveAlertKey, escalateAlert } from '../factory/alerts.js';
import { plantOf } from '../factory/production.js';
import { shiftWindows, localDate } from '../factory/time.js';
import { median } from '../ml/stats.js';
import { summarise, pearson, driftOf, levelOf, round } from '../ml/fingerprint-stats.js';

const HOUR=3600000, DAY=24*HOUR, iso=ms=>new Date(ms).toISOString();
const J=(s,d)=>{ try { return JSON.parse(s||''); } catch { return d; } };
const envNum=(k,d)=>{ const v=Number(process.env[k]); return Number.isFinite(v)&&v>0?v:d; };
// Thresholds, all overridable by environment variables (read on every call so tests and operators can change them).
export const config=()=>({
  lookbackDays:envNum('MOULDCARE_FP_LOOKBACK_DAYS',90),   // how far back a fingerprint learns
  minBatches:envNum('MOULDCARE_FP_MIN_BATCHES',2),         // good batches needed
  minReadings:envNum('MOULDCARE_FP_MIN_READINGS',60),      // good readings needed per setting
  minParams:envNum('MOULDCARE_FP_MIN_PARAMS',2),           // settings that reach minReadings
  maxScrapPct:envNum('MOULDCARE_FP_MAX_SCRAP_PCT',3),      // batch scrap share above which a batch is not "good"
  slotRejectPct:envNum('MOULDCARE_FP_SLOT_REJECT_PCT',6),  // 15-minute slot reject share above which readings are left out
  recentHours:envNum('MOULDCARE_FP_RECENT_HOURS',12),      // width of the "recent run" window
  minRecent:envNum('MOULDCARE_FP_MIN_RECENT',8),           // recent readings needed per setting
  staleHours:envNum('MOULDCARE_FP_STALE_HOURS',12),        // newest reading older than this: the run is not current
  warning:envNum('MOULDCARE_FP_WARN_SCORE',2),
  critical:envNum('MOULDCARE_FP_CRIT_SCORE',4),
  resolveBelow:envNum('MOULDCARE_FP_RESOLVE_SCORE',1.5),
});
const thresholds=c=>({warning:c.warning,critical:c.critical,resolveBelow:c.resolveBelow});

const EXTRA_PARAMS=[['cushionMm','Cushion','mm'],['dosingTimeS','Dosing time','s'],['holdTimeS','Hold time','s'],['coolingTimeS','Cooling time','s'],['backPressureBar','Back pressure','bar'],['injectionSpeedMmS','Injection speed','mm/s']];
const KNOWN=Object.fromEntries([...Object.values(PROCESS_PARAMS).flat(),...EXTRA_PARAMS].map(([k,label,unit])=>[k,{label,unit}]));
export const paramInfo=k=>KNOWN[k]||{label:k,unit:''};
const clean=(s,n=200)=>String(s??'').replace(/[<>]/g,'‹').replace(/\s+/g,' ').trim().slice(0,n);

// ---------- Scopes ----------
export const scopeKey=s=>`${s.mouldId}|${s.equipmentId}|${s.productId}`;
export async function mouldOf(companyId,mouldId) { const m=await one("SELECT * FROM equipment WHERE id=? AND machine_type='mould'",mouldId); return m&&(!companyId||m.company_id===companyId)?m:null; }
// Machine + product combinations a mould has run in the look-back period, plus any that already have a fingerprint.
export async function scopesOf(mould,now=Date.now()) {
  const from=iso(now-config().lookbackDays*DAY);
  const rows=await all(`SELECT equipment_id,product_id,max(started_at) latest FROM (
      SELECT equipment_id,product_id,started_at FROM batches WHERE mould_id=? AND COALESCE(ended_at,'9999')>=?
      UNION ALL SELECT equipment_id,product_id,created_at FROM mould_fingerprints WHERE mould_id=?) x GROUP BY equipment_id,product_id ORDER BY max(started_at) DESC`,mould.id,from,mould.id);
  return rows.map(r=>({companyId:mould.company_id,mouldId:mould.id,equipmentId:r.equipment_id,productId:r.product_id}));
}
export const activeFingerprint=async s=>await one("SELECT * FROM mould_fingerprints WHERE mould_id=? AND equipment_id=? AND product_id=? AND status='active'",s.mouldId,s.equipmentId,s.productId);
const latestFingerprint=async s=>await one('SELECT * FROM mould_fingerprints WHERE mould_id=? AND equipment_id=? AND product_id=? ORDER BY version DESC LIMIT 1',s.mouldId,s.equipmentId,s.productId);
export const parsed=row=>({...J(row.fingerprint,{params:{},correlations:[]})});

// ---------- Which batches and readings are good ----------
async function classifyBatch(b,cfg) {
  if (b.status==='running') return {good:false,code:'running'};
  if (b.status==='on_hold') return {good:false,code:'on_hold'};
  if (b.status==='scrapped') return {good:false,code:'scrapped'};
  const total=(b.good_qty??0)+(b.scrap_qty??0), scrapPct=b.good_qty!=null&&b.scrap_qty!=null&&total>0?b.scrap_qty/total*100:null;
  if (scrapPct!=null&&scrapPct>cfg.maxScrapPct) return {good:false,code:'scrap_rate',scrapPct:round(scrapPct,1)};
  const latest={}; for (const c of await all('SELECT gate,result FROM batch_checks WHERE batch_id=? ORDER BY checked_at',b.id)) latest[c.gate]=c.result;
  if (Object.values(latest).includes('fail')) return {good:false,code:'gate_failed'};
  if (await one("SELECT 1 FROM process_deviations WHERE batch_id=? AND status='rejected'",b.id)) return {good:false,code:'deviation_rejected'};
  return {good:true,scrapPct:scrapPct==null?null:round(scrapPct,1)};
}
// Sorted, merged [start,end) intervals and a membership test.
function intervalSet(list) {
  const s=list.filter(x=>x[1]>x[0]).sort((a,b)=>a[0]-b[0]), m=[];
  for (const x of s) { const last=m.at(-1); if (last&&x[0]<=last[1]) last[1]=Math.max(last[1],x[1]); else m.push([...x]); }
  return t=>{ let lo=0,hi=m.length-1; while (lo<=hi) { const mid=(lo+hi)>>1; if (t<m[mid][0]) hi=mid-1; else if (t>=m[mid][1]) lo=mid+1; else return true; } return false; };
}
async function highRejectSlots(equipmentId,fromIso,toIso,cfg) {
  const out=[], limit=cfg.slotRejectPct/100;
  for (const c of await all('SELECT period_start,period_minutes,total_qty,scrap_qty FROM production_counts WHERE equipment_id=? AND period_start>=? AND period_start<?',equipmentId,fromIso,toIso))
    if (c.total_qty>=20&&c.scrap_qty/c.total_qty>limit) out.push([Date.parse(c.period_start),Date.parse(c.period_start)+c.period_minutes*60000]);
  for (const v of await all('SELECT period_start,period_minutes,inspected,rejected FROM vision_results WHERE equipment_id=? AND period_start>=? AND period_start<?',equipmentId,fromIso,toIso))
    if (v.inspected>=20&&v.rejected/v.inspected>limit) out.push([Date.parse(v.period_start),Date.parse(v.period_start)+v.period_minutes*60000]);
  return intervalSet(out);
}
const idList=ids=>ids.map(()=>'?').join(',');
// Readings as snapshots: all settings of one batch at one minute.
function snapshots(rows) {
  const map=new Map();
  for (const r of rows) { const k=`${r.batch_id}|${r.observed_at.slice(0,16)}`; let s=map.get(k); if (!s) map.set(k,s={batchId:r.batch_id,t:Date.parse(r.observed_at),vals:{}}); s.vals[r.parameter]=r.value; }
  return [...map.values()].sort((a,b)=>a.t-b.t);
}

// ---------- Building ----------
const REASON_TEXT={
  no_batches:v=>`No finished batch of this product on this mould and machine in the last ${v.days} days.`,
  too_few_batches:v=>`Only ${v.good} batch${v.good===1?'':'es'} passed the quality checks (${v.excluded} excluded${v.excludedWhy?`: ${v.excludedWhy}`:''}); at least ${v.min} are needed.`,
  too_few_readings:v=>`Only ${v.have} good process readings; at least ${v.min} per setting are needed.`,
  too_few_params:v=>`Only ${v.have} setting${v.have===1?'':'s'} ha${v.have===1?'s':'ve'} at least ${v.min} good readings; at least ${v.need} settings are needed.`,
};
const reason=(code,vars={})=>({code,vars,message:REASON_TEXT[code](vars)});
const CODE_TEXT={running:'still running',on_hold:'on hold',scrapped:'scrapped',scrap_rate:'scrap above the limit',gate_failed:'failed a quality gate',deviation_rejected:'rejected process deviation'};

// Builds a fingerprint from good production in [from,to]. Returns {ok:false,reasons} when the data is too thin.
export async function buildFingerprint(scope,{from,to=Date.now()}={}) {
  const cfg=config(), fromMs=from??to-cfg.lookbackDays*DAY, fromIso=iso(fromMs), toIso=iso(to);
  const batches=await all("SELECT * FROM batches WHERE company_id=? AND mould_id=? AND equipment_id=? AND product_id=? AND started_at<? AND COALESCE(ended_at,'9999')>=? ORDER BY started_at",scope.companyId,scope.mouldId,scope.equipmentId,scope.productId,toIso,fromIso);
  if (!batches.length) return {ok:false,reasons:[reason('no_batches',{days:Math.round((to-fromMs)/DAY)})]};
  const used=[], excluded=[], tally={};
  for (const b of batches) { const c=await classifyBatch(b,cfg); if (c.good) used.push({b,scrapPct:c.scrapPct}); else { excluded.push({id:b.id,batchNumber:b.batch_number,code:c.code,scrapPct:c.scrapPct??null}); tally[c.code]=(tally[c.code]||0)+1; } }
  if (used.length<cfg.minBatches) return {ok:false,reasons:[reason('too_few_batches',{good:used.length,excluded:excluded.length,min:cfg.minBatches,excludedWhy:Object.entries(tally).map(([k,n])=>`${n} ${CODE_TEXT[k]}`).join(', ')})],excluded};
  const ids=used.map(x=>x.b.id);
  const devs=await all(`SELECT batch_id,started_at,ended_at FROM process_deviations WHERE batch_id IN (${idList(ids)})`,...ids);
  const inDeviation=intervalSet(devs.map(d=>[Date.parse(d.started_at),d.ended_at?Date.parse(d.ended_at):Infinity]));
  const badSlot=await highRejectSlots(scope.equipmentId,fromIso,toIso,cfg);
  const rows=await all(`SELECT batch_id,observed_at,parameter,value FROM process_readings WHERE batch_id IN (${idList(ids)}) AND observed_at>=? AND observed_at<? ORDER BY observed_at`,...ids,fromIso,toIso);
  const kept=[], dropped={deviation:0,highRejectSlot:0};
  for (const r of rows) { const t=Date.parse(r.observed_at); if (inDeviation(t)) dropped.deviation++; else if (badSlot(t)) dropped.highRejectSlot++; else kept.push(r); }
  const byParam={}; for (const r of kept) (byParam[r.parameter]??=[]).push(r.value);
  const enough=Object.entries(byParam).filter(([,v])=>v.length>=cfg.minReadings).sort((a,b)=>b[1].length-a[1].length).slice(0,12);
  const maxN=Math.max(0,...Object.values(byParam).map(v=>v.length));
  if (maxN<cfg.minReadings) return {ok:false,reasons:[reason('too_few_readings',{have:maxN,min:cfg.minReadings})],excluded};
  if (enough.length<cfg.minParams) return {ok:false,reasons:[reason('too_few_params',{have:enough.length,min:cfg.minReadings,need:cfg.minParams})],excluded};
  const product=await one('SELECT process_window FROM products WHERE id=?',scope.productId), win=J(product?.process_window,{});
  const params={}; for (const [k,vals] of enough) { const s=summarise(vals), w=win[k]; params[k]={...paramInfo(k),n:s.n,mean:round(s.mean,4),sd:round(s.sd,4),median:round(s.median,4),p05:round(s.p05,4),p95:round(s.p95,4),min:round(s.min,4),max:round(s.max,4),window:w?{min:w.min??null,max:w.max??null}:null}; }
  const keys=Object.keys(params), snaps=snapshots(kept.filter(r=>params[r.parameter]));
  const correlations=[]; for (let i=0;i<keys.length;i++) for (let j=i+1;j<keys.length;j++) { const xs=[],ys=[]; for (const s of snaps) if (s.vals[keys[i]]!=null&&s.vals[keys[j]]!=null) { xs.push(s.vals[keys[i]]); ys.push(s.vals[keys[j]]); } const r=pearson(xs,ys); if (r!=null) correlations.push({a:keys[i],b:keys[j],r:round(r,3),n:xs.length}); }
  const fp={schema:1,params,correlations,shifts:[],days:[]};
  // Variation between shifts and days inside the good data: does the fingerprint hold the same on every shift?
  const machine=await one('SELECT * FROM equipment WHERE id=?',scope.equipmentId), plant=machine?await plantOf(machine):null;
  if (plant) {
    const windows=await shiftWindows(plant,snaps[0].t,snaps.at(-1).t+1), byShift=new Map(), byDay=new Map();
    for (const s of snaps) { const w=windows.find(x=>s.t>=x.start&&s.t<x.end); if (w) (byShift.get(w.name)||byShift.set(w.name,[]).get(w.name)).push(s); const d=localDate(s.t,plant.timezone); (byDay.get(d)||byDay.set(d,[]).get(d)).push(s); }
    const sd=k=>Math.max(params[k].sd,0.005*Math.abs(params[k].mean),1e-6);
    for (const [name,list] of byShift) { if (list.length<10) continue; const offsets={}; for (const k of keys) { const v=list.map(s=>s.vals[k]).filter(x=>x!=null); if (v.length>=5) offsets[k]=round((v.reduce((a,b)=>a+b,0)/v.length-params[k].mean)/sd(k),2); } fp.shifts.push({name,n:list.length,offsets}); }
    for (const [date,list] of [...byDay].sort()) { if (list.length<6) continue; const med={}; for (const k of keys) { const v=list.map(s=>s.vals[k]).filter(x=>x!=null); if (v.length>=4) med[k]=median(v); } const d=driftOf(fp,med); if (d) fp.days.push({date,n:list.length,score:d.score}); }
    fp.days=fp.days.slice(-60);
  }
  const counted=used.filter(x=>x.scrapPct!=null).length;
  fp.labels={criteria:{maxScrapPct:cfg.maxScrapPct,slotRejectPct:cfg.slotRejectPct,minBatches:cfg.minBatches,minReadings:cfg.minReadings},
    batches:used.slice(-50).map(x=>({id:x.b.id,batchNumber:x.b.batch_number,scrapPct:x.scrapPct})),excluded:excluded.slice(-50),
    evidence:{batchesWithCounts:counted,batchesWithoutCounts:used.length-counted},readingsLeftOut:dropped};
  return {ok:true,fingerprint:fp,sampleSize:snaps.length,batches:used.length,periodFrom:snaps[0]?new Date(snaps[0].t).toISOString():fromIso,periodTo:new Date(snaps.at(-1).t).toISOString(),excluded};
}

// Stores a built fingerprint as the new active version of its scope; the previous version is closed.
async function saveVersion(scope,built,{origin,userId=null,reason:why=''}) {
  const prev=await latestFingerprint(scope), at=nowIso();
  if (prev?.status==='active') await run("UPDATE mould_fingerprints SET status='superseded',closed_by=?,closed_at=? WHERE id=?",userId,at,prev.id);
  const key=id(), version=(prev?.version||0)+1;
  await run('INSERT INTO mould_fingerprints (id,company_id,mould_id,equipment_id,product_id,version,status,origin,fingerprint,sample_size,batches,period_from,period_to,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    key,scope.companyId,scope.mouldId,scope.equipmentId,scope.productId,version,'active',origin,JSON.stringify(built.fingerprint),built.sampleSize,built.batches,built.periodFrom,built.periodTo,clean(why,500),userId,at);
  return {id:key,version,previousVersion:prev?.version??null};
}
export async function buildAndSave(u,scope,{days,origin='manual',reason:why=''}={}) {
  if (await activeFingerprint(scope)) bad('This mould already has an active fingerprint. Use "accept the new normal" to learn a new one, or reset it first.');
  const now=Date.now(), built=await buildFingerprint(scope,{from:days?now-days*DAY:undefined,to:now});
  if (!built.ok) return {built:false,reasons:built.reasons};
  const v=await saveVersion(scope,built,{origin,userId:u?.id??null,reason:why});
  if (u) await audit(u,'fingerprint.build','equipment',scope.mouldId,scope.companyId,{equipmentId:scope.equipmentId,productId:scope.productId,version:v.version,sampleSize:built.sampleSize,batches:built.batches});
  return {built:true,version:v.version,id:v.id,sampleSize:built.sampleSize,batches:built.batches};
}
// "Accept the new normal": learn a new version from the last `days` days of good production. Refused when that is too thin.
export async function rebaseline(u,scope,{days=7,reason:why}) {
  const prev=await activeFingerprint(scope); if (!prev) bad('There is no active fingerprint to replace. Build one first.');
  const now=Date.now(), built=await buildFingerprint(scope,{from:now-days*DAY,to:now});
  if (!built.ok) return {rebaselined:false,reasons:built.reasons};
  const v=await saveVersion(scope,built,{origin:'rebaseline',userId:u.id,reason:why});
  await audit(u,'fingerprint.rebaseline','equipment',scope.mouldId,scope.companyId,{equipmentId:scope.equipmentId,productId:scope.productId,version:v.version,previousVersion:v.previousVersion,days,reason:clean(why,500),sampleSize:built.sampleSize});
  await checkMould(await one('SELECT * FROM equipment WHERE id=?',scope.mouldId),Date.now());
  return {rebaselined:true,version:v.version,previousVersion:v.previousVersion,sampleSize:built.sampleSize,batches:built.batches};
}
// Reset: the active version is closed and nothing replaces it, so no drift is judged until a fingerprint is built again.
export async function resetFingerprint(u,scope,{reason:why}) {
  const prev=await activeFingerprint(scope); if (!prev) bad('There is no active fingerprint to reset.');
  await run("UPDATE mould_fingerprints SET status='reset',closed_by=?,closed_at=?,reason=? WHERE id=?",u.id,nowIso(),clean(why,500),prev.id);
  await audit(u,'fingerprint.reset','equipment',scope.mouldId,scope.companyId,{equipmentId:scope.equipmentId,productId:scope.productId,version:prev.version,reason:clean(why,500)});
  await checkMould(await one('SELECT * FROM equipment WHERE id=?',scope.mouldId),Date.now());
  return {reset:true,version:prev.version};
}

// ---------- Drift ----------
async function scopeReadings(scope,fromMs,toMs) {
  const ids=(await all('SELECT id FROM batches WHERE company_id=? AND mould_id=? AND equipment_id=? AND product_id=? AND started_at<? AND COALESCE(ended_at,\'9999\')>=?',scope.companyId,scope.mouldId,scope.equipmentId,scope.productId,iso(toMs),iso(fromMs))).map(r=>r.id);
  if (!ids.length) return [];
  return (await all(`SELECT batch_id,observed_at,parameter,value FROM process_readings WHERE batch_id IN (${idList(ids)}) AND observed_at>=? AND observed_at<? ORDER BY observed_at`,...ids,iso(fromMs),iso(toMs))).map(r=>({t:Date.parse(r.observed_at),k:r.parameter,v:r.value,batchId:r.batch_id}));
}
// Medians of the settings in [from,to), for settings with enough readings.
function windowMedians(readings,fp,from,to,minN) {
  const by={}; for (const r of readings) if (r.t>=from&&r.t<to&&fp.params[r.k]) (by[r.k]??=[]).push(r.v);
  const med={}, counts={}; for (const [k,v] of Object.entries(by)) if (v.length>=minN) { med[k]=median(v); counts[k]=v.length; }
  return {med,counts,n:Math.max(0,...Object.values(by).map(v=>v.length))};
}

// The recent run against a fingerprint: score, level, per-setting movement, per-shift scores and a score series.
export async function driftFor(scope,fpRow,now=Date.now()) {
  const cfg=config(), fp=parsed(fpRow), th=thresholds(cfg), SPAN=8*DAY;
  const readings=await scopeReadings(scope,now-SPAN,now+1);
  const base={fingerprintId:fpRow.id,version:fpRow.version,thresholds:th,recentHours:cfg.recentHours};
  if (!readings.length) return {...base,status:'insufficient',score:null,level:null,message:'no_readings',series:[],byShift:[],parameters:[]};
  const latest=readings.at(-1).t, end=Math.min(now,latest+1), stale=now-latest>cfg.staleHours*HOUR;
  const need=Math.min(2,Object.keys(fp.params).length);
  const w=windowMedians(readings,fp,end-cfg.recentHours*HOUR,end,cfg.minRecent);
  const d=Object.keys(w.med).length>=need?driftOf(fp,w.med):null;
  const series=[]; for (let t=end-7*DAY; t<=end; t+=3*HOUR) { const x=windowMedians(readings,fp,t-cfg.recentHours*HOUR,t,cfg.minRecent), y=Object.keys(x.med).length>=need?driftOf(fp,x.med):null; if (y) series.push({t:iso(t),v:y.score}); }
  const out={...base,windowFrom:iso(end-cfg.recentHours*HOUR),windowTo:iso(Math.min(end,now)),latestReadingAt:iso(latest),series};
  if (!d) return {...out,status:'insufficient',score:null,level:null,message:'few_recent',recentReadings:w.n,minRecent:cfg.minRecent,byShift:[],parameters:[]};
  const machine=await one('SELECT * FROM equipment WHERE id=?',scope.equipmentId), plant=machine?await plantOf(machine):null, byShift=[];
  if (plant) for (const sw of (await shiftWindows(plant,end-3*DAY,end)).slice(-9)) { const x=windowMedians(readings,fp,sw.start,sw.end,4), y=Object.keys(x.med).length>=need?driftOf(fp,x.med):null; if (y) byShift.push({date:sw.date,shift:sw.name,score:y.score,level:levelOf(y.score,th),worst:y.parameters[0]?.parameter||null}); }
  const parameters=d.parameters.map(p=>({...p,...paramInfo(p.parameter),n:w.counts[p.parameter]}));
  return {...out,status:stale?'stale':'ok',score:d.score,level:levelOf(d.score,th),stale,ageHours:round((now-latest)/HOUR,1),parameters,byShift};
}

// ---------- One scope for the screens and the advice ----------
export async function scopeView(scope,now=Date.now()) {
  const machine=await one('SELECT id,asset_tag,make,model FROM equipment WHERE id=?',scope.equipmentId), product=await one('SELECT id,part_number,name FROM products WHERE id=?',scope.productId), mould=await one('SELECT id,asset_tag,make,model FROM equipment WHERE id=?',scope.mouldId);
  const out={key:scopeKey(scope),mouldId:scope.mouldId,mould:mould&&{id:mould.id,assetTag:mould.asset_tag,name:`${mould.make} ${mould.model}`.trim()},equipmentId:scope.equipmentId,machine:machine&&{id:machine.id,assetTag:machine.asset_tag,name:`${machine.make} ${machine.model}`.trim()},
    productId:scope.productId,product:product&&{id:product.id,partNumber:product.part_number,name:product.name}};
  const fpRow=await activeFingerprint(scope), last=fpRow||await latestFingerprint(scope);
  const versions=(await all('SELECT version,status,origin,sample_size,batches,period_from,period_to,reason,created_at,closed_at FROM mould_fingerprints WHERE mould_id=? AND equipment_id=? AND product_id=? ORDER BY version DESC LIMIT 10',scope.mouldId,scope.equipmentId,scope.productId))
    .map(v=>({version:v.version,status:v.status,origin:v.origin,sampleSize:v.sample_size,batches:v.batches,periodFrom:v.period_from,periodTo:v.period_to,reason:v.reason,createdAt:v.created_at,closedAt:v.closed_at}));
  if (!fpRow) {
    const dry=await buildFingerprint(scope,{to:now});
    return {...out,status:last?.status==='reset'?'reset':'none',versions,canBuild:dry.ok,reasons:dry.ok?[]:dry.reasons,buildPreview:dry.ok?{sampleSize:dry.sampleSize,batches:dry.batches,periodFrom:dry.periodFrom,periodTo:dry.periodTo}:null};
  }
  const fp=parsed(fpRow), drift=await driftFor(scope,fpRow,now);
  return {...out,status:'active',version:fpRow.version,origin:fpRow.origin,builtAt:fpRow.created_at,reason:fpRow.reason,sampleSize:fpRow.sample_size,batches:fpRow.batches,periodFrom:fpRow.period_from,periodTo:fpRow.period_to,
    params:Object.fromEntries(Object.entries(fp.params).map(([k,p])=>[k,p])),correlations:fp.correlations,shifts:fp.shifts,days:fp.days,labels:fp.labels,versions,drift,thresholds:thresholds(config())};
}

// ---------- Alerts ----------
const alertKey=mouldId=>`process-drift:${mouldId}`;
const wordsOf=d=>d.parameters.filter(p=>p.moved).slice(0,3).map(p=>`${p.label} ${p.delta>0?'+':''}${p.delta} ${p.unit} (${p.z>0?'+':''}${p.z} sd)`).join(', ');
// Judges every active fingerprint of a mould and keeps at most one alert open for it: raised (or escalated) when the
// worst score reaches warning, resolved when every judged score is back below the resolve level. Stale or thin recent
// data changes nothing.
export async function checkMould(mould,now=Date.now()) {
  const cfg=config(), results=[];
  for (const scope of await scopesOf(mould,now)) { const fpRow=await activeFingerprint(scope); if (!fpRow) continue; const d=await driftFor(scope,fpRow,now); results.push({scope,d}); }
  const judged=results.filter(r=>r.d.status==='ok');
  const worst=judged.reduce((w,r)=>!w||r.d.score>w.d.score?r:w,null), key=alertKey(mould.id);
  const open=await one("SELECT * FROM alerts WHERE dedupe_key=? AND status<>'resolved'",key);
  if (!results.length) { if (open) await resolveAlertKey(key,iso(now)); return {checked:0,level:null,resolved:!!open}; } // no fingerprint, nothing to drift from
  if (!judged.length) return {checked:results.length,level:null,alert:open?.id??null};
  if (worst.d.score>=cfg.warning) {
    const severity=worst.d.score>=cfg.critical?'critical':'warning', product=await one('SELECT part_number FROM products WHERE id=?',worst.scope.productId), machine=await one('SELECT asset_tag FROM equipment WHERE id=?',worst.scope.equipmentId);
    const title=`Process drift on mould ${mould.asset_tag||mould.model}: score ${worst.d.score} (${severity})`, detail=`${product?.part_number||''} on ${machine?.asset_tag||''}: the run of the last ${cfg.recentHours} h has moved away from the good-run fingerprint (version ${worst.d.version}). Moved: ${wordsOf(worst.d)||'several settings slightly'}. Open the mould's process fingerprint for the table, or ask for advice.`;
    if (open) { if (severity==='critical'&&open.severity!=='critical') await escalateAlert(open.id,{severity,title,detail}); return {checked:results.length,level:severity,alert:open.id,raised:false}; }
    const alert=await raiseAlert({companyId:mould.company_id,plantId:mould.plant_id,module:'process',severity,equipmentId:mould.id,title,detail,dedupeKey:key,at:iso(now)});
    return {checked:results.length,level:severity,alert,raised:!!alert};
  }
  if (open&&worst.d.score<cfg.resolveBelow) { await resolveAlertKey(key,iso(now)); return {checked:results.length,level:'ok',resolved:true}; }
  return {checked:results.length,level:levelOf(worst.d.score,thresholds(cfg)),alert:open?.id??null};
}
// Background scan: learns a first fingerprint where there is enough good data (never after a reset: that takes a person),
// then judges every mould's recent run.
export async function scanFingerprints(now=Date.now()) {
  let built=0, checked=0;
  for (const mould of await all("SELECT * FROM equipment WHERE machine_type='mould' AND status<>'decommissioned' ORDER BY id")) {
    for (const scope of await scopesOf(mould,now)) { if (await latestFingerprint(scope)) continue; const b=await buildFingerprint(scope,{to:now}); if (b.ok) { await saveVersion(scope,b,{origin:'auto',reason:'Learned automatically from good production'}); built++; } }
    await checkMould(mould,now); checked++;
  }
  return {built,checked};
}
