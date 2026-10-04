// Demo data for the traceability suite on the demo companies: product rules (customer, warranty, packing, process
// window, check sheets), gate results, process readings with one open deviation, box and pallet labels, shipments,
// and field returns (genuine, duplicate and counterfeit claims). Runs once per database, on new and existing demos.
import { id, one, all, run, transaction } from '../common/db.js';
import { rand } from '../services/factory/simulator.js';

const iso=ms=>new Date(ms).toISOString();
const SHEETS={
  'pr-cap':{first_article:[{label:'Thread gauge PCO1881 – go/no-go',type:'ok'},{label:'Part weight',type:'measure',min:2.0,max:2.2,unit:'g'},{label:'Tamper band complete on all 24 cavities',type:'ok'}],
    final_qc:[{label:'Visual – no short shot, flash or black specks (AQL 125 pcs)',type:'ok'},{label:'Removal torque',type:'measure',min:1.2,max:2.0,unit:'Nm'},{label:'Leak test 10 bottles – leaking',type:'measure',max:0,unit:'pcs'}],
    packaging:[{label:'Label matches box contents',type:'ok'},{label:'Carton sealed, no damage',type:'ok'}]},
  'pr-hsg':{first_article:[{label:'Snap-fit clips present (4)',type:'ok'},{label:'Wall thickness at rib',type:'measure',min:1.9,max:2.1,unit:'mm'},{label:'Flatness of mounting face',type:'measure',max:0.3,unit:'mm'}],
    in_process:[{label:'Visual – sink marks on class A face',type:'ok'},{label:'Boss inner diameter',type:'measure',min:3.95,max:4.05,unit:'mm'}],
    final_qc:[{label:'Visual – class A face (VDA 16)',type:'ok'},{label:'Colour ΔE against master',type:'measure',max:1.0,unit:'ΔE'},{label:'Glow-wire test sample passed',type:'ok'}],
    packaging:[{label:'KLT label (VDA 4902) matches',type:'ok'},{label:'Parts per KLT',type:'measure',min:40,max:40,unit:'pcs'}]},
  'pr-btl':{first_article:[{label:'Bottle weight',type:'measure',min:41,max:43,unit:'g'},{label:'Neck finish gauge',type:'ok'}],final_qc:[{label:'Top-load test',type:'measure',min:180,unit:'N'},{label:'Leak test',type:'ok'}]},
  'pr-cmp':{final_qc:[{label:'MFR (230 °C / 2.16 kg)',type:'measure',min:8,max:12,unit:'g/10 min'},{label:'Glass content (ash)',type:'measure',min:29,max:31,unit:'%'}]},
  'pr-pipe':{first_article:[{label:'Outside diameter',type:'measure',min:110.0,max:110.7,unit:'mm'},{label:'Wall thickness',type:'measure',min:10.0,max:11.1,unit:'mm'}],final_qc:[{label:'Marking legible (EN 12201)',type:'ok'},{label:'Ovality',type:'measure',max:2.2,unit:'mm'}]}};
const WINDOWS={
  'pr-cap':{meltTempC:{min:220,max:240},mouldTempC:{min:30,max:40},injectionPressureBar:{min:900,max:1000},holdPressureBar:{min:480,max:560},cycleTimeS:{min:4.6,max:5.2}},
  'pr-hsg':{meltTempC:{min:255,max:275},mouldTempC:{min:75,max:85},injectionPressureBar:{min:1100,max:1200},holdPressureBar:{min:620,max:680},cycleTimeS:{min:31.5,max:33.5}},
  'pr-btl':{parisonTempC:{min:188,max:202},blowPressureBar:{min:6.5,max:7.5},cycleTimeS:{min:13.8,max:15}},
  'pr-cmp':{meltTempC:{min:228,max:242},screwRpm:{min:420,max:480},meltPressureBar:{min:38,max:52},lineSpeedMMin:{min:25,max:31}},
  'pr-pipe':{meltTempC:{min:205,max:220},screwRpm:{min:85,max:105},meltPressureBar:{min:180,max:230},lineSpeedMMin:{min:1.6,max:2.2}}};
const RULES={'pr-cap':['FreshDrinks Bottling',24,5000,0],'pr-hsg':['Meridian Automotive',36,40,1],'pr-btl':['CleanHome Products',12,250,0],'pr-cmp':['Rhein Automotive Parts',24,1000,1],'pr-pipe':['BauRohr Handel',120,300,0]};

export function seedTraceSuite(inTransaction=false) {
  if (!one("SELECT 1 FROM products WHERE id='pr-cap'")||!one("SELECT 1 FROM batches WHERE id='b-cap1'")||one('SELECT 1 FROM trace_units LIMIT 1')) return false;
  const work=()=>{
    const users=Object.fromEntries(all("SELECT id,company_id FROM users WHERE role IN ('customer_admin','plant_manager','maintenance') ORDER BY role").reverse().map(u=>[u.company_id,u.id]));
    for (const [pid,[customer,warranty,pack,hold]] of Object.entries(RULES)) run('UPDATE products SET customer=?,warranty_months=?,pack_qty=?,process_window=?,check_sheets=?,hold_on_deviation=? WHERE id=?',customer,warranty,pack,JSON.stringify(WINDOWS[pid]),JSON.stringify(SHEETS[pid]),hold,pid);
    // Finished batches carry their counted output (good and scrap), as entered at completion.
    run("UPDATE batches SET good_qty=round(planned_qty*(0.955+0.02*((length(batch_number)%3))),0),scrap_qty=round(planned_qty*0.012,0) WHERE status IN ('completed','released') AND good_qty IS NULL");
    const batches=all('SELECT * FROM batches ORDER BY started_at');
    for (const b of batches) {
      const by=users[b.company_id]; if (!by) continue;
      run('UPDATE batches SET started_by=? WHERE id=?',by,b.id);
      const sheets=SHEETS[b.product_id]||{}, win=WINDOWS[b.product_id]||{}, start=Date.parse(b.started_at), end=b.ended_at?Date.parse(b.ended_at):Date.now();
      // Gate results: first article at the start; final QC and packaging for released batches.
      const pass=(gate,at)=>run('INSERT INTO batch_checks (id,company_id,batch_id,gate,result,answers,note,checked_by,checked_at) VALUES (?,?,?,?,?,?,?,?,?)',id(),b.company_id,b.id,gate,'pass',
        JSON.stringify(sheets[gate].map((it,i)=>it.type==='ok'?{label:it.label,ok:true}:{label:it.label,value:it.min!=null&&it.max!=null?Math.round((it.min+(it.max-it.min)*(0.35+0.3*rand(b.id,gate,i)))*100)/100:it.max!=null?Math.round(it.max*0.6*100)/100:Math.round(it.min*1.15),unit:it.unit,min:it.min??null,max:it.max??null,ok:true})),'',by,iso(at));
      if (sheets.first_article) pass('first_article',start+40*60000);
      if (sheets.in_process) pass('in_process',start+(end-start)/2);
      if (b.status==='released') { if (sheets.final_qc) pass('final_qc',end+60*60000); if (sheets.packaging) pass('packaging',end+90*60000); run('UPDATE batches SET released_by=?,released_at=? WHERE id=?',by,iso(end+2*3600000),b.id); }
      // Process readings every 30 minutes around the centre of the window, within it.
      const params=JSON.parse(b.process_params||'{}');
      for (let t=start, i=0; t<=end; t+=30*60000, i++) for (const [k,v] of Object.entries(params)) { const w=win[k]; const span=w?(w.max-w.min):v*0.04;
        run('INSERT OR IGNORE INTO process_readings (batch_id,observed_at,parameter,value,source) VALUES (?,?,?,?,?)',b.id,iso(t),k,Math.round((v+(rand(b.id,k,i)-0.5)*span*0.35)*100)/100,'machine'); }
    }
    // One deviation: melt temperature on the housing batch awaiting release (an open decision blocks its release).
    const hsg=one("SELECT * FROM batches WHERE id='b-hsg2'");
    if (hsg) { const t=Date.parse(hsg.started_at)+20*3600000;
      for (const [dt,v] of [[0,281.5],[30,283.2],[60,279.8]]) run('INSERT OR REPLACE INTO process_readings (batch_id,observed_at,parameter,value,source) VALUES (?,?,?,?,?)',hsg.id,iso(t+dt*60000),'meltTempC',v,'machine');
      run('INSERT INTO process_deviations (id,company_id,batch_id,parameter,value,min,max,started_at,ended_at,readings,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)','dev-hsg2-melt','c-acme',hsg.id,'meltTempC',283.2,255,275,iso(t),iso(t+90*60000),3,'open'); }

    // Labels: boxes for released and completed batches (pallets of 10 boxes for closures), shipments, returns.
    const box=(b,n,qty,status='packed')=>Array.from({length:n},(_,i)=>{ const key=id(), serial=`${b.batch_number}-${String(i+1).padStart(4,'0')}`; run('INSERT INTO trace_units (id,company_id,batch_id,serial,kind,quantity,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',key,b.company_id,b.id,serial,'box',qty,status,users[b.company_id],iso(Date.parse(b.ended_at||b.started_at)+3600000*(1+i/n))); return {id:key,serial}; });
    const pallet=(b,boxes,n)=>{ const key=id(), serial=`PAL-${b.batch_number.slice(2)}-${String(n).padStart(2,'0')}`; run('INSERT INTO trace_units (id,company_id,batch_id,serial,kind,quantity,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',key,b.company_id,b.id,serial,'pallet',0,'packed',users[b.company_id],iso(Date.parse(b.ended_at)+4*3600000));
      for (const x of boxes) run('UPDATE trace_units SET parent_id=? WHERE id=?',key,x.id); run('UPDATE trace_units SET quantity=(SELECT sum(quantity) FROM trace_units WHERE parent_id=?) WHERE id=?',key,key); return key; };
    const ship=(company,number,customer,channel,dest,po,daysAgo,unitIds,status='shipped')=>{ const key=id(); run('INSERT INTO shipments (id,company_id,shipment_number,customer,channel,destination,customer_po,status,shipped_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',key,company,number,customer,channel,dest,po,status,status==='shipped'?iso(Date.now()-daysAgo*86400000):null,users[company],iso(Date.now()-daysAgo*86400000-3600000));
      for (const u of unitIds) { run('UPDATE trace_units SET shipment_id=?,status=? WHERE id=? OR parent_id=?',key,status==='shipped'?'shipped':'packed',u,u); } return key; };
    const B=k=>one('SELECT * FROM batches WHERE id=?',k);
    const cap1=box(B('b-cap1'),40,5000), cap2=box(B('b-cap2'),30,5000);
    const p1=pallet(B('b-cap1'),cap1.slice(0,10),1), p2=pallet(B('b-cap1'),cap1.slice(10,20),2), p3=pallet(B('b-cap1'),cap1.slice(20,30),3);
    ship('c-acme','DN-2026-00041','FreshDrinks Bottling','oem','Filling plant Springfield, dock 3','PO-FD-88123',3.6,[p1,p2]);
    ship('c-acme','DN-2026-00044','FreshDrinks Bottling','oem','Filling plant Rockford','PO-FD-88177',2.2,[p3]);
    const hsg1=box(B('b-hsg1'),60,40), hsg2=box(B('b-hsg2'),50,40);
    ship('c-acme','DN-2026-00042','Meridian Automotive','tier1','Assembly line 2, Detroit','PO-MA-55410',3.1,hsg1.slice(0,30).map(x=>x.id));
    ship('c-acme','DN-2026-00045','Meridian Automotive','tier1','Service parts warehouse, Toledo','PO-MA-55502',1.9,hsg1.slice(30,45).map(x=>x.id));
    const btl1=box(B('b-btl1'),40,250); ship('c-acme','DN-2026-00043','CleanHome Products','distributor','Regional DC Chicago','PO-CH-2207',2.8,btl1.slice(0,24).map(x=>x.id));
    ship('c-acme','DN-2026-00046','FreshDrinks Bottling','oem','Filling plant Springfield, dock 1','PO-FD-88201',0,cap1.slice(30,34).map(x=>x.id),'loading');
    const cmp1=box(B('b-cmp1'),25,1000); ship('c-nova','LS-2026-0311','Rhein Automotive Parts','tier1','Werk Mannheim','BE-4471',3,cmp1.slice(0,18).map(x=>x.id));
    const pipe1=box(B('b-pipe1'),30,300); ship('c-nova','LS-2026-0312','BauRohr Handel','distributor','Lager Duisburg','BE-9915',2.5,pipe1.slice(0,20).map(x=>x.id));
    void cap2; void hsg2;
    // Field returns: genuine warranty claims on the housing, a duplicate claim, a counterfeit label, a closure complaint.
    const ret=(company,ref,kind,customer,serial,batchId,qty,defect,desc,days,auth,checks,status='open',cause=null,action=null)=>{ const u=serial?one('SELECT id FROM trace_units WHERE serial=?',serial):null;
      run('INSERT INTO field_returns (id,company_id,reference,kind,customer,serial,unit_id,batch_id,quantity,defect,description,reported_at,authenticity,checks,status,root_cause,corrective_action,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id(),company,ref,kind,customer,serial||'',u?.id??null,batchId,qty,defect,desc,iso(Date.now()-days*86400000),auth,JSON.stringify(checks),status,cause,action,users[company],iso(Date.now()-days*86400000));
      if (u) run("UPDATE trace_units SET status='returned' WHERE id=?",u.id); };
    const ok=(c,d)=>({check:c,ok:true,detail:d}), no=(c,d)=>({check:c,ok:false,detail:d});
    ret('c-acme','FR-2026-0001','warranty_claim','Meridian Automotive',hsg1[3].serial,'b-hsg1',3,'Cracked snap-fit clip','3 housings with a cracked clip found at vehicle assembly; parts attached.',1.5,'genuine',[ok('Label is one of ours',`box ${hsg1[3].serial}`),ok('Made in a released batch','Batch B-HSG-2026-041 (released)'),ok('Shipped by us','DN-2026-00042'),ok('Shipped to this customer','Shipped to Meridian Automotive (Tier-1 supplier)'),ok('Within warranty','36 months from shipment'),ok('Not claimed before','First claim for this label')]);
    ret('c-acme','FR-2026-0002','warranty_claim','Meridian Automotive',hsg1[11].serial,'b-hsg1',2,'Cracked snap-fit clip','Same failure, second line.',0.9,'genuine',[ok('Label is one of ours',`box ${hsg1[11].serial}`),ok('Made in a released batch','Batch B-HSG-2026-041 (released)'),ok('Shipped by us','DN-2026-00042'),ok('Shipped to this customer','Shipped to Meridian Automotive (Tier-1 supplier)'),ok('Within warranty','36 months from shipment'),ok('Not claimed before','First claim for this label')],'accepted','Clip root radius too small for the PC/ABS lot moisture level; dryer dew point drifted','Dryer dew-point alarm added; clip radius change requested (ECR-118)');
    ret('c-acme','FR-2026-0003','warranty_claim','Meridian Automotive',hsg1[3].serial,'b-hsg1',3,'Cracked snap-fit clip','Claim submitted again by the service warehouse.',0.4,'suspicious',[ok('Label is one of ours',`box ${hsg1[3].serial}`),ok('Made in a released batch','Batch B-HSG-2026-041 (released)'),ok('Shipped by us','DN-2026-00042'),ok('Shipped to this customer','Shipped to Meridian Automotive (Tier-1 supplier)'),ok('Within warranty','36 months from shipment'),no('Not claimed before','Already claimed in FR-2026-0001')]);
    ret('c-acme','FR-2026-0004','warranty_claim','AutoFix Aftermarket','B-HSG-2026-099-0007',null,1,'Housing deformed','Claim from an aftermarket reseller.',0.3,'not_found',[no('Label is one of ours','B-HSG-2026-099-0007 was never printed by this plant – possibly counterfeit or a typing error')],'rejected');
    ret('c-acme','FR-2026-0005','complaint','FreshDrinks Bottling',cap1[2].serial,'b-cap1',120,'Black specks','120 closures with black specks sorted out of one box at the filler.',1.1,'genuine',[ok('Label is one of ours',`box ${cap1[2].serial}`),ok('Made in a released batch','Batch B-CAP-2026-101 (released)'),ok('Shipped by us','DN-2026-00041'),ok('Shipped to this customer','Shipped to FreshDrinks Bottling (OEM (direct))'),ok('Within warranty','24 months from shipment'),ok('Not claimed before','First claim for this label')]);
  };
  if (inTransaction) work(); else transaction(work);
  return true;
}
