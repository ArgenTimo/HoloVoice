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
  private env = new Float32Array(RING) // огибающая энергии — для привязки меток к импульсам
  private envS = 0
  private readonly envA: number
  private voicedRun = false
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
  private floor = 1
  private pSmooth = 0
  private wasVoiced = false
  /** сглаживание периода синтеза: доля нового значения (1 — без сглаживания) */
  smoothK = 0.12
  /** подтяжка метки к пику энергии, доля периода (0 — выкл) */
  refine = 0
  /** асимметричное окно голосового зерна (до соседних импульсов) */
  asym = true
  /** голос/не голос по сходству соседних периодов (поверх детектора тона) */
  selfVoicing = true
  rVoiced = 0.3 // минимальная корреляция, когда детектор говорит «голос»
  rHold = 0.7 // когда детектор потерял голос, а мы продолжаем
  private lastPeriod = 0
  private readonly maxHalf: number

  constructor(private readonly sampleRate: number, readonly latency: number) {
    // ниже первой форманты: один пик на период, метки не прыгают между двумя пиками внутри периода
    this.lpA = Math.exp((-2 * Math.PI * 600) / sampleRate)
    this.envA = Math.exp(-1 / (0.001 * sampleRate))
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
      // огибающая энергии (|x| сглаженный ~1 мс): максимумы — голосовые импульсы
      this.envS = Math.abs(v) + (this.envS - Math.abs(v)) * this.envA
      this.env[k] = this.envS
    }
    this.t += n
    this.analyze(f0)
    this.synthesize(this.t - this.latency)
    // выдача — делим на сумму окон: иначе громкость пульсирует с частотой тона («жужжание»). При понижении между
    // зёрнами щели (новый, более длинный период) — их не вытягиваем: деление не меньше чем на долю ratio
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

  /** Метки: в голосе — максимум сглаженного сигнала около «прошлая метка + период», в глухом — равный шаг */
  private analyze(f0: number): void {
    // детектор тона пропускает часть голосовых кадров (~14 %): если голос только что был — продолжаем с прошлым
    // периодом, а решает сходство соседних периодов (ниже)
    const tracked = f0 > 0 ? Math.min(this.sampleRate / f0, this.maxHalf) : 0
    const period = tracked || (this.voicedRun && this.selfVoicing ? this.lastPeriod : 0)
    const horizon = this.t - 2
    while (true) {
      if (period > 0) {
        if (!this.voicedRun) {
          // начало голосового участка: первая метка — на голосовой импульс (пик энергии в пределах периода после
          // прошлой метки). Дальше метки по корреляции наследуют эту фазу: окно зерна центрировано на импульсе.
          // Без этого метка могла встать между импульсами, зерно захватывало два импульса — при повышении тона
          // в каждом периоде выхода выходило по два импульса, отсюда хрип
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
        // следующая метка — где отрезок сигнала лучше всего повторяет отрезок у предыдущей (взаимная корреляция):
        // метки встают в одну и ту же точку каждого периода, зёрна согласованы (поиск пика давал разнобой)
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
        // уточнение до отсчёта
        for (let p = best - 1; p <= best + 1; p += 2) {
          let c = 0, e = 0
          for (let k = -hw; k <= hw; k += 3) { const v = this.x[(p + k) & MASK]; c += v * this.x[(m0 + k) & MASK]; e += v * v }
          const sc = e > 0 ? c / Math.sqrt(e) : 0
          if (sc > bv) { bv = sc; best = p }
        }
        if (this.selfVoicing) {
          // голос ли это: нормированная корреляция соседних периодов. Нет повторения — глухой участок
          let e0 = 0, e1 = 0, c = 0
          for (let k = -hw; k <= hw; k += 3) {
            const u = this.x[(m0 + k) & MASK], v = this.x[(best + k) & MASK]
            c += u * v; e0 += u * u; e1 += v * v
          }
          const r = e0 > 0 && e1 > 0 ? c / Math.sqrt(e0 * e1) : 0
          if (r < (tracked ? this.rVoiced : this.rHold)) {
            this.voicedRun = false
            this.pushMark(this.lastMark + this.tu, 0)
            continue
          }
        }
        this.lastPeriod = best - this.lastMark
        // удержание на импульсе: цепочка корреляций может понемногу уводить фазу — подтягиваем метку к пику
        // энергии рядом (±refine периода), если он там явно есть
        if (this.refine > 0) {
          const r = Math.round(period * this.refine)
          let pk = best, pv = this.env[best & MASK]
          for (let p = best - r; p <= best + r; p++) { const e = this.env[p & MASK]; if (e > pv) { pv = e; pk = p } }
          if (pv > this.env[best & MASK] * 1.15) best = pk
        }
        this.pushMark(best, best - this.lastMark)
      } else {
        this.voicedRun = false
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
    let j = 0
    if (this.nextSyn < outEnd - this.latency) {
      // старт или сбой: точку синтеза ставим на ближайшую метку анализа — иначе при сдвиге ~½ периода «ближайшая
      // метка» скачет туда-сюда и периоды то дублируются, то пропадают
      const want = outEnd - this.latency
      while (j < n - 1 && Math.abs(pos[this.mi(j + 1)] - want) <= Math.abs(pos[this.mi(j)] - want)) j++
      this.nextSyn = pos[this.mi(j)]
      j = 0
    }
    while (this.nextSyn <= outEnd + this.maxHalf) {
      const s = this.nextSyn
      // ближайшая к s метка анализа
      while (j < n - 1 && Math.abs(pos[this.mi(j + 1)] - s) <= Math.abs(pos[this.mi(j)] - s)) j++
      const a = pos[this.mi(j)]
      let T = this.markT[this.mi(j)]
      const back = T
      // шаг — точно до следующей метки (если она уже есть): при неизменной высоте зёрна встают ровно на свои места
      const fwd = j + 1 < n && this.markT[this.mi(j + 1)] > 0 ? this.markT[this.mi(j + 1)] : 0
      if (T > 0 && fwd > 0) T = fwd
      const voiced = T > 0
      const half = voiced ? T : this.tu
      // зерну нужен вход до a + half: если ещё не пришёл — ждём следующего блока
      if (a + half * Math.max(1, this.formant) >= this.t) break
      // подстройка по волне — только для глухих зёрен: у голосовых метки и так стоят в одной точке периода,
      // а подстройка подтягивала бы зерно к старому периоду и съедала сдвиг высоты
      // окно зерна (как в Praat): влево — до предыдущего импульса, вправо — до следующего; при неровных периодах
      // симметричное окно захватывало куски соседних импульсов
      if (voiced && this.asym) this.grain(a, s, back, fwd || T)
      else this.grain(voiced ? a : a + this.align(a, s, half), s, half, half)
      // шаг синтеза — по сглаженному периоду: неровность меток (дрожание голоса + ошибки разметки) иначе копируется
      // в выход, а дрожание и есть акустическая основа хрипоты; так же делает Praat (новые периоды по гладкой кривой)
      if (voiced) this.pSmooth = this.wasVoiced ? this.pSmooth + (T - this.pSmooth) * this.smoothK : T
      this.wasVoiced = voiced
      this.nextSyn = s + Math.max(16, Math.round(voiced ? this.pSmooth / this.ratio : this.tu))
    }
  }

  /** Подстройка по форме волны (как в WSOLA): сдвиг зерна в пределах ±30 % периода, при котором его начало лучше
   *  всего совпадает с уже собранным выходом — соседние зёрна стыкуются в фазе, даже если метка стоит неточно
   *  (без этого голос «дробился» и терял связность даже без смены высоты). */
  private align(a: number, s: number, half: number): number {
    const R = Math.round(half * 0.3)
    const f = this.formant
    const oh = Math.max(8, Math.min(this.maxHalf, Math.round(half / f)))
    const { x, y } = this
    // сравниваем первую половину зерна с тем, что уже накоплено на этом месте (хвосты предыдущих зёрен)
    let acc = 0
    for (let k = -oh; k < 0; k += 2) acc += Math.abs(y[(s + k) & MASK])
    if (acc < 1e-6) return 0 // перед зерном пусто (начало, после паузы) — сдвигать не к чему
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
