import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../mobile/',import.meta.url));
function crc32(bytes){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return (crc^0xffffffff)>>>0}
function chunk(type,data){const name=Buffer.from(type),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([len,name,data,crc])}
function inside(x,y,poly){let hit=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])hit=!hit}return hit}
const letter=[[.22,.74],[.22,.25],[.34,.25],[.5,.49],[.66,.25],[.78,.25],[.78,.74],[.65,.74],[.65,.47],[.5,.68],[.35,.47],[.35,.74]];
for(const size of [192,512]){
  const rows=[];for(let y=0;y<size;y++){const row=Buffer.alloc(1+size*4);for(let x=0;x<size;x++){const u=(x+.5)/size,v=(y+.5)/size;const mark=inside(u,v,letter),edge=Math.min(u,v,1-u,1-v);const rounded=edge>.045||Math.hypot(Math.max(.045-u,0),Math.max(.045-v,0))<.045;const color=!rounded?[0,0,0,0]:mark?[102,215,202,255]:[18,50,61,255];row.set(color,1+x*4)}rows.push(row)}
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]);
  writeFileSync(join(root,`icon-${size}.png`),png);
}
