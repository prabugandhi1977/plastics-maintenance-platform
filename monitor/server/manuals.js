// The text of uploaded documents, so the AI can read the plant's manuals. After an upload the text is read in the
// background (PDF page by page, Word, Excel, text and CSV; images and scanned PDFs have none, and there is no OCR),
// split into passages of a few hundred words and kept in a full-text index. search() finds the passages that best
// match a question or a finding for one machine, ranked by BM25.
import { unzipSync, strFromU8 } from 'fflate';
import { one, all, run, transaction } from './db.js';
import { MACHINE_TYPES } from './catalog.js';

const WORDS = 220, MAX_WORDS = 320, MIN_WORDS = 40, TIMEOUT = 120000, MB = 1024 * 1024;
const words = s => s.split(/\s+/).filter(Boolean);
const tidy = s => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();

// ---- Text extraction: [{ page, text }], page null where a format has no pages ----
async function pdfPages(buf) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0, isEvalSupported: false });
  try { const { text } = await extractText(pdf, { mergePages: false }); return text.map((t, i) => ({ page: i + 1, text: t })); }
  finally { await pdf.destroy?.(); }
}
// Office files are zips of XML; only the parts with text are unpacked, and none larger than 50 MB.
const unzip = (buf, want) => unzipSync(new Uint8Array(buf), { filter: f => want(f.name) && f.originalSize < 50 * MB });
const xmlText = s => s.replace(/<[^>]+>/g, '').replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e.toLowerCase()] ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))));
function docxPages(buf) {
  const xml = unzip(buf, n => n === 'word/document.xml')['word/document.xml'];
  if (!xml) throw new Error('The Word file has no document text');
  return [{ page: null, text: xmlText(strFromU8(xml).replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n\n')) }];
}
// Each sheet is a "page": its rows, one line each, cells separated by " | ".
function xlsxPages(buf) {
  const files = unzip(buf, n => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = files['xl/sharedStrings.xml'] ? [...strFromU8(files['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => xmlText(m[1])) : [];
  return Object.keys(files).filter(n => n.includes('worksheets')).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).map(n => ({ page: Number(n.match(/sheet(\d+)/)[1]),
    text: [...strFromU8(files[n]).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(r => [...r[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, attrs, body = '']) => {
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? '';
      return /t="s"/.test(attrs) ? shared[Number(v)] ?? '' : xmlText(v);
    }).filter(Boolean).join(' | ')).filter(Boolean).join('\n') }));
}
export async function extract(buf, mime) {
  if (mime === 'application/pdf') return pdfPages(buf);
  if (mime.includes('wordprocessingml')) return docxPages(buf);
  if (mime.includes('spreadsheetml')) return xlsxPages(buf);
  if (mime === 'text/plain' || mime === 'text/csv') return [{ page: null, text: buf.toString('utf8').replace(/^﻿/, '') }];
  return []; // images
}

// Passages of about WORDS words, built from whole paragraphs where they fit; a passage never spans two pages.
export function passagesOf(pages) {
  const out = [];
  for (const { page, text } of pages) {
    const paras = tidy(text).split(/\n+/).map(p => words(p)).filter(w => w.length);
    let cur = [];
    const flush = () => { if (!cur.length) return; const last = out.at(-1); if (cur.length < MIN_WORDS && last?.page === page && last.n + cur.length <= MAX_WORDS) { last.text += ' ' + cur.join(' '); last.n += cur.length; } else out.push({ page, text: cur.join(' '), n: cur.length }); cur = []; };
    for (let w of paras) {
      while (w.length > MAX_WORDS) { flush(); cur = w.slice(0, WORDS); w = w.slice(WORDS); flush(); }
      if (cur.length + w.length > MAX_WORDS) flush();
      cur.push(...w); if (cur.length >= WORDS) flush();
    }
    flush();
  }
  return out.map(({ page, text }) => ({ page, text }));
}

const NO_TEXT = { image: 'An image has no text that can be read. Text in pictures is not read (no OCR).', pdf: 'This PDF has no text layer, so it is probably a scan. Scanned pages are not read (no OCR).', other: 'The file has no text.' };
const failure = e => e?.name === 'PasswordException' ? 'The PDF is password-protected.' : e?.name === 'InvalidPDFException' ? 'The PDF is damaged or not a valid PDF.' : `The text could not be read: ${String(e?.message || e).slice(0, 200)}`;

// Reads one document's text into the index and records the result. It never throws for a bad file.
export async function indexFile(fid) {
  const f = one("SELECT id,machine_id,signal_key,kind,mime,filename,title,data FROM files WHERE id=? AND kind='document'", fid);
  if (!f) return null;
  let status = null, reason = '', pages = [], chunks = [];
  try {
    let timer; pages = await Promise.race([extract(Buffer.from(f.data), f.mime), new Promise((_, no) => { timer = setTimeout(() => no(new Error('reading took more than two minutes')), TIMEOUT); timer.unref?.(); })]).finally(() => clearTimeout(timer));
    chunks = passagesOf(pages);
  } catch (e) { status = 'failed'; reason = failure(e); }
  if (!status) { status = chunks.length ? 'indexed' : 'no_text'; if (!chunks.length) reason = f.mime.startsWith('image/') ? NO_TEXT.image : f.mime === 'application/pdf' ? NO_TEXT.pdf : NO_TEXT.other; }
  const pageCount = pages.some(p => p.page != null) ? pages.length : null;
  transaction(() => {
    if (!one('SELECT 1 FROM files WHERE id=?', fid)) return; // removed while it was being read
    run('DELETE FROM passages WHERE file_id=?', fid);
    const doc = [f.title, f.filename].filter(Boolean).join(' ');
    for (const c of chunks) run('INSERT INTO passages (text,doc,machine_id,signal_key,file_id,page) VALUES (?,?,?,?,?,?)', c.text, doc, f.machine_id, f.signal_key, fid, c.page);
    run('INSERT INTO file_text (file_id,status,reason,pages,passages,indexed_at) VALUES (?,?,?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,pages=excluded.pages,passages=excluded.passages,indexed_at=excluded.indexed_at',
      fid, status, reason, pageCount, chunks.length, Date.now());
  });
  return { status, reason, passages: chunks.length };
}

// One document at a time, after the upload has been answered.
let chain = Promise.resolve();
export function queueIndex(fid) {
  try { run("INSERT INTO file_text (file_id,status) VALUES (?, 'pending') ON CONFLICT(file_id) DO UPDATE SET status='pending',reason=''", fid); } catch (e) { console.error('Could not queue document text:', e.message); }
  chain = chain.then(() => new Promise(r => setImmediate(r))).then(() => indexFile(fid)).catch(e => { if (!/not open/i.test(e.message)) console.error('Reading document text failed:', e.message); });
  return chain;
}
export const indexingDone = () => chain;
// At start-up: every document not read yet (uploaded before this feature, or interrupted by a restart).
export function indexPending() {
  const ids = all("SELECT f.id FROM files f LEFT JOIN file_text t ON t.file_id=f.id WHERE f.kind='document' AND (t.file_id IS NULL OR t.status='pending') ORDER BY f.uploaded_at").map(r => r.id);
  for (const fid of ids) queueIndex(fid);
  return ids.length;
}
export const textStatus = fid => { const t = one('SELECT status,reason,pages,passages FROM file_text WHERE file_id=?', fid); return t ? { ...t } : { status: 'pending', reason: '', pages: null, passages: 0 }; };

// ---- Search ----
const STOP = new Set('a an and are as at be been but by can could do does did for from had has have how i if in into is it its may me my no not of on or our should so than that the their them then there these they this those to was we were what when where which while who why will with would you your about after before also any each other over under up very more most out off only same such too again'.split(' '));
// An FTS5 query from free text: its distinct words as quoted terms joined by OR, so BM25 favours passages that hold
// more of them, rarer ones most. Quoting keeps FTS5 syntax in the text from being read as operators.
export function ftsQuery(text, max = 24) {
  const terms = [...new Set(String(text ?? '').normalize('NFKD').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(w => (w.length > 1 || /\d/.test(w)) && !STOP.has(w));
  return terms.slice(0, max).map(t => `"${t}"`).join(' OR ');
}
const KIND_WORDS = { limit: 'alarm limit exceeded', unusual: 'abnormal deviation', degrading: 'rising trend wear', pattern: 'fault troubleshooting' };
// The query for a finding: the signal (its label and key), which way it moved, what kind of finding it is and the
// machine type, plus the signals driving a pattern finding.
export function findingQuery(f, machine, sig) {
  const d = JSON.parse(f.detail_json || '{}'), dir = d.side ?? (d.direction === 'down' ? 'low' : d.direction === 'up' || f.kind === 'degrading' ? 'high' : '');
  const drivers = (d.contributors ?? []).map(c => one('SELECT label FROM signals WHERE machine_id=? AND key=?', f.machine_id, c.key)?.label ?? c.key.replaceAll('_', ' '));
  return [sig?.label, f.signal_key?.replaceAll('_', ' '), dir, KIND_WORDS[f.kind], ...drivers, MACHINE_TYPES[machine.type], 'cause check troubleshooting'].filter(Boolean).join(' ');
}

// The best passages for one machine: its own documents and its signals' documents, with those of `signal` counted a
// little higher. With related, other machines of the same type fill any places left (the same manual is often
// uploaded once). Each result: { fileId, document, filename, page, signalKey, machineTag, text, snippet, score }.
// The snippet marks matched words with \u0002 … \u0003.
export function search(machineId, text, { limit = 5, signal = null, related = false } = {}) {
  const q = ftsQuery(text), m = one('SELECT id,tag,type FROM machines WHERE id=?', machineId);
  if (!q || !m) return [];
  const find = where => all(`SELECT passages.rowid id, passages.text, passages.machine_id, passages.signal_key, passages.file_id, passages.page, bm25(passages, 1.0, 0.5) score,
      snippet(passages, 0, char(2), char(3), '…', 48) snippet, f.title, f.filename, mm.tag FROM passages JOIN files f ON f.id=passages.file_id JOIN machines mm ON mm.id=passages.machine_id
      WHERE passages MATCH ? AND ${where} ORDER BY score LIMIT 60`, q, m.id, ...(where.includes('type') ? [m.type] : []));
  const own = find('passages.machine_id=?').map(r => ({ ...r, score: r.score * (signal && r.signal_key === signal ? 1.25 : 1) })).sort((a, b) => a.score - b.score).slice(0, limit);
  const more = related && own.length < limit ? find('passages.machine_id<>? AND mm.type=?').slice(0, limit - own.length) : [];
  return [...own, ...more].map(r => ({ fileId: r.file_id, document: r.title || r.filename, filename: r.filename, page: r.page, signalKey: r.signal_key, machineTag: r.machine_id === m.id ? null : r.tag,
    text: r.text, snippet: r.snippet, score: Math.round(-r.score * 1000) / 1000 }));
}
export const searchable = machineId => one("SELECT COUNT(*) n FROM file_text t JOIN files f ON f.id=t.file_id WHERE f.machine_id=? AND t.status='indexed'", machineId).n;
