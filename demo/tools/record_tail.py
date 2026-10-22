import json, re, time, pathlib
from playwright.sync_api import sync_playwright

WORK = pathlib.Path(r'C:\Users\User\AppData\Local\Temp\kt-demo')
RAW = WORK / 'raw_tail'
RAW.mkdir(exist_ok=True)
for f in RAW.glob('*.webm'):
    f.unlink()
SITE = 'https://katalyst-intent.vercel.app'
NONCE = json.load(open(WORK / 'markers.json'))['nonce']
m = {}

with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True)
    ctx = b.new_context(viewport={'width': 1280, 'height': 720}, record_video_dir=str(RAW), record_video_size={'width': 1280, 'height': 720})
    pg = ctx.new_page()
    t0 = time.time()
    now = lambda: round(time.time() - t0, 2)
    def mark(n): m[n] = now(); print(f'[{now():7.2f}] {n}', flush=True)
    def pause(s): pg.wait_for_timeout(int(s * 1000))
    def scroll(y, wait): pg.evaluate(f"window.scrollTo({{top:{y}, behavior:'smooth'}})"); pause(wait)

    pg.goto(f'{SITE}/#/verify/{NONCE}', wait_until='domcontentloaded')
    pg.wait_for_selector('text=checks passed', timeout=120000)
    mark('verify_start'); pause(3.5)
    for y in (260, 520, 780, 1040, 1300):
        scroll(y, 3.6)
    pause(1.0); mark('verify_end')

    pg.goto(f'{SITE}/#/verify/4', wait_until='domcontentloaded')
    pg.wait_for_selector('text=checks passed', timeout=120000)
    mark('veto_start'); pause(4.5)
    for y in (300, 620, 900):
        scroll(y, 4.2)
    pause(1.5); mark('veto_end')

    pg.goto(f'{SITE}/#/network', wait_until='domcontentloaded')
    pg.wait_for_selector('text=Vault rules', timeout=90000)
    mark('network_start'); pause(3.0)
    scroll(340, 3.6); pause(2.2)
    mark('network_end')
    ctx.close(); b.close()

vids = sorted(RAW.glob('*.webm'))
m['video'] = str(vids[-1])
json.dump(m, open(WORK / 'tail.json', 'w'))
print('saved', vids[-1])
