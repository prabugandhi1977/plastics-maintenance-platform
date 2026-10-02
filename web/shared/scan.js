// Identifying a machine at the machine, shared by the web workspace and the field app:
// - the camera reads the printed QR label: with the browser's BarcodeDetector where it has one (Chrome, Edge), and
//   otherwise with the jsQR library (vendored, Apache-2.0), so iPhone Safari and Firefox scan too;
// - the phone's NFC reads an HF RFID/NFC tag (Web NFC: Chrome on Android); a text record "MC:…" counts as the QR code,
//   otherwise the tag's UID is used;
// - handheld UHF RFID readers and USB/Bluetooth barcode scanners type into the focused field like a keyboard and end
//   with Enter, so the plain text field covers them, and the code printed under the label can be typed by hand.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const canCamera=()=>!!navigator.mediaDevices?.getUserMedia&&window.isSecureContext!==false;
export const canNfc=()=>'NDEFReader' in window;

// A QR decoder for video frames: the built-in one when it reads QR codes, else jsQR on a downscaled canvas copy.
async function qrDecoder() {
  if ('BarcodeDetector' in window) {
    const formats=await BarcodeDetector.getSupportedFormats?.().catch(()=>[])||[];
    if (formats.includes('qr_code')) { const detector=new BarcodeDetector({formats:['qr_code']}); return async video=>(await detector.detect(video))[0]?.rawValue; }
  }
  const { default: jsQR }=await import('/vendor/jsqr.min.js');
  const canvas=document.createElement('canvas'), ctx=canvas.getContext('2d',{willReadFrequently:true});
  return async video=>{
    if (!video.videoWidth) return null;
    const scale=Math.min(1,720/Math.max(video.videoWidth,video.videoHeight)); canvas.width=Math.round(video.videoWidth*scale); canvas.height=Math.round(video.videoHeight*scale);
    ctx.drawImage(video,0,0,canvas.width,canvas.height); const img=ctx.getImageData(0,0,canvas.width,canvas.height);
    return jsQR(img.data,img.width,img.height,{inversionAttempts:'attemptBoth'})?.data;
  };
}
const cameraError=e=>Error(e?.name==='NotAllowedError'?'Camera access was refused. Allow the camera for this site in the browser settings, then try again.'
  :e?.name==='NotFoundError'||e?.name==='OverconstrainedError'?'No camera was found on this device. Use a scanner, or type the code printed under the label.'
  :e?.name==='NotReadableError'?'The camera is in use by another app. Close it and try again.':`The camera could not start${e?.message?`: ${e.message}`:''}.`);

// Opens the rear camera in a modal and resolves with the first QR code read; rejects on cancel.
export async function scanQr() {
  if (!canCamera()) throw Error('This browser cannot use the camera here. Type the code printed under the label, or use a scanner.');
  const decode=await qrDecoder();
  let stream; try { stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false}); } catch (e) { throw cameraError(e); }
  const d=document.createElement('dialog');
  d.setAttribute('aria-label','Scan the equipment QR label');
  d.style.cssText='padding:0;border:0;border-radius:14px;background:#0e2630;color:#fff;width:min(92vw,460px);max-width:none';
  d.innerHTML='<video playsinline muted autoplay style="display:block;width:100%;aspect-ratio:1;object-fit:cover;background:#000"></video><div style="display:flex;gap:10px;align-items:center;justify-content:space-between;padding:12px 14px"><span style="font-size:14px">Point the camera at the QR label</span><button type="button" data-cancel style="border:0;border-radius:8px;padding:9px 14px;font:inherit;font-weight:700;background:#e4efef;color:#1d4d53;cursor:pointer">Cancel</button></div>';
  document.body.append(d); d.showModal();
  const video=d.querySelector('video'); video.srcObject=stream; await video.play().catch(()=>{});
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(fn,value)=>{ if (done) return; done=true; stream.getTracks().forEach(t=>t.stop()); if (d.open) d.close(); d.remove(); fn(value); };
    d.querySelector('[data-cancel]').onclick=()=>finish(reject,Error('Scan cancelled'));
    d.addEventListener('cancel',e=>{ e.preventDefault(); finish(reject,Error('Scan cancelled')); });
    const tick=async()=>{ if (done) return; try { const value=await decode(video); if (value) return finish(resolve,String(value).trim()); } catch {} setTimeout(tick,200); };
    tick();
  });
}

// Waits for an NFC/RFID tag to be held to the phone (up to 30 s). uid: return the tag's UID even if it holds an MC: record.
export async function readNfc({uid=false}={}) {
  if (!canNfc()) throw Error('Reading tags with the phone needs Chrome on an Android phone with NFC. Use a handheld RFID reader, or type the number printed on the tag.');
  const reader=new NDEFReader(), stop=new AbortController();
  try { await reader.scan({signal:stop.signal}); }
  catch (e) { throw Error(e?.name==='NotAllowedError'?'NFC is switched off or not allowed. Turn on NFC in the phone settings, allow it for this site, and try again.'
    :e?.name==='NotSupportedError'?'This phone has no NFC reader. Use a handheld RFID reader, or type the number printed on the tag.':`NFC could not start${e?.message?`: ${e.message}`:''}.`); }
  return new Promise((resolve,reject)=>{
    const fail=message=>{ clearTimeout(timer); stop.abort(); reject(Error(message)); };
    const timer=setTimeout(()=>fail('No tag read. Hold the top of the phone flat against the tag for a second and try again.'),30000);
    // Many industrial tags (UHF, or HF tags that are not NFC-formatted) cannot be read by phones.
    reader.onreadingerror=()=>fail('The phone found a tag but cannot read this type. Use a handheld RFID reader, or type the number printed on the tag.');
    reader.onreading=e=>{
      const text=[...(e.message?.records||[])].filter(r=>r.recordType==='text'||r.recordType==='url').map(r=>{ try { return new TextDecoder(r.encoding||'utf-8').decode(r.data); } catch { return ''; } }).find(x=>/^MC:/i.test(x.trim()));
      const value=((uid?'':text)||e.serialNumber||'').trim();
      if (!value) return fail('The tag has no readable ID. Type the number printed on the tag instead.');
      clearTimeout(timer); stop.abort(); resolve(value);
    };
  });
}

// A scan field: the code input plus camera and NFC buttons where the device supports them.
// camera:false for a field that only takes RFID tags; uid:true to read the tag's UID (registering a tag);
// nfcHint: explain how to read tags when this device cannot.
export function scanInput(name,{value='',placeholder='Scan, or type the code under the label',required=false,inputClass='',camera=true,uid=false,nfcHint=false}={}) {
  return `<div class="scan-input" data-scan-for="${esc(name)}" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><input name="${esc(name)}" id="f-${esc(name)}" class="${esc(inputClass)}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="characters" spellcheck="false" ${required?'required aria-required="true"':''} style="flex:1 1 200px;min-width:0">${camera&&canCamera()?'<button type="button" class="secondary small" data-scan="camera">Scan QR</button>':''}${canNfc()?`<button type="button" class="secondary small" data-scan="nfc"${uid?' data-uid="1"':''}>Read RFID/NFC tag</button>`:''}</div><small class="help scan-msg" role="status" hidden></small>${nfcHint&&!canNfc()?'<small class="help scan-hint">To read tags with the phone, use Chrome on an Android phone with NFC on. Here, use a USB or Bluetooth reader, or type the number printed on the tag.</small>':''}`;
}

// Wires a scan field: a code from the camera, NFC, or a scanner's Enter (which must not submit the form) calls onCode.
// Without onError, results and problems show in the line under the field (a toast would sit behind an open dialog).
export function bindScanInput(root,name,onCode,onError) {
  const box=root.querySelector(`[data-scan-for="${name}"]`); if (!box) return;
  const input=box.querySelector('input'), msg=box.nextElementSibling?.classList.contains('scan-msg')?box.nextElementSibling:null;
  const say=(text,ok)=>{ if (!msg) return; msg.hidden=!text; msg.textContent=text||''; msg.classList.toggle('scan-ok',ok===true); msg.classList.toggle('scan-bad',ok===false); };
  const report=e=>{ if (onError) onError(e); else say(e.message,false); };
  const use=async (code,via)=>{ input.value=code; try { await onCode(code); if (!onError&&via) say(`✓ Read: ${code}`,true); } catch (e) { report(e); } };
  input.addEventListener('input',()=>say(''));
  input.addEventListener('keydown',e=>{ if (e.key==='Enter') { e.preventDefault(); if (input.value.trim()) use(input.value.trim()); } });
  input.addEventListener('change',()=>{ if (input.value.trim()) use(input.value.trim()); });
  box.querySelectorAll('[data-scan]').forEach(b=>b.onclick=async()=>{
    const label=b.textContent; b.disabled=true; if (b.dataset.scan==='nfc') b.textContent='Hold the tag to the phone…';
    say(b.dataset.scan==='nfc'?'Hold the phone against the tag…':'');
    try { const code=b.dataset.scan==='camera'?await scanQr():await readNfc({uid:!!b.dataset.uid}); if (code) await use(code,b.dataset.scan); }
    catch (e) { if (e.message==='Scan cancelled') say(''); else report(e); }
    finally { b.disabled=false; b.textContent=label; }
  });
}
