// AudioWorklet «holo-voice»: высота, тембр, робот, шёпот, шумоподавление, вибрато (фазовый вокодер, pv.ts)
// + огрубление (биты, частота).
// В нейтральном положении (всё по нулям) отдаёт входной сигнал с той же задержкой, что и вокодер, —
// переход между ними плавный (~30 мс), поэтому нарастание эффекта не щёлкает и задержка не скачет.
import { PhaseVocoder } from './pv'

declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  constructor(options?: unknown)
  readonly port: MessagePort
}

const PARAMS = ['pitch', 'formant', 'robot', 'whisper', 'crush', 'decimate', 'denoise', 'vibrato', 'vibratoHz'] as const

class Channel {
  pv: PhaseVocoder
  delay: Float32Array // сухой сигнал с задержкой вокодера
  di = 0
  pvBuf = new Float32Array(128)
  mix = 0 // 0 — сухой, 1 — вокодер
  hold = 0
  held = 0
  constructor(n: number) {
    this.pv = new PhaseVocoder(n, 8, sampleRate)
    this.delay = new Float32Array(this.pv.latency)
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
    ]
  }

  private n: number
  private ch: Channel[] = []
  private readonly smooth = Math.exp(-1 / (0.03 * sampleRate))

  constructor(options: { processorOptions?: { fftSize?: number } }) {
    super(options)
    this.n = options.processorOptions?.fftSize ?? 2048
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<(typeof PARAMS)[number], Float32Array>): boolean {
    const input = inputs[0]
    const output = outputs[0]
    const pitch = params.pitch[0], formant = params.formant[0], robot = params.robot[0], whisper = params.whisper[0]
    const crush = params.crush[0], decimate = params.decimate[0]
    const denoise = params.denoise[0], vibrato = params.vibrato[0], vibratoHz = params.vibratoHz[0]
    const active = Math.abs(pitch) > 0.01 || Math.abs(formant) > 0.01 || robot > 0.001 || whisper > 0.001 ||
      denoise > 0.001 || vibrato > 0.001
    const levels = crush > 0.001 ? 2 ** (15 - crush * 12) : 0 // 16 бит → 4 бита
    const holdN = 1 + Math.round(decimate * 15) // до 1/16 частоты дискретизации
    for (let c = 0; c < output.length; c++) {
      const x = input[c] ?? input[0]
      const y = output[c]
      if (!x) { y.fill(0); continue }
      const st = (this.ch[c] ??= new Channel(this.n))
      const pv = st.pv
      pv.pitch = 2 ** (pitch / 12)
      pv.formant = 2 ** (formant / 12)
      pv.robot = robot
      pv.whisper = whisper
      pv.denoise = denoise
      pv.vibrato = vibrato * 0.8 // до 0.8 полутона
      pv.vibratoHz = vibratoHz
      pv.process(x, st.pvBuf) // крутится всегда: при включении фазы уже прогреты
      const target = active ? 1 : 0
      const a = this.smooth
      for (let i = 0; i < x.length; i++) {
        const dry = st.delay[st.di]
        st.delay[st.di] = x[i]
        st.di = (st.di + 1) % st.delay.length
        st.mix = target + (st.mix - target) * a
        let v = dry + (st.pvBuf[i] - dry) * st.mix
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
