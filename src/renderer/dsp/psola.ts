// TD-PSOLA: pitch shifting by slicing at fundamental periods. Around each glottal pulse a two-period
// "grain" (Hann window) is taken and re-placed at a new spacing, the period of the new pitch.
// Formants are preserved automatically (each grain keeps its spectrum), so it sounds like another person rather
// than a sped-up tape, and without the vocoder's "phasey" metallic tone. Timbre (formants) is changed by resampling
// the grain: a compressed grain raises formants (female/child), a stretched one lowers them (male).
// Unvoiced sounds (s, sh, f) and pauses are not pitch-shifted: grains there use a fixed step, only the timbre
// changes. Grain overlap (higher pitch) is normalized by the window sum, so loudness does not grow.
// Latency is `latency` samples (set equal to the vocoder latency so the two can be crossfaded smoothly).

const RING = 1 << 15
const MASK = RING - 1
const MARKS = 256

export class Psola {
  /** pitch ratio (2 = one octave up) */
  ratio = 1
  /** formant ratio (1.18 = ~18% higher) */
  formant = 1

  private x = new Float32Array(RING) // input
  private lp = new Float32Array(RING) // low-passed input, for finding glottal pulses
  private y = new Float32Array(RING) // output accumulator
  private env = new Float32Array(RING) // energy envelope, for snapping marks to pulses
  private envS = 0
  private readonly envA: number
  private voicedRun = false
  private w = new Float32Array(RING) // window sum
  private t = 0 // samples received so far (absolute input time)
  private l1 = 0
  private l2 = 0
  private readonly lpA: number
  // analysis marks: pulse position and the period around it (0 = unvoiced segment)
  // marks live in a fixed-size ring (no allocations on the audio thread)
  private readonly markPos = new Float64Array(MARKS)
  private readonly markT = new Float32Array(MARKS)
  private mHead = 0 // index of the next write
  private mCount = 0
  private lastMark = 0
  private nextSyn = 0
  private readonly tu: number
  private floor = 1
  private pSmooth = 0
  private wasVoiced = false
  /** synthesis period smoothing: weight of the new value (1 = no smoothing). 0.12 removed marking errors but also the
   *  voice's natural period-to-period variation, and grains drifted off their analysis marks: even an unshifted voice
   *  lost ~0.4 UTMOS. 0.5 keeps most of the natural variation while still damping single misplaced marks */
  smoothK = 0.5
  /** the same when raising pitch noticeably: a male voice's period-to-period irregularity, copied into a female
   *  or child voice, reads as male/hoarse (gender classifier on a rough 98 Hz voice: 0.96 female at 0.12, 0.12 at 0.3) */
  smoothUp = 0.15
  /** grain shortening when raising pitch: half-length × ratio^-shrink */
  shrink = 0.6
  /** snapping marks to the energy peak, fraction of a period (0 = off) */
  refine = 0
  /** asymmetric window for voiced grains (up to the neighbouring pulses) */
  asym = true
  /** voiced/unvoiced decision from similarity of adjacent periods (on top of the pitch detector) */
  selfVoicing = true
  rVoiced = 0.3 // minimum correlation when the detector says "voiced"
  rHold = 0.7 // when the detector has lost the voice but we carry on
  rStart = 0.8 // a voiced onset found by PSOLA itself, before the detector reports it
  /** onsets are searched for only when the pitch ratio is below this */
  startBelow = 0.97
  /** the speaker's typical pitch, Hz (0 = unknown): where to look for the period of a voice onset */
  priorHz = 0
  private lastVoiced = -1e9 // position of the last voiced mark
  private lastPeriod = 0
  private readonly maxHalf: number
  private readonly minP: number

  constructor(private readonly sampleRate: number, readonly latency: number) {
    // below the first formant: one peak per period, so marks don't jump between two peaks within a period
    this.lpA = Math.exp((-2 * Math.PI * 600) / sampleRate)
    this.envA = Math.exp(-1 / (0.001 * sampleRate))
    this.tu = Math.round(sampleRate * 0.008) // unvoiced segments: a grain every 8 ms
    // a grain needs half a period of lookahead: the given latency caps the longest period
    this.maxHalf = Math.floor(latency * 0.45)
    this.minP = Math.round(sampleRate / 600)
    this.lastMark = 0
    this.nextSyn = 0
  }

  private idle = false

  /** While PSOLA is not in use: keep the input history fresh (cheap), so when it is switched back on it doesn't
   *  play ~30 ms of audio from before the pause; synthesis restarts from a clean slate (see restart) */
  feed(input: Float32Array): void {
    this.idle = true
    this.store(input)
  }

  /** Back from idle: drop old grains, window sums and marks; analysis resumes just before the output point */
  private restart(): void {
    this.idle = false
    this.y.fill(0)
    this.w.fill(0)
    this.mCount = 0
    this.mHead = 0
    this.voicedRun = false
    this.wasVoiced = false
    this.lastPeriod = 0
    this.lastVoiced = -1e9
    this.lastMark = Math.max(0, this.t - this.latency - this.tu)
    this.nextSyn = 0
  }

  private store(input: Float32Array): void {
    const n = input.length
    for (let i = 0; i < n; i++) {
      const v = input[i]
      this.l1 = v + (this.l1 - v) * this.lpA
      this.l2 = this.l1 + (this.l2 - this.l1) * this.lpA
      const k = (this.t + i) & MASK
      this.x[k] = v
      this.lp[k] = this.l2
      // energy envelope (|x| smoothed over ~1 ms): maxima are glottal pulses
      this.envS = Math.abs(v) + (this.envS - Math.abs(v)) * this.envA
      this.env[k] = this.envS
    }
    this.t += n
  }

  /** f0 is the current input pitch (0 = unvoiced) */
  process(input: Float32Array, output: Float32Array, f0: number): void {
    const n = input.length
    if (this.idle) this.restart()
    this.store(input)
    this.analyze(f0)
    this.synthesize(this.t - this.latency)
    // output is divided by the window sum, otherwise loudness pulsates at the pitch rate ("buzzing"). When lowering pitch
    // there are gaps between grains (new, longer period); we don't boost them: divide by at least a fraction of ratio
    this.floor = Math.min(1, Math.max(0.05, this.ratio)) * 0.999
    const start = this.t - n - this.latency
    for (let i = 0; i < n; i++) {
      const at = start + i
      if (at < 0) { output[i] = 0; continue }
      const k = at & MASK
      output[i] = this.y[k] / Math.max(this.w[k], this.floor)
      this.y[k] = 0
      this.w[k] = 0
    }
  }

  /** Marks: when voiced, the maximum of the smoothed signal near "last mark + period"; when unvoiced, a fixed step */
  private analyze(f0: number): void {
    // the pitch detector misses some voiced frames (~14%): if we were just voiced, continue with the last
    // period and let the similarity of adjacent periods decide (below)
    const tracked = f0 > 0 ? Math.min(this.sampleRate / f0, this.maxHalf) : 0
    // (periods shorter than ~1.7 ms are not a voice: a correlation chain on rumble or DC can shrink the period
    // step by step, and a zero step would never advance the marks)
    const minP = this.minP
    let period = tracked || (this.voicedRun && this.selfVoicing && this.lastPeriod >= minP ? this.lastPeriod : 0)
    const horizon = this.t - 2
    while (true) {
      if (period <= 0 && this.selfVoicing && this.ratio < this.startBelow) {
        // the pitch detector reports a voice onset only after its 30 ms window fills with it: until then the
        // first syllable's start played at the original pitch (a female "blip" before each male syllable). Look
        // for periodicity ourselves around the expected period (the last one heard or the speaker's average).
        // Only when lowering the pitch: measured on 5 + 5 speakers it helps female → male (UTMOS +0.04) but hurts
        // male → female (−0.11): onsets of low male voices are often creaky, and an octave-up creak sounds worse
        // than a few unshifted milliseconds
        const recent = this.lastPeriod > 0 && this.lastMark - this.lastVoiced < this.sampleRate * 0.3
        const P = recent ? this.lastPeriod : this.priorHz > 0 ? this.sampleRate / this.priorHz : 0
        // lookahead it needs: unvoiced marks then trail the input by up to ~1.6 periods (synthesis needs them
        // only up to latency·0.55 behind the input, so there is room for voices down to ~85 Hz)
        const need = Math.round(P * 1.3) + Math.round(P / 4) + this.tu
        if (P >= minP && P < this.maxHalf && need < this.latency * 0.5) {
          if (this.lastMark + need > horizon) break
          const found = this.periodAt(this.lastMark + this.tu, P)
          if (found > 0) period = found
        }
      }
      if (period > 0) {
        if (!this.voicedRun) {
          // start of a voiced segment: the first mark goes on a glottal pulse (energy peak within one period after
          // the last mark). Subsequent correlation-based marks inherit this phase: the grain window is centered on the pulse.
          // Without this a mark could land between pulses and the grain caught two pulses; when raising pitch
          // each output period then got two pulses, hence the rasp
          const from = this.lastMark + Math.round(this.tu * 0.5), to = from + Math.round(period)
          if (to + Math.round(period) > horizon) break
          let pk = from, pv = -1
          for (let p = from; p <= to; p++) { const e = this.env[p & MASK]; if (e > pv) { pv = e; pk = p } }
          this.voicedRun = true
          this.pushMark(pk, Math.round(period))
          continue
        }
        const lo = this.lastMark + Math.round(period * 0.7), hi = this.lastMark + Math.round(period * 1.3)
        if (hi + Math.round(period / 2) > horizon) break
        // the next mark is where the signal best repeats the segment around the previous one (cross-correlation):
        // marks land on the same point of every period and grains stay consistent (peak picking was erratic)
        const m0 = this.lastMark, hw = Math.round(period / 2)
        let best = Math.round(m0 + period), bv = -Infinity
        for (let p = lo; p <= hi; p += 2) {
          let c = 0, e = 0
          for (let k = -hw; k <= hw; k += 3) {
            const v = this.x[(p + k) & MASK]
            c += v * this.x[(m0 + k) & MASK]
            e += v * v
          }
          const sc = e > 0 ? c / Math.sqrt(e) : 0
          if (sc > bv) { bv = sc; best = p }
        }
        // refine to the sample
        for (let p = best - 1; p <= best + 1; p += 2) {
          let c = 0, e = 0
          for (let k = -hw; k <= hw; k += 3) { const v = this.x[(p + k) & MASK]; c += v * this.x[(m0 + k) & MASK]; e += v * v }
          const sc = e > 0 ? c / Math.sqrt(e) : 0
          if (sc > bv) { bv = sc; best = p }
        }
        if (this.selfVoicing) {
          // is it voiced: normalized correlation of adjacent periods. No repetition means an unvoiced segment
          let e0 = 0, e1 = 0, c = 0
          for (let k = -hw; k <= hw; k += 3) {
            const u = this.x[(m0 + k) & MASK], v = this.x[(best + k) & MASK]
            c += u * v; e0 += u * u; e1 += v * v
          }
          const r = e0 > 0 && e1 > 0 ? c / Math.sqrt(e0 * e1) : 0
          if (r < (tracked ? this.rVoiced : this.rHold)) {
            this.voicedRun = false
            this.pushMark(this.lastMark + this.tu, 0)
            if (!tracked) period = 0
            continue
          }
        }
        if (best - this.lastMark < minP) {
          this.voicedRun = false
          this.pushMark(this.lastMark + this.tu, 0)
          period = 0
          continue
        }
        this.lastPeriod = best - this.lastMark
        // stay locked on the pulse: the correlation chain can slowly drift in phase, so snap the mark to a nearby
        // energy peak (±refine of a period) if one is clearly there
        if (this.refine > 0) {
          const r = Math.round(period * this.refine)
          let pk = best, pv = this.env[best & MASK]
          for (let p = best - r; p <= best + r; p++) { const e = this.env[p & MASK]; if (e > pv) { pv = e; pk = p } }
          if (pv > this.env[best & MASK] * 1.15) best = pk
        }
        this.pushMark(best, best - this.lastMark)
        this.lastVoiced = best
      } else {
        this.voicedRun = false
        const m = this.lastMark + this.tu
        if (m > horizon) break
        this.pushMark(m, 0)
      }
    }
  }

  /** Period near P (±30%) at position m if the signal clearly repeats there (normalized correlation ≥ rStart), else 0 */
  private periodAt(m: number, P: number): number {
    const x = this.x, hw = Math.round(P / 4)
    const lo = Math.round(P * 0.7), hi = Math.round(P * 1.3)
    let e0 = 0
    for (let k = -hw; k <= hw; k += 3) { const u = x[(m + k) & MASK]; e0 += u * u }
    if (e0 < 1e-7) return 0 // silence
    let best = 0, bv = this.rStart
    for (let L = lo; L <= hi; L += 2) {
      let c = 0, e1 = 0
      for (let k = -hw; k <= hw; k += 3) { const v = x[(m + L + k) & MASK]; c += x[(m + k) & MASK] * v; e1 += v * v }
      const r = e1 > 0 ? c / Math.sqrt(e0 * e1) : 0
      if (r > bv) { bv = r; best = L }
    }
    // a double period repeats too: prefer the true one if the signal repeats nearly as well at half the lag
    const h = Math.round(best / 2)
    if (best > 0 && h >= this.minP) {
      for (let L = h - 3; L <= h + 3; L++) {
        let c = 0, e1 = 0
        for (let k = -hw; k <= hw; k += 3) { const v = x[(m + L + k) & MASK]; c += x[(m + k) & MASK] * v; e1 += v * v }
        if (e1 > 0 && c / Math.sqrt(e0 * e1) > this.rStart - 0.1) return L
      }
    }
    return best
  }

  private pushMark(pos: number, T: number): void {
    this.markPos[this.mHead] = pos
    this.markT[this.mHead] = T > 0 ? Math.min(T, this.maxHalf) : 0
    this.mHead = (this.mHead + 1) % MARKS
    if (this.mCount < MARKS) this.mCount++
    this.lastMark = pos
  }

  /** i-th mark counting from the oldest stored one */
  private mi(i: number): number { return (this.mHead - this.mCount + i + MARKS) % MARKS }

  /** Place grains at the new spacing until they cover the output up to outEnd with some margin */
  private synthesize(outEnd: number): void {
    const n = this.mCount
    if (!n) return
    const pos = this.markPos
    let j = 0
    if (this.nextSyn < outEnd - this.latency) {
      // start or glitch: put the synthesis point on the nearest analysis mark, otherwise with a ~½ period offset the
      // "nearest mark" flips back and forth and periods get duplicated or dropped
      const want = outEnd - this.latency
      while (j < n - 1 && Math.abs(pos[this.mi(j + 1)] - want) <= Math.abs(pos[this.mi(j)] - want)) j++
      this.nextSyn = pos[this.mi(j)]
      j = 0
    }
    while (this.nextSyn <= outEnd + this.maxHalf) {
      const s = this.nextSyn
      // analysis mark nearest to s
      while (j < n - 1 && Math.abs(pos[this.mi(j + 1)] - s) <= Math.abs(pos[this.mi(j)] - s)) j++
      const a = pos[this.mi(j)]
      let T = this.markT[this.mi(j)]
      const back = T
      // step exactly to the next mark (if it exists yet): at unchanged pitch grains land exactly in place
      const fwd = j + 1 < n && this.markT[this.mi(j + 1)] > 0 ? this.markT[this.mi(j + 1)] : 0
      if (T > 0 && fwd > 0) T = fwd
      const voiced = T > 0
      const half = voiced ? T : this.tu
      // the grain needs input up to a + half: if it hasn't arrived yet, wait for the next block
      if (a + half * Math.max(1, this.formant) >= this.t) break
      // waveform alignment only for unvoiced grains: voiced marks already sit on the same point of the period,
      // and alignment would pull the grain toward the old period and eat the pitch shift
      // grain window (as in Praat): left up to the previous pulse, right up to the next; with uneven periods
      // a symmetric window caught pieces of neighbouring pulses
      if (voiced && this.asym) {
        // raising pitch packs the two-period grains several deep (4× at an octave up): neighbouring grains, never
        // quite identical, then interfere into a rough, phasey tone. Shorter grains (ratio^-0.6: ~1.3 output periods
        // at an octave up) overlap less; the formants widen only slightly. Measured: HNR +1 dB, shimmer −2 points
        const g = this.ratio > 1 ? this.ratio ** -this.shrink : 1
        this.grain(a, s, back * g, (fwd || T) * g)
      }
      else this.grain(voiced ? a : a + this.align(a, s, half), s, half, half)
      // synthesis step follows the smoothed period: otherwise mark irregularity (vocal jitter + marking errors) is copied
      // to the output, and jitter is the acoustic basis of hoarseness; Praat does the same (new periods along a smooth curve)
      if (voiced) {
        const k = this.ratio > 1.06 ? this.smoothUp : this.smoothK
        this.pSmooth = this.wasVoiced ? this.pSmooth + (T - this.pSmooth) * k : T
      }
      this.wasVoiced = voiced
      this.nextSyn = s + Math.max(16, Math.round(voiced ? this.pSmooth / this.ratio : this.tu))
    }
  }

  /** Waveform alignment (as in WSOLA): the grain offset within ±30% of a period at which its start best
   *  matches the output already assembled, so adjacent grains join in phase even if the mark is imprecise
   *  (without this the voice "fragmented" and lost coherence even without a pitch change). */
  private align(a: number, s: number, half: number): number {
    const R = Math.round(half * 0.3)
    const f = this.formant
    const oh = Math.max(8, Math.min(this.maxHalf, Math.round(half / f)))
    const { x, y } = this
    // compare the first half of the grain with what is already accumulated there (tails of previous grains)
    let acc = 0
    for (let k = -oh; k < 0; k += 2) acc += Math.abs(y[(s + k) & MASK])
    if (acc < 1e-6) return 0 // nothing before the grain (start, after a pause): nothing to align to
    let best = 0, bestC = -Infinity
    for (let d = -R; d <= R; d += 2) {
      let c = 0, e = 0
      for (let k = -oh; k < 0; k += 2) {
        const v = x[Math.round(a + d + k * f) & MASK]
        c += v * y[(s + k) & MASK]
        e += v * v
      }
      const score = e > 0 ? c / Math.sqrt(e) : 0
      if (score > bestC) { bestC = score; best = d }
    }
    return best
  }

  private grain(a: number, s: number, left: number, right: number): void {
    const f = this.formant
    const ol = Math.max(8, Math.min(this.maxHalf, Math.round(left / f)))
    const or = Math.max(8, Math.min(this.maxHalf, Math.round(right / f)))
    const { x, y, w } = this
    for (let k = -ol; k <= or; k++) {
      const win = 0.5 + 0.5 * Math.cos((Math.PI * k) / ((k < 0 ? ol : or) + 1))
      const src = a + k * f
      const i0 = Math.floor(src)
      const fr = src - i0
      const v = x[i0 & MASK] + (x[(i0 + 1) & MASK] - x[i0 & MASK]) * fr
      const o = (s + k) & MASK
      y[o] += v * win
      w[o] += win
    }
  }
}
