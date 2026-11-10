# dbt-synthea (OHDSI) — real-world dbt sample

## What it is

dbt-synthea is the OHDSI community's dbt project that turns Synthea synthetic patient data into the OMOP Common Data Model (CDM 5.4). It is a real, published project, not written for ERD Studio. It has 87 models in three folders: `staging/` (Synthea, vocabulary and a state map), `intermediate/` and `omop/` (the 37 OMOP CDM tables).

It is a good import test because every documented column has a `data_type`, and the schema yml holds 319 `relationships` / `dbt_utils.relationships_where` tests and 41 `unique` tests.

Test it with **Import from dbt…** (`erdStudio.drawFromDbt`).

## Where it came from

- Repository: https://github.com/OHDSI/dbt-synthea
- Pinned commit: `33fdbfa9b354f00def5ee6e45525cb2da80e0ddf` (main, 2026-05-22, "fix dependabot alerts (#152)"). The repo has no tags or releases.
- Browse the pin: https://github.com/OHDSI/dbt-synthea/tree/33fdbfa9b354f00def5ee6e45525cb2da80e0ddf

## Licence

Apache License 2.0 (GitHub reports `Apache-2.0`). Redistribution is allowed with a copy of the licence, so the upstream `LICENSE` is kept as `UPSTREAM-LICENSE.txt`. Upstream has no NOTICE file. No file was changed.

## Why not dbt-labs/jaffle-shop

The suggested `dbt-labs/jaffle-shop` has no licence file (GitHub reports no licence), so it cannot be redistributed. Its Apache-2.0 siblings (`jaffle_shop_duckdb`, the archived `jaffle-shop-classic`) have only 5 models, one relationship test and no `data_type`, so they would not show whether types and relationships come in. dbt-synthea is permissively licensed and much richer.

## What was copied

Copied unchanged, keeping the upstream layout:

- `dbt_project.yml`, `packages.yml`, `package-lock.yml`, `.dbtignore`, `README.md`, `docs/overview.md`
- `models/` — all 87 `.sql` files and 43 yml files (40 model property files, 3 `sources:` files; the OMOP tables have one yml each under `omop/_models/`)
- `macros/` — referenced by the models and tests (`get_type_variants`, `get_equivalent_types`, `string_truncate`, …)
- `tests/generic/` — the custom generic tests `concept_record_completeness` and `person_completeness`
- `seeds/.gitkeep` only

Left out:

- `seeds/` data (about 12 MB of CSV: Synthea patients and an OMOP vocabulary subset). Not needed to draw.
- `scripts/` (Python and R helpers), `requirements/`, `.github/`, `.vscode/`, `.sqlfluff*`, `.pre-commit-config.yaml`, `assets/` (a PNG logo), `analyses/`, `snapshots/` (both only `.gitkeep`), `DATA_QUALITY.md`, `STYLE_GUIDE.md`.
- Upstream has no `profiles.yml`, `target/`, `logs/` or `dbt_packages/`, and none are included.

## Does the draw need a manifest?

No. There is no `target/manifest.json` here and dbt was never run. Every model that has a schema yml entry lists its columns there, with a `data_type`, and all the tests are in the yml. So the draw works from schema yml alone.

Without a manifest, the 21 `intermediate/int__*` models are not drawable: they have a `.sql` file but no yml entry, so they have no declared columns (`listDraftModels` leaves them out). A manifest would not change that either, because a manifest copies yml columns. There is no `catalog.json`.

The physical stage will show the models from yml. Model SQL uses Jinja and `ref()`, which ERD Studio does not need to compile.

## Expected counts

Counted by parsing every `models/**/*.yml` file with the `yaml` npm package (a scratch Node script, not ERD Studio) and checking the result against `.sql` file names:

- A **table** is a model with a yml entry. 87 `.sql` models, 66 with a yml entry, 21 without (all `intermediate/`).
- A **column** is an entry under the model's `columns:`.
- A **primary key** is a column with a `unique` test. No model has two, and there is no `unique_combination_of_columns`, so there are no composite keys.
- A **relationship** is one distinct (model, column, target model, target field) from `relationships` or `dbt_utils.relationships_where` tests. 319 tests (194 `relationships`, 125 `relationships_where`) collapse to **235 distinct links**: 41 columns carry both kinds to the same target, and some carry two `relationships_where` tests with different filters.

| | Count |
|---|---|
| Models (`.sql`) | 87 |
| Tables (models with yml) | 66 |
| Columns | 741 |
| Columns with `data_type` | 732 |
| Primary keys (single-column `unique`) | 41 |
| Composite keys | 0 |
| Relationship tests (raw) | 319 |
| Relationships (distinct links) | 235 |
| Sources (`sources:` tables, no columns) | 29 |

By folder (what a single-folder draw should show):

| Folder | Tables | Columns | Typed | PKs | Links | Links inside the folder |
|---|---|---|---|---|---|---|
| `omop` | 37 | 421 | 421 | 28 | 174 | 174 |
| `staging/synthea` | 18 | 257 | 257 | 8 | 42 | 42 |
| `staging/vocabulary` | 10 | 61 | 52 | 5 | 19 | 0 (all 19 point at `omop` models) |
| `staging/map` | 1 | 2 | 2 | 0 | 0 | 0 |
| `intermediate` | 0 drawable (21 `.sql`) | — | — | — | — | — |

Per table. "Links" is distinct links out of the table; "Tests" is the raw relationship-test count.

| Table | Folder | Columns | Typed | PK | Links | Tests |
|---|---|---|---|---|---|---|
| care_site | omop | 6 | 6 | care_site_id | 2 | 3 |
| cdm_source | omop | 11 | 11 | - | 1 | 2 |
| concept | omop | 10 | 10 | concept_id | 3 | 3 |
| concept_ancestor | omop | 4 | 4 | - | 2 | 2 |
| concept_class | omop | 3 | 3 | concept_class_id | 1 | 1 |
| concept_relationship | omop | 6 | 6 | - | 3 | 3 |
| concept_synonym | omop | 3 | 3 | - | 2 | 2 |
| condition_era | omop | 6 | 6 | condition_era_id | 2 | 3 |
| condition_occurrence | omop | 16 | 16 | condition_occurrence_id | 8 | 11 |
| cost | omop | 22 | 22 | cost_id | 5 | 9 |
| death | omop | 7 | 7 | - | 4 | 6 |
| device_exposure | omop | 19 | 19 | device_exposure_id | 9 | 12 |
| domain | omop | 3 | 3 | domain_id | 1 | 1 |
| dose_era | omop | 7 | 7 | dose_era_id | 3 | 6 |
| drug_era | omop | 7 | 7 | drug_era_id | 2 | 4 |
| drug_exposure | omop | 23 | 23 | drug_exposure_id | 8 | 11 |
| drug_strength | omop | 12 | 12 | - | 5 | 10 |
| episode | omop | 13 | 13 | episode_id | 5 | 8 |
| episode_event | omop | 3 | 3 | - | 2 | 3 |
| fact_relationship | omop | 5 | 5 | - | 3 | 4 |
| location | omop | 12 | 12 | location_id | 1 | 2 |
| measurement | omop | 23 | 23 | measurement_id | 12 | 18 |
| metadata | omop | 9 | 9 | metadata_id | 3 | 6 |
| note | omop | 16 | 16 | note_id | 9 | 14 |
| note_nlp | omop | 14 | 14 | note_nlp_id | 3 | 5 |
| observation | omop | 21 | 21 | observation_id | 11 | 17 |
| observation_period | omop | 5 | 5 | observation_period_id | 2 | 3 |
| payer_plan_period | omop | 17 | 17 | payer_plan_period_id | 9 | 13 |
| person | omop | 18 | 18 | person_id | 9 | 12 |
| procedure_occurrence | omop | 16 | 16 | procedure_occurrence_id | 8 | 11 |
| provider | omop | 13 | 13 | provider_id | 5 | 7 |
| relationship | omop | 6 | 6 | relationship_id | 1 | 1 |
| source_to_concept_map | omop | 9 | 9 | - | 3 | 5 |
| specimen | omop | 15 | 15 | specimen_id | 6 | 11 |
| visit_detail | omop | 19 | 19 | visit_detail_id | 11 | 15 |
| visit_occurrence | omop | 17 | 17 | visit_occurrence_id | 9 | 13 |
| vocabulary | omop | 5 | 5 | vocabulary_id | 1 | 1 |
| stg_map__states | staging/map | 2 | 2 | - | 0 | 0 |
| stg_synthea__patients | staging/synthea | 25 | 25 | patient_id | 0 | 0 |
| stg_synthea__allergies | staging/synthea | 15 | 15 | - | 2 | 2 |
| stg_synthea__careplans | staging/synthea | 9 | 9 | careplan_id | 2 | 2 |
| stg_synthea__claims_transactions | staging/synthea | 33 | 33 | claim_transaction_id | 6 | 6 |
| stg_synthea__claims | staging/synthea | 31 | 31 | claim_id | 7 | 7 |
| stg_synthea__conditions | staging/synthea | 6 | 6 | - | 2 | 2 |
| stg_synthea__devices | staging/synthea | 9 | 9 | - | 2 | 2 |
| stg_synthea__encounters | staging/synthea | 17 | 17 | encounter_id | 4 | 4 |
| stg_synthea__imaging_studies | staging/synthea | 13 | 13 | - | 2 | 2 |
| stg_synthea__immunizations | staging/synthea | 6 | 6 | - | 2 | 2 |
| stg_synthea__medications | staging/synthea | 15 | 15 | - | 3 | 3 |
| stg_synthea__observations | staging/synthea | 10 | 10 | - | 2 | 2 |
| stg_synthea__organizations | staging/synthea | 11 | 11 | organization_id | 0 | 0 |
| stg_synthea__payer_transitions | staging/synthea | 10 | 10 | - | 3 | 3 |
| stg_synthea__payers | staging/synthea | 18 | 18 | payer_id | 0 | 0 |
| stg_synthea__procedures | staging/synthea | 11 | 11 | - | 2 | 2 |
| stg_synthea__providers | staging/synthea | 12 | 12 | provider_id | 1 | 1 |
| stg_synthea__supplies | staging/synthea | 6 | 6 | - | 2 | 2 |
| stg_vocabulary__concept | staging/vocabulary | 10 | 10 | concept_id | 3 | 3 |
| stg_vocabulary__concept_ancestor | staging/vocabulary | 4 | 4 | - | 2 | 2 |
| stg_vocabulary__concept_class | staging/vocabulary | 3 | 3 | concept_class_id | 1 | 1 |
| stg_vocabulary__concept_relationship | staging/vocabulary | 6 | 6 | - | 3 | 3 |
| stg_vocabulary__concept_synonym | staging/vocabulary | 3 | 3 | - | 2 | 2 |
| stg_vocabulary__domain | staging/vocabulary | 3 | 3 | domain_id | 1 | 1 |
| stg_vocabulary__drug_strength | staging/vocabulary | 12 | 12 | - | 5 | 5 |
| stg_vocabulary__relationship | staging/vocabulary | 6 | 6 | relationship_id | 1 | 1 |
| stg_vocabulary__vocabulary | staging/vocabulary | 5 | 5 | vocabulary_id | 1 | 1 |
| stg_vocabulary__source_to_concept_map | staging/vocabulary | 9 | 0 | - | 0 | 0 |

## Notable features an importer might drop or mangle

- **Legacy test syntax everywhere.** Tests sit under `tests:` (not `data_tests:`), and every relationship test puts `to:` / `field:` directly under the test name, without the dbt 1.10+ `arguments:` block.
- **`dbt_utils.relationships_where`** (125 tests) with `from_condition` / `to_condition` filters. The OMOP convention stores `0` for "no concept", so the filters exclude it.
- **Duplicate relationship tests** on the same column and target (plain `relationships` plus one or two `relationships_where`). An importer should draw one line, not two or three.
- **Role-playing foreign keys.** Most OMOP tables point many columns at `concept.concept_id` (for example `measurement` has 8 links to `concept`). `stg_synthea__claims` points three columns at `stg_synthea__providers` and two at `stg_synthea__payers`.
- **Self-references:** `visit_detail.preceding_visit_detail_id` and `visit_detail.parent_visit_detail_id` → `visit_detail`; `visit_occurrence.preceding_visit_occurrence_id` → `visit_occurrence`.
- **Cross-folder links:** all 19 links from `staging/vocabulary` point at `omop` models (`concept`, `domain`, `vocabulary`, `concept_class`, `relationship`), not at their own staging siblings. A one-folder draw cannot show them as lines.
- **Mixed type spellings:** `integer` (251), `text` (164), `date` (75), `varchar(50)` (55), `double precision` (39), `datetime` (35), `float` (28), `varchar(n)` with many lengths, `varchar(MAX)` (3, a SQL Server spelling), and one capitalised `Integer` (`visit_occurrence.yml`).
- **Missing types:** `stg_vocabulary__source_to_concept_map` declares 9 columns with no `data_type`.
- **25 tables with no `unique` test**, so no primary key (for example `death`, `concept_ancestor`, `concept_relationship`, `fact_relationship`, `drug_strength`, most Synthea event tables).
- **Models without yml:** the 21 `intermediate/int__*` models.
- **Double-underscore names** (`stg_synthea__patients`, `int__person`) and three models named like SQL words (`domain`, `relationship`, `metadata`).
- **Long, multi-line descriptions** on most OMOP columns, some with quotes and colons.
- **YAML anchors and aliases** in `dbt_project.yml` (`&synthea_config` / `*synthea_config`, `&concept_columns` / `*concept_columns`), plus Jinja in a source `schema:`.
- **Packages** referenced but not installed: `dbt_utils`, `dbt_expectations` (metaplane), `dbt_date`. The `dbt_expectations.*` type and length tests (953 in all) and the custom `concept_record_completeness` / `person_completeness` tests are not keys or relationships and should be ignored.
- **Model-level tests:** 16 OMOP models carry a model-level `person_completeness` test, which is neither a key nor a relationship.
