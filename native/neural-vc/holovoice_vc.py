#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""
HoloVoice neural voice sidecar: streaming Seed-VC (v1 "seed-uvit-tat-xlsr-tiny", its real-time model).

GPL-3.0, because it imports and runs Seed-VC (GPL-3.0, https://github.com/Plachtaa/seed-vc).
HoloVoice starts it as a separate process and talks to it only through pipes.

Usage:
  python holovoice_vc.py --rate 48000 --voice ref.wav [--block-ms 180] [--steps 6]
  python holovoice_vc.py --check

Streams:
  stdin   raw mono float32 LE PCM at --rate, chunks of any size (partial floats are fine)
  stdout  raw mono float32 LE PCM at --rate: the converted voice. It is paced by the input: every
          sample read in releases one sample out, `latency` later (silence while gated, while
          starting up, or where the model ran late), so the stream never runs ahead or drifts.
          Late blocks may raise the latency by up to --max-extra-ms (reported in stats.latency_ms).
  stderr  JSON lines: loading / ready / stats / voice / warning / error
  fd 3    optional JSON control lines: {"voice": path} {"steps": n} {"gate_db": x}
The process exits when stdin closes.

How it works (same windowing as Seed-VC's real-time-gui.py): every --block-ms of input, the model
converts a window of [2.5 s context | crossfade | block | 20 ms lookahead], and SOLA splices the
result onto the previous block. An energy gate skips the model in silence. The reference is normalized to
--prompt-db and the output is held at --target-db (slow AGC + soft limiter), so every voice is equally loud.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import threading
import time
from collections import deque

# ---------------------------------------------------------------------------
# Paths. HOLOVOICE_HOME or --home override the default.
# ---------------------------------------------------------------------------


def default_home() -> str:
    if os.environ.get("HOLOVOICE_HOME"):
        return os.environ["HOLOVOICE_HOME"]
    if sys.platform == "win32":
        return os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "HoloVoice", "neural")
    return os.path.join(os.path.expanduser("~"), ".local", "share", "holovoice")


DIT_REPO, DIT_FILE, DIT_CFG = "Plachta/Seed-VC", "DiT_uvit_tat_xlsr_ema.pth", "config_dit_mel_seed_uvit_xlsr_tiny.yml"
# Every model is pinned to a reviewed commit and read from the local cache only (install.sh downloads them):
# a changed upstream repository can never put new code or weights into a running sidecar.
REVISIONS = {
    "Plachta/Seed-VC": "257283f9f41585055e8f858fba4fd044e5caed6e",
    "funasr/campplus": "e4b6ede7ce16997aff4ae69fbca1f0175e2afede",
    "FunAudioLLM/CosyVoice-300M": "24c40509c3c5ea6fe06b5f8790ff99e3714a6bee",
    "facebook/wav2vec2-xls-r-300m": "1a640f32ac3e39899438a2931f9924c02f080a54",
}
CAMPPLUS = ("funasr/campplus", "campplus_cn_common.bin")
HIFT = ("FunAudioLLM/CosyVoice-300M", "hift.pt")
XLSR = "facebook/wav2vec2-xls-r-300m"

_err_fd = 2  # becomes a dup of the real stderr once library output is silenced
_err_lock = threading.Lock()


def emit(obj: dict) -> None:
    """One JSON line to the real stderr."""
    line = (json.dumps(obj, ensure_ascii=False) + "\n").encode()
    with _err_lock:
        try:
            os.write(_err_fd, line)
        except OSError:
            pass


def silence_libraries(log_path: str | None) -> int:
    """Point fd 1 and fd 2 at /dev/null (or a log file) so print() and warnings from torch, transformers
    and seed-vc can't corrupt the PCM or JSON streams. Returns the fd that carries the PCM."""
    global _err_fd
    out_fd = os.dup(1)
    _err_fd = os.dup(2)
    sink = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644) if log_path else os.open(os.devnull, os.O_WRONLY)
    os.dup2(sink, 1)
    os.dup2(sink, 2)
    os.close(sink)
    import warnings
    warnings.simplefilter("ignore")
    return out_fd


def cap_threads(n: int) -> None:
    # before torch/numpy load their thread pools
    for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ[k] = str(n)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def hf_env(home: str) -> None:
    os.environ.setdefault("HF_HOME", os.path.join(home, "models", "hf"))
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")


# ---------------------------------------------------------------------------
# --check: answers in a few seconds (imports torch), loads no model
# ---------------------------------------------------------------------------


def run_check(home: str) -> int:
    res = {"ok": False, "cuda": False, "gpu": "", "error": ""}
    try:
        seed_dir = os.path.join(home, "src", "seed-vc")
        ck = os.path.join(seed_dir, "checkpoints")
        need = [os.path.join(seed_dir, "modules"),
                os.path.join(ck, "models--Plachta--Seed-VC"),
                os.path.join(ck, "models--funasr--campplus"),
                os.path.join(ck, "models--FunAudioLLM--CosyVoice-300M"),
                os.path.join(home, "models", "hf", "hub", "models--" + XLSR.replace("/", "--"))]
        missing = [p for p in need if not os.path.isdir(p)]
        cap_threads(1)
        import torch
        res["cuda"] = bool(torch.cuda.is_available())
        if res["cuda"]:
            res["gpu"] = torch.cuda.get_device_name(0)
            res["vram_mb"] = int(torch.cuda.get_device_properties(0).total_memory // (1 << 20))
        if missing:
            res["error"] = "not installed: " + ", ".join(missing)
        elif not res["cuda"]:
            res["error"] = "no CUDA GPU"
        else:
            res["ok"] = True
    except Exception as e:  # noqa: BLE001
        res["error"] = f"{type(e).__name__}: {e}"
    sys.stdout.write(json.dumps(res) + "\n")
    sys.stdout.flush()
    return 0


# ---------------------------------------------------------------------------
# CUDA graphs: one streaming block launches ~4000 small kernels; on a busy CPU the launches, not the
# GPU, set the pace. A graph replays them all with one call. Shapes are fixed while streaming
# (window, prompt length), so a graph is captured once per input shape and replayed.
# ---------------------------------------------------------------------------


class Graphed:
    def __init__(self, fn, name: str, autocast: bool = False):
        self.fn, self.name, self.autocast = fn, name, autocast
        self.graphs: dict = {}
        self.enabled = True

    def __call__(self, *args):
        import torch
        if not self.enabled:
            return self.fn(*args)
        key = tuple((tuple(a.shape), a.dtype) for a in args)
        g = self.graphs.get(key)
        if g is None:
            g = self.graphs[key] = self._capture(args)
        if g is False:
            return self.fn(*args)
        static_in, static_out, graph = g
        for s, a in zip(static_in, args):
            s.copy_(a)
        graph.replay()
        return static_out.clone()

    def _capture(self, args):
        import torch
        try:
            static_in = [a.detach().clone() for a in args]
            ac = torch.autocast("cuda", dtype=torch.float16, enabled=self.autocast, cache_enabled=False)
            s = torch.cuda.Stream()
            s.wait_stream(torch.cuda.current_stream())
            with torch.cuda.stream(s), ac:
                for _ in range(2):
                    self.fn(*static_in)
            torch.cuda.current_stream().wait_stream(s)
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph, capture_error_mode="thread_local"), ac:
                static_out = self.fn(*static_in)
            torch.cuda.synchronize()
            return static_in, static_out, graph
        except Exception as e:  # noqa: BLE001  — runs without the graph, just slower
            emit({"event": "warning", "message": f"cuda graph ({self.name}) off: {type(e).__name__}: {e}"})
            torch.cuda.synchronize()
            return False


def patch_for_graphs(seed_dir: str, device) -> None:
    """Make seed-vc's DiT and HiFT capturable: no host syncs or host->device copies inside."""
    import numpy as np
    import torch
    import modules.diffusion_transformer as dtm
    import modules.hifigan.generator as gen

    orig_mask = dtm.sequence_mask

    def sequence_mask(length, max_length=None):
        # DiT asks for length.max() (a host sync); while streaming every row is full length
        if max_length is None and STATIC_LEN[0]:
            max_length = STATIC_LEN[0]
        return orig_mask(length, max_length)
    dtm.sequence_mask = sequence_mask

    def sine_forward(self, f0):
        # SineGen.forward, with the random phase drawn on the GPU (was: on the CPU, then copied)
        F_mat = torch.zeros((f0.size(0), self.harmonic_num + 1, f0.size(-1)), device=f0.device)
        for i in range(self.harmonic_num + 1):
            F_mat[:, i: i + 1, :] = f0 * (i + 1) / self.sampling_rate
        theta_mat = 2 * np.pi * (torch.cumsum(F_mat, dim=-1) % 1)
        phase_vec = (torch.rand((f0.size(0), self.harmonic_num + 1, 1), device=f0.device) * 2 - 1) * np.pi
        phase_vec[:, 0, :] = 0
        sine_waves = self.sine_amp * torch.sin(theta_mat + phase_vec)
        uv = self._f02uv(f0)
        noise_amp = uv * self.noise_std + (1 - uv) * self.sine_amp / 3
        noise = noise_amp * torch.randn_like(sine_waves)
        return sine_waves * uv + noise, uv, noise
    gen.SineGen.forward = torch.no_grad()(sine_forward)

    def istft(self, magnitude, phase):
        # HiFTGenerator._istft without torch.istft's NOLA check (a host sync): irfft + overlap-add,
        # same result as torch.istft(center=True)
        n_fft, hop = self.istft_params["n_fft"], self.istft_params["hop_len"]
        magnitude = torch.clip(magnitude, max=1e2)
        spec = torch.complex(magnitude * torch.cos(phase), magnitude * torch.sin(phase))
        win = self.stft_window
        frames = torch.fft.irfft(spec, n=n_fft, dim=1) * win[None, :, None]  # (B, n_fft, T)
        T = frames.size(-1)
        out_len = n_fft + hop * (T - 1)
        y = torch.nn.functional.fold(frames, (1, out_len), (1, n_fft), stride=(1, hop))[:, 0, 0]
        env = torch.nn.functional.fold((win ** 2)[None, :, None].expand(1, n_fft, T), (1, out_len), (1, n_fft),
                                       stride=(1, hop))[:, 0, 0]
        y = y[:, n_fft // 2: out_len - n_fft // 2]
        env = env[:, n_fft // 2: out_len - n_fft // 2]
        return y / env.clamp_min(1e-11)
    gen.HiFTGenerator._istft = istft


def active_level_db(x, rate: int) -> float:
    """Speech level of a numpy signal, dBFS: mean power of the 20 ms frames within 30 dB of the loudest."""
    import numpy as np
    n = rate // 50
    fr = np.asarray(x[: len(x) // n * n], dtype=np.float64).reshape(-1, n)
    if not len(fr):
        return -100.0
    e = 10 * np.log10((fr ** 2).mean(axis=1) + 1e-12)
    act = e[e > max(e.max() - 30, -70)]
    return float(10 * np.log10(np.mean(10 ** (act / 10)))) if len(act) else -100.0


PROMPT_DB = [-20.0]  # level the reference is brought to before it becomes the prompt (None: as recorded)
STATIC_LEN = [0]  # sequence length for the patched sequence_mask (DiT tokens: time + style + frames)


def _graphed_estimator_cls():
    import torch

    class GraphedEstimator(torch.nn.Module):
        """Stands in for cfm.estimator (the DiT, called once per diffusion step)."""

        def __init__(self, inner, fp16: bool):
            super().__init__()
            self.inner = inner
            self.g = Graphed(self._run, "dit", autocast=fp16)

        def _run(self, x, prompt_x, x_lens, t, style, mu):
            return self.inner(x, prompt_x, x_lens, t, style, mu)

        def forward(self, x, prompt_x, x_lens, t, style, mu):
            STATIC_LEN[0] = x.size(-1) + 2  # time token + style token + frames
            try:
                return self.g(x, prompt_x, x_lens, t, style, mu)
            finally:
                STATIC_LEN[0] = 0

        def setup_caches(self, *a, **k):
            return self.inner.setup_caches(*a, **k)

    return GraphedEstimator


def GraphedEstimator(inner, fp16):  # noqa: N802
    return _graphed_estimator_cls()(inner, fp16)


# ---------------------------------------------------------------------------
# Model: loading as in real-time-gui.py load_models(), inference as in its custom_infer()
# ---------------------------------------------------------------------------


class SeedVC:
    def __init__(self, home: str, fp16: bool = True, graphs: bool = True):
        hf_env(home)
        self.seed_dir = os.path.join(home, "src", "seed-vc")
        if self.seed_dir not in sys.path:
            sys.path.insert(0, self.seed_dir)
        import torch
        import yaml
        from huggingface_hub import hf_hub_download
        from modules.commons import build_model, recursive_munch
        from modules.campplus.DTDNN import CAMPPlus
        from modules.hifigan.generator import HiFTGenerator
        from modules.hifigan.f0_predictor import ConvRNNF0Predictor
        from modules.audio import mel_spectrogram
        from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2Model

        self.torch = torch
        if not torch.cuda.is_available():
            raise RuntimeError("no CUDA GPU")
        self.device = torch.device("cuda")
        self.fp16 = fp16
        ck = os.path.join(self.seed_dir, "checkpoints")
        def dl(repo, fn):
            try:
                return hf_hub_download(repo_id=repo, filename=fn, cache_dir=ck, revision=REVISIONS[repo], local_files_only=True)
            except Exception as e:
                raise RuntimeError(f"model file {repo}/{fn} missing — run native/neural-vc/install.sh") from e

        with open(dl(DIT_REPO, DIT_CFG)) as f:
            cfg = yaml.safe_load(f)
        mp = recursive_munch(cfg["model_params"])
        mp.dit_type = "DiT"
        model = build_model(mp, stage="DiT")
        # Seed-VC's own load_checkpoint unpickles arbitrary objects; tensors only here (same mapping otherwise)
        params = torch.load(dl(DIT_REPO, DIT_FILE), map_location="cpu", weights_only=True)["net"]
        for key in model:
            if key not in params:
                continue
            own = model[key].state_dict()
            src = {(k[7:] if k.startswith("module.") else k): v for k, v in params[key].items()}
            model[key].load_state_dict({k: v for k, v in src.items() if k in own and v.shape == own[k].shape}, strict=False)
        for k in model:
            model[k].eval().to(self.device)
        model.cfm.estimator.setup_caches(max_batch_size=1, max_seq_length=8192)
        self.model = model

        camp = CAMPPlus(feat_dim=80, embedding_size=192)
        camp.load_state_dict(torch.load(dl(*CAMPPLUS), map_location="cpu", weights_only=True))
        self.campplus = camp.eval().to(self.device)

        with open(os.path.join(self.seed_dir, "configs", "hifigan.yml")) as f:
            hcfg = yaml.safe_load(f)
        hift = HiFTGenerator(**hcfg["hift"], f0_predictor=ConvRNNF0Predictor(**hcfg["f0_predictor"]))
        hift.load_state_dict(torch.load(dl(*HIFT), map_location="cpu", weights_only=True))
        self.vocoder = hift.eval().to(self.device)

        sp = cfg["model_params"]["speech_tokenizer"]
        if sp["name"] not in REVISIONS:
            raise RuntimeError(f"unexpected speech tokenizer {sp['name']}")
        pin = dict(revision=REVISIONS[sp["name"]], local_files_only=True)
        self.w2v_fe = Wav2Vec2FeatureExtractor.from_pretrained(sp["name"], **pin)
        w2v = Wav2Vec2Model.from_pretrained(sp["name"], **pin)
        w2v.encoder.layers = w2v.encoder.layers[: sp["output_layer"]]
        self.w2v = w2v.to(self.device).eval().half()

        spect = cfg["preprocess_params"]["spect_params"]
        self.sr = cfg["preprocess_params"]["sr"]  # 22050
        self.hop = spect["hop_length"]
        mel_args = {"n_fft": spect["n_fft"], "win_size": spect["win_length"], "hop_size": spect["hop_length"],
                    "num_mels": spect["n_mels"], "sampling_rate": self.sr, "fmin": spect.get("fmin", 0),
                    "fmax": None if spect.get("fmax", "None") == "None" else 8000, "center": False}
        self.to_mel = lambda x: mel_spectrogram(x, **mel_args)

        # CUDA graphs for the streaming path (make_prompt stays eager)
        self.g_w2v = self.g_est = self.g_voc = None
        if graphs:
            patch_for_graphs(self.seed_dir, self.device)
            self.vocoder.stft_window = self.vocoder.stft_window.to(self.device)
            w2v_m, voc_m = self.w2v, self.vocoder
            self.g_w2v = Graphed(lambda x: w2v_m(x).last_hidden_state, "xlsr")
            self.g_voc = Graphed(lambda m: voc_m(m), "hift", autocast=fp16)
            self.model.cfm.estimator = GraphedEstimator(self.model.cfm.estimator, fp16)
            self.g_est = self.model.cfm.estimator.g

    def semantic(self, wav16k, graphed: bool = False):
        """XLS-R content features. wav16k: (1, T) tensor."""
        x = self.w2v_fe([wav16k[0].cpu().numpy()], return_tensors="pt", return_attention_mask=True,
                        padding=True, sampling_rate=16000).input_values.to(self.device).half()
        with self.torch.no_grad():
            if graphed and self.g_w2v is not None:
                return self.g_w2v(x).float()
            return self.w2v(x).last_hidden_state.float()

    def make_prompt(self, path: str, prompt_sec: float) -> dict:
        """The target voice: the first prompt_sec seconds of the reference (silence trimmed)."""
        import librosa
        import numpy as np
        import torchaudio
        import torchaudio.compliance.kaldi as kaldi
        torch = self.torch
        ref, _ = librosa.load(path, sr=self.sr, mono=True)
        ref, _ = librosa.effects.trim(ref, top_db=40)
        if len(ref) < self.sr // 2:
            raise ValueError(f"voice reference too short: {path}")
        n = int(self.sr * prompt_sec)
        if len(ref) < n:
            # a short reference is repeated: every prompt has the same length, so the CUDA graphs captured
            # for the first voice are reused (a new shape would be captured mid-stream, a long stall)
            gap = np.zeros(self.sr // 5, dtype=ref.dtype)
            ref = np.concatenate([ref, gap] * (n // (len(ref) + len(gap)) + 1))
        ref = ref[:n]
        # the output's loudness follows the prompt's: every reference is brought to the same level
        if PROMPT_DB[0] is not None:
            level = active_level_db(ref, self.sr)
            ref = ref * float(10 ** ((PROMPT_DB[0] - level) / 20))
            peak = float(np.abs(ref).max())
            if peak > 0.98:
                ref = ref * (0.98 / peak)
        with torch.no_grad():
            r = torch.from_numpy(ref).to(self.device)
            r16 = torchaudio.functional.resample(r, self.sr, 16000)
            s_ori = self.semantic(r16[None])
            feat = kaldi.fbank(r16[None], num_mel_bins=80, dither=0, sample_frequency=16000)
            feat = feat - feat.mean(dim=0, keepdim=True)
            style = self.campplus(feat[None])
            mel2 = self.to_mel(r[None])
            cond = self.model.length_regulator(s_ori, ylens=torch.LongTensor([mel2.size(2)]).to(self.device),
                                               n_quantizers=3, f0=None)[0]
        torch.cuda.synchronize()
        return {"cond": cond, "mel2": mel2, "style": style, "path": path}

    def infer(self, prompt: dict, win16k, skip_head: int, skip_tail: int, return_length: int,
              steps: int, cfg_rate: float, ce_dit_diff: float):
        torch = self.torch
        with torch.no_grad():
            s_alt = self.semantic(win16k[None], graphed=True)
            d = int(ce_dit_diff * 50)
            s_alt = s_alt[:, d:]
            tl = torch.LongTensor([(skip_head + return_length + skip_tail - d) / 50 * self.sr // self.hop]).to(self.device)
            cond = self.model.length_regulator(s_alt, ylens=tl, n_quantizers=3, f0=None)[0]
            cat = torch.cat([prompt["cond"], cond], dim=1)
            with torch.autocast(device_type="cuda", dtype=torch.float16 if self.fp16 else torch.float32):
                mel = self.model.cfm.inference(cat, torch.LongTensor([cat.size(1)]).to(self.device), prompt["mel2"],
                                               prompt["style"], None, n_timesteps=steps, inference_cfg_rate=cfg_rate)
                mel = mel[:, :, prompt["mel2"].size(-1):]
                wav = (self.g_voc(mel) if self.g_voc is not None else self.vocoder(mel)).squeeze()
            out_len = return_length * self.sr // 50
            tail = skip_tail * self.sr // 50
            return wav[-out_len - tail: -tail].float()


# ---------------------------------------------------------------------------
# Streamer: sliding window, SOLA and an energy gate (real-time-gui.py's audio_callback, with an
# energy gate in place of its FunASR VAD)
# ---------------------------------------------------------------------------


class Streamer:
    def __init__(self, vc: SeedVC, rate: int, block_ms: float, steps: int, prompt_sec: float,
                 extra_ce: float = 2.5, extra_dit: float = 0.5, right_ms: float = 20, xfade_ms: float = 40,
                 gate_db: float = -50.0, hang_ms: float = 400, cfg_rate: float = 0.7, target_db: float | None = -20.0):
        import torch
        import torchaudio.transforms as tat
        self.torch, self.vc = torch, vc
        self.rate, self.steps, self.prompt_sec = rate, steps, prompt_sec
        self.want_steps = steps  # what was asked for; the adaptation goes below it and back
        self.gate_db, self.cfg_rate, self.hang_ms = gate_db, cfg_rate, hang_ms
        self.extra_ce, self.extra_dit = extra_ce, extra_dit
        zc = self.zc = rate // 50  # 20 ms, one content-feature frame
        rnd = lambda sec: max(1, int(round(sec * rate / zc))) * zc  # noqa: E731
        self.block = rnd(block_ms / 1000)
        self.xfade = rnd(xfade_ms / 1000)
        self.sola_buf_n = min(self.xfade, 4 * zc)
        self.sola_search = zc
        self.extra = rnd(extra_ce)
        self.right = rnd(right_ms / 1000)  # >= one frame: custom_infer slices with [-tail]
        n = self.extra + self.xfade + self.sola_search + self.block + self.right
        self.input_wav = torch.zeros(n)
        self.input_16k = torch.zeros(320 * n // zc)
        self.skip_head = self.extra // zc
        self.skip_tail = self.right // zc
        self.return_length = (self.block + self.sola_buf_n + self.sola_search) // zc
        self.block_16k = 320 * self.block // zc
        dev = vc.device
        w = torch.sin(0.5 * math.pi * torch.linspace(0.0, 1.0, self.sola_buf_n, device=dev)) ** 2
        self.fade_in, self.fade_out = w, 1 - w
        self.sola_buffer = torch.zeros(self.sola_buf_n, device=dev)
        self.res_in = tat.Resample(rate, 16000)
        self.res_out = tat.Resample(vc.sr, rate).to(dev) if vc.sr != rate else None
        self.open_left = 0
        self.prompt: dict | None = None
        # output level: a slow speech-level AGC towards target_db (None: off) and a soft limiter
        self.target_db = target_db
        # [speech level of the output before the gain (dB), level known (0/1), gain (dB)]
        self.agc = torch.zeros(3, device=dev)
        bs = self.block / rate
        self.agc_up = torch.tensor(1 - math.exp(-bs / 0.5), device=dev)    # level rises: tau 0.5 s
        self.agc_down = torch.tensor(1 - math.exp(-bs / 2.0), device=dev)  # level falls: tau 2 s
        self.ramp = torch.linspace(0.0, 1.0, self.block, device=dev)

    @property
    def lookback(self) -> int:
        """Output block k sits this many samples earlier in the input than input block k (SOLA picks 0..search)."""
        return self.right + self.sola_buf_n + self.sola_search // 2

    def reset(self) -> None:
        self.input_wav.zero_()
        self.input_16k.zero_()
        self.sola_buffer.zero_()
        self.open_left = 0
        self.agc.zero_()

    def _level(self, out):
        """AGC: follow the output's speech level (20 ms frames that aren't pauses) and ramp the gain
        towards target_db across the block; louder speech is followed faster than quieter. Then a soft
        limiter above -1 dBFS. All on the GPU, no host syncs."""
        torch = self.torch
        if self.target_db is None:
            return out
        fr = out[: out.numel() // self.zc * self.zc].view(-1, self.zc)
        p = fr.pow(2).mean(dim=1)
        e = 10 * torch.log10(p + 1e-12)
        lvl, have = self.agc[0], self.agc[1] > 0
        floor = torch.where(have, torch.clamp(lvl - 20, min=-55.0), torch.full_like(lvl, -55.0))
        act = (e > floor).float()
        n = act.sum()
        blk = 10 * torch.log10((p * act).sum() / n.clamp(min=1) + 1e-12)
        a = torch.where(blk > lvl, self.agc_up, self.agc_down)
        new = torch.where(have, lvl + a * (blk - lvl), blk)
        upd = n >= 2
        lvl = torch.where(upd, new, lvl)
        have = have | upd
        g_old = self.agc[2]
        g_new = torch.where(have, torch.clamp(self.target_db - lvl, -12.0, 12.0), g_old)
        self.agc = torch.stack([lvl, have.float(), g_new])
        g0, g1 = 10 ** (g_old / 20), 10 ** (g_new / 20)
        out = out * (g0 + (g1 - g0) * self.ramp[: out.numel()])
        th = 0.89
        mag = out.abs()
        return torch.where(mag > th, out.sign() * (th + (1 - th) * torch.tanh((mag - th) / (1 - th))), out)

    def _push(self, x) -> None:
        """Shift one block into the window and its 16 kHz copy (resampled incrementally, like the GUI)."""
        torch, b, zc = self.torch, self.block, self.zc
        self.input_wav[:-b] = self.input_wav[b:].clone()
        self.input_wav[-b:] = torch.from_numpy(x)
        self.input_16k[:-self.block_16k] = self.input_16k[self.block_16k:].clone()
        seg = self.res_in(self.input_wav[-b - 2 * zc:].unsqueeze(0))[0][320:]
        need = 320 * (b // zc + 1)
        if seg.numel() < need:
            seg = torch.nn.functional.pad(seg, (0, need - seg.numel()))
        self.input_16k[-need:] = seg[:need]

    def _gate_open(self) -> bool:
        """Open while any 20 ms frame of the audio this output covers is above gate_db; hold hang_ms."""
        torch = self.torch
        seg = self.input_wav[-(self.block + self.right + self.sola_buf_n + self.sola_search):]
        fr = seg[: seg.numel() // self.zc * self.zc].view(-1, self.zc)
        db = 10 * torch.log10(fr.pow(2).mean(dim=1) + 1e-12)
        if bool((db > self.gate_db).any()):
            self.open_left = max(1, math.ceil(self.hang_ms / 1000 * self.rate / self.block))
        elif self.open_left > 0:
            self.open_left -= 1
        return self.open_left > 0

    def _sola(self, infer_wav):
        torch, F = self.torch, self.torch.nn.functional
        n = self.sola_buf_n
        conv_in = infer_wav[None, None, : n + self.sola_search]
        nom = F.conv1d(conv_in, self.sola_buffer[None, None, :])
        den = torch.sqrt(F.conv1d(conv_in ** 2, torch.ones(1, 1, n, device=infer_wav.device)) + 1e-8)
        off = int(torch.argmax(nom[0, 0] / den[0, 0]).item())
        w = infer_wav[off:].clone()
        w[:n] *= self.fade_in
        w[:n] += self.sola_buffer * self.fade_out
        self.sola_buffer[:] = w[self.block: self.block + n]
        return w[: self.block]

    def process(self, x, skip_model: bool = False):
        """One input block in (numpy float32, length self.block), one output block out.
        Returns (out, state) with state 'ran', 'gated' or 'skipped'."""
        torch = self.torch
        self._push(x)
        gate = self._gate_open()
        prompt = self.prompt
        need = self.block + self.sola_buf_n + self.sola_search
        if skip_model or not gate or prompt is None:
            infer_wav = torch.zeros(need, device=self.vc.device)
            state = "skipped" if (skip_model and gate) else "gated"
        else:
            y = self.vc.infer(prompt, self.input_16k.to(self.vc.device), self.skip_head, self.skip_tail,
                              self.return_length, self.steps, self.cfg_rate, self.extra_ce - self.extra_dit)
            if self.res_out is not None:
                y = self.res_out(y[None])[0]
            if y.numel() < need:
                y = torch.nn.functional.pad(y, (0, need - y.numel()))
            infer_wav = y
            state = "ran"
        out = self._level(self._sola(infer_wav))
        return out.clamp(-1, 1).cpu().numpy().astype("<f4"), state


# ---------------------------------------------------------------------------
# I/O: the input pump releases output in step with the input
# ---------------------------------------------------------------------------


class Pipeline:
    """stdin reader + paced output writer.

    Output sample p is written when input sample p + delay has been read. The model thread puts block k
    at output position k * block + offset; whatever isn't there by the time it's due goes out as silence.
    A late block moves offset up by its lateness (the latency grows, nothing is cut) until offset reaches
    max_extra; past that the late part of a block is dropped, so the latency stays bounded."""

    def __init__(self, out_fd: int, block: int, delay: int, fade: int, max_extra: int):
        import numpy as np
        self.np = np
        self.out_fd, self.block, self.delay, self.fade = out_fd, block, delay, fade
        self.offset = 0           # extra delay picked up from late blocks (<= max_extra)
        self.max_extra = max_extra
        self.cv = threading.Condition()
        self.inbuf = bytearray()  # unread input bytes (whole blocks are taken by the model thread)
        self.in_total = 0         # input samples received
        self.taken = 0            # input blocks handed to the model thread
        self.eof = False
        self.broken = False       # stdout gone
        self.olock = threading.Lock()
        self.pending: deque = deque()  # output arrays covering [out_written, out_written + pending_n)
        self.pending_n = 0
        self.out_written = 0
        self.late_samples = 0
        self.fade_next = False

    # -- reader thread -----------------------------------------------------------
    def read_loop(self) -> None:
        fd = sys.stdin.fileno()
        carry = b""
        while True:
            try:
                b = os.read(fd, 1 << 16)
            except OSError:
                b = b""
            if not b:
                with self.cv:
                    self.eof = True
                    self.cv.notify_all()
                return
            if carry:
                b = carry + b
            whole = len(b) - (len(b) % 4)
            carry = b[whole:]
            if not whole:
                continue
            with self.cv:
                self.inbuf += b[:whole]
                self.in_total += whole // 4
                total = self.in_total
                if len(self.inbuf) >= self.block * 4:
                    self.cv.notify_all()
            self.release(total)

    def release(self, in_total: int) -> None:
        """Write the output that is due once in_total input samples have arrived."""
        np = self.np
        due = in_total - self.delay - self.out_written
        if due <= 0 or self.broken:
            return
        parts = []
        with self.olock:
            n = due
            while n and self.pending:
                a = self.pending[0]
                if len(a) <= n:
                    parts.append(self.pending.popleft())
                    n -= len(a)
                else:
                    parts.append(a[:n])
                    self.pending[0] = a[n:]
                    n = 0
            self.pending_n -= due - n
            if n:  # the model hasn't delivered this part: silence
                parts.append(np.zeros(n, dtype="<f4"))
                self.late_samples += n
                self.fade_next = True
            self.out_written += due
        buf = parts[0].tobytes() if len(parts) == 1 else np.concatenate(parts).tobytes()
        try:
            view = memoryview(buf)
            while view:
                view = view[os.write(self.out_fd, view):]
        except OSError:
            self.broken = True
            with self.cv:
                self.cv.notify_all()

    # -- model thread ------------------------------------------------------------
    def next_blocks(self):
        """Wait for whole input blocks. Returns (list of (index, samples), in_total), or (None, _) at EOF."""
        np = self.np
        nb = self.block * 4
        with self.cv:
            while len(self.inbuf) < nb and not self.eof and not self.broken:
                self.cv.wait(0.5)
            if self.broken or (self.eof and len(self.inbuf) < nb):
                return None, self.in_total
            k = len(self.inbuf) // nb
            raw = bytes(self.inbuf[: k * nb])
            del self.inbuf[: k * nb]
            first = self.taken
            self.taken += k
            total = self.in_total
        x = np.frombuffer(raw, dtype="<f4").reshape(k, self.block)
        return [(first + i, x[i]) for i in range(k)], total

    def put(self, index: int, y) -> bool:
        """Output for block `index`. Returns False if it arrived (partly) too late."""
        np = self.np
        with self.olock:
            start = index * self.block + self.offset
            end = self.out_written + self.pending_n
            if start > end:  # (only after skipped blocks) pad the gap
                self.pending.append(np.zeros(start - end, dtype="<f4"))
                self.pending_n += start - end
                end = start
            cut = end - start
            late = cut > 0
            if late and self.offset + cut <= self.max_extra:
                # late, but there's room: delay everything from here on instead of cutting the block
                self.offset += cut
                start, cut = end, 0
            if cut >= len(y):
                return False
            if cut > 0 or self.fade_next:
                y = y[cut:].copy()
                f = min(self.fade, len(y))
                y[:f] *= np.linspace(0.0, 1.0, f, dtype=np.float32)
                self.fade_next = False
            self.pending.append(y)
            self.pending_n += len(y)
            return not late


class Control(threading.Thread):
    """JSON control lines from fd 3."""

    def __init__(self, st: Streamer, fd: int):
        super().__init__(daemon=True)
        self.st, self.fd = st, fd
        self.voice_busy = threading.Lock()

    def run(self) -> None:
        try:
            with os.fdopen(self.fd, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    self.handle(line)
        except Exception as e:  # noqa: BLE001
            emit({"event": "warning", "message": f"control channel: {type(e).__name__}: {e}"})

    def handle(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            msg = json.loads(line)
            if "steps" in msg:
                self.st.steps = self.st.want_steps = max(1, min(30, int(msg["steps"])))
                emit({"event": "steps", "steps": self.st.steps})
            if "gate_db" in msg:
                self.st.gate_db = float(msg["gate_db"])
                emit({"event": "gate", "gate_db": self.st.gate_db})
            if "voice" in msg:
                # build the new prompt while audio keeps flowing; it's swapped in between two blocks
                t = time.perf_counter()
                with self.voice_busy:
                    self.st.prompt = self.st.vc.make_prompt(str(msg["voice"]), self.st.prompt_sec)
                emit({"event": "voice", "path": msg["voice"], "switch_ms": round((time.perf_counter() - t) * 1000)})
        except Exception as e:  # noqa: BLE001  — a bad command must not stop the voice
            emit({"event": "warning", "message": f"control: {type(e).__name__}: {e}"})


# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="print a JSON line about the install and the GPU, then exit")
    ap.add_argument("--rate", type=int, default=48000)
    ap.add_argument("--voice", type=str, help="target voice reference (wav)")
    ap.add_argument("--block-ms", type=float, default=180)
    ap.add_argument("--steps", type=int, default=6, help="diffusion steps")
    ap.add_argument("--prompt-sec", type=float, default=6.0, help="seconds of the reference used as the prompt")
    ap.add_argument("--gate-db", type=float, default=-50.0, help="energy gate threshold, dBFS per 20 ms")
    ap.add_argument("--hang-ms", type=float, default=400, help="gate hold time")
    ap.add_argument("--xfade-ms", type=float, default=40)
    ap.add_argument("--right-ms", type=float, default=20, help="lookahead")
    ap.add_argument("--extra-ce", type=float, default=2.5, help="left context (s) for the content encoder")
    ap.add_argument("--extra-dit", type=float, default=0.5, help="left context (s) for the DiT")
    ap.add_argument("--margin-ms", type=float, default=0, help="time allowed for one block's inference "
                    "(0: measured at warm-up)")
    ap.add_argument("--max-extra-ms", type=float, default=100, help="how much the latency may grow when "
                    "blocks come late, before late audio is dropped")
    ap.add_argument("--min-steps", type=int, default=3, help="steps are lowered down to this when the GPU can't keep up")
    ap.add_argument("--target-db", type=float, default=-20.0, help="output speech level, dBFS (AGC + soft "
                    "limiter); 0 turns the AGC off")
    ap.add_argument("--prompt-db", type=float, default=-20.0, help="level the reference is normalized to "
                    "before it becomes the prompt; 0 keeps it as recorded")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--no-fp16", action="store_true")
    ap.add_argument("--no-graphs", action="store_true", help="don't use CUDA graphs")
    ap.add_argument("--home", type=str, default=default_home())
    ap.add_argument("--log", type=str, default=None, help="file for library output (default: discarded)")
    a = ap.parse_args()

    if a.check:
        return run_check(a.home)

    # fd 3 (control) must be claimed before dup() can hand that number out
    try:
        os.fstat(3)
        ctl_fd = os.dup(3)
    except OSError:
        ctl_fd = None
    out_fd = silence_libraries(a.log)
    cap_threads(a.threads)
    emit({"event": "loading"})
    try:
        if not a.voice or not os.path.isfile(a.voice):
            raise FileNotFoundError(f"voice reference not found: {a.voice}")
        import numpy as np
        t0 = time.perf_counter()
        vc = SeedVC(a.home, fp16=not a.no_fp16, graphs=not a.no_graphs)
        torch = vc.torch
        torch.set_num_threads(a.threads)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass
        PROMPT_DB[0] = a.prompt_db if a.prompt_db < 0 else None
        st = Streamer(vc, a.rate, a.block_ms, a.steps, a.prompt_sec, extra_ce=a.extra_ce, extra_dit=a.extra_dit,
                      right_ms=a.right_ms, xfade_ms=a.xfade_ms, gate_db=a.gate_db, hang_ms=a.hang_ms,
                      target_db=a.target_db if a.target_db < 0 else None)
        st.prompt = vc.make_prompt(a.voice, a.prompt_sec)
        # warm-up: kernels, cuDNN/cuBLAS handles, the allocator. Speech-like noise passes the gate.
        rng = np.random.default_rng(0)
        warm = []
        for i in range(10):
            x = (rng.standard_normal(st.block) * 0.05 * (1 + np.sin(np.arange(st.block) / 300))).astype(np.float32)
            t = time.perf_counter()
            st.process(x)
            torch.cuda.synchronize()
            warm.append((time.perf_counter() - t) * 1000)
        st.reset()
        proc = float(np.max(warm[3:]))
        margin_ms = a.margin_ms or max(100.0, 10 * math.ceil((proc * 1.5 + 20) / 10))
        delay = st.block + int(round(margin_ms / 1000 * a.rate))
        latency_ms = 1000 * (delay + st.lookback) / a.rate
        emit({"event": "ready", "latency_ms": round(latency_ms), "device": torch.cuda.get_device_name(0),
              "block_ms": round(1000 * st.block / a.rate), "proc_ms": round(float(np.median(warm[3:])), 1),
              "margin_ms": round(margin_ms), "steps": st.steps, "fp16": vc.fp16,
              "load_s": round(time.perf_counter() - t0, 1),
              "vram_mb": round(torch.cuda.max_memory_allocated() / (1 << 20))})
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "message": f"{type(e).__name__}: {e}"})
        return 1

    pipe = Pipeline(out_fd, st.block, delay, fade=a.rate // 200, max_extra=int(a.max_extra_ms / 1000 * a.rate))
    threading.Thread(target=pipe.read_loop, daemon=True).start()
    if ctl_fd is not None:
        Control(st, ctl_fd).start()

    times: list = []
    overruns = gated = skipped = blocks = 0
    win_overruns = 0
    calm = 0  # stats windows in a row without overruns while the steps are lowered
    last_stats = time.perf_counter()
    est = float(np.median(warm[3:]))  # recent inference time, ms
    try:
        while True:
            items, in_total = pipe.next_blocks()
            if items is None:
                break
            for idx, x in items:
                x = np.nan_to_num(x.astype(np.float32), nan=0.0, posinf=0.0, neginf=0.0)
                # skip the model if this block's output couldn't be ready by the time it's due
                due_in = (idx * st.block + pipe.offset + delay - pipe.in_total) / a.rate * 1000
                skip = due_in < 0.5 * est
                t = time.perf_counter()
                y, state = st.process(x, skip_model=skip)
                dt = (time.perf_counter() - t) * 1000
                blocks += 1
                if state == "ran":
                    times.append(dt)
                    est = 0.8 * est + 0.2 * dt
                elif state == "gated":
                    gated += 1
                else:
                    skipped += 1
                    # est only learns from blocks that ran: without this, one long stall (another program
                    # on the GPU) could inflate it so far that every later block is skipped, for good
                    est *= 0.7
                if not pipe.put(idx, y) or state == "skipped":
                    overruns += 1
                    win_overruns += 1
            if pipe.broken:
                break
            now = time.perf_counter()
            if now - last_stats >= 2.0:
                arr = np.array(times) if times else np.zeros(1)
                # GPU too slow (a game?): fewer steps
                if win_overruns >= 2 and st.steps > a.min_steps:
                    st.steps -= 1
                    calm = 0
                    emit({"event": "steps", "steps": st.steps, "reason": "overruns"})
                elif win_overruns == 0 and st.steps < st.want_steps:
                    # GPU free again: one step back up after ~20 s of speech without overruns (pauses don't
                    # count), if the slowest recent block would still fit the budget with the extra step
                    if len(times) >= 3:
                        calm += 1
                        budget = 1000 * (delay - st.block) / a.rate
                        if calm >= 10 and float(arr.max()) * (st.steps + 1) / st.steps < 0.85 * budget:
                            st.steps += 1
                            calm = 0
                            emit({"event": "steps", "steps": st.steps, "reason": "recovered"})
                else:
                    calm = 0
                emit({"event": "stats", "block_ms": round(float(arr.mean()), 1),
                      "p95_ms": round(float(np.percentile(arr, 95)), 1), "max_ms": round(float(arr.max()), 1),
                      "overruns": overruns, "skipped": skipped, "gated": gated, "blocks": blocks,
                      "late_ms": round(1000 * pipe.late_samples / a.rate), "steps": st.steps,
                      "latency_ms": round(1000 * (delay + pipe.offset + st.lookback) / a.rate),
                      "budget_ms": round(1000 * delay / a.rate - 1000 * st.block / a.rate)})
                times.clear()
                win_overruns = 0
                last_stats = now
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "message": f"{type(e).__name__}: {e}"})
        return 1
    return 0


if __name__ == "__main__":
    code = main()
    # don't wait for the reader/control threads or CUDA teardown
    try:
        sys.stdout.flush()
    except Exception:  # noqa: BLE001
        pass
    os._exit(code)
