// TD-PSOLA — смена высоты голоса нарезкой по периодам основного тона: вокруг каждого голосового импульса
// берётся «зерно» длиной в два периода (окно Ханна) и переставляется с новым шагом — периодом новой высоты.
// Форманты при этом сохраняются сами (у каждого зерна тот же спектр), поэтому звучит как другой человек, а не
// как ускоренная плёнка и без «фазового» металла вокодера. Тембр (форманты) меняется пересэмплированием зерна:
// сжатое зерно — форманты выше (женский/детский), растянутое — ниже (мужской).
// Глухие звуки (с, ш, ф) и паузы не сдвигаются по высоте: зёрна там идут с фиксированным шагом, меняется
// только тембр. Перекрытие зёрен (тон выше) нормируется суммой окон — громкость не растёт.
// Задержка — `latency` отсчётов (берётся равной задержке вокодера, чтобы их можно было плавно смешивать).

const RING = 1 << 15
const MASK = RING - 1
const MARKS = 256

export class Psola {
  /** отношение высот (2 — на октаву выше) */
  ratio = 1
  /** отношение формант (1.18 — на ~18 % выше) */
  formant = 1

  private x = new Float32Array(RING) // вход
  private lp = new Float32Array(RING) // вход после НЧ-фильтра — для поиска голосовых импульсов
  private y = new Float32Array(RING) // накопление выхода
  private w = new Float32Array(RING) // сумма окон
  private t = 0 // сколько отсчётов пришло (абсолютное время входа)
  private l1 = 0
  private l2 = 0
  private readonly lpA: number
  // метки анализа: позиция импульса и период вокруг него (0 — глухой участок)
  // метки — кольцо фиксированного размера (без выделений памяти в аудиопотоке)
  private readonly markPos = new Float64Array(MARKS)
  private readonly markT = new Float32Array(MARKS)
  private mHead = 0 // индекс следующей записи
  private mCount = 0
  private lastMark = 0
  private nextSyn = 0
  private readonly tu: number
  private readonly maxHalf: number

  constructor(private readonly sampleRate: number, readonly latency: number) {
    this.lpA = Math.exp((-2 * Math.PI * 900) / sampleRate)
    this.tu = Math.round(sampleRate * 0.008) // глухие участки — зёрна каждые 8 мс
    // зерну нужно смотреть вперёд на полпериода: при заданной задержке самый длинный период ограничен
    this.maxHalf = Math.floor(latency * 0.45)
    this.lastMark = 0
    this.nextSyn = 0
  }

  /** f0 — текущий тон входа (0 — не голос) */
  process(input: Float32Array, output: Float32Array, f0: number): void {
    const n = input.length
    for (let i = 0; i < n; i++) {
      const v = input[i]
      this.l1 = v + (this.l1 - v) * this.lpA
      this.l2 = this.l1 + (this.l2 - this.l1) * this.lpA
      const k = (this.t + i) & MASK
      this.x[k] = v
      this.lp[k] = this.l2
    }
    this.t += n
    this.analyze(f0)
    this.synthesize(this.t - this.latency)
    // выдача: где зёрна перекрываются (выше тон) — делим на сумму окон, чтобы громкость не росла; где между ними
    // щели (ниже тон) — не тянем: щель и есть новый, более длинный период
    const start = this.t - n - this.latency
    for (let i = 0; i < n; i++) {
      const at = start + i
      if (at < 0) { output[i] = 0; continue }
      const k = at & MASK
      output[i] = this.y[k] / Math.max(1, this.w[k])
      this.y[k] = 0
      this.w[k] = 0
    }
  }

  /** Метки: в голосе — максимум сглаженного сигнала около «прошлая метка + период», в глухом — равный шаг */
  private analyze(f0: number): void {
    const period = f0 > 0 ? Math.min(this.sampleRate / f0, this.maxHalf) : 0
    const horizon = this.t - Math.ceil((period || this.tu) * 1.3) - 2
    while (true) {
      if (period > 0) {
        const lo = this.lastMark + Math.round(period * 0.75), hi = this.lastMark + Math.round(period * 1.25)
        if (hi > horizon) break
        let best = lo, bv = -Infinity
        for (let p = lo; p <= hi; p++) { const v = this.lp[p & MASK]; if (v > bv) { bv = v; best = p } }
        this.pushMark(best, best - this.lastMark)
      } else {
        const m = this.lastMark + this.tu
        if (m > horizon) break
        this.pushMark(m, 0)
      }
    }
  }

  private pushMark(pos: number, T: number): void {
    this.markPos[this.mHead] = pos
    this.markT[this.mHead] = T > 0 ? Math.min(T, this.maxHalf) : 0
    this.mHead = (this.mHead + 1) % MARKS
    if (this.mCount < MARKS) this.mCount++
    this.lastMark = pos
  }

  /** i-я метка от самой старой из хранящихся */
  private mi(i: number): number { return (this.mHead - this.mCount + i + MARKS) % MARKS }

  /** Расставить зёрна с новым шагом, пока они покрывают выдачу до outEnd с запасом */
  private synthesize(outEnd: number): void {
    const n = this.mCount
    if (!n) return
    const pos = this.markPos
    if (this.nextSyn < outEnd - this.latency) this.nextSyn = outEnd - this.latency // после паузы/старта
    let j = 0
    while (this.nextSyn <= outEnd + this.maxHalf) {
      const s = this.nextSyn
      // ближайшая к s метка анализа
      while (j < n - 1 && Math.abs(pos[this.mi(j + 1)] - s) <= Math.abs(pos[this.mi(j)] - s)) j++
      const a = pos[this.mi(j)]
      const T = this.markT[this.mi(j)]
      const voiced = T > 0
      const half = voiced ? T : this.tu
      // зерну нужен вход до a + half: если ещё не пришёл — ждём следующего блока
      if (a + half * Math.max(1, this.formant) >= this.t) break
      this.grain(a, s, half)
      this.nextSyn = s + Math.max(16, Math.round(voiced ? T / this.ratio : this.tu))
    }
  }

  private grain(a: number, s: number, half: number): void {
    const f = this.formant
    const oh = Math.max(8, Math.min(this.maxHalf, Math.round(half / f)))
    const { x, y, w } = this
    for (let k = -oh; k <= oh; k++) {
      const win = 0.5 + 0.5 * Math.cos((Math.PI * k) / (oh + 1))
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
