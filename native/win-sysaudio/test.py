# CI check of holo-sysaudio on a Windows runner with a virtual sound card.
# Plays a tone from a separate process and verifies that:
#   1. the helper captures the tone at its original level and quality while the user doesn't hear the original,
#   2. the original comes back after the helper stops (and after "--restore" if it was killed),
#   3. the excluded process tree is not captured,
#   4. an app changing its own volume during capture stays inaudible and is followed.
import math, struct, subprocess, sys, threading, time, wave, os

EXE = sys.argv[1]
TONE = os.path.abspath('tone.wav')
fails = []

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' - ' + detail if detail else ''), flush=True)
    if not ok: fails.append(name)

with wave.open(TONE, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
    w.writeframes(b''.join(struct.pack('<hh', v, v) for v in (int(12000 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(48000 * 2))))

def player():
    return subprocess.Popen([sys.executable, '-c',
        'import winsound,time;winsound.PlaySound(r"%s",winsound.SND_FILENAME|winsound.SND_LOOP|winsound.SND_ASYNC);time.sleep(120)' % TONE])

def probe(ms=800):
    out = subprocess.run([EXE, '--probe-endpoint', str(ms)], capture_output=True, text=True, timeout=30)
    parts = out.stdout.split()
    if len(parts) > 1: print('  probe', out.stdout.strip(), '(rms, near-silent 10 ms blocks)', flush=True)
    try: return float(parts[0])
    except ValueError: print('probe error:', out.stderr); return -1.0

def set_volume(pid, v):
    from pycaw.pycaw import AudioUtilities
    for s in AudioUtilities.GetAllSessions():
        if s.Process and s.Process.pid == pid: s.SimpleAudioVolume.SetMasterVolume(v, None)

def snr(samples, rate=48000, f=440.0):
    # least-squares fit of a sinusoid at f (+ DC) on the left channel; residual = noise
    x = samples[0::2][:rate]
    n = len(x)
    if n < 1000: return 0.0
    c = [math.cos(2 * math.pi * f * i / rate) for i in range(n)]
    s = [math.sin(2 * math.pi * f * i / rate) for i in range(n)]
    a = 2 * sum(xi * ci for xi, ci in zip(x, c)) / n
    b = 2 * sum(xi * si for xi, si in zip(x, s)) / n
    m = sum(x) / n
    res = [xi - a * ci - b * si - m for xi, ci, si in zip(x, c, s)]
    p_sig = (a * a + b * b) / 2
    p_res = sum(r * r for r in res) / n
    return 10 * math.log10(p_sig / max(p_res, 1e-20))

class Helper:
    def __init__(self, *args):
        self.p = subprocess.Popen([EXE, *map(str, args)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.data = bytearray(); self.err = []
        threading.Thread(target=self._out, daemon=True).start()
        threading.Thread(target=self._err, daemon=True).start()
    def _out(self):
        while True:
            b = self.p.stdout.read(4096)
            if not b: break
            self.data += b
    def _err(self):
        for line in self.p.stderr: self.err.append(line.decode(errors='replace').strip())
    def samples(self, since=0):
        since -= since % 8
        n = (len(self.data) - since) // 4
        return struct.unpack_from('<%df' % n, self.data, since) if n > 0 else ()
    def rms(self, since=0):
        v = self.samples(since)
        return math.sqrt(sum(x * x for x in v) / len(v)) if v else 0.0
    def stop(self):
        self.p.stdin.close(); self.p.wait(10); time.sleep(0.3)

dummy = subprocess.Popen(['ping', '-n', '120', '127.0.0.1'], stdout=subprocess.DEVNULL)
tone = player(); time.sleep(1.5)
base = probe(); check('tone audible before capture', base > 0.02, '%.4f' % base)

h = Helper(dummy.pid, '--no-mute'); time.sleep(1.0)
mark = len(h.data); time.sleep(1.5)
plain = h.rms(mark); h.stop()
check('captures without attenuation', plain > 0.02, 'rms %.4f' % plain)

h = Helper(dummy.pid); time.sleep(1.5)
mark = len(h.data); time.sleep(1.5)
cap = h.rms(mark); q = snr(h.samples(mark)); heard = probe()
check('captures the tone at its level', abs(20 * math.log10(max(cap, 1e-9) / max(plain, 1e-9))) < 1.0, 'rms %.4f vs %.4f' % (cap, plain))
check('captured quality', q > 50, 'SNR %.1f dB' % q)
check('original inaudible while capturing', 0 <= heard < 0.0005, '%.6f' % heard)
try:
    set_volume(tone.pid, 0.5); time.sleep(0.6)
    mark = len(h.data); time.sleep(1.0)
    half = h.rms(mark); heard2 = probe()
    check('app volume change followed', abs(20 * math.log10(max(half, 1e-9) / max(plain * 0.5, 1e-9))) < 1.5, 'rms %.4f' % half)
    check('still inaudible after app volume change', 0 <= heard2 < 0.0005, '%.6f' % heard2)
except Exception as e:
    check('pycaw volume change', False, repr(e))
h.stop()
print('helper log:', h.err, flush=True)
after = probe()
check('helper exits on stdin close', h.p.returncode == 0, str(h.p.returncode))
check('original back after stop (at the new 0.5 volume)', abs(after - base * 0.5) < base * 0.1, '%.4f' % after)
try: set_volume(tone.pid, 1.0)
except Exception: pass
time.sleep(0.3)

h = Helper(tone.pid, '--no-mute'); time.sleep(1.0)
mark = len(h.data); time.sleep(1.5)
excl = h.rms(mark); h.stop()
check('excluded process tree not captured', excl < 0.002, 'rms %.4f, %d bytes' % (excl, len(h.data)))

h = Helper(dummy.pid); time.sleep(1.5)
h.p.kill(); h.p.wait(); time.sleep(0.3)
stuck = probe()
check('killed helper leaves it quiet (expected)', stuck < 0.002, '%.4f' % stuck)
r = subprocess.run([EXE, '--restore'], timeout=20, capture_output=True, text=True); print(r.stderr.strip())
rest = probe()
check('--restore brings it back', abs(rest - base) < base * 0.1, '%.4f' % rest)

tone.kill(); dummy.kill()
sys.exit(1 if fails else 0)
