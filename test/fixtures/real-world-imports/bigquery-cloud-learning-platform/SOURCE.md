# Google Cloud Learning Platform's BigQuery tables (BigQuery)

Import type: **SQL DDL, Google BigQuery**. Pick the folder `tables_sql/` in **Import SQL DDL…**; the dialect is detected.

## What it is

The BigQuery tables Google's Cloud Learning Platform creates for its analytics (`lms_analytics`) and its
Learning Record Store (`lrs`): one `CREATE TABLE IF NOT EXISTS` per file. Columns carry their descriptions as
`OPTIONS(description = "…")`, some names are backtick-quoted (`` `description` ``, `` `state` ``), and several
columns are `STRUCT<…>` or `ARRAY<…>` (nested `NOT NULL` and `OPTIONS` inside a `STRUCT` in `lrs/statements.sql`).
The tables declare no keys.

Before the BigQuery dialect it was detected as Databricks and nothing imported: every table stopped at its first
`OPTIONS(…)`.

## Where it came from

- Project: https://github.com/GoogleCloudPlatform/cloud-learning-platform
- Pin: commit `5da5e36798114b103480f494157cfaaf44530409` (`main`), as pinned by the import corpus (`scripts/corpus/manifest.json` on `wip/b-corpus`, 2026-11-09).
- Files (`utils/tables_sql/` upstream, `tables_sql/` here):
  - https://raw.githubusercontent.com/GoogleCloudPlatform/cloud-learning-platform/5da5e36798114b103480f494157cfaaf44530409/utils/tables_sql/lms_analytics/cohort.sql
  - https://raw.githubusercontent.com/GoogleCloudPlatform/cloud-learning-platform/5da5e36798114b103480f494157cfaaf44530409/utils/tables_sql/lms_analytics/courseTemplate.sql
  - https://raw.githubusercontent.com/GoogleCloudPlatform/cloud-learning-platform/5da5e36798114b103480f494157cfaaf44530409/utils/tables_sql/lms_analytics/courseWork_collection.sql
  - https://raw.githubusercontent.com/GoogleCloudPlatform/cloud-learning-platform/5da5e36798114b103480f494157cfaaf44530409/utils/tables_sql/lms_analytics/courseWork_logs.sql
  - https://raw.githubusercontent.com/GoogleCloudPlatform/cloud-learning-platform/5da5e36798114b103480f494157cfaaf44530409/utils/tables_sql/lms_analytics/enrollmentFailureLogs.sql
  - https://raw.githubusercontent.com/GoogleCloudPlatform/cloud-learning-platform/5da5e36798114b103480f494157cfaaf44530409/utils/tables_sql/lms_analytics/enrollment_section_record.sql
  - https://raw.githubusercontent.com/GoogleCloudPlatform/cloud-learning-platform/5da5e36798114b103480f494157cfaaf44530409/utils/tables_sql/lms_analytics/roster_logs.sql
  - https://raw.githubusercontent.com/GoogleCloudPlatform/cloud-learning-platform/5da5e36798114b103480f494157cfaaf44530409/utils/tables_sql/lms_analytics/section.sql
  - https://raw.githubusercontent.com/GoogleCloudPlatform/cloud-learning-platform/5da5e36798114b103480f494157cfaaf44530409/utils/tables_sql/lms_analytics/submittedCW_collection.sql
  - https://raw.githubusercontent.com/GoogleCloudPlatform/cloud-learning-platform/5da5e36798114b103480f494157cfaaf44530409/utils/tables_sql/lms_analytics/user_collection.sql
  - https://raw.githubusercontent.com/GoogleCloudPlatform/cloud-learning-platform/5da5e36798114b103480f494157cfaaf44530409/utils/tables_sql/lrs/statements.sql
- SHA-256:
  - `tables_sql/lms_analytics/cohort.sql` (405 bytes): `27fe9871c5b50174a23952a97b9ea8aea110d65e74b43966ae78e6d60716f30a`
  - `tables_sql/lms_analytics/courseTemplate.sql` (529 bytes): `bfb51697481a2ef25eb83bbaf097501a46b8839baa46223c923cb899723d89a6`
  - `tables_sql/lms_analytics/courseWork_collection.sql` (1,265 bytes): `9876490da4a3a7781fe1c764c01666e3f864613e5f2eceaa87ffde505a971e3e`
  - `tables_sql/lms_analytics/courseWork_logs.sql` (277 bytes): `da49c1c5464c60ce38241e57712d5a1c9af262d173d8587ecb3f90bca4ee176b`
  - `tables_sql/lms_analytics/enrollmentFailureLogs.sql` (512 bytes): `96107a6574e6407959b563d7f88512072f6880c817f3382f35afeb98793cea3f`
  - `tables_sql/lms_analytics/enrollment_section_record.sql` (746 bytes): `64da0f6d271d5de38f034c6e5a614077d16cc7d067b277ae3e280a1b1788eec1`
  - `tables_sql/lms_analytics/roster_logs.sql` (308 bytes): `772ced8ee41054f95185bac60f7f41dc568a3858df9c322c544cc7daa3b285a2`
  - `tables_sql/lms_analytics/section.sql` (978 bytes): `f89105ebd60b37ff39956d2e80510897d1b753ffb77a4f7dcb21f5b33ef35ec1`
  - `tables_sql/lms_analytics/submittedCW_collection.sql` (1,077 bytes): `c95630f46af6c3f1a763fc91af4cb80e7493eaaad1c7337d01f726fc4be188c3`
  - `tables_sql/lms_analytics/user_collection.sql` (484 bytes): `6e43486fb7f23f4a44245fb170bc416df8b7435459cd0eee5f06b8addfb403bf`
  - `tables_sql/lrs/statements.sql` (1,271 bytes): `efeaa78f522d656ccbf94ce78f148a52cfaba0e036e006f8affbe64ae7f4e6bc`
- Downloaded 2026-11-09; each file's SHA-256 checked against the pinned manifest.

## Licence

Apache-2.0 (`LICENSE` at the repository root). The repository has no `NOTICE` file and the scripts carry
no headers. Copied to `UPSTREAM-LICENSE.txt`; the files are unchanged.

## What was copied

- `tables_sql/lms_analytics/cohort.sql`, byte for byte.
- `tables_sql/lms_analytics/courseTemplate.sql`, byte for byte.
- `tables_sql/lms_analytics/courseWork_collection.sql`, byte for byte.
- `tables_sql/lms_analytics/courseWork_logs.sql`, byte for byte.
- `tables_sql/lms_analytics/enrollmentFailureLogs.sql`, byte for byte.
- `tables_sql/lms_analytics/enrollment_section_record.sql`, byte for byte.
- `tables_sql/lms_analytics/roster_logs.sql`, byte for byte.
- `tables_sql/lms_analytics/section.sql`, byte for byte.
- `tables_sql/lms_analytics/submittedCW_collection.sql`, byte for byte.
- `tables_sql/lms_analytics/user_collection.sql`, byte for byte.
- `tables_sql/lrs/statements.sql`, byte for byte.
- Nothing else from the repository.

## Expected counts

Counted by sqlglot 27.29 (bigquery) over the 11 upstream files, never through ERD Studio (11 of 11 statements), types re-read as written (STRUCT<...> and ARRAY<...> as one type). No keys: the tables declare none. Descriptions are the columns' OPTIONS(description = ...).

- Tables: **11**
- Columns: **129**
- Primary keys: **0**
- Foreign keys / relationships: **0**
- Descriptions: **54**

| Table | Columns | Primary key | Foreign keys (column → target) |
|---|---|---|---|
| cohort | 9 | – | – |
| courseTemplate | 6 | – | – |
| courseWorkCollection | 27 | – | – |
| courseWorkLogs | 6 | – | – |
| enrollmentFailureLogs | 6 | – | – |
| sectionEnrollmentRecord | 10 | – | – |
| rosterLogs | 6 | – | – |
| section | 11 | – | – |
| submittedCourseWorkCollections | 21 | – | – |
| userCollection | 10 | – | – |
| statements | 17 | – | – |
