'use strict'
// A log file the user can send: <userData>/logs/main.log (rotated at 1 MB, one old file kept).
// console.* of the main process, the renderers' console (engine errors), helper stderr and crashes all land here.
const { app, crashReporter } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const util = require('node:util')

const MAX = 1024 * 1024
let file = null
let lines = [] // recent lines for "copy diagnostics"

function dir() { return path.join(app.getPath('userData'), 'logs') }

function write(level, args) {
  const text = util.format(...args)
  const line = `${new Date().toISOString()} ${level} ${text}`
  lines.push(line)
  if (lines.length > 300) lines = lines.slice(-200)
  if (!file) return
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX) fs.renameSync(file, file.replace(/\.log$/, '.old.log'))
    fs.appendFileSync(file, line + '\n')
  } catch { /* the log must never break the app */ }
}

/** Call once, before anything else logs */
function init() {
  try { fs.mkdirSync(dir(), { recursive: true }); file = path.join(dir(), 'main.log') } catch { file = null }
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console)
    console[level] = (...args) => { orig(...args); write(level.toUpperCase(), args) }
  }
  process.on('uncaughtException', (e) => console.error('uncaught:', e?.stack || e))
  process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.stack || e))
  try { crashReporter.start({ uploadToServer: false }) } catch { /* not critical */ }
  console.log(`HoloVoice ${app.getVersion()} — ${process.platform} ${process.arch}, Electron ${process.versions.electron}`)
}

/** Renderer console → log (warnings and errors only: the engine is chatty otherwise) */
function attach(name, webContents) {
  webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) write(level === 3 ? 'ERROR' : 'WARN', [`[${name}] ${message} (${path.basename(source || '')}:${line})`])
  })
  webContents.on('render-process-gone', (_e, d) => write('ERROR', [`[${name}] renderer gone: ${d.reason} (${d.exitCode})`]))
}

module.exports = { init, attach, dir, recent: () => lines.slice(-120) }
