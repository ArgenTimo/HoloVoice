// Главное окно — пульт движка. Раскладка: слева карточки дорожек (вкл/выкл, уровни, сила, громкость),
// по центру каталог эффектов для выбранной дорожки, справа настройки выбранного эффекта и «Проверить на записи»,
// снизу — устройства. Горячие клавиши и подсказка на экране — в окнах поверх панели.
// Звук здесь не обрабатывается (см. engine.ts).
import { EFFECT, PARAM, PARAMS, effectFull, type EffectId, type ParamDef, type ParamKey } from './effects'
import { $, holo, type EngineState, type HotkeyInfo, type LaneId, type Levels, type OsdPos, type Quality, type UiConfig } from './shared'

let st: EngineState | null = null
let ui: UiConfig
let hk: HotkeyInfo = { map: {}, failed: [] }
const LANES: LaneId[] = ['mic', 'sys']
const LANE_NAME: Record<LaneId, string> = { mic: 'Мой голос', sys: 'Звук компьютера' }
const LANE_ICO: Record<LaneId, string> = { mic: '🎙️', sys: '🔊' }

const GROUPS: [string, EffectId[]][] = [
  ['Голоса', ['clean', 'male', 'female', 'child', 'autotune', 'giant', 'chipmunk', 'whisper']],
  ['Персонажи', ['demon', 'ghost', 'digital', 'smolder']],
  ['Атмосфера', ['hologram_classic', 'hologram_warm', 'ice', 'electric', 'vhs', 'radio', 'cave']],
]

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

// ---------------------------------------------------------------- карточки дорожек

const LANE_SLIDERS: { key: 'amount' | 'gain' | 'gate'; label: string; min: number; max: number; fmt: (v: number) => string
  lanes: LaneId[]; title: string }[] = [
  { key: 'amount', label: 'Сила', min: 0, max: 100, fmt: (v) => `${v}%`, lanes: ['mic', 'sys'],
    title: 'Доля пути от обычного звука к эффекту — все параметры эффекта сразу' },
  { key: 'gain', label: 'Громкость', min: 0, max: 200, fmt: (v) => `${v}%`, lanes: ['mic', 'sys'], title: 'Громкость на выходе дорожки' },
  { key: 'gate', label: 'Шумодав', min: -80, max: -20, fmt: (v) => (v <= -80 ? 'выкл' : `${v}`), lanes: ['mic'],
    title: 'Порог шумового гейта, дБ: тише порога — тишина (паузы без шума). Влево до упора — выключен' },
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
        <div class="lc-title"><div class="lc-name">${LANE_NAME[id]}</div><div class="lc-fx" id="fx-${id}"></div></div>
        <button class="switch" id="sw-${id}" title="${id === 'mic' ? 'Ctrl+Alt+V' : 'Ctrl+Alt+B'}"><i></i></button>
      </div>
      <select class="lc-fxsel" id="fxsel-${id}"></select>
      <div class="meters">
        <span>вход</span><div class="bar-m"><i id="mi-${id}"></i></div>
        <span>выход</span><div class="bar-m"><i id="mo-${id}"></i></div>
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
    for (const [, ids] of GROUPS) for (const fx of ids) {
      const o = el('option', '', `${EFFECT[fx].emoji} ${EFFECT[fx].label}`)
      o.value = fx
      sel.appendChild(o)
    }
    sel.onchange = () => holo.cmd({ type: 'effect', lane: id, effect: sel.value as EffectId })
    const ctrls = $(`ctrls-${id}`)
    for (const d of LANE_SLIDERS.filter((x) => x.lanes.includes(id))) {
      const row = el('label', 'mini')
      row.title = d.title
      const input = el('input')
      input.type = 'range'; input.min = String(d.min); input.max = String(d.max); input.step = '1'
      const val = el('b')
      input.oninput = () => {
        val.textContent = d.fmt(Number(input.value))
        holo.cmd({ type: 'set', lane: id, key: d.key, value: Number(input.value) })
      }
      row.append(el('span', '', d.label), input, val)
      ctrls.appendChild(row)
      laneInputs.push({ lane: id, key: d.key, input, val, fmt: d.fmt })
    }
    const q = el('label', 'mini')
    q.title = 'Качество — чище звук (задержка ~40 мс); быстро — задержка ~20 мс, для игр'
    q.innerHTML = `<span>Обработка</span><select id="q-${id}"><option value="hq">Качество · 40 мс</option><option value="fast">Быстро · 20 мс</option></select>`
    ctrls.appendChild(q)
    const qs = $<HTMLSelectElement>(`q-${id}`)
    qs.onchange = () => holo.cmd({ type: 'quality', lane: id, value: qs.value as Quality })
  }
}

function renderLanes(): void {
  if (!st) return
  for (const id of LANES) {
    const cfg = st.S.lanes[id]
    const fx = EFFECT[cfg.effect]
    $(`card-${id}`).classList.toggle('on', cfg.enabled)
    $(`card-${id}`).classList.toggle('sel', ui.tab === id)
    $(`sw-${id}`).classList.toggle('on', cfg.enabled)
    $(`fx-${id}`).textContent = cfg.enabled ? `${fx.emoji} ${fx.label}` : id === 'mic' ? 'выключено — чистый голос' : 'выключено — звук как обычно'
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
  $('cat-lane').textContent = `${LANE_ICO[id]} ${LANE_NAME[id]}`
  renderLanes()
  renderCatalog()
  renderInspector()
}

// ---------------------------------------------------------------- каталог эффектов

function buildCatalog(): void {
  const box = $('groups')
  for (const [title, ids] of GROUPS) {
    const g = el('div', 'group')
    g.appendChild(el('h3', '', title))
    const tiles = el('div', 'tiles')
    for (const id of ids) {
      const fx = EFFECT[id]
      const t = el('button', 'tile')
      t.dataset.effect = id
      t.append(el('span', 't-emoji', fx.emoji), el('span', 't-name', fx.label), el('span', 't-key'))
      t.onclick = () => holo.cmd({ type: 'effect', lane: ui.tab, effect: id })
      tiles.appendChild(t)
    }
    g.appendChild(tiles)
    box.appendChild(g)
  }
}

function renderCatalog(): void {
  if (!st) return
  const cfg = st.S.lanes[ui.tab]
  document.querySelectorAll<HTMLElement>('.tile').forEach((t) => {
    const id = t.dataset.effect as EffectId
    t.classList.toggle('sel', id === cfg.effect)
    t.classList.toggle('live', id === cfg.effect && cfg.enabled)
    const modified = !!cfg.fx[id]?.p && Object.keys(cfg.fx[id]!.p!).length > 0
    let dot = t.querySelector('.mod-dot')
    if (modified && !dot) { dot = el('i', 'mod-dot'); (dot as HTMLElement).title = 'Настроен вами'; t.appendChild(dot) }
    if (!modified && dot) dot.remove()
    const key = hk.map[`${ui.tab}:${id}`]
    t.querySelector('.t-key')!.textContent = key || ''
    t.title = `${EFFECT[id].label}${key ? ` — ${key}` : ''}`
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
  const head = el('span', '', d.label)
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
  row.title = which === 'rampIn'
    ? 'За сколько голос плавно переходит от обычного к эффекту (и от другого эффекта к этому)'
    : 'За сколько эффект плавно сходит на нет при выключении'
  const head = el('span', '', label)
  const val = el('b')
  head.appendChild(val)
  const input = el('input')
  input.type = 'range'; input.min = '0'; input.max = '10'; input.step = '0.1'
  const fmt = (v: number) => (v <= 0 ? 'сразу' : `${v.toFixed(1)} с`)
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
  const info = EFFECT[effect]

  const head = el('div', 'ins-head')
  const titles = el('div')
  titles.append(el('div', 'ins-title', info.label), el('div', 'ins-sub', `${LANE_ICO[lane]} ${LANE_NAME[lane]}`))
  head.append(el('span', 'ins-emoji', info.emoji), titles)
  box.appendChild(head)

  const status = el('div', 'ins-info')
  status.id = 'ins-info'
  status.hidden = true
  box.appendChild(status)

  const ramp = el('div', 'box')
  ramp.appendChild(el('div', 'box-title', 'Переход'))
  const ramps = el('div', 'ramps')
  rampSlider(lane, effect, 'rampIn', 'Нарастание', ramps)
  rampSlider(lane, effect, 'rampOut', 'Затухание', ramps)
  ramp.appendChild(ramps)
  box.appendChild(ramp)

  const main = el('div', 'box')
  main.appendChild(el('div', 'box-title', 'Главное'))
  for (const k of info.main) paramSlider(lane, effect, PARAM[k], main)
  const all = el('details', 'all')
  all.appendChild(el('summary', '', 'Все параметры'))
  let group = ''
  for (const d of PARAMS.filter((p) => !info.main.includes(p.key))) {
    if (d.group !== group) { group = d.group; all.appendChild(el('div', 'pgroup', group)) }
    paramSlider(lane, effect, d, all)
  }
  main.appendChild(all)
  const btns = el('div', 'row-btns')
  const reset = el('button', 'btn', 'Сбросить настройки эффекта')
  reset.onclick = () => holo.cmd({ type: 'fxReset', lane, effect })
  btns.appendChild(reset)
  main.appendChild(btns)
  box.appendChild(main)

  if (lane === 'mic') {
    const p = el('div', 'box')
    p.appendChild(el('div', 'box-title', '🎧 Проверить на записи'))
    p.appendChild(el('div', 'prev-status', 'Запишите несколько секунд своего голоса и слушайте его через этот эффект, двигая ручки.'))
    const row = el('div', 'row-btns')
    const rec = el('button', 'btn rec', '● Записать 6 с')
    rec.id = 'pv-rec'
    rec.onclick = () => holo.cmd({ type: 'record' })
    const play = el('button', 'btn primary', '▶ Послушать')
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
    rec.textContent = pv.recording ? '● Идёт запись…' : '● Записать 6 с'
    rec.disabled = pv.recording
    ;($('pv-play') as HTMLButtonElement).disabled = !pv.ready || pv.recording
    ;($('pv-stop') as HTMLButtonElement).disabled = !pv.playing && !pv.recording
    $('pv-status').textContent = pv.recording ? 'Говорите…'
      : pv.playing ? `Звучит запись (${pv.seconds.toFixed(1)} с) — можно двигать ручки`
      : pv.ready ? 'Запись готова — «Послушать» ещё раз или выберите другой эффект' : ''
  }
}

function renderVoiceInfo(l: Levels): void {
  if (!st) return
  for (const id of LANES) {
    const [f0, avg] = l.f0[id]
    $(`voice-${id}`).innerHTML = avg > 0
      ? `Тон голоса: <b>${f0 > 0 ? Math.round(f0) : '—'}</b> Гц · средний <b>${Math.round(avg)}</b> Гц`
      : id === 'mic' ? 'Тон голоса: скажите что-нибудь' : ''
  }
  const info = document.getElementById('ins-info')
  if (!info) return
  const cfg = st.S.lanes[ui.tab]
  const p = effectFull(cfg.effect, cfg.fx[cfg.effect])
  const [f0, avg] = l.f0[ui.tab]
  if (p.autoTarget > 0) {
    info.hidden = false
    info.innerHTML = avg > 0
      ? `Ваш голос ≈ <b>${Math.round(avg)} Гц</b> → цель <b>${Math.round(p.targetHz)} Гц</b>: подстраивается под любого говорящего`
      : `Цель — <b>${Math.round(p.targetHz)} Гц</b>. Скажите что-нибудь — голос подстроится под говорящего`
  } else if (p.tune > 0 || p.mono > 0) {
    info.hidden = false
    info.innerHTML = `Тон сейчас: <b>${f0 > 0 ? `${Math.round(f0)} Гц` : '—'}</b>${p.mono > 0 ? ` → нота <b>${Math.round(p.monoHz)} Гц</b>` : ' → ближайшая нота'}`
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
      ['toggle', 'Вкл / выкл эффект'], ['next', 'Следующий эффект'], ['prev', 'Предыдущий эффект'],
      ...GROUPS.flatMap(([, ids]) => ids.map((id): [string, string] => [id, `${EFFECT[id].emoji} ${EFFECT[id].label}`])),
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
    b.title = k && hk.failed.includes(a) ? 'Сочетание занято другой программой — назначьте другое' : ''
  })
  renderCatalog()
}

let recording: (() => void) | null = null
async function record(btn: HTMLButtonElement): Promise<void> {
  recording?.()
  await holo.pauseHotkeys(true) // иначе нажатие перехватит само глобальное сочетание
  btn.classList.add('rec')
  btn.textContent = 'нажмите сочетание…'
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
      btn.textContent = 'Shift+цифра не работает в Linux'
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

async function main(): Promise<void> {
  ui = await holo.getUi()
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
  holo.onUpdateProgress((t) => { updStatus.textContent = t })
  upd.onclick = async () => {
    upd.disabled = true
    updStatus.textContent = 'Проверяю…'
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
