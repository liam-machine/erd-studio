# Getting-started video

Source and render pipeline for the short getting-started tour (at most 140 s, `maxDuration` in `script.yaml`; the product copy calls it "short", never "2-minute", since it runs a little over two minutes) that the **Welcome to ERD Studio** panel plays. Nothing in this folder ships: `.vscodeignore` excludes `video/**`, and nothing in `esbuild.js`, the tsconfigs or the root vitest run refers to it. The pipeline writes three committed outputs:

| Output | Used by |
|---|---|
| `media/onboarding/getting-started.mp4` | the Welcome panel's `<video>` (ships) |
| `media/onboarding/getting-started-poster.jpg` | the poster and the "can't play here" fallback (ships) |
| `src/types/gettingStartedTranscript.ts` | `GETTING_STARTED_CUES` (the panel adds them as `VTTCue`s) and `GETTING_STARTED_TRANSCRIPT` (the **Transcript** section). Generated; do not edit by hand. |

`video/getting-started.vtt` is the same captions as WebVTT, kept as a source artefact for review and for uploading next to the video elsewhere. It is not shipped.

Style reference: `/Users/liamwynne/GIT/LIAM/erd-studio/docs/assets/erd-studio-linkedin.mp4`. It lives only in the main checkout and is untracked, so do not copy it here. Colour tokens come from it and from `scripts/social-preview.html`.

## Prerequisites

- **ffmpeg 7 or later** built with `libx264` and `libmp3lame`. Homebrew's build has both. Check with `ffmpeg -encoders | grep -E 'libx264|libmp3lame'`.
- **Node 18 or later**, then in this folder run `npm install` and `npx playwright install chromium`. Capture uses Playwright's bundled Chromium rather than your installed Chrome, so frames do not change when Chrome updates.
- **uv** (<https://docs.astral.sh/uv/>). `tts.py` declares its Python dependencies inline, so `uv run tts.py` builds its own environment on the first run. It needs Python 3.10 to 3.12.
- The Kokoro model files, about 330 MB. `tts.py` downloads `kokoro-v1.0.onnx` and `voices-v1.0.bin` into `build/models/` on the first run. Set `KOKORO_MODEL_DIR` to reuse a copy you already have.

## Regenerate

```bash
cd video
npm run all        # tts → timeline → music → capture → encode (also writes build/getting-started-share.mp4)
npm run qa         # contact sheet + per-scene stills in build/qa/, and the A/V onset check
npm test           # pipeline self-tests (node:test), incl. that the Welcome-panel mocks (helper and
                   # sample scenes, incl. the "Try the sample" card, link and confirm dialog), the sample
                   # scene's other two entry points (the sidebar welcome-view link and the Command Palette
                   # title, both read from package.json) and the modelling scene (detect-and-confirm) use
                   # the real copy from src/types/gettingStarted.ts, src/providers/GettingStartedPanel.ts,
                   # package.json and the setup skill's SKILL.md (reword any of them, and the video must
                   # be re-rendered)
```

| Step | Command | What it does |
|---|---|---|
| tts | `uv run tts.py` | Voices each `lines[].say` (or `caption`) from `script.yaml` into `build/voice/<id>.wav`. A line is re-voiced only when its text, voice, speed or engine changed. |
| timeline | `node build-timeline.mjs` | Lays the scenes out from the **measured** clip durations, then writes `build/timeline.json`, `build/narration.wav` (two-pass loudnorm to −16 LUFS / −1.5 dBTP, 48 kHz mono), `getting-started.vtt` and `src/types/gettingStartedTranscript.ts`. It fails if the total is over `maxDuration` (140 s). |
| music | `uv run music.py` | Writes the background track, `build/music.wav`, trimmed to the timeline, faded in (0.5 s) and out (4 s), and levelled to −14.5 LUFS. The source, in order: a `music/background.{m4a,mp3,wav,flac}` file if one exists (only ever music you are licensed to redistribute publicly); otherwise `music/synth_music.py`, the maintainer's original "demo audio kit" underscore (part 1: warm ambient, D major, 96 BPM; numpy/scipy; deterministic), which it runs into `build/music_raw.wav`; otherwise its own built-in synth: an upbeat 120 BPM electronic track in A minor — kick, claps, hats, pumping supersaw pad, offbeat bass, plucky arp with echo — arranged on `build/timeline.json` (beat drops on the first scene cut, arp enters with the AI assistants, breakdown under the modelling scene, impacts on "checks its own work" and the end card). `encode.sh` mixes it at one steady level about 12 dB under the voice (−28 vs −16 LUFS; no ducking, so it never pumps between lines), with a gentle compressor to even out the track's own sections, then normalises the mix to −16 LUFS. Delete `build/music.wav` for a voice-only render. |
| capture | `node capture.mjs [--draft] [--jobs N] [--scale 0.6667]` | Renders every frame of `player/` at 1920×1080 and 30 fps and pipes it into a lossless master, `build/master.mkv`. `render(t)` is pure, so `--jobs` renders ranges in parallel and concatenates them. `--draft` pipes JPEG q95 instead of PNG. `--stills 3.2,41` writes single frames to `build/stills/`. |
| encode | `bash encode.sh` | Produces the mp4 and the poster, then asserts them with ffprobe (see *Size budget and checks*). `--placeholder` makes a 2-second test pattern through the same path. |

The timeline rules are that a scene starts where the previous one ends, and its first line starts `timing.lead` (0.45 s) into it. Every later line starts `timing.gap` (0.25 s) after the one before, or after the line's own `pause` if it sets one. A scene lasts `max(minDur, lastLineEnd + tail)`. Each line's `beat` becomes `beats.<name> = { t, end }` in scene-local seconds, and the scene modules key every animation off those values. That means editing a line and re-running `tts` and `timeline` moves the visuals with the voice. Some beats sit a fixed offset after a line starts so they land on a particular word, for example the Diff button lighting up on "…the Diff button". Those offsets are commented in the scene module. If you reword a line, check them with `npm run preview`.

### Preview

```bash
npm run preview    # serves the repo root on 127.0.0.1:4173
```

- `http://127.0.0.1:4173/video/player/index.html?preview=1` plays the narration and drives `t` from `audio.currentTime`. Click to play or pause, and use ←/→ to seek 5 s.
- `…/index.html?t=42.5` freezes on one frame.

The player is plain ES modules. `main.js` owns the persistent chrome (kicker, headline, chapter bar). Each `player/scenes/<module>.js` exports `render(localT, { beats, dur })` and returns HTML. `lib.js` holds the shared pieces: the node card, the canvas toolbar, edges, the pointer and the easing helpers. There are no CSS transitions, `@keyframes`, timers or randomness anywhere, and `npm test` enforces that.

## Voice

The default is Kokoro v1.0 voice **`af_heart`** at speed 1.0 (set in `script.yaml → voice`). Kokoro has no Australian voice. `af_heart` was the clearest of the voices auditioned (`af_heart`, `af_bella`, `af_nicole`, `bf_emma`, `bm_george`, `am_michael`), and `bf_emma` is the closest non-American alternative.

- To audition another voice: `uv run tts.py --voice bf_emma --force && node build-timeline.mjs`.
- To switch permanently, edit `voice.kokoro` (and `speed`, anywhere from 0.95 to 1.0) in `script.yaml`.
- For a fallback without Kokoro, use macOS `say -v Karen -r 175` (en-AU): `npm run tts:say`. It is genuinely Australian but noticeably more robotic.

Kokoro has two environment traps, and `tts.py` handles both:

1. It needs **`phonemizer-fork`**, not `phonemizer`. kokoro-onnx 0.6 calls `EspeakWrapper.set_data_path`, which only the fork has.
2. **espeak-ng silently truncates a long data path.** The buffer is about 160 bytes, and the `espeak-ng-data` bundled inside site-packages is usually deeper than that. The result is silence or garbled phonemes, with no error. `tts.py` copies the data once to a short directory, `build/ed`, or a temp directory if even that path is over 100 characters. It passes that directory explicitly through `EspeakConfig(lib_path=…, data_path=…)`.

### Pronunciation

Captions show the real text. When the voice needs something different, the line's `say` field carries a respelling. Kokoro's own G2P already reads most of the vocabulary correctly. These were checked against its phoneme output:

| Written | Kokoro reads it as | Respelling used |
|---|---|---|
| ERD Studio | "E-R-D studio" | none needed |
| dbt | "D-B-T" | none needed |
| YAML | "yammel" | none needed |
| SQL | "S-Q-L" | none needed |
| AI | "A-I" | none needed. Do **not** write "A I", which reads as "a eye". |
| `/erd-studio-setup` | "erdstudiosetup" | `slash ERD studio setup` |
| modelling (AU caption) | | `modeling`, since the voice is en-US |

To check a new word, run `from kokoro_onnx.tokenizer import Tokenizer` and `Tokenizer(...).phonemize("word", "en-us")`.

## Size budget and checks

- **Codec:** MP4 container, **H.264** High profile, yuv420p, `+faststart`, with **MP3** audio (64 kbps, mono, 44.1 kHz): the audio codec VS Code's webview guide documents for video. VS Code's bundled ffmpeg has **no AAC decoder**, so AAC audio plays silently. Opus-in-MP4 shipped first and a user heard no voice, so stay on MP3. Never switch the audio to AAC.
- **Ceiling: 8 MB** (8 MiB) for the mp4, and 140 s for the timeline. `encode.sh` tries CRF 20, then 22, 24 and 26, and fails if the file is still over. The GOP is 150 frames (5 s). The content is mostly static UI, and the longer GOP roughly halves the size at the same CRF compared with 2 s keyframes. The current render is about 7.94 MiB (8.33 MB, 137.9 s) at CRF 20, close to the ceiling: a longer or busier render will fall through to CRF 22. The ceiling was 7 MiB until the sample-project scene took the video past 120 s; CRF 20 is kept rather than dropping to 22 for the extra 15 s.
- `encode.sh` asserts: `h264` / `High` / `yuv420p`, `mp3` / 44100 / mono, size ≤ 8 MB, duration within 0.25 s of the timeline, the moov atom before mdat, and a 1280×720 JPEG poster.
- `test/unit/gettingStartedMedia.test.ts` (root vitest) re-checks the shipped files: only two files in `media/onboarding/`, ≤ 8 MB, cues ending by 140 s, faststart, an MP3 track (esds object type 0x6B, not AAC), a JPEG poster, and well-formed cues.
- The poster is the end card 1.5 s in, once every element has landed.

## Licences

- **Kokoro-82M** model and voices: Apache-2.0 (hexgrad/Kokoro-82M; ONNX export from thewh1teagle/kokoro-onnx, MIT). **Re-verify both before each release that re-voices the video.**
- **espeak-ng** (via `espeakng-loader`): GPL-3.0. It is used only as a build-time tool, and neither it nor any of its output ships except as rendered audio.
- **Fonts:** Inter and JetBrains Mono, SIL Open Font License 1.1. They are in `player/fonts/`, with the licence text in `player/fonts/OFL.txt`. The video uses OFL fonts only, never SF Pro.
- **Playwright** (Apache-2.0) and **yaml** (ISC) are dev-only dependencies of this folder.

## Manual QA before shipping a new render

- [ ] `npm run qa`: look at `build/qa/contact.png` and at each `scene-NN.png` at full size for clipped text, overflow, misalignment and overlaps. The A/V check must report worst |onset − line start| ≤ 0.12 s.
- [ ] It plays **with sound** in the Extension Development Host on macOS, Windows and Linux (it starts with sound; if an editor blocks that, the panel shows **Turn on sound**).
- [ ] It falls back gracefully in VSCodium, with the poster, "Watch in your browser" and the transcript.
- [ ] Captions line up with the voice, including after seeking.
- [ ] `npm test` here, and `npx vitest run test/unit/gettingStartedMedia.test.ts` at the repo root.
