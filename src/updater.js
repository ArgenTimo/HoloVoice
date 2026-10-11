'use strict'
// The "Update" button:
//   from a git folder (my Linux install) — git pull from the main branch (master or main), rebuild, restart;
//   an installed build (exe / AppImage) — a new version from GitHub Releases (built by CI on every push to main/master,
//   .github/workflows/release.yml), downloaded and installed via electron-updater.
const { app } = require('electron')
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function run(cmd, args, cwd, timeout = 300000) {
  return new Promise((resolve, reject) => {
    // npm on Windows is npm.cmd; no shell needed: the arguments are fixed
    const exe = process.platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd
    execFile(exe, args, { cwd, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')))
      else resolve(stdout.trim())
    })
  })
}

const repoDir = () => app.getAppPath()
const isGitCheckout = () => !app.isPackaged && fs.existsSync(path.join(repoDir(), '.git'))

/** progress(text) — for the status line in the panel. Returns the final text; on success restarts the app. */
async function update(progress, tr, beforeInstall) {
  try {
    return await (isGitCheckout() ? updateFromGit(progress, tr) : updateFromReleases(progress, tr, beforeInstall))
  } catch (e) {
    console.error('update:', e)
    return explain(e, tr)
  }
}

async function updateFromGit(progress, tr) {
  const cwd = repoDir()
  const remote = await run('git', ['remote'], cwd).catch(() => '')
  if (!remote) return tr('upd.noRemote')
  // npm is needed for the rebuild — check BEFORE moving the checkout (a .desktop launch may lack nvm's PATH)
  const npmOk = await run('npm', ['--version'], cwd, 20000).then(() => true, () => false)
  if (!npmOk) return tr('upd.noNpm')
  progress(tr('upd.fetching'))
  await run('git', ['fetch', 'origin'], cwd, 60000)
  const branch = (await run('git', ['rev-parse', '--verify', '--quiet', 'origin/master'], cwd).then(() => 'master', () => 'main'))
  const before = await run('git', ['rev-parse', 'HEAD'], cwd)
  const target = await run('git', ['rev-parse', `origin/${branch}`], cwd)
  if (before === target) return tr('upd.latest')
  // a lockfile rewritten by a past `npm install` is not a real local change
  const dirty = (await run('git', ['status', '--porcelain', '--untracked-files=no'], cwd)).split('\n')
    .filter((l) => l.trim() && !/package-lock\.json$/.test(l))
  if (dirty.length) return tr('upd.dirty')
  await run('git', ['checkout', '--', 'package-lock.json'], cwd).catch(() => {})
  progress(tr('upd.from', { b: branch }))
  await run('git', ['merge', '--ff-only', `origin/${branch}`], cwd, 60000)
  try {
    const changed = await run('git', ['diff', '--name-only', before, 'HEAD'], cwd)
    if (/^package(-lock)?\.json$/m.test(changed)) {
      progress(tr('upd.deps'))
      await run('npm', ['ci', '--no-audit', '--no-fund'], cwd, 600000)
    }
    progress(tr('upd.build'))
    await run('npm', ['run', 'build:renderer'], cwd)
  } catch (e) {
    // never leave new sources with an old build: go back to where we were
    console.error('update failed, rolling back:', e)
    await run('git', ['reset', '--hard', before], cwd).catch(() => {})
    throw e
  }
  progress(tr('upd.restart'))
  app.relaunch()
  app.quit()
  return tr('upd.done')
}

const canAutoUpdate = () => app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))

function updater() {
  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = false
  autoUpdater.logger = { info: (m) => console.log('updater:', m), warn: (m) => console.warn('updater:', m), error: (m) => console.error('updater:', m) }
  return autoUpdater
}

/** Is a newer release out? null — no (or can't tell). Used silently at startup. */
async function check() {
  if (isGitCheckout() || !canAutoUpdate()) return null
  const r = await updater().checkForUpdates()
  // in electron-updater 6.3 the result has no "available" flag: a cancellation token appears only if the version is newer
  return r && r.cancellationToken ? r.updateInfo.version : null
}

/** Network/server problems in words a user understands */
function explain(err, tr) {
  const m = String(err?.message || err)
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|net::/i.test(m)) return tr('upd.offline')
  if (/404|latest(-linux)?\.yml/i.test(m)) return tr('upd.notReady')
  if (/403|rate limit/i.test(m)) return tr('upd.limit')
  return tr('upd.fail', { err: m.split('\n')[0].slice(0, 160) })
}

async function updateFromReleases(progress, tr, beforeInstall) {
  if (!canAutoUpdate()) return tr('upd.noAuto')
  const autoUpdater = updater()
  progress(tr('upd.check'))
  const r = await autoUpdater.checkForUpdates()
  if (!r || !r.cancellationToken) return tr('upd.latestV', { v: app.getVersion() })
  progress(tr('upd.dl', { v: r.updateInfo.version }))
  const onProgress = (p) => progress(tr('upd.dlp', { v: r.updateInfo.version, p: Math.round(p.percent) }))
  autoUpdater.on('download-progress', onProgress)
  try { await autoUpdater.downloadUpdate() } finally { autoUpdater.removeListener('download-progress', onProgress) }
  progress(tr('upd.installing'))
  // helpers (Windows computer-sound exe, neural sidecar) must be gone, or the installer can't replace them
  await beforeInstall?.()
  setImmediate(() => {
    // AppImage: the updater launches the new file without arguments, but on Ubuntu 24+ (AppArmor) Electron without --no-sandbox
    // won't start — so we restart it ourselves, with the flag. Installation happens right inside quitAndInstall,
    // so by this point the new file is already in place (its name may have changed — we catch the event).
    let appImage = process.env.APPIMAGE
    if (appImage) autoUpdater.once('appimage-filename-updated', (p) => { appImage = p })
    autoUpdater.quitAndInstall(true, true)
    // app.relaunch won't do: its helper runs from the old AppImage's image, which is unmounted on exit.
    // The system sh waits for the app to exit and launches the new file.
    if (appImage) {
      spawn('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done; exec "$2" --no-sandbox', 'holovoice-relaunch',
        String(process.pid), appImage], { detached: true, stdio: 'ignore' }).unref()
    }
  })
  return tr('upd.installingUpd')
}

module.exports = { update, check }
