'use strict'
// Глобальные сочетания клавиш: работают в любом окне, в том числе в играх (Windows — RegisterHotKey, X11 — XGrabKey;
// на Wayland глобальные сочетания приложений не работают — ограничение системы).
// Действие = "<дорожка>:<что>": toggle — вкл/выкл, next/prev — следующий/предыдущий эффект, иначе id эффекта
// (повторное нажатие сочетания включённого эффекта выключает дорожку).
const { globalShortcut } = require('electron')

const VOICE = ['clean', 'male', 'female', 'child', 'demon', 'ghost', 'digital', 'hologram_classic', 'hologram_warm', 'smolder']

function defaults() {
  const d = {
    'mic:toggle': 'Ctrl+Alt+V', 'sys:toggle': 'Ctrl+Alt+B',
    'mic:next': 'Ctrl+Alt+=', 'mic:prev': 'Ctrl+Alt+-',
    'sys:next': 'Ctrl+Shift+F12', 'sys:prev': 'Ctrl+Shift+F11',
  }
  // Мой голос — Ctrl+Alt+0…9 (0 — чистый). Звук компьютера — Ctrl+Shift+F1…F10 (F10 — чистый): Shift с цифрой
  // на X11 даёт другой символ («!»), и такое сочетание срабатывает как без Shift. Лёд, провод, VHS — без сочетаний.
  VOICE.forEach((fx, i) => {
    d[`mic:${fx}`] = `Ctrl+Alt+${i}`
    d[`sys:${fx}`] = `Ctrl+Shift+F${i === 0 ? 10 : i}`
  })
  return d
}

class Hotkeys {
  /** onAction(lane, action) — вызывается при нажатии */
  constructor(onAction) {
    this.onAction = onAction
    this.map = defaults()
    this.failed = [] // сочетания, занятые другой программой
    this.paused = false
  }

  /** saved — из ui.json: свои назначения поверх значений по умолчанию ('' — сочетание снято) */
  load(saved) { this.map = { ...defaults(), ...(saved || {}) } }

  apply() {
    globalShortcut.unregisterAll()
    this.failed = []
    if (this.paused) return
    for (const [action, accel] of Object.entries(this.map)) {
      if (!accel) continue
      const [lane, what] = action.split(':')
      let ok = false
      try { ok = globalShortcut.register(accel, () => this.onAction(lane, what)) } catch { ok = false }
      if (!ok) this.failed.push(action)
    }
  }

  /** Пока панель ловит новое сочетание, глобальные не должны перехватывать нажатия */
  pause(on) { this.paused = !!on; this.apply() }

  /** Назначить сочетание. Одно сочетание — одно действие: у прежнего владельца снимается. */
  set(action, accel) {
    if (accel) for (const [a, k] of Object.entries(this.map)) if (k === accel && a !== action) this.map[a] = ''
    this.map[action] = accel || ''
    this.apply()
    return { ok: !this.failed.includes(action), map: this.map, failed: this.failed }
  }

  reset() { this.map = defaults(); this.apply() }

  /** Только отличия от умолчаний — для ui.json */
  diff() {
    const d = defaults()
    const out = {}
    for (const [a, k] of Object.entries(this.map)) if (d[a] !== k) out[a] = k
    return out
  }

  dispose() { globalShortcut.unregisterAll() }
}

module.exports = { Hotkeys }
