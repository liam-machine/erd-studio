# Onboarding stories

User stories as code: each one drives a **real VS Code** with the extension the
way a new user would (clicks, typing, the Command Palette, dialogs), asserts
what they should see and what lands on disk, and can film itself as a
captioned MP4. Re-run them after any change to the start surfaces (the
walkthrough, the sidebar's welcome text, the start suggestion, More ways to
start…), a draft (Draft-first: `docs/dev/draft-first.md`), an import's quick
path, Open an Example…, the first canvas or anything that can pop up in a
new user's first minute: they catch what unit tests cannot, such as a
`command:` link whose arguments VS Code drops, a command that drops its own
(story 05 guards against `erdStudio.start` passing no `{ quick: true }` to the
import it runs), or a second prompt sneaking into the first minute (stories
15–22).

```
test/stories/
├── run.mjs                 ← the runner (npm run stories / stories:record)
├── lib/
│   ├── story.mjs           ← the DSL: story({ … }) and the `s` a story's steps get
│   ├── vscode.mjs          ← VS Code DOM selectors and helpers (sidebar, quick pick, palette, tabs)
│   ├── act.mjs             ← the actor: cursor, click, press, type, waitFor, highlight; webviews
│   ├── launch.mjs          ← build, stage the extension, launch an isolated VS Code, kill it
│   ├── cdp.mjs             ← a dependency-free Chrome DevTools Protocol client
│   ├── recorder.mjs        ← films the window over CDP (screenshots, ~15 fps)
│   ├── video.mjs           ← frames + step captions → MP4 (ffmpeg, libass)
│   ├── narrate.mjs         ← --narrate: a spoken line per caption, placed on the video's timeline
│   ├── tts.py              ← --narrate's voice (Kokoro, a uv script; the only Python here)
│   ├── publish.mjs         ← --publish: recorded stories → media/onboarding/stories/<clip>.mp4
│   ├── draft.mjs           ← the draft preview's selectors and helpers (waitForDraft, chooseScope, …)
│   ├── noise.mjs           ← interruptions nobody asked for (the first-60-seconds stories)
│   ├── firstMinute.mjs     ← the steps stories 15–22 share (install, the one interruption, the quiet minute)
│   └── workspaces.mjs      ← the folder a story opens, copied fresh each run
├── workspaces/plain/       ← a folder with only a README
├── stories/NN-<id>.story.mjs ← one per new-starter journey (below)
├── out/                    ← gitignored: <id>.mp4/.srt/.log, failures, summary.json
└── .cache/                 ← gitignored: --narrate's voiced lines (voice/<hash>.wav) and espeak data
```

Plain `.mjs`, Node 22 or later, no npm dependencies; `--narrate` alone also
needs [uv](https://docs.astral.sh/uv/) (it runs `lib/tts.py`), and nothing else
loads it. `test/**` is outside the VSIX (`.vscodeignore`) and outside vitest
(`include` is `test/unit/**`).

## The stories

One file per typical new-starter journey, numbered in the order a newcomer
meets them. Each is a user story (*As …, I want …, so that …*) whose video
doubles as "watch how" help for that start.

| # | id | Journey |
|---|---|---|
| 01 | `empty-window-opens-an-example` | No folder open → sidebar: **Open Folder…** the one button → **More ways to start…** (`erdStudio.start` `[{ from: 'sidebar' }]`, asserted) → **Open an Example…** → the **Example: Coffee shop** draft (primary **Open Folder…**, the Example switcher) → switch to Medallion lakehouse → **Save This Example…** → Projects/ → the window opens it on the gold sales canvas |
| 02 | `walkthrough-starts-a-blank-diagram` | Plain folder, popup off → the ERD Studio sidebar (the walkthrough is listed once ERD Studio has started in a folder) → Welcome: Open Walkthrough → its **New Diagram** step, **New Diagram…** its one button → name it → empty canvas |
| 03 | `plain-folder-new-diagram-add-table` | Empty folder, popup off → sidebar **New Diagram…** (the one button, **More ways to start…** the one link) → "Orders" → canvas **New Table** → `customer` on the canvas and in `.erd-studio/main/tables/` (shown in the Explorer) |
| 04 | `sql-scripts-import` | CREATE TABLE scripts (`test/fixtures/sql-ddl/postgres`) → the start suggestion ("ERD Studio found CREATE TABLE scripts in this folder (4 tables). Show them as a diagram? Nothing is saved until you keep it.", **Show Me** / **Don't Ask Again for This Folder**) → **Show Me** → **Draft: sales** with nothing asked first ("Draft from 2 SQL files (PostgreSQL) · 4 tables, 3 relationships · not saved", "Keep saves it as sales in the Main layer (…)", nothing on disk) → **Keep as Diagram** → 4 tables, 3 relationships on the canvas and on disk |
| 05 | `power-bi-model-import` | A PBIP project (`test/fixtures/semantic-model/pbip-tmdl`), popup off → the empty Diagrams view's one button, **Import your Power BI semantic model** → **Draft: adventure-sales** (4 tables, 4 relationships, nothing asked first) → **Show details**: the measures left out → **Keep as Diagram** → sales, customer, product, date_table and 4 relationships |
| 06 | `dbml-file-import` | A dbdiagram.io file (`test/fixtures/dbml/foreign/ecommerce.dbml`) → the start suggestion ("…found a DBML file in this folder. Show it as a diagram? …") → **Show Me** → **Draft: ecommerce** (6 tables, 6 relationships; the banner counts what is left out) → **Show details** in plain words → **Keep as Diagram** → one file per table, by schema |
| 07 | `dbt-project-draw` | The dbt fixture without `.erd-studio/` → the start suggestion ("…found a dbt project in this folder. Show its models as a diagram? …"), the sidebar's one button **Draw from dbt** beside it → **Show Me** → **Draft: gold** (the top-ranked folder) with a **Folder** switcher → silver → **Draft: silver** → **Keep as Diagram** → laid out, Logical / Physical switch, files in the Silver layer |
| 08 | `yaml-project-convert` | A pre-2.0 YAML/JSON project (`test/fixtures/logical-only`) → the opening notice offers **Convert to DBML…** then **Open sales** → the Diagrams view's first row, **Convert to DBML…** → Convert panel → DBML files, the YAML and JSON removed, the diagram reopens |
| 09 | `welcome-tab-example` | No folder open → the Diagrams view's ▶ (**Watch the One-Minute Tour**) → the **ERD Studio Tour** tab (the example's short video waiting) → **Open an Example…** → the example draft → switch to Kimball bus matrix → **Save This Example…** → retail sales opens |
| 10 | `welcome-tab-watch-how` | CREATE TABLE scripts, popup off → Help & Feedback's **Watch the One-Minute Tour** → the tour's "Ways to start, in short videos" (no dbt video without dbt) → the SQL clip (published from 04), not muted, waiting → play: it plays in VS Code with its narration (H.264 decodes, and the MP3 audio: `webkitAudioDecodedByteCount` > 0) and pauses the tour |
| 11 | `start-suggestion-turn-off` | CREATE TABLE scripts → the start suggestion → **Don't Ask Again for This Folder** → "Start suggestions are off for this folder." (**Undo**) → reload: no popup (the sidebar still offers the import) → the palette offers **Turn On Start Suggestions for This Folder**, not Turn Off → run it → reload: the popup is back |
| 12 | `large-import-review` | 257 tables in 8 scripts (`test/fixtures/sql-ddl/large`, copied without `generate.mjs`) → the start suggestion ("… (257 tables) …") → **Show Me** → a large draft: the schema panel open (All tables (257), then 8 schemas), the canvas on sales ("Showing sales: 80 of 257 tables") → finance → **Show details**: every table by schema, every relationship, the views left out → **Keep as Diagram** keeps all 257 → the diagram opens laid out, no second confirm |
| 13 | `nothing-found-import-from-databricks` | A folder with nothing to bring in (README only) → the ERD Studio icon → the automatic **Example: Coffee shop** draft (primary **New Diagram…**) → **Bring In Your Data Model…** → the guide (no Found or dbt card) → the Databricks card → **Copy** the notebook cell (the clipboard holds it, read by `s.ui.clipboardText()`) → `schema.sql` (`test/fixtures/sql-ddl/databricks-notebook`) lands in the folder only now → **Import Databricks DDL…** → the file dialog → no dialect question (the name box kept) → "Draft from 1 SQL file (Databricks / Spark SQL) · 2 tables, 1 relationship · not saved" → **Keep as Diagram** → customers and orders, joined |
| 14 | `import-guide-from-picker-fabric` | A folder with nothing to bring in, popup off → **More ways to start…** → **Import…** → its last item **Bring In Your Data Model…** → the guide → the Microsoft Fabric card (Semantic model / Warehouse or SQL analytics endpoint) → `warehouse.sql` (`test/fixtures/sql-ddl/fabric-warehouse`, as SSMS scripts it) lands in the folder → **Import SQL Server DDL…** → no dialect question → "Draft from 1 SQL file (SQL Server / Azure SQL) · …" → **Keep as Diagram** → dim_customer and fct_order, joined |
| 15 | `first-minute-no-folder` | *Realistic.* No folder → install → VS Code opens the ERD Studio walkthrough (the one interruption) → one click on its **Open Folder…**: VS Code's folder dialog → nothing else in the first minute |
| 16 | `first-minute-empty-folder` | *Realistic.* A folder with a README → install → nothing pops up → one click on the ERD Studio icon: **Example: Coffee shop**, nothing written → no interruption at all in the first minute |
| 17 | `first-minute-sql-scripts` | *Realistic.* CREATE TABLE scripts → install → the start suggestion (the one interruption; no walkthrough beside it) → one click on **Show Me**: **Draft: sales** → nothing else |
| 18 | `first-minute-power-bi` | *Realistic.* A PBIP project → install → the start suggestion → one click on **Show Me**: **Draft: adventure-sales** → nothing else |
| 19 | `first-minute-dbt-project` | *Realistic.* The dbt fixture without `.erd-studio/` → install → the start suggestion → one click on **Show Me**: **Draft: gold** → nothing else |
| 20 | `first-minute-pre-2-0-project` | *Realistic.* A pre-2.0 project → install → the opening notice, **Convert to DBML…** first (the one interruption) → one click: the Convert panel, nothing written → nothing else |
| 21 | `first-minute-existing-diagrams` | *Realistic.* A clone of `docs/examples/kimball-bus-matrix` → install → "This project has 4 ERD Studio diagrams." (the one interruption) → one click on its **Open …**: the canvas → nothing else |
| 22 | `first-minute-query-only-sql` | *Realistic.* SQL queries only (SELECTs, a CTE, an INSERT … SELECT; no CREATE TABLE) → install → nothing pops up (no "found CREATE TABLE scripts") → one click on the ERD Studio icon: the example draft → no interruption at all |

**The start suggestion (the popup).** A folder ERD Studio can model (SQL
scripts, a semantic model, a DBML file, a dbt project) gets one notification
as its window's activation prompt, once per folder: "… Show them as a
diagram? Nothing is saved until you keep it." with **Show Me** (the draft)
and **Don't Ask Again for This Folder**. A folder with nothing found gets no
notification: the ERD Studio icon opens the example draft, once per machine.
Stories about the popup (04, 06, 07, 11, 12, 17–19) wait for it with
`s.ui.waitForNotification(text)` and press its buttons with
`s.ui.notificationButton(text, label)`; every other story with a folder turns
suggestions off with the story's `settings` (written into the profile's user
settings, over `STORY_SETTINGS`), which also turns off the automatic draft,
so it keeps testing what it tests:

```js
settings: { 'erdStudio.startSuggestions': false },
```

**The draft.** Every import and Draw from dbt ends in the read-only draft
preview (`Draft: <name>`, `Example: <title>`), never a confirm modal.
`lib/draft.mjs` holds its selectors (`DRAFT.headline`, `DRAFT.button(label)`,
`DRAFT.tables`, …) and helpers: `waitForDraft(s, tab, { tables })` waits for
the tab and its laid-out diagram and resolves what the banner says and what
it draws; `chooseScope(s, page, label)` uses the switcher (a native
`<select>`'s popup cannot be driven over CDP, so the value is set and React's
change event dispatched); `waitForDraftKeepingName(s, { never })` follows a
step-by-step import (the name box kept, a question matching `never` fails, a
modal fails) until its draft opens. A quick path asks nothing first: the
draft is the first thing it shows (asserted by waiting for it with no quick
input answered). Assert nothing is on disk before **Keep as Diagram**.

A story that finds a product bug asserts the intended behaviour, says so in
its header comment ("currently failing"), and the bug is reported; it is not
bent to pass.

## Run

```bash
npm run stories                                  # every story, fast, no video
npm run stories:record                           # every story, filmed: test/stories/out/<id>.mp4
node test/stories/run.mjs --record --narrate     # filmed and narrated (needs uv)
node test/stories/run.mjs --record --publish     # film them narrated, then publish the tour tab's short videos
node test/stories/run.mjs --publish              # publish the clips from the narrated recordings already in out/
node test/stories/run.mjs --only empty-window    # stories whose id or file name contains this
node test/stories/run.mjs --record --keep        # keep /tmp/erds-…: profile, workspace, frames
node test/stories/run.mjs --headed-slow          # slow pacing, to watch it run
node test/stories/run.mjs --no-build             # reuse dist/ (skips npm run build)
node test/stories/run.mjs --list
```

The runner builds once (`npm run build`), copies `dist/`, `package.json`,
`media/`, `schemas/`, `syntaxes/` and `LICENSE` to a temp folder (so a rebuild
never films a half-written bundle), then runs the stories one after another.
Each gets its own profile, workspace copy and CDP port, and prints `PASS` or
`FAIL` with the failing step. It exits 1 when any story fails, and always kills
the VS Code it started (by `--user-data-dir`) and removes its `/tmp/erds-…`
folders (unless `--keep`), even on Ctrl+C. `--record --publish` publishes only
the clips of the stories that ran; a run of stories without a clip publishes
nothing and exits on the stories alone.

A window opens on your screen while it runs (Extension Development Host,
1440×900). It is a separate instance with its own profile: your own VS Code
windows, settings and extensions are never touched. It can sit behind other
windows; it keeps painting.

VS Code: `$VSCODE_PATH`, else `/Applications/Visual Studio Code.app` on macOS,
`/usr/share/code/code` or `/opt/vscode/code` on Linux (the Electron binary, not
the `code` launcher script). ffmpeg: `$FFMPEG_PATH`, else Homebrew's or the
system's.

## Write a story

```js
// test/stories/stories/03-import-a-dbml-file.story.mjs
import path from 'node:path';
import { story } from '../lib/story.mjs';

export default story({
  id: 'import-a-dbml-file',                      // the output names: out/<id>.mp4
  title: 'Import a DBML file into a new folder',
  persona: 'As someone with a dbdiagram.io export',
  want: 'I want to bring it into ERD Studio',
  soThat: 'so that my diagram lives in Git',
  workspace: 'plain',                            // 'empty' | 'plain' | 'dbt' | 'yaml-project' | <name> | (dir) => …
  steps: async (s) => {
    await s.step('Given my project folder with no data model yet', async () => {
      s.expectNoFile('.erd-studio');
    });
    await s.step('When I open the ERD Studio sidebar', async () => {
      await s.ui.openSidebar('ERD Studio');
    });
    await s.step('Then I see "import a DBML file"', async () => {
      await s.expectVisible(s.sel.welcomeLink('import a DBML file'));
    });
    // …
  },
});
```

**Every step is a caption plus actions plus assertions.** Its text is the
caption burned into the video while it runs, so write it as the user would say
it: *Given …*, *When I …*, *Then I see …*. A step that throws fails the story
with that step's name; the steps after it do not run.

What `s` gives a story:

| | |
|---|---|
| `s.step(caption, fn, { say })` | one step; `say` is what `--narrate` speaks instead of the caption (below) |
| `s.ui.openSidebar('ERD Studio')` | open a view container from the activity bar |
| `s.ui.waitForQuickPick({ title })` → `{ title, placeholder, value, message, items }` | a quick pick or input box (`items` are the row labels) |
| `s.ui.pick(label)`, `s.ui.setQuickInput(text)`, `s.ui.quickInputButton(text)` | choose a row, type into the box, press its button |
| `s.ui.runCommand(text, label?)` | the Command Palette, opened from the Command Center |
| `s.ui.tabs()`, `s.ui.waitForActiveTab(label)`, `s.ui.notifications()`, `s.ui.windowTitle()` | |
| `s.wb.click(expr)`, `s.wb.press('Enter')`, `s.wb.press('a', PRIMARY)`, `s.wb.type(text)` | trusted input (CDP), with a visible cursor and ripple |
| `s.wb.waitFor(expr)`, `s.wb.ev(expr)`, `s.wb.highlight(expr)` / `unhighlight()` | |
| `s.wb.tagPage()` then `s.wb.waitForReload(tag)` | around an action that reloads the window |
| `s.webview()` → `.waitFor(expr)`, `.ev(expr)`, `.click(expr)`, `.fill(expr, text)`, `.highlight(expr)`, `.rect(expr)` | the ERD Studio webview in the active editor (the canvas, a draft, the tour tab, the Convert panel); expressions see its document as `doc`; elements are scrolled into view before a click |
| `s.ui.waitForDialog()` → `{ message, detail, buttons }`, `s.ui.dialogButton(text)` | a modal dialog (an import's no-preview fallback, a sample download) |
| `s.ui.waitForDialogAskingNothingFirst()` | the same, failing if any quick input shows first |
| `s.ui.waitForNotification(text)` → `{ message, buttons }`, `s.ui.notificationButton(text, label)` | a notification toast (the start suggestion) |
| `s.ui.paletteItems(text, { expect })` → labels, `s.ui.reloadWindow()` | the Command Palette's rows, left open; Developer: Reload Window |
| `s.ui.chooseInFileDialog(rel, button)` | VS Code's own file dialog: type `rel` after the folder it shows, press `button` |
| `s.ui.waitForDialogKeepingName({ never })` → `{ dialog, named }` | a modal reached through a step-by-step flow: the name box is answered with its suggestion, a quick input matching `never` (`/dialect/i`) fails (an import ending in a draft: `waitForDraftKeepingName`) |
| `s.ui.dismissVSCodeFirstLaunch()`, `s.sel.viewHeader(title)` | VS Code's own first-launch modal closed (realistic stories); a side bar view's header (expand Help & Feedback) |
| `s.ui.clipboardText()` | the clipboard's text, as a paste gets it (the page may not read the clipboard: it pastes into an off-screen textarea) |
| `s.wb.highlightRect({ x, y, width, height })` | the highlight box around any rectangle |
| `s.installErdStudio()`, `s.oneClick(fn)`, `s.expectQuietFirstMinute({ max })`, `s.noise` | a realistic story's install, the one-click check, the first minute's interruptions (below) |
| `waitForDraft`, `draftState`, `chooseScope`, `waitForDraftKeepingName`, `DRAFT.*` (`lib/draft.mjs`) | the draft preview |
| `s.sel.*` | selector expressions: `activity`, `welcomeLink`, `welcomeButtons` (the empty view's buttons, by text: a link alone on its line is one), `viewAction` (a view's title-bar icon), `walkthroughButtons`, `quickPickRow`, `tab`, `walkthroughStep`, `walkthroughLink`, `sidebarRow`, `dialog`, `dialogButton`, `notification`, `activeEditor`, … |
| `s.expect(cond, msg)`, `s.assert.*` (node:assert/strict), `s.eventually(fn)` | |
| `s.expectVisible(expr)`, `s.expectText(expr, text)` | wait for the workbench DOM |
| `s.expectFile(rel, { contains })`, `s.expectNoFile(rel)` | the workspace's files (an empty window: the temp HOME); `rel` may be absolute |
| `s.home`, `s.workspace`, `s.path(...)` | the story's temp HOME, the folder it opened |
| `s.pause(ms)` | a beat for the viewer (scaled down when not recording) |

Selectors are JavaScript **expressions** evaluated in the workbench page, so any
lookup works (`[...document.querySelectorAll(…)].find(…)`). VS Code's DOM
changes between releases: put a new selector in `lib/vscode.mjs`, never inline
the same one in several stories, so a VS Code update is fixed in one place.

**Assert the outcome a user cares about, and say what went wrong.** A story
about a start link asserts the picker that link should open *and* names the
failure it guards against: `s.expect(!title.includes('Start your data
model'), "the link's argument did not reach erdStudio.start …")`.

**Workspaces.** `empty` launches no folder. `plain` is `test/stories/workspaces/plain`.
`dbt` copies `test/fixtures/dbt-project` and `yaml-project` copies
`test/fixtures/logical-only` (a pre-2.0 YAML/JSON project), so fixtures are not
duplicated in git. Any other name is `test/stories/workspaces/<name>` or
`test/fixtures/<name>`; a function `(dir) => …` fills an empty folder. An
object builds a named folder from repo files at run time (the window title
shows the name):

```js
workspace: { name: 'shop-database', add: { database: 'test/fixtures/sql-ddl/postgres' } },
workspace: { name: 'analytics', from: 'test/fixtures/dbt-project', skip: ['.erd-studio', '.claude'] },
```

`from` is copied as the folder (minus the top-level names in `skip`), `add`
maps a path in the folder to a repo file or folder, and an optional `fill(dir)`
runs last. The copy goes inside the story's temp HOME
(`/tmp/erds-…/home/<name>`), so dialogs start in a clean folder, never your
home.

## Record

`--record` films the workbench page about 15 times a second over the DevTools
protocol (the canvas webview is in the picture; no screen-recording permission,
works under Xvfb) and encodes `out/<id>.mp4` (H.264, 1440×900, 25 fps) with one
caption per step burned in, plus `out/<id>.srt`. The first seconds show the
story itself (title, *As …*, *I want …*, *so that …*); a passing run ends on a
green *Done* caption, a failing one on a red *FAILED: <step>* caption with the
error, and the video is still written up to that point.

Captions use ffmpeg's `ass` filter (libass), present in Homebrew's and Ubuntu's
ffmpeg. An ffmpeg without libass still writes the video, with the captions as a
subtitle track and the `.srt`, and warns.

Recording slows the steps down (the cursor glides, each caption is held about
2.5 s before its actions) so a person can follow; without `--record` the same
story runs in a few seconds. Keep a recorded story between 25 and 60 seconds:
a caption per step, `s.pause()` after showing the user something, and waits
on real conditions (`waitFor`, `eventually`), never long fixed sleeps.

## Narrate

`--record --narrate` speaks each caption in the getting-started tour's voice
(Kokoro `af_heart` at 1.04, `VOICE` in `lib/narrate.mjs`, the same as
`video/script.yaml`), so the story videos sound like the rest of ERD Studio.

- **What is said.** A step's caption, made speakable (`spoken`: no quotes,
  ellipses or arrows, a bracket read as a pause, ▶ as "play"); the title card
  says the story's title (or the story's own `say`), and a passing run ends on
  "Done.". A caption that reads badly aloud — a path (`.erd-studio/main/tables/`,
  `database/`), a file name (`ecommerce.dbml`, `AdventureSales.pbip`), an
  identifier (`customer_id`), a site (`dbdiagram.io`) — gets a `say`:
  `s.step('And it is its own file under .erd-studio/main/tables/', fn, { say: 'And it is saved as its own file in my project.' })`.
  Keep spoken lines short and natural; `say: ''` keeps a step silent.
- **Voicing.** `lib/tts.py` (a uv script: kokoro-onnx 0.6.1, phonemizer-fork,
  espeak's data copied to a short folder, the same workarounds as
  `video/tts.py`) voices only the lines the cache does not hold
  (`test/stories/.cache/voice/<sha1 of voice|speed|text>.wav`), so a re-run voices
  nothing new. The model is the one `~/.cache/issue-to-pr/kokoro` holds for the
  issue videos (`kokoro-v1.0.int8.onnx`, `voices-v1.0.bin`; the full
  `kokoro-v1.0.onnx` when present; `$KOKORO_MODEL_DIR` overrides), downloaded
  once if missing.
- **Timing.** Each line starts 0.35 s after its caption appears and leaves
  0.3 s before the next (`TIMING`). Where a line is longer than the time to the
  next caption, the last frame before that caption is **held** for the
  difference (`planNarration`, `frameDurations`): the voice is never overlapped,
  cut or sped up, the caption stays on screen until its line ends, and every
  later caption and line moves with it. The run uses the `narrate` pace (a 0.9 s
  beat before a step's actions instead of 2.5 s of reading time, a shorter
  title card), as the voice does the reading.
- **Output.** `out/<id>.mp4` gets the voice as AAC (128 kbps mono): these copies
  are for review on GitHub, and Safari plays no MP3 in an MP4. The log's video
  line says how many lines, how long the speech and how long the holds.
- A plain `npm run stories` (or `--record` alone) never needs uv or Python.

**Assert the one obvious start.** Each story checks that the start its
workspace should suggest is the surface's one button: `s.wb.ev(s.sel.welcomeButtons)`
is `['Import your Power BI semantic model']` in a PBIP project (05),
`['New Diagram…']` in a plain folder (03), `['Draw from dbt']` in a dbt project
(07, beside the popup), `['Open Folder…']` in an empty window (01); the
walkthrough's step (02), a draft's one primary button (`DRAFT.primary`: Keep
as Diagram for a find, New Diagram… for the example in a folder, Open
Folder… with no folder, Save This Example… for a bundled project) and the
Convert row and notice of a project from before 2.0 (08) likewise.

## The first 60 seconds (realistic stories)

Stories 15–22 are one per kind of workspace a new user opens (no folder, an
empty folder, SQL scripts, a Power BI / Fabric model, a dbt project, a
project from before 2.0, a project with diagrams, a repository of SQL
queries). Each proves two things about the first minute after ERD Studio is
installed: **ERD Studio interrupts at most once** (its own notifications,
tabs, modals and quick picks, and VS Code's on its behalf: the walkthrough it
opens on install), and **the draft, or the right next step, is one click
away** (`s.oneClick(fn)` fails unless `fn` took exactly one click). A story
fails if noise creeps back: with the walkthrough's `when` removed, story 17
fails on "0.5s walkthrough: Get started with ERD Studio | 0.8s notification:
ERD Studio found CREATE TABLE scripts …".

`realistic: true` makes a story as close to a Marketplace install as the
harness allows:

- **No `--extensionDevelopmentPath`.** The runner packages the extension once
  (`packageVsix`: `npx @vscode/vsce package --no-dependencies`, which runs the
  production build) and puts it in the story's `~/Downloads`; the story
  installs it in the running window (`s.installErdStudio()`: **Extensions:
  Install from VSIX…**, the file, Install). VS Code then does what it does
  for a Marketplace install: activates ERD Studio where its activation
  events match, and opens its walkthrough when the walkthrough's `when` holds
  (`workbench.welcomePage.walkthroughs.openOnInstall`). The window title has
  no "[Extension Development Host]".
- **Every prompt left on** (`REALISTIC_SETTINGS` in `lib/launch.mjs`, no
  `--skip-welcome`): VS Code's Welcome page, walkthroughs on install, tips,
  extension recommendations, the Chat view, Git. Only what the harness needs
  stays set: dialogs drawn in the page (`window.dialogStyle`,
  `files.simpleDialog.enable`), the title bar and zoom, no updates (the
  machine's VS Code, and the ERD Studio under test, must not update
  themselves), telemetry off, and workspace trust off (the folder is a copy
  made a moment ago; a person's own folder was trusted long before).
- **VS Code's own first launch** of a brand-new profile (the "Welcome to VS
  Code" sign-in modal) is closed before the story starts
  (`s.ui.dismissVSCodeFirstLaunch()`): someone installing ERD Studio answered
  it long ago.

`lib/noise.mjs` polls the workbench from the moment Install is pressed and
records each new notification (with its source), editor tab, walkthrough,
modal and quick pick as `{ t, kind, text, origin, asked }`. A story declares
what its click is expected to open just before it (`s.noise.expect(/^Draft: /,
{ kind: 'tab' })`); a quick pick right after the story's own input is its
own; VS Code's "Completed installing extension." is the install's answer.
Everything else is unasked. `s.expectQuietFirstMinute({ max })` (the shared
step `quietFirstMinute` in `lib/firstMinute.mjs`) watches to 60 s after the
install and fails if ERD Studio's unasked events exceed `max` (1; 0 where
nothing should pop up at all); VS Code's own unasked ones are logged
(`NOISE:` lines in `out/<id>.log`) and kept in `summary.json`
(`interruptions`), never failing a story. A recorded one runs about 90 s
(the minute is watched to its end); none is a clip.

## Publish the "Watch how" clips

The tour tab (**ERD Studio Tour**) shows a short clip of each start
("Ways to start, in short videos", `HOW_TO_CLIPS` in
`src/types/startActions.ts`; the dbt one on the dbt page only). They are
stories:

| Clip (`media/onboarding/stories/`) | Shown for | Story |
|---|---|---|
| `open-an-example.mp4` | no folder open | 01 `empty-window-opens-an-example` |
| `start-a-blank-diagram.mp4` | `blank` | 03 `plain-folder-new-diagram-add-table` |
| `import-sql-scripts.mp4` | `importSqlDdl` | 04 `sql-scripts-import` |
| `import-power-bi-model.mp4` | `importSemanticModel` | 05 `power-bi-model-import` |
| `import-a-dbml-file.mp4` | `importDbmlFile` | 06 `dbml-file-import` |
| `draw-from-dbt.mp4` | `drawFromDbt` | 07 `dbt-project-draw` |

`--publish` (`lib/publish.mjs`) re-encodes each story's **narrated** recording
(`--record --publish` implies `--narrate`): H.264 High yuv420p, `+faststart`,
1280 px wide, captions as burned in by the recording, the narration as **MP3**
(64 kbps mono 44.1 kHz, `AUDIO`; never AAC, which VS Code cannot decode:
`docs/dev/onboarding-and-cli.md` → Codec decision), at most 60 s and 2 MB (the
video quality steps down until it fits). It is **never sped up** (the voice would
be): a recording over 60 s from its title card is refused, and the story is
re-paced instead (fewer or shorter steps, shorter spoken lines). It refuses a
silent recording and a story whose captions name a path, and checks the result
with ffprobe. With `--record` it publishes the clips whose story passed in that
run; alone, those whose last recording passed (`out/<id>.log`).
It starts the clip on the story's title card (the empty window before the
first caption is cut, `leadIn`) and crops the window's title bar off
(`[Extension Development Host] <folder>`, `cropTitleBarFilter`). No poster
files: the panel loads the clip's metadata, so its first frame (the title card)
is the poster, and every file counts toward the VSIX's 60-file cap. `test/unit/gettingStartedMedia.test.ts` and
`storiesPublish.test.ts` hold the clips to all of this; story 10
(`welcome-tab-watch-how`) proves the SQL clip shows on the tour tab and
plays in VS Code. Re-publish after a change to a start a clip shows.

**No path from the recording machine.** VS Code's own file dialog shows the
folder it is in (`/tmp/erds-…/home/shop-database/`). The actor films the
story's HOME as `~` (`maskHome` in `lib/act.mjs`: an overlay drawn over the
quick input's text while it holds a path under HOME; the DOM, which the
stories assert, is unchanged), and step captions never name a path.

## Debug a failing story

1. Read the runner's lines: the failing step and its error.
2. `out/<id>-failure.jpg` is the window at the moment it failed.
3. `out/<id>.log` has every step with its timing and the full stack.
4. `out/<id>-logs/` is VS Code's own logs for that run: `window1/exthost/` holds
   the extension host's log and ERD Studio's output channel; `out/<id>.vscode.log`
   is the main process's output.
5. `--record` and watch `out/<id>.mp4`, or `--headed-slow` and watch the window.
6. `--keep` keeps `/tmp/erds-…` (profile, workspace copy, frames) to inspect
   the files the story wrote.

## CI

`.github/workflows/stories.yml` runs them on `ubuntu-latest`, manually
(`workflow_dispatch`, inputs `only` and `record`):

```bash
gh workflow run stories.yml -f record=true
gh workflow run stories.yml -f only=empty-window -f record=true
```

It installs the stable VS Code tarball into `/opt/vscode`, Xvfb and ffmpeg,
runs `xvfb-run node test/stories/run.mjs --record`, and uploads `test/stories/out`
as the `onboarding-stories` artifact (videos, logs, screenshots, `summary.json`).

## Gotchas (each one cost a debugging session)

- **Short profile path.** VS Code puts an IPC socket in `--user-data-dir`, and
  macOS caps a Unix socket path at 104 characters: past it the window silently
  exits. The runner uses `/tmp/erds-XXXXXX/ud`, never the long `$TMPDIR`.
- **Its own CDP port.** 9333 is used by other tools, and a second VS Code on a
  taken port fails silently, so a script ends up driving someone else's window.
  A port picked in advance races another run started at the same moment, so
  the runner launches with `--remote-debugging-port=0` and reads the port this
  window bound back from `<profile>/DevToolsActivePort` (or the "DevTools
  listening on" line in its output): `boundPort` in `lib/launch.mjs`.
- **Open a folder with `--folder-uri`.** A plain path argument next to
  `--extensionDevelopmentPath` was ignored on macOS (the window opened empty).
- **Window size** cannot be set over CDP in Electron (no `Browser.setWindowBounds`):
  the runner pre-writes `storage.json`'s `windowsState` (`lastPluginDevelopmentHostWindow`).
- **Hidden windows stop painting** unless launched with
  `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows
  --disable-background-timer-throttling` (the runner does).
- **A fresh profile per story**, so nothing carries over: no restored editors,
  no remembered globalState (the Welcome panel's dismissal, the example
  folder). Pre-written settings keep the window quiet and deterministic
  (`lib/launch.mjs` `STORY_SETTINGS`: no startup editor, no workspace trust, no
  updates, no tips, no Copilot, telemetry off, custom title bar,
  `files.simpleDialog.enable`).
- **Dialogs.** Native Open/Save dialogs cannot be driven over CDP;
  `files.simpleDialog.enable` makes them VS Code's own in-window dialog (a quick
  input: type a path, press its button). `window.dialogStyle: custom` does the
  same for modal message boxes.
- **HOME is the story's temp folder**, so a dialog's first folder and anything
  an example writes stay inside `/tmp/erds-…`.
- **Webviews are separate CDP targets** (`iframe`, `vscode-webview://…`), the
  content inside `iframe#active-frame`. A walkthrough step's image is also an
  ERD Studio webview: `s.webview()` picks the one covering the active editor.
- **Reloads.** An empty window that opens a folder reloads itself. The actor and
  recorder reconnect; use `tagPage()` / `waitForReload()` to wait for the new page.
- **Trusted input.** Clicks are CDP `Input` events at the element's centre (as
  a person's). A synthetic DOM click (`domClick`) misses controls that check
  for trusted events. F1 does not reach the palette while a webview has focus:
  `runCommand` opens it from the Command Center.
- **Notifications sit over the bottom-right of the editor**, where a webview's
  own buttons often are (the Convert panel's **Convert**): a trusted click
  lands on the toast. Close a toast the story does not care about first.
- **A file dialog's placeholder is "Folder path"** even when it picks a file;
  `chooseInFileDialog` waits for the typed path before pressing the button.
- **A `<video>`'s middle does not start it** in VS Code's webview: press its
  controls' play button (bottom left, above the timeline), as story 10 does.
- **The recording has no sound of its own.** It is screenshots over CDP; a
  clip or the tour playing in the window is not heard. `--narrate` adds the
  voice afterwards, from the marks.
- **A fresh profile is a first run.** With no folder open ERD Studio's
  first activation opens its walkthrough (the window's one prompt); in a
  folder it never does (Draft-first §3.4): the ERD Studio icon opens a draft
  instead (the folder's find, or the example once per machine) unless the
  story turns start suggestions off.
- **The walkthrough is listed once ERD Studio has started** in a folder (its
  `when`: `workspaceFolderCount == 0 || erdStudio.activated`). A story that
  opens it from Welcome: Open Walkthrough in a plain folder opens the ERD
  Studio sidebar first (02).
- **The Command Center is an agents pill** in a profile with chat on (the
  realistic stories): `s.sel.commandCenter` takes whichever is visible, and
  its label opens the same Quick Open.
- **A notification's source** is in its footer ("Source: ERD Studio"); a
  progress notification has none, and `lib/noise.mjs` counts it as the
  extension's. A click's progress toast is part of the answer: expect it.
- **Clicks into a webview get lost while filming.** A recorded run dropped
  one trusted click in a few on a draft, the tour or the canvas (an
  out-of-process iframe), never a fast one. Two guards: no screenshot is in
  flight while the actor clicks (`Recorder.quiet`, the click waits for the
  capture to finish), and `Webview.click` watches the element for the click
  and, when none arrived within 1.5 s, clicks once more (the log says so).
- **A link that wraps** onto two lines has its box's centre on plain text
  between them: `click` aims at its widest line (`center` in `lib/act.mjs`).
- **The page may not read the clipboard** (`navigator.clipboard.readText()`
  is denied): `s.ui.clipboardText()` pastes over CDP into an off-screen
  textarea. A Copy button writes the machine's real clipboard.
- **Run from a terminal that stays open.** The runner kills its VS Code when it
  exits; a tool that kills a command's process group when the command ends
  (some agent shells) kills the window with it.
