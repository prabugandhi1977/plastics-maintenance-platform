// Deterministic mock machine-data API. It deliberately uses a vendor-style payload (not the canonical shape) so the
// toCanonical mapping step is exercised the same way the real adapter's will be. Scenarios covered:
//   demo-device-a  Acme injection press: reports every 5 min; alarm E-204 raises and clears on a cycle.
//   demo-device-n  Nova extruder: stopped reporting 2 h ago (stale); no cycle counter (missing metric); alarm T-302 held.
//   demo-device-x  Not mapped to any asset (rejected and quarantined), first batch only.
//   malformed      Implausible temperature (rejected and quarantined), first batch only.
const STEP=5*60*1000, EPOCH=Date.parse('2026-01-01T00:00:00Z'), BACKFILL=6*60*60*1000, MAX_SLOTS=144;
const DEVICES=[
  {id:'demo-device-a',lag:0,hours:4000,cyclesPerStep:150,cycles:120000,melt:38},
  {id:'demo-device-n',lag:2*60*60*1000,hours:9000,cyclesPerStep:null,melt:86}
];

function vendorRecord(device,t) {
  const k=Math.floor((t-EPOCH)/STEP), alarms=[];
  if (device.id==='demo-device-a' && k%24===0) alarms.push({code:'E-204',active:true,level:'WARN',text:'Hydraulic pressure below setpoint'});
  if (device.id==='demo-device-a' && k%24===3) alarms.push({code:'E-204',active:false,level:'WARN'});
  if (device.id==='demo-device-n') alarms.push({code:'T-302',active:true,level:'CRIT',text:'Barrel zone 3 over temperature'});
  return {device:{id:device.id},ts:new Date(t).toISOString(),metrics:{run_hours:Math.round((device.hours+(t-EPOCH)/3600000)*10)/10,...(device.cyclesPerStep?{cycles:device.cycles+k*device.cyclesPerStep}:{}),melt_temp_c:Math.round((device.melt+Math.sin(k/6)*1.5)*10)/10},alarms};
}

export function createMockAdapter(env,{clock=()=>Date.now()}={}) {
  return {
    name:'mock',
    async fetchBatch(cursor) {
      const nowMs=clock(), end=Math.floor(nowMs/STEP)*STEP, start=cursor?Date.parse(cursor)+STEP:Math.floor((nowMs-BACKFILL)/STEP)*STEP;
      const records=[]; let t=start, slots=0;
      for (; t<=end && slots<MAX_SLOTS; t+=STEP, slots++) for (const d of DEVICES) if (t<=nowMs-d.lag) records.push(vendorRecord(d,t));
      if (!cursor) records.push({device:{id:'demo-device-x'},ts:new Date(end).toISOString(),metrics:{run_hours:10},alarms:[]},{device:{id:'demo-device-a'},ts:new Date(end-STEP/2).toISOString(),metrics:{melt_temp_c:-999},alarms:[]});
      const last=t-STEP;
      return {records,nextCursor:last>=start?new Date(last).toISOString():cursor,hasMore:t<=end};
    },
    toCanonical(raw) {
      if (!raw?.device?.id || !raw.ts) throw new Error('vendor record missing device.id or ts');
      const m=raw.metrics||{};
      return {deviceId:raw.device.id,observedAt:raw.ts,runningHours:m.run_hours??null,cycleCount:m.cycles??null,temperatureC:m.melt_temp_c??null,
        alarms:(raw.alarms||[]).map(a=>({code:a.code,state:a.active?'active':'cleared',severity:{INFO:'info',WARN:'warning',CRIT:'critical'}[a.level]??'warning',message:a.text||''}))};
    }
  };
}
