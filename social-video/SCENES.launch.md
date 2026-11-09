# Scene brief — the 2.0 launch post (`VARIANT=launch`)

A ~2:20, 1080×1350 LinkedIn feed video for ERD Studio 2.0. Voice only (Kokoro `af_heart`, no
music), burned-in captions. Narration: `script.launch.yaml`. The frame rules are `SCENES.md`'s
(stage y 300–1090, pure `render(t)`, inline styles, `ICON.*`, body text ≥ 24 px); the look is the
README cut's (`player/scenes/readme/`).

**The story** (Liam, 2026-11-10): the pro cut's arc (`script.yaml`) with 2.0 facts, the
interesting part first, getting started last. THE PROBLEM: we've built the data model backwards
for decades, and your AI can't see the design. THE FIX: the model in the repo as DBML (an open
format), drawn by ERD Studio, edited by hand or by your AI, built for big models, one pull request,
ERD Studio for Confluence for the business. GET STARTED: bring it in from what you use (the
reverse-engineering nod lives here, never in the hook), one step out, a draft first, dbt as an
add-on, free to use in VS Code. Two examples: the fix act edits the README cut's `R` (gold
`dim_customer` ← `fct_order`, `status` added); the get-started act imports the shop's `sales`
schema (`player/scenes/launch/story.js`, real pg_dump and draft output).

| # | Scene (module) | Chapter | On screen | Lands on |
|---|---|---|---|---|
| 1 | `hook` (pro cut) | THE PROBLEM | dim_customer ← fct_order upside down, "drawn the wrong way up"; turns the right way up, "the right way up". Frame 0 is finished | the turn on "Here's the fix" |
| 2 | `launch/problem` | THE PROBLEM | A generic light "Modelling tool" window ("drawn for the business") over the repo's `sql/`; a dashed "working backwards from the picture" line; it snaps: "Last updated 14 months ago", `orders.sql` "add loaded_at column", "drifts from the code", a NOBODY TRUSTS IT stamp | "business", "separate", "Developers", "backwards", "drifts", "nobody" |
| 3 | `ai` (pro cut) | THE PROBLEM | Claude Code: `build a daily orders mart`, Read(models/**/*.sql) 42 files, no data model; a guessed fct_order flips between grains and keys | the pro cut's offsets from each line |
| 4 | `readme/flip` | THE FIX | The repo's Explorer: `.erd-studio` slides in above `sql/`; "same repo, same PR" | "DBML", "next" |
| 5 | `readme/canvas` | THE FIX | `sales.dbml` on the canvas; `status VARCHAR` typed into `fct_order.dbml`, the node grows the row | "diagram", "VS Code", "follows" |
| 6 | `launch/aiwrite` | THE FIX | Claude Code: the prompt, Skill(erd-studio), Write/Edit the three files; dim_date lands on the canvas, "review it, then commit" | "ask", "skill", "appears", "canvas" |
| 7 | `launch/scale` | THE FIX | A REAL 2,000-table `ErdCanvas` take (`scale-clip.mjs`): overview, zoom while the lines route, straight lines jump to routed curves, the hover on `sales.dim_store` with flowing arrows. Chips "2,000 tables · 2,719 relationships", "Routing lines in the background" → "Lines routed in the background". **The poster** (`props.poster`) | the take's own clock (`build-launch/clip/meta.json`) |
| 8 | `launch/pr` | THE FIX | PR #128 Add status to fct_order: the `.dbml` line, `sql/orders.sql` joins, one outline, Approved, Merged, "1 PR · design + code" | "the SQL", "same pull", "Reviewed", "Shipped", "decades" |
| 9 | `launch/confluence` | THE FIX | The repo → a light Confluence page "Sales data model" with the real viewer-mode render of the same diagram (`confluence-sales.png`), viewers, Read-only, No VS Code needed | "ERD Studio for Confluence", "reads", "GitHub", "business", "view", "no VS Code" |
| 10 | `launch/wall` | GET STARTED | All 14 sources as official logos, same size (5 + 5 + 4), grey silhouettes from the start, each lit in its colours as named; then **still ≥ 4 s** under "Whichever you start from…". Secondary still (`thumb.mjs --scene wall`) | each name in `list` |
| 11 | `launch/export` | GET STARTED | Snowflake `GET_DDL('SCHEMA', 'SHOP.SALES')` above PostgreSQL `pg_dump --schema-only -d shop -f sales.sql`; "whole schema · 6 tables" | "Snowflake", "PostgreSQL", "whole schema" |
| 12 | `launch/draft` | GET STARTED | Import… (SQL DDL scripts) → "Draft from 1 SQL file (PostgreSQL) · 6 tables, 5 relationships · not saved" → Keep as Diagram → what Keep wrote | "draft", "Keep as Diagram", "DBML files" |
| 13 | `readme/dbt` | GET STARTED | In a dbt project: the read-only Physical tab, then Compare with dbt marks the physical-only column and the missing relationship test | "Physical", "read-only", "marks" |
| 14 | `endCard` (shared) | — | "Your data model, in Git." · Free to use in VS Code · Source available · Extensions search · Also on Open VSX | as the README cut |

**Claims and their evidence.** No routing time is shown: it depends on the machine (Liam,
2026-11-10). The chip switches when the take's routed pass lands; `meta.json` keeps the measured
time (`routedSec`, first draw to routed; the worker's own pass in `routing`). The narration only
says "in a few seconds". Nothing claims smooth dragging,
fast import of thousands of tables, instant open or any size. Confluence is never "free" and has
no price. DBML is "an open format".

**Render**

```bash
cd social-video
npm run all:launch    # tts → timeline → clip:launch (a new real-time take) → music (none) → capture → encode → thumb:launch
npm run qa:launch     # contact sheet + A/V onset check
npm run clip:launch   # re-shoot only the scale take (needs tts + timeline); then capture + encode
node confluence-shot.mjs --launch   # re-render player/assets/confluence-launch.png
```

`clip:launch` regenerates the 2,000-table project with `video/record/bigProject.mjs` into
`build-launch/big/` (gitignored), reads it with core's `loadDisplaySubjectArea`, and records the
take in Chrome (the routing worker inlined as the extension inlines it). Run it on a quiet machine:
on a busy one the lines take longer to land, and the take may run out of time before the hover.
