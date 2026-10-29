import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Synthetic data uses fixed timestamps (T0) so nothing depends on the clock or the time of day. The few tests that go through
// the HTTP intake need samples near "now" (the intake refuses old timestamps); they use offsets from Date.now() only, never the hour.
const dir=mkdtempSync(join(tmpdir(),'mouldcare-audit-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
process.env.MOULDCARE_INTEGRATION_KEY='test-integration-key';
delete process.env.EMAIL_PROVIDER;
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one, all, run, rawQuery }=await import('../common/db.js');
const A=await import('../services/energy-audit/analysis.js');
const I=await import('../services/energy-audit/ingest.js');
const { genTrace, templateOf, rowsOf, FIXED_PUMP_PHASES, SERVO_PHASES }=await import('../services/energy-audit/synthetic.js');
const { parseBatch, storeBatch }=I;
const { equipmentBody }=await import('./fixtures.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token,extra={}){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...extra},body:body==null?undefined:JSON.stringify(body)});let data=null;try{data=await r.json();}catch{}return {status:r.status,data,headers:r.headers};}
const tokens={};
for (const [key,email] of Object.entries({admin:'admin@demo.test',dispatch:'dispatch@demo.test',acme:'acme@demo.test',maint:'maint@demo.test',nova:'nova@demo.test',atlas:'atlas@demo.test',engineer:'engineer@demo.test'})) tokens[key]=(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;

const T0=Date.UTC(2026,0,5,9,0,0), HOUR=3600000;
const seriesOf=(samples)=>A.resolveSeries(rowsOf(samples));
const trace10=genTrace({startMs:T0,cycles:60,warmupS:40,missing:[20],pauses:[{afterCycle:40,seconds:50}],noise:0.05,seed:3});
const tmpl=templateOf(FIXED_PUMP_PHASES);

// ---------- Maths ----------
test('SEC: kWh from the power trace, kg, kWh per part and shot, idle share from machine states',()=>{
  const s=[]; for (let i=0;i<=3600;i++) s.push({ts:T0+i*1000,kw:i<=1800?10:4});
  const states=[{state:'running',a:T0,b:T0+1800000},{state:'idle',a:T0+1800000,b:T0+3600000}];
  const res=A.analyseWindow({fromMs:T0,toMs:T0+HOUR,series:seriesOf(s),states,output:{goodKg:3.5,goodParts:70,shots:35,basis:'manual'}});
  assert.ok(Math.abs(res.energy.kwh-7)<0.01,`kwh ${res.energy.kwh}`);
  assert.ok(Math.abs(res.sec.kwhPerKg-2)<0.01); assert.ok(Math.abs(res.sec.kwhPerPart-0.1)<0.001); assert.ok(Math.abs(res.sec.kwhPerShot-0.2)<0.001);
  assert.equal(res.idle.basis,'states'); assert.ok(Math.abs(res.idle.sharePct-100*2/7)<0.2,`idle ${res.idle.sharePct}`);
  assert.ok(Math.abs(res.energy.avgKw-7)<0.01); assert.equal(res.energy.peakKw,10); assert.equal(res.data.power,'measured');
  assert.equal(A.analyseWindow({fromMs:T0,toMs:T0+HOUR,series:seriesOf(s)}).sec.kwhPerKg,null,'no mass, no SEC');
});
test('SEC from interval readings (energy_readings path): pro rata over the window',()=>{
  const readings=[0,1,2,3].map(i=>({period_start:new Date(T0+i*900000).toISOString(),period_minutes:15,kwh:3,peak_kw:14,kva:null,pf:null}));
  const res=A.analyseWindow({fromMs:T0+450000,toMs:T0+3600000,readings,output:{goodKg:10}});
  assert.ok(Math.abs(res.energy.kwh-10.5)<1e-9); assert.equal(res.data.source,'readings'); assert.equal(res.energy.peakKw,14);
});
test('power from current only is flagged ESTIMATED; with measured V and PF, or kW, it is measured',()=>{
  const m={voltage:400,assumedPf:0.8,voltageBasis:'ll'};
  const e=A.sampleKw({amps:20},m); assert.equal(e.est,true); assert.ok(Math.abs(e.kw-Math.sqrt(3)*400*20*0.8/1000)<1e-9);
  assert.equal(A.sampleKw({amps:20,volts:410,pf:0.7},m).est,false); assert.equal(A.sampleKw({amps:20,volts:410},m).est,true);
  assert.equal(A.sampleKw({kw:5},m).est,false); assert.equal(A.sampleKw({amps:20},{assumedPf:0.8}),null,'no voltage, no estimate');
  assert.ok(Math.abs(A.sampleKw({amps:10},{voltage:230,assumedPf:1,voltageBasis:'ln'}).kw-6.9)<1e-9);
  const s=[0,1,2,3].map(i=>({ts:T0+i*600000,amps:20})), res=A.analyseWindow({fromMs:T0,toMs:T0+1800000,series:A.resolveSeries(s.map(x=>({...x,kw:null,volts:null,pf:null,kva:null,thd:null,kwh_total:null,cyc:null})),m)});
  assert.equal(res.data.power,'estimated'); assert.equal(res.data.integration,'hold'); assert.ok(Math.abs(res.energy.kwh-11.0851*0.5)<0.01);
  const mixed=A.analyseWindow({fromMs:T0,toMs:T0+3000,series:[{ts:T0,kw:5,est:false},{ts:T0+1000,kw:5,est:false},{ts:T0+2000,kw:5,est:true},{ts:T0+3000,kw:5,est:true}]});
  assert.equal(mixed.data.power,'mixed');
  // a cumulative kWh counter gives interval averages
  const c=A.resolveSeries([{ts:T0,kwh_total:100},{ts:T0+HOUR,kwh_total:110},{ts:T0+2*HOUR,kwh_total:5}]); assert.equal(c.length,1); assert.equal(c[0].kw,10,'a counter reset is skipped');
});

// ---------- Mapping ----------
test('LoRaWAN uplinks: ChirpStack v4 and The Things Stack v3 envelopes, configurable mapping, no prototype paths',()=>{
  const cs={deviceInfo:{devEui:'0004A30B001A2B3C'},time:'2026-01-05T09:00:00Z',object:{current_1:12.5,current_2:13.5,vals:[{x:'7'}]}};
  const w=I.unwrapLoRa(cs); assert.equal(w.network,'chirpstack'); assert.equal(w.time,'2026-01-05T09:00:00Z');
  const ttn=I.unwrapLoRa({end_device_ids:{dev_eui:'0004A30B001A2B3C'},received_at:'2026-01-05T09:00:00Z',uplink_message:{decoded_payload:{amps:13}}}); assert.equal(ttn.network,'ttn'); assert.equal(ttn.obj.amps,13);
  const m=I.parseMapping({amps:{path:'current_1',scale:2,offset:1},pf:'vals[0].x'});
  const raw=I.applyMapping(w.obj,m); assert.equal(raw.amps,26); assert.equal(raw.pf,7,'numeric strings are read');
  assert.throws(()=>I.unwrapLoRa({foo:1}),/Not a ChirpStack/);
  assert.throws(()=>I.parseMapping({__proto__x:'a'}),/unknown/); assert.throws(()=>I.parseMapping({kw:'a.__proto__.b'}),/Invalid mapping path/); assert.throws(()=>I.parseMapping({kw:{path:'a',scale:0}}),/scale/);
  assert.throws(()=>I.applyMapping({a:'abc'},I.parseMapping({kw:'a'})),/not a number/);
  assert.equal(I.getPath({a:{b:[1,2]}},'a.b[1]'),2); assert.throws(()=>I.getPath({a:1},'constructor'),/Invalid mapping path/);
  assert.deepEqual(I.sampleValues({kw1:1,kw2:2,kw3:3,v1:230,v2:230,v3:230,i1:5,i2:5,i3:5}).kw,6,'phases add up');
  const ph=I.sampleValues({v1:230,v2:230,v3:230,i1:10,i2:10,i3:10,pf1:0.9,pf2:0.9,pf3:0.9}); assert.ok(Math.abs(ph.kw-6.21)<1e-9&&Math.abs(ph.kva-6.9)<1e-9&&Math.abs(ph.pf-0.9)<1e-9);
});

// ---------- Cycle detection ----------
test('cycle detection at 10 Hz on a noisy trace with a skipped cycle and a pause',()=>{
  const det=A.detectCycles(seriesOf(trace10),T0,trace10[trace10.length-1].ts,{idealS:34});
  assert.ok(det.ok); assert.equal(det.method,'trace'); assert.equal(det.resolutionS,0.1);
  assert.ok(Math.abs(det.cycleTimeS-37)<0.15,`cycle time ${det.cycleTimeS}`);
  assert.ok(det.count>=54&&det.count<=58,`count ${det.count}`); assert.ok(det.rejected.length>=1,'cycles around the skipped cycle and the pause are left out');
  // the detected starts sit on the mould-close rise: within 0.4 s of a true start (40 s warm-up, 37 s cycles, cycle 20 skipped, 50 s pause after cycle 40)
  const exact=genTrace({startMs:T0,cycles:60,warmupS:40,missing:[20],pauses:[{afterCycle:40,seconds:50}],noise:0.05,jitterS:0,seed:3}), dx=A.detectCycles(seriesOf(exact),T0,exact[exact.length-1].ts,{});
  const truth=[]; let at=40000; for (let c=0;c<60;c++) { if (c!==20) truth.push(at); at+=37000; if (c===40) at+=50000; }
  const near=dx.cycles.filter(c=>truth.some(x=>Math.abs(c.startMs-T0-x)<400)).length;
  assert.ok(near>=dx.count-1,`${near} of ${dx.count} starts within 0.4 s of a true start`);
});
test('cycle detection at 1 Hz, with the cycle signal, and none in a flat trace',()=>{
  const slow=trace10.filter((_,i)=>i%10===0), d1=A.detectCycles(seriesOf(slow),T0,slow[slow.length-1].ts,{});
  assert.ok(d1.ok&&Math.abs(d1.cycleTimeS-37)<0.4&&d1.resolutionS===1,`1 Hz ${d1.cycleTimeS}`);
  const sig=genTrace({startMs:T0,cycles:30,counter:true,seed:5}), d2=A.detectCycles(A.resolveSeries(sig.map(s=>({ts:s.ts,kw:s.kw,pf:s.pf,cyc:s.cyc,amps:null,volts:null,kva:null,thd:null,kwh_total:null}))),T0,sig[sig.length-1].ts,{});
  assert.ok(d2.ok&&d2.method==='signal'&&d2.count>=28&&Math.abs(d2.cycleTimeS-37)<0.15,`signal ${d2.method} ${d2.count} ${d2.cycleTimeS}`);
  const flat=genTrace({startMs:T0,cycles:1,plan:[['Hold',600,10,'other']],spike:null,restS:0,noise:0.05,seed:2}), d3=A.detectCycles(seriesOf(flat),T0,flat[flat.length-1].ts,{});
  assert.equal(d3.ok,false); assert.equal(d3.reason,'no_cycle');
  const coarse=Array.from({length:50},(_,i)=>({ts:T0+i*600000,kw:5+(i%2)})); assert.equal(A.detectCycles(seriesOf(coarse),T0,T0+50*600000).reason,'resolution');
});
test('per-phase energy adds up to the cycle energy, the template may be too long or too short',()=>{
  const det=A.detectCycles(seriesOf(trace10),T0,trace10[trace10.length-1].ts,{}), pb=A.phaseBreakdown(det,tmpl,null);
  assert.ok(Math.abs(pb.sumKwh-det.profile.cycleKwh)<1e-9,'phases integrate to the cycle total');
  assert.equal(pb.phases.filter(p=>p.unassigned).length,1,'the 2 s rest is a phase of its own'); assert.ok(Math.abs(pb.phases.find(p=>p.unassigned).seconds-2)<0.15);
  const hold=pb.phases.find(p=>p.name==='Holding'); assert.ok(Math.abs(hold.avgKw-20)<1&&hold.kwhMin<=hold.kwh&&hold.kwh<=hold.kwhMax);
  const long=A.phaseBreakdown(det,[...tmpl,{name:'Extra',seconds:100,category:'other'}],null); assert.equal(long.truncated,true); assert.ok(Math.abs(long.sumKwh-det.profile.cycleKwh)<1e-9);
  const short=A.phaseBreakdown(det,tmpl.slice(0,3),null); assert.ok(Math.abs(short.sumKwh-det.profile.cycleKwh)<1e-9&&short.phases.at(-1).unassigned);
  assert.equal(A.guessCategory('Mould close'),'close'); assert.equal(A.guessCategory('Lock up'),'lockup'); assert.equal(A.guessCategory('Unlock'),'open'); assert.equal(A.guessCategory('Nachdruck'),'holding'); assert.equal(A.guessCategory('Kühlzeit'),'cooling'); assert.equal(A.guessCategory('Core pull'),'other');
});

// ---------- Drive inference ----------
test('the drive is inferred from the profile, with confidence and evidence, and "cannot tell" when it cannot',()=>{
  const run1=(plan,extra={})=>{ const t=genTrace({startMs:T0,cycles:50,plan,seed:4,...extra}), r=A.analyseWindow({fromMs:T0,toMs:t[t.length-1].ts,series:seriesOf(t),phases:templateOf(plan),output:{goodKg:5}}); return r; };
  const fx=run1(FIXED_PUMP_PHASES,{warmupS:60,pauses:[{afterCycle:25,seconds:60}],standbyKw:8}), sv=run1(SERVO_PHASES,{warmupS:60,pauses:[{afterCycle:25,seconds:60}],standbyKw:2.5,pfFloor:0.85});
  assert.equal(fx.drive.class,'fixed'); assert.equal(fx.drive.level,'high'); assert.ok(fx.drive.evidence.some(e=>e.key==='hold'&&e.value>0.6));
  assert.equal(sv.drive.class,'efficient'); assert.ok(fx.inefficiency.scorePct>sv.inefficiency.scorePct+5,'inefficiency does not depend on the label');
  const mid=[['Mould close',2.5,15,'close'],['Filling',2,26,'injection'],['Holding',6,12,'holding'],['Charge',5.5,12,'charge'],['Cooling',12,6.5,'cooling'],['Open',3,10,'open']];
  const md=run1(mid,{standbyKw:5,pfFloor:0.65});
  assert.ok(['variable','unknown'].includes(md.drive.class),`mid profile: ${md.drive.class}`);
  const noTemplate=A.analyseWindow({fromMs:T0,toMs:trace10[trace10.length-1].ts,series:seriesOf(trace10)}); assert.ok(noTemplate.drive.level!=='high','no phases, only weak evidence');
  assert.equal(A.startingDrive({override:'servo_hydraulic',nameplatePump:'fixed',inferred:fx.drive}).class,'efficient'); assert.equal(A.startingDrive({nameplatePump:'fixed'}).source,'nameplate');
  assert.equal(A.startingDrive({inferred:{class:'unknown',level:'none'}}).class,'unknown');
  assert.equal(A.startingDrive({inferred:{class:'fixed',level:'low'}}).class,'unknown','a low-confidence guess is not used');
});

// ---------- Savings ----------
test('savings: low <= typical <= high, payback and net saving arithmetic, efficient and unknown starting points',()=>{
  const t=genTrace({startMs:T0,cycles:50,seed:4}), an=A.analyseWindow({fromMs:T0,toMs:t[t.length-1].ts,series:seriesOf(t),phases:tmpl,output:{goodKg:6}}), rows=an.phases.rows;
  const p=A.proposal({drive:{class:'fixed',source:'nameplate'},phases:rows,cycleKwh:an.cycle.cycleKwh,cycleTimeS:an.cycle.cycleTimeS,kgPerCycle:0.076,sec:2,assumptions:{annualHours:5000,retrofitCost:20000,years:5},price:{rate:0.2,co2:0.4}});
  assert.equal(p.status,'ok'); assert.deepEqual(p.options.map(o=>o.target),['variable','servo']);
  for (const o of p.options) { const [lo,ty,hi]=o.scenarios; assert.ok(lo.annualKwh<=ty.annualKwh&&ty.annualKwh<=hi.annualKwh&&lo.fraction<=ty.fraction&&ty.fraction<=hi.fraction&&lo.annualMoney<=hi.annualMoney&&lo.kwhPerKgSaved<=hi.kwhPerKgSaved);
    assert.ok(lo.paybackYears>=ty.paybackYears&&ty.paybackYears>=hi.paybackYears,'a smaller saving pays back later');
    for (const s of o.scenarios) { assert.ok(Math.abs(s.annualMoney-s.annualKwh*0.2)<1e-9); assert.ok(Math.abs(s.annualCo2Kg-s.annualKwh*0.4)<1e-9); assert.ok(Math.abs(s.paybackYears-20000/s.annualMoney)<1e-9); assert.ok(Math.abs(s.netYears-(s.annualMoney*5-20000))<1e-9);
      assert.ok(Math.abs(s.annualKwh-s.savedPerCycleKwh*5000*3600/an.cycle.cycleTimeS)<1e-6); assert.ok(Math.abs(s.kwhPerKgSaved-s.savedPerCycleKwh/0.076)<1e-9); } }
  const servo=p.options[1].scenarios[1], vd=p.options[0].scenarios[1]; assert.ok(servo.fraction>vd.fraction,'servo saves more than a variable pump');
  const withLoad=A.proposal({drive:{class:'fixed'},phases:rows,cycleKwh:an.cycle.cycleKwh,cycleTimeS:an.cycle.cycleTimeS,assumptions:{fixedLoadKw:5,annualHours:5000},price:{}});
  assert.ok(withLoad.options[1].scenarios[1].annualKwh<servo.annualKwh,'a fixed load (heaters) is not saved'); assert.equal(withLoad.options[1].scenarios[1].paybackYears,null,'no cost, no payback'); assert.equal(withLoad.options[1].scenarios[1].annualMoney,null,'no price, no money');
  assert.deepEqual(A.proposal({drive:{class:'variable'},phases:rows,cycleKwh:an.cycle.cycleKwh,cycleTimeS:37,assumptions:{},price:{}}).options.map(o=>o.target),['servo']);
  assert.equal(A.proposal({drive:{class:'efficient'},assumptions:{}}).status,'efficient'); assert.equal(A.proposal({drive:{class:'unknown'},assumptions:{}}).status,'unknown_drive');
  const whole=A.proposal({drive:{class:'fixed'},phases:null,sec:2,wholeKwhPerHour:12,assumptions:{annualHours:1000},price:{rate:0.1}}); assert.equal(whole.options[1].mode,'whole'); assert.ok(Math.abs(whole.options[1].scenarios[1].annualKwh-12*1000*0.35)<1e-9);
  assert.ok(A.checkTriple([0.1,0.2,0.3])&&!A.checkTriple([0.3,0.2,0.1])&&!A.checkTriple([0.1,0.2,1.2]));
  const conf=A.confidence({cycle:an.cycle,power:'measured',coveragePct:100,hours:1,templateOk:true,drive:{class:'fixed'}}); assert.equal(conf.level,'high');
  assert.equal(A.confidence({cycle:null,power:'estimated',coveragePct:100,hours:1,templateOk:false,drive:{class:'unknown'}}).level,'low');
  assert.equal(A.benchmarkPosition(2.2,'fixed','',A.DEFAULT_BENCHMARKS).position,'above'); assert.equal(A.benchmarkPosition(1.2,'fixed').position,'within'); assert.equal(A.benchmarkPosition(0.5,'fixed').position,'below'); assert.equal(A.benchmarkPosition(1,'unknown'),null);
  assert.deepEqual([A.pathAdvice({measures:'power',intervalMs:100}).cycleMap,A.pathAdvice({measures:'power',intervalMs:1000}).cycleMap,A.pathAdvice({measures:'power',intervalMs:4000}).cycleMap,A.pathAdvice({measures:'current',intervalMs:600000}).cycleMap],['yes','yes','limited','no']);
  assert.equal(A.pathAdvice({measures:'current',intervalMs:600000}).power,'estimated');
});

// ---------- Intake ----------
const nowMs=()=>Date.now();
const mk=async (token,body)=>(await call('/energy-audit/meters','POST',{equipmentId:'eq-a',name:'Analyzer',...body},token));
const keyFor=async (token,scopes,name='energy')=>(await call('/integration-keys','POST',{name,...(scopes?{scopes}:{})},token)).data;

test('keys: scoped, hashed, shown once, never returned again',async()=>{
  const k=await keyFor(tokens.acme,['energy']); assert.match(k.key,/^mck_/); assert.deepEqual(k.scopes,['energy']);
  const list=(await call('/integration-keys','GET',null,tokens.acme)).data; const row=list.find(x=>x.id===k.id); assert.equal(row.key,undefined); assert.equal(JSON.stringify(list).includes(k.key),false);
  const stored=await one('SELECT key_hash,key_hint FROM integration_keys WHERE id=?',k.id); assert.notEqual(stored.key_hash,k.key); assert.ok(!JSON.stringify(stored).includes(k.key.slice(8,30)));
  assert.equal((await call('/integration-keys','POST',{name:'x',scopes:['sudo']},tokens.acme)).status,400);
  assert.equal((await call('/integration-keys','POST',{name:'x'},tokens.maint)).status,403,'only the customer admin makes keys');
  const m=(await mk(tokens.maint,{})).data;
  const legacy=await keyFor(tokens.acme,null,'tickets only'); assert.deepEqual(legacy.scopes,['tickets']);
  const tt=await call('/integrations/energy-samples','POST',{meterId:m.id,samples:[{t:nowMs(),kw:5}]},null,{'x-integration-key':legacy.key}); assert.equal(tt.status,403,'a tickets key cannot send machine data');
  const ok=await call('/integrations/energy-samples','POST',{meterId:m.id,samples:[{t:nowMs(),kw:5}]},null,{'x-integration-key':k.key}); assert.equal(ok.status,201); assert.equal(ok.data.accepted,1);
  assert.ok(!JSON.stringify(ok.data).includes(k.key));
  assert.equal((await call('/integrations/energy-samples','POST',{meterId:m.id,samples:[{t:nowMs(),kw:5}]})).status,401,'no key');
  assert.equal((await call('/integrations/energy-samples','POST',{meterId:m.id,samples:[{t:nowMs(),kw:5}]},null,{'x-integration-key':'mck_'+'x'.repeat(30)})).status,401,'wrong key');
  await call(`/integration-keys/${k.id}`,'PATCH',{active:false},tokens.acme);
  assert.equal((await call('/integrations/energy-samples','POST',{meterId:m.id,samples:[{t:nowMs(),kw:5}]},null,{'x-integration-key':k.key})).status,401,'inactive key');
  // a ticket key still raises tickets only with the tickets scope
  const nt=await call('/integrations/tickets','POST',{source:'monitor'},null,{'x-integration-key':k.key}); assert.equal(nt.status,401);
});
test('intake: validation of batches, sizes, clocks, duplicates and order',async()=>{
  const key=(await keyFor(tokens.acme,['energy'],'intake')).key, h={'x-integration-key':key}, m=(await mk(tokens.maint,{name:'Intake meter'})).data;
  const post=(body)=>call('/integrations/energy-samples','POST',{meterId:m.id,...body},null,h);
  const t=nowMs()-60000;
  assert.equal((await post({samples:[]})).status,400);
  assert.equal((await post({samples:[{t,kw:-1}]})).status,400); assert.equal((await post({samples:[{t,kw:'5'}]})).status,400); assert.equal((await post({samples:[{t,pf:0.9}]})).status,400,'needs a power or current value');
  assert.equal((await post({samples:[{t,kw:5,pf:2}]})).status,400); assert.equal((await post({samples:[{t:'yesterday',kw:5}]})).status,400); assert.equal((await post({samples:[{t,kw:5},{kw:5}]})).status,400,'all samples need a time, or none');
  assert.equal((await post({samples:Array.from({length:I.LIMITS.maxBatch+1},(_,i)=>({t:t+i*100,kw:5}))})).status,400,'batch too large');
  const bad=await post({samples:[{t,kw:5},{t:t+100,kw:99999}]}); assert.equal(bad.status,400); assert.match(bad.data.error,/Sample 1/);
  assert.equal(await one('SELECT count(*) c FROM energy_samples WHERE meter_id=?',m.id).then(r=>r.c),0,'a bad batch stores nothing');
  const old=await post({samples:[{t:nowMs()-10*86400000,kw:5}]}); assert.equal(old.status,400); assert.match(old.data.error,/clock/);
  assert.equal((await post({samples:[{t:nowMs()+3600000,kw:5}]})).status,400,'from the future');
  assert.equal((await post({t0:t,dtMs:100,kw:[1,2],pf:[0.5]})).status,400,'columns must match');
  assert.equal((await post({t0:t,kw:[1,2]})).status,400,'columns need dtMs');
  // good: out of order and duplicates
  const r1=await post({samples:[{t:t+200,kw:5},{t:t,kw:6},{t:t+100,kw:7},{t:t,kw:6}]}); assert.equal(r1.status,201); assert.equal(r1.data.accepted,3); assert.equal(r1.data.duplicates,1); assert.ok(r1.data.outOfOrder>=1);
  const r2=await post({samples:[{t:t+100,kw:7}]}); assert.equal(r2.data.accepted,0); assert.equal(r2.data.duplicates,1,'a replay adds nothing');
  assert.ok(r1.data.observedIntervalMs===100&&Math.abs(r1.data.clockOffsetMs-60000)<5000,'clock offset is reported');
  // columns without times: the last sample is "now"
  const r3=await post({dtMs:100,kw:[1,2,3],pf:[0.8,0.8,0.8]}); assert.equal(r3.status,201); assert.equal(r3.data.accepted,3);
  const cs=await all('SELECT ts,rx FROM energy_samples WHERE meter_id=? AND kw IN (1,2,3) ORDER BY ts',m.id); assert.ok(cs.every(x=>x.rx>=x.ts)&&cs[2].ts-cs[0].ts===200);
  // per-phase values are combined; receive mode re-times an insane clock
  const ph=await post({samples:[{t:t+5000,v1:230,v2:231,v3:229,i1:10,i2:10,i3:10,pf1:0.9,pf2:0.9,pf3:0.9}]}); assert.equal(ph.status,201);
  assert.ok(Math.abs((await one('SELECT kw FROM energy_samples WHERE meter_id=? AND ts=?',m.id,t+5000)).kw-6.21)<0.01);
  await call(`/energy-audit/meters/${m.id}`,'PATCH',{clockMode:'receive'},tokens.maint);
  const rc=await post({samples:[{t:nowMs()-30*86400000,kw:5},{t:nowMs()-30*86400000+100,kw:6}]}); assert.equal(rc.status,201); assert.ok(rc.data.clockOffsetMs>29*86400000,'the offset of the meter clock is reported');
  const row=await one('SELECT max(ts) m FROM energy_samples WHERE meter_id=?',m.id); assert.ok(row.m>nowMs()-30000,'the batch was re-timed to its arrival');
  // another company's key cannot reach this meter
  const novaKey=(await keyFor(tokens.nova,['energy'],'nova')).key;
  assert.equal((await call('/integrations/energy-samples','POST',{meterId:m.id,samples:[{t,kw:5}]},null,{'x-integration-key':novaKey})).status,404);
  assert.equal((await call('/integrations/energy-samples','POST',{meterId:'nope',samples:[{t,kw:5}]},null,h)).status,404);
});
test('limits: per key per minute, per meter samples per second',()=>{
  const at=Date.UTC(2026,0,5,9,0,0);
  for (let i=0;i<I.LIMITS.keyPerMinute;i++) I.limitKey('k-test',at+i);
  assert.throws(()=>I.limitKey('k-test',at+1000),e=>e.status===429&&!!e.headers['retry-after']);
  I.limitKey('k-test',at+61000);
  I.limitMeter('m-test',I.LIMITS.meterBurst,at); assert.throws(()=>I.limitMeter('m-test',1200,at),e=>e.status===429);
  I.limitMeter('m-test',1200,at+60000);
});
test('LoRaWAN webhook and generic payload endpoints use the meter mapping; nothing vendor-specific is assumed',async()=>{
  const key=(await keyFor(tokens.acme,['energy'],'lora')).key, h={'x-integration-key':key};
  assert.equal((await mk(tokens.maint,{kind:'lorawan_ct',name:'no voltage'})).status,400,'current-only meters need the line voltage');
  const m=(await mk(tokens.maint,{kind:'lorawan_ct',name:'CT clamp',deviceId:'0004A30B001A2B3C',voltageV:400,assumedPf:0.8,mapping:{amps:{path:'object.i_avg'}}})).data;
  assert.equal(m.measures,'current'); assert.equal(m.advice.cycleMap,'no'); assert.equal(m.advice.power,'estimated');
  const when=new Date(nowMs()-120000).toISOString();
  const up={deviceInfo:{devEui:'0004a30b001a2b3c'},time:when,object:{i_avg:18.5}};
  // ChirpStack puts the decoded object top-level; the mapping here reads it from `object`, so the mapped path is applied to the decoded object
  const bad0=await call(`/integrations/lorawan/${m.id}`,'POST',up,null,h); assert.equal(bad0.status,400,'mapped field not found in the decoded object');
  await call(`/energy-audit/meters/${m.id}`,'PATCH',{mapping:{amps:'i_avg'}},tokens.maint);
  const ok=await call(`/integrations/lorawan/${m.id}`,'POST',up,null,h); assert.equal(ok.status,201,JSON.stringify(ok.data)); assert.equal(ok.data.accepted,1);
  const row=await one('SELECT * FROM energy_samples WHERE meter_id=?',m.id); assert.equal(row.amps,18.5); assert.equal(row.kw,null,'current is stored; power is derived and flagged at analysis time'); assert.equal(row.ts,Date.parse(when));
  assert.equal((await call(`/integrations/lorawan/${m.id}`,'POST',{...up,deviceInfo:{devEui:'ffff'}},null,h)).status,403,'another device');
  const dry=await call(`/energy-audit/meters/${m.id}/test-mapping`,'POST',{lorawan:true,payload:up},tokens.maint); assert.equal(dry.status,200); assert.equal(dry.data.stored.amps,18.5);
  // generic payloads (HTTP or an MQTT bridge): an object, or an array with a mapped time
  const g=(await mk(tokens.maint,{kind:'generic',name:'Gateway',transport:'mqtt',mapping:{time:'ts',kw:{path:'pwr.total',scale:0.001},pf:'pwr.pf'}})).data;
  const t=nowMs()-5000, one1=await call(`/integrations/energy-payload/${g.id}`,'POST',{ts:t,pwr:{total:12500,pf:0.82}},null,h); assert.equal(one1.status,201,JSON.stringify(one1.data));
  assert.equal((await one('SELECT kw FROM energy_samples WHERE meter_id=?',g.id)).kw,12.5);
  assert.equal((await call(`/integrations/energy-payload/${g.id}`,'POST',[{pwr:{total:1,pf:1}},{pwr:{total:2,pf:1}}],null,h)).status,400,'several payloads need a time');
  assert.equal((await call(`/integrations/energy-payload/${g.id}`,'POST',[{ts:t+100,pwr:{total:1,pf:1}},{ts:t+200,pwr:{total:2,pf:1}}],null,h)).status,201);
  assert.equal((await call('/energy-audit/meters','POST',{equipmentId:'eq-a',name:'x',kind:'generic',mapping:{kw:'a.__proto__'}},tokens.maint)).status,400);
});
test('rolling up: old raw samples become one-minute aggregates unless an audit window needs them',async()=>{
  const m=(await mk(tokens.maint,{name:'Rollup'})).data, long=Math.floor((Date.now()-48*HOUR)/60000)*60000;
  const rows=Array.from({length:120},(_,i)=>({ts:long+i*1000,kw:10+(i%2),pf:0.8}));
  await storeBatch(await one('SELECT * FROM energy_meters WHERE id=?',m.id),{rows,rx:long+120000,offsetMs:0,outOfOrder:0});
  const protectedRows=Array.from({length:30},(_,i)=>({ts:long+HOUR+i*1000,kw:5}));
  await storeBatch(await one('SELECT * FROM energy_meters WHERE id=?',m.id),{rows:protectedRows,rx:long+HOUR+30000,offsetMs:0,outOfOrder:0});
  const au=(await call('/energy-audits','POST',{equipmentId:'eq-a',title:'Keeps raw',meterId:m.id,massMode:'manual',manualKg:1,periodStart:new Date(long+HOUR-1000).toISOString(),periodEnd:new Date(long+HOUR+60000).toISOString()},tokens.maint)).data;
  const n=await I.rollupRaw(Date.now()); assert.equal(n,120);
  const agg=await all('SELECT * FROM energy_sample_agg WHERE meter_id=? ORDER BY ts',m.id); assert.equal(agg.length,2); assert.equal(agg.reduce((s,x)=>s+x.n,0),120); assert.equal(agg[0].kw_max,11);
  assert.equal((await one('SELECT count(*) c FROM energy_samples WHERE meter_id=?',m.id)).c,30,'the audit window keeps its raw samples');
  assert.equal((await call(`/energy-audits/${au.id}/complete`,'POST',{},tokens.maint)).status,200);
  const del=await call(`/energy-audits/${au.id}/raw`,'DELETE',null,tokens.maint); assert.equal(del.data.deleted,30);
  assert.equal((await call(`/energy-audits/${au.id}`,'GET',null,tokens.maint)).data.analysis.energy.kwh>0,true,'the stored result survives');
});

// ---------- Audits end to end, 10 Hz throughput ----------
test('an audit on a 10 Hz hour: ingest throughput, SEC, cycle map, drive, upgrade case, report in English and German',async()=>{
  const key=(await keyFor(tokens.acme,['energy'],'hz')).key, h={'x-integration-key':key};
  const m=(await mk(tokens.maint,{name:'10 Hz analyzer'})).data; assert.equal(m.nominalIntervalMs,100); assert.equal(m.advice.cycleMap,'yes');
  const end=nowMs()-120000, n=36000, start=end-n*100, tr=genTrace({startMs:start,cycles:97,warmupS:60,missing:[30],pauses:[{afterCycle:60,seconds:80}],noise:0.04,seed:11}).slice(0,n);
  const t0=performance.now(); let accepted=0, batches=0;
  for (let i=0;i<tr.length;i+=1200) { const c=tr.slice(i,i+1200), r=await call('/integrations/energy-samples','POST',{meterId:m.id,t0:c[0].ts,dtMs:100,kw:c.map(s=>s.kw),pf:c.map(s=>s.pf)},null,h); assert.equal(r.status,201,JSON.stringify(r.data)); accepted+=r.data.accepted; batches++; }
  const secs=(performance.now()-t0)/1000; assert.equal(accepted,n);
  console.log(`THROUGHPUT 10 Hz: ${n} samples in ${batches} batches, ${secs.toFixed(2)} s = ${Math.round(n/secs)} samples/s (meter limit ${I.LIMITS.meterRefillPerS}/s sustained is far below this ingest speed)`);
  assert.ok(n/secs>500,`ingest ${Math.round(n/secs)} samples/s`);
  // template for the product, then the audit over the hour
  const tp=await call('/energy-audit/templates/pr-hsg','PUT',{name:'HMI',phases:tmpl},tokens.maint); assert.equal(tp.status,200);
  assert.equal((await call('/energy-audit/templates/pr-hsg','PUT',{phases:[{name:'x',seconds:-1}]},tokens.maint)).status,400);
  assert.equal((await call('/energy-audit/templates/pr-hsg','PUT',{phases:tmpl},tokens.dispatch)).status,403);
  const body={equipmentId:'eq-a',productId:'pr-hsg',meterId:m.id,title:'Hour at 10 Hz',material:'PC/ABS',massMode:'manual',manualParts:190,nameplate:{pumpType:'fixed',motorKw:30,clampTonnes:200},assumptions:{annualHours:5000,retrofitCost:25000},periodStart:new Date(start).toISOString(),periodEnd:new Date(end).toISOString()};
  const a=await call('/energy-audits','POST',body,tokens.maint); assert.equal(a.status,201); assert.equal(a.data.status,'draft');
  const done=await call(`/energy-audits/${a.data.id}/complete`,'POST',{},tokens.maint); assert.equal(done.status,200);
  const d=done.data, an=d.analysis, kwh=tr.reduce((s,x,i)=>i?s+(x.kw+tr[i-1].kw)/2*0.1/3600:s,0);
  assert.equal(d.status,'completed'); assert.ok(Math.abs(an.energy.kwh-kwh)/kwh<0.002,`kwh ${an.energy.kwh} vs ${kwh}`); assert.equal(an.data.power,'measured'); assert.equal(an.data.medianStepMs,100);
  assert.ok(Math.abs(an.output.goodKg-190*0.038)<1e-9); assert.ok(Math.abs(an.sec.kwhPerKg-an.energy.kwh/(190*0.038))<1e-3);
  console.log(`CYCLE MAP 10 Hz: cycle time ${an.cycle.cycleTimeS} s (true 37.0), ${an.cycle.count} cycles used of ${an.cycle.candidates} candidates (96 real), rejected ${JSON.stringify(an.cycle.rejected)}, resolution ${an.cycle.resolutionS} s, drive ${an.drive.class}/${an.drive.level}`);
  assert.ok(Math.abs(an.cycle.cycleTimeS-37)<0.15); assert.ok(an.cycle.count>=88&&an.cycle.count<=95);
  assert.equal(d.drive.effective.class,'fixed'); assert.equal(d.drive.inferred.class,'fixed'); assert.equal(d.benchmark.position,'above');
  const hold=an.phases.rows.find(p=>p.name==='Holding'), cool=an.phases.rows.find(p=>p.name==='Cooling'); assert.ok(hold.waste&&cool.waste,'holding and cooling flagged on a fixed pump');
  assert.ok(Math.abs(an.phases.rows.reduce((s,p)=>s+p.kwh,0)-an.cycle.cycleKwh)<1e-3);
  assert.equal(d.proposal.status,'ok'); assert.ok(d.proposal.options[1].scenarios.every(s=>s.paybackYears>0)); assert.equal(d.confidence.level,'high');
  assert.ok(an.idle&&an.idle.sharePct>0,'idle between cycles estimated from the trace');
  // override: an engineer who says it is already a servo pump gets "no upgrade case"
  const ov=await call(`/energy-audits/${a.data.id}`,'PATCH',{assumptions:{driveOverride:'servo_hydraulic'}},tokens.maint); assert.equal(ov.data.proposal.status,'efficient'); assert.equal(ov.data.drive.mismatch,'fixed');
  assert.equal((await call(`/energy-audits/${a.data.id}`,'PATCH',{assumptions:{driveOverride:'fixed'}},tokens.maint)).data.proposal.status,'ok');
  // edits recompute a completed audit
  const ed=await call(`/energy-audits/${a.data.id}`,'PATCH',{manualParts:380},tokens.maint); assert.ok(Math.abs(ed.data.analysis.sec.kwhPerKg-an.sec.kwhPerKg/2)<0.01);
  // reports
  for (const [lang,needle] of [['en','Energy audit'],['de','Energie-Audit']]) {
    const r=await fetch(`${base}/api/energy-audits/${a.data.id}/report?lang=${lang}`,{headers:{authorization:`Bearer ${tokens.maint}`}}); const html=await r.text();
    assert.equal(r.status,200); assert.match(r.headers.get('content-type'),/text\/html/); assert.ok(html.includes(needle)); assert.ok(html.includes('<svg')); assert.ok(!html.includes('<script')); assert.ok(!html.includes('mck_'));
    assert.match(r.headers.get('content-security-policy'),/default-src 'none'/);
  }
  const de=await (await fetch(`${base}/api/energy-audits/${a.data.id}/report?lang=de`,{headers:{authorization:`Bearer ${tokens.maint}`}})).text(); assert.ok(de.includes('Annahmen')&&de.includes('Einschränkungen')&&de.includes('Haltedruck')===false);
  assert.equal((await fetch(`${base}/api/energy-audits/${a.data.id}/report?lang=fr`,{headers:{authorization:`Bearer ${tokens.maint}`}})).status,400);
  assert.equal((await fetch(`${base}/api/energy-audits/${a.data.id}/report`,{headers:{authorization:`Bearer ${tokens.nova}`}})).status,403);
  const csv=await (await fetch(`${base}/api/energy-audits/${a.data.id}/raw.csv`,{headers:{authorization:`Bearer ${tokens.maint}`}})).text(); assert.ok(csv.split('\n').length>n*0.99); assert.ok(csv.startsWith('time_utc,kw'));
  assert.ok((await all("SELECT 1 FROM audit_events WHERE entity_id=? AND action IN ('energy_audit.report','energy_audit.complete','energy_audit.export_raw')",a.data.id)).length>=3,'audited');
});

// ---------- Tenancy and roles ----------
test('tenancy and roles: write for platform admin, customer admin, plant manager and maintenance; read for dispatch; nothing across companies',async()=>{
  const body={equipmentId:'eq-a',title:'Role test',massMode:'manual',manualKg:2};
  const a=await call('/energy-audits','POST',body,tokens.maint); assert.equal(a.status,201);
  assert.equal((await call('/energy-audits','POST',body,tokens.acme)).status,201); assert.equal((await call('/energy-audits','POST',body,tokens.admin)).status,201);
  assert.equal((await call('/energy-audits','POST',body,tokens.dispatch)).status,403,'dispatch reads only'); assert.equal((await call('/energy-audits','POST',body,tokens.engineer)).status,403); assert.equal((await call('/energy-audits','POST',body,tokens.atlas)).status,403);
  assert.equal((await call('/energy-audits','POST',body,tokens.nova)).status,400,'another company\'s machine is refused');
  assert.equal((await call('/energy-audits','POST',{...body,equipmentId:'eq-n'},tokens.nova)).status,400,'extruders are not audited here');
  assert.equal((await call('/energy-audits','POST',{...body,productId:'pr-cmp'},tokens.maint)).status,400,'a product of another company');
  assert.equal((await call(`/energy-audits/${a.data.id}`,'GET',null,tokens.dispatch)).status,200);
  for (const t of ['nova','atlas','engineer']) assert.equal((await call(`/energy-audits/${a.data.id}`,'GET',null,tokens[t])).status,403,t);
  assert.equal((await call(`/energy-audits/${a.data.id}`,'PATCH',{notes:'x'},tokens.dispatch)).status,403); assert.equal((await call(`/energy-audits/${a.data.id}`,'PATCH',{notes:'x'},tokens.nova)).status,403);
  assert.equal((await call(`/energy-audits/${a.data.id}/start`,'POST',{},tokens.dispatch)).status,403);
  const list=await call('/energy-audits','GET',null,tokens.nova); assert.equal(list.status,200); assert.ok(list.data.every(x=>x.companyId==='c-nova')); assert.equal((await call('/energy-audits','GET',null,tokens.dispatch)).data.some(x=>x.title==='Role test'),true);
  assert.equal((await call('/energy-audit/meters','GET',null,tokens.nova)).data.length,0);
  const mid=(await mk(tokens.maint,{name:'Tenancy'})).data.id;
  assert.equal((await call(`/energy-audit/meters/${mid}`,'GET',null,tokens.nova)).status,403); assert.equal((await call(`/energy-audit/meters/${mid}`,'PATCH',{name:'z'},tokens.dispatch)).status,403);
  assert.equal((await call(`/energy-audit/meters/${mid}/relay`,'POST',{samples:[{t:nowMs(),kw:3}]},tokens.nova)).status,403); assert.equal((await call(`/energy-audit/meters/${mid}/relay`,'POST',{samples:[{t:nowMs(),kw:3}]},tokens.maint)).status,201);
  assert.equal((await call('/energy-audits','POST',{...body,meterId:mid},tokens.maint)).status,201); assert.equal((await call('/energy-audits','POST',{...body,equipmentId:'eq-a2',meterId:mid},tokens.maint)).status,400,'a meter of another machine');
  // company tables
  assert.equal((await call('/energy-audit/config','GET',null,tokens.maint)).data.canManage,false);
  assert.equal((await call('/energy-audit/config','PUT',{materials:['PP']},tokens.maint)).status,403);
  const cfg=await call('/energy-audit/config','PUT',{materials:['PP','ZZ-Mat'],benchmarks:[{driveType:'fixed',material:'',low:1,high:2,note:'ours'}]},tokens.acme); assert.equal(cfg.status,200); assert.deepEqual(cfg.data.materials,['PP','ZZ-Mat']); assert.equal(cfg.data.defaults.benchmarks,false);
  assert.equal((await call('/energy-audit/config','PUT',{benchmarks:[{driveType:'fixed',low:2,high:1}]},tokens.acme)).status,400); assert.equal((await call('/energy-audit/config','PUT',{factors:{'fixed>servo':{holding:[0.9,0.5,0.1]}}},tokens.acme)).status,400);
  assert.equal((await call('/energy-audit/config','PUT',{factors:{'fixed>servo':{holding:[0.1,0.2,0.3]}}},tokens.acme)).data.factors['fixed>servo'].holding[1],0.2);
  assert.equal((await call('/energy-audit/config','GET',null,tokens.nova)).data.materials.includes('ZZ-Mat'),false,'the other company keeps the defaults');
  await call('/energy-audit/config','PUT',{materials:null,benchmarks:null,factors:null},tokens.acme);
  assert.equal((await call('/energy-audit/config','GET',null,tokens.acme)).data.defaults.benchmarks,true);
  assert.equal((await call('/energy-audit/config?companyId=c-acme','GET',null,tokens.nova)).status,403);
});
test('a test run: one at a time per machine, not stopped too early; photos attach to the audit and stay private',async()=>{
  const a=(await call('/energy-audits','POST',{equipmentId:'eq-a',title:'Live run',massMode:'manual',manualKg:1},tokens.maint)).data;
  const s=await call(`/energy-audits/${a.id}/start`,'POST',{},tokens.maint); assert.equal(s.status,200); assert.equal(s.data.status,'running');
  const b=(await call('/energy-audits','POST',{equipmentId:'eq-a',title:'Second',massMode:'manual',manualKg:1},tokens.maint)).data;
  assert.equal((await call(`/energy-audits/${b.id}/start`,'POST',{},tokens.maint)).status,400,'one test run per machine');
  assert.equal((await call(`/energy-audits/${a.id}/stop`,'POST',{},tokens.maint)).status,400,'at least ten seconds');
  assert.equal((await call(`/energy-audits/${a.id}`,'PATCH',{periodStart:new Date().toISOString()},tokens.maint)).status,400);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const up=await call('/attachments','POST',{entityType:'energy_audit',entityId:a.id,kind:'photo',filename:'nameplate.png',mime:'image/png',base64:png},tokens.maint); assert.equal(up.status,201);
  assert.equal((await call('/attachments','POST',{entityType:'energy_audit',entityId:a.id,kind:'photo',filename:'x.png',mime:'image/png',base64:png},tokens.nova)).status,403);
  assert.equal((await call('/attachments','POST',{entityType:'energy_audit',entityId:a.id,kind:'photo',filename:'x.png',mime:'image/png',base64:png},tokens.dispatch)).status,403);
  assert.equal((await fetch(`${base}/api/attachments/${up.data.id}`,{headers:{authorization:`Bearer ${tokens.nova}`}})).status,403); assert.equal((await fetch(`${base}/api/attachments/${up.data.id}`,{headers:{authorization:`Bearer ${tokens.maint}`}})).status,200);
  assert.equal((await call(`/energy-audits/${a.id}`,'GET',null,tokens.maint)).data.photos.length,1);
  assert.equal((await call(`/energy-audits/${a.id}/cancel`,'POST',{},tokens.maint)).data.status,'cancelled');
});
test('interval readings without a meter: SEC from energy_readings and idle share from machine states',async()=>{
  const e=(await call('/equipment','POST',equipmentBody('plant-a','injection'),tokens.acme)).data;
  const from=Date.UTC(2026,0,5,6,0,0);
  for (let i=0;i<8;i++) await run('INSERT INTO energy_readings (equipment_id,period_start,period_minutes,kwh,peak_kw,company_id,source) VALUES (?,?,?,?,?,?,?)',e.id,new Date(from+i*900000).toISOString(),15,i<4?5:2,25,'c-acme','test');
  await run("INSERT INTO machine_states (id,company_id,equipment_id,state,started_at,ended_at,source) VALUES (?,?,?,?,?,?,?)",crypto.randomUUID(),'c-acme',e.id,'running',new Date(from).toISOString(),new Date(from+3600000).toISOString(),'test');
  await run("INSERT INTO machine_states (id,company_id,equipment_id,state,started_at,ended_at,source) VALUES (?,?,?,?,?,?,?)",crypto.randomUUID(),'c-acme',e.id,'idle',new Date(from+3600000).toISOString(),new Date(from+7200000).toISOString(),'test');
  const a=(await call('/energy-audits','POST',{equipmentId:e.id,title:'Readings',massMode:'manual',manualKg:20,periodStart:new Date(from).toISOString(),periodEnd:new Date(from+7200000).toISOString()},tokens.acme)).data;
  assert.equal(a.advice.cycleMap,'no'); assert.equal(a.advice.sec,true);
  const d=(await call(`/energy-audits/${a.id}/complete`,'POST',{},tokens.acme)).data;
  assert.equal(d.analysis.energy.kwh,28); assert.equal(d.analysis.sec.kwhPerKg,1.4); assert.ok(Math.abs(d.analysis.idle.sharePct-100*8/28)<0.1); assert.equal(d.analysis.cycle,null); assert.equal(d.proposal.status,'unknown_drive'); assert.equal(d.confidence.level,'low');
  const set=await call(`/energy-audits/${a.id}`,'PATCH',{nameplate:{pumpType:'fixed'},assumptions:{annualHours:4000,retrofitCost:10000}},tokens.acme); assert.equal(set.data.proposal.options[1].mode,'whole'); assert.ok(set.data.proposal.options[1].scenarios[1].annualKwh>0);
});
test('Bluetooth decoder config is validated (experimental, generic)',async()=>{
  const ok={serviceUuid:'0000ffe0-0000-1000-8000-00805f9b34fb',characteristicUuid:'ffe1',sampleIntervalMs:100,decoder:{fields:[{name:'kw',offset:0,type:'float32',endian:'le',scale:1},{name:'pf',offset:4,type:'uint16',endian:'be',scale:0.001}]}};
  const m=await mk(tokens.maint,{name:'BLE',transport:'ble',bleConfig:ok}); assert.equal(m.status,201); assert.equal(m.data.bleConfig.experimental,true);
  assert.equal((await mk(tokens.maint,{name:'BLE2',transport:'ble',bleConfig:{...ok,serviceUuid:'not a uuid'}})).status,400);
  assert.equal((await mk(tokens.maint,{name:'BLE3',transport:'ble',bleConfig:{...ok,decoder:{fields:[{name:'rm -rf',offset:0,type:'float32'}]}}})).status,400);
});

test('the generic Bluetooth decoder reads the configured byte layout (experimental, no vendor profile)',async()=>{
  const { decodeNotification, uuidOf }=await import('../../frontend/shared/ble-decode.js');
  const buf=new ArrayBuffer(8), v=new DataView(buf); v.setFloat32(0,12.5,true); v.setUint16(4,812,false);
  const out=decodeNotification(v,[{name:'kw',offset:0,type:'float32',endian:'le',scale:1},{name:'pf',offset:4,type:'uint16',endian:'be',scale:0.001}]);
  assert.ok(Math.abs(out.kw-12.5)<1e-6&&Math.abs(out.pf-0.812)<1e-9);
  assert.equal(decodeNotification(v,[{name:'kw',offset:6,type:'float32',endian:'le'}]),null,'a layout past the end of the notification is refused');
  assert.equal(uuidOf('ffe0'),0xffe0);
});
