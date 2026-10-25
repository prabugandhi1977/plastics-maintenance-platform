// Demo data for spare parts stock on the demo companies: a catalogue with bins, opening balances, one open purchase
// order, a part issued to the earlier repair, and parts below their reorder point (so the reorder list and the
// low-stock alert have something to show). Runs once per database, on new and existing demos (only seed.js calls it,
// and seed.js runs only when demo data is switched on).
import { one, run } from '../common/db.js';
import { checkReorder, record } from '../services/core/stock.js';

const daysAgo=d=>new Date(Date.now()-d*86400000).toISOString();
// [company, partNumber, name, maker, unit, category, fitsTypes, fitsMachines, unitCostMinor, reorderPoint, reorderQty, leadDays, supplier, plant, bin, onHand]
const PARTS=[
  ['c-acme','ARB-PRV-570-02','Pressure relief valve assembly','Arburg','pcs','Hydraulics',[],['eq-a'],48500,1,2,5,'Arburg Spare Parts US','plant-a','H-01',1],
  ['c-acme','ARB-SEAL-50','Screw seal kit 50 mm','Arburg','set','Seals',['injection'],[],12900,2,4,10,'Arburg Spare Parts US','plant-a','S-02',5],
  ['c-acme','HYD-OIL-46','Hydraulic oil HLP 46','Shell','l','Lubricants',['injection','blow'],[],650,100,200,3,'Midwest Lubricants','plant-a','OIL-1',60],
  ['c-acme','HTR-BAND-60','Heater band 60 × 50 mm, 230 V 350 W','Watlow','pcs','Heating',['injection'],[],3800,4,10,7,'Watlow Distribution','plant-a','E-03',6],
  ['c-acme','TC-J-150','Thermocouple type J, 150 mm','Watlow','pcs','Sensors',['injection','mould'],[],1450,6,20,7,'Watlow Distribution','plant-a','E-04',3],
  ['c-acme','HR-NOZ-TIP','Hot runner nozzle tip','Husky','pcs','Hot runner',[],['eq-b'],9200,4,8,21,'Husky Parts Center','plant-a','T-01',8],
  ['c-acme','FLT-DRY-120','Dryer filter cartridge','Motan','pcs','Filters',[],['eq-c'],5400,2,4,10,'Motan-Colortronic Inc.','plant-a','F-02',2],
  ['c-acme','BLW-PIN-20','Blow pin 20 mm','Kautex','pcs','Blow moulding',[],['eq-bm'],15600,1,2,28,'Kautex Service','plant-a','B-01',0],
  ['c-nova','ZSK-58-ELEM','Schneckenelement ZSK 58','Coperion','pcs','Schnecke',[],['eq-n'],89000,1,2,42,'Coperion Service','plant-n','R-01',2],
  ['c-nova','HTR-BAND-110','Heizband 110 mm, 400 V','Hotset','pcs','Heizung',['extrusion'],[],6200,3,6,10,'Hotset GmbH','plant-n','E-01',2],
  ['c-nova','GEAR-OIL-220','Getriebeöl CLP 220','Fuchs','l','Schmierstoffe',['extrusion'],[],900,40,100,5,'Fuchs Schmierstoffe','plant-n','OEL-1',75]];

export async function seedStock() {
  if (!await one("SELECT 1 FROM companies WHERE id='c-acme'")||!await one("SELECT 1 FROM plants WHERE id='plant-a'")||await one('SELECT 1 FROM spare_parts LIMIT 1')) return false;
  const acme={id:'u-acme'}, nova={id:'u-nova'};
  for (const [company,pn,name,maker,unit,category,types,machines,cost,rp,rq,lead,supplier,plant,bin,qty] of PARTS) {
    const key=`sp-${pn.toLowerCase()}`;
    await run(`INSERT INTO spare_parts (id,company_id,part_number,name,maker,unit,category,fits_types,unit_cost_minor,reorder_point,reorder_qty,lead_time_days,supplier,qr_code,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,key,company,pn,name,maker,unit,category,JSON.stringify(types),cost,rp,rq,lead,supplier,`SP:${key}`,company==='c-acme'?'u-acme':'u-nova',daysAgo(30),daysAgo(30));
    for (const e of machines) if (await one('SELECT 1 FROM equipment WHERE id=?',e)) await run('INSERT INTO spare_part_fits (part_id,equipment_id) VALUES (?,?)',key,e);
    const part=await one('SELECT * FROM spare_parts WHERE id=?',key), by=company==='c-acme'?acme:nova;
    if (qty>0) await record(by,{part,plantId:plant,bin,type:'receive',quantity:qty,reference:'Opening balance',at:daysAgo(30)});
  }
  // The seal kit used on the earlier hydraulic repair, a bin transfer, and thermocouples on order.
  const seal=await one("SELECT * FROM spare_parts WHERE id='sp-arb-seal-50'");
  if (await one("SELECT 1 FROM tickets WHERE id='ticket-a-old'")) {
    await record({id:'u-engineer'},{part:seal,plantId:'plant-a',bin:'S-02',type:'issue',quantity:-1,ticketId:'ticket-a-old',equipmentId:'eq-a',at:daysAgo(19.8)});
    await run("INSERT INTO ticket_events (id,ticket_id,actor_id,event_type,detail,created_at) VALUES (?,?,?,?,?,?)",crypto.randomUUID(),'ticket-a-old','u-engineer','part_issued','1 set ARB-SEAL-50 Screw seal kit 50 mm from stock (Chicago Plant)',daysAgo(19.8));
  }
  const heater=await one("SELECT * FROM spare_parts WHERE id='sp-htr-band-60'");
  await record(acme,{part:heater,plantId:'plant-a',bin:'E-03',type:'transfer_out',quantity:-2,transferId:'demo-transfer-1',reason:'To Chicago Plant E-03B',at:daysAgo(8)});
  await record(acme,{part:heater,plantId:'plant-a',bin:'E-03B',type:'transfer_in',quantity:2,transferId:'demo-transfer-1',reason:'From Chicago Plant E-03',at:daysAgo(8)});
  await run("INSERT INTO spare_orders (id,company_id,part_id,plant_id,quantity,supplier,reference,status,expected_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    'so-demo-tc','c-acme','sp-tc-j-150','plant-a',20,'Watlow Distribution','PO-2026-0418','open',daysAgo(-4),'u-acme',daysAgo(3),daysAgo(3));
  for (const [key] of PARTS.map(p=>[`sp-${p[1].toLowerCase()}`])) await checkReorder(key);
  return true;
}
