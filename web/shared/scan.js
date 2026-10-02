// Identifying a machine at the machine, shared by the web workspace and the field app:
// - the camera reads the printed QR label (BarcodeDetector: Chrome and Edge on Android, ChromeOS, macOS and Windows);
// - the phone's NFC reads an HF RFID/NFC tag (Web NFC: Chrome on Android); a text record "MC:…" counts as the QR code,
//   otherwise the tag's UID is used;
// - handheld UHF RFID readers and USB/Bluetooth barcode scanners type into the focused field like a keyboard and end
//   with Enter, so the plain text field covers them, and the code printed under the label can be typed by hand.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const canCamera=()=>'BarcodeDetector' in window&&!!navigator.mediaDevices?.getUserMedia;
export const canNfc=()=>'NDEFReader' in window;

// Opens the rear camera in a modal and resolves with the first QR code read; rejects on cancel.
export async function scanQr() {
  if (!canCamera()) throw Error('This browser cannot read QR codes with the camera. Type the code under the label, or use a scanner.');
  const formats=await BarcodeDetector.getSupportedFormats?.().catch(()=>[])||[];
  if (formats.length&&!formats.includes('qr_code')) throw Error('This browser cannot read QR codes with the camera.');
  const detector=new BarcodeDetector({formats:['qr_code']});
  const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
  const d=document.createElement('dialog');
  d.setAttribute('aria-label','Scan the equipment QR label');
  d.style.cssText='padding:0;border:0;border-radius:14px;background:#0e2630;color:#fff;width:min(92vw,460px);max-width:none';
  d.innerHTML='<video playsinline muted style="display:block;width:100%;aspect-ratio:1;object-fit:cover;background:#000"></video><div style="display:flex;gap:10px;align-items:center;justify-content:space-between;padding:12px 14px"><span style="font-size:14px">Point the camera at the QR label</span><button type="button" data-cancel style="border:0;border-radius:8px;padding:9px 14px;font:inherit;font-weight:700;background:#e4efef;color:#1d4d53;cursor:pointer">Cancel</button></div>';
  document.body.append(d); d.showModal();
  const video=d.querySelector('video'); video.srcObject=stream; await video.play().catch(()=>{});
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(fn,value)=>{ if (done) return; done=true; stream.getTracks().forEach(t=>t.stop()); if (d.open) d.close(); d.remove(); fn(value); };
    d.querySelector('[data-cancel]').onclick=()=>finish(reject,Error('Scan cancelled'));
    d.addEventListener('cancel',e=>{ e.preventDefault(); finish(reject,Error('Scan cancelled')); });
    const tick=async()=>{ if (done) return; try { const [hit]=await detector.detect(video); if (hit?.rawValue) return finish(resolve,hit.rawValue.trim()); } catch {} setTimeout(tick,200); };
    tick();
  });
}

// Waits for an NFC/RFID tag to be held to the phone (up to 30 s). uid: return the tag's UID even if it holds an MC: record.
export async function readNfc({uid=false}={}) {
  if (!canNfc()) throw Error('This device cannot read RFID/NFC tags in the browser. Use a handheld reader, or type the tag number.');
  const reader=new NDEFReader(), stop=new AbortController();
  await reader.scan({signal:stop.signal});
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ stop.abort(); reject(Error('No tag read. Hold the phone against the tag and try again.')); },30000);
    reader.onreadingerror=()=>{};
    reader.onreading=e=>{
      clearTimeout(timer); stop.abort();
      const text=[...(e.message?.records||[])].filter(r=>r.recordType==='text'||r.recordType==='url').map(r=>{ try { return new TextDecoder(r.encoding||'utf-8').decode(r.data); } catch { return ''; } }).find(x=>/^MC:/i.test(x.trim()));
      resolve(((uid?'':text)||e.serialNumber||'').trim());
    };
  });
}

// A scan field: the code input plus camera and NFC buttons where the device supports them.
// camera:false for a field that only takes RFID tags; uid:true to read the tag's UID (registering a tag).
export function scanInput(name,{value='',placeholder='Scan, or type the code under the label',required=false,inputClass='',camera=true,uid=false}={}) {
  return `<div class="scan-input" data-scan-for="${esc(name)}" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><input name="${esc(name)}" id="f-${esc(name)}" class="${esc(inputClass)}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="characters" spellcheck="false" ${required?'required aria-required="true"':''} style="flex:1 1 200px;min-width:0">${camera&&canCamera()?'<button type="button" class="secondary small" data-scan="camera">Scan QR</button>':''}${canNfc()?`<button type="button" class="secondary small" data-scan="nfc"${uid?' data-uid="1"':''}>Read RFID/NFC tag</button>`:''}</div>`;
}

// Wires a scan field: a code from the camera, NFC, or a scanner's Enter (which must not submit the form) calls onCode.
export function bindScanInput(root,name,onCode,onError=()=>{}) {
  const box=root.querySelector(`[data-scan-for="${name}"]`); if (!box) return;
  const input=box.querySelector('input');
  const use=async code=>{ input.value=code; try { await onCode(code); } catch (e) { onError(e); } };
  input.addEventListener('keydown',e=>{ if (e.key==='Enter') { e.preventDefault(); if (input.value.trim()) use(input.value.trim()); } });
  input.addEventListener('change',()=>{ if (input.value.trim()) use(input.value.trim()); });
  box.querySelectorAll('[data-scan]').forEach(b=>b.onclick=async()=>{
    const label=b.textContent; b.disabled=true; if (b.dataset.scan==='nfc') b.textContent='Hold the tag to the phone…';
    try { const code=b.dataset.scan==='camera'?await scanQr():await readNfc({uid:!!b.dataset.uid}); if (code) await use(code); }
    catch (e) { if (e.message!=='Scan cancelled') onError(e); }
    finally { b.disabled=false; b.textContent=label; }
  });
}
