// Main window — the engine controller. Layout: lane cards on the left (on/off, levels, strength, volume),
// the effect catalog for the selected lane in the center, the selected effect's settings and "Test with a recording" on the right,
// devices at the bottom. Hotkeys and the on-screen hint are in windows on top of the panel.
// No audio is processed here (see engine.ts).
import { PARAM, PARAMS, VOICE_ONLY, customs, effectFull, effectInfo, fxLabel, groupLabel, isCustom, isNeural, paramLabel, setCustom, type EffectId, type ParamDef, type ParamKey } from './effects'
import { LANGS, applyStatic, flagSvg, lang, setLang, t } from './i18n'
import { CUSTOM_ICONS, DEFAULT_CUSTOM_ICON, applyIcons, icon, iconEl } from './icons'
import { $, holo, type EngineState, type HotkeyInfo, type LaneId, type Levels, type OsdPos, type Quality, type Speaker, type UiConfig } from './shared'

let st: EngineState | null = null
let ui: UiConfig
let hk: HotkeyInfo = { map: {}, failed: [] }
const LANES: LaneId[] = ['mic', 'sys']
const laneName = (id: LaneId) => t(`lane.${id}`)
const LANE_ICO: Record<LaneId, string> = { mic: 'mic', sys: 'speaker' }

const BUILTIN_GROUPS: [string, EffectId[]][] = [
  ['grp.voices', ['clean', 'male', 'female', 'child', 'autotune', 'giant', 'chipmunk', 'whisper']],
  ['grp.characters', ['demon', 'divine', 'tts', 'ghost', 'digital', 'smolder']],
  ['grp.atmo', ['hologram_classic', 'hologram_warm', 'ice', 'electric', 'vhs', 'radio', 'cave']],
]
/** Catalog groups: built-in + "My effects", if any */
function groups(): [string, EffectId[]][] {
  const mine = customs().map((c) => c.id)
  const out = [...BUILTIN_GROUPS]
  const fav = (st?.S.favorites ?? []).filter((id) => effectInfo(id as EffectId)) as EffectId[]
  if (fav.length) out.unshift(['grp.fav', fav])
  // neural voices: only with the optional GPU mode installed, only for "My voice" (hidden on the other tab by CSS)
  if (st?.neural?.available) out.splice(1, 0, ['grp.neural', ['neural_female', 'neural_male']])
  if (mine.length) out.push(['grp.custom', mine])
  return out
}
const esc = (x: string) => x.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
/** Signature of the custom effect set: when it changes, the catalog, lists and hotkeys are rebuilt */
let customSig = ''
const sigOf = () => customs().map((c) => c.id + c.name + c.icon).join('|') + (st?.neural?.available ? '|neural' : '') + `|${(st?.S.favorites ?? []).join(',')}`
const iconOf = (id: EffectId) => effectInfo(id)?.icon ?? DEFAULT_CUSTOM_ICON
/** Icon + text in one element; text goes through textContent (custom effect names are user input) */
const labeled = (cls: string, ico: string, text: string, size = 16) => {
  const e = el('span', `with-ico ${cls}`.trim())
  e.append(iconEl(ico, size), el('span', '', text))
  return e
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

// ---------------------------------------------------------------- lane cards

const LANE_SLIDERS: { key: 'amount' | 'gain' | 'gate'; min: number; max: number; fmt: (v: number) => string; lanes: LaneId[] }[] = [
  { key: 'amount', min: 0, max: 100, fmt: (v) => `${v}%`, lanes: ['mic', 'sys'] },
  { key: 'gain', min: 0, max: 200, fmt: (v) => `${v}%`, lanes: ['mic', 'sys'] },
  { key: 'gate', min: -80, max: -20, fmt: (v) => (v <= -80 ? t('u.off') : `${v}`), lanes: ['mic'] },
]
const laneInputs: { lane: LaneId; key: 'amount' | 'gain' | 'gate'; input: HTMLInputElement; val: HTMLElement; fmt: (v: number) => string }[] = []

/** "My voice" card: where the voice comes from and goes to, hearing yourself, your own voice type */
const micDevices = () => `
      <div class="lc-devs">
        <label class="dev-row" title="${t('dev.mic')}"><span>${t('dev.micL')}</span><select id="mic"></select></label>
        <label class="dev-row" title="${t('dev.out')}"><span>${t('dev.outL')}</span><select id="out"></select></label>
        <div class="dev-row" title="${t('dev.monitorTip')}">
          <label class="check"><input type="checkbox" id="monitor"><span>${t('dev.monitor')}</span></label>
          <input type="range" id="monitor-vol" min="0" max="100" step="1" title="${t('dev.monitorVol')}"><b id="monitor-val"></b>
        </div>
        <div class="dev-row stack" title="${t('dev.speakerTip')}"><span>${t('speaker.title')}</span><div class="seg" id="speaker" role="radiogroup"></div></div>
      </div>`

function buildLanes(): void {
  const box = $('lanes')
  for (const id of LANES) {
    const card = el('section', 'lane-card')
    card.dataset.lane = id
    card.id = `card-${id}`
    card.innerHTML = `
      <div class="lc-head">
        <div class="lc-ico">${icon(LANE_ICO[id], 20)}</div>
        <div class="lc-title"><div class="lc-name">${laneName(id)}</div><div class="lc-fx" id="fx-${id}"></div></div>
        <button class="switch" id="sw-${id}" data-hk-title="${id}:toggle" role="switch"><i></i></button>
      </div>
      <select class="lc-fxsel" id="fxsel-${id}"></select>
      <div class="meters">
        <span>${t('lane.in')}</span><div class="bar-m"><i id="mi-${id}"></i></div>
        <span>${t('lane.out')}</span><div class="bar-m"><i id="mo-${id}"></i></div>
      </div>
      <div class="voice" id="voice-${id}"></div>
      ${id === 'mic' ? micDevices() : ''}
      <div class="lc-ctrls" id="ctrls-${id}"></div>
      <div class="lc-hint" id="hint-${id}"></div>`
    box.appendChild(card)
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.switch, .lc-ctrls, .lc-hint, .lc-devs, select')) return
      selectLane(id)
    })
    $(`sw-${id}`).onclick = () => holo.cmd({ type: 'toggle', lane: id })
    const sel = $<HTMLSelectElement>(`fxsel-${id}`)
    fillFxSelect(sel, id)
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

function fillFxSelect(sel: HTMLSelectElement, lane: LaneId): void {
  sel.innerHTML = ''
  for (const [, ids] of groups()) for (const fx of ids) {
    if (lane === 'sys' && isNeural(fx)) continue
    const o = el('option', '', fxLabel(fx)) // <option> can't hold an SVG
    o.value = fx
    sel.appendChild(o)
  }
}

function renderLanes(): void {
  if (!st) return
  for (const id of LANES) {
    const cfg = st.S.lanes[id]
    $(`card-${id}`).classList.toggle('on', cfg.enabled)
    $(`card-${id}`).classList.toggle('sel', ui.tab === id)
    $(`sw-${id}`).classList.toggle('on', cfg.enabled)
    $(`sw-${id}`).setAttribute('aria-checked', String(cfg.enabled))
    $(`sw-${id}`).setAttribute('aria-label', laneName(id))
    const fxBox = $(`fx-${id}`)
    fxBox.replaceChildren(cfg.enabled ? labeled('', iconOf(cfg.effect), fxLabel(cfg.effect), 13) : t(id === 'mic' ? 'lane.offMic' : 'lane.offSys'))
    const sel = $<HTMLSelectElement>(`fxsel-${id}`)
    if (document.activeElement !== sel) sel.value = cfg.effect
    const q = $<HTMLSelectElement>(`q-${id}`)
    if (document.activeElement !== q) q.value = cfg.quality
    const h = $(`hint-${id}`)
    h.innerHTML = st.hint[id].html // built in the engine, device labels are escaped there
    fillHotkeyRefs(h)
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
  $('cat-lane').replaceChildren(labeled('', LANE_ICO[id], laneName(id), 16))
  renderLanes()
  renderSetup()
  renderCatalog()
  renderInspector()
}

// ---------------------------------------------------------------- effect catalog

function buildCatalog(): void {
  const box = $('groups')
  box.innerHTML = ''
  for (const [title, ids] of groups()) {
    const g = el('div', title === 'grp.neural' ? 'group neural' : 'group')
    g.appendChild(el('h3', '', t(title)))
    const tiles = el('div', 'tiles')
    for (const id of ids) {
      const tile = el('button', 'tile')
      tile.dataset.effect = id
      tile.append(iconEl(iconOf(id), 24, 't-icon'), el('span', 't-name', fxLabel(id)), el('span', 't-key'))
      tile.onclick = () => holo.cmd({ type: 'effect', lane: ui.tab, effect: id })
      tile.dataset.name = fxLabel(id).toLowerCase()
      const fav = !!st?.S.favorites?.includes(id)
      const star = iconEl('star', 13, 't-fav' + (fav ? ' on' : ''))
      star.title = t(fav ? 'cat.unfav' : 'cat.fav')
      star.onclick = (e) => { e.stopPropagation(); holo.cmd({ type: 'favorite', id }) }
      tile.appendChild(star)
      if (isCustom(id)) {
        const del = iconEl('x', 12, 't-del')
        del.title = t('ins.delete')
        del.onclick = (e) => { e.stopPropagation(); deleteCustom(id) }
        tile.appendChild(del)
      }
      tiles.appendChild(tile)
    }
    g.appendChild(tiles)
    box.appendChild(g)
  }
  filterCatalog()
}

/** Deleting a custom effect can be undone for a few seconds */
function deleteCustom(id: EffectId): void {
  const copy = st?.S.custom.find((c) => c.id === id)
  holo.cmd({ type: 'customDelete', id })
  if (copy) toast(t('ins.deleted', { name: copy.name }), { label: t('undo'), run: () => holo.cmd({ type: 'customRestore', effect: copy }) }, 6000)
}

/** Catalog search: tiles whose name contains the text; empty groups hide */
function filterCatalog(): void {
  const q = ($<HTMLInputElement>('cat-search').value || '').trim().toLowerCase()
  document.querySelectorAll<HTMLElement>('#groups .group').forEach((g) => {
    let any = false
    g.querySelectorAll<HTMLElement>('.tile').forEach((tile) => {
      const hit = !q || tile.dataset.name!.includes(q)
      tile.hidden = !hit
      any ||= hit
    })
    g.hidden = !any
  })
}

function renderCatalog(): void {
  if (!st) return
  const cfg = st.S.lanes[ui.tab]
  document.querySelectorAll<HTMLElement>('.tile').forEach((tile) => {
    const id = tile.dataset.effect as EffectId
    tile.classList.toggle('sel', id === cfg.effect)
    tile.setAttribute('aria-pressed', String(id === cfg.effect))
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

// ---------------------------------------------------------------- effect inspector

let shown = ''
const fxInputs: { key: ParamKey | 'rampIn' | 'rampOut'; input: HTMLInputElement; val: HTMLElement; row: HTMLElement
  toSlider: (v: number) => number; fmt: (v: number) => string }[] = []

// frequencies — logarithmic slider: perceptually equal steps
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
  titles.append(el('div', 'ins-title', fxLabel(effect)), labeled('ins-sub', LANE_ICO[lane], laneName(lane), 13))
  head.append(iconEl(info.icon, 24, 'ins-icon'), titles)
  box.appendChild(head)

  const status = el('div', 'ins-info')
  status.id = 'ins-info'
  status.hidden = true
  box.appendChild(status)

  const main = el('div', 'box')
  main.appendChild(el('div', 'box-title', t('ins.main')))
  // computer-sound track: voice-only parameters do nothing there, so they are not shown
  const visible = (k: ParamKey) => lane === 'mic' || !VOICE_ONLY.includes(k)
  for (const k of info.main.filter(visible)) paramSlider(lane, effect, PARAM[k], main)
  const all = el('details', 'all')
  all.appendChild(el('summary', '', t('ins.all')))
  let group = ''
  for (const d of PARAMS.filter((p) => !info.main.includes(p.key) && visible(p.key))) {
    if (d.group !== group) { group = d.group; all.appendChild(el('div', 'pgroup', groupLabel(group))) }
    paramSlider(lane, effect, d, all)
  }
  main.appendChild(all)
  const btns = el('div', 'row-btns')
  const reset = el('button', 'btn', t('ins.reset'))
  reset.onclick = () => {
    const before = st?.S.lanes[lane].fx[effect]
    holo.cmd({ type: 'fxReset', lane, effect })
    if (before) toast(t('ins.wasReset'), { label: t('undo'), run: () => holo.cmd({ type: 'fxRestore', lane, effect, user: before }) }, 6000)
  }
  btns.appendChild(reset)
  main.appendChild(btns)
  box.appendChild(main)

  // the quickest way to hear an effect without a call: right under its knobs
  if (lane === 'mic') {
    const p = el('div', 'box')
    p.appendChild(labeled('box-title', 'headphones', t('pv.title'), 14))
    p.appendChild(el('div', 'prev-status', t('pv.desc')))
    const row = el('div', 'row-btns')
    const rec = el('button', 'btn rec')
    rec.id = 'pv-rec'
    rec.onclick = () => holo.cmd({ type: 'record' })
    const play = el('button', 'btn primary')
    play.append(iconEl('play', 12), el('span', '', t('pv.play')))
    play.id = 'pv-play'
    play.onclick = () => holo.cmd({ type: 'play' })
    const stop = el('button', 'btn')
    stop.append(iconEl('stop', 12))
    stop.id = 'pv-stop'
    stop.onclick = () => holo.cmd({ type: 'stopPreview' })
    row.append(rec, play, stop)
    p.appendChild(row)
    const ps = el('div', 'prev-status')
    ps.id = 'pv-status'
    p.appendChild(ps)
    box.appendChild(p)
  }

  // fade-in / fade-out: folded — most people never touch it
  const ramp = el('details', 'box fold')
  const rs = el('summary', 'box-title', t('ins.transition'))
  const rIn = Number(st?.S.lanes[lane].fx[effect]?.rampIn ?? 0), rOut = Number(st?.S.lanes[lane].fx[effect]?.rampOut ?? 0)
  if (rIn || rOut) rs.appendChild(el('span', 'fold-val', `${rIn}s / ${rOut}s`))
  ramp.appendChild(rs)
  const ramps = el('div', 'ramps')
  rampSlider(lane, effect, 'rampIn', t('ins.rampIn'), ramps)
  rampSlider(lane, effect, 'rampOut', t('ins.rampOut'), ramps)
  ramp.appendChild(ramps)
  box.appendChild(ramp)

  // save as my own effect: folded too
  const mine = el('details', 'box fold')
  const ms = el('summary', 'box-title')
  ms.innerHTML = `${icon('save', 14)}<span>${t('ins.saveTitle')}</span>`
  mine.appendChild(ms)
  mine.appendChild(el('div', 'prev-status', t('ins.saveHint')))
  let pick: string = isCustom(effect) ? iconOf(effect) : DEFAULT_CUSTOM_ICON
  const icons = el('div', 'icon-row')
  for (const name of CUSTOM_ICONS) {
    const b = el('button', 'icon-btn' + (name === pick ? ' sel' : ''))
    b.innerHTML = icon(name, 16)
    b.onclick = () => { pick = name; icons.querySelectorAll('.icon-btn').forEach((x) => x.classList.toggle('sel', x === b)) }
    icons.appendChild(b)
  }
  const row = el('div', 'row-btns')
  const name = el('input', 'name-input')
  name.type = 'text'; name.maxLength = 40; name.placeholder = t('ins.saveName')
  // a built-in effect's copy gets "(mine)" — otherwise two effects with the same name
  name.value = isCustom(effect) ? fxLabel(effect) : t('ins.mineName', { name: fxLabel(effect) })
  const save = el('button', 'btn primary', t('ins.save'))
  save.onclick = () => holo.cmd({ type: 'customSave', lane, name: name.value, icon: pick })
  name.onkeydown = (e) => { if (e.key === 'Enter') save.click() }
  row.append(name, save)
  mine.append(icons, row)
  if (isCustom(effect)) {
    const del = el('button', 'btn', t('ins.delete'))
    del.onclick = () => deleteCustom(effect)
    mine.appendChild(del)
  }
  box.appendChild(mine)
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
    rec.replaceChildren(iconEl('record', 12, pv.recording ? 'blink' : ''), el('span', '', t(pv.recording ? 'pv.recording' : 'pv.rec')))
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
  const n = st.neural
  if (ui.tab === 'mic' && isNeural(cfg.effect)) {
    info.hidden = false
    info.innerHTML = !n.available ? t('neural.unavailable')
      : n.status === 'ready' ? t('neural.ready', { gpu: esc(n.gpu || 'GPU'), ms: Math.round(n.latencyMs) || '≈400' })
      : n.status === 'loading' ? t('neural.loading')
      : n.status === 'error' ? t('neural.error', { err: esc(n.error) })
      : t('neural.off')
  } else if (p.autoTarget > 0) {
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

// ---------------------------------------------------------------- devices

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
  $('monitor-val').textContent = `${st.S.monitorVol}%`
  $('monitor-vol').classList.toggle('dim', !st.S.monitor)
  document.querySelectorAll<HTMLElement>('#speaker button').forEach((b) => {
    const on = b.dataset.v === (st!.S.speaker ?? 'neutral')
    b.classList.toggle('on', on)
    b.setAttribute('aria-checked', String(on))
  })
}

function render(): void {
  if (st) setCustom(st.S.custom)
  if (sigOf() !== customSig) {
    // the custom effect set changed — rebuild the catalog, card lists and hotkeys
    customSig = sigOf()
    buildCatalog()
    for (const id of LANES) fillFxSelect($(`fxsel-${id}`) as HTMLSelectElement, id)
    buildHotkeys()
    renderHotkeys()
    shown = ''
  }
  renderLanes()
  renderCatalog()
  renderInspector()
  renderDevices()
}

// ---------------------------------------------------------------- the user's own voice

/** "Your voice: low / medium / high" — effects with a fixed shift adjust to it */
const SPEAKERS: [Speaker, string][] = [['male', 'speaker.low'], ['neutral', 'speaker.mid'], ['female', 'speaker.high']]
function buildSpeaker(): void {
  const box = $('speaker')
  box.innerHTML = ''
  for (const [v, key] of SPEAKERS) {
    const b = el('button', '', t(key))
    b.dataset.v = v
    b.setAttribute('role', 'radio')
    b.onclick = () => holo.cmd({ type: 'speaker', value: v })
    box.appendChild(b)
  }
}

// ---------------------------------------------------------------- hotkeys

const MODS = (e: KeyboardEvent | MouseEvent) =>
  [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[]

/** Keys that are fine on their own (no modifier): they don't type text */
const LONE_KEY = /^(F\d{1,2}|Insert|Home|End|PageUp|PageDown|CapsLock|Scrolllock|Numlock|PrintScreen|num.+|Mouse\d)$/

/** KeyboardEvent → Electron accelerator. Uses e.code — independent of the keyboard layout (Russian, English). */
function accelerator(e: KeyboardEvent): string | null {
  const c = e.code
  const named: Record<string, string> = {
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    Slash: '/', Backslash: '\\', Backquote: '`', Space: 'Space', Tab: 'Tab', Enter: 'Enter', ArrowUp: 'Up', ArrowDown: 'Down',
    ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
    CapsLock: 'CapsLock', ScrollLock: 'Scrolllock', NumLock: 'Numlock', PrintScreen: 'PrintScreen',
  }
  let key: string | undefined
  if (/^Digit\d$/.test(c)) key = c.slice(5)
  else if (/^Key[A-Z]$/.test(c)) key = c.slice(3)
  else if (/^Numpad\d$/.test(c)) key = `num${c.slice(6)}`
  else if (/^F\d{1,2}$/.test(c)) key = c
  else key = named[c]
  if (!key) return null
  const mods = MODS(e)
  if (!mods.length && !LONE_KEY.test(key)) return null // a single letter would fire while typing
  return [...mods, key].join('+')
}

/** Middle and side mouse buttons (DOM: 1 middle, 3 back, 4 forward) → "Mouse3/4/5" as the input hook names them */
function mouseAccelerator(e: MouseEvent): string | null {
  const name = ({ 1: 'Mouse3', 3: 'Mouse4', 4: 'Mouse5' } as Record<number, string>)[e.button]
  return name ? [...MODS(e), name].join('+') : null
}

type HkMode = 'press' | 'x2' | 'x3' | 'hold'
const HK_MODES: HkMode[] = ['press', 'x2', 'x3', 'hold']

/** "Ctrl+F8 x2" → ["Ctrl+F8", "x2"] */
function splitBinding(b: string): [string, HkMode] {
  const m = /^(.*?)(?: (x2|x3|hold))?$/.exec(b)!
  return [m[1], (m[2] as HkMode) || 'press']
}

/** Hints and switch tooltips name the CURRENT shortcut of an action ([data-hk] text, [data-hk-title] tooltip) */
function fillHotkeyRefs(root: ParentNode = document): void {
  const text = (a: string) => {
    const k = hk.map[a]
    if (!k) return t('hk.none')
    const [combo, mode] = splitBinding(k)
    return mode === 'press' ? bindingText(combo) : `${bindingText(combo)} (${t(`hk.mode.${mode}`)})`
  }
  root.querySelectorAll<HTMLElement>('[data-hk]').forEach((e) => { e.textContent = text(e.dataset.hk!) })
  root.querySelectorAll<HTMLElement>('[data-hk-title]').forEach((e) => { e.title = text(e.dataset.hkTitle!) })
}

/** Human-readable shortcut: mouse buttons by name */
function bindingText(combo: string): string {
  return combo.split('+').map((k) => (/^Mouse\d$/.test(k) ? t(`hk.${k.toLowerCase()}`) : k)).join(' + ')
}

function buildHotkeys(): void {
  for (const lane of LANES) {
    const list = $(`hk-${lane}`)
    list.innerHTML = ''
    const actions: [string, string][] = [
      ['toggle', t('hk.toggle')], ['next', t('hk.next')], ['prev', t('hk.prev')],
      ...groups().flatMap(([, ids]) => ids.map((id): [string, string] => [id, fxLabel(id)])),
    ]
    for (const [what, label] of actions) {
      const row = el('div', 'hk-row')
      const fx = effectInfo(what)
      const btn = el('button', 'hk-key')
      btn.dataset.action = `${lane}:${what}`
      btn.onclick = () => record(btn)
      const mode = el('select', 'hk-mode') as HTMLSelectElement
      mode.dataset.action = btn.dataset.action
      mode.title = t('hk.modeTitle')
      for (const m of HK_MODES) mode.add(new Option(t(`hk.mode.${m}`), m))
      mode.onchange = async () => {
        const [combo] = splitBinding(hk.map[mode.dataset.action!] || '')
        if (!combo) return
        await holo.setHotkey(mode.dataset.action!, mode.value === 'press' ? combo : `${combo} ${mode.value}`)
        hk = await holo.getHotkeys()
        renderHotkeys()
      }
      row.append(fx ? labeled('hk-label', fx.icon, label, 15) : el('span', 'hk-label', label), btn, mode)
      list.appendChild(row)
    }
  }
  $('hk-reset').onclick = async () => { hk = await holo.resetHotkeys(); renderHotkeys() }
}

function renderHotkeys(): void {
  fillHotkeyRefs()
  document.querySelectorAll<HTMLButtonElement>('.hk-key').forEach((b) => {
    if (b.classList.contains('rec')) return
    const a = b.dataset.action!
    const k = hk.map[a] || ''
    b.textContent = k ? bindingText(splitBinding(k)[0]) : '—'
    b.classList.toggle('empty', !k)
    b.classList.toggle('busy', !!k && hk.failed.includes(a))
    b.title = k && hk.failed.includes(a) ? t('hk.busy') : ''
    // a conflict is spelled out under the row, not just an orange border
    const row = b.closest('.hk-row')!
    const busy = !!k && hk.failed.includes(a)
    let note = row.querySelector('.hk-busy')
    if (busy && !note) { note = el('div', 'hk-busy', t('hk.busy')); row.appendChild(note) }
    if (!busy) note?.remove()
  })
  document.querySelectorAll<HTMLSelectElement>('.hk-mode').forEach((m) => {
    const k = hk.map[m.dataset.action!] || ''
    m.value = splitBinding(k)[1]
    m.disabled = !k
  })
  renderCatalog()
}

let recording: (() => void) | null = null
async function record(btn: HTMLButtonElement): Promise<void> {
  recording?.()
  await holo.pauseHotkeys(true) // otherwise the global shortcut itself would intercept the keypress
  btn.classList.add('rec')
  btn.textContent = t('hk.press')
  const [, mode] = splitBinding(hk.map[btn.dataset.action!] || '')
  const finish = async (accel: string | null) => {
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('mousedown', onMouse, true)
    window.removeEventListener('auxclick', stop, true)
    window.removeEventListener('blur', onBlur)
    recording = null
    // a new key keeps the row's mode (double press, hold…)
    if (accel !== null) await holo.setHotkey(btn.dataset.action!, accel && mode !== 'press' ? `${accel} ${mode}` : accel)
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
    // X11: Shift with a digit/symbol yields a different character, and the global shortcut fires as if without Shift
    if (accel && holo.platform === 'linux' && e.shiftKey && /\+[0-9\-=[\];',./\\`]$/.test(accel)) {
      btn.textContent = t('hk.shiftLinux')
      return
    }
    // Windows: Ctrl+Alt is AltGr — Ctrl+Alt+<a typing key> would steal that character on many layouts
    if (accel && holo.platform === 'win32' && /^Ctrl\+Alt\+(Shift\+)?([0-9A-Z]|[-=[\];',./\\`])$/.test(accel)) {
      btn.textContent = t('hk.altgr')
      return
    }
    if (accel) finish(accel)
    else btn.textContent = MODS(e).join('+') + '+…'
  }
  // middle / side mouse buttons; a left click elsewhere cancels, a right click is ignored
  const onMouse = (e: MouseEvent) => {
    const accel = mouseAccelerator(e)
    if (accel) { e.preventDefault(); e.stopPropagation(); finish(accel); return }
    if (e.button === 0 && e.target !== btn) finish(null)
  }
  const stop = (e: Event) => { e.preventDefault(); e.stopPropagation() } // the "back" button must not navigate
  const onBlur = () => finish(null)
  window.addEventListener('mousedown', onMouse, true)
  window.addEventListener('auxclick', stop, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', onBlur)
  recording = () => finish(null)
}

// ---------------------------------------------------------------- on-screen hint

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

let modalReturn: HTMLElement | null = null
function openModal(id: string): void {
  const m = $(id)
  modalReturn = document.activeElement as HTMLElement | null
  m.hidden = false
  m.onclick = (e) => { if (e.target === m || (e.target as HTMLElement).closest('[data-close]')) closeModal(m) }
  // keyboard users land inside the dialog
  m.querySelector<HTMLElement>('button, input, select')?.focus()
}
function closeModal(m: HTMLElement): void {
  m.hidden = true
  modalReturn?.focus?.()
  modalReturn = null
}

// ---------------------------------------------------------------- setup guide

/** When the microphone last had a voice-like level (the guide's first check) */
let micHeardAt = 0
let avgPitch = 0

/** Re-entrant checklist: microphone heard → virtual mic present → what to pick in the call app → try a voice.
 *  Opens by itself on the first start; later from the app menu. Every check is live. */
function openSetup(): void {
  buildSetup()
  openModal('modal-setup')
}

function buildSetup(): void {
  const box = $('setup')
  box.innerHTML = `
    <header><b class="with-ico">${icon('settings', 18)}<span>${t('setup.title')}</span></b><button class="x" data-close>${icon('x', 18)}</button></header>
    <p class="note">${t('setup.intro')}</p>
    <ol class="steps">
      <li id="st-mic"><div class="st-mark"></div><div class="st-body"><b>${t('setup.micT')}</b><div class="st-text"></div>
        <div class="st-ctl"><div class="bar-m st-meter"><i id="st-meter"></i></div></div></div></li>
      <li id="st-virt"><div class="st-mark"></div><div class="st-body"><b>${t('setup.virtT')}</b><div class="st-text"></div><div class="st-ctl"></div></div></li>
      <li id="st-app"><div class="st-mark"></div><div class="st-body"><b>${t('setup.appT')}</b><div class="st-text"></div><div class="st-ctl"></div></div></li>
      <li id="st-try"><div class="st-mark"></div><div class="st-body"><b>${t('setup.tryT')}</b><div class="st-text"></div><div class="st-ctl"></div></div></li>
    </ol>
    <footer><button class="btn primary" id="setup-done">${t('setup.done')}</button></footer>`
  $('setup-done').onclick = async () => {
    ui = await holo.setUi({ onboarded: true })
    closeModal($('modal-setup'))
  }
  renderSetup()
}

function renderSetup(): void {
  const m = document.getElementById('modal-setup')
  if (!m || m.hidden || !st) return
  const step = (id: string, state: 'ok' | 'todo' | 'info', text: string, ctl?: (box: HTMLElement) => void) => {
    const li = $(id)
    li.className = state
    li.querySelector('.st-text')!.innerHTML = text
    const box = li.querySelector<HTMLElement>('.st-ctl')!
    if (ctl && box.dataset.sig !== state) { box.dataset.sig = state; box.innerHTML = ''; ctl(box) }
  }
  const win = holo.platform === 'win32'
  const virtual = st.outs.find((d) => (win ? /CABLE Input/i.test(d.label) : /HoloVoice/.test(d.label)))
  const micName = win ? 'CABLE Output' : 'HoloVoice-Microphone'
  const heard = Date.now() - micHeardAt < 8000
  const micLabel = st.mics.find((d) => d.id === st!.S.mic)?.label || t('dev.default')

  step('st-mic', heard ? 'ok' : 'todo', heard ? t('setup.micOk', { mic: esc(micLabel) }) : t('setup.micSay', { mic: esc(micLabel) }))
  step('st-virt', virtual ? 'ok' : 'todo',
    virtual ? t('setup.virtOk', { dev: esc(virtual.label) }) : win ? t('setup.virtWin') : t('setup.virtLinux'),
    (box) => {
      if (virtual || !win) return
      const b = el('button', 'btn primary', t('setup.virtGet'))
      b.onclick = () => holo.open('https://vb-audio.com/Cable/')
      box.append(b, el('span', 'st-wait', t('setup.virtWait')))
    })
  step('st-app', virtual ? 'info' : 'todo', t('setup.app', { mic: micName }), (box) => {
    const b = el('button', 'btn', t('setup.copy'))
    b.onclick = async () => { try { await navigator.clipboard.writeText(micName); toast(t('setup.copied', { mic: micName })) } catch { /* no clipboard */ } }
    box.appendChild(b)
  })
  const suggest: Speaker | null = avgPitch > 0 ? (avgPitch < 145 ? 'male' : avgPitch > 175 ? 'female' : 'neutral') : null
  step('st-try', st.S.monitor ? 'ok' : 'info',
    t('setup.try') + (suggest ? `<br>${t('setup.voiceGuess', { hz: Math.round(avgPitch), v: t(SPEAKERS.find(([v]) => v === suggest)![1]) })}` : ''),
    (box) => {
      const mon = el('button', st!.S.monitor ? 'btn primary' : 'btn', t('dev.monitor'))
      mon.setAttribute('aria-pressed', String(st!.S.monitor))
      mon.onclick = () => holo.cmd({ type: 'monitor', on: !st!.S.monitor })
      box.appendChild(mon)
      for (const id of ['clean', 'demon', 'female', 'male', 'digital'] as EffectId[]) {
        if (!effectInfo(id)) continue
        const b = el('button', 'btn')
        b.append(iconEl(iconOf(id), 14), el('span', '', fxLabel(id)))
        b.onclick = () => holo.cmd({ type: 'effect', lane: 'mic', effect: id })
        box.appendChild(b)
      }
      if (suggest && suggest !== st!.S.speaker) {
        const b = el('button', 'btn primary', t('setup.voiceApply'))
        b.onclick = () => holo.cmd({ type: 'speaker', value: suggest })
        box.appendChild(b)
      }
    })
}

// ---------------------------------------------------------------- startup

async function setCompact(on: boolean): Promise<void> {
  ui = await holo.setUi({ compact: on })
  document.body.classList.toggle('compact', on)
  $('btn-compact').innerHTML = icon(on ? 'expand' : 'shrink', 16)
  await new Promise((r) => requestAnimationFrame(r))
  // height — down to the bottom of the last card (the column spans the whole window, so its scrollHeight is useless)
  await holo.compact(on, $('card-sys').getBoundingClientRect().bottom + 14)
}

// ---------------------------------------------------------------- language

function buildLangMenu(): void {
  const cur = LANGS.find((l) => l.code === lang()) ?? LANGS[0]
  const btn = $('btn-lang')
  btn.innerHTML = flagSvg(cur.flag) // our own SVGs: Windows doesn't render emoji flags
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
  holo.onLang(() => location.reload()) // the window is rebuilt entirely in the new language; audio in the engine is not interrupted
}

// ---------------------------------------------------------------- HOLO ecosystem

/** HoloVoice is one product of the HOLO family; the other entries are placeholders until their links exist. */
const HOLO_PRODUCTS: { name: string; icon: string; desc: string; url?: string; current?: boolean }[] = [
  { name: 'HoloVoice', icon: 'mic', desc: 'holo.voice', current: true },
  { name: 'HOLO Messenger', icon: 'message', desc: 'holo.messenger' },
  { name: 'HOLO Viewer', icon: 'glasses', desc: 'holo.viewer' },
  { name: 'HOLO Studio', icon: 'cube', desc: 'holo.studio' },
]

/** A short message at the bottom of the panel, optionally with one action (e.g. "Undo") */
let toastTimer = 0
function toast(text: string, action?: { label: string; run: () => void }, ms = 4000): void {
  let box = document.getElementById('toast')
  if (!box) { box = el('div', 'toast'); box.id = 'toast'; box.setAttribute('role', 'status'); document.body.appendChild(box) }
  box.replaceChildren(el('span', '', text))
  if (action) {
    const b = el('button', 'btn', action.label)
    b.onclick = () => { action.run(); box!.classList.remove('show') }
    box.appendChild(b)
  }
  box.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => box!.classList.remove('show'), ms)
}

/** The app menu (under the HoloVoice brand): setup, settings windows, updates, help — then the HOLO family */
function buildHoloMenu(): void {
  const menu = $('holo-menu')
  const item = (ico: string, label: string, run: () => void) => {
    const b = el('button', 'menu-item')
    b.append(iconEl(ico, 16), el('span', '', label))
    b.onclick = () => { menu.hidden = true; run() }
    menu.appendChild(b)
  }
  item('settings', t('menu.setup'), () => openSetup())
  item('keyboard', t('btn.hotkeys'), () => openModal('modal-hk'))
  item('monitor', t('btn.osd'), () => openModal('modal-osd'))
  item('refresh', t('menu.update'), () => $<HTMLButtonElement>('btn-update').click())
  menu.appendChild(el('div', 'menu-sep'))
  item('eye', t('menu.logs'), () => holo.openLogs())
  item('message', t('menu.diag'), async () => { await holo.copyDiagnostics(); toast(t('menu.diagDone')) })
  item('power', t('menu.quit'), () => holo.quit())
  menu.appendChild(el('div', 'menu-sep'))
  menu.appendChild(el('div', 'holo-head', t('holo.title')))
  for (const p of HOLO_PRODUCTS) {
    const item = el('button', 'holo-item' + (p.current ? ' current' : ''))
    item.disabled = !p.current && !p.url
    const text = el('div')
    text.append(el('div', 'holo-name', p.name), el('div', 'holo-desc', t(p.desc)))
    item.append(iconEl(p.icon, 20, 'holo-icon'), text, el('span', 'holo-badge', p.current ? t('holo.here') : t('holo.soon')))
    if (p.url) item.onclick = () => holo.open(p.url!)
    menu.appendChild(item)
  }
  $('btn-holo').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden }
  document.addEventListener('click', (e) => { if (!menu.hidden && !(e.target as HTMLElement).closest('#holo-menu')) menu.hidden = true })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { menu.hidden = true; $('lang-menu').hidden = true } })
}

async function main(): Promise<void> {
  ui = await holo.getUi()
  setLang(ui.lang)
  applyStatic()
  applyIcons()
  buildLangMenu()
  buildHoloMenu()
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
    if (e.key === 'Escape' && !recording) document.querySelectorAll<HTMLElement>('.modal:not([hidden])').forEach((m) => closeModal(m))
  })
  // links in hints (VB-Cable) open in the external browser
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('a[data-href]')
    if (a) { e.preventDefault(); holo.open(a.dataset.href!) }
  })

  // update
  $('version').textContent = `v${await holo.version()}`
  const upd = $<HTMLButtonElement>('btn-update'), updStatus = $('update-status')
  holo.onUpdateProgress((text) => { updStatus.textContent = text })
  // a newer version was found in the background: the button says so
  const showAvailable = (v: string | null) => {
    if (!v) return
    upd.classList.add('primary')
    upd.querySelector('span')!.textContent = t('upd.toV', { v })
  }
  holo.updateAvailable().then(showAvailable).catch(() => {})
  holo.onUpdateAvailable(showAvailable)
  upd.onclick = async () => {
    upd.disabled = true
    updStatus.textContent = t('upd.checking')
    updStatus.textContent = await holo.update()
    upd.disabled = false
  }

  $<HTMLInputElement>('cat-search').oninput = filterCatalog
  $<HTMLInputElement>('cat-search').onkeydown = (e) => { if (e.key === 'Escape') { (e.target as HTMLInputElement).value = ''; filterCatalog() } }
  buildLanes()
  // devices (in the "My voice" card)
  const mon = $<HTMLInputElement>('monitor'), monVol = $<HTMLInputElement>('monitor-vol')
  mon.onchange = () => holo.cmd({ type: 'monitor', on: mon.checked })
  monVol.oninput = () => { $('monitor-val').textContent = `${monVol.value}%`; holo.cmd({ type: 'monitorVol', value: Number(monVol.value) }) }
  buildSpeaker()
  $<HTMLSelectElement>('mic').onchange = (e) => holo.cmd({ type: 'mic', id: (e.target as HTMLSelectElement).value })
  $<HTMLSelectElement>('out').onchange = (e) => holo.cmd({ type: 'out', id: (e.target as HTMLSelectElement).value })

  buildCatalog()
  buildHotkeys()
  hk = await holo.getHotkeys()
  renderHotkeys()
  await buildOsd()

  // the setup guide opens by itself (once the engine is up) until it has been completed once
  let guideChecked = false
  const maybeGuide = () => {
    if (guideChecked || !st?.ready || ui.compact) return
    guideChecked = true
    if (!ui.onboarded) openSetup()
  }
  holo.onState((s) => { st = s; render(); maybeGuide() })
  let setupTick = 0
  holo.onLevels((l) => {
    for (const id of LANES) {
      $(`mi-${id}`).style.width = `${l[id][0]}%`
      $(`mo-${id}`).style.width = `${l[id][1]}%`
    }
    renderVoiceInfo(l)
    if (l.mic[0] > 12) micHeardAt = Date.now()
    if (l.f0.mic[1] > 0) avgPitch = l.f0.mic[1]
    const meter = document.getElementById('st-meter')
    if (meter) meter.style.width = `${l.mic[0]}%`
    if (Date.now() - setupTick > 500) { setupTick = Date.now(); renderSetup() }
  })
  st = await holo.getState()
  selectLane(ui.tab)
  render()
  if (ui.compact) await setCompact(true)
  maybeGuide()
}

main()
