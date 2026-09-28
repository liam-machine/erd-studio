# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "kokoro-onnx==0.6.1",
#   "phonemizer-fork>=3.3.2",
#   "espeakng-loader>=0.2.4",
#   "soundfile>=0.12",
#   "numpy>=1.26",
#   "pyyaml>=6",
# ]
# ///
"""Synthesise the getting-started narration: one WAV per `lines[].say` in script.yaml.

    uv run tts.py                   # Kokoro (default voice from script.yaml)
    uv run tts.py --engine say      # macOS `say -v Karen` fallback
    uv run tts.py --voice bf_emma   # audition another Kokoro voice
    uv run tts.py --only s04_type   # re-voice one line

Writes build/voice/<line id>.wav (mono, 24 kHz, 16-bit) and build/voice/manifest.json
({ engine, voice, speed, lines: [{ id, file, dur }] }). A line is re-synthesised only when
its text, engine, voice or speed changed, so editing one line is cheap.

Two environment quirks this file works around (both cost an afternoon once):

1. `phonemizer-fork`, not `phonemizer`. kokoro-onnx 0.6 calls
   `EspeakWrapper.set_data_path`, which only the fork has; plain phonemizer 3.4 fails at import.
2. espeak-ng silently truncates a long `data_path` (the buffer is ~160 bytes) and then
   cannot find its phoneme tables, so every line comes out as silence or garbage. The
   bundled data lives deep inside site-packages, so it is copied once to a SHORT directory
   (build/ed by default, or a temp dir if even that path is long) and passed explicitly
   through EspeakConfig.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

import numpy as np
import soundfile as sf
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
VOICE_DIR = os.path.join(BUILD, "voice")
MODEL_DIR = os.environ.get("KOKORO_MODEL_DIR", os.path.join(BUILD, "models"))
MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
MODEL_FILES = ("kokoro-v1.0.onnx", "voices-v1.0.bin")
# espeak-ng's path buffer is small; anything longer than this gets a temp-dir copy instead.
MAX_ESPEAK_PATH = 100


def load_lines(script_path: str) -> tuple[dict, list[dict]]:
    with open(script_path, encoding="utf-8") as fh:
        script = yaml.safe_load(fh)
    lines = []
    for scene in script["scenes"]:
        for line in scene.get("lines", []):
            lines.append({"id": line["id"], "say": line.get("say") or line["caption"]})
    return script, lines


def ensure_models() -> None:
    os.makedirs(MODEL_DIR, exist_ok=True)
    for name in MODEL_FILES:
        dest = os.path.join(MODEL_DIR, name)
        if os.path.exists(dest):
            continue
        print(f"downloading {name} (one-off, ~330 MB total) ...", file=sys.stderr)
        tmp = dest + ".part"
        urllib.request.urlretrieve(MODEL_URL + name, tmp)
        os.replace(tmp, dest)


def short_espeak_data() -> str:
    import espeakng_loader

    src = espeakng_loader.get_data_path()
    dest = os.path.join(BUILD, "ed")
    if len(dest) > MAX_ESPEAK_PATH:
        dest = os.path.join(tempfile.gettempdir(), "erd-studio-espeak-data")
    if not os.path.exists(os.path.join(dest, "phontab")):
        shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(src, dest)
    return dest


def trim(samples: np.ndarray, sr: int, pad: float = 0.04, floor: float = 0.004) -> np.ndarray:
    """Cut leading/trailing near-silence so a line's measured duration is its speech."""
    loud = np.flatnonzero(np.abs(samples) > floor)
    if loud.size == 0:
        return samples
    p = int(pad * sr)
    return samples[max(0, loud[0] - p): min(len(samples), loud[-1] + p)]


def kokoro_engine(voice: str, speed: float, lang: str):
    from kokoro_onnx import Kokoro
    from kokoro_onnx.config import EspeakConfig
    import espeakng_loader

    ensure_models()
    k = Kokoro(
        os.path.join(MODEL_DIR, MODEL_FILES[0]),
        os.path.join(MODEL_DIR, MODEL_FILES[1]),
        espeak_config=EspeakConfig(lib_path=espeakng_loader.get_library_path(), data_path=short_espeak_data()),
    )

    def synth(text: str) -> tuple[np.ndarray, int]:
        samples, sr = k.create(text, voice=voice, speed=speed, lang=lang)
        return np.asarray(samples, dtype=np.float32), sr

    return synth


def say_engine(voice: str, rate: int):
    if shutil.which("say") is None:
        sys.exit("--engine say needs macOS `say`")

    def synth(text: str) -> tuple[np.ndarray, int]:
        with tempfile.TemporaryDirectory() as d:
            aiff, wav = os.path.join(d, "l.aiff"), os.path.join(d, "l.wav")
            subprocess.run(["say", "-v", voice, "-r", str(rate), "-o", aiff, text], check=True)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", aiff, "-ac", "1", "-ar", "24000", wav], check=True)
            samples, sr = sf.read(wav, dtype="float32")
        return samples, sr

    return synth


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--script", default=os.path.join(HERE, "script.yaml"))
    ap.add_argument("--engine", choices=["kokoro", "say"], default=None)
    ap.add_argument("--voice", default=None)
    ap.add_argument("--speed", type=float, default=None)
    ap.add_argument("--only", default=None, help="comma-separated line ids to force re-synthesis of")
    ap.add_argument("--force", action="store_true", help="ignore the cache and re-voice every line")
    args = ap.parse_args()

    script, lines = load_lines(args.script)
    vcfg = script.get("voice", {})
    engine = args.engine or vcfg.get("engine", "kokoro")
    if engine == "kokoro":
        voice = args.voice or vcfg.get("kokoro", "af_heart")
        speed = args.speed or float(vcfg.get("speed", 1.0))
        lang = "en-gb" if voice.startswith("b") else "en-us"
        synth = kokoro_engine(voice, speed, lang)
    else:
        voice = args.voice or vcfg.get("say", "Karen")
        speed = args.speed or float(vcfg.get("sayRate", 175))
        synth = say_engine(voice, int(speed))

    os.makedirs(VOICE_DIR, exist_ok=True)
    only = set((args.only or "").split(",")) - {""}
    out = []
    for line in lines:
        wav = os.path.join(VOICE_DIR, f"{line['id']}.wav")
        key = hashlib.sha1(json.dumps([engine, voice, speed, line["say"]]).encode()).hexdigest()
        stamp = wav + ".key"
        fresh = (
            not args.force
            and line["id"] not in only
            and os.path.exists(wav)
            and os.path.exists(stamp)
            and open(stamp).read() == key
        )
        if not fresh:
            samples, sr = synth(line["say"])
            samples = trim(samples, sr)
            sf.write(wav, samples, sr, subtype="PCM_16")
            with open(stamp, "w") as fh:
                fh.write(key)
        info = sf.info(wav)
        dur = round(info.frames / info.samplerate, 3)
        out.append({"id": line["id"], "file": os.path.relpath(wav, HERE), "dur": dur})
        print(f"{'cached' if fresh else 'voiced'}  {dur:6.2f}s  {line['id']}", file=sys.stderr)

    manifest = {"engine": engine, "voice": voice, "speed": speed, "lines": out}
    with open(os.path.join(VOICE_DIR, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    total = sum(l["dur"] for l in out)
    print(f"{len(out)} lines, {total:.1f}s of speech ({engine}/{voice})", file=sys.stderr)


if __name__ == "__main__":
    main()
