# End-to-end check on a Windows runner: the real app with the computer-sound lane.
# A tone plays from another process; with the lane on, the user must still hear it (processed by HoloVoice),
# the original must be turned down, and turning the lane off/on again must keep working.
import json, math, os, struct, subprocess, sys, time, wave

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
EXE = os.path.join(ROOT, 'native', 'win-sysaudio', 'holo-sysaudio.exe')
CDP = os.path.join(ROOT, 'native', 'win-sysaudio', 'cdp.mjs')
TONE = os.path.abspath('tone.wav')
fails = []

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' - ' + str(detail) if detail != '' else ''), flush=True)
    if not ok: fails.append(name)

with wave.open(TONE, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
    w.writeframes(b''.join(struct.pack('<hh', v, v) for v in (int(12000 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(48000 * 2))))

def probe(ms=1000):
    out = subprocess.run([EXE, '--probe-endpoint', str(ms)], capture_output=True, text=True, timeout=30)
    try: return float(out.stdout.strip())
    except ValueError: print('probe error:', out.stderr); return -1.0

def ev(expr):
    out = subprocess.run(['node', CDP, '9333', 'engine', expr], capture_output=True, text=True, timeout=30)
    try: return json.loads(out.stdout.strip() or 'null')
    except ValueError: print('cdp:', out.stdout, out.stderr); return None

STATUS = '''(() => { const l = __hv.lanes.sys, a = new Float32Array(1024); l.anIn.getFloatTimeDomainData(a);
  let s = 0; for (const x of a) s += x * x;
  return { on: __hv.S.lanes.sys.enabled, feed: !!l.feed, ctx: l.ctx.state, inRms: Math.sqrt(s / a.length), hint: __hv.sysHint } })()'''

tone = subprocess.Popen([sys.executable, '-c',
    'import winsound,time;winsound.PlaySound(r"%s",winsound.SND_FILENAME|winsound.SND_LOOP|winsound.SND_ASYNC);time.sleep(300)' % TONE])
app = subprocess.Popen(['npx', 'electron', '.', '--remote-debugging-port=9333'], cwd=ROOT, shell=True,
                       stdout=open('app.log', 'w'), stderr=subprocess.STDOUT)
for _ in range(60):
    time.sleep(1)
    if ev('typeof __hv') == 'object': break
time.sleep(3)
base = probe(); check('tone audible, app running, lane off', base > 0.02, '%.4f' % base)

for cycle in (1, 2, 3):
    ev("__hv.handle({ type: 'effect', lane: 'sys', effect: 'clean' })")
    ev("__hv.handle({ type: 'toggle', lane: 'sys', on: true })")
    time.sleep(4)
    st = ev(STATUS) or {}
    heard = probe()
    check('cycle %d: lane on with the helper feed' % cycle, st.get('on') and st.get('feed') and st.get('ctx') == 'running', st)
    check('cycle %d: captured tone reaches the effect chain' % cycle, (st.get('inRms') or 0) > 0.02, st.get('inRms'))
    check('cycle %d: user hears the processed sound' % cycle, heard > 0.02, '%.4f (original %.4f)' % (heard, base))
    ev("__hv.handle({ type: 'effect', lane: 'sys', effect: 'demon' })")
    time.sleep(3)
    fx = probe()
    check('cycle %d: still audible with an effect' % cycle, fx > 0.005, '%.4f' % fx)
    ev("__hv.handle({ type: 'toggle', lane: 'sys', on: false })")
    time.sleep(4)
    off = probe()
    check('cycle %d: original back after turning off' % cycle, abs(off - base) < base * 0.15, '%.4f' % off)

subprocess.run(['taskkill', '/F', '/T', '/PID', str(app.pid)], capture_output=True)
tone.kill()
time.sleep(1)
print(open('app.log', errors='replace').read()[-3000:])
sys.exit(1 if fails else 0)
