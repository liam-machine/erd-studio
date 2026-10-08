# Issue #133 — relationships stored with the model holding the foreign key

Evidence for the pull request that closes
[#133](https://github.com/liam-machine/erd-studio/issues/133): the before/after video, the
documents the change was designed from, and the scripts, demo projects and command output
the video and the real-extension tests were made with. Nothing in this folder is part of the
extension build (`videos/**` is in `.vscodeignore`).

## The video

`issue-133-before-after.mp4` (3 min 19 s) — narrated, captioned:

| Part | What it shows |
|---|---|
| Before (`develop`, 1.6.7) | A drag from a dimension's key to a fact's column is saved in the dimension's file, with the dimension as the many side |
| After (this PR) | The same drag is turned round; the dialog says it will be saved in the fact's file; the dimension file is untouched; a relationship can carry a role (`ship date`), drawn on the line |
| Upgrading from 1.6.7 | `erd-studio check` flags the two relationships 1.6.7 saved the old way; opening the diagram offers **Repair Relationships…**; one preview, one confirm; both relationships end up in the fact's file as many-to-one, the stray foreign-key flag is cleared, and `check` is clean |
| What else changed | Summary cards |

Also here: `storyboard.json` (the render input), `issue-133-before-after.timeline.json`
(where each caption and line of narration sits) and `issue-133-before-after-sheet.jpg`
(one still per caption).

The video was rendered with the `issue-to-pr` skill's `make_video.py` (Kokoro `af_heart`
narration, burnt-in captions, music bed). The raw screen-recording frames (`rec/before`,
`rec/after`, `rec/notify`, a few thousand JPEGs) are not kept — re-record them with the
scripts below.

## Contents

| Path | What it is |
|---|---|
| `design/holistic-design.md` | The combined design from the five-council review (rules P1–P11) that the rework follows |
| `design/SPEC.md` | The implementation contract (R1–R12, defects D1–D12, file ownership) the build workflow worked from. Later simplified: Repair makes only safe automatic fixes and lists everything else with **Open File**; a diagram file's own copy of a model-library link is an ignored REL009 copy |
| `evidence/check-before.txt`, `evidence/check-after.txt` | `erd-studio check` on the 1.6.7-style demo project before and after Repair (the `.wrapped` copies are what the video shows) |
| `demo-projects/demo-template` | The three-model demo (dim_customer, dim_date, fct_order) the before/after takes use |
| `demo-projects/demo-func` | The same plus a second diagram (`reporting.json`) and a declared foreign key, for the functional checks |
| `demo-projects/demo-legacy2` | A project as 1.6.7 left it: a dimension-side many-to-one, a one-to-many, and the foreign-key flag 1.6.7's Draw from dbt put on a dimension key |
| `demo-projects/demo-perdomain` | A project that keeps relationships in each diagram file |
| `scripts/launch.sh` | Starts VS Code (isolated profile, `--remote-debugging-port`) with a build and a fresh copy of a demo project |
| `scripts/reset.mjs`, `prep.mjs`, `clearall.mjs` | Close editors, open the diagram, dismiss the welcome card and dbt banner |
| `scripts/wv.mjs` | Drives the canvas inside the webview frame over the DevTools protocol (cursor, clicks, captions) |
| `scripts/take.mjs` | The before/after take (`node take.mjs before` / `after`) |
| `scripts/notify2.mjs` | The 1.6.7 upgrade scene (notification → Repair) |
| `scripts/functional2.mjs` | Real-extension functional checks on the canvas (25 checks: orientation, read-back, role, undo/redo, ⇄, edit, cardinality, duplicate refusal, ambiguous prompt, contradiction warning, second diagram, delete) |
| `scripts/perdomain.mjs` | Real-extension checks for a per-diagram project (4 checks) |
| `scripts/assert-legacy.mjs` | Checks the files on disk after the upgrade scene |

The scripts are kept as a record of how the evidence was produced. Absolute paths in them are
replaced by placeholders — `<repo>` (this repository), `<work>` (the working directory that
held the builds, demo copies and recordings), `<issue-to-pr-skill>` (the skill providing
`cdp/act.mjs`, `cdp/recorder.mjs` and `make_video.py`) and `<short-tmp>` (a short temp
directory for the VS Code profile: its socket path must stay under 104 characters). Set them
before running anything.

## Results at the time of recording

- Real VS Code: 25/25 canvas checks, 4/4 per-diagram checks, the upgrade scene's 4 disk checks.
- `npx vitest run`: 169 files, 3,735 tests (including 23 end-to-end journey tests in
  `test/unit/journeys.relationships*.test.ts`).
