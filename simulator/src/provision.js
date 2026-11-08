// Creates the virtual plant's records in the platform through its public API, so nothing here depends on its database:
// one injection machine and one mould per virtual machine, the four device mappings (controller, energy meter,
// inspection camera, safety camera), a product, a released material lot, and a running batch so process settings
// are accepted. Safe to run twice: existing records (matched by asset tag, device id, part number) are reused.
export class Api {
  constructor(base) { this.base = base.replace(/\/$/, ''); this.token = null; }
  async call(path, method = 'GET', body) {
    const res = await fetch(`${this.base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`${method} ${path} -> ${res.status} ${data.error ?? data.message ?? JSON.stringify(data)}`); e.status = res.status; throw e; }
    return data;
  }
  async login(email, password) { const r = await this.call('/auth/login', 'POST', { email, password }); this.token = r.token; return r; }
}

export async function provision({ api, plantId, companyId, config, log = console.log, batches = true }) {
  const plant = (await api.call('/plants')).find(p => p.id === plantId); if (!plant) throw new Error(`Plant ${plantId} not found or not visible to this user`);
  companyId ??= plant.company_id;
  const have = {
    eq: new Map((await api.call('/equipment')).map(e => [e.asset_tag ?? e.assetTag, e])),
    dev: new Set((await api.call('/devices')).map(d => d.external_device_id)),
    prod: new Map((await api.call('/products')).map(p => [p.part_number, p]))
  };
  const warn = (what, e) => log(`  ! ${what}: ${e.message}`);
  const out = { equipment: 0, moulds: 0, devices: 0, products: 0, batches: 0, skipped: 0 };
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  for (const m of config.machines) {
    log(`- ${m.tag} (${m.make} ${m.model}, ${m.protocol})`);
    let eq = have.eq.get(m.tag);
    if (!eq) { eq = await api.call('/equipment', 'POST', { plantId, machineType: 'injection', make: m.make, model: m.model, serialNumber: m.serialNumber, location: m.location, assetTag: m.tag, criticality: 'B', status: 'in_service', yearBuilt: 2022,
      specs: { clampForceKn: m.clampKn, shotVolumeCm3: m.shotVolumeCm3, screwDiameterMm: m.screwDiameterMm, driveType: m.driveType, controller: m.controller } }); out.equipment++; } else out.skipped++;
    let mould = have.eq.get(`MLD-${m.tag}`);
    if (!mould) { try { mould = await api.call('/equipment', 'POST', { plantId, machineType: 'mould', make: 'Virtual Tooling', model: `${m.cavities}-cavity`, serialNumber: `MLD-${m.serialNumber}`, location: 'Tool room (virtual)', assetTag: `MLD-${m.tag}`, criticality: 'B', status: 'in_service', yearBuilt: 2022,
      specs: { mouldNumber: `M-${m.tag}`, cavities: m.cavities, hotRunner: 'yes', hotRunnerZones: 4, shotCount: 0, pmIntervalShots: 250000, steelGrade: '1.2343' } }); out.moulds++; } catch (e) { warn('mould', e); } }
    for (const id of [m.id, m.meterId, m.cameraId, m.safetyCameraId]) {
      if (have.dev.has(id)) continue;
      try { await api.call('/devices', 'POST', { equipmentId: eq.id, externalDeviceId: id, staleAfterMinutes: 60 }); out.devices++; } catch (e) { warn(`device ${id}`, e); }
    }
    let product = have.prod.get(m.partNumber.toUpperCase());
    if (!product) { try { product = await api.call('/products', 'POST', { companyId, partNumber: m.partNumber, name: m.name, material: m.material, partWeightG: m.partWeightG, unit: 'parts', idealCycleS: m.cycleS, cavities: m.cavities, defaultMachineId: eq.id, ...(mould ? { mouldId: mould.id } : {}) }); out.products++; } catch (e) { warn('product', e); } }
    if (batches && product && mould) {
      try {
        const lot = await api.call('/trace/lots', 'POST', { lotNumber: `SIM-LOT-${m.tag}-${stamp}`, material: m.material, supplier: 'Virtual Polymers', receivedAt: new Date().toISOString(), quantityKg: 5000 }).catch(e => { if (/exist|already|unique/i.test(e.message)) return null; throw e; });
        const lotId = lot?.id ?? (await api.call('/trace/lots')).find(l => l.lot_number === `SIM-LOT-${m.tag}-${stamp}`)?.id;
        const sp = m.setpoints;
        await api.call('/trace/batches', 'POST', { productId: product.id, equipmentId: eq.id, mouldId: mould.id, batchNumber: `SIM-${m.tag}-${stamp}`, operatorName: 'Virtual Operator', plannedQty: 500000, lots: lotId ? [{ lotId, quantityKg: 1000 }] : [],
          processParams: { meltTempC: sp.meltTempC, mouldTempC: sp.mouldTempC, injectionPressureBar: sp.injectionPressureBar, holdPressureBar: sp.holdPressureBar, cycleTimeS: m.cycleS } }); out.batches++;
      } catch (e) { if (/one running batch|already/i.test(e.message)) out.skipped++; else warn('batch', e); }
    }
  }
  return out;
}
