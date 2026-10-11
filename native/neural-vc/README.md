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
Seed-VC at a pinned commit (`src/seed-vc`), downloads the checkpoints, and copies `voices/female.wav`,
`voices/male.wav` and `ATTRIBUTION.txt`. Anything that's already there is kept.
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

Useful options: `--block-ms 180`, `--steps 6`, `--prompt-sec 3` (how much of the reference is used),
`--gate-db -50`, `--margin-ms 0` (0 = measured), `--min-steps 3`, `--no-graphs`,
`--log file` (library output, for debugging).

## Voices

Any clean, single-speaker wav of 3 s or more works as a target. The first `--prompt-sec` seconds after the
leading silence are used. Name it `female*.wav` or `male*.wav` in the voices folder.
