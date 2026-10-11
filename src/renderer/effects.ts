// Effects are presets of a single processing chain (rig.ts). Any parameter of any effect can be tweaked in the panel;
// transitions between effects and ramp-in are smooth interpolation of all parameters (frequencies on a log scale).
// The idea and first chains come from holo-messenger (src/client/audio/voice-fx.ts). Names live in the dictionaries (src/locales).
import { t } from './i18n'

export const fxLabel = (id: string) => (isCustom(id) ? CUSTOM.find((c) => c.id === id)?.name ?? id : t(`fx.${id}`))
export const paramLabel = (k: string) => t(`p.${k}`)
export const groupLabel = (g: string) => t(`pg.${g}`)

export type ParamKey =
  | 'denoise' | 'pitch' | 'formant' | 'vibrato' | 'vibratoHz' | 'robot' | 'whisper'
  | 'autoTarget' | 'targetHz' | 'formantFollow' | 'tune' | 'mono' | 'monoHz' | 'psola'
  | 'comp' | 'deess' | 'warmth' | 'clarity' | 'excite' | 'double'
  | 'drive' | 'crush' | 'decimate' | 'ring' | 'ringHz'
  | 'lowcut' | 'highcut' | 'bass' | 'presence' | 'air'
  | 'wow' | 'chorus' | 'chorusRate' | 'tremolo' | 'tremoloHz'
  | 'echo' | 'echoTime' | 'echoFb' | 'reverb' | 'size' | 'noise' | 'level'
export type FxParams = Record<ParamKey, number>

export type ParamGroup = 'voice' | 'enh' | 'color' | 'tone' | 'motion' | 'space'
export interface ParamDef {
  key: ParamKey; group: ParamGroup
  min: number; max: number; step: number
  fmt: (v: number) => string
  log?: boolean // frequencies: slider and interpolation on a log scale
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} ${t('u.db')}`
const st = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} ${t('u.st')}`
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} ${t('u.khz')}` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ${t('u.hz')}`)
const sec = (v: number) => `${v.toFixed(2)} ${t('u.s')}`
const onoff = (v: number) => (v >= 0.5 ? t('u.on') : t('u.off'))

export const PARAMS: ParamDef[] = [
  { key: 'psola', group: 'voice', min: 0, max: 1, step: 1, fmt: onoff },
  { key: 'targetHz', group: 'voice', min: 60, max: 450, step: 1, fmt: hz, log: true },
  { key: 'autoTarget', group: 'voice', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'formantFollow', group: 'voice', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'pitch', group: 'voice', min: -24, max: 24, step: 0.5, fmt: st },
  { key: 'formant', group: 'voice', min: -12, max: 12, step: 0.5, fmt: st },
  { key: 'whisper', group: 'voice', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'vibrato', group: 'voice', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'vibratoHz', group: 'voice', min: 0.5, max: 12, step: 0.1, fmt: hz, log: true },
  { key: 'tune', group: 'voice', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'mono', group: 'voice', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'monoHz', group: 'voice', min: 50, max: 450, step: 1, fmt: hz, log: true },
  { key: 'robot', group: 'voice', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'denoise', group: 'enh', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'comp', group: 'enh', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'deess', group: 'enh', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'warmth', group: 'enh', min: -12, max: 12, step: 0.5, fmt: db },
  { key: 'clarity', group: 'enh', min: -6, max: 12, step: 0.5, fmt: db },
  { key: 'excite', group: 'enh', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'double', group: 'enh', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'drive', group: 'color', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'crush', group: 'color', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'decimate', group: 'color', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'ring', group: 'color', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'ringHz', group: 'color', min: 10, max: 1500, step: 1, fmt: hz, log: true },
  { key: 'noise', group: 'color', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'lowcut', group: 'tone', min: 20, max: 1500, step: 1, fmt: hz, log: true },
  { key: 'highcut', group: 'tone', min: 1500, max: 20000, step: 10, fmt: hz, log: true },
  { key: 'bass', group: 'tone', min: -12, max: 12, step: 0.5, fmt: db },
  { key: 'presence', group: 'tone', min: -12, max: 12, step: 0.5, fmt: db },
  { key: 'air', group: 'tone', min: -12, max: 12, step: 0.5, fmt: db },
  { key: 'level', group: 'tone', min: -18, max: 12, step: 0.5, fmt: db },
  { key: 'wow', group: 'motion', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'chorus', group: 'motion', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'chorusRate', group: 'motion', min: 0.05, max: 8, step: 0.01, fmt: hz, log: true },
  { key: 'tremolo', group: 'motion', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'tremoloHz', group: 'motion', min: 0.5, max: 20, step: 0.1, fmt: hz, log: true },
  { key: 'echo', group: 'space', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'echoTime', group: 'space', min: 0.04, max: 1.2, step: 0.01, fmt: sec },
  { key: 'echoFb', group: 'space', min: 0, max: 0.9, step: 0.01, fmt: pct },
  { key: 'reverb', group: 'space', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'size', group: 'space', min: 0, max: 1, step: 0.01, fmt: pct },
]
export const PARAM = Object.fromEntries(PARAMS.map((p) => [p.key, p])) as Record<ParamKey, ParamDef>

export const NEUTRAL: FxParams = {
  denoise: 0, pitch: 0, formant: 0, vibrato: 0, vibratoHz: 5, robot: 0, whisper: 0,
  autoTarget: 0, targetHz: 150, formantFollow: 0, tune: 0, mono: 0, monoHz: 110, psola: 0,
  comp: 0, deess: 0, warmth: 0, clarity: 0, excite: 0, double: 0,
  drive: 0, crush: 0, decimate: 0, ring: 0, ringHz: 60, noise: 0,
  lowcut: 20, highcut: 20000, bass: 0, presence: 0, air: 0, level: 0,
  wow: 0, chorus: 0, chorusRate: 0.8, tremolo: 0, tremoloHz: 5,
  echo: 0, echoTime: 0.3, echoFb: 0.35, reverb: 0, size: 0.5,
}

export type BuiltinId =
  | 'clean' | 'male' | 'female' | 'child' | 'autotune' | 'giant' | 'chipmunk'
  | 'demon' | 'ghost' | 'digital' | 'whisper' | 'radio'
  | 'hologram_classic' | 'hologram_warm' | 'smolder' | 'ice' | 'electric' | 'vhs' | 'cave'

/** A user's custom effect: a snapshot of all parameters of a built-in one (with their edits) under its own name */
export type CustomId = `c-${string}`
export type EffectId = BuiltinId | CustomId
export interface CustomEffect { id: CustomId; name: string; emoji: string; base: BuiltinId; preset: FxParams }

export interface EffectInfo {
  id: EffectId; emoji: string
  preset: Partial<FxParams>
  main: ParamKey[] // the effect's main knobs, shown up front; the rest are under "All parameters"
}

export const EFFECTS: EffectInfo[] = [
  { id: 'clean', emoji: '🎙️',
    preset: { denoise: 0.3, comp: 0.45, deess: 0.3, warmth: 1.5, clarity: 2, presence: 1.5, air: 2, excite: 0.15, lowcut: 70, level: 2.5 },
    main: ['denoise', 'comp', 'deess', 'warmth', 'clarity', 'presence', 'air', 'excite', 'double', 'reverb'] },
  { id: 'male', emoji: '👨',
    preset: { psola: 1, autoTarget: 1, targetHz: 115, formantFollow: 1, formant: -1, warmth: 2.5, bass: 2, clarity: 1, presence: -0.5 },
    main: ['targetHz', 'formant', 'warmth', 'bass', 'vibrato', 'psola'] },
  { id: 'female', emoji: '👩',
    preset: { psola: 1, autoTarget: 1, targetHz: 195, formantFollow: 1, lowcut: 90, air: 1, level: -0.5 },
    main: ['targetHz', 'formant', 'air', 'presence', 'warmth', 'vibrato', 'psola'] },
  { id: 'child', emoji: '🧒',
    preset: { psola: 1, autoTarget: 1, targetHz: 260, formantFollow: 1, formant: 1, lowcut: 150, clarity: 2, presence: 1, air: 1, level: -0.5 },
    main: ['targetHz', 'formant', 'air', 'presence', 'vibrato', 'psola'] },
  { id: 'autotune', emoji: '🎤',
    preset: { psola: 1, tune: 1, comp: 0.45, deess: 0.35, clarity: 2, presence: 2, air: 2.5, excite: 0.2, double: 0.3, reverb: 0.15, size: 0.3, level: -3.5 },
    main: ['tune', 'pitch', 'formant', 'double', 'reverb'] },
  { id: 'demon', emoji: '😈', preset: { psola: 1, pitch: -8, formant: -5, drive: 0.45, bass: 6, reverb: 0.35, size: 0.6, level: 0 },
    main: ['pitch', 'formant', 'drive', 'reverb'] },
  { id: 'ghost', emoji: '👻',
    preset: { pitch: 3, formant: 2, whisper: 0.55, lowcut: 300, air: 3, echo: 0.4, echoTime: 0.33, echoFb: 0.45, reverb: 0.6, size: 0.9,
      tremolo: 0.35, tremoloHz: 4, level: 2.5 },
    main: ['whisper', 'echo', 'reverb', 'tremolo'] },
  { id: 'digital', emoji: '🤖', preset: { psola: 1, mono: 1, monoHz: 100, ring: 0.35, ringHz: 60, crush: 0.25, presence: 2, highcut: 9000, level: 2 },
    main: ['monoHz', 'mono', 'ring', 'ringHz', 'crush'] },
  { id: 'hologram_classic', emoji: '🛰️',
    preset: { ring: 0.5, ringHz: 50, lowcut: 400, highcut: 4500, presence: 4, chorus: 0.5, chorusRate: 0.3, noise: 0.15, level: -2.5 },
    main: ['ring', 'ringHz', 'chorus', 'noise'] },
  { id: 'hologram_warm', emoji: '✨', preset: { chorus: 0.6, chorusRate: 0.2, highcut: 6000, bass: 2, reverb: 0.3, size: 0.4, level: -2.5 },
    main: ['chorus', 'reverb', 'highcut'] },
  { id: 'smolder', emoji: '🔥', preset: { psola: 1, pitch: -3, formant: -1.5, drive: 0.4, whisper: 0.15, bass: 3, reverb: 0.2, size: 0.3, level: 0.5 },
    main: ['pitch', 'drive', 'whisper'] },
  { id: 'ice', emoji: '🧊',
    preset: { pitch: 2, formant: 1.5, ring: 0.25, ringHz: 420, air: 6, presence: 2, chorus: 0.3, reverb: 0.45, size: 0.8, level: 0 },
    main: ['ring', 'ringHz', 'air', 'reverb'] },
  { id: 'electric', emoji: '⚡',
    preset: { ring: 0.6, ringHz: 90, crush: 0.45, decimate: 0.2, drive: 0.2, lowcut: 300, highcut: 6000, noise: 0.25, level: 1.5 },
    main: ['ring', 'crush', 'decimate', 'noise'] },
  { id: 'vhs', emoji: '📼', preset: { wow: 0.7, crush: 0.35, drive: 0.15, lowcut: 120, highcut: 4000, noise: 0.35, level: 1 },
    main: ['wow', 'crush', 'noise', 'highcut'] },
  { id: 'giant', emoji: '🗿', preset: { psola: 1, pitch: -12, formant: -7, bass: 4, reverb: 0.25, size: 0.7, level: 1 },
    main: ['pitch', 'formant', 'reverb'] },
  { id: 'chipmunk', emoji: '🐿️', preset: { psola: 1, pitch: 12, formant: 12, lowcut: 200, level: -1.5 },
    main: ['pitch', 'formant'] },
  { id: 'whisper', emoji: '🤫', preset: { whisper: 1, lowcut: 300, presence: 3, air: 4, level: 6 },
    main: ['whisper', 'air', 'reverb'] },
  { id: 'radio', emoji: '📻', preset: { lowcut: 500, highcut: 3200, drive: 0.5, presence: 6, noise: 0.2, crush: 0.15, level: -7.5 },
    main: ['drive', 'noise', 'lowcut', 'highcut'] },
  { id: 'cave', emoji: '🕳️', preset: { reverb: 0.8, size: 1, echo: 0.3, echoTime: 0.45, echoFb: 0.3, bass: 2, level: -1.5 },
    main: ['reverb', 'size', 'echo'] },
]
export const EFFECT = Object.fromEntries(EFFECTS.map((e) => [e.id, e])) as Record<BuiltinId, EffectInfo>

// ---------------------------------------------------------------- custom effects (stored in the engine settings)

let CUSTOM: CustomEffect[] = []
const customInfo = new Map<string, EffectInfo>()
export function setCustom(list: CustomEffect[] | undefined): void {
  CUSTOM = list ?? []
  customInfo.clear()
  for (const c of CUSTOM) customInfo.set(c.id, { id: c.id, emoji: c.emoji, preset: c.preset, main: EFFECT[c.base]?.main ?? EFFECT.clean.main })
}
export function customs(): CustomEffect[] { return CUSTOM }
export const isCustom = (id: string): id is CustomId => id.startsWith('c-')
/** Any effect, built-in or custom */
export function effectInfo(id: string): EffectInfo | undefined {
  return isCustom(id) ? customInfo.get(id) : EFFECT[id as BuiltinId]
}
/** All effects in order: built-in, then custom */
export function allEffects(): EffectInfo[] { return [...EFFECTS, ...customInfo.values()] }

/** User-saved settings for one effect (on top of the preset) */
export interface EffectUser { p?: Partial<FxParams>; rampIn?: number; rampOut?: number }

/** Full effect parameters: neutral ← preset ← user edits */
export function effectFull(id: EffectId, user?: EffectUser): FxParams {
  return { ...NEUTRAL, ...(effectInfo(id)?.preset ?? {}), ...(user?.p ?? {}) }
}

/** Between a and b at fraction t; frequencies on a log scale so it sounds even */
export function interpolate(a: FxParams, b: FxParams, t: number): FxParams {
  const out = { ...a }
  for (const d of PARAMS) {
    const x = a[d.key], y = b[d.key]
    out[d.key] = d.log && x > 0 && y > 0 ? x * (y / x) ** t : x + (y - x) * t
  }
  return out
}

/** Parameters that only make sense for a single live voice: on the computer-sound track (videos, music,
 *  several speakers) they misbehave — denoise slowly eats sustained notes, the compressor pumps the level. */
export const VOICE_ONLY: ParamKey[] = ['denoise', 'comp', 'deess', 'psola', 'autoTarget', 'targetHz', 'formantFollow']

/** Computer-sound track: PSOLA and speaker tracking need one voice, so gender voices become a fixed pitch/formant
 *  shift through the vocoder (it copes with polyphonic sound); voice-only tools are off. */
export function forSystemSound(p: FxParams): FxParams {
  const out = { ...p, denoise: 0, comp: 0, deess: 0, psola: 0 }
  if (p.autoTarget > 0) {
    // shift as if the speaker were an average voice (~150 Hz)
    const semis = p.autoTarget * 12 * Math.log2(p.targetHz / 150)
    out.pitch = p.pitch + semis
    out.formant = Math.max(-12, Math.min(12, p.formant + p.formantFollow * 0.27 * semis))
    out.autoTarget = 0
    out.formantFollow = 0
  }
  return out
}

/** What is heard: the effect at strength amount (0..1), the fraction of the way from neutral sound to the effect */
export function effectTarget(id: EffectId, user: EffectUser | undefined, amount: number): FxParams {
  return interpolate(NEUTRAL, effectFull(id, user), Math.max(0, Math.min(1, amount)))
}
