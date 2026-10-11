// Audio capture on Linux — the mechanism from re-traductor (src/callsubs/audio/routing.py, guard.py):
// only temporary pipewire-pulse devices (`pactl load-module`), no config files.
//
// mic — my voice for the other party:
//   null sink  holovoice_out ("HoloVoice-feed")       — the app plays the processed voice here
//   remap      holovoice_mic ("HoloVoice-Microphone") — its monitor as a microphone: select it in Discord/Telegram/Zoom
//   My real microphone stays the default device — that is what the app reads.
// sys — computer sound (videos, the other party):
//   null sink  holovoice_in ("HoloVoice-speaker") becomes the default output, app streams
//   are moved into it — the original no longer goes straight to the headphones; the app reads its monitor,
//   applies the effect and plays to the real output. Chromium does not see monitors (.monitor) as inputs,
//   so the monitor is exposed via remap-source holovoice_in_cap ("HoloVoice-system-sound").
//
// Every change is written to the state file BEFORE the next step; on exit everything is rolled back, on a crash —
// by the guard (a separate sh process), on the next launch — by restoreStale().
'use strict'
const { execFile, execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const OUT_SINK = 'holovoice_out'
const MIC = 'holovoice_mic'
const IN_SINK = 'holovoice_in'
const SINK_LABEL = 'HoloVoice-feed'
const MIC_LABEL = 'HoloVoice-Microphone'
const SPEAKER_LABEL = 'HoloVoice-speaker'
const IN_CAP = 'holovoice_in_cap'
const CAPTURE_LABEL = 'HoloVoice-system-sound' // Chromium does not show monitors — read via remap-source
const OURS = [OUT_SINK, IN_SINK]

/** Is `pid` our process or a child of it (renderers, audio service)? Walks /proc parent links. */
function descendsFrom(pid, root) {
  for (let p = pid, i = 0; p > 1 && i < 8; i++) {
    if (p === root) return true
    try { p = Number(fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ')[1]) } catch { return false }
  }
  return false
}

function pactl(...args) {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`pactl ${args.join(' ')}: ${(stderr || err.message).trim().slice(0, 200)}`))
      else resolve(stdout)
    })
  })
}

/** `pactl list short sinks` → {index: name} */
async function sinkNames() {
  const out = {}
  for (const line of (await pactl('list', 'short', 'sinks')).split('\n')) {
    const p = line.split('\t')
    if (p.length >= 2) out[p[0]] = p[1]
  }
  return out
}

/** `pactl list sink-inputs` (text: more reliable than JSON with Cyrillic in names) → [{id, sink, pid, owner}] */
async function sinkInputs() {
  const names = await sinkNames()
  const text = await pactl('list', 'sink-inputs')
  const out = []
  for (const block of text.split(/\n(?=Sink Input #)/)) {
    const m = block.match(/Sink Input #(\d+)/)
    if (!m) continue
    const sink = block.match(/^\s*Sink:\s*(\S+)/m)?.[1] ?? ''
    out.push({
      id: m[1],
      sink: names[sink] ?? sink,
      pid: Number(block.match(/application\.process\.id = "(\d+)"/)?.[1] ?? 0),
      owner: block.match(/^\s*Owner Module:\s*(\d+)/m)?.[1] ?? null,
    })
  }
  return out
}

/** Device description (what Chromium shows as the label) by sink name. */
async function sinkDescription(name) {
  const text = await pactl('list', 'sinks')
  for (const block of text.split(/\n(?=Sink #)/)) {
    if (new RegExp(`^\\s*Name:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(block)) {
      return block.match(/^\s*Description:\s*(.+)$/m)?.[1]?.trim() ?? name
    }
  }
  return name
}

class LinuxRouter {
  /** ownPids() — pids of the app's processes: their streams are not captured (otherwise a loop) */
  constructor(stateDir, ownPids) {
    this.statePath = path.join(stateDir, 'routing.json')
    this.ownPids = ownPids
    this.s = { mic: [], sys: [], realSink: '', defaultChanged: false, moved: {} }
    this.guard = null
  }

  save() {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
    const tmp = this.statePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.s), { mode: 0o600 })
    fs.renameSync(tmp, this.statePath)
    this.restartGuard()
  }

  async load(lane, ...args) {
    const out = await pactl('load-module', ...args)
    this.s[lane].push(Number(out.trim().split(/\s+/)[0]))
    this.save()
  }

  /** The previous run died without cleaning up (the guard didn't make it) — clean up now. Plus modules without a file — by name. */
  async restoreStale() {
    let st = null
    try { st = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) } catch { /* none */ }
    if (st) {
      if (st.defaultChanged && st.realSink) await pactl('set-default-sink', st.realSink).catch(() => {})
      for (const m of [...(st.sys || []), ...(st.mic || [])].reverse()) await pactl('unload-module', String(m)).catch(() => {})
      try { fs.unlinkSync(this.statePath) } catch { /* none */ }
    }
    const out = await pactl('list', 'short', 'modules').catch(() => '')
    for (const line of out.split('\n')) {
      const [id, , args = ''] = line.split('\t')
      if ([OUT_SINK, IN_SINK].some((n) => args.includes(`sink_name=${n}`)) ||
          [MIC, IN_CAP].some((n) => args.includes(`source_name=${n}`))) {
        await pactl('unload-module', id).catch(() => {})
      }
    }
  }

  // ------------------------------------------------------------ my voice

  /** Idempotent: the engine window may reload — then the already created microphone is used as is */
  async setupMic() {
    if (this.s.mic.length) {
      const out = await pactl('list', 'short', 'modules').catch(() => '')
      const alive = new Set(out.split('\n').map((l) => Number(l.split('\t')[0])))
      if (this.s.mic.every((m) => alive.has(m))) return { sinkLabel: SINK_LABEL, micLabel: MIC_LABEL }
      for (const m of this.s.mic) await pactl('unload-module', String(m)).catch(() => {})
      this.s.mic = []
      this.save()
    }
    await this.load('mic', 'module-null-sink', `sink_name=${OUT_SINK}`,
      `sink_properties=device.description='${SINK_LABEL}'`)
    await this.load('mic', 'module-remap-source', `master=${OUT_SINK}.monitor`, `source_name=${MIC}`,
      `source_properties=device.description='${MIC_LABEL}'`)
    return { sinkLabel: SINK_LABEL, micLabel: MIC_LABEL }
  }

  // ------------------------------------------------------------ computer sound

  isOwn(si) {
    const pids = this.ownPids()
    return pids.has(si.pid) || descendsFrom(si.pid, process.pid) || [...this.s.mic, ...this.s.sys].includes(Number(si.owner))
  }

  /** Our own playback must never sit inside the interception: it would play back into our own input and nothing
   *  would reach the headphones (seen after turning the computer-sound track off and on again). Move it back. */
  async rescueOwn() {
    if (!this.s.realSink) return
    for (const si of await sinkInputs().catch(() => [])) {
      if (si.sink === IN_SINK && this.isOwn(si)) await pactl('move-sink-input', si.id, this.s.realSink).catch(() => {})
    }
  }

  /** Returns descriptions of the real output (where to play the result) and the capture monitor (what to read). */
  async interceptSys() {
    const s = this.s
    if (!s.sys.length) {
      s.realSink = (await pactl('get-default-sink')).trim()
      if (!s.realSink || OURS.includes(s.realSink)) throw new Error('real audio output not found')
      this.knownSinks = null
      this.save()
      await this.load('sys', 'module-null-sink', `sink_name=${IN_SINK}`,
        `sink_properties=device.description='${SPEAKER_LABEL}'`)
      await this.load('sys', 'module-remap-source', `master=${IN_SINK}.monitor`, `source_name=${IN_CAP}`,
        `source_properties=device.description='${CAPTURE_LABEL}'`)
      await pactl('set-default-sink', IN_SINK)
      s.defaultChanged = true
      this.save()
    }
    await this.followStreams()
    return { realSinkLabel: await sinkDescription(s.realSink), monitorLabel: CAPTURE_LABEL }
  }

  /**
   * The real output can change while the capture is on: headphones/a BT speaker connect, the old device disappears,
   * or WirePlumber/the user picks another output (then the default stops being ours). Pick the output the user would
   * get without HoloVoice and keep the default on the capture. Returns the new output or null.
   */
  async checkRealSink() {
    const s = this.s
    if (!s.sys.length) return null
    const real = Object.values(await sinkNames()).filter((n) => !OURS.includes(n))
    const known = this.knownSinks ?? new Set(real)
    this.knownSinks = new Set(real)
    const def = (await pactl('get-default-sink')).trim()
    let next = null
    if (def && !OURS.includes(def)) {
      next = def // someone chose this output: follow it, and take the default back
      await pactl('set-default-sink', IN_SINK).catch(() => {})
    } else {
      const added = real.filter((n) => !known.has(n) && /^bluez_output|usb/i.test(n))
      if (added.length) next = added[added.length - 1]
      else if (!real.includes(s.realSink)) next = real.find((n) => /^bluez_output/.test(n)) ?? real.find((n) => /usb/i.test(n)) ?? real[0] ?? null
    }
    if (!next || next === s.realSink) return null
    s.realSink = next
    this.save()
    this.restartGuard() // the guard restores this output if we crash
    return { realSinkLabel: await sinkDescription(next) }
  }

  /** Move into the capture the streams playing to my real output bypassing it (started before capture or bound
   *  to the device). Streams to other devices (a second output, OBS virtual devices, etc.) are left alone. */
  async followStreams() {
    if (!this.s.sys.length) return 0
    await this.rescueOwn()
    let n = 0
    for (const si of await sinkInputs()) {
      if (si.sink !== this.s.realSink || this.isOwn(si)) continue
      try {
        await pactl('move-sink-input', si.id, IN_SINK)
        this.s.moved[si.id] = si.sink
        n++
      } catch { /* the stream may have just ended */ }
    }
    if (n) this.save()
    return n
  }

  async releaseSys() {
    const s = this.s
    if (!s.sys.length) return
    if (s.defaultChanged) await pactl('set-default-sink', s.realSink).catch(() => {})
    s.defaultChanged = false
    for (const si of await sinkInputs().catch(() => [])) {
      if (si.sink === IN_SINK && !this.isOwn(si)) {
        await pactl('move-sink-input', si.id, s.moved[si.id] || s.realSink).catch(() => {})
      }
    }
    for (const m of s.sys.slice().reverse()) await pactl('unload-module', String(m)).catch(() => {})
    s.sys = []
    s.moved = {}
    this.save()
  }

  // ------------------------------------------------------------ rollback

  /** Guard: waits while my process is alive; if it dies and the state file remains — restore the output and unload the modules.
   *  PipeWire itself moves streams of an unloaded null sink to the default output — so that goes first. */
  restartGuard() {
    if (this.guard) { try { process.kill(this.guard.pid) } catch { /* already gone */ } this.guard = null }
    const ids = [...this.s.sys, ...this.s.mic].reverse().join(' ')
    if (!ids) return
    const setDefault = this.s.defaultChanged && this.s.realSink ? `pactl set-default-sink "$3" 2>/dev/null; ` : ''
    const script = [
      'while [ -f "$1" ] && kill -0 "$2" 2>/dev/null; do sleep 1; done',
      `if [ -f "$1" ]; then ${setDefault}for m in ${ids}; do pactl unload-module "$m" 2>/dev/null; done; rm -f "$1"; fi`,
    ].join('\n')
    this.guard = spawn('/bin/sh', ['-c', script, 'holovoice-guard', this.statePath, String(process.pid), this.s.realSink],
      { detached: true, stdio: 'ignore' })
    this.guard.unref()
  }

  /** Synchronous — so it completes within the exit handler. */
  restoreSync() {
    const run = (...a) => { try { execFileSync('pactl', a, { timeout: 5000, stdio: 'ignore' }) } catch { /* already gone */ } }
    if (this.s.defaultChanged && this.s.realSink) run('set-default-sink', this.s.realSink)
    for (const m of [...this.s.sys, ...this.s.mic].reverse()) run('unload-module', String(m))
    this.s = { mic: [], sys: [], realSink: '', defaultChanged: false, moved: {} }
    try { fs.unlinkSync(this.statePath) } catch { /* none */ }
    if (this.guard) { try { process.kill(this.guard.pid) } catch { /* already gone */ } }
  }
}

module.exports = { LinuxRouter }
