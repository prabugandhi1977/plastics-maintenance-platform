// Complete, valid request bodies with every mandatory parameter, shared by the test files. Tests override only the
// fields they are about, so a missing mandatory field is always a deliberate part of the test.
const minutesAgo=m=>new Date(Date.now()-m*60000).toISOString();
const daysAhead=d=>new Date(Date.now()+d*86400000).toISOString().slice(0,10);
let serial=0; const unique=prefix=>`${prefix}-${Date.now().toString(36)}-${++serial}`.toUpperCase();

export const closeOut={failureMode:'low_output',rootCause:'wear_and_ageing',actionTaken:'replace'};
// A scan of a seeded machine's QR label (seed labels are MC:<equipment id>), as made when standing at the machine.
export const atMachine=(equipmentId='eq-a')=>({scanCode:`MC:${equipmentId}`});
export const ticketBody=(equipmentId,extra={})=>({equipmentId,...(String(equipmentId).startsWith('eq-')?atMachine(equipmentId):{}),title:'Screw slips',priority:'high',symptoms:'Recovery time doubled',errorCodes:'E-311',productionImpact:'Cycle time +20%',failureCategory:'mechanical',machineState:'reduced_output',safetyIssue:false,occurredAt:minutesAgo(30),...extra});
export const partBody=(extra={})=>({item:'Seal kit',quantity:1,partNumber:'SK-100',unit:'pcs',urgency:'urgent',manufacturer:'Arburg',...extra});
export const quoteBody=(extra={})=>({amountMinor:12500,currency:'USD',leadDays:3,validUntil:daysAhead(30),...extra});
export const contractBody=(companyId,equipmentIds,extra={})=>({companyId,title:'Annual care',contractNumber:unique('AMC'),startsAt:'2026-01-01',renewsAt:'2027-01-01',responseHours:8,coverageHours:'8x5',visitsPerYear:4,noticeDays:60,commitments:'Visit',exclusions:'None',equipmentIds,visits:[],...extra});
export const companyBody=(extra={})=>({name:'Test Composites',timezone:'Asia/Kolkata',currency:'INR',units:'metric',locale:'en',country:'IN',contactName:'Priya Rao',contactEmail:'priya@testcomposites.test',contactPhone:'+91 20 5555 0100',...extra});
export const plantBody=(companyId,extra={})=>({companyId,name:'Pune',address:'Plot 12, MIDC Chakan, Pune',country:'IN',serviceArea:'IN-S',timezone:'Asia/Kolkata',operatingPattern:'24x7',...extra});
export const SPECS={
  injection:{clampForceKn:1500,shotVolumeCm3:300,screwDiameterMm:45,driveType:'electric'},
  blow:{process:'extrusion_blow',cavities:4,maxVolumeL:1},
  extrusion:{lineType:'pipe',screwConfig:'single',screwDiameterMm:75,ldRatio:33,outputKgH:350},
  mould:{mouldNumber:'M-100',cavities:8,hotRunner:'no',shotCount:0,pmIntervalShots:100000},
  auxiliary:{auxType:'chiller'}
};
export const equipmentBody=(plantId,machineType='blow',extra={})=>({plantId,machineType,make:'Demo',model:'B1',serialNumber:unique('SN'),location:'Bay 1',assetTag:unique('TAG'),criticality:'B',yearBuilt:2020,specs:SPECS[machineType],...extra});
