# Import analysis: QUT Ecoacoustics Acoustic Workbench (DBML, PostgreSQL)

**Verdict: imported, with gaps (minor gaps).** There were no errors. All 49 tables, 466 columns, 45 primary keys, 96 relationships and every data type came through. Four things changed without a message: schema `public` became `main`, the composite key names were dropped, four `0.0` defaults became `0`, and every composite key shows a false warning. Not null, defaults, indexes and enums are kept only as metadata.

## Tested with

- **Build:** ERD Studio 2.0, branch `feat/native-dbml-storage` at `d04c4167`. The CLI `dist/cli.js` comes from the same commit. The extension and the CLI both report version `1.7.2`.
- **Source:** `schema.dbml` in this folder, copied unchanged from QutEcoacoustics/workbench at `5e169267`, Apache-2.0. See `SOURCE.md`.
- **Import path:**
  1. On the ERD Studio activity bar, the start screen read "No diagrams yet. This folder has a DBML file."
  2. I clicked "Or: More ways to start…", then "Import… (A DBML file, SQL scripts or a Power BI semantic model)".
  3. I picked "DBML file". It was listed first and tagged "found in this folder".
  4. The "Import DBML" file dialog was already filled in with `schema.dbml`, and I pressed Import.
  5. No layer picker appeared, because the project has only one layer (Main). DBML import does not ask for a dialect.
  6. I kept the suggested diagram name `baw-server-on-postgre-sql`.
  7. In the draft I skipped the guide, opened Show details, and pressed **Keep as Diagram**.
- **Recording:** `import-review.mp4` in this folder. It runs 128.8 s, voice only.

## Source vs imported

| | Source | Imported | Notes |
|---|---:|---:|---|
| Tables | 49 | 49 | one file per table under `main/tables/main/` |
| Columns | 466 | 466 | names and order exact |
| Primary keys (3 composite) | 45 | 45 | composite keys kept as `(a, b) [pk]`; their names were dropped |
| Relationships | 96 | 96 | all written `>?` (optional); none flipped |
| Data types matching | 466 | 466 | |
| Column notes | 32 | 32 | became column descriptions |
| not null | 214 | 214 | metadata only (`meta_json`) |
| Defaults (10 expressions) | 49 | 49 | metadata only; 45 byte-identical, 4 × `0.0` → `0` |
| Indexes | 109 | 109 | metadata only |
| Enum definitions | 3 | 0 | values kept per column in `meta_json` |
| TableGroups | 2 | 0 | reported in "Not imported" |
| `delete: cascade` | 4 | 0 | reported in "Not imported" |
| Tables with no PK | 4 | 4 | the draft says "no primary key" for each |
| Files written | | 53 | `layers.json`, `README.md`, 1 diagram, 1 relationships file, 49 table files |

**How I counted.**

- **Source:**
  - `grep -c '^Table "'` gives 49. A plain `^Table` gives 51, because it also matches the 2 `TableGroup` lines.
  - `grep -c '^Ref'` gives 96. All 96 are standalone and named, with no inline refs.
  - There are 214 `not null` settings.
  - The 45 primary keys are 42 single-column `[pk]` plus 3 composite keys declared in `Indexes`. The count comes from `SOURCE.md`'s line parser.
- **Imported:**
  - `erd-studio inventory --json` reports 49 logical tables, 466 columns and 45 tables with a primary key. The 3 composite keys are `analysis_jobs_scripts`, `audio_recording_statistics` and `user_statistics`.
  - `main/relationships/main.dbml` has 96 `Ref` lines, and all 96 contain `>?`.
  - The table files hold 214 `"not_null":true` entries.
  - Inventory's `relationships` array is empty, because it lists dbt relationships only.
- **NOT NULL FKs:** a parse of all 96 refs against the source column settings found 40 FK columns that are `not null`.
- **Where the numbers come from:**
  - The analysis and the fix agree on every number. These counts match them and the final storyboard.
  - The only row the fix added is the `0.0` → `0` note on defaults, confirmed below.

Output paths below are relative to the imported project's `.erd-studio/` folder. Source line numbers refer to `schema.dbml`.

## Findings

### Errors

None.

- The draft opened, Keep as Diagram wrote the files, and the canvas loaded.
- Problems showed "No Problems" throughout.
- `doctor --no-dbt` reported "✓ ERD Studio: 1 diagram, 49 tables — storage DBML" and "Next steps: 1. Ready".
- No import warnings or errors were logged.

### Bugs (silently lost or wrong)

1. **False "Multiple primary keys" warning on every composite key.**
   - **What happens:** the 3 composite keys import correctly, but each key column shows an orange `!` badge with the tooltip `Multiple primary keys detected in this table`.
   - **Code:** the tooltip text is at `packages/renderer/src/components/common/KeyBadgeGroup.tsx:142`. The badge shows when `hasMultiplePKs` is true, and `packages/renderer/src/components/DetailPanel/ColumnEditor.tsx:231` sets that as `pkColumnNames.length > 1`. So every composite key triggers it.
   - **Source:** `schema.dbml:159` `(analysis_job_id, script_id) [pk, name: "analysis_jobs_scripts_pkey"]`.
   - **Imported:** `main/tables/main/analysis_jobs_scripts.dbml:6` `(analysis_job_id, script_id) [pk]`.
   - **In the video:** the native tooltip never appeared in the recording (frames f00894 to f00975 show the cursor on the badge and no tooltip). The video shows a zoomed still of the badges instead and cites the code.
2. **Composite key names dropped, not reported.**
   - **Source:** lines 159, 288 and 839 name the keys `analysis_jobs_scripts_pkey`, `audio_recording_statistics_pkey` and `user_statistics_pkey`.
   - **Imported:** the output keeps only `[pk]`, at `main/tables/main/analysis_jobs_scripts.dbml:6`, `audio_recording_statistics.dbml:13` and `user_statistics.dbml:14`.
   - **Not reported:** "Not imported" does not mention it. The names of the other 109 indexes are kept.
3. **Numeric default `0.0` rewritten as `0` on 4 columns, not reported.**
   - **Source:** these lines say `default: 0.0`:
     - line 167: `anonymous_user_statistics.audio_download_duration`
     - line 284: `audio_recording_statistics.segment_download_duration`
     - line 833: `user_statistics.audio_download_duration`
     - line 835: `user_statistics.analyzed_audio_duration`
   - **Imported:** the output stores `"default":"0"`, for example `main/tables/main/user_statistics.dbml:10` and `:12`.
   - **Rest kept:** the other 45 defaults are byte-identical, including all 10 backtick expressions.
4. **Schema `public` written as `main` on all 49 tables, by design but not reported.**
   - **Why it happens:** `src/services/dbmlLibraryWrites.ts:132` says new tables go to "the diagram's layer, its name as the schema; default: the first layer listed, else `main`". A table keeps its source schema only when the source qualified it (lines 134–137).
   - **Source:** this file qualifies nothing, so DBML and PostgreSQL read every table as `public`. The file's own default names `public.analysis_jobs_item_status` (`schema.dbml:129`).
   - **Imported:** every table file starts `Table main.<name>`, for example `main/tables/main/active_storage_attachments.dbml:1` and `main/tables/main/scripts.dbml:1`. The side panel shows `Schema main`.
   - **Not reported:** the draft's details and notes never mention a schema. Other DBML tools and SQL exports now see a different schema.
5. **Detail panel hides the names of columns with long type names.**
   - **What happens:** on `analysis_jobs_items`, status shows as "s", result as "r.", the transition name is blank next to `analysis_jobs_item_transition`, and `queue_id` is cut short.
   - **Files are correct:** `main/tables/main/analysis_jobs_items.dbml:7-9` are right. It is filmed at about 63 s of the take.
6. **The "found a DBML file" toast stays after Keep.**
   - **What happens:** "ERD Studio found a DBML file in this folder. Show it as a diagram? Nothing is saved until you keep it." [Show Me] [Don't Ask Again for This Folder] stayed on screen until about 78 s. By then the file had already been imported and kept.
7. **Draft "Notes" overcounts the mandatory references.**
   - **The note:** "In the file, 96 references were not optional."
   - **The count is wrong:** only 40 of the 96 FK columns are `not null`.
   - **Why:** `src/services/dbmlImport.ts:1115-1116` counts refs without a `?` marker and ignores column nullability.
8. **Minor oddities.**
   - The suggested name `baw-server-on-postgre-sql` splits "PostgreSQL".
   - The output channel logs "ERD Studio 1.7.2 activating" on the 2.0 build.
   - The `// ` comments on lines 1–3 are dropped, and this is not reported.
   - Rehearsal only, nothing changed on disk: clicking an edge's midpoint hit the hover-revealed "Swap cardinality" button, and this error toast appeared: "Failed to update relationship: analysis_jobs.id is analysis_jobs's key, so each value appears only once — it can't be the "many" side. Unmark it as a key first, then try again."

### Gaps (unsupported)

1. **40 NOT NULL foreign keys saved as optional (`>?`). The user was told.**
   - **Source:** `schema.dbml:886` `Ref "analysis_jobs_creator_id_fk":"users"."id" < "analysis_jobs"."creator_id"`, with `:93` `"creator_id" integer [not null]`.
   - **Imported:** `main/relationships/main.dbml:44` `Ref analysis_jobs_creator_id_fk: main.analysis_jobs.creator_id >? main.users.id`.
   - **Result:** the column still says not null in `meta_json`, but the Ref says the key may be empty.
   - **What the user saw:** the draft note discloses this, with the count of 96 (see Bug 7).
2. **Not null, defaults, unique and indexes kept only as metadata. The user was told.**
   - **Where they go:** all 214 not nulls, 49 defaults and 109 indexes are written into `meta_json` strings, not as DBML settings. For example, `main/tables/main/analysis_jobs.dbml:6` reads `creator_id integer [meta_json: '{"dbml":{"not_null":true}}']`.
   - **Who can see them:** the canvas does not show nullability. Other DBML tools (dbdiagram.io, dbml-renderer) see none of them.
   - **What the user saw:** "Not null, defaults, indexes and other details ERD Studio has no field for are kept in the table files, so they are not lost."
3. **The 3 Enum definitions are not written. The user was only partly told.**
   - **Source:** the Enum blocks at `schema.dbml:28`, `:36` and `:43` are gone.
   - **Imported:** each of the 3 columns keeps its type name and 4 values in `meta_json`, for example `main/tables/main/analysis_jobs_items.dbml:8-9` with `"enum":["new","queued","working","finished"]`.
   - **Result:** the type name now refers to no Enum anywhere in `.erd-studio/`.
   - **What the user saw:** "Not imported" does not name enums. Only the general "other details" note covers them.
4. **TableGroups, database type and `[delete: cascade]` left out. The user was told.**
   - **Source:** the 2 TableGroups (`schema.dbml:9`, `:21`), `database_type: 'PostgreSQL'` (`:5`), and the 4 cascades (`:892`, `:914`, `:944`, `:1008`).
   - **Imported:** none of them is saved. For example, `main/relationships/main.dbml:55` has no settings.
   - **What the user saw:** all three are listed in the draft's "Not imported" section.

### What came through correctly

- **Tables, columns and types.** 49 of 49 tables and 466 of 466 columns came through, with names and order exact. All 466 types match, including:
  - `numeric(14,4)` (`:104` → `analysis_jobs.dbml:17`)
  - `character varying(255)` (`analysis_jobs_items.dbml:7`)
  - `tsrange` (`:164`)
  - `integer[]` (`:206`)
  - `timestamp(6)` (`:569`)
  - `jsonb`, `bigint`, and the enum type names

  The reserved word `key` stays quoted, and `order` and `position` parse.
- **Keys.** The 42 single-column keys came through as `[pk]`, and the 3 composite keys as `indexes { (a, b) [pk] }`. The 4 tables without a key stay without one.
- **Direction.** The file writes every Ref parent first, for example `:892` `"audio_events"."id" < "audio_event_comments"."audio_event_id"`. ERD Studio stores it child first, at `main/relationships/main.dbml:55`: `main.audio_event_comments.audio_event_id >? main.audio_events.id`. I checked all 96 by name: every endpoint matches and none is flipped.
- **Ref names.** All are kept: 47 `*_fk` and 49 `fk_rails_<hash>`.
- **Self-reference.** `scripts.group_id → scripts.id` is kept (`:1066` → `main/relationships/main.dbml:150`). The panel shows "↻ group_id → scripts.id many-to-one", and a loop edge is drawn.
- **Role-playing refs.** All 54 refs to `users.id` stay separate relationships.
- **analysis_jobs_items.** It has four relationships:
  - three out to the right parents (`main/relationships/main.dbml:48-50`)
  - one in from `audio_event_import_files.analysis_jobs_item_id` (`fk_rails_1b93a0a373`, line 61)
- **Notes and expressions.**
  - All 32 column notes became descriptions.
  - The 10 backtick default expressions are byte-identical, for example the `tsrange(...)` default at `user_statistics.dbml:8`.
  - All 109 indexes keep their names, `unique` and type, including the gin index.
  - The Project note is kept at `main/diagrams/baw-server-on-postgre-sql.dbml:53`.
- **Exports.** Every written file and both CLI exports parse with @dbml/core 11.0.0.

## What the import showed

- **Start screen:** "No diagrams yet. This folder has a DBML file." / [Import your DBML file] / "Or: More ways to start…"
- **Toast:** "ERD Studio found a DBML file in this folder. Show it as a diagram? Nothing is saved until you keep it." [Show Me] [Don't Ask Again for This Folder]
- **Name box:** "Name the diagram. It is saved in the Main layer." with the value `baw-server-on-postgre-sql`.
- **Draft banner:** "Draft from schema.dbml · 49 tables, 96 relationships · not saved" / "Keep saves it as baw-server-on-postgre-sql in the Main layer (.erd-studio/main/diagrams/baw-server-on-postgre-sql.dbml)." / "2 notes, 3 left out: Show details"
- **Details, sample table lines:**
  - "analysis_jobs_scripts 3 columns · primary key analysis_job_id, script_id · 2 foreign keys new"
  - "anonymous_user_statistics 4 columns · no primary key new"
  - "user_statistics 7 columns · primary key user_id, bucket · 1 foreign key new"
- **Details, sample relationship lines:**
  - "analysis_jobs.creator_id → users.id many-to-one · analysis_jobs_creator_id_fk"
  - "scripts.group_id → scripts.id many-to-one · scripts_group_id_fk"
- **Not imported (3):** "These stay in your own files only: the import writes none of them."
  - "2 table groups (CMS, Rails): ERD Studio has no table groups. The tables were imported"
  - "The database type (PostgreSQL): ERD Studio does not record the database type"
  - "Settings on 4 references (delete: cascade): ERD Studio does not record what a reference does on delete or update, its colour, or whether it is inactive. The relationships were imported"
- **Notes (2):**
  - "Every relationship is saved as optional (?: its foreign key may be empty), as ERD Studio saves them all. In the file, 96 references were not optional."
  - "Not null, defaults, indexes and other details ERD Studio has no field for are kept in the table files, so they are not lost."
- **Canvas footer:** "49 tables | 96 relationships". Problems: "No Problems".
- **Output channel:** "Project: DBML storage, 0 table file(s), 0 diagram(s), no dbt project (logical only)" … "[Canvas] Saved the positions of 49 tables in …/baw-server-on-postgre-sql.dbml in 24 ms (layout only)". No import warnings or errors.
- **doctor:** "✓ ERD Studio: 1 diagram, 49 tables — storage DBML" / "✓ Fields: the starting set (no fields.yml) — 7 table fields, 3 column fields" / "Next steps: 1. Ready"

The import did not fail, so there is no failure section.

## Corrections to the first review

- **Relationship caption.** "Relationships run child to parent, as the file wrote them" misstated the source, which writes parent `<` child. It now reads "Listed child to parent. The file wrote `parent < child`; none came out flipped."
- **analysis_jobs_items caption.** "All many-to-one to the right parents" missed that one of the four is incoming. It now says three out and one in from `audio_event_import_files`.
- **Composite-key captions.** They claimed a tooltip the recording never shows. The video now shows a zoomed still of the badges and gives the tooltip text from the code.
- **New finding.** The `0.0` → `0` default rewrite was missed and has been added.
- **Schema finding.** It was called a plain bug. It is now worded as by design (`dbmlLibraryWrites.ts:132`) but not reported.
- **Optional relationships.** The finding now says the import reports it, and that the note's count of 96 ignores column nullability (only 40 were mandatory).
