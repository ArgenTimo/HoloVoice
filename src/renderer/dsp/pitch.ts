// Voice fundamental pitch tracking (YIN), for steering the voice to a target pitch, autotune and the monotone robot.
// Runs on a signal decimated to ~12 kHz: enough for voice, and tens of times cheaper.

export class PitchTracker {
  /** current pitch, Hz (0 = unvoiced: pause, sibilants) */
  f0 = 0
  /** speaker's average pitch over the last seconds, Hz (0 = no voice heard yet) */
  avg = 0
  /** confidence of the last decision, 0..1 */
  clarity = 0

  private readonly decim: number
  private readonly rate: number
  private readonly buf: Float32Array
  private pos = 0
  private filled = 0
  private lp1 = 0
  private lp2 = 0
  private phase = 0
  private since = 0
  private readonly win: number
  private readonly minLag: number
  private readonly maxLag: number
  private readonly d: Float32Array
  private readonly frame: Float32Array
  private readonly hist = new Float32Array(400) // recent voice pitches (~2 s at 256-sample frames)
  private readonly sorted = new Float32Array(400)
  private hi = 0
  private lastF = 0
  private holdLeft = 0
  thrV = 0.3 // "definitely voiced" threshold for the global minimum
  thrHold = 0.5 // threshold under hysteresis
  hold = 8 // how many consecutive analyses (~5 ms each) hysteresis lasts
  private hn = 0
  private since2 = 0

  /** analysis interval, samples (the worklet slows it down when nothing needs the pitch) */
  every = 256

  constructor(sampleRate: number) {
    this.decim = Math.max(1, Math.round(sampleRate / 12000))
    this.rate = sampleRate / this.decim
    this.minLag = Math.floor(this.rate / 900)
    this.maxLag = Math.ceil(this.rate / 65)
    this.win = Math.round(this.rate * 0.03)
    this.buf = new Float32Array(this.win + this.maxLag + 2)
    this.d = new Float32Array(this.maxLag + 1)
    this.frame = new Float32Array(this.buf.length)
  }

  push(x: Float32Array): void {
    // low-pass filter (two one-pole stages, ~2.5 kHz) and decimation
    const a = Math.exp((-2 * Math.PI * 2500) / (this.rate * this.decim))
    for (let i = 0; i < x.length; i++) {
      this.lp1 = x[i] + (this.lp1 - x[i]) * a
      this.lp2 = this.lp1 + (this.lp2 - this.lp1) * a
      if (++this.phase >= this.decim) {
        this.phase = 0
        this.buf[this.pos] = this.lp2
        this.pos = (this.pos + 1) % this.buf.length
        if (this.filled < this.buf.length) this.filled++
      }
    }
    this.since += x.length
    if (this.since >= this.every && this.filled === this.buf.length) {
      this.analyze(this.since / (this.rate * this.decim))
      this.since = 0
    }
  }

  private analyze(dt: number): void {
    const { buf, frame, d, win, minLag, maxLag } = this
    const n = buf.length
    for (let i = 0; i < n; i++) frame[i] = buf[(this.pos + i) % n]
    let energy = 0
    for (let i = 0; i < win; i++) energy += frame[i] * frame[i]
    if (energy / win < 1e-6) { this.unvoiced(); return } // silence (−60 dB)
    // difference function and its cumulative mean normalization (YIN)
    d[0] = 1
    let sum = 0
    let best = -1
    for (let tau = 1; tau <= maxLag; tau++) {
      let s = 0
      for (let i = 0; i < win; i++) { const v = frame[i] - frame[i + tau]; s += v * v }
      sum += s
      d[tau] = sum > 0 ? (s * tau) / sum : 1
    }
    for (let tau = minLag; tau < maxLag; tau++) {
      if (d[tau] < 0.15 && d[tau] <= d[tau + 1]) { best = tau; break }
    }
    if (best < 0) {
      // no confident dip: take the global minimum if it is deep enough; if we were just voiced and the minimum
      // is near the last pitch, trust a less confident one too (hysteresis): otherwise the voice "dropped out"
      // for a moment mid-word and the pitch jumped back to the original
      let m = minLag
      for (let tau = minLag; tau <= maxLag; tau++) if (d[tau] < d[m]) m = tau
      const near = this.lastF > 0 && Math.abs(Math.log((this.rate / m) / this.lastF)) < 0.22
      if (d[m] < this.thrV || (near && this.holdLeft > 0 && d[m] < this.thrHold)) best = m
    }
    if (best < 0) { this.unvoiced(); return }
    // in low voices a strong second harmonic gives a false dip at half the period (pitch "an octave too high"):
    // if the dip at double the period is noticeably deeper, that is the true period
    if (2 * best + 2 <= maxLag) {
      let b2 = 2 * best - 2
      for (let tau = 2 * best - 2; tau <= 2 * best + 2; tau++) if (d[tau] < d[b2]) b2 = tau
      if (d[b2] < d[best] - 0.04) best = b2 // absolute margin: for a purely periodic signal both dips are ≈ 0
    }
    // parabolic interpolation
    const y0 = d[best - 1] ?? d[best], y1 = d[best], y2 = d[best + 1] ?? d[best]
    const den = y0 - 2 * y1 + y2
    const lag = den !== 0 ? best + (0.5 * (y0 - y2)) / den : best
    const f = this.rate / lag
    this.clarity = 1 - y1
    this.f0 = f
    this.lastF = f
    this.holdLeft = this.hold
    // average pitch is the median of the last ~2 s of voice: robust to octave outliers; the first 0.2 s just accumulate
    this.hist[this.hi] = f
    this.hi = (this.hi + 1) % this.hist.length
    if (this.hn < this.hist.length) this.hn++
    if (this.hn >= 40 && (++this.since2 >= 8 || this.avg <= 0)) {
      this.since2 = 0
      // no allocations on the audio thread (GC pauses caused crackling), not even subarray views: unused slots
      // are +∞ and sort to the end
      const v = this.sorted, hn = this.hn
      for (let i = 0; i < v.length; i++) v[i] = i < hn ? this.hist[i] : Infinity
      v.sort()
      this.avg = v[hn >> 1]
    }
    void dt
  }

  private unvoiced(): void {
    this.f0 = 0
    this.clarity = 0
    if (this.holdLeft > 0) this.holdLeft--
  }
}
