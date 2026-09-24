# Scene brief — LinkedIn explainer

A ~99 s, 1080×1350 portrait video for the LinkedIn feed. Its job is to **stop the scroll, teach,
and sell**: the logical data model has been built backwards for decades (for business users
first, developers working backwards from a picture). ERD Studio flips it: the logical model is
plain files in the repo, next to the SQL, built for developers and their AI first, and
*rendered* for the business.

Most viewers watch **muted on a phone** (the frame is shown ~390 pt wide, so 1 px ≈ 0.36 pt).
Everything must read at that size: body text **≥ 26 px**, labels **≥ 24 px**, hero words 40 px+,
code 26–28 px. Prefer fewer, larger things over detailed ones. Every scene needs **one hero
moment** that lands on the narration beat named below: motion keyed to that beat, not decoration.

## What main.js already draws (do not duplicate)

- Kicker `ERD STUDIO · CHAPTER` (top-left), the two-line **headline** (y 102–245), the
  **burned-in caption** (y 1112–1232) and the **chapter bar** (y 1262+).
- The scene fade-in/out and a 14 px rise. The hook scene is fully drawn at frame 0.
- Scene content goes inside `FRAME.stage` = `{ x: 64, y: 300, w: 952, h: 790 }` (y 300–1090).
  Nothing may go below y 1090 (captions) or above y 290 (headline).

## Rules (capture depends on them)

- `export default { render(t, { beats, dur, scene }) { return htmlString } }`. `t` is seconds from
  scene start. `beats.<name>.t` / `.end` are the start/end of each narration line (scene-local
  seconds, from the real audio). Key every animation off beats, with small commented offsets to
  land on a word ("+1.1 → 'SQL'").
- **Pure**: no timers, `Date`, `Math.random`, CSS transitions, `@keyframes` or `animation`.
  Motion comes only from `t` (use `appear`, `seg`, `easeOut`, `easeInOut`, `lerp`, `mix`, `path`,
  `typed`, `caret`, `spinner` from `../lib.js`).
- Absolute positioning in frame pixels. **Inline styles only**: do not edit `style.css`,
  `lib.js`, `main.js` or anyone else's scene. Put helpers you need inside your own scene file.
  You may *use* every class in `style.css` (`.card`, `.node`, `.badge--pk`, `.pill`, `.tb`,
  `.code`, `.k/.v/.s/.kw/.p`, `.grid-bg`, …) and every export of `lib.js`.
- Colours: use the tokens in `style.css` `:root` (`var(--amber)`, `var(--logical)`, …) or
  `COLORS`/`ACCENT` from lib.js. Logical is **blue**, physical is **green**, drift is **amber**.
- Fonts: Inter and JetBrains Mono only. The font subsets have **no arrows, check marks or
  emoji**: draw them with `ICON.*` (inline SVG).
- No third-party logos (GitHub, Atlassian, Microsoft, dbt Labs, Anthropic). Generic window
  chrome with a text label is fine, as in the reference video. The ERD Studio icon is `appIcon()`.
- Use the shared example in `STORY` (lib.js): `dim_customer` ← `fct_order`, the exact YAML and
  JSON lines, the drift trio and the PR. Every scene tells the story with the same data.
- `node(...)` rows are 46 px with 22 px text. On this frame that is the *minimum*; wrap node
  groups in a container with `transform:scale(1.15–1.3);transform-origin:…` when it helps.

## Look

Match the existing videos: dark cards with window chrome (`card()`), the ERD node style
(`node()`, `edge()`, `toolbar()`), amber drift callouts, green success pills, generous spacing,
calm eased motion (0.3–0.5 s entrances), nothing bouncy or gimmicky. Reference frames:
`/private/tmp/claude-501/-Users-liamwynne-GIT-LIAM-erd-studio/83257a30-aeb6-47d8-9ff5-aeebc57056c3/scratchpad/strip.jpg`
(the previous 4-slide LinkedIn video). Reference scene code (1920×1080, same helpers):
`/Users/liamwynne/GIT/LIAM/erd-studio/.claude/worktrees/onboarding-guide/video/player/scenes/*.js`
(`verify.js`, `writes.js`, `explore.js`, `twoWays.js`, `endCard.js` are the best examples).

## Scenes

Narration and beats: `script.yaml`; real timings: `build/timeline.json` (`scenes[].start`,
`.dur`, `.beats`). Accent = the scene's highlight colour in the headline.

1. **hook** (`hook.js`, amber). *"For decades, we've built the data model backwards. / Here's
   the fix, and why your AI needs it."* The thumbnail frame: it must be striking **at t = 0**
   (no entrance on the main element). Hero: a real-looking ERD (dim_customer + fct_order,
   edge) drawn **upside down** (rotated 180°, desaturated/dim, a faint amber "wrong way" feel).
   On `loop` (+0.3 s) it **rotates the right way up** (eased ~0.9 s) and its borders go logical
   blue, and a small pill appears: sparkle icon + "and why your AI needs it" (or similar). Big and
   centred, simple.
2. **problem** (`problem.js`, amber). *drawn → "…for business users, in a separate tool." /
   back → "Developers work backwards from the picture," / drift → "…drifts from the warehouse,
   and nobody trusts the diagram."* Two stacked windows: top, a browser-style **modelling SaaS**
   window ("modeller.app", a small diagram, a business-user avatar/label "Business"); bottom, the
   **repo** window (`models/marts/fct_order.sql`, `dim_customer.sql`, recent commit times). On
   `back`: an arrow from the diagram down to the code labelled "work backwards". On `drift`: the
   link between them breaks/dashes amber, the diagram gets a "Last updated 14 months ago" stamp
   and its column list visibly disagrees with the code (amber), then a "Nobody trusts it" stamp.
3. **ai** (`ai.js`, blue). *vibe → "Then I tried to vibe code data engineering." / blind → "My AI
   could read every line of SQL, but it couldn't see the design." / guess → "What's the grain?
   Which keys? It had to guess."* A terminal card "Claude Code": the prompt types
   `build a daily orders mart` (or similar); then `Read(models/**/*.sql)` → "42 files" with a green
   tick; then "Looking for the data model…" → amber "not in this repo". On `guess`: a ghost
   node card for fct_order with `grain: ???` and `?` badges on the key columns, amber, maybe a
   gentle wobble between two guesses ("one row per order?" / "one row per order line?").
4. **flip** (`flip.js`, green). *flip → "So flip it. Build the logical model for developers
   first," / repo → "and save it in the repo, right next to the SQL."* On `flip`: a two-row
   priority stack "1 Business users / 2 Developers" physically **swaps** (developers to the
   top, business below as "sees a rendered view"). On `repo`: a repo file tree (VS Code-style
   explorer: `models/marts/` with the two `.sql` files) where
   `.erd-studio/logical-models/dim_customer.yml` and `fct_order.yml` (+ `silver/orders.json`)
   slide in alongside, highlighted green, with a bracket/label "same repo · same PR". Keep the
   tree large.
5. **yaml** (`yaml.js`, blue). *file → "Each table is one small YAML file," / fields → "with its
   grain, columns, types and keys." / domain → "A domain file groups the tables and says how
   they join."* Educational core. A code card `fct_order.yml` (crumb `.erd-studio › logical-models`)
   that types/reveals `STORY.fctOrderYml` from `file`. On `fields`: callout tags light up the
   grain line, a `dataType` line and the `isPrimaryKey`/`isForeignKey` lines (tags "GRAIN",
   "TYPE", "KEY"). On `domain`: the YAML card slides/shrinks up and an `orders.json` card
   (`STORY.ordersJson` via `jsonLine`) takes over, highlighting the `models` list and the
   `relationships` entry (`fct_order.customer_id → dim_customer.customer_id`, many-to-one).
6. **canvas** (`canvas.js`, blue). *draw → "ERD Studio draws those files as a diagram, inside VS
   Code." / sync → "Edit either one, and the other updates."* An editor card (tab `orders.json`,
   crumb `.erd-studio › silver`) with the logical canvas: `toolbar()` (Logical on) and the two
   nodes stacked with the edge drawing in. On `sync`: a two-way demo, e.g. a small YAML strip
   gains `- name: order_status` and the node grows the row in the same beat (both highlighted),
   with a ⇄ indicator "files ⇄ diagram".
7. **physical** (`physical.js`, green). *logical → "Logical is the design: what you mean." /
   physical → "Physical is what dbt actually builds, read straight from your project."* The
   same canvas; the toolbar flips from Logical (blue) to Physical (green, lock icon, read-only
   tab over the node like `node({lock:true})`), node borders blend blue→green (`stage` 0..1). On
   `physical`: source chips feed in from below: `models/*.sql`, `schema.yml`, `manifest.json`,
   `catalog.json`, labelled "read from your dbt project · nothing to maintain".
8. **diff** (`diff.js`, amber). *best → "Now the best part." / press → "Press Diff." / lights →
   "A renamed column, a wrong type, a missing relationship. Every mismatch lights up before it
   ships."* The payoff. Canvas with `toolbar()`; a pointer (`pointer`/`path`) moves to Diff and
   clicks on `press` (+0.2); Diff turns amber. Then in narration order (≈ +0.0, +1.2, +2.4 s
   into `lights`, check against the audio): `order_total` vs `order_amt` (logical-only row
   struck through + physical-only row with an "only in dbt" pill), `order_date` DATE vs
   TIMESTAMP (types stacked, like the reference `verify.js`), and the relationship edge going
   dashed amber with "no relationships test in dbt". A count pill "3 differences". End on a
   short "caught before it ships" note.
9. **pr** (`pr.js`, green). *same → "The design change and the SQL change ship in the same pull
   request." / review → "Reviewed together. Tracked together." / ai → "And your AI reads the
   model before it writes a single line."* A generic PR card: `#128 Add order_status to
   fct_order`, "Files changed 2": `.erd-studio/logical-models/fct_order.yml` (+ `- name:
   order_status` / `dataType: VARCHAR`) and `models/marts/fct_order.sql` (+ `order_status,`), diff
   lines green. On `review`: "Approved" + a "1 PR · design + code" pill. On `ai`: a compact Claude
   Code strip: `Read(fct_order.yml)` → "grain: one row per order · PK order_id" → `Write(…sql)` ✓.
10. **business** (`business.js`, blue). *lose → "And the business doesn't lose a thing." / conf →
   "ERD Studio for Confluence renders the same files on a page. No GitHub account needed."* A
   generic team-wiki page mock (title "Orders data model", breadcrumb "Data / Models", no
   Atlassian branding) with an embedded read-only diagram macro, header "ERD Studio for
   Confluence · acme/analytics · main". From `conf`: a thin line/arrow from a small repo files
   chip into the page, then a pill "Viewers need no GitHub account".
11. **noDbt** (`noDbt.js`, green). *dbt → "Not on dbt? Use it for your logical model today." /
   more → "Support for more tools is on the way."* Two compact rows/cards: "With dbt:
   Logical · Physical · Diff" (all ticked) vs "Without dbt: Logical ✓" with Physical/Diff dimmed
   "coming". On `more`: a dashed "+ more tools" chip. Do **not** name specific future tools.
12. **endCard** (`endCard.js`, green). *name → "ERD Studio. Free, with the source on GitHub." / cta →
   "Search ERD Studio in VS Code. Link in the comments."* No headline (main.js hides chrome here).
   Centred: `appIcon(200)`, "ERD Studio" (big), "The logical model, in your repo." sub-line,
   pills "Free", "Source on GitHub", "VS Code" (the licence is PolyForm Shield 1.0.0: source-available, not OSI open source — never say "open source" or "MIT"), then on `cta`: a search-box mock
   (`Extensions: ERD Studio`) and "Link in the comments" with a down chevron. Everything should
   have landed by `cta` + 1.5 s: the last frame is held and can be the thumbnail.
