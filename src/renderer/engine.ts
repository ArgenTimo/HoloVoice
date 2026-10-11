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
import { NEUTRAL, allEffects, effectFull, effectInfo, effectTarget, forSystemSound, interpolate, isCustom, setCustom, type BuiltinId, type EffectId, type FxParams } from './effects'
import { holo, type Cmd, type EngineState, type Hint, type LaneId, type LaneSettings, type Preview, type RouteResult, type Settings } from './shared'

const isWin = holo.platform === 'win32'

// ---------------------------------------------------------------- settings

const DEFAULTS: Settings = {
  lanes: {
    mic: { enabled: true, effect: 'demon', amount: 100, gate: -50, gain: 100, quality: 'hq', fx: {} },
    // computer audio isn't captured by default — until it is turned on
    sys: { enabled: false, effect: 'hologram_classic', amount: 100, gate: -80, gain: 100, quality: 'hq', fx: {} },
  },
  mic: 'default', out: '', monitor: false, monitorVol: 70, custom: [],
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
    return { ...DEFAULTS, ...raw, lanes: { mic: lane('mic'), sys: lane('sys') } }
  } catch { return structuredClone(DEFAULTS) }
}
const S = loadSettings()
const hint: Record<LaneId, Hint> = { mic: { html: '', warn: false }, sys: { html: '', warn: false } }
let mics: MediaDeviceInfo[] = []
let outs: MediaDeviceInfo[] = []
let ready = false

function publish(): void {
  try { localStorage.setItem(KEY, JSON.stringify(S)) } catch { /* not critical */ }
  const dev = (d: MediaDeviceInfo) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? t('dev.default') : d.deviceId.slice(0, 8)) })
  const st: EngineState = { S, mics: mics.map(dev), outs: outs.map(dev), hint, ready, preview }
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
    this.stream = stream
    this.src = stream ? this.ctx.createMediaStreamSource(stream) : null
    this.src?.connect(this.inGain)
  }

  /** Load the vocoder and build the chain (and rebuild it on quality change — with the same parameters, without a pause) */
  async makeRig(): Promise<void> {
    if (!this.loaded) {
      await this.ctx.audioWorklet.addModule(new URL('../../dist/dsp/worklet.js', location.href).href)
      this.loaded = true
    }
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
    if (this.id !== 'sys') return effectTarget(c.effect, c.fx[c.effect], c.amount / 100)
    // computer sound: "Clean" means untouched (its preset is voice EQ/enhancement) plus only the user's own edits
    const p = c.effect === 'clean'
      ? interpolate(NEUTRAL, { ...NEUTRAL, ...(c.fx.clean?.p ?? {}) }, c.amount / 100)
      : effectTarget(c.effect, c.fx[c.effect], c.amount / 100)
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
      if (thr > -80) {
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
// diagnostics from DevTools: window.__hv.lanes.sys.rig.current, .ctx.state, .stream …
;(window as unknown as { __hv: unknown }).__hv = { lanes, get S() { return S } }

// ---------------------------------------------------------------- test with a recording

const preview: Preview = { recording: false, ready: false, playing: false, seconds: 0 }
const REC_SECONDS = 6
let recBuffer: AudioBuffer | null = null
let tap: AudioWorkletNode | null = null
let pv: { ctx: SinkCtx; rig: VoiceRig; src: AudioBufferSourceNode | null } | null = null

/** The "My voice" lane effect — the selected one, even if the lane is off: that's the one they want to hear */
function previewTarget(): FxParams {
  const c = S.lanes.mic
  return effectTarget(c.effect, c.fx[c.effect], c.amount / 100)
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
    let stream: MediaStream
    if (isWin) {
      // system loopback; a video track is required by getDisplayMedia, so we stop it right away
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t) })
      if (!stream.getAudioTracks().length) throw new Error('the system provided no audio')
      await lane.setSink('')
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
    lane.setStream(stream)
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
        const list = allEffects()
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
      S.custom.push({ id, name: c.name.trim().slice(0, 40) || id, emoji: c.emoji || '⭐', base, preset: effectFull(src, cfg.fx[src]) })
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
  }
  publish()
}

// ---------------------------------------------------------------- startup

async function main(): Promise<void> {
  setLang((await holo.getUi()).lang)
  holo.onLang((code) => { setLang(code); updateMicHint(); updateSysHint(); publish() })
  holo.onCmd((c) => { handle(c).catch((e) => console.error(e)) })
  updateSysHint()
  // my voice: microphone (also grants permission to see device names), virtual output, chain
  await openMic()
  micRoute = await holo.routeMic()
  const virt = micRoute.ok && micRoute.sinkLabel
    ? await findDevice('audiooutput', (l) => l === micRoute.sinkLabel)
    : await findDevice('audiooutput', (l) => /CABLE Input/i.test(l), 1)
  // At startup the voice always goes to the virtual microphone, if present (the null sink id changes between runs)
  if (virt) S.out = virt.deviceId
  await lanes.mic.setSink(S.out)
  await lanes.mic.makeRig()
  await lanes.sys.makeRig()
  lanes.mic.update(0) // at startup — immediately, no fade-in or bar
  await refreshDevices()
  await lanes.mic.ctx.resume()

  // computer audio — if it was on last time
  if (S.lanes.sys.enabled) await setSys(true)
  else await lanes.sys.ctx.suspend()
  await applyMonitor()
  ready = true
  publish()

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
