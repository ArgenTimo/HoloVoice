// Shared by the engine (engine — hidden window with the audio) and the controllers (panel — main window, widget — widget).
import type { CustomEffect, EffectId, EffectUser, ParamKey } from './effects'

export type LaneId = 'mic' | 'sys'

export type Quality = 'hq' | 'fast'
export interface LaneSettings {
  enabled: boolean; effect: EffectId
  amount: number // strength, 0..100 — fraction of the way from the normal sound to the effect
  gate: number; gain: number
  quality: Quality // hq — vocoder window 2048 (~40 ms), fast — 1024 (~20 ms)
  fx: Partial<Record<EffectId, EffectUser>> // per-effect user settings: parameters, fade-in, fade-out
}
export interface Settings {
  lanes: Record<LaneId, LaneSettings>
  mic: string; out: string; monitor: boolean; monitorVol: number
  /** the user's own voice: effects with a fixed pitch/formant shift adjust to it (neutral — as designed) */
  speaker: Speaker
  custom: CustomEffect[] // custom effects
}
export type Speaker = 'neutral' | 'male' | 'female'
export interface NeuralCheck { ok: boolean; cuda?: boolean; gpu?: string; error?: string; voices: { id: string; path: string }[] }
export interface NeuralEvent { event: 'loading' | 'ready' | 'stats' | 'error' | 'exit'; message?: string; latency_ms?: number; device?: string
  block_ms?: number; p95_ms?: number; overruns?: number; code?: number }
/** Neural voice mode as the engine sees it */
export interface NeuralState { available: boolean; gpu: string; status: 'off' | 'loading' | 'ready' | 'error'; latencyMs: number; error: string }
export interface Hint { html: string; warn: boolean }
export interface Device { id: string; label: string }

/** What the engine broadcasts to the controllers on every change */
export interface EngineState {
  S: Settings
  mics: Device[]; outs: Device[]
  hint: Record<LaneId, Hint>
  ready: boolean
  preview: Preview
  neural: NeuralState
}
/** "Test with a recording": record your voice and play it back through the "My voice" lane effect */
export interface Preview { recording: boolean; ready: boolean; playing: boolean; seconds: number
}

export type Cmd =
  | { type: 'toggle'; lane: LaneId; on?: boolean }
  | { type: 'effect'; lane: LaneId; effect: EffectId }
  | { type: 'set'; lane: LaneId; key: 'amount' | 'gate' | 'gain'; value: number }
  | { type: 'fxParam'; lane: LaneId; effect: EffectId; key: ParamKey; value: number }
  | { type: 'fxRamp'; lane: LaneId; effect: EffectId; which: 'rampIn' | 'rampOut'; value: number }
  | { type: 'fxReset'; lane: LaneId; effect: EffectId }
  | { type: 'quality'; lane: LaneId; value: Quality }
  | { type: 'record' } | { type: 'play' } | { type: 'stopPreview' }
  | { type: 'customSave'; lane: LaneId; name: string; icon: string }
  | { type: 'customDelete'; id: EffectId }
  | { type: 'mic' | 'out'; id: string }
  | { type: 'monitor'; on: boolean }
  | { type: 'monitorVol'; value: number }
  | { type: 'speaker'; value: Speaker }
  /** hotkey: toggle / next / prev / effect id */
  | { type: 'hotkey'; lane: LaneId; action: string }
  /** held hotkey: down — apply the action, up — return to the state before it */
  | { type: 'hold'; lane: LaneId; action: string; down: boolean }

/** input/output levels, %, and voice pitch: current and average, Hz (0 — no voice) */
export interface Levels { mic: [number, number]; sys: [number, number]; f0: Record<LaneId, [number, number]> }

export interface UiConfig { pinned: boolean; compact: boolean; tab: LaneId; widget: boolean; widgetPinned: boolean; lang: string }

export interface HotkeyInfo { map: Record<string, string>; failed: string[] }
export type OsdPos = 'top' | 'top-left' | 'top-right' | 'bottom' | 'bottom-left' | 'bottom-right'
export interface OsdInfo { osd: boolean; rampBar: boolean; osdPos: OsdPos }
export interface OsdMsg { lane: LaneId; toast: boolean; ramp: { seconds: number; dir: 'in' | 'out' } | null }

export interface RouteResult {
  ok: boolean; platform: string; error?: string
  sinkLabel?: string; micLabel?: string; realSinkLabel?: string; monitorLabel?: string
}

export interface HoloApi {
  platform: string
  // controllers
  cmd(c: Cmd): void
  getState(): Promise<EngineState | null>
  onState(cb: (s: EngineState) => void): void
  onLevels(cb: (l: Levels) => void): void
  getUi(): Promise<UiConfig>
  setUi(patch: Partial<UiConfig>): Promise<UiConfig>
  widget(on: boolean): Promise<void>
  showPanel(): Promise<void>
  minimize(): Promise<void>
  close(): Promise<void>
  setHeight(h: number): Promise<void>
  compact(on: boolean, height: number): Promise<void>
  open(url: string): Promise<void>
  getHotkeys(): Promise<HotkeyInfo>
  setHotkey(action: string, accel: string): Promise<HotkeyInfo>
  resetHotkeys(): Promise<HotkeyInfo>
  pauseHotkeys(on: boolean): Promise<void>
  getOsd(): Promise<OsdInfo>
  setOsd(patch: Partial<OsdInfo>): Promise<OsdInfo>
  testOsd(): Promise<void>
  onOsd(cb: (msg: OsdMsg) => void): void
  onLang(cb: (code: string) => void): void
  version(): Promise<string>
  update(): Promise<string>
  onUpdateProgress(cb: (text: string) => void): void
  // engine
  routeMic(): Promise<RouteResult>
  routeSys(on: boolean, rate?: number): Promise<RouteResult>
  onSysAudio(cb: (pcm: Uint8Array) => void): void
  onSysEnd(cb: (error: string) => void): void
  /** Linux: the real output changed while computer sound is captured */
  onRealSink(cb: (r: { realSinkLabel: string }) => void): void
  // neural voices (optional GPU mode)
  neuralCheck(force?: boolean): Promise<NeuralCheck>
  neuralStart(voice: string, rate: number): Promise<{ ok: boolean; error?: string }>
  neuralStop(): Promise<void>
  neuralIn(buf: ArrayBuffer): void
  onNeuralAudio(cb: (pcm: Uint8Array) => void): void
  onNeuralStatus(cb: (s: NeuralEvent) => void): void
  pushState(s: EngineState): void
  pushLevels(l: Levels): void
  pushRamp(r: { lane: LaneId; seconds: number; dir: 'in' | 'out' }): void
  onCmd(cb: (c: Cmd) => void): void
}

export const holo = (window as unknown as { holo: HoloApi }).holo
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
