# Third-party logos on the import guide

The marks beside each source's name in **Bring In Your Data Model…** (`src/services/importGuide.ts`).
Copied unchanged from `video/player/assets/logos/` (nothing here loads from `video/` at build or run
time); each file's source, terms and how it was vetted are in
`social-video/player/assets/logos/LOGOS.md`.

Each mark names the product it stands for, beside that product's name (nominative use); none suggests
endorsement. The marks remain their owners' trademarks. Colours are each brand's own, unchanged, and
each is drawn as an image, never restyled by the page.

| Card | File |
|---|---|
| Databricks (Unity Catalog) | `databricks.svg` |
| Snowflake | `snowflake.svg` |
| Power BI | `power-bi.svg` |
| Microsoft Fabric | `fabric.svg` |
| SQL Server and Azure SQL | `sql-server.svg` |
| PostgreSQL | `postgresql.svg` |
| MySQL and MariaDB | `mysql.svg` |
| dbt | `dbt.svg` |

DBML, "Other modelling tools" and "Not yet" have no mark: DBML has none of its own, and the others
are not one product.

The guide inlines them as `data:` images from the generated `src/services/importGuideLogos.ts`
(`node scripts/gen-import-guide-logos.mjs` after changing a file; a test fails if the two differ).
The `.svg` files do not ship in the VSIX (`src/**` is ignored).
