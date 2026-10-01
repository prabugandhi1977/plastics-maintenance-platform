// Asset register: equipment records, QR lookup, manuals/photos, and attachment download.
import { randomBytes } from 'node:crypto';
import { id, now, one, all, run } from '../db.js';
import { canCompany, canManageCompany, isInternal } from '../security.js';
import { audit, byId, getEquipment, getTicket, isDispatch, scope, visibleTickets } from '../access.js';
import { created } from '../http.js';
import { storeFile, readStoredFile, downloadHeaders } from '../files.js';
import { telemetry } from '../iot/ingest.js';
import { bad, choice, deny, missing, required } from '../validate.js';
import { MACHINE_TYPES } from './org.js';

const companyOfAttachmentTarget=(u,type,entityId)=>{
  if (type==='equipment') return getEquipment(u,entityId).company_id;
  if (type==='ticket') return getTicket(u,entityId).company_id;
  const log=byId('work_logs',entityId); if (!log) missing(); return getTicket(u,log.ticket_id).company_id;
};

export function register(r) {
  r.get('/equipment',({u})=>scope(u,'equipment'));
  r.get('/equipment/lookup',({u,query})=>{
    const qr=query.get('qr'); if (!qr) bad('qr is required');
    const e=one('SELECT * FROM equipment WHERE qr_code=?',qr); if (!e) missing();
    const assigned=visibleTickets(u).filter(t=>t.equipment_id===e.id); if (!canCompany(u,e.company_id)&&!assigned.length) deny();
    return {id:e.id,qrCode:e.qr_code,machineType:e.machine_type,make:e.make,model:e.model,serialNumber:e.serial_number,location:e.location,ticketIds:assigned.map(t=>t.id)};
  });
  r.post('/equipment',({u,body})=>{
    const plant=byId('plants',body.plantId); if (!plant) bad('Unknown plant'); if (!canManageCompany(u,plant.company_id)) deny();
    const key=id(); run('INSERT INTO equipment (id,company_id,plant_id,machine_type,make,model,serial_number,location,qr_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',key,plant.company_id,plant.id,choice(body.machineType,'machineType',MACHINE_TYPES),required(body.make,'make',100),required(body.model,'model',100),required(body.serialNumber,'serialNumber',100),required(body.location,'location',160),`MC:${randomBytes(6).toString('hex')}`,now());
    audit(u,'equipment.create','equipment',key,plant.company_id); return created(byId('equipment',key));
  });
  r.get('/equipment/:id',({u,params})=>{
    const e=getEquipment(u,params.id), plant=byId('plants',e.plant_id);
    return {...e,plant:{id:plant.id,name:plant.name,timezone:plant.timezone},attachments:all("SELECT id,kind,filename,mime,size_bytes,created_at FROM attachments WHERE entity_type='equipment' AND entity_id=?",e.id),telemetry:telemetry(e.id),
      tickets:all('SELECT id,title,status,priority,created_at FROM tickets WHERE equipment_id=? ORDER BY created_at DESC LIMIT 20',e.id)};
  });
  // QR code and company never change; moving an asset is allowed only between plants of the same company.
  r.patch('/equipment/:id',({u,body,params})=>{
    const e=getEquipment(u,params.id); if (!canManageCompany(u,e.company_id)&&!isDispatch(u)) deny();
    let plantId=e.plant_id; if (body.plantId!=null) { const p=byId('plants',body.plantId); if (!p||p.company_id!==e.company_id) bad('Equipment can only move between plants of the same company'); plantId=p.id; }
    const value=(key,column,max)=>body[key]==null?e[column]:required(body[key],key,max);
    run('UPDATE equipment SET plant_id=?,make=?,model=?,serial_number=?,location=? WHERE id=?',plantId,value('make','make',100),value('model','model',100),value('serialNumber','serial_number',100),value('location','location',160),e.id);
    audit(u,'equipment.update','equipment',e.id,e.company_id); return byId('equipment',e.id);
  });

  r.post('/attachments',({u,body})=>{
    const type=choice(body.entityType,'entityType',['equipment','ticket','work_log']), companyId=companyOfAttachmentTarget(u,type,body.entityId);
    const kind=choice(body.kind,'kind',['manual','photo','evidence']);
    if (type==='equipment' && !canManageCompany(u,companyId) && !isInternal(u)) deny();
    if (type!=='equipment' && kind==='manual') bad('Manuals attach to equipment');
    return created(storeFile(u,{companyId,entityType:type,entityId:body.entityId,kind,filename:body.filename,mime:body.mime,base64:body.base64}));
  },{offline:true});
  r.get('/attachments/:id',({u,params,res})=>{
    const a=byId('attachments',params.id); if (!a) missing();
    companyOfAttachmentTarget(u,a.entity_type,a.entity_id);
    res.writeHead(200,downloadHeaders(a)); res.end(readStoredFile(a));
  });
}
