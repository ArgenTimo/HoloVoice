// Главное окно — пульт движка. Раскладка: слева карточки дорожек (вкл/выкл, уровни, сила, громкость),
// по центру каталог эффектов для выбранной дорожки, справа настройки выбранного эффекта и «Проверить на записи»,
// снизу — устройства. Горячие клавиши и подсказка на экране — в окнах поверх панели.
// Звук здесь не обрабатывается (см. engine.ts).
import { PARAM, PARAMS, customs, effectFull, effectInfo, fxLabel, groupLabel, isCustom, paramLabel, setCustom, type EffectId, type ParamDef, type ParamKey } from './effects'
import { LANGS, applyStatic, flagSvg, lang, setLang, t } from './i18n'
import { $, holo, type EngineState, type HotkeyInfo, type LaneId, type Levels, type OsdPos, type Quality, type UiConfig } from './shared'

let st: EngineState | null = null
let ui: UiConfig
let hk: HotkeyInfo = { map: {}, failed: [] }
const LANES: LaneId[] = ['mic', 'sys']
const laneName = (id: LaneId) => t(`lane.${id}`)
const LANE_ICO: Record<LaneId, string> = { mic: '🎙️', sys: '🔊' }

const BUILTIN_GROUPS: [string, EffectId[]][] = [
  ['grp.voices', ['clean', 'male', 'female', 'child', 'autotune', 'giant', 'chipmunk', 'whisper']],
  ['grp.characters', ['demon', 'ghost', 'digital', 'smolder']],
  ['grp.atmo', ['hologram_classic', 'hologram_warm', 'ice', 'electric', 'vhs', 'radio', 'cave']],
]
/** Группы каталога: встроенные + «Мои эффекты», если они есть */
function groups(): [string, EffectId[]][] {
  const mine = customs().map((c) => c.id)
  return mine.length ? [...BUILTIN_GROUPS, ['grp.custom', mine]] : BUILTIN_GROUPS
}
/** Подпись набора своих эффектов: меняется — каталог, списки и горячие клавиши перестраиваются */
let customSig = ''
const sigOf = () => customs().map((c) => c.id + c.name + c.emoji).join('|')
const emojiOf = (id: EffectId) => effectInfo(id)?.emoji ?? '⭐'

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

// ---------------------------------------------------------------- карточки дорожек

const LANE_SLIDERS: { key: 'amount' | 'gain' | 'gate'; min: number; max: number; fmt: (v: number) => string; lanes: LaneId[] }[] = [
  { key: 'amount', min: 0, max: 100, fmt: (v) => `${v}%`, lanes: ['mic', 'sys'] },
  { key: 'gain', min: 0, max: 200, fmt: (v) => `${v}%`, lanes: ['mic', 'sys'] },
  { key: 'gate', min: -80, max: -20, fmt: (v) => (v <= -80 ? t('u.off') : `${v}`), lanes: ['mic'] },
]
const laneInputs: { lane: LaneId; key: 'amount' | 'gain' | 'gate'; input: HTMLInputElement; val: HTMLElement; fmt: (v: number) => string }[] = []

function buildLanes(): void {
  const box = $('lanes')
  for (const id of LANES) {
    const card = el('section', 'lane-card')
    card.dataset.lane = id
    card.id = `card-${id}`
    card.innerHTML = `
      <div class="lc-head">
        <div class="lc-ico">${LANE_ICO[id]}</div>
        <div class="lc-title"><div class="lc-name">${laneName(id)}</div><div class="lc-fx" id="fx-${id}"></div></div>
        <button class="switch" id="sw-${id}" title="${id === 'mic' ? 'Ctrl+Alt+V' : 'Ctrl+Alt+B'}"><i></i></button>
      </div>
      <select class="lc-fxsel" id="fxsel-${id}"></select>
      <div class="meters">
        <span>${t('lane.in')}</span><div class="bar-m"><i id="mi-${id}"></i></div>
        <span>${t('lane.out')}</span><div class="bar-m"><i id="mo-${id}"></i></div>
      </div>
      <div class="voice" id="voice-${id}"></div>
      <div class="lc-ctrls" id="ctrls-${id}"></div>
      <div class="lc-hint" id="hint-${id}"></div>`
    box.appendChild(card)
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.switch, .lc-ctrls, .lc-hint, select')) return
      selectLane(id)
    })
    $(`sw-${id}`).onclick = () => holo.cmd({ type: 'toggle', lane: id })
    const sel = $<HTMLSelectElement>(`fxsel-${id}`)
    fillFxSelect(sel)
    sel.onchange = () => holo.cmd({ type: 'effect', lane: id, effect: sel.value as EffectId })
    const ctrls = $(`ctrls-${id}`)
    for (const d of LANE_SLIDERS.filter((x) => x.lanes.includes(id))) {
      const row = el('label', 'mini')
      row.title = t(`lane.${d.key}Tip`)
      const input = el('input')
      input.type = 'range'; input.min = String(d.min); input.max = String(d.max); input.step = '1'
      const val = el('b')
      input.oninput = () => {
        val.textContent = d.fmt(Number(input.value))
        holo.cmd({ type: 'set', lane: id, key: d.key, value: Number(input.value) })
      }
      row.append(el('span', '', t(`lane.${d.key}`)), input, val)
      ctrls.appendChild(row)
      laneInputs.push({ lane: id, key: d.key, input, val, fmt: d.fmt })
    }
    const q = el('label', 'mini')
    q.title = t('lane.qualityTip')
    q.innerHTML = `<span>${t('lane.quality')}</span><select id="q-${id}"><option value="hq">${t('lane.qHq')}</option><option value="fast">${t('lane.qFast')}</option></select>`
    ctrls.appendChild(q)
    const qs = $<HTMLSelectElement>(`q-${id}`)
    qs.onchange = () => holo.cmd({ type: 'quality', lane: id, value: qs.value as Quality })
  }
}

function fillFxSelect(sel: HTMLSelectElement): void {
  sel.innerHTML = ''
  for (const [, ids] of groups()) for (const fx of ids) {
    const o = el('option', '', `${emojiOf(fx)} ${fxLabel(fx)}`)
    o.value = fx
    sel.appendChild(o)
  }
}

function renderLanes(): void {
  if (!st) return
  for (const id of LANES) {
    const cfg = st.S.lanes[id]
    const fx = { id: cfg.effect, emoji: emojiOf(cfg.effect) }
    $(`card-${id}`).classList.toggle('on', cfg.enabled)
    $(`card-${id}`).classList.toggle('sel', ui.tab === id)
    $(`sw-${id}`).classList.toggle('on', cfg.enabled)
    $(`fx-${id}`).textContent = cfg.enabled ? `${fx.emoji} ${fxLabel(fx.id)}` : t(id === 'mic' ? 'lane.offMic' : 'lane.offSys')
    const sel = $<HTMLSelectElement>(`fxsel-${id}`)
    if (document.activeElement !== sel) sel.value = cfg.effect
    const q = $<HTMLSelectElement>(`q-${id}`)
    if (document.activeElement !== q) q.value = cfg.quality
    const h = $(`hint-${id}`)
    h.innerHTML = st.hint[id].html // собирается в движке, подписи устройств экранированы там
    h.classList.toggle('warn', st.hint[id].warn)
  }
  for (const s of laneInputs) {
    if (document.activeElement === s.input) continue
    const v = Number(st.S.lanes[s.lane][s.key])
    s.input.value = String(v)
    s.val.textContent = s.fmt(v)
  }
}

function selectLane(id: LaneId): void {
  ui.tab = id
  holo.setUi({ tab: id })
  document.body.classList.toggle('lane-sys', id === 'sys')
  $('cat-lane').textContent = `${LANE_ICO[id]} ${laneName(id)}`
  renderLanes()
  renderCatalog()
  renderInspector()
}

// ---------------------------------------------------------------- каталог эффектов

function buildCatalog(): void {
  const box = $('groups')
  box.innerHTML = ''
  for (const [title, ids] of groups()) {
    const g = el('div', 'group')
    g.appendChild(el('h3', '', t(title)))
    const tiles = el('div', 'tiles')
    for (const id of ids) {
      const tile = el('button', 'tile')
      tile.dataset.effect = id
      tile.append(el('span', 't-emoji', emojiOf(id)), el('span', 't-name', fxLabel(id)), el('span', 't-key'))
      tile.onclick = () => holo.cmd({ type: 'effect', lane: ui.tab, effect: id })
      if (isCustom(id)) {
        const del = el('span', 't-del', '✕')
        del.title = t('ins.delete')
        del.onclick = (e) => { e.stopPropagation(); holo.cmd({ type: 'customDelete', id }) }
        tile.appendChild(del)
      }
      tiles.appendChild(tile)
    }
    g.appendChild(tiles)
    box.appendChild(g)
  }
}

function renderCatalog(): void {
  if (!st) return
  const cfg = st.S.lanes[ui.tab]
  document.querySelectorAll<HTMLElement>('.tile').forEach((tile) => {
    const id = tile.dataset.effect as EffectId
    tile.classList.toggle('sel', id === cfg.effect)
    tile.classList.toggle('live', id === cfg.effect && cfg.enabled)
    const modified = !!cfg.fx[id]?.p && Object.keys(cfg.fx[id]!.p!).length > 0
    let dot = tile.querySelector('.mod-dot')
    if (modified && !dot) { dot = el('i', 'mod-dot'); (dot as HTMLElement).title = t('ins.custom'); tile.appendChild(dot) }
    if (!modified && dot) dot.remove()
    const key = hk.map[`${ui.tab}:${id}`]
    tile.querySelector('.t-key')!.textContent = key || ''
    tile.title = `${fxLabel(id)}${key ? ` — ${key}` : ''}`
  })
}

// ---------------------------------------------------------------- инспектор эффекта

let shown = ''
const fxInputs: { key: ParamKey | 'rampIn' | 'rampOut'; input: HTMLInputElement; val: HTMLElement; row: HTMLElement
  toSlider: (v: number) => number; fmt: (v: number) => string }[] = []

// частоты — ползунок в логарифме: равные шаги на слух
const STEPS = 1000
const toSlider = (d: ParamDef, v: number) => (d.log ? (Math.log(v / d.min) / Math.log(d.max / d.min)) * STEPS : v)
const fromSlider = (d: ParamDef, x: number) => (d.log ? d.min * (d.max / d.min) ** (x / STEPS) : x)

function paramSlider(lane: LaneId, effect: EffectId, d: ParamDef, parent: HTMLElement): void {
  const row = el('label', 'slider')
  const head = el('span', '', paramLabel(d.key))
  const val = el('b')
  head.appendChild(val)
  const input = el('input')
  input.type = 'range'
  if (d.log) { input.min = '0'; input.max = String(STEPS); input.step = '1' }
  else { input.min = String(d.min); input.max = String(d.max); input.step = String(d.step) }
  input.oninput = () => {
    const v = fromSlider(d, Number(input.value))
    val.textContent = d.fmt(v)
    row.classList.add('mod')
    holo.cmd({ type: 'fxParam', lane, effect, key: d.key, value: v })
  }
  row.append(head, input)
  parent.appendChild(row)
  fxInputs.push({ key: d.key, input, val, row, toSlider: (v) => toSlider(d, v), fmt: d.fmt })
}

function rampSlider(lane: LaneId, effect: EffectId, which: 'rampIn' | 'rampOut', label: string, parent: HTMLElement): void {
  const row = el('label', 'slider')
  row.title = t(which === 'rampIn' ? 'ins.rampInTip' : 'ins.rampOutTip')
  const head = el('span', '', label)
  const val = el('b')
  head.appendChild(val)
  const input = el('input')
  input.type = 'range'; input.min = '0'; input.max = '10'; input.step = '0.1'
  const fmt = (v: number) => (v <= 0 ? t('ins.now') : `${v.toFixed(1)} ${t('u.s')}`)
  input.oninput = () => {
    val.textContent = fmt(Number(input.value))
    holo.cmd({ type: 'fxRamp', lane, effect, which, value: Number(input.value) })
  }
  row.append(head, input)
  parent.appendChild(row)
  fxInputs.push({ key: which, input, val, row, toSlider: (v) => v, fmt })
}

function buildInspector(lane: LaneId, effect: EffectId): void {
  const box = $('inspector')
  box.innerHTML = ''
  fxInputs.length = 0
  const info = effectInfo(effect) ?? effectInfo('clean')!

  const head = el('div', 'ins-head')
  const titles = el('div')
  titles.append(el('div', 'ins-title', fxLabel(effect)), el('div', 'ins-sub', `${LANE_ICO[lane]} ${laneName(lane)}`))
  head.append(el('span', 'ins-emoji', info.emoji), titles)
  box.appendChild(head)

  const status = el('div', 'ins-info')
  status.id = 'ins-info'
  status.hidden = true
  box.appendChild(status)

  const ramp = el('div', 'box')
  ramp.appendChild(el('div', 'box-title', t('ins.transition')))
  const ramps = el('div', 'ramps')
  rampSlider(lane, effect, 'rampIn', t('ins.rampIn'), ramps)
  rampSlider(lane, effect, 'rampOut', t('ins.rampOut'), ramps)
  ramp.appendChild(ramps)
  box.appendChild(ramp)

  const main = el('div', 'box')
  main.appendChild(el('div', 'box-title', t('ins.main')))
  for (const k of info.main) paramSlider(lane, effect, PARAM[k], main)
  const all = el('details', 'all')
  all.appendChild(el('summary', '', t('ins.all')))
  let group = ''
  for (const d of PARAMS.filter((p) => !info.main.includes(p.key))) {
    if (d.group !== group) { group = d.group; all.appendChild(el('div', 'pgroup', groupLabel(group))) }
    paramSlider(lane, effect, d, all)
  }
  main.appendChild(all)
  const btns = el('div', 'row-btns')
  const reset = el('button', 'btn', t('ins.reset'))
  reset.onclick = () => holo.cmd({ type: 'fxReset', lane, effect })
  btns.appendChild(reset)
  main.appendChild(btns)
  box.appendChild(main)

  // свой эффект: сохранить текущие настройки под своим именем
  const mine = el('div', 'box')
  mine.appendChild(el('div', 'box-title', t('ins.saveTitle')))
  mine.appendChild(el('div', 'prev-status', t('ins.saveHint')))
  const EMOJIS = ['⭐', '🔥', '🎭', '🦊', '🐉', '👽', '🎃', '🤖', '🧙', '💀', '🌊', '⚡', '🍄', '🎸', '👑', '🫧']
  let pick = EMOJIS[0]
  const emo = el('div', 'emoji-row')
  for (const e of EMOJIS) {
    const b = el('button', 'emoji-btn' + (e === pick ? ' sel' : ''), e)
    b.onclick = () => { pick = e; emo.querySelectorAll('.emoji-btn').forEach((x) => x.classList.toggle('sel', x === b)) }
    emo.appendChild(b)
  }
  const row = el('div', 'row-btns')
  const name = el('input', 'name-input')
  name.type = 'text'; name.maxLength = 40; name.placeholder = t('ins.saveName')
  name.value = `${fxLabel(effect)} ★`
  const save = el('button', 'btn primary', t('ins.save'))
  save.onclick = () => holo.cmd({ type: 'customSave', lane, name: name.value, emoji: pick })
  name.onkeydown = (e) => { if (e.key === 'Enter') save.click() }
  row.append(name, save)
  mine.append(emo, row)
  if (isCustom(effect)) {
    const del = el('button', 'btn', t('ins.delete'))
    del.onclick = () => holo.cmd({ type: 'customDelete', id: effect })
    mine.appendChild(del)
  }
  box.appendChild(mine)

  if (lane === 'mic') {
    const p = el('div', 'box')
    p.appendChild(el('div', 'box-title', t('pv.title')))
    p.appendChild(el('div', 'prev-status', t('pv.desc')))
    const row = el('div', 'row-btns')
    const rec = el('button', 'btn rec', t('pv.rec'))
    rec.id = 'pv-rec'
    rec.onclick = () => holo.cmd({ type: 'record' })
    const play = el('button', 'btn primary', t('pv.play'))
    play.id = 'pv-play'
    play.onclick = () => holo.cmd({ type: 'play' })
    const stop = el('button', 'btn', '■')
    stop.id = 'pv-stop'
    stop.onclick = () => holo.cmd({ type: 'stopPreview' })
    row.append(rec, play, stop)
    p.appendChild(row)
    const ps = el('div', 'prev-status')
    ps.id = 'pv-status'
    p.appendChild(ps)
    box.appendChild(p)
  }
  shown = `${lane}:${effect}`
}

function renderInspector(): void {
  if (!st) return
  const lane = ui.tab
  const cfg = st.S.lanes[lane]
  if (shown !== `${lane}:${cfg.effect}`) buildInspector(lane, cfg.effect)
  const user = cfg.fx[cfg.effect]
  const full = effectFull(cfg.effect, user)
  for (const f of fxInputs) {
    if (document.activeElement === f.input) continue
    const ramp = f.key === 'rampIn' || f.key === 'rampOut'
    const v = ramp ? (user?.[f.key as 'rampIn' | 'rampOut'] ?? 0) : full[f.key as ParamKey]
    f.input.value = String(f.toSlider(v))
    f.val.textContent = f.fmt(v)
    if (!ramp) f.row.classList.toggle('mod', user?.p?.[f.key as ParamKey] !== undefined)
  }
  const pv = st.preview
  const rec = document.getElementById('pv-rec') as HTMLButtonElement | null
  if (rec) {
    rec.textContent = t(pv.recording ? 'pv.recording' : 'pv.rec')
    rec.disabled = pv.recording
    ;($('pv-play') as HTMLButtonElement).disabled = !pv.ready || pv.recording
    ;($('pv-stop') as HTMLButtonElement).disabled = !pv.playing && !pv.recording
    $('pv-status').textContent = pv.recording ? t('pv.speak')
      : pv.playing ? t('pv.playing', { s: pv.seconds.toFixed(1) })
      : pv.ready ? t('pv.ready') : ''
  }
}

function renderVoiceInfo(l: Levels): void {
  if (!st) return
  for (const id of LANES) {
    const [f0, avg] = l.f0[id]
    $(`voice-${id}`).innerHTML = avg > 0
      ? t('voice.tone', { f0: f0 > 0 ? Math.round(f0) : '—', avg: Math.round(avg) })
      : id === 'mic' ? t('voice.say') : ''
  }
  const info = document.getElementById('ins-info')
  if (!info) return
  const cfg = st.S.lanes[ui.tab]
  const p = effectFull(cfg.effect, cfg.fx[cfg.effect])
  const [f0, avg] = l.f0[ui.tab]
  if (p.autoTarget > 0) {
    info.hidden = false
    info.innerHTML = avg > 0
      ? t('info.target', { avg: Math.round(avg), t: Math.round(p.targetHz) })
      : t('info.targetWait', { t: Math.round(p.targetHz) })
  } else if (p.tune > 0 || p.mono > 0) {
    info.hidden = false
    const now = f0 > 0 ? `${Math.round(f0)} ${t('u.hz')}` : '—'
    info.innerHTML = p.mono > 0 ? t('info.toneNote', { f0: now, n: Math.round(p.monoHz) }) : t('info.toneNearest', { f0: now })
  } else info.hidden = true
}

// ---------------------------------------------------------------- устройства

function fillSelect(sel: HTMLSelectElement, items: { id: string; label: string }[], value: string): void {
  const sig = items.map((d) => d.id + d.label).join('|')
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = ''
    for (const d of items) {
      const o = el('option', '', d.label)
      o.value = d.id
      sel.appendChild(o)
    }
    sel.dataset.sig = sig
  }
  if (document.activeElement !== sel) sel.value = value
}

function renderDevices(): void {
  if (!st) return
  fillSelect($('mic'), st.mics, st.S.mic)
  fillSelect($('out'), st.outs, st.S.out)
  $<HTMLInputElement>('monitor').checked = st.S.monitor
  $<HTMLInputElement>('monitor-vol').value = String(st.S.monitorVol)
}

function render(): void {
  if (st) setCustom(st.S.custom)
  if (sigOf() !== customSig) {
    // набор своих эффектов изменился — каталог, списки в карточках и горячие клавиши строим заново
    customSig = sigOf()
    buildCatalog()
    for (const id of LANES) fillFxSelect($(`fxsel-${id}`) as HTMLSelectElement)
    buildHotkeys()
    renderHotkeys()
    shown = ''
  }
  renderLanes()
  renderCatalog()
  renderInspector()
  renderDevices()
}

// ---------------------------------------------------------------- горячие клавиши

/** KeyboardEvent → ускоритель Electron. По e.code — не зависит от раскладки (русская, английская). */
function accelerator(e: KeyboardEvent): string | null {
  const c = e.code
  const named: Record<string, string> = {
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    Slash: '/', Backslash: '\\', Backquote: '`', Space: 'Space', Tab: 'Tab', Enter: 'Enter', ArrowUp: 'Up', ArrowDown: 'Down',
    ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  }
  let key: string | undefined
  if (/^Digit\d$/.test(c)) key = c.slice(5)
  else if (/^Key[A-Z]$/.test(c)) key = c.slice(3)
  else if (/^Numpad\d$/.test(c)) key = `num${c.slice(6)}`
  else if (/^F\d{1,2}$/.test(c)) key = c
  else key = named[c]
  if (!key) return null
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean)
  if (!mods.length && !/^F\d/.test(key)) return null // одиночная клавиша мешала бы печатать и играть
  return [...mods, key].join('+')
}

function buildHotkeys(): void {
  for (const lane of LANES) {
    const list = $(`hk-${lane}`)
    list.innerHTML = ''
    const actions: [string, string][] = [
      ['toggle', t('hk.toggle')], ['next', t('hk.next')], ['prev', t('hk.prev')],
      ...groups().flatMap(([, ids]) => ids.map((id): [string, string] => [id, `${emojiOf(id)} ${fxLabel(id)}`])),
    ]
    for (const [what, label] of actions) {
      const row = el('div', 'hk-row')
      const btn = el('button', 'hk-key')
      btn.dataset.action = `${lane}:${what}`
      btn.onclick = () => record(btn)
      row.append(el('span', '', label), btn)
      list.appendChild(row)
    }
  }
  $('hk-reset').onclick = async () => { hk = await holo.resetHotkeys(); renderHotkeys() }
}

function renderHotkeys(): void {
  document.querySelectorAll<HTMLButtonElement>('.hk-key').forEach((b) => {
    if (b.classList.contains('rec')) return
    const a = b.dataset.action!
    const k = hk.map[a] || ''
    b.textContent = k || '—'
    b.classList.toggle('empty', !k)
    b.classList.toggle('busy', !!k && hk.failed.includes(a))
    b.title = k && hk.failed.includes(a) ? t('hk.busy') : ''
  })
  renderCatalog()
}

let recording: (() => void) | null = null
async function record(btn: HTMLButtonElement): Promise<void> {
  recording?.()
  await holo.pauseHotkeys(true) // иначе нажатие перехватит само глобальное сочетание
  btn.classList.add('rec')
  btn.textContent = t('hk.press')
  const finish = async (accel: string | null) => {
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', onBlur)
    recording = null
    if (accel !== null) await holo.setHotkey(btn.dataset.action!, accel)
    await holo.pauseHotkeys(false)
    hk = await holo.getHotkeys()
    btn.classList.remove('rec')
    renderHotkeys()
  }
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault(); e.stopPropagation()
    if (e.key === 'Escape') { finish(null); return }
    if (e.key === 'Delete' || e.key === 'Backspace') { finish(''); return }
    const accel = accelerator(e)
    // X11: Shift с цифрой/знаком даёт другой символ, и глобальное сочетание срабатывает как без Shift
    if (accel && holo.platform === 'linux' && e.shiftKey && /\+[0-9\-=[\];',./\\`]$/.test(accel)) {
      btn.textContent = t('hk.shiftLinux')
      return
    }
    if (accel) finish(accel)
    else btn.textContent = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super']
      .filter(Boolean).join('+') + '+…'
  }
  const onBlur = () => finish(null)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', onBlur)
  recording = () => finish(null)
}

// ---------------------------------------------------------------- подсказка на экране

async function buildOsd(): Promise<void> {
  const info = await holo.getOsd()
  const toast = $<HTMLInputElement>('osd-toast'), bar = $<HTMLInputElement>('osd-bar')
  toast.checked = info.osd
  bar.checked = info.rampBar
  const markPos = (p: OsdPos) => document.querySelectorAll<HTMLElement>('#osd-pos button').forEach((b) => b.classList.toggle('sel', b.dataset.pos === p))
  markPos(info.osdPos)
  toast.onchange = () => holo.setOsd({ osd: toast.checked })
  bar.onchange = () => holo.setOsd({ rampBar: bar.checked })
  document.querySelectorAll<HTMLButtonElement>('#osd-pos button').forEach((b) => {
    b.onclick = async () => { const r = await holo.setOsd({ osdPos: b.dataset.pos as OsdPos }); markPos(r.osdPos); holo.testOsd() }
  })
  $('osd-test').onclick = () => holo.testOsd()
}

function openModal(id: string): void {
  const m = $(id)
  m.hidden = false
  m.onclick = (e) => { if (e.target === m || (e.target as HTMLElement).closest('[data-close]')) m.hidden = true }
}

// ---------------------------------------------------------------- запуск

async function setCompact(on: boolean): Promise<void> {
  ui = await holo.setUi({ compact: on })
  document.body.classList.toggle('compact', on)
  await new Promise((r) => requestAnimationFrame(r))
  // высота — по низу последней карточки (колонка растянута на всё окно, её scrollHeight не годится)
  await holo.compact(on, $('card-sys').getBoundingClientRect().bottom + 14)
}

// ---------------------------------------------------------------- язык

function buildLangMenu(): void {
  const cur = LANGS.find((l) => l.code === lang()) ?? LANGS[0]
  const btn = $('btn-lang')
  btn.innerHTML = flagSvg(cur.flag) // свои SVG: на Windows эмодзи-флаги не отображаются
  const menu = $('lang-menu')
  for (const l of LANGS) {
    const b = el('button')
    if (l.code === cur.code) b.className = 'sel'
    b.innerHTML = flagSvg(l.flag)
    b.appendChild(el('span', '', l.name))
    b.onclick = () => { menu.hidden = true; if (l.code !== lang()) holo.setUi({ lang: l.code }) }
    menu.appendChild(b)
  }
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden }
  document.addEventListener('click', (e) => { if (!menu.hidden && !(e.target as HTMLElement).closest('#lang-menu')) menu.hidden = true })
  holo.onLang(() => location.reload()) // окно перестраивается целиком на новом языке; звук в движке не прерывается
}

async function main(): Promise<void> {
  ui = await holo.getUi()
  setLang(ui.lang)
  applyStatic()
  buildLangMenu()
  $('btn-close').onclick = () => holo.close()
  $('btn-min').onclick = () => holo.minimize()
  const pin = $('btn-pin')
  pin.classList.toggle('on', ui.pinned)
  pin.onclick = async () => { ui = await holo.setUi({ pinned: !ui.pinned }); pin.classList.toggle('on', ui.pinned) }
  $('btn-compact').onclick = () => setCompact(!ui.compact)
  $('btn-widget').onclick = () => holo.widget(true)
  $('open-hk').onclick = () => openModal('modal-hk')
  $('open-osd').onclick = () => openModal('modal-osd')
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !recording) document.querySelectorAll<HTMLElement>('.modal').forEach((m) => { m.hidden = true })
  })
  // ссылки в подсказках (VB-Cable) — во внешнем браузере
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('a[data-href]')
    if (a) { e.preventDefault(); holo.open(a.dataset.href!) }
  })

  // обновление
  $('version').textContent = `v${await holo.version()}`
  const upd = $<HTMLButtonElement>('btn-update'), updStatus = $('update-status')
  holo.onUpdateProgress((text) => { updStatus.textContent = text })
  upd.onclick = async () => {
    upd.disabled = true
    updStatus.textContent = t('upd.checking')
    updStatus.textContent = await holo.update()
    upd.disabled = false
  }

  // устройства
  const mon = $<HTMLInputElement>('monitor'), monVol = $<HTMLInputElement>('monitor-vol')
  mon.onchange = () => holo.cmd({ type: 'monitor', on: mon.checked })
  monVol.oninput = () => holo.cmd({ type: 'monitorVol', value: Number(monVol.value) })
  $<HTMLSelectElement>('mic').onchange = (e) => holo.cmd({ type: 'mic', id: (e.target as HTMLSelectElement).value })
  $<HTMLSelectElement>('out').onchange = (e) => holo.cmd({ type: 'out', id: (e.target as HTMLSelectElement).value })

  buildLanes()
  buildCatalog()
  buildHotkeys()
  hk = await holo.getHotkeys()
  renderHotkeys()
  await buildOsd()

  holo.onState((s) => { st = s; render() })
  holo.onLevels((l) => {
    for (const id of LANES) {
      $(`mi-${id}`).style.width = `${l[id][0]}%`
      $(`mo-${id}`).style.width = `${l[id][1]}%`
    }
    renderVoiceInfo(l)
  })
  st = await holo.getState()
  selectLane(ui.tab)
  render()
  if (ui.compact) await setCompact(true)
}

main()
