import { t as _t } from './i18n.js';
// Immersive repair guide for critical breakdowns. Opens full screen with three panels around the technician: the
// machine (picture and breakdown), the current repair step, and the hazards and PPE. "Enter VR" starts a WebXR
// session on a headset (for example the Meta Quest browser); controllers or hand pinch select Back / Next. Without a
// headset the same scene works on a phone, tablet or PC: drag to look around, tap the 3D buttons or use the toolbar
// and arrow keys. three.js is loaded only when the view opens.
const W=1024;
function wrap(ctx,text,maxWidth) {
  const lines=[];
  for (const para of String(text??'').split('\n')) {
    let line='';
    for (const word of para.split(/\s+/).filter(Boolean)) { const test=line?`${line} ${word}`:word; if (ctx.measureText(test).width>maxWidth&&line) { lines.push(line); line=word; } else line=test; }
    lines.push(line);
  }
  return lines;
}
function text(ctx,str,x,y,{size=34,weight=400,color='#e8f3f2',width=W-96,lineHeight=1.3,maxLines=99}={}) {
  ctx.font=`${weight} ${size}px system-ui, Segoe UI, sans-serif`; ctx.fillStyle=color;
  const lines=wrap(ctx,str,width); const shown=lines.slice(0,maxLines); if (lines.length>maxLines) shown[maxLines-1]=shown[maxLines-1].replace(/.{0,2}$/,'…');
  shown.forEach((l,i)=>ctx.fillText(l,x,y+i*size*lineHeight)); return y+shown.length*size*lineHeight;
}
function card(ctx,h,{accent='#2bb3a3'}={}) {
  ctx.clearRect(0,0,W,h); ctx.fillStyle='rgba(13,35,43,0.94)'; ctx.beginPath(); ctx.roundRect(4,4,W-8,h-8,36); ctx.fill();
  ctx.lineWidth=6; ctx.strokeStyle=accent; ctx.stroke();
}

export async function openVrGuide({title,machine,guide,image=null,critical=false}) {
  const THREE=await import('/vendor/three.min.js');
  const steps=guide.steps||[]; let index=0;
  const root=document.createElement('div');
  root.setAttribute('role','dialog'); root.setAttribute('aria-label',_t('vr.vrRepairGuide2'));
  root.style.cssText='position:fixed;inset:0;z-index:2147483000;background:#081419;color:#e8f3f2;font-family:system-ui,Segoe UI,sans-serif;touch-action:none';
  root.innerHTML=`<div style="position:absolute;top:0;left:0;right:0;display:flex;gap:8px;align-items:center;padding:10px 12px;background:linear-gradient(#081419ee,#08141900);z-index:2;flex-wrap:wrap">
    <b style="flex:1;min-width:160px;font-size:15px">${_t('vr.vrRepairGuide',{value:critical?_t('vr.critical'):''})}</b>
    <span data-count style="font-size:14px"></span>
    <button data-prev style="${btnCss}">${_t('vr.back')}</button><button data-next style="${btnCss}">${_t('vr.next')}</button>
    <button data-xr hidden style="${btnCss};background:#2bb3a3;color:#04221e">${_t('vr.enterVr')}</button><button data-exit style="${btnCss}">${_t('vr.exit')}</button></div>
    <p style="position:absolute;bottom:8px;left:0;right:0;text-align:center;font-size:13px;color:#9fbfbe;margin:0;z-index:2">${_t('vr.dragToLookAroundTap')}</p>`;
  document.body.append(root);

  const renderer=new THREE.WebGLRenderer({antialias:true}); renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.setSize(innerWidth,innerHeight); renderer.xr.enabled=true;
  renderer.domElement.style.cssText='display:block;width:100%;height:100%'; root.prepend(renderer.domElement);
  const scene=new THREE.Scene(); scene.background=new THREE.Color(0x081419);
  const camera=new THREE.PerspectiveCamera(70,innerWidth/innerHeight,0.05,100); camera.position.set(0,1.6,0); camera.rotation.order='YXZ';
  const grid=new THREE.GridHelper(24,24,0x2bb3a3,0x16343c); scene.add(grid);

  // A panel is a canvas texture on a plane, placed on a circle around the viewer and turned to face them.
  const panels=[];
  function panel(h,widthM,angleDeg,y,draw,name) {
    const canvas=Object.assign(document.createElement('canvas'),{width:W,height:h}), ctx=canvas.getContext('2d'), texture=new THREE.CanvasTexture(canvas);
    texture.colorSpace=THREE.SRGBColorSpace;
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(widthM,widthM*h/W),new THREE.MeshBasicMaterial({map:texture,transparent:true}));
    const a=angleDeg*Math.PI/180, r=2.4; mesh.position.set(Math.sin(a)*r,y,-Math.cos(a)*r); mesh.lookAt(0,y,0); mesh.name=name||'';
    const p={mesh,redraw:()=>{ draw(ctx); texture.needsUpdate=true; }}; p.redraw(); scene.add(mesh); panels.push(p); return p;
  }
  let photo=null;
  const machinePanel=panel(1100,1.3,-48,1.6,ctx=>{
    card(ctx,1100);
    let y=70; y=text(ctx,_t('vr.machine'),48,y,{size:30,weight:700,color:'#7fd6cb'});
    if (photo) { const h=480, w=Math.min(W-96,photo.width*h/photo.height); ctx.save(); ctx.beginPath(); ctx.roundRect((W-w)/2,y,w,h,18); ctx.clip(); ctx.drawImage(photo,(W-w)/2,y,w,h); ctx.restore(); y+=h+50; }
    y=text(ctx,machine.name,48,y+10,{size:44,weight:700,maxLines:2});
    y=text(ctx,machine.detail,48,y+6,{size:30,color:'#b8d4d2',maxLines:3});
    y=text(ctx,title,48,y+30,{size:36,weight:700,color:'#ffd27a',maxLines:3});
    text(ctx,machine.report,48,y+8,{size:30,maxLines:critical?5:7});
  },'machine');
  const stepPanel=panel(1000,1.5,0,1.78,ctx=>{
    card(ctx,1000,{accent:critical?'#e0675f':'#2bb3a3'});
    let y=74;
    if (critical) { const label='CRITICAL · SAFETY FIRST'; ctx.font='800 28px system-ui, Segoe UI, sans-serif'; const w=ctx.measureText(label).width+36; ctx.fillStyle='#b0413e'; ctx.beginPath(); ctx.roundRect(48,y-44,w,58,12); ctx.fill(); text(ctx,label,66,y-4,{size:28,weight:800,color:'#fff'}); y+=50; }
    const s=steps[index];
    if (!s) { text(ctx,_t('vr.noStepsInThisGuide'),48,y+40,{size:40}); return; }
    y=text(ctx,`Step ${index+1} of ${steps.length}`,48,y+20,{size:32,weight:700,color:'#7fd6cb'});
    y=text(ctx,s.title,48,y+24,{size:58,weight:800,maxLines:2});
    y=text(ctx,s.instruction,48,y+24,{size:40,maxLines:8});
    if (s.check) { const top=Math.min(y+30,1000-230); ctx.fillStyle='rgba(43,179,163,0.18)'; ctx.beginPath(); ctx.roundRect(40,top,W-80,180,18); ctx.fill(); text(ctx,'✓ Check',64,top+52,{size:30,weight:700,color:'#7fd6cb'}); text(ctx,s.check,64,top+98,{size:32,maxLines:2,width:W-140}); }
    // Progress dots
    const n=steps.length, gap=Math.min(40,(W-120)/Math.max(n,1)); for (let i=0;i<n;i++) { ctx.fillStyle=i===index?'#2bb3a3':i<index?'#3d7f78':'#2a4950'; ctx.beginPath(); ctx.arc(W/2-(n-1)*gap/2+i*gap,960,i===index?11:8,0,Math.PI*2); ctx.fill(); }
  },'step');
  panel(1100,1.3,48,1.6,ctx=>{
    card(ctx,1100,{accent:'#e0a64f'});
    let y=70; y=text(ctx,'⚠ Hazards',48,y,{size:34,weight:800,color:'#ffd27a'});
    for (const h of (guide.hazards||[]).slice(0,6)) y=text(ctx,`• ${h}`,48,y+14,{size:30,maxLines:3});
    y=text(ctx,_t('vr.ppeRequired'),48,y+50,{size:34,weight:800,color:'#ffd27a'});
    for (const p of (guide.ppe||[]).slice(0,6)) y=text(ctx,`• ${p}`,48,y+14,{size:30,maxLines:2});
    if (guide.summary) text(ctx,guide.summary,48,Math.max(y+50,820),{size:26,color:'#9fbfbe',maxLines:6});
  },'hazards');
  const button=(label,angle,name)=>panel(220,0.5,angle,0.84,ctx=>{ ctx.clearRect(0,0,W,220); ctx.fillStyle='#2bb3a3'; ctx.beginPath(); ctx.roundRect(8,8,W-16,204,60); ctx.fill(); ctx.textAlign='center'; text(ctx,label,W/2,140,{size:96,weight:800,color:'#04221e',width:W}); ctx.textAlign='left'; },name);
  button(_t('vr.back'),-12,'prev'); button(_t('vr.next'),12,'next');

  const count=root.querySelector('[data-count]');
  const go=delta=>{ index=Math.max(0,Math.min(steps.length-1,index+delta)); stepPanel.redraw(); count.textContent=steps.length?`${_t('vr.step',{value:index+1,length:steps.length})}`:''; };
  go(0);
  if (image) { const img=new Image(); img.onload=()=>{ photo=img; machinePanel.redraw(); }; img.src=image; }

  // Selecting: a click or tap on the canvas, or a controller / hand "select" in VR, along a ray.
  const raycaster=new THREE.Raycaster(), targets=()=>panels.map(p=>p.mesh).filter(m=>m.name==='prev'||m.name==='next');
  const act=hit=>{ if (hit?.object.name==='next') go(1); if (hit?.object.name==='prev') go(-1); };
  let drag=null;
  const onDown=e=>{ drag={x:e.clientX,y:e.clientY,moved:false,yaw:camera.rotation.y,pitch:camera.rotation.x}; };
  const onMove=e=>{ if (!drag||renderer.xr.isPresenting) return; const dx=e.clientX-drag.x, dy=e.clientY-drag.y; if (Math.abs(dx)+Math.abs(dy)>6) drag.moved=true;
    camera.rotation.y=drag.yaw+dx*0.005; camera.rotation.x=Math.max(-1.2,Math.min(1.2,drag.pitch+dy*0.005)); };
  const onUp=e=>{ if (drag&&!drag.moved) { const r=renderer.domElement.getBoundingClientRect(); raycaster.setFromCamera(new THREE.Vector2(((e.clientX-r.left)/r.width)*2-1,-((e.clientY-r.top)/r.height)*2+1),camera); act(raycaster.intersectObjects(targets())[0]); } drag=null; };
  renderer.domElement.addEventListener('pointerdown',onDown); addEventListener('pointermove',onMove); addEventListener('pointerup',onUp);
  const tempMatrix=new THREE.Matrix4();
  for (const i of [0,1]) {
    const c=renderer.xr.getController(i);
    c.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(0,0,-4)]),new THREE.LineBasicMaterial({color:0x7fd6cb})));
    c.addEventListener('select',()=>{ tempMatrix.identity().extractRotation(c.matrixWorld); raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld); raycaster.ray.direction.set(0,0,-1).applyMatrix4(tempMatrix); act(raycaster.intersectObjects(targets())[0]); });
    scene.add(c);
  }

  const onKey=e=>{ if (e.key==='ArrowRight') go(1); if (e.key==='ArrowLeft') go(-1); if (e.key==='Escape') close(); };
  const onResize=()=>{ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight); };
  addEventListener('keydown',onKey); addEventListener('resize',onResize);
  root.querySelector('[data-prev]').onclick=()=>go(-1); root.querySelector('[data-next]').onclick=()=>go(1);
  const xrBtn=root.querySelector('[data-xr]');
  if (navigator.xr?.isSessionSupported) navigator.xr.isSessionSupported('immersive-vr').then(ok=>{ xrBtn.hidden=!ok; }).catch(()=>{});
  xrBtn.onclick=async()=>{
    if (renderer.xr.isPresenting) return renderer.xr.getSession().end();
    try { const session=await navigator.xr.requestSession('immersive-vr',{optionalFeatures:['local-floor','hand-tracking']}); renderer.xr.setReferenceSpaceType('local-floor'); await renderer.xr.setSession(session); xrBtn.textContent=_t('vr.exitVr'); session.addEventListener('end',()=>{ xrBtn.textContent=_t('vr.enterVr'); }); }
    catch (err) { xrBtn.textContent=_t('vr.vrUnavailable'); xrBtn.disabled=true; console.warn(_t('vr.webxr'),err); }
  };
  renderer.setAnimationLoop(()=>renderer.render(scene,camera));
  function close() {
    renderer.xr.getSession()?.end().catch(()=>{}); renderer.setAnimationLoop(null);
    removeEventListener('keydown',onKey); removeEventListener('resize',onResize); removeEventListener('pointermove',onMove); removeEventListener('pointerup',onUp);
    scene.traverse(o=>{ o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); }); renderer.dispose(); root.remove();
  }
  root.querySelector('[data-exit]').onclick=close;
  return {close,go};
}
const btnCss='border:0;border-radius:8px;padding:9px 13px;font:inherit;font-weight:700;background:#e4efef;color:#12323d;cursor:pointer';
