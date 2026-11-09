import sys, types, math
from unittest.mock import MagicMock
adsk=types.ModuleType('adsk'); core=MagicMock(); fusion=MagicMock()
class H: pass
core.CommandCreatedEventHandler=H; core.InputChangedEventHandler=H; core.CommandEventHandler=H
adsk.core=core; adsk.fusion=fusion; adsk.doEvents=lambda:None
sys.modules['adsk']=adsk; sys.modules['adsk.core']=core; sys.modules['adsk.fusion']=fusion
import os; sys.path.insert(0, os.environ.get('IMM_SRC') or next(d for d in (os.path.join(os.path.dirname(__file__), '..', 'assets', 'IMM_Simulator'), os.path.join(os.path.dirname(__file__), '..', 'IMM_Simulator')) if os.path.exists(os.path.join(d, 'IMM_Simulator.py'))))
import IMM_Simulator as S
S.time.sleep=lambda x:None
S.APP=MagicMock(); S.UI=MagicMock()
design=MagicMock(); design.rootComponent.occurrences.count=0
design.attributes.itemByName.return_value=None
base=dict(tonnage=250,drive=S.CONV_KEY,mdata=S.MDATA[0],emodel=S.EMODEL[0],material='PP',glass=False,shot_g=150,area=300,wall=2.5,melt=230,mould=40,speed=60,hold_p=600,hold_t=4,cool=0,tariff=8,hours_yr=6000,run_h=12000,oil_h=2500,oil_t=45,cycles=1,log=False,
 c_tiebar=560,c_stroke=520,c_screw=50,c_motor=37,c_heater=12,e_cycle=18.3,e_close=9,e_nozzle=5,e_inject=12,e_hold=25,e_cool=66,e_open=9,e_eject=4,e_heat=22)
for p in (base, dict(base,drive='All-electric',tonnage=1500), dict(base,mdata=S.MDATA[1],tonnage=1200,c_tiebar=1250,c_stroke=1200,c_screw=105,shot_g=2000,area=2000)):
    r=S.simulate(p); g=S.build_machine(design,p,r); S.animate(g,r,1)
    G=g['G']; print(p['tonnage'],p['drive'][:12],'links',len(g['links']),'heaters',len(g['heaters']),'cs=%.0f'%(G['xc_closed']-G['xc_open']))
print('bodies created:', design.rootComponent.occurrences.addNewComponent.call_count)
