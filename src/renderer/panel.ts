// Главное окно — пульт движка: все настройки обеих дорожек. Звук здесь не обрабатывается (см. engine.ts).
import { EFFECT, EFFECTS, PARAM, PARAMS, effectFull, type EffectId, type ParamDef, type ParamKey } from './effects'
import { $, holo, type EngineState, type HotkeyInfo, type LaneId, type OsdPos, type Quality, type UiConfig } from './shared'

let st: EngineState | null = null
let ui: UiConfig

const SLIDERS: { key: 'amount' | 'gate' | 'gain'; label: string; min: number; max: number
  fmt: (v: number) => string; lanes: LaneId[]; title?: string }[] = [
  { key: 'amount', label: 'Сила эффекта', min: 0, max: 100, fmt: (v) => `${v}%`, lanes: ['mic', 'sys'],
    title: 'Доля пути от обычного звука к эффекту — все параметры эффекта сразу' },
  { key: 'gate', label: 'Шумодав', min: -80, max: -20, fmt: (v) => (v <= -80 ? 'выкл' : `${v} dB`), lanes: ['mic'],
    title: 'Порог шумового гейта: тише порога — тишина. Влево до упора — выключен' },
  { key: 'gain', label: 'Громкость', min: 0, max: 200, fmt: (v) => `${v}%`, lanes: ['mic', 'sys'] },
]

const sliderInputs: { lane: LaneId; key: 'amount' | 'gate' | 'gain'; input: HTMLInputElement; val: HTMLElement; fmt: (v: number) => string }[] = []

function buildLane(id: LaneId): void {
  const box = $(`lane-${id}`)
  box.innerHTML = `
    <section class="power-row">
      <button class="power ${id}" id="power-${id}" title="${id === 'mic' ? 'Ctrl+Alt+V' : 'Ctrl+Alt+B'}">
        <span class="power-label"></span><span class="power-sub"></span>
      </button>
      <div class="meters">
        <div class="meter"><span>вход</span><div class="bar"><i id="m-in-${id}"></i></div></div>
        <div class="meter"><span>выход</span><div class="bar"><i id="m-out-${id}"></i></div></div>
      </div>
    </section>
    <section class="effects" id="effects-${id}"></section>
    <section class="full sliders" id="sliders-${id}"></section>
    <details class="full fxbox" id="fxbox-${id}" open></details>`
  $(`power-${id}`).onclick = () => holo.cmd({ type: 'toggle', lane: id })
  const fx = $(`effects-${id}`)
  for (const e of EFFECTS) {
    const b = document.createElement('button')
    b.className = 'fx'
    b.dataset.effect = e.id
    b.title = e.label
    b.innerHTML = `<span class="e">${e.emoji}</span><span class="l">${e.label}</span>`
    b.onclick = () => holo.cmd({ type: 'effect', lane: id, effect: e.id })
    fx.appendChild(b)
  }
  const sl = $(`sliders-${id}`)
  for (const d of SLIDERS.filter((x) => x.lanes.includes(id))) {
    const wrap = document.createElement('label')
    wrap.className = 'slider'
    if (d.title) wrap.title = d.title
    const head = document.createElement('span')
    head.textContent = d.label + ' '
    const val = document.createElement('b')
    head.appendChild(val)
    const input = document.createElement('input')
    input.type = 'range'; input.min = String(d.min); input.max = String(d.max); input.step = '1'
    input.oninput = () => {
      val.textContent = d.fmt(Number(input.value))
      holo.cmd({ type: 'set', lane: id, key: d.key, value: Number(input.value) })
    }
    wrap.append(head, input)
    sl.appendChild(wrap)
    sliderInputs.push({ lane: id, key: d.key, input, val, fmt: d.fmt })
  }
  // качество вокодера: окно 2048 — чище, окно 1024 — меньше задержка (для игр)
  const q = document.createElement('label')
  q.className = 'select-row'
  q.innerHTML = '<span>Обработка</span><select><option value="hq">Качество (~40 мс)</option><option value="fast">Быстро (~20 мс)</option></select>'
  const sel = q.querySelector('select')!
  sel.id = `quality-${id}`
  sel.onchange = () => holo.cmd({ type: 'quality', lane: id, value: sel.value as Quality })
  sl.appendChild(q)
}

// ---------------------------------------------------------------- настройки эффекта

const shownEffect: Partial<Record<LaneId, EffectId>> = {}
const fxInputs: { lane: LaneId; key: ParamKey | 'rampIn' | 'rampOut'; input: HTMLInputElement; val: HTMLElement; row: HTMLElement
  toSlider: (v: number) => number; fmt: (v: number) => string }[] = []

// частоты — ползунок в логарифме: равные шаги на слух
const SLIDER_STEPS = 1000
function toSlider(d: ParamDef, v: number): number {
  return d.log ? (Math.log(v / d.min) / Math.log(d.max / d.min)) * SLIDER_STEPS : v
}
function fromSlider(d: ParamDef, x: number): number {
  return d.log ? d.min * (d.max / d.min) ** (x / SLIDER_STEPS) : x
}

function fxSlider(lane: LaneId, d: ParamDef, effect: EffectId, parent: HTMLElement): void {
  const row = document.createElement('label')
  row.className = 'slider'
  const head = document.createElement('span')
  head.textContent = d.label + ' '
  const val = document.createElement('b')
  head.appendChild(val)
  const input = document.createElement('input')
  input.type = 'range'
  if (d.log) { input.min = '0'; input.max = String(SLIDER_STEPS); input.step = '1' }
  else { input.min = String(d.min); input.max = String(d.max); input.step = String(d.step) }
  input.oninput = () => {
    const v = fromSlider(d, Number(input.value))
    val.textContent = d.fmt(v)
    row.classList.add('mod')
    holo.cmd({ type: 'fxParam', lane, effect, key: d.key, value: v })
  }
  row.append(head, input)
  parent.appendChild(row)
  fxInputs.push({ lane, key: d.key, input, val, row, toSlider: (v) => toSlider(d, v), fmt: d.fmt })
}

function rampSlider(lane: LaneId, which: 'rampIn' | 'rampOut', label: string, effect: EffectId, parent: HTMLElement): void {
  const row = document.createElement('label')
  row.className = 'slider'
  row.title = which === 'rampIn'
    ? 'За сколько голос плавно переходит от обычного к эффекту (и от другого эффекта к этому)'
    : 'За сколько эффект плавно сходит на нет при выключении'
  const head = document.createElement('span')
  head.textContent = label + ' '
  const val = document.createElement('b')
  head.appendChild(val)
  const input = document.createElement('input')
  input.type = 'range'; input.min = '0'; input.max = '10'; input.step = '0.1'
  const fmt = (v: number) => (v <= 0 ? 'мгновенно' : `${v.toFixed(1)} с`)
  input.oninput = () => {
    val.textContent = fmt(Number(input.value))
    holo.cmd({ type: 'fxRamp', lane, effect, which, value: Number(input.value) })
  }
  row.append(head, input)
  parent.appendChild(row)
  fxInputs.push({ lane, key: which, input, val, row, toSlider: (v) => v, fmt })
}

function buildFxBox(lane: LaneId, effect: EffectId): void {
  const box = $(`fxbox-${lane}`)
  for (let i = fxInputs.length - 1; i >= 0; i--) if (fxInputs[i].lane === lane) fxInputs.splice(i, 1)
  const info = EFFECT[effect]
  box.innerHTML = ''
  const sum = document.createElement('summary')
  sum.textContent = `🎛️ Настройки: ${info.emoji} ${info.label}`
  box.appendChild(sum)
  const body = document.createElement('div')
  body.className = 'fxbody'
  box.appendChild(body)
  const ramps = document.createElement('div')
  ramps.className = 'ramps'
  rampSlider(lane, 'rampIn', 'Нарастание', effect, ramps)
  rampSlider(lane, 'rampOut', 'Затухание', effect, ramps)
  body.appendChild(ramps)
  for (const k of info.main) fxSlider(lane, PARAM[k], effect, body)
  const all = document.createElement('details')
  all.className = 'allparams'
  const allSum = document.createElement('summary')
  allSum.textContent = 'Все параметры'
  all.appendChild(allSum)
  let group = ''
  for (const d of PARAMS.filter((p) => !info.main.includes(p.key))) {
    if (d.group !== group) {
      group = d.group
      const h = document.createElement('div')
      h.className = 'pgroup'
      h.textContent = group
      all.appendChild(h)
    }
    fxSlider(lane, d, effect, all)
  }
  all.addEventListener('toggle', () => fitHeight())
  body.appendChild(all)
  const reset = document.createElement('button')
  reset.className = 'fxreset'
  reset.textContent = `Сбросить «${info.label}»`
  reset.onclick = () => holo.cmd({ type: 'fxReset', lane, effect })
  body.appendChild(reset)
  shownEffect[lane] = effect
  fitHeight()
}

function renderFxBox(lane: LaneId): void {
  if (!st) return
  const cfg = st.S.lanes[lane]
  if (shownEffect[lane] !== cfg.effect) buildFxBox(lane, cfg.effect)
  const user = cfg.fx[cfg.effect]
  const full = effectFull(cfg.effect, user)
  for (const f of fxInputs) {
    if (f.lane !== lane || document.activeElement === f.input) continue
    const v = f.key === 'rampIn' || f.key === 'rampOut' ? (user?.[f.key] ?? 0) : full[f.key]
    f.input.value = String(f.toSlider(v))
    f.val.textContent = f.fmt(v)
    if (f.key !== 'rampIn' && f.key !== 'rampOut') f.row.classList.toggle('mod', user?.p?.[f.key] !== undefined)
  }
}

// ---------------------------------------------------------------- горячие клавиши

let hk: HotkeyInfo = { map: {}, failed: [] }

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

function buildHotkeys(lane: LaneId): void {
  const list = $(`hk-${lane}`).querySelector<HTMLElement>('.hk-list')!
  list.innerHTML = ''
  const actions: [string, string][] = [
    ['toggle', 'Вкл / выкл эффект'], ['next', 'Следующий эффект'], ['prev', 'Предыдущий эффект'],
    ...EFFECTS.map((e): [string, string] => [e.id, `${e.emoji} ${e.label}`]),
  ]
  for (const [what, label] of actions) {
    const action = `${lane}:${what}`
    const row = document.createElement('div')
    row.className = 'hk-row'
    const name = document.createElement('span')
    name.textContent = label
    const btn = document.createElement('button')
    btn.className = 'hk-key'
    btn.dataset.action = action
    btn.onclick = () => record(btn)
    row.append(name, btn)
    list.appendChild(row)
  }
  const note = document.createElement('div')
  note.className = 'hk-note'
  note.textContent = 'Работают в любой программе и в играх. Повторное нажатие сочетания эффекта выключает его. ' +
    'Нажмите на сочетание, чтобы назначить своё (Esc — отмена, Delete — убрать).'
  const foot = document.createElement('div')
  foot.className = 'hk-foot'
  const reset = document.createElement('button')
  reset.textContent = 'Сбросить'
  reset.onclick = async () => { hk = await holo.resetHotkeys(); renderHotkeys() }
  foot.append(reset)
  list.append(note, foot)
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
}

// ---------------------------------------------------------------- подсказка на экране

async function buildOsdSettings(): Promise<void> {
  const info = await holo.getOsd()
  const toast = $<HTMLInputElement>('osd-toast'), bar = $<HTMLInputElement>('osd-bar'), pos = $<HTMLSelectElement>('osd-pos')
  toast.checked = info.osd
  bar.checked = info.rampBar
  pos.value = info.osdPos
  toast.onchange = () => holo.setOsd({ osd: toast.checked })
  bar.onchange = () => holo.setOsd({ rampBar: bar.checked })
  pos.onchange = () => holo.setOsd({ osdPos: pos.value as OsdPos })
  $('osd-test').onclick = () => holo.testOsd()
  $('osdset').addEventListener('toggle', () => fitHeight())
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

function fillSelect(sel: HTMLSelectElement, items: { id: string; label: string }[], value: string): void {
  const sig = items.map((d) => d.id + d.label).join('|')
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = ''
    for (const d of items) {
      const o = document.createElement('option')
      o.value = d.id
      o.textContent = d.label
      sel.appendChild(o)
    }
    sel.dataset.sig = sig
  }
  if (document.activeElement !== sel) sel.value = value
}

function render(): void {
  if (!st) return
  const S = st.S
  for (const id of ['mic', 'sys'] as LaneId[]) {
    const cfg = S.lanes[id]
    const p = $(`power-${id}`)
    p.classList.toggle('on', cfg.enabled)
    p.querySelector('.power-label')!.textContent = cfg.enabled ? 'ЭФФЕКТ ВКЛ' : 'ЭФФЕКТ ВЫКЛ'
    p.querySelector('.power-sub')!.textContent = cfg.enabled
      ? (EFFECTS.find((e) => e.id === cfg.effect)?.label ?? '')
      : id === 'mic' ? 'чистый голос' : 'звук как обычно'
    $(`led-${id}`).classList.toggle('on', cfg.enabled)
    document.querySelectorAll<HTMLElement>(`#effects-${id} .fx`).forEach((b) => b.classList.toggle('sel', b.dataset.effect === cfg.effect))
    const h = $(`hint-${id}`)
    h.innerHTML = st.hint[id].html // собирается в движке, подписи устройств экранированы там
    h.classList.toggle('warn', st.hint[id].warn)
  }
  for (const id of ['mic', 'sys'] as LaneId[]) {
    renderFxBox(id)
    const q = $<HTMLSelectElement>(`quality-${id}`)
    if (document.activeElement !== q) q.value = S.lanes[id].quality
  }
  for (const s of sliderInputs) {
    if (document.activeElement === s.input) continue
    const v = Number(S.lanes[s.lane][s.key])
    s.input.value = String(v)
    s.val.textContent = s.fmt(v)
  }
  fillSelect($('mic'), st.mics, S.mic)
  fillSelect($('out'), st.outs, S.out)
  const mon = $<HTMLInputElement>('monitor')
  mon.checked = S.monitor
  $<HTMLInputElement>('monitor-vol').value = String(S.monitorVol)
}

function selectTab(id: LaneId): void {
  ui.tab = id
  holo.setUi({ tab: id })
  document.querySelectorAll<HTMLElement>('.tabs button').forEach((b) => b.classList.toggle('sel', b.dataset.tab === id))
  document.querySelectorAll<HTMLElement>('.lane').forEach((el) => el.classList.toggle('sel', el.id === `lane-${id}`))
  document.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => el.classList.toggle('sel', el.dataset.for === id))
  fitHeight()
}

async function fitHeight(): Promise<void> {
  await new Promise((r) => requestAnimationFrame(r))
  await holo.setHeight($('app').scrollHeight + 4)
}

async function main(): Promise<void> {
  ui = await holo.getUi()
  $('btn-close').onclick = () => holo.close()
  $('btn-min').onclick = () => holo.minimize()
  const pin = $('btn-pin')
  pin.classList.toggle('on', ui.pinned)
  pin.onclick = async () => { ui = await holo.setUi({ pinned: !ui.pinned }); pin.classList.toggle('on', ui.pinned) }
  document.body.classList.toggle('compact', ui.compact)
  $('btn-compact').onclick = async () => {
    ui = await holo.setUi({ compact: !ui.compact })
    document.body.classList.toggle('compact', ui.compact)
    fitHeight()
  }
  $('btn-widget').onclick = () => holo.widget(true)
  document.querySelectorAll<HTMLElement>('.tabs button').forEach((b) => { b.onclick = () => selectTab(b.dataset.tab as LaneId) })
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

  buildLane('mic'); buildLane('sys')
  buildHotkeys('mic'); buildHotkeys('sys')
  await buildOsdSettings()
  hk = await holo.getHotkeys()
  renderHotkeys()
  document.querySelectorAll('details.hk').forEach((d) => d.addEventListener('toggle', () => fitHeight()))
  const mon = $<HTMLInputElement>('monitor'), monVol = $<HTMLInputElement>('monitor-vol')
  mon.onchange = () => holo.cmd({ type: 'monitor', on: mon.checked })
  monVol.oninput = () => holo.cmd({ type: 'monitorVol', value: Number(monVol.value) })
  $<HTMLSelectElement>('mic').onchange = (e) => holo.cmd({ type: 'mic', id: (e.target as HTMLSelectElement).value })
  $<HTMLSelectElement>('out').onchange = (e) => holo.cmd({ type: 'out', id: (e.target as HTMLSelectElement).value })

  holo.onState((s) => { st = s; render() })
  holo.onLevels((l) => {
    const [i, o] = l[ui.tab]
    $(`m-in-${ui.tab}`).style.width = `${i}%`
    $(`m-out-${ui.tab}`).style.width = `${o}%`
  })
  st = await holo.getState()
  render()
  selectTab(ui.tab)
}

main()
