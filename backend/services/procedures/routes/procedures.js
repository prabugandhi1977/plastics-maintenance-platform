// Work procedures. Platform administrators and dispatchers write and publish them; whoever services a ticket (the assigned
// engineer or provider, or dispatch) attaches one and records each step; staff who see the ticket see the run.
import { id, now, one, all, run } from '../../../common/db.js';
import { isProvider } from '../../../common/security.js';
import { audit, byId, canService, getTicket, isDispatch } from '../../../common/access.js';
import { created } from '../../../common/http.js';
import { array, bad, deny, missing, required } from '../../../common/validate.js';
import * as P from '../procedures.js';

const canView=u=>isDispatch(u)||u.role==='engineer'||isProvider(u);
const CODE=/^[A-Z0-9][A-Z0-9._-]{1,39}$/;
const RUNNING=['accepted','in_progress','escalated'];

async function replaceSteps(procedureId,list) {
  const steps=array(list,'steps'); if (steps.length>60) bad('A procedure can hold up to 60 steps');
  const parsed=steps.map(P.parseStep);
  await run('DELETE FROM procedure_steps WHERE procedure_id=?',procedureId);
  for (const [i,s] of parsed.entries()) await run('INSERT INTO procedure_steps (id,procedure_id,position,title,instruction,safety,spec,parts,measurement,requires_photo,mandatory,expected_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    id(),procedureId,i+1,s.title,s.instruction,s.safety,s.spec,JSON.stringify(s.parts),s.measurement?JSON.stringify(s.measurement):null,s.requiresPhoto?1:0,s.mandatory?1:0,s.expectedMinutes);
}
const full=async key=>{ const p=await byId('procedures',key); return P.procedureOut(p,await P.stepsOf(key)); };

export function register(r) {
  r.get('/procedures',async ({u,query})=>{
    if (!canView(u)) deny(); const type=query.get('machineType'), status=query.get('status');
    const list=(await all('SELECT p.*,(SELECT count(*) FROM procedure_steps s WHERE s.procedure_id=p.id)::int steps FROM procedures p ORDER BY p.code,p.version DESC'))
      .filter(p=>(!status||p.status===status)&&(!type||P.J(p.machine_types,[]).includes(type)));
    return list.map(p=>({...P.procedureOut(p),stepCount:p.steps}));
  });
  // Body: {code, title, machineTypes:[...], autoAttach?, steps:[...]}. A code that exists gets its next version as a new draft.
  r.post('/procedures',async ({u,body})=>{
    if (!isDispatch(u)) deny();
    const code=required(body.code,'code',40).trim().toUpperCase(); if (!CODE.test(code)) bad('code must be 2-40 letters, digits, dots, dashes or underscores');
    const last=await one('SELECT max(version)::int v FROM procedures WHERE code=?',code);
    if (await one("SELECT 1 FROM procedures WHERE code=? AND status='draft'",code)) bad(`${code} already has a draft: edit or publish it`);
    const key=id(), types=P.machineTypes(body.machineTypes??[]);
    if (body.autoAttach!=null&&typeof body.autoAttach!=='boolean') bad('autoAttach must be true or false');
    await run('INSERT INTO procedures (id,code,version,title,machine_types,auto_attach,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',key,code,(last?.v||0)+1,required(body.title,'title',160),JSON.stringify(types),body.autoAttach?1:0,'draft',u.id,now());
    await replaceSteps(key,body.steps??[]);
    await audit(u,'procedure.create','procedure',key,null,{code});
    return created(await full(key));
  });
  r.get('/procedures/by-code/:code/analytics',async ({u,params,query})=>{
    if (!isDispatch(u)) deny(); const v=query.get('version');
    if (v&&!/^\d+$/.test(v)) bad('version must be a number');
    const code=params.code.toUpperCase(); if (!await one('SELECT 1 FROM procedures WHERE code=?',code)) missing();
    return await P.analytics(code,v?Number(v):null);
  });
  r.get('/procedures/:id',async ({u,params})=>{ if (!canView(u)) deny(); if (!await byId('procedures',params.id)) missing(); return await full(params.id); });
  r.patch('/procedures/:id',async ({u,body,params})=>{
    if (!isDispatch(u)) deny(); const p=await byId('procedures',params.id); if (!p) missing();
    if (p.status!=='draft') bad('Only a draft can be edited: make a new version instead');
    const types=body.machineTypes===undefined?P.J(p.machine_types,[]):P.machineTypes(body.machineTypes);
    if (body.autoAttach!=null&&typeof body.autoAttach!=='boolean') bad('autoAttach must be true or false');
    await run('UPDATE procedures SET title=?,machine_types=?,auto_attach=? WHERE id=?',body.title===undefined?p.title:required(body.title,'title',160),JSON.stringify(types),body.autoAttach==null?p.auto_attach:body.autoAttach?1:0,p.id);
    if (body.steps!==undefined) await replaceSteps(p.id,body.steps);
    await audit(u,'procedure.update','procedure',p.id,null,{code:p.code,version:p.version});
    return await full(p.id);
  });
  r.post('/procedures/:id/publish',async ({u,params})=>{
    if (!isDispatch(u)) deny(); const p=await byId('procedures',params.id); if (!p) missing();
    if (p.status!=='draft') bad('Only a draft can be published');
    const steps=await P.stepsOf(p.id); if (!steps.length) bad('Add at least one step before publishing');
    if (!P.J(p.machine_types,[]).length) bad('Choose the machine types this procedure is for before publishing');
    const stamp=now();
    await run("UPDATE procedures SET status='retired' WHERE code=? AND status='active'",p.code);
    await run("UPDATE procedures SET status='active',published_at=? WHERE id=?",stamp,p.id);
    await audit(u,'procedure.publish','procedure',p.id,null,{code:p.code,version:p.version});
    return await full(p.id);
  });
  r.post('/procedures/:id/retire',async ({u,params})=>{
    if (!isDispatch(u)) deny(); const p=await byId('procedures',params.id); if (!p) missing();
    if (p.status!=='active') bad('Only an active procedure can be retired');
    await run("UPDATE procedures SET status='retired' WHERE id=?",p.id); await audit(u,'procedure.retire','procedure',p.id,null,{code:p.code,version:p.version});
    return await full(p.id);
  });

  // On a ticket: attach a published procedure (it must be for the machine's type), then record its steps.
  r.post('/tickets/:id/procedures',async ({u,body,params})=>{
    const t=await getTicket(u,params.id); if (!canService(u,t)) deny(); if (t.status==='completed') bad('Completed ticket cannot take a procedure');
    const p=await byId('procedures',required(body.procedureId,'procedureId',80)); if (!p||p.status!=='active') bad('Choose a published procedure');
    const type=(await byId('equipment',t.equipment_id)).machine_type; if (!P.J(p.machine_types,[]).includes(type)) bad(`This procedure is not for ${type} machines`);
    const had=await one('SELECT id FROM ticket_procedures WHERE ticket_id=? AND code=?',t.id,p.code), row=await P.attach(u,t,p);
    const out=(await P.runsOf(t.id)).find(x=>x.id===row.id);
    return had?out:created(out);
  });
  const step=async ({u,body,params})=>{
    const row=await byId('ticket_procedure_steps',params.id); if (!row) missing();
    const tp=await byId('ticket_procedures',row.ticket_procedure_id), t=await getTicket(u,tp.ticket_id); if (!canService(u,t)) deny();
    if (!RUNNING.includes(t.status)) bad(t.status==='completed'?'Completed ticket is read-only':'Accept the job before recording steps');
    return await P.recordStep(u,t,row,body);
  };
  r.patch('/procedure-steps/:id',step);
  r.post('/procedure-steps/:id',step,{offline:true});
}
