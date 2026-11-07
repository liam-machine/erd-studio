# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "kokoro-onnx==0.6.1",
#   "phonemizer-fork>=3.3.2",
#   "espeakng-loader>=0.2.4",
#   "soundfile>=0.12",
#   "numpy>=1.26",
# ]
# ///
"""Voice the onboarding stories' narration (run.mjs --narrate, lib/narrate.mjs).

    uv run --script test/stories/lib/tts.py --voice af_heart --speed 1.04 --out <dir> < lines.json

stdin is a JSON list of {"text": ..., "file": "<name>.wav"}; each line is written to
<dir>/<file> (mono, 24 kHz, 16-bit, leading and trailing silence trimmed). narrate.mjs
names each file by a hash of voice + speed + text and only asks for the ones it does not
have, so a line is voiced once.

The voice is the getting-started tour's (video/script.yaml: Kokoro af_heart at 1.04), so
ERD Studio sounds the same everywhere. The model is the one ~/.cache/issue-to-pr/kokoro
already holds for the issue videos (kokoro-v1.0.int8.onnx + voices-v1.0.bin; the full
kokoro-v1.0.onnx is used instead when it is there), downloaded once if it is missing
($KOKORO_MODEL_DIR overrides the folder).

The same two workarounds as video/tts.py (see its header): phonemizer-fork, not phonemizer
(kokoro-onnx 0.6 calls EspeakWrapper.set_data_path), and espeak-ng's data copied to a SHORT
folder, because espeak-ng truncates a long data_path and then voices silence or garbage.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import urllib.request

import numpy as np
import soundfile as sf

CACHE = os.path.expanduser(os.environ.get("ISSUE_TO_PR_CACHE", "~/.cache/issue-to-pr"))
MODEL_DIR = os.environ.get("KOKORO_MODEL_DIR", os.path.join(CACHE, "kokoro"))
MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
MODELS = ("kokoro-v1.0.onnx", "kokoro-v1.0.int8.onnx")
VOICES = "voices-v1.0.bin"
MAX_ESPEAK_PATH = 100


def model_files() -> tuple[str, str]:
    os.makedirs(MODEL_DIR, exist_ok=True)
    model = next((os.path.join(MODEL_DIR, m) for m in MODELS if os.path.exists(os.path.join(MODEL_DIR, m))), None)
    wanted = [] if model else [MODELS[1]]
    if not os.path.exists(os.path.join(MODEL_DIR, VOICES)):
        wanted.append(VOICES)
    for name in wanted:
        print(f"[tts] downloading {name} (once) to {MODEL_DIR} ...", file=sys.stderr)
        dest = os.path.join(MODEL_DIR, name)
        urllib.request.urlretrieve(MODEL_URL + name, dest + ".part")
        os.replace(dest + ".part", dest)
    return model or os.path.join(MODEL_DIR, MODELS[1]), os.path.join(MODEL_DIR, VOICES)


def short_espeak_data(out_dir: str) -> str:
    import espeakng_loader

    dest = os.path.join(os.path.dirname(os.path.abspath(out_dir)), "ed")
    if len(dest) > MAX_ESPEAK_PATH:
        dest = os.path.join(tempfile.gettempdir(), "erd-studio-espeak-data")
    if not os.path.exists(os.path.join(dest, "phontab")):
        shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(espeakng_loader.get_data_path(), dest)
    return dest


def trim(samples: np.ndarray, sr: int, pad: float = 0.04, floor: float = 0.004) -> np.ndarray:
    loud = np.flatnonzero(np.abs(samples) > floor)
    if loud.size == 0:
        return samples
    p = int(pad * sr)
    return samples[max(0, loud[0] - p): min(len(samples), loud[-1] + p)]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--speed", type=float, default=1.04)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    lines = json.load(sys.stdin)
    if not lines:
        return
    os.makedirs(args.out, exist_ok=True)

    from kokoro_onnx import Kokoro
    from kokoro_onnx.config import EspeakConfig
    import espeakng_loader

    model, voices = model_files()
    k = Kokoro(model, voices, espeak_config=EspeakConfig(
        lib_path=espeakng_loader.get_library_path(), data_path=short_espeak_data(args.out)))
    lang = "en-gb" if args.voice.startswith("b") else "en-us"
    for line in lines:
        samples, sr = k.create(line["text"], voice=args.voice, speed=args.speed, lang=lang)
        samples = trim(np.asarray(samples, dtype=np.float32), sr)
        dest = os.path.join(args.out, line["file"])
        sf.write(dest + ".part.wav", samples, sr, subtype="PCM_16")
        os.replace(dest + ".part.wav", dest)
        print(f"[tts] {len(samples) / sr:5.2f} s  {line['text']}", file=sys.stderr)


if __name__ == "__main__":
    main()
