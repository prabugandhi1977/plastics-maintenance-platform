// Exports the feature table the Python ML service (ml/) trains on.
// Usage: node backend/scripts/ml-export.js --task failure|scrap --out data/ml-features.json [--company <id>] [--days 60] [--step 6]
import { writeFileSync } from 'node:fs';
import { exportFeatureTable } from '../services/ml/features.js';
import { exportScrapTable } from '../services/ml/quality.js';

const arg=(name,fallback)=>{ const i=process.argv.indexOf('--'+name); return i>0?process.argv[i+1]:fallback; };
const out=arg('out','ml-features.json'), task=arg('task','failure'), opts={companyId:arg('company',null),days:Number(arg('days',60)),stepHours:Number(arg('step',task==='scrap'?2:6))}, table=task==='scrap'?exportScrapTable(opts):exportFeatureTable(opts);
writeFileSync(out,JSON.stringify(table));
const labelled=table.rows.filter(r=>r.label!=null);
console.log(`Exported ${table.rows.length} rows (${labelled.length} labelled, ${labelled.filter(r=>r.label).length} ${task==='scrap'?'before a scrap spike':'before a breakdown'}) to ${out}`);
