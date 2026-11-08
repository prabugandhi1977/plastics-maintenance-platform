# Virtual plant

A virtual injection-moulding plant for testing the platform end to end before real machines are connected: machines that cycle, wear and fail; 3-phase energy meters; chiller, dryer and air auxiliaries; inspection and safety cameras; and a gateway that carries the data into the platform the same way a real plant gateway would.

```text
 virtual plant ──MQTT──────────────┐
 (machines, meters,  ──OPC UA──────┼─▶ gateway ─▶ translate ─▶ store-and-forward ─▶ POST /api/integrations/factory/events
  cameras, aux)      ──Euromap 63──┘   (poll+diff)  (state, count,    (retry, spool,         POST /api/integrations/iot/records
                                                     energy, vision…)   chaos)
```

The gateway (`src/gateway/`) is real, reusable code; the plant (`src/machine.js`, `devices.js`, `plant.js`) is the part that stands in for hardware.

## Run it

```powershell
npm run sim:install                       # once, from the repository root
npm run sim:test                          # unit + end-to-end tests (no database or Docker needed)
```

Against a running platform (`docker compose up -d`, or `npm start` with PostgreSQL):

```powershell
cd simulator
npm run provision -- --platform-url http://localhost:3100 --email admin@demo.test --password DemoPass123! --plant plant-a --machines 6
npm run start -- --gateway --key <MOULDCARE_INTEGRATION_KEY> --platform-url http://localhost:3100
```

`provision` creates, through the public API, one injection machine and mould per virtual machine (asset tags `SIM-01`…), four device mappings each (`plc-sim-01`, `meter-sim-01`, `cam-sim-01`, `safety-sim-01`), a product, a material lot and a running batch. Run it twice and it reuses what exists. Demo accounts only exist when the platform was started with `MOULDCARE_SEED_DEMO=true`; on a real deployment use your own admin and a **separate company/plant**, never your production one.

With Docker: `docker compose --profile sim up -d --build` runs the plant and gateway as the `vplant` service (set `MOULDCARE_INTEGRATION_KEY`, optionally `VPLANT_MACHINES`, `VPLANT_SCENARIO`). Provision once first.

### Time

The clock starts at *now* and runs in real time. `--backfill 24 --speed 3600` starts it 24 h in the past and runs fast until it catches up, which fills dashboards with a day of history in under a minute (the platform refuses data timestamped in the future, so the clock can never run ahead of real time). While catching up, OPC UA and Euromap 63 machines are carried over MQTT, because polling cannot follow a fast clock.

## Scenarios (`--scenario`)

| Name | What happens |
| --- | --- |
| `normal-day` | Cycles, minor stops, lunch break, energy, scrap, camera and safety events. Clean data. |
| `machine-faults` | Each machine in turn develops a different fault: warning → critical alarm → breakdown → repair → start-up. |
| `data-faults` | Duplicates, reordering, garbage values, unmapped devices, a 20 min uplink outage, a device clock 15 min fast, a controller counter reset, a replaced energy meter. |
| `power-cut` | Mains lost on every machine for 20 min. |
| `load` | Quiet; use `--machines 200`. One CPU core simulates 200 machines at about 3000× real time. |

While it runs, the control port (`--control-port`, default 4850) lets you act by hand:

```powershell
curl localhost:4850/status
node src/cli.js act '{"action":"fault","machine":"SIM-01","kind":"heater_band_failure","rampS":600}'
node src/cli.js act '{"action":"chaos","config":{"duplicateRate":0.1,"garbageRate":0.02}}'
node src/cli.js act '{"action":"outage","on":true}'
node src/cli.js scenarios     # all scenarios and fault kinds
```

Faults: `hydraulic_pressure_loss`, `heater_band_failure`, `cooling_loss`, `bearing_wear`, `mould_wear`, `oil_overheat`, `material_moisture`, `power_failure`. Other actions: `repair`, `changeover`, `controller-reset`, `meter-reset`, `chaos-clear`, `skew`.

## What reaches the platform

| Platform intake | Source in the plant |
| --- | --- |
| `state` | Machine state and downtime reason (running, idle: minor stop / waiting for material, setup: mould change / start-up, down: breakdown, planned stop: break, offline: power cut) |
| `count` | Good and scrap parts per 15 min, per part number |
| `condition` | Hydraulic oil temperature (not on electric presses), pump vibration, cooling water temperature, every minute |
| `energy` | kWh and peak kW per 15 min from the meter's register (handles a register that resets) |
| `vision` | Inspection-camera results per 15 min, with defect types that follow the real cause (low melt → short shot, worn mould → flash, hot mould → sink marks, wet resin → splay) |
| `safety` | Safety-camera detections (PPE, zone intrusion, near miss) and gate-bypass events |
| `process` | Every 10th shot's melt/mould temperature, pressures and cycle time, attached to the running batch |
| IoT records | Running hours, cycle count, melt temperature and alarm raise/clear (E-204, T-302, C-111, V-411…) every 5 min and on alarm changes |

## What is real and what is approximated

- **MQTT** is real (embedded broker, or point `--mqtt-url` at Mosquitto). Topic layout: `mouldcare/v1/<site>/<machine>/<kind>`; `state` is retained.
- **OPC UA** is a real server and client (node-opcua), shaped like the Euromap 77 / OPC 40077 companion spec (Operation, Production, Process, Energy, Alarms per machine). It is a **subset for gateway testing, not a certified implementation**. Real controllers (Engel, Arburg, KraussMaffei…) expose their own node names, so expect to adjust the mapping in `src/transports/opcua.js`.
- **Euromap 63** is a **file-based emulation**: each machine writes a small `KEY=VALUE` `ACTUAL.TXT`. The real standard's command channel and job data are not implemented.
- **Cameras** report inspection counts and detections as the platform's intake events. The video pipeline (edge node, models, snapshots, `/edge/v1/*`) is separate: use `npm run edge:simulate` for that.
- **ERP/operator events** are limited to provisioning: product, lot and a running batch. Mould changes are available through the `changeover` action. Shift/ERP order scheduling is not simulated.
- Physics is plausible, not calibrated to any particular machine. Treat it as a way to exercise the app's rules (limits, alerts, OEE, traceability), not to predict real behaviour.

## Tests

`npm run sim:test` covers the machine model (healthy running, determinism, each fault's consequences, repair, power cut, changeover) and the full chain over MQTT, OPC UA and Euromap 63 into a stand-in for the two intake endpoints. The stand-in reuses the app's own IoT validation and reads the factory-event enumerations from `backend/common/catalog.js`, so a change to the app's rules breaks these tests instead of silently drifting. It is **not** the real server: run the plant against the real platform (above) to verify acceptance, alerts, tickets and dashboards.
