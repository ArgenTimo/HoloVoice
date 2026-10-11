// AppImage: Ubuntu 23.10+ restricts unprivileged user namespaces (AppArmor), so Electron's sandbox aborts at start
// unless --no-sandbox is passed. AppRun runs the binary directly (only the .desktop entry has the flag), so a
// double-clicked AppImage showed nothing. The binary is renamed and a tiny wrapper adds the flag.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'linux') return
  const name = ctx.packager.executableName
  const bin = path.join(ctx.appOutDir, name)
  fs.renameSync(bin, `${bin}.bin`)
  fs.writeFileSync(bin, `#!/bin/sh\nexec "$(dirname "$(readlink -f "$0")")/${name}.bin" --no-sandbox "$@"\n`, { mode: 0o755 })
}
