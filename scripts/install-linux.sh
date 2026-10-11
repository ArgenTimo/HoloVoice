#!/bin/sh
# Install HoloVoice from this git folder: a shortcut in the applications menu. The "Update" button in the app
# does git pull from master + rebuild, so we install from source rather than the AppImage.
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$DIR"
command -v npm >/dev/null || { echo "npm is required (Node.js 20+)"; exit 1; }
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run build:renderer
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS"
cat > "$APPS/holovoice.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=HoloVoice
Comment=Real-time effects for your voice and computer sound
Exec="$DIR/node_modules/electron/dist/electron" "$DIR" --no-sandbox
Icon=$DIR/build/icon.png
Categories=Audio;AudioVideo;
StartupWMClass=HoloVoice
Terminal=false
DESKTOP
update-desktop-database "$APPS" 2>/dev/null || true
# `holovoice` command: starts the app, or sends an action to the running one (holovoice --toggle mic, --effect mic:demon)
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
cat > "$BIN/holovoice" <<LAUNCHER
#!/bin/sh
exec "$DIR/node_modules/electron/dist/electron" "$DIR" --no-sandbox "\$@"
LAUNCHER
chmod +x "$BIN/holovoice"
echo "HoloVoice installed: $APPS/holovoice.desktop and the command $BIN/holovoice"
