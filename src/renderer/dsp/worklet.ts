// AudioWorklet "holo-voice": pitch, timbre, robot, whisper, noise reduction, vibrato (phase vocoder, pv.ts)
// + growl (rattle, rasp, undertone) + degradation (bits, sample rate). Tracks voice pitch (pitch.ts): steering to a
// target pitch (any speaker's voice to ~110 Hz male, ~210 female…), timbre following the shift, autotune, monotone (robot).
// Every 200 ms posts { f0, avg } to the port; the panel shows "your voice ≈ … Hz".
// Pitch and timbre come from either the vocoder or PSOLA (psola.ts, psola parameter): PSOLA sounds more natural for
// voice changing (male/female/child); the vocoder is needed for whisper, noise reduction and the buzzing robot.
// In the neutral position (everything at zero) it passes the input through with the same latency as the vocoder;
// the crossfade between them is smooth (~30 ms), so effect ramps don't click and latency doesn't jump.
import { PitchTracker } from './pitch'
import { PhaseVocoder } from './pv'
import { Psola } from './psola'

declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  constructor(options?: unknown)
  readonly port: MessagePort
}

const PARAMS = ['pitch', 'formant', 'robot', 'whisper', 'crush', 'decimate', 'denoise', 'vibrato', 'vibratoHz',
  'autoTarget', 'targetHz', 'formantFollow', 'tune', 'mono', 'monoHz', 'psola', 'growl', 'sub'] as const

/** Growl ("false-chord" / death-metal texture), applied to the shifted voice. Two independent amounts:
 *  - growl: a rattle — jittery amplitude modulation at ~35–75 Hz like loosely flapping false vocal folds — plus raspy
 *    noise that follows the voice envelope and pulses with the rattle (silent in pauses);
 *  - sub: an undertone an octave below the voice — every other period is louder (period doubling) and an
 *    octave-divided copy of the fundamental is mixed in (flip-flop divider, like an analog octaver).
 *  All amounts are smoothed per sample, so presets crossfade without clicks; nothing allocates. */
class Growl {
  private g = 0 // smoothed amounts
  private s = 0
  private seed = 0x2545f491
  // rattle oscillator: phase, current rate and depth (re-drawn every cycle)
  private rPh = 0
  private rInc = 0
  private rAmp = 1
  // octave divider: low-passed voice, its envelope, Schmitt trigger, ±1 flip-flop (smoothed)
  private l1 = 0
  private l2 = 0
  private lEnv = 0
  private armed = false
  private flip = 1
  private sq = 0
  private sl = 0 // sub layer low-pass
  // raspy noise: band-limited white noise, voice envelope
  private n1 = 0
  private n2 = 0
  private n3 = 0
  private vEnv = 0
  private lpA = 0.98
  private readonly smooth: number
  private readonly envDecay: number
  private readonly sqA: number
  private readonly subA: number
  private readonly nHp: number
  private readonly nLp: number
  private readonly vAtt: number
  private readonly vRel: number

  constructor(private readonly sr: number) {
    this.smooth = Math.exp(-1 / (0.03 * sr))
    this.envDecay = Math.exp(-1 / (0.02 * sr))
    this.sqA = Math.exp(-1 / (0.0012 * sr))
    this.subA = Math.exp((-2 * Math.PI * 160) / sr)
    this.nHp = Math.exp((-2 * Math.PI * 700) / sr)
    this.nLp = Math.exp((-2 * Math.PI * 3500) / sr)
    this.vAtt = Math.exp(-1 / (0.003 * sr))
    this.vRel = Math.exp(-1 / (0.03 * sr))
    this.rInc = (2 * Math.PI * 50) / sr
  }

  private rnd(): number { // xorshift32, 0..1
    let x = this.seed
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    this.seed = x
    return (x >>> 0) / 4294967296
  }

  get busy(): boolean { return this.g > 1e-4 || this.s > 1e-4 }

  /** f is the current (shifted) voice pitch, 0 if unknown: the divider's low-pass sits just above it */
  process(y: Float32Array, growl: number, sub: number, f: number): void {
    if (f > 0) this.lpA = Math.exp((-2 * Math.PI * Math.max(45, Math.min(320, f * 1.25))) / this.sr)
    const a = this.smooth, lpA = this.lpA
    for (let i = 0; i < y.length; i++) {
      this.g = growl + (this.g - growl) * a
      this.s = sub + (this.s - sub) * a
      const g = this.g, s = this.s
      const v = y[i]
      // voice envelope (fast attack, slower release)
      const av = Math.abs(v)
      this.vEnv = av + (this.vEnv - av) * (av > this.vEnv ? this.vAtt : this.vRel)
      // rattle: a sine whose rate (35–75 Hz) and depth are re-drawn every cycle: irregular, like flapping tissue
      this.rPh += this.rInc
      if (this.rPh >= 2 * Math.PI) {
        this.rPh -= 2 * Math.PI
        this.rInc = (2 * Math.PI * (35 + 40 * this.rnd())) / this.sr
        this.rAmp = 0.45 + 0.55 * this.rnd()
      }
      const rattle = this.rAmp * Math.sin(this.rPh)
      // octave divider: toggle on each period of the low-passed voice (Schmitt trigger at ±30% of its envelope)
      this.l1 = v + (this.l1 - v) * lpA
      this.l2 = this.l1 + (this.l2 - this.l1) * lpA
      const l = this.l2, al = Math.abs(l)
      this.lEnv = al > this.lEnv ? al : this.lEnv * this.envDecay
      const th = 0.3 * this.lEnv
      if (!this.armed) { if (l < -th) this.armed = true }
      else if (l > th) { this.armed = false; this.flip = -this.flip }
      this.sq = this.flip + (this.sq - this.flip) * this.sqA
      // octave-down copy of the fundamental, smoothed
      const lo = l * this.sq
      this.sl = lo + (this.sl - lo) * this.subA
      // amplitude: period doubling (sub) and rattle (growl); never below zero
      let m = 1 + 0.55 * s * this.sq + 0.75 * g * rattle
      if (m < 0) m = 0
      // raspy noise: band-limited white noise shaped by the voice envelope, pulsing with the rattle
      const w = this.rnd() * 2 - 1
      this.n1 = w + (this.n1 - w) * this.nHp
      const hp = w - this.n1
      this.n2 = hp + (this.n2 - hp) * this.nLp
      this.n3 = this.n2 + (this.n3 - this.n2) * this.nLp // 0.7–3.5 kHz: raspy, not fizzy
      const rasp = this.n3 * this.vEnv * (0.6 + 0.4 * rattle)
      y[i] = v * m + 2.2 * s * this.sl + 2.4 * g * rasp
    }
  }
}

class Channel {
  pv: PhaseVocoder
  ps: Psola
  psBuf = new Float32Array(128)
  psMix = 0 // 0 = vocoder/dry, 1 = PSOLA
  delay: Float32Array // dry signal delayed by the vocoder latency
  di = 0
  pvBuf = new Float32Array(128)
  mix = 0 // 0 = dry, 1 = vocoder
  hold = 0
  held = 0
  growl = new Growl(sampleRate)
  constructor(n: number) {
    this.pv = new PhaseVocoder(n, 8, sampleRate)
    this.delay = new Float32Array(this.pv.latency)
    // PSOLA looks ahead one and a half periods: at least ~29 ms so low voices (down to ~75 Hz) aren't clipped
    this.ps = new Psola(sampleRate, Math.max(this.pv.latency, Math.round(sampleRate * 0.029)))
  }
}

class HoloVoice extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitch', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'formant', defaultValue: 0, minValue: -12, maxValue: 12, automationRate: 'k-rate' },
      { name: 'robot', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'whisper', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'crush', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'decimate', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'denoise', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'vibrato', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'vibratoHz', defaultValue: 5, minValue: 0.5, maxValue: 12, automationRate: 'k-rate' },
      { name: 'autoTarget', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'targetHz', defaultValue: 150, minValue: 50, maxValue: 500, automationRate: 'k-rate' },
      { name: 'formantFollow', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'tune', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mono', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'monoHz', defaultValue: 110, minValue: 50, maxValue: 500, automationRate: 'k-rate' },
      { name: 'psola', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'growl', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'sub', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  private n: number
  private ch: Channel[] = []
  private tracker = new PitchTracker(sampleRate)
  private corr = 0 // autotune/monotone correction, semitones (smoothed; held during pauses)
  private report = 0
  private vibPhase = 0
  private readonly smooth = Math.exp(-1 / (0.03 * sampleRate))

  constructor(options: { processorOptions?: { fftSize?: number } }) {
    super(options)
    this.n = options.processorOptions?.fftSize ?? 2048
    this.warmup()
  }

  /** JIT warm-up: until the code is compiled, vocoder frames take several times longer, so the first seconds after
   *  start clicked. Run everything on ~1 s of noise before audio starts; the state is discarded afterwards. */
  private warmup(): void {
    const ch = new Channel(this.n)
    const tr = new PitchTracker(sampleRate)
    const x = new Float32Array(128), y = new Float32Array(128)
    let s = 1
    ch.pv.denoise = 0.3
    ch.pv.pitch = 1.2
    ch.ps.ratio = 1.3
    for (let b = 0; b < 400; b++) {
      for (let i = 0; i < 128; i++) { s = (s * 16807) % 2147483647; x[i] = 0.1 * Math.sin((b * 128 + i) * 0.03) + 0.02 * (s / 2147483647 - 0.5) }
      tr.push(x)
      ch.pv.process(x, y)
      ch.ps.process(x, y, b % 3 ? 220 : 0)
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<(typeof PARAMS)[number], Float32Array>): boolean {
    const input = inputs[0]
    const output = outputs[0]
    const pitch = params.pitch[0], formant = params.formant[0], robot = params.robot[0], whisper = params.whisper[0]
    const crush = params.crush[0], decimate = params.decimate[0]
    const denoise = params.denoise[0], vibrato = params.vibrato[0], vibratoHz = params.vibratoHz[0]
    const autoTarget = params.autoTarget[0], targetHz = params.targetHz[0], follow = params.formantFollow[0]
    const tune = params.tune[0], mono = params.mono[0], monoHz = params.monoHz[0], psola = params.psola[0]
    const growl = params.growl[0], sub = params.sub[0]

    // speaker pitch from the first channel
    const tr = this.tracker
    if (input[0]) tr.push(input[0])
    // shift: manual + toward the target pitch (based on average pitch, so intonation is kept)
    let semis = pitch
    if (autoTarget > 0.001 && tr.avg > 0) semis += autoTarget * 12 * Math.log2(targetHz / tr.avg)
    semis = Math.max(-24, Math.min(24, semis))
    // timbre follows the shift: in people, formants rise with the voice but less (~0.4 of the pitch shift)
    // (in real voices formants are higher by about 0.27 of the pitch difference: male → female ≈ +18%)
    const fmt = Math.max(-12, Math.min(12, formant + follow * 0.27 * (semis - pitch)))
    // autotune and monotone use the current pitch after shifting
    if ((tune > 0.001 || mono > 0.001) && tr.f0 > 0) {
      const f1 = tr.f0 * 2 ** (semis / 12)
      const note = 12 * Math.log2(f1 / 440)
      let want = tune * (Math.round(note) - note)
      const f2 = f1 * 2 ** (want / 12)
      if (mono > 0.001) want += mono * 12 * Math.log2(monoHz / f2)
      const k = 1 - Math.exp(-128 / (0.012 * sampleRate)) // ~12 ms: fast correction without clicks
      this.corr += (want - this.corr) * k
    } else if (tune <= 0.001 && mono <= 0.001) this.corr = 0
    semis = Math.max(-24, Math.min(24, semis + this.corr))
    this.vibPhase = (this.vibPhase + (2 * Math.PI * params.vibratoHz[0] * 128) / sampleRate) % (2 * Math.PI)
    if ((this.report += 128) >= sampleRate * 0.2) {
      this.report = 0
      this.port.postMessage({ f0: tr.f0, avg: tr.avg })
    }

    const active = Math.abs(semis) > 0.01 || Math.abs(fmt) > 0.01 || robot > 0.001 || whisper > 0.001 ||
      denoise > 0.001 || vibrato > 0.001
    const levels = crush > 0.001 ? 2 ** (15 - crush * 12) : 0 // 16 bits → 4 bits
    const holdN = 1 + Math.round(decimate * 15) // down to 1/16 of the sample rate
    for (let c = 0; c < output.length; c++) {
      const x = input[c] ?? input[0]
      const y = output[c]
      if (!x) { y.fill(0); continue }
      const st = (this.ch[c] ??= new Channel(this.n))
      const pv = st.pv
      pv.pitch = 2 ** (semis / 12)
      pv.formant = 2 ** (fmt / 12)
      pv.robot = robot
      pv.whisper = whisper
      pv.denoise = denoise
      pv.vibrato = vibrato * 0.8 // up to 0.8 semitone
      pv.vibratoHz = vibratoHz
      // the vocoder computes only when needed (or still audible in a crossfade); otherwise idle
      pv.idle = !active && st.mix < 0.001
      pv.process(x, st.pvBuf)
      if (psola > 0.001 || st.psMix > 0.001) {
        st.ps.ratio = 2 ** ((semis + vibrato * 0.8 * Math.sin(this.vibPhase)) / 12)
        st.ps.formant = 2 ** (fmt / 12)
        st.ps.process(x, st.psBuf, tr.f0)
      }
      const target = active ? 1 : 0
      const a = this.smooth
      for (let i = 0; i < x.length; i++) {
        const dry = st.delay[st.di]
        st.delay[st.di] = x[i]
        st.di = (st.di + 1) % st.delay.length
        st.mix = target + (st.mix - target) * a
        let v = dry + (st.pvBuf[i] - dry) * st.mix
        st.psMix = psola + (st.psMix - psola) * a
        if (st.psMix > 0.0005) v += (st.psBuf[i] - v) * st.psMix
        y[i] = v
      }
      if (growl > 0.001 || sub > 0.001 || st.growl.busy) {
        st.growl.process(y, growl, sub, tr.f0 > 0 ? tr.f0 * 2 ** (semis / 12) : 0)
      }
      if (holdN > 1 || levels) {
        for (let i = 0; i < y.length; i++) {
          let v = y[i]
          if (holdN > 1) {
            if (st.hold-- <= 0) { st.held = v; st.hold = holdN - 1 }
            v = st.held
          }
          if (levels) v = Math.round(v * levels) / levels
          y[i] = v
        }
      }
    }
    return true
  }
}

registerProcessor('holo-voice', HoloVoice)

// "holo-tap": input recording for "Test on a recording": on { start: seconds } it collects samples (mono) and returns
// them as one Float32Array when full or when { stop: true } arrives
class HoloTap extends AudioWorkletProcessor {
  private buf: Float32Array | null = null
  private n = 0
  constructor(options?: unknown) {
    super(options)
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data?.start) { this.buf = new Float32Array(Math.round(e.data.start * sampleRate)); this.n = 0 }
      if (e.data?.stop) this.flush()
    }
  }
  private flush(): void {
    if (!this.buf) return
    this.port.postMessage(this.buf.slice(0, this.n))
    this.buf = null
  }
  process(inputs: Float32Array[][]): boolean {
    const x = inputs[0]?.[0]
    if (this.buf && x) {
      const k = Math.min(x.length, this.buf.length - this.n)
      this.buf.set(x.subarray(0, k), this.n)
      this.n += k
      if (this.n >= this.buf.length) this.flush()
    }
    return true
  }
}

registerProcessor('holo-tap', HoloTap)

// "holo-feed": plays interleaved stereo float32 chunks posted to its port (Windows computer sound from
// holo-sysaudio). A small jitter buffer: starts after ~40 ms, re-primes after an underrun, and drops the
// excess if the helper's clock runs ahead.
class HoloFeed extends AudioWorkletProcessor {
  private ring = new Float32Array(2 * 48000)
  private r = 0
  private w = 0
  private primed = false
  private readonly start = Math.round(0.04 * sampleRate)
  private readonly max = Math.round(0.15 * sampleRate)
  constructor(options?: unknown) {
    super(options)
    this.port.onmessage = (e: MessageEvent) => this.push(new Float32Array(e.data as ArrayBuffer))
  }
  private get frames(): number { return (this.w - this.r + this.ring.length) % this.ring.length / 2 }
  private push(x: Float32Array): void {
    const N = this.ring.length
    for (let i = 0; i < x.length; i++) { this.ring[this.w] = x[i]; this.w = (this.w + 1) % N }
    if (this.frames > this.max) this.r = (this.w - 2 * this.start + N) % N
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [L, R] = outputs[0]
    const n = L.length
    if (!this.primed) { if (this.frames < this.start) return true; this.primed = true }
    if (this.frames < n) { this.primed = false; return true }
    const N = this.ring.length
    for (let i = 0; i < n; i++) {
      L[i] = this.ring[this.r]
      R[i] = this.ring[this.r + 1]
      this.r = (this.r + 2) % N
    }
    return true
  }
}

registerProcessor('holo-feed', HoloFeed)
