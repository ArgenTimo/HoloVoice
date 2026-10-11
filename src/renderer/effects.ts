// Effects are presets of a single processing chain (rig.ts). Any parameter of any effect can be tweaked in the panel;
// transitions between effects and ramp-in are smooth interpolation of all parameters (frequencies on a log scale).
// The idea and first chains come from holo-messenger (src/client/audio/voice-fx.ts). Names live in the dictionaries (src/locales).
import { t } from './i18n'
import { customIcon } from './icons'
import type { Speaker } from './shared'

export const fxLabel = (id: string) => (isCustom(id) ? CUSTOM.find((c) => c.id === id)?.name ?? id : t(`fx.${id}`))
export const paramLabel = (k: string) => t(`p.${k}`)
export const groupLabel = (g: string) => t(`pg.${g}`)

export type ParamKey =
  | 'denoise' | 'pitch' | 'formant' | 'vibrato' | 'vibratoHz' | 'robot' | 'whisper'
  | 'autoTarget' | 'targetHz' | 'formantFollow' | 'tune' | 'mono' | 'monoHz' | 'steps' | 'psola'
  | 'comp' | 'deess' | 'warmth' | 'clarity' | 'excite' | 'double'
  | 'drive' | 'grit' | 'growl' | 'sub' | 'fry' | 'rasp' | 'octave' | 'crush' | 'decimate' | 'ring' | 'ringHz'
  | 'lowcut' | 'highcut' | 'bass' | 'presence' | 'air'
  | 'wow' | 'chorus' | 'chorusRate' | 'tremolo' | 'tremoloHz'
  | 'echo' | 'echoTime' | 'echoFb' | 'reverb' | 'size' | 'halo' | 'noise' | 'level'
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
  { key: 'steps', group: 'voice', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'robot', group: 'voice', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'denoise', group: 'enh', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'comp', group: 'enh', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'deess', group: 'enh', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'warmth', group: 'enh', min: -12, max: 12, step: 0.5, fmt: db },
  { key: 'clarity', group: 'enh', min: -6, max: 12, step: 0.5, fmt: db },
  { key: 'excite', group: 'enh', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'double', group: 'enh', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'drive', group: 'color', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'growl', group: 'color', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'sub', group: 'color', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'fry', group: 'color', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'rasp', group: 'color', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'octave', group: 'color', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'grit', group: 'color', min: 0, max: 1, step: 0.01, fmt: pct },
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
  { key: 'halo', group: 'space', min: 0, max: 1, step: 0.01, fmt: pct },
]
export const PARAM = Object.fromEntries(PARAMS.map((p) => [p.key, p])) as Record<ParamKey, ParamDef>

export const NEUTRAL: FxParams = {
  denoise: 0, pitch: 0, formant: 0, vibrato: 0, vibratoHz: 5, robot: 0, whisper: 0,
  autoTarget: 0, targetHz: 150, formantFollow: 0, tune: 0, mono: 0, monoHz: 110, steps: 0, psola: 0,
  comp: 0, deess: 0, warmth: 0, clarity: 0, excite: 0, double: 0,
  drive: 0, grit: 0, growl: 0, sub: 0, fry: 0, rasp: 0, octave: 0, crush: 0, decimate: 0, ring: 0, ringHz: 60, noise: 0,
  lowcut: 20, highcut: 20000, bass: 0, presence: 0, air: 0, level: 0,
  wow: 0, chorus: 0, chorusRate: 0.8, tremolo: 0, tremoloHz: 5,
  echo: 0, echoTime: 0.3, echoFb: 0.35, reverb: 0, size: 0.5, halo: 0,
}

export type BuiltinId =
  | 'clean' | 'male' | 'female' | 'child' | 'autotune' | 'giant' | 'chipmunk'
  | 'demon' | 'divine' | 'tts' | 'ghost' | 'digital' | 'whisper' | 'radio'
  | 'hologram_classic' | 'hologram_warm' | 'smolder' | 'ice' | 'electric' | 'vhs' | 'cave'
  | 'telephone' | 'megaphone' | 'stadium' | 'narrator' | 'helium' | 'oldman' | 'zombie' | 'alien' | 'underwater'
  | 'neural_female' | 'neural_male'

/** A user's custom effect: a snapshot of all parameters of a built-in one (with their edits) under its own name */
export type CustomId = `c-${string}`
export type EffectId = BuiltinId | CustomId
/** icon — an id from icons.ts; `emoji` is the legacy field of saves from older versions (migrated in setCustom) */
export interface CustomEffect { id: CustomId; name: string; icon: string; emoji?: string; base: BuiltinId; preset: FxParams }

export interface EffectInfo {
  id: EffectId; icon: string // icon id from icons.ts
  preset: Partial<FxParams>
  main: ParamKey[] // the effect's main knobs, shown up front; the rest are under "All parameters"
  /** neural voice conversion (optional GPU mode, native/neural-vc): the target voice; the preset only polishes the result */
  neural?: 'female' | 'male'
  /** level on the computer-sound track (see systemSoundTarget); without it the preset's level is used */
  sysLevel?: number
}

export const EFFECTS: EffectInfo[] = [
  { id: 'clean', icon: 'mic',
    preset: { denoise: 0.3, comp: 0.45, deess: 0.3, warmth: 1.5, clarity: 2, presence: 1.5, air: 2, excite: 0.15, lowcut: 70, level: 2.5 },
    main: ['denoise', 'comp', 'deess', 'warmth', 'clarity', 'presence', 'air', 'excite', 'double', 'reverb'] },
  { id: 'male', icon: 'mars',
    sysLevel: -0.9,
    preset: { psola: 1, autoTarget: 1, targetHz: 115, formantFollow: 1, formant: -1, warmth: 2.5, bass: 2, clarity: 1, presence: -0.5, comp: 0.3, level: 2.5 },
    main: ['targetHz', 'formant', 'warmth', 'bass', 'vibrato', 'psola'] },
  { id: 'female', icon: 'venus',
    sysLevel: -0.2,
    preset: { psola: 1, autoTarget: 1, targetHz: 195, formantFollow: 1, lowcut: 90, air: 1, level: 4, comp: 0.3 },
    main: ['targetHz', 'formant', 'air', 'presence', 'warmth', 'vibrato', 'psola'] },
  { id: 'child', icon: 'baby',
    sysLevel: 0.2,
    preset: { psola: 1, autoTarget: 1, targetHz: 260, formantFollow: 1, formant: 1, lowcut: 150, clarity: 2, presence: 1, air: 1, level: 4.5, comp: 0.4 },
    main: ['targetHz', 'formant', 'air', 'presence', 'vibrato', 'psola'] },
  { id: 'autotune', icon: 'music',
    sysLevel: 1.1,
    preset: { psola: 1, tune: 1, comp: 0.45, deess: 0.35, clarity: 2, presence: 2, air: 2.5, excite: 0.2, double: 0.3, reverb: 0.15, size: 0.3, level: 3.5 },
    main: ['tune', 'pitch', 'formant', 'double', 'reverb'] },
  // deep demonic growl: an octave down with a bigger "vocal tract", false-chord rattle and rasp, an undertone
  // another octave below, saturation darkened by the high cut, heavy low end, compressed
  { id: 'demon', icon: 'demon',
    sysLevel: -7.8,
    preset: { psola: 1, pitch: -12, formant: -6, growl: 0.8, sub: 0.55, drive: 0.6, lowcut: 40, highcut: 6500, bass: 5, warmth: 3,
      presence: 2, comp: 0.6, reverb: 0.25, size: 0.6, level: 0.5 },
    main: ['pitch', 'formant', 'growl', 'sub', 'drive', 'reverb'] },
  // divine / angelic: a calm, slightly lower voice wrapped in a quiet choir (octaves and a fifth) and a shimmering
  // cathedral tail; widened, airy, gently compressed
  { id: 'divine', icon: 'halo',
    sysLevel: -1.9,
    preset: { psola: 1, pitch: -2.5, formant: -1, halo: 0.6, comp: 0.55, deess: 0.3, warmth: 1.5, lowcut: 60, presence: 1, air: 4,
      double: 0.4, chorus: 0.2, chorusRate: 0.25, reverb: 0.55, size: 0.9, level: 2.5 },
    main: ['halo', 'pitch', 'formant', 'reverb', 'size', 'double', 'air'] },
  // early web text-to-speech: a flat, steady pitch that jumps between levels from syllable to syllable, glued-together
  // joins, the vocoder's slightly phasey tone, a lower sample rate, narrow and loud
  { id: 'tts', icon: 'tts',
    sysLevel: 1.6,
    preset: { autoTarget: 1, targetHz: 185, formantFollow: 1, mono: 1, monoHz: 185, steps: 0.9, decimate: 0.1, crush: 0.12,
      lowcut: 160, highcut: 7000, presence: 3, clarity: 2, comp: 0.6, level: 4.5 },
    main: ['steps', 'monoHz', 'targetHz', 'decimate', 'highcut'] },
  { id: 'ghost', icon: 'ghost',
    sysLevel: 6.1,
    preset: { pitch: 3, formant: 2, whisper: 0.55, lowcut: 300, air: 3, echo: 0.4, echoTime: 0.33, echoFb: 0.45, reverb: 0.6, size: 0.9,
      tremolo: 0.35, tremoloHz: 4, level: 8.5, comp: 0.3 },
    main: ['whisper', 'echo', 'reverb', 'tremolo'] },
  { id: 'digital', icon: 'bot', sysLevel: 2.9, preset: { psola: 1, mono: 1, monoHz: 100, ring: 0.35, ringHz: 60, crush: 0.25, presence: 2, highcut: 9000, level: 7, comp: 0.5 },
    main: ['monoHz', 'mono', 'ring', 'ringHz', 'crush'] },
  { id: 'hologram_classic', icon: 'orbit',
    sysLevel: 3.4,
    preset: { ring: 0.5, ringHz: 50, lowcut: 400, highcut: 4500, presence: 4, chorus: 0.5, chorusRate: 0.3, noise: 0.15, level: 6.5, comp: 0.5 },
    main: ['ring', 'ringHz', 'chorus', 'noise'] },
  { id: 'hologram_warm', icon: 'sparkles', sysLevel: -1, preset: { chorus: 0.6, chorusRate: 0.2, highcut: 6000, bass: 2, reverb: 0.3, size: 0.4, level: 1.5, comp: 0.3 },
    main: ['chorus', 'reverb', 'highcut'] },
  { id: 'smolder', icon: 'flame', sysLevel: -0.7, preset: { psola: 1, pitch: -3, formant: -1.5, drive: 0.4, whisper: 0.15, bass: 3, reverb: 0.2, size: 0.3, level: 2, comp: 0.3 },
    main: ['pitch', 'drive', 'whisper'] },
  { id: 'ice', icon: 'snowflake',
    sysLevel: 2.2,
    preset: { pitch: 2, formant: 1.5, ring: 0.25, ringHz: 420, air: 6, presence: 2, chorus: 0.3, reverb: 0.45, size: 0.8, level: 5, comp: 0.4 },
    main: ['ring', 'ringHz', 'air', 'reverb'] },
  { id: 'electric', icon: 'zap',
    sysLevel: 3.4,
    preset: { ring: 0.6, ringHz: 90, crush: 0.45, decimate: 0.2, drive: 0.2, lowcut: 300, highcut: 6000, noise: 0.25, level: 6.5, comp: 0.5 },
    main: ['ring', 'crush', 'decimate', 'noise'] },
  { id: 'vhs', icon: 'cassette', sysLevel: 2.1, preset: { wow: 0.7, crush: 0.35, drive: 0.15, lowcut: 120, highcut: 4000, noise: 0.35, level: 5, comp: 0.35 },
    main: ['wow', 'crush', 'noise', 'highcut'] },
  { id: 'giant', icon: 'mountain', sysLevel: -1.1, preset: { psola: 1, pitch: -12, formant: -7, bass: 4, reverb: 0.25, size: 0.7, level: 2.5, comp: 0.45 },
    main: ['pitch', 'formant', 'reverb'] },
  { id: 'chipmunk', icon: 'acorn', sysLevel: -0.3, preset: { psola: 1, pitch: 12, formant: 12, lowcut: 200, level: 2.5, comp: 0.35 },
    main: ['pitch', 'formant'] },
  // a real whisper: no pitch at all (noise shaped by the voice's formants), breathy highs, no low end, close and dry
  { id: 'whisper', icon: 'wind',
    sysLevel: 8.7,
    preset: { whisper: 1, denoise: 0.4, lowcut: 350, bass: -4, warmth: -2, presence: 5, air: 4, deess: 0.25, comp: 0.5, level: 11 },
    main: ['whisper', 'presence', 'air', 'denoise'] },
  { id: 'radio', icon: 'radio', sysLevel: -0.6, preset: { lowcut: 500, highcut: 3200, drive: 0.5, presence: 6, noise: 0.2, crush: 0.15, level: 3, comp: 0.5 },
    main: ['drive', 'noise', 'lowcut', 'highcut'] },
  { id: 'cave', icon: 'cave', sysLevel: -0.5, preset: { reverb: 0.8, size: 1, echo: 0.3, echoTime: 0.45, echoFb: 0.3, bass: 2, level: 2, comp: 0.4 },
    main: ['reverb', 'size', 'echo'] },
  // ---- added in the catalog overhaul
  // landline phone: the 300–3400 Hz band at an 8 kHz-ish sample rate (the decimation's aliasing is part of the sound),
  // slightly overdriven and squashed like a telephone line
  { id: 'telephone', icon: 'phone', sysLevel: 1.7,
    preset: { lowcut: 320, highcut: 3400, decimate: 0.33, crush: 0.2, drive: 0.25, presence: 4, clarity: 2, comp: 0.6, level: 5.5 },
    main: ['lowcut', 'highcut', 'decimate', 'drive'] },
  // police / crowd megaphone: a honky horn band, hard-driven, a short outdoor slap
  { id: 'megaphone', icon: 'megaphone', sysLevel: -3.6,
    preset: { lowcut: 500, highcut: 4500, drive: 0.7, grit: 0.2, presence: 6, clarity: 3, comp: 0.3, reverb: 0.15, size: 0.4, level: -0.5 },
    main: ['drive', 'grit', 'presence', 'reverb'] },
  // stadium announcer: a PA voice (compressed, forward) thrown across an arena: slap-back echo and a huge tail
  { id: 'stadium', icon: 'stadium', sysLevel: -0.5,
    preset: { lowcut: 180, highcut: 7000, presence: 4, clarity: 2, comp: 0.7, drive: 0.15, echo: 0.35, echoTime: 0.27, echoFb: 0.3,
      reverb: 0.5, size: 0.95, level: 5 },
    main: ['echo', 'echoTime', 'reverb', 'size'] },
  // movie-trailer narrator: a few semitones lower, a bigger chest, heavily compressed and close, a hint of a large hall
  { id: 'narrator', icon: 'clapper', sysLevel: -1.6,
    preset: { psola: 1, pitch: -4, formant: -2, comp: 0.75, deess: 0.3, bass: 4, warmth: 3, clarity: 2, presence: 2, excite: 0.2,
      reverb: 0.18, size: 0.75, level: 6 },
    main: ['pitch', 'formant', 'bass', 'comp', 'reverb'] },
  // helium: the vocal tract "gets smaller" (formants far up) while the pitch barely moves — unlike the chipmunk
  { id: 'helium', icon: 'balloon', sysLevel: 0.5,
    preset: { psola: 1, pitch: 2, formant: 8, lowcut: 180, clarity: 1, comp: 0.35, level: 5 },
    main: ['formant', 'pitch'] },
  // old man: a lower, breathy, slightly creaky voice with a ~6 Hz tremor in pitch and loudness
  { id: 'oldman', icon: 'cane', sysLevel: 2.5,
    preset: { psola: 1, pitch: -1, formant: -0.5, vibrato: 0.55, vibratoHz: 6, tremolo: 0.15, tremoloHz: 6, fry: 0.3, rasp: 0.15,
      whisper: 0.15, lowcut: 120, highcut: 6000, presence: 1, comp: 0.3, level: 5 },
    main: ['vibrato', 'vibratoHz', 'fry', 'whisper'] },
  // zombie: lower, hoarse and creaky (vocal fry + rasp), a little breath and growl, dark
  { id: 'zombie', icon: 'zombie', sysLevel: 3.7,
    preset: { psola: 1, pitch: -4, formant: -2, fry: 0.7, rasp: 0.6, growl: 0.3, whisper: 0.2, lowcut: 80, highcut: 5000, comp: 0.6,
      reverb: 0.15, size: 0.4, level: 7 },
    main: ['pitch', 'fry', 'rasp', 'growl', 'whisper'] },
  // alien: a higher voice with a lower vocal tract (an odd combination for a human), ring modulation, a fast warble
  { id: 'alien', icon: 'alien', sysLevel: 1.2,
    preset: { psola: 1, pitch: 4, formant: -3, ring: 0.3, ringHz: 140, vibrato: 0.6, vibratoHz: 9, chorus: 0.5, chorusRate: 2.5,
      reverb: 0.3, size: 0.6, comp: 0.4, level: 7.5 },
    main: ['pitch', 'formant', 'ring', 'ringHz', 'vibrato'] },
  // underwater: everything above ~750 Hz is gone, the sound wobbles and smears
  { id: 'underwater', icon: 'bubbles', sysLevel: 1.4,
    preset: { lowcut: 80, highcut: 750, bass: 4, wow: 0.6, vibrato: 0.5, vibratoHz: 7, chorus: 0.6, chorusRate: 3, reverb: 0.25, size: 0.5,
      comp: 0.3, level: 4 },
    main: ['highcut', 'wow', 'chorus', 'reverb'] },
  // Neural voices: a real voice model (Seed-VC on an NVIDIA GPU) instead of pitch/formant tricks; ~0.4 s latency.
  // Without the GPU mode they fall back to the DSP "female"/"male" (see NEURAL_FALLBACK).
  { id: 'neural_female', icon: 'venus', neural: 'female',
    preset: { comp: 0.35, deess: 0.25, lowcut: 80, presence: 1, air: 1.5, level: 2.5 },
    main: ['comp', 'deess', 'presence', 'air', 'warmth', 'reverb'] },
  { id: 'neural_male', icon: 'mars', neural: 'male',
    preset: { comp: 0.35, deess: 0.2, lowcut: 60, warmth: 1.5, presence: 0.5, level: 1.5 },
    main: ['comp', 'deess', 'warmth', 'bass', 'presence', 'reverb'] },
]
export const EFFECT = Object.fromEntries(EFFECTS.map((e) => [e.id, e])) as Record<BuiltinId, EffectInfo>

// ---------------------------------------------------------------- custom effects (stored in the engine settings)

let CUSTOM: CustomEffect[] = []
const customInfo = new Map<string, EffectInfo>()
export function setCustom(list: CustomEffect[] | undefined): void {
  // a damaged entry is dropped on its own — never the whole list
  CUSTOM = (Array.isArray(list) ? list : []).filter((c) =>
    c && typeof c === 'object' && typeof c.id === 'string' && c.id.startsWith('c-') && typeof c.name === 'string'
    && !!c.preset && typeof c.preset === 'object')
  customInfo.clear()
  for (const c of CUSTOM) {
    // older saves: an emoji instead of an icon id
    if (!c.icon || c.emoji !== undefined) { c.icon = customIcon(c.icon ?? c.emoji); delete c.emoji }
    customInfo.set(c.id, { id: c.id, icon: c.icon, preset: c.preset, main: EFFECT[c.base]?.main ?? EFFECT.clean.main })
  }
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
export const NEURAL_FALLBACK: Record<'female' | 'male', BuiltinId> = { female: 'female', male: 'male' }
export const isNeural = (id: EffectId): boolean => !!effectInfo(id)?.neural

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

/** Level offset (dB) of an effect on the computer-sound track. Mic presets are levelled to the loudness of "Clean"
 *  (which is compressed and ~7 dB louder than raw speech), but untouched sound is the reference for the computer-sound
 *  track and the compressor is off there, so each built-in effect carries its own level for that track (sysLevel).
 *  Custom effects inherit the offset of the effect they were made from. */
export function sysLevelOffset(id: EffectId): number {
  const base = isCustom(id) ? CUSTOM.find((c) => c.id === id)?.base : id
  const info = base ? EFFECT[base] : undefined
  return info?.sysLevel === undefined ? 0 : info.sysLevel - (info.preset.level ?? 0)
}

/** What the computer-sound track plays for an effect at strength amount: "Clean" means untouched (its preset is voice
 *  EQ/enhancement) plus only the user's own edits; other effects get their computer-sound level, then forSystemSound. */
export function systemSoundTarget(id: EffectId, user: EffectUser | undefined, amount: number): FxParams {
  const t = Math.max(0, Math.min(1, amount))
  if (id === 'clean') return forSystemSound(interpolate(NEUTRAL, { ...NEUTRAL, ...(user?.p ?? {}) }, t))
  const full = effectFull(id, user)
  full.level = Math.max(PARAM.level.min, Math.min(PARAM.level.max, full.level + sysLevelOffset(id)))
  return forSystemSound(interpolate(NEUTRAL, full, t))
}

/**
 * Presets with a fixed shift are tuned for an average voice (~150 Hz): -12 st makes a 150 Hz voice a 75 Hz demon,
 * but leaves a 205 Hz female voice at a not-so-demonic 102 Hz, and a chipmunk from a deep voice ends up too low.
 * Knowing the speaker, part of the gap to the average voice is added: the character lands where it was meant to,
 * while the speaker's own voice still shows through. Adaptive presets (autoTarget) follow the real pitch anyway.
 */
const SPEAKER_HZ = { male: 115, female: 205 } as const
const SPEAKER_PITCH = 0.6 // share of the gap to the average voice that is compensated
const SPEAKER_FORMANT = 1.2 // st: female vocal tracts are shorter (~2.4 st between average male and female)

export function adaptToSpeaker(p: FxParams, speaker: Speaker): FxParams {
  if (speaker === 'neutral' || p.autoTarget >= 0.5) return p
  const out = { ...p }
  if (Math.abs(p.pitch) >= 2) {
    const gap = 12 * Math.log2(150 / SPEAKER_HZ[speaker]) // male +4.6 st, female -5.6 st
    out.pitch = Math.max(-24, Math.min(24, p.pitch + SPEAKER_PITCH * gap))
  }
  if (Math.abs(p.formant) >= 1) {
    out.formant = Math.max(-12, Math.min(12, p.formant + (speaker === 'female' ? -SPEAKER_FORMANT : SPEAKER_FORMANT)))
  }
  return out
}

/** What is heard: the effect at strength amount (0..1), the fraction of the way from neutral sound to the effect */
export function effectTarget(id: EffectId, user: EffectUser | undefined, amount: number, speaker: Speaker = 'neutral'): FxParams {
  return interpolate(NEUTRAL, adaptToSpeaker(effectFull(id, user), speaker), Math.max(0, Math.min(1, amount)))
}
