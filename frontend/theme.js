// Colour theme, applied before the page draws so a dark theme never flashes light. The choice (light, dark or auto,
// which follows the device) is kept per browser; mcTheme.set() switches it and fires "mc-theme" so the app redraws.
(function () {
  const KEY='mc_theme', media=window.matchMedia('(prefers-color-scheme: dark)');
  const read=()=>{ try { const v=localStorage.getItem(KEY); return ['light','dark','auto'].includes(v)?v:'light'; } catch { return 'light'; } };
  const apply=()=>{ const choice=read(), root=document.documentElement; root.dataset.theme=choice; root.classList.toggle('dark',choice==='dark'||(choice==='auto'&&media.matches)); };
  apply();
  media.addEventListener('change',()=>{ apply(); window.dispatchEvent(new Event('mc-theme')); });
  window.mcTheme={ get:read, set:choice=>{ try { localStorage.setItem(KEY,choice); } catch {} apply(); window.dispatchEvent(new Event('mc-theme')); } };
})();
