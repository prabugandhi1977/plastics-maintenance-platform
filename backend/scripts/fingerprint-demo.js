// Demo data for the mould process fingerprint: the closure mould (Hot Runner 24 on IMM-04, product CAP-28-PCO) gets a
// fingerprint learned from its two finished batches, and the running batch's last hours are nudged so the recent run
// has drifted: hotter melt and mould, longer cycle, lower pressures, all still inside the validated process window
// (the case a window check alone does not catch). No alert is raised here; the scan or a manager's "check now" does that.
// Runs once per database, after the traceability demo data, on new and existing demos.
import { one, run, transaction } from '../common/db.js';
import { buildAndSave } from '../services/process/fingerprint.js';

const HOUR=3600000;
// Drift added at full strength, in each setting's unit (about 3 good-run standard deviations each).
const DRIFT={meltTempC:6,mouldTempC:3,injectionPressureBar:-30,holdPressureBar:-25,cycleTimeS:0.17};

export async function seedFingerprint(inTransaction=false) {
  if (await one('SELECT 1 FROM mould_fingerprints LIMIT 1')) return false;
  const scope={companyId:'c-acme',mouldId:'eq-b',equipmentId:'eq-a',productId:'pr-cap'};
  if (!await one("SELECT 1 FROM batches WHERE id='b-cap3' AND mould_id='eq-b'")||!await one("SELECT 1 FROM process_readings WHERE batch_id='b-cap1' LIMIT 1")) return false;
  const work=async ()=>{
    const out=await buildAndSave(null,scope,{origin:'auto',reason:'Learned from the finished batches of the demo'});
    if (!out.built) return false;
    const last=await one("SELECT max(observed_at) t FROM process_readings WHERE batch_id='b-cap3'");
    if (last?.t) {
      const end=Date.parse(last.t);
      // Ramps in over 8 hours, ending 6 hours before the newest reading, then holds.
      for (const [k,delta] of Object.entries(DRIFT)) await run('UPDATE process_readings SET value=round((value+?*LEAST(1,GREATEST(0,(EXTRACT(EPOCH FROM (observed_at::timestamptz))*1000-?)/?)))::numeric,2) WHERE batch_id=? AND parameter=? AND observed_at>=?',delta,end-14*HOUR,8*HOUR,'b-cap3',k,new Date(end-14*HOUR).toISOString());
    }
    return true;
  };
  return inTransaction?await work():await transaction(work);
}
