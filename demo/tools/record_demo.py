"""Record the live Katalyst site doing a real Portaldot testnet intent end to end.

Uses the local dev wallet (signs with the testnet deployer key) and records a 1280x720 video plus a markers.json
with the time (seconds from video start) of each scene boundary.
"""
import json, os, sys, time, pathlib, re
from playwright.sync_api import sync_playwright

WORK = pathlib.Path(r'C:\Users\User\AppData\Local\Temp\kt-demo')
RAW = WORK / 'raw'
RAW.mkdir(exist_ok=True)
for f in RAW.glob('*.webm'):
    f.unlink()

SITE = 'https://katalyst-intent.vercel.app'
PROMPT = 'Maximize yield, but only A-Tier carbon pools, minimum 12% APY.'
markers: dict[str, float] = {}

SHIM = """
(() => {
  window.ethereum = {
    isMetaMask: false,
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts') window.__ktAuth = true;
      if (method === 'eth_accounts' && !window.__ktAuth) return [];
      const out = JSON.parse(await window.__ktWallet(JSON.stringify({ method, params })));
      if (out.error) { const e = new Error(out.error.message || 'rpc error'); e.code = out.error.code; throw e; }
      return out.result;
    },
    on() {}, removeListener() {},
  };
  // Visible cursor + click ripple (Playwright videos do not draw the mouse).
  const css = document.createElement('style');
  css.textContent = '#kt-cur{position:fixed;z-index:2147483647;width:18px;height:18px;margin:-3px 0 0 -3px;pointer-events:none;transition:transform .08s;}#kt-cur svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}.kt-rip{position:fixed;z-index:2147483646;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid #c4ff42;pointer-events:none;animation:ktr .55s ease-out forwards}@keyframes ktr{to{transform:scale(3.2);opacity:0}}';
  const mount = () => {
    if (document.getElementById('kt-cur')) return;
    document.head.appendChild(css);
    const c = document.createElement('div'); c.id = 'kt-cur';
    c.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#fff" stroke="#05090c" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    window.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    window.addEventListener('mousedown', (e) => { const r = document.createElement('div'); r.className = 'kt-rip'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700); }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
"""


import urllib.request


def wallet_bridge(payload: str) -> str:
    """Forward an EIP-1193 request to the local dev wallet (testnet key; signs locally)."""
    req = urllib.request.Request('http://127.0.0.1:8787/rpc', data=payload.encode(), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode()


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=True)
        ctx = browser.new_context(viewport={'width': 1280, 'height': 720}, record_video_dir=str(RAW), record_video_size={'width': 1280, 'height': 720}, device_scale_factor=1)
        ctx.expose_function('__ktWallet', wallet_bridge)
        ctx.add_init_script(SHIM)
        page = ctx.new_page()
        t0 = time.time()
        now = lambda: round(time.time() - t0, 2)  # noqa: E731

        def mark(name: str) -> None:
            markers[name] = now()
            print(f'[{now():7.2f}] {name}', flush=True)

        def pause(s: float) -> None:
            page.wait_for_timeout(int(s * 1000))

        def move_to(box, steps=28):
            x = box['x'] + box['width'] / 2
            y = box['y'] + box['height'] / 2
            page.mouse.move(x, y, steps=steps)

        def click(locator, steps=28, settle=0.35):
            locator.scroll_into_view_if_needed()
            pause(0.2)
            box = locator.bounding_box()
            move_to(box, steps)
            pause(settle)
            page.mouse.down()
            page.mouse.up()

        def smooth_scroll(y: int, wait: float = 1.6) -> None:
            page.evaluate(f"window.scrollTo({{top:{y}, behavior:'smooth'}})")
            pause(wait)

        # ---------------- scene: landing ----------------
        page.goto(SITE + '/', wait_until='domcontentloaded')
        page.mouse.move(640, 360)
        page.wait_for_selector('.kt-table tbody tr td .kt-pill', timeout=60000)
        mark('landing_start')
        pause(3.5)
        smooth_scroll(260, 2.2)          # flow diagram + metrics
        pause(2.5)
        smooth_scroll(520, 2.2)          # recent settlements
        pause(3.0)
        smooth_scroll(900, 2.0)          # protocol layers
        pause(2.0)
        smooth_scroll(0, 1.5)
        mark('landing_end')

        # ---------------- scene: compose ----------------
        click(page.get_by_role('button', name=re.compile('Launch app')))
        page.wait_for_selector('textarea[aria-label="Intent"]')
        pause(1.2)
        mark('compose_start')
        click(page.get_by_role('button', name=re.compile('Connect wallet')).first)
        pause(2.2)
        ta = page.locator('textarea[aria-label="Intent"]')
        click(ta)
        page.keyboard.press('Control+A')
        page.keyboard.press('Delete')
        page.keyboard.type(PROMPT, delay=38)
        pause(0.6)
        amount = page.locator('#amount')
        click(amount)
        page.keyboard.press('Control+A')
        page.keyboard.type('0.3', delay=90)
        pause(0.8)
        click(page.get_by_role('button', name=re.compile('Preview verdict')))
        mark('preview_clicked')
        page.wait_for_selector('text=Verdict preview', timeout=90000)
        pause(1.0)
        smooth_scroll(260, 1.8)
        pause(4.0)                        # let the viewer read the allocation
        smooth_scroll(0, 1.2)
        mark('compose_end')

        # ---------------- scene: deposit ----------------
        pause(0.4)
        lock = page.locator('input[type=checkbox]').first
        click(lock)
        pause(1.2)
        mark('lock_checked')
        click(page.get_by_role('button', name=re.compile('Deposit & submit')))
        mark('deposit_clicked')
        page.wait_for_selector('text=Deposit locked', timeout=120000)
        mark('deposit_confirmed')
        pause(4.0)

        # ---------------- scene: consensus + delay (real time) ----------------
        mark('lifecycle_start')
        page.wait_for_selector('text=validators agreed', timeout=240000)
        mark('consensus_seen')
        page.wait_for_selector('text=Safety delay', timeout=240000)
        mark('delay_seen')
        page.wait_for_selector('text=Routed to', timeout=300000)
        mark('settled_seen')
        pause(4.0)
        nonce_txt = page.locator('h2:has-text("Intent #")').first.inner_text()
        nonce = int(re.search(r'#(\d+)', nonce_txt).group(1))
        markers['nonce'] = nonce
        # explorer link for the settlement step
        href = page.locator('a[href*="node-console.portaldot.dev"]').last.get_attribute('href')
        markers['explorer_href'] = href
        mark('lifecycle_end')

        # ---------------- scene: Portaldot explorer ----------------
        if href:
            try:
                page.goto(href, wait_until='domcontentloaded')
                mark('explorer_start')
                pause(14.0)
                mark('explorer_end')
            except Exception as e:  # noqa: BLE001
                print('explorer failed', e)

        # ---------------- scene: verify (the run we just did) ----------------
        page.goto(f'{SITE}/#/verify/{nonce}', wait_until='domcontentloaded')
        page.wait_for_selector('text=checks passed', timeout=120000)
        mark('verify_start')
        pause(2.5)
        for y in (330, 700, 1100):
            smooth_scroll(y, 2.4)
        pause(1.5)
        mark('verify_end')

        # ---------------- scene: veto story (intent 4, real testnet) ----------------
        page.goto(f'{SITE}/#/verify/4', wait_until='domcontentloaded')
        page.wait_for_selector('text=checks passed', timeout=120000)
        mark('veto_start')
        pause(2.0)
        for y in (380, 800):
            smooth_scroll(y, 2.6)
        pause(2.0)
        mark('veto_end')

        # ---------------- scene: network / vault rules ----------------
        page.goto(f'{SITE}/#/network', wait_until='domcontentloaded')
        page.wait_for_selector('text=Vault rules', timeout=90000)
        mark('network_start')
        pause(2.5)
        smooth_scroll(300, 2.4)
        pause(3.0)
        mark('network_end')

        mark('done')
        ctx.close()   # flushes the video
        browser.close()

    vids = sorted(RAW.glob('*.webm'), key=lambda f: f.stat().st_mtime)
    markers['video'] = str(vids[-1])
    (WORK / 'markers.json').write_text(json.dumps(markers, indent=2))
    print('saved', vids[-1], flush=True)


if __name__ == '__main__':
    main()
