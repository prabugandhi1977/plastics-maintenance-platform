// Master data catalogue: the mandatory parameter sets and code lists the platform uses. The API validates against it
// and the clients build their forms from it (GET /api/catalog), so both always agree.
//
// Sources: failure modes, failure causes and maintenance activities follow the ISO 14224 taxonomy (collection of
// reliability and maintenance data); KPI terms follow EN 13306 / EN 15341. Machine parameters are the ones machine
// builders publish on data sheets (Euromap conventions): values are stored in metric units.
import { bad } from './validate.js';

export const MACHINE_TYPES=['injection','blow','extrusion','mould','auxiliary'];
// A: stoppage halts production or affects safety; B: significant but bypassable; C: low impact.
export const CRITICALITY=['A','B','C'];
export const EQUIPMENT_STATUS=['in_service','standby','out_of_service','decommissioned'];

// Type-specific parameter sets. required:true fields are mandatory when an asset is created or its specs edited.
export const SPEC_FIELDS={
  injection:[
    {key:'clampForceKn',label:'Clamp force',unit:'kN',type:'number',min:50,max:100000,required:true},
    {key:'shotVolumeCm3',label:'Shot volume',unit:'cm³',type:'number',min:1,max:200000,required:true},
    {key:'screwDiameterMm',label:'Screw diameter',unit:'mm',type:'number',min:8,max:300,required:true},
    {key:'driveType',label:'Drive type',type:'choice',options:['hydraulic','electric','hybrid'],required:true},
    {key:'controller',label:'Control system',type:'text',max:80,required:false}
  ],
  blow:[
    {key:'process',label:'Process',type:'choice',options:['extrusion_blow','injection_blow','stretch_blow'],required:true},
    {key:'cavities',label:'Cavities',type:'integer',min:1,max:256,required:true},
    {key:'maxVolumeL',label:'Max container volume',unit:'L',type:'number',min:0.001,max:10000,required:true},
    {key:'clampForceKn',label:'Clamp force',unit:'kN',type:'number',min:1,max:100000,required:false}
  ],
  extrusion:[
    {key:'lineType',label:'Line type',type:'choice',options:['pipe','profile','film','sheet','compounding','cable','other'],required:true},
    {key:'screwConfig',label:'Screw configuration',type:'choice',options:['single','twin'],required:true},
    {key:'screwDiameterMm',label:'Screw diameter',unit:'mm',type:'number',min:10,max:500,required:true},
    {key:'ldRatio',label:'L/D ratio',type:'number',min:5,max:80,required:true},
    {key:'outputKgH',label:'Rated output',unit:'kg/h',type:'number',min:0.1,max:20000,required:true}
  ],
  mould:[
    {key:'mouldNumber',label:'Mould number',type:'text',max:60,required:true},
    {key:'cavities',label:'Cavities',type:'integer',min:1,max:512,required:true},
    {key:'hotRunner',label:'Hot runner',type:'choice',options:['yes','no'],required:true},
    {key:'hotRunnerZones',label:'Hot runner zones',type:'integer',min:0,max:256,required:false},
    {key:'shotCount',label:'Current shot count',type:'integer',min:0,max:1000000000,required:true},
    {key:'pmIntervalShots',label:'Preventive maintenance interval',unit:'shots',type:'integer',min:1000,max:100000000,required:true},
    {key:'steelGrade',label:'Steel grade',type:'text',max:40,required:false}
  ],
  auxiliary:[
    {key:'auxType',label:'Equipment type',type:'choice',options:['dryer','chiller','temperature_controller','loader','granulator','robot','conveyor','dosing_blender','other'],required:true},
    {key:'capacity',label:'Capacity',type:'text',max:60,required:false},
    {key:'linkedEquipmentId',label:'Serves machine',type:'equipment',required:false}
  ]
};

// Breakdown reporting (at creation) and close-out (at completion) code lists.
export const FAILURE_CATEGORIES=['mechanical','hydraulic','pneumatic','electrical','controls','heating','cooling','tooling','material','safety','other'];
export const MACHINE_STATES=['stopped','reduced_output','quality_issue','running'];
export const FAILURE_MODES=['fail_to_start','fail_to_stop','breakdown','low_output','erratic_operation','abnormal_noise_vibration','overheating','external_leakage','quality_defect','structural_damage','minor_issue','other'];
export const ROOT_CAUSES=['design','installation','operation_error','maintenance_error','wear_and_ageing','contamination','material_or_supply','external_influence','unknown'];
export const ACTIONS=['replace','repair','adjust','modify','clean','inspect','service','overhaul','software_update','temporary_fix'];

export const COVERAGE_HOURS=['8x5','12x5','16x6','24x7'];
export const OPERATING_PATTERNS=['24x7','24x5','16x5','8x5'];
export const PART_UNITS=['pcs','set','m','kg','l'];
export const PART_URGENCY=['normal','urgent','breakdown'];
export const DEFAULT_RESPONSE_HOURS={critical:4,high:8,medium:24,low:72};
export const FIELD_ROLES=['engineer','provider_engineer'];

export const catalog=()=>({machineTypes:MACHINE_TYPES,criticality:CRITICALITY,equipmentStatus:EQUIPMENT_STATUS,specFields:SPEC_FIELDS,failureCategories:FAILURE_CATEGORIES,machineStates:MACHINE_STATES,failureModes:FAILURE_MODES,rootCauses:ROOT_CAUSES,actions:ACTIONS,coverageHours:COVERAGE_HOURS,operatingPatterns:OPERATING_PATTERNS,partUnits:PART_UNITS,partUrgency:PART_URGENCY,fieldRoles:FIELD_ROLES});

// Validates a full parameter set for a machine type and returns only known keys, typed.
// linkedEquipment(id) must return the referenced asset (or undefined) so cross-company links are refused.
export function validateSpecs(type,input,linkedEquipment=()=>undefined) {
  const fields=SPEC_FIELDS[type]; if (!fields) bad('Unknown machine type');
  if (input==null||typeof input!=='object'||Array.isArray(input)) bad('specs must be an object');
  const out={}, missing=[];
  for (const f of fields) {
    const v=input[f.key];
    if (v==null||v==='') { if (f.required) missing.push(f.label); continue; }
    if (f.type==='number'||f.type==='integer') {
      const n=typeof v==='string'?Number(v):v;
      if (!Number.isFinite(n)||(f.type==='integer'&&!Number.isInteger(n))||n<f.min||n>f.max) bad(`${f.label} must be ${f.type==='integer'?'a whole number':'a number'} from ${f.min} to ${f.max}${f.unit?' '+f.unit:''}`);
      out[f.key]=n;
    } else if (f.type==='choice') { if (!f.options.includes(v)) bad(`${f.label} must be one of: ${f.options.join(', ')}`); out[f.key]=v; }
    else if (f.type==='equipment') { if (typeof v!=='string'||!linkedEquipment(v)) bad(`${f.label} must be a machine of the same company`); out[f.key]=v; }
    else { if (typeof v!=='string'||v.trim().length>f.max) bad(`${f.label} must be text up to ${f.max} characters`); if (v.trim()) out[f.key]=v.trim(); }
  }
  if (missing.length) bad(`Missing mandatory ${type} parameters: ${missing.join(', ')}`);
  return out;
}

// Which mandatory master data a record still lacks (records created before a field became mandatory stay valid,
// but are flagged so they can be completed).
export function missingEquipmentData(e) {
  const specs=JSON.parse(e.specs||'{}'), missing=[];
  if (!e.asset_tag) missing.push('Asset tag');
  if (!e.year_built) missing.push('Year built');
  for (const f of SPEC_FIELDS[e.machine_type]||[]) if (f.required&&(specs[f.key]==null||specs[f.key]==='')) missing.push(f.label);
  return missing;
}
