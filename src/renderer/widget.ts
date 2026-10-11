// Desktop widget: no controls — just an input/output effect picked from a list and instant on/off.
// An engine controller, like the panel; a pinned widget starts with the system (main.js).
import { allEffects, customs, fxLabel, setCustom, type EffectId } from './effects'
import { applyStatic, setLang } from './i18n'
import { applyIcons } from './icons'
import { $, holo, type EngineState, type LaneId } from './shared'

const rows = {} as Record<LaneId, HTMLElement>
document.querySelectorAll<HTMLElement>('.w-row').forEach((r) => { rows[r.dataset.lane as LaneId] = r })

let sig = ''
function fillOptions(sel: HTMLSelectElement, lane: LaneId, neural: boolean): void {
  sel.innerHTML = ''
  for (const e of allEffects()) {
    if (e.neural && (lane === 'sys' || !neural)) continue // neural voices: GPU mode, "My voice" only
    const o = document.createElement('option')
    o.value = e.id
    o.textContent = fxLabel(e.id) // <option> can't hold an SVG
    sel.appendChild(o)
  }
}

function render(st: EngineState): void {
  setCustom(st.S.custom)
  const now = customs().map((c) => c.id + c.name + c.icon).join('|') + (st.neural?.available ? '|neural' : '')
  if (now !== sig) { sig = now; for (const id of ['mic', 'sys'] as LaneId[]) fillOptions(rows[id].querySelector<HTMLSelectElement>('.w-fx')!, id, !!st.neural?.available) }
  for (const id of ['mic', 'sys'] as LaneId[]) {
    const cfg = st.S.lanes[id]
    const row = rows[id]
    row.classList.toggle('on', cfg.enabled)
    const sel = row.querySelector<HTMLSelectElement>('.w-fx')!
    if (document.activeElement !== sel) sel.value = cfg.effect
    row.title = st.hint[id].warn ? st.hint[id].html.replace(/<[^>]+>/g, '') : ''
  }
}

async function main(): Promise<void> {
  setLang((await holo.getUi()).lang)
  applyStatic()
  applyIcons()
  holo.onLang(() => location.reload())
  $('btn-panel').onclick = () => holo.showPanel()
  $('btn-unpin').onclick = () => holo.widget(false)
  for (const id of ['mic', 'sys'] as LaneId[]) {
    const row = rows[id]
    const sel = row.querySelector<HTMLSelectElement>('.w-fx')!
    fillOptions(sel, id, false)
    sel.onchange = () => holo.cmd({ type: 'effect', lane: id, effect: sel.value as EffectId })
    row.querySelector<HTMLButtonElement>('.w-sw')!.onclick = () => holo.cmd({ type: 'toggle', lane: id })
  }
  holo.onState(render)
  holo.onLevels((l) => {
    for (const id of ['mic', 'sys'] as LaneId[]) rows[id].querySelector<HTMLElement>('.w-bar i')!.style.width = `${l[id][1]}%`
  })
  const st = await holo.getState()
  if (st) render(st)
  await new Promise((r) => requestAnimationFrame(r))
  holo.setHeight($('app').scrollHeight + 2)
}

main()
