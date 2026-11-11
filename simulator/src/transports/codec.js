// A machine snapshot as a flat list of named fields, and back. OPC UA nodes and Euromap 63 file lines carry exactly
// these fields, so the two polled protocols share one mapping.
export const VALUE_KEYS = ['meltTempC', 'mouldTempC', 'injectionPressureBar', 'holdPressureBar', 'cycleTimeS', 'cushionMm', 'screwRpm', 'hydraulicOilTempC', 'coolingWaterTempC', 'vibrationMmS', 'powerKw', 'dryerDewPointC', 'airPressureBar', 'oilLevelPct'];
export const FIELDS = [
  ['at', 'number'], ['state', 'string'], ['reason', 'string'], ['phase', 'string'], ['partNumber', 'string'], ['driveType', 'string'],
  ['cycleCount', 'number'], ['good', 'number'], ['scrap', 'number'], ['runningHours', 'number'], ['kwh', 'number'], ['alarms', 'json'], ['shot', 'json'],
  ...VALUE_KEYS.map(k => [`v.${k}`, 'number'])
];
export function flatten(s) {
  const f = { at: s.at, state: s.state, reason: s.reason ?? '', phase: s.phase ?? '', partNumber: s.partNumber ?? '', driveType: s.driveType ?? '',
    cycleCount: s.counters.cycleCount, good: s.counters.good, scrap: s.counters.scrap, runningHours: s.counters.runningHours, kwh: s.counters.kwh, alarms: JSON.stringify(s.alarms), shot: JSON.stringify(s.shot ?? null) };
  for (const k of VALUE_KEYS) f[`v.${k}`] = s.values[k] ?? 0;
  return f;
}
export function unflatten(deviceId, f) {
  const values = {}; for (const k of VALUE_KEYS) values[k] = Number(f[`v.${k}`] ?? 0);
  return { deviceId, at: Number(f.at), state: f.state, reason: f.reason || null, phase: f.phase || null, partNumber: f.partNumber || null, driveType: f.driveType || null, values,
    counters: { cycleCount: Number(f.cycleCount), good: Number(f.good), scrap: Number(f.scrap), runningHours: Number(f.runningHours), kwh: Number(f.kwh) }, alarms: JSON.parse(f.alarms || '[]'), shot: JSON.parse(f.shot || 'null') };
}
