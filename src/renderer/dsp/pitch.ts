// Слежение за основным тоном голоса (YIN) — для подстройки голоса под цель, автотюна и монотонного робота.
// Считается на сигнале, прореженном до ~12 кГц: голосу хватает, а стоит в десятки раз дешевле.

export class PitchTracker {
  /** текущий тон, Гц (0 — не голос: пауза, шипящие) */
  f0 = 0
  /** средний тон говорящего за последние секунды, Гц (0 — ещё не слышали голоса) */
  avg = 0
  /** уверенность последнего решения 0..1 */
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

  constructor(sampleRate: number, private readonly every = 256) {
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
    // НЧ-фильтр (две однополюсные ступени ~2.5 кГц) и прореживание
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
    if (energy / win < 1e-6) { this.unvoiced(); return } // тишина (−60 дБ)
    // разностная функция и её нормировка накопленным средним (YIN)
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
      // нет уверенного провала — берём глобальный минимум, если он достаточно глубокий
      let m = minLag
      for (let tau = minLag; tau <= maxLag; tau++) if (d[tau] < d[m]) m = tau
      if (d[m] < 0.3) best = m
    }
    if (best < 0) { this.unvoiced(); return }
    // параболическое уточнение
    const y0 = d[best - 1] ?? d[best], y1 = d[best], y2 = d[best + 1] ?? d[best]
    const den = y0 - 2 * y1 + y2
    const lag = den !== 0 ? best + (0.5 * (y0 - y2)) / den : best
    const f = this.rate / lag
    this.clarity = 1 - y1
    this.f0 = f
    // средний тон — в логарифме, постоянная времени ~1.5 с; сначала — сразу первое значение
    if (this.avg <= 0) this.avg = f
    else {
      const k = 1 - Math.exp(-dt / 1.5)
      this.avg = Math.exp(Math.log(this.avg) + (Math.log(f) - Math.log(this.avg)) * k)
    }
  }

  private unvoiced(): void {
    this.f0 = 0
    this.clarity = 0
  }
}
