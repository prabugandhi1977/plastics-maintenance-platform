// Equipment identification at the machine: the printed QR label (MC:…) or an RFID/NFC tag fixed to the asset.
// Raising and closing a ticket can require a scan that resolves to the ticket's machine, so the record proves someone
// was at the machine. The scan policy is a platform setting; dispatchers can override with a recorded reason.
import { one } from './db.js';
import { bad } from './validate.js';

export const SCAN_POLICY_DEFAULT={raise:'optional',close:'required'};
export function scanPolicy() {
  try { return {...SCAN_POLICY_DEFAULT,...JSON.parse(one("SELECT value FROM settings WHERE key='scan_policy'")?.value||'{}')}; } catch { return {...SCAN_POLICY_DEFAULT}; }
}

// RFID readers report the same UID as "04:A2:3B:…", "04 a2 3b" or "04A23B…"; store and compare one form.
export const normaliseRfid=v=>String(v??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
export function rfidTag(v) {
  if (v==null||v==='') return null;
  const tag=normaliseRfid(v); if (tag.length<4||tag.length>64) bad('RFID tag must be 4-64 letters or digits (the tag UID or EPC)');
  return tag;
}

// A QR label code: the platform's own (MC:…) or the code on labels a plant already uses (plain text or a URL).
export function qrLabel(v) {
  const code=String(v??'').trim();
  if (code.length<3||code.length>200||!/^[\x21-\x7E]+$/.test(code)) bad('QR code must be 3-200 characters without spaces (letters, digits and symbols as printed in the code)');
  return code;
}

// Resolves a scanned code to its equipment: an exact QR payload first, then an RFID tag. Returns undefined when unknown.
export function resolveScan(code) {
  const raw=String(code??'').trim(); if (!raw||raw.length>200) return undefined;
  const byQr=one('SELECT * FROM equipment WHERE qr_code=?',raw); if (byQr) return {equipment:byQr,method:'qr'};
  const tag=normaliseRfid(raw); if (tag.length<4) return undefined;
  const byTag=one('SELECT * FROM equipment WHERE rfid_tag=?',tag); if (byTag) return {equipment:byTag,method:'rfid'};
  return undefined;
}

// A scan for a specific machine: unknown codes and codes of another machine are refused with a clear reason.
export function scanFor(code,equipment) {
  const hit=resolveScan(code);
  if (!hit) bad('Scanned code is not a known equipment QR label or RFID tag');
  // Names only the expected machine: the scanned one may belong to another company.
  if (hit.equipment.id!==equipment.id) bad(`Scanned code belongs to a different machine; scan the label or tag on ${equipment.asset_tag||'this machine'}`);
  return hit.method;
}
