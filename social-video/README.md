# LinkedIn explainer videos

Source and render pipeline for two 1080×1350 (4:5) feed videos telling the same story. Nothing
here ships: `.vscodeignore` excludes `social-video/**`, `deploy.yml` ignores it (a change here
never publishes a release), and no build, tsconfig or test run refers to it.

| Cut | `VARIANT` | Script / scenes | Audience | Length |
|---|---|---|---|---|
| **pro** | `pro` (default) | `script.yaml`, `SCENES.md`, `player/scenes/*.js` | data engineers: logical vs physical, dbt, YAML/JSON, Diff, PRs | ~121 s |
| **simple** | `simple` | `script.simple.yaml`, `SCENES.simple.md`, `player/scenes/simple/*.js` | anyone: no jargon, one analogy (blueprints in a different city to the building site) | ~85 s |
| **readme** | `readme` | `script.readme.yaml`, the pro cut's scenes | README visitors: "How ERD Studio works" — the pro story without the social-only scenes (Confluence, "not on dbt?", launch traction, "link in the comments") | ~102 s |

`VARIANT` selects the script, the build folder (`build/` or `build-simple/`) and the output
names (`erd-studio-explainer[-simple].*`). Both cuts share the player, `lib.js`, the voice, the
music, and the `stars` and `endCard` scenes (a script can pass `props`, e.g. the end card's
tagline). Finished renders are kept, gitignored, in `renders/` (see below).

It is the getting-started video's pipeline ([`../video/`](../video/README.md): same Kokoro `af_heart` voice, same synthesised
underscore `music/synth_music.py`, same pure `render(t)` player captured frame by frame with
Playwright), re-laid out for a phone feed:

- **Portrait frame** — `FRAME` in `player/lib.js`: headline on top, scene content in
  `FRAME.stage` (y 300–1090), burned-in captions (y 1112–1232), chapter bar at the bottom.
- **Burned-in captions** — most feed viewers watch muted. `build-timeline.mjs` splits every line
  into ≤ 30-character chunks timed by their share of the line (`timeline.json → chunks`);
  `{word}` in a caption is drawn in the scene's accent colour.
- **Frame 0 is finished** — the first scene does not fade in, so the feed's first frame and the
  thumbnail are the hook, not a blank card.
- **Brisker voice** — speed 1.06 (the getting-started video uses 1.0).
- **Stereo AAC** at −14 LUFS for the upload (the getting-started video is mono MP3 because
  VS Code's webview cannot decode AAC; that constraint does not apply here).

The narration is `script.yaml`; the per-scene direction is `SCENES.md`; the example every scene
uses (tables, YAML, JSON, drift, PR) is `STORY` in `player/lib.js`, in the real v5 file formats.

## Render

Prerequisites are the same as the getting-started video in [`../video/`](../video/README.md) (ffmpeg 7 with libx264, Node 18+,
`npm install` + `npx playwright install chromium`, `uv`, the Kokoro model files in
`build/models/` or `KOKORO_MODEL_DIR`).

```bash
cd social-video
npm run all        # pro cut: tts → timeline → music → capture → encode
npm run all:simple # the plain-language cut (VARIANT=simple)
npm run qa         # build/qa/contact.png + per-scene stills, and the A/V onset check (qa:simple too)
npm run preview    # http://127.0.0.1:4173/social-video/player/index.html?preview=1  (?t=42.5 freezes a frame, &guides=1 shows the stage box)
```

Outputs, in `out/` (gitignored; `-simple` for the plain cut):

| File | Use |
|---|---|
| `erd-studio-explainer.mp4` | the upload: H.264 High 1080×1350 30 fps, AAC stereo 48 kHz, faststart |
| `erd-studio-explainer-thumb.jpg` | frame 0, the hook — set it as the video thumbnail |
| `erd-studio-explainer-end.jpg` | the end card, an alternative thumbnail |
| `erd-studio-explainer.srt` | captions, only if you also want LinkedIn's own caption track (the video already has them burned in, so normally skip it) |

## The README cut

`VARIANT=readme` is the only cut that is committed: the README embeds it from
`docs/assets/how-it-works.mp4` (served by jsDelivr, so it must stay **under 18 MB**; ~13 MB now)
behind the poster `docs/assets/how-it-works-play.jpg`.

```bash
npm run readme        # all:readme, copy the mp4 into docs/assets/, then thumb:readme
npm run qa:readme     # contact sheet + A/V onset check, as for the other cuts
npm run thumb:readme  # just the poster (needs only tts + timeline)
```

`thumb.mjs` renders the poster in the player page itself: the Diff scene once all three
differences are lit (`--t` picks another time), the headline, caption and chapter chrome hidden,
the scene dimmed, then the title, a play button dead centre and the real running time from
`timeline.json`. The JPEG quality steps down until the file is under 250 KB (`--max-kb`).
`--out`, `--title` and `--sub` override the rest. Re-run it whenever the cut's length changes.

## Finished renders

Copy a render you mean to post into `renders/` (`cp out/erd-studio-explainer* renders/`). The
folder is **gitignored**, like `out/`: the finished videos are kept on disk, not in git (an mp4
is 10–15 MB and git would keep every version for ever).

## Licences

As for the getting-started video: Kokoro-82M (Apache-2.0), espeak-ng (GPL-3.0, build-time tool
only), Inter and JetBrains Mono (OFL 1.1, `player/fonts/OFL.txt`), Playwright (Apache-2.0),
yaml (ISC). The underscore is generated by `music/synth_music.py`, the maintainer's own.
