# README cut — scene direction

`VARIANT=readme`: "How ERD Studio works", committed as `docs/assets/how-it-works.mp4` and linked
from the README and `docs/dbt.md`. A DBML-first tour of the **logical model**; dbt is a short last
beat. Narration: `script.readme.yaml`. Scenes: `player/scenes/readme/*.js` (plus the shared
`endCard`). The example is `R` in `player/scenes/readme/story.js`: a `gold` layer, the tables
`dim_customer` and `fct_order` in schema `gold`, and the `sales` diagram — written exactly as ERD
Studio 2.0 writes a new project:

```
.erd-studio/gold/tables/gold/<table>.dbml     one Table each
.erd-studio/gold/relationships/gold.dbml      the layer's default relationships file
.erd-studio/gold/diagrams/sales.dbml          use lines + Project sales { erd_layout }
```

Every label on screen is the product's own: `src/types/startActions.ts`, `package.json` command
titles, the webview toolbar (`Compare with dbt`, `Stop comparing`, `{ } View File`, `+ Add`, the stage
tabs `Logical · your design` / `Physical · read from dbt`), the DiscrepancyPanel's counts, the
Import picker (`src/commands/importModel.ts`), the draft banner (`src/services/draftModel.ts`)
and Export Diagram's format picker (`src/commands/exportDiagram.ts`). Wording follows
`docs/dev/onboarding-and-cli.md` → "User-facing wording": DBML is an open format (never an open
standard); ERD Studio is free to use, source available (never "open source"); "diagram";
"Set Up My AI Helper". Words are timed with `wordAt()` (story.js), from the real clip lengths.

| # | Scene | Chapter | What is on screen |
|---|---|---|---|
| 1 | `hook` | WHY | Frame 0 is the finished logical diagram. *Tables, grain, keys, joins* light up on their words. Then the diagram is packed off into a light, separate browser tool; the repo arrives below, the link between them snaps on "drifts" ("Last updated 14 months ago"; `orders.sql` changed `order_date` to TIMESTAMP — the same drift the dbt beat finds), and the AI in the repo finds no data model. |
| 2 | `flip` | WHY | The repo's Explorer: `.erd-studio/` slides in above `sql/` on "in Git"; a bracket spans the model and the SQL — same repo, same PR. |
| 3 | `tree` | DBML | The same Explorer, `.erd-studio/` expanded to the layer-first tree. "DBML" lights the `.dbml` rows, ".dbml · an open format · no lock-in" builds on the right; then A LAYER, ONE FILE PER TABLE (with "a schema" on the schema folder), RELATIONSHIPS, DIAGRAMS tag their groups on their words. |
| 4 | `files` | DBML | `fct_order.dbml` (with a hand-written comment) — COLUMNS, KEYS, GRAIN tag their lines. It folds away for `relationships/gold.dbml` (the Ref line lit: ONE REF LINE) and `diagrams/sales.dbml` (ITS TABLES on the `use` lines, POSITIONS on `erd_layout`). |
| 5 | `canvas` | EDIT | `sales.dbml` on the canvas (no Logical/Physical tabs: no dbt here), each table labelled with its `.dbml` file. `status VARCHAR` is typed into `fct_order.dbml` (the tab's dirty dot shows), the file is saved ("saved") and the node grows the row on "follows" — the canvas follows a table file on save; then the comment on line 1 lights up, "your comment, kept". The README poster frame (`props.poster`). |
| 6 | `pr` | EDIT | PR #128: `fct_order.dbml` gains one aligned line ("+1 line" on "readable diff"); `sql/orders.sql` (the file the hook and flip show) joins it, one green outline, "1 PR · design + code". |
| 7 | `ai` | AI | Command Palette → ERD Studio: Set Up My AI Helper ("teaches your assistant these files"); Claude Code, GitHub Copilot, Codex, Gemini CLI and Cursor tick in on their names (`.claude/skills/` / `.agents/skills/`). Then a Claude Code session writes `dim_date.dbml` and edits `relationships/gold.dbml` and `diagrams/sales.dbml`; the canvas shows the whole `sales` diagram (`dim_customer`, `fct_order` with its `status` column) with the new table and its relationship, "review it, then commit". |
| 8 | `import` | IMPORT | The Import picker lights DBML file, SQL DDL scripts and Power BI or Fabric semantic model on their words. The draft preview, laid out as `DraftBanner`: "Draft from 4 SQL files (PostgreSQL) · 6 tables, 5 relationships · not saved", the Keep detail, the Change options… link, then Keep as Diagram · More ways to start ▾ · Discard; Keep as Diagram pressed on "keep it" and the diagram opens. Export Diagram's picker: Mermaid, DBML, Rich DBML, with the product's full details. |
| 9 | `dbt` | DBT | ~10 s, the same `sales` diagram (with `status`). "Open the project": Compare with dbt joins the toolbar and the stage tabs row appears under it, *Logical · your design* / *Physical · read from dbt* (`dbt_project.yml` found). Physical: green, the lock on its tab, no + Add, "read-only · read from dbt" — `order_date` a TIMESTAMP, an extra `loaded_at` column, no relationship. Back on Logical, Compare with dbt → Stop comparing: three differences, marked as the canvas draws them — both types stacked on `order_date`, `loaded_at` as a ghost row under ONLY IN PHYSICAL with its "physical only" badge, the relationship dbt has no test for dashed amber — and the DiscrepancyPanel bottom right: "Logical (current) vs Physical (target)", 2 matched · 1 type diff · 1 col diff · 1 rel diff, ⊕ Sync. No rename: the product's diff has no rename detection. |
| 10 | `endCard` | — | "Design your data model in Git." Pills: Free to use · Source available. The Extensions search, "Also on Open VSX". |
