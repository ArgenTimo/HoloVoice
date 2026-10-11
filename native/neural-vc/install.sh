#!/usr/bin/env bash
# Installs the optional neural voices for HoloVoice (Linux, NVIDIA GPU) into ~/.local/share/holovoice
# (or $HOLOVOICE_HOME): a Python venv with CUDA PyTorch, Seed-VC at a pinned commit, its checkpoints and the
# two target voices. Idempotent: anything already in place is kept — run it again to finish an install that
# was interrupted. Nothing outside that folder is touched (uv may cache downloads in ~/.cache/uv).
#
#   native/neural-vc/install.sh            install / complete the install
#   native/neural-vc/install.sh --check    only run the sidecar's self-check
#
# Needs: git, curl, an NVIDIA driver (CUDA 12.1 capable), ~6 GB of disk. Python comes from uv (installed
# into ~/.local/bin if missing) — no system Python packages are needed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HV="${HOLOVOICE_HOME:-$HOME/.local/share/holovoice}"
VENV="$HV/venvs/seedvc"
SEED="$HV/src/seed-vc"
SEED_REPO="https://github.com/Plachtaa/seed-vc.git"
SEED_COMMIT="51383efd921027683c89e5348211d93ff12ac2a8"  # 2025-04-20
TORCH_INDEX="https://download.pytorch.org/whl/cu121"
PY="$VENV/bin/python"

# pip-installed CUDA libraries break with a system-wide LD_LIBRARY_PATH (wrong nvJitLink)
unset LD_LIBRARY_PATH

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

check() {
  "$PY" "$HERE/holovoice_vc.py" --check --home "$HV"
}

if [[ "${1:-}" == "--check" ]]; then check; exit; fi

command -v git >/dev/null || die "git is required"
command -v nvidia-smi >/dev/null || echo "warning: nvidia-smi not found — the neural voices need an NVIDIA GPU" >&2
mkdir -p "$HV/venvs" "$HV/src" "$HV/models/hf" "$HV/voices"

# --- uv (Python + fast installs) ---------------------------------------------------------------
UV="$(command -v uv || true)"
if [[ -z "$UV" && -x "$HOME/.local/bin/uv" ]]; then UV="$HOME/.local/bin/uv"; fi
if [[ -z "$UV" ]]; then
  say "Installing uv into ~/.local/bin"
  command -v curl >/dev/null || die "curl is required to install uv"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
  UV="$HOME/.local/bin/uv"
fi

# --- venv ----------------------------------------------------------------------------------------
if [[ ! -x "$PY" ]]; then
  say "Creating the Python 3.10 venv in $VENV"
  "$UV" venv --python 3.10 "$VENV"
fi

if ! "$PY" -c 'import torch, torchaudio; assert torch.__version__.startswith("2.4.0")' 2>/dev/null; then
  say "Installing PyTorch 2.4.0 (CUDA 12.1) — about 2.5 GB"
  "$UV" pip install --python "$PY" --index-url "$TORCH_INDEX" "torch==2.4.0" "torchaudio==2.4.0"
fi

say "Installing Python packages"
"$UV" pip install --python "$PY" \
  "numpy==1.26.4" "scipy==1.13.1" "librosa==0.10.2" "soundfile==0.12.1" \
  "transformers==4.46.3" "huggingface_hub>=0.28.1,<1.0" "munch==4.0.0" "einops==0.8.0" "pyyaml" \
  "descript-audio-codec==1.0.0" "hydra-core==1.3.2" "python-dotenv" "accelerate"

# --- Seed-VC (GPL-3.0) at a pinned commit ------------------------------------------------------------
if [[ ! -d "$SEED/.git" ]]; then
  say "Cloning Seed-VC"
  git clone --quiet "$SEED_REPO" "$SEED"
fi
if [[ "$(git -C "$SEED" rev-parse HEAD)" != "$SEED_COMMIT" ]]; then
  say "Checking out Seed-VC $SEED_COMMIT"
  git -C "$SEED" cat-file -e "$SEED_COMMIT^{commit}" 2>/dev/null || git -C "$SEED" fetch --quiet origin
  git -C "$SEED" -c advice.detachedHead=false checkout --quiet "$SEED_COMMIT" \
    || die "can't check out $SEED_COMMIT in $SEED (local changes?)"
fi

# --- checkpoints -----------------------------------------------------------------------------------
# Seed-VC's own files go where its code looks (src/seed-vc/checkpoints), XLS-R into the HF cache in models/hf.
say "Downloading checkpoints (skips files already there) — about 1.6 GB"
HF_HOME="$HV/models/hf" HF_HUB_DISABLE_TELEMETRY=1 "$PY" - "$SEED/checkpoints" <<'EOF'
import sys
from huggingface_hub import hf_hub_download
ck = sys.argv[1]
for repo, fn in [("Plachta/Seed-VC", "DiT_uvit_tat_xlsr_ema.pth"),
                 ("Plachta/Seed-VC", "config_dit_mel_seed_uvit_xlsr_tiny.yml"),
                 ("funasr/campplus", "campplus_cn_common.bin"),
                 ("FunAudioLLM/CosyVoice-300M", "hift.pt")]:
    print("  ", repo, fn, flush=True)
    hf_hub_download(repo_id=repo, filename=fn, cache_dir=ck)
for fn in ("config.json", "preprocessor_config.json", "pytorch_model.bin"):
    print("   facebook/wav2vec2-xls-r-300m", fn, flush=True)
    hf_hub_download(repo_id="facebook/wav2vec2-xls-r-300m", filename=fn)
EOF

# --- target voices ------------------------------------------------------------------------------------
# female.wav / male.wav (+ ATTRIBUTION.txt) ship next to this script. Existing files are kept, so a
# voice the user replaced stays.
if [[ -d "$HERE/voices" ]]; then
  for f in "$HERE"/voices/*; do
    [[ -e "$HV/voices/$(basename "$f")" ]] || { say "Adding voice $(basename "$f")"; cp "$f" "$HV/voices/"; }
  done
fi
[[ -f "$HV/voices/female.wav" && -f "$HV/voices/male.wav" ]] \
  || echo "warning: $HV/voices needs female.wav and male.wav (a few seconds of clean speech each)" >&2

say "Self-check"
check
