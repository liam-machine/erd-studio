# README cut — scene direction

`VARIANT=readme`: "How ERD Studio works", committed as `docs/assets/how-it-works.mp4` and linked
from `docs/dbt.md`. An argument, then a tour: ERD Studio is a free-to-use VS Code extension; why do
data teams keep the data model in a separate tool or a remote database, versioned apart from the
code that builds it, when it can be plain DBML files (an open format) right next to that code,
reviewed in the same pull request? Then the files and the canvas, the imports that build the
logical model (longest chapter), Set Up My AI Helper (found in the ERD Studio sidebar under Help &
Feedback; a markdown skill for every assistant it sets up; in Claude Code, GitHub Copilot, Codex
and Gemini CLI a pre-tool hook), then, if you use dbt, dbt parse → `manifest.json` → Compare with dbt (dbt is the
first physical source, "with more to follow" — no other source is named), and ERD Studio for Confluence reading the
team's GitHub repo as the single source of truth. **Voice only**: the script says `music: false`,
so `music.py` writes no bed and `encode.sh` normalises the voice alone to −14 LUFS. Narration:
`script.readme.yaml`. Scenes: `player/scenes/readme/*.js` (plus the shared `endCard`). The example
is `R` in `player/scenes/readme/story.js`: a `gold` layer, the tables `dim_customer` and
`fct_order` in schema `gold`, and the `sales` diagram — written exactly as ERD Studio 2.0 writes a
new project:

```
.erd-studio/gold/tables/gold/<table>.dbml     one Table each
.erd-studio/gold/relationships/gold.dbml      the layer's default relationships file
.erd-studio/gold/diagrams/sales.dbml          use lines + Project sales { erd_layout }
```

Every label on screen is the product's own: `src/types/startActions.ts` (Import from dbt, More ways
to start…, Bring In Your Data Model…), Import…'s picker (`src/commands/importModel.ts`) and the
SQL dialects (`src/services/sqlDdlImport.ts`), the import guide's card titles
(`src/services/importGuide.ts`), `package.json` command titles, the webview toolbar (`Compare with
dbt`, `Stop comparing`, `{ } View File`, `+ Add`, the stage tabs `Logical · your design` /
`Physical · read from dbt`), the logical stage's dbt parse strip and its **Run dbt parse** button
(`webview/components/Canvas/ManifestHint.tsx`), the DiscrepancyPanel's counts and the draft banner
(`src/services/draftModel.ts`). The skill and the hook are the files Set Up My AI Helper writes
(`src/services/harnessService.ts`, `src/harness/CLAUDE.md`): `.claude/skills/erd-studio/SKILL.md`
(the same markdown under `.agents/skills/` for Copilot, Codex, Gemini CLI and Cursor) and the
pre-edit hook — Claude Code's `enforce-skill.sh`, and from the assistant-hooks PR the same check for
GitHub Copilot, Codex and Gemini CLI (every assistant that PR registers a hook for,
`docs/ai-assistants.md` → "The safety check"; Cursor is not yet supported and relies on the skill)
— which pauses (denies) the first `.erd-studio` edit of a session and tells the assistant to load
the skill (it does not check that it did) and never approves anything. The narration says
"pauses", not "stops", and leaves the conditions (Codex runs a new hook only after you trust it in
`/hooks`; Copilot under VS Code's own local agent may not run it; the Copilot and Codex checks do
not run on Windows) to that guide. The hook line depends on the assistant-hooks PR shipping with
or before this video: if it slips, the line goes back to "In Claude Code, …".
The Help & Feedback rows are `HELP_ACTIONS` in `src/providers/HelpTreeProvider.ts`; the side bar's
views are `package.json` → `contributes.views["erd-studio"]`. Wording follows `docs/dev/onboarding-and-cli.md` →
"User-facing wording": DBML is an open format (never an open standard); ERD Studio is free to use,
source available (never "open source"); "diagram"; "Set Up My AI Helper". No competitor is named.
Words are timed with `wordAt()` (story.js), from the real clip lengths. Third-party marks (Power
BI, SQL Server, the SQL dialects, Snowflake, Databricks, dbt, Confluence, GitHub) are the official
files in `player/assets/logos/`, with their sources and terms in `LOGOS.md`; MySQL, Microsoft
Fabric and DBML deliberately have none (MySQL and DBML: `LOGOS.md` says why; no Fabric mark was
vetted, so Fabric is named in text). ERD Studio for Confluence is described only as it works
(`docs/dev/compatibility.md`: it reads the committed `.erd-studio/` folder from GitHub and draws a
diagram read-only), never as free and with no price. It says "DBML files": the app is assumed to
move to core 0.4.0 with the `dbml` reader (compatibility.md → "The 2.0 format") before this video
ships (Liam, PR #246). dbt parse is never said to query the warehouse: it writes `target/manifest.json`
without connecting, and the comparison shows no type difference, because the warehouse's real types
come from `catalog.json` (`dbt docs generate`), which the tour does not run.

| # | Scene | Chapter | What is on screen |
|---|---|---|---|
| 1 | `hook` | WHY | Frame 0 is finished: the ERD Studio brand row (icon, name, "VS Code extension" and "Free to use" pills, lit on their words) over the logical diagram `dim_customer` ← `fct_order`; *Tables, Grain, Keys, Joins* light one by one as "logical data model" is said. |
| 2 | `why` | WHY | The challenge. The diagram is packed off into a light, separate browser tool ("a separate tool") on "separate tool"; "remote database" and "its own version history" tag it on their words; the repo (`sql/`, "versioned in Git") arrives below on "the code that builds it". `cost`: a pointer hops between the two windows, "switching context"; the link snaps on "drifts" ("Last updated 14 months ago"; `orders.sql` added a `loaded_at` column — the drift the dbt beat finds); the AI in the repo finds "no data model here". The tool's tab says "Modelling tool": no competitor, product name or domain is named or drawn. |
| 3 | `flip` | WHY | The repo's Explorer: `.erd-studio/` slides in above `sql/` on "DBML"; on "right next to the code" a bracket spans the model and the SQL — same repo, same PR. |
| 4 | `tree` | DBML | The same Explorer, `.erd-studio/` expanded to the layer-first tree. ".dbml · an open format · no lock-in" builds on the right; then A LAYER, ONE FILE PER TABLE (with "a schema" on the schema folder), RELATIONSHIPS, DIAGRAMS tag their groups on their words. |
| 5 | `files` | DBML | `fct_order.dbml` (with a hand-written comment) — COLUMNS, KEYS, GRAIN tag their lines. It folds away for `relationships/gold.dbml` (ONE REF LINE); then, unnarrated, `diagrams/sales.dbml` (ITS TABLES on the `use` lines, POSITIONS on `erd_layout`). |
| 6 | `canvas` | EDIT | `sales.dbml` on the canvas, each table labelled with its `.dbml` file. `status VARCHAR` is typed into `fct_order.dbml`, saved, and the node grows the row on "follows", "file ⇄ diagram", held to the scene's end (`minDur: 7.6`, under 1 s of quiet after "follows"). The README poster frame (`props.poster`, the `sync` beat + 3.0 s). |
| 7 | `pr` | EDIT | PR #128: `fct_order.dbml` gains one aligned line ("+1 line" on "readable diff"); `sql/orders.sql` joins it, one green outline, "1 PR · design + code". |
| 8 | `import` | IMPORT | ~25 s. ERD Studio's **Import…** picker (title Import, "What would you like to start your data model from?"): DBML file (a plain DBML badge), SQL DDL scripts (its five dialect chips: PostgreSQL, MySQL as a name only, SQL Server, Snowflake, Databricks), Power BI or Fabric semantic model (Power BI logo), Bring In Your Data Model…, each with its real detail; the row being spoken about is selected. Under it one panel at a time (each swap dips out before the next rises, so two panels never overlap) shows what each source takes in: FROM WHAT YOU USE (DBML, SQL, Snowflake, Databricks, Power BI, dbt marks); `shop.dbml` ("one file, from any DBML tool") with a DBML excerpt; "4 .sql files" with a CREATE TABLE excerpt and "exported from Snowflake / Databricks" (the dialect chips light, Snowflake and Databricks on their words); a `Sales.SemanticModel` folder (TMDL tables or `model.bim`, from Power BI Desktop's .pbip or Fabric's Git integration); then, with the picker dimmed (it is its own start), the empty **Diagrams** view of a dbt project with **Import from dbt** lit; last the guide's card titles (dbt, Databricks (Unity Catalog), Snowflake, Power BI, Microsoft Fabric, SQL Server and Azure SQL, PostgreSQL, MySQL and MariaDB). |
| 9 | `draft` | IMPORT | The draft preview, laid out as `DraftBanner`: "Draft from 4 SQL files (Snowflake) · 6 tables, 5 relationships · not saved", the Keep detail, Change options…, then Keep as Diagram · More ways to start ▾ · Discard over dashed tables; Keep as Diagram pressed on "keep it", the tab becomes `shop.dbml`. `keep`: SAVED AS DBML — `diagrams/shop.dbml`, `tables/…/<table>.dbml` × 6, `relationships/gold.dbml` — then "edit by hand" and "or with your AI" on their words. |
| 10 | `ai` | AI | Where to find it, not the Command Palette: a VS Code window with the Explorer open (`acme-analytics`: `.erd-studio`, `sql`, `README.md`). The pointer clicks the ERD Studio icon in the activity bar on "ERD Studio": the side bar becomes ERD STUDIO — DIAGRAMS (Gold · Layer · 2 diagrams, `sales`, `shop`; the + New… action), TABLE LIBRARY expanded (Gold · Layer, `dim_customer`, `fct_order`), and RELATIONSHIPS and HELP & FEEDBACK collapsed at the foot of the side bar, as VS Code pins collapsed views (`visibility: collapsed` in `package.json`). On "Help" it expands HELP & FEEDBACK, which rises (the pointer riding up with its header) to show Set Up My AI Helper, Watch the Tour, Show Me Around, Send Feedback, Show Logs, and clicks **Set Up My AI Helper** on "Helper". In the editor area an explainer card titled "What it adds" (not product UI: the real command installs for the assistants it finds and reports it in a notification): Claude Code, GitHub Copilot, Codex, Gemini CLI (each "+ hook") and Cursor tick in on their names with where each skill lands (`.claude/skills/` / `.agents/skills/`); "one skill: the erd-studio format". |
| 11 | `skill` | AI | ~21 s. `md`: `.claude/skills/erd-studio/SKILL.md` open as what it is, the real frontmatter and opening (truncated), "just markdown" and "loaded by your assistant" on their words; on "renders as a diagram" a strip: a `dim_date` DBML table → the node it draws. `hook`: a Claude Code transcript — `Edit(.erd-studio/gold/tables/gold/dim_date.dbml)`, the **PreToolUse hook** `enforce-skill.sh` with "first edit paused" and its own reason (load the /erd-studio skill (file-format rules) before editing .erd-studio files), then `Skill(/erd-studio)` loaded and the Edit going through; the card says "once per session". At its foot "pre-tool hook in" Claude Code · GitHub Copilot · Codex · Gemini CLI, each lit on its name (the transcript is Claude Code's, as the example). As the transcript arrives the SKILL.md card shrinks to end on a line boundary, the lines below it fading. |
| 12 | `aiwrite` | AI | A Claude Code session writes `dim_date.dbml` and edits `relationships/gold.dbml` and `diagrams/sales.dbml`; the canvas shows the whole `sales` diagram with the new table and its relationship, "review it, then commit" (anchored from the right, so it never hangs off the frame). On "Whichever assistant you use" a pill on the session's tab row: "or GitHub Copilot · Codex · Gemini CLI · Cursor". The scene holds ~1.5 s on the canvas (`minDur: 8`) with `dim_date` lit, and keeps moving through the hold (a green light runs along the new Ref from `order_date` to `dim_date` every 1.4 s, the table's glow breathes), so the AI's change reads without a still, silent frame. |
| 13 | `parse` | DBT | `if` (the caveat): "If you use dbt" — under the canvas a PHYSICAL MODEL panel, "compared with your design" on "physical model": the dbt tile (official mark, `manifest.json · catalog.json`) on "dbt", a dashed "more to follow" tile on its words, "dbt first"; it gives way before Run dbt parse. `parse`: the `sales` canvas in a dbt project (stage tabs, Compare with dbt) before dbt has run: the logical stage's strip, "dbt hasn't parsed this project yet. Your diagram is fine, but the Physical view can't show columns and tests without it." with **Run dbt parse**, pressed on "Run". A terminal runs `dbt parse` (its two output lines illustrative); on "manifest.json" `target/manifest.json` opens (an excerpt: the `model.` nodes with their columns, a `test.` node), the model rows lit on "every model", "every model, its columns and tests"; the strip gives way to "manifest.json found · Physical tab ready". |
| 14 | `dbt` | DBT | The same diagram, "reads target/manifest.json". On "Physical" the canvas flips to the read-only Physical stage (green, the lock, no + Add, "read-only · read from dbt") — an extra `loaded_at` (declared in the model's schema yml), no relationship. Back on Logical, Compare with dbt → Stop comparing on "between your design and what dbt builds": two differences as the canvas draws them (`loaded_at` under ONLY IN PHYSICAL, the relationship dbt has no test for dashed amber) and the DiscrepancyPanel: "Logical (current) vs Physical (target)", 2 matched · 1 col diff · 1 rel diff, ⊕ Sync. No type difference: dbt parse does not know the warehouse's types. |
| 15 | `confluence` | SHARE | ~20 s. Top: the team's repo (GitHub mark, `acme-analytics`, `main › .erd-studio/`, its folders); below it a light Confluence page (official icon) with a real render of the diagram as the ERD Studio for Confluence macro draws it (`assets/confluence-sales-before.png` / `confluence-sales.png`, `node confluence-shot.mjs`), and under it the macro's source line, `acme-analytics · main · 7c03b5d`. The dark "ERD Studio for Confluence" pill on its words; on "connects" a line draws from the repo to the page ("reads the committed files"), the GitHub mark pulses on "GitHub". `db`: "the “database”" tags the repo, "= DBML files" lights its folders, "drawn as a diagram" glows the macro (Read-only chip), "No VS Code needed". `truth`: "one source of truth" on the line; a developer's commit ("Add status to fct_order · just now") lands in the repo, the macro redraws from it — `status` appears in `fct_order`, lit, and the source line's commit becomes `a1f9c2e`; the page's own byline does not change; "nothing else to update" on "not another SaaS product". No editing in Confluence, no price, not "free". |
| 16 | `endCard` | — | "Design your data model in Git." Pills: Free to use in VS Code · Source available, each on its word (`props.pillWords`). The Extensions search, "Also on Open VSX". Nothing about the Confluence app here. |
