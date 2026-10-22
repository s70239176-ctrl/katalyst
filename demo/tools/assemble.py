import json, os, subprocess, wave, glob, pathlib, shutil, textwrap, sys
import numpy as np
import imageio_ffmpeg
from playwright.sync_api import sync_playwright

W = pathlib.Path(r'C:\Users\User\AppData\Local\Temp\kt-demo')
OUT = pathlib.Path(r'C:\Users\User\Documents\Projects\New folder (2)\demo')
OUT.mkdir(exist_ok=True)
FF = imageio_ffmpeg.get_ffmpeg_exe()
CLIPS = W / 'clips'
CLIPS.mkdir(exist_ok=True)
for f in CLIPS.glob('*'):
    f.unlink()

main = json.load(open(W / 'markers.json'))
tail = json.load(open(W / 'tail.json'))
exp = json.load(open(W / 'explorer.json'))
script = json.load(open(W / 'script.json', encoding='utf8'))
OFF = 0.4  # video starts slightly before the marker clock

# ------------------------------------------------------------------ cards
K = '<path d="M12 8h12v48H12z" fill="#c4ff42"/><path d="M24 36 52 8H40L24 24z" fill="#c4ff42"/><path d="M24 28 52 56H40L24 40z" fill="#35caff"/>'
BASE = '''<!doctype html><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{margin:0;width:1280px;height:720px;background:#05090c;color:#f3f6f8;font-family:Inter,Arial,sans-serif;position:relative;overflow:hidden}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(105,145,163,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(105,145,163,.07) 1px,transparent 1px);background-size:40px 40px}
.glow{position:absolute;right:-160px;top:-160px;width:640px;height:640px;border-radius:50%;background:radial-gradient(circle,rgba(196,255,66,.13),transparent 65%)}
.glow2{position:absolute;left:-200px;bottom:-240px;width:640px;height:640px;border-radius:50%;background:radial-gradient(circle,rgba(53,202,255,.10),transparent 65%)}
.c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.brand{display:flex;align-items:center;gap:20px;font-weight:600;letter-spacing:.2em;font-size:34px}
h1{margin:34px 0 0;font-size:88px;line-height:1.02;letter-spacing:-.03em;font-weight:700}h1 span{color:#c4ff42}
p{margin:26px 0 0;font-size:25px;color:#8fa5bd}
.chip{display:inline-flex;align-items:center;gap:10px;margin-top:34px;padding:10px 18px;border:1px solid #2a3b46;border-radius:4px;background:#0a1116;font-size:18px;color:#dfe7ee}
.dot{width:9px;height:9px;border-radius:50%;background:#42e58b;box-shadow:0 0 10px #42e58b}
.mono{font-family:'JetBrains Mono',monospace}
.row{display:flex;gap:28px;margin-top:38px}
.box{padding:18px 26px;border:1px solid #2a3b46;border-radius:4px;background:#0a1116;font-size:21px}
.box b{display:block;font-size:13px;letter-spacing:.16em;color:#65798b;font-weight:600;margin-bottom:8px}
</style>'''
intro = BASE + f'''<body><div class="grid"></div><div class="glow"></div><div class="glow2"></div><div class="c">
<div class="brand"><svg width="76" height="76" viewBox="0 0 64 64">{K}</svg><span>KATALYST</span></div>
<h1>Intent in.<br><span>Settlement out.</span></h1>
<div class="chip"><span class="dot"></span>Live demo on the Portaldot V3 testnet</div></div></body>'''
outro = BASE + f'''<body><div class="grid"></div><div class="glow"></div><div class="glow2"></div><div class="c">
<div class="brand"><svg width="76" height="76" viewBox="0 0 64 64">{K}</svg><span>KATALYST</span></div>
<p style="font-size:34px;color:#f3f6f8;margin-top:30px">GenLayer decides.&nbsp; Portaldot settles.&nbsp; <span style="color:#c4ff42">Anyone can verify.</span></p>
<div class="row"><div class="box"><b>TRY IT</b><span class="mono">katalyst-intent.vercel.app</span></div><div class="box"><b>SOURCE (MIT)</b><span class="mono">github.com/s70239176-ctrl/katalyst</span></div></div>
<p style="font-size:20px;margin-top:34px">Next: security audit &nbsp;·&nbsp; relayer quorum &nbsp;·&nbsp; real pool strategies &nbsp;·&nbsp; mainnet</p>
<p style="font-size:15px;color:#65798b;margin-top:14px">Testnet software, unaudited.</p></div></body>'''
(W / 'intro.html').write_text(intro, encoding='utf8')
(W / 'outro.html').write_text(outro, encoding='utf8')
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True)
    pg = b.new_page(viewport={'width': 1280, 'height': 720})
    for n in ('intro', 'outro'):
        pg.goto((W / f'{n}.html').as_uri())
        pg.wait_for_timeout(2500)
        pg.screenshot(path=str(W / f'{n}.png'))
    b.close()

# ------------------------------------------------------------------ voice-over lengths
def wav_len(path):
    w = wave.open(str(path)); return w.getnframes() / w.getframerate()

GAP = 0.32
scene_vo = {}
for sc in script['scenes']:
    lens = [wav_len(W / 'vo' / f"{sc['id']}_{i:02d}.wav") for i in range(len(sc['lines']))]
    scene_vo[sc['id']] = lens

def vo_total(sid): return sum(scene_vo[sid]) + GAP * (len(scene_vo[sid]) - 1)

# ------------------------------------------------------------------ scene plan
mv, tv, ev = main['video'], tail['video'], exp['video']
L = exp['loaded_at']
SCENES = [
    dict(id='intro', card='intro.png', note=None),
    dict(id='landing', src=mv, segs=[(main['landing_start'] + OFF, main['landing_end'] + OFF, 1.1)], note='LIVE DATA  |  read from the vault on Portaldot V3 testnet'),
    dict(id='compose', src=mv, segs=[(main['compose_start'] + OFF, main['compose_end'] + OFF, 1.45)], note='FREE PREVIEW  |  nothing is deposited yet'),
    dict(id='deposit', src=mv, segs=[(59.0 + OFF, main['deposit_confirmed'] + 4.0 + OFF, 1.6)], note='REAL TRANSACTION  |  signed and sent to Portaldot V3 testnet'),
    dict(id='lifecycle', src=mv, segs=[(main['lifecycle_start'] + OFF, main['consensus_seen'] + OFF, 4.0), (main['consensus_seen'] + OFF, main['settled_seen'] + OFF, 6.0), (main['settled_seen'] + OFF, main['lifecycle_end'] + OFF, 1.0)], note='TIMELAPSE x4 to x6  |  live GenLayer consensus, then the safety delay'),
    dict(id='explorer', src=ev, segs=[(L - 1.0, L + 15.0, 1.25)], note='PORTALDOT V3 TEST  |  block 138,228  |  revive.ethTransact to the vault'),
    dict(id='verify', src=tv, segs=[(tail['verify_start'] + OFF, tail['verify_end'] + OFF, 1.12)], note='INDEPENDENT VERIFICATION  |  12 of 12 checks pass'),
    dict(id='veto', src=tv, segs=[(tail['veto_start'] + OFF, tail['veto_end'] + OFF, 1.0)], note='TESTNET FAILURE CASE  |  rogue proposal vetoed, full refund'),
    dict(id='network', src=tv, segs=[(tail['network_start'] + OFF, tail['network_end'] + OFF, 1.0)], note='FIXED AT DEPLOYMENT  |  nobody can change these rules'),
    dict(id='outro', card='outro.png', note=None),
]

FONT = 'C\\:/Windows/Fonts/arialbd.ttf'
def run(args):
    r = subprocess.run([FF, '-y', '-hide_banner', '-loglevel', 'error'] + args, capture_output=True, text=True)
    if r.returncode:
        print(r.stderr[-1500:]); raise SystemExit(1)

timeline = []   # (scene id, start, duration)
t = 0.0
for sc in SCENES:
    sid = sc['id']
    vo = vo_total(sid)
    lead = 0.35
    if 'segs' in sc:
        foot = sum((b - a) / s for a, b, s in sc['segs'])
        dur = max(vo + lead + 0.8, foot)
    elif sid == 'intro':
        dur = vo + lead + 1.0
    else:
        dur = vo + lead + 1.6
    out = CLIPS / f'{sid}.mp4'
    fade = f'fade=t=in:st=0:d=0.3,fade=t=out:st={dur - 0.35:.2f}:d=0.35'
    note = ''
    if sc['note']:
        txt = sc['note'].replace(':', '\\:').replace("'", '')
        note = f",drawtext=fontfile='{FONT}':text='{txt}':fontcolor=white:fontsize=17:box=1:boxcolor=0x05090c@0.78:boxborderw=11:x=w-text_w-26:y=60:enable='between(t,0.6,{dur - 0.6:.2f})'"
    if 'card' in sc:
        zoom = "zoompan=z='1+0.0006*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1280x720:fps=30"
        run(['-loop', '1', '-framerate', '30', '-t', f'{dur:.2f}', '-i', str(W / sc['card']), '-vf', f'{zoom},{fade},format=yuv420p', '-t', f'{dur:.2f}', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-r', '30', str(out)])
    else:
        parts, labels = [], []
        for k, (a, b, s) in enumerate(sc['segs']):
            parts.append(f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/{s},fps=30,scale=1280:720:flags=lanczos,setsar=1[s{k}]")
            labels.append(f'[s{k}]')
        pad = max(0.0, dur - foot)
        cat = ''.join(labels) + f"concat=n={len(labels)}:v=1:a=0,tpad=stop_mode=clone:stop_duration={pad + 0.2:.2f},trim=duration={dur:.2f}{note},{fade},format=yuv420p[v]"
        run(['-i', sc['src'], '-filter_complex', ';'.join(parts) + ';' + cat, '-map', '[v]', '-t', f'{dur:.2f}', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-r', '30', str(out)])
    timeline.append((sid, t, dur, lead))
    print(f'{sid:10s} start {t:6.1f}  dur {dur:5.1f}  (vo {vo:4.1f})', flush=True)
    t += dur
TOTAL = t
print('TOTAL', round(TOTAL, 1), flush=True)
if TOTAL > 178:
    print('TOO LONG'); raise SystemExit(2)

# ------------------------------------------------------------------ concat video
(W / 'concat.txt').write_text(''.join(f"file '{(CLIPS / (s + '.mp4')).as_posix()}'\n" for s, *_ in timeline), encoding='utf8')
run(['-f', 'concat', '-safe', '0', '-i', str(W / 'concat.txt'), '-c', 'copy', str(W / 'video_nosub.mp4')])

# ------------------------------------------------------------------ voice track + captions
SR = 44100
vo_track = np.zeros(int((TOTAL + 2) * SR), dtype=np.float32)
srt, idx = [], 1
def ts(x):
    h, rem = divmod(x, 3600); m, s = divmod(rem, 60)
    return f'{int(h):02d}:{int(m):02d}:{int(s):02d},{int((s % 1) * 1000):03d}'
for sc in script['scenes']:
    sid = sc['id']
    start = next(a for s, a, d, ld in timeline if s == sid) + next(ld for s, a, d, ld in timeline if s == sid)
    cur = start
    for i, line in enumerate(sc['lines']):
        w = wave.open(str(W / 'vo' / f'{sid}_{i:02d}.wav'))
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        s0 = int(cur * SR)
        vo_track[s0:s0 + len(data)] += data
        dur = len(data) / SR
        wrapped = '\n'.join(textwrap.wrap(line, 62))
        srt.append(f'{idx}\n{ts(cur)} --> {ts(cur + dur + 0.1)}\n{wrapped}\n')
        idx += 1
        cur += dur + GAP
(W / 'captions.srt').write_text('\n'.join(srt), encoding='utf8')
import scipy.io.wavfile as wf
wf.write(str(W / 'vo_full.wav'), SR, (np.clip(vo_track, -1, 1) * 32767).astype(np.int16))

# ------------------------------------------------------------------ final mix + captions
style = "Fontname=Arial,Fontsize=15,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&HB0000000,BorderStyle=3,Outline=1,Shadow=0,MarginV=24,Alignment=2"
final = OUT / 'katalyst-demo.mp4'
fc = (
    "[2:a]atrim=0:%.2f,asetpts=PTS-STARTPTS,volume=0.62,afade=t=out:st=%.2f:d=3[mus];"
    "[1:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=1.6,asplit=2[vo1][vo2];"
    "[mus][vo1]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=450[duck];"
    "[duck][vo2]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11[a]"
) % (TOTAL + 0.5, TOTAL - 3.0)
subprocess.run(['cmd', '/c', 'echo'], capture_output=True)
shutil.copy(W / 'captions.srt', W / 'c.srt')
os.chdir(W)
run(['-i', 'video_nosub.mp4', '-i', 'vo_full.wav', '-i', 'music.wav',
     '-filter_complex', "[0:v]subtitles=c.srt:force_style='" + style + "'[v];" + fc,
     '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', f'{TOTAL:.2f}', str(final)])
shutil.copy(W / 'captions.srt', OUT / 'katalyst-demo.srt')
print('DONE', final, round(final.stat().st_size / 1e6, 1), 'MB')
