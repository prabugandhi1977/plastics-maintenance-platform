// Canonical telemetry record. Every adapter (mock today, the customer's real API later) maps its vendor payload to
// this shape before ingest, so validation, mapping, and storage never depend on a vendor schema.
//
// { deviceId, observedAt (ISO 8601 with offset), runningHours?, cycleCount?, temperatureC? | temperatureF?,
//   alarms?: [{ code, state: 'active'|'cleared', severity?: 'info'|'warning'|'critical', message? }] }
//
// normalizeRecord never throws: it returns { record } or { errors }, so a batch can report every problem per record.
import { instant } from '../validate.js';

export const FUTURE_TOLERANCE_MS=5*60*1000;
export const LIMITS={runningHours:[0,1_000_000],cycleCount:[0,Number.MAX_SAFE_INTEGER],temperatureC:[-50,600]};
const METRICS=['runningHours','cycleCount','temperatureC'];

export function normalizeRecord(input) {
  const errors=[], check=fn=>{ try { return fn(); } catch(e) { errors.push(e.message); } };
  if (!input || typeof input!=='object' || Array.isArray(input)) return {errors:['record must be a JSON object']};
  const deviceId=typeof input.deviceId==='string' && input.deviceId.trim() && input.deviceId.length<=100 ? input.deviceId.trim() : (errors.push('deviceId must be 1-100 characters'),null);
  const observedAt=check(()=>instant(input.observedAt,'observedAt'));
  if (observedAt && Date.parse(observedAt)>Date.now()+FUTURE_TOLERANCE_MS) errors.push('observedAt is more than 5 minutes in the future');
  if (input.temperatureC!=null && input.temperatureF!=null) errors.push('send temperatureC or temperatureF, not both');
  const values={runningHours:input.runningHours,cycleCount:input.cycleCount,temperatureC:input.temperatureF!=null&&Number.isFinite(input.temperatureF)?Math.round((input.temperatureF-32)*5/9*100)/100:input.temperatureC};
  if (input.temperatureF!=null && !Number.isFinite(input.temperatureF)) errors.push('temperatureF must be a number');
  for (const key of METRICS) {
    const v=values[key]; if (v==null) { values[key]=null; continue; }
    const [min,max]=LIMITS[key];
    if (!Number.isFinite(v) || (key==='cycleCount' && !Number.isSafeInteger(v)) || v<min || v>max) errors.push(`${key} must be ${key==='cycleCount'?'an integer':'a number'} from ${min} to ${max}`);
  }
  const alarmInput=input.alarms??(input.alarmCode!=null?[{code:input.alarmCode,state:'active',severity:'warning'}]:[]);
  const alarms=[];
  if (!Array.isArray(alarmInput) || alarmInput.length>50) errors.push('alarms must be an array of at most 50 items');
  else for (const [i,a] of alarmInput.entries()) {
    if (!a || typeof a.code!=='string' || !a.code.trim() || a.code.length>100) { errors.push(`alarms[${i}].code must be 1-100 characters`); continue; }
    if (!['active','cleared'].includes(a.state)) { errors.push(`alarms[${i}].state must be active or cleared`); continue; }
    const severity=a.severity??'warning'; if (!['info','warning','critical'].includes(severity)) { errors.push(`alarms[${i}].severity must be info, warning or critical`); continue; }
    alarms.push({code:a.code.trim(),state:a.state,severity,message:typeof a.message==='string'?a.message.slice(0,500):''});
  }
  if (!errors.length && METRICS.every(k=>values[k]==null) && !alarms.length) errors.push('record has no measurements or alarms');
  return errors.length?{errors}:{record:{deviceId,observedAt,...values,alarms}};
}
