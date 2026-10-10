// Цепочка обработки одной дорожки — одна на все эффекты, эффект = набор параметров (effects.ts).
// Граф не перестраивается при смене эффекта: все параметры — AudioParam, поэтому нарастание, затухание и переход
// между эффектами — это плавная автоматизация, без щелчков и без скачков задержки.
//
//   вход → holo-voice (шумоподавление, высота, тембр, вибрато, робот, шёпот, огрубление) → перегруз
//        → кольцевая модуляция → срез низа/верха → низы / теплота / чистота / разборчивость / воздух (+ блеск)
//        → де-эссер → компрессор → плавание плёнки → хорус (+ дублер) → тремоло → уровень → выход
//                                                            тремоло ─┬→ эхо ─────────→ уровень
//                                                                     └→ реверберация ─→ уровень
//   шум → (гейт дорожки) → уровень
import { NEUTRAL, PARAM, type FxParams, type ParamKey } from '../effects'

interface Target { p: AudioParam; map: (v: number) => number; exp?: boolean }

const dbToGain = (d: number) => 10 ** (d / 20)

function impulse(ctx: BaseAudioContext, seconds: number, decay: number, seed: number): AudioBuffer {
  const n = Math.round(ctx.sampleRate * seconds)
  const ir = ctx.createBuffer(2, n, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c)
    let s = seed + c * 7919
    for (let i = 0; i < n; i++) {
      s = (s * 16807) % 2147483647
      d[i] = ((s / 2147483647) * 2 - 1) * (1 - i / n) ** decay
    }
  }
  return ir
}

export class VoiceRig {
  readonly input: GainNode
  readonly output: GainNode
  /** гейт шума: дорожка закрывает его вместе со своим шумодавом, чтобы шипение не шло в паузах */
  readonly noiseGate: GainNode
  current: FxParams = { ...NEUTRAL }
  private targets = {} as Record<ParamKey, Target[]>
  private sources: AudioScheduledSourceNode[] = []

  constructor(private ctx: BaseAudioContext, readonly voice: AudioWorkletNode) {
    const c = ctx
    const gain = (v = 1) => { const g = c.createGain(); g.gain.value = v; return g }
    const bind = (key: ParamKey, p: AudioParam, map: (v: number) => number = (v) => v, exp = false) => {
      ;(this.targets[key] ??= []).push({ p, map, exp })
      p.value = map(NEUTRAL[key])
    }
    const lfo = (hz: number, type: OscillatorType = 'sine') => {
      const o = c.createOscillator(); o.type = type; o.frequency.value = hz; o.start(); this.sources.push(o); return o
    }

    this.input = gain()
    this.output = gain()
    const level = gain()
    bind('level', level.gain, dbToGain)
    level.connect(this.output)

    // голос
    this.input.connect(voice)
    for (const k of ['pitch', 'formant', 'robot', 'whisper', 'crush', 'decimate', 'denoise', 'vibrato', 'vibratoHz',
      'autoTarget', 'targetHz', 'formantFollow', 'tune', 'mono', 'monoHz', 'psola'] as const) {
      bind(k, voice.parameters.get(k)!)
    }

    // перегруз: смесь чистого и tanh(6x); после насыщения громкость выравнивается
    const driveIn = gain(), driveDry = gain(), drivePre = gain(6), driveWet = gain(0)
    const shaper = c.createWaveShaper()
    const curve = new Float32Array(4096)
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 1.5) / Math.tanh(1.5)
    shaper.curve = curve
    shaper.oversample = '4x'
    voice.connect(driveIn)
    driveIn.connect(driveDry)
    driveIn.connect(drivePre).connect(shaper).connect(driveWet)
    bind('drive', driveDry.gain, (v) => 1 - v)
    bind('drive', driveWet.gain, (v) => v * 0.35)

    // кольцевая модуляция
    const ringIn = gain(), ringDry = gain(), ringVca = gain(0), ringWet = gain(0)
    driveDry.connect(ringIn); driveWet.connect(ringIn)
    const carrier = lfo(60)
    carrier.connect(ringVca.gain)
    ringIn.connect(ringDry)
    ringIn.connect(ringVca).connect(ringWet)
    bind('ring', ringDry.gain, (v) => 1 - v)
    bind('ring', ringWet.gain, (v) => v * 1.4)
    bind('ringHz', carrier.frequency, (v) => v, true)

    // тон
    const biq = (type: BiquadFilterType, hz: number, q = 0.7) => { const f = c.createBiquadFilter(); f.type = type; f.frequency.value = hz; f.Q.value = q; return f }
    const lowcut = biq('highpass', 20), highcut = biq('lowpass', 20000)
    const bass = biq('lowshelf', 180), warmth = biq('peaking', 280, 0.8), mud = biq('peaking', 480, 1.1)
    const presence = biq('peaking', 3200, 0.8), air = biq('highshelf', 10000)
    ringDry.connect(lowcut); ringWet.connect(lowcut)
    lowcut.connect(highcut).connect(bass).connect(warmth).connect(mud).connect(presence).connect(air)
    bind('warmth', warmth.gain)
    bind('clarity', mud.gain, (v) => -v) // чистота: вырезать «бубнение» 400–500 Гц
    bind('lowcut', lowcut.frequency, (v) => v, true)
    bind('highcut', highcut.frequency, (v) => Math.min(v, c.sampleRate / 2 - 100), true)
    bind('bass', bass.gain)
    bind('presence', presence.gain)
    bind('air', air.gain)

    // блеск: насыщение только верхов, подмешивается — добавляет обертоны, голос звучит дороже
    const enh = gain(), excGain = gain(0), excPre = gain(4)
    const excShaper = c.createWaveShaper()
    const ec = new Float32Array(2048)
    for (let i = 0; i < ec.length; i++) ec[i] = Math.tanh((i / (ec.length - 1)) * 2 - 1)
    excShaper.curve = ec
    air.connect(enh)
    air.connect(biq('highpass', 3000)).connect(excPre).connect(excShaper).connect(biq('highpass', 2500)).connect(excGain).connect(enh)
    bind('excite', excGain.gain, (v) => v * 0.3)

    // де-эссер: полоса выше 5.5 кГц (кроссовер Линквица—Райли 4-го порядка — в сумме ровно) сжимается отдельно
    const deLow = biq('lowpass', 5500), deLow2 = biq('lowpass', 5500), deHigh = biq('highpass', 5500), deHigh2 = biq('highpass', 5500)
    const deComp = c.createDynamicsCompressor()
    deComp.knee.value = 3; deComp.attack.value = 0.001; deComp.release.value = 0.06
    const deOut = gain()
    enh.connect(deLow).connect(deLow2).connect(deOut)
    enh.connect(deHigh).connect(deHigh2).connect(deComp).connect(deOut)
    bind('deess', deComp.threshold, (v) => -45 * v)
    bind('deess', deComp.ratio, (v) => 1 + 11 * v)

    // компрессор: ровная громкость, голос «ближе»
    const comp = c.createDynamicsCompressor()
    comp.knee.value = 10; comp.attack.value = 0.005; comp.release.value = 0.15
    deOut.connect(comp)
    bind('comp', comp.threshold, (v) => -32 * v)
    bind('comp', comp.ratio, (v) => 1 + 4 * v)

    // плавание плёнки: задержка, качающаяся медленно (wow) и быстро (flutter)
    const wowDry = gain(), wowWet = gain(0), wowDelay = c.createDelay(0.1), wowDepth = gain(0), flutDepth = gain(0)
    wowDelay.delayTime.value = 0.012
    lfo(0.55).connect(wowDepth).connect(wowDelay.delayTime)
    lfo(6.5).connect(flutDepth).connect(wowDelay.delayTime)
    comp.connect(wowDry)
    comp.connect(wowDelay).connect(wowWet)
    bind('wow', wowDry.gain, (v) => 1 - v)
    bind('wow', wowWet.gain, (v) => v)
    bind('wow', wowDepth.gain, (v) => v * 0.0035)
    bind('wow', flutDepth.gain, (v) => v * 0.0004)

    // хорус: две копии с разной базовой задержкой и скоростью качания
    const chorusIn = gain(), chorusWet = gain(0)
    wowDry.connect(chorusIn); wowWet.connect(chorusIn)
    for (const [base, rate] of [[0.018, 1], [0.025, 1.37]] as const) {
      const dl = c.createDelay(0.1); dl.delayTime.value = base
      const o = lfo(0.8 * rate); const depth = gain(0.004)
      o.connect(depth).connect(dl.delayTime)
      bind('chorusRate', o.frequency, (v) => v * rate, true)
      chorusIn.connect(dl).connect(chorusWet)
    }
    bind('chorus', chorusWet.gain, (v) => v * 0.6)

    // тремоло
    const trem = gain(1), tremDepth = gain(0)
    chorusIn.connect(trem); chorusWet.connect(trem)

    // объём (дублер): две чуть «плавающие» копии, разведённые влево и вправо — голос шире и богаче
    const dblGain = gain(0)
    for (const [base, hz, pan] of [[0.013, 0.31, -0.75], [0.019, 0.43, 0.75]] as const) {
      const dl = c.createDelay(0.05); dl.delayTime.value = base
      const depth = gain(0.0012)
      lfo(hz).connect(depth).connect(dl.delayTime)
      const panner = c.createStereoPanner(); panner.pan.value = pan
      chorusIn.connect(dl).connect(panner).connect(dblGain)
    }
    dblGain.connect(trem)
    bind('double', dblGain.gain, (v) => v * 0.5)
    const tremLfo = lfo(5)
    tremLfo.connect(tremDepth).connect(trem.gain)
    bind('tremolo', trem.gain, (v) => 1 - v / 2)
    bind('tremolo', tremDepth.gain, (v) => v / 2)
    bind('tremoloHz', tremLfo.frequency, (v) => v, true)
    trem.connect(level)

    // эхо
    const echoSend = gain(0), echoDelay = c.createDelay(2), echoTone = biq('lowpass', 3200), echoFb = gain(0.35)
    trem.connect(echoSend).connect(echoDelay).connect(echoTone)
    echoTone.connect(echoFb).connect(echoDelay)
    echoTone.connect(level)
    bind('echo', echoSend.gain, (v) => v * 0.8)
    bind('echoTime', echoDelay.delayTime)
    bind('echoFb', echoFb.gain)

    // реверберация: малая и большая комнаты, «размер» смешивает их
    const revShort = c.createConvolver(), revLong = c.createConvolver()
    revShort.buffer = impulse(c, 1.1, 3, 11)
    revLong.buffer = impulse(c, 3.6, 2.2, 23)
    const sendShort = gain(0), sendLong = gain(0)
    trem.connect(sendShort).connect(revShort).connect(level)
    trem.connect(sendLong).connect(revLong).connect(level)
    // реверберация хранит эффект через size: обе отправки пересчитываются при любом из двух параметров (см. apply)
    this.revSends = [sendShort.gain, sendLong.gain]

    // шум плёнки/эфира
    const n = c.sampleRate * 2
    const buf = c.createBuffer(1, n, c.sampleRate)
    const d = buf.getChannelData(0)
    let s = 7
    for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 2147483647) * 2 - 1 }
    const noise = c.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.start(); this.sources.push(noise)
    const noiseLevel = gain(0)
    this.noiseGate = gain(1)
    noise.connect(biq('highpass', 1500)).connect(noiseLevel).connect(this.noiseGate).connect(level)
    bind('noise', noiseLevel.gain, (v) => v * 0.05)
  }

  private revSends: AudioParam[]

  /** Перейти к параметрам target за seconds (0 — почти мгновенно, со сглаживанием против щелчков) */
  apply(target: FxParams, seconds: number): void {
    const now = this.ctx.currentTime
    // Своя кривая от текущего значения: cancelAndHoldAtTime в Chromium после setTargetAtTime может удержать 0,
    // а экспоненциальный переход от 0 по спецификации остаётся нулём до конца — фильтр закрылся бы в тишину.
    const go = (p: AudioParam, v: number, exp = false) => {
      const cur = p.value
      p.cancelScheduledValues(now)
      if (seconds < 0.03 || Math.abs(cur - v) < 1e-6) {
        p.setValueAtTime(cur, now)
        p.setTargetAtTime(v, now, 0.015)
        return
      }
      const n = Math.max(2, Math.ceil(seconds * 50))
      const curve = new Float32Array(n)
      const log = exp && cur > 0 && v > 0
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1)
        curve[i] = log ? cur * (v / cur) ** t : cur + (v - cur) * t
      }
      p.setValueCurveAtTime(curve, now, seconds)
    }
    for (const key of Object.keys(this.targets) as ParamKey[]) {
      const v = Math.max(PARAM[key].min, Math.min(PARAM[key].max, target[key]))
      for (const t of this.targets[key]) go(t.p, t.map(v), t.exp)
    }
    const rv = target.reverb * 0.9, size = target.size
    go(this.revSends[0], rv * (1 - size))
    go(this.revSends[1], rv * size)
    this.current = { ...target }
  }

  dispose(): void {
    for (const s of this.sources) { try { s.stop() } catch { /* уже */ } }
    this.input.disconnect()
    this.voice.disconnect()
    this.output.disconnect()
  }
}
