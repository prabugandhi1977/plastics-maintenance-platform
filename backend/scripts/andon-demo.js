// Operator tablet and andon demo data: a tablet per demo plant, an andon board for Chicago, and a week of resolved
// andon calls with realistic response and resolution times, so the andon reports have history. Demo databases only
// (run from seed.js). The factory simulator adds live calls and operator downtime entries while it runs.
import { id, one, run } from '../common/db.js';
import { hashPassword } from '../common/security.js';
import { currentShift } from '../services/factory/time.js';
import { rand } from '../services/factory/simulator.js';

// Station codes and PINs for the demo copy (shown in the README and on the sign-in page of the tablet).
export const DEMO_STATIONS=[
  {id:'st-acme-imm',company:'c-acme',plant:'plant-a',name:'Bay 4–5 tablet',kind:'tablet',code:'IMM45TAB',pin:'482915',machines:['eq-a','eq-a2']},
  {id:'st-acme-bm',company:'c-acme',plant:'plant-a',name:'Blow hall tablet',kind:'tablet',code:'BM01TAB2',pin:'371946',machines:['eq-bm']},
  {id:'st-acme-tv',company:'c-acme',plant:'plant-a',name:'Chicago hall TV',kind:'board',code:'CHIBOARD',pin:'730152',machines:[]},
  {id:'st-nova-ext',company:'c-nova',plant:'plant-n',name:'Linie 2–3 Tablet',kind:'tablet',code:'EXT23TAB',pin:'615204',machines:['eq-n','eq-n2']}
];
const OPERATORS=['J. Rivera','K. Patel','M. Novak','S. Okafor','L. Chen'];
const TYPES=[['maintenance',0.4],['material',0.25],['quality',0.18],['supervisor',0.12],['safety',0.05]];
const pickType=r=>{ let a=0; for (const [t,w] of TYPES) { a+=w; if (r<a) return t; } return 'maintenance'; };
const NOTES={maintenance:['Ejector not retracting','Hydraulic leak at the nozzle','Robot gripper fault','Heater band zone 3 not heating'],material:['Hopper running low','Wrong masterbatch delivered','Dryer empty'],
  quality:['Short shots on cavity 7','Flash on the parting line','Colour off compared to the master sample'],supervisor:['Need approval to restart after the mould change','Question about the shift plan'],safety:['Guard door switch damaged','Oil on the floor at the machine']};
const RESOLUTIONS={maintenance:'Repaired and tested',material:'Material delivered',quality:'Settings adjusted, first parts approved',supervisor:'Decision given',safety:'Area secured and fixed'};

export async function seedAndon() {
  if (await one('SELECT 1 FROM operator_stations LIMIT 1')||!await one("SELECT 1 FROM equipment WHERE id='eq-a'")||!await one("SELECT 1 FROM plants WHERE id='plant-n'")) return false;
  const stamp=new Date().toISOString();
  for (const s of DEMO_STATIONS) {
    await run('INSERT INTO operator_stations (id,company_id,plant_id,name,kind,code,pin_hash,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',s.id,s.company,s.plant,s.name,s.kind,s.code,hashPassword(s.pin),s.company==='c-acme'?'u-acme':'u-nova',stamp);
    for (const e of s.machines) await run('INSERT INTO operator_station_machines (station_id,equipment_id) VALUES (?,?)',s.id,e);
  }
  // History: resolved calls over the last 7 days. Most are answered within minutes; a few wait past the first
  // escalation level and are marked escalated.
  const machines=[['eq-a','c-acme','plant-a','st-acme-imm'],['eq-a2','c-acme','plant-a','st-acme-imm'],['eq-bm','c-acme','plant-a','st-acme-bm'],['eq-n','c-nova','plant-n','st-nova-ext'],['eq-n2','c-nova','plant-n','st-nova-ext']];
  const responder={'c-acme':'u-acme-maint','c-nova':'u-nova'}, names={'u-acme-maint':'Lee Maintenance','u-nova':'Nora Nova'};
  for (const [eq,company,plantId,station] of machines) {
    const plant=await one('SELECT * FROM plants WHERE id=?',plantId);
    for (let i=0;i<9;i++) {
      const r=k=>rand(eq,'andon',String(i),k), raised=Date.now()-(2+r('t')*165)*3600000, shift=await currentShift(plant,raised);
      if (!shift) continue;
      const type=pickType(r('type')), response=1+Math.round(r('resp')**2*14*10)/10, resolve=response+3+Math.round(r('res')*50), level=response>(type==='safety'?2:type==='maintenance'||type==='supervisor'?5:10)?1:0;
      const at=m=>new Date(raised+m*60000).toISOString(), list=NOTES[type], who=responder[company];
      await run("INSERT INTO andon_calls (id,company_id,plant_id,equipment_id,station_id,call_type,severity,status,level,note,machine_state,machine_reason,operator_name,raised_by,raised_at,shift_name,shift_date,escalated_at,acknowledged_at,acknowledged_by,acknowledged_name,resolved_at,resolved_by,resolution) VALUES (?,?,?,?,?,?,?,'resolved',?,?,?,?,?,'u-system',?,?,?,?,?,?,?,?,?,?)",
        id(),company,plantId,eq,station,type,type==='safety'||level?'critical':'warning',level,list[Math.floor(r('note')*list.length)%list.length],type==='maintenance'?'down':'running',type==='maintenance'?'breakdown':null,
        OPERATORS[Math.floor(r('op')*OPERATORS.length)%OPERATORS.length],at(0),shift.name,shift.date,level?at(type==='safety'?2:5):null,at(response),who,names[who],at(resolve),who,RESOLUTIONS[type]);
    }
  }
  return true;
}
