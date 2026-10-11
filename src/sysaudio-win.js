'use strict'
// Windows computer sound: runs holo-sysaudio.exe (native/win-sysaudio), which captures everything except
// HoloVoice itself and turns the other apps down while it runs. PCM comes on stdout and goes to the engine.
const { app } = require('electron')
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function exePath() {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'holo-sysaudio.exe')
    : path.join(__dirname, '..', 'native', 'win-sysaudio', 'holo-sysaudio.exe')
  return fs.existsSync(p) ? p : null
}

class WinSysAudio {
  /** onData(Buffer of whole stereo float32 frames), onEnd(error) — the helper stopped on its own */
  constructor(onData, onEnd) {
    this.onData = onData
    this.onEnd = onEnd
    this.proc = null
  }

  /** Undo what a killed helper left (other apps turned down) */
  static restore() {
    const exe = exePath()
    if (exe) execFile(exe, ['--restore'], { windowsHide: true }, () => {})
  }

  start(rate) {
    this.stop()
    const exe = exePath()
    if (!exe) return Promise.resolve({ ok: false, error: 'holo-sysaudio.exe is missing' })
    return new Promise((resolve) => {
      const p = spawn(exe, [String(process.pid), '--rate', String(Math.round(rate) || 48000)], { windowsHide: true })
      this.proc = p
      let settled = false
      let err = ''
      let rest = Buffer.alloc(0)
      const done = (r) => { if (!settled) { settled = true; resolve(r) } }
      const timer = setTimeout(() => { done({ ok: false, error: 'the capture helper did not start' }); this.stop() }, 8000)
      p.stdout.on('data', (b) => {
        const buf = rest.length ? Buffer.concat([rest, b]) : b
        const whole = buf.length - (buf.length % 8)
        rest = buf.subarray(whole)
        if (whole) this.onData(buf.subarray(0, whole))
      })
      p.stderr.setEncoding('utf8')
      p.stderr.on('data', (t) => {
        for (const line of t.split(/\r?\n/)) {
          if (line.startsWith('ready')) { clearTimeout(timer); done({ ok: true }) }
          if (line.startsWith('error')) err = line
        }
      })
      p.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: String(e.message || e) }) })
      p.on('exit', (code) => {
        clearTimeout(timer)
        const wasOurs = this.proc === p
        if (wasOurs) this.proc = null
        if (!settled) done({ ok: false, error: err || `the capture helper exited (${code})` })
        else if (wasOurs) this.onEnd(err || `the capture helper exited (${code})`)
      })
    })
  }

  /** Closing stdin makes the helper give the apps their volume back and exit */
  stop() {
    const p = this.proc
    if (!p) return
    this.proc = null
    try { p.stdin.end() } catch {}
    setTimeout(() => { if (p.exitCode === null) p.kill() }, 3000)
  }
}

module.exports = { WinSysAudio }
