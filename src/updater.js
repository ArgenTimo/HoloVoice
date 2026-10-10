'use strict'
// Кнопка «Обновить»:
//   из git-папки (моя установка на Linux) — git pull из основной ветки (master или main), пересборка, перезапуск;
//   установленная сборка (exe / AppImage) — новая версия из GitHub Releases (их собирает CI на каждый пуш в main/master,
//   .github/workflows/release.yml), скачать и поставить через electron-updater.
const { app } = require('electron')
const { execFile } = require('node:child_process')
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
async function update(progress) {
  return isGitCheckout() ? updateFromGit(progress) : updateFromReleases(progress)
}

async function updateFromGit(progress) {
  const cwd = repoDir()
  const remote = await run('git', ['remote'], cwd).catch(() => '')
  if (!remote) return 'Git-репозиторий ещё не подключён (нет remote)'
  progress('Получаю изменения…')
  await run('git', ['fetch', 'origin'], cwd, 60000)
  const branch = (await run('git', ['rev-parse', '--verify', '--quiet', 'origin/master'], cwd).then(() => 'master', () => 'main'))
  const before = await run('git', ['rev-parse', 'HEAD'], cwd)
  const target = await run('git', ['rev-parse', `origin/${branch}`], cwd)
  if (before === target) return 'Уже последняя версия'
  const dirty = await run('git', ['status', '--porcelain', '--untracked-files=no'], cwd)
  if (dirty) return 'В папке есть незакоммиченные изменения — обновление пропущено'
  progress(`Обновляю из ${branch}…`)
  await run('git', ['merge', '--ff-only', `origin/${branch}`], cwd, 60000)
  const changed = await run('git', ['diff', '--name-only', before, 'HEAD'], cwd)
  if (/^package(-lock)?\.json$/m.test(changed)) {
    progress('Ставлю зависимости…')
    await run('npm', ['install', '--no-audit', '--no-fund'], cwd, 600000)
  }
  progress('Собираю…')
  await run('npm', ['run', 'build:renderer'], cwd)
  progress('Перезапуск…')
  app.relaunch()
  app.quit()
  return 'Обновлено'
}

async function updateFromReleases(progress) {
  if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
    return 'Эта сборка без автообновления — поставьте версию из GitHub Releases'
  }
  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = false
  progress('Проверяю обновления…')
  const r = await autoUpdater.checkForUpdates()
  if (!r || !r.isUpdateAvailable) return `Уже последняя версия (${app.getVersion()})`
  progress(`Скачиваю ${r.updateInfo.version}…`)
  autoUpdater.on('download-progress', (p) => progress(`Скачиваю ${r.updateInfo.version}… ${Math.round(p.percent)}%`))
  await autoUpdater.downloadUpdate()
  progress('Устанавливаю…')
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
  return 'Устанавливаю обновление'
}

module.exports = { update }
