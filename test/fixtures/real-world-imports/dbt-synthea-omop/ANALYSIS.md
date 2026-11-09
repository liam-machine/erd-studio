# Import analysis: dbt-synthea: Synthea to OMOP CDM (OHDSI, dbt)

**Verdict: imported, with two bugs.** There were no errors, and the 15 drawn tables match dbt (types, PKs, 113 relationships). The draft draws at most 15 tables, so 22 of the 37 omop models were left out, and it says so. The two bugs: not_null is dropped, so 38 required FKs are written as possibly null, and 5 FKs to undrawn tables are lost.

## Tested with

- ERD Studio 2.0, branch `feat/native-dbml-storage` at `d04c4167` (tag `prerelease-v1.9.9`). It ran as a frozen build in an isolated VS Code 1.145.2. The output channel reports the version as "ERD Studio 1.7.2".
- Source: OHDSI/dbt-synthea at `33fdbfa9b354f00def5ee6e45525cb2da80e0ddf`, Apache-2.0. It is copied into this folder, and `SOURCE.md` says how.
- Import path:
  - Activity Bar > ERD Studio > Diagrams welcome view > **Import from dbt**.
  - On activation a start-suggestion toast appeared. It was shown on camera, then dismissed and not used.
  - The draft-first flow asked nothing. It picked the folder (omop, the top-ranked), the layer (Gold) and the diagram name (omop) by itself.
  - The onboarding guide was skipped. The Folder switcher was shown but not changed.
  - **Show details**, then **Keep as Diagram**. No `dbt parse` was run and there is no manifest or catalog.
- Not filmed, only rehearsed: **Change options…** and the 15-model cap error.
- Video: `import-review.mp4` in this folder (111.3 s). The closing card is "Imported, with two bugs".

## Source vs imported

| Count | Source (66 yml models) | omop folder | Drawn 15, expected | Imported |
|---|---|---|---|---|
| Tables | 66 (87 `.sql`; the 21 `int__*` have no yml) | 37 | 15 | 15 |
| Columns | 741 | 421 | 247 | 247 |
| Typed columns | 732 | 421 | 247 | 247, verbatim |
| Primary keys (`unique` test) | 41 | 28 | 15 | 15 |
| Relationships (distinct links) | 235 (from 319 tests) | 174 | 113, plus 5 to undrawn tables | 113 Refs, all `>?` |
| Column descriptions | – | – | 208 | 208, exact |
| Table notes | – | – | 15 | 15, exact |
| not_null columns | 211 | – | 77 (38 of them FKs to drawn tables) | 0 |
| FKs to undrawn tables | – | – | 5 | 0 |

How I counted. I parsed every `models/**/*.yml` with the `yaml` package in an inline Node script, not ERD Studio:
- **Table:** a model with a yml entry.
- **PK:** a column with a `unique` test.
- **Link:** a distinct (model, column, target, field) from `relationships` and `dbt_utils.relationships_where`.

For the imported side I counted in `.erd-studio/gold/`:
- `^Ref` lines in `relationships/gold.dbml`: 113. All 113 use `>?`, and `sort | uniq -d` finds 0 duplicates.
- `pk` markers across the 15 table files: 15.
- Column lines: 247.
- `foreign_key` flags: 113.
- `not null`: 0, and `<> 0`: 0.

The source counts agree with `SOURCE.md`, the analysis, the verifier, the fixer and the final term card. Where the analysis and the fix disagreed, I used the fix's numbers only after re-counting them.

CLI on the imported copy:
- `doctor --no-dbt`: "✓ ERD Studio: 1 diagram, 15 tables — storage DBML".
- `inventory --summary`: "87 models, 319 relationships (manifest missing, catalog missing)". The CLI counts raw tests, not distinct links.

Files the import wrote:
- `.erd-studio/gold/diagrams/omop.dbml`
- 15 files under `.erd-studio/gold/tables/gold/`
- `.erd-studio/gold/relationships/gold.dbml`
- `.erd-studio/layers.json` (Silver and Gold; Silver is empty)
- `.erd-studio/README.md`
- `selectors.yml` at the dbt project root

In the rest of this file, imported paths are relative to the imported copy. Source paths are relative to this folder.

## Errors

None.
- No error toast and no error page.
- Problems showed 0 errors and 0 warnings. `doctor --no-dbt` passed.
- The only warning is in the output channel, and it is expected because the sample has no `target/`: "[warning] [ManifestService] manifest.json not found at …/dbt-synthea-omop/target/manifest.json. Run "dbt parse" to generate it."

## Bugs (silently lost or wrong)

**B1. not_null is dropped, so required FKs are written as possibly null.**
- None of the 77 not_null tests on drawn columns reaches the model, and the user is not told.
- 38 of those columns are FKs to drawn tables. Every Ref is written `>?`, which DBML 9+ reads as "FK may be null". That is the opposite of what dbt asserts.
- Evidence:
  - `models/omop/_models/condition_occurrence.yml:20-27`: `person_id` has `not_null` and `relationships`. It becomes `.erd-studio/gold/relationships/gold.dbml:24` `Ref: gold.condition_occurrence.person_id >? gold.person.person_id`.
  - `models/omop/_models/person.yml:12` puts `not_null` on `person_id`. `.erd-studio/gold/tables/gold/person.dbml:4-7` carries `pk` only.
  - `grep 'not null'` across `.erd-studio` finds 0.
- Cause: ERD Studio has no nullability field, and writing `>?` on every Ref is design D18 (`docs/dev/dbml.md:86`, `packages/core/src/exportDbmlRich.ts:42`: "ERD Studio does not record nullability, so every end that is not primary-key columns gets one"). The `>?` is a direct result of the dropped not_null, so it is one bug, not two.

**B2. Five FKs to undrawn tables are lost.**
- When a link's target was left out, the import writes no Ref and no `foreign_key` flag. Nothing in the diagram records that dbt has the relationship.
- The Details drawer counts these FKs out without saying so: "person 18 columns · primary key person_id · 8 foreign keys" (dbt has 9).
- The five links:
  - `person.location_id` → location: `models/omop/_models/person.yml:109` → `.erd-studio/gold/tables/gold/person.dbml:24`
  - `care_site.location_id` → location: `models/omop/_models/care_site.yml:46` → `.erd-studio/gold/tables/gold/care_site.dbml:12`
  - `concept.domain_id` → domain: `models/omop/_models/concept.yml:39` → `.erd-studio/gold/tables/gold/concept.dbml:11`
  - `concept.vocabulary_id` → vocabulary: `concept.yml:56` → `concept.dbml:14`
  - `concept.concept_class_id` → concept_class: `concept.yml:73` → `concept.dbml:17`
- The three concept columns are also not_null.
- On camera, `person.location_id` shows "—" where an FK marker would be.
- Not checked: whether adding the target table later brings the link back.

## Gaps (unsupported)

**G1. A draft draws at most 15 tables. The user is told.**
- The default draft draws one folder (omop, 37 models). It drew the 15 best-connected and left 22 out (174 columns, 13 PKs, 61 of the folder's 174 links).
- Messages:
  - The banner says "Drew the 15 best-connected of 37 models; add the rest from the canvas." This text comes from `src/services/draftModel.ts:204`.
  - The banner also shows "22 left out", and Details lists "Not drawn (22)".
  - After Keep, a toast repeats it.
- The other 29 staging models were not candidates for this draft. An earlier "51 of 66 left out" claim was wrong and has been dropped: the UI only ever said 22.
- **Choose models…** allows up to 15 of all 66. A 16th gives "You picked 16 models. A draft holds up to 15, so untick 1." (rehearsal).
- The 19 staging/vocabulary links all point at omop, so a draw of that folder alone shows no lines. This was not filmed.

**G2. relationships_where filters are not kept, and the user is not told.**
- 125 `dbt_utils.relationships_where` tests carry a `from_condition` (`<> 0` / `!= 0`, the OMOP rule that 0 means no concept). Most also carry a `to_condition`, such as `domain_id = 'Gender'` or `standard_concept = 'S' AND invalid_reason IS NULL`.
- Each test becomes a plain Ref with no condition text. Example: `models/omop/_models/person.yml:22-35` → `.erd-studio/gold/relationships/gold.dbml:102`. `grep '<> 0'` across `.erd-studio` finds 0.
- This is a gap and not a bug. The link itself (column, target, field) is imported exactly, and nothing written contradicts the filter, unlike `>?` against not_null.

**G3. The 21 intermediate models and 29 sources are not offered, with no explanation.**
- They have no yml columns, so they cannot be drawn, and leaving them out is reasonable.
- The UI never says why. The Folder list has no intermediate entry, and Choose models counts 66, not 87.
- `inventory` lists every `int__*` model as "0 columns".

**G4. The schema comes from the layer, not from dbt.**
- Tables are written as `gold.<name>` under `.erd-studio/gold/tables/gold/`, so the path has "gold" twice. The panel shows "Schema gold".
- dbt sets no `+schema` for omop (`dbt_project.yml:389-398`), so "gold" is the layer the draft chose by itself.
- The warehouse name is correct. This may be intended. The user is not told.

**G5. Not exercised on camera:**
- the 9 untyped columns in `stg_vocabulary__source_to_concept_map` (`inventory` reads them as an empty dataType);
- the Synthea role-playing FKs (`stg_synthea__claims`: 3 to providers, 2 to payers);
- the 25 tables with no PK (all 15 drawn tables have one);
- the `text` and `double precision` types, which appear only in undrawn staging tables.

**Info**
- **I1. Keep also writes `selectors.yml` at the dbt project root.** The source has none. The new file holds `domain_gold_omop` ("All models in the omop domain (gold layer). Managed by ERD Studio."), a union of 15 `fqn` selectors. The banner names only `.erd-studio/gold/diagrams/omop.dbml`. This is intended behaviour (SelectorsService), but the user is not told about it.
- **I2. The start-suggestion toast stays up after Keep.** It is not withdrawn once a diagram has been kept (seen in the rehearsal; in the take it was dismissed before importing).
- **I3. The canvas banner asks for `dbt parse`.** It says the Physical view needs it. The logical draw does not.

## What came through correctly

- **Relationships:**
  - The 113 Refs are identical to the 113 yml links between the 15 drawn tables, as (from table, column, to table, column).
  - Direction is FK to PK, and the UI lists all 113 as "many-to-one".
  - The legacy syntax (`tests:`, with `to:`/`field:` and no `arguments:` block) was read everywhere.
- **Duplicate tests collapse to one line:**
  - 319 raw tests become 235 links, with 0 duplicate Refs.
  - `person.gender_concept_id` has two `relationships_where` tests (`models/omop/_models/person.yml:22-35`) and gets one Ref (`.erd-studio/gold/relationships/gold.dbml:102`).
- **Self-references are kept:**
  - `visit_detail.preceding_visit_detail_id` (`visit_detail.yml:228`) and `parent_visit_detail_id` (`visit_detail.yml:239`) → `gold.dbml:131-132`.
  - `visit_occurrence.preceding_visit_occurrence_id` → `gold.dbml:143`.
  - They are drawn as loops on the nodes.
- **Role-playing FKs:** measurement has 8 separate Refs to `concept.concept_id` (`gold.dbml:54-61`), and the UI shows "measurement 23 columns · primary key measurement_id · 12 foreign keys".
- **Types are verbatim (247 of 247):**
  - `visit_occurrence.yml:95` `Integer` → `visit_occurrence.dbml:23` `Integer`
  - `drug_exposure.yml:157` `varchar(MAX)` → `drug_exposure.dbml:39`
  - `note.yml:93` → `note.dbml:17`
  - `varchar(n)` is quoted in the DBML (`"varchar(50)"`).
- **Descriptions and order:**
  - All 208 column descriptions and 15 table notes match the source exactly, including quotes, colons and markdown links. Example: `concept.yml:39-43` → `concept.dbml:11-13`.
  - Columns are in source order.
- **Keys:**
  - The 15 PKs are written as `pk` (for example `person.dbml:4-7`).
  - The `dbt_expectations`, `concept_record_completeness` and `person_completeness` tests create no stray keys.
- **DBML keyword table:** the table `note` is quoted correctly: `note.dbml:1` `Table gold."note" {`.
- **No manifest, catalog or installed packages needed:** the draw ran from schema yml alone. The YAML anchors in `dbt_project.yml` (`:21` `&synthea_config`, `:451` `*synthea_config`) and the Jinja source `schema:` caused no error.

## What the import showed

- Start toast: "ERD Studio found a dbt project in this folder. Show its models as a diagram? Nothing is saved until you keep it." [Show Me] [Don't Ask Again for This Folder]
- Sidebar: "No diagrams yet. This folder is a dbt project." [Import from dbt] "Or: More ways to start…"
- Draft banner: "Draft from your dbt models in omop · 15 tables, 113 relationships · not saved" / "Keep saves it as omop in the Gold layer (.erd-studio/gold/diagrams/omop.dbml). Drew the 15 best-connected of 37 models; add the rest from the canvas." / "Change options… · 22 left out: Show details"
- Folder options: "omop · 37 models", "staging/synthea · 18 models", "staging/vocabulary · 10 models", "staging/map · 1 model"
- Guide 1 of 3: "Your draft — This is a draft of your model, drawn from your dbt models in omop: 15 tables, 113 relationships. Nothing is saved yet."
- Show details: "Tables (15)" (for example "person 18 columns · primary key person_id · 8 foreign keys new"), "Relationships (113)" all "many-to-one", and "Not drawn (22)", each with "Left out to keep the diagram readable. Add it from the canvas."
- Toast after Keep: "Drew the 15 best-connected tables and left 22 out to keep the diagram readable. Add more from the canvas."
- Canvas banner: "dbt hasn't parsed this project yet. Your diagram is fine, but the Physical view can't show columns and tests without it. No dbt profile? Run dbt parse can parse without your credentials when dbt Core and your adapter are installed." [Run dbt parse]
- Canvas footer: "15 tables | 113 relationships | GLD Gold 15"; Problems 0 errors, 0 warnings.
- Rehearsal only:
  - Change options… QuickPick: "Which dbt models should the diagram start from?" Options: omop (37, pick up to 15), staging/map (1), staging/synthea (18, pick up to 15), staging/vocabulary (10), "Models connected to concept" (46, pick up to 15), and "Choose models… pick up to 15 of 66".
  - Error toast after ticking a 16th: "You picked 16 models. A draft holds up to 15, so untick 1." [Choose Again]
- Output channel: "Project: DBML storage, 0 table file(s), 0 diagram(s), dbt project" / the manifest warning above / "[Canvas] Open …: posted 15 tables (auto layout next) in 6 ms" / "[Canvas] Saved the positions of 15 tables in …/omop.dbml in 22 ms (layout only)"

## If the import failed

It did not fail. The import completed with no errors.
