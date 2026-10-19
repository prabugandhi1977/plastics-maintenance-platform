// Client for the Python ML service (ml/). Optional: when ML_SERVICE_URL is not set, or the service is down, the
// platform simply carries on with the built-in statistics. Every prediction comes back with the model name and
// version that produced it, so a score can always be traced to the exact model.
import { featureRow } from './features.js';
import { scrapFeatureRow } from './quality.js';

export const mlConfigured=()=>!!process.env.ML_SERVICE_URL;
const TIMEOUT_MS=3000;
async function post(e,task,features,fetchFn) {
  const r=await fetchFn(process.env.ML_SERVICE_URL.replace(/\/$/,'')+'/score',{method:'POST',signal:AbortSignal.timeout(TIMEOUT_MS),
    headers:{'content-type':'application/json',...(process.env.ML_SERVICE_KEY?{'x-ml-key':process.env.ML_SERVICE_KEY}:{})},body:JSON.stringify({companyId:e.company_id,equipmentId:e.id,task,features})});
  if (!r.ok) throw Error('ML service '+r.status);
  return r.json();
}
// Breakdown risk and unusual pattern (task "failure"), plus scrap-spike risk (task "scrap") while the machine runs.
export async function scoreMachine(e,at=Date.now(),fetchFn=fetch) {
  if (!mlConfigured()) return null;
  const features=await featureRow(e,at); if (!features) return {status:'learning'};
  try {
    const out={status:'ok',...await post(e,'failure',features,fetchFn)}, scrapFeatures=await scrapFeatureRow(e,at);
    if (scrapFeatures) out.scrap=(await post(e,'scrap',scrapFeatures,fetchFn)).scrap??null;
    return out;
  } catch { return {status:'unavailable'}; }
}
