// Asset tracking: tagged moulds, tools, gauges and trolleys located by zone. A BLE gateway or RFID reader covers each
// zone; every time it hears a tag, the asset's last known zone is updated. Alerts: a mould or tool entering a
// restricted or outside zone, a tag not heard for too long ("missing"), and a low beacon battery.
import { one, all, run } from '../db.js';
import { bad } from '../validate.js';
import { raiseAlert, resolveAlertKey } from './alerts.js';

const HOUR=3600000, GUARDED=['mould','tool','gauge','fixture'];
export function recordSighting({tagId,readerId,at,rssi=null,batteryPct=null},{alerts=true}={}) {
  const asset=one('SELECT * FROM tracked_assets WHERE tag_id=?',tagId); if (!asset) bad('Unknown tagId: register the asset first');
  const zone=one('SELECT * FROM zones WHERE reader_id=?',readerId); if (!zone) bad('Unknown readerId: register the zone first');
  if (zone.company_id!==asset.company_id) bad('Tag and reader belong to different companies');
  const r=run('INSERT OR IGNORE INTO asset_sightings (asset_id,seen_at,zone_id,rssi) VALUES (?,?,?,?)',asset.id,at,zone.id,rssi);
  if (!r.changes) return 'duplicate';
  // Out-of-order sightings are kept in the history but do not move the asset back in time.
  if (!asset.last_seen_at||at>=asset.last_seen_at) {
    run('UPDATE tracked_assets SET last_zone_id=?,last_seen_at=?,plant_id=?,battery_pct=COALESCE(?,battery_pct) WHERE id=?',zone.id,at,zone.plant_id,batteryPct,asset.id);
    if (alerts) {
      resolveAlertKey(`asset-missing:${asset.id}`,at);
      const key=`asset-zone:${asset.id}`;
      if (GUARDED.includes(asset.kind)&&['restricted','outside'].includes(zone.kind)) raiseAlert({companyId:asset.company_id,plantId:zone.plant_id,module:'assets',severity:'warning',equipmentId:asset.equipment_id,title:`${asset.name} is in ${zone.name}`,detail:`${asset.kind[0].toUpperCase()+asset.kind.slice(1)} ${asset.name} (tag ${asset.tag_id}) was detected in ${zone.name}, a ${zone.kind} zone, at ${at}. Check whether it should leave the production area.`,dedupeKey:key,at});
      else resolveAlertKey(key,at);
      if (batteryPct!=null&&batteryPct<15) raiseAlert({companyId:asset.company_id,plantId:zone.plant_id,module:'assets',severity:'info',title:`Low tag battery: ${asset.name}`,detail:`Tag ${asset.tag_id} reports ${batteryPct} % battery. Replace it before the asset stops being tracked.`,dedupeKey:`asset-battery:${asset.id}`,at});
      else if (batteryPct!=null&&batteryPct>30) resolveAlertKey(`asset-battery:${asset.id}`,at);
    }
  }
  return 'accepted';
}
export const isMissing=(a,at=Date.now())=>!a.last_seen_at||at-Date.parse(a.last_seen_at)>a.missing_after_hours*HOUR;
// Raises "missing" alerts for tags that have gone quiet; run periodically.
export function checkMissing(at=Date.now()) {
  let n=0;
  for (const a of all('SELECT * FROM tracked_assets WHERE last_seen_at IS NOT NULL')) if (isMissing(a,at)&&raiseAlert({companyId:a.company_id,plantId:a.plant_id,module:'assets',severity:'warning',equipmentId:a.equipment_id,title:`${a.name} not seen for ${Math.round((at-Date.parse(a.last_seen_at))/HOUR)} h`,detail:`Tag ${a.tag_id} was last heard in ${one('SELECT name FROM zones WHERE id=?',a.last_zone_id)?.name||'an unknown zone'} at ${a.last_seen_at}. Search there first; the tag battery may also be flat.`,dedupeKey:`asset-missing:${a.id}`,at:new Date(at).toISOString()})) n++;
  return n;
}
export const assetView=a=>({...a,zone:a.last_zone_id?one('SELECT id,name,kind FROM zones WHERE id=?',a.last_zone_id):null,home:a.home_zone_id?one('SELECT id,name FROM zones WHERE id=?',a.home_zone_id):null,missing:isMissing(a),awayFromHome:!!(a.home_zone_id&&a.last_zone_id&&a.home_zone_id!==a.last_zone_id)});
