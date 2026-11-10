// Work procedures: definitions (versioned, published), copying one onto a ticket, recording each step, and what the
// recorded runs say about the procedure. A run keeps a copy of each step as it was when attached.
import { id, now, one, all, run } from '../../common/db.js';
import { audit, byId, ticketEvent } from '../../common/access.js';
import { array, bad, integer, required } from '../../common/validate.js';
import { MACHINE_TYPES } from '../../common/catalog.js';

export const J=(v,d)=>{ try { return JSON.parse(v); } catch { return d; } };
const MAX_STEP_SECONDS=8*3600;
const text=(v,name,max)=>v==null||v===''?'':typeof v==='string'&&v.length<=max?v.trim():bad(`${name} must be text of at most ${max} characters`);
const number=(v,name)=>v==null||v===''?null:typeof v==='number'&&Number.isFinite(v)?v:bad(`${name} must be a number`);

// One step as the author sends it: {title, instruction?, safety?, spec?, parts?:[{partNumber,quantity}], measurement?:{name,unit?,min?,max?},
// requiresPhoto?, mandatory? (default true), expectedMinutes?}.
export function parseStep(b,i) {
  const at=`steps[${i}]`; if (!b||typeof b!=='object') bad(`${at} must be an object`);
  const parts=b.parts==null?[]:array(b.parts,`${at}.parts`);
  if (parts.length>20) bad(`${at}.parts can hold up to 20 parts`);
  const cleanParts=parts.map(p=>({partNumber:required(p?.partNumber,`${at}.parts.partNumber`,80),quantity:p.quantity==null?1:integer(p.quantity,`${at}.parts.quantity`,1,100000)}));
  let measurement=null;
  if (b.measurement!=null) {
    const m=b.measurement; if (typeof m!=='object') bad(`${at}.measurement must be an object`);
    measurement={name:required(m.name,`${at}.measurement.name`,80),unit:text(m.unit,`${at}.measurement.unit`,20),min:number(m.min,`${at}.measurement.min`),max:number(m.max,`${at}.measurement.max`)};
    if (measurement.min!=null&&measurement.max!=null&&measurement.min>measurement.max) bad(`${at}.measurement.min must not be above max`);
  }
  if (b.requiresPhoto!=null&&typeof b.requiresPhoto!=='boolean') bad(`${at}.requiresPhoto must be true or false`);
  if (b.mandatory!=null&&typeof b.mandatory!=='boolean') bad(`${at}.mandatory must be true or false`);
  return {title:required(b.title,`${at}.title`,160),instruction:text(b.instruction,`${at}.instruction`,2000),safety:text(b.safety,`${at}.safety`,500),spec:text(b.spec,`${at}.spec`,200),
    parts:cleanParts,measurement,requiresPhoto:b.requiresPhoto===true,mandatory:b.mandatory!==false,expectedMinutes:b.expectedMinutes==null||b.expectedMinutes===''?null:integer(b.expectedMinutes,`${at}.expectedMinutes`,1,1440)};
}
export const stepOut=s=>({id:s.id,position:s.position,title:s.title,instruction:s.instruction,safety:s.safety,spec:s.spec,parts:J(s.parts,[]),measurement:J(s.measurement,null),requiresPhoto:!!s.requires_photo,mandatory:!!s.mandatory,expectedMinutes:s.expected_minutes});
export const procedureOut=(p,steps)=>({id:p.id,code:p.code,version:p.version,title:p.title,machineTypes:J(p.machine_types,[]),autoAttach:!!p.auto_attach,status:p.status,createdAt:p.created_at,publishedAt:p.published_at,
  ...(steps?{steps:steps.map(stepOut)}:{})});
export const machineTypes=v=>{ const t=array(v,'machineTypes'); if (t.some(x=>!MACHINE_TYPES.includes(x))) bad(`machineTypes must be from: ${MACHINE_TYPES.join(', ')}`); return [...new Set(t)]; };
export const stepsOf=async pid=>await all('SELECT * FROM procedure_steps WHERE procedure_id=? ORDER BY position',pid);

// ---------- Running a procedure on a ticket ----------
const defOf=s=>({title:s.title,instruction:s.instruction,safety:s.safety,spec:s.spec,parts:J(s.parts,[]),measurement:J(s.measurement,null),requiresPhoto:!!s.requires_photo,mandatory:!!s.mandatory,expectedMinutes:s.expected_minutes});

export async function attach(u,ticket,p) {
  const existing=await one('SELECT * FROM ticket_procedures WHERE ticket_id=? AND code=?',ticket.id,p.code); if (existing) return existing;
  const key=id(), stamp=now();
  await run('INSERT INTO ticket_procedures (id,ticket_id,procedure_id,code,version,title,status,attached_by,started_at) VALUES (?,?,?,?,?,?,?,?,?)',key,ticket.id,p.id,p.code,p.version,p.title,'in_progress',u.id,stamp);
  for (const s of await stepsOf(p.id)) await run('INSERT INTO ticket_procedure_steps (id,ticket_procedure_id,step_id,position,def) VALUES (?,?,?,?,?)',id(),key,s.id,s.position,JSON.stringify(defOf(s)));
  await ticketEvent(ticket.id,u,'procedure',`Procedure attached: ${p.title} (v${p.version})`,stamp);
  await audit(u,'procedure.attach','ticket',ticket.id,ticket.company_id,{procedureId:p.id,code:p.code,version:p.version});
  return await byId('ticket_procedures',key);
}
// Active procedures marked auto-attach for the machine's type are attached when the technician accepts the job.
export async function autoAttach(u,ticket) {
  const type=(await one('SELECT machine_type FROM equipment WHERE id=?',ticket.equipment_id))?.machine_type; if (!type) return 0;
  let n=0;
  for (const p of await all("SELECT * FROM procedures WHERE status='active' AND auto_attach=1 ORDER BY code")) if (J(p.machine_types,[]).includes(type)) { const before=await one('SELECT 1 FROM ticket_procedures WHERE ticket_id=? AND code=?',ticket.id,p.code); await attach(u,ticket,p); if (!before) n++; }
  return n;
}
// Mandatory steps still waiting, by title, on a ticket's procedures.
export async function openMandatory(ticketId) {
  const rows=await all("SELECT tp.title procedure,s.def FROM ticket_procedure_steps s JOIN ticket_procedures tp ON tp.id=s.ticket_procedure_id WHERE tp.ticket_id=? AND s.status='pending' ORDER BY tp.started_at,s.position",ticketId);
  return rows.map(r=>({procedure:r.procedure,def:J(r.def,{})})).filter(r=>r.def.mandatory).map(r=>`${r.procedure}: ${r.def.title}`);
}
export async function runsOf(ticketId) {
  const runs=await all('SELECT * FROM ticket_procedures WHERE ticket_id=? ORDER BY started_at',ticketId), out=[];
  for (const r of runs) {
    const steps=await all('SELECT * FROM ticket_procedure_steps WHERE ticket_procedure_id=? ORDER BY position',r.id);
    out.push({id:r.id,procedureId:r.procedure_id,code:r.code,version:r.version,title:r.title,status:r.status,startedAt:r.started_at,completedAt:r.completed_at,
      steps:steps.map(s=>({id:s.id,position:s.position,...J(s.def,{}),status:s.status,measurementValue:s.measurement_value,inRange:s.in_range==null?null:!!s.in_range,photoId:s.photo_id,note:s.note,deviation:s.deviation,completedAt:s.completed_at,completedBy:s.completed_by,seconds:s.seconds}))});
  }
  return out;
}

// Record a step: {status:'done'|'skipped'|'pending', measurementValue?, photoId?, note?, deviation?}. A measured step needs its value; a value
// outside the limits needs a deviation note; a step that requires a photo needs one from this ticket; a mandatory step cannot be skipped.
export async function recordStep(u,ticket,row,body) {
  const def=J(row.def,{}), status=body.status; if (!['done','skipped','pending'].includes(status)) bad('status must be one of: done, skipped, pending');
  const note=text(body.note,'note',1000), deviation=text(body.deviation,'deviation',500);
  let value=null, inRange=null, photoId=null, completedAt=null, seconds=null;
  if (status==='skipped') { if (def.mandatory) bad('A mandatory step cannot be skipped: do it, or record a deviation'); if (!note) bad('Say why the step is skipped'); completedAt=now(); }
  if (status==='done') {
    completedAt=now();
    if (def.measurement) {
      value=number(body.measurementValue,'measurementValue'); if (value==null) bad(`Enter the ${def.measurement.name}`);
      const m=def.measurement; inRange=(m.min==null||value>=m.min)&&(m.max==null||value<=m.max)?1:0;
      if (!inRange&&!deviation) bad(`${def.measurement.name} ${value}${m.unit?' '+m.unit:''} is outside ${m.min??'…'} to ${m.max??'…'}: record a deviation note`);
    }
    if (def.requiresPhoto) {
      const a=typeof body.photoId==='string'?await one("SELECT id FROM attachments WHERE id=? AND entity_type='ticket' AND entity_id=? AND kind='photo'",body.photoId,ticket.id):null;
      if (!a) bad('This step needs a photo: upload it to this ticket first and send its photoId');
      photoId=a.id;
    }
    const run0=await one('SELECT * FROM ticket_procedures WHERE id=?',row.ticket_procedure_id);
    const last=await one("SELECT max(completed_at) t FROM ticket_procedure_steps WHERE ticket_procedure_id=? AND id<>? AND completed_at IS NOT NULL",row.ticket_procedure_id,row.id);
    const since=Math.max(Date.parse(run0.started_at),last?.t?Date.parse(last.t):0);
    seconds=Math.min(MAX_STEP_SECONDS,Math.max(0,Math.round((Date.parse(completedAt)-since)/1000)));
  }
  await run('UPDATE ticket_procedure_steps SET status=?,measurement_value=?,in_range=?,photo_id=?,note=?,deviation=?,completed_at=?,completed_by=?,seconds=? WHERE id=?',status,value,inRange,photoId,note,deviation,completedAt,status==='pending'?null:u.id,seconds,row.id);
  const left=(await all("SELECT def FROM ticket_procedure_steps WHERE ticket_procedure_id=? AND status='pending'",row.ticket_procedure_id)).filter(s=>J(s.def,{}).mandatory).length;
  const tp=await one('SELECT * FROM ticket_procedures WHERE id=?',row.ticket_procedure_id), finished=left===0;
  if (finished&&tp.status!=='completed') { await run("UPDATE ticket_procedures SET status='completed',completed_at=? WHERE id=?",now(),tp.id); await ticketEvent(ticket.id,u,'procedure',`Procedure completed: ${tp.title} (v${tp.version})`); }
  if (!finished&&tp.status==='completed') await run("UPDATE ticket_procedures SET status='in_progress',completed_at=NULL WHERE id=?",tp.id);
  await audit(u,'procedure.step','ticket',ticket.id,ticket.company_id,{runId:tp.id,step:def.title,status,...(inRange===0?{outOfRange:true,value}:{}),...(deviation?{deviation}:{})});
  return (await runsOf(ticket.id)).find(r=>r.id===tp.id);
}

// What recorded runs say about a procedure code (all versions, or one): per step how often it was done, skipped, out of range
// or noted with a deviation, and the time from the previous step (the first step: from the start of the run) against the expected time.
export async function analytics(code,version=null) {
  const runs=await all(`SELECT * FROM ticket_procedures WHERE code=?${version?' AND version=?':''}`,...(version?[code,version]:[code]));
  const steps=new Map(); let completed=0, totalSeconds=0, timed=0;
  for (const r of runs) {
    if (r.status==='completed') { completed++; const secs=(await all("SELECT seconds FROM ticket_procedure_steps WHERE ticket_procedure_id=? AND seconds IS NOT NULL",r.id)).reduce((n,x)=>n+x.seconds,0); totalSeconds+=secs; timed++; }
    for (const s of await all('SELECT * FROM ticket_procedure_steps WHERE ticket_procedure_id=? ORDER BY position',r.id)) {
      const def=J(s.def,{}), k=`${r.version}:${s.position}`; const a=steps.get(k)||{version:r.version,position:s.position,title:def.title,expectedMinutes:def.expectedMinutes??null,runs:0,done:0,skipped:0,pending:0,outOfRange:0,deviations:0,seconds:[]};
      a.runs++; a[s.status]++; if (s.in_range===0) a.outOfRange++; if (s.deviation) a.deviations++; if (s.seconds!=null&&s.status==='done') a.seconds.push(s.seconds); steps.set(k,a);
    }
  }
  const avg=xs=>xs.length?Math.round(xs.reduce((a,b)=>a+b,0)/xs.length/60*10)/10:null;
  return {code,version,runs:runs.length,completedRuns:completed,averageRunMinutes:timed?Math.round(totalSeconds/timed/60*10)/10:null,
    steps:[...steps.values()].sort((a,b)=>a.version-b.version||a.position-b.position).map(({seconds,...a})=>({...a,averageMinutes:avg(seconds),
      deviationRate:a.runs?Math.round(a.deviations/a.runs*1000)/1000:0,skipRate:a.runs?Math.round(a.skipped/a.runs*1000)/1000:0,outOfRangeRate:a.runs?Math.round(a.outOfRange/a.runs*1000)/1000:0,
      overExpected:a.expectedMinutes!=null&&avg(seconds)!=null?avg(seconds)>a.expectedMinutes:null}))};
}
