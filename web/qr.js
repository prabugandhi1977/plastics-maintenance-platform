// Minimal QR Code Model 1, version 1-L encoder for short equipment labels (up to 17 UTF-8 bytes).
// The stored QR payload is a random, non-secret lookup code such as MC:ab12cd34ef56.
export function qrSvg(value,size=144) {
  const bytes=new TextEncoder().encode(value); if (bytes.length>17) throw new Error('QR label too long');
  const bits=[]; const push=(n,count)=>{ for(let i=count-1;i>=0;i--) bits.push((n>>>i)&1); };
  push(4,4); push(bytes.length,8); for(const b of bytes) push(b,8);
  for(let i=0;i<4&&bits.length<152;i++) bits.push(0);
  while(bits.length%8) bits.push(0);
  const data=[]; for(let i=0;i<bits.length;i+=8) data.push(parseInt(bits.slice(i,i+8).join(''),2));
  let pad=0; while(data.length<19) data.push(pad++%2?0x11:0xec);
  const mul=(a,b)=>{ let z=0; for(let i=7;i>=0;i--) { z=(z<<1)^((z&0x80)?0x11d:0); if((b>>i)&1) z^=a; } return z; };
  let gen=[1]; for(let i=0,p=1;i<7;i++,p=mul(p,2)) { const next=Array(gen.length+1).fill(0); gen.forEach((x,j)=>{next[j]^=x; next[j+1]^=mul(x,p);}); gen=next; }
  const rem=Array(7).fill(0); for(const b of data) { const factor=b^rem.shift(); rem.push(0); for(let j=0;j<7;j++) rem[j]^=mul(gen[j+1],factor); }
  const code=[...data,...rem], stream=code.flatMap(b=>Array.from({length:8},(_,i)=>(b>>(7-i))&1));
  const grid=Array.from({length:21},()=>Array(21).fill(false)), reserved=Array.from({length:21},()=>Array(21).fill(false));
  const set=(x,y,dark)=>{ if(x>=0&&x<21&&y>=0&&y<21) {grid[y][x]=!!dark;reserved[y][x]=true;} };
  for(const [ox,oy] of [[0,0],[14,0],[0,14]]) for(let y=-1;y<=7;y++) for(let x=-1;x<=7;x++) { const on=x>=0&&x<=6&&y>=0&&y<=6&&(x===0||x===6||y===0||y===6||(x>=2&&x<=4&&y>=2&&y<=4)); set(ox+x,oy+y,on); }
  for(let i=8;i<13;i++) { set(i,6,i%2===0); set(6,i,i%2===0); }
  for(let i=0;i<9;i++) {set(8,i,false);set(i,8,false);} for(let i=13;i<21;i++) {set(8,i,false);set(i,8,false);} set(8,13,true);
  let pos=0; for(let right=20;right>=1;right-=2) { if(right===6) right=5; for(let vert=0;vert<21;vert++) { const y=(((right+1)&2)===0)?20-vert:vert; for(let j=0;j<2;j++) {const x=right-j; if(!reserved[y][x]) {grid[y][x]=(stream[pos++]||0)!==(((x+y)%2)===0); reserved[y][x]=true;}}} }
  const fmt=0x77c4,bit=i=>(fmt>>i)&1;
  for(let i=0;i<=5;i++) set(8,i,bit(i)); set(8,7,bit(6));set(8,8,bit(7));set(7,8,bit(8));for(let i=9;i<15;i++)set(14-i,8,bit(i));
  for(let i=0;i<8;i++)set(20-i,8,bit(i));for(let i=8;i<15;i++)set(8,21-15+i,bit(i));set(8,13,true);
  const paths=[]; for(let y=0;y<21;y++)for(let x=0;x<21;x++)if(grid[y][x])paths.push(`M${x+4} ${y+4}h1v1h-1z`);
  return `<svg width="${size}" height="${size}" viewBox="0 0 29 29" role="img" aria-label="QR code for ${value.replace(/[&<>"']/g,'')}"><rect width="29" height="29" fill="white"/><path d="${paths.join('')}" fill="#142e3d"/></svg>`;
}
