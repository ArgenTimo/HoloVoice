'use strict'
// Processes and windows:
//   engine — hidden window with all the audio (engine.ts); lives as long as the app does
//   panel  — main window with settings; close button: if any effect is on or the widget is pinned — hides
//            to the tray and audio keeps running; if nothing is on — the whole app quits
//   widget — desktop widget; when pinned it starts with the system (--widget) and does not depend on the panel
//   osd    — hotkey toast and effect ramp bar; takes no focus and ignores the mouse (doesn't disturb games)
const { app, BrowserWindow, ipcMain, shell, session, Tray, Menu, Notification, clipboard, nativeImage, powerMonitor, screen } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LinuxRouter } = require('./routing-linux')
const updater = require('./updater')
const { Hotkeys } = require('./hotkeys')
const { WinSysAudio } = require('./sysaudio-win')
const neuralVc = require('./neural-vc')
const log = require('./log')
log.init()

// ---------------------------------------------------------------- language (dictionaries shared with the windows: src/locales)
const LANG_CODES = ['en', 'zh', 'hi', 'es', 'fr', 'ar', 'bn', 'pt', 'ru', 'ur', 'id', 'de', 'ja', 'mr', 'te', 'tr', 'ta', 'vi', 'ko', 'it', 'uk', 'be', 'pl']
const dicts = {}
const dict = (code) => (dicts[code] ??= (() => { try { return require(`./locales/${code}.json`) } catch { return {} } })())
function tr(key, vars) {
  const s = dict(ui.lang)[key] ?? dict('en')[key] ?? key
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : s
}
function systemLang() {
  const code = (app.getLocale() || 'en').slice(0, 2).toLowerCase()
  return LANG_CODES.includes(code) ? code : 'en'
}

// Real-time audio must not sleep when windows are minimized or hidden
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.disableHardwareAcceleration() // windows are tiny; without a GPU process there are fewer crashes across drivers

const ICON = path.join(__dirname, '..', 'build', 'icon.png')
const TRAY_ICON = { off: path.join(__dirname, '..', 'build', 'tray.png'), live: path.join(__dirname, '..', 'build', 'tray-live.png') }
const trayImage = (live) => nativeImage.createFromPath(live ? TRAY_ICON.live : TRAY_ICON.off).resize({ width: 22, height: 22 })
const PAGE = (name) => path.join(__dirname, 'renderer', `${name}.html`)
const fromAutostart = process.argv.includes('--widget')

/**
 * Command-line actions for system shortcuts (Wayland has no global hotkeys for apps) and scripts:
 *   holovoice --toggle mic|sys      on/off
 *   holovoice --effect mic:demon    switch to an effect (pressing again for the active one turns it off, like a hotkey)
 *   holovoice --next mic | --prev mic
 * A running HoloVoice receives them through the single-instance lock. Returns true if argv had an action.
 */
function cliAction(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
  const lane = (v) => (v === 'sys' ? 'sys' : 'mic')
  let cmd = null
  if (arg('--toggle')) cmd = { lane: lane(arg('--toggle')), action: 'toggle' }
  else if (arg('--next')) cmd = { lane: lane(arg('--next')), action: 'next' }
  else if (arg('--prev')) cmd = { lane: lane(arg('--prev')), action: 'prev' }
  else if (arg('--effect')) { const [l, fx] = arg('--effect').split(':'); if (fx) cmd = { lane: lane(l), action: fx } }
  if (!cmd) return false
  onHotkey(cmd.lane, cmd.action)
  return true
}

let engine = null
let panel = null
let widget = null
let tray = null
let router = null
let followTimer = null
let state = null // last engine state
let quitting = false
let osd = null
let osdTimer = null
let osdToast = null // { lane, at } — hotkey: show the toast together with the ramp or on the next state
const hotkeys = new Hotkeys(onHotkey, onHotkeyHold)

// ---------------------------------------------------------------- window settings

const UI_DEFAULTS = { pinned: false, trayNotice: false, onboarded: false, compact: false, tab: 'mic', widget: false, widgetPinned: true, widgetBounds: null, panelBounds: null, hotkeys: {}, osd: true, rampBar: true, osdPos: 'top', lang: null }
let ui = { ...UI_DEFAULTS }
const uiPath = () => path.join(app.getPath('userData'), 'ui.json')
function loadUi() {
  try { ui = { ...UI_DEFAULTS, ...JSON.parse(fs.readFileSync(uiPath(), 'utf8')) } } catch { /* defaults */ }
  if (!LANG_CODES.includes(ui.lang)) ui.lang = systemLang()
}
// Written via a temp file + rename (a crash mid-write must not wipe the settings), and debounced: windows report
// 'moved' many times per drag.
let saveTimer = null
function saveUi() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveUiNow, 300)
}
function saveUiNow() {
  clearTimeout(saveTimer)
  try {
    fs.mkdirSync(path.dirname(uiPath()), { recursive: true })
    fs.writeFileSync(`${uiPath()}.tmp`, JSON.stringify(ui))
    fs.renameSync(`${uiPath()}.tmp`, uiPath())
  } catch { /* not critical */ }
}

/** Saved bounds that still fit a connected display (a monitor may be gone, the resolution may have changed);
 *  otherwise only the size is kept, clamped to the primary work area, and the window is centered. */
function fitBounds(b, w, h) {
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(b?.width || w, area.width), height = Math.min(b?.height || h, area.height)
  if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) {
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      b.x + 40 < a.x + a.width && b.x + Math.min(width, 200) - 40 > a.x && b.y >= a.y - 10 && b.y + 30 < a.y + a.height)
    if (visible) return { x: b.x, y: b.y, width, height }
  }
  return { width, height }
}

// ---------------------------------------------------------------- startup

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (cliAction(argv)) return // `holovoice --toggle mic` etc.: act without showing anything
    if (!argv.includes('--widget')) showPanel()
  })
  app.whenReady().then(start)
}

const ownPids = () => new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)])

function start() {
  loadUi()
  if (fromAutostart && !ui.widget) { app.quit(); return } // the widget was unpinned but the autostart entry remained
  // Microphone and output device selection — no prompts (the app is local)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true))
  session.defaultSession.setPermissionCheckHandler(() => true)
  if (process.platform === 'win32') WinSysAudio.restore()

  engine = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, contextIsolation: true, sandbox: true },
  })
  engine.loadFile(PAGE('engine'))
  log.attach('engine', engine.webContents)
  // the engine reloads itself (quality change): helpers it started must start over with the new page,
  // otherwise e.g. the neural sidecar never says "ready" again
  engine.webContents.on('did-start-loading', () => { winSys?.stop(); neural?.stop() })
  engine.on('closed', () => { engine = null; if (!quitting) app.quit() })
  // The engine renderer crashed: release what it held (the Windows helper keeps other apps turned down otherwise)
  // and start it again — settings are in its localStorage, so it comes back in the same state.
  engine.webContents.on('render-process-gone', (_e, d) => {
    console.error('engine gone:', d.reason)
    winSys?.stop()
    neural?.stop()
    if (!quitting && d.reason !== 'clean-exit') setTimeout(() => engine?.webContents.reload(), 1000)
  })

  createTray()
  powerMonitor.on('resume', () => engine?.webContents.send('power:resume'))
  setTimeout(checkUpdates, 15000)
  setInterval(checkUpdates, 6 * 3600 * 1000)
  if (ui.widget) showWidget()
  if (!fromAutostart) showPanel()
  // Linux: refresh the autostart entry's paths (an AppImage may have moved). Windows: only when the user toggles
  // the widget — re-registering on every start would undo turning it off in Task Manager.
  if (process.platform === 'linux' && ui.widget) setAutostart(true)

  hotkeys.load(ui.hotkeys)
  hotkeys.apply()
}

// ---------------------------------------------------------------- hotkeys and toast

function onHotkey(lane, action) {
  osdToast = { lane, at: Date.now() }
  toEngine({ type: 'hotkey', lane, action })
}

/** Held shortcut: the effect is on while held, the previous state comes back on release */
function onHotkeyHold(lane, action, down) {
  osdToast = { lane, at: Date.now() }
  toEngine({ type: 'hold', lane, action, down })
}

const OSD_W = 260
const OSD_H = { toast: 54, toastBar: 64, bar: 14 }
const OSD_POS = ['top', 'top-left', 'top-right', 'bottom', 'bottom-left', 'bottom-right']

/** toast — "lane: effect" caption; ramp — { seconds, dir } fade-in/fade-out bar, disappears at the peak */
function showOsd(lane, toast, ramp) {
  if (!toast && !ramp) return
  if (!osd) {
    osd = new BrowserWindow({
      width: OSD_W, height: OSD_H.toast, show: false, frame: false, backgroundColor: '#12131a', resizable: false, movable: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, webPreferences: webPrefs(),
    })
    osd.setAlwaysOnTop(true, 'screen-saver')
    osd.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    osd.setIgnoreMouseEvents(true)
    osd.loadFile(PAGE('osd'))
    osd.on('closed', () => { osd = null })
  }
  const w = toast ? OSD_W : 220
  const h = toast ? (ramp ? OSD_H.toastBar : OSD_H.toast) : OSD_H.bar
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const pos = OSD_POS.includes(ui.osdPos) ? ui.osdPos : 'top'
  const m = 40
  const x = pos.endsWith('left') ? area.x + m : pos.endsWith('right') ? area.x + area.width - w - m : area.x + (area.width - w) / 2
  const y = pos.startsWith('top') ? area.y + m : area.y + area.height - h - m
  osd.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h })
  const send = () => {
    osd.webContents.send('osd', { lane, toast, ramp })
    osd.showInactive()
    // when shown while a hotkey is held, the window manager may leave the window below others — raise it explicitly
    osd.setAlwaysOnTop(true, 'screen-saver')
    osd.moveTop()
  }
  if (osd.webContents.isLoading()) osd.webContents.once('did-finish-load', send)
  else send()
  clearTimeout(osdTimer)
  osdTimer = setTimeout(() => osd?.hide(), Math.max(toast ? 1400 : 0, ramp ? ramp.seconds * 1000 + 350 : 0))
}

/** this lane's hotkey was just pressed — show the toast (once) */
function takeToast(lane) {
  const t = osdToast && osdToast.lane === lane && Date.now() - osdToast.at < 1500
  if (t) osdToast = null
  return !!t && ui.osd
}

// The engine started a smooth transition (fade-in/fade-out/effect change)
ipcMain.on('ramp', (e, r) => {
  if (!engine || e.sender !== engine.webContents) return
  const toast = takeToast(r.lane)
  showOsd(r.lane, toast, ui.rampBar ? { seconds: r.seconds, dir: r.dir } : null)
})

const webPrefs = () => ({
  preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, contextIsolation: true, sandbox: true,
})

function showPanel() {
  if (panel) { panel.show(); panel.focus(); return }
  const b = fitBounds(ui.panelBounds, PANEL_W, PANEL_H)
  panel = new BrowserWindow({
    ...b, minWidth: Math.min(PANEL_MIN_W, b.width), minHeight: Math.min(PANEL_MIN_H, b.height),
    frame: false, alwaysOnTop: ui.pinned, backgroundColor: '#12131a', title: 'HoloVoice', icon: ICON,
    webPreferences: webPrefs(),
  })
  if (ui.pinned) panel.setAlwaysOnTop(true, 'screen-saver') // on top of everything, including fullscreen windows
  panel.loadFile(PAGE('index'))
  log.attach('panel', panel.webContents)
  panel.on('close', (e) => {
    if (quitting) return
    if ((isActive() || widget) && tray) { // keep running in the background
      e.preventDefault()
      panel.hide()
      updateTray()
      trayNotice()
    } else quit() // nothing to keep running, or no tray to come back from
  })
  panel.on('closed', () => { panel = null })
  // the size and position of the wide window are remembered (not in compact mode)
  const keep = () => { if (panel && !panelCompact) { ui.panelBounds = panel.getBounds(); saveUi() } }
  panel.on('resized', keep)
  panel.on('moved', keep)
}

const PANEL_W = 1180, PANEL_H = 720, PANEL_MIN_W = 880, PANEL_MIN_H = 560
let panelCompact = false

/** Compact mode — lane cards only: a narrow window sized to the content height; switching back restores the previous size */
ipcMain.handle('win:compact', (_e, on, h) => {
  if (!panel) return
  const maxH = screen.getDisplayMatching(panel.getBounds()).workArea.height - 20
  if (on) {
    if (!panelCompact) { ui.panelBounds = panel.getBounds(); saveUi() }
    panelCompact = true
    panel.setMinimumSize(300, 150)
    panel.setSize(320, Math.min(maxH, Math.max(150, Math.round(h))))
  } else {
    panelCompact = false
    panel.setMinimumSize(PANEL_MIN_W, PANEL_MIN_H)
    const b = ui.panelBounds || {}
    panel.setBounds({ x: b.x ?? panel.getBounds().x, y: b.y ?? panel.getBounds().y, width: b.width || PANEL_W, height: b.height || PANEL_H })
  }
})

function showWidget() {
  if (widget) { widget.show(); return }
  const b = fitBounds(ui.widgetBounds, 260, 130)
  widget = new BrowserWindow({
    ...b, width: 260, height: 130, minWidth: 220,
    frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: ui.widgetPinned, minimizable: false,
    backgroundColor: '#12131a', title: 'HoloVoice', icon: ICON, webPreferences: webPrefs(),
  })
  if (ui.widgetPinned) widget.setAlwaysOnTop(true, 'screen-saver')
  widget.setVisibleOnAllWorkspaces(true)
  widget.loadFile(PAGE('widget'))
  log.attach('widget', widget.webContents)
  widget.on('moved', () => { ui.widgetBounds = widget.getBounds(); saveUi() })
  widget.on('close', (e) => { if (!quitting && ui.widget) e.preventDefault() }) // closes only by unpinning
  widget.on('closed', () => { widget = null })
}

function setWidget(on) {
  ui.widget = on
  saveUi()
  setAutostart(on)
  if (on) { showWidget(); return }
  if (widget) { const w = widget; widget = null; w.destroy() }
  if (!panel || !panel.isVisible()) {
    if (isActive()) updateTray()
    else quit()
  }
  updateTray()
}

const isActive = () => !!state && (state.S.lanes.mic.enabled || state.S.lanes.sys.enabled)

function quit() {
  quitting = true
  app.quit()
}

// ---------------------------------------------------------------- autostart (pinned widget)

function setAutostart(on) {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    if (!app.isPackaged) return
    app.setLoginItemSettings({ openAtLogin: on, args: ['--widget'] })
    return
  }
  // Linux: ~/.config/autostart/holovoice.desktop
  const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'holovoice.desktop')
  if (!on) { try { fs.unlinkSync(file) } catch { /* none */ } return }
  const exe = process.env.APPIMAGE
    ? `"${process.env.APPIMAGE}"`
    : `"${process.execPath}"${app.isPackaged ? '' : ` "${app.getAppPath()}"`}`
  // icon goes to a permanent location: the path inside the AppImage is temporary
  const icon = path.join(app.getPath('userData'), 'icon.png')
  try { fs.copyFileSync(ICON, icon) } catch { /* no icon */ }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, [
    '[Desktop Entry]', 'Type=Application', 'Name=HoloVoice (widget)', `Exec=${exe} --no-sandbox --widget`,
    `Icon=${icon}`, 'X-GNOME-Autostart-enabled=true', 'NoDisplay=true', '',
  ].join('\n'))
}

// ---------------------------------------------------------------- tray

function createTray() {
  try {
    tray = new Tray(trayImage(false))
    tray.setToolTip('HoloVoice')
    tray.on('click', showPanel)
    updateTray()
  } catch { tray = null } // no notification area — not critical
}

/** First time the panel goes to the tray: say so — otherwise it looks closed while the mic and hotkeys stay active */
function trayNotice() {
  if (ui.trayNotice) return
  ui.trayNotice = true
  saveUi()
  try { if (Notification.isSupported()) new Notification({ title: 'HoloVoice', body: tr('tray.notice'), icon: ICON }).show() } catch { /* no notifications */ }
}

const fxName = (id) => state?.S.custom?.find((c) => c.id === id)?.name ?? tr(`fx.${id}`)
const laneStatus = (lane) => {
  const l = state?.S.lanes[lane]
  return `${tr(lane === 'mic' ? 'tray.mic' : 'tray.sys')}: ${l?.enabled ? fxName(l.effect) : tr('tray.off')}`
}

function updateTray() {
  if (!tray) return
  const L = state?.S.lanes
  tray.setToolTip(state ? `HoloVoice\n${laneStatus('mic')}\n${laneStatus('sys')}` : 'HoloVoice')
  // a green dot while any effect is on — so "it's still running" is visible at a glance
  const live = !!(L?.mic.enabled || L?.sys.enabled)
  if (tray.live !== live) { tray.live = live; tray.setImage(trayImage(live)) }
  // quick effect choice without opening the panel: built-in effects in catalog order + the user's own
  const effects = (lane) => [...(state?.effects ?? []), ...(state?.S.custom ?? []).map((c) => c.id)]
    .filter((id) => !(lane === 'sys' && id.startsWith('neural')))
    .map((id) => ({ label: fxName(id), type: 'radio', checked: L?.[lane].effect === id, click: () => toEngine({ type: 'effect', lane, effect: id }) }))
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr('tray.open'), click: showPanel },
    ...(updateAvailable ? [{ label: tr('upd.toV', { v: updateAvailable }), click: showPanel }] : []),
    { type: 'separator' },
    { label: tr('tray.mic'), type: 'checkbox', checked: !!L?.mic.enabled, click: () => toEngine({ type: 'toggle', lane: 'mic' }) },
    { label: tr('tray.effect'), submenu: effects('mic'), enabled: !!state },
    { label: tr('tray.sys'), type: 'checkbox', checked: !!L?.sys.enabled, click: () => toEngine({ type: 'toggle', lane: 'sys' }) },
    { label: tr('tray.effect'), submenu: effects('sys'), enabled: !!state },
    { label: tr('tray.widget'), type: 'checkbox', checked: ui.widget, click: () => setWidget(!ui.widget) },
    { type: 'separator' },
    { label: tr('tray.quit'), click: quit },
  ]))
}

// ---------------------------------------------------------------- engine ↔ controls link

function toEngine(cmd) { engine?.webContents.send('cmd', cmd) }
const remotes = () => [panel, widget].filter((w) => w && !w.isDestroyed())

ipcMain.on('cmd', (_e, cmd) => toEngine(cmd))
ipcMain.on('state', (e, st) => {
  if (!engine || e.sender !== engine.webContents) return
  const prev = state
  state = st
  for (const w of [...remotes(), osd].filter((w) => w && !w.isDestroyed())) w.webContents.send('state', st)
  if (osdToast) { const lane = osdToast.lane; if (takeToast(lane)) showOsd(lane, true, null) }
  const sig = (x) => x && ['mic', 'sys'].map((l) => `${x.S.lanes[l].enabled}${x.S.lanes[l].effect}`).join() + (x.S.custom?.length ?? 0)
  if (sig(prev) !== sig(st)) updateTray()
})
ipcMain.on('levels', (e, l) => {
  if (!engine || e.sender !== engine.webContents) return
  for (const w of remotes()) if (w.isVisible()) w.webContents.send('levels', l)
})
ipcMain.handle('state:get', () => state)
ipcMain.handle('ui:get', () => ui)
ipcMain.handle('ui:set', (_e, patch) => {
  ui = { ...ui, ...patch }
  saveUi()
  if ('pinned' in patch && panel) panel.setAlwaysOnTop(!!ui.pinned, 'screen-saver')
  if ('lang' in patch) {
    if (!LANG_CODES.includes(ui.lang)) ui.lang = 'en'
    saveUi()
    for (const w of [engine, panel, widget, osd]) if (w && !w.isDestroyed()) w.webContents.send('lang', ui.lang)
    updateTray()
  }
  return ui
})
ipcMain.handle('widget', (_e, on) => setWidget(!!on))
const hotkeyInfo = () => ({ map: hotkeys.map, failed: hotkeys.failed })
const saveHotkeys = () => { ui.hotkeys = hotkeys.diff(); saveUi(); return hotkeyInfo() }
ipcMain.handle('hotkeys:get', () => hotkeyInfo())
ipcMain.handle('hotkeys:set', (_e, action, accel) => { hotkeys.set(action, accel); return saveHotkeys() })
ipcMain.handle('hotkeys:reset', () => { hotkeys.reset(); return saveHotkeys() })
ipcMain.handle('hotkeys:pause', (_e, on) => hotkeys.pause(on))
const osdInfo = () => ({ osd: ui.osd, rampBar: ui.rampBar, osdPos: ui.osdPos })
ipcMain.handle('osd:get', () => osdInfo())
ipcMain.handle('osd:set', (_e, patch) => {
  for (const k of ['osd', 'rampBar']) if (k in patch) ui[k] = !!patch[k]
  if (OSD_POS.includes(patch.osdPos)) ui.osdPos = patch.osdPos
  saveUi()
  return osdInfo()
})
ipcMain.handle('osd:test', () => showOsd(ui.tab || 'mic', ui.osd, ui.rampBar ? { seconds: 2, dir: 'in' } : null))
ipcMain.handle('panel:show', () => showPanel())

ipcMain.handle('app:version', () => app.getVersion())
let updating = false
ipcMain.handle('app:update', async (e) => {
  if (updating) return tr('upd.busy')
  updating = true
  const progress = (t) => { if (!e.sender.isDestroyed()) e.sender.send('update:progress', t) }
  const beforeInstall = async () => {
    winSys?.stop()
    neural?.stop()
    await new Promise((r) => setTimeout(r, 1500)) // let the helpers restore and exit
  }
  try { return await updater.update(progress, tr, beforeInstall) } finally { updating = false }
})
// a quiet check shortly after start and then every 6 hours: the panel shows "Update to X" instead of a plain button
let updateAvailable = null
async function checkUpdates() {
  try {
    const v = await updater.check()
    if (v && v !== updateAvailable) {
      updateAvailable = v
      for (const w of remotes()) w.webContents.send('update:available', v)
      updateTray()
    }
  } catch (e) { console.warn('update check:', e.message || e) }
}
ipcMain.handle('app:updateAvailable', () => updateAvailable)

ipcMain.handle('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
ipcMain.handle('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
ipcMain.handle('win:height', (e, h) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return
  const [width] = w.getSize()
  const resizable = w.isResizable()
  w.setResizable(true)
  const maxH = screen.getDisplayMatching(w.getBounds()).workArea.height - 20
  w.setSize(width, Math.min(maxH, Math.max(100, Math.round(h))))
  w.setResizable(resizable)
})
ipcMain.handle('open', (_e, url) => {
  // only what the UI links to: VB-Cable, Windows privacy/sound settings
  if (/^https:\/\/(www\.)?vb-audio\.com\//.test(url) || /^ms-settings:(privacy-microphone|sound)$/.test(url)) shell.openExternal(url)
})

// ---------------------------------------------------------------- routing (Linux)

function getRouter() {
  router = router || new LinuxRouter(app.getPath('userData'), ownPids)
  return router
}

// Clean up after the previous run if it crashed — once per app launch, not on every engine load:
// otherwise reloading the engine window would unload the live process's modules
let stale = null
function routerReady() {
  stale = stale || getRouter().restoreStale().catch(() => {})
  return stale.then(() => router)
}

ipcMain.handle('routing:mic', async () => {
  if (process.platform !== 'linux') return { ok: false, platform: process.platform }
  try {
    return { ok: true, platform: 'linux', ...(await (await routerReady()).setupMic()) }
  } catch (e) {
    return { ok: false, platform: 'linux', error: String(e.message || e) }
  }
})

// Windows: PCM from the helper straight to the engine
let winSys = null
function getWinSys() {
  return (winSys ??= new WinSysAudio(
    (buf) => engine?.webContents.send('sysaudio', buf),
    (error) => engine?.webContents.send('sysaudio:end', error),
  ))
}

ipcMain.handle('routing:sys', async (_e, on, rate) => {
  if (process.platform === 'win32') {
    if (!on) { getWinSys().stop(); return { ok: true, platform: 'win32' } }
    return { platform: 'win32', ...(await getWinSys().start(rate)) }
  }
  if (process.platform !== 'linux') return { ok: true, platform: process.platform }
  const r = getRouter()
  clearInterval(followTimer)
  await routerReady()
  try {
    if (!on) { await r.releaseSys(); return { ok: true, platform: 'linux' } }
    const res = await r.interceptSys()
    // New streams go to the default output (ours) on their own, but some apps are bound to a device
    // and the real output may change (a BT speaker connects…): the engine then plays to the new one
    followTimer = setInterval(async () => {
      const changed = await r.checkRealSink().catch(() => null)
      if (changed) engine?.webContents.send('routing:realSink', changed)
      await r.followStreams().catch(() => {})
    }, 2000)
    return { ok: true, platform: 'linux', ...res }
  } catch (e) {
    await r.releaseSys().catch(() => {})
    return { ok: false, platform: 'linux', error: String(e.message || e) }
  }
})

// ---------------------------------------------------------------- Linux AppImage: applications menu + command

const desktopEntry = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications', 'holovoice.desktop')
/** Is there something to offer: an AppImage that isn't in the applications menu yet */
ipcMain.handle('linux:canInstall', () => !!process.env.APPIMAGE && !fs.existsSync(desktopEntry()))
ipcMain.handle('linux:install', () => {
  const exe = process.env.APPIMAGE
  if (!exe) return false
  const icon = path.join(app.getPath('userData'), 'icon.png')
  try { fs.copyFileSync(ICON, icon) } catch { /* no icon */ }
  fs.mkdirSync(path.dirname(desktopEntry()), { recursive: true })
  fs.writeFileSync(desktopEntry(), [
    '[Desktop Entry]', 'Type=Application', 'Name=HoloVoice', 'Comment=Real-time effects for your voice and computer sound',
    `Exec="${exe}" --no-sandbox %U`, `Icon=${icon}`, 'Categories=Audio;AudioVideo;', 'StartupWMClass=HoloVoice', 'Terminal=false', '',
  ].join('\n'))
  // the `holovoice` command for system shortcuts (Wayland) and scripts
  const bin = path.join(os.homedir(), '.local', 'bin', 'holovoice')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${exe}" --no-sandbox "$@"\n`, { mode: 0o755 })
  return true
})

// ---------------------------------------------------------------- diagnostics

ipcMain.handle('app:quit', () => quit())
ipcMain.handle('diag:logs', () => shell.openPath(log.dir()))
/** Everything useful for a bug report, to the clipboard: versions, what is on, hints, devices, recent log */
ipcMain.handle('diag:copy', () => {
  const plain = (h) => String(h ?? '').replace(/<[^>]+>/g, '').replace(/&#(\d+);/g, (_m, c) => String.fromCharCode(c))
  const L = state?.S.lanes
  const text = [
    `HoloVoice ${app.getVersion()} — ${process.platform} ${os.release()} ${process.arch}, Electron ${process.versions.electron}`,
    `session: ${process.env.XDG_SESSION_TYPE || '-'}, lang: ${ui.lang}`,
    L ? `my voice: ${L.mic.enabled ? 'on' : 'off'} ${L.mic.effect}; computer sound: ${L.sys.enabled ? 'on' : 'off'} ${L.sys.effect}` : 'engine: no state',
    state ? `hint mic: ${plain(state.hint.mic.html)}` : '',
    state ? `hint sys: ${plain(state.hint.sys.html)}` : '',
    state ? `mics: ${state.mics.map((d) => d.label).join(' | ')}` : '',
    state ? `outputs: ${state.outs.map((d) => d.label).join(' | ')}` : '',
    state?.neural ? `neural: ${JSON.stringify(state.neural)}` : '',
    `hotkeys failed: ${hotkeys.failed.join(', ') || '-'}`,
    '', '--- recent log ---', ...log.recent(),
  ].filter((x) => x !== null).join('\n')
  clipboard.writeText(text)
  return true
})

// ---------------------------------------------------------------- neural voices (optional GPU mode)

let neural = null
function getNeural() {
  return (neural ??= new neuralVc.NeuralVc(
    (buf) => engine?.webContents.send('neural:audio', buf),
    (status) => engine?.webContents.send('neural:status', status),
  ))
}
ipcMain.handle('neural:check', (_e, force) => neuralVc.check(!!force))
ipcMain.handle('neural:start', (_e, voiceId, rate) => {
  const v = neuralVc.voices().find((x) => x.id === voiceId) ?? neuralVc.voices().find((x) => x.id.startsWith(voiceId))
  if (!v) return { ok: false, error: `voice "${voiceId}" not found` }
  return getNeural().start(v.path, rate)
})
ipcMain.handle('neural:stop', () => { neural?.stop() })
ipcMain.on('neural:in', (_e, buf) => { neural?.write(Buffer.from(buf)) })

// ---------------------------------------------------------------- exit

function cleanup() {
  clearInterval(followTimer)
  winSys?.stop()
  neural?.stop()
  hotkeys.dispose()
  if (router) { router.restoreSync(); router = null }
}
app.on('before-quit', () => { quitting = true; saveUiNow() })
app.on('window-all-closed', () => { if (quitting) app.quit() })
app.on('will-quit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(0) })
