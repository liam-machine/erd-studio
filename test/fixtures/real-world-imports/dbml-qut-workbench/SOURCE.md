# DBML sample: QUT Ecoacoustics Acoustic Workbench

## What it is

The database diagram of the Acoustic Workbench, an open-source platform for storing and annotating environmental audio recordings, built by the QUT Ecoacoustics research group. The file describes the PostgreSQL database behind its Rails server (`baw-server`). The project keeps it in its `workbench` meta repository and renders it to SVG with `dbml-renderer`.

It was generated from a live database, not written by hand, so it reads like a real production schema: Rails tables, a CMS plugin's tables, audit columns on almost every table, and named foreign keys.

## Where it came from

- Repository: https://github.com/QutEcoacoustics/workbench
- File: `system_documentation/schema.dbml`
- Pinned commit: `5e169267e4286eddf343cb9fbbad5d7845adc02f` (2024-11-05, "Check in first version of a database diagram"). This is the only commit that touches the file. It is unchanged at `main` (`d7472bcf`, 2025-06-02).
- Raw URL: https://raw.githubusercontent.com/QutEcoacoustics/workbench/5e169267e4286eddf343cb9fbbad5d7845adc02f/system_documentation/schema.dbml
- SHA-256 of `schema.dbml`: `cdcafe0c33b28c1a83f81460c1f17bee4be379a88e3d4f798ee7d881476130df`

## Licence

Apache License 2.0 (the repository's `LICENSE`). Apache-2.0 asks redistributors to include a copy of the licence, so it is kept here as `UPSTREAM-LICENSE.txt`. The repository has no `NOTICE` file.

## What was copied

- `schema.dbml`: the upstream file, byte for byte. Nothing was removed or edited. (Upstream keeps it under `system_documentation/`; the folder is not kept because the file stands alone.)
- `UPSTREAM-LICENSE.txt`: the upstream `LICENSE`, unchanged.

## Why this one

Other real `.dbml` files were checked. GemsTracker (BSD-3-Clause) has inline refs and a three-column key but no enums. Mendeleev (MIT) is a small SchemaCrawler export with no enums or relationships of note. CityCatalyst and Avni are AGPL. This file has the widest spread of DBML features from a real project under a permissive licence. It has no inline refs; every relationship is a standalone `Ref`.

## Expected counts

Counted with a small Python line parser written for this task (not ERD Studio and not `@dbml/core`), then cross-checked with `grep` and `awk`:

- Tables: `^Table ` blocks. **49**.
- Columns: non-blank lines inside a `Table` block, outside its `Indexes` block. **466**.
- Primary keys: a column with `pk`, or an `Indexes` entry `(a, b) [pk]`. A composite key counts once. **45** tables have one: **42** single-column and **3** composite (two columns each). **4** tables have no primary key.
- Relationships: `^Ref ` lines. **96**. All are standalone, named, one-to-many (`parent.id < child.fk`). There are no inline `ref:` settings and no composite (multi-column) refs.
- Enums: **3**, with 4 values each.
- TableGroups: **2** (`CMS` with 9 tables, `Rails` with 2). 38 tables are in no group.
- Indexes: **109** (plus the 3 composite-key entries in `Indexes` blocks), of which **26** are `unique`. Every entry has a `name`. 106 are `type: btree`, 1 is `type: gin` (`harvest_items.info`, a jsonb column) and 2 unique constraints have no type.
- Column notes: **32**. Table notes: **0**. Column defaults: **49**, of which **10** are backtick SQL expressions.

| Table | Columns | Primary key | FKs out | Indexes (excl. PK) | TableGroup |
|---|---|---|---|---|---|
| active_storage_attachments | 6 | id | 1 | 2 |  |
| active_storage_blobs | 9 | id | 0 | 1 |  |
| active_storage_variant_records | 3 | id | 1 | 1 |  |
| analysis_jobs | 23 | id | 4 | 5 |  |
| analysis_jobs_items | 18 | id | 3 | 5 |  |
| analysis_jobs_scripts | 3 | analysis_job_id, script_id | 2 | 0 |  |
| anonymous_user_statistics | 4 | none | 0 | 0 |  |
| ar_internal_metadata | 4 | key | 0 | 0 | Rails |
| audio_event_comments | 13 | id | 5 | 5 |  |
| audio_event_import_files | 7 | id | 2 | 2 |  |
| audio_event_imports | 10 | id | 4 | 1 |  |
| audio_events | 18 | id | 6 | 6 |  |
| audio_events_tags | 7 | id | 4 | 3 |  |
| audio_recording_statistics | 6 | audio_recording_id, bucket | 1 | 2 |  |
| audio_recordings | 22 | id | 5 | 11 |  |
| bookmarks | 10 | id | 3 | 4 |  |
| comfy_cms_categories | 4 | id | 0 | 1 | CMS |
| comfy_cms_categorizations | 4 | id | 0 | 1 | CMS |
| comfy_cms_files | 7 | id | 0 | 1 | CMS |
| comfy_cms_fragments | 10 | id | 0 | 4 | CMS |
| comfy_cms_layouts | 12 | id | 0 | 2 | CMS |
| comfy_cms_pages | 14 | id | 0 | 3 | CMS |
| comfy_cms_revisions | 5 | id | 0 | 1 | CMS |
| comfy_cms_sites | 8 | id | 0 | 1 | CMS |
| comfy_cms_snippets | 8 | id | 0 | 2 | CMS |
| comfy_cms_translations | 9 | id | 0 | 3 |  |
| dataset_items | 8 | id | 3 | 1 |  |
| datasets | 7 | id | 2 | 0 |  |
| harvest_items | 10 | id | 3 | 4 |  |
| harvests | 16 | id | 3 | 0 |  |
| permissions | 10 | id | 4 | 7 |  |
| progress_events | 5 | id | 2 | 0 |  |
| projects | 17 | id | 3 | 4 |  |
| projects_saved_searches | 2 | none | 2 | 3 |  |
| projects_sites | 2 | none | 2 | 3 |  |
| provenances | 13 | id | 3 | 0 |  |
| questions | 7 | id | 2 | 0 |  |
| questions_studies | 2 | none | 2 | 0 |  |
| regions | 11 | id | 4 | 0 |  |
| responses | 7 | id | 4 | 0 |  |
| saved_searches | 8 | id | 2 | 3 |  |
| schema_migrations | 1 | version | 0 | 0 | Rails |
| scripts | 16 | id | 3 | 3 |  |
| sites | 19 | id | 4 | 3 |  |
| studies | 7 | id | 3 | 0 |  |
| tag_groups | 5 | id | 1 | 2 |  |
| tags | 10 | id | 2 | 3 |  |
| user_statistics | 7 | user_id, bucket | 1 | 2 |  |
| users | 32 | id | 0 | 4 |  |
| **Total** | **466** | **45** | **96** | **109** | |

"FKs out" counts the `Ref`s where the table is the many (child) side.

## Notable features an importer might drop or mangle

- **Named refs.** Every `Ref` has a name, such as `Ref "analysis_jobs_creator_id_fk":"users"."id" < "analysis_jobs"."creator_id"`. 47 are `*_fk` names and 49 are Rails `fk_rails_<hash>` names.
- **Ref direction written as `<`.** The parent (one side) is on the left and the child (many side) on the right. An importer that reads the left side as the FK side will flip all 96.
- **Referential actions.** 4 refs have `[delete: cascade]`.
- **Self-reference.** `scripts.group_id` points at `scripts.id`.
- **Role-playing references.** Most tables have `creator_id`, `updater_id` and `deleter_id`, each a separate ref to `users.id`. 18 child tables have two to four refs to `users`, so the same pair of tables has several relationships.
- **Many-to-many join tables with no primary key.** `projects_sites`, `projects_saved_searches` and `questions_studies` each hold two FKs and no key. `anonymous_user_statistics` also has no key.
- **Composite primary keys** declared only in `Indexes`: `analysis_jobs_scripts (analysis_job_id, script_id)`, `audio_recording_statistics (audio_recording_id, bucket)`, `user_statistics (user_id, bucket)`. In two of them the first key column is also an FK.
- **Enum-typed columns.** `analysis_jobs_items.status`, `.transition` and `.result` use the three enums. `status` has the default `` `'new'::public.analysis_jobs_item_status` ``.
- **Quoted names everywhere.** Every table, column, enum and ref name is in double quotes. Some types are quoted because they contain a space (`"character varying"`, 97 columns).
- **Reserved-word column names**: `"key"`, `"order"` and `"position"` are quoted and must keep their exact text.
- **PostgreSQL types with arguments**: `numeric(14,4)`, `numeric(10,4)`, `numeric(9,6)`, `character varying(255)`, `timestamp(6)`, plus `jsonb`, `tsrange` and an array type `integer[]`.
- **SQL expression defaults** in backticks, including commas and casts, e.g. `` `tsrange((CURRENT_DATE)::timestampwithouttimezone,(CURRENT_DATE+'1 day'::interval))` ``. The generator stripped the spaces from type names inside these expressions (`timestampwithouttimezone`, `charactervarying`); that is upstream text, not damage.
- **Notes with punctuation.** Column notes contain commas, full stops, hyphens and quotes, e.g. `note: 'Count of retries'`.
- **Column-level `unique`** on `anonymous_user_statistics.bucket`, and multi-column unique indexes such as `(record_type, record_id, name, blob_id)`.
- **TableGroup that leaves a table out.** `comfy_cms_translations` belongs with the CMS tables but is not in the `CMS` group.
- **Tables with no relationships at all (13)**: all 10 `comfy_cms_*` tables, `ar_internal_metadata`, `schema_migrations` and `anonymous_user_statistics`.
- **One hub table.** 54 of the 96 refs point at `users.id`.
- **`Project` block** with `database_type: 'PostgreSQL'` and a `Note`, and `//` comment lines at the top of the file.
- **Not present**: inline refs, composite refs, table aliases, schema-qualified names (`schema.table`), table notes, TableGroup colours or notes, one-to-one (`-`) and many-to-many (`<>`) refs, `increment`, and table header colours.
