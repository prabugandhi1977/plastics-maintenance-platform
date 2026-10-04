// Asset register: equipment master data with type-specific parameter sets, QR lookup, manuals/photos, and downloads.
import { randomBytes } from 'node:crypto';
import { id, now, one, all, run } from '../../../common/db.js';
import { canCompany, canManageCompany, isInternal } from '../../../common/security.js';
import { audit, byId, getEquipment, getTicket, isDispatch, scope, visibleTickets } from '../../../common/access.js';
import { created } from '../../../common/http.js';
import { storeFile, readStoredFile, downloadHeaders } from '../../../common/files.js';
import { telemetry } from '../../iot/ingest.js';
import { bad, choice, deny, integer, missing, required, optionalDate } from '../../../common/validate.js';
import { MACHINE_TYPES, CRITICALITY, EQUIPMENT_STATUS, validateSpecs, missingEquipmentData } from '../../../common/catalog.js';
import { qrLabel, resolveScan, rfidTag } from '../../../common/scan.js';

const companyOfAttachmentTarget=(u,type,entityId)=>{
  if (type==='equipment') return getEquipment(u,entityId).company_id;
  if (type==='ticket') return getTicket(u,entityId).company_id;
  const log=byId('work_logs',entityId); if (!log) missing(); return getTicket(u,log.ticket_id).company_id;
};
const yearBuilt=v=>integer(typeof v==='string'?Number(v):v,'yearBuilt',1950,new Date().getUTCFullYear()+1);
const assetTag=v=>{ const tag=required(v,'assetTag',40).toUpperCase(); if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(tag)) bad('Asset tag may contain letters, digits, dot, dash, slash or underscore'); return tag; };
// An auxiliary unit can name the machine it serves; that machine must belong to the same company.
const sameCompanyAsset=companyId=>key=>{ const e=byId('equipment',key); return e&&e.company_id===companyId?e:undefined; };
// An RFID tag UID is unique across the platform, because a scan must resolve to exactly one machine.
// A QR code must resolve to exactly one machine too; labels a plant already uses can be registered instead of ours.
const uniqueQr=(code,selfId)=>{ if (one('SELECT 1 FROM equipment WHERE qr_code=? AND id<>?',code,selfId??'')) bad('This QR code is already on another machine'); return code; };
const uniqueRfid=(tag,selfId)=>{ if (tag&&one('SELECT 1 FROM equipment WHERE rfid_tag=? AND id<>?',tag,selfId??'')) bad('This RFID tag is already fixed to another machine'); return tag; };
const present=e=>({...e,specs:JSON.parse(e.specs||'{}'),missing:missingEquipmentData(e)});

export function register(r) {
  r.get('/equipment',({u})=>scope(u,'equipment').map(present));
  // Resolves a scan (QR label payload or RFID tag UID; ?qr= is kept for older clients) to the machine and its tickets.
  r.get('/equipment/lookup',({u,query})=>{
    const code=query.get('code')||query.get('qr'); if (!code) bad('code is required');
    const hit=resolveScan(code); if (!hit) missing(); const e=hit.equipment;
    const assigned=visibleTickets(u).filter(t=>t.equipment_id===e.id); if (!canCompany(u,e.company_id)&&!assigned.length) deny();
    return {id:e.id,scannedVia:hit.method,qrCode:e.qr_code,rfidTag:e.rfid_tag,assetTag:e.asset_tag,machineType:e.machine_type,make:e.make,model:e.model,serialNumber:e.serial_number,location:e.location,status:e.status,plantId:e.plant_id,
      ticketIds:assigned.map(t=>t.id),openTicketIds:assigned.filter(t=>t.status!=='completed').map(t=>t.id)};
  });
  r.post('/equipment',({u,body})=>{
    const plant=byId('plants',body.plantId); if (!plant) bad('Unknown plant'); if (!canManageCompany(u,plant.company_id)) deny();
    const type=choice(body.machineType,'machineType',MACHINE_TYPES), specs=validateSpecs(type,body.specs??{},sameCompanyAsset(plant.company_id)), tag=assetTag(body.assetTag);
    if (one('SELECT 1 FROM equipment WHERE company_id=? AND asset_tag=?',plant.company_id,tag)) bad(`Asset tag ${tag} is already used in this company`);
    const rfid=uniqueRfid(rfidTag(body.rfidTag)), qr=body.qrCode?uniqueQr(qrLabel(body.qrCode)):`MC:${randomBytes(6).toString('hex')}`, key=id();
    run('INSERT INTO equipment (id,company_id,plant_id,machine_type,make,model,serial_number,location,qr_code,created_at,asset_tag,criticality,status,year_built,commissioned_at,warranty_until,specs,rfid_tag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      key,plant.company_id,plant.id,type,required(body.make,'make',100),required(body.model,'model',100),required(body.serialNumber,'serialNumber',100),required(body.location,'location',160),qr,now(),
      tag,choice(body.criticality,'criticality',CRITICALITY),choice(body.status??'in_service','status',EQUIPMENT_STATUS),yearBuilt(body.yearBuilt),optionalDate(body.commissionedAt,'commissionedAt'),optionalDate(body.warrantyUntil,'warrantyUntil'),JSON.stringify(specs),rfid);
    audit(u,'equipment.create','equipment',key,plant.company_id); return created(present(byId('equipment',key)));
  });
  r.get('/equipment/:id',({u,params})=>{
    const e=getEquipment(u,params.id), plant=byId('plants',e.plant_id);
    return {...present(e),plant:{id:plant.id,name:plant.name,timezone:plant.timezone},attachments:all("SELECT id,kind,filename,mime,size_bytes,created_at FROM attachments WHERE entity_type='equipment' AND entity_id=?",e.id),telemetry:telemetry(e.id),
      tickets:all('SELECT id,title,status,priority,created_at,failure_category FROM tickets WHERE equipment_id=? ORDER BY created_at DESC LIMIT 20',e.id)};
  });
  // Company and machine type never change (the QR label and RFID tag can be replaced); moving an asset is allowed only between the company's plants.
  // When specs are sent they replace the set and must be complete for the machine type.
  r.patch('/equipment/:id',({u,body,params})=>{
    const e=getEquipment(u,params.id); if (!canManageCompany(u,e.company_id)&&!isDispatch(u)) deny();
    let plantId=e.plant_id; if (body.plantId!=null) { const p=byId('plants',body.plantId); if (!p||p.company_id!==e.company_id) bad('Equipment can only move between plants of the same company'); plantId=p.id; }
    const value=(key,column,max)=>body[key]==null?e[column]:required(body[key],key,max);
    const tag=body.assetTag==null?e.asset_tag:assetTag(body.assetTag);
    if (tag&&tag!==e.asset_tag&&one('SELECT 1 FROM equipment WHERE company_id=? AND asset_tag=? AND id<>?',e.company_id,tag,e.id)) bad(`Asset tag ${tag} is already used in this company`);
    // RFID tags get replaced when damaged: send the new UID, or null/'' to remove it.
    const rfid=body.rfidTag===undefined?e.rfid_tag:uniqueRfid(rfidTag(body.rfidTag),e.id);
    // A replaced label: send its code. Empty keeps the current one.
    const qr=body.qrCode==null||String(body.qrCode).trim()===''?e.qr_code:uniqueQr(qrLabel(body.qrCode),e.id);
    const specs=body.specs==null?e.specs:JSON.stringify(validateSpecs(e.machine_type,body.specs,sameCompanyAsset(e.company_id)));
    if (body.specs?.linkedEquipmentId===e.id) bad('An auxiliary unit cannot serve itself');
    run('UPDATE equipment SET plant_id=?,make=?,model=?,serial_number=?,location=?,asset_tag=?,criticality=?,status=?,year_built=?,commissioned_at=?,warranty_until=?,specs=?,rfid_tag=?,qr_code=? WHERE id=?',
      plantId,value('make','make',100),value('model','model',100),value('serialNumber','serial_number',100),value('location','location',160),tag,
      body.criticality==null?e.criticality:choice(body.criticality,'criticality',CRITICALITY),body.status==null?e.status:choice(body.status,'status',EQUIPMENT_STATUS),
      body.yearBuilt==null?e.year_built:yearBuilt(body.yearBuilt),body.commissionedAt===undefined?e.commissioned_at:optionalDate(body.commissionedAt,'commissionedAt'),body.warrantyUntil===undefined?e.warranty_until:optionalDate(body.warrantyUntil,'warrantyUntil'),specs,rfid,qr,e.id);
    audit(u,'equipment.update','equipment',e.id,e.company_id,{fields:Object.keys(body)}); return present(byId('equipment',e.id));
  });

  // The equipment picture: shown on the asset, its tickets, the field app and the VR guide. Anyone who can see the
  // asset, or holds a ticket on it, can view it; the people who can edit the asset can change it.
  r.post('/equipment/:id/image',({u,body,params})=>{
    const e=getEquipment(u,params.id); if (!canManageCompany(u,e.company_id)&&!isDispatch(u)) deny();
    choice(body.mime,'mime',['image/jpeg','image/png','image/webp']);
    const file=storeFile(u,{companyId:e.company_id,entityType:'equipment',entityId:e.id,kind:'image',filename:body.filename,mime:body.mime,base64:body.base64});
    run('UPDATE equipment SET image_attachment_id=? WHERE id=?',file.id,e.id); audit(u,'equipment.image','equipment',e.id,e.company_id,{attachmentId:file.id});
    return created(present(byId('equipment',e.id)));
  });
  r.delete('/equipment/:id/image',({u,params})=>{
    const e=getEquipment(u,params.id); if (!canManageCompany(u,e.company_id)&&!isDispatch(u)) deny();
    run('UPDATE equipment SET image_attachment_id=NULL WHERE id=?',e.id); audit(u,'equipment.image_remove','equipment',e.id,e.company_id);
    return present(byId('equipment',e.id));
  });
  r.get('/equipment/:id/image',({u,params,res})=>{
    const e=byId('equipment',params.id); if (!e) missing();
    if (!canCompany(u,e.company_id)&&!visibleTickets(u).some(t=>t.equipment_id===e.id)) deny();
    const a=e.image_attachment_id&&byId('attachments',e.image_attachment_id); if (!a) missing();
    res.writeHead(200,{'content-type':a.mime,'content-disposition':'inline','x-content-type-options':'nosniff','cache-control':'private, max-age=300'}); res.end(readStoredFile(a));
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
