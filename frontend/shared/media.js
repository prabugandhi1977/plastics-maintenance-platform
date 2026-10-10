import { t, t as _t } from './i18n.js';
// Equipment pictures and icons, and chat text formatting, shared by the web workspace and the field app.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// A simple line icon per machine type, used where an asset has no picture.
const GLYPHS={
  injection:'<rect x="6" y="20" width="52" height="22" rx="3"/><rect x="34" y="12" width="10" height="8"/><path d="M40 12l-4-6h8z"/><path d="M6 31h-3M12 42v6M52 42v6"/><rect x="10" y="25" width="14" height="12" rx="1"/>',
  blow:'<path d="M26 8h12v6l4 6v28a6 6 0 0 1-6 6h-8a6 6 0 0 1-6-6V20l4-6z"/><path d="M22 30h20"/>',
  extrusion:'<rect x="4" y="22" width="34" height="14" rx="3"/><path d="M14 22l-3-10h10l-3 10M38 26h8v6h-8M46 29h14"/><path d="M8 36v8M32 36v8"/>',
  mould:'<rect x="10" y="10" width="44" height="44" rx="3"/><circle cx="24" cy="24" r="5"/><circle cx="40" cy="24" r="5"/><circle cx="24" cy="40" r="5"/><circle cx="40" cy="40" r="5"/>',
  auxiliary:'<path d="M20 8h24l-4 22H24z"/><rect x="18" y="30" width="28" height="18" rx="2"/><circle cx="32" cy="39" r="5"/><path d="M24 48v8M40 48v8"/>',
};
export function machineIcon(type,size=48,label='') {
  return `<svg class="machine-icon" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${esc(label||type||_t('media.equipment'))}" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">${GLYPHS[type]||GLYPHS.auxiliary}</svg>`;
}

// Pictures are private: they are fetched with the sign-in token and shown from a blob URL. Markup carries
// <img data-auth-src="/api/equipment/<id>/image?v=<attachment id>">; the version makes a new picture load fresh.
const cache=new Map();
export async function authImageUrl(src,token) {
  if (!cache.has(src)) cache.set(src,fetch(src,{headers:{authorization:`Bearer ${token}`}}).then(r=>r.ok?r.blob():null).then(b=>b&&URL.createObjectURL(b)).catch(()=>null));
  return cache.get(src);
}
export function loadAuthImages(root,token) {
  root.querySelectorAll('img[data-auth-src]:not([src])').forEach(async img=>{ const url=await authImageUrl(img.dataset.authSrc,token); if (url) img.src=url; else img.replaceWith(Object.assign(document.createElement('span'),{className:'img-missing'})); });
}
export const imageSrc=e=>e?.image_attachment_id?`/api/equipment/${encodeURIComponent(e.id)}/image?v=${encodeURIComponent(e.image_attachment_id)}`:null;
// The asset's picture, or its machine-type icon.
export function assetVisual(e,size=48,cls='asset-visual') {
  const src=imageSrc(e);
  return `<span class="${cls}" style="width:${size}px;height:${size}px">${src?`<img data-auth-src="${esc(src)}" alt="${esc(`${e.make||''} ${e.model||''}`.trim()||_t('media.equipment'))}" width="${size}" height="${size}">`:machineIcon(e?.machine_type,Math.round(size*0.8),e?.machine_type)}</span>`;
}

// Assistant replies use light Markdown: paragraphs, numbered and bulleted lists, **bold**. Everything is escaped first.
export function chatText(text) {
  const inline=s=>esc(s).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/`([^`]+)`/g,'<code>$1</code>');
  const out=[]; let list=null;
  const close=()=>{ if (list) { out.push(`</${list}>`); list=null; } };
  for (const raw of String(text??'').split('\n')) {
    const line=raw.trimEnd(), num=line.match(/^\s*\d+[.)]\s+(.*)$/), bullet=line.match(/^\s*[-*•]\s+(.*)$/), head=line.match(/^\s*#{1,4}\s+(.*)$/);
    if (num||bullet) { const kind=num?'ol':'ul'; if (list!==kind) { close(); out.push(`<${kind}>`); list=kind; } out.push(`<li>${inline((num||bullet)[1])}</li>`); continue; }
    close();
    if (head) out.push(`<p><b>${inline(head[1])}</b></p>`); else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  close(); return out.join('');
}
