'use strict'
// Global shortcuts: work in any window, including games.
// Action = "<lane>:<what>": toggle — on/off, next/prev — next/previous effect, otherwise an effect id
// (pressing the active effect's shortcut again turns the lane off).
//
// Binding = "<combo>[ x2| x3| hold]", combo = modifiers + key or mouse button ("Mouse3" middle, "Mouse4" back,
// "Mouse5" forward), e.g. "Ctrl+Alt+V", "F8 x2", "CapsLock x3", "Mouse4 hold", "Ctrl+Mouse5".
//   * plain keyboard combos — Electron globalShortcut (Windows RegisterHotKey, X11 XGrabKey; the key is consumed);
//   * mouse buttons, double/triple presses and holds — a passive low-level hook (uiohook: Windows hook, X11 XRecord);
//     the key still reaches the app. "hold" = while held: the lane switches to the effect and comes back on release.
// On Wayland neither works — a system limitation.
const { globalShortcut } = require('electron')

const VOICE = ['clean', 'male', 'female', 'child', 'demon', 'ghost', 'digital', 'hologram_classic', 'hologram_warm', 'smolder']
const MODS = ['Ctrl', 'Alt', 'Shift', 'Super']
const TAP_GAP = 350 // ms between presses of a double/triple press
const HOLD_MS = 250 // a press longer than this is a hold
const debug = process.env.HOLO_HK_DEBUG ? (...a) => console.log('[hotkeys]', ...a) : () => {}

function defaults() {
  // Windows: Ctrl+Alt is AltGr — Ctrl+Alt+digit/=/- would steal {, [, @, \\ … on German, French, Polish, Turkish
  // layouts in every app. Alt+Shift+key types nothing there (Alt+Shift alone switches the layout, with a key it doesn't).
  const m = process.platform === 'win32' ? 'Alt+Shift' : 'Ctrl+Alt'
  const d = {
    'mic:toggle': `${m}+V`, 'sys:toggle': `${m}+B`,
    'mic:next': `${m}+=`, 'mic:prev': `${m}+-`,
    'sys:next': 'Ctrl+Shift+F12', 'sys:prev': 'Ctrl+Shift+F11',
  }
  // My voice — <mod>+0…9 (0 — clean). Computer sound — Ctrl+Shift+F1…F10 (F10 — clean): Shift with a digit
  // on X11 produces a different symbol ("!"), and such a shortcut fires as if without Shift. Ice, wire, VHS — no shortcuts.
  VOICE.forEach((fx, i) => {
    d[`mic:${fx}`] = `${m}+${i}`
    d[`sys:${fx}`] = `Ctrl+Shift+F${i === 0 ? 10 : i}`
  })
  return d
}

/** "Ctrl+F8 x2" → { mods: 'Ctrl', key: 'F8', combo: 'Ctrl+F8', mode: 'x2' } (mods in canonical order) */
function parse(binding) {
  const m = /^(.*?)(?: (x2|x3|hold))?$/.exec(String(binding).trim())
  const parts = m[1].split('+')
  // "Ctrl+Alt+=" or "Ctrl+Alt+-": the key itself can't be empty, but "+" as a key is written "Plus"
  const key = parts.pop()
  const mods = MODS.filter((x) => parts.includes(x)).join('+')
  return { mods, key, combo: mods ? `${mods}+${key}` : key, mode: m[2] || 'press' }
}

const isMouse = (key) => /^Mouse\d$/.test(key)

// uiohook keycode → key name as in Electron accelerators (the panel records the same names)
function keyNames(UiohookKey) {
  const rename = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    Slash: '/', Backslash: '\\', Backquote: '`', NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv', NumpadDecimal: 'numdec', ScrollLock: 'Scrolllock', NumLock: 'Numlock', PrintScreen: 'PrintScreen',
  }
  const out = new Map()
  for (const [name, code] of Object.entries(UiohookKey)) {
    if (/^(Ctrl|Alt|Shift|Meta)/.test(name)) continue
    out.set(code, rename[name] ?? (/^Numpad\d$/.test(name) ? `num${name.slice(6)}` : name))
  }
  return out
}

let hookLib // undefined — not tried yet, null — unavailable
function loadHook() {
  if (hookLib === undefined) {
    try { hookLib = require('uiohook-napi') } catch (e) { hookLib = null; console.error('uiohook:', e.message) }
  }
  return hookLib
}

class Hotkeys {
  /** onAction(lane, action) — on press; onHold(lane, action, down) — hold started / released */
  constructor(onAction, onHold) {
    this.onAction = onAction
    this.onHold = onHold
    this.map = defaults()
    this.failed = [] // shortcuts taken by another program (or no input hook available)
    this.paused = false
    this.gestures = new Map() // combo → { press?, x2?, x3?, hold? } → action
    this.hookOn = false
    this.down = new Map() // held key/button → combo it was pressed with (also skips auto-repeat)
    this.taps = null // { combo, count, timer }
    this.hold = null // { name, combo, timer, action, active }
  }

  /** saved — from ui.json: custom bindings on top of the defaults ('' — shortcut removed) */
  load(saved) { this.map = { ...defaults(), ...(saved || {}) } }

  apply() {
    globalShortcut.unregisterAll()
    this.failed = []
    this.gestures.clear()
    if (this.paused) { this.stopHook(); return }
    // a combo that also has a double/triple press must go through the hook: otherwise its single press fires every time
    const multi = new Set()
    for (const b of Object.values(this.map)) if (b) { const p = parse(b); if (p.mode !== 'press') multi.add(p.combo) }
    for (const [action, binding] of Object.entries(this.map)) {
      if (!binding) continue
      const p = parse(binding)
      const [lane, what] = action.split(':')
      if (p.mode === 'press' && !isMouse(p.key) && !multi.has(p.combo)) {
        let ok = false
        try { ok = globalShortcut.register(p.combo, () => this.onAction(lane, what)) } catch { ok = false }
        if (!ok) this.failed.push(action)
        continue
      }
      const g = this.gestures.get(p.combo) ?? {}
      g[p.mode] = action
      this.gestures.set(p.combo, g)
    }
    if (this.gestures.size) this.startHook()
    else this.stopHook()
  }

  startHook() {
    const lib = loadHook()
    if (!lib) {
      for (const g of this.gestures.values()) this.failed.push(...Object.values(g))
      return
    }
    if (this.hookOn) return
    this.names ??= keyNames(lib.UiohookKey)
    if (!this.listening) {
      this.listening = true
      const mods = (e) => [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean).join('+')
      lib.uIOhook.on('keydown', (e) => { const n = this.names.get(e.keycode); if (n) this.press(n, mods(e)) })
      lib.uIOhook.on('keyup', (e) => { const n = this.names.get(e.keycode); if (n) this.release(n) })
      // 1 left, 2 right — not bindable (clicks); 3 middle, 4/5 side buttons
      lib.uIOhook.on('mousedown', (e) => { if (e.button >= 3) this.press(`Mouse${e.button}`, mods(e)) })
      lib.uIOhook.on('mouseup', (e) => { if (e.button >= 3) this.release(`Mouse${e.button}`) })
    }
    try { lib.uIOhook.start(); this.hookOn = true } catch (e) {
      console.error('uiohook start:', e.message)
      for (const g of this.gestures.values()) this.failed.push(...Object.values(g))
    }
  }

  stopHook() {
    if (!this.hookOn) return
    try { hookLib.uIOhook.stop() } catch {}
    this.hookOn = false
    this.down.clear()
    this.endHold()
  }

  fire(action, down) {
    const [lane, what] = action.split(':')
    if (down === undefined) this.onAction(lane, what)
    else this.onHold(lane, what, down)
  }

  press(name, mods) {
    debug('press', name, mods)
    if (this.down.has(name)) return // auto-repeat
    const combo = mods ? `${mods}+${name}` : name
    this.down.set(name, combo)
    const g = this.gestures.get(combo)
    if (g?.hold) {
      const h = { name, combo, action: g.hold, active: false }
      h.timer = setTimeout(() => { h.active = true; this.fire(h.action, true) }, HOLD_MS)
      this.endHold()
      this.hold = h
    }
  }

  release(name) {
    // modifiers are sometimes released before the key: count the tap by the combo it was pressed with
    const combo = this.down.get(name)
    this.down.delete(name)
    const h = this.hold
    if (h && h.name === name) {
      this.hold = null
      clearTimeout(h.timer)
      if (h.active) { this.fire(h.action, false); this.taps = null; return } // a hold isn't a tap
      this.tap(h.combo)
      return
    }
    if (combo) this.tap(combo)
  }

  /** Taps are counted on release */
  tap(combo) {
    const g = this.gestures.get(combo)
    debug('tap', combo, !!g, this.taps?.combo, this.taps?.count)
    if (!g) { this.taps = null; return }
    const t = this.taps
    const count = t && t.combo === combo ? t.count + 1 : 1
    if (t) clearTimeout(t.timer)
    const max = g.x3 ? 3 : g.x2 ? 2 : 1
    const action = count === 1 ? g.press : g[`x${count}`]
    if (count >= max) { this.taps = null; if (action) this.fire(action); return }
    // more presses may follow: wait, then run what was counted
    this.taps = { combo, count, timer: setTimeout(() => { this.taps = null; if (action) this.fire(action) }, TAP_GAP) }
  }

  endHold() {
    const h = this.hold
    if (!h) return
    this.hold = null
    clearTimeout(h.timer)
    if (h.active) this.fire(h.action, false)
  }

  /** While the panel is capturing a new shortcut, global ones must not intercept key presses */
  pause(on) { this.paused = !!on; this.apply() }

  /** Assign a shortcut. One shortcut — one action: it is removed from the previous owner. */
  set(action, binding) {
    const norm = binding ? (({ combo, mode }) => (mode === 'press' ? combo : `${combo} ${mode}`))(parse(binding)) : ''
    if (norm) for (const [a, k] of Object.entries(this.map)) if (k === norm && a !== action) this.map[a] = ''
    this.map[action] = norm
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

  dispose() { globalShortcut.unregisterAll(); this.stopHook() }
}

module.exports = { Hotkeys, parse }
