# Validate translation JSON files: {lang: {key: text}} against the English catalogue.
import json,re,sys
exec(open('/tmp/cat.py').read())
en=entries(block('en'))
SCRIPT={'ta':r'[\u0B80-\u0BFF]','hi':r'[\u0900-\u097F]','de':r'[A-Za-zÄÖÜäöüß]'}
ph=lambda s:sorted(re.findall(r'\{\w+\}',s)); ent=lambda s:sorted(re.findall(r'&\w+;|<[^>]+>',s))
bad=0; counts={}
for f in sys.argv[1:]:
    d=json.load(open(f))
    for lang,tr in d.items():
        counts[lang]=counts.get(lang,0)+len(tr)
        for k,v in tr.items():
            if k not in en: print(f'{f} {lang} unknown key {k}'); bad+=1; continue
            e=en[k].replace("\\'","'").replace('\\"','"')
            if ph(v)!=ph(e): print(f'{lang} {k}: placeholders {ph(v)} != {ph(e)}'); bad+=1
            if ent(v)!=ent(e): print(f'{lang} {k}: markup {ent(v)} != {ent(e)}'); bad+=1
            if not re.search(SCRIPT[lang],v): print(f'{lang} {k}: no {lang} script: {v[:40]}'); bad+=1
            if not v.strip(): print(f'{lang} {k}: empty'); bad+=1
print('checked',counts,'problems',bad)
