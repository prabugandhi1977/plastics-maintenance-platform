// Meter data in: validation, field mapping, timestamps, storage and roll-up. Nothing here knows a vendor's payload format:
// the meter's field mapping says where each value sits. The only formats built in are our own batch formats (below) and the
// two LoRaWAN network-server envelopes (ChirpStack v4 and The Things Stack v3), used to find the decoded object, time and DevEUI.
//
// Native batch, objects:  {meterId, samples:[{t, kw, pf, volts, amps, kva, kvar, thd, kwhTotal, cycle, kw1..kw3, v1..v3, i1..i3, pf1..pf3}]}
// Native batch, columns:  {meterId, t0, dtMs, kw:[..], pf:[..], volts:[..], amps:[..], kva:[..], kvar:[..], thd:[..], cycle:[..]}
//   t / t0: ISO 8601 with offset, or epoch milliseconds. Without t0 the last sample is taken to be "now" (receive time).
import { one, all, run, rawQuery, now } from '../../common/db.js';
import { HttpError, bad } from '../../common/validate.js';

export const LIMITS={maxBatch:1200,bodyBytes:400*1024,keyPerMinute:300,meterRefillPerS:50,meterBurst:60000,maxPastMs:7*86400000,maxFutureMs:5*60000,maxSpanMs:24*3600000,maxMapEntries:30,maxPath:120};
const NAMES=['time','kw','kva','kvar','pf','volts','amps','thd','kwhTotal','cycle','kw1','kw2','kw3','v1','v2','v3','i1','i2','i3','pf1','pf2','pf3'];
const RANGE={kw:[0,20000],kva:[0,20000],kvar:[-20000,20000],pf:[0,1],volts:[0,2000],amps:[0,50000],thd:[0,500],kwhTotal:[0,1e12]};
const num=(v,name,lo,hi)=>{ if (typeof v!=='number'||!Number.isFinite(v)) bad(`${name} must be a number`); if (v<lo||v>hi) bad(`${name} must be from ${lo} to ${hi}`); return v; };

// ---------- Rate limits (in memory: per key and per meter) ----------
const keyHits=new Map(), buckets=new Map();
export function limitKey(keyId,at=Date.now()) {
  if (keyHits.size>5000) keyHits.clear();
  const h=(keyHits.get(keyId)||[]).filter(x=>at-x<60000); h.push(at); keyHits.set(keyId,h);
  if (h.length>LIMITS.keyPerMinute) throw Object.assign(new HttpError(429,`Too many requests for this key (limit ${LIMITS.keyPerMinute} per minute). Send bigger batches, less often.`),{headers:{'retry-after':'10'}});
}
export function limitMeter(meterId,n,at=Date.now()) {
  if (buckets.size>5000) buckets.clear();
  const b=buckets.get(meterId)||{tokens:LIMITS.meterBurst,at};
  b.tokens=Math.min(LIMITS.meterBurst,b.tokens+(at-b.at)/1000*LIMITS.meterRefillPerS); b.at=at;
  if (b.tokens<n) { buckets.set(meterId,b); throw Object.assign(new HttpError(429,`This meter sends more than ${LIMITS.meterRefillPerS} samples per second on average. Slow down and retry.`),{headers:{'retry-after':String(Math.ceil((n-b.tokens)/LIMITS.meterRefillPerS))}}); }
  b.tokens-=n; buckets.set(meterId,b);
}

// ---------- Mapping ----------
const BAD_KEYS=new Set(['__proto__','constructor','prototype']);
export function parsePath(path) {
  if (typeof path!=='string'||!path||path.length>LIMITS.maxPath) bad('A mapping path must be text of 1-120 characters');
  const parts=[]; for (const m of path.matchAll(/([^.[\]]+)|\[(\d{1,4})\]/g)) { const k=m[1]??Number(m[2]); if (typeof k==='string'&&BAD_KEYS.has(k)) bad('Invalid mapping path'); parts.push(k); }
  if (!parts.length||parts.join('.').length>LIMITS.maxPath*2||!/^[\w.[\]-]+$/.test(path)) bad('A mapping path may contain letters, digits, dot, dash, underscore and [n]');
  return parts;
}
export function getPath(obj,path) { let o=obj; for (const k of parsePath(path)) { if (o==null||typeof o!=='object'||!Object.hasOwn(o,k)) return undefined; o=o[k]; } return o; }
export function parseMapping(m) {
  if (m==null) return {};
  if (typeof m!=='object'||Array.isArray(m)) bad('mapping must be an object');
  const out={}, keys=Object.keys(m); if (keys.length>LIMITS.maxMapEntries) bad(`mapping has at most ${LIMITS.maxMapEntries} entries`);
  for (const k of keys) {
    if (k==='objectPath') { parsePath(m[k]); out[k]=m[k]; continue; }
    if (!NAMES.includes(k)) bad(`mapping field ${k} is unknown. Use: ${NAMES.join(', ')}, objectPath`);
    const v=m[k], e=typeof v==='string'?{path:v}:v;
    if (!e||typeof e!=='object') bad(`mapping.${k} must be a path or {path, scale, offset}`);
    parsePath(e.path); const scale=e.scale??1, offset=e.offset??0;
    if (typeof scale!=='number'||!Number.isFinite(scale)||scale===0||Math.abs(scale)>1e9||typeof offset!=='number'||!Number.isFinite(offset)) bad(`mapping.${k}: scale and offset must be numbers`);
    out[k]={path:e.path,scale,offset};
  }
  return out;
}
// A decoded LoRaWAN uplink: ChirpStack v4 puts the decoded object in `object`, The Things Stack v3 in `uplink_message.decoded_payload`.
export function unwrapLoRa(p) {
  if (!p||typeof p!=='object') bad('The uplink must be a JSON object');
  if (p.uplink_message&&typeof p.uplink_message==='object') return {obj:p.uplink_message.decoded_payload,time:p.uplink_message.received_at||p.received_at,devEui:p.end_device_ids?.dev_eui,network:'ttn'};
  if (p.deviceInfo||p.object!==undefined) return {obj:p.object,time:p.time,devEui:p.deviceInfo?.devEui,network:'chirpstack'};
  bad('Not a ChirpStack v4 or The Things Stack v3 uplink: no object / uplink_message found');
}
// One payload through the mapping → raw fields (named like the native format).
export function applyMapping(root,mapping) {
  const obj=mapping.objectPath?getPath(root,mapping.objectPath):root, out={};
  if (obj==null||typeof obj!=='object') bad('The mapped object was not found in the payload (check objectPath)');
  for (const [k,e] of Object.entries(mapping)) {
    if (k==='objectPath') continue;
    const v=getPath(obj,e.path); if (v===undefined||v===null) continue;
    if (k==='time') { out.t=v; continue; }
    const n=typeof v==='string'&&v.trim()!==''?Number(v):v; if (typeof n!=='number'||!Number.isFinite(n)) bad(`Mapped field ${k} (${e.path}) is not a number`);
    out[k]=n*e.scale+e.offset;
  }
  return out;
}

// ---------- One sample ----------
export function timeMs(t,name='t') {
  if (typeof t==='number') { if (!Number.isFinite(t)||t<1e11) bad(`${name} must be epoch milliseconds or an ISO 8601 time with offset`); return Math.round(t); }
  if (typeof t!=='string'||!/^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/.test(t)) bad(`${name} must be epoch milliseconds or an ISO 8601 time with offset, e.g. 2026-10-01T09:30:00.100Z`);
  const ms=Date.parse(t); if (!Number.isFinite(ms)) bad(`${name} is not a valid time`); return ms;
}
// Raw fields → stored values. Per-phase values are combined: kW and kVA are sums, V and I averages; reactive power follows from kVA and kW.
export function sampleValues(s) {
  const v={}; for (const k of Object.keys(RANGE)) if (s[k]!=null) v[k]=num(s[k],k,...RANGE[k]);
  const ph=n=>[1,2,3].map(i=>s[`${n}${i}`]);
  const [v1,v2,v3]=ph('v'), [i1,i2,i3]=ph('i'), [p1,p2,p3]=ph('pf'), [k1,k2,k3]=ph('kw');
  const volts=[v1,v2,v3].filter(x=>x!=null), amps=[i1,i2,i3].filter(x=>x!=null), kws=[k1,k2,k3].filter(x=>x!=null);
  volts.forEach((x,i)=>num(x,`v${i+1}`,0,2000)); amps.forEach((x,i)=>num(x,`i${i+1}`,0,50000)); kws.forEach((x,i)=>num(x,`kw${i+1}`,0,20000));
  if (v.volts==null&&volts.length) v.volts=volts.reduce((a,b)=>a+b,0)/volts.length;
  if (v.amps==null&&amps.length) v.amps=amps.reduce((a,b)=>a+b,0)/amps.length;
  if (v.kw==null&&kws.length) v.kw=kws.reduce((a,b)=>a+b,0);
  if (v.kw==null&&volts.length===3&&amps.length===3&&[p1,p2,p3].every(x=>x!=null)) { // per-phase V (line to neutral), I and PF
    [p1,p2,p3].forEach((x,i)=>num(x,`pf${i+1}`,0,1)); v.kw=[0,1,2].reduce((n,i)=>n+volts[i]*amps[i]*[p1,p2,p3][i],0)/1000;
    if (v.kva==null) v.kva=[0,1,2].reduce((n,i)=>n+volts[i]*amps[i],0)/1000;
  }
  if (v.kva==null&&v.kw!=null&&v.kvar!=null) v.kva=Math.hypot(v.kw,v.kvar);
  if (v.pf==null&&v.kw!=null&&v.kva>0) v.pf=Math.min(1,v.kw/v.kva);
  if (v.kw==null&&v.amps==null&&v.kwhTotal==null) bad('A sample needs kw (or per-phase values), amps, or kwhTotal');
  if (s.cycle!=null) { if (!Number.isInteger(s.cycle)||s.cycle<0||s.cycle>2**40) bad('cycle must be a non-negative integer'); v.cyc=s.cycle; }
  return v;
}

// ---------- A batch ----------
// Returns [{ts,...values}] in the order given, timestamps from the device when sane (else see clock mode), with the clock offset.
export function parseBatch(body,meter,rx=Date.now()) {
  if (!body||typeof body!=='object') bad('Body must be a JSON object');
  let raw;
  if (Array.isArray(body.samples)) {
    raw=body.samples; if (raw.some(s=>!s||typeof s!=='object'||Array.isArray(s))) bad('Every sample must be an object');
  } else if (body.kw!==undefined||body.amps!==undefined||body.kwhTotal!==undefined) { // columns
    const cols=['kw','kva','kvar','pf','volts','amps','thd','kwhTotal','cycle'].filter(k=>body[k]!==undefined);
    for (const k of cols) if (!Array.isArray(body[k])) bad(`${k} must be an array`);
    const n=body[cols[0]].length; for (const k of cols) if (body[k].length!==n) bad('All columns must have the same length');
    if (n>LIMITS.maxBatch) bad(`At most ${LIMITS.maxBatch} samples per batch`);
    const dt=body.dtMs; if (typeof dt!=='number'||!(dt>=10&&dt<=3600000)) bad('dtMs (10 to 3600000) is required with columns');
    const t0=body.t0==null?null:timeMs(body.t0,'t0'); raw=[];
    for (let i=0;i<n;i++) { const s={}; for (const k of cols) if (body[k][i]!=null) s[k]=body[k][i]; s.t=t0==null?null:t0+Math.round(i*dt); raw.push(s); }
    raw.dtMs=dt;
  } else bad('Send samples:[...] or columns (kw:[...], dtMs, t0)');
  if (!raw.length) bad('The batch is empty');
  if (raw.length>LIMITS.maxBatch) bad(`At most ${LIMITS.maxBatch} samples per batch`);
  const dtMs=raw.dtMs??body.dtMs??meter.nominal_interval_ms;
  let ts=raw.map((s,i)=>{ try { return s.t==null?null:timeMs(s.t); } catch(e) { bad(`Sample ${i}: ${e.message}`); } });
  if (ts.every(t=>t==null)) ts=raw.map((_,i)=>Math.round(rx-(raw.length-1-i)*dtMs));
  else if (ts.some(t=>t==null)) bad('Either every sample has a time or none has');
  const insane=ts.some(t=>t<rx-LIMITS.maxPastMs||t>rx+LIMITS.maxFutureMs);
  let last=Math.max(...ts), offset=rx-last;
  if (insane) {
    if (meter.clock_mode!=='receive') bad(`The meter's clock is off by ${Math.round(offset/1000)} s (samples must be within 7 days in the past and 5 minutes ahead). Fix the meter clock, or set the meter's clock mode to "receive" to use the arrival time.`);
    ts=ts.map(t=>t+offset); last=rx; // keep the spacing, end at the receive time
  }
  if (Math.max(...ts)-Math.min(...ts)>LIMITS.maxSpanMs) bad('A batch can cover at most 24 hours');
  const rows=raw.map((s,i)=>{ try { return {ts:ts[i],...sampleValues(s)}; } catch(e) { if (e instanceof HttpError) bad(`Sample ${i}: ${e.message}`); throw e; } });
  let outOfOrder=0; for (let i=1;i<ts.length;i++) if (ts[i]<ts[i-1]) outOfOrder++;
  return {rows,offsetMs:insane?offset:rx-Math.max(...ts),insane,outOfOrder,rx};
}

// ---------- Storage ----------
export async function storeBatch(meter,parsed) {
  const {rows,rx}=parsed, col=k=>rows.map(r=>r[k]??null);
  const res=await rawQuery(`INSERT INTO energy_samples (meter_id,ts,rx,kw,kva,kvar,pf,volts,amps,thd,kwh_total,cyc)
    SELECT $1,* FROM unnest($2::bigint[],$3::bigint[],$4::float8[],$5::float8[],$6::float8[],$7::float8[],$8::float8[],$9::float8[],$10::float8[],$11::float8[],$12::bigint[]) ON CONFLICT DO NOTHING`,
    [meter.id,rows.map(r=>r.ts),rows.map(()=>rx),col('kw'),col('kva'),col('kvar'),col('pf'),col('volts'),col('amps'),col('thd'),col('kwhTotal'),col('cyc')]);
  const accepted=res.rowCount, ts=rows.map(r=>r.ts), sorted=[...ts].sort((a,b)=>a-b);
  const gaps=[]; for (let i=1;i<sorted.length;i++) if (sorted[i]>sorted[i-1]) gaps.push(sorted[i]-sorted[i-1]);
  const observed=gaps.length?gaps.sort((a,b)=>a-b)[gaps.length>>1]:null;
  await run('UPDATE energy_meters SET last_seen_at=?,last_sample_ts=GREATEST(COALESCE(last_sample_ts,0),?),clock_offset_ms=?,observed_interval_ms=COALESCE(?,observed_interval_ms) WHERE id=?',now(),sorted[sorted.length-1],Math.round(parsed.offsetMs),observed,meter.id);
  return {accepted,duplicates:rows.length-accepted,outOfOrder:parsed.outOfOrder,clockOffsetMs:Math.round(parsed.offsetMs),observedIntervalMs:observed};
}

// Raw samples older than the retention (default 24 h) that no audit still needs are rolled up to one-minute aggregates and deleted.
// Audit windows keep their raw samples until the audit's keep-until date (set when it completes) or someone deletes them.
export const RAW_RETENTION_H=Number(process.env.ENERGY_RAW_RETENTION_HOURS||24), RAW_KEEP_DAYS=Number(process.env.ENERGY_AUDIT_RAW_KEEP_DAYS||90);
export async function rollupRaw(at=Date.now()) {
  const where=`FROM energy_samples s JOIN energy_meters m ON m.id=s.meter_id AND m.measures='power' WHERE s.rx<$1 AND NOT EXISTS (SELECT 1 FROM energy_audits a WHERE a.meter_id=s.meter_id AND a.status<>'cancelled' AND a.period_start_ms IS NOT NULL
    AND s.ts>=a.period_start_ms-60000 AND s.ts<=COALESCE(a.period_end_ms,9000000000000000000)+60000 AND COALESCE(a.keep_raw_until_ms,9000000000000000000)>$2)`;
  const cutoff=at-RAW_RETENTION_H*3600000;
  await rawQuery(`INSERT INTO energy_sample_agg (meter_id,ts,n,kw_n,kw_sum,kw_max,pf_n,pf_sum)
    SELECT s.meter_id,(s.ts/60000)*60000,count(*),count(s.kw),COALESCE(sum(s.kw),0),max(s.kw),count(s.pf),COALESCE(sum(s.pf),0) ${where} GROUP BY 1,2
    ON CONFLICT (meter_id,ts) DO UPDATE SET n=energy_sample_agg.n+EXCLUDED.n,kw_n=energy_sample_agg.kw_n+EXCLUDED.kw_n,kw_sum=energy_sample_agg.kw_sum+EXCLUDED.kw_sum,kw_max=GREATEST(energy_sample_agg.kw_max,EXCLUDED.kw_max),pf_n=energy_sample_agg.pf_n+EXCLUDED.pf_n,pf_sum=energy_sample_agg.pf_sum+EXCLUDED.pf_sum`,[cutoff,at]);
  const del=await rawQuery(`DELETE FROM energy_samples WHERE (meter_id,ts) IN (SELECT s.meter_id,s.ts ${where})`,[cutoff,at]);
  return del.rowCount;
}
export async function sampleRows(meterId,from,to,limit=900000) {
  return await all('SELECT ts,kw,kva,kvar,pf,volts,amps,thd,kwh_total,cyc FROM energy_samples WHERE meter_id=? AND ts>=? AND ts<=? ORDER BY ts LIMIT ?',meterId,from,to,limit);
}
export async function aggRows(meterId,from,to) {
  return (await all('SELECT ts,kw_n,kw_sum,pf_n,pf_sum FROM energy_sample_agg WHERE meter_id=? AND ts>=? AND ts<=? ORDER BY ts',meterId,from-60000,to)).filter(a=>a.kw_n>0)
    .map(a=>({ts:a.ts+30000,kw:a.kw_sum/a.kw_n,pf:a.pf_n?a.pf_sum/a.pf_n:null,amps:null,volts:null,kva:null,thd:null,kwh_total:null,cyc:null}));
}
