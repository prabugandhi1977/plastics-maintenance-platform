// QR label for an equipment record, as inline SVG. Uses the qrcode-generator library (MIT, vendored), so any code
// fits: the platform's own MC:… codes and the longer codes or URLs of labels a plant already uses.
import qrcode from './vendor/qrcode.min.js';

qrcode.stringToBytes=s=>[...new TextEncoder().encode(s)];
export function qrSvg(value,size=144) {
  const q=qrcode(0,'M'); q.addData(String(value),'Byte'); q.make();
  const n=q.getModuleCount(), paths=[];
  for (let y=0;y<n;y++) for (let x=0;x<n;x++) if (q.isDark(y,x)) paths.push(`M${x+4} ${y+4}h1v1h-1z`);
  const label=String(value).replace(/[&<>"']/g,'');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${n+8} ${n+8}" role="img" aria-label="QR code for ${label}" shape-rendering="crispEdges"><rect width="${n+8}" height="${n+8}" fill="white"/><path d="${paths.join('')}" fill="#142e3d"/></svg>`;
}
