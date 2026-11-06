# Getting-started video and README GIF

Source and render pipeline for the getting-started tours (**Watch the Tour**) and the README's hero GIF. **The default cut is a recording of the real VS Code in its light theme** (ERD Studio built from this checkout, driven by `record/`, see [Recording the default cut](#recording-the-default-cut)), set into a light frame (headline, chapter bar, end card) that matches it. The logical cut is the same recording without the dbt beat: it plays the default cut's plain-folder take on its own narration (`recording.footage`, see [The logical cut](#the-logical-cut)). Both are voice only: there is no background music. They are picked with `VARIANT` (`build-timeline.mjs` `CUTS` lists them):

| Cut | `VARIANT` | Script | Build folder | Plays where | Length |
|---|---|---|---|---|---|
| default (recorded) | unset | `script.yaml` | `build/` | the README link, and the Welcome panel in a dbt project (its `dbt` page) | 137.6 s |
| logical (the default cut's footage) | `logical` | `script.logical.yaml` | `build-logical/` | the Welcome panel in a folder without `dbt_project.yml` and in an empty window (`logical`, `nofolder`) | 116.0 s |

**The default cut** (`script.yaml`, `record/scenes.mjs`) leads with the data model people already have, and shows both ways to edit it, by hand and with an AI assistant:

| Chapter | Scene | What is filmed |
|---|---|---|
| — | `hook` | the finished `sales` diagram beside its `.erd-studio/main/…/*.dbml` files; claims "DBML files in Git", "By hand or with AI"; the Explorer without its Outline and Timeline sections, so the whole tree shows; the pointer comes in from past the window's right edge to the files and leaves again, so the poster (the scene's last frame) has none (filmed last, cut to the front) |
| 1 · IMPORT | `bring` | the project folder (`pipelines/`, `sales.sql`: Snowflake's `GET_DDL` export) with the DDL open; ERD Studio's start entry ("This folder has CREATE TABLE scripts."), **More ways to start…**, **Import…**; a row of the tools a model lives in (Snowflake, Databricks, dbt, Power BI / Fabric, SQL; Fabric is named beside the Power BI icon, with no mark of its own) right of the headline (`props.logos`, `player/assets/logos/`, LOGOS.md) |
| | `importSql` | Import…'s rows (DBML, SQL DDL scripts, Power BI or Fabric), **SQL DDL scripts**, `sales.sql` in the file dialog, **Snowflake** (detected) |
| | `draft` | the name box, the draft ("Draft from 1 SQL file (Snowflake) · 4 tables, 3 relationships · not saved"), **Keep as Diagram** |
| 2 · SAVE | `files` | the Explorer: `.erd-studio/main/tables/main/fct_order.dbml` opened as DBML, beside `pipelines/` (its last line, "Change it, and Git shows exactly what changed.", sets up the pull request without saying it; its `minDur` pins the length the take was filmed for) |
| 3 · EDIT | `byHand` | **+ Add** → **New Table** `dim_promotion` with Dimension starter columns, then **Layout** and **Fit** ("Every edit is saved to its file." plays while it settles) |
| | `aiSetup` | Help & Feedback → **Set Up My AI Helper** and its "AI helper ready for Claude Code" toast; right of the headline, "Works with" and the assistants it sets up (`props.assistants`: `src/types/aiAssistants.ts`'s names; shown, not said, and the pre-tool hook is claimed only for Claude Code) |
| | `aiRun` | Claude Code in the integrated terminal (on the right) asked "Add a dim_customer table, linked to fct_order": it loads the `erd-studio` skill by itself, edits the `.dbml` files, the diagram updates; the wait sped up (`props.fastForward`), with a "Sped up N×" badge (the real speed, to one decimal: 2.2× in the current take); then **Layout**, **Fit**, and the new table held in the open for about 2 s |
| | `aiShow` | HTML (`tour/aiChange`, both cuts'): the change held for 9.6 s. A still of `aiRun`'s last frame where the footage was (`props.still: aiRun`; `player/assets/still-aiRun.jpg` and the drawn pointer's place on it, `still-aiRun.json`, written by `npm run still`), so the cut from the footage is invisible: composite cuts to it with no fade and main.js keeps the window still. The pointer glides off; a card over the terminal shows what Claude Code wrote, word for word (`CHANGE`: the new `dim_customer.dbml`, the `use` and `Ref` lines it added to the relationships file; `npm test` checks them against the take's terminal and `record/fixtures.erd.mjs`), each part lighting with its mark on the canvas (the new table ringed, its relationship traced); then the canvas punches in (1.5×) on the new table and its relationship, with "Added by your AI", held about 1.9 s in silence after the line (the still is the inset-size frame, so the punch-in is a little soft; the take keeps no 2x frames). `NEW_TABLE`, `LINK` and `FK_ROW` are measured on the still: check them after a new take of `aiRun` |
| | `pr` | HTML (`tour/pullRequest`, both cuts'): "One pull request: the design and the code." A light code review's **Files changed** (the GitHub mark only: no repo address, user or number): left, the `.dbml` lines the AI wrote; right ("SQL and Python, in pipelines/"), `pipelines/dim_customer.sql`, the SQL that builds the table, and `pipelines/load_orders.py` (collapsed, +1), the loader the folder already has, filling `fct_order`'s new key: 6 files, +21, in the tour folder's own code folder; then "Changes approved" and **Merge pull request** on "reviews both together" |
| 4 · COMPARE | `dbt` | a second take in a dbt project holding the same files: the Diagrams view's **New…** menu with **Import from dbt…** pointed at, beside the other imports (how a dbt project becomes a diagram; not run, the diagram exists), the side bar closed and the diagram fitted to the width, **Run dbt parse** (real dbt Core in its terminal, closed as soon as it finishes), **Open Physical view** held for about 4 s (its line and a 1.2 s pause), **Logical**, **Compare with dbt**, with a punch-in on the comparison panel |
| 5 · SHARE | `confluence` | HTML (`tour/confluence`): the repo's `.dbml` files beside a light Confluence page carrying a real render of the diagram as the ERD Studio for Confluence macro draws it (read-only, from GitHub; `confluence-shot.mjs`); its "For business users" pill lands 1.4 s after the page, and the scene holds about 1.3 s after its last line |
| — | `end` | HTML (`tour/endCard`, both cuts'): little to read, so it lands at once: the icon, **ERD Studio**, one line ("Your data model, in Git."), a small "Free to use in VS Code" and the extension id `liamwynne.erd-studio`; nothing about the Confluence app; a silent hold of about 2.4 s after "ERD Studio is free to use in VS Code." |

The narration never says "No AI needed": the tour shows both ways, and the hook says the assistant gets a built-in skill it uses by itself. dbt is named in the import's list of tools and in the dbt beat only; the recording's screen shows it only in the dbt beat.

### The logical cut

**The logical cut** (`script.logical.yaml`) is the default cut's story for a folder without dbt: the same scenes, minus the dbt beat, and its chapters are 1 · IMPORT, 2 · SAVE, 3 · EDIT, 4 · SHARE. It films nothing of its own. The default cut's `plain` take is a project folder with no `dbt_project.yml` (the start entry says "This folder has CREATE TABLE scripts.", and the import picker has no **Import from dbt**), so its footage has no dbt on screen or in the terminal. `recording.footage: default` makes `record/composite.mjs` lay that take (`build/rec/`) on this cut's clock, and it does that only if each recorded scene here has the default cut's length and beats (`checkFootage`), because the take's clicks were timed to those beats. So every recorded scene in `script.logical.yaml` is `script.yaml`'s, word for word, except `bring`. Its first line names no dbt ("…in Snowflake, Databricks, Power BI, Fabric or SQL."), and its logo row has no dbt mark. Its second line's `pause` (0.949 s) puts the `open` beat back at the default cut's 6.564 s, because the new first line is 0.749 s shorter. Kokoro voices the same text identically, so the other lines' clips match. `npm test` checks that the two scripts match like this, and that nothing in the take's on-screen text or terminal names dbt. To change a recorded scene, change it in both scripts, then record the default cut again; `record.mjs` refuses `VARIANT`. The logical cut builds with `npm run all:logical` (tts, timeline, capture, composite, encode) once the default cut's footage is in `build/rec/`.

dbt is an add-on: the logical cut never names it, and the default cut names it only in its import's list of tools and its dbt beat. Each script's header lists the words to keep out, and `npm test` checks both scripts, every `tour/` module's source, every frame the logical cut's HTML draws, and the text that was on screen (and in the terminal) while each scene was filmed (`record/takes.json`).

Help & Feedback, the walkthrough's `watch` / `watchLogical` steps and the command call it **Watch the Tour**, with no length in the name; each cut may run 80–140 s (`maxDuration` 140). The walkthrough's player picture (`media/walkthrough/watch.svg`) shows the default cut's real m:ss; update it with the length. Nothing in this folder ships: `.vscodeignore` excludes `video/**`, and nothing in `esbuild.js`, the tsconfigs or the root vitest run refers to it. Each cut writes its committed outputs (plus, for the default cut, the README copy and thumbnail, see [Thumbnail](#readme-thumbnail)):

| Output | Used by |
|---|---|
| `media/onboarding/getting-started.mp4` | the Welcome panel's `<video>` on the dbt page (ships) |
| `media/onboarding/getting-started-poster.jpg` | the poster and the "can't play here" fallback (ships) |
| `docs/assets/getting-started.mp4` | the README's link: the same video with **AAC** audio, because Safari and QuickTime play MP3-in-MP4 silently (not shipped; `docs/**` is excluded from the VSIX) |
| `docs/assets/getting-started-logical.mp4` | the logical cut's AAC copy, for Safari and sharing (not shipped) |
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
npm test           # pipeline self-tests (node:test), incl. that the README GIF's mock uses the real
                   # product copy (the Import DBML draft: src/services/draftModel.ts, webview-draft/;
                   # the toolbar: webview/; the activity bar icon), that the logical cut's recorded
                   # scenes are script.yaml's, and that each recorded scene was filmed for its length
                   # with its clicks done in time and showed the labels its line names
                   # (record/takes.json). Reword any of them and the default cut must be re-recorded.
npm run thumbnail  # docs/assets/getting-started-play.jpg, the README's play-button image
npm run confluence # player/assets/confluence-sales.png: the Confluence scene's real render (after a plain take)
npm run gif        # media/demo.gif, the README's hero GIF (no audio, no timeline needed)

npm run all:logical   # the logical cut: the same steps with VARIANT=logical (build-logical/ in and out); its
                      # composite plays the default cut's footage (build/rec/), so record that first
npm run qa:logical    # build-logical/qa/contact.png, stills and the A/V check
npm run preview:logical
```

Every step reads `VARIANT` (`tts.py`, `build-timeline.mjs`, `capture.mjs`, `encode.sh`, `qa.sh`; the player takes `?variant=logical`). The Kokoro model and the short espeak copy stay in `build/` for both cuts. A scene's `props` (a map in the script) reaches its module as `ctx.scene.props`.

| Step | Command | What it does |
|---|---|---|
| tts | `uv run tts.py` | Voices each `lines[].say` (or `caption`) from `script.yaml` into `build/voice/<id>.wav`. A line is re-voiced only when its text, voice, speed or engine changed. |
| timeline | `node build-timeline.mjs` | Lays the scenes out from the **measured** clip durations, then writes `build/timeline.json`, `build/narration.wav` (two-pass loudnorm to −16 LUFS / −1.5 dBTP, 48 kHz mono), `getting-started.vtt` and `src/types/gettingStartedTranscript.ts`. It fails if the total is over `maxDuration` (140 s). |
| record | `node record/record.mjs` | The default cut only: films the real VS Code, scene by scene, on the timeline's beats (see [Recording the default cut](#recording-the-default-cut)). Writes `build/rec/` and `record/takes.json`. |
| capture | `node capture.mjs [--draft] [--jobs N] [--scale 0.6667]` | Renders every frame of `player/` at 1920×1080 and 30 fps and pipes it into a lossless master, `build/master.mkv` (for a recorded cut, the frame alone: `build/chrome.mkv`). `render(t)` is pure, so `--jobs` renders ranges in parallel and concatenates them. `--draft` pipes JPEG q95 instead of PNG. `--stills 3.2,41` writes single frames to `build/stills/`. |
| composite | `node record/composite.mjs` | A recorded cut (both): lays the footage on the video's clock (`build/recording.mkv`), cross-fading where it jumps, draws the pointer, applies `recording.zoom`, and lays each run of recorded scenes over `build/chrome.mkv` at `recording.inset`, fading it in and out with the frame (or cutting, with no fade, to a still of it), into `build/master.mkv`. `--stills` (`npm run still`) instead writes the stills HTML scenes draw (`props.still`). |
| encode | `bash encode.sh` | Produces the mp4 and the poster from `build/master.mkv` and `build/narration.wav`. The audio is the narration alone: there is no background music, so nothing is mixed under the voice and the loudness is the timeline step's −16 LUFS. It then asserts them with ffprobe (see *Size budget and checks*). `--placeholder` makes a 2-second test pattern through the same path. |

The timeline rules are that a scene starts where the previous one ends, and its first line starts `timing.lead` (0.35 s) into it. Every later line starts `timing.gap` (0.2 s) after the one before, or after the line's own `pause` if it sets one. A scene lasts `max(minDur, lastLineEnd + tail)`. Each line's `beat` becomes `beats.<name> = { t, end }` in scene-local seconds, and the scene modules key every animation off those values. That means editing a line and re-running `tts` and `timeline` moves the visuals with the voice. Some beats sit a fixed offset after a line starts so they land on a particular word, for example the pointer clicking the ERD Studio icon on "…its icon". Those offsets are commented in the scene module. If you reword a line, check them with `npm run preview`.

### Preview

```bash
npm run preview    # serves the repo root on 127.0.0.1:4173
```

- `http://127.0.0.1:4173/video/player/index.html?preview=1` plays the narration and drives `t` from `audio.currentTime`. Click to play or pause, and use ←/→ to seek 5 s.
- `…/index.html?t=42.5` freezes on one frame.

The player is plain ES modules. `main.js` owns the persistent chrome (kicker, headline, chapter bar); for a recorded cut (`timeline.recording`) it sets `body.rec`, a smaller headline and a lower chapter bar that leave the window room, and keeps the window still across recorded scenes and a still of the footage (`props.still`; only the headline fades). Each `player/scenes/<folder>/<module>.js` exports `render(localT, { beats, dur, scene })` and returns HTML: `rec/window` the bezel both cuts' footage plays in, the hook's claim pills and the import's logo row; `tour/` the HTML scenes, the AI change, the pull request, Confluence and the end card (both cuts'). The drawn tour the logical cut used to be (`tour/hook`, `install`, `newDiagram`, `tables`, `files`, `importDbml`, `enrich`) is retired. `lib.js` holds the shared pieces: the node card, the canvas toolbar, edges and the easing helpers. `editor.js` holds what the README GIF draws of VS Code: the activity bar (its ERD Studio item is the real `media/icon-sidebar.svg`, inlined), an Explorer file tree, the Import DBML… draft page, DBML's syntax colours, and the product copy the tests check. There are no CSS transitions, `@keyframes`, timers or randomness anywhere, and `npm test` enforces that.

## Recording the default cut

The default cut's footage is the real VS Code (Light Modern) with ERD Studio built from this checkout, filmed scene by scene on the narration's beats. Everything lives in `record/`, nothing in it ships, and none of it touches your own VS Code.

```bash
cd video
npm run tts && npm run timeline   # the beats the clicks are timed to (build/timeline.json)
npm run record:setup              # once, and after every product change: builds the VSIX (vsce runs npm run package)
                                  # and installs it into the isolated profile
npm run record                    # both takes (about 4 minutes; a VS Code window opens and closes twice,
                                  # and Claude Code runs once, on your existing login)
node record/fixtures.mjs --capture && npm run confluence   # the design the take wrote: the dbt take's fallback and the Confluence render
npm run still                     # after a new plain take: the AI change's still of aiRun's last frame (player/assets/still-aiRun.*)
npm run capture && npm run composite && npm run encode
npm run thumbnail && npm run qa && npm test
```

`node record/record.mjs --dry` drives every scene without filming (to check selectors and timing; it still runs Claude Code; `--dry --take plain --skip aiRun,hook` leaves scenes out, since aiRun runs Claude Code and the hook needs the table it adds), `--take plain` or `--take dbt` records one take (the dbt take copies the plain folder's `.erd-studio`, or `record/fixtures.erd.mjs` when there is none), and `REC_DEBUG=1` logs each click. Each scene prints how long its clicks took; one that runs past its scene, or a click more than 0.6 s late, fails `npm test`: raise that scene's `minDur` in `script.yaml` or tighten its clicks in `record/scenes.mjs`, then re-run `timeline` and `record`. **Any change to the narration (tts, timeline) needs a new recording**, because each scene is filmed for exactly its timeline duration; `composite` refuses footage filmed for another length.

**Fast-forwards.** A scene with `props.fastForward: { until: [beat, offset] }` (`aiRun`, `dbt`) marks a wait in its take with `ff.start()` / `ff.end()` (Claude Code working, dbt parsing). The take films the wait for as long as it lasts; `composite` plays it in the video between the mark and `until` (`takeClock`), sped up, with a "Sped up N×" badge in the window's title bar, and the take runs on in real time after it. A wait shorter than its window plays in real time (no badge). `record/takes.json` keeps each scene's `ff` (`a`, `b`, take seconds; `o`, video seconds).

**Claude Code** runs in the window's integrated terminal with your existing login (the terminal's HOME is your real one; nothing logs in, and no credential is typed or shown) and none of your user config: `claude` is a shell function in the take's own zsh config (`record/vscode.mjs` `CLAUDE_FLAGS`): `--setting-sources project,local` (the folder's `.claude/settings.local.json`, where Set Up My AI Helper registers its PreToolUse hook), `--strict-mcp-config` with no servers, `--permission-mode acceptEdits`, `--disallowedTools Bash` (it reads and edits files in the folder, nothing else, and never stops to ask), `--model sonnet`, and one appended instruction (shell is off by design; a two-sentence reply), with `IS_DEMO=1`. The prompt is `$ `. Claude Code is started off camera and its banner cleared (Terminal: Clear) before the take, because the banner names the plan the login is on; `npm test` checks every terminal row the take sampled (`terminalText`) for an account, plan, email or home folder. Check the final frames by eye as well.

| File | Role |
|---|---|
| `record/vscode.mjs` | The isolated VS Code: `--user-data-dir` and `--extensions-dir` under `/tmp/erdrec` (short, because macOS caps the Unix socket path inside a profile), CDP on port **9555** (never 9333, which other tools share; the launch checks the port belongs to this profile), `--use-mock-keychain` (no "Code Safe Storage" prompt) and the no-backgrounding flags. Its own HOME (`/tmp/erdrec/home`: nothing ERD Studio writes to a home folder lands in yours) and PATH (`/tmp/erdrec/bin`: `claude`, `uvx`, and `dbt`, real dbt Core with dbt-duckdb through uvx, pinned, its cache warmed by the fixtures), kept as given with `VSCODE_CLI=1` (VS Code would otherwise read your login shell's environment, and with it any dbt on your PATH). `launch(folder)` resets the profile to a first run every time: the settings below, no workspace storage, ERD Studio's state as just installed minus the Show Me Around guide, the Explorer's Outline and Timeline sections hidden, and a 1440×600 window rendered at device pixel ratio 2 (`--force-device-scale-factor=2`, `DPR`), as on a Retina display, whatever screen it opens on: the screencast's 1728×720 frames are scaled down from 2880×1200, never up, so the footage's text is sharp. `quit()` signals only the processes whose command line names this profile. |
| settings | Light Modern, no welcome page, tips, AI/chat UI, Copilot, minimap or Git decorations, `telemetry.telemetryLevel: off`, `erdStudio.telemetry.enabled: false`, `erdStudio.startSuggestions: false` (the tour clicks its import; no automatic draft), DOM menus, dialogs and file picker (`window.menuStyle` / `window.dialogStyle: custom`, `files.simpleDialog.enable`), the panel on the right, and a terminal profile `tour` (bare zsh, DOM renderer, no shell integration). |
| `record/fixtures.mjs` | Writes each take's folder fresh, under `/tmp/erd-tour` (the file dialog and Claude Code show the path, so it is short and free of any home path): `shop-analytics`, a project folder (`pipelines/`, `sales.sql`: four tables and three foreign keys as Snowflake's `GET_DDL` exports them), and `dbt/shop-analytics`, a dbt project (profile in the project: in-memory DuckDB, never connects) holding the plain take's `.erd-studio`, whose models differ on purpose (an extra `order_status`, `amount` NUMBER(18,2), no `dim_promotion`; `dim_customer` follows the design's columns). No `target/`: the take clicks **Run dbt parse**. `--capture` writes `record/fixtures.erd.mjs`, a copy of the plain take's `.erd-studio`. |
| `record/driver.mjs` | CDP without dependencies. The pointer glides (eased) to each target and a ripple drawn in the workbench marks each click. The pointer itself is not filmed: every glide is logged (`d.trail`, saved as `build/rec/<take>/pointer.json`) and `composite` draws it on the video's 30 fps clock. `hover: false` glides without moving the real mouse; `parkMouse()` moves only the real mouse (off a picker row whose tooltip would cover the next one); `drag()` moves a node or a sash; clicks are trusted mouse events at the target's centre, so they reach the webviews; keys go to whatever has focus. `wb(selector)` targets the workbench (shadow roots included), `wv(selector)` the visible webviews. `screenText()` reads the text a viewer can see, `terminalText()` the terminal's rows. |
| `record/scenes.mjs` | Each scene's clicks keyed to its beats, and the two takes: `plain` (bring, importSql, draft, files, byHand, aiSetup, aiRun, then the hook, filmed last and cut to the front) and `dbt`. Off-camera `prep` sets a scene up (the canvas fitted and, while a table sits under the minimap React Flow draws in the canvas's bottom-right corner, zoomed out about its top-left a wheel step at a time (`clearOfMinimap`, also run after the on-camera Fits); for `aiRun`, the side bar hidden, the terminal opened on the right, Claude Code started and its banner cleared). |
| `record/screencast.mjs` | Films with `Page.startScreencast`: the compositor pushes a JPEG (quality 95) on every repaint, already scaled (down, from the 2x window) to the 1728×720 inset; a still window sends nothing and the last frame holds. `npm test` checks that a raw frame is the inset's size. |
| `record/record.mjs` | Per take: its fixture folder, launch, prep, then each scene filmed for its timeline duration (or, with a fast-forward, as long as its wait takes; `at(s)` waits for s seconds into the scene, in the video's time), the visible text and the terminal's rows sampled about every 0.6 s. Writes `build/rec/<take>/` and `record/takes.json`. |
| `record/takes.json` | Committed, small: per scene its take, length, when its clicks finished, how late any ran, its fast-forward, the text that was on screen and the terminal's rows. `npm test` checks it: dbt words only in the dbt beat, each scene shows the product labels its line names, and nothing private in the terminal. |
| `record/composite.mjs` | Lays the footage on the video's clock (`takeClock`: real time, or a fast-forward), cross-fades over 10 frames where the footage jumps, draws the pointer from `pointer.json`, dissolves into `recording.zoom` (the dbt beat's comparison at 1.45×), lays the "Sped up N×" badge over each fast-forward, then lays the result over the rendered frame at `recording.inset` (x 96, y 240, 1728×720), one run of recorded scenes at a time (`runsOf`): HTML scenes may sit between two runs (the AI change and the pull request, before the dbt beat), where the footage is hidden and its cut sits out of sight; each run fades in and out where the frame does, except into a scene that holds the window (`holdsWindow`: a still of the footage), where the footage runs on two frames over the still and cuts. |
| `confluence-shot.mjs` | `player/assets/confluence-sales.png`: the tour's `sales` diagram (`record/fixtures.erd.mjs`) loaded by `@erd-studio/core`'s `loadDisplaySubjectArea` with its DBML reader and drawn by `@erd-studio/renderer`'s `ErdCanvas` in viewer mode, as the ERD Studio for Confluence macro draws it, on a light page. |

The raw takes (about 3,300 JPEGs) stay in `build/rec/`, which is gitignored. Recording needs macOS with VS Code in `/Applications` (or `VSCODE_BIN` / `VSCODE_CLI_BIN`), `sqlite3`, `uv`, Claude Code signed in (`claude` on your PATH, or `CLAUDE_BIN`), and a screen: the window opens for real, though nothing outside it is filmed. Running Claude Code once adds this folder to the projects in your `~/.claude.json`, as any first run in a folder does.

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
- **Ceiling: 9 MiB** for the mp4 (raised from 8 MiB: the recorded default cut is over two minutes of real UI and terminal text), and 140 s for the timeline. `encode.sh` tries CRF 20, then 22, 24 and 26, and fails if the file is still over. The GOP is 150 frames (5 s). The content is mostly static UI, and the longer GOP roughly halves the size at the same CRF compared with 2 s keyframes. The current renders are 7.9 MiB (default cut, 137.6 s, at CRF 24: CRF 22 is 9.1 MiB) and 8.3 MiB (logical cut, 116.0 s, at CRF 20), filmed at 2x. Mostly still frames keep their text sharp at CRF 24.
- `encode.sh` asserts: `h264` / `High` / `yuv420p`, `mp3` / 44100 / mono, size ≤ 9 MiB, duration within 0.25 s of the timeline, the moov atom before mdat, and a 1280×720 JPEG poster.
- `test/unit/gettingStartedMedia.test.ts` (root vitest) re-checks the shipped files: the two cuts' videos and posters in `media/onboarding/`, ≤ 9 MiB, 50–140 s, cues ending inside the video, faststart, an MP3 track (esds object type 0x6B, not AAC), a JPEG poster, and well-formed cues.
- The poster is the opening (hook) scene's last frame, once every element has landed (for the default cut a real frame: the finished diagram and its files): never the end card, whose "Install ERD Studio" chip reads wrong in an editor that already has it.

## README GIF

`npm run gif` (`hero-gif.mjs`) renders `media/demo.gif`, the README's hero image, from `player/hero.html` + `player/hero.js`: the same editor pieces as the video, laid out at 1440×900 and drawn frame by frame (`render(t)` is pure, so every run gives the same GIF). It shows ERD Studio in a plain folder (no stage tabs, neutral grey tables and lines, nothing about dbt), the Explorer's layer-first `.erd-studio/main/tables/main/*.dbml` tree (in VS Code's order, with `sales.dbml` in the folder's top level) beside the orders diagram (a `fct_order` star with its keys); the table files light one by one with their tables, `fct_order.dbml`'s formatted text shows, then `sales.dbml` lights and the editor switches to Import DBML…'s draft of it (its summary and **Show details**, before anything is written; none of its tables is already in the library, so nothing is reused) and back. A 12 s seamless loop at 12 fps, scaled to 800 px wide (the README shows it at `width="800"`), one palette for the loop, no dithering, only each frame's changed rectangle stored: about 0.66 MB. `npm test` renders every quarter second of the loop and fails on any dbt word or a blue table border. The script fails over 2 MB. `node hero-gif.mjs --frames 0.5,8` writes stills to `build/hero/` for review. Re-render it when the canvas, the side bar, the draft page or the file layout changes, and look at it.

## README thumbnail

`npm run thumbnail` (`thumbnail.mjs`) renders `docs/assets/getting-started-play.jpg`, the image the README links to the video with: 1280×720 JPEG, under 300 KB (the script lowers the quality until it fits, and fails if it cannot). The page is `player/thumbnail.html`: for the recorded default cut a real frame (its opening scene's end, the finished diagram in VS Code's light theme, taken from `build/recording.mkv` into `build/thumb-bg.png`; run it after `npm run composite`) softened behind a dark play button on a light page, "Watch the tour", "Your data model as DBML, in your repo — by hand or with AI" and a duration pill with the real m:ss from `build/timeline.json`. Run it after every render that changes the length or the canvas, and look at the result.

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
