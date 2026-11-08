// MQTT: an embedded broker for local runs (or point MQTT_URL at Mosquitto/EMQX), a publisher that carries the plant's
// bus messages, and the topic layout the gateway subscribes to:  mouldcare/v1/<site>/<machineId>/<kind>
import net from 'node:net';
import mqtt from 'mqtt';

export const topicFor = msg => `mouldcare/v1/${msg.site}/${msg.machineId}/${msg.kind}`;
export const SUBSCRIBE = 'mouldcare/v1/#';
// Kinds a machine's own controller sends; meter, camera and safety devices are always on MQTT.
export const MACHINE_KINDS = new Set(['state', 'alarm', 'telemetry', 'shot', 'interval', 'fault']);

export async function startBroker(port = 1883) {
  const { default: Aedes } = await import('aedes');
  const aedes = new Aedes();
  const server = net.createServer(aedes.handle);
  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, res); });
  return { port: server.address().port, async close() { await new Promise(r => server.close(r)); await new Promise(r => aedes.close(r)); } };
}

export class MqttSink {
  // fast = true when the clock runs faster than polling protocols can follow: all machine data then goes over MQTT.
  constructor(url, { fast = false, log = () => {} } = {}) { this.fast = fast; this.log = log; this.client = mqtt.connect(url, { reconnectPeriod: 1000, clientId: `vplant-${Math.random().toString(16).slice(2, 8)}` }); this.client.on('error', e => log(`mqtt: ${e.message}`)); this.sent = 0; }
  ready() { return new Promise(res => this.client.connected ? res() : this.client.once('connect', res)); }
  carries(msg) { return this.fast || msg.protocol === 'mqtt' || !MACHINE_KINDS.has(msg.kind); }
  publish(msg) { if (!this.carries(msg)) return; this.sent++; this.client.publish(topicFor(msg), JSON.stringify(msg), { qos: 1, retain: msg.kind === 'state' }); }
  async close() { await this.client.endAsync(); }
}
