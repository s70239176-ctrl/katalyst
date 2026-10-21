import json, pathlib, time, sys
from playwright.sync_api import sync_playwright

WORK = pathlib.Path(r'C:\Users\User\AppData\Local\Temp\kt-demo')
RAW = WORK / 'raw_explorer'
RAW.mkdir(exist_ok=True)
for f in RAW.glob('*.webm'):
    f.unlink()
href = 'https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/138228'
print('href', href, flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True)
    ctx = b.new_context(viewport={'width': 1280, 'height': 720}, record_video_dir=str(RAW), record_video_size={'width': 1280, 'height': 720})
    pg = ctx.new_page()
    t0 = time.time()
    pg.goto(href, wait_until='domcontentloaded')
    loaded_at = None
    for i in range(120):
        pg.wait_for_timeout(1000)
        txt = pg.evaluate("document.body.innerText")
        if 'revive.ethTransact' in txt and 'Retrieving data' not in txt:
            loaded_at = time.time() - t0
            print('loaded at', round(loaded_at, 1), flush=True)
            break
        if i % 10 == 0:
            print(i, txt[:100].replace(chr(10), ' | '), flush=True)
    pg.wait_for_timeout(7000)
    if loaded_at:
        for _ in range(6):
            pg.mouse.wheel(0, 90)
            pg.wait_for_timeout(450)
        pg.wait_for_timeout(5500)
    total = time.time() - t0
    ctx.close()
    b.close()
vids = sorted(RAW.glob('*.webm'))
json.dump({'video': str(vids[-1]), 'loaded_at': loaded_at, 'total': total}, open(WORK / 'explorer.json', 'w'))
print('saved', vids[-1], loaded_at, total)
