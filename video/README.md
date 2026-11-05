# Getting-started video and README GIF

Source and render pipeline for the one-minute getting-started tours (**Watch the One-Minute Tour**) and the README's hero GIF. Both tours are the same DBML tour of the logical model, scene for scene; the default cut adds one short dbt beat before its end card. **The default cut is a recording of the real VS Code** (ERD Studio built from this checkout, driven by `record/`, see [Recording the default cut](#recording-the-default-cut)) set into the same frame as the logical cut, which is still drawn in HTML. Both are voice only: there is no background music. They are picked with `VARIANT` (`build-timeline.mjs` `CUTS` lists them):

| Cut | `VARIANT` | Script | Build folder | Plays where | Length |
|---|---|---|---|---|---|
| default (recorded) | unset | `script.yaml` | `build/` | the README link, and the Welcome panel in a dbt project (its `dbt` page) | 57.5 s (the dbt beat 8 s) |
| logical | `logical` | `script.logical.yaml` | `build-logical/` | the Welcome panel in a folder without `dbt_project.yml` and in an empty window (`logical`, `nofolder`) | 51.9 s |

**The default cut** (`script.yaml`, `record/scenes.mjs`): the same scenes, filmed. The hook is the finished `orders` diagram beside its `.erd-studio/main/…/*.dbml` files in the Explorer; then the Extensions view (`@installed`, ERD Studio), the plain folder in the Explorer and a click on ERD Studio's icon, which shows the Diagrams view's start entry and the coffee-shop example a folder's first visit opens; **New Diagram…** and its name box; **New Table** twice (`dim_date` from the Dimension starter columns, `fct_order` from Fact) and **New Relationship** (fct_order.date_key → dim_date.date_key, filled in by itself; "then link the two with a relationship" is its own cue, spoken as the dialog opens), then **Fit**; the Explorer's `tables/main/fct_order.dbml` opened as DBML text; the diagram's **Export Diagram…** pick (Mermaid, DBML, Rich DBML), then the Diagrams view's + → **Import DBML…** on `sales.dbml`, its name box, its draft and **Keep as Diagram**; Help & Feedback → **Set Up My AI Helper** and its "AI helper ready for …" toast (the line says "then start the guided setup in your assistant", as the toast does; the logical cut, which shows `/erd-studio-setup` typed, says that instead); and, in a second take in a dbt project, the **Logical · your design** / **Physical · read from dbt** tabs and **Compare with dbt** ("only here", the Logical/Physical type lines, "Only in Physical", the comparison panel, with a punch-in on fct_order and the panel so their small text reads). The end card is HTML (`tour/endCard`, both cuts'); its search hint names the Marketplace id, `liamwynne.erd-studio`, because a search for "ERD Studio" also lists an unrelated extension.

**The logical cut** (`player/scenes/tour/`, HTML): the hook (a plain folder whose `.erd-studio/main/tables/main/*.dbml` files fly into a diagram); install, open a folder and click the ERD Studio icon, which shows the Diagrams view's start entry ("No diagrams yet.", **New Diagram…**, "Or: More ways to start…"; no Table Library or Relationships view yet, as there is no `.erd-studio`) beside the example draft a folder's first visit opens (the walkthrough opens by itself only in an empty window); **New Diagram…** and its name box, after which the side bar lists the folder's one layer (Main › orders, **New Layer…**) and the empty Table Library; two tables from **New Table** and a relationship from **New Relationship** (fct_order's FK badge arrives with it); the layer-first DBML files that writes (`main/diagrams/orders.dbml`, `main/relationships/main.dbml`, `main/tables/main/<table>.dbml`, `layers.json`, `README.md`), their text exactly as ERD Studio formats it; **Export Diagram…** and the Diagrams view's + menu → **Import DBML…**, which picks `sales.dbml`, asks only the name (one layer, so no layer question) and ends on its draft (nothing saved until **Keep as Diagram**); **Set Up My AI Helper** from Help & Feedback and `/erd-studio-setup`; the end card. Every canvas in the tour is drawn as a plain folder draws it: neutral grey tables and lines, no stage colours. Its layer is the one a new folder without dbt really gets, **Main** (`src/services/layerService.ts` `NEW_PROJECT_LAYERS_WITHOUT_DBT`), as the recorded cut shows: no layer badge on the canvas or its toolbar (a single-layer project), MAIN on a draft page's tables. Its activity bar draws the real ERD Studio icon (`media/icon-sidebar.svg`, inlined in `player/editor.js`), as does the README GIF.

dbt is an add-on: the logical cut never names it, and the default cut names it only in its dbt beat. Each script's header lists the words to keep out, and `npm test` checks both scripts, every `tour/` module's source, every rendered frame of the logical cut and, for the default cut, the text that was on screen while each scene was filmed (`record/takes.json`).

Help & Feedback, the walkthrough's `watch` / `watchLogical` steps and **Watch the One-Minute Tour** call these "one-minute" videos; keep each between 50 and 65 s (`maxDuration`), ideally about 60, or reword them. Nothing in this folder ships: `.vscodeignore` excludes `video/**`, and nothing in `esbuild.js`, the tsconfigs or the root vitest run refers to it. Each cut writes its committed outputs (plus, for the default cut, the README copy and thumbnail, see [Thumbnail](#readme-thumbnail)):

| Output | Used by |
|---|---|
| `media/onboarding/getting-started.mp4` | the Welcome panel's `<video>` on the dbt page (ships) |
| `media/onboarding/getting-started-poster.jpg` | the poster and the "can't play here" fallback (ships) |
| `docs/assets/getting-started.mp4` | the README's link: the same video with **AAC** audio, because Safari and QuickTime play MP3-in-MP4 silently (not shipped; `docs/**` is excluded from the VSIX) |
| `src/types/gettingStartedTranscript.ts` | `GETTING_STARTED_CUES` (the panel adds them as `VTTCue`s) and `GETTING_STARTED_TRANSCRIPT` (the **Transcript** section). Generated; do not edit by hand. |
| `media/onboarding/getting-started-logical.mp4`, `-poster.jpg` | the logical cut and its poster (ship) |
| `src/types/gettingStartedLogicalTranscript.ts` | `LOGICAL_GETTING_STARTED_CUES` and `LOGICAL_GETTING_STARTED_TRANSCRIPT`, the same shapes for the logical cut. Generated. |
| `media/demo.gif` | the README's hero GIF (`npm run gif`, see [README GIF](#readme-gif); not shipped) |

`video/getting-started.vtt` (and `getting-started-logical.vtt`) is the same captions as WebVTT, kept as a source artefact for review and for uploading next to the video elsewhere. It is not shipped.

Style reference: `docs/assets/erd-studio-linkedin.mp4` (thumbnail beside it). Colour tokens come from it and from `scripts/social-preview.html`.

## Prerequisites

- **ffmpeg 7 or later** built with `libx264` and `libmp3lame`. Homebrew's build has both. Check with `ffmpeg -encoders | grep -E 'libx264|libmp3lame'`.
- **Node 18 or later**, then in this folder run `npm install` and `npx playwright install chromium`. Capture uses Playwright's bundled Chromium rather than your installed Chrome, so frames do not change when Chrome updates.
- **uv** (<https://docs.astral.sh/uv/>). `tts.py` declares its Python dependencies inline, so `uv run tts.py` builds its own environment on the first run. It needs Python 3.10 to 3.12.
- The Kokoro model files, about 330 MB. `tts.py` downloads `kokoro-v1.0.onnx` and `voices-v1.0.bin` into `build/models/` on the first run. Set `KOKORO_MODEL_DIR` to reuse a copy you already have.

## Regenerate

```bash
cd video
npm run all        # tts → timeline → capture → composite → encode (also writes the AAC copy, build/getting-started-share.mp4 → docs/assets/getting-started.mp4)
                   # the default cut needs its footage first: npm run record, after timeline (see Recording the default cut)
npm run qa         # contact sheet + per-scene stills in build/qa/, and the A/V onset check
npm test           # pipeline self-tests (node:test), incl. that every HTML mock (the logical cut, the GIF)
                   # uses the real product copy: the extension listing, the side bar's views, start entry,
                   # + menu and Help & Feedback rows (package.json, src/types/startActions.ts,
                   # HelpTreeProvider.ts), the example and Import DBML drafts (src/services/draftModel.ts,
                   # webview-draft/), the New Diagram name box, the New Table / New Relationship dialogs,
                   # the toolbar and stage tabs (webview/), Export Diagram (src/commands/exportDiagram.ts)
                   # and the setup command (src/types/aiAssistants.ts, the setup skill); and, for the
                   # recorded cut, that each scene was filmed for its length with its clicks done in time
                   # and showed the labels its line names (record/takes.json). Reword any of them and the
                   # video must be re-rendered (the default cut re-recorded).
npm run thumbnail  # docs/assets/getting-started-play.jpg, the README's play-button image
npm run gif        # media/demo.gif, the README's hero GIF (no audio, no timeline needed)

npm run all:logical   # the logical-first cut: the same steps with VARIANT=logical (build-logical/ in and out;
                      # its AAC share copy stays in build-logical/, the README links none)
npm run qa:logical    # build-logical/qa/contact.png, stills and the A/V check
npm run preview:logical
```

Every step reads `VARIANT` (`tts.py`, `build-timeline.mjs`, `capture.mjs`, `encode.sh`, `qa.sh`; the player takes `?variant=logical`). The Kokoro model and the short espeak copy stay in `build/` for both cuts. A scene's `props` (a map in the script) reaches its module as `ctx.scene.props`.

| Step | Command | What it does |
|---|---|---|
| tts | `uv run tts.py` | Voices each `lines[].say` (or `caption`) from `script.yaml` into `build/voice/<id>.wav`. A line is re-voiced only when its text, voice, speed or engine changed. |
| timeline | `node build-timeline.mjs` | Lays the scenes out from the **measured** clip durations, then writes `build/timeline.json`, `build/narration.wav` (two-pass loudnorm to −16 LUFS / −1.5 dBTP, 48 kHz mono), `getting-started.vtt` and `src/types/gettingStartedTranscript.ts`. It fails if the total is over `maxDuration` (65 s). |
| record | `node record/record.mjs` | The default cut only: films the real VS Code, scene by scene, on the timeline's beats (see [Recording the default cut](#recording-the-default-cut)). Writes `build/rec/` and `record/takes.json`. |
| capture | `node capture.mjs [--draft] [--jobs N] [--scale 0.6667]` | Renders every frame of `player/` at 1920×1080 and 30 fps and pipes it into a lossless master, `build/master.mkv` (for a recorded cut, the frame alone: `build/chrome.mkv`). `render(t)` is pure, so `--jobs` renders ranges in parallel and concatenates them. `--draft` pipes JPEG q95 instead of PNG. `--stills 3.2,41` writes single frames to `build/stills/`. |
| composite | `node record/composite.mjs` | The default cut only (a no-op for the logical cut): lays the footage on the video's clock (`build/recording.mkv`), cross-fading where it jumps, draws the pointer, applies `recording.zoom`, and lays it over `build/chrome.mkv` at `recording.inset`, fading it in and out with the frame, into `build/master.mkv`. |
| encode | `bash encode.sh` | Produces the mp4 and the poster from `build/master.mkv` and `build/narration.wav`. The audio is the narration alone: there is no background music, so nothing is mixed under the voice and the loudness is the timeline step's −16 LUFS. It then asserts them with ffprobe (see *Size budget and checks*). `--placeholder` makes a 2-second test pattern through the same path. |

The timeline rules are that a scene starts where the previous one ends, and its first line starts `timing.lead` (0.35 s) into it. Every later line starts `timing.gap` (0.2 s) after the one before, or after the line's own `pause` if it sets one. A scene lasts `max(minDur, lastLineEnd + tail)`. Each line's `beat` becomes `beats.<name> = { t, end }` in scene-local seconds, and the scene modules key every animation off those values. That means editing a line and re-running `tts` and `timeline` moves the visuals with the voice. Some beats sit a fixed offset after a line starts so they land on a particular word, for example the pointer clicking the ERD Studio icon on "…its icon". Those offsets are commented in the scene module. If you reword a line, check them with `npm run preview`.

### Preview

```bash
npm run preview    # serves the repo root on 127.0.0.1:4173
```

- `http://127.0.0.1:4173/video/player/index.html?preview=1` plays the narration and drives `t` from `audio.currentTime`. Click to play or pause, and use ←/→ to seek 5 s.
- `…/index.html?t=42.5` freezes on one frame.

The player is plain ES modules. `main.js` owns the persistent chrome (kicker, headline, chapter bar) and reads `package.json`'s description once, for the extension listing; for a recorded cut (`timeline.recording`) it sets `body.rec`, a smaller headline and a lower chapter bar that leave the window room, and keeps the window still across recorded scenes (only the headline fades). Each `player/scenes/<folder>/<module>.js` exports `render(localT, { beats, dur, scene })` and returns HTML: `tour/` holds the logical cut's scenes (and the end card both cuts use), `rec/window` the bezel the default cut's footage plays in and the hook's claim pills. `lib.js` holds the shared pieces: the node card, the canvas toolbar (logical-only, or with the stage tabs and Compare), edges, the pointer and the easing helpers. `editor.js` holds the VS Code window every scene plays in: the activity bar (its ERD Studio item is the real `media/icon-sidebar.svg`, inlined), the Explorer and its file tree, ERD Studio's side bar (Diagrams with its start entry or its tree, Table Library, Relationships, Help & Feedback, the + menu), the draft page (the example and an Import DBML… draft), the QuickPick shell, and the product copy the tests check. There are no CSS transitions, `@keyframes`, timers or randomness anywhere, and `npm test` enforces that.

## Recording the default cut

The default cut's footage is the real VS Code with ERD Studio built from this checkout, filmed scene by scene on the narration's beats. Everything lives in `record/`, nothing in it ships, and none of it touches your own VS Code.

```bash
cd video
npm run tts && npm run timeline   # the beats the clicks are timed to (build/timeline.json)
npm run record:setup              # once, and after every product change: builds the VSIX (vsce runs npm run package)
                                  # and installs it into the isolated profile
npm run record                    # both takes (about 2 minutes; a VS Code window opens and closes twice)
npm run capture && npm run composite && npm run encode
npm run thumbnail && npm run qa && npm test
```

`node record/record.mjs --dry` drives every scene without filming (to check selectors and timing), `--take plain` or `--take dbt` records one take, and `REC_DEBUG=1` logs each click. Each scene prints how long its clicks took; one that runs past its scene, or a click more than 0.6 s late, fails `npm test`: raise that scene's `minDur` in `script.yaml` (the tour must stay 50–65 s, ideally about 60) or tighten its clicks in `record/scenes.mjs`, then re-run `timeline` and `record`. **Any change to the narration (tts, timeline) needs a new recording**, because each scene is filmed for exactly its timeline duration; `composite` refuses footage filmed for another length.

| File | Role |
|---|---|
| `record/vscode.mjs` | The isolated VS Code: `--user-data-dir` and `--extensions-dir` under `/tmp/erdrec` (short, because macOS caps the Unix socket path inside a profile), CDP on port **9555** (never 9333, which other tools share; the launch checks the port belongs to this profile), `--use-mock-keychain` (no "Code Safe Storage" prompt) and the no-backgrounding flags. `launch(folder)` resets the profile to a first run every time: the settings below, no workspace storage, ERD Studio's state as just installed (no example shown yet) minus the Show Me Around guide, whose coach marks would cover the canvas, and a 1440×600 window. `quit()` signals only the processes whose command line names this profile. |
| settings | Dark Modern, no welcome page, tips, AI/chat UI, Copilot, minimap or Git decorations, `telemetry.telemetryLevel: off`, `erdStudio.telemetry.enabled: false`, and DOM menus, dialogs and file picker (`window.menuStyle` / `window.dialogStyle: custom`, `files.simpleDialog.enable`): the screencast films only the page, never a native menu. |
| `record/fixtures.mjs` | Writes the two folders fresh before each take, under `/tmp/erd-tour` (the Import DBML picker shows the path, so it is short and free of any home path): `shop-analytics`, a plain folder with nothing to import (`sales.dbml` is dropped in just before the import scene), and `dbt/shop-analytics`, a dbt project whose `.erd-studio` is what the plain take writes for `orders`, whose schema yml differs on purpose (no `event_date`, `amount` NUMBER(12,2), an extra `order_status`) and whose `target/manifest.json` comes from a real `dbt parse` (dbt-duckdb 1.9.4 through `uvx`, with a throwaway profile outside the project). |
| `record/driver.mjs` | CDP without dependencies. The pointer glides (eased) to each target and a ripple drawn in the workbench marks each click. The pointer itself is not filmed: every glide is logged (`d.trail`, saved as `build/rec/<take>/pointer.json`) and `composite` draws it on the video's 30 fps clock, because the screencast's ~25 frames a second made a filmed pointer judder (`REC_PAGE_POINTER=1` shows it in the page for a dry run). `hover: false` glides without moving the real mouse (the hook points at Explorer rows without opening their path tooltips); `drag()` moves a node (not the canvas: React Flow's pan misses CDP's release and keeps panning); clicks are trusted mouse events at the target's centre, so they reach the webviews (out-of-process iframes: a target's rect is offset by its `iframe#active-frame`), and keys go to whatever has focus. `wb(selector)` targets the workbench (shadow roots included, where VS Code draws its menus), `wv(selector)` the visible webviews. A `<select>` is set the way React sees a pick (macOS draws native select menus outside the page). `screenText()` reads the text a viewer can see. |
| `record/scenes.mjs` | Each scene's clicks keyed to its beats, and the two takes: `plain` (install, newDiagram, tables, files, then the hook, filmed last and cut to the front, then importDbml and enrich) and `dbt`. Off-camera `prep` sets a scene up (the Extensions view filtered to `@installed`; for the hook, fct_order dragged right so the relationship reads, then Fit and nothing selected; the dbt project's diagram open, its first-open toast closed). |
| `record/screencast.mjs` | Films with `Page.startScreencast`: the compositor pushes a JPEG on every repaint, already scaled to the 1728×720 inset (1.2× the window's CSS size at devicePixelRatio 2); a still window sends nothing and the last frame holds. |
| `record/record.mjs` | Per take: fixtures, launch, prep, then each scene filmed for exactly its timeline duration (`at(s)` waits for s seconds into the scene before a click), the visible text sampled about every 0.6 s. Writes `build/rec/<take>/` (frames, `frames.jsonl`, `scenes.json` with each scene's start mark, `pointer.json`) and `record/takes.json`. |
| `record/takes.json` | Committed, small: per scene its take, length, when its clicks finished, how late any ran, and the text that was on screen. `npm test` checks it: dbt words only in the dbt beat, and each scene shows the product labels its line names. |
| `record/composite.mjs` | Lays the footage on the video's clock (at each 1/30 s the latest frame painted by then, from the scene's own mark; the JPEGs' full range converted to the frame's limited range). Where the footage jumps (the hook, filmed after `files`; the next take) it cross-fades over 10 frames instead of cutting. It draws the pointer from `pointer.json` (an ffmpeg expression in `t`, exact at every frame), dissolves into `recording.zoom` (the dbt beat: fct_order's marks and the comparison panel at 1.35×, from 1.5 s after "Click Compare with dbt" to the scene's end), then lays the result over the rendered frame at `script.yaml`'s `recording.inset` (x 96, y 240, 1728×720), fading in and out where the frame does. |

The raw takes (about 2,700 JPEGs, ~370 MB) stay in `build/rec/`, which is gitignored. Recording needs macOS with VS Code in `/Applications` (or `VSCODE_BIN` / `VSCODE_CLI`), `sqlite3`, `uv` and a screen: the window opens for real, though nothing outside it is filmed.

## Voice

The default is Kokoro v1.0 voice **`af_heart`** at speed 1.04 (set in `script.yaml → voice`). Kokoro has no Australian voice. `af_heart` was the clearest of the voices auditioned (`af_heart`, `af_bella`, `af_nicole`, `bf_emma`, `bm_george`, `am_michael`), and `bf_emma` is the closest non-American alternative.

- To audition another voice: `uv run tts.py --voice bf_emma --force && node build-timeline.mjs`.
- To switch permanently, edit `voice.kokoro` (and `speed`, anywhere from 0.95 to 1.05) in `script.yaml`.
- For a fallback without Kokoro, use macOS `say -v Karen -r 175` (en-AU): `npm run tts:say`. It is genuinely Australian but noticeably more robotic.

Kokoro has two environment traps, and `tts.py` handles both:

1. It needs **`phonemizer-fork`**, not `phonemizer`. kokoro-onnx 0.6 calls `EspeakWrapper.set_data_path`, which only the fork has.
2. **espeak-ng silently truncates a long data path.** The buffer is about 160 bytes, and the `espeak-ng-data` bundled inside site-packages is usually deeper than that. The result is silence or garbled phonemes, with no error. `tts.py` copies the data once to a short directory, `build/ed`, or a temp directory if even that path is over 100 characters. It passes that directory explicitly through `EspeakConfig(lib_path=…, data_path=…)`.

### Pronunciation

Captions show the real text. When the voice needs something different, the line's `say` field carries a respelling. Kokoro's own G2P already reads most of the vocabulary correctly. These were checked against its phoneme output:

| Written | Kokoro reads it as | Respelling used |
|---|---|---|
| ERD Studio | "E-R-D studio" | none needed |
| DBML | "D-B-M-L" | none needed |
| Mermaid | "mermaid" | none needed |
| dbt | "D-B-T" | none needed |
| YAML | "yammel" | none needed |
| SQL | "S-Q-L" | none needed |
| AI | "A-I" | none needed. Do **not** write "A I", which reads as "a eye". |
| `/erd-studio-setup` | "erdstudiosetup" | `slash ERD studio setup` |

To check a new word, run `from kokoro_onnx.tokenizer import Tokenizer` and `Tokenizer(...).phonemize("word", "en-us")`.

## Size budget and checks

- **Codec:** MP4 container, **H.264** High profile, yuv420p, `+faststart`, with **MP3** audio (64 kbps, mono, 44.1 kHz): the audio codec VS Code's webview guide documents for video. VS Code's bundled ffmpeg has **no AAC decoder**, so AAC audio plays silently. Opus-in-MP4 shipped first and a user heard no voice, so stay on MP3. Never switch the audio to AAC.
- **Ceiling: 8 MB** (8 MiB) for the mp4, and 65 s for the timeline. `encode.sh` tries CRF 20, then 22, 24 and 26, and fails if the file is still over. The GOP is 150 frames (5 s). The content is mostly static UI, and the longer GOP roughly halves the size at the same CRF compared with 2 s keyframes. The current renders are 4.9 MiB (default cut, recorded, 57.5 s) and 4.3 MiB (logical cut, 51.9 s) at CRF 20, well under the ceiling.
- `encode.sh` asserts: `h264` / `High` / `yuv420p`, `mp3` / 44100 / mono, size ≤ 8 MB, duration within 0.25 s of the timeline, the moov atom before mdat, and a 1280×720 JPEG poster.
- `test/unit/gettingStartedMedia.test.ts` (root vitest) re-checks the shipped files: the two cuts' videos and posters in `media/onboarding/`, ≤ 8 MB, cues ending by 65 s, faststart, an MP3 track (esds object type 0x6B, not AAC), a JPEG poster, and well-formed cues.
- The poster is the opening (hook) scene's last frame, once every element has landed (for the default cut a real frame: the finished diagram and its files): never the end card, whose "Install ERD Studio" chip reads wrong in an editor that already has it.

## README GIF

`npm run gif` (`hero-gif.mjs`) renders `media/demo.gif`, the README's hero image, from `player/hero.html` + `player/hero.js`: the same editor pieces as the video, laid out at 1440×900 and drawn frame by frame (`render(t)` is pure, so every run gives the same GIF). It shows ERD Studio in a plain folder (no stage tabs, neutral grey tables and lines, nothing about dbt), the Explorer's layer-first `.erd-studio/main/tables/main/*.dbml` tree (in VS Code's order, with `sales.dbml` in the folder's top level) beside the orders diagram (a `fct_order` star with its keys); the table files light one by one with their tables, `fct_order.dbml`'s formatted text shows, then `sales.dbml` lights and the editor switches to Import DBML…'s draft of it (its summary and **Show details**, before anything is written; none of its tables is already in the library, so nothing is reused) and back. A 12 s seamless loop at 12 fps, scaled to 800 px wide (the README shows it at `width="800"`), one palette for the loop, no dithering, only each frame's changed rectangle stored: about 0.66 MB. `npm test` renders every quarter second of the loop and fails on any dbt word or a blue table border. The script fails over 2 MB. `node hero-gif.mjs --frames 0.5,8` writes stills to `build/hero/` for review. Re-render it when the canvas, the side bar, the draft page or the file layout changes, and look at it.

## README thumbnail

`npm run thumbnail` (`thumbnail.mjs`) renders `docs/assets/getting-started-play.jpg`, the image the README links to the video with: 1280×720 JPEG, under 300 KB (the script lowers the quality until it fits, and fails if it cannot). The page is `player/thumbnail.html`: the tables scene's last frame (for the recorded default cut a real frame, taken from `build/recording.mkv` into `build/thumb-bg.png`; run it after `npm run composite`), scaled up, softened and dimmed behind a large play button dead centre, the headline "Get started in N seconds" (the timeline's total rounded to the nearest 5 s) and a duration pill with the real m:ss, both read from `build/timeline.json`. Run it after every render that changes the length or the canvas, and look at the result.

## Licences

- **Kokoro-82M** model and voices: Apache-2.0 (hexgrad/Kokoro-82M; ONNX export from thewh1teagle/kokoro-onnx, MIT). **Re-verify both before each release that re-voices the video.**
- **espeak-ng** (via `espeakng-loader`): GPL-3.0. It is used only as a build-time tool, and neither it nor any of its output ships except as rendered audio.
- **Fonts:** Inter and JetBrains Mono, SIL Open Font License 1.1. They are in `player/fonts/`, with the licence text in `player/fonts/OFL.txt`. The video uses OFL fonts only, never SF Pro.
- **Playwright** (Apache-2.0) and **yaml** (ISC) are dev-only dependencies of this folder.

## Manual QA before shipping a new render

- [ ] `npm run qa` (or `npm run qa:logical`): look at `build/qa/contact.png` (`build-logical/qa/contact.png`) and at each `scene-NN.png` at full size for clipped text, overflow, misalignment and overlaps. The A/V check must report worst |onset − line start| ≤ 0.12 s.
- [ ] It plays **with sound** in the Extension Development Host on macOS, Windows and Linux (it starts with sound; if an editor blocks that, the panel shows **Turn on sound**).
- [ ] It falls back gracefully in VSCodium, with the poster, "Watch in your browser" and the transcript.
- [ ] Captions line up with the voice, including after seeking.
- [ ] `npm test` here, and `npx vitest run test/unit/gettingStartedMedia.test.ts test/unit/gettingStartedPanel.test.ts` at the repo root.
- [ ] After `npm run gif`, open `media/demo.gif` and watch one full loop.
