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
import { NEURAL_FALLBACK, NEUTRAL, allEffects, effectFull, effectInfo, effectTarget, forSystemSound, interpolate, isCustom, isNeural, setCustom, type BuiltinId, type EffectId, type FxParams } from './effects'
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
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Settings>
    setCustom(raw.custom) // custom effects — before validating the lanes: a lane may use a custom effect
    const lane = (id: LaneId): LaneSettings => {
      // from older versions: extra keys (strength, pitch, space) are harmless, effects that no longer exist become "Clean"
      const l = { ...DEFAULTS.lanes[id], ...raw.lanes?.[id] }
      if (!effectInfo(l.effect)) l.effect = 'clean'
      l.fx ??= {}
      return l
    }
    const speaker = (['neutral', 'male', 'female'] as const).includes(raw.speaker as Speaker) ? raw.speaker! : 'neutral'
    return { ...DEFAULTS, ...raw, speaker, lanes: { mic: lane('mic'), sys: lane('sys') } }
  } catch { return structuredClone(DEFAULTS) }
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
  const st: EngineState = { S, mics: mics.map(dev), outs: outs.map(dev), hint, ready, preview, neural }
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
  /** neural voice: the mic goes out to the sidecar (nOut), the converted voice comes back (nIn) in place of the mic */
  nOut: AudioWorkletNode | null = null
  nIn: AudioWorkletNode | null = null
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
    this.inGain.connect(this.hpIn).connect(this.gate)
    this.hpIn.connect(this.anIn)
    this.outGain.connect(this.hpOut).connect(L)
    L.connect(this.ctx.destination)
    L.connect(this.anOut)
    L.connect(this.tap)
    this.outGain.gain.value = this.cfg.gain / 100
    this.runGate()
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

  /** Route the microphone through the neural voice sidecar (on) or straight into the chain (off) */
  setNeural(on: boolean): void {
    if (on === !!this.nIn || !this.loaded) return
    if (on) {
      const nOut = new AudioWorkletNode(this.ctx, 'holo-stream', { numberOfOutputs: 0 })
      nOut.port.onmessage = (e: MessageEvent) => holo.neuralIn(e.data as ArrayBuffer)
      // the sidecar answers in blocks (~180 ms): the buffer must hold more than one
      const nIn = new AudioWorkletNode(this.ctx, 'holo-feed',
        { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { channels: 1, start: 0.25, max: 0.8 } })
      this.hpIn.connect(nOut)
      this.hpIn.disconnect(this.gate)
      nIn.connect(this.gate)
      this.nOut = nOut
      this.nIn = nIn
    } else {
      if (this.nOut) { this.hpIn.disconnect(this.nOut); this.nOut.port.onmessage = null }
      this.nIn?.disconnect()
      this.nOut = this.nIn = null
      this.hpIn.connect(this.gate)
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
      if (g && !this.nIn) { const fb = NEURAL_FALLBACK[g]; return effectTarget(fb, c.fx[fb], c.amount / 100, S.speaker) }
      return effectTarget(c.effect, c.fx[c.effect], c.amount / 100, S.speaker)
    }
    // computer sound: "Clean" means untouched (its preset is voice EQ/enhancement) plus only the user's own edits
    const fx = effectInfo(c.effect)?.neural ? NEURAL_FALLBACK[effectInfo(c.effect)!.neural!] : c.effect // no neural on this lane
    const p = fx === 'clean'
      ? interpolate(NEUTRAL, { ...NEUTRAL, ...(c.fx.clean?.p ?? {}) }, c.amount / 100)
      : effectTarget(fx, c.fx[fx], c.amount / 100)
    return forSystemSound(p)
  }

  /** Smoothly transition to the settings over seconds: fade-in, fade-out, switching between effects */
  update(seconds = 0.05): void {
    this.rig?.apply(this.target(), seconds)
    if (this.id === 'mic') previewFollow()
    // noticeable transition — show the fade bar (main decides whether it is enabled)
    if (seconds >= 0.15) holo.pushRamp({ lane: this.id, seconds, dir: this.cfg.enabled ? 'in' : 'out' })
  }

  rampIn(effect: EffectId = this.cfg.effect): number { return this.cfg.fx[effect]?.rampIn ?? 0 }
  rampOut(effect: EffectId = this.cfg.effect): number { return this.cfg.fx[effect]?.rampOut ?? 0 }

  async setSink(id: string): Promise<void> {
    try { await this.ctx.setSinkId?.(id === 'default' ? '' : id) } catch (e) { console.warn('setSinkId', e) }
  }

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
      if (thr > -80 && !this.nIn) {
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
;(window as unknown as { __hv: unknown }).__hv = { lanes, handle, get S() { return S }, get sysHint() { return hint.sys } }

// ---------------------------------------------------------------- test with a recording

const preview: Preview = { recording: false, ready: false, playing: false, seconds: 0 }
const REC_SECONDS = 6
let recBuffer: AudioBuffer | null = null
let tap: AudioWorkletNode | null = null
let pv: { ctx: SinkCtx; rig: VoiceRig; src: AudioBufferSourceNode | null } | null = null

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
  publish()
}

async function playPreview(): Promise<void> {
  if (!recBuffer) return
  stopPreview()
  if (!pv) {
    const ctx = new AudioContext({ latencyHint: 'interactive' }) as SinkCtx
    await ctx.audioWorklet.addModule(new URL('../../dist/dsp/worklet.js', location.href).href)
    const rig = new VoiceRig(ctx, new AudioWorkletNode(ctx, 'holo-voice', { processorOptions: { fftSize: 2048 } }))
    const lim = ctx.createDynamicsCompressor()
    lim.threshold.value = -3; lim.ratio.value = 20; lim.attack.value = 0.002
    rig.output.connect(lim).connect(ctx.destination)
    pv = { ctx, rig, src: null }
  }
  // to the headphones: while computer audio is captured the default output is ours, so set the real one explicitly
  try { await pv.ctx.setSinkId?.(realOutId) } catch { /* default */ }
  await pv.ctx.resume()
  pv.rig.apply(previewTarget(), 0)
  const src = pv.ctx.createBufferSource()
  src.buffer = recBuffer
  src.connect(pv.rig.input)
  src.onended = () => { if (pv?.src === src) { pv.src = null; preview.playing = false; publish() } }
  src.start()
  pv.src = src
  preview.playing = true
  publish()
}

function stopPreview(): void {
  if (preview.recording) tap?.port.postMessage({ stop: true })
  if (pv?.src) { const s = pv.src; pv.src = null; try { s.stop() } catch { /* already */ } }
  preview.playing = false
}

// ---------------------------------------------------------------- devices

let micRoute: RouteResult = { ok: false, platform: holo.platform }
let realOutId = '' // the real headphones/speakers (on Linux, while capturing, the default output is ours)

const isVirtualOut = (label: string) => /HoloVoice|CABLE Input|VB-Audio|Virtual Cable|VoiceMeeter Input/i.test(label)
const isVirtualIn = (label: string) => /HoloVoice|Monitor of|CABLE Output|VoiceMeeter Out/i.test(label)
const isAlias = (d: MediaDeviceInfo) => d.deviceId === 'default' || d.deviceId === 'communications'

async function listDevices(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices()
  mics = all.filter((d) => d.kind === 'audioinput' && !isVirtualIn(d.label))
  outs = all.filter((d) => d.kind === 'audiooutput' && !/HoloVoice-speaker/.test(d.label))
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

async function openMic(): Promise<void> {
  const audio: MediaTrackConstraints = {
    echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1,
  }
  if (S.mic && S.mic !== 'default') audio.deviceId = { exact: S.mic }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio })
  } catch {
    S.mic = 'default'
    delete audio.deviceId
    stream = await navigator.mediaDevices.getUserMedia({ audio })
  }
  lanes.mic.setStream(stream)
}

async function refreshDevices(): Promise<void> {
  await listDevices()
  const pick = (items: MediaDeviceInfo[], v: string) => (items.some((d) => d.deviceId === v) ? v : items[0]?.deviceId ?? 'default')
  const mic = pick(mics, S.mic)
  const out = pick(outs, S.out)
  if (mic !== S.mic) { S.mic = mic; await openMic() }
  if (out !== S.out) { S.out = out; await lanes.mic.setSink(out) }
  updateMicHint()
  publish()
}

function updateMicHint(): void {
  const outLabel = outs.find((d) => d.deviceId === S.out)?.label ?? ''
  if (isVirtualOut(outLabel)) {
    const mic = /HoloVoice/.test(outLabel) ? 'HoloVoice-Microphone'
      : /CABLE/.test(outLabel) ? 'CABLE Output (VB-Audio Virtual Cable)' : t('hint.cableOut')
    hint.mic = { warn: false, html: t('hint.micOk', { mic }) }
  } else if (isWin && !outs.some((d) => /CABLE Input/i.test(d.label))) {
    hint.mic = { warn: true, html: t('hint.noCable') }
  } else if (holo.platform === 'linux' && !micRoute.ok) {
    hint.mic = { warn: true, html: t('hint.routeFail', { err: esc(micRoute.error ?? ''), out: esc(outLabel) }) }
  } else {
    hint.mic = { warn: true, html: t('hint.local', { out: esc(outLabel || t('dev.default')) }) }
  }
}

function updateSysHint(err = ''): void {
  if (err) { hint.sys = { warn: true, html: t('hint.sysFail', { err: esc(err) }) }; return }
  hint.sys = { warn: false, html: S.lanes.sys.enabled
    ? t('hint.sysOn') + (isWin ? `<br><i>${t('hint.sysWin')}</i>` : '')
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
    lane.setStream(null)
    await holo.routeSys(false)
    await lane.ctx.suspend()
    realOutId = ''
    sysActive = false
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

let neuralGender: 'female' | 'male' | null = null // the voice the sidecar runs (or is loading)
let neuralStopTimer = 0

/** Bring the sidecar in line with the "My voice" lane: started for a neural effect, stopped a while after leaving it */
async function syncNeural(): Promise<void> {
  const c = S.lanes.mic
  const want = neural.available && c.enabled ? effectInfo(c.effect)?.neural ?? null : null
  if (want) {
    clearTimeout(neuralStopTimer)
    if (want === neuralGender && neural.status !== 'error' && neural.status !== 'off') return
    neuralGender = want
    if (neural.status === 'off' || neural.status === 'error') { neural.status = 'loading'; neural.error = '' }
    publish()
    const r = await holo.neuralStart(want, lanes.mic.ctx.sampleRate)
    if (!r.ok) { neural.status = 'error'; neural.error = r.error ?? ''; neuralGender = null; publish() }
    return
  }
  lanes.mic.setNeural(false)
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
  if (on !== !!lane.nIn) { lane.setNeural(on); lane.update(0.3) }
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
        else await setSys(true)
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
        const list = allEffects().filter((e) => !e.neural || (neural.available && c.lane === 'mic') || e.id === cfg.effect)
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
      setCustom(S.custom)
      for (const id of ['mic', 'sys'] as LaneId[]) {
        const cfg = S.lanes[id]
        delete cfg.fx[c.id]
        if (cfg.effect === c.id) { cfg.effect = 'clean'; lanes[id].update() }
      }
      break
    }
    case 'record': await startRecording(); return
    case 'play': await playPreview(); return
    case 'stopPreview': stopPreview(); break
    case 'mic': S.mic = c.id; await openMic(); break
    case 'out': S.out = c.id; await lanes.mic.setSink(c.id); updateMicHint(); break
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
  let micError = ''
  try { await openMic() } catch (e) { micError = String((e as Error)?.message ?? e) }
  micRoute = await holo.routeMic()
  const virt = micRoute.ok && micRoute.sinkLabel
    ? await findDevice('audiooutput', (l) => l === micRoute.sinkLabel)
    : await findDevice('audiooutput', (l) => /CABLE Input/i.test(l), 1)
  // At startup the voice always goes to the virtual microphone, if present (the null sink id changes between runs)
  if (virt) S.out = virt.deviceId
  await lanes.mic.setSink(S.out)
  lanes.mic.update(0) // at startup — immediately, no fade-in or bar
  await refreshDevices()
  await lanes.mic.ctx.resume()

  // computer audio — if it was on last time
  if (S.lanes.sys.enabled) await setSys(true)
  else await lanes.sys.ctx.suspend()
  await applyMonitor()
  if (micError) hint.mic = { warn: true, html: t('err.start', { err: esc(micError) }) }
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
