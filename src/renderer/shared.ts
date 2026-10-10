// Общее для движка (engine — скрытое окно со звуком) и пультов (panel — главное окно, widget — виджет).
import type { CustomEffect, EffectId, EffectUser, ParamKey } from './effects'

export type LaneId = 'mic' | 'sys'

export type Quality = 'hq' | 'fast'
export interface LaneSettings {
  enabled: boolean; effect: EffectId
  amount: number // сила, 0..100 — доля пути от обычного звука к эффекту
  gate: number; gain: number
  quality: Quality // hq — окно вокодера 2048 (~40 мс), fast — 1024 (~20 мс)
  fx: Partial<Record<EffectId, EffectUser>> // свои настройки каждого эффекта: параметры, нарастание, затухание
}
export interface Settings {
  lanes: Record<LaneId, LaneSettings>
  mic: string; out: string; monitor: boolean; monitorVol: number
  custom: CustomEffect[] // свои эффекты
}
export interface Hint { html: string; warn: boolean }
export interface Device { id: string; label: string }

/** Что движок рассылает пультам при каждом изменении */
export interface EngineState {
  S: Settings
  mics: Device[]; outs: Device[]
  hint: Record<LaneId, Hint>
  ready: boolean
  preview: Preview
}
/** «Проверить на записи»: запись своего голоса и прослушивание через эффект дорожки «Мой голос» */
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
  | { type: 'customSave'; lane: LaneId; name: string; emoji: string }
  | { type: 'customDelete'; id: EffectId }
  | { type: 'mic' | 'out'; id: string }
  | { type: 'monitor'; on: boolean }
  | { type: 'monitorVol'; value: number }
  /** горячая клавиша: toggle / next / prev / id эффекта */
  | { type: 'hotkey'; lane: LaneId; action: string }

/** уровни вход/выход, %, и тон голоса: текущий и средний, Гц (0 — нет голоса) */
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
  // пульты
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
  // движок
  routeMic(): Promise<RouteResult>
  routeSys(on: boolean): Promise<RouteResult>
  pushState(s: EngineState): void
  pushLevels(l: Levels): void
  pushRamp(r: { lane: LaneId; seconds: number; dir: 'in' | 'out' }): void
  onCmd(cb: (c: Cmd) => void): void
}

export const holo = (window as unknown as { holo: HoloApi }).holo
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
