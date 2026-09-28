---
name: make-video
description: Make or edit a narrated, captioned 1080×1350 promo/explainer video for ERD Studio with the social-video/ pipeline (Kokoro voice, synth music, HTML scenes captured frame by frame, ffmpeg encode). Use when the user asks to make a new video, a new cut or version of the LinkedIn explainer, or to change an existing video's script, scenes, voice line, captions or end card, or runs /make-video.
---

# Make a video

Everything lives in `social-video/`: read its `README.md` first, then `script.yaml` (the format
is documented in its header) and `SCENES.md` (the rules every scene follows). The two finished
cuts are the worked examples: **pro** (`script.yaml`, `player/scenes/*.js`) and **simple**
(`script.simple.yaml`, `player/scenes/simple/*.js`). A new video is a new `VARIANT`:
`script.<v>.yaml` + `player/scenes/<v>/*.js` → `build-<v>/` → `out/erd-studio-explainer-<v>.*`.

## Steps

1. **Agree the story first.** Get the hook (first 3 s must work muted, frame 0 is the thumbnail),
   the audience and the target length (≤ 90 s for a feed). Draft the narration in chat before
   building anything.
2. **Write `script.<v>.yaml`.** Copy the structure of `script.simple.yaml`. Keep headline lines
   ≤ ~26 characters; mark caption breaks with ` | ` and accent words with `{…}`; quote any
   caption containing `: `; put a respelling in `say:` if the voice misreads a word. Scenes can
   reuse shared modules (`stars`, `endCard` with `props.tagline`) if their beat names match.
3. **Voice and timeline:**
   ```bash
   cd social-video
   VARIANT=<v> uv run tts.py && VARIANT=<v> node build-timeline.mjs   # prints each scene's start and beats
   ```
   The first run downloads the Kokoro model (~330 MB) into `build/models` if it is missing.
   Word positions inside a clip: `ffmpeg -hide_banner -i build-<v>/voice/<id>.wav -af silencedetect=noise=-35dB:d=0.06 -f null -`.
4. **Scenes.** One file per scene in `player/scenes/<v>/`, `export default { render(t, { beats, scene }) }`,
   pure (no timers/random/CSS animation), inside `FRAME.stage`, helpers from `../../lib.js`.
   Check stills as you go: `VARIANT=<v> node capture.mjs --stills 3.2,41 --out build-<v>/stills/x`
   and look at the PNGs. For more than ~4 scenes, write a `SCENES.<v>.md` brief and fan out
   subagents (three scenes each; each edits only its own files, never lib.js/style.css/main.js).
5. **Render and check:** `VARIANT=<v> npm run all` (or `uv run music.py`, `node capture.mjs`,
   `bash encode.sh` separately, all with `VARIANT=<v>`), then `VARIANT=<v> bash qa.sh` and read
   `build-<v>/qa/contact.png`. QA must report worst A/V onset ≤ 0.12 s.
6. **Save.** Copy only a render you mean to post into `renders/`
   (`cp out/erd-studio-explainer-<v>.* renders/`). Each committed mp4 is ~10–15 MB of permanent git
   history. Commit through a PR; `deploy.yml` ignores `social-video/**` and `.claude/**`, so a
   video-only PR never publishes an extension release (check the PR touches nothing else).

## Facts every video must get right

- Licence is **PolyForm Shield 1.0.0**: never say "open source" or "MIT". "Free" applies to the
  **VS Code extension** only; never state or imply a price for ERD Studio for Confluence.
- No specific GitHub star counts on screen (the `stars` scene shows the real curve, no numbers).
- Show the product truthfully: real UI labels (Logical / Physical / Diff, `{ } View File`,
  "Semantic Domain Editor"), real file formats (`docs/semantic-domain-json-reference.md`, where
  `dataType` is required). Confluence shots are real `ErdCanvas` renders; re-shoot them with
  erd-studio-pro's harness (see the header of `player/scenes/business.js`).
- No third-party logos or emoji; the fonts have no arrows or check marks, so use `ICON.*`.
- Don't put on-screen text that repeats the burned-in caption word for word.
