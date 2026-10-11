'use strict'
// Global keyboard shortcuts: work in any window, including games (Windows — RegisterHotKey, X11 — XGrabKey;
// on Wayland global app shortcuts do not work — a system limitation).
// Action = "<lane>:<what>": toggle — on/off, next/prev — next/previous effect, otherwise an effect id
// (pressing the active effect's shortcut again turns the lane off).
const { globalShortcut } = require('electron')

const VOICE = ['clean', 'male', 'female', 'child', 'demon', 'ghost', 'digital', 'hologram_classic', 'hologram_warm', 'smolder']

function defaults() {
  const d = {
    'mic:toggle': 'Ctrl+Alt+V', 'sys:toggle': 'Ctrl+Alt+B',
    'mic:next': 'Ctrl+Alt+=', 'mic:prev': 'Ctrl+Alt+-',
    'sys:next': 'Ctrl+Shift+F12', 'sys:prev': 'Ctrl+Shift+F11',
  }
  // My voice — Ctrl+Alt+0…9 (0 — clean). Computer sound — Ctrl+Shift+F1…F10 (F10 — clean): Shift with a digit
  // on X11 produces a different symbol ("!"), and such a shortcut fires as if without Shift. Ice, wire, VHS — no shortcuts.
  VOICE.forEach((fx, i) => {
    d[`mic:${fx}`] = `Ctrl+Alt+${i}`
    d[`sys:${fx}`] = `Ctrl+Shift+F${i === 0 ? 10 : i}`
  })
  return d
}

class Hotkeys {
  /** onAction(lane, action) — called on press */
  constructor(onAction) {
    this.onAction = onAction
    this.map = defaults()
    this.failed = [] // shortcuts taken by another program
    this.paused = false
  }

  /** saved — from ui.json: custom bindings on top of the defaults ('' — shortcut removed) */
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

  /** While the panel is capturing a new shortcut, global ones must not intercept key presses */
  pause(on) { this.paused = !!on; this.apply() }

  /** Assign a shortcut. One shortcut — one action: it is removed from the previous owner. */
  set(action, accel) {
    if (accel) for (const [a, k] of Object.entries(this.map)) if (k === accel && a !== action) this.map[a] = ''
    this.map[action] = accel || ''
    this.apply()
    return { ok: !this.failed.includes(action), map: this.map, failed: this.failed }
  }

  reset() { this.map = defaults(); this.apply() }

  /** Only the differences from the defaults — for ui.json */
  diff() {
    const d = defaults()
    const out = {}
    for (const [a, k] of Object.entries(this.map)) if (d[a] !== k) out[a] = k
    return out
  }

  dispose() { globalShortcut.unregisterAll() }
}

module.exports = { Hotkeys }
