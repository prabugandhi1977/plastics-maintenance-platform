// EXPERIMENTAL generic Bluetooth decoder. No vendor profile is built in: the meter's GATT service, characteristic and the byte
// layout of one notification are configured by the user (see the meter's Bluetooth settings). Pure functions, testable in Node.
const SIZES={int16:2,uint16:2,int32:4,uint32:4,float32:4};
export function decodeNotification(view,fields) {
  const out={};
  for (const f of fields) {
    const size=SIZES[f.type]; if (!size||f.offset<0||f.offset+size>view.byteLength) return null; const le=(f.endian||'le')==='le';
    const v={int16:()=>view.getInt16(f.offset,le),uint16:()=>view.getUint16(f.offset,le),int32:()=>view.getInt32(f.offset,le),uint32:()=>view.getUint32(f.offset,le),float32:()=>view.getFloat32(f.offset,le)}[f.type]();
    if (!Number.isFinite(v)) return null; out[f.name]=v*(f.scale??1);
  }
  return out;
}
export const bleSupported=()=>typeof navigator!=='undefined'&&!!navigator.bluetooth;
// UUIDs as typed: 16-bit hex ("ffe0"), 32-bit hex, or a full UUID.
export const uuidOf=u=>/^[0-9a-f]{4}$/i.test(u)?parseInt(u,16):/^[0-9a-f]{8}$/i.test(u)?parseInt(u,16):u.toLowerCase();
