'use strict'
// Кнопка «Обновить»:
//   из git-папки (моя установка на Linux) — git pull из основной ветки (master или main), пересборка, перезапуск;
//   установленная сборка (exe / AppImage) — новая версия из GitHub Releases (их собирает CI на каждый пуш в main/master,
//   .github/workflows/release.yml), скачать и поставить через electron-updater.
const { app } = require('electron')
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function run(cmd, args, cwd, timeout = 300000) {
  return new Promise((resolve, reject) => {
    // npm на Windows — npm.cmd; shell не нужен: аргументы фиксированные
    const exe = process.platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd
    execFile(exe, args, { cwd, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')))
      else resolve(stdout.trim())
    })
  })
}

const repoDir = () => app.getAppPath()
const isGitCheckout = () => !app.isPackaged && fs.existsSync(path.join(repoDir(), '.git'))

/** progress(text) — для строки состояния в панели. Возвращает итоговый текст; при успехе перезапускает приложение. */
async function update(progress, tr) {
  return isGitCheckout() ? updateFromGit(progress, tr) : updateFromReleases(progress, tr)
}

async function updateFromGit(progress, tr) {
  const cwd = repoDir()
  const remote = await run('git', ['remote'], cwd).catch(() => '')
  if (!remote) return tr('upd.noRemote')
  progress(tr('upd.fetching'))
  await run('git', ['fetch', 'origin'], cwd, 60000)
  const branch = (await run('git', ['rev-parse', '--verify', '--quiet', 'origin/master'], cwd).then(() => 'master', () => 'main'))
  const before = await run('git', ['rev-parse', 'HEAD'], cwd)
  const target = await run('git', ['rev-parse', `origin/${branch}`], cwd)
  if (before === target) return tr('upd.latest')
  const dirty = await run('git', ['status', '--porcelain', '--untracked-files=no'], cwd)
  if (dirty) return tr('upd.dirty')
  progress(tr('upd.from', { b: branch }))
  await run('git', ['merge', '--ff-only', `origin/${branch}`], cwd, 60000)
  const changed = await run('git', ['diff', '--name-only', before, 'HEAD'], cwd)
  if (/^package(-lock)?\.json$/m.test(changed)) {
    progress(tr('upd.deps'))
    await run('npm', ['install', '--no-audit', '--no-fund'], cwd, 600000)
  }
  progress(tr('upd.build'))
  await run('npm', ['run', 'build:renderer'], cwd)
  progress(tr('upd.restart'))
  app.relaunch()
  app.quit()
  return tr('upd.done')
}

async function updateFromReleases(progress, tr) {
  if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
    return tr('upd.noAuto')
  }
  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = false
  progress(tr('upd.check'))
  const r = await autoUpdater.checkForUpdates()
  // в electron-updater 6.3 у результата нет флага «доступно»: токен отмены появляется, только если версия новее
  if (!r || !r.cancellationToken) return tr('upd.latestV', { v: app.getVersion() })
  progress(tr('upd.dl', { v: r.updateInfo.version }))
  autoUpdater.on('download-progress', (p) => progress(tr('upd.dlp', { v: r.updateInfo.version, p: Math.round(p.percent) })))
  await autoUpdater.downloadUpdate()
  progress(tr('upd.installing'))
  setImmediate(() => {
    // AppImage: апдейтер запускает новый файл без аргументов, а на Ubuntu 24+ (AppArmor) Electron без --no-sandbox
    // не стартует — поэтому перезапускаем сами, с флагом. Установка происходит прямо внутри quitAndInstall,
    // так что к этому моменту новый файл уже на месте (имя могло смениться — ловим событие).
    let appImage = process.env.APPIMAGE
    if (appImage) autoUpdater.once('appimage-filename-updated', (p) => { appImage = p })
    autoUpdater.quitAndInstall(true, true)
    // app.relaunch не годится: его помощник запускается из образа старой AppImage, который размонтируется при выходе.
    // Системный sh дождётся выхода приложения и запустит новый файл.
    if (appImage) {
      spawn('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done; exec "$2" --no-sandbox', 'holovoice-relaunch',
        String(process.pid), appImage], { detached: true, stdio: 'ignore' }).unref()
    }
  })
  return tr('upd.installingUpd')
}

module.exports = { update }
