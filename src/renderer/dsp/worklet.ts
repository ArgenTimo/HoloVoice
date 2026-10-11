// AudioWorklet "holo-voice": pitch, timbre, robot, whisper, noise reduction, vibrato (phase vocoder, pv.ts)
// + growl (rattle, rasp, undertone) + halo (choir, shimmer) + degradation (bits, sample rate). Tracks voice pitch
// (pitch.ts): steering to a target pitch (any speaker's voice to ~110 Hz male, ~210 female…), timbre following the
// shift, autotune, monotone (robot).
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
  'autoTarget', 'targetHz', 'formantFollow', 'tune', 'mono', 'monoHz', 'psola', 'growl', 'sub', 'fry', 'rasp', 'octave', 'halo', 'steps'] as const

/** Delay-line pitch shifter ("rotating tape heads"): two read taps sweep through a window of recent input and
 *  are crossfaded with complementary sin² windows. Cheap, works on any sound (chords too), slightly grainy — fine
 *  for layers mixed under the main voice. */
class Shifter {
  private buf: Float32Array
  private w = 0
  private ph = 0
  private readonly mask: number
  constructor(private readonly win: number, readonly ratio: number) {
    let n = 1
    while (n < win + 4) n <<= 1
    this.buf = new Float32Array(n)
    this.mask = n - 1
  }
  private tap(d: number): number {
    const r = this.w - 1 - d
    const i = Math.floor(r), f = r - i
    const a = this.buf[i & this.mask], b = this.buf[(i + 1) & this.mask]
    return a + (b - a) * f
  }
  next(x: number): number {
    this.buf[this.w & this.mask] = x
    this.w = (this.w + 1) & 0x3fffffff
    // the delay changes by (1 - ratio) per sample: shrinking delay = higher pitch
    this.ph -= (this.ratio - 1) / this.win
    this.ph -= Math.floor(this.ph)
    const p2 = this.ph + 0.5 >= 1 ? this.ph - 0.5 : this.ph + 0.5
    const g1 = Math.sin(Math.PI * this.ph), g2 = Math.sin(Math.PI * p2)
    return g1 * g1 * this.tap(this.ph * this.win) + g2 * g2 * this.tap(p2 * this.win)
  }
}

/** Growl ("false-chord" / death-metal texture), applied to the shifted voice. Independent amounts:
 *  - growl: a rattle — jittery amplitude modulation at ~35–75 Hz like loosely flapping false vocal folds — plus raspy
 *    noise that follows the voice envelope and pulses with the rattle (silent in pauses);
 *  - sub: an undertone an octave below the voice — every other period is louder (period doubling) and an
 *    octave-divided copy of the fundamental is mixed in (flip-flop divider, like an analog octaver);
 *  - fry: period-synchronous subharmonics, the way false vocal folds vibrate: the loudness of each glottal period
 *    follows a pattern (f0/2: loud-soft, f0/3: loud-soft-mid) that switches irregularly, with per-period jitter.
 *    Crisp and tonal — no noise added;
 *  - rasp: roughness that keeps the vowels: the voice is multiplied by low-band noise (< ~300 Hz), which smears every
 *    harmonic by less than the formant spacing — the vowel envelope stays, the clean tone turns hoarse;
 *  - octave: a parallel copy an octave lower (delay-line shifter), formants lowered with it — a second, bigger throat.
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
  // fry: period counter, current pattern (2 or 3 periods), smoothed per-period gain
  private f = 0
  private r = 0
  private o = 0
  private per = 0
  private mode = 2
  private fTarget = 1
  private fGain = 1
  private q1 = 0 // rasp: low-band noise
  private q2 = 0
  private readonly qA: number
  private readonly fA: number
  private readonly oct: Shifter
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
    this.qA = Math.exp((-2 * Math.PI * 280) / sr)
    this.fA = Math.exp(-1 / (0.0015 * sr))
    this.oct = new Shifter(Math.round(sr * 0.045), 0.5)
  }

  private rnd(): number { // xorshift32, 0..1
    let x = this.seed
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    this.seed = x
    return (x >>> 0) / 4294967296
  }

  get busy(): boolean { return this.g > 1e-4 || this.s > 1e-4 || this.f > 1e-4 || this.r > 1e-4 || this.o > 1e-4 }

  /** f is the current (shifted) voice pitch, 0 if unknown: the divider's low-pass sits just above it */
  process(y: Float32Array, growl: number, sub: number, fry: number, hoarse: number, octave: number, f: number): void {
    if (f > 0) this.lpA = Math.exp((-2 * Math.PI * Math.max(45, Math.min(320, f * 1.25))) / this.sr)
    const a = this.smooth, lpA = this.lpA
    for (let i = 0; i < y.length; i++) {
      this.g = growl + (this.g - growl) * a
      this.s = sub + (this.s - sub) * a
      this.f = fry + (this.f - fry) * a
      this.r = hoarse + (this.r - hoarse) * a
      this.o = octave + (this.o - octave) * a
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
      else if (l > th) {
        this.armed = false
        this.flip = -this.flip
        // a new period: next step of the fry pattern; now and then switch between f0/2 and f0/3
        if (++this.per >= this.mode) {
          this.per = 0
          if (this.rnd() < 0.12) this.mode = this.mode === 2 ? 3 : 2
        }
        const step = this.per === 0 ? 1 : this.per === 1 ? 0.2 : 0.55
        this.fTarget = step * (0.75 + 0.25 * this.rnd())
      }
      this.sq = this.flip + (this.sq - this.flip) * this.sqA
      this.fGain = this.fTarget + (this.fGain - this.fTarget) * this.fA
      // octave-down copy of the fundamental, smoothed
      const lo = l * this.sq
      this.sl = lo + (this.sl - lo) * this.subA
      // amplitude: period doubling (sub) and rattle (growl); never below zero
      let m = 1 + 0.55 * s * this.sq + 0.75 * g * rattle
      if (m < 0) m = 0
      m *= 1 - 0.85 * this.f * (1 - this.fGain) * Math.min(1, this.lEnv * 40)
      // raspy noise: band-limited white noise shaped by the voice envelope, pulsing with the rattle
      const w = this.rnd() * 2 - 1
      this.n1 = w + (this.n1 - w) * this.nHp
      const hp = w - this.n1
      this.n2 = hp + (this.n2 - hp) * this.nLp
      this.n3 = this.n2 + (this.n3 - this.n2) * this.nLp // 0.7–3.5 kHz: raspy, not fizzy
      const rasp = this.n3 * this.vEnv * (0.6 + 0.4 * rattle)
      // rasp: voice × low-band noise (normalized to ~unit level)
      const u = this.rnd() * 2 - 1
      this.q1 = u + (this.q1 - u) * this.qA
      this.q2 = this.q1 + (this.q2 - this.q1) * this.qA
      let q = 18 * this.q2
      q = q > 2 ? 2 : q < -2 ? -2 : q
      const vm = v * m
      y[i] = vm * (1 - 0.5 * this.r) + 2.2 * s * this.sl + 2.4 * g * rasp + this.r * q * vm +
        0.8 * this.o * this.oct.next(vm)
    }
  }
}

/** Halo (divine / angelic): a quiet choir around the voice — copies an octave up, an octave down and a fifth up —
 *  plus shimmer: a feedback delay with an octave-up shifter in the loop, so the tail keeps rising and glowing
 *  (high-cut in the loop, so it fades into a soft shine instead of fizz). The rig's reverb then smears it into a
 *  cathedral. The amount is smoothed per sample; nothing allocates. */
class Halo {
  private h = 0
  private readonly up: Shifter
  private readonly down: Shifter
  private readonly fifth: Shifter
  private readonly shim: Shifter
  private readonly fb: Float32Array
  private fw = 0
  private lp = 0
  private hp = 0
  private readonly smooth: number
  private readonly lpA: number
  private readonly hpA: number
  constructor(sr: number) {
    const win = Math.round(sr * 0.05)
    this.up = new Shifter(win, 2)
    this.down = new Shifter(Math.round(sr * 0.07), 0.5)
    this.fifth = new Shifter(win, 1.5)
    this.shim = new Shifter(Math.round(sr * 0.08), 2)
    this.fb = new Float32Array(Math.round(sr * 0.17))
    this.smooth = Math.exp(-1 / (0.03 * sr))
    this.lpA = Math.exp((-2 * Math.PI * 5500) / sr)
    this.hpA = Math.exp((-2 * Math.PI * 250) / sr)
  }
  get busy(): boolean { return this.h > 1e-4 }
  process(y: Float32Array, halo: number): void {
    const a = this.smooth, fb = this.fb, n = fb.length
    for (let i = 0; i < y.length; i++) {
      this.h = halo + (this.h - halo) * a
      const h = this.h, v = y[i]
      const choir = 0.42 * this.up.next(v) + 0.38 * this.down.next(v) + 0.22 * this.fifth.next(v)
      // shimmer loop: voice + 0.6 × the delayed loop output, shifted an octave up, low-passed, low end removed
      const back = fb[this.fw]
      let z = this.shim.next(0.5 * v + 0.6 * back)
      this.lp = z + (this.lp - z) * this.lpA
      this.hp = this.lp + (this.hp - this.lp) * this.hpA
      z = this.lp - this.hp
      fb[this.fw] = z
      this.fw = this.fw + 1 === n ? 0 : this.fw + 1
      y[i] = v + h * (choir + 0.9 * z)
    }
  }
}

/** Pitch levels for "steps", semitones around the flattened pitch (mostly small moves, sometimes a big jump) */
const STEP_LEVELS = [-3, -2, -1, 0, 1, 2, 3, 5]

class Channel {
  pv: PhaseVocoder
  ps: Psola
  psBuf = new Float32Array(128)
  psMix = 0 // 0 = vocoder/dry, 1 = PSOLA
  /** common latency of all three paths (dry, vocoder, PSOLA), so crossfades between them don't comb-filter */
  readonly latency: number
  delay: Float32Array // dry signal delayed by the common latency
  di = 0
  pvBuf = new Float32Array(128)
  // vocoder output delayed by (latency − vocoder latency): with a short FFT ("fast") PSOLA needs more lookahead
  pvDelay: Float32Array | null
  pdi = 0
  mix = 0 // 0 = dry, 1 = vocoder
  hold = 0
  held = 0
  growl = new Growl(sampleRate)
  halo = new Halo(sampleRate)
  constructor(n: number) {
    this.pv = new PhaseVocoder(n, 8, sampleRate)
    // PSOLA looks ahead one and a half periods: at least ~29 ms so low voices (down to ~75 Hz) aren't clipped
    this.latency = Math.max(this.pv.latency, Math.round(sampleRate * 0.029))
    this.delay = new Float32Array(this.latency)
    this.pvDelay = this.latency > this.pv.latency ? new Float32Array(this.latency - this.pv.latency) : null
    this.ps = new Psola(sampleRate, this.latency)
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
      { name: 'fry', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'rasp', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'octave', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'halo', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'steps', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  private n: number
  private ch: Channel[] = []
  private tracker = new PitchTracker(sampleRate)
  private corr = 0 // autotune/monotone correction, semitones (smoothed; held during pauses)
  private report = 0
  private vibPhase = 0
  // "steps" (old concatenative text-to-speech): the pitch holds a level for a syllable-sized segment, then jumps
  // to another one; each join gets a short loudness dip, like units glued together
  private stepSemis = 0
  private stepLeft = 0
  private stepVoiced = false
  private stepSeed = 0x6d2b79f5
  private dipWait = -1 // samples until the next dip starts (the voice comes out with the processing latency)
  private dipPos = -1 // position inside the current dip, -1 = none
  private readonly dipLen = Math.round(0.018 * sampleRate)
  private readonly dipGain = new Float32Array(128)
  private stepRnd(): number {
    let x = this.stepSeed
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    this.stepSeed = x
    return (x >>> 0) / 4294967296
  }
  private readonly smooth = Math.exp(-1 / (0.03 * sampleRate))

  constructor(options: { processorOptions?: { fftSize?: number } }) {
    super(options)
    this.n = options.processorOptions?.fftSize ?? 2048
    // channels are big (~0.7 MB of buffers): allocate them here, not on the audio thread inside process()
    this.ch.push(new Channel(this.n), new Channel(this.n))
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
    const growl = params.growl[0], sub = params.sub[0], halo = params.halo[0]
    const fry = params.fry[0], rasp = params.rasp[0], octave = params.octave[0], steps = params.steps[0]

    // speaker pitch from the first channel. YIN is the costliest part when nothing else runs: full rate only when a
    // parameter needs the pitch, otherwise a slow rate that still feeds the panel's "your voice ≈ … Hz"
    const tr = this.tracker
    const needF0 = autoTarget > 0.001 || tune > 0.001 || mono > 0.001 || steps > 0.001 || psola > 0.001 ||
      growl > 0.001 || sub > 0.001 || fry > 0.001 || rasp > 0.001 || octave > 0.001
    tr.every = needF0 ? 256 : 2048
    if (input[0]) tr.push(input[0])
    // shift: manual + toward the target pitch (based on average pitch, so intonation is kept)
    let semis = pitch
    if (autoTarget > 0.001 && tr.avg > 0) semis += autoTarget * 12 * Math.log2(targetHz / tr.avg)
    semis = Math.max(-24, Math.min(24, semis))
    // timbre follows the shift: in people, formants rise with the voice but less (~0.4 of the pitch shift)
    // (in real voices formants are higher by about 0.27 of the pitch difference: male → female ≈ +18%)
    const fmt = Math.max(-12, Math.min(12, formant + follow * 0.27 * (semis - pitch)))
    // steps: a new pitch level at each voiced onset or after 120–220 ms
    if (steps > 0.001) {
      const voiced = tr.f0 > 0
      this.stepLeft -= 128
      if (voiced && (!this.stepVoiced || this.stepLeft <= 0)) {
        const prev = this.stepSemis
        do this.stepSemis = STEP_LEVELS[Math.floor(this.stepRnd() * STEP_LEVELS.length)]
        while (this.stepSemis === prev)
        this.stepLeft = Math.round(sampleRate * (0.12 + 0.1 * this.stepRnd()))
        this.dipWait = this.ch[0]?.latency ?? 0
      }
      this.stepVoiced = voiced
    }
    // autotune and monotone use the current pitch after shifting
    if ((tune > 0.001 || mono > 0.001 || steps > 0.001) && tr.f0 > 0) {
      const f1 = tr.f0 * 2 ** (semis / 12)
      const note = 12 * Math.log2(f1 / 440)
      let want = tune * (Math.round(note) - note)
      const f2 = f1 * 2 ** (want / 12)
      if (mono > 0.001) want += mono * 12 * Math.log2(monoHz / f2)
      want += steps * this.stepSemis
      const k = 1 - Math.exp(-128 / (0.012 * sampleRate)) // ~12 ms: fast correction without clicks
      this.corr += (want - this.corr) * k
    } else if (tune <= 0.001 && mono <= 0.001 && steps <= 0.001) this.corr = 0
    semis = Math.max(-24, Math.min(24, semis + this.corr))
    this.vibPhase = (this.vibPhase + (2 * Math.PI * params.vibratoHz[0] * 128) / sampleRate) % (2 * Math.PI)
    if ((this.report += 128) >= sampleRate * 0.2) {
      this.report = 0
      this.port.postMessage({ f0: tr.f0, avg: tr.avg })
    }

    const active = Math.abs(semis) > 0.01 || Math.abs(fmt) > 0.01 || robot > 0.001 || whisper > 0.001 ||
      denoise > 0.001 || vibrato > 0.001
    // join dips (same for all channels): a smooth 18 ms half-sine notch, deeper with more steps
    const dips = steps > 0.001 && (this.dipWait >= 0 || this.dipPos >= 0)
    if (dips) {
      const n = output[0]?.length ?? 128, depth = 0.65 * Math.min(1, steps)
      for (let i = 0; i < n; i++) {
        if (this.dipWait >= 0 && this.dipWait-- === 0) this.dipPos = 0
        let g = 1
        if (this.dipPos >= 0) {
          g = 1 - depth * Math.sin((Math.PI * this.dipPos) / this.dipLen)
          if (++this.dipPos >= this.dipLen) this.dipPos = -1
        }
        this.dipGain[i] = g
      }
    } else if (steps <= 0.001) { this.dipWait = -1; this.dipPos = -1 }
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
      const pd = st.pvDelay
      if (pd) {
        for (let i = 0; i < x.length; i++) {
          const v = pd[st.pdi]
          pd[st.pdi] = st.pvBuf[i]
          st.pdi = st.pdi + 1 === pd.length ? 0 : st.pdi + 1
          st.pvBuf[i] = v
        }
      }
      if (psola > 0.001 || st.psMix > 0.001) {
        st.ps.ratio = 2 ** ((semis + vibrato * 0.8 * Math.sin(this.vibPhase)) / 12)
        st.ps.formant = 2 ** (fmt / 12)
        st.ps.process(x, st.psBuf, tr.f0)
      } else st.ps.feed(x)
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
      if (growl > 0.001 || sub > 0.001 || fry > 0.001 || rasp > 0.001 || octave > 0.001 || st.growl.busy) {
        st.growl.process(y, growl, sub, fry, rasp, octave, tr.f0 > 0 ? tr.f0 * 2 ** (semis / 12) : 0)
      }
      if (halo > 0.001 || st.halo.busy) st.halo.process(y, halo)
      if (dips) for (let i = 0; i < y.length; i++) y[i] *= this.dipGain[i]
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
// excess if the helper's clock runs ahead. Underruns fade out over what is left (and fade back in after
// re-priming); dropping the excess crossfades from the old read position to the new one — no clicks.
const FEED_FADE = Math.round(0.003 * sampleRate)
class HoloFeed extends AudioWorkletProcessor {
  // processorOptions: channels (2 — interleaved stereo, 1 — mono to every output channel), start/max — seconds
  private readonly ch: number
  private readonly ring: Float32Array
  private r = 0
  private w = 0
  private primed = false
  private readonly start: number
  private readonly max: number
  private gain = 0 // fade-in after (re)priming, 0..1
  private jumpTo = -1 // pending read position after dropping the excess (crossfaded in process)
  private xf = 0 // crossfade samples left
  private xr = 0 // old read position during the crossfade
  constructor(options?: { processorOptions?: { channels?: number; start?: number; max?: number } }) {
    super(options)
    const o = options?.processorOptions ?? {}
    this.ch = o.channels === 1 ? 1 : 2
    this.start = Math.round((o.start ?? 0.04) * sampleRate)
    this.max = Math.round((o.max ?? 0.15) * sampleRate)
    this.ring = new Float32Array(this.ch * Math.max(sampleRate, 3 * this.max))
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) this.push(new Float32Array(e.data))
      else if (e.data?.stats) this.port.postMessage({ underruns: this.underruns, drops: this.drops, frames: this.frames })
    }
  }
  /** diagnostics: buffer ran dry / excess dropped */
  private underruns = 0
  private drops = 0
  private get frames(): number { return (this.w - this.r + this.ring.length) % this.ring.length / this.ch }
  private push(x: Float32Array): void {
    const N = this.ring.length
    for (let i = 0; i < x.length; i++) { this.ring[this.w] = x[i]; this.w = (this.w + 1) % N }
    if (this.frames > this.max && this.xf === 0) {
      // too far behind: jump ahead to `start` frames before the write position, crossfading in process()
      if (!this.primed) this.r = (this.w - this.ch * this.start + N) % N
      else { if (this.jumpTo < 0) this.drops++; this.jumpTo = (this.w - this.ch * this.start + N) % N }
    }
  }
  /** one output frame from read position p (advanced), mono or stereo */
  private read(p: number, out: Float32Array[], i: number, g: number, add: boolean): number {
    const N = this.ring.length
    if (this.ch === 2) {
      const L = this.ring[p] * g, R = this.ring[p + 1] * g
      if (add) { out[0][i] += L; if (out[1]) out[1][i] += R } else { out[0][i] = L; if (out[1]) out[1][i] = R }
      return (p + 2) % N
    }
    const v = this.ring[p] * g
    for (let c = 0; c < out.length; c++) out[c][i] = add ? out[c][i] + v : v
    return (p + 1) % N
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    const n = out[0].length
    if (!this.primed) {
      if (this.frames < this.start) return true
      this.primed = true
      this.gain = 0
    }
    if (this.jumpTo >= 0) { this.xr = this.r; this.r = this.jumpTo; this.jumpTo = -1; this.xf = FEED_FADE }
    const have = this.frames
    if (have < n + FEED_FADE) {
      // (about to) run dry: play what is left of this block with a fade-out, then silence until re-primed
      const m = Math.min(n, have)
      for (let i = 0; i < n; i++) {
        if (i < m) this.r = this.read(this.r, out, i, this.gain * (1 - (i + 1) / m), false)
        else for (let c = 0; c < out.length; c++) out[c][i] = 0
      }
      this.primed = false
      this.xf = 0
      this.underruns++
      return true
    }
    const step = 1 / FEED_FADE
    for (let i = 0; i < n; i++) {
      if (this.gain < 1) this.gain = Math.min(1, this.gain + step)
      if (this.xf > 0) {
        const a = this.xf / FEED_FADE // weight of the old position
        this.xr = this.read(this.xr, out, i, this.gain * a, false)
        this.r = this.read(this.r, out, i, this.gain * (1 - a), true)
        this.xf--
      } else this.r = this.read(this.r, out, i, this.gain, false)
    }
    return true
  }
}

// "holo-stream": sends its (mono) input out through the port in 10 ms chunks — the microphone for the neural voice
// One reused buffer, posted without a transfer list: the browser serializes a copy natively, so no JS objects are
// allocated on the audio thread (the old version allocated a fresh array every 10 ms → GC pressure there)
class HoloStream extends AudioWorkletProcessor {
  private readonly buf = new Float32Array(Math.round(sampleRate / 100))
  private n = 0
  process(inputs: Float32Array[][]): boolean {
    const x = inputs[0]?.[0]
    if (!x) return true
    for (let i = 0; i < x.length; i++) {
      this.buf[this.n++] = x[i]
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.buffer)
        this.n = 0
      }
    }
    return true
  }
}

registerProcessor('holo-stream', HoloStream)
registerProcessor('holo-feed', HoloFeed)
