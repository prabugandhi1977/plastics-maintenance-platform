// Ticket intake for trusted systems (MouldCare Monitor first), and the company integration keys they use.
// A company key is sent in X-Integration-Key, like the server-wide key for machine data, but it reaches only its own
// company's machines. Only its hash is stored; the key itself is shown once, when it is created or replaced.
import { createHash, randomBytes } from 'node:crypto';
import { id, now, one, all, run } from '../../../common/db.js';
import { canManageCompany, isPlatform } from '../../../common/security.js';
import { audit, byId, ticketEvent } from '../../../common/access.js';
import { created } from '../../../common/http.js';
import { HttpError, array, bad, choice, date, deny, missing, required } from '../../../common/validate.js';
import { MACHINE_STATES, codes } from '../../../common/catalog.js';

const SYSTEM={id:'u-system'};
// Senders and how their tickets show as raised (tickets.raised_via).
const SOURCES={monitor:{via:'monitor',label:'MouldCare Monitor'}};
const hashKey=key=>createHash('sha256').update(String(key)).digest('hex');
export const newKey=()=>{ const key=`mck_${randomBytes(24).toString('base64url')}`; return {key,hash:hashKey(key),hint:`${key.slice(0,8)}…${key.slice(-4)}`}; };
export const KEY_SCOPES=['tickets','energy'];
const keyOut=k=>({id:k.id,companyId:k.company_id,name:k.name,keyHint:k.key_hint,scopes:String(k.scopes||'tickets').split(','),active:!!k.active,createdAt:k.created_at,lastUsedAt:k.last_used_at});
const ticketOut=(t,e,isNew)=>({created:isNew,ticket:{id:t.id,status:t.status,priority:t.priority,title:t.title,assetTag:e.asset_tag,equipmentId:t.equipment_id,plantId:t.plant_id,raisedVia:t.raised_via,source:t.external_source,externalId:t.external_id,createdAt:t.created_at}});

// A key carries scopes (tickets, energy): a key made for machine data cannot raise tickets, and the other way round.
export async function companyKey(req,scope='tickets') {
  const actual=req.headers['x-integration-key'];
  const k=typeof actual==='string'&&/^mck_[A-Za-z0-9_-]{20,}$/.test(actual)?await one('SELECT * FROM integration_keys WHERE key_hash=? AND active=1',hashKey(actual)):null;
  if (!k) throw new HttpError(401,'A valid company integration key is required in X-Integration-Key');
  if (!String(k.scopes||'tickets').split(',').includes(scope)) throw new HttpError(403,`This integration key is not allowed for ${scope}. Create a key with the ${scope} scope.`);
  return k;
}
const optText=(v,name,max)=>v==null||v===''?'':typeof v==='string'&&v.length<=max?v.trim():bad(`${name} must be text of at most ${max} characters`);

export function register(r) {
  // Body: {source:'monitor', externalId, assetTag, title, symptoms, failureCategory, priority, machineState, safetyIssue,
  // occurredAt, productionImpact, errorCodes?, suggestedActions?:[text], assigneeName?}. Sending the same source and
  // externalId again returns the ticket already raised (200) instead of a new one (201).
  r.post('/integrations/tickets',async ({req,body})=>{
    const k=await companyKey(req,'tickets'), stamp=now();
    await run('UPDATE integration_keys SET last_used_at=? WHERE id=?',stamp,k.id);
    const source=choice(body.source,'source',Object.keys(SOURCES)), externalId=required(body.externalId,'externalId',120);
    const existing=await one('SELECT * FROM tickets WHERE company_id=? AND external_source=? AND external_id=?',k.company_id,source,externalId);
    if (existing) return ticketOut(existing,await byId('equipment',existing.equipment_id),false);
    // Same rules as a ticket raised in the app (POST /tickets), with the machine found by asset tag in the key's company.
    const tag=required(body.assetTag,'assetTag',60).toUpperCase();
    const e=await one('SELECT * FROM equipment WHERE company_id=? AND upper(asset_tag)=?',k.company_id,tag);
    if (!e) throw new HttpError(404,`No machine with asset tag ${tag} in this company. Check the tag matches the asset tag in MouldCare.`);
    if (e.status==='decommissioned') bad(`${tag} is decommissioned; reactivate it before raising a breakdown`);
    if (typeof body.safetyIssue!=='boolean') bad('safetyIssue must be answered (true or false)');
    const occurredAt=date(body.occurredAt,'occurredAt',(await one('SELECT timezone FROM plants WHERE id=?',e.plant_id)).timezone);
    if (occurredAt>new Date(Date.now()+5*60000).toISOString()) bad('Failure start cannot be in the future');
    if (occurredAt<new Date(Date.now()-90*86400000).toISOString()) bad('Failure start must be within the last 90 days');
    // A safety issue is always handled as critical.
    const priority=body.safetyIssue?'critical':choice(body.priority,'priority',['low','medium','high','critical']);
    const title=required(body.title,'title',160), symptoms=required(body.symptoms,'symptoms',3000), impact=required(body.productionImpact,'productionImpact',1000);
    const category=choice(body.failureCategory,'failureCategory',await codes('failure_categories')), state=choice(body.machineState,'machineState',MACHINE_STATES);
    const actions=body.suggestedActions==null?[]:array(body.suggestedActions,'suggestedActions');
    if (actions.length>20||actions.some(a=>typeof a!=='string'||!a.trim()||a.length>500)) bad('suggestedActions must be up to 20 texts of 1-500 characters');
    const assignee=optText(body.assigneeName,'assigneeName',160);
    // MouldCare has no field for suggested actions: they follow the symptoms, as far as the symptoms limit allows.
    const fullSymptoms=actions.length?`${symptoms}\n\nSuggested actions:\n${actions.map((a,i)=>`${i+1}. ${a.trim()}`).join('\n')}`.slice(0,3000):symptoms;
    const key=id(), via=SOURCES[source];
    await run('INSERT INTO tickets (id,company_id,plant_id,equipment_id,title,priority,symptoms,error_codes,production_impact,status,created_by,created_at,downtime_minutes,failure_category,machine_state,safety_issue,occurred_at,raised_via,external_source,external_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      key,e.company_id,e.plant_id,e.id,title,priority,fullSymptoms,optText(body.errorCodes,'errorCodes',500),impact,'open',SYSTEM.id,stamp,0,category,state,body.safetyIssue?1:0,occurredAt,via.via,source,externalId);
    // The sender's assignee is a person in that system, not a MouldCare user: it is noted for dispatch, who assigns here.
    await ticketEvent(key,SYSTEM,'external',`Raised by ${via.label} (reference ${externalId}, key "${k.name}")${assignee?`. Assigned there to ${assignee}.`:''}`,stamp);
    if (body.safetyIssue) await ticketEvent(key,SYSTEM,'safety','Safety issue reported: priority set to critical',stamp);
    await audit(SYSTEM,'ticket.create_external','ticket',key,e.company_id,{source,externalId,integrationKeyId:k.id,priority,assigneeName:assignee||null});
    return created(ticketOut(await byId('tickets',key),e,true));
  },{public:true});

  // Company integration keys: the platform admin for any company, a customer admin for their own.
  r.get('/integration-keys',async ({u})=>{
    if (isPlatform(u)) return (await all('SELECT * FROM integration_keys ORDER BY created_at DESC')).map(keyOut);
    if (u.role!=='customer_admin') deny();
    return (await all('SELECT * FROM integration_keys WHERE company_id=? ORDER BY created_at DESC',u.company_id)).map(keyOut);
  });
  r.post('/integration-keys',async ({u,body})=>{
    const companyId=isPlatform(u)?required(body.companyId,'companyId',80):body.companyId??u.company_id;
    if (!canManageCompany(u,companyId)) deny(); if (!await byId('companies',companyId)) bad('Unknown company');
    const k=newKey(), key=id(), scopes=body.scopes==null?['tickets']:[...new Set(array(body.scopes,'scopes'))];
    if (!scopes.length||scopes.some(x=>!KEY_SCOPES.includes(x))) bad(`scopes must be a non-empty list of: ${KEY_SCOPES.join(', ')}`);
    await run('INSERT INTO integration_keys (id,company_id,name,key_hash,key_hint,scopes,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',key,companyId,required(body.name,'name',80),k.hash,k.hint,scopes.join(','),u.id,now());
    await audit(u,'integration_key.create','integration_key',key,companyId);
    // The key is shown once; only its hash is stored.
    return created({...keyOut(await byId('integration_keys',key)),key:k.key});
  });
  r.patch('/integration-keys/:id',async ({u,body,params})=>{
    const k=await byId('integration_keys',params.id); if (!k) missing(); if (!canManageCompany(u,k.company_id)) deny();
    const active=body.active==null?k.active:body.active===true?1:body.active===false?0:bad('active must be true or false');
    await run('UPDATE integration_keys SET name=?,active=? WHERE id=?',body.name==null?k.name:required(body.name,'name',80),active,k.id);
    await audit(u,'integration_key.update','integration_key',k.id,k.company_id,{active:!!active}); return keyOut(await byId('integration_keys',k.id));
  });
  // A new key replaces the old one at once (e.g. after it leaked).
  r.post('/integration-keys/:id/key',async ({u,params})=>{
    const k=await byId('integration_keys',params.id); if (!k) missing(); if (!canManageCompany(u,k.company_id)) deny();
    const n=newKey(); await run('UPDATE integration_keys SET key_hash=?,key_hint=? WHERE id=?',n.hash,n.hint,k.id);
    await audit(u,'integration_key.rotate','integration_key',k.id,k.company_id); return {...keyOut(await byId('integration_keys',k.id)),key:n.key};
  });
}
