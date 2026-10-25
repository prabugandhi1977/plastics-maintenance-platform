// Euromap 63: the file interface of older injection moulding machines. Host and machine share a session folder.
// Each poll is one session:
//   1. Monitor writes the job file SESSnnnn.JOB with a REPORT command listing the parameters, then the session
//      request SESSnnnn.REQ: `00000001 EXECUTE "SESSnnnn.JOB";`
//   2. The machine runs the job, writes the report SESSnnnn.DAT (a header line with the parameter names, then a line
//      of values, comma separated), the job log SESSnnnn.LOG and the session response SESSnnnn.RSP
//      (`00000001 PROCESSED "EXECUTE ...";` or `... ERROR ...`), and removes the request.
//   3. Monitor reads the values and removes the session's files.
// A session that gets no response within the timeout fails and its files are removed. Files of earlier sessions left
// behind (after a crash or a machine restart) are removed once they are older than the stale age.
import { readFile, writeFile, rename, unlink, readdir, stat, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { numberOf, scaled, mapState } from './common.js';

const SESSION_FILE = /^SESS\d{4}\.(REQ|RSP|JOB|DAT|LOG|TMP)$/i;
export const PARAM = /^@?[A-Za-z][A-Za-z0-9_]*(\[\d{1,3}\])?$/;
const norm = p => p.replace(/^@/, '').toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One CSV line with optional double quotes ("" inside quotes is a quote).
export function csvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',' || c === ';') { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim()); return out;
}
// The report: { NAME: raw text } from the header and the last line of values.
export function parseReport(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('The Euromap 63 report has no values');
  const names = csvLine(lines[0]), values = csvLine(lines.at(-1));
  return Object.fromEntries(names.map((n, i) => [norm(n), values[i] ?? '']));
}
export function jobText(n, params, machineFolder = '') {
  const s = `SESS${n}`;
  return `JOB ${s} RESPONSE "${machineFolder}${s}.LOG";\r\nREPORT REP${n} REWRITE "${machineFolder}${s}.DAT"\r\n  PARAMETERS\r\n    ${['DATE', 'TIME', ...params].join(', ')};\r\n`;
}
export const requestText = (n, machineFolder = '') => `00000001 EXECUTE "${machineFolder}SESS${n}.JOB";\r\n`;

async function writeAtomic(path, text) { await writeFile(path + '.TMP', text, 'latin1'); await rename(path + '.TMP', path); }
const remove = path => unlink(path).catch(() => {});

export async function cleanStale(folder, maxAgeMs, now = Date.now()) {
  let removed = 0;
  for (const f of await readdir(folder)) {
    if (!SESSION_FILE.test(f)) continue;
    const st = await stat(join(folder, f)).catch(() => null);
    if (st?.isFile() && now - st.mtimeMs > maxAgeMs) { await remove(join(folder, f)); removed++; }
  }
  return removed;
}

export function euromap63Driver(cfg) {
  const folder = cfg.endpoint, o = cfg.options ?? {}, timeoutMs = o.timeoutMs ?? 10000, staleMs = Math.max(60000, 3 * timeoutMs);
  const entries = Object.entries(cfg.mapping).map(([key, m]) => ({ key, ...m }));
  const params = [...new Set([...entries.map(e => e.param), ...(o.state?.param ? [o.state.param] : [])])];
  let n = Math.floor(Date.now() / 1000) % 10000;
  const next = () => String(n = (n + 1) % 10000).padStart(4, '0');
  return {
    mode: 'poll',
    async open() {
      await access(folder, constants.R_OK | constants.W_OK).catch(() => { throw new Error('The Euromap 63 session folder does not exist or cannot be written'); });
      await cleanStale(folder, staleMs);
    },
    async read() {
      await cleanStale(folder, staleMs);
      const id = next(), base = join(folder, `SESS${id}`), files = ['REQ', 'RSP', 'JOB', 'DAT', 'LOG'].map(x => `${base}.${x}`);
      try {
        await writeAtomic(`${base}.JOB`, jobText(id, params, o.machineFolder ?? ''));
        await writeAtomic(`${base}.REQ`, requestText(id, o.machineFolder ?? ''));
        const end = Date.now() + timeoutMs; let rsp = null;
        while (Date.now() < end) {
          rsp = await readFile(`${base}.RSP`, 'latin1').catch(() => null);
          if (rsp?.includes(';')) break;
          rsp = null; await sleep(Math.min(100, timeoutMs / 20));
        }
        if (!rsp) throw new Error(`The machine did not answer the Euromap 63 session within ${timeoutMs / 1000} s. Check that its EM63 interface is on and the folder is shared.`);
        if (/\bERROR\b/i.test(rsp)) {
          const log = (await readFile(`${base}.LOG`, 'latin1').catch(() => '')).split(/\r?\n/).find(l => /error/i.test(l)) ?? '';
          throw new Error(`The machine refused the Euromap 63 job${log ? `: ${log.trim().slice(0, 200)}` : ''}`);
        }
        const report = parseReport(await readFile(`${base}.DAT`, 'latin1').catch(() => { throw new Error('The machine answered but wrote no Euromap 63 report'); }));
        const values = {}, raw = {}, skipped = []; let state = null;
        for (const e of entries) {
          const r = report[norm(e.param)]; raw[e.key] = r ?? null;
          if (r == null) { skipped.push(`${e.key}: ${e.param} not in the report`); continue; }
          const v = numberOf(r); if (v == null) { skipped.push(`${e.key}: ${e.param} is not a number`); continue; }
          values[e.key] = scaled(v, e);
        }
        if (o.state?.param) { const r = report[norm(o.state.param)]; raw.$state = r ?? null; state = r == null ? null : mapState(r, o.state.map); if (r != null && !state) skipped.push(`state: value ${r} is not mapped`); }
        return { values, state, raw, skipped };
      } finally { for (const f of files) await remove(f); }
    },
    async close() {},
  };
}
