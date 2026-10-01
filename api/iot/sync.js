// Pull-sync runner: fetch batches from an adapter, ingest each batch and advance its cursor atomically, and record a
// run row with counts so operators can see what arrived, what was deduplicated, and what was quarantined.
import { id, now, one, run, transaction } from '../db.js';
import { ingestRecord, rejectRecord } from './ingest.js';

const running=new Set();
export async function runSync(adapter,{maxBatches=20}={}) {
  if (running.has(adapter.name)) throw new Error(`Sync for ${adapter.name} is already running`);
  running.add(adapter.name);
  const runId=id(), before=one('SELECT cursor FROM integration_cursors WHERE adapter=?',adapter.name)?.cursor??null, totals={accepted:0,duplicate:0,rejected:0};
  run('INSERT INTO integration_runs (id,adapter,started_at,status,cursor_before) VALUES (?,?,?,?,?)',runId,adapter.name,now(),'running',before);
  let cursor=before;
  try {
    for (let i=0;i<maxBatches;i++) {
      const batch=await adapter.fetchBatch(cursor);
      transaction(()=>{
        for (const raw of batch.records) {
          let canonical; try { canonical=adapter.toCanonical(raw); } catch(e) { rejectRecord(adapter.name,raw,[`adapter mapping failed: ${e.message}`]); totals.rejected++; continue; }
          totals[ingestRecord(canonical,adapter.name,raw).status]++;
        }
        run('INSERT INTO integration_cursors (adapter,cursor,updated_at) VALUES (?,?,?) ON CONFLICT(adapter) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at',adapter.name,batch.nextCursor,now());
      });
      cursor=batch.nextCursor;
      if (!batch.hasMore) break;
    }
    run('UPDATE integration_runs SET finished_at=?,status=?,accepted=?,duplicates=?,rejected=?,cursor_after=? WHERE id=?',now(),'succeeded',totals.accepted,totals.duplicate,totals.rejected,cursor,runId);
  } catch(e) {
    run('UPDATE integration_runs SET finished_at=?,status=?,accepted=?,duplicates=?,rejected=?,cursor_after=?,error=? WHERE id=?',now(),'failed',totals.accepted,totals.duplicate,totals.rejected,cursor,String(e.message).slice(0,500),runId);
  } finally { running.delete(adapter.name); }
  return one('SELECT * FROM integration_runs WHERE id=?',runId);
}
