# Onboarding stories

User stories as code: each one drives a **real VS Code** with the extension the
way a new user would (clicks, typing, the Command Palette, dialogs), asserts
what they should see and what lands on disk, and can film itself as a
captioned MP4. Re-run them after any change to the start screen, the
walkthrough, the sidebar's welcome text, Open an Example, Import DBML or the
first canvas: they catch what unit tests cannot, such as a `command:` link
whose arguments VS Code drops.

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
│   └── workspaces.mjs      ← the folder a story opens, copied fresh each run
├── workspaces/plain/       ← a folder with only a README
├── stories/NN-<id>.story.mjs
└── out/                    ← gitignored: <id>.mp4/.srt/.log, failures, summary.json
```

Plain `.mjs`, Node 22 or later, no npm dependencies. `test/**` is outside the
VSIX (`.vscodeignore`) and outside vitest (`include` is `test/unit/**`).

## Run

```bash
npm run stories                                  # every story, fast, no video
npm run stories:record                           # every story, filmed: test/stories/out/<id>.mp4
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
the VS Code it started (by `--user-data-dir`), even on Ctrl+C.

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
| `s.step(caption, fn)` | one step |
| `s.ui.openSidebar('ERD Studio')` | open a view container from the activity bar |
| `s.ui.waitForQuickPick({ title })` → `{ title, placeholder, value, message, items }` | a quick pick or input box (`items` are the row labels) |
| `s.ui.pick(label)`, `s.ui.setQuickInput(text)`, `s.ui.quickInputButton(text)` | choose a row, type into the box, press its button |
| `s.ui.runCommand(text, label?)` | the Command Palette, opened from the Command Center |
| `s.ui.tabs()`, `s.ui.waitForActiveTab(label)`, `s.ui.notifications()`, `s.ui.windowTitle()` | |
| `s.wb.click(expr)`, `s.wb.press('Enter')`, `s.wb.press('a', PRIMARY)`, `s.wb.type(text)` | trusted input (CDP), with a visible cursor and ripple |
| `s.wb.waitFor(expr)`, `s.wb.ev(expr)`, `s.wb.highlight(expr)` / `unhighlight()` | |
| `s.wb.tagPage()` then `s.wb.waitForReload(tag)` | around an action that reloads the window |
| `s.webview()` → `.waitFor(expr)`, `.ev(expr)`, `.click(expr)` | the ERD canvas in the active editor; expressions see its document as `doc` |
| `s.sel.*` | selector expressions: `activity`, `welcomeLink`, `quickPickRow`, `tab`, `walkthroughStep`, `walkthroughLink`, … |
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
`test/fixtures/<name>`; a function `(dir) => …` fills an empty folder. The copy
goes inside the story's temp HOME (`/tmp/erds-…/home/<name>`), so dialogs
start in a clean folder, never your home.

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

Recording slows the steps down (the cursor glides, each caption is held before
its actions) so a person can follow; without `--record` the same story runs in
a few seconds.

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
  The runner takes the first free port from 9400.
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
- **Run from a terminal that stays open.** The runner kills its VS Code when it
  exits; a tool that kills a command's process group when the command ends
  (some agent shells) kills the window with it.
