// Подсказка поверх экрана: какая дорожка и эффект (при горячей клавише) и полоса нарастания/затухания —
// заполняется ровно за время перехода, на пике окно прячет main.
import { effectInfo, fxLabel, setCustom } from './effects'
import { setLang, t } from './i18n'
import { $, holo, type EngineState, type OsdMsg } from './shared'

let st: EngineState | null = null
let cur: OsdMsg | null = null
let anim = 0

function renderText(): void {
  if (!st || !cur) return
  const cfg = st.S.lanes[cur.lane]
  setCustom(st.S.custom)
  const fx = effectInfo(cfg.effect)
  $('lane').textContent = `${cur.lane === 'mic' ? '🎙️' : '🔊'} ${t(`lane.${cur.lane}`)}`
  $('ico').textContent = cfg.enabled ? (fx?.emoji ?? '') : '⏻'
  $('text').textContent = cfg.enabled ? fxLabel(cfg.effect) : t('osd.off')
  const root = $('root')
  root.classList.toggle('off', !cfg.enabled && !cur.ramp)
  root.classList.toggle('sys', cur.lane === 'sys')
}

holo.getUi().then((u) => setLang(u.lang))
holo.onLang(() => location.reload())
holo.onState((s) => { st = s; renderText() })

holo.onOsd(async (msg) => {
  st = st ?? (await holo.getState())
  cur = msg
  const root = $('root')
  $('toast').hidden = !msg.toast
  $('track').hidden = !msg.ramp
  root.classList.toggle('baronly', !msg.toast)
  renderText()
  cancelAnimationFrame(anim)
  const fill = $('fill'), pct = $('pct')
  pct.textContent = ''
  if (!msg.ramp) return
  // нарастание — полоса заполняется к эффекту, затухание — убывает к обычному звуку
  const { seconds, dir } = msg.ramp
  const t0 = performance.now()
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / (seconds * 1000))
    const v = dir === 'in' ? k : 1 - k
    fill.style.width = `${v * 100}%`
    pct.textContent = `${Math.round(v * 100)}%`
    if (k < 1) anim = requestAnimationFrame(tick)
  }
  tick()
})
