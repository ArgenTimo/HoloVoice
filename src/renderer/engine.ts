// Движок — скрытое окно, живёт всё время работы приложения: звук не зависит от того, открыта ли панель или виджет.
// Две независимые дорожки, у каждой свой эффект (цепочка dsp/rig.ts + вокодер dsp/worklet.ts; начало — voice-fx
// из holo-messenger):
//   mic — мой микрофон → эффект → виртуальный микрофон (Linux: HoloVoice-Microphone из routing-linux.js,
//         механизм re-traductor; Windows: VB-Audio Virtual Cable, звонилка читает «CABLE Output»)
//   sys — звук компьютера (ролики, собеседник) → эффект → мои наушники
//         (Linux: перехват через временный null sink; Windows: системный loopback с заглушением оригинала)
// У каждой дорожки свой AudioContext: у них разные устройства вывода.
import { VoiceRig } from './dsp/rig'
import { EFFECT, EFFECTS, NEUTRAL, effectTarget, type EffectId, type FxParams } from './effects'
import { holo, type Cmd, type EngineState, type Hint, type LaneId, type LaneSettings, type RouteResult, type Settings } from './shared'

const isWin = holo.platform === 'win32'

// ---------------------------------------------------------------- настройки

const DEFAULTS: Settings = {
  lanes: {
    mic: { enabled: true, effect: 'demon', amount: 100, gate: -50, gain: 100, quality: 'hq', fx: {} },
    // звук компьютера по умолчанию не перехватывается — пока его не включили
    sys: { enabled: false, effect: 'hologram_classic', amount: 100, gate: -80, gain: 100, quality: 'hq', fx: {} },
  },
  mic: 'default', out: '', monitor: false, monitorVol: 70,
}
const KEY = 'holovoice.settings.v2'
function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Settings>
    const lane = (id: LaneId): LaneSettings => {
      // из прежних версий: лишние ключи (strength, pitch, space) не мешают, эффекты, которых больше нет, — «Чистый»
      const l = { ...DEFAULTS.lanes[id], ...raw.lanes?.[id] }
      if (!EFFECT[l.effect]) l.effect = 'clean'
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
  try { localStorage.setItem(KEY, JSON.stringify(S)) } catch { /* не страшно */ }
  const dev = (d: MediaDeviceInfo) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'По умолчанию' : d.deviceId.slice(0, 8)) })
  const st: EngineState = { S, mics: mics.map(dev), outs: outs.map(dev), hint, ready }
  holo.pushState(st)
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type SinkCtx = AudioContext & { setSinkId?: (id: string) => Promise<void> }
type SinkEl = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

// ---------------------------------------------------------------- дорожка

class Lane {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' }) as SinkCtx
  readonly inGain = this.ctx.createGain()
  // Срез низа на входе: постоянное смещение и гул микрофона эффекты (низкая полка, насыщение) раздувают в рокот
  readonly hpIn: BiquadFilterNode
  // Шумовой гейт: в паузах эффекты раздувают фон комнаты в шипение
  readonly gate = this.ctx.createGain()
  readonly outGain = this.ctx.createGain()
  readonly hpOut: BiquadFilterNode
  readonly limiter = this.ctx.createDynamicsCompressor() // эффекты с насыщением не должны клиповать
  readonly anIn = this.ctx.createAnalyser()
  readonly anOut = this.ctx.createAnalyser()
  readonly tap = this.ctx.createMediaStreamDestination() // для самопрослушки
  stream: MediaStream | null = null
  src: MediaStreamAudioSourceNode | null = null
  rig: VoiceRig | null = null
  private loaded = false

  constructor(readonly id: LaneId) {
    this.hpIn = this.biquad('highpass', id === 'mic' ? 80 : 20)
    this.hpOut = this.biquad('highpass', 25)
    const L = this.limiter
    L.threshold.value = -3; L.knee.value = 0; L.ratio.value = 20; L.attack.value = 0.002; L.release.value = 0.1
    this.anIn.fftSize = 1024; this.anOut.fftSize = 1024 // ≈20 мс: и индикатор, и гейт
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

  /** Загрузить вокодер и собрать цепочку (и пересобрать при смене качества — с теми же параметрами, без паузы) */
  async makeRig(): Promise<void> {
    if (!this.loaded) {
      await this.ctx.audioWorklet.addModule(new URL('../../dist/dsp/worklet.js', location.href).href)
      this.loaded = true
    }
    const fftSize = this.cfg.quality === 'fast' ? 1024 : 2048
    const rig = new VoiceRig(this.ctx, new AudioWorkletNode(this.ctx, 'holo-voice', { processorOptions: { fftSize } }))
    const old = this.rig
    rig.apply(old?.current ?? NEUTRAL, 0)
    this.gate.connect(rig.input)
    rig.output.connect(this.outGain)
    if (old) { this.gate.disconnect(old.input); old.dispose() }
    this.rig = rig
  }

  /** Что должно звучать по настройкам: эффект с силой amount, а выключенная дорожка — обычный звук */
  target(): FxParams {
    const c = this.cfg
    return c.enabled ? effectTarget(c.effect, c.fx[c.effect], c.amount / 100) : NEUTRAL
  }

  /** Плавно перейти к настройкам за seconds: нарастание, затухание, переход между эффектами */
  update(seconds = 0.05): void {
    this.rig?.apply(this.target(), seconds)
    // заметный переход — показать полосу нарастания (main решает, включена ли она)
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

  /** Гейт по уровню входа: открывается за 5 мс, держится 250 мс после звука, закрывается за ~80 мс.
   *  Таймер, а не requestAnimationFrame — тот в скрытом окне не работает. */
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

// ---------------------------------------------------------------- устройства

let micRoute: RouteResult = { ok: false, platform: holo.platform }
let realOutId = '' // настоящие наушники/колонки (на Linux при перехвате выход по умолчанию — наш)

const isVirtualOut = (label: string) => /HoloVoice|CABLE Input|VB-Audio|Virtual Cable|VoiceMeeter Input/i.test(label)
const isVirtualIn = (label: string) => /HoloVoice|Monitor of|CABLE Output|VoiceMeeter Out/i.test(label)
const isAlias = (d: MediaDeviceInfo) => d.deviceId === 'default' || d.deviceId === 'communications'

async function listDevices(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices()
  mics = all.filter((d) => d.kind === 'audioinput' && !isVirtualIn(d.label))
  outs = all.filter((d) => d.kind === 'audiooutput' && !/HoloVoice-speaker/.test(d.label))
  return all
}

/** Новые устройства (наши null sink) появляются в списке не сразу — подождать. */
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
      : /CABLE/.test(outLabel) ? 'CABLE Output (VB-Audio Virtual Cable)' : 'выход виртуального кабеля'
    hint.mic = { warn: false, html: `В Discord / Telegram / Zoom выберите микрофон <b>${mic}</b>.<br>Вкл/выкл эффект — <b>Ctrl+Alt+V</b>.` }
  } else if (isWin && !outs.some((d) => /CABLE Input/i.test(d.label))) {
    hint.mic = { warn: true, html: 'Чтобы голос с эффектом шёл в Discord/игры, поставьте бесплатный ' +
      '<a data-href="https://vb-audio.com/Cable/">VB-Audio Virtual Cable</a>, перезапустите HoloVoice и выберите в программе звонка ' +
      'микрофон <b>CABLE Output</b>. Сейчас голос идёт в колонки — можно проверить, как звучит.' }
  } else if (holo.platform === 'linux' && !micRoute.ok) {
    hint.mic = { warn: true, html: `Не удалось создать виртуальный микрофон: ${esc(micRoute.error ?? '')}. Голос идёт в «${esc(outLabel)}».` }
  } else {
    hint.mic = { warn: true, html: `Голос идёт в «<b>${esc(outLabel || 'по умолчанию')}</b>» — это проверка на слух, в звонок он не попадёт.` }
  }
}

function updateSysHint(err = ''): void {
  if (err) { hint.sys = { warn: true, html: `Не удалось перехватить звук: ${esc(err)}` }; return }
  hint.sys = { warn: false, html: S.lanes.sys.enabled
    ? 'Всё, что играет на компьютере (ролики, собеседник в звонке), идёт через эффект. ' +
      'Вкл/выкл — <b>Ctrl+Alt+B</b>. При выключении звук возвращается как было.' +
      (isWin ? '<br><i>На Windows эта функция экспериментальная.</i>' : '')
    : 'Выключено — звук компьютера идёт как обычно. Включите, чтобы наложить эффект на ролики и собеседника.' }
}

// ---------------------------------------------------------------- звук компьютера

// Включение/выключение перехвата занимает до пары секунд; горячую клавишу могут нажать снова раньше.
// Поэтому запоминается желаемое состояние, а цикл доводит до него фактическое — ни одно нажатие не теряется.
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
      // системный loopback; видео-дорожка обязательна для getDisplayMedia, сразу выключаем её
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t) })
      if (!stream.getAudioTracks().length) throw new Error('система не отдала звук')
      await lane.setSink('')
    } else {
      const r = await holo.routeSys(true)
      if (!r.ok) throw new Error(r.error ?? 'pactl')
      const cap = await findDevice('audioinput', (l) => l === r.monitorLabel)
      const real = await findDevice('audiooutput', (l) => l === r.realSinkLabel, 10)
      if (!cap) throw new Error('не найден вход перехвата')
      if (!real) throw new Error(`не найден выход «${r.realSinkLabel}»`)
      realOutId = real.deviceId
      await lane.setSink(realOutId)
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: { exact: cap.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: 2,
      } })
    }
    lane.rig?.apply(NEUTRAL, 0) // перехваченный звук сначала как есть — дальше нарастание эффекта
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

// ---------------------------------------------------------------- самопрослушка

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

// ---------------------------------------------------------------- команды пультов

// Выключение звука компьютера ждёт затухания эффекта, а уже потом снимает перехват
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
        if (sysActive) lane.update(lane.rampIn()) // ещё не успел выключиться — просто нарастить обратно
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
      // включённый — перетекает в новый эффект за его время нарастания
      if (cfg.enabled) lanes[c.lane].update(lanes[c.lane].rampIn())
      else return handle({ type: 'toggle', lane: c.lane, on: true })
      break
    }
    case 'hotkey': {
      const cfg = S.lanes[c.lane]
      if (c.action === 'toggle') return handle({ type: 'toggle', lane: c.lane })
      if (c.action === 'next' || c.action === 'prev') {
        const i = EFFECTS.findIndex((e) => e.id === cfg.effect)
        const n = EFFECTS.length
        const next = EFFECTS[(i + (c.action === 'next' ? 1 : n - 1)) % n].id
        return handle({ type: 'effect', lane: c.lane, effect: next })
      }
      if (!EFFECTS.some((e) => e.id === c.action)) break
      // то же сочетание у включённого эффекта — выключить: «нажал — включил, нажал ещё раз — выключил»
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
      S.lanes[c.lane].quality = c.value
      await lanes[c.lane].makeRig()
      break
    case 'mic': S.mic = c.id; await openMic(); break
    case 'out': S.out = c.id; await lanes.mic.setSink(c.id); updateMicHint(); break
    case 'monitor': S.monitor = c.on; await applyMonitor(); break
    case 'monitorVol': S.monitorVol = c.value; await applyMonitor(); break
  }
  publish()
}

// ---------------------------------------------------------------- запуск

async function main(): Promise<void> {
  holo.onCmd((c) => { handle(c).catch((e) => console.error(e)) })
  updateSysHint()
  // мой голос: микрофон (заодно даёт право видеть названия устройств), виртуальный выход, цепочка
  await openMic()
  micRoute = await holo.routeMic()
  const virt = micRoute.ok && micRoute.sinkLabel
    ? await findDevice('audiooutput', (l) => l === micRoute.sinkLabel)
    : await findDevice('audiooutput', (l) => /CABLE Input/i.test(l), 1)
  // На старте голос всегда идёт в виртуальный микрофон, если он есть (id null sink меняется от запуска к запуску)
  if (virt) S.out = virt.deviceId
  await lanes.mic.setSink(S.out)
  await lanes.mic.makeRig()
  await lanes.sys.makeRig()
  lanes.mic.update(0) // при запуске — сразу, без нарастания и полосы
  await refreshDevices()
  await lanes.mic.ctx.resume()

  // звук компьютера — если был включён в прошлый раз
  if (S.lanes.sys.enabled) await setSys(true)
  else await lanes.sys.ctx.suspend()
  await applyMonitor()
  ready = true
  publish()

  navigator.mediaDevices.addEventListener('devicechange', () => { refreshDevices() })
  // индикаторы уровня для пультов, 20 раз в секунду
  const buf = new Float32Array(1024)
  const pct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
  setInterval(() => {
    holo.pushLevels({
      mic: [pct(lanes.mic.level('in', buf)), pct(lanes.mic.level('out', buf))],
      sys: [pct(lanes.sys.level('in', buf)), pct(lanes.sys.level('out', buf))],
    })
  }, 50)
}

main().catch((e) => {
  hint.mic = { warn: true, html: `Ошибка запуска звука: ${esc(String(e?.message ?? e))}` }
  ready = true
  publish()
  console.error(e)
})
