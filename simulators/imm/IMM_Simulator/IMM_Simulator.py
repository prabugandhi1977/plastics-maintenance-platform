# =============================================================================
#  IMM_Simulator.py  v3  -  Injection Moulding Machine all-in-one simulator
#  for Autodesk Fusion (Python API script)
#
#  v3 (reference: industrial IMM mechanical overview): 5-point double toggle
#  with crosshead + clamp cylinder, mould cooling circuits / guide pillars /
#  sprue, cutaway barrel with 3-zone flighted screw + check ring that turns
#  during recovery, twin injection cylinders + hydraulic motor, carriage
#  cylinders, hydraulic power pack (tank, motor-pump, manifold, cooler),
#  electrical cabinet.
#
#  v2 adds:
#   1. Realistic machine: double-toggle clamp (animated links), safety guards,
#      tie-bar nuts, toggle actuator; "Custom (my machine)" data mode for
#      tie-bar spacing, opening stroke, screw diameter, drive and heater kW.
#   2. Measured-energy mode: enter the per-phase energy (Wh) you measured on
#      a CONVENTIONAL machine; servo-hydraulic and all-electric are predicted
#      phase by phase from it (your SEC retrofit template logic).
#   3. Every run is logged to Documents\IMM_Simulator\IMM_runs.csv (opens in
#      Excel) plus a full text report per run.
#   4. Heater bands glow during injection / recovery, and a live cycle timer
#      (t = x.x / cycle s) runs in the progress bar.
#
#  All constants marked ASSUMPTION are generic rule-of-thumb values. Replace
#  them with your machine data and material datasheets.
# =============================================================================
import adsk.core
import adsk.fusion
import traceback
import math
import time
import os
import csv
import datetime

APP = None
UI = None
HANDLERS = []
INPUTS = None
CMD_ID = 'IMM_Simulator_Cmd'
ATTR_GROUP = 'IMMSim'

# ----------------------------------------------------------------------------
# ASSUMPTION tables - edit to match your plant
# ----------------------------------------------------------------------------
MATERIALS = {
    'PP':   dict(melt=(200, 250), mould=(20, 60),  eject_t=90,  alpha=0.08, rho=0.73, cav=0.35, rgb=(235, 225, 190)),
    'ABS':  dict(melt=(210, 260), mould=(40, 80),  eject_t=85,  alpha=0.09, rho=0.95, cav=0.45, rgb=(60, 60, 65)),
    'PA66': dict(melt=(270, 300), mould=(60, 90),  eject_t=140, alpha=0.10, rho=0.97, cav=0.50, rgb=(240, 235, 215)),
    'PC':   dict(melt=(280, 320), mould=(80, 110), eject_t=130, alpha=0.12, rho=1.05, cav=0.60, rgb=(170, 210, 235)),
}
CONV_KEY = 'Conventional hydraulic (fixed pump)'
DRIVES = {
    CONV_KEY:          dict(close=.70, nozzle=.50, inject=1.00, hold=.60, recover=.80, idle=.45, open=.70, eject=.50, speed=1.0),
    'Servo-hydraulic': dict(close=.60, nozzle=.30, inject=.90,  hold=.30, recover=.60, idle=.05, open=.60, eject=.30, speed=1.0),
    'All-electric':    dict(close=.40, nozzle=.20, inject=.70,  hold=.20, recover=.40, idle=.02, open=.40, eject=.20, speed=0.8),
}
MDATA = ['Generic (scaled from tonnage)', 'Custom (my machine)']
EMODEL = ['Generic phase factors', 'Measured phase energy (conventional machine)']
HEATER_DUTY = 0.35
OIL_CHANGE_H = 4000
SCREW_LIFE_H = 20000
GLASS_WEAR = 4.0
GLASS_RHO = 1.20
LOG_DIR = os.path.join(os.path.expanduser('~'), 'Documents', 'IMM_Simulator')


def machine_spec(p):
    """Machine data: scaled from tonnage, or user's own values (Custom)."""
    T = p['tonnage']
    s = (T / 250.0) ** (1.0 / 3.0)
    custom = p['mdata'] == MDATA[1]
    D = p['c_screw'] if custom else 8.0 * T ** 0.33                 # mm
    tb = p['c_tiebar'] / 10.0 if custom else 56.0 * s              # cm
    Pl = 1.43 * tb                                                 # platen size, cm
    stroke = p['c_stroke'] / 10.0 if custom else 0.65 * Pl         # cm
    Dc = D / 10.0
    vmax = math.pi / 4 * Dc ** 2 * 3.5 * Dc
    return dict(T=T, s=s, D=D, tb=tb, Pl=Pl, stroke=stroke, vmax=vmax, custom=custom,
                motor_kw=p['c_motor'] if custom else 0.12 * T + 7.0,
                heater_kw=p['c_heater'] if custom else 0.03 * T + 4.0,
                q_max=vmax / 1.2, plast=0.012 * D ** 2,
                move_t=1.2 * s * (stroke / (0.65 * 1.43 * 56.0 * s)) ** 0.5)


# ----------------------------------------------------------------------------
# Simulation (pure calculation)
# ----------------------------------------------------------------------------
def simulate(p):
    m = MATERIALS[p['material']]
    ms = machine_spec(p)
    measured = p['emodel'] == EMODEL[1]
    rho = m['rho'] * (GLASS_RHO if p['glass'] else 1.0)
    shot_cm3 = p['shot_g'] / rho
    util = shot_cm3 / ms['vmax']

    s = p['wall']
    Tm, Tw, Te = p['melt'], p['mould'], m['eject_t']
    if Te <= Tw + 1:
        t_cool_calc = 60.0
    else:
        arg = 8 / math.pi ** 2 * (Tm - Tw) / (Te - Tw)
        t_cool_calc = max(0.5, s * s / (math.pi ** 2 * m['alpha']) * math.log(max(arg, 1.01)))
    t_cool = p['cool'] if p['cool'] > 0 else t_cool_calc
    t_fill = shot_cm3 / (ms['q_max'] * max(p['speed'], 5) / 100.0)
    t_rec = shot_cm3 / ms['plast']
    t_noz, t_eject = 0.5, 0.8
    tcp = max(t_cool, t_rec)

    def phases_for(dk):
        t_move = ms['move_t'] * dk['speed']
        return [('Mould close', t_move, 'close'),
                ('Nozzle forward', t_noz, 'nozzle'),
                ('Injection (fill)', t_fill, 'inject'),
                ('Holding pressure', p['hold_t'], 'hold'),
                ('Cooling + screw recovery', tcp, None),
                ('Nozzle back', t_noz, 'nozzle'),
                ('Mould open', t_move, 'open'),
                ('Ejection', t_eject, 'eject')]

    conv = DRIVES[CONV_KEY]
    conv_cycle = sum(t for _, t, _ in phases_for(conv))

    def cool_factor(dk):
        return dk['recover'] * t_rec + dk['idle'] * (tcp - t_rec)

    def energy_for(dk):
        ph = phases_for(dk)
        cyc = sum(t for _, t, _ in ph)
        if measured:
            # scale the conventional measurement phase by phase
            rt = lambda k: dk[k] / conv[k]
            wh = (p['e_close'] * rt('close') + p['e_nozzle'] * rt('nozzle') + p['e_inject'] * rt('inject') +
                  p['e_hold'] * rt('hold') + p['e_cool'] * cool_factor(dk) / max(cool_factor(conv), 1e-6) +
                  p['e_open'] * rt('open') + p['e_eject'] * rt('eject') + p['e_heat'])
            kwh = wh / 1000.0
            cyc = p['e_cycle'] * cyc / conv_cycle
        else:
            kj = 0.0
            for _, t, key in ph:
                kj += ms['motor_kw'] * (dk[key] * t if key else cool_factor(dk))
            kj += ms['heater_kw'] * HEATER_DUTY * cyc
            kwh = kj / 3600.0
        sec = kwh / (p['shot_g'] / 1000.0)
        kgh = p['shot_g'] / 1000.0 * 3600.0 / cyc
        annual_kwh = sec * kgh * p['hours_yr']
        return dict(cycle=cyc, kwh=kwh, sec=sec, kgh=kgh, annual_kwh=annual_kwh,
                    annual_cost=annual_kwh * p['tariff'], phases=ph)

    cur = energy_for(DRIVES[p['drive']])
    compare = {k: energy_for(v) for k, v in DRIVES.items()}
    req_t = p['area'] * m['cav']
    clamp_util = req_t / p['tonnage']

    lo, hi = m['melt']
    mlo, mhi = m['mould']
    hold_rec = 1.5 * s
    d = []
    if Tm < lo:
        d.append(('Short shot / weld lines', 'Melt %d C below %d-%d C range' % (Tm, lo, hi), 'Raise melt temperature'))
    if Tm > hi:
        d.append(('Degradation / burn streaks', 'Melt %d C above %d-%d C range' % (Tm, lo, hi), 'Lower melt temperature'))
    if util > 0.85:
        d.append(('Short shot', 'Shot uses %.0f%% of barrel capacity' % (util * 100), 'Move to a bigger machine / screw'))
    if util < 0.20:
        d.append(('Material degradation (long residence)', 'Shot uses only %.0f%% of barrel' % (util * 100), 'Move to a smaller machine / screw'))
    if p['speed'] < 25:
        d.append(('Short shot / flow lines', 'Injection speed only %d%%' % p['speed'], 'Increase injection speed'))
    if p['speed'] > 90:
        d.append(('Jetting / burn marks (diesel effect)', 'Injection speed %d%%' % p['speed'], 'Reduce speed, check mould venting'))
    if clamp_util > 0.90:
        d.append(('Flash', 'Needs %.0f t of %d t available' % (req_t, p['tonnage']), 'Bigger machine or reduce projected area'))
    if p['hold_p'] > 1100:
        d.append(('Flash / over-packing / sticking', 'Hold pressure %d bar' % p['hold_p'], 'Reduce hold pressure'))
    if p['hold_p'] < 300:
        d.append(('Sink marks / short shot', 'Hold pressure only %d bar' % p['hold_p'], 'Increase hold pressure'))
    if p['hold_t'] < 0.6 * hold_rec:
        d.append(('Sink marks / voids', 'Hold %.1f s < ~%.1f s gate-freeze estimate' % (p['hold_t'], hold_rec), 'Increase hold time'))
    if Tw < mlo or Tw > mhi:
        d.append(('Warpage / poor surface finish', 'Mould %d C outside %d-%d C' % (Tw, mlo, mhi), 'Correct mould temperature'))
    if p['cool'] > 0 and p['cool'] < 0.8 * t_cool_calc:
        d.append(('Warpage / ejector marks', 'Cooling %.1f s < %.1f s calculated' % (p['cool'], t_cool_calc), 'Increase cooling time'))
    if s > 4.0:
        d.append(('Sink marks (thick wall)', 'Wall %.1f mm' % s, 'Core out thick sections'))

    mt = []
    if 'electric' not in p['drive'].lower():
        if p['oil_t'] > 55:
            mt.append(('Hydraulic oil hot (%d C)' % p['oil_t'], 'Check oil cooler / water flow; seal & oil life at risk'))
        elif p['oil_t'] < 35:
            mt.append(('Hydraulic oil cold (%d C)' % p['oil_t'], 'Warm up before production; unstable pressure/speed'))
        if p['oil_h'] > OIL_CHANGE_H:
            mt.append(('Oil due (%d h since change)' % p['oil_h'], 'Do oil analysis / change and filters'))
    wear = p['run_h'] * (GLASS_WEAR if p['glass'] else 1.0) * (1.3 if p['material'] in ('PA66', 'PC') else 1.0) / SCREW_LIFE_H * 100
    shots = p['run_h'] * 3600.0 / cur['cycle']
    if wear > 80:
        mt.append(('Screw & barrel wear ~%.0f%% of reference life' % wear, 'Measure screw OD / barrel ID, check check-ring'))
    if clamp_util > 0.90:
        mt.append(('Clamp loaded at %.0f%%' % (clamp_util * 100), 'Check tie-bar stretch balance and platen parallelism'))
    if shots > 1e6:
        mt.append(('%.1f million shots' % (shots / 1e6), 'Toggle pins & bushes: check lubrication and play'))

    return dict(ms=ms, measured=measured, shot_cm3=shot_cm3, util=util, t_cool_calc=t_cool_calc, t_cool=t_cool,
                t_fill=t_fill, t_rec=t_rec, cur=cur, compare=compare, req_t=req_t, clamp_util=clamp_util,
                defects=d, maint=mt, wear=wear, shots=shots, vmax_g=ms['vmax'] * rho)


def report_lines(p, r):
    ms, cur = r['ms'], r['cur']
    L = [('MACHINE', '#1f4e79'),
         ('%d t, %s, %s' % (p['tonnage'], p['drive'], 'custom data' if ms['custom'] else 'generic data'), None),
         ('Tie-bar spacing %.0f mm | opening stroke %.0f mm | screw %.0f mm' % (ms['tb'] * 10, ms['stroke'] * 10, ms['D']), None),
         ('Max shot %.0f g %s | drive %.0f kW | heaters %.0f kW' % (r['vmax_g'], p['material'], ms['motor_kw'], ms['heater_kw']), None),
         ('Shot utilisation %.0f%% | clamp needed %.0f t (%.0f%%)' % (r['util'] * 100, r['req_t'], r['clamp_util'] * 100), None),
         ('CYCLE', '#1f4e79')]
    for name, t, _ in cur['phases']:
        L.append(('  %-26s %5.1f s' % (name, t), None))
    L.append(('Total cycle %.1f s%s | %.0f shots/h | %.1f kg/h' %
              (cur['cycle'], ' (measured basis)' if r['measured'] else '', 3600 / cur['cycle'], cur['kgh']), None))
    L.append(('Cooling: calculated %.1f s, used %.1f s, recovery %.1f s' % (r['t_cool_calc'], r['t_cool'], r['t_rec']), None))
    L.append(('ENERGY - %s (machine meter, excl. chiller/dryer)' % ('measured conventional basis' if r['measured'] else 'generic factors'), '#1f4e79'))
    L.append(('This setup: %.3f kWh/cycle | SEC %.2f kWh/kg' % (cur['kwh'], cur['sec']), None))
    base = r['compare'][CONV_KEY]
    for k, e in r['compare'].items():
        save = (1 - e['annual_kwh'] / base['annual_kwh']) * 100 if base['annual_kwh'] else 0
        L.append(('  %-24s SEC %.2f | %.0f MWh/yr | Rs %.1f lakh/yr | save %.0f%%' %
                  (k.split(' (')[0], e['sec'], e['annual_kwh'] / 1000, e['annual_cost'] / 1e5, save), None))
    L.append(('QUALITY PREDICTION', '#1f4e79'))
    if r['defects']:
        for name, cause, fix in r['defects']:
            L.append(('X %s - %s -> %s' % (name, cause, fix), '#c00000'))
    else:
        L.append(('OK: no defect predicted for these settings', '#2e7d32'))
    L.append(('MAINTENANCE', '#1f4e79'))
    L.append(('Shots so far ~%.2f million | screw & barrel wear ~%.0f%%' % (r['shots'] / 1e6, r['wear']), None))
    if r['maint']:
        for a, b in r['maint']:
            L.append(('! %s -> %s' % (a, b), '#c55a11'))
    else:
        L.append(('OK: no maintenance alert', '#2e7d32'))
    L.append(('Indicative model - tune constants to plant data.', '#808080'))
    return L


def to_html(lines):
    out = []
    for t, c in lines:
        t = t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('  ', '&nbsp;&nbsp;')
        out.append('<font color="%s"><b>%s</b></font>' % (c, t) if c else t)
    return '<br>'.join(out)


# ----------------------------------------------------------------------------
# Excel log (CSV)
# ----------------------------------------------------------------------------
LOG_COLS = ['Timestamp', 'Tonnage_t', 'Drive', 'Machine_data', 'Energy_model', 'Material', 'Glass_filled',
            'Shot_g', 'Projected_area_cm2', 'Wall_mm', 'Melt_C', 'Mould_C', 'Inj_speed_pct', 'Hold_bar',
            'Hold_s', 'Cooling_used_s', 'Cycle_s', 'Shots_per_h', 'kg_per_h', 'kWh_per_cycle', 'SEC_kWh_per_kg',
            'SEC_conventional', 'SEC_servo', 'SEC_electric', 'Annual_MWh', 'Annual_cost_Rs',
            'Servo_saving_pct', 'Clamp_util_pct', 'Shot_util_pct', 'Defects', 'Maintenance_alerts']


def log_run(p, r):
    os.makedirs(LOG_DIR, exist_ok=True)
    path = os.path.join(LOG_DIR, 'IMM_runs.csv')
    cur, cmp_ = r['cur'], r['compare']
    conv, servo, elec = cmp_[CONV_KEY], cmp_['Servo-hydraulic'], cmp_['All-electric']
    row = [datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'), p['tonnage'], p['drive'], p['mdata'], p['emodel'],
           p['material'], 'Yes' if p['glass'] else 'No', p['shot_g'], p['area'], p['wall'], p['melt'], p['mould'],
           p['speed'], p['hold_p'], p['hold_t'], round(r['t_cool'], 2), round(cur['cycle'], 2),
           round(3600 / cur['cycle'], 1), round(cur['kgh'], 2), round(cur['kwh'], 4), round(cur['sec'], 3),
           round(conv['sec'], 3), round(servo['sec'], 3), round(elec['sec'], 3), round(cur['annual_kwh'] / 1000, 1),
           round(cur['annual_cost']), round((1 - servo['annual_kwh'] / conv['annual_kwh']) * 100, 1) if conv['annual_kwh'] else 0,
           round(r['clamp_util'] * 100, 1), round(r['util'] * 100, 1),
           '; '.join(x[0] for x in r['defects']) or 'None', '; '.join(x[0] for x in r['maint']) or 'None']
    new = not os.path.exists(path)
    with open(path, 'a', newline='', encoding='utf-8-sig' if new else 'utf-8') as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(LOG_COLS)
        w.writerow(row)
    rep = os.path.join(LOG_DIR, 'IMM_report_%s.txt' % datetime.datetime.now().strftime('%Y%m%d_%H%M%S'))
    with open(rep, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(t for t, _ in report_lines(p, r)))
    return path


# ----------------------------------------------------------------------------
# Geometry helpers
# ----------------------------------------------------------------------------
def P3(x, y, z):
    return adsk.core.Point3D.create(x, y, z)


def V3(x, y, z):
    return adsk.core.Vector3D.create(x, y, z)


_BASE_AP = [None]


def appearance(design, name, rgb):
    try:
        ap = design.appearances.itemByName(name)
        if ap:
            return ap
        if _BASE_AP[0] is None:
            for libname in ('Fusion Appearance Library', 'Fusion 360 Appearance Library'):
                lib = APP.materialLibraries.itemByName(libname)
                if not lib:
                    continue
                for i in range(lib.appearances.count):
                    a = lib.appearances.item(i)
                    if 'Paint - Enamel Glossy' in a.name:
                        _BASE_AP[0] = a
                        break
                if _BASE_AP[0]:
                    break
        if _BASE_AP[0] is None:
            return None
        ap = design.appearances.addByCopy(_BASE_AP[0], name)
        prop = ap.appearanceProperties.itemById('opaque_albedo')
        cp = adsk.core.ColorProperty.cast(prop) if prop else None
        if cp is None:
            for i in range(ap.appearanceProperties.count):
                cp = adsk.core.ColorProperty.cast(ap.appearanceProperties.item(i))
                if cp:
                    break
        if cp:
            cp.value = adsk.core.Color.create(rgb[0], rgb[1], rgb[2], 255)
        return ap
    except Exception:
        return None


def _add(comp, name, tbody, ap):
    b = comp.bRepBodies.add(tbody)
    b.name = name
    if ap:
        b.appearance = ap
    return b


def box(comp, name, x0, x1, yc, zc, w, h, ap):
    tbm = adsk.fusion.TemporaryBRepManager.get()
    obb = adsk.core.OrientedBoundingBox3D.create(P3((x0 + x1) / 2, yc, zc), V3(1, 0, 0), V3(0, 1, 0),
                                                 abs(x1 - x0), w, h)
    return _add(comp, name, tbm.createBox(obb), ap)


def zbox(comp, name, xc, yc, z0, z1, lx, wy, ap):
    return box(comp, name, xc - lx / 2, xc + lx / 2, yc, (z0 + z1) / 2, wy, abs(z1 - z0), ap)


def xcyl(comp, name, x0, x1, yc, zc, r0, ap, r1=None):
    tbm = adsk.fusion.TemporaryBRepManager.get()
    t = tbm.createCylinderOrCone(P3(x0, yc, zc), r0, P3(x1, yc, zc), r0 if r1 is None else r1)
    return _add(comp, name, t, ap)


def zcyl(comp, name, x, y, z0, z1, r0, ap, r1=None):
    tbm = adsk.fusion.TemporaryBRepManager.get()
    t = tbm.createCylinderOrCone(P3(x, y, z0), r0, P3(x, y, z1), r0 if r1 is None else r1)
    return _add(comp, name, t, ap)


def ycyl(comp, name, x, y0, y1, z, r0, ap):
    tbm = adsk.fusion.TemporaryBRepManager.get()
    t = tbm.createCylinderOrCone(P3(x, y0, z), r0, P3(x, y1, z), r0)
    return _add(comp, name, t, ap)


def new_comp(root, name):
    occ = root.occurrences.addNewComponent(adsk.core.Matrix3D.create())
    occ.component.name = name
    return occ


# ----------------------------------------------------------------------------
# 5-point double-toggle kinematics (pure maths, also used for animation)
# ----------------------------------------------------------------------------
def toggle_geom(stroke, s, Pl, pt, az):
    toggle = 2 * stroke + 30 * s
    x0 = pt + 4 * s                          # rear link pin
    x_mp = pt + toggle                       # moving platen rear face (closed)
    d_closed = (x_mp - 4 * s) - x0           # rear pin -> front pin, closed
    L = d_closed / 2.0                       # long links: straight when locked
    zU, zL = az + 0.25 * Pl, az - 0.25 * Pl  # link pin heights
    zcU, zcL = az + 0.06 * Pl, az - 0.06 * Pl  # crosshead pin heights
    f = 0.6                                  # small link joins rear link at 60%
    d_open = d_closed - stroke
    h_open = math.sqrt(max(L * L - (d_open / 2) ** 2, 0.0))
    Lc = 1.08 * ((zU - zcU) + f * h_open)    # small (crosshead) link length
    G = dict(toggle=toggle, x0=x0, x_mp=x_mp, d_closed=d_closed, L=L, zU=zU, zL=zL,
             zcU=zcU, zcL=zcL, f=f, Lc=Lc, az=az, stroke=stroke)
    G['xc_closed'] = toggle_kin(G, 0.0)['xc']
    G['xc_open'] = toggle_kin(G, -stroke)['xc']
    return G


def toggle_kin(G, mov):
    L, x0 = G['L'], G['x0']
    d = max(1e-6, G['d_closed'] + mov)
    half = min(d / 2.0, L)
    h = math.sqrt(max(L * L - half * half, 0.0))
    a = math.atan2(h, half)
    qx = x0 + G['f'] * L * math.cos(a)
    qdz = G['f'] * L * math.sin(a)
    dz = (G['zU'] + qdz) - G['zcU']
    xc = qx + math.sqrt(max(G['Lc'] ** 2 - dz * dz, 0.0))
    return dict(half=half, h=h, qx=qx, qdz=qdz, xc=xc)


# ----------------------------------------------------------------------------
# Machine model v3 (cm, X = machine axis, Z = up, -Y = operator side)
# ----------------------------------------------------------------------------
def _tcyl(x0, x1, y, z, r0, r1=None):
    tbm = adsk.fusion.TemporaryBRepManager.get()
    return tbm.createCylinderOrCone(P3(x0, y, z), r0, P3(x1, y, z), r0 if r1 is None else r1)


def _tbox(x0, x1, y0, y1, z0, z1):
    tbm = adsk.fusion.TemporaryBRepManager.get()
    obb = adsk.core.OrientedBoundingBox3D.create(P3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
                                                 V3(1, 0, 0), V3(0, 1, 0),
                                                 abs(x1 - x0), abs(y1 - y0), abs(z1 - z0))
    return tbm.createBox(obb)


def _cut(target, tool):
    tbm = adsk.fusion.TemporaryBRepManager.get()
    try:
        tbm.booleanOperation(target, tool, adsk.fusion.BooleanTypes.DifferenceBooleanType)
    except Exception:
        pass
    return target


def build_machine(design, p, r):
    root = design.rootComponent
    for i in range(root.occurrences.count - 1, -1, -1):
        root.occurrences.item(i).deleteMe()

    ms = r['ms']
    s = ms['s']
    Dc = ms['D'] / 10.0
    tb, Pl, stroke = ms['tb'], ms['Pl'], ms['stroke']
    hydraulic = 'electric' not in p['drive'].lower()
    pt = 0.32 * tb
    tbd = 0.14 * tb
    fh = 70 * s
    az = fh + Pl / 2 + 3 * s
    G = toggle_geom(stroke, s, Pl, pt, az)
    x_mp = G['x_mp']
    cs = G['xc_closed'] - G['xc_open']           # crosshead stroke
    msz = 0.85 * (tb - tbd)
    mh = 0.35 * msz
    x_pl = x_mp + pt + mh
    x_fp = x_pl + mh
    x_fp2 = x_fp + pt
    x_n = x_fp2 - 2 * s
    noz = 8 * s
    Lb = 20 * Dc
    xb0 = x_n + noz
    xb1 = xb0 + Lb
    br = 1.1 * Dc
    bore = 0.5 * Dc + 0.05 * s
    dose = min(r['shot_cm3'] / (math.pi / 4 * Dc ** 2), 4 * Dc)
    xfl = xb1 + 3 * s                            # barrel head flange rear face
    xm0 = xfl + 2 * s                            # hydraulic motor front (screw forward)
    xm1 = xm0 + 0.15 * Lb
    xpl1 = xm1 + 3 * s                           # injection plate rear face
    rod_len = 0.25 * Lb
    xc0 = xpl1 + 0.10 * Lb                       # injection cylinder front
    xc1 = xpl1 + rod_len + 4 * Dc + 3 * s        # injection cylinder rear
    xd1 = xc1 + 3 * s                            # end of injection unit
    es = 6 * s
    ps = min(math.sqrt(max(p['area'], 1)), 0.7 * msz)
    pth = max(p['wall'] / 10.0, 0.15)
    yl = 0.25 * Pl                               # long-link y position
    yc = yl + 4 * s                              # small-link y position
    x_bed0 = -(cs + 14 * s)

    A = lambda n, c: appearance(design, n, c)
    a_frame = A('IMM Frame', (45, 50, 58))
    a_platen = A('IMM Platen', (90, 110, 130))
    a_chrome = A('IMM Chrome', (205, 210, 215))
    a_mould = A('IMM Mould', (150, 155, 160))
    a_mould2 = A('IMM Mould Cavity', (120, 125, 130))
    a_blue = A('IMM Blue', (40, 90, 160))
    a_barrel = A('IMM Barrel', (170, 175, 180))
    a_heat = A('IMM Heater', (120, 60, 35))
    a_hot = A('IMM Heater Hot', (255, 70, 0))
    a_eject = A('IMM Ejector', (200, 160, 40))
    a_dark = A('IMM Panel', (30, 30, 30))
    a_guard = A('IMM Guard', (240, 190, 20))
    a_link = A('IMM Toggle Link', (70, 75, 85))
    a_wIn = A('IMM Water In', (30, 110, 220))
    a_wOut = A('IMM Water Out', (220, 40, 40))
    a_screw = A('IMM Screw', (215, 220, 225))
    a_ring = A('IMM Check Ring', (190, 150, 60))
    a_oil = A('IMM Oil Tank', (60, 70, 80))
    a_motor = A('IMM Motor', (20, 120, 90))
    a_cab = A('IMM Cabinet', (225, 228, 232))
    a_part = A('IMM Part ' + p['material'], MATERIALS[p['material']]['rgb'])

    # ---------------- fixed structure ----------------
    fo = new_comp(root, 'Fixed structure')
    f = fo.component
    box(f, 'Machine bed', x_bed0, xd1 + 10 * s, 0, fh / 2, Pl + 10 * s, fh, a_frame)
    box(f, 'Rear platen', 0, pt, 0, az, Pl, Pl, a_platen)
    box(f, 'Fixed platen', x_fp, x_fp2, 0, az, Pl, Pl, a_platen)
    xcyl(f, 'Locating ring', x_fp2, x_fp2 + 1.5 * s, 0, az, 0.12 * msz, a_chrome)
    corners = [(-tb / 2, az - tb / 2), (tb / 2, az - tb / 2), (-tb / 2, az + tb / 2), (tb / 2, az + tb / 2)]
    for i, (y, z) in enumerate(corners):
        xcyl(f, 'Tie bar %d' % (i + 1), -5 * s, x_fp2 + 6 * s, y, z, tbd / 2, a_chrome)
        xcyl(f, 'Tie-bar nut rear %d' % (i + 1), -5 * s, 0, y, z, tbd * 0.85, a_dark)
        xcyl(f, 'Tie-bar nut front %d' % (i + 1), x_fp2, x_fp2 + 5 * s, y, z, tbd * 0.85, a_dark)
    xcyl(f, 'Clamp cylinder' if hydraulic else 'Clamp servo + ballscrew', -(cs + 12 * s), 0, 0, az, 0.11 * Pl,
         a_blue if hydraulic else a_motor)
    for yy in (-yl, yl):
        for zz in (G['zU'], G['zL']):
            box(f, 'Rear clevis', pt, pt + 4 * s, yy, zz, 5 * s, 7 * s, a_platen)
    # cavity half with sprue bush, cooling channels and water connectors
    box(f, 'Mould - cavity half', x_pl, x_fp, 0, az, msz, msz, a_mould2)
    xcyl(f, 'Sprue bush', x_fp - 1 * s, x_fp2 + 0.5 * s, 0, az, 1.5 * s, a_chrome)
    for zz in (az - 0.3 * msz, az + 0.3 * msz):
        xm = (x_pl + x_fp) / 2
        ycyl(f, 'Cooling channel (cavity)', xm, -msz / 2 - 4 * s, msz / 2 + 4 * s, zz, 0.9 * s, a_wIn)
        ycyl(f, 'Water in (cavity)', xm, -msz / 2 - 7 * s, -msz / 2 - 4 * s, zz, 1.5 * s, a_wIn)
        ycyl(f, 'Water out (cavity)', xm, msz / 2 + 4 * s, msz / 2 + 7 * s, zz, 1.5 * s, a_wOut)
    box(f, 'Operator panel', x_fp2 + 8 * s, x_fp2 + 30 * s, -(Pl / 2 + 14 * s), az, 6 * s, 30 * s, a_dark)
    # carriage (nozzle-touch) cylinders on fixed platen
    zcar = az - 2.6 * br
    for yy in (-2.4 * br, 2.4 * br):
        xcyl(f, 'Carriage cylinder', x_fp2, x_fp2 + 16 * s, yy, zcar, 1.6 * s, a_blue)

    # hydraulic power pack / drive cabinet (rear side)
    yr = Pl / 2 + 5 * s
    px0, px1 = x_fp2 + 5 * s, xd1
    if hydraulic:
        box(f, 'Oil tank', px0, px1, yr + 14 * s, 0.22 * fh, 28 * s, 0.44 * fh, a_oil)
        xm_len = 0.35 * (px1 - px0)
        xcyl(f, 'Pump motor', px0 + 5 * s, px0 + 5 * s + xm_len, yr + 14 * s, 0.44 * fh + 9 * s, 9 * s,
             a_motor if 'Servo' in p['drive'] else a_blue)
        xcyl(f, 'Bell housing', px0 + 5 * s + xm_len, px0 + 10 * s + xm_len, yr + 14 * s, 0.44 * fh + 9 * s,
             6 * s, a_platen, r1=4 * s)
        xcyl(f, 'Hydraulic pump', px0 + 10 * s + xm_len, px0 + 18 * s + xm_len, yr + 14 * s, 0.44 * fh + 9 * s,
             4 * s, a_chrome)
        box(f, 'Valve manifold', px0 + 22 * s + xm_len, px0 + 34 * s + xm_len, yr + 14 * s,
            0.44 * fh + 5 * s, 14 * s, 10 * s, a_platen)
        xcyl(f, 'Oil cooler', px1 - 30 * s, px1 - 4 * s, yr + 22 * s, 0.44 * fh + 5 * s, 4 * s, a_wIn)
    box(f, 'Electrical cabinet', x_bed0, x_bed0 + 50 * s, yr + 16 * s, (fh + 70 * s) / 2, 24 * s, fh + 70 * s, a_cab)

    # ---------------- safety guards ----------------
    go = new_comp(root, 'Safety guards')
    g = go.component
    gx0, gx1 = pt, x_fp2
    gz0, gz1 = fh, az + Pl / 2 + 12 * s
    bar = 2.0 * s
    for side, yy in (('operator', -(Pl / 2 + 8 * s)), ('rear', Pl / 2 + 8 * s)):
        box(g, 'Guard %s top rail' % side, gx0, gx1, yy, gz1 - bar / 2, bar, bar, a_guard)
        box(g, 'Guard %s bottom rail' % side, gx0, gx1, yy, gz0 + bar / 2, bar, bar, a_guard)
        for k, xx in enumerate((gx0 + bar / 2, (gx0 + gx1) / 2, gx1 - bar / 2)):
            zbox(g, 'Guard %s post %d' % (side, k + 1), xx, yy, gz0, gz1, bar, bar, a_guard)
    box(g, 'Guard roof rail', gx0, gx1, 0, gz1, Pl + 16 * s, bar, a_guard)

    # ---------------- moving platen + core half ----------------
    mo = new_comp(root, 'Moving platen + core')
    m = mo.component
    box(m, 'Moving platen', x_mp, x_mp + pt, 0, az, Pl, Pl, a_platen)
    box(m, 'Mould - core half', x_mp + pt, x_pl, 0, az, msz, msz, a_mould)
    for yy in (-yl, yl):
        for zz in (G['zU'], G['zL']):
            box(m, 'Front clevis', x_mp - 4 * s, x_mp, yy, zz, 5 * s, 7 * s, a_platen)
    gp = 0.42 * msz
    for i, (y, z) in enumerate([(-gp, az - gp), (gp, az - gp), (-gp, az + gp), (gp, az + gp)]):
        xcyl(m, 'Guide pillar %d' % (i + 1), x_pl - 0.5 * mh, x_pl + 0.6 * mh, y, z, 1.4 * s, a_chrome)
    for zz in (az - 0.3 * msz, az + 0.3 * msz):
        xm = (x_mp + pt + x_pl) / 2
        ycyl(m, 'Cooling channel (core)', xm, -msz / 2 - 4 * s, msz / 2 + 4 * s, zz, 0.9 * s, a_wIn)
        ycyl(m, 'Water in (core)', xm, -msz / 2 - 7 * s, -msz / 2 - 4 * s, zz, 1.5 * s, a_wIn)
        ycyl(m, 'Water out (core)', xm, msz / 2 + 4 * s, msz / 2 + 7 * s, zz, 1.5 * s, a_wOut)
    xcyl(m, 'Ejector cylinder', x_mp - 20 * s, x_mp, 0, az, 2.2 * s, a_blue if hydraulic else a_motor)

    # ---------------- toggle links (built along +X from origin) ----------------
    links = {}
    for key, Ln, yy in (('upA', G['L'], yl), ('upB', G['L'], yl), ('loA', G['L'], yl), ('loB', G['L'], yl),
                        ('upC', G['Lc'], yc), ('loC', G['Lc'], yc)):
        o = new_comp(root, 'Toggle link ' + key)
        for sy in (-1, 1):
            box(o.component, 'Link', 0, Ln, sy * yy, 0, 3 * s, 5 * s, a_link)
            ycyl(o.component, 'Pin', 0, sy * yy - 2.5 * s, sy * yy + 2.5 * s, 0, 1.6 * s, a_chrome)
        links[key] = o

    # ---------------- crosshead + clamp piston rod ----------------
    xo = new_comp(root, 'Crosshead')
    xcmp = xo.component
    xcc = G['xc_closed']
    box(xcmp, 'Crosshead', xcc - 2.5 * s, xcc + 2.5 * s, 0, az, 2 * yc + 4 * s, (G['zcU'] - G['zcL']) + 8 * s, a_blue)
    xcyl(xcmp, 'Clamp piston rod', -6 * s, xcc, 0, az, 0.05 * Pl, a_chrome)

    # ---------------- ejector ----------------
    eo = new_comp(root, 'Ejector')
    e = eo.component
    box(e, 'Ejector plate', x_mp - 12 * s, x_mp - 9 * s, 0, az, 0.3 * msz, 0.3 * msz, a_eject)
    xcyl(e, 'Ejector rod', x_mp - 16 * s, x_mp - 12 * s, 0, az, 1.0 * s, a_chrome)
    off = 0.25 * ps
    for i, (y, z) in enumerate([(-off, az - off), (off, az - off), (-off, az + off), (off, az + off)]):
        xcyl(e, 'Ejector pin %d' % (i + 1), x_mp - 9 * s, x_pl - pth, y, z, 0.6 * s, a_chrome)

    # ---------------- moulded part + sprue ----------------
    po = new_comp(root, 'Moulded part')
    box(po.component, 'Part', x_pl - pth, x_pl, 0, az, ps, ps, a_part)
    xcyl(po.component, 'Sprue', x_pl, x_fp, 0, az, 0.7 * s, a_part, r1=0.35 * s)

    # ---------------- injection unit (carriage) ----------------
    co = new_comp(root, 'Injection unit')
    c = co.component
    xcyl(c, 'Nozzle', x_n, xb0, 0, az, 0.3 * Dc, a_barrel, r1=0.7 * br)
    xcyl(c, 'Nozzle heater', x_n + 0.35 * noz, x_n + 0.75 * noz, 0, az, 0.75 * br, a_heat)
    quarter = lambda xa, xb_: _tbox(xa - 1, xb_ + 1, -3 * br, 0, az, az + 3 * br)
    barrel = _cut(_cut(_tcyl(xb0, xb1, 0, az, br), _tcyl(xb0 - 1, xb1 + 1, 0, az, bore)), quarter(xb0, xb1))
    _add(c, 'Barrel (cutaway)', barrel, a_barrel)
    heaters = []
    for i, frac in enumerate([0.08, 0.30, 0.52, 0.74]):
        x0 = xb0 + frac * Lb
        band = _cut(_cut(_tcyl(x0, x0 + 0.12 * Lb, 0, az, 1.15 * br), _tcyl(x0 - 1, x0 + 0.12 * Lb + 1, 0, az, br)),
                    quarter(x0, x0 + 0.12 * Lb))
        heaters.append(_add(c, 'Heater band %d' % (i + 1), band, a_heat))
    heaters.append(c.bRepBodies.itemByName('Nozzle heater'))
    xh = xb0 + 0.90 * Lb
    box(c, 'Feed throat (water cooled)', xh - 0.06 * Lb, xh + 0.06 * Lb, 0, az + 1.2 * br, 2.4 * br, 0.8 * br, a_wIn)
    zcyl(c, 'Hopper', xh, 0, az + 1.6 * br, az + br + 25 * s, 0.8 * Dc, a_platen, r1=max(10 * s, 2 * Dc))
    box(c, 'Barrel head flange', xb1, xfl, 0, az, 3.2 * br, 3.2 * br, a_platen)
    for yy in (-2.4 * br, 2.4 * br):
        xcyl(c, 'Injection cylinder', xc0, xc1, yy, az, 0.9 * br, a_blue if hydraulic else a_motor)
        xcyl(c, 'Guide rod', xfl, xc1, yy, az - 1.8 * br, 0.25 * br, a_chrome)
    box(c, 'Rear end plate', xc1, xd1, 0, az, 7 * br, 4.6 * br, a_platen)
    box(c, 'Carriage', xb0 + 0.6 * Lb, xd1, 0, (fh + az - br) / 2, 3 * br, az - br - fh, a_frame)
    box(c, 'Carriage bracket', xb0 + 0.44 * Lb, xb0 + 0.44 * Lb + 3 * s, 0, (zcar + az) / 2, 5.4 * br, az - zcar + 2 * s, a_frame)
    for yy in (-2.4 * br, 2.4 * br):
        xcyl(c, 'Carriage rod', x_fp2 + 4 * s, xb0 + 0.44 * Lb, yy, zcar, 0.8 * s, a_chrome)

    # ---------------- screw (rotates) ----------------
    so = new_comp(root, 'Screw')
    sc = so.component
    xt0 = xb0 + 0.3 * s                         # tip, screw forward
    xt1 = xt0 + 0.8 * Dc
    xcr1 = xt1 + 0.5 * Dc                       # check ring
    xseat = xcr1 + 0.2 * Dc
    xfl_end = xb1 - dose - 0.5 * s              # flights stay in barrel at full dose
    flen = max(xfl_end - xseat, 2 * Dc)
    xmet = xseat + 0.25 * flen
    xcomp = xmet + 0.25 * flen
    xcyl(sc, 'Screw tip', xt0, xt1, 0, az, 0.15 * Dc, a_screw, r1=0.35 * Dc)
    xcyl(sc, 'Check ring', xt1, xcr1, 0, az, 0.49 * Dc, a_ring)
    xcyl(sc, 'Check ring seat', xcr1, xseat, 0, az, 0.45 * Dc, a_ring)
    xcyl(sc, 'Root - metering zone', xseat, xmet, 0, az, 0.40 * Dc, a_screw)
    xcyl(sc, 'Root - compression zone', xmet, xcomp, 0, az, 0.40 * Dc, a_screw, r1=0.30 * Dc)
    xcyl(sc, 'Root - feed zone', xcomp, xseat + flen, 0, az, 0.30 * Dc, a_screw)
    tbm = adsk.fusion.TemporaryBRepManager.get()
    phi = math.atan(1.0 / math.pi)              # square-pitch helix angle
    dv = (math.cos(phi), math.sin(phi))
    t = 0.10 * Dc
    k = 0
    xx = xseat + 0.5 * Dc
    while xx < xseat + flen - 0.3 * Dc:
        p1 = P3(xx - dv[0] * t / 2, -dv[1] * t / 2, az)
        p2 = P3(xx + dv[0] * t / 2, dv[1] * t / 2, az)
        _add(sc, 'Flight %d' % (k + 1), tbm.createCylinderOrCone(p1, 0.48 * Dc, p2, 0.48 * Dc), a_screw)
        xx += Dc
        k += 1
    xcyl(sc, 'Screw shank', xseat + flen, xm0, 0, az, 0.30 * Dc, a_screw)

    # ---------------- injection piston group (moves with screw, no spin) ----------------
    io = new_comp(root, 'Injection drive (motor + pistons)')
    ic = io.component
    box(ic, 'Hydraulic motor' if hydraulic else 'Screw servo motor', xm0, xm1, 0, az, 2.6 * br, 2.6 * br,
        a_blue if hydraulic else a_motor)
    box(ic, 'Injection plate', xm1, xpl1, 0, az, 6.0 * br, 2.2 * br, a_platen)
    for yy in (-2.4 * br, 2.4 * br):
        xcyl(ic, 'Injection piston rod', xpl1, xpl1 + rod_len, yy, az, 0.35 * br, a_chrome)

    if design.attributes.itemByName(ATTR_GROUP, 'v') is None:
        design.attributes.add(ATTR_GROUP, 'v', '1')

    return dict(mov=mo, ej=eo, part=po, car=co, scr=so, inj=io, cross=xo, links=links,
                heaters=[h for h in heaters if h], a_heat=a_heat, a_hot=a_hot, G=G, az=az,
                stroke=stroke, retract=8 * s, dose=dose, es=es, drop=(az - fh) * 0.8)


# ----------------------------------------------------------------------------
# Animation
# ----------------------------------------------------------------------------
def _move(occ, dx, dz=0.0):
    mtx = adsk.core.Matrix3D.create()
    mtx.translation = V3(dx, 0, dz)
    occ.transform2 = mtx


def _pose_link(occ, xa, za, xb, zb):
    """Place a link built along +X (origin = its first pin) from (xa,za) to (xb,zb)."""
    theta = -math.atan2(zb - za, xb - xa)
    mtx = adsk.core.Matrix3D.create()
    mtx.setToRotation(theta, V3(0, 1, 0), P3(0, 0, 0))
    mtx.translation = V3(xa, 0, za)
    occ.transform2 = mtx


def _pose_toggle(g, mov):
    G = g['G']
    k = toggle_kin(G, mov)
    x0, half, h = G['x0'], k['half'], k['h']
    xf = x0 + 2 * half
    lk = g['links']
    _pose_link(lk['upA'], x0, G['zU'], x0 + half, G['zU'] + h)
    _pose_link(lk['upB'], x0 + half, G['zU'] + h, xf, G['zU'])
    _pose_link(lk['loA'], x0, G['zL'], x0 + half, G['zL'] - h)
    _pose_link(lk['loB'], x0 + half, G['zL'] - h, xf, G['zL'])
    _pose_link(lk['upC'], k['xc'], G['zcU'], k['qx'], G['zU'] + k['qdz'])
    _pose_link(lk['loC'], k['xc'], G['zcL'], k['qx'], G['zL'] - k['qdz'])
    _move(g['cross'], k['xc'] - G['xc_closed'])


def _spin_screw(g, dx, rot):
    mtx = adsk.core.Matrix3D.create()
    mtx.setToRotation(rot, V3(1, 0, 0), P3(0, 0, g['az']))
    t = mtx.translation
    mtx.translation = V3(t.x + dx, t.y, t.z)
    g['scr'].transform2 = mtx


def _apply(g, st):
    _move(g['mov'], st['mov'])
    _move(g['ej'], st['mov'] + st['ej'])
    _move(g['part'], st['mov'] + st['pej'], st['pdz'])
    _move(g['car'], st['car'])
    _move(g['inj'], st['car'] + st['scr'])
    _spin_screw(g, st['car'] + st['scr'], st['rot'])
    _pose_toggle(g, st['mov'])


def _heaters(g, hot):
    if g.get('hot') == hot:
        return
    ap = g['a_hot'] if hot else g['a_heat']
    if ap:
        for b in g['heaters']:
            b.appearance = ap
    g['hot'] = hot


def _refresh():
    APP.activeViewport.refresh()
    adsk.doEvents()


def _tween(g, st, keys, targets, real_t, name, clk, pb, heat=None, spin=False):
    """Animate keys -> targets; clk = dict(t0, cycle, tag) drives the live timer."""
    frames = int(min(36, max(6, 6 + 3 * real_t)))
    start = [st[k] for k in keys]
    for i in range(1, frames + 1):
        t = i / frames
        ease = 0.5 - 0.5 * math.cos(math.pi * t)
        for k, a, b in zip(keys, start, targets):
            st[k] = a + (b - a) * ease
        if spin:
            st['rot'] += 0.45
        if heat == 'pulse':
            _heaters(g, (i // 4) % 2 == 0)
        elif heat is not None:
            _heaters(g, heat)
        now = clk['t0'] + real_t * t
        try:
            pb.message = '%s%s  |  t = %.1f / %.1f s' % (clk['tag'], name, now, clk['cycle'])
            pb.progressValue = int(min(100, now / clk['cycle'] * 100))
        except Exception:
            pass
        _apply(g, st)
        _refresh()
        time.sleep(0.015)
    clk['t0'] += real_t


def animate(g, r, cycles):
    pb = UI.progressBar
    try:
        pb.show('IMM cycle', 0, 100)
    except Exception:
        pass
    ph = {name: t for name, t, _ in r['cur']['phases']}
    cyc = r['cur']['cycle']
    sim_cyc = sum(ph.values())
    k = cyc / sim_cyc if sim_cyc else 1.0
    st = dict(mov=-g['stroke'], ej=0.0, pej=0.0, pdz=0.0, car=g['retract'], scr=g['dose'], rot=0.0)
    g['part'].isLightBulbOn = False
    _heaters(g, False)
    _apply(g, st)
    _refresh()
    try:
        for c in range(cycles):
            clk = dict(t0=0.0, cycle=cyc, tag='Cycle %d/%d - ' % (c + 1, cycles))
            T = lambda n: ph[n] * k
            _tween(g, st, ['mov'], [0.0], T('Mould close'), 'Mould close (crosshead drives toggle to lock)', clk, pb, False)
            _tween(g, st, ['car'], [0.0], T('Nozzle forward'), 'Nozzle forward', clk, pb)
            _tween(g, st, ['scr'], [0.05 * g['dose']], T('Injection (fill)'),
                   'Injection - check ring closes, screw rams forward', clk, pb, True)
            g['part'].isLightBulbOn = True
            _tween(g, st, ['scr'], [0.0], T('Holding pressure'), 'Holding pressure', clk, pb, True)
            _tween(g, st, ['scr'], [g['dose']], T('Cooling + screw recovery'),
                   'Cooling + recovery - screw turns and moves back', clk, pb, 'pulse', spin=True)
            _tween(g, st, ['car'], [g['retract']], T('Nozzle back'), 'Nozzle back', clk, pb, False)
            _tween(g, st, ['mov'], [-g['stroke']], T('Mould open'), 'Mould open (toggle folds)', clk, pb)
            _tween(g, st, ['ej', 'pej'], [g['es'], g['es']], T('Ejection'), 'Ejection', clk, pb)
            _tween(g, st, ['pdz'], [-g['drop']], 0.0, 'Part + sprue drop', clk, pb)
            g['part'].isLightBulbOn = False
            st['pdz'] = 0.0
            st['pej'] = 0.0
            _tween(g, st, ['ej'], [0.0], 0.0, 'Ejector back', clk, pb)
    finally:
        _heaters(g, False)
        try:
            pb.hide()
        except Exception:
            pass


# ----------------------------------------------------------------------------
# Command dialog
# ----------------------------------------------------------------------------
CUSTOM_IDS = ['c_tiebar', 'c_stroke', 'c_screw', 'c_motor', 'c_heater']
MEASURED_IDS = ['e_cycle', 'e_close', 'e_nozzle', 'e_inject', 'e_hold', 'e_cool', 'e_open', 'e_eject', 'e_heat']


def read_inputs():
    def v(i):
        return INPUTS.itemById(i).value

    def dd(i):
        return adsk.core.DropDownCommandInput.cast(INPUTS.itemById(i)).selectedItem.name

    p = dict(tonnage=int(v('tonnage')), drive=dd('drive'), mdata=dd('mdata'), emodel=dd('emodel'),
             material=dd('material'), glass=bool(v('glass')), shot_g=v('shot_g'), area=v('area'), wall=v('wall'),
             melt=v('melt'), mould=v('mould'), speed=v('speed'), hold_p=v('hold_p'),
             hold_t=v('hold_t'), cool=v('cool'), tariff=v('tariff'), hours_yr=v('hours_yr'),
             run_h=v('run_h'), oil_h=v('oil_h'), oil_t=v('oil_t'),
             cycles=int(v('cycles')), log=bool(v('log')))
    for i in CUSTOM_IDS + MEASURED_IDS:
        p[i] = v(i)
    return p


def update_visibility():
    p_custom = adsk.core.DropDownCommandInput.cast(INPUTS.itemById('mdata')).selectedItem.name == MDATA[1]
    p_meas = adsk.core.DropDownCommandInput.cast(INPUTS.itemById('emodel')).selectedItem.name == EMODEL[1]
    for i in CUSTOM_IDS:
        INPUTS.itemById(i).isVisible = p_custom
    for i in MEASURED_IDS:
        INPUTS.itemById(i).isVisible = p_meas


def refresh_results():
    p = read_inputs()
    r = simulate(p)
    tb = adsk.core.TextBoxCommandInput.cast(INPUTS.itemById('results'))
    tb.formattedText = to_html(report_lines(p, r))


class CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def notify(self, args):
        global INPUTS
        try:
            cmd = args.command
            cmd.okButtonText = 'Build model & run cycle'
            cmd.setDialogInitialSize(580, 900)
            INPUTS = cmd.commandInputs
            ins = INPUTS

            def grp(i, n, expanded=True):
                gg = ins.addGroupCommandInput(i, n)
                gg.isExpanded = expanded
                return gg.children

            def fl(ch, i, n, lo, hi, step, val):
                ch.addFloatSpinnerCommandInput(i, n, '', lo, hi, step, val)

            def drop(ch, i, n, items):
                d = ch.addDropDownCommandInput(i, n, adsk.core.DropDownStyles.TextListDropDownStyle)
                for k, it in enumerate(items):
                    d.listItems.add(it, k == 0, '')

            g = grp('g_machine', 'Machine')
            g.addIntegerSpinnerCommandInput('tonnage', 'Clamp tonnage (t)', 50, 4000, 50, 250)
            drop(g, 'drive', 'Drive type', list(DRIVES))
            drop(g, 'mdata', 'Machine data', MDATA)
            fl(g, 'c_tiebar', 'Tie-bar spacing (mm)', 150, 3000, 10, 560)
            fl(g, 'c_stroke', 'Opening stroke (mm)', 100, 3000, 10, 520)
            fl(g, 'c_screw', 'Screw diameter (mm)', 15, 200, 1, 50)
            fl(g, 'c_motor', 'Drive motor (kW)', 2, 600, 1, 37)
            fl(g, 'c_heater', 'Barrel heaters (kW)', 1, 200, 0.5, 12)

            g = grp('g_part', 'Material & part')
            drop(g, 'material', 'Material', list(MATERIALS))
            g.addBoolValueInput('glass', 'Glass filled', True, '', False)
            fl(g, 'shot_g', 'Shot weight incl. runner (g)', 1, 50000, 10, 150)
            fl(g, 'area', 'Projected area (cm2)', 1, 50000, 10, 300)
            fl(g, 'wall', 'Wall thickness (mm)', 0.5, 10, 0.1, 2.5)

            g = grp('g_proc', 'Process settings')
            fl(g, 'melt', 'Melt temperature (C)', 150, 350, 5, 230)
            fl(g, 'mould', 'Mould temperature (C)', 10, 140, 5, 40)
            fl(g, 'speed', 'Injection speed (%)', 5, 100, 5, 60)
            fl(g, 'hold_p', 'Hold pressure (bar)', 100, 1600, 25, 600)
            fl(g, 'hold_t', 'Hold time (s)', 0.2, 30, 0.5, 4)
            fl(g, 'cool', 'Cooling time (s, 0 = auto)', 0, 120, 0.5, 0)

            g = grp('g_energy', 'Energy & cost')
            drop(g, 'emodel', 'Energy model', EMODEL)
            fl(g, 'e_cycle', 'Measured cycle time (s)', 1, 600, 0.1, 18.3)
            fl(g, 'e_close', 'Mould close (Wh)', 0, 5000, 0.5, 9)
            fl(g, 'e_nozzle', 'Nozzle fwd + back (Wh)', 0, 5000, 0.5, 5)
            fl(g, 'e_inject', 'Injection (Wh)', 0, 5000, 0.5, 12)
            fl(g, 'e_hold', 'Holding (Wh)', 0, 5000, 0.5, 25)
            fl(g, 'e_cool', 'Cooling + recovery (Wh)', 0, 20000, 0.5, 66)
            fl(g, 'e_open', 'Mould open (Wh)', 0, 5000, 0.5, 9)
            fl(g, 'e_eject', 'Ejection (Wh)', 0, 5000, 0.5, 4)
            fl(g, 'e_heat', 'Barrel heaters (Wh)', 0, 20000, 0.5, 22)
            fl(g, 'tariff', 'Tariff (Rs/kWh)', 1, 30, 0.5, 8)
            fl(g, 'hours_yr', 'Running hours per year', 500, 8760, 100, 6000)

            g = grp('g_maint', 'Maintenance inputs')
            fl(g, 'run_h', 'Total running hours', 0, 200000, 500, 12000)
            fl(g, 'oil_h', 'Hours since oil change', 0, 50000, 100, 2500)
            fl(g, 'oil_t', 'Hydraulic oil temp (C)', 10, 90, 1, 45)

            g = grp('g_run', 'Run options')
            g.addIntegerSpinnerCommandInput('cycles', 'Cycles to animate', 1, 10, 1, 2)
            g.addBoolValueInput('log', 'Log run to Excel (CSV)', True, '', True)

            ins.addTextBoxCommandInput('results', 'Results', '', 30, True)
            update_visibility()
            refresh_results()

            for ev, H in ((cmd.inputChanged, ChangedHandler), (cmd.execute, ExecuteHandler), (cmd.destroy, DestroyHandler)):
                h = H()
                ev.add(h)
                HANDLERS.append(h)
        except Exception:
            UI.messageBox(traceback.format_exc())


class ChangedHandler(adsk.core.InputChangedEventHandler):
    def notify(self, args):
        try:
            if args.input.id == 'results':
                return
            if args.input.id in ('mdata', 'emodel'):
                update_visibility()
            refresh_results()
        except Exception:
            pass


class ExecuteHandler(adsk.core.CommandEventHandler):
    def notify(self, args):
        try:
            p = read_inputs()
            r = simulate(p)
            design = adsk.fusion.Design.cast(APP.activeProduct)
            g = build_machine(design, p, r)
            vp = APP.activeViewport
            cam = vp.camera
            cam.viewOrientation = adsk.core.ViewOrientations.IsoTopRightViewOrientation
            vp.camera = cam
            vp.fit()
            _refresh()
            animate(g, r, p['cycles'])
            msg = '\n'.join(t for t, _ in report_lines(p, r))
            if p['log']:
                try:
                    msg += '\n\nLogged to: ' + log_run(p, r)
                except Exception as ex:
                    msg += '\n\nLog failed: %s' % ex
            UI.messageBox(msg, 'IMM Simulator - results')
        except Exception:
            UI.messageBox(traceback.format_exc())


class DestroyHandler(adsk.core.CommandEventHandler):
    def notify(self, args):
        adsk.terminate()


def ensure_design():
    design = adsk.fusion.Design.cast(APP.activeProduct)
    if design and design.attributes.itemByName(ATTR_GROUP, 'v'):
        return design
    APP.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
    design = adsk.fusion.Design.cast(APP.activeProduct)
    design.designType = adsk.fusion.DesignTypes.DirectDesignType
    design.attributes.add(ATTR_GROUP, 'v', '1')
    return design


def run(context):
    global APP, UI
    try:
        APP = adsk.core.Application.get()
        UI = APP.userInterface
        ensure_design()
        cd = UI.commandDefinitions.itemById(CMD_ID)
        if cd:
            cd.deleteMe()
        cd = UI.commandDefinitions.addButtonDefinition(
            CMD_ID, 'IMM Simulator v3',
            'Injection moulding machine: 3D toggle cycle, energy/SEC, defects, maintenance, Excel log')
        h = CreatedHandler()
        cd.commandCreated.add(h)
        HANDLERS.append(h)
        cd.execute()
        adsk.autoTerminate(False)
    except Exception:
        if UI:
            UI.messageBox(traceback.format_exc())


def stop(context):
    try:
        cd = UI.commandDefinitions.itemById(CMD_ID)
        if cd:
            cd.deleteMe()
    except Exception:
        pass
