#!/bin/sh
# Установка HoloVoice из этой git-папки: ярлык в меню приложений. Кнопка «Обновить» в приложении
# делает git pull из master + пересборку, поэтому ставим именно из исходников, а не AppImage.
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$DIR"
[ -d node_modules ] || npm install --no-audit --no-fund
npm run build:renderer
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS"
cat > "$APPS/holovoice.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=HoloVoice
Comment=Эффекты на голос и звук компьютера в реальном времени
Exec="$DIR/node_modules/electron/dist/electron" "$DIR" --no-sandbox
Icon=$DIR/build/icon.png
Categories=Audio;AudioVideo;
StartupWMClass=HoloVoice
Terminal=false
DESKTOP
update-desktop-database "$APPS" 2>/dev/null || true
echo "HoloVoice установлен: $APPS/holovoice.desktop"
