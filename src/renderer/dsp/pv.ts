// Фазовый вокодер со сдвигом высоты и раздельным сдвигом тембра (формант).
// Высота: перенос бинов спектра с пересчётом истинной частоты каждого бина (схема Бернзее).
// Тембр: спектральная огибающая через кепстр — источник «отбеливается» (делится на огибающую), сдвигается по высоте,
// затем умножается на огибающую, растянутую в formant раз. formant = 1 — тембр сохранён (голос другого человека,
// а не ускоренная плёнка); formant = pitch — классический «бурундук».
// robot — фазы синтеза одинаковые каждый кадр (монотонный робот на частоте кадров: sampleRate / hop), whisper — случайные фазы (шёпот).
// Фазы фиксируются относительно пиков спектра (Ларош—Долсон) — голос чище; шумоподавление и вибрато — тут же.
// Задержка = N − hop отсчётов.

class FFT {
  private rev: Uint32Array
  private cos: Float32Array
  private sin: Float32Array

  constructor(readonly n: number) {
    const bits = Math.log2(n)
    this.rev = new Uint32Array(n)
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
    this.cos = new Float32Array(n / 2)
    this.sin = new Float32Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n)
      this.sin[i] = Math.sin((2 * Math.PI * i) / n)
    }
  }

  /** На месте; inverse — без деления на n */
  run(re: Float32Array, im: Float32Array, inverse: boolean): void {
    const n = this.n
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    const sign = inverse ? 1 : -1
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step], s = sign * this.sin[k * step]
          const a = start + k, b = a + half
          const tr = re[b] * c - im[b] * s
          const ti = re[b] * s + im[b] * c
          re[b] = re[a] - tr; im[b] = im[a] - ti
          re[a] += tr; im[a] += ti
        }
      }
    }
  }
}

const TWO_PI = 2 * Math.PI

export class PhaseVocoder {
  readonly hop: number
  readonly latency: number
  pitch = 1 // отношение частот
  formant = 1
  robot = 0
  whisper = 0
  denoise = 0 // 0..1 — спектральное шумоподавление
  vibrato = 0 // глубина, полутоны
  vibratoHz = 5
  /** холостой ход: вход копится (буфер всегда свежий), но кадры не считаются — выход тишина. Включается, когда
   *  вокодер не нужен (нейтраль, PSOLA): это основная нагрузка, а её пики давали треск */
  idle = false

  private fft: FFT
  private win: Float32Array
  private inFifo: Float32Array
  private outFifo: Float32Array
  private accum: Float32Array
  private lastPhase: Float32Array
  private sumPhase: Float32Array
  private anaMag: Float32Array
  private anaPhase: Float32Array
  private anaFreq: Float32Array
  private synMag: Float32Array
  private synPh: Float32Array
  private synBest: Float32Array
  private env: Float32Array
  private noise: Float32Array
  private power: Float32Array
  private pmin: Float32Array
  private gain: Float32Array
  private peaks: Int32Array
  private owner: Int32Array
  private peakPh: Float32Array
  private re: Float32Array
  private im: Float32Array
  private cre: Float32Array
  private cim: Float32Array
  private rover: number
  private frames = 0
  private vibPhase = 0
  private readonly lifter: number
  private readonly scale: number
  private readonly expct: number

  constructor(readonly n: number, readonly osamp: number, readonly sampleRate: number) {
    this.hop = n / osamp
    this.latency = n - this.hop
    this.fft = new FFT(n)
    this.win = new Float32Array(n)
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / n)
    this.inFifo = new Float32Array(n)
    this.outFifo = new Float32Array(n)
    this.accum = new Float32Array(2 * n)
    const h = n / 2 + 1
    this.lastPhase = new Float32Array(h)
    this.sumPhase = new Float32Array(h)
    this.anaMag = new Float32Array(h)
    this.anaPhase = new Float32Array(h)
    this.anaFreq = new Float32Array(h)
    this.synMag = new Float32Array(h)
    this.synPh = new Float32Array(h)
    this.synBest = new Float32Array(h)
    this.env = new Float32Array(h)
    this.noise = new Float32Array(h)
    this.power = new Float32Array(h)
    this.pmin = new Float32Array(h)
    this.gain = new Float32Array(h).fill(1)
    this.peaks = new Int32Array(h)
    this.owner = new Int32Array(h)
    this.peakPh = new Float32Array(h)
    this.re = new Float32Array(n)
    this.im = new Float32Array(n)
    this.cre = new Float32Array(n)
    this.cim = new Float32Array(n)
    this.rover = this.latency
    // кепстр: оставляем кефренции короче ~1.6 мс — огибающая без гармоник голоса (период основного тона ≥ 2.5 мс)
    this.lifter = Math.max(8, Math.round(sampleRate / 600))
    // Ханн на анализе и синтезе: сумма перекрытий ханна² = osamp·3/8; обратное БПФ без 1/n
    this.scale = 1 / (n * osamp * 0.375)
    this.expct = (TWO_PI * this.hop) / n
  }

  process(input: Float32Array, output: Float32Array): void {
    const { latency, n } = this
    for (let i = 0; i < input.length; i++) {
      this.inFifo[this.rover] = input[i]
      output[i] = this.outFifo[this.rover - latency]
      this.rover++
      if (this.rover >= n) {
        this.rover = latency
        if (this.idle) { this.outFifo.fill(0, 0, this.hop); this.inFifo.copyWithin(0, this.hop, n) }
        else this.frame()
      }
    }
  }

  private envelope(): void {
    const { n, cre, cim, anaMag, env } = this
    const half = n / 2
    for (let k = 0; k <= half; k++) { cre[k] = Math.log(anaMag[k] + 1e-9); cim[k] = 0 }
    for (let k = half + 1; k < n; k++) { cre[k] = cre[n - k]; cim[k] = 0 }
    this.fft.run(cre, cim, true)
    const L = this.lifter
    for (let q = 0; q < n; q++) {
      const d = Math.min(q, n - q)
      const w = d < L ? 1 : d === L ? 0.5 : 0
      cre[q] = (cre[q] * w) / n
      cim[q] = 0
    }
    this.fft.run(cre, cim, false)
    for (let k = 0; k <= half; k++) env[k] = Math.exp(cre[k])
  }

  /** Шумоподавление (в духе MCRA): минимум сглаженной мощности полосы — детектор «здесь только шум»;
   *  оценка шума — среднее мощности на таких участках; усиление по Винеру с порогом и сглаживанием во времени
   *  (без «музыкального» шума). Голос между паузами шумом не становится: минимум растёт медленно. */
  private reduceNoise(): void {
    const { anaMag, noise, pmin, power, gain } = this
    const d = this.denoise
    const over = 1 + 1.5 * d
    const floor = 10 ** (-(24 * d) / 20) // до −24 дБ
    const first = this.frames < 10
    for (let k = 0; k < anaMag.length; k++) {
      const m = anaMag[k]
      const P = (power[k] = power[k] * 0.7 + m * m * 0.3)
      if (first) { pmin[k] = Math.max(pmin[k], P); noise[k] = Math.max(noise[k], P) }
      else {
        pmin[k] = P < pmin[k] ? P : pmin[k] * 1.0012 // ~+1 дБ/с
        if (P < 4 * pmin[k]) noise[k] = noise[k] * 0.96 + P * 0.04
      }
      const g = Math.max(floor, 1 - (over * noise[k]) / (P + 1e-20))
      gain[k] = gain[k] * 0.5 + g * 0.5
      anaMag[k] = m * gain[k]
    }
  }

  private frame(): void {
    const { n, hop, osamp, re, im, win, anaMag, anaPhase, anaFreq, synMag, synPh, synBest, env, expct, peaks, owner, peakPh } = this
    const half = n / 2
    this.frames++
    for (let k = 0; k < n; k++) { re[k] = this.inFifo[k] * win[k]; im[k] = 0 }
    this.fft.run(re, im, false)

    // анализ: амплитуда, фаза и истинная частота каждого бина (в долях бина)
    for (let k = 0; k <= half; k++) {
      const mag = Math.hypot(re[k], im[k])
      const phase = Math.atan2(im[k], re[k])
      let d = phase - this.lastPhase[k] - k * expct
      this.lastPhase[k] = phase
      d -= TWO_PI * Math.round(d / TWO_PI)
      anaMag[k] = mag
      anaPhase[k] = phase
      anaFreq[k] = k + (osamp * d) / TWO_PI
    }
    if (this.denoise > 0.001) this.reduceNoise()

    // вибрато — качание высоты
    let pitch = this.pitch
    if (this.vibrato > 0.001) {
      this.vibPhase = (this.vibPhase + (TWO_PI * this.vibratoHz * hop) / this.sampleRate) % TWO_PI
      pitch *= 2 ** ((this.vibrato * Math.sin(this.vibPhase)) / 12)
    }
    const formant = this.formant
    const shaping = Math.abs(pitch - 1) > 1e-4 || Math.abs(formant - 1) > 1e-4
    if (shaping) this.envelope()

    // пики спектра; каждый бин принадлежит ближайшему пику
    let np = 0
    for (let k = 2; k < half - 1; k++) {
      const m = anaMag[k]
      if (m > anaMag[k - 1] && m >= anaMag[k + 1] && m > anaMag[k - 2] && m >= anaMag[k + 2]) peaks[np++] = k
    }

    synMag.fill(0)
    synBest.fill(0)
    if (np === 0) {
      // тишина: без пиков — просто перенос бинов
      for (let k = 0; k <= half; k++) {
        const j = Math.round(k * pitch)
        if (j > half) break
        synMag[j] += anaMag[k]
        synPh[j] = this.sumPhase[j] + (TWO_PI * (anaFreq[k] * pitch - j)) / osamp + j * expct
      }
    } else {
      let pi = 0
      for (let k = 0; k <= half; k++) {
        while (pi < np - 1 && Math.abs(peaks[pi + 1] - k) <= Math.abs(peaks[pi] - k)) pi++
        owner[k] = peaks[pi]
      }
      // фаза пика — накопление по его истинной частоте после сдвига (схема Ларош—Долсон с фиксацией фаз):
      // соседние бины области пика сохраняют фазы относительно него — меньше «фазового» металла в голосе
      for (let q = 0; q < np; q++) {
        const p = peaks[q]
        const jp = Math.round(p * pitch)
        if (jp > half) { peakPh[p] = 0; continue }
        peakPh[p] = this.sumPhase[jp] + (TWO_PI * (anaFreq[p] * pitch - jp)) / osamp + jp * expct
      }
      for (let k = 0; k <= half; k++) {
        const p = owner[k]
        const j = k + Math.round(p * pitch) - p // область пика сдвигается целиком, сохраняя форму
        if (j < 0 || j > half) continue
        const m = shaping ? anaMag[k] / env[k] : anaMag[k]
        synMag[j] += m
        if (m > synBest[j]) { synBest[j] = m; synPh[j] = peakPh[p] + (anaPhase[k] - anaPhase[p]) }
      }
    }
    if (shaping) {
      for (let j = 0; j <= half; j++) {
        const src = j / formant
        const i0 = Math.floor(src)
        const e = i0 >= half ? env[half] * 0.1 : env[i0] + (env[i0 + 1] - env[i0]) * (src - i0)
        synMag[j] *= e
      }
    }

    // синтез
    const robot = this.robot, whisper = this.whisper
    for (let k = 0; k <= half; k++) {
      let ph = synMag[k] > 0 ? synPh[k] : this.sumPhase[k] + k * expct
      ph -= TWO_PI * Math.floor(ph / TWO_PI)
      this.sumPhase[k] = ph
      // робот: фаза πk — импульс кадра в центре окна (нулевая фаза ставит его на край, где окно Ханна гасит звук)
      let out = ph + robot * (Math.PI * k - ph)
      if (whisper > 0) out += whisper * (Math.random() * TWO_PI - Math.PI)
      re[k] = synMag[k] * Math.cos(out)
      im[k] = synMag[k] * Math.sin(out)
    }
    for (let k = half + 1; k < n; k++) { re[k] = re[n - k]; im[k] = -im[n - k] }
    this.fft.run(re, im, true)

    const acc = this.accum
    for (let k = 0; k < n; k++) acc[k] += win[k] * re[k] * this.scale
    for (let k = 0; k < hop; k++) this.outFifo[k] = acc[k]
    acc.copyWithin(0, hop, hop + n)
    acc.fill(0, n)
    this.inFifo.copyWithin(0, hop, n)
  }
}
