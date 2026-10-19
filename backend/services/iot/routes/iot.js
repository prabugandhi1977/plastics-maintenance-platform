// Machine data: server-to-server ingest, device mappings, telemetry reads, and sync administration.
import { timingSafeEqual } from 'node:crypto';
import { id, now, one, all, run, transaction, mapSeq } from '../../../common/db.js';
import { isPlatform } from '../../../common/security.js';
import { audit, byId, getAssetTelemetry, isDispatch } from '../../../common/access.js';
import { created, reply } from '../../../common/http.js';
import { ingestRecord, telemetry, readingHistory, alarmHistory } from '../ingest.js';
import { runSync } from '../sync.js';
import { createAdapter } from '../adapters/index.js';
import { HttpError, bad, choice, deny, instant, integer, missing, required } from '../../../common/validate.js';

const canManageDevices=(u,companyId)=>isDispatch(u)||(u.role==='customer_admin'&&u.company_id===companyId);
function requireIntegrationKey(req) {
  const expected=process.env.MOULDCARE_INTEGRATION_KEY, actual=req.headers['x-integration-key'];
  if (!expected || typeof actual!=='string' || Buffer.byteLength(expected)!==Buffer.byteLength(actual) || !timingSafeEqual(Buffer.from(expected),Buffer.from(actual))) throw new HttpError(401,'Integration key required');
}

export function register(r) {
  r.post('/integrations/iot/records',async ({req,body})=>{
    requireIntegrationKey(req);
    const records=Array.isArray(body.records)?body.records:bad('records must be an array'); if (!records.length||records.length>500) bad('Send 1-500 records per request');
    const results=await transaction(async ()=>(await mapSeq(records, async (rec,index)=>({index,...await ingestRecord(rec,'push')})))), count=s=>results.filter(x=>x.status===s).length;
    return {accepted:await count('accepted'),duplicates:await count('duplicate'),rejected:await count('rejected'),results};
  },{public:true});
  r.post('/integrations/mock/readings',async ({req,body})=>{
    requireIntegrationKey(req);
    const result=await transaction(async ()=>await ingestRecord(body,'push')); if (result.status==='rejected') bad(result.errors.join('; '));
    return reply(result.status==='accepted'?201:200,result);
  },{public:true});

  r.get('/equipment/:id/readings',async ({u,params,query})=>{
    const e=await getAssetTelemetry(u,params.id), before=query.get('before')?instant(query.get('before'),'before'):null, limit=query.get('limit')?integer(Number(query.get('limit')),'limit',1,1000):100;
    return {equipmentId:e.id,...await telemetry(e.id),history:await readingHistory(e.id,{before,limit})};
  });
  r.get('/equipment/:id/alarms',async ({u,params,query})=>{ const e=await getAssetTelemetry(u,params.id); return await alarmHistory(e.id,choice(query.get('state')||'all','state',['active','all'])); });

  r.get('/devices',async ({u})=>{ const rows='SELECT d.*,e.make,e.model FROM device_mappings d JOIN equipment e ON e.id=d.equipment_id'; return isDispatch(u)?await all(rows+' ORDER BY d.created_at'):u.role==='customer_admin'?await all(rows+' WHERE d.company_id=? ORDER BY d.created_at',u.company_id):[]; });
  r.post('/devices',async ({u,body})=>{
    const e=await byId('equipment',body.equipmentId); if (!e) bad('Unknown equipment'); if (!canManageDevices(u,e.company_id)) deny();
    const deviceId=required(body.externalDeviceId,'externalDeviceId',100), stale=body.staleAfterMinutes==null?30:integer(body.staleAfterMinutes,'staleAfterMinutes',1,10080);
    if (await one('SELECT 1 FROM device_mappings WHERE external_device_id=?',deviceId)) throw new HttpError(409,'Device is already mapped');
    const key=id(); await run('INSERT INTO device_mappings (id,external_device_id,company_id,equipment_id,created_at,active,stale_after_minutes) VALUES (?,?,?,?,?,?,?)',key,deviceId,e.company_id,e.id,now(),1,stale);
    await audit(u,'device.map','device_mapping',key,e.company_id,{externalDeviceId:deviceId,equipmentId:e.id}); return created(await byId('device_mappings',key));
  });
  r.patch('/devices/:id',async ({u,body,params})=>{
    const d=await byId('device_mappings',params.id); if (!d) missing(); if (!canManageDevices(u,d.company_id)) deny();
    let equipmentId=d.equipment_id; if (body.equipmentId!=null) { const e=await byId('equipment',body.equipmentId); if (!e||e.company_id!==d.company_id) bad('A device can only be remapped within the same company'); equipmentId=e.id; }
    const active=body.active==null?d.active:body.active===true?1:body.active===false?0:bad('active must be true or false'), stale=body.staleAfterMinutes==null?d.stale_after_minutes:integer(body.staleAfterMinutes,'staleAfterMinutes',1,10080);
    await run('UPDATE device_mappings SET equipment_id=?,active=?,stale_after_minutes=? WHERE id=?',equipmentId,active,stale,d.id);
    await audit(u,'device.update','device_mapping',d.id,d.company_id,{equipmentId,active:!!active,staleAfterMinutes:stale}); return await byId('device_mappings',d.id);
  });

  r.get('/integrations/status',async ({u})=>{
    if (!isPlatform(u)) deny();
    return {adapter:process.env.IOT_SYNC_ADAPTER||'mock',cursors:await all('SELECT * FROM integration_cursors'),runs:await all('SELECT * FROM integration_runs ORDER BY started_at DESC LIMIT 20'),rejections:(await all('SELECT id,source,external_device_id,reasons,received_at FROM iot_rejections ORDER BY received_at DESC LIMIT 50')).map(x=>({...x,reasons:JSON.parse(x.reasons)}))};
  });
  r.post('/integrations/sync',async({u})=>{
    if (!isPlatform(u)) deny();
    const result=await runSync(createAdapter(process.env.IOT_SYNC_ADAPTER||'mock')); await audit(u,'integration.sync','integration_run',result.id,null,{status:result.status}); return result;
  },{external:true});
}
