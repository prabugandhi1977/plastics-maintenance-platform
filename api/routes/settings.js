// Platform settings and reference data: the master-data catalogue, managed service areas, default response targets
// by priority (used when no contract covers an asset) and the standard checklist per machine type.
import { id, now, one, all, run, transaction } from '../db.js';
import { isInternal, isPlatform } from '../security.js';
import { audit } from '../access.js';
import { created } from '../http.js';
import { bad, deny, missing, required, integer, array, choice } from '../validate.js';
import { catalog, codes, CODE_LISTS, DEFAULT_RESPONSE_HOURS, MACHINE_TYPES } from '../catalog.js';
import { scanPolicy } from '../scan.js';
import { AI_MODEL, aiEnabled } from '../assistant.js';

const PRIORITIES=['critical','high','medium','low'];
export function defaultResponseHours() {
  try { return {...DEFAULT_RESPONSE_HOURS,...JSON.parse(one("SELECT value FROM settings WHERE key='default_response_hours'")?.value||'{}')}; } catch { return {...DEFAULT_RESPONSE_HOURS}; }
}

export function register(r) {
  r.get('/catalog',()=>({...catalog(),scanPolicy:scanPolicy(),ai:{enabled:aiEnabled(),model:aiEnabled()?AI_MODEL:null}}));

  r.get('/service-areas',()=>all('SELECT sa.code,sa.name,(SELECT count(*) FROM plants p WHERE p.service_area=sa.code) plants FROM service_areas sa ORDER BY sa.code'));
  r.post('/service-areas',({u,body})=>{
    if (!isPlatform(u)) deny();
    const code=required(body.code,'code',20).toUpperCase(); if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) bad('Code must be 2-20 letters, digits or dashes, e.g. IN-SOUTH');
    if (one('SELECT 1 FROM service_areas WHERE code=?',code)) bad(`Service area ${code} already exists`);
    run('INSERT INTO service_areas (code,name,created_at) VALUES (?,?,?)',code,required(body.name,'name',80),now());
    audit(u,'service_area.create','service_area',code,null); return created(one('SELECT * FROM service_areas WHERE code=?',code));
  });
  r.patch('/service-areas/:code',({u,body,params})=>{
    if (!isPlatform(u)) deny(); const a=one('SELECT * FROM service_areas WHERE code=?',params.code); if (!a) missing();
    run('UPDATE service_areas SET name=? WHERE code=?',required(body.name,'name',80),a.code);
    audit(u,'service_area.update','service_area',a.code,null); return one('SELECT * FROM service_areas WHERE code=?',a.code);
  });

  r.get('/settings/response-targets',({u})=>{ if (!isInternal(u)) deny(); return defaultResponseHours(); });
  r.patch('/settings/response-targets',({u,body})=>{
    if (!isPlatform(u)) deny();
    const value=Object.fromEntries(PRIORITIES.map(p=>[p,integer(body[p]??defaultResponseHours()[p],`${p} response hours`,1,720)]));
    if (!(value.critical<=value.high&&value.high<=value.medium&&value.medium<=value.low)) bad('Targets must not get shorter for lower priorities (critical ≤ high ≤ medium ≤ low)');
    run("INSERT INTO settings (key,value,updated_at) VALUES ('default_response_hours',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",JSON.stringify(value),now());
    audit(u,'settings.response_targets','settings','default_response_hours',null,value); return value;
  });

  // Whether raising and closing a ticket need a scan of the machine's QR label or RFID tag.
  r.get('/settings/scan-policy',()=>scanPolicy());
  r.patch('/settings/scan-policy',({u,body})=>{
    if (!isPlatform(u)) deny();
    const current=scanPolicy(), value={raise:choice(body.raise??current.raise,'raise',['required','optional']),close:choice(body.close??current.close,'close',['required','optional'])};
    run("INSERT INTO settings (key,value,updated_at) VALUES ('scan_policy',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",JSON.stringify(value),now());
    audit(u,'settings.scan_policy','settings','scan_policy',null,value); return value;
  });

  // Failure coding lists: add a code, or delete one. Tickets keep codes recorded before a deletion.
  const COLUMN={failureCategories:'failure_category',failureModes:'failure_mode',rootCauses:'root_cause',actions:'action_taken'};
  r.post('/settings/codes/:list',({u,body,params})=>{
    if (!isPlatform(u)) deny(); const key=choice(params.list,'list',Object.keys(CODE_LISTS)), list=CODE_LISTS[key];
    const text=required(body.label,'label',60), code=text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
    if (!code) bad('Use letters or digits in the name');
    if (one('SELECT 1 FROM code_lists WHERE list=? AND code=?',list,code)) bad(`"${text}" is already in the list`);
    if (codes(list).length>=60) bad('A list can hold at most 60 codes');
    run('INSERT INTO code_lists (list,code,position,created_at) VALUES (?,?,(SELECT COALESCE(max(position),0)+1 FROM code_lists WHERE list=?),?)',list,code,list,now());
    audit(u,'settings.code_add','code_list',`${list}:${code}`,null,{label:text}); return created({list:key,code,codes:codes(list)});
  });
  r.delete('/settings/codes/:list/:code',({u,params})=>{
    if (!isPlatform(u)) deny(); const key=choice(params.list,'list',Object.keys(CODE_LISTS)), list=CODE_LISTS[key], code=decodeURIComponent(params.code);
    if (!one('SELECT 1 FROM code_lists WHERE list=? AND code=?',list,code)) missing();
    if (codes(list).length<=1) bad('A list needs at least one code');
    run('DELETE FROM code_lists WHERE list=? AND code=?',list,code);
    const used=one(`SELECT count(*) n FROM tickets WHERE ${COLUMN[key]}=?`,code).n;
    audit(u,'settings.code_delete','code_list',`${list}:${code}`,null,{ticketsKeepingCode:used}); return {list:key,code,deleted:true,ticketsKeepingCode:used,codes:codes(list)};
  });

  r.get('/settings/checklists',({u})=>{ if (!isInternal(u)) deny(); return Object.fromEntries(MACHINE_TYPES.map(t=>[t,all('SELECT item FROM checklist_templates WHERE machine_type=? ORDER BY position',t).map(x=>x.item)])); });
  // Replaces a machine type's standard checklist. Tickets already accepted keep the checklist they started with.
  r.patch('/settings/checklists/:type',({u,body,params})=>{
    if (!isPlatform(u)) deny(); const type=choice(params.type,'machine type',MACHINE_TYPES);
    const items=array(body.items,'items').map((x,i)=>required(x,`item ${i+1}`,200));
    if (!items.length||items.length>40) bad('A checklist needs 1-40 items');
    if (new Set(items.map(x=>x.toLowerCase())).size!==items.length) bad('Checklist items must be unique');
    transaction(()=>{ run('DELETE FROM checklist_templates WHERE machine_type=?',type); items.forEach((item,i)=>run('INSERT INTO checklist_templates (id,machine_type,position,item) VALUES (?,?,?,?)',id(),type,i+1,item)); });
    audit(u,'settings.checklist','checklist_template',type,null,{items:items.length}); return items;
  });
}
