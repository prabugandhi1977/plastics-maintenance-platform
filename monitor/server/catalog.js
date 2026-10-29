// What each machine type measures, with recommended limits and what a change usually means. The knowledge here also
// feeds the explanations shown when the AI is switched off. Vibration limits follow the ISO 20816 zones for medium
// machines; the rest are typical values for plastics processing and should be tuned per machine.
export const MACHINE_TYPES = {
  injection: 'Injection moulding machine', extrusion: 'Extruder', blow: 'Blow moulding machine',
  chiller: 'Chiller', dryer: 'Material dryer', compressor: 'Air compressor',
};

const S = (key, label, unit, limits) => ({ key, label, unit, ...limits });
export const SIGNALS = {
  injection: [
    S('hydraulic_oil_temp', 'Hydraulic oil temperature', '°C', { warn_high: 55, crit_high: 65 }),
    S('pump_vibration', 'Pump / motor vibration', 'mm/s', { warn_high: 4.5, crit_high: 7.1 }),
    S('barrel_zone3_temp', 'Barrel zone 3 temperature', '°C', { warn_low: 220, crit_low: 210, warn_high: 240, crit_high: 250 }),
    S('injection_pressure', 'Peak injection pressure', 'bar', { warn_high: 1450, crit_high: 1600 }),
    S('cooling_water_temp', 'Cooling water supply', '°C', { warn_high: 22, crit_high: 28 }),
    S('motor_current', 'Main motor current', 'A', { warn_high: 110, crit_high: 130 }),
  ],
  extrusion: [
    S('melt_pressure', 'Melt pressure', 'bar', { warn_high: 300, crit_high: 350 }),
    S('gearbox_oil_temp', 'Gearbox oil temperature', '°C', { warn_high: 70, crit_high: 85 }),
    S('gearbox_vibration', 'Gearbox vibration', 'mm/s', { warn_high: 4.5, crit_high: 7.1 }),
    S('motor_load', 'Main motor load', '%', { warn_high: 90, crit_high: 100 }),
    S('die_temp', 'Die temperature', '°C', { warn_low: 195, crit_low: 185, warn_high: 215, crit_high: 225 }),
  ],
  blow: [
    S('compressed_air', 'Compressed air pressure', 'bar', { warn_low: 6, crit_low: 5 }),
    S('hydraulic_oil_temp', 'Hydraulic oil temperature', '°C', { warn_high: 55, crit_high: 65 }),
    S('pump_vibration', 'Pump / motor vibration', 'mm/s', { warn_high: 4.5, crit_high: 7.1 }),
    S('parison_head_temp', 'Parison head temperature', '°C', { warn_low: 185, crit_low: 175, warn_high: 205, crit_high: 215 }),
  ],
  chiller: [
    S('supply_temp', 'Chilled water supply', '°C', { warn_high: 16, crit_high: 18 }),
    S('compressor_current', 'Compressor current', 'A', { warn_high: 48, crit_high: 55 }),
    S('discharge_pressure', 'Refrigerant discharge pressure', 'bar', { warn_high: 19, crit_high: 22 }),
  ],
  dryer: [
    S('dew_point', 'Dew point', '°C', { warn_high: -30, crit_high: -20 }),
    S('air_temp', 'Drying air temperature', '°C', { warn_low: 75, crit_low: 70, warn_high: 90, crit_high: 95 }),
  ],
  compressor: [
    S('outlet_pressure', 'Outlet pressure', 'bar', { warn_low: 6.5, crit_low: 6 }),
    S('motor_temp', 'Motor temperature', '°C', { warn_high: 95, crit_high: 110 }),
    S('vibration', 'Vibration', 'mm/s', { warn_high: 4.5, crit_high: 7.1 }),
  ],
};

// Typical causes and first checks by signal and direction of change; used for rule-based explanations and to ground
// the AI's answers.
export const KNOWLEDGE = {
  hydraulic_oil_temp: { up: ['Oil cooler fouled or cooling water flow too low', 'Pump or valve internal leakage turning pressure into heat', 'Oil level low or oil degraded'], checks: ['Cooling water flow and inlet/outlet temperature at the oil cooler', 'Oil level and condition (colour, smell, last analysis)', 'Pump case drain flow and relief valve setting'] },
  pump_vibration: { up: ['Bearing wear in the pump or motor', 'Coupling misalignment or worn coupling insert', 'Loose mounting or cavitation at the pump inlet'], checks: ['Listen and feel at the pump and motor bearings; check bearing temperature', 'Coupling alignment and insert condition', 'Mounting bolts and suction line for air ingress'] },
  gearbox_vibration: { up: ['Gear or bearing wear', 'Thrust bearing damage', 'Low or contaminated gearbox oil'], checks: ['Gearbox oil level and a sample for metal particles', 'Bearing noise and temperature', 'Coupling alignment to the motor'] },
  vibration: { up: ['Bearing wear', 'Imbalance or loose mounting', 'Misalignment'], checks: ['Bearing temperature and noise', 'Mounting and anti-vibration pads', 'Alignment'] },
  barrel_zone3_temp: { down: ['Heater band failed or loose', 'Thermocouple fault or poor contact', 'Solid-state relay or fuse failed'], up: ['Thermocouple out of its well', 'Relay stuck closed', 'Excessive shear heating from screw speed or back pressure'], checks: ['Heater band current with a clamp meter', 'Thermocouple seating and reading against a handheld probe', 'Relay and fuse on that zone'] },
  die_temp: { down: ['Die heater failed', 'Thermocouple fault'], up: ['Controller or relay fault', 'Excess shear heat'], checks: ['Die heater current', 'Thermocouple seating', 'Controller output'] },
  parison_head_temp: { down: ['Head heater failed', 'Thermocouple fault'], up: ['Relay stuck', 'Thermocouple out of position'], checks: ['Heater current', 'Thermocouple', 'Relay'] },
  injection_pressure: { up: ['Material viscosity change (moisture, regrind ratio, lot)', 'Nozzle or hot runner partly blocked', 'Mould temperature too low'], checks: ['Material lot and dryer dew point', 'Nozzle and hot runner temperatures', 'Mould temperature controller'] },
  cooling_water_temp: { up: ['Chiller capacity short or chiller fault', 'Cooling tower or heat exchanger fouled', 'Valve partly closed'], checks: ['Chiller supply temperature and alarms', 'Flow at the machine manifold', 'Strainers and valves'] },
  motor_current: { up: ['Mechanical drag (bearings, screw, toggle lubrication)', 'Supply voltage low or phase imbalance', 'Higher load from material or settings'], checks: ['Phase currents and supply voltage', 'Lubrication of moving parts', 'Recent setting or material changes'] },
  melt_pressure: { up: ['Screen pack clogging', 'Die or adapter partly blocked', 'Melt temperature too low'], checks: ['Pressure before and after the screen changer', 'Melt and die temperatures', 'Time since the last screen change'] },
  gearbox_oil_temp: { up: ['Oil cooler fouled', 'Oil degraded or level low', 'Bearing wear'], checks: ['Cooler water flow', 'Oil level and sample', 'Bearing noise'] },
  motor_load: { up: ['Screen or die restriction', 'Material change', 'Mechanical wear'], checks: ['Melt pressure trend', 'Material lot', 'Gearbox and thrust bearing'] },
  compressed_air: { down: ['Air leak in the machine or supply line', 'Compressor capacity short', 'Filter or regulator blocked'], checks: ['Leak check with the machine idle (listen, soap test)', 'Compressor outlet pressure', 'Filter differential pressure and regulator'] },
  supply_temp: { up: ['Condenser fouled or condenser fan fault', 'Refrigerant charge low', 'Heat load above chiller capacity'], checks: ['Condenser coils and fans', 'Discharge and suction pressures', 'Number of machines on the loop'] },
  compressor_current: { up: ['High head pressure from a fouled condenser', 'Compressor wear'], checks: ['Discharge pressure', 'Condenser', 'Compressor noise'] },
  discharge_pressure: { up: ['Condenser fouled or fan failed', 'Refrigerant overcharge or non-condensables'], checks: ['Condenser airflow', 'Fan operation', 'Service technician check of the charge'] },
  dew_point: { up: ['Desiccant saturated or regeneration heater failed', 'Valve not switching beds', 'Air leak into the drying circuit'], checks: ['Regeneration heater current and temperature', 'Bed switching cycle', 'Hoses and seals'] },
  air_temp: { down: ['Process heater failed'], up: ['Controller fault'], checks: ['Heater current', 'Controller', 'Thermocouple'] },
  outlet_pressure: { down: ['Demand above capacity or a leak', 'Inlet filter blocked'], checks: ['Leaks across the plant', 'Inlet filter', 'Load/unload cycle'] },
  motor_temp: { up: ['Cooling fan or airflow blocked', 'Overload'], checks: ['Fan and air path', 'Motor current'] },
};

export const signalsFor = type => SIGNALS[type] || [];

// Basic parameters per machine type, shown and checked when a machine is added or edited. `options` makes a choice;
// otherwise the value is a number within min..max. All are optional except where `required` is set.
const P = (key, label, unit, more = {}) => ({ key, label, unit, ...more });
export const MACHINE_SPECS = {
  injection: [P('clampForceKn', 'Clamp force', 'kN', { min: 50, max: 60000, required: true }), P('shotVolumeCm3', 'Shot volume', 'cm³', { min: 1, max: 100000 }), P('screwDiameterMm', 'Screw diameter', 'mm', { min: 10, max: 200 }),
    P('driveType', 'Drive', '', { options: ['hydraulic', 'electric', 'hybrid'], required: true }), P('motorKw', 'Main motor power', 'kW', { min: 0.5, max: 2000 }), P('controller', 'Controller', '', { text: true })],
  extrusion: [P('screwDiameterMm', 'Screw diameter', 'mm', { min: 10, max: 400, required: true }), P('ldRatio', 'L/D ratio', '', { min: 10, max: 60 }), P('screwConfig', 'Screw configuration', '', { options: ['single', 'twin', 'counter-rotating twin'] }),
    P('outputKgH', 'Rated output', 'kg/h', { min: 1, max: 10000 }), P('motorKw', 'Main motor power', 'kW', { min: 1, max: 5000 }), P('controller', 'Controller', '', { text: true })],
  blow: [P('process', 'Process', '', { options: ['extrusion blow', 'injection blow', 'stretch blow'], required: true }), P('cavities', 'Cavities', '', { min: 1, max: 64 }), P('maxVolumeL', 'Largest container', 'L', { min: 0.01, max: 2000 }),
    P('clampForceKn', 'Clamp force', 'kN', { min: 10, max: 5000 }), P('motorKw', 'Main motor power', 'kW', { min: 0.5, max: 1000 })],
  chiller: [P('coolingCapacityKw', 'Cooling capacity', 'kW', { min: 1, max: 5000, required: true }), P('refrigerant', 'Refrigerant', '', { text: true }), P('compressorType', 'Compressor', '', { options: ['scroll', 'screw', 'reciprocating', 'centrifugal'] }),
    P('setpointC', 'Supply set point', '°C', { min: -20, max: 40 })],
  dryer: [P('dryerType', 'Dryer type', '', { options: ['desiccant', 'hot air', 'vacuum', 'compressed air'], required: true }), P('hopperCapacityL', 'Hopper capacity', 'L', { min: 1, max: 20000 }), P('airflowM3h', 'Air flow', 'm³/h', { min: 1, max: 10000 }),
    P('throughputKgH', 'Throughput', 'kg/h', { min: 1, max: 5000 })],
  compressor: [P('compressorType', 'Compressor', '', { options: ['screw', 'piston', 'scroll', 'centrifugal'], required: true }), P('freeAirM3min', 'Free air delivery', 'm³/min', { min: 0.1, max: 500 }), P('maxPressureBar', 'Maximum pressure', 'bar', { min: 1, max: 50 }),
    P('motorKw', 'Motor power', 'kW', { min: 0.5, max: 2000 })],
};
export const specsFor = type => MACHINE_SPECS[type] || [];

// What measures a signal.
export const SENSOR_TYPES = { thermocouple: 'Thermocouple', rtd: 'RTD (Pt100)', pressure: 'Pressure transducer', accelerometer: 'Vibration sensor (accelerometer)', current: 'Current transformer',
  flow: 'Flow meter', dew_point: 'Dew point sensor', level: 'Level sensor', power: 'Power meter', plc: 'PLC / controller value', other: 'Other' };
// A sensible sensor for each catalogue signal, used when the standard signals are added to a new machine.
export const sensorFor = key => /vibration/.test(key) ? 'accelerometer' : /dew_point/.test(key) ? 'dew_point' : /temp/.test(key) ? 'thermocouple' : /pressure|compressed_air/.test(key) ? 'pressure' : /current/.test(key) ? 'current' : 'plc';

// STANDARD RULES, NOT AI. Known failure patterns per machine type, used to rank root causes when the AI is off or
// unavailable. A rule names the signal that usually moves first (`lead`, with its direction) and what the other signals
// usually do (`with`: up, down or flat). The score is 3 for the lead moving first in the right direction (1.5 if it
// moved that way, but not first), +w for each companion that behaves as expected (w is 1 unless given), −1 for each
// that does the opposite. A modest table of common patterns, to be extended with the plant's own experience; it knows
// the machine type, not the machine.
const R = (cause, lead, withs, checks, ruledOutBy) => ({ cause, lead, with: withs, checks, ruledOutBy });
const L = (signal, dir) => ({ signal, dir });
const W = (signal, dir, w = 1) => ({ signal, dir, w });
export const ROOT_CAUSE_RULES = {
  injection: [
    R('Hydraulic oil cooler fouled, or cooling water flow too low', L('hydraulic_oil_temp', 'up'), [W('cooling_water_temp', 'flat'), W('injection_pressure', 'flat'), W('pump_vibration', 'flat')],
      ['Oil cooler water-side inlet and outlet temperature and flow', 'Cooler fins or tubes for scale and sludge'], ['Cooler delta-T is normal and flow is full: look at the pump instead', 'Oil temperature stays high with the cooling water valve fully open and clean']),
    R('Hydraulic pump wear or internal leakage (pressure lost as heat)', L('hydraulic_oil_temp', 'up'), [W('injection_pressure', 'down', 2), W('pump_vibration', 'up'), W('motor_current', 'up')],
      ['Pump case drain flow against the data sheet', 'Pump and motor bearing noise and vibration', 'Relief valve setting and valve leakage'], ['Case drain flow within the data sheet value', 'Pressure at the set point with the pump unloaded']),
    R('Cooling water supply problem (chiller capacity, valve or strainer)', L('cooling_water_temp', 'up'), [W('hydraulic_oil_temp', 'up')],
      ['Chiller supply temperature and alarms', 'Flow at the machine manifold, strainers and valves'], ['Cooling water supply temperature is normal at the machine inlet']),
    R('Pump or motor bearing wear', L('pump_vibration', 'up'), [W('hydraulic_oil_temp', 'up'), W('motor_current', 'up')],
      ['Bearing temperature, noise and vibration spectrum', 'Coupling alignment and insert condition'], ['Vibration is the same with the coupling disconnected and the motor alone is smooth']),
    R('Heater band, thermocouple or relay fault on the barrel zone', L('barrel_zone3_temp', 'down'), [W('motor_current', 'flat'), W('injection_pressure', 'up')],
      ['Heater band current with a clamp meter', 'Thermocouple seating against a handheld probe', 'Relay and fuse on that zone'], ['Heater current is normal and a handheld probe agrees with the controller']),
    R('Barrel overheating from a stuck relay, a displaced thermocouple or shear heat', L('barrel_zone3_temp', 'up'), [W('motor_current', 'up')],
      ['Relay output state with the heater off', 'Thermocouple seating', 'Screw speed and back pressure settings'], ['Relay opens when the set point is reached']),
    R('Material viscosity change or partly blocked nozzle or hot runner', L('injection_pressure', 'up'), [W('motor_current', 'up'), W('barrel_zone3_temp', 'flat')],
      ['Material lot, moisture and regrind ratio', 'Nozzle and hot runner temperatures', 'Mould temperature controller'], ['The same pressure on a known good lot of material']),
    R('Mechanical drag or a supply-voltage problem on the main drive', L('motor_current', 'up'), [W('pump_vibration', 'up'), W('hydraulic_oil_temp', 'up')],
      ['Phase currents and supply voltage balance', 'Lubrication of the toggle and guides'], ['Phase currents balanced and no extra drag when the machine is run empty']),
  ],
  extrusion: [
    R('Screen pack clogging or a partly blocked die', L('melt_pressure', 'up'), [W('motor_load', 'up'), W('die_temp', 'flat')],
      ['Pressure before and after the screen changer', 'Time since the last screen change', 'Die and adapter for deposits'], ['Pressure drops back after a screen change']),
    R('Gearbox bearing or gear wear', L('gearbox_vibration', 'up'), [W('gearbox_oil_temp', 'up'), W('motor_load', 'up')],
      ['Gearbox oil sample for metal particles', 'Bearing noise and temperature', 'Coupling alignment to the motor'], ['Clean oil sample and a vibration spectrum without bearing or gear mesh peaks']),
    R('Gearbox oil cooler fouled, or oil level low', L('gearbox_oil_temp', 'up'), [W('gearbox_vibration', 'flat'), W('motor_load', 'flat')],
      ['Cooler water flow and temperatures', 'Oil level and condition'], ['Normal cooler delta-T and a correct oil level']),
    R('Die heater or thermocouple fault (cold melt raises the pressure)', L('die_temp', 'down'), [W('melt_pressure', 'up')],
      ['Die heater current', 'Thermocouple seating against a handheld probe', 'Controller output'], ['Heater current is normal and a handheld probe agrees with the controller']),
  ],
  blow: [
    R('Compressed-air leak or supply shortfall', L('compressed_air', 'down'), [W('pump_vibration', 'flat'), W('hydraulic_oil_temp', 'flat')],
      ['Leak check with the machine idle (listen, soap test)', 'Compressor outlet pressure', 'Filter differential pressure and regulator'], ['Pressure holds with the machine isolated from the supply']),
    R('Pump or motor bearing wear', L('pump_vibration', 'up'), [W('hydraulic_oil_temp', 'up')],
      ['Bearing temperature and noise', 'Coupling alignment'], ['Vibration is the same with the coupling disconnected']),
    R('Hydraulic oil cooling shortfall', L('hydraulic_oil_temp', 'up'), [W('pump_vibration', 'flat')],
      ['Cooler water flow and temperatures', 'Oil level and condition'], ['Normal cooler delta-T and a correct oil level']),
    R('Head heater or thermocouple fault', L('parison_head_temp', 'down'), [],
      ['Heater current', 'Thermocouple seating', 'Relay'], ['Heater current is normal and a handheld probe agrees with the controller']),
  ],
  chiller: [
    R('Condenser fouled or condenser fan fault (high head pressure)', L('supply_temp', 'up'), [W('discharge_pressure', 'up', 2), W('compressor_current', 'up')],
      ['Condenser coils and fans', 'Discharge and suction pressures', 'Ambient temperature at the condenser'], ['Discharge pressure is normal for the ambient temperature']),
    R('Refrigerant charge low or heat load above capacity', L('supply_temp', 'up'), [W('discharge_pressure', 'flat'), W('compressor_current', 'flat')],
      ['Suction pressure and superheat (service technician)', 'Number of machines on the loop and their load'], ['Charge checked correct and the load within the rated capacity']),
    R('Compressor wear', L('compressor_current', 'up'), [W('discharge_pressure', 'flat')],
      ['Compressor noise, current per phase and oil condition'], ['Normal current per phase and a normal pressure ratio']),
  ],
  dryer: [
    R('Desiccant saturated or regeneration heater failed', L('dew_point', 'up'), [W('air_temp', 'flat')],
      ['Regeneration heater current and temperature', 'Bed switching cycle'], ['Regeneration temperature reached and beds switching on time']),
    R('Process air heater failed', L('air_temp', 'down'), [W('dew_point', 'up')],
      ['Heater current', 'Thermocouple', 'Controller output'], ['Heater current is normal and a handheld probe agrees with the controller']),
  ],
  compressor: [
    R('Demand above capacity, a leak or a blocked inlet filter', L('outlet_pressure', 'down'), [W('motor_temp', 'flat'), W('vibration', 'flat')],
      ['Leaks across the plant', 'Inlet filter differential pressure', 'Load and unload cycle'], ['Pressure holds with the plant isolated']),
    R('Motor cooling airflow blocked, or overload', L('motor_temp', 'up'), [W('vibration', 'flat')],
      ['Fan and air path', 'Motor current'], ['Airflow clear and current within the rating']),
    R('Bearing wear', L('vibration', 'up'), [W('motor_temp', 'up')],
      ['Bearing temperature and noise', 'Mounting and alignment'], ['Vibration is the same with the compressor uncoupled']),
  ],
};
