// AudioWorklet «holo-voice»: высота, тембр, робот, шёпот, шумоподавление, вибрато (фазовый вокодер, pv.ts)
// + огрубление (биты, частота). Следит за тоном голоса (pitch.ts): подстройка к целевой высоте (голос любого
// говорящего — к ~110 Гц мужской, ~210 женский…), тембр следом за сдвигом, автотюн, монотонность (робот).
// Раз в 200 мс отправляет в port { f0, avg } — панель показывает «ваш голос ≈ … Гц».
// Высота и тембр — либо вокодером, либо PSOLA (psola.ts, параметр psola): PSOLA звучит естественнее для
// смены голоса (мужской/женский/детский), вокодер нужен для шёпота, шумоподавления и робота-жужжалки.
// В нейтральном положении (всё по нулям) отдаёт входной сигнал с той же задержкой, что и вокодер, —
// переход между ними плавный (~30 мс), поэтому нарастание эффекта не щёлкает и задержка не скачет.
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
  'autoTarget', 'targetHz', 'formantFollow', 'tune', 'mono', 'monoHz', 'psola'] as const

class Channel {
  pv: PhaseVocoder
  ps: Psola
  psBuf = new Float32Array(128)
  psMix = 0 // 0 — вокодер/сухой, 1 — PSOLA
  delay: Float32Array // сухой сигнал с задержкой вокодера
  di = 0
  pvBuf = new Float32Array(128)
  mix = 0 // 0 — сухой, 1 — вокодер
  hold = 0
  held = 0
  constructor(n: number) {
    this.pv = new PhaseVocoder(n, 8, sampleRate)
    this.delay = new Float32Array(this.pv.latency)
    // PSOLA смотрит вперёд на полтора периода: не меньше ~29 мс, чтобы низкие голоса (от ~75 Гц) не обрезались
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
    ]
  }

  private n: number
  private ch: Channel[] = []
  private tracker = new PitchTracker(sampleRate)
  private corr = 0 // поправка автотюна/монотонности, полутоны (сглаженная; в паузах держится)
  private report = 0
  private vibPhase = 0
  private readonly smooth = Math.exp(-1 / (0.03 * sampleRate))

  constructor(options: { processorOptions?: { fftSize?: number } }) {
    super(options)
    this.n = options.processorOptions?.fftSize ?? 2048
    this.warmup()
  }

  /** Прогрев JIT: пока код не скомпилирован, кадры вокодера считаются в разы дольше — первые секунды после
   *  запуска давали щелчки. Прогоняем всё на шуме ~1 с до начала звука; состояние потом сбрасывается. */
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

    // тон говорящего — по первому каналу
    const tr = this.tracker
    if (input[0]) tr.push(input[0])
    // сдвиг: заданный + к целевой высоте (по среднему тону — интонация сохраняется)
    let semis = pitch
    if (autoTarget > 0.001 && tr.avg > 0) semis += autoTarget * 12 * Math.log2(targetHz / tr.avg)
    semis = Math.max(-24, Math.min(24, semis))
    // тембр следует за сдвигом: у людей форманты выше вместе с голосом, но слабее (~0.4 от сдвига высоты)
    // (у реальных голосов форманты выше примерно на 0.27 от разницы высот: мужской → женский ≈ +18 %)
    const fmt = Math.max(-12, Math.min(12, formant + follow * 0.27 * (semis - pitch)))
    // автотюн и монотонность — по текущему тону после сдвига
    if ((tune > 0.001 || mono > 0.001) && tr.f0 > 0) {
      const f1 = tr.f0 * 2 ** (semis / 12)
      const note = 12 * Math.log2(f1 / 440)
      let want = tune * (Math.round(note) - note)
      const f2 = f1 * 2 ** (want / 12)
      if (mono > 0.001) want += mono * 12 * Math.log2(monoHz / f2)
      const k = 1 - Math.exp(-128 / (0.012 * sampleRate)) // ~12 мс — быстрая подтяжка без щелчков
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
    const levels = crush > 0.001 ? 2 ** (15 - crush * 12) : 0 // 16 бит → 4 бита
    const holdN = 1 + Math.round(decimate * 15) // до 1/16 частоты дискретизации
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
      pv.vibrato = vibrato * 0.8 // до 0.8 полутона
      pv.vibratoHz = vibratoHz
      // вокодер считает, только когда нужен (или ещё звучит в переходе); иначе холостой ход
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
        if (holdN > 1) {
          if (st.hold-- <= 0) { st.held = v; st.hold = holdN - 1 }
          v = st.held
        }
        if (levels) v = Math.round(v * levels) / levels
        y[i] = v
      }
    }
    return true
  }
}

registerProcessor('holo-voice', HoloVoice)

// «holo-tap» — запись входа для «Проверить на записи»: по { start: секунды } копит отсчёты (моно) и отдаёт их
// одним Float32Array, когда набралось или пришло { stop: true }
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
