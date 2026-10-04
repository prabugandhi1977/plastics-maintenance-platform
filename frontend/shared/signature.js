// Finger/stylus/mouse signature pad on a canvas. Exports a PNG (base64, no data: prefix) for the sign-off API.
export function signaturePad(canvas) {
  const ctx=canvas.getContext('2d'), ratio=window.devicePixelRatio||1;
  const size=()=>{ const r=canvas.getBoundingClientRect(); canvas.width=r.width*ratio; canvas.height=r.height*ratio; ctx.scale(ratio,ratio); ctx.lineWidth=2.2; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.strokeStyle='#12323d'; ctx.fillStyle='#fff'; ctx.fillRect(0,0,r.width,r.height); };
  size();
  let drawing=false, strokes=0;
  const point=e=>{ const r=canvas.getBoundingClientRect(); return [e.clientX-r.left,e.clientY-r.top]; };
  canvas.style.touchAction='none';
  canvas.addEventListener('pointerdown',e=>{ drawing=true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...point(e)); });
  canvas.addEventListener('pointermove',e=>{ if (!drawing) return; ctx.lineTo(...point(e)); ctx.stroke(); strokes++; });
  const stop=()=>{ drawing=false; };
  canvas.addEventListener('pointerup',stop); canvas.addEventListener('pointercancel',stop);
  return {
    isEmpty:()=>strokes<5,
    clear:()=>{ ctx.setTransform(1,0,0,1,0,0); strokes=0; size(); },
    toBase64:()=>canvas.toDataURL('image/png').split(',')[1]
  };
}
