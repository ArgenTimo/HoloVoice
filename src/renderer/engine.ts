// Engine — a hidden window that lives for the app's whole lifetime: audio doesn't depend on whether the panel or widget is open.
// Two independent lanes, each with its own effect (chain dsp/rig.ts + vocoder dsp/worklet.ts; originally voice-fx
// from holo-messenger):
//   mic — my microphone → effect → virtual microphone (Linux: HoloVoice-Microphone from routing-linux.js,
//         re-traductor mechanism; Windows: VB-Audio Virtual Cable, the calling app reads "CABLE Output")
//   sys — computer audio (videos, the other party) → effect → my headphones
//         (Linux: capture via a temporary null sink; Windows: system loopback with the original muted)
// Each lane has its own AudioContext: they use different output devices.
import { VoiceRig } from './dsp/rig'
import { setLang, t } from './i18n'
import { EFFECTS, NEURAL_FALLBACK, NEUTRAL, allEffects, customs, effectFull, effectInfo, effectTarget, effectVariant, isCustom, isNeural, setCustom, systemSoundTarget, type BuiltinId, type EffectId, type FxParams } from './effects'
import { holo, type Cmd, type EngineState, type Hint, type LaneId, type LaneSettings, type Preview, type RouteResult, type NeuralState, type Settings, type Speaker } from './shared'

const isWin = holo.platform === 'win32'

// ---------------------------------------------------------------- settings

const DEFAULTS: Settings = {
  lanes: {
    mic: { enabled: true, effect: 'demon', amount: 100, gate: -50, gain: 100, quality: 'hq', fx: {} },
    // computer audio isn't captured by default — until it is turned on
    sys: { enabled: false, effect: 'hologram_classic', amount: 100, gate: -80, gain: 100, quality: 'hq', fx: {} },
  },
  mic: 'default', out: '', monitor: false, monitorVol: 70, speaker: 'neutral', custom: [],
}
const KEY = 'holovoice.settings.v2'
function loadSettings(): Settings {
  const text = localStorage.getItem(KEY)
  let raw: Partial<Settings> = {}
  try {
    raw = JSON.parse(text || '{}') ?? {}
    if (typeof raw !== 'object') raw = {}
  } catch (e) {
    // unreadable: keep a copy before anything overwrites it (custom effects can be recovered from it)
    console.error('settings unreadable, starting with defaults:', e)
    try { localStorage.setItem(`${KEY}.broken.${Date.now()}`, text ?? '') } catch { /* full */ }
  }
  // every part is checked on its own: one bad value must not reset everything (custom effects especially)
  try { setCustom(raw.custom) } catch (e) { console.error('custom effects:', e); setCustom([]) }
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
  const lane = (id: LaneId): LaneSettings => {
    const def = DEFAULTS.lanes[id]
    const r = (raw.lanes?.[id] ?? {}) as Partial<LaneSettings>
    // from older versions: extra keys are harmless, effects that no longer exist become "Clean"
    const l: LaneSettings = { ...def, ...r,
      enabled: typeof r.enabled === 'boolean' ? r.enabled : def.enabled,
      amount: num(r.amount, 0, 100, def.amount), gain: num(r.gain, 0, 200, def.gain), gate: num(r.gate, -80, -20, def.gate),
      quality: r.quality === 'fast' ? 'fast' : 'hq',
      fx: r.fx && typeof r.fx === 'object' ? r.fx : {} }
    if (typeof l.effect !== 'string' || !effectInfo(l.effect)) l.effect = 'clean'
    return l
  }
  const speaker = (['neutral', 'male', 'female'] as const).includes(raw.speaker as Speaker) ? raw.speaker! : 'neutral'
  const favorites = Array.isArray(raw.favorites) ? raw.favorites.filter((x) => typeof x === 'string' && !!effectInfo(x as EffectId)) : []
  return { ...DEFAULTS, ...raw, speaker, favorites, custom: customs(),
    monitorVol: num(raw.monitorVol, 0, 100, DEFAULTS.monitorVol), monitor: raw.monitor === true,
    mic: typeof raw.mic === 'string' ? raw.mic : 'default', out: typeof raw.out === 'string' ? raw.out : '',
    lanes: { mic: lane('mic'), sys: lane('sys') } }
}
const S = loadSettings()
const hint: Record<LaneId, Hint> = { mic: { html: '', warn: false }, sys: { html: '', warn: false } }
let mics: MediaDeviceInfo[] = []
let outs: MediaDeviceInfo[] = []
let ready = false
/** Neural voices (optional GPU mode): availability from main, sidecar status */
const neural: NeuralState = { available: false, gpu: '', status: 'off', latencyMs: 0, error: '' }

function publish(): void {
  try { localStorage.setItem(KEY, JSON.stringify(S)) } catch { /* not critical */ }
  const dev = (d: MediaDeviceInfo) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? t('dev.default') : d.deviceId.slice(0, 8)) })
  const effects = EFFECTS.filter((e) => !e.neural || neural.available).map((e) => e.id)
  const st: EngineState = { S, mics: mics.map(dev), outs: outs.map(dev), hint, ready, preview, neural, effects }
  holo.pushState(st)
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type SinkCtx = AudioContext & { setSinkId?: (id: string) => Promise<void> }
type SinkEl = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

// ---------------------------------------------------------------- lane

class Lane {
  readonly ctx: SinkCtx
  readonly inGain: GainNode
  // Input low cut: effects (low shelf, saturation) blow up DC offset and mic hum into a rumble
  readonly hpIn: BiquadFilterNode
  // Noise gate: during pauses effects blow up room noise into hiss
  readonly gate: GainNode
  readonly outGain: GainNode
  readonly hpOut: BiquadFilterNode
  readonly limiter: DynamicsCompressorNode // effects with saturation must not clip
  readonly anIn: AnalyserNode
  readonly anOut: AnalyserNode
  readonly tap: MediaStreamAudioDestinationNode // for self-monitoring
  stream: MediaStream | null = null
  src: MediaStreamAudioSourceNode | null = null
  /** Windows computer sound: PCM pushed from holo-sysaudio */
  feed: AudioWorkletNode | null = null
  /** neural voice: the mic goes out to the sidecar (nOut), the converted voice comes back (nIn → nGain) in place
   *  of the mic (direct); the two are crossfaded so switching never clicks or lets the real voice through */
  nOut: AudioWorkletNode | null = null
  nIn: AudioWorkletNode | null = null
  nGain: GainNode | null = null
  neuralOn = false
  private direct!: GainNode
  rig: VoiceRig | null = null
  /** voice pitch from the vocoder: current and average, Hz */
  f0: [number, number] = [0, 0]
  private loaded = false

  constructor(readonly id: LaneId) {
    // buffer: in "quality" 25 ms — headroom against clicks when the system is loaded; in "fast" — minimal (for games)
    const c = (this.ctx = new AudioContext({ latencyHint: S.lanes[id].quality === 'fast' ? 'interactive' : 0.025 }) as SinkCtx)
    this.inGain = c.createGain()
    this.gate = c.createGain()
    this.outGain = c.createGain()
    this.limiter = c.createDynamicsCompressor()
    this.anIn = c.createAnalyser()
    this.anOut = c.createAnalyser()
    this.tap = c.createMediaStreamDestination()
    this.hpIn = this.biquad('highpass', id === 'mic' ? 80 : 20)
    this.hpOut = this.biquad('highpass', 25)
    const L = this.limiter
    L.threshold.value = -3; L.knee.value = 0; L.ratio.value = 20; L.attack.value = 0.002; L.release.value = 0.1
    this.anIn.fftSize = 1024; this.anOut.fftSize = 1024 // ≈20 ms: for both the meter and the gate
    this.direct = c.createGain()
    this.inGain.connect(this.hpIn).connect(this.direct).connect(this.gate)
    this.hpIn.connect(this.anIn)
    this.outGain.connect(this.hpOut).connect(L)
    // Chromium's compressor adds automatic make-up gain ((1/fullRangeGain)^0.6 → +1.71 dB at -3 dB, 20:1):
    // take it back so "Clean" stays at the original level
    const makeup = c.createGain()
    makeup.gain.value = 10 ** (-0.6 * 3 * (1 - 1 / 20) / 20)
    L.connect(makeup)
    makeup.connect(this.ctx.destination)
    makeup.connect(this.anOut)
    makeup.connect(this.tap)
    this.outGain.gain.value = this.cfg.gain / 100
    this.runGate()
    // the output device failed (a Bluetooth speaker went away mid-play): bind the output again and keep going;
    // where the device is gone for good, the device refresh picks another one
    c.addEventListener('error', () => {
      console.warn(`${id}: audio device error — rebinding the output`)
      setTimeout(() => {
        this.setSink(this.sink || '').then(() => this.ctx.resume()).catch(() => {})
        refreshDevices()
      }, 500)
    })
  }

  get cfg(): LaneSettings { return S.lanes[this.id] }

  private biquad(type: BiquadFilterType, hz: number) {
    const f = this.ctx.createBiquadFilter()
    f.type = type; f.frequency.value = hz; f.Q.value = 0.7
    return f
  }

  setStream(stream: MediaStream | null): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.src?.disconnect()
    this.feed?.disconnect()
    this.feed = null
    this.stream = stream
    this.src = stream ? this.ctx.createMediaStreamSource(stream) : null
    this.src?.connect(this.inGain)
  }

  /** Input from pushed PCM chunks instead of a MediaStream (see "holo-feed" in the worklet) */
  async setFeed(): Promise<void> {
    this.setStream(null)
    await this.loadWorklet()
    this.feed = new AudioWorkletNode(this.ctx, 'holo-feed', { numberOfInputs: 0, outputChannelCount: [2] })
    this.feed.connect(this.inGain)
  }

  /** Stream the mic to the sidecar and buffer its answer (while it loads, too — so the switch finds it primed) */
  streamNeural(on: boolean): void {
    if (on === !!this.nOut || !this.loaded) return
    if (on) {
      const nOut = new AudioWorkletNode(this.ctx, 'holo-stream', { numberOfOutputs: 0 })
      nOut.port.onmessage = (e: MessageEvent) => holo.neuralIn(e.data as ArrayBuffer)
      // the sidecar paces its output by its input (steady 10 ms chunks), so a small jitter buffer is enough
      const nIn = new AudioWorkletNode(this.ctx, 'holo-feed',
        { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { channels: 1, start: 0.06, max: 0.3 } })
      const nGain = this.ctx.createGain()
      nGain.gain.value = 0
      this.hpIn.connect(nOut)
      nIn.connect(nGain).connect(this.gate)
      Object.assign(this, { nOut, nIn, nGain })
    } else {
      this.setNeural(false)
      const { nOut, nIn, nGain } = this
      this.nOut = this.nIn = this.nGain = null
      // after the crossfade back
      setTimeout(() => {
        if (nOut) { try { this.hpIn.disconnect(nOut) } catch { /* gone */ } nOut.port.onmessage = null }
        nIn?.disconnect(); nGain?.disconnect()
      }, 150)
    }
  }

  /** Crossfade between the real mic (direct) and the converted voice (20 ms) */
  setNeural(on: boolean): void {
    if (on && !this.nGain) return
    if (on === this.neuralOn) return
    this.neuralOn = on
    const t = this.ctx.currentTime
    for (const [g, v] of [[this.direct.gain, on ? 0 : 1], [this.nGain?.gain, on ? 1 : 0]] as [AudioParam | undefined, number][]) {
      if (!g) continue
      g.cancelScheduledValues(t)
      g.setTargetAtTime(v, t, 0.02)
    }
  }

  private async loadWorklet(): Promise<void> {
    if (this.loaded) return
    await this.ctx.audioWorklet.addModule(new URL('../../dist/dsp/worklet.js', location.href).href)
    this.loaded = true
  }

  /** Load the vocoder and build the chain (and rebuild it on quality change — with the same parameters, without a pause) */
  async makeRig(): Promise<void> {
    await this.loadWorklet()
    const fftSize = this.cfg.quality === 'fast' ? 1024 : 2048
    const rig = new VoiceRig(this.ctx, new AudioWorkletNode(this.ctx, 'holo-voice', { processorOptions: { fftSize } }))
    rig.voice.port.onmessage = (e: MessageEvent) => { this.f0 = [e.data.f0, e.data.avg] }
    const old = this.rig
    rig.apply(old?.current ?? NEUTRAL, 0)
    this.gate.connect(rig.input)
    rig.output.connect(this.outGain)
    if (old) { this.gate.disconnect(old.input); old.dispose() }
    this.rig = rig
  }

  /** What should be playing per the settings: the effect at strength amount, or the normal sound for a disabled lane */
  target(): FxParams {
    const c = this.cfg
    if (!c.enabled) return NEUTRAL
    if (this.id !== 'sys') {
      // a neural voice that isn't running (no GPU mode, still loading): its DSP counterpart meanwhile
      const g = effectInfo(c.effect)?.neural
      if (g && !this.neuralOn) { const fb = NEURAL_FALLBACK[g]; return effectTarget(fb, c.fx[fb], c.amount / 100, S.speaker) }
      return effectTarget(c.effect, c.fx[c.effect], c.amount / 100, S.speaker)
    }
    // computer sound: "Clean" means untouched (its preset is voice EQ/enhancement) plus only the user's own edits
    const fx = effectInfo(c.effect)?.neural ? NEURAL_FALLBACK[effectInfo(c.effect)!.neural!] : c.effect // no neural on this lane
    // per-effect level for this lane: untouched sound is the reference here (no compressor), not "Clean"
    return systemSoundTarget(fx, c.fx[fx], c.amount / 100)
  }

  /** Smoothly transition to the settings over seconds: fade-in, fade-out, switching between effects */
  /** when the current fade ends (ctx time): touching a knob mid-fade must not cut a 10 s fade to 50 ms */
  private rampEnd = 0

  update(seconds?: number): void {
    const now = this.ctx.currentTime
    if (seconds === undefined) seconds = Math.max(0.05, this.rampEnd - now)
    else this.rampEnd = now + seconds
    this.rig?.apply(this.target(), seconds)
    if (this.id === 'mic') previewFollow()
    // noticeable transition — show the fade bar (main decides whether it is enabled)
    if (seconds >= 0.15) holo.pushRamp({ lane: this.id, seconds, dir: this.cfg.enabled ? 'in' : 'out' })
  }

  rampIn(effect: EffectId = this.cfg.effect): number { return this.cfg.fx[effect]?.rampIn ?? 0 }
  rampOut(effect: EffectId = this.cfg.effect): number { return this.cfg.fx[effect]?.rampOut ?? 0 }

  /** id 'none' — render without playing anywhere (the chain, meters and self-monitoring keep working) */
  async setSink(id: string): Promise<boolean> {
    this.sink = id
    const sink = id === 'none' ? { type: 'none' } : id === 'default' ? '' : id
    try { await (this.ctx as unknown as { setSinkId?: (s: unknown) => Promise<void> }).setSinkId?.(sink); return true } catch (e) { console.warn('setSinkId', e); return false }
  }
  /** the output this lane should play to (re-applied after a device error) */
  private sink = ''

  level(which: 'in' | 'out', buf: Float32Array): number {
    const an = which === 'in' ? this.anIn : this.anOut
    an.getFloatTimeDomainData(buf)
    let s = 0
    for (const x of buf) s += x * x
    return 10 * Math.log10(s / buf.length + 1e-12)
  }

  /** Gate on the input level: opens in 5 ms, holds 250 ms after sound, closes in ~80 ms.
   *  A timer, not requestAnimationFrame — that doesn't run in a hidden window. */
  private runGate(): void {
    const buf = new Float32Array(this.anIn.fftSize)
    let lastLoud = 0
    let open = true
    setInterval(() => {
      const thr = this.cfg.gate
      let want = true
      // neural voice: the converted voice comes ~0.4 s after the mic — the sidecar gates silence itself
      if (thr > -80 && !this.neuralOn) {
        if (this.level('in', buf) > thr) lastLoud = performance.now()
        want = performance.now() - lastLoud < 250
      }
      if (want !== open) {
        open = want
        for (const g of [this.gate.gain, this.rig?.noiseGate.gain]) g?.setTargetAtTime(want ? 1 : 0, this.ctx.currentTime, want ? 0.005 : 0.03)
      }
    }, 10)
  }
}

const lanes: Record<LaneId, Lane> = { mic: new Lane('mic'), sys: new Lane('sys') }
// diagnostics from DevTools (and the Windows CI test): window.__hv.lanes.sys.rig.current, .ctx.state, .stream, handle(cmd) …
;(window as unknown as { __hv: unknown }).__hv = { lanes, handle, get S() { return S }, get sysHint() { return hint.sys }, get neural() { return neural } }

// ---------------------------------------------------------------- test with a recording

const preview: Preview = { recording: false, ready: false, playing: false, seconds: 0 }
const REC_SECONDS = 6
let recBuffer: AudioBuffer | null = null
let tap: AudioWorkletNode | null = null
let pv: { ctx: SinkCtx; rig: VoiceRig; src: AudioBufferSourceNode | null } | null = null
let pvInit: Promise<void> | null = null

/** The "My voice" lane effect — the selected one, even if the lane is off: that's the one they want to hear */
function previewTarget(): FxParams {
  const c = S.lanes.mic
  const g = effectInfo(c.effect)?.neural
  const fx = g ? NEURAL_FALLBACK[g] : c.effect // the recording test runs the DSP chain only
  return effectTarget(fx, c.fx[fx], c.amount / 100, S.speaker)
}
function previewFollow(): void { pv?.rig.apply(previewTarget(), 0.05) }

async function startRecording(): Promise<void> {
  if (preview.recording) return
  stopPreview()
  const lane = lanes.mic
  if (!tap) {
    tap = new AudioWorkletNode(lane.ctx, 'holo-tap')
    lane.hpIn.connect(tap) // before the noise gate and effect — a clean recording
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const data = e.data
      preview.recording = false
      if (data.length > lane.ctx.sampleRate * 0.3) {
        recBuffer = new AudioBuffer({ length: data.length, sampleRate: lane.ctx.sampleRate, numberOfChannels: 1 })
        recBuffer.copyToChannel(data, 0)
        preview.ready = true
        preview.seconds = data.length / lane.ctx.sampleRate
        playPreview()
      }
      publish()
    }
  }
  preview.recording = true
  tap.port.postMessage({ start: REC_SECONDS })
  // a dead microphone never fills the buffer: stop by the clock too
  setTimeout(() => { if (preview.recording) tap?.port.postMessage({ stop: true }) }, (REC_SECONDS + 1) * 1000)
  publish()
}

async function playPreview(): Promise<void> {
  if (!recBuffer) return
  stopPreview()
  // one context, created once even if "play" is pressed twice quickly
  pvInit ??= (async () => {
    const ctx = new AudioContext({ latencyHint: 'interactive' }) as SinkCtx
    await ctx.audioWorklet.addModule(new URL('../../dist/dsp/worklet.js', location.href).href)
    const rig = new VoiceRig(ctx, new AudioWorkletNode(ctx, 'holo-voice', { processorOptions: { fftSize: 2048 } }))
    const lim = ctx.createDynamicsCompressor()
    lim.threshold.value = -3; lim.ratio.value = 20; lim.attack.value = 0.002
    rig.output.connect(lim).connect(ctx.destination)
    pv = { ctx, rig, src: null }
  })()
  await pvInit
  if (!pv) return
  // to the headphones: while computer audio is captured the default output is ours, so set the real one explicitly
  try { await pv.ctx.setSinkId?.(realOutId) } catch { /* default */ }
  await pv.ctx.resume()
  pv.rig.apply(previewTarget(), 0)
  const src = pv.ctx.createBufferSource()
  src.buffer = recBuffer
  src.connect(pv.rig.input)
  src.onended = () => { if (pv?.src === src) { pv.src = null; preview.playing = false; publish(); idlePreview() } }
  src.start()
  pv.src = src
  preview.playing = true
  publish()
}

function stopPreview(): void {
  if (preview.recording) tap?.port.postMessage({ stop: true })
  if (pv?.src) { const s = pv.src; pv.src = null; try { s.stop() } catch { /* already */ } }
  preview.playing = false
  idlePreview()
}
/** The test chain is a full third DSP chain and keeps the headphones' stream open: sleep when not playing */
function idlePreview(): void {
  setTimeout(() => { if (pv && !pv.src) pv.ctx.suspend().catch(() => {}) }, 300)
}

// ---------------------------------------------------------------- devices

let micRoute: RouteResult = { ok: false, platform: holo.platform }
let realOutId = '' // the real headphones/speakers (on Linux, while capturing, the default output is ours)

const isVirtualOut = (label: string) => /HoloVoice|CABLE Input|VB-Audio|Virtual Cable|VoiceMeeter Input/i.test(label)
const isVirtualIn = (label: string) => /HoloVoice|Monitor of|CABLE Output|VoiceMeeter Out/i.test(label)
const isAlias = (d: MediaDeviceInfo) => d.deviceId === 'default' || d.deviceId === 'communications'

/** VB-Cable's installer often makes the cable the system default: the default playback "CABLE Input" means the
 *  user hears nothing at all; the default recording "CABLE Output" would make us listen to our own output. */
let defaultInVirtual = false
let defaultOutVirtual = false

async function listDevices(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices()
  mics = all.filter((d) => d.kind === 'audioinput' && !isVirtualIn(d.label))
  outs = all.filter((d) => d.kind === 'audiooutput' && !/HoloVoice-speaker/.test(d.label))
  const def = (kind: MediaDeviceKind) => all.find((d) => d.kind === kind && d.deviceId === 'default')?.label ?? ''
  defaultInVirtual = /CABLE Output|VoiceMeeter Out|HoloVoice/i.test(def('audioinput'))
  defaultOutVirtual = isWin && /CABLE Input|VoiceMeeter Input/i.test(def('audiooutput'))
  return all
}

/** New devices (our null sinks) don't show up in the list immediately — wait. */
async function findDevice(kind: MediaDeviceKind, test: (label: string) => boolean, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const d = (await listDevices()).find((x) => x.kind === kind && !isAlias(x) && test(x.label))
    if (d) return d
    if (i < tries - 1) await sleep(200)
  }
  return undefined
}

let micError = '' // the last failure to open the microphone (shown in the hint until it opens again)

/** S.mic is the user's choice and is kept even while that mic is unplugged; activeMic is what is open now */
let activeMic = ''
const wantedMic = () => {
  if (S.mic && S.mic !== 'default' && mics.some((d) => d.deviceId === S.mic)) return S.mic
  // the system's default input is the virtual cable itself: take the first real microphone instead
  if (defaultInVirtual) return mics.find((d) => !isAlias(d))?.deviceId ?? 'default'
  return 'default'
}

async function openMic(): Promise<void> {
  const audio: MediaTrackConstraints = {
    echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1,
  }
  let id = mics.length ? wantedMic() : S.mic || 'default'
  if (id !== 'default') audio.deviceId = { exact: id }
  let stream: MediaStream
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio })
    } catch (e) {
      if ((e as Error)?.name === 'NotAllowedError') throw e // a different device won't help
      // fall back for now — without forgetting the choice (it comes back when that mic is available again)
      id = 'default'
      delete audio.deviceId
      stream = await navigator.mediaDevices.getUserMedia({ audio })
    }
  } catch (e) {
    micError = (e as Error)?.name || String(e)
    console.error('microphone:', e)
    updateMicHint()
    throw e
  }
  micError = ''
  activeMic = id
  // unplugged (or taken away by the system): try again shortly — a replugged USB mic keeps its id
  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    console.warn('microphone track ended')
    setTimeout(() => { openMic().then(() => { updateMicHint(); publish() }).catch(() => publish()) }, 1500)
  })
  lanes.mic.setStream(stream)
}

/** Plain-language microphone errors with a way out */
function micErrorHint(name: string): string {
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return t('err.micDenied') + (isWin ? ` <a data-href="ms-settings:privacy-microphone">${t('err.micSettings')}</a>` : '')
  }
  if (name === 'NotReadableError' || name === 'AbortError') return t('err.micBusy')
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return t('err.micNone')
  return t('err.start', { err: esc(name) })
}

/** The virtual microphone's input side: HoloVoice-feed on Linux, CABLE Input (VB-Cable) etc. on Windows */
function virtualOut(): MediaDeviceInfo | undefined {
  return outs.find((d) => (micRoute.ok && micRoute.sinkLabel ? d.label === micRoute.sinkLabel : isVirtualOut(d.label)))
}
const outLabelOf = (id: string) => outs.find((d) => d.deviceId === id)?.label ?? ''
/** Where "My voice" actually plays: the virtual mic, or an output the user chose — never speakers by itself
 *  (a laptop mic next to its speakers howls; the user hears himself via "Hear myself" instead). */
let micSink = ''
async function applyMicOut(): Promise<void> {
  const target = isVirtualOut(outLabelOf(S.out)) || S.outManual ? S.out : 'none'
  if (target === micSink) return
  // remembered only when it worked — a failed switch is retried on the next refresh
  micSink = (await lanes.mic.setSink(target)) ? target : ''
}

let rerouteAt = 0
/** One refresh at a time: the poll, devicechange, resume and track 'ended' can all ask at once */
let refreshing: Promise<void> = Promise.resolve()
function refreshDevices(): Promise<void> {
  refreshing = refreshing.then(doRefreshDevices, doRefreshDevices)
  return refreshing
}
async function doRefreshDevices(): Promise<void> {
  await listDevices()
  const pick = (items: MediaDeviceInfo[], v: string) => (items.some((d) => d.deviceId === v) ? v : items[0]?.deviceId ?? 'default')
  const dead = lanes.mic.stream?.getAudioTracks()[0]?.readyState !== 'live'
  if (wantedMic() !== activeMic || dead || micError) await openMic().catch(() => {})
  // Linux: PipeWire restarted (update, resume) and took the HoloVoice sink with it — create it again
  if (holo.platform === 'linux' && micRoute.ok && micRoute.sinkLabel && !outs.some((d) => d.label === micRoute.sinkLabel)
    && Date.now() - rerouteAt > 10000) {
    rerouteAt = Date.now()
    console.warn('virtual microphone gone — recreating')
    micRoute = await holo.routeMic()
    if (micRoute.ok && micRoute.sinkLabel) await findDevice('audiooutput', (l) => l === micRoute.sinkLabel)
    micSink = '' // the new sink has the same id but is a new device: bind again
  }
  // a virtual cable that appears (VB-Cable just installed, PipeWire restarted) is taken at once — no restart needed
  const virt = virtualOut()
  if (virt && !S.outManual) S.out = virt.deviceId
  else S.out = pick(outs, S.out)
  await applyMicOut()
  updateMicHint()
  publish()
}

/** Placeholder for the lane's on/off hotkey: the controllers fill it from the current bindings (the engine doesn't know them) */
const HK = (lane: LaneId) => `<b data-hk="${lane}:toggle"></b>`

function updateMicHint(): void {
  const outLabel = outLabelOf(S.out)
  if (micError) {
    hint.mic = { warn: true, html: micErrorHint(micError) }
  } else if (defaultOutVirtual) {
    hint.mic = { warn: true, html: `${t('hint.cableDefault')} <a data-href="ms-settings:sound">${t('err.micSettings')}</a>` }
  } else if (isVirtualOut(outLabel)) {
    const mic = /HoloVoice/.test(outLabel) ? 'HoloVoice-Microphone'
      : /CABLE/.test(outLabel) ? 'CABLE Output (VB-Audio Virtual Cable)' : t('hint.cableOut')
    hint.mic = { warn: false, html: t('hint.micOk', { mic, key: HK('mic') }) }
  } else if (isWin && !outs.some((d) => /CABLE Input/i.test(d.label))) {
    hint.mic = { warn: true, html: t('hint.noCable') }
  } else if (holo.platform === 'linux' && !micRoute.ok) {
    hint.mic = { warn: true, html: t('hint.routeFail', { err: esc(micRoute.error ?? ''), out: esc(outLabel) }) }
  } else if (S.outManual) {
    hint.mic = { warn: true, html: t('hint.local', { out: esc(outLabel || t('dev.default')) }) }
  } else {
    hint.mic = { warn: true, html: t('hint.noVirtual') }
  }
}

function updateSysHint(err = ''): void {
  if (err) { hint.sys = { warn: true, html: t('hint.sysFail', { err: esc(err) }) }; return }
  hint.sys = { warn: false, html: S.lanes.sys.enabled
    ? t('hint.sysOn', { key: HK('sys') })
    : t('hint.sysOff') }
}

// ---------------------------------------------------------------- computer audio

// Enabling/disabling capture takes up to a couple of seconds; the hotkey may be pressed again before that.
// So the desired state is stored, and a loop brings the actual state to it — no keypress is lost.
let sysBusy = false
let sysActive = false
let sysWanted = false
async function setSys(on: boolean): Promise<void> {
  sysWanted = on
  if (sysBusy) return
  sysBusy = true
  try {
    while (sysActive !== sysWanted) await applySys(sysWanted)
  } finally {
    sysBusy = false
    await applyMonitor()
    publish()
  }
}

async function applySys(on: boolean): Promise<void> {
  const lane = lanes.sys
  if (!on) {
    sysActive = false // first: a toggle-on arriving during the release must queue a new start
    lane.setStream(null)
    await holo.routeSys(false)
    await lane.ctx.suspend()
    realOutId = ''
    updateSysHint()
    return
  }
  try {
    let stream: MediaStream | null = null
    if (isWin) {
      // holo-sysaudio captures every app except us and turns them down; PCM arrives via onSysAudio
      await lane.setSink('')
      await lane.setFeed()
      const r = await holo.routeSys(true, lane.ctx.sampleRate)
      if (!r.ok) throw new Error(r.error ?? 'holo-sysaudio')
    } else {
      const r = await holo.routeSys(true)
      if (!r.ok) throw new Error(r.error ?? 'pactl')
      const cap = await findDevice('audioinput', (l) => l === r.monitorLabel)
      const real = await findDevice('audiooutput', (l) => l === r.realSinkLabel, 10)
      if (!cap) throw new Error('capture input not found')
      if (!real) throw new Error(`output "${r.realSinkLabel}" not found`)
      realOutId = real.deviceId
      await lane.setSink(realOutId)
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: { exact: cap.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: 2,
      } })
      // the capture device vanished (PipeWire restarted, resume): set the interception up again
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (!sysActive) return
        console.warn('computer-sound capture ended — restarting it')
        setSys(false).then(() => { if (S.lanes.sys.enabled) return setSys(true) }).catch(() => {})
      })
    }
    lane.rig?.apply(NEUTRAL, 0) // captured audio starts as is — then the effect fades in
    if (stream) lane.setStream(stream)
    await lane.ctx.resume()
    lane.update(lane.rampIn())
    sysActive = true
    updateSysHint()
  } catch (e) {
    S.lanes.sys.enabled = false
    sysWanted = false
    sysActive = false
    lane.setStream(null)
    await holo.routeSys(false).catch(() => {})
    updateSysHint(String((e as Error)?.message ?? e))
  }
}

if (isWin) {
  holo.onSysAudio((pcm) => {
    const buf = pcm.slice().buffer // own, aligned copy for Float32Array
    lanes.sys.feed?.port.postMessage(buf, [buf])
  })
  // the helper stopped by itself: same as a failed start
  holo.onSysEnd((error) => {
    if (!sysActive) return
    S.lanes.sys.enabled = false
    sysWanted = false
    sysActive = false
    lanes.sys.setStream(null)
    lanes.sys.ctx.suspend().catch(() => {})
    updateSysHint(error)
    publish()
  })
}

// Linux: a speaker/headphones connected (or the output was switched) while computer sound is captured
holo.onRealSink(async ({ realSinkLabel }) => {
  if (!sysActive) return
  const real = await findDevice('audiooutput', (l) => l === realSinkLabel, 25)
  if (!real || real.deviceId === realOutId) return
  realOutId = real.deviceId
  await lanes.sys.setSink(realOutId)
  await applyMonitor()
  if (pv) try { await pv.ctx.setSinkId?.(realOutId) } catch { /* default */ }
})

// ---------------------------------------------------------------- neural voices

let neuralGender: string | null = null // the voice file the sidecar runs (or is loading): female, female2, male…
let neuralStopTimer = 0
let neuralOffTimer = 0

/** Switch between the converted voice and the DSP fallback: parameters and audio path change together */
function neuralSwitch(on: boolean): void {
  const lane = lanes.mic
  if (on === lane.neuralOn) return
  lane.setNeural(on)
  lane.update(0.02)
}

/** Bring the sidecar in line with the "My voice" lane: started for a neural effect, stopped a while after leaving it */
async function syncNeural(): Promise<void> {
  const c = S.lanes.mic
  // the voice: the effect's chosen timbre (its style id names the voice file), else the plain gender voice
  const g = effectInfo(c.effect)?.neural
  const want = neural.available && c.enabled && g ? (effectVariant(c.effect, c.fx[c.effect])?.id ?? g) : null
  if (want) {
    clearTimeout(neuralOffTimer)
    clearTimeout(neuralStopTimer)
    neuralStopTimer = 0
    lanes.mic.streamNeural(true)
    if (neural.status === 'ready' && want === neuralGender) neuralSwitch(true)
    if (want === neuralGender && neural.status !== 'error' && neural.status !== 'off') return
    neuralGender = want
    if (neural.status === 'off' || neural.status === 'error') { neural.status = 'loading'; neural.error = '' }
    publish()
    const r = await holo.neuralStart(want, lanes.mic.ctx.sampleRate)
    if (!r.ok) { neural.status = 'error'; neural.error = r.error ?? ''; neuralGender = null; publish() }
    return
  }
  // leaving the neural voice: a lane being turned off fades out ON the neural voice first
  if (lanes.mic.neuralOn) {
    clearTimeout(neuralOffTimer)
    const wait = S.lanes.mic.enabled ? 0 : lanes.mic.rampOut() * 1000 + 50
    neuralOffTimer = window.setTimeout(() => {
      if (effectInfo(S.lanes.mic.effect)?.neural && S.lanes.mic.enabled) return
      neuralSwitch(false)
      lanes.mic.streamNeural(false)
    }, wait)
  } else lanes.mic.streamNeural(false)
  if (neural.status === 'off' || neuralStopTimer) return
  // keep the model loaded for a minute: switching back is then instant
  neuralStopTimer = window.setTimeout(() => {
    neuralStopTimer = 0
    if (effectInfo(S.lanes.mic.effect)?.neural && S.lanes.mic.enabled) return
    holo.neuralStop()
    neural.status = 'off'
    neuralGender = null
    publish()
  }, 60000)
}

holo.onNeuralAudio((pcm) => {
  const buf = pcm.slice().buffer
  lanes.mic.nIn?.port.postMessage(buf, [buf])
})
holo.onNeuralStatus((e) => {
  const lane = lanes.mic
  if (e.event === 'loading') neural.status = 'loading'
  else if (e.event === 'ready') {
    neural.status = 'ready'
    neural.latencyMs = e.latency_ms ?? 0
    if (e.device) neural.gpu ||= e.device
  } else if (e.event === 'error') { neural.status = 'error'; neural.error = e.message ?? '' }
  else if (e.event === 'exit') {
    if (neural.status !== 'error') neural.status = 'off'
    neuralGender = null
  } else return // stats
  const on = neural.status === 'ready' && !!effectInfo(S.lanes.mic.effect)?.neural && S.lanes.mic.enabled
  if (on !== lane.neuralOn) neuralSwitch(on)
  if (neural.status === 'off' || neural.status === 'error') lane.streamNeural(false)
  publish()
})

// ---------------------------------------------------------------- self-monitoring

const monAudio = new Audio() as SinkEl
monAudio.srcObject = lanes.mic.tap.stream
async function applyMonitor(): Promise<void> {
  monAudio.volume = S.monitorVol / 100
  if (S.monitor) {
    await monAudio.setSinkId?.(realOutId).catch(() => {})
    await monAudio.play().catch(() => {})
  } else {
    monAudio.pause()
  }
}

// ---------------------------------------------------------------- controller commands

// Turning off computer audio waits for the effect to fade out, and only then releases the capture
let sysOffTimer = 0

/** state before a held hotkey, restored on release */
const held: Partial<Record<LaneId, { enabled: boolean; effect: EffectId }>> = {}

async function handle(c: Cmd): Promise<void> {
  switch (c.type) {
    case 'toggle': {
      const cfg = S.lanes[c.lane]
      const lane = lanes[c.lane]
      const on = c.on ?? !cfg.enabled
      if (on === cfg.enabled) break
      cfg.enabled = on
      if (c.lane === 'mic') { lane.update(on ? lane.rampIn() : lane.rampOut()); break }
      clearTimeout(sysOffTimer)
      updateSysHint(); publish()
      if (on) {
        if (sysActive) lane.update(lane.rampIn()) // hasn't turned off yet — just fade back in
        await setSys(true) // always through the queue: a release may be in progress right now
      } else {
        const t = lane.rampOut()
        lane.update(t)
        sysOffTimer = window.setTimeout(() => { if (!S.lanes.sys.enabled) setSys(false) }, t * 1000 + 50)
      }
      break
    }
    case 'effect': {
      const cfg = S.lanes[c.lane]
      cfg.effect = c.effect
      // if enabled — crossfades into the new effect over its fade-in time
      if (cfg.enabled) lanes[c.lane].update(lanes[c.lane].rampIn())
      else return handle({ type: 'toggle', lane: c.lane, on: true })
      break
    }
    case 'hotkey': {
      const cfg = S.lanes[c.lane]
      if (c.action === 'toggle') return handle({ type: 'toggle', lane: c.lane })
      if (c.action === 'next' || c.action === 'prev') {
        let list = allEffects().filter((e) => !e.neural || (neural.available && c.lane === 'mic') || e.id === cfg.effect)
        // with two or more favorites, next/previous walks through them only
        const fav = list.filter((e) => S.favorites?.includes(e.id))
        if (fav.length >= 2) list = fav.some((e) => e.id === cfg.effect) ? fav : [...fav, ...list.filter((e) => e.id === cfg.effect)]
        const i = list.findIndex((e) => e.id === cfg.effect)
        const n = list.length
        const next = list[(i + (c.action === 'next' ? 1 : n - 1)) % n].id
        return handle({ type: 'effect', lane: c.lane, effect: next })
      }
      if (!effectInfo(c.action)) break
      // same shortcut for the enabled effect — turn it off: "press to turn on, press again to turn off"
      if (cfg.enabled && cfg.effect === c.action) return handle({ type: 'toggle', lane: c.lane, on: false })
      return handle({ type: 'effect', lane: c.lane, effect: c.action as EffectId })
    }
    case 'hold': {
      const cfg = S.lanes[c.lane]
      if (c.down) {
        held[c.lane] ??= { enabled: cfg.enabled, effect: cfg.effect }
        if (c.action === 'toggle') return handle({ type: 'toggle', lane: c.lane, on: !held[c.lane]!.enabled })
        if (c.action === 'next' || c.action === 'prev') return handle({ type: 'hotkey', lane: c.lane, action: c.action })
        if (!effectInfo(c.action)) break
        return handle({ type: 'effect', lane: c.lane, effect: c.action as EffectId })
      }
      const before = held[c.lane]
      held[c.lane] = undefined
      if (!before) break
      if (!before.enabled) {
        await handle({ type: 'toggle', lane: c.lane, on: false })
        cfg.effect = before.effect // fading out goes to neutral anyway; the selection comes back as it was
        break
      }
      if (cfg.effect !== before.effect) return handle({ type: 'effect', lane: c.lane, effect: before.effect })
      if (!cfg.enabled) return handle({ type: 'toggle', lane: c.lane, on: true })
      break
    }
    case 'set':
      S.lanes[c.lane][c.key] = c.value
      if (c.key === 'gain') lanes[c.lane].outGain.gain.setTargetAtTime(c.value / 100, lanes[c.lane].ctx.currentTime, 0.02)
      else if (c.key === 'amount') lanes[c.lane].update()
      break
    case 'fxParam': {
      const cfg = S.lanes[c.lane]
      const u = (cfg.fx[c.effect] ??= {})
      ;(u.p ??= {})[c.key] = c.value
      if (cfg.effect === c.effect) lanes[c.lane].update()
      break
    }
    case 'fxRamp': (S.lanes[c.lane].fx[c.effect] ??= {})[c.which] = Math.max(0, Math.min(30, c.value)); break
    case 'fxReset':
      delete S.lanes[c.lane].fx[c.effect]
      if (S.lanes[c.lane].effect === c.effect) lanes[c.lane].update()
      break
    case 'quality':
      // the buffer size is set when the AudioContext is created — restart the engine (routing survives this)
      S.lanes[c.lane].quality = c.value
      publish()
      setTimeout(() => location.reload(), 100)
      return
    case 'customSave': {
      // a snapshot of what's playing now (preset + tweaks) under a custom name; the lane switches to it immediately
      const cfg = S.lanes[c.lane]
      const src = cfg.effect
      const id = `c-${Date.now().toString(36)}` as const
      const base: BuiltinId = isCustom(src) ? (S.custom.find((x) => x.id === src)?.base ?? 'clean') : src
      S.custom.push({ id, name: c.name.trim().slice(0, 40) || id, icon: c.icon || 'star', base, preset: effectFull(src, cfg.fx[src]) })
      setCustom(S.custom)
      cfg.fx[id] = { rampIn: cfg.fx[src]?.rampIn, rampOut: cfg.fx[src]?.rampOut }
      cfg.effect = id
      if (cfg.enabled) lanes[c.lane].update()
      break
    }
    case 'customDelete': {
      S.custom = S.custom.filter((x) => x.id !== c.id)
      S.favorites = (S.favorites ?? []).filter((x) => x !== c.id)
      setCustom(S.custom)
      for (const id of ['mic', 'sys'] as LaneId[]) {
        const cfg = S.lanes[id]
        delete cfg.fx[c.id]
        if (cfg.effect === c.id) { cfg.effect = 'clean'; lanes[id].update() }
      }
      break
    }
    case 'customRestore': {
      if (!S.custom.some((x) => x.id === c.effect.id)) S.custom.push(c.effect)
      setCustom(S.custom)
      break
    }
    case 'fxRestore': {
      if (c.user) S.lanes[c.lane].fx[c.effect] = c.user
      else delete S.lanes[c.lane].fx[c.effect]
      if (S.lanes[c.lane].effect === c.effect) lanes[c.lane].update()
      break
    }
    case 'fxVariant': {
      const cfg = S.lanes[c.lane]
      const u = (cfg.fx[c.effect] ??= {})
      u.variant = c.variant
      delete u.p // the knobs mean something else in another style
      if (cfg.effect === c.effect) lanes[c.lane].update(lanes[c.lane].rampIn())
      break
    }
    case 'favorite': {
      const fav = new Set(S.favorites ?? [])
      if (fav.has(c.id)) fav.delete(c.id); else fav.add(c.id)
      S.favorites = [...fav]
      break
    }
    case 'record': await startRecording(); return
    case 'play': await playPreview(); return
    case 'stopPreview': stopPreview(); break
    case 'mic': S.mic = c.id; await openMic().catch(() => {}); updateMicHint(); break
    case 'out': S.out = c.id; S.outManual = !isVirtualOut(outLabelOf(c.id)); await applyMicOut(); updateMicHint(); break
    case 'monitor': S.monitor = c.on; await applyMonitor(); break
    case 'monitorVol': S.monitorVol = c.value; await applyMonitor(); break
    case 'speaker': S.speaker = c.value; lanes.mic.update(); previewFollow(); break
  }
  publish()
}

// ---------------------------------------------------------------- startup

async function main(): Promise<void> {
  setLang((await holo.getUi()).lang)
  holo.onLang((code) => { setLang(code); updateMicHint(); updateSysHint(); publish() })
  holo.onCmd((c) => { handle(c).then(() => syncNeural()).catch((e) => console.error(e)) })
  updateSysHint()
  // effect chains first: a missing or broken microphone must not take the computer-sound lane down with it
  await lanes.mic.makeRig()
  await lanes.sys.makeRig()
  // my voice: microphone (also grants permission to see device names), virtual output
  try { await openMic() } catch { /* micError is set; the hint explains it */ }
  micRoute = await holo.routeMic()
  // the HoloVoice sink may take a moment to show up in the device list
  if (micRoute.ok && micRoute.sinkLabel) await findDevice('audiooutput', (l) => l === micRoute.sinkLabel)
  // At startup the voice goes to the virtual microphone if there is one (the null sink id changes between runs)
  if (virtualOut()) S.outManual = false
  await refreshDevices()
  lanes.mic.update(0) // at startup — immediately, no fade-in or bar
  await lanes.mic.ctx.resume()

  // computer audio — if it was on last time
  if (S.lanes.sys.enabled) await setSys(true)
  else await lanes.sys.ctx.suspend()
  await applyMonitor()
  ready = true
  publish()
  // neural voices: only with the optional GPU install (checking imports torch — a few seconds, in the background)
  holo.neuralCheck().then((r) => {
    const ids = r.voices.map((v) => v.id)
    neural.available = r.ok && !!r.cuda && ids.some((v) => v.startsWith('female')) && ids.some((v) => v.startsWith('male'))
    neural.gpu = r.gpu ?? ''
    if (!neural.available) neural.error = r.error ?? ''
    publish()
    return syncNeural()
  }).catch(() => {})

  navigator.mediaDevices.addEventListener('devicechange', () => { refreshDevices() })
  // a context the system suspended (device switch, audio server hiccup) is woken up while it should run
  lanes.mic.ctx.addEventListener('statechange', () => { if (lanes.mic.ctx.state === 'suspended') lanes.mic.ctx.resume().catch(() => {}) })
  lanes.sys.ctx.addEventListener('statechange', () => {
    if (lanes.sys.ctx.state === 'suspended' && sysActive && !sysBusy) lanes.sys.ctx.resume().catch(() => {})
  })
  // after sleep: contexts may be suspended, devices re-enumerated
  holo.onResume(() => {
    console.log('resumed from sleep')
    lanes.mic.ctx.resume().catch(() => {})
    if (sysActive) lanes.sys.ctx.resume().catch(() => {})
    setTimeout(() => refreshDevices(), 1500)
  })
  // devicechange doesn't fire in the hidden engine window — otherwise a connected headset goes unseen: re-check the list every 3 s
  let devSig = ''
  setInterval(async () => {
    const sig = (await navigator.mediaDevices.enumerateDevices()).map((d) => d.kind + d.deviceId + d.label).join('|')
    if (devSig && sig !== devSig) refreshDevices()
    devSig = sig
  }, 3000)
  // level meters for the controllers, 20 times per second
  const buf = new Float32Array(1024)
  const pct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
  setInterval(() => {
    holo.pushLevels({
      mic: [pct(lanes.mic.level('in', buf)), pct(lanes.mic.level('out', buf))],
      sys: [pct(lanes.sys.level('in', buf)), pct(lanes.sys.level('out', buf))],
      f0: { mic: lanes.mic.f0, sys: lanes.sys.f0 },
    })
  }, 50)
}

main().catch((e) => {
  hint.mic = { warn: true, html: t('err.start', { err: esc(String(e?.message ?? e)) }) }
  ready = true
  publish()
  console.error(e)
})
