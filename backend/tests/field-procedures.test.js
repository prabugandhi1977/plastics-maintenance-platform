import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcedures } from '../../frontend/mobile/procedures.js';

// The field app's offline step logic (frontend/mobile/procedures.js): what is checked on the device before an action is queued
// (a refused queued action would stop the queue), how the cached copy shows a queued step, and when the job can be closed.
const P=createProcedures({safe:v=>String(v??''),t:k=>k,_t:(k,v)=>k+(v?JSON.stringify(v):''),formatNumber:n=>String(n),formatDateTime:x=>x,zone:()=>'UTC'});
const ticket=()=>({status:'in_progress',procedures:[{id:'r',title:'Tie-bar',version:1,status:'in_progress',steps:[
  {id:'a',position:1,title:'Lock out',mandatory:true,status:'pending'},
  {id:'b',position:2,title:'Torque',mandatory:true,status:'pending',measurement:{name:'Torque',min:1400,max:1500}},
  {id:'c',position:3,title:'Wipe',mandatory:false,status:'pending'}]}]});
const form=o=>({get:k=>o[k]??null});

test('a step is checked on the device with the same rules as the server before it is queued',async()=>{
  const [, torque, wipe]=ticket().procedures[0].steps;
  assert.match((await P.prepare('step',torque,form({measurementValue:'1300'}))).error,/prc\.valueOutside/,'outside the limits needs a deviation note');
  assert.match((await P.prepare('step',torque,form({measurementValue:''}))).error,/prc\.enterValue/);
  const out=await P.prepare('step',torque,form({measurementValue:'1300',deviation:'wrench limit'})); assert.deepEqual([out.body.status,out.body.measurementValue,out.local.inRange],['done',1300,false]);
  assert.equal((await P.prepare('step',torque,form({measurementValue:'1450'}))).local.inRange,true);
  assert.ok((await P.prepare('skip',wipe,form({note:''}))).error,'a skipped step says why');
  assert.equal((await P.prepare('skip',wipe,form({note:'clean'}))).body.status,'skipped');
  const photoStep={id:'p',title:'Photo',mandatory:true,status:'pending',requiresPhoto:true};
  assert.match((await P.prepare('step',photoStep,form({}))).error,/prc\.photoNeeded/);
  assert.match((await P.prepare('step',photoStep,form({file:{size:6*1024*1024,name:'x.jpg',type:'image/jpeg'}}))).error,/photoExceeds5Mb/);
});

test('a queued step shows at once on the cached ticket, the run follows, and the job cannot be closed while a mandatory step is open',()=>{
  const tk=ticket();
  assert.deepEqual(P.openSteps(tk),['Tie-bar: Lock out','Tie-bar: Torque']);
  P.applyLocal(tk,'a',{status:'done',note:''},'u1'); assert.equal(tk.procedures[0].status,'in_progress'); assert.equal(tk.procedures[0].steps[0].pending,true); assert.equal(tk.procedures[0].steps[0].completedBy,'u1');
  P.applyLocal(tk,'b',{status:'done',measurementValue:1450,inRange:true},'u1'); assert.equal(tk.procedures[0].status,'completed'); assert.deepEqual(P.openSteps(tk),[]);
  P.applyLocal(tk,'a',{status:'pending'},'u1'); assert.equal(tk.procedures[0].status,'in_progress'); assert.equal(tk.procedures[0].steps[0].completedAt,null); assert.deepEqual(P.openSteps(tk),['Tie-bar: Lock out']);
});

test('who can record steps, and when',()=>{
  assert.equal(P.canRecord({status:'assigned'},'engineer'),false,'accept the job first');
  assert.equal(P.canRecord({status:'accepted'},'engineer'),true); assert.equal(P.canRecord({status:'escalated'},'provider_engineer'),true);
  assert.equal(P.canRecord({status:'accepted'},'maintenance'),false,'customers do not record steps');
  assert.equal(P.canAdd({status:'completed'},'engineer'),false); assert.equal(P.canAdd({status:'open'},'dispatcher'),true);
});
