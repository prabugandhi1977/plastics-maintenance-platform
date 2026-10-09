// Breakdown tickets: raise, assign (engineer or approved provider by area and skill), accept/decline/escalate/complete,
// checklists, work logs, and customer sign-off (in the customer portal, or on site with a captured signature).
import { id, now, one, all, run } from '../../../common/db.js';
import { isCustomer, isInternal } from '../../../common/security.js';
import { audit, byId, canService, getEquipment, getTicket, isAssignee, isDispatch, ticketEvent, visibleTickets } from '../../../common/access.js';
import { created } from '../../../common/http.js';
import { storeFile } from '../../../common/files.js';
import { coverageFor, responseTarget } from './contracts.js';
import { HttpError, bad, choice, date, deny, integer, missing, required } from '../../../common/validate.js';
import { MACHINE_STATES, codes } from '../../../common/catalog.js';
import { resolveScan, scanFor, scanPolicy } from '../../../common/scan.js';

const TRANSITIONS={assigned:['accepted','declined','escalated'],accepted:['in_progress','escalated'],in_progress:['escalated','completed'],escalated:['in_progress','completed']};
const note=(body,max=2000)=>typeof body.note==='string'?body.note.trim().slice(0,max):'';
const SCAN_LABEL={qr:'QR label scanned at the machine',rfid:'RFID tag scanned at the machine'};

// Without a scan: allowed when the scan policy makes it optional; otherwise only a dispatcher or platform admin may
// proceed, and only with a reason (e.g. label damaged, customer phoned in). The reason is kept on the ticket.
async function unscanned(u,body,stage) {
  if ((await scanPolicy())[stage]!=='required') return {via:'manual'};
  const what=stage==='raise'?'raise a ticket':'close this ticket';
  if (!isDispatch(u)) bad(`Scan the equipment QR label or RFID tag to ${what}`);
  const reason=typeof body.scanOverrideReason==='string'?body.scanOverrideReason.trim().slice(0,500):'';
  if (!reason) bad(`Scan the equipment QR label or RFID tag to ${what}, or give a reason for proceeding without a scan`);
  return {via:'override',reason};
}

export async function ticketDetail(u,key) {
  const t=await getTicket(u,key), coverage=await coverageFor(t);
  return {...t,
    asset:await one('SELECT id,machine_type,make,model,serial_number,location,qr_code,rfid_tag,asset_tag,criticality,image_attachment_id FROM equipment WHERE id=?',t.equipment_id),
    plant:await one('SELECT id,name,country,service_area,timezone FROM plants WHERE id=?',t.plant_id),
    coverage,...await responseTarget(t,coverage),
    events:await all('SELECT e.*,u.name actor_name FROM ticket_events e JOIN users u ON u.id=e.actor_id WHERE e.ticket_id=? ORDER BY e.created_at',key),
    checklist:await all('SELECT * FROM checklist_entries WHERE ticket_id=? ORDER BY rowid',key),
    workLogs:await all('SELECT w.*,u.name user_name FROM work_logs w JOIN users u ON u.id=w.user_id WHERE w.ticket_id=? ORDER BY w.created_at',key),
    parts:await all('SELECT * FROM parts_requests WHERE ticket_id=?',key),
    signoff:await one('SELECT * FROM signoffs WHERE ticket_id=?',key)||null,
    attachments:await all("SELECT id,entity_type,entity_id,kind,filename,mime,size_bytes,created_at FROM attachments WHERE company_id=? AND ((entity_type='ticket' AND entity_id=?) OR (entity_type='work_log' AND entity_id IN (SELECT id FROM work_logs WHERE ticket_id=?)))",t.company_id,key,key)};
}

// Every in-house engineer and provider, with the reasons any of them cannot take this ticket, eligible and least
// loaded first. The dispatcher still chooses; assignment re-checks eligibility server-side.
export async function candidatesFor(t) {
  const plant=await byId('plants',t.plant_id), asset=await byId('equipment',t.equipment_id);
  const load=await all("SELECT assigned_user_id u,assigned_provider_id p,count(*) n FROM tickets WHERE status NOT IN ('open','completed') GROUP BY 1,2");
  const reasons=(ok,okLabel,areas,skills)=>[...(ok?[]:[okLabel]),...(JSON.parse(areas).includes(plant.service_area)?[]:[`does not cover ${plant.service_area}`]),...(JSON.parse(skills).includes(asset.machine_type)?[]:[`no ${asset.machine_type} skill`])];
  return [
    ...(await all("SELECT id,name,active,service_areas,skills FROM users WHERE role='engineer'")).map(e=>({type:'engineer',id:e.id,name:e.name,openWork:load.filter(x=>x.u===e.id).reduce((n,x)=>n+x.n,0),reasons:reasons(e.active,'inactive',e.service_areas,e.skills)})),
    ...(await all('SELECT id,name,approved,service_areas,skills FROM providers')).map(p=>({type:'provider',id:p.id,name:p.name,openWork:load.filter(x=>x.p===p.id).reduce((n,x)=>n+x.n,0),reasons:reasons(p.approved,'not approved',p.service_areas,p.skills)}))
  ].map(c=>({...c,eligible:!c.reasons.length})).sort((a,b)=>b.eligible-a.eligible||a.openWork-b.openWork||a.name.localeCompare(b.name));
}

async function applyChecklistTemplate(u,t) {
  if (await one('SELECT 1 FROM checklist_entries WHERE ticket_id=?',t.id)) return;
  const type=(await one('SELECT machine_type FROM equipment WHERE id=?',t.equipment_id)).machine_type, stamp=now();
  for (const x of await all('SELECT item FROM checklist_templates WHERE machine_type=? ORDER BY position',type)) await run('INSERT INTO checklist_entries (id,ticket_id,item,done,note,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)',id(),t.id,x.item,0,'',u.id,stamp);
}

async function serviceAction(u,t,body) {
  if (!canService(u,t)) deny();
  const status=choice(body.status,'status',['accepted','declined','in_progress','escalated','completed']);
  if (!(TRANSITIONS[t.status]||[]).includes(status)) bad(`Cannot move ${t.status} to ${status}`);
  if (['declined','escalated'].includes(status) && !note(body)) bad(`A note is required to ${status==='declined'?'decline':'escalate'}`);
  const stamp=now();
  // Decline hands the ticket back to dispatch; the decliner loses access, so the reply is a receipt, not the ticket.
  if (status==='declined') {
    if (!isAssignee(u,t)) bad('Only the assigned engineer or provider can decline');
    await run("UPDATE tickets SET status='open',assigned_user_id=NULL,assigned_provider_id=NULL WHERE id=?",t.id);
    await ticketEvent(t.id,u,'declined',note(body),stamp); await audit(u,'ticket.decline','ticket',t.id,t.company_id);
    return {id:t.id,status:'open',declined:true};
  }
  // Close-out (ISO 14224): what failed, why, and what was done are mandatory to complete a breakdown.
  let closeLink=null, closeOut={failure_mode:t.failure_mode,root_cause:t.root_cause,action_taken:t.action_taken}, downtime=body.downtimeMinutes==null||body.downtimeMinutes===''?t.downtime_minutes:integer(Number(body.downtimeMinutes),'downtimeMinutes',0,525600);
  if (status==='completed') {
    if (!await one('SELECT 1 FROM work_logs WHERE ticket_id=?',t.id)) bad('A work log is required before completion');
    const gaps=[...(!body.failureMode?['failure mode']:[]),...(!body.rootCause?['root cause']:[]),...(!body.actionTaken?['action taken']:[])];
    if (gaps.length) bad(`To complete a breakdown, record the ${gaps.join(', ')}`);
    closeOut={failure_mode:choice(body.failureMode,'failureMode',await codes('failure_modes')),root_cause:choice(body.rootCause,'rootCause',await codes('root_causes')),action_taken:choice(body.actionTaken,'actionTaken',await codes('actions'))};
    // Closing is tied to the machine: scan its QR label or RFID tag, unless the scan policy or a dispatcher override allows otherwise.
    closeLink=body.scanCode?{via:await scanFor(body.scanCode,await byId('equipment',t.equipment_id))}:await unscanned(u,body,'close');
    // A stopped machine with no downtime entered: downtime runs from when the failure started until now.
    if (body.downtimeMinutes==null&&!t.downtime_minutes&&t.machine_state==='stopped'&&t.occurred_at) downtime=Math.max(0,Math.round((Date.parse(stamp)-Date.parse(t.occurred_at))/60000));
  }
  await run("UPDATE tickets SET status=?,first_response_at=COALESCE(first_response_at,?),completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END,downtime_minutes=?,failure_mode=?,root_cause=?,action_taken=? WHERE id=?",status,status==='accepted'?stamp:null,status,stamp,downtime,closeOut.failure_mode,closeOut.root_cause,closeOut.action_taken,t.id);
  if (closeLink) {
    const reason=closeLink.reason?[t.scan_override_reason,`Close: ${closeLink.reason}`].filter(Boolean).join('\n'):t.scan_override_reason;
    await run('UPDATE tickets SET closed_via=?,closed_scan_at=?,scan_override_reason=? WHERE id=?',closeLink.via,['qr','rfid'].includes(closeLink.via)?stamp:null,reason,t.id);
    await ticketEvent(t.id,u,'scan',SCAN_LABEL[closeLink.via]?`Closed at the machine: ${SCAN_LABEL[closeLink.via]}`:closeLink.via==='override'?`Closed without a scan: ${closeLink.reason}`:'Closed without a scan (scan optional)',stamp);
  }
  if (status==='accepted') await applyChecklistTemplate(u,t);
  await ticketEvent(t.id,u,status,note(body),stamp); await audit(u,'ticket.status','ticket',t.id,t.company_id,{status});
  return await ticketDetail(u,t.id);
}

async function updateChecklist(u,key,body) {
  const entry=await byId('checklist_entries',key); if (!entry) missing();
  const t=await getTicket(u,entry.ticket_id); if (!canService(u,t)) deny();
  await run('UPDATE checklist_entries SET done=?,note=?,updated_by=?,updated_at=? WHERE id=?',body.done===true?1:0,String(body.note??entry.note).slice(0,1000),u.id,now(),entry.id);
  await audit(u,'checklist.update','ticket',t.id,t.company_id,{itemId:entry.id}); return await byId('checklist_entries',entry.id);
}

export function register(r) {
  r.get('/tickets',async ({u})=>await visibleTickets(u));
  r.post('/tickets',async ({u,body})=>{
    if (!isCustomer(u)&&!isInternal(u)) deny();
    // The machine can be chosen, or identified by scanning its QR label or RFID tag (which then must match the choice).
    if (!body.equipmentId&&!body.scanCode) bad('Choose the machine, or scan its QR label or RFID tag');
    const scanned=body.scanCode?await resolveScan(body.scanCode):undefined;
    if (body.scanCode&&!scanned) bad('Scanned code is not a known equipment QR label or RFID tag');
    const e=await getEquipment(u,body.equipmentId||scanned?.equipment.id);
    if (e.status==='decommissioned') bad('This asset is decommissioned; reactivate it before raising a breakdown');
    if (scanned&&scanned.equipment.id!==e.id) bad(`Scanned code belongs to a different machine; scan the label or tag on ${e.asset_tag||'the selected machine'}`);
    const alert=body.alertId?await one('SELECT * FROM alerts WHERE id=?',body.alertId):undefined;
    if (body.alertId&&(!alert||alert.company_id!==e.company_id)) bad('Unknown alert for this company');
    const link=scanned?{via:scanned.method}:alert?{via:'alert'}:await unscanned(u,body,'raise');
    // Breakdown report (ISO 14224): category, machine state, safety and when the failure started are mandatory.
    if (typeof body.safetyIssue!=='boolean') bad('safetyIssue must be answered (true or false)');
    const zone=(await one('SELECT timezone FROM plants WHERE id=?',e.plant_id)).timezone, stamp=now(), occurredAt=date(body.occurredAt,'occurredAt',zone);
    if (occurredAt>new Date(Date.now()+5*60000).toISOString()) bad('Failure start cannot be in the future');
    if (occurredAt<new Date(Date.now()-90*86400000).toISOString()) bad('Failure start must be within the last 90 days');
    let priority=choice(body.priority,'priority',['low','medium','high','critical']);
    // A safety issue is always handled as critical.
    if (body.safetyIssue) priority='critical';
    const key=id(); await run('INSERT INTO tickets (id,company_id,plant_id,equipment_id,title,priority,symptoms,error_codes,production_impact,status,created_by,created_at,downtime_minutes,failure_category,machine_state,safety_issue,occurred_at,raised_via,raised_scan_at,scan_override_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      key,e.company_id,e.plant_id,e.id,required(body.title,'title',160),priority,required(body.symptoms,'symptoms',3000),String(body.errorCodes||'').slice(0,500),required(body.productionImpact,'productionImpact',1000),'open',u.id,stamp,0,
      choice(body.failureCategory,'failureCategory',await codes('failure_categories')),choice(body.machineState,'machineState',MACHINE_STATES),body.safetyIssue?1:0,occurredAt,
      link.via,scanned?stamp:null,link.reason?`Raise: ${link.reason}`:null);
    if (link.via!=='alert') await ticketEvent(key,u,'scan',SCAN_LABEL[link.via]?`Raised at the machine: ${SCAN_LABEL[link.via]}`:link.via==='override'?`Raised without a scan: ${link.reason}`:'Raised without a scan (scan optional)',stamp);
    if (body.safetyIssue) await ticketEvent(key,u,'safety','Safety issue reported: priority set to critical',stamp);
    if (alert) { const a=alert; await run("UPDATE alerts SET ticket_id=?,status=CASE WHEN status='open' THEN 'acknowledged' ELSE status END,acknowledged_by=COALESCE(acknowledged_by,?),acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=?",key,u.id,stamp,a.id); await ticketEvent(key,u,'alert',`Raised from alert: ${a.title}`,stamp); }
    await audit(u,'ticket.create','ticket',key,e.company_id,{priority,safetyIssue:body.safetyIssue,raisedVia:link.via}); return created(await ticketDetail(u,key));
  },{offline:true});
  r.get('/tickets/:id',async ({u,params})=>await ticketDetail(u,params.id));
  r.get('/tickets/:id/candidates',async ({u,params})=>{ if (!isDispatch(u)) deny(); return await candidatesFor(await getTicket(u,params.id)); });
  r.post('/tickets/:id/assign',async ({u,body,params})=>{
    if (!isDispatch(u)) deny();
    const t=await getTicket(u,params.id); if (t.status==='completed') bad('Completed ticket cannot be assigned');
    const type=choice(body.assigneeType,'assigneeType',['engineer','provider']), target=(await candidatesFor(t)).find(c=>c.type===type&&c.id===body.assigneeId);
    if (!target) bad(`Unknown ${type}`);
    if (!target.eligible) bad(`${type==='engineer'?'Engineer':'Provider'} is not eligible: ${target.reasons.join(', ')}`);
    await run('UPDATE tickets SET assigned_user_id=?,assigned_provider_id=?,status=? WHERE id=?',type==='engineer'?target.id:null,type==='provider'?target.id:null,'assigned',t.id);
    await ticketEvent(t.id,u,'assigned',`Assigned to ${target.name}`); await audit(u,'ticket.assign','ticket',t.id,t.company_id,{assigneeType:type,assigneeId:target.id});
    return await ticketDetail(u,t.id);
  });
  r.post('/tickets/:id/status',async ({u,body,params})=>await serviceAction(u,await getTicket(u,params.id),body),{offline:true});
  r.post('/tickets/:id/checklist',async ({u,body,params})=>{
    const t=await getTicket(u,params.id); if (!canService(u,t)) deny();
    const key=id(); await run('INSERT INTO checklist_entries (id,ticket_id,item,done,note,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)',key,t.id,required(body.item,'item',300),body.done===true?1:0,String(body.note||'').slice(0,1000),u.id,now());
    await audit(u,'checklist.add','ticket',t.id,t.company_id,{itemId:key}); return created(await byId('checklist_entries',key));
  },{offline:true});
  r.patch('/checklist/:id',async ({u,body,params})=>await updateChecklist(u,params.id,body));
  r.post('/checklist/:id',async ({u,body,params})=>await updateChecklist(u,params.id,body),{offline:true});
  r.post('/tickets/:id/work-logs',async ({u,body,params})=>{
    const t=await getTicket(u,params.id); if (!canService(u,t)) deny();
    const key=id(); await run('INSERT INTO work_logs (id,ticket_id,user_id,description,minutes,parts_used,created_at) VALUES (?,?,?,?,?,?,?)',key,t.id,u.id,required(body.description,'description',3000),integer(body.minutes,'minutes',1,10080),String(body.partsUsed||'').slice(0,1000),now());
    await audit(u,'work_log.create','ticket',t.id,t.company_id,{workLogId:key}); return created(await byId('work_logs',key));
  },{offline:true});
  r.post('/tickets/:id/signoff',async ({u,body,params})=>{
    const t=await getTicket(u,params.id), signer=required(body.signerName,'signerName',160);
    if (!isCustomer(u)&&!canService(u,t)) deny();
    if (t.status!=='completed') bad('Ticket must be completed before sign-off');
    if (await one('SELECT 1 FROM signoffs WHERE ticket_id=?',t.id)) throw new HttpError(409,'Ticket is already signed off');
    const stamp=now();
    if (isCustomer(u)) await run("INSERT INTO signoffs (ticket_id,customer_user_id,signer_name,signed_at,method) VALUES (?,?,?,?,'portal')",t.id,u.id,signer,stamp);
    else {
      const file=await storeFile(u,{companyId:t.company_id,entityType:'ticket',entityId:t.id,kind:'signature',filename:`signature-${t.id}.png`,mime:'image/png',base64:body.signatureBase64});
      await run("INSERT INTO signoffs (ticket_id,signer_name,signed_at,method,signature_attachment_id,collected_by) VALUES (?,?,?,'on_site',?,?)",t.id,signer,stamp,file.id,u.id);
    }
    await ticketEvent(t.id,u,'signed_off',`Signed by ${signer}`,stamp); await audit(u,'ticket.signoff','ticket',t.id,t.company_id);
    return created(await one('SELECT * FROM signoffs WHERE ticket_id=?',t.id));
  },{offline:true});
}
