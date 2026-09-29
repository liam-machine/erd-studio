# Scene brief — the onboarding cut (VARIANT=onboard)

A ~68 s, 1080×1350 portrait LinkedIn video for **analytics / data engineers who use dbt**. It
shows the first run after the onboarding release, as a user would really see it:

> Install ERD Studio, open your dbt project, and the Get started guide opens by itself. Click
> **Draw from dbt**, pick a folder like your marts, and it reads your models and relationship
> tests and lays out the diagram for you — no AI needed. Switch to Physical to see what dbt really
> built, Compare to spot drift. Then ask your AI assistant to enrich it (keys, grain, the reason
> behind every table), saved as plain files next to your code. No dbt project? Open the sample
> in GitHub Codespaces, nothing to install. And teammates who open the repo find the diagrams
> already there.

Narration and beats: `script.onboard.yaml`; real timings: `build-onboard/timeline.json`.

## Everything in SCENES.md applies

Read `SCENES.md` "What main.js already draws", "Rules" and "Look": pure `render(t)`, inline
styles only, stay inside `FRAME.stage` (y 300–1090), body text ≥ 26 px, labels ≥ 24 px, beats
with commented offsets, no third-party logos (no VS Code, GitHub, Codespaces, dbt Labs or AI
vendor logos — generic window chrome with a text label is fine), no emoji/arrows/ticks from the
font (use `ICON.*` or your own inline SVG), own files only. Import helpers from `'../../lib.js'`
(these scenes live in `player/scenes/onboard/`). Render stills with
`VARIANT=onboard node capture.mjs --stills <absolute times> --out build-onboard/stills/<you>`.

## Show the product truthfully

These are the REAL UI labels (check them against the code named, and use the code's exact
wording if it differs):
- Walkthrough (package.json `contributes.walkthroughs`, id `erdStudio.getStarted`): title
  **"Get started with ERD Studio"**, description "Draw your dbt project as an ERD in a minute, then enrich it with your AI
  assistant.", steps in order: "Watch the one-minute tour", "No dbt project? Try the sample", "Open
  your dbt project", "Draw your dbt project — no AI needed" (button **Draw from dbt**), "Enrich it
  with your AI assistant" (button **Set Up My AI Helper**). It appears in VS Code's Welcome editor: a left column of step rows
  (a circle that fills when done, the title, the open step expanded with its description and a
  blue button) and the step's image on the right (`media/walkthrough/*.svg` — you may inline a
  simplified version of the real SVG).
- Command: **"ERD Studio: Draw from dbt…"** (`erdStudio.drawFromDbt`). Its QuickPick has the
  title "Draw from dbt", placeholder "Which dbt models should the diagram start from?", one row
  per folder with a folder icon (`marts` · "6 models", `staging` · "6 models", detail = the first
  model names) and a last row "Choose models…" with a checklist icon. After picking, a second
  QuickPick "Which layer is this diagram for?" (Bronze / Silver / Gold) and an input box for the
  diagram name — skip those in the video or show them as one quick flash.
- The canvas: `toolbar()` (domain name, layer badge `GLD`, Logical / Physical tabs, Diff button),
  `node()` cards, `edge()` lines with 1 / * marks. Logical is blue, Physical is green, drift is
  amber.
- The sidebar status bar item: **"ERD N"** with a hierarchy icon, tooltip "Open an ERD Studio diagram", and
  the one-time notification **"This project has N ERD Studio diagrams."** with a button
  "Open <name>" and "Not now".
- The AI step: the user types **`/erd-studio-setup`** into a generic "AI assistant" chat panel
  (no vendor name or mark).
- The sample: a browser window at `github.com/liam-machine/erd-studio-sample` with an
  **"Open in GitHub Codespaces"** button (draw a generic button, not GitHub's logo), then a
  browser tab titled "erd-studio-sample — Codespaces" showing VS Code-style chrome with the canvas
  already open.

Example data — the real sample (`liam-machine/erd-studio-sample`, a Kimball jaffle shop): the
marts folder has 6 models — `dim_customers`, `dim_dates`, `dim_locations`, `dim_products`,
`fct_orders`, `fct_order_items`. Show at most four big nodes: `dim_customers` (PK customer_id,
customer_name), `dim_products` (PK product_id, product_name, product_price), `fct_orders`
(PK order_id, FK customer_id, order_date, order_total), `fct_order_items` (PK order_item_id,
FK order_id, FK product_id). Types: VARCHAR / DATE / DECIMAL(16,2). The diagram is `orders`,
layer badge `GLD`, domain file `.erd-studio/gold/orders.json`. The real grain of fct_orders is
"One row per order"; its real rationale starts "Revenue, tax and cost per order".

## Scenes (start s · duration s · beats in scene-local seconds)

1. **onboard/hook** (0 · 6.39 · minute 0.35, noai 3.82, blue). *"Your dbt project, as a diagram,
   in under a minute. / No setup. No AI required."* The thumbnail — finished at **t = 0**. Hero: a
   split image. Left, a stack of dbt files (a file list card: `models/marts/` with
   `dim_customers.sql`, `fct_orders.sql`, `schema.yml`…); right, the finished blue ERD of the four
   tables. Between them a large "60 s" timer chip / stopwatch shape. On `noai` (+0.3) two pills
   land under it: "No setup" and "No AI required" (with ICON ticks) — no longer than 3 words each.
2. **onboard/install** (6.39 · 7.85 · install 0.35, guide 5.08, blue). *"Install ERD Studio for VS
   Code, and open your dbt project. / A short Get started guide opens by itself."* An editor
   window (generic chrome, crumb "jaffle-shop"): first the Extensions view with the ERD Studio
   entry (`appIcon`, name, "Install" button that the pointer clicks at ~+1.0 and becomes
   "Installed"), then (~+2.8, "open your dbt project") the explorer shows `dbt_project.yml`,
   `models/`, `target/`. On `guide` the Welcome editor slides in: the real walkthrough — title
   "Get started with ERD Studio", the five step rows, "Draw your dbt project — no AI needed"
   highlighted as next, its image on the right.
3. **onboard/draw** (14.24 · 7.00 · click 0.35, pick 1.96, blue). *"Click Draw from dbt. / Pick a
   folder, like your marts."* Zoom on the walkthrough step "Draw your dbt project — no AI
   needed" with its blue **Draw from dbt** button; the pointer clicks it on `click` +0.6. On
   `pick` the command palette QuickPick drops from the top: title "Draw from dbt", placeholder
   "Which dbt models should the diagram start from?", rows `marts` · 6 models (highlighted),
   `staging` · 6 models, "Choose models…"; the pointer/selection lands on `marts` at ~+1.4 and it confirms (a brief
   press). Keep the rows big (≥ 30 px).
4. **onboard/canvas** (21.24 · 8.00 · copies 0.35, layout 3.12, blue). *"It reads your models and
   your relationship tests, / and lays out the diagram for you. Nothing to drag."* The hero
   moment. On `copies`: a canvas editor tab `orders.json` opens with the four node cards
   arriving jumbled/stacked at one spot (as a fresh domain paints before layout), while small
   source chips "schema.yml" and "relationships tests" feed in. On `layout` (+0.2): the cards
   glide (eased ~1.0 s) into a clean star layout, the edges draw in with 1 / * marks, and a
   subtle pill "Auto layout" appears. On "Nothing to drag" (~+2.2) a quiet `pointer` sits still /
   a crossed-out drag hint. Big nodes (scale up the node group ~1.15).
5. **onboard/check** (29.24 · 8.00 · physical 0.35, compare 3.43, green). *"Switch to Physical to
   see what dbt really built, / and Compare to spot where the design and the code disagree."*
   Same canvas geometry as scene 4. On `physical` +0.4 the pointer clicks the Physical tab: tab
   turns green with the lock, node borders blend blue → green (`stage` 0..1), a pill "read from
   manifest.json + catalog.json". On `compare`: back to Logical, the pointer clicks Diff (it turns
   amber), and one mismatch lights on `fct_orders`: `order_total` struck through (design only) vs
   `order_amount` with an "only in dbt" pill, plus a count pill "1 difference". Keep it to one
   difference: this video is about the first run, not the diff.
6. **onboard/enrich** (37.24 · 9.00 · ask 0.35, keys 2.66, repo 5.72, blue). *"Then ask your AI
   assistant to enrich it. / Keys, grain, and the reason behind every table, / saved as plain files
   next to your code."* Left/top: a generic "AI assistant" chat panel; the user types
   `/erd-studio-setup` on `ask` and the assistant replies "Your diagram mirrors dbt. I'll add keys,
   grain and rationale." On `keys`: the `fct_orders` node gains PK / FK badges one by one, a grain
   line "One row per order" appears, and a small rationale note "Why: revenue, tax and cost per order" (keep ≥ 24 px). On `repo`: a file tree card slides in showing
   `.erd-studio/logical-models/fct_orders.yml` (+ `dim_customers.yml` …) and
   `.erd-studio/gold/orders.json` beside `models/marts/` with a green "next to your code" bracket.
7. **onboard/sample** (46.24 · 7.00 · nodbt 0.35, nothing 4.66, green). *"No dbt project? Open the
   sample in GitHub Codespaces. / Nothing to install."* A browser window at
   `github.com/liam-machine/erd-studio-sample` with the repo title and a big generic green button
   "Open in GitHub Codespaces"; the pointer clicks it at ~+2.4; the window turns into a browser tab
   "erd-studio-sample — Codespaces" showing editor chrome with the same blue canvas already open
   (reuse scene-4 geometry, smaller). On `nothing`: a green pill "Runs in your browser".
8. **onboard/team** (53.24 · 7.00 · team 0.35, green). *"And when a teammate opens the repo, the
   diagrams are already there."* A second editor window labelled with a teammate avatar ("Priya
   opens the repo" — a generic initial-circle avatar, no photo) and the explorer showing
   `.erd-studio/`. ~+1.6: the one-time notification (bottom-right of the window, VS Code-style)
   "This project has 3 ERD Studio diagrams." with buttons "Open orders" / "Not now", and the status
   bar item "ERD 3" lights up green at the bottom. ~+3.2 the pointer clicks "Open orders" and the
   canvas opens (small). End calm.

`endCard` is shared: it gets `props.tagline` "Your dbt project, drawn in a minute."
