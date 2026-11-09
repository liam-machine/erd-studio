# DBML written by other tools

Small DBML files other tools wrote or published, used unchanged by the DBML
round-trip tests (`test/unit/generated/dbmlImport.property.test.ts`): each is
imported, exported with ERD Studio's rich DBML exporter, and imported again,
and must give back the same tables, columns, keys and relationships.

They are kept here, apart from `test/fixtures/dbml/`, so the stricter
"export with no diagnostic" checks of `test/unit/dbmlRoundTrip.test.ts` do not
apply to them.

| File | Written by | Source (exact commit) | Licence |
|---|---|---|---|
| `holistics-dbml/index_tables.dbml` | `@dbml/core`'s DBML exporter (its test output) | [holistics/dbml `packages/dbml-core/__tests__/examples/model_exporter/dbml_exporter/output/index_tables.out.dbml`](https://github.com/holistics/dbml/blob/6b0c25b5d87ef8f44236eeb1e9dc149848e1503e/packages/dbml-core/__tests__/examples/model_exporter/dbml_exporter/output/index_tables.out.dbml) | Apache-2.0 (`holistics-dbml/LICENSE`) |
| `holistics-dbml/checks.dbml` | `@dbml/core`'s DBML exporter | [… `dbml_exporter/output/checks.out.dbml`](https://github.com/holistics/dbml/blob/6b0c25b5d87ef8f44236eeb1e9dc149848e1503e/packages/dbml-core/__tests__/examples/model_exporter/dbml_exporter/output/checks.out.dbml) | Apache-2.0 |
| `holistics-dbml/table_settings.dbml` | `@dbml/core`'s DBML exporter | [… `dbml_exporter/output/table_settings.out.dbml`](https://github.com/holistics/dbml/blob/6b0c25b5d87ef8f44236eeb1e9dc149848e1503e/packages/dbml-core/__tests__/examples/model_exporter/dbml_exporter/output/table_settings.out.dbml) | Apache-2.0 |
| `holistics-dbml/sticky_notes.dbml` | `@dbml/core`'s DBML exporter | [… `dbml_exporter/output/sticky_notes.out.dbml`](https://github.com/holistics/dbml/blob/6b0c25b5d87ef8f44236eeb1e9dc149848e1503e/packages/dbml-core/__tests__/examples/model_exporter/dbml_exporter/output/sticky_notes.out.dbml) | Apache-2.0 |
| `holistics-dbml/business.dbml` | hand-written example (the `dbml2sql` CLI's test input) | [holistics/dbml `packages/dbml-cli/__tests__/dbml2sql/filenames stdout/in-files/business.dbml`](https://github.com/holistics/dbml/blob/6b0c25b5d87ef8f44236eeb1e9dc149848e1503e/packages/dbml-cli/__tests__/dbml2sql/filenames%20stdout/in-files/business.dbml) | Apache-2.0 |
| `holistics-dbml/customer.dbml` | hand-written example (the `dbml2sql` CLI's test input) | [… `in-files/customer.dbml`](https://github.com/holistics/dbml/blob/6b0c25b5d87ef8f44236eeb1e9dc149848e1503e/packages/dbml-cli/__tests__/dbml2sql/filenames%20stdout/in-files/customer.dbml) | Apache-2.0 |
| `prisma-dbml-generator/schema.dbml` | prisma-dbml-generator (generated from its example Prisma schema) | [notiz-dev/prisma-dbml-generator `prisma/dbml/schema.dbml`](https://github.com/notiz-dev/prisma-dbml-generator/blob/955d62a3c34f2d5028902af3acf349cc1e91c60a/prisma/dbml/schema.dbml) | MIT, © 2020 notiz.dev (`prisma-dbml-generator/LICENSE`) |

The files are unmodified copies (Apache-2.0 §4: no changes were made; the
licence text is beside them).

Not committed (their licence is only a `license` field in package.json, with
no licence file or copyright line), noted for the gitignored schema-set cache
instead: softwaretechnik-berlin/dbml-renderer's `examples/*.dbml` (ISC per
package.json; `video-rental.dbml`, `aliases.dbml` at
`cb632914626bc9572063abba056d49fb00354980`).
