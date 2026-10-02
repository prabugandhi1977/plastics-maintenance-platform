// HTTP entry point: static web/mobile shells with security headers, and the shared JSON API for both clients.
// Feature areas live in api/routes/*; later phases (remote support, AI assistance) register their own route modules.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, now, one, run, transaction } from './db.js';
import { authenticate } from './security.js';
import { HttpError, bad } from './validate.js';
import { createRouter, bodyOf, json, Reply, API_HEADERS } from './http.js';
import { runSync } from './iot/sync.js';
import { createAdapter } from './iot/adapters/index.js';
import * as auth from './routes/auth.js';
import * as org from './routes/org.js';
import * as equipment from './routes/equipment.js';
import * as iot from './routes/iot.js';
import * as contracts from './routes/contracts.js';
import * as tickets from './routes/tickets.js';
import * as parts from './routes/parts.js';
import * as dashboard from './routes/dashboard.js';
import * as settings from './routes/settings.js';
import * as factory from './routes/factory.js';
import * as factoryOps from './routes/factory-ops.js';
import * as assistant from './routes/assistant.js';
import * as vision from './routes/vision.js';
import * as traceability from './routes/traceability.js';
import { checkNodes, pruneMedia } from './vision.js';
import { simulateAll, simulatorEnabled } from './factory/simulator.js';
import { checkMissing } from './factory/assets.js';

export const router=createRouter();
for (const area of [auth,org,equipment,iot,contracts,tickets,parts,dashboard,settings,factory,factoryOps,traceability,assistant,vision]) area.register(router);

const STATIC_HEADERS={'x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','permissions-policy':'camera=(self), geolocation=(), microphone=()',
  'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"};
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};

// Offline-capable mutations carry X-Client-Action-Id. The first result is stored with the mutation in one
// transaction; a replay by the same user returns it unchanged, and reusing the ID for a different request is refused.
function runOffline(u,req,path,body,handle) {
  const actionId=req.headers['x-client-action-id'];
  if (!actionId) return transaction(handle);
  if (typeof actionId!=='string'||!/^[a-f0-9-]{36}$/.test(actionId)) bad('Invalid client action ID');
  const hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const previous=one('SELECT result_json FROM offline_actions WHERE user_id=? AND client_action_id=?',u.id,actionId);
  if (previous) { const saved=JSON.parse(previous.result_json); if (saved.path!==path||saved.hash!==hash) throw new HttpError(409,'Client action ID already used for another request'); return new Reply(200,saved.result); }
  return transaction(()=>{ const out=handle(), value=out instanceof Reply?out.value:out; run('INSERT INTO offline_actions (user_id,client_action_id,result_json,created_at) VALUES (?,?,?,?)',u.id,actionId,JSON.stringify({path,hash,result:value}),now()); return out; });
}

async function api(req,res,url) {
  const {route,params,pathExists}=router.match(req.method,url.pathname);
  if (!route) throw new HttpError(pathExists?405:404,pathExists?'Method not allowed':'Endpoint not found');
  const body=['POST','PATCH','PUT'].includes(req.method)?await bodyOf(req):{};
  const u=route.public?null:authenticate(req); if (!route.public&&!u) throw new HttpError(401,'Authentication required');
  const ctx={u,body,params,query:url.searchParams,req,res};
  const out=route.offline?runOffline(u,req,url.pathname,body,()=>route.handler(ctx)):await route.handler(ctx);
  if (res.writableEnded||res.headersSent) return;
  if (out instanceof Reply) return json(res,out.status,out.value);
  json(res,200,out);
}

function serveStatic(req,res,path) {
  if (req.method!=='GET'&&req.method!=='HEAD') throw new HttpError(405,'Method not allowed');
  const safe=path==='/'?'index.html':path.endsWith('/')?path.slice(1)+'index.html':path.slice(1);
  if (!/^[\w./-]+$/.test(safe)||safe.includes('..')) throw new HttpError(404,'Not found');
  const file=join(ROOT,'web',safe); if (!existsSync(file)||!statSync(file).isFile()) throw new HttpError(404,'Not found');
  res.writeHead(200,{...STATIC_HEADERS,'content-type':MIME[extname(file)]||'application/octet-stream',...(safe.endsWith('sw.js')?{'cache-control':'no-cache'}:{})});
  res.end(req.method==='HEAD'?undefined:readFileSync(file));
}

export function createServer() {
  return http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req,res,url);
      serveStatic(req,res,url.pathname);
    } catch(e) {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) { res.writeHead(e.status,{...API_HEADERS,...e.headers}); return res.end(JSON.stringify({error:e.message})); }
      if (String(e.message).includes('UNIQUE constraint failed')) return json(res,409,{error:'Record already exists'});
      console.error(e); json(res,500,{error:'Internal server error'});
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const port=Number(process.env.PORT||3100);
  createServer().listen(port,()=>console.log(`MouldCare listening on port ${port}`));
  // Asset tags that stop reporting are flagged as missing whether the data is real or simulated.
  setInterval(()=>{ try { checkMissing(); } catch(e) { console.error('Missing-asset check failed:',e.message); } },5*60000).unref();
  // Vision: silent edge nodes raise an alert; closed, unlocked evidence past its retention is deleted (locked never).
  setInterval(()=>{ try { checkNodes(); } catch(e) { console.error('Vision node check failed:',e.message); } },60000).unref();
  setInterval(()=>{ try { const n=pruneMedia(); if (n) console.log(`Vision: pruned ${n} media files past retention`); } catch(e) { console.error('Vision pruning failed:',e.message); } },6*3600000).unref();
  // Simulated machine data (local demos only): backfills a week on first start, then keeps the factory live.
  if (simulatorEnabled()) { const tick=()=>{ try { const n=simulateAll(); if (n) console.log(`Factory simulator: ${n} slots generated`); } catch(e) { console.error('Factory simulator failed:',e.message); } }; tick(); setInterval(tick,60000).unref(); }
  const every=Number(process.env.IOT_SYNC_INTERVAL_SECONDS||0);
  if (every>0) { const adapter=createAdapter(process.env.IOT_SYNC_ADAPTER||'mock'), tick=()=>runSync(adapter).then(r=>console.log(`IoT sync ${r.status}: ${r.accepted} accepted, ${r.duplicates} duplicate, ${r.rejected} rejected${r.error?' - '+r.error:''}`)).catch(e=>console.error('IoT sync skipped:',e.message)); tick(); setInterval(tick,Math.max(every,15)*1000).unref(); }
}
