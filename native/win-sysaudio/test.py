# CI check of holo-sysaudio on a Windows runner with a virtual sound card.
# Plays a tone from a separate process and verifies that:
#   1. the helper captures the tone while the tone app is muted (the user hears only the processed copy),
#   2. the original is muted during capture and unmuted afterwards,
#   3. the excluded process tree is not captured,
#   4. "--restore" undoes the mutes of a killed helper.
import math, struct, subprocess, sys, threading, time, wave, os

EXE = sys.argv[1]
TONE = os.path.abspath('tone.wav')
fails = []

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' — ' + detail if detail else ''), flush=True)
    if not ok: fails.append(name)

with wave.open(TONE, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
    w.writeframes(b''.join(struct.pack('<hh', v, v) for v in (int(12000 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(48000 * 2))))

def player():
    return subprocess.Popen([sys.executable, '-c',
        'import winsound,time;winsound.PlaySound(r"%s",winsound.SND_FILENAME|winsound.SND_LOOP|winsound.SND_ASYNC);time.sleep(120)' % TONE])

def probe(ms=800):
    out = subprocess.run([EXE, '--probe-endpoint', str(ms)], capture_output=True, text=True, timeout=30)
    try: return float(out.stdout.strip())
    except ValueError: print('probe error:', out.stderr); return -1.0

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
    def rms(self, since=0):
        n = (len(self.data) - since) // 4
        if n <= 0: return 0.0
        v = struct.unpack_from('<%df' % n, self.data, since)
        return math.sqrt(sum(x * x for x in v) / n)
    def stop(self):
        self.p.stdin.close(); self.p.wait(10); time.sleep(0.3)

dummy = subprocess.Popen(['ping', '-n', '120', '127.0.0.1'], stdout=subprocess.DEVNULL)
tone = player(); time.sleep(1.5)
base = probe(); check('tone audible before capture', base > 0.02, '%.4f' % base)

h = Helper(dummy.pid); time.sleep(1.5)
mark = len(h.data); time.sleep(1.5)
cap = h.rms(mark); heard = probe()
print('helper log:', h.err, flush=True)
check('helper captures the tone', cap > 0.02, 'rms %.4f, %d bytes' % (cap, len(h.data)))
check('original muted while capturing', 0 <= heard < 0.002, '%.4f' % heard)
h.stop()
after = probe()
check('helper exits on stdin close', h.p.returncode == 0, str(h.p.returncode))
check('original unmuted after stop', after > 0.02, '%.4f' % after)

h = Helper(tone.pid, '--no-mute'); time.sleep(1.5)
mark = len(h.data); time.sleep(1.5)
excl = h.rms(mark); h.stop()
check('excluded process tree not captured', excl < 0.002, 'rms %.4f, %d bytes' % (excl, len(h.data)))

h = Helper(dummy.pid); time.sleep(1.5)
h.p.kill(); h.p.wait(); time.sleep(0.3)
stuck = probe()
check('killed helper leaves mute (expected)', stuck < 0.002, '%.4f' % stuck)
subprocess.run([EXE, '--restore'], timeout=20)
rest = probe()
check('--restore unmutes', rest > 0.02, '%.4f' % rest)

tone.kill(); dummy.kill()
sys.exit(1 if fails else 0)
