// Energy: kWh per machine and interval, and the figures plants manage energy by.
//   Specific energy consumption (SEC) = kWh ÷ kg produced (parts are converted with the product's part weight).
//   Wasted energy = kWh used while the machine was not producing (idle, down, set-up, planned stop).
//   CO₂ = kWh × grid emission factor (the company's own, else its country's average); cost = kWh × energy price.
import { one, all, run, mapSeq, reduceSeq } from '../../common/db.js';
import { GRID_CO2 } from '../../common/catalog.js';
import { localDays } from './time.js';
import { plantOf } from './production.js';

export async function recordEnergy(e,{periodStart,periodMinutes,kwh,peakKw=null},source) {
  const r=await run('INSERT INTO energy_readings (equipment_id,period_start,period_minutes,kwh,peak_kw,company_id,source) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',e.id,periodStart,periodMinutes,kwh,peakKw,e.company_id,source);
  return r.changes?'accepted':'duplicate';
}
export const co2Factor=company=>company?.grid_co2_kg_per_kwh??GRID_CO2[company?.country]??GRID_CO2.default;

async function machineEnergy(e,from,to) {
  const fromIso=new Date(from).toISOString(), toIso=new Date(to).toISOString();
  const rows=await all('SELECT period_start,kwh,peak_kw FROM energy_readings WHERE equipment_id=? AND period_start>=? AND period_start<? ORDER BY period_start',e.id,fromIso,toIso);
  const states=await all('SELECT state,started_at,ended_at FROM machine_states WHERE equipment_id=? AND started_at<? AND (ended_at IS NULL OR ended_at>?) ORDER BY started_at',e.id,toIso,fromIso);
  let kwh=0,waste=0,peak=0,i=0;
  for (const r of rows) {
    kwh+=r.kwh; peak=Math.max(peak,r.peak_kw||0);
    while (i<states.length-1&&states[i].ended_at&&states[i].ended_at<=r.period_start) i++;
    const s=states[i]; if (s&&s.started_at<=r.period_start&&s.state!=='running') waste+=r.kwh;
  }
  // Output in kg: kg/m products directly (m is not convertible and is left out), parts × part weight.
  const kg=(await one(`SELECT sum(CASE WHEN c.unit='kg' THEN c.total_qty WHEN c.unit='parts' AND p.part_weight_g IS NOT NULL THEN c.total_qty*p.part_weight_g/1000.0 ELSE 0 END) kg FROM production_counts c LEFT JOIN products p ON p.id=c.product_id WHERE c.equipment_id=? AND c.period_start>=? AND c.period_start<?`,e.id,fromIso,toIso)).kg||0;
  const company=await one('SELECT * FROM companies WHERE id=?',e.company_id), factor=co2Factor(company);
  return {equipmentId:e.id,kwh,wasteKwh:waste,peakKw:peak||null,kg,secKwhPerKg:kg?kwh/kg:null,co2Kg:kwh*factor,co2Factor:factor,cost:company.energy_price_per_kwh!=null?kwh*company.energy_price_per_kwh:null,currency:company.currency};
}
export async function energyReport(machines,from,to) {
  const per=(await mapSeq(machines, async e=>({...await machineEnergy(e,from,to),assetTag:e.asset_tag,name:`${e.make} ${e.model}`,machineType:e.machine_type})));
  const sum=k=>per.reduce((n,x)=>n+(x[k]||0),0), kwh=sum('kwh'), kg=sum('kg');
  // Cost only adds up within one currency; mixed portfolios show it per machine.
  const currencies=[...new Set(per.filter(x=>x.cost!=null).map(x=>x.currency))];
  const daily=machines.length?(await mapSeq(localDays(await plantOf(machines[0]),from,to), async d=>({date:d.date,kwh:Math.round((await reduceSeq(machines, async (n,e)=>n+((await one('SELECT sum(kwh) k FROM energy_readings WHERE equipment_id=? AND period_start>=? AND period_start<?',e.id,new Date(d.start).toISOString(),new Date(d.end).toISOString())).k||0),0)))}))):[];
  return {total:{kwh,wasteKwh:sum('wasteKwh'),wastePct:kwh?sum('wasteKwh')/kwh*100:null,kg,secKwhPerKg:kg?kwh/kg:null,co2Kg:sum('co2Kg'),peakKw:Math.max(0,...per.map(x=>x.peakKw||0))||null,cost:currencies.length===1&&per.every(x=>x.cost!=null||!x.kwh)?sum('cost'):null,currency:currencies.length===1?currencies[0]:null},
    machines:per,daily};
}
