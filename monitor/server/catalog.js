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
