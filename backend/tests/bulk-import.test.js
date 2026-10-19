import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-bulk-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one }=await import('../common/db.js');
const { parseCsv }=await import('../services/core/routes/bulk.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body==null?undefined:JSON.stringify(body)});const type=r.headers.get('content-type')||'';return {status:r.status,type,data:type.includes('json')?await r.json():Buffer.from(await r.arrayBuffer())};}
const login=async email=>(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;
const tokens={acme:await login('acme@demo.test'),engineer:await login('engineer@demo.test')};

test('csv reader handles quotes, semicolons, BOM and comment-free rows',()=>{
  assert.deepEqual(parseCsv('﻿a;b\r\n"x;1";"he said ""hi"""\r\n').map(r=>r.cells),[['a','b'],['x;1','he said "hi"']]);
  assert.equal(parseCsv('a,b\n\n1,2\n').length,2);
});

test('templates download as csv for equipment, products and plants',async()=>{
  const t=await call('/import/equipment/template?machineType=injection','GET',null,tokens.acme); assert.equal(t.status,200); assert.match(t.type,/text\/csv/);
  const text=t.data.toString('utf8'); assert.match(text,/plant,assetTag,make,model,serialNumber,yearBuilt,criticality,status,location,commissionedAt,warrantyUntil,qrCode,rfidTag,spec\.clampForceKn/);
  assert.equal((await call('/import/equipment/template?machineType=nope','GET',null,tokens.acme)).status,400);
  assert.equal((await call('/import/products/template','GET',null,tokens.acme)).status,200);
  assert.equal((await call('/import/plants/template','GET',null,tokens.acme)).status,200);
  assert.equal((await call('/import/widgets/template','GET',null,tokens.acme)).status,404);
});

test('equipment upload creates every row, or none',async()=>{
  const plant=await one("SELECT p.name FROM plants p JOIN users u ON u.company_id=p.company_id WHERE u.email='acme@demo.test' LIMIT 1");
  const head='plant,assetTag,make,model,serialNumber,yearBuilt,criticality,location,spec.clampForceKn,spec.shotVolumeCm3,spec.screwDiameterMm,spec.driveType';
  const good=`# comment\n${head}\n${plant.name},bulk-1,Arburg,A1,S1,2020,b,Bay 1,1500,300,45,electric\n${plant.name},BULK-2,Engel,E1,S2,2021,A,Bay 2,900,200,40,hybrid\n`;
  const ok=await call('/import/equipment','POST',{machineType:'injection',csv:good},tokens.acme); assert.equal(ok.status,200); assert.equal(ok.data.imported,2);
  assert.equal((await one("SELECT count(*)::int n FROM equipment WHERE asset_tag IN ('BULK-1','BULK-2')")).n,2);
  const bad=`${head}\n${plant.name},BULK-3,Arburg,A1,S3,2020,B,Bay 1,1500,300,45,electric\n${plant.name},BULK-1,Arburg,A1,S4,2020,B,Bay 1,1500,300,45,electric\n${plant.name},BULK-5,Arburg,A1,S5,2020,B,Bay 1,10,300,45,electric\n`;
  const fail=await call('/import/equipment','POST',{machineType:'injection',csv:bad},tokens.acme); assert.equal(fail.status,400);
  assert.match(fail.data.error,/Nothing was imported/); assert.match(fail.data.error,/Row 3: Asset tag BULK-1 is already used/); assert.match(fail.data.error,/Row 4: Clamp force/);
  assert.equal((await one("SELECT count(*)::int n FROM equipment WHERE asset_tag='BULK-3'")).n,0);
  assert.match((await call('/import/equipment','POST',{machineType:'injection',csv:'plant,nonsense\nx,y'},tokens.acme)).data.error,/Unknown column/);
  assert.match((await call('/import/equipment','POST',{machineType:'injection',csv:'plant,assetTag\nx,y'},tokens.acme)).data.error,/Missing required column/);
  assert.equal((await call('/import/equipment','POST',{machineType:'injection',csv:good.replaceAll('bulk-1','bulk-9').replaceAll('BULK-2','BULK-8')},tokens.engineer)).status,403);
});

test('products and plants upload',async()=>{
  const p=await call('/import/products','POST',{csv:'partNumber,name,material,idealCycleS,cavities\ncap-1,Cap,HDPE,12,8\n'},tokens.acme); assert.equal(p.status,200,JSON.stringify(p.data));
  assert.equal((await one("SELECT part_number FROM products WHERE part_number='CAP-1'")).part_number,'CAP-1');
  const pl=await call('/import/plants','POST',{csv:'name,address,country,serviceArea,timezone,operatingPattern\nBulkville,1 Main Rd,IN,IN-S,Asia/Kolkata,24x7\n'},tokens.acme); assert.equal(pl.status,200,JSON.stringify(pl.data));
});
