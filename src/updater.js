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
  // in electron-updater 6.3 the result has no "available" flag: a cancellation token appears only if the version is newer
  if (!r || !r.cancellationToken) return tr('upd.latestV', { v: app.getVersion() })
  progress(tr('upd.dl', { v: r.updateInfo.version }))
  autoUpdater.on('download-progress', (p) => progress(tr('upd.dlp', { v: r.updateInfo.version, p: Math.round(p.percent) })))
  await autoUpdater.downloadUpdate()
  progress(tr('upd.installing'))
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

module.exports = { update }
