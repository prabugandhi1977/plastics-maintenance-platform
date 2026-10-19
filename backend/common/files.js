// Private file storage. Files live under DATA_DIR/uploads with random names (never the client's filename), are
// type-checked by magic bytes, and are only served through an authorized route as downloads.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR, id, now, run } from './db.js';
import { audit } from './access.js';
import { bad, choice, required } from './validate.js';

export const MAX_FILE_BYTES=5*1024*1024;
const SIGNATURES={'application/pdf':'25504446','image/png':'89504e47','image/jpeg':'ffd8ff','image/webp':'52494646'};

export async function storeFile(u,{companyId,entityType,entityId,kind,filename,mime,base64}) {
  const name=required(filename,'filename',160), type=choice(mime,'mime',Object.keys(SIGNATURES));
  if (typeof base64!=='string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) bad('base64 content required');
  const bytes=Buffer.from(base64,'base64'); if (!bytes.length || bytes.length>MAX_FILE_BYTES) bad('File must be 1 byte to 5 MB');
  if (!bytes.subarray(0,4).toString('hex').startsWith(SIGNATURES[type]) || (type==='image/webp' && bytes.subarray(8,12).toString('latin1')!=='WEBP')) bad('File signature does not match MIME type');
  const fileId=id(), storage=randomBytes(20).toString('hex');
  mkdirSync(join(DATA_DIR,'uploads'),{recursive:true}); writeFileSync(join(DATA_DIR,'uploads',storage),bytes,{flag:'wx'});
  await run('INSERT INTO attachments (id,company_id,entity_type,entity_id,kind,filename,mime,size_bytes,storage_name,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',fileId,companyId,entityType,entityId,kind,name,type,bytes.length,storage,u.id,now());
  await audit(u,'attachment.create',entityType,entityId,companyId,{attachmentId:fileId,kind});
  return {id:fileId,filename:name,mime:type,sizeBytes:bytes.length};
}
export const readStoredFile=a=>readFileSync(join(DATA_DIR,'uploads',a.storage_name));
export const downloadHeaders=a=>({'content-type':a.mime,'content-disposition':`attachment; filename="${a.filename.replace(/["\\\r\n]/g,'_')}"`,'x-content-type-options':'nosniff','cache-control':'private, no-store'});
