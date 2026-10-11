# Neural voices (optional, NVIDIA GPU)

`holovoice_vc.py` is a small sidecar program that turns the microphone into a different real voice
("female" / "male") with [Seed-VC](https://github.com/Plachtaa/seed-vc). It uses Seed-VC's real-time model
`seed-uvit-tat-xlsr-tiny` (25 M parameters, 22.05 kHz, XLS-R content encoder, HiFT vocoder) and the
streaming scheme of its `real-time-gui.py`: every 180 ms block, the model converts a sliding window
(2.5 s of context, a 40 ms crossfade and 20 ms of lookahead), and SOLA splices the result onto the previous
block. On top of that:

- fp16 autocast, and **CUDA graphs** for XLS-R, the DiT and the vocoder. One block launches ~4000 small
  kernels, so on a busy CPU the launches were the bottleneck. With graphs one block takes ~40–80 ms on an
  RTX 3070 Laptop (6 steps), versus 110–170 ms without them.
- An energy gate (default −50 dBFS per 20 ms, held for 400 ms). The model doesn't run in silence and the
  output is exact zeros there.
- **Output paced by the input.** Each input sample read releases one output sample a fixed `delay` later
  (`block + inference margin`, which is measured at warm-up). The app gets a steady 10 ms stream that
  can't drift from its own clock. If a block is late, the delay grows by the lateness, up to
  `--max-extra-ms` (default 100 ms; `stats.latency_ms` shows the current value). Past that limit, the
  part of a late block that's past due is replaced with silence, so the latency stays bounded. Late blocks count as `overruns`. When they keep happening (for
  example, a game is using the GPU), the number of diffusion steps goes down, but never below `--min-steps`.
  After about 20 s of speech without overruns, it goes back up one step at a time, as long as the slowest
  recent block would still fit the budget.
- **The same loudness for every voice.** The reference is brought to −20 dBFS before it becomes the
  prompt (the output's level follows the prompt's), and a slow speech-level AGC with a soft limiter keeps
  the output at about −20 dBFS (`--target-db`). Measured over 6 voices × 2 speakers: −20.1 dB ± 0.4 dB,
  versus −14 dB ± 1.8 dB without it.
- Torch is capped to 2 CPU threads. Library output goes to /dev/null so it can't corrupt the pipes.

The app (`src/neural-vc.js`) runs it from its own install in `~/.local/share/holovoice`
(Windows: `%LOCALAPPDATA%\HoloVoice\neural`).

## License

Seed-VC is **GPL-3.0**, and so is `holovoice_vc.py`, because it imports Seed-VC. HoloVoice doesn't link to
it. It only starts it as a separate process (installed separately, outside the app) and exchanges raw
audio and JSON lines with it over pipes. Seed-VC and its checkpoints aren't bundled with the app.
The checkpoints come from Hugging Face under their own licenses:
Plachta/Seed-VC, funasr/campplus, FunAudioLLM/CosyVoice-300M (HiFT) and facebook/wav2vec2-xls-r-300m.

The target voices in `voices/` are recordings from public datasets. `voices/ATTRIBUTION.txt` lists the
speaker, source and license of each one (CC-BY 4.0 requires attribution).

## Install (Linux)

```sh
native/neural-vc/install.sh          # ~6 GB in ~/.local/share/holovoice; re-run to complete/repair
native/neural-vc/install.sh --check  # {"ok":true,"cuda":true,"gpu":"...",...}
```

The script uses `uv` to create a Python 3.10 venv (`venvs/seedvc`) with PyTorch 2.4.0+cu121. It clones
Seed-VC at a pinned commit (`src/seed-vc`), downloads the checkpoints, and copies the voices from `voices/`
(`female*.wav`, `male*.wav`). Voice files that are already there are kept; `voices.json` and
`ATTRIBUTION.txt` are always updated.
**Run the venv's Python with `LD_LIBRARY_PATH` unset.** A system CUDA on that path breaks pip's CUDA
libraries. Both the app and the script unset it.

## Protocol

```
python holovoice_vc.py --rate 48000 --voice ~/.local/share/holovoice/voices/female.wav
python holovoice_vc.py --check
```

| stream | content |
|---|---|
| stdin | raw mono float32 LE PCM at `--rate`, any chunk size (the app sends 10 ms) |
| stdout | raw mono float32 LE PCM at `--rate`, the converted voice. It's paced by the input: one sample out per sample in, `latency_ms` later. There's silence while gated, while starting up, and where the model ran late |
| stderr | JSON lines: `{"event":"loading"}`, `{"event":"ready","latency_ms":N,"device":"<GPU>",...}`, `{"event":"stats","block_ms":..,"p95_ms":..,"overruns":n,...}` about every 2 s, `{"event":"voice","switch_ms":..}`, `{"event":"steps",...}`, `{"event":"warning","message":..}` (not fatal), `{"event":"error","message":..}` (fatal, then exit 1) |
| fd 3 | JSON lines: `{"voice":"<path>"}` switches the target without a restart (the new voice is prepared while the old one keeps playing, then swapped between blocks), `{"steps":N}`, `{"gate_db":-50}` |

It exits with code 0 when stdin closes. `latency_ms` covers the sidecar only: block + inference margin +
SOLA/lookahead. The app's playback buffer comes on top of that.

Useful options: `--block-ms 180`, `--steps 6`, `--prompt-sec 6` (how much of the reference is used),
`--target-db -20` (output level, 0 = AGC off), `--prompt-db -20` (reference level, 0 = as recorded),
`--gate-db -50`, `--margin-ms 0` (0 = measured), `--min-steps 3`, `--no-graphs`,
`--log file` (library output, for debugging).

## Voices

Three timbres per gender ship in `voices/`; `voices/voices.json` gives each an id (the file name), its
gender and English/Russian labels and descriptions for the app:

| file | label | output pitch (median) | source |
|---|---|---|---|
| `female.wav` (default) | Calm / Спокойный | ~205 Hz | Hi-Fi TTS 92 |
| `female2.wav` | Warm / Тёплый | ~175 Hz | LibriTTS-R 3570 |
| `female3.wav` | Bright / Звонкий | ~215 Hz | LibriTTS-R 1284 |
| `male.wav` (default) | Baritone / Баритон | ~105 Hz | LibriTTS-R 1089 |
| `male2.wav` | Deep / Низкий | ~80 Hz | VCTK p326 |
| `male3.wav` | Young / Молодой | ~125 Hz | LibriTTS-R 7127 |

Any clean, single-speaker wav of a few seconds works as a target. The first `--prompt-sec` seconds after
the leading silence are used; a shorter reference is repeated to that length, so every voice gives the
prompt the same shape and a switch never needs new CUDA graphs. Name it `female*.wav` or `male*.wav` in
the voices folder.

## Defaults and what they cost (RTX 3070 Laptop)

Measured through the real streaming path (paced 10 ms writes, fd 3 voice switches), on 6 voices × the
Russian male and female test recordings. UTMOS is low in absolute terms because the speech is Russian;
compare rows, not to the usual English scale. Differences under about 0.1 are within run-to-run noise.

| block / steps / prompt | ms per block (median, p95) | sidecar latency | UTMOS | similarity to target |
|---|---|---|---|---|
| 180 ms / 6 / 3 s (old default, no level control) | ~50, ~85 | 350 ms | 2.36 | 0.41 |
| 180 ms / 6 / 3 s | ~55, ~90 | 350 ms | 2.45 | 0.41 |
| **180 ms / 6 / 6 s (default)** | ~65, ~100 | 370–410 ms | 2.43–2.55 | 0.44 |
| 180 ms / 7 / 3 s | ~67, ~100 | 360–390 ms | 2.46 | 0.40 |
| 180 ms / 8 / 3 s | ~64, ~95 | 370–420 ms | 2.42 | 0.42 |
| 180 ms / 8 / 6 s | ~90, ~130 | 390 ms | 2.51 | 0.42 |
| 180 ms / 6 / 10 s | ~95, ~150 | 400–440 ms | 2.44 | 0.44 |
| 120 ms / 6 / 3 s | ~51, ~95 | 290–340 ms | 2.31 | 0.41 |
| 120 ms / 8 / 3 s | ~58, ~97 | 340 ms | 2.43 | 0.41 |

More diffusion steps (7, 8) didn't measurably improve quality and cost more time. A 6 s prompt raises the
similarity to the target voice at little cost, and it's the default. 120 ms blocks are about 60 ms faster
but need 8 steps to keep the quality, which leaves little headroom on a busy GPU (`--block-ms 120 --steps 8`
for low latency). The latency depends on the inference time measured at warm-up, so it's higher while
other programs load the CPU or GPU.
