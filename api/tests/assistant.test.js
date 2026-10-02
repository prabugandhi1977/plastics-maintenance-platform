import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
process.env.MOULDCARE_INTEGRATION_KEY='test-integration-key';
delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
await import('../seed.js');
const { createServer }=await import('../server.js');
const { db }=await import('../db.js');
const { setAiClient }=await import('../assistant.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{setAiClient(null);await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token) {const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body==null?undefined:JSON.stringify(body)});const type=r.headers.get('content-type')||'';return {status:r.status,type,data:type.startsWith('application/json')?await r.json():Buffer.from(await r.arrayBuffer())};}
const tokens={};
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PDF=Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');

// A stand-in for the Anthropic client: records each request and answers like the Messages API.
const requests=[]; let reply=()=>({stop_reason:'end_turn',content:[{type:'thinking',thinking:''},{type:'text',text:'1. Check the pump pressure.'}]});
setAiClient({beta:{messages:{create:async body=>{requests.push(body);return reply(body);}}}});

test('setup',async()=>{for (const [k,email] of Object.entries({admin:'admin@demo.test',acme:'acme@demo.test',maint:'maint@demo.test',engineer:'engineer@demo.test',nova:'nova@demo.test',euro:'euro@demo.test'})) tokens[k]=(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;});

test('equipment picture: upload, view by those with access, remove',async()=>{
  assert.equal((await call('/equipment/eq-a/image','POST',{filename:'imm.png',mime:'image/png',base64:PNG},tokens.maint)).status,403);
  assert.equal((await call('/equipment/eq-a/image','POST',{filename:'x.pdf',mime:'application/pdf',base64:PDF},tokens.acme)).status,400);
  const up=await call('/equipment/eq-a/image','POST',{filename:'imm.png',mime:'image/png',base64:PNG},tokens.acme);
  assert.equal(up.status,201); assert.ok(up.data.image_attachment_id);
  const img=await call('/equipment/eq-a/image','GET',null,tokens.maint); assert.equal(img.status,200); assert.equal(img.type,'image/png'); assert.equal(img.data.toString('base64'),PNG);
  // The engineer assigned to ticket-a sees the picture of its machine; another company does not.
  assert.equal((await call('/equipment/eq-a/image','GET',null,tokens.engineer)).status,200);
  assert.equal((await call('/equipment/eq-a/image','GET',null,tokens.nova)).status,403);
  assert.equal((await call('/tickets/ticket-a','GET',null,tokens.acme)).data.asset.image_attachment_id,up.data.image_attachment_id);
  assert.equal((await call('/equipment/eq-a/image','DELETE',null,tokens.acme)).data.image_attachment_id,null);
  assert.equal((await call('/equipment/eq-a/image','GET',null,tokens.acme)).status,404);
  await call('/equipment/eq-a/image','POST',{filename:'imm.png',mime:'image/png',base64:PNG},tokens.acme);
});

test('AI assistant chat: grounded in the ticket, manuals and company history; shared on the ticket',async()=>{
  setAiClient(null);
  const off=await call('/tickets/ticket-a/assistant','GET',null,tokens.acme); assert.equal(off.data.enabled,false);
  assert.equal((await call('/tickets/ticket-a/assistant','POST',{message:'Why?'},tokens.acme)).status,503);
  assert.equal((await call('/catalog','GET',null,tokens.acme)).data.ai.enabled,false);
  setAiClient({beta:{messages:{create:async body=>{requests.push(body);return reply(body);}}}});
  await call('/attachments','POST',{entityType:'equipment',entityId:'eq-a',kind:'manual',filename:'arburg-570.pdf',mime:'application/pdf',base64:PDF},tokens.acme);

  const first=await call('/tickets/ticket-a/assistant','POST',{message:'Pressure drops after warm-up. Where do I start?'},tokens.engineer);
  assert.equal(first.status,200); assert.deepEqual(first.data.messages.map(m=>m.role),['user','assistant']);
  assert.equal(first.data.messages[1].content,'1. Check the pump pressure.');
  const req=requests.at(-1);
  assert.equal(req.model,'claude-opus-5-5'); assert.equal(req.fallbacks,'default'); assert.deepEqual(req.betas,['server-side-fallback-2026-07-01']);
  assert.deepEqual(req.thinking,{type:'adaptive'}); assert.match(req.system[0].text,/lock-out\/tag-out/);
  // The manual travels as a cached PDF document in the first turn; the ticket record comes last as a system message.
  const doc=req.messages[0].content[0]; assert.equal(doc.type,'document'); assert.equal(doc.title,'arburg-570.pdf'); assert.deepEqual(doc.cache_control,{type:'ephemeral'});
  const ctx=req.messages.at(-1); assert.equal(ctx.role,'system');
  assert.match(ctx.content,/Arburg Allrounder 570/); assert.match(ctx.content,/E-204/); assert.match(ctx.content,/Hydraulic pressure low at start-up/);
  assert.doesNotMatch(ctx.content,/Coperion|Nova/);

  // A follow-up replays the conversation in order; the customer sees the same thread.
  await call('/tickets/ticket-a/assistant','POST',{message:'Pump is fine. Next?'},tokens.acme);
  assert.deepEqual(requests.at(-1).messages.slice(0,-1).map(m=>m.role),['user','assistant','user']);
  assert.equal((await call('/tickets/ticket-a/assistant','GET',null,tokens.acme)).data.messages.length,4);
  // Other tenants and engineers not on the ticket cannot read or ask.
  assert.equal((await call('/tickets/ticket-a/assistant','GET',null,tokens.nova)).status,403);
  assert.equal((await call('/tickets/ticket-a/assistant','POST',{message:'Hi'},tokens.euro)).status,403);

  // A declined request is answered plainly and the API failure path gives a clear error, without storing a half turn.
  reply=()=>({stop_reason:'refusal',content:[]});
  assert.match((await call('/tickets/ticket-a/assistant','POST',{message:'Odd question'},tokens.acme)).data.messages.at(-1).content,/could not answer/);
  reply=()=>{ throw new Error('network down'); };
  assert.equal((await call('/tickets/ticket-a/assistant','POST',{message:'Again?'},tokens.acme)).status,502);
  assert.equal((await call('/tickets/ticket-a/assistant','GET',null,tokens.acme)).data.messages.length,6);
});

test('repair guide: standard without AI, structured AI guide when set up',async()=>{
  setAiClient(null);
  const std=(await call('/tickets/ticket-n/guide','GET',null,tokens.nova)).data;
  assert.equal(std.source,'standard'); assert.match(std.guide.steps[0].title,/safe/i); assert.ok(std.guide.hazards.some(h=>/die head/.test(h)));
  assert.equal((await call('/tickets/ticket-n/guide','POST',{},tokens.nova)).data.source,'standard');

  const guide={summary:'Likely worn pump.',hazards:['Accumulator pressure'],ppe:['Face shield'],steps:[{title:'Lock out',instruction:'Apply LOTO.',check:'Gauge at 0 bar.'},{title:'Test pump',instruction:'Measure flow.',check:'Flow within spec.'}]};
  reply=()=>({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(guide)}]});
  setAiClient({beta:{messages:{create:async body=>{requests.push(body);return reply(body);}}}});
  const made=await call('/tickets/ticket-a/guide','POST',{},tokens.engineer);
  assert.equal(made.status,200); assert.equal(made.data.source,'ai'); assert.deepEqual(made.data.guide,guide);
  const req=requests.at(-1); assert.equal(req.output_config.format.type,'json_schema'); assert.match(req.messages[0].content.at(-1).text,/Pump is fine/);
  assert.deepEqual((await call('/tickets/ticket-a/guide','GET',null,tokens.acme)).data.guide,guide);
  reply=()=>({stop_reason:'end_turn',content:[{type:'text',text:'not json'}]});
  assert.equal((await call('/tickets/ticket-a/guide','POST',{},tokens.engineer)).status,502);
  assert.deepEqual((await call('/tickets/ticket-a/guide','GET',null,tokens.acme)).data.guide,guide);
});
