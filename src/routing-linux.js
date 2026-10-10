// Перехват звука на Linux — механизм из re-traductor (src/callsubs/audio/routing.py, guard.py):
// только временные устройства pipewire-pulse (`pactl load-module`), никаких конфигов.
//
// mic — мой голос для собеседника:
//   null sink  holovoice_out ("HoloVoice-feed")       — сюда приложение играет обработанный голос
//   remap      holovoice_mic ("HoloVoice-Microphone") — его монитор как микрофон: выбрать в Discord/Telegram/Zoom
//   Мой настоящий микрофон остаётся устройством по умолчанию — его и читает приложение.
// sys — звук компьютера (ролики, собеседник):
//   null sink  holovoice_in ("HoloVoice-speaker") становится выходом по умолчанию, потоки приложений
//   переносятся в него — оригинал больше не идёт в наушники напрямую; приложение читает его монитор,
//   накладывает эффект и играет в настоящий выход. Chromium не видит мониторы (.monitor) как входы,
//   поэтому монитор пробрасывается remap-source holovoice_in_cap ("HoloVoice-system-sound").
//
// Что изменено, пишется в файл состояния ДО следующего шага; при выходе всё откатывается, при падении —
// сторож (отдельный sh-процесс), при следующем запуске — restoreStale().
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
const CAPTURE_LABEL = 'HoloVoice-system-sound' // Chromium не показывает мониторы — читаем через remap-source
const OURS = [OUT_SINK, IN_SINK]

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

/** `pactl list sink-inputs` (текст: с кириллицей в именах надёжнее JSON) → [{id, sink, pid, owner}] */
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

/** Описание устройства (то, что Chromium показывает как label) по имени sink. */
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
  /** ownPids() — pid'ы процессов приложения: их потоки не перехватываем (иначе петля) */
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

  /** Прошлый запуск умер, не убрав за собой (сторож не успел) — убрать сейчас. Плюс модули без файла — по имени. */
  async restoreStale() {
    let st = null
    try { st = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) } catch { /* нет */ }
    if (st) {
      if (st.defaultChanged && st.realSink) await pactl('set-default-sink', st.realSink).catch(() => {})
      for (const m of [...(st.sys || []), ...(st.mic || [])].reverse()) await pactl('unload-module', String(m)).catch(() => {})
      try { fs.unlinkSync(this.statePath) } catch { /* нет */ }
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

  // ------------------------------------------------------------ мой голос

  /** Идемпотентно: окно движка может перезагрузиться — тогда уже созданный микрофон используется как есть */
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

  // ------------------------------------------------------------ звук компьютера

  isOwn(si) {
    const pids = this.ownPids()
    return pids.has(si.pid) || [...this.s.mic, ...this.s.sys].includes(Number(si.owner))
  }

  /** Возвращает описания: настоящего выхода (куда играть результат) и монитора перехвата (что читать). */
  async interceptSys() {
    const s = this.s
    if (!s.sys.length) {
      s.realSink = (await pactl('get-default-sink')).trim()
      if (!s.realSink || OURS.includes(s.realSink)) throw new Error('не найден настоящий выход звука')
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

  /** Перенести в перехват потоки, играющие в мой настоящий выход мимо него (начатые до перехвата или привязанные
   *  к устройству). Потоки в другие устройства (второй выход, виртуальные устройства OBS и т. п.) не трогаем. */
  async followStreams() {
    if (!this.s.sys.length) return 0
    let n = 0
    for (const si of await sinkInputs()) {
      if (si.sink !== this.s.realSink || this.isOwn(si)) continue
      try {
        await pactl('move-sink-input', si.id, IN_SINK)
        this.s.moved[si.id] = si.sink
        n++
      } catch { /* поток мог только что закончиться */ }
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

  // ------------------------------------------------------------ откат

  /** Сторож: ждёт, пока мой процесс жив; если он умер, а файл состояния остался — вернуть выход и выгрузить модули.
   *  Потоки выгружаемого null sink PipeWire сам переносит на выход по умолчанию — поэтому сначала он. */
  restartGuard() {
    if (this.guard) { try { process.kill(this.guard.pid) } catch { /* уже */ } this.guard = null }
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

  /** Синхронно — чтобы успеть в обработчике выхода. */
  restoreSync() {
    const run = (...a) => { try { execFileSync('pactl', a, { timeout: 5000, stdio: 'ignore' }) } catch { /* уже */ } }
    if (this.s.defaultChanged && this.s.realSink) run('set-default-sink', this.s.realSink)
    for (const m of [...this.s.sys, ...this.s.mic].reverse()) run('unload-module', String(m))
    this.s = { mic: [], sys: [], realSink: '', defaultChanged: false, moved: {} }
    try { fs.unlinkSync(this.statePath) } catch { /* нет */ }
    if (this.guard) { try { process.kill(this.guard.pid) } catch { /* уже */ } }
  }
}

module.exports = { LinuxRouter }
