# HoloVoice

Real-time voice and sound effects for Windows and Linux, part of the HOLO family.

Two independent lanes, each with its own effect:

- **My voice** → a virtual microphone for Discord, Telegram, Zoom, OBS and games;
- **Computer sound** → everything you hear (videos, the other person in a call) — only you hear the result.

Voices and atmospheres — male, female, child, demon growl, divine, old TTS robot, whisper, giant, chipmunk,
hologram, radio, cave… — plus your own saved effects, smooth fade-in/out between them, global hotkeys (with
double/triple press, hold-to-talk and mouse side buttons), a desktop widget and an on-screen overlay.
Everything runs locally; no audio leaves your computer.

**Русский:** [кратко по-русски](#по-русски) ниже.

## Download

- **Windows:** [HoloVoice-Setup.exe](https://github.com/ArgenTimo/HoloVoice/releases/latest/download/HoloVoice-Setup.exe)
- **Linux:** the `.AppImage` from the [latest release](https://github.com/ArgenTimo/HoloVoice/releases/latest),
  or install from source (below).

The app checks for updates by itself and shows **Update to X** when a new version is out.

### Windows

1. Run the installer. It isn't code-signed yet, so Windows SmartScreen may say *“Windows protected your PC”* —
   click **More info → Run anyway**. Browsers may say the file is *not commonly downloaded* — choose **Keep**.
2. HoloVoice opens a **setup guide**. To send your voice to other apps, Windows needs the free
   [VB-Audio Virtual Cable](https://vb-audio.com/Cable/): unpack it, right-click `VBCABLE_Setup_x64.exe` →
   **Run as administrator** → **Install Driver**, restart if asked. HoloVoice picks the cable up by itself.
3. In Discord / Telegram / Zoom / the game choose the microphone **CABLE Output**, and turn off the app's own
   noise suppression (Krisp) and echo cancellation — they fight the effects.

Antivirus note: hotkeys with mouse buttons, double press or hold use a low-level keyboard/mouse hook, and the
computer-sound lane uses a small helper (`holo-sysaudio.exe`) that turns other apps down while it captures them.
Both are expected; neither sends anything anywhere.

### Linux

**AppImage:** `chmod +x HoloVoice-*.AppImage` and run it. On Ubuntu 22.04+ install FUSE 2 first:
`sudo apt install libfuse2t64` (or `libfuse2` on 22.04).

**From source** (Node.js 20+): `git clone https://github.com/ArgenTimo/HoloVoice && cd HoloVoice && sh scripts/install-linux.sh`
— adds HoloVoice to the applications menu and a `holovoice` command. **Update** in the app then pulls and rebuilds.

Needs PipeWire (with `pipewire-pulse`) or PulseAudio and the `pactl` tool. In your call app choose the
microphone **HoloVoice-Microphone**.

## Using it

- Turn a lane on with its switch, pick an effect in the catalog (☆ marks favorites), tune it on the right.
  **Test on a recording** records 6 s of your voice and plays it through the effect while you move the knobs.
- **Hear myself** (in the My voice card) plays your processed voice in your headphones.
  HoloVoice never sends your voice to the speakers by itself — on a laptop that would howl.
- **Your voice: low / medium / high** — effects with a fixed shift (demon, giant, chipmunk…) adjust to it.
  The setup guide suggests it from your pitch.
- **Save as my effect** keeps the current settings under your own name and icon.
- ▭ compact mode, 🧩 desktop widget (starts with the system while pinned), tray menu with on/off and effects.
- The **HoloVoice** menu (top left) has the setup guide, hotkeys, overlay, updates, logs and diagnostics.

### Hotkeys

They work in any program and in games; each can be a key combination or a middle/side mouse button, pressed
once, twice, three times, or **held** (the effect is on while you hold it). Defaults:

| | Windows | Linux |
|---|---|---|
| My voice on/off | `Alt+Shift+V` | `Ctrl+Alt+V` |
| next / previous effect | `Alt+Shift+=` / `Alt+Shift+-` | `Ctrl+Alt+=` / `Ctrl+Alt+-` |
| clean, male, female, child, demon, ghost, robot, hologram, warm, smolder | `Alt+Shift+0…9` | `Ctrl+Alt+0…9` |
| Computer sound on/off | `Alt+Shift+B` | `Ctrl+Alt+B` |
| its effects / next / previous | `Ctrl+Shift+F1…F10` / `F12` / `F11` | same |

(On Windows `Ctrl+Alt` is AltGr, so it isn't used.) With two or more favorites, next/previous walk through them.

**Wayland** doesn't let apps catch global keys. Bind system shortcuts to commands instead:
`holovoice --toggle mic`, `holovoice --effect mic:demon`, `holovoice --next mic` (also `sys`).

### Neural voices (optional, NVIDIA GPU)

“Female (neural)” and “Male (neural)” use a voice-conversion model (Seed-VC) instead of pitch tricks: much more
natural, ~0.4 s delay. They appear only after installing the add-on: `sh native/neural-vc/install.sh` (Linux;
~10 GB with CUDA). Seed-VC is GPL-3.0 and runs as a separate process. Until it's ready the regular voices play.

## Troubleshooting

- **Discord doesn't hear me** — pick the right microphone there (**CABLE Output** / **HoloVoice-Microphone**);
  the My voice card says where your voice goes.
- **Microphone blocked** (Windows) — Settings → Privacy → Microphone → allow desktop apps (the hint has a link).
- **Other apps stayed quiet after a crash** (Windows, computer-sound lane) — start HoloVoice again: it restores
  their volume (and keeps doing so for 2 minutes as apps start). The uninstaller restores them too.
- **Logs:** HoloVoice menu → *Open the logs folder*, or *Copy diagnostics* and paste it into a bug report.
  Locations: `%APPDATA%\HoloVoice\logs` (Windows), `~/.config/HoloVoice/logs` (Linux).

## Privacy

Audio is processed only on your computer. The only network access is the update check against GitHub Releases
(and links you click). Crash dumps stay local.

## Uninstall

- **Windows:** Apps & features → HoloVoice. Settings remain in `%APPDATA%\HoloVoice` — delete it if you like.
- **Linux:** delete the AppImage or the source folder, `~/.local/share/applications/holovoice.desktop`,
  `~/.local/bin/holovoice`, `~/.config/autostart/holovoice.desktop` and `~/.config/HoloVoice`.
  The virtual devices exist only while HoloVoice runs.

## Development

```
npm ci
npm run build:renderer   # esbuild: src/renderer/*.ts → dist/
npm run typecheck
npx electron . --no-sandbox
```

- `src/main.js` — windows, tray, hotkeys (`hotkeys.js`), routing (`routing-linux.js`, `sysaudio-win.js`),
  updates (`updater.js`), logs (`log.js`), neural sidecar (`neural-vc.js`).
- `src/renderer/engine.ts` — the audio engine in a hidden window; `dsp/` — AudioWorklet DSP (phase vocoder,
  PSOLA, pitch tracking, growl, halo…), `rig.ts` — the Web Audio chain; `effects.ts` — parameters and presets.
- `src/renderer/panel.ts`, `widget.ts`, `osd.ts` — the UI; `src/locales/*.json` — 23 languages.
- `native/win-sysaudio` — the Windows computer-sound helper (C++), tested in CI on a runner with a virtual sound
  card, including the app end to end; `native/neural-vc` — the neural voice sidecar.
- Every push to `main` builds the Windows installer and the AppImage and publishes a release once both succeed.

## По-русски

HoloVoice — эффекты для голоса и звука компьютера в реальном времени (Windows, Linux).

- **Windows:** скачайте [HoloVoice-Setup.exe](https://github.com/ArgenTimo/HoloVoice/releases/latest/download/HoloVoice-Setup.exe).
  Если появится «Windows защитила ваш компьютер» — **Подробнее → Выполнить в любом случае**. Мастер настройки
  проведёт по шагам: поставьте бесплатный [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) (установщик —
  от имени администратора), затем в Discord выберите микрофон **CABLE Output** и отключите там шумоподавление.
- **Linux:** AppImage из [релизов](https://github.com/ArgenTimo/HoloVoice/releases/latest) (`chmod +x`, на Ubuntu
  нужен `libfuse2t64`) или `sh scripts/install-linux.sh` из исходников. В программе звонка — микрофон
  **HoloVoice-Microphone**.
- Голос сам никогда не уходит в колонки; чтобы послушать себя — «Слышать себя» в наушниках.
- Горячие клавиши, избранное, свои эффекты, виджет, оверлей, нейросетевые голоса (видеокарта NVIDIA) —
  описаны выше; интерфейс на 23 языках, выбирается флагом в заголовке.
- Проблемы: меню HoloVoice → «Скопировать диагностику» и пришлите текст.
