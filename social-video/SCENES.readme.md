# README cut — scene direction

`VARIANT=readme`: "How ERD Studio works", committed as `docs/assets/how-it-works.mp4` and linked
from the README and `docs/dbt.md`. A DBML-first tour of the **logical model**; dbt is a short beat
near the end, then ERD Studio for Confluence for readers without VS Code. **Voice only**: the script
says `music: false`, so `music.py` writes no bed and `encode.sh` normalises the voice alone to
−14 LUFS. Narration: `script.readme.yaml`. Scenes: `player/scenes/readme/*.js` (plus the shared
`endCard`). The example is `R` in `player/scenes/readme/story.js`: a `gold` layer, the tables
`dim_customer` and `fct_order` in schema `gold`, and the `sales` diagram — written exactly as ERD
Studio 2.0 writes a new project:

```
.erd-studio/gold/tables/gold/<table>.dbml     one Table each
.erd-studio/gold/relationships/gold.dbml      the layer's default relationships file
.erd-studio/gold/diagrams/sales.dbml          use lines + Project sales { erd_layout }
```

Every label on screen is the product's own: `src/types/startActions.ts` (and the start quick pick's
items, `START_PICK_ITEMS` in `src/commands/start.ts`), `package.json` command
titles, the webview toolbar (`Compare with dbt`, `Stop comparing`, `{ } View File`, `+ Add`, the stage
tabs `Logical · your design` / `Physical · read from dbt`), the DiscrepancyPanel's counts, the
draft banner (`src/services/draftModel.ts`)
and Export Diagram's format picker (`src/commands/exportDiagram.ts`). Wording follows
`docs/dev/onboarding-and-cli.md` → "User-facing wording": DBML is an open format (never an open
standard); ERD Studio is free to use, source available (never "open source"); "diagram";
"Set Up My AI Helper". Words are timed with `wordAt()` (story.js), from the real clip lengths.
Third-party marks (Power BI, SQL Server, the SQL dialects, dbt, Confluence, GitHub) are the
official files in `player/assets/logos/`, with their sources and terms in `LOGOS.md`; MySQL and
DBML deliberately have none (`LOGOS.md` says why). ERD Studio
for Confluence is described only as it works (`docs/dev/compatibility.md`: it reads the committed
`.erd-studio/` folder from GitHub and draws a diagram read-only), never as free and with no price.

| # | Scene | Chapter | What is on screen |
|---|---|---|---|
| 1 | `hook` | WHY | Frame 0 is the finished logical diagram. *Tables, grain, keys, joins* light up on their words. Then the diagram is packed off into a light, separate browser tool; the repo arrives below, the link between them snaps on "drifts" ("Last updated 14 months ago"; `orders.sql` changed `order_date` to TIMESTAMP — the same drift the dbt beat finds), and the AI in the repo finds no data model. |
| 2 | `flip` | WHY | The repo's Explorer: `.erd-studio/` slides in above `sql/` on "in Git"; a bracket spans the model and the SQL — same repo, same PR. |
| 3 | `tree` | DBML | The same Explorer, `.erd-studio/` expanded to the layer-first tree. "DBML" lights the `.dbml` rows, ".dbml · an open format · no lock-in" builds on the right; then A LAYER, ONE FILE PER TABLE (with "a schema" on the schema folder), RELATIONSHIPS, DIAGRAMS tag their groups on their words. |
| 4 | `files` | DBML | `fct_order.dbml` (with a hand-written comment) — COLUMNS, KEYS, GRAIN tag their lines. It folds away for `relationships/gold.dbml` (the Ref line lit: ONE REF LINE) and `diagrams/sales.dbml` (ITS TABLES on the `use` lines, POSITIONS on `erd_layout`). |
| 5 | `canvas` | EDIT | `sales.dbml` on the canvas (no Logical/Physical tabs: no dbt here), each table labelled with its `.dbml` file. `status VARCHAR` is typed into `fct_order.dbml` (the tab's dirty dot shows), the file is saved ("saved") and the node grows the row on "follows" — the canvas follows a table file on save; then the comment on line 1 lights up, "your comment, kept". The README poster frame (`props.poster`). |
| 6 | `pr` | EDIT | PR #128: `fct_order.dbml` gains one aligned line ("+1 line" on "readable diff"); `sql/orders.sql` (the file the hook and flip show) joins it, one green outline, "1 PR · design + code". |
| 7 | `ai` | AI | Command Palette → ERD Studio: Set Up My AI Helper ("teaches your assistant these files"); Claude Code, GitHub Copilot, Codex, Gemini CLI and Cursor tick in on their names (`.claude/skills/` / `.agents/skills/`). Then a Claude Code session writes `dim_date.dbml` and edits `relationships/gold.dbml` and `diagrams/sales.dbml`; the canvas shows the whole `sales` diagram (`dim_customer`, `fct_order` with its `status` column) with the new table and its relationship, "review it, then commit". |
| 8 | `import` | IMPORT | Two real screens, each source's official logo on a light tile in place of its codicon. First the empty **Diagrams** view of a dbt project (package.json's viewsWelcome), beside the activity bar with the extension's own icon (`media/icon-sidebar.svg`): "No diagrams yet. This folder is a dbt project.", the **Draw from dbt** button (dbt logo beside it; it lights on "dbt", nothing is clicked) and "Or: More ways to start…". On "import", ERD Studio's **Import…** picker (title Import, "What would you like to start your data model from?") drops in below: DBML file (a plain DBML badge: DBML has no mark of its own), SQL DDL scripts (with the five dialects its detail names as chips: PostgreSQL's elephant, MySQL as a name only since Oracle licenses its logo only by written agreement, SQL Server's Azure icon, Snowflake, Databricks), Power BI or Fabric semantic model (Power BI logo), then Bring In Your Data Model…, each with its real detail. Power BI, SQL and DBML light on their words; SQL DDL scripts stays picked (its chips light) for a beat. The draft preview, laid out as `DraftBanner`: "Draft from 4 SQL files (PostgreSQL) · 6 tables, 5 relationships · not saved", the Keep detail, the Change options… link, then Keep as Diagram · More ways to start ▾ · Discard; Keep as Diagram pressed on "keep it" and the diagram opens. Export Diagram's picker: Mermaid, DBML, Rich DBML, with the product's full details. |
| 9 | `dbt` | DBT | ~10 s, the same `sales` diagram (with `status`). "Open the project": Compare with dbt joins the toolbar and the stage tabs row appears under it, *Logical · your design* / *Physical · read from dbt* (`dbt_project.yml` found). Physical: green, the lock on its tab, no + Add, "read-only · read from dbt" — `order_date` a TIMESTAMP, an extra `loaded_at` column, no relationship. Back on Logical, Compare with dbt → Stop comparing: three differences, marked as the canvas draws them — both types stacked on `order_date`, `loaded_at` as a ghost row under ONLY IN PHYSICAL with its "physical only" badge, the relationship dbt has no test for dashed amber — and the DiscrepancyPanel bottom right: "Logical (current) vs Physical (target)", 2 matched · 1 type diff · 1 col diff · 1 rel diff, ⊕ Sync. No rename: the product's diff has no rename detection. |
| 10 | `confluence` | SHARE | ~10.6 s. A light Confluence page (the official Confluence icon in its top bar), "Sales data model", carrying a real render of the diagram as the ERD Studio for Confluence macro draws it (`@erd-studio/renderer`'s `ErdCanvas` in viewer mode, `assets/confluence-sales.png`, re-shot with `node confluence-shot.mjs`): `dim_customer` → `fct_order` in the gold layer, with the `status` column the earlier scenes add. On their words: the dark "ERD Studio for Confluence" pill with the app icon, "on the Atlassian Marketplace" (with its caption chunk), then the GitHub mark "read from acme-analytics › .erd-studio/"; "in Confluence" glows the macro and adds its Read-only chip; "No VS Code needed" lands right of the page's meta line just ahead of its words and holds ~2 s. Nothing else is claimed: no editing in Confluence, no price, not "free". |
| 11 | `endCard` | — | "Design your data model in Git." Pills: Free to use · Source available. The Extensions search, "Also on Open VSX". |
