// Ingest and read-side queries for telemetry. ingestRecord does not open its own transaction: callers (push endpoint,
// sync runner) wrap a whole batch so a cursor only advances together with the records it covers.
import { id, now, one, all, run, mapSeq } from '../../common/db.js';
import { normalizeRecord } from './contract.js';

const COLUMNS={runningHours:'running_hours',cycleCount:'cycle_count',temperatureC:'temperature_c'};

// deviceId comes from the canonical record when there is one; the stored raw payload stays in the vendor's own shape.
export async function rejectRecord(source,original,reasons,deviceId=original?.deviceId) {
  await run('INSERT INTO iot_rejections (id,source,external_device_id,reasons,raw_json,received_at) VALUES (?,?,?,?,?,?)',id(),source,typeof deviceId==='string'?deviceId.slice(0,100):null,JSON.stringify(reasons),String(JSON.stringify(original??null)).slice(0,4000),now());
  return {status:'rejected',errors:reasons};
}
const reject=async (source,original,reasons,input)=>await rejectRecord(source,original,reasons,input?.deviceId);

// Returns {status:'accepted'|'duplicate'|'rejected', ...}. Suspicious but plausible data is stored with quality flags
// rather than dropped, so later analysis can decide; only structurally invalid or unmapped records are rejected.
export async function ingestRecord(input,source,original=input) {
  const {record,errors}=normalizeRecord(input);
  if (errors) return await reject(source,original,errors,input);
  const mapping=await one('SELECT * FROM device_mappings WHERE external_device_id=?',record.deviceId);
  if (!mapping) return await reject(source,original,['Unknown deviceId: map it to an asset first'],input);
  if (!mapping.active) return await reject(source,original,['Device mapping is inactive'],input);
  const existing=await one('SELECT id FROM readings WHERE external_device_id=? AND observed_at=?',record.deviceId,record.observedAt);
  if (existing) return {status:'duplicate',id:existing.id,equipmentId:mapping.equipment_id};
  const received=now(), flags=[];
  if (await one('SELECT 1 FROM readings WHERE external_device_id=? AND observed_at>?',record.deviceId,record.observedAt)) flags.push('out_of_order');
  if (Date.parse(received)-Date.parse(record.observedAt)>mapping.stale_after_minutes*60000) flags.push('late_arrival');
  if (Date.parse(record.observedAt)>Date.parse(received)) flags.push('device_clock_ahead');
  for (const [key,column] of [['cycleCount','cycle_count'],['runningHours','running_hours']]) {
    if (record[key]==null) continue;
    const prev=await one(`SELECT ${column} v FROM readings WHERE external_device_id=? AND observed_at<? AND ${column} IS NOT NULL ORDER BY observed_at DESC LIMIT 1`,record.deviceId,record.observedAt);
    if (prev && record[key]<prev.v) flags.push(`${column}_regression`);
  }
  const readingId=id(), firstActive=record.alarms.find(a=>a.state==='active')?.code??null;
  await run('INSERT INTO readings (id,company_id,equipment_id,external_device_id,observed_at,received_at,running_hours,cycle_count,temperature_c,alarm_code,raw_json,source,quality_flags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',readingId,mapping.company_id,mapping.equipment_id,record.deviceId,record.observedAt,received,record.runningHours,record.cycleCount,record.temperatureC,firstActive,String(JSON.stringify(original)).slice(0,8000),source,JSON.stringify(flags));
  for (const a of record.alarms) {
    if (a.state==='active') { if (!await one('SELECT 1 FROM iot_alarms WHERE external_device_id=? AND code=? AND cleared_at IS NULL',record.deviceId,a.code)) await run('INSERT INTO iot_alarms (id,company_id,equipment_id,external_device_id,code,severity,message,raised_at,received_at,source) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',id(),mapping.company_id,mapping.equipment_id,record.deviceId,a.code,a.severity,a.message,record.observedAt,received,source); }
    else await run('UPDATE iot_alarms SET cleared_at=? WHERE external_device_id=? AND code=? AND cleared_at IS NULL AND raised_at<=?',record.observedAt,record.deviceId,a.code,record.observedAt);
  }
  return {status:'accepted',id:readingId,equipmentId:mapping.equipment_id,flags};
}

// Freshness per asset and per metric. Overall status: unmapped | inactive | missing | stale | current.
// Each metric reports its own last known value and age, because a device can keep reporting while one sensor drops out.
export async function telemetry(equipmentId,at=Date.now()) {
  const mappings=await all('SELECT external_device_id,active,stale_after_minutes FROM device_mappings WHERE equipment_id=?',equipmentId), active=mappings.filter(m=>m.active);
  const activeAlarms=await all('SELECT id,code,severity,message,raised_at,external_device_id FROM iot_alarms WHERE equipment_id=? AND cleared_at IS NULL ORDER BY raised_at DESC',equipmentId);
  const base={deviceIds:mappings.map(m=>m.external_device_id),activeAlarms};
  if (!mappings.length) return {status:'unmapped',...base,reading:null,metrics:null};
  if (!active.length) return {status:'inactive',...base,reading:null,metrics:null};
  const staleAfterMinutes=Math.min(...active.map(m=>m.stale_after_minutes)), fresh=t=>at-Date.parse(t)<=staleAfterMinutes*60000;
  const reading=await one('SELECT observed_at,received_at,running_hours,cycle_count,temperature_c,alarm_code,quality_flags FROM readings WHERE equipment_id=? ORDER BY observed_at DESC LIMIT 1',equipmentId);
  if (!reading) return {status:'missing',...base,staleAfterMinutes,reading:null,metrics:null};
  const metrics=Object.fromEntries((await mapSeq(Object.entries(COLUMNS), async ([key,column])=>{
    const row=await one(`SELECT ${column} value,observed_at FROM readings WHERE equipment_id=? AND ${column} IS NOT NULL ORDER BY observed_at DESC LIMIT 1`,equipmentId);
    return [key,row?{value:row.value,observedAt:row.observed_at,status:fresh(row.observed_at)?'current':'stale'}:{value:null,observedAt:null,status:'missing'}];
  })));
  return {status:fresh(reading.observed_at)?'current':'stale',...base,staleAfterMinutes,lastObservedAt:reading.observed_at,ageMinutes:Math.round((at-Date.parse(reading.observed_at))/60000),reading:{...reading,quality_flags:JSON.parse(reading.quality_flags)},metrics};
}
export async function readingHistory(equipmentId,{before,limit=100}={}) {
  return (await all(`SELECT id,external_device_id,observed_at,received_at,running_hours,cycle_count,temperature_c,alarm_code,quality_flags,source FROM readings WHERE equipment_id=? ${before?'AND observed_at<?':''} ORDER BY observed_at DESC LIMIT ?`,...[equipmentId,...(before?[before]:[]),limit])).map(r=>({...r,quality_flags:JSON.parse(r.quality_flags)}));
}
export async function alarmHistory(equipmentId,state='all') {
  return await all(`SELECT id,external_device_id,code,severity,message,raised_at,cleared_at,source FROM iot_alarms WHERE equipment_id=? ${state==='active'?'AND cleared_at IS NULL':''} ORDER BY raised_at DESC LIMIT 200`,equipmentId);
}
