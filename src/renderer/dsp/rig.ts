// Processing chain for one track, shared by all effects; an effect is a set of parameters (effects.ts).
// The graph is not rebuilt when the effect changes: all parameters are AudioParams, so ramp-in, ramp-out and transitions
// between effects are smooth automation, with no clicks and no latency jumps.
//
//   input → holo-voice (noise reduction, pitch, timbre, vibrato, robot, whisper, degradation) → drive
//        → ring modulation → low/high cut → bass / warmth / clarity / presence / air (+ excite)
//        → de-esser → compressor → tape wow → chorus (+ doubler) → tremolo → level → output
//                                                            tremolo ─┬→ echo ───→ level
//                                                                     └→ reverb ─→ level
//   noise → (track gate) → level
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
  /** noise gate: the track closes it together with its own noise gate so hiss doesn't play during pauses */
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

    // voice
    this.input.connect(voice)
    for (const k of ['pitch', 'formant', 'robot', 'whisper', 'crush', 'decimate', 'denoise', 'vibrato', 'vibratoHz',
      'autoTarget', 'targetHz', 'formantFollow', 'tune', 'mono', 'monoHz', 'psola'] as const) {
      bind(k, voice.parameters.get(k)!)
    }

    // drive: mix of clean and tanh(6x); loudness is evened out after saturation
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

    // ring modulation
    const ringIn = gain(), ringDry = gain(), ringVca = gain(0), ringWet = gain(0)
    driveDry.connect(ringIn); driveWet.connect(ringIn)
    const carrier = lfo(60)
    carrier.connect(ringVca.gain)
    ringIn.connect(ringDry)
    ringIn.connect(ringVca).connect(ringWet)
    bind('ring', ringDry.gain, (v) => 1 - v)
    bind('ring', ringWet.gain, (v) => v * 1.4)
    bind('ringHz', carrier.frequency, (v) => v, true)

    // tone
    const biq = (type: BiquadFilterType, hz: number, q = 0.7) => { const f = c.createBiquadFilter(); f.type = type; f.frequency.value = hz; f.Q.value = q; return f }
    const lowcut = biq('highpass', 20), highcut = biq('lowpass', 20000)
    const bass = biq('lowshelf', 180), warmth = biq('peaking', 280, 0.8), mud = biq('peaking', 480, 1.1)
    const presence = biq('peaking', 3200, 0.8), air = biq('highshelf', 10000)
    ringDry.connect(lowcut); ringWet.connect(lowcut)
    lowcut.connect(highcut).connect(bass).connect(warmth).connect(mud).connect(presence).connect(air)
    bind('warmth', warmth.gain)
    bind('clarity', mud.gain, (v) => -v) // clarity: cut the 400–500 Hz "mud"
    bind('lowcut', lowcut.frequency, (v) => v, true)
    bind('highcut', highcut.frequency, (v) => Math.min(v, c.sampleRate / 2 - 100), true)
    bind('bass', bass.gain)
    bind('presence', presence.gain)
    bind('air', air.gain)

    // excite: saturate only the highs and blend in; adds overtones so the voice sounds richer
    const enh = gain(), excGain = gain(0), excPre = gain(4)
    const excShaper = c.createWaveShaper()
    const ec = new Float32Array(2048)
    for (let i = 0; i < ec.length; i++) ec[i] = Math.tanh((i / (ec.length - 1)) * 2 - 1)
    excShaper.curve = ec
    air.connect(enh)
    air.connect(biq('highpass', 3000)).connect(excPre).connect(excShaper).connect(biq('highpass', 2500)).connect(excGain).connect(enh)
    bind('excite', excGain.gain, (v) => v * 0.3)

    // de-esser: the band above 5.5 kHz (4th-order Linkwitz–Riley crossover, flat when summed) is compressed separately
    const deLow = biq('lowpass', 5500), deLow2 = biq('lowpass', 5500), deHigh = biq('highpass', 5500), deHigh2 = biq('highpass', 5500)
    const deComp = c.createDynamicsCompressor()
    deComp.knee.value = 3; deComp.attack.value = 0.001; deComp.release.value = 0.06
    const deOut = gain()
    enh.connect(deLow).connect(deLow2).connect(deOut)
    enh.connect(deHigh).connect(deHigh2).connect(deComp).connect(deOut)
    bind('deess', deComp.threshold, (v) => -45 * v)
    bind('deess', deComp.ratio, (v) => 1 + 11 * v)

    // compressor: even loudness, the voice sounds "closer"
    const comp = c.createDynamicsCompressor()
    comp.knee.value = 10; comp.attack.value = 0.005; comp.release.value = 0.15
    deOut.connect(comp)
    bind('comp', comp.threshold, (v) => -32 * v)
    bind('comp', comp.ratio, (v) => 1 + 4 * v)

    // tape wow: a delay modulated slowly (wow) and quickly (flutter)
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

    // chorus: two copies with different base delays and modulation rates
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

    // tremolo
    const trem = gain(1), tremDepth = gain(0)
    chorusIn.connect(trem); chorusWet.connect(trem)

    // width (doubler): two slightly "drifting" copies panned left and right, making the voice wider and richer
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

    // echo
    const echoSend = gain(0), echoDelay = c.createDelay(2), echoTone = biq('lowpass', 3200), echoFb = gain(0.35)
    trem.connect(echoSend).connect(echoDelay).connect(echoTone)
    echoTone.connect(echoFb).connect(echoDelay)
    echoTone.connect(level)
    bind('echo', echoSend.gain, (v) => v * 0.8)
    bind('echoTime', echoDelay.delayTime)
    bind('echoFb', echoFb.gain)

    // reverb: small and large rooms, "size" blends them
    const revShort = c.createConvolver(), revLong = c.createConvolver()
    revShort.buffer = impulse(c, 1.1, 3, 11)
    revLong.buffer = impulse(c, 3.6, 2.2, 23)
    const sendShort = gain(0), sendLong = gain(0)
    trem.connect(sendShort).connect(revShort).connect(level)
    trem.connect(sendLong).connect(revLong).connect(level)
    // reverb is stored via size: both sends are recomputed when either parameter changes (see apply)
    this.revSends = [sendShort.gain, sendLong.gain]

    // tape/radio noise
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

  /** Move to the target parameters over seconds (0 = almost instantly, smoothed to avoid clicks) */
  apply(target: FxParams, seconds: number): void {
    const now = this.ctx.currentTime
    // Our own curve from the current value: in Chromium cancelAndHoldAtTime after setTargetAtTime may hold 0,
    // and per the spec an exponential ramp from 0 stays at zero to the end, so the filter would close to silence.
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
    for (const s of this.sources) { try { s.stop() } catch { /* already */ } }
    this.input.disconnect()
    this.voice.disconnect()
    this.output.disconnect()
  }
}
