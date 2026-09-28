# Scene brief — the plain-language cut (VARIANT=simple)

An ~85 s, 1080×1350 portrait LinkedIn video for people who know **nothing** about data
engineering: managers, founders, designers, anyone on LinkedIn. Same story as the pro cut
(`SCENES.md`, `script.yaml`), told with everyday words and pictures:

> The map of your company's data is probably wrong. For decades it was drawn in a separate tool
> for managers while engineers built the real thing elsewhere — like keeping the blueprints in a
> different city to the building site — so it stops being true, and now AI can't see it either.
> Fix: move the map next to the code as a simple text file; ERD Studio turns it into a picture,
> catches when the real thing stops matching, and the map and code change in one approval.
> Managers still see the picture on their wiki page.

Narration and beats: `script.simple.yaml`; real timings: `build-simple/timeline.json`.

## What must be true of every frame

- **No jargon on screen** unless it is part of the real product UI being shown. Never write, in
  your own labels: logical, physical, model, schema, dbt, YAML, JSON, SQL, warehouse, pipeline,
  domain, grain, primary/foreign key, column, table, pull request, repo, commit, merge. Use:
  map, picture, file, code, app, information, customers/orders/payments, change, approval,
  engineers, managers, AI.
- **The product is shown truthfully.** When a scene shows ERD Studio itself (the canvas, the
  toolbar, node cards via `node()` / `toolbar()`), draw it as it really looks — including its
  real labels like "Logical / Physical" and the PK/FK badges — and explain it with **plain
  callouts pointing at it** ("the map", "what's actually built"). Never relabel the real UI.
- **Concept scenes** (the map idea, the analogy, the AI guessing) are illustrations: friendly
  icon cards, simple shapes, big type. Draw icons as inline SVG in your own file (person,
  receipt, card, house, crane, folder, chat bubble…). The font subsets have no emoji, arrows or
  check marks.
- The example data is `SIMPLE` in `player/lib.js`: tables `customers`, `orders`, `payments`
  with everyday field names, `SIMPLE.ordersYml` (the REAL file format, cut short), the drift
  (`total` in the map, `order_amount` in the code) and the change (#128 "Add order status").

## Everything else is exactly as in SCENES.md

Read `SCENES.md` "What main.js already draws", "Rules" and "Look" — they all apply (pure
`render(t)`, inline styles only, stay inside `FRAME.stage` y 300–1090, ≥ 26 px body text,
beats with commented offsets, no third-party logos, own files only). Import helpers from
`'../../lib.js'` (these scenes live one folder deeper, in `player/scenes/simple/`). Legibility
matters even more here: fewer, bigger things. A 55-year-old manager on a phone must get each
scene in one glance.

Render stills with `VARIANT=simple node capture.mjs --stills <absolute times> --out build-simple/stills/<you>`.

## Scenes (start s · duration s · beats in scene-local seconds)

1. **simple/hook** (0 · 5.4 · wrong 0.35, fix 3.17, amber). *"The map of your company's data is
   probably wrong. / Here's why, and the simple fix."* The thumbnail: finished at **t = 0**. A
   friendly data map (three icon cards — customers, orders, payments — joined by lines) with a
   big, slightly rotated amber rubber stamp **OUT OF DATE** already on it, a couple of its
   fields highlighted amber as wrong. On `fix` (+0.3) the stamp lifts off / fades and the map
   "heals": lines redraw blue, the amber fields turn to green ticks. No pill that repeats the
   caption.
2. **simple/map** (5.40 · 7.28 · apps 0.35, map 3.93, blue). *"Every app keeps information:
   customers, orders, payments. / A data map shows what's kept, and how it all connects."* The
   three cards pop in one per spoken word (≈ apps +1.25 / +1.75 / +2.3 — measure the clip),
   each with an icon and 2–3 plain fields (name, email · date, total · amount). On `map` lines
   draw between them with plain labels ("places", "pays for"), then a tag "a data map".
3. **simple/apart** (12.68 · 12.64 · drawn 0.35, built 4.30, city 7.00, stale 10.29, amber).
   The heart of the video. *drawn → "For decades, that map was drawn in a separate tool, for
   the managers." / built → "The engineers build the real thing somewhere else." / city →
   "It's like keeping the blueprints in a different city to the building site." / stale → "So
   the map slowly stops being true."* On `drawn`: a light "drawing tool" window with the map
   and a "Managers" avatar. On `built`: a dark "the code" window (abstract code bars, not real
   code) with an "Engineers" avatar, far from the first. On `city`: cross-fade to the
   analogy — a **blueprint** sheet (blue grid paper, white house outline) on one side, a
   **building site** (crane, house frame) on the other, a long dashed road between them with a
   "different city" marker. On `stale`: the building visibly differs from the blueprint (an
   extra room / window, highlighted amber) and the blueprint gets a "last updated 14 months
   ago" stamp.
4. **simple/ai** (25.31 · 7.50 · ai 0.35, guess 2.33, blue). *"I wanted AI to help build it all.
   / But it could read the code, not the map. So it had to guess."* A generic "AI assistant"
   chat (no vendor names or marks): the user bubble types "Show me orders per customer"; on
   `guess` the AI "reads" the code (code icon ticks green) then looks for the map (map icon, amber
   "not found"), and draws a **guessed** mini-map with a wrong, wobbly amber line and "?" marks.
5. **simple/flip** (32.81 · 6.50 · moved 0.35, reads 4.15, green). *"So I moved the map right
   next to the code, as a simple text file. / Now the AI reads it too."* A big folder view
   "your project": code files, then the map file `orders.yml` slides in beside them with a
   green "the map" tag and a bracket "same place". On "a simple text file" a small text card
   pops open showing `SIMPLE.ordersYml` (it is the real format; label it just "plain text").
   On `reads`: the AI chat chip from the previous scene reads it, green tick.
6. **simple/picture** (39.31 · 8.27 · draw 0.35, both 4.33, blue). *"ERD Studio turns that file
   into a picture anyone can read. / Change the picture, the file changes. And the other way
   round."* The text file turns into the real ERD Studio canvas (`toolbar()` + `node()` for
   customers and orders + `edge()`), with a callout "the same map, as a picture". On `both`:
   a "status" row appears in the picture and `- name: status` in the file strip at the same
   moment, with a two-way arrow "picture ⇄ file".
7. **simple/catch** (47.59 · 7.50 · stops 0.35, lights 2.90, amber). *"And if what's really built
   stops matching the map, / it lights up the difference, before it causes problems."* The real
   canvas with its real toolbar; plain callouts point at the tabs: "Logical" → "the map",
   "Physical" → "what's actually built". The Diff button turns amber on `lights`; the orders
   node shows `total` (map only, struck) vs `order_amount` (in the code only) lit amber, a "1
   difference" pill, then a green "caught early" note.
8. **simple/together** (55.09 · 11.0 · one 0.35, rts 3.47, sense 6.47, green). *"Now the map and
   the code change together, in one approval. / Reviewed together. Tracked together. Shipped
   together. / It's just common sense. Why did this take us decades to figure out?"* A plain
   "Change #128 · Add order status" card holding two items — "The map" and "The code" — with
   an "1 approval" pill on `one`. On `rts`: three big checklist rows tick on each word
   (Reviewed ✓ · Tracked ✓ · Shipped ✓ — measure `x_rts.wav`), the card turns "Live". Hold calm
   for the rhetorical question; optional subtle touch, nothing that repeats the caption.
9. **simple/business** (66.09 · 6.0 · mgr 0.35, blue). *"And managers still see the picture,
   right on their team's wiki page."* Same idea as `scenes/business.js` (read it): a light team
   wiki page titled "Customer orders" holding the **real** macro render
   `/social-video/player/assets/confluence-simple.png` (1760×1110, 880×555 CSS), a "Managers ·
   Sales · Finance" line, the "ERD Studio for Confluence" callout on "picture", and a green
   pill "No developer tools needed" late in the line.

`stars` and `endCard` are shared with the pro cut and already done.
