// Bulk import of master data from CSV: a downloadable template per list, and an all-or-nothing upload.
// Every row goes through the same create handler as the single-record form, so the rules (and permissions) are identical.
import { all, one, now } from '../../../common/db.js';
import { isDispatch } from '../../../common/access.js';
import { bad, deny, missing, HttpError } from '../../../common/validate.js';
import { MACHINE_TYPES, CRITICALITY, EQUIPMENT_STATUS, SPEC_FIELDS, OPERATING_PATTERNS, PRODUCT_UNITS } from '../../../common/catalog.js';

const MAX_ROWS=1000;
const cell=v=>{ const s=String(v??''); return /[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s; };

// RFC 4180 reader. Excel in many locales saves with ';' as the separator, so the header line decides.
export function parseCsv(text) {
  text=String(text??'').replace(/^﻿/,'');
  const first=text.split(/\r?\n/).find(l=>l.trim()&&!l.trim().startsWith('#'))||'', sep=(first.match(/;/g)||[]).length>(first.match(/,/g)||[]).length?';':',';
  const rows=[]; let row=[], cur='', quoted=false, line=1, start=1;
  const endRow=()=>{ row.push(cur); cur=''; if (row.some(c=>c.trim()!=='')) rows.push({line:start,cells:row}); row=[]; start=line+1; };
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    if (quoted) { if (ch==='"') { if (text[i+1]==='"') { cur+='"'; i++; } else quoted=false; } else { if (ch==='\n') line++; cur+=ch; } }
    else if (ch==='"'&&cur==='') quoted=true;
    else if (ch===sep) { row.push(cur); cur=''; }
    else if (ch==='\n') { endRow(); line++; start=line; }
    else if (ch!=='\r') cur+=ch;
  }
  if (cur!==''||row.length) endRow();
  return rows;
}

const text=v=>v==null?'':String(v).trim();
const blank=v=>text(v)==='';

async function companiesOf(u) { return isDispatch(u)?await all('SELECT id,name FROM companies ORDER BY name'):u.company_id?await all('SELECT id,name FROM companies WHERE id=?',u.company_id):[]; }
async function companyFrom(u,name) {
  const list=await companiesOf(u), n=text(name).toLowerCase();
  if (!n) { if (list.length===1) return list[0]; bad('company is required'); }
  const hit=list.filter(c=>c.name.toLowerCase()===n); if (hit.length!==1) bad(`Unknown company "${text(name)}"`); return hit[0];
}
async function plantFrom(u,name) {
  const plants=await all(isDispatch(u)?'SELECT id,name,company_id FROM plants':'SELECT id,name,company_id FROM plants WHERE company_id=?',...(isDispatch(u)?[]:[u.company_id])), n=text(name).toLowerCase();
  if (!n) { if (plants.length===1) return plants[0]; bad('plant is required'); }
  const hit=plants.filter(p=>p.name.toLowerCase()===n); if (!hit.length) bad(`Unknown plant "${text(name)}"`); if (hit.length>1) bad(`Several plants are called "${text(name)}"; rename one first`); return hit[0];
}
const assetByTag=async (companyId,tag)=>{ const e=await one('SELECT id FROM equipment WHERE company_id=? AND asset_tag=?',companyId,text(tag).toUpperCase()); if (!e) bad(`No machine with asset tag "${text(tag)}" in this company`); return e.id; };
const withValues=(base,row)=>{ for (const [k,v] of Object.entries(row)) if (!blank(v)) base[k]=text(v); return base; };

const ENTITIES={
  equipment:{
    file:'equipment', post:'/equipment', title:'equipment',
    columns:({machineType})=>{
      if (!MACHINE_TYPES.includes(machineType)) bad('machineType must be one of: '+MACHINE_TYPES.join(', '));
      const spec=SPEC_FIELDS[machineType].map(f=>({key:'spec.'+f.key,required:f.required,allowed:f.type==='choice'?f.options:undefined,help:f.type==='equipment'?'asset tag of the machine it serves':`${f.label}${f.unit?' ('+f.unit+')':''}${f.min!=null?`, ${f.min} to ${f.max}`:''}`,example:f.type==='choice'?f.options[0]:f.type==='text'?'':f.type==='equipment'?'':String(f.min<1?1:f.min)}));
      return [
        {key:'plant',required:true,help:'plant name as in Organisation',example:'Pune'},
        {key:'assetTag',required:true,help:'your equipment number, unique in the company',example:'IMM-01'},
        {key:'make',required:true,example:'Arburg'},{key:'model',required:true,example:'Allrounder 470'},{key:'serialNumber',required:true,example:'SN-1001'},
        {key:'yearBuilt',required:true,help:'1950 or later',example:'2020'},
        {key:'criticality',required:true,allowed:CRITICALITY,example:'B'},
        {key:'status',required:false,allowed:EQUIPMENT_STATUS,help:'blank means in_service',example:'in_service'},
        {key:'location',required:true,help:'bay, line or room',example:'Bay 1'},
        {key:'commissionedAt',required:false,help:'YYYY-MM-DD',example:'2020-06-01'},{key:'warrantyUntil',required:false,help:'YYYY-MM-DD',example:'2025-06-01'},
        {key:'qrCode',required:false,help:'blank creates a label code'},{key:'rfidTag',required:false,help:'tag UID or EPC'},
        ...spec];
    },
    async toBody(u,row,{machineType}) {
      const plant=await plantFrom(u,row.plant), body={plantId:plant.id,machineType,specs:{}};
      for (const k of ['assetTag','make','model','serialNumber','location','criticality','status','commissionedAt','warrantyUntil','qrCode','rfidTag']) if (!blank(row[k])) body[k]=text(row[k]);
      if (body.criticality) body.criticality=body.criticality.toUpperCase();
      if (!blank(row.yearBuilt)) body.yearBuilt=Number(text(row.yearBuilt));
      for (const f of SPEC_FIELDS[machineType]) { const v=row['spec.'+f.key]; if (blank(v)) continue;
        body.specs[f.key]=f.type==='equipment'?await assetByTag(plant.company_id,v):f.type==='text'||f.type==='choice'?text(v):Number(text(v)); }
      return body;
    },
    summary:(b)=>b.assetTag||b.make
  },
  products:{
    file:'products', post:'/products', title:'products',
    columns:()=>[
      {key:'company',required:false,help:'only needed when you manage several companies',example:'Acme Plastics'},
      {key:'partNumber',required:true,example:'CAP-28'},{key:'name',required:true,example:'Bottle cap 28 mm'},{key:'material',required:true,example:'HDPE'},
      {key:'unit',required:false,allowed:PRODUCT_UNITS,help:'blank means parts',example:'parts'},
      {key:'partWeightG',required:false,help:'grams',example:'2.4'},
      {key:'idealCycleS',required:false,help:'seconds; required for unit parts',example:'12'},{key:'cavities',required:false,help:'required for unit parts',example:'8'},
      {key:'idealRatePerHour',required:false,help:'required for unit kg or m',example:''},
      {key:'mould',required:false,help:'asset tag of the mould',example:''},{key:'defaultMachine',required:false,help:'asset tag of the usual machine',example:''}],
    async toBody(u,row) {
      const company=await companyFrom(u,row.company), body={companyId:company.id};
      for (const k of ['partNumber','name','material','unit']) if (!blank(row[k])) body[k]=text(row[k]);
      for (const k of ['partWeightG','idealCycleS','cavities','idealRatePerHour']) if (!blank(row[k])) body[k]=Number(text(row[k]));
      if (!blank(row.mould)) body.mouldId=await assetByTag(company.id,row.mould);
      if (!blank(row.defaultMachine)) body.defaultMachineId=await assetByTag(company.id,row.defaultMachine);
      return body;
    },
    summary:b=>b.partNumber
  },
  plants:{
    file:'plants', post:'/plants', title:'plants',
    columns:()=>[
      {key:'company',required:false,help:'only needed when you manage several companies',example:'Acme Plastics'},
      {key:'name',required:true,example:'Pune'},{key:'address',required:true,example:'Plot 12, MIDC Chakan, Pune'},
      {key:'country',required:true,help:'ISO two-letter code',example:'IN'},{key:'serviceArea',required:true,help:'service area code as in Organisation',example:'IN-S'},
      {key:'timezone',required:true,help:'IANA time zone',example:'Asia/Kolkata'},{key:'operatingPattern',required:true,allowed:OPERATING_PATTERNS,example:'24x7'}],
    async toBody(u,row) {
      const company=await companyFrom(u,row.company), body={companyId:company.id};
      for (const k of ['name','address','country','serviceArea','timezone','operatingPattern']) if (!blank(row[k])) body[k]=text(row[k]);
      return body;
    },
    summary:b=>b.name
  }
};

const entityOf=name=>ENTITIES[name]||missing();
const optionsOf=query=>({machineType:query.get('machineType')||undefined});

function templateCsv(entity,options) {
  const cols=entity.columns(options), allowed=cols.filter(c=>c.allowed).map(c=>`${c.key}: ${c.allowed.join(' | ')}`).join('; ');
  const lines=[
    [`# Import template for ${entity.title}${options.machineType?` (${options.machineType})`:''}. Lines starting with # are ignored: delete them if you like.`],
    [`# Required columns: ${cols.filter(c=>c.required).map(c=>c.key).join(', ')}`],
    ...(allowed?[[`# Allowed values - ${allowed}`]]:[]),
    ...cols.filter(c=>c.help).map(c=>[`# ${c.key}: ${c.help}`]),
    cols.map(c=>c.key),
    cols.map((c,i)=>i===0?`# e.g. ${c.example??''}`:c.example??'')
  ];
  return '﻿'+lines.map(l=>l.map(cell).join(',')).join('\r\n')+'\r\n';
}

export function register(r) {
  const handlerFor=path=>r.routes.find(x=>x.method==='POST'&&x.pattern===path)?.handler||missing();
  r.get('/import/:entity/template',async ({params,query,res})=>{
    const entity=entityOf(params.entity), options=optionsOf(query), body=templateCsv(entity,options);
    res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="${entity.file}${options.machineType?'-'+options.machineType:''}-import-template.csv"`,'cache-control':'no-store'});
    res.end(body);
  });
  // All or nothing: the request runs in one transaction, so a single bad row rolls the whole file back.
  r.post('/import/:entity',async ({u,params,body})=>{
    if (!isDispatch(u)&&!u.company_id) deny();
    const entity=entityOf(params.entity), options={machineType:body.machineType}, cols=entity.columns(options), create=handlerFor(entity.post);
    if (typeof body.csv!=='string'||!body.csv.trim()) bad('csv is required');
    const rows=parseCsv(body.csv).filter(x=>!text(x.cells[0]).startsWith('#'));
    if (rows.length<2) bad('The file has no data rows');
    const header=rows[0].cells.map(h=>text(h)), known=new Map(cols.map(c=>[c.key.toLowerCase(),c.key]));
    const keys=header.map(h=>known.get(h.toLowerCase())); const unknown=header.filter((h,i)=>!keys[i]); if (unknown.length) bad(`Unknown column${unknown.length>1?'s':''}: ${unknown.join(', ')}. Use the downloaded template.`);
    const absent=cols.filter(c=>c.required&&!keys.includes(c.key)).map(c=>c.key); if (absent.length) bad(`Missing required column${absent.length>1?'s':''}: ${absent.join(', ')}`);
    const data=rows.slice(1); if (data.length>MAX_ROWS) bad(`At most ${MAX_ROWS} rows per file`);
    const errors=[], made=[];
    for (const x of data) {
      const row={}; keys.forEach((k,i)=>{ row[k]=x.cells[i]??''; });
      try { const b=await entity.toBody(u,row,options); const out=await create({u,body:b,params:{},query:new URLSearchParams()}); made.push({row:x.line,label:entity.summary(b),id:(out.value??out).id}); }
      catch (e) { if (!(e instanceof HttpError)) throw e; errors.push(`Row ${x.line}: ${e.message}`); if (e.status!==400) break; }
    }
    if (errors.length) throw new HttpError(400,`Nothing was imported. ${errors.length} row${errors.length>1?'s have':' has'} a problem. ${errors.slice(0,15).join(' | ')}${errors.length>15?` | …and ${errors.length-15} more`:''}`);
    return {entity:params.entity,imported:made.length,rows:made,at:now()};
  });
}
