'use strict'
// Neural voices (optional, NVIDIA GPU): runs native/neural-vc/holovoice_vc.py (Seed-VC, GPL-3.0 — a separate
// process) from its own Python install in ~/.local/share/holovoice (Windows: %LOCALAPPDATA%\HoloVoice\neural).
// Mic PCM goes to its stdin, the converted voice comes back on stdout, status as JSON lines on stderr,
// control (voice switch) as JSON lines on fd 3. Closing stdin stops it.
const { app } = require('electron')
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HOME = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'HoloVoice', 'neural')
  : path.join(os.homedir(), '.local', 'share', 'holovoice')
const PYTHON = process.platform === 'win32'
  ? path.join(HOME, 'venvs', 'seedvc', 'Scripts', 'python.exe')
  : path.join(HOME, 'venvs', 'seedvc', 'bin', 'python')
const VOICES = path.join(HOME, 'voices')

function scriptPath() {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'neural-vc', 'holovoice_vc.py')
    : path.join(__dirname, '..', 'native', 'neural-vc', 'holovoice_vc.py')
  return fs.existsSync(p) ? p : null
}

// pip-installed CUDA torch breaks with a system-wide LD_LIBRARY_PATH (wrong nvJitLink)
function env() {
  const e = { ...process.env, PYTHONUNBUFFERED: '1' }
  delete e.LD_LIBRARY_PATH
  return e
}

/** female.wav, male.wav (+ alternatives like female2.wav) */
function voices() {
  try {
    return fs.readdirSync(VOICES).filter((f) => /\.wav$/i.test(f)).map((f) => ({ id: f.replace(/\.wav$/i, ''), path: path.join(VOICES, f) }))
  } catch { return [] }
}

let checked = null
/** Is the neural mode installed and is there a CUDA GPU? Cached: torch import takes seconds. */
function check(force = false) {
  if (checked && !force) return checked
  checked = new Promise((resolve) => {
    const script = scriptPath()
    if (!script || !fs.existsSync(PYTHON)) return resolve({ ok: false, error: 'not installed', voices: [] })
    execFile(PYTHON, [script, '--check'], { env: env(), cwd: HOME, timeout: 60000, windowsHide: true }, (err, stdout) => {
      let r = { ok: false, error: String(err?.message || 'no answer') }
      try { r = JSON.parse(stdout.trim().split('\n').pop()) } catch { /* keep the error */ }
      resolve({ ...r, voices: voices() })
    })
  })
  return checked
}

class NeuralVc {
  /** onAudio(Buffer of whole float32 samples), onStatus(object) — events from the sidecar, incl. { event: 'exit' } */
  constructor(onAudio, onStatus) {
    this.onAudio = onAudio
    this.onStatus = onStatus
    this.proc = null
    this.voice = ''
  }

  get running() { return !!this.proc }

  /** Start (model loading takes a while: status 'loading' → 'ready') or just switch the voice if running */
  start(voicePath, rate) {
    if (this.proc) { this.setVoice(voicePath); return { ok: true } }
    const script = scriptPath()
    if (!script || !fs.existsSync(PYTHON)) return { ok: false, error: 'not installed' }
    const p = spawn(PYTHON, [script, '--rate', String(Math.round(rate) || 48000), '--voice', voicePath],
      { env: env(), cwd: HOME, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true })
    this.proc = p
    this.voice = voicePath
    let rest = Buffer.alloc(0)
    p.stdout.on('data', (b) => {
      const buf = rest.length ? Buffer.concat([rest, b]) : b
      const whole = buf.length - (buf.length % 4)
      rest = buf.subarray(whole)
      if (whole) this.onAudio(buf.subarray(0, whole))
    })
    let line = ''
    p.stderr.setEncoding('utf8')
    p.stderr.on('data', (t) => {
      line += t
      for (let i; (i = line.indexOf('\n')) >= 0;) {
        const l = line.slice(0, i).trim()
        line = line.slice(i + 1)
        if (!l) continue
        try { this.onStatus(JSON.parse(l)) } catch { console.log('neural-vc:', l) } // library warnings
      }
    })
    p.stdin.on('error', () => {}) // EPIPE if it died
    p.on('error', (e) => this.onStatus({ event: 'error', message: String(e.message || e) }))
    p.on('exit', (code) => {
      if (this.proc === p) this.proc = null
      this.onStatus({ event: 'exit', code })
    })
    return { ok: true }
  }

  write(buf) {
    const p = this.proc
    if (p && p.stdin.writable) p.stdin.write(buf)
  }

  setVoice(voicePath) {
    if (!this.proc || voicePath === this.voice) return
    this.voice = voicePath
    try { this.proc.stdio[3].write(JSON.stringify({ voice: voicePath }) + '\n') } catch { /* gone */ }
  }

  stop() {
    const p = this.proc
    if (!p) return
    this.proc = null
    try { p.stdin.end() } catch {}
    setTimeout(() => { if (p.exitCode === null) p.kill() }, 4000)
  }
}

module.exports = { NeuralVc, check, voices }
