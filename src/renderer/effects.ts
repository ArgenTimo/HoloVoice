// Эффекты — пресеты одной цепочки обработки (rig.ts). Любой параметр любого эффекта можно подкрутить в панели;
// переход между эффектами и нарастание — плавная интерполяция всех параметров (частоты — в логарифме).
// Идея и первые цепочки — из holo-messenger (src/client/audio/voice-fx.ts).

export type ParamKey =
  | 'denoise' | 'pitch' | 'formant' | 'vibrato' | 'vibratoHz' | 'robot' | 'whisper'
  | 'autoTarget' | 'targetHz' | 'formantFollow' | 'tune' | 'mono' | 'monoHz' | 'psola'
  | 'comp' | 'deess' | 'warmth' | 'clarity' | 'excite' | 'double'
  | 'drive' | 'crush' | 'decimate' | 'ring' | 'ringHz'
  | 'lowcut' | 'highcut' | 'bass' | 'presence' | 'air'
  | 'wow' | 'chorus' | 'chorusRate' | 'tremolo' | 'tremoloHz'
  | 'echo' | 'echoTime' | 'echoFb' | 'reverb' | 'size' | 'noise' | 'level'
export type FxParams = Record<ParamKey, number>

export interface ParamDef {
  key: ParamKey; label: string; group: string
  min: number; max: number; step: number
  fmt: (v: number) => string
  log?: boolean // частоты: ползунок и интерполяция в логарифме
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
const st = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} пт`
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} кГц` : `${v < 10 ? v.toFixed(1) : Math.round(v)} Гц`)
const sec = (v: number) => `${v.toFixed(2)} с`

export const PARAMS: ParamDef[] = [
  { key: 'psola', label: 'Естественная обработка (PSOLA)', group: 'Голос', min: 0, max: 1, step: 1, fmt: (v) => (v >= 0.5 ? 'вкл' : 'выкл') },
  { key: 'targetHz', label: 'Целевая высота голоса', group: 'Голос', min: 60, max: 450, step: 1, fmt: hz, log: true },
  { key: 'autoTarget', label: 'Подстройка под цель', group: 'Голос', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'formantFollow', label: 'Тембр следом за высотой', group: 'Голос', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'pitch', label: 'Высота (сдвиг)', group: 'Голос', min: -24, max: 24, step: 0.5, fmt: st },
  { key: 'formant', label: 'Тембр (форманты)', group: 'Голос', min: -12, max: 12, step: 0.5, fmt: st },
  { key: 'whisper', label: 'Дыхание / шёпот', group: 'Голос', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'vibrato', label: 'Вибрато', group: 'Голос', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'vibratoHz', label: 'Скорость вибрато', group: 'Голос', min: 0.5, max: 12, step: 0.1, fmt: hz, log: true },
  { key: 'tune', label: 'Автотюн (к нотам)', group: 'Голос', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'mono', label: 'Монотонность', group: 'Голос', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'monoHz', label: 'Нота монотонности', group: 'Голос', min: 50, max: 450, step: 1, fmt: hz, log: true },
  { key: 'robot', label: 'Робот (жужжание)', group: 'Голос', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'denoise', label: 'Шумоподавление', group: 'Улучшение', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'comp', label: 'Компрессия (ровность)', group: 'Улучшение', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'deess', label: 'Де-эссер (свист «с»)', group: 'Улучшение', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'warmth', label: 'Теплота', group: 'Улучшение', min: -12, max: 12, step: 0.5, fmt: db },
  { key: 'clarity', label: 'Чистота (без бубнения)', group: 'Улучшение', min: -6, max: 12, step: 0.5, fmt: db },
  { key: 'excite', label: 'Блеск', group: 'Улучшение', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'double', label: 'Объём (дублер)', group: 'Улучшение', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'drive', label: 'Перегруз', group: 'Окраска', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'crush', label: 'Огрубление (биты)', group: 'Окраска', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'decimate', label: 'Цифровая грязь', group: 'Окраска', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'ring', label: 'Кольцевая модуляция', group: 'Окраска', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'ringHz', label: 'Её частота', group: 'Окраска', min: 10, max: 1500, step: 1, fmt: hz, log: true },
  { key: 'noise', label: 'Шум', group: 'Окраска', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'lowcut', label: 'Срез низа', group: 'Тон', min: 20, max: 1500, step: 1, fmt: hz, log: true },
  { key: 'highcut', label: 'Срез верха', group: 'Тон', min: 1500, max: 20000, step: 10, fmt: hz, log: true },
  { key: 'bass', label: 'Низы', group: 'Тон', min: -12, max: 12, step: 0.5, fmt: db },
  { key: 'presence', label: 'Разборчивость', group: 'Тон', min: -12, max: 12, step: 0.5, fmt: db },
  { key: 'air', label: 'Воздух', group: 'Тон', min: -12, max: 12, step: 0.5, fmt: db },
  { key: 'level', label: 'Уровень', group: 'Тон', min: -18, max: 12, step: 0.5, fmt: db },
  { key: 'wow', label: 'Плавание плёнки', group: 'Движение', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'chorus', label: 'Хорус', group: 'Движение', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'chorusRate', label: 'Скорость хоруса', group: 'Движение', min: 0.05, max: 8, step: 0.01, fmt: hz, log: true },
  { key: 'tremolo', label: 'Тремоло', group: 'Движение', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'tremoloHz', label: 'Скорость тремоло', group: 'Движение', min: 0.5, max: 20, step: 0.1, fmt: hz, log: true },
  { key: 'echo', label: 'Эхо', group: 'Пространство', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'echoTime', label: 'Задержка эха', group: 'Пространство', min: 0.04, max: 1.2, step: 0.01, fmt: sec },
  { key: 'echoFb', label: 'Повторы эха', group: 'Пространство', min: 0, max: 0.9, step: 0.01, fmt: pct },
  { key: 'reverb', label: 'Реверберация', group: 'Пространство', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'size', label: 'Размер помещения', group: 'Пространство', min: 0, max: 1, step: 0.01, fmt: pct },
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

export type EffectId =
  | 'clean' | 'male' | 'female' | 'child' | 'autotune' | 'giant' | 'chipmunk'
  | 'demon' | 'ghost' | 'digital' | 'whisper' | 'radio'
  | 'hologram_classic' | 'hologram_warm' | 'smolder' | 'ice' | 'electric' | 'vhs' | 'cave'

export interface EffectInfo {
  id: EffectId; label: string; emoji: string
  preset: Partial<FxParams>
  main: ParamKey[] // главные ручки эффекта — показываются сразу, остальные в «Все параметры»
}

export const EFFECTS: EffectInfo[] = [
  { id: 'clean', label: 'Чистый', emoji: '🎙️',
    preset: { denoise: 0.3, comp: 0.45, deess: 0.3, warmth: 1.5, clarity: 2, presence: 1.5, air: 2, excite: 0.15, lowcut: 70, level: 2.5 },
    main: ['denoise', 'comp', 'deess', 'warmth', 'clarity', 'presence', 'air', 'excite', 'double', 'reverb'] },
  { id: 'male', label: 'Мужской', emoji: '👨',
    preset: { psola: 1, autoTarget: 1, targetHz: 105, formantFollow: 1, warmth: 2.5, bass: 2, clarity: 1, comp: 0.4, deess: 0.2, presence: -0.5, level: -2 },
    main: ['targetHz', 'formant', 'warmth', 'bass', 'vibrato', 'comp', 'psola'] },
  { id: 'female', label: 'Женский', emoji: '👩',
    preset: { psola: 1, autoTarget: 1, targetHz: 215, formantFollow: 1, lowcut: 130, warmth: -1, bass: -2, clarity: 2, presence: 2, air: 3, comp: 0.4, deess: 0.45, excite: 0.15, level: -3 },
    main: ['targetHz', 'formant', 'air', 'warmth', 'presence', 'vibrato', 'deess', 'psola'] },
  { id: 'child', label: 'Детский', emoji: '🧒',
    preset: { psola: 1, autoTarget: 1, targetHz: 290, formantFollow: 1, formant: 1, lowcut: 200, warmth: -2, clarity: 2, presence: 2.5, air: 3, comp: 0.35, deess: 0.5, level: -4 },
    main: ['targetHz', 'formant', 'air', 'presence', 'vibrato', 'deess', 'psola'] },
  { id: 'autotune', label: 'Автотюн', emoji: '🎤',
    preset: { psola: 1, tune: 1, comp: 0.45, deess: 0.35, clarity: 2, presence: 2, air: 2.5, excite: 0.2, double: 0.3, reverb: 0.15, size: 0.3, level: -3.5 },
    main: ['tune', 'pitch', 'formant', 'double', 'reverb'] },
  { id: 'demon', label: 'Демон', emoji: '😈', preset: { psola: 1, pitch: -8, formant: -5, drive: 0.45, bass: 6, reverb: 0.35, size: 0.6, level: 0.5 },
    main: ['pitch', 'formant', 'drive', 'reverb'] },
  { id: 'ghost', label: 'Призрак', emoji: '👻',
    preset: { pitch: 3, formant: 2, whisper: 0.55, lowcut: 300, air: 3, echo: 0.4, echoTime: 0.33, echoFb: 0.45, reverb: 0.6, size: 0.9,
      tremolo: 0.35, tremoloHz: 4, level: 2.5 },
    main: ['whisper', 'echo', 'reverb', 'tremolo'] },
  { id: 'digital', label: 'Робот', emoji: '🤖', preset: { psola: 1, mono: 1, monoHz: 100, ring: 0.35, ringHz: 60, crush: 0.25, presence: 2, highcut: 9000, level: 2.5 },
    main: ['monoHz', 'mono', 'ring', 'ringHz', 'crush'] },
  { id: 'hologram_classic', label: 'Голограмма', emoji: '🛰️',
    preset: { ring: 0.5, ringHz: 50, lowcut: 400, highcut: 4500, presence: 4, chorus: 0.5, chorusRate: 0.3, noise: 0.15, level: -2.5 },
    main: ['ring', 'ringHz', 'chorus', 'noise'] },
  { id: 'hologram_warm', label: 'Тёплая', emoji: '✨', preset: { chorus: 0.6, chorusRate: 0.2, highcut: 6000, bass: 2, reverb: 0.3, size: 0.4, level: -2.5 },
    main: ['chorus', 'reverb', 'highcut'] },
  { id: 'smolder', label: 'Хрипотца', emoji: '🔥', preset: { psola: 1, pitch: -3, formant: -1.5, drive: 0.4, whisper: 0.15, bass: 3, reverb: 0.2, size: 0.3, level: 0.5 },
    main: ['pitch', 'drive', 'whisper'] },
  { id: 'ice', label: 'Лёд', emoji: '🧊',
    preset: { pitch: 2, formant: 1.5, ring: 0.25, ringHz: 420, air: 6, presence: 2, chorus: 0.3, reverb: 0.45, size: 0.8, level: 0 },
    main: ['ring', 'ringHz', 'air', 'reverb'] },
  { id: 'electric', label: 'Провод', emoji: '⚡',
    preset: { ring: 0.6, ringHz: 90, crush: 0.45, decimate: 0.2, drive: 0.2, lowcut: 300, highcut: 6000, noise: 0.25, level: 1.5 },
    main: ['ring', 'crush', 'decimate', 'noise'] },
  { id: 'vhs', label: 'VHS', emoji: '📼', preset: { wow: 0.7, crush: 0.35, drive: 0.15, lowcut: 120, highcut: 4000, noise: 0.35, level: 1 },
    main: ['wow', 'crush', 'noise', 'highcut'] },
  { id: 'giant', label: 'Великан', emoji: '🗿', preset: { psola: 1, pitch: -12, formant: -7, bass: 4, reverb: 0.25, size: 0.7, level: 1 },
    main: ['pitch', 'formant', 'reverb'] },
  { id: 'chipmunk', label: 'Бурундук', emoji: '🐿️', preset: { psola: 1, pitch: 12, formant: 12, lowcut: 200, level: -1.5 },
    main: ['pitch', 'formant'] },
  { id: 'whisper', label: 'Шёпот', emoji: '🤫', preset: { whisper: 1, lowcut: 300, presence: 3, air: 4, level: 5.5 },
    main: ['whisper', 'air', 'reverb'] },
  { id: 'radio', label: 'Рация', emoji: '📻', preset: { lowcut: 500, highcut: 3200, drive: 0.5, presence: 6, noise: 0.2, crush: 0.15, level: -7.5 },
    main: ['drive', 'noise', 'lowcut', 'highcut'] },
  { id: 'cave', label: 'Пещера', emoji: '🕳️', preset: { reverb: 0.8, size: 1, echo: 0.3, echoTime: 0.45, echoFb: 0.3, bass: 2, level: -1.5 },
    main: ['reverb', 'size', 'echo'] },
]
export const EFFECT = Object.fromEntries(EFFECTS.map((e) => [e.id, e])) as Record<EffectId, EffectInfo>

/** Настройки одного эффекта, сохранённые пользователем (поверх пресета) */
export interface EffectUser { p?: Partial<FxParams>; rampIn?: number; rampOut?: number }

/** Полные параметры эффекта: нейтраль ← пресет ← свои правки */
export function effectFull(id: EffectId, user?: EffectUser): FxParams {
  return { ...NEUTRAL, ...(EFFECT[id]?.preset ?? {}), ...(user?.p ?? {}) }
}

/** Между a и b на долю t; частоты — в логарифме, чтобы звучало равномерно */
export function interpolate(a: FxParams, b: FxParams, t: number): FxParams {
  const out = { ...a }
  for (const d of PARAMS) {
    const x = a[d.key], y = b[d.key]
    out[d.key] = d.log && x > 0 && y > 0 ? x * (y / x) ** t : x + (y - x) * t
  }
  return out
}

/** Что звучит: эффект с силой amount (0..1) — доля пути от нейтрального звука к эффекту */
export function effectTarget(id: EffectId, user: EffectUser | undefined, amount: number): FxParams {
  return interpolate(NEUTRAL, effectFull(id, user), Math.max(0, Math.min(1, amount)))
}
