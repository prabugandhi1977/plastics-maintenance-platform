// JSON replies, body parsing and a small path router. Handlers get ({user, body, params, query, req}) and return a
// value (200) or reply(status, value).
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const bad = message => { throw new HttpError(400, message); };
export const deny = (message = 'Not allowed') => { throw new HttpError(403, message); };
export const missing = (message = 'Not found') => { throw new HttpError(404, message); };

export const API_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
export const json = (res, status, value) => { res.writeHead(status, API_HEADERS); res.end(JSON.stringify(value)); };
export class Reply { constructor(status, value) { this.status = status; this.value = value; } }
export const reply = (status, value) => new Reply(status, value);

export async function bodyOf(req, limit = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'Request too large'); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { bad('Invalid JSON'); }
}

// Options: public (no sign-in), roles (allowed roles).
export function createRouter() {
  const routes = [];
  const add = method => (pattern, handler, options = {}) => routes.push({ method, re: new RegExp('^/api' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...options });
  return {
    get: add('GET'), post: add('POST'), patch: add('PATCH'), put: add('PUT'), delete: add('DELETE'),
    match(method, path) {
      let pathExists = false;
      for (const r of routes) { const m = r.re.exec(path); if (!m) continue; if (r.method === method) return { route: r, params: m.groups || {} }; pathExists = true; }
      return { route: null, pathExists };
    },
  };
}

export const text = (v, name, max = 200) => { if (typeof v !== 'string' || !v.trim()) bad(`${name} is required`); if (v.length > max) bad(`${name} is too long (max ${max})`); return v.trim(); };
export const choice = (v, name, options) => { if (!options.includes(v)) bad(`${name} must be one of: ${options.join(', ')}`); return v; };
export const optNumber = (v, name) => { if (v == null || v === '') return null; if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${name} must be a number`); return v; };
