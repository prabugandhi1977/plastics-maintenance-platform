// HTTP plumbing shared by all route modules: JSON replies, body parsing, and a small path router.
// Route handlers receive ({u, body, params, query, req, res}) and return a value (200) or reply(status, value).
import { HttpError, bad } from './validate.js';

export const API_HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
export const json=(res,status,value)=>{ res.writeHead(status,API_HEADERS); res.end(JSON.stringify(value)); };
export class Reply { constructor(status,value) { this.status=status; this.value=value; } }
export const reply=(status,value)=>new Reply(status,value);
export const created=value=>reply(201,value);

export async function bodyOf(req,limit=8*1024*1024) {
  let chunks=[],size=0;
  for await (const chunk of req) { size+=chunk.length; if (size>limit) throw new HttpError(413,'Request too large'); chunks.push(chunk); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { bad('Invalid JSON'); }
}

// Options: public (no token), offline (idempotent replay via X-Client-Action-Id), roles (allowed roles, checked first).
export function createRouter() {
  const routes=[];
  const add=method=>(pattern,handler,options={})=>routes.push({method,pattern,re:new RegExp('^/api'+pattern.replace(/:(\w+)/g,'(?<$1>[^/]+)')+'$'),handler,...options});
  return {
    routes,get:add('GET'),post:add('POST'),patch:add('PATCH'),
    match(method,path) {
      let pathExists=false;
      for (const r of routes) { const m=r.re.exec(path); if (!m) continue; if (r.method===method) return {route:r,params:m.groups||{}}; pathExists=true; }
      return {route:null,pathExists};
    }
  };
}
