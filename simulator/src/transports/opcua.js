// OPC UA server and client in the shape of the Euromap 77 / OPC 40077 injection-moulding companion spec: one object per
// machine with Operation, Production, Process, Energy and Alarms groups. It is a SUBSET for gateway testing, not a
// certified implementation; node ids and names follow the spec's structure, not its exact type definitions.
import { OPCUAServer, OPCUAClient, Variant, DataType, MessageSecurityMode, SecurityPolicy, AttributeIds } from 'node-opcua';
import { FIELDS, flatten, unflatten } from './codec.js';

export const NS_URI = 'urn:mouldcare:virtual-plant';
const GROUP = k => (k.startsWith('v.') ? 'Process' : ['state', 'reason', 'phase', 'at'].includes(k) ? 'Operation' : k === 'alarms' ? 'Alarms' : k === 'kwh' ? 'Energy' : 'Production');
const NAME = k => (k.startsWith('v.') ? k.slice(2) : k[0].toUpperCase() + k.slice(1));
export const nodeKey = (tag, k) => `${tag}.${GROUP(k)}.${NAME(k)}`;

export async function startOpcUaServer(plant, { port = 4840, log = () => {} } = {}) {
  const server = new OPCUAServer({ port, resourcePath: '/UA/MouldCare', buildInfo: { productName: 'MouldCare virtual plant', manufacturerName: 'MouldCare' } });
  await server.initialize();
  const as = server.engine.addressSpace, ns = as.registerNamespace(NS_URI);
  const root = ns.addObject({ organizedBy: as.rootFolder.objects, browseName: 'InjectionMoldingMachines' });
  const cache = new Map();
  const snap = m => { const c = cache.get(m.cfg.id); if (c && c.at === m.now) return c.f; const f = flatten(m.snapshot()); cache.set(m.cfg.id, { at: m.now, f }); return f; };
  for (const m of plant.machines.values()) {
    if (m.cfg.protocol !== 'opcua') continue;
    const obj = ns.addObject({ organizedBy: root, browseName: m.cfg.tag });
    ns.addVariable({ componentOf: obj, browseName: 'MachineInformation', dataType: 'String', minimumSamplingInterval: 1000, nodeId: `s=${m.cfg.tag}.MachineInformation`, value: { get: () => new Variant({ dataType: DataType.String, value: `${m.cfg.make} ${m.cfg.model} (${m.cfg.controller})` }) } });
    for (const [k, type] of FIELDS) {
      const num = type === 'number';
      ns.addVariable({ componentOf: obj, browseName: nodeKey(m.cfg.tag, k), nodeId: `s=${nodeKey(m.cfg.tag, k)}`, dataType: num ? 'Double' : 'String', minimumSamplingInterval: 1000,
        value: { get: () => new Variant({ dataType: num ? DataType.Double : DataType.String, value: num ? Number(snap(m)[k]) : String(snap(m)[k]) }) } });
    }
  }
  await server.start();
  const url = server.getEndpointUrl(); log(`OPC UA server at ${url}`);
  return { url, close: () => server.shutdown(500) };
}

export class OpcUaReader {
  constructor(url, machines, onSnapshot, { log = () => {} } = {}) { this.url = url; this.machines = machines; this.onSnapshot = onSnapshot; this.log = log; }
  async connect() {
    this.client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.None, securityPolicy: SecurityPolicy.None, connectionStrategy: { initialDelay: 500, maxRetry: 10, maxDelay: 5000 } });
    await this.client.connect(this.url); this.session = await this.client.createSession();
    const arr = await this.session.readNamespaceArray(); this.ns = arr.indexOf(NS_URI); if (this.ns < 0) throw new Error('virtual plant namespace not found on OPC UA server');
  }
  async poll() {
    for (const m of this.machines) {
      const nodes = FIELDS.map(([k]) => ({ nodeId: `ns=${this.ns};s=${nodeKey(m.tag, k)}`, attributeId: AttributeIds.Value }));
      const res = await this.session.read(nodes), f = {};
      res.forEach((dv, i) => { f[FIELDS[i][0]] = dv.value?.value; });
      if (f.at == null) continue;
      this.onSnapshot(m, unflatten(m.deviceId, f));
    }
  }
  async close() { await this.session?.close(); await this.client?.disconnect(); }
}
