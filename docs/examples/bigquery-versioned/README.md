# Layer in the dataset name, versioned tables (Mozilla style)

Mozilla documents its BigQuery warehouse in [bigquery-etl](https://github.com/mozilla/bigquery-etl/blob/main/docs/reference/recommended_practices.md) and its [data docs](https://mozilla.github.io/data-docs/cookbooks/bigquery/querying.html). Each product's data lives in four datasets, told apart by a **suffix**: `<namespace>_live` (pings as they arrive, kept 30 days), `<namespace>_stable` (deduplicated daily), `<namespace>_derived` (tables the nightly jobs build) and `<namespace>` with no suffix (the user-facing views). **Tables carry a version** (`clients_daily_v6`); **views don't** (`clients_daily`), so a new version can replace the old one behind the view. This example is a browser called Atlas, laid out the way Mozilla describes.

| In BigQuery | In `.erd-studio/` |
|---|---|
| the dataset suffix: `_live`, `_stable`, `_derived`, none | a layer: `live/`, `stable/`, `derived/`, `views/` |
| a dataset: `atlas_derived` | a schema folder with the full dataset name: `derived/tables/atlas_derived/` |
| the project (`project.dataset.table`) | nothing: one design per project, or a layer when the project is the stage |
| a versioned table, and the view over it | two tables: `clients_daily_v6` and `clients_daily` |

```text
.erd-studio/
├── README.md
├── layers.json
├── live/
│   └── tables/
│       └── atlas_live/
│           └── atlas_live__main_v1.dbml
├── stable/
│   ├── tables/
│   │   └── atlas_stable/
│   │       └── atlas_stable__main_v1.dbml
│   └── diagrams/
│       └── pings.dbml
├── derived/
│   ├── tables/
│   │   └── atlas_derived/
│   │       ├── clients_daily_v6.dbml
│   │       ├── clients_first_seen_v1.dbml
│   │       └── clients_last_seen_v2.dbml
│   ├── relationships/
│   │   └── derived.dbml
│   └── diagrams/
│       └── clients.dbml
└── views/
    ├── tables/
    │   └── atlas/
    │       ├── clients_daily.dbml
    │       ├── clients_first_seen.dbml
    │       └── clients_last_seen.dbml
    ├── relationships/
    │   └── views.dbml
    └── diagrams/
        └── clients.dbml
```

## What to notice

- **The layer can be part of the schema name.** The layer folder is the stage the suffix names; the schema folder keeps the dataset's full name, `atlas_derived`, exactly as BigQuery spells it. Add another product and it gets its own schema folders (`derived/tables/other_derived/`) in the same layers.
- **Same table name in two datasets.** `main_v1` is in both `atlas_live` and `atlas_stable`. A table's name is unique across the whole project, so they are `atlas_live__main_v1` and `atlas_stable__main_v1` (the dataset, two underscores, then the table), each with `alias: 'main_v1'`.
- **A version is part of the name.** `clients_daily_v6` is its own table; v7 would be a new file beside it. The view `clients_daily` says in its **Decisions** which version it shows.
- **Views are tables in the design**, marked `materialized: 'view'`. Each layer draws its own relationships: the derived tables point at `clients_first_seen_v1`, and the views at `clients_first_seen`.
- **Two diagrams can share a name in different layers**: `derived/diagrams/clients.dbml` and `views/diagrams/clients.dbml`.
- **A diagram can show two layers.** **pings**, in `stable/`, shows the live and stable copies of the ping side by side.

## When to choose it

Your warehouse marks the stage in the dataset or schema name rather than in a separate database, as BigQuery projects often do, or you version tables so consumers can move to a new version at their own pace.
