// Shift calendar. Shifts are wall-clock times in the plant's time zone (an end before the start crosses midnight)
// on given ISO weekdays (1 = Monday ... 7 = Sunday, the day the shift starts). Plants without shifts of their own
// get defaults from their operating pattern. Shift windows define planned production time for OEE.
import { all } from '../../common/db.js';
import { zonedToUtc } from '../../common/validate.js';

const ALL_DAYS=[1,2,3,4,5,6,7], WEEKDAYS=[1,2,3,4,5];
const DEFAULT_SHIFTS={
  '24x7':[['A','06:00','14:00',ALL_DAYS],['B','14:00','22:00',ALL_DAYS],['C','22:00','06:00',ALL_DAYS]],
  '24x5':[['A','06:00','14:00',WEEKDAYS],['B','14:00','22:00',WEEKDAYS],['C','22:00','06:00',WEEKDAYS]],
  '16x5':[['A','06:00','14:00',WEEKDAYS],['B','14:00','22:00',WEEKDAYS]],
  '8x5':[['Day','08:00','16:00',WEEKDAYS]]
};
export function shiftsFor(plant) {
  const own=all('SELECT name,start_time,end_time,days FROM shifts WHERE plant_id=? ORDER BY start_time',plant.id);
  if (own.length) return own.map(s=>({name:s.name,start:s.start_time,end:s.end_time,days:JSON.parse(s.days),custom:true}));
  return (DEFAULT_SHIFTS[plant.operating_pattern]||DEFAULT_SHIFTS['24x7']).map(([name,start,end,days])=>({name,start,end,days,custom:false}));
}
// Calendar date (YYYY-MM-DD) of an instant in a time zone.
export const localDate=(ms,zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
const addDays=(date,n)=>{ const d=new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); };
const isoWeekday=date=>new Date(`${date}T00:00:00Z`).getUTCDay()||7;

// Shift occurrences overlapping [from,to), clipped to it: [{name,date,start,end}] in epoch ms, sorted.
export function shiftWindows(plant,from,to) {
  const shifts=shiftsFor(plant), out=[];
  for (let date=addDays(localDate(from,plant.timezone),-1), last=localDate(to,plant.timezone); date<=last; date=addDays(date,1)) {
    for (const s of shifts) {
      if (!s.days.includes(isoWeekday(date))) continue;
      const start=Date.parse(zonedToUtc(`${date}T${s.start}`,plant.timezone)), end=Date.parse(zonedToUtc(`${s.end<=s.start?addDays(date,1):date}T${s.end}`,plant.timezone));
      if (end>from&&start<to) out.push({name:s.name,date,start:Math.max(start,from),end:Math.min(end,to),fullStart:start,fullEnd:end});
    }
  }
  return out.sort((a,b)=>a.start-b.start);
}
export const inShift=(windows,ms)=>windows.some(w=>ms>=w.start&&ms<w.end);
// The shift running at `at`, or null.
export function currentShift(plant,at=Date.now()) {
  const w=shiftWindows(plant,at-86400000,at+86400000).find(x=>at>=x.fullStart&&at<x.fullEnd);
  return w?{name:w.name,date:w.date,start:w.fullStart,end:w.fullEnd}:null;
}
// Local calendar days covering [from,to): [{date,start,end}] in epoch ms.
export function localDays(plant,from,to) {
  const days=[];
  for (let date=localDate(from,plant.timezone), last=localDate(to-1,plant.timezone); date<=last; date=addDays(date,1)) {
    const start=Date.parse(zonedToUtc(`${date}T00:00`,plant.timezone)), end=Date.parse(zonedToUtc(`${addDays(date,1)}T00:00`,plant.timezone));
    days.push({date,start:Math.max(start,from),end:Math.min(end,to)});
  }
  return days;
}
