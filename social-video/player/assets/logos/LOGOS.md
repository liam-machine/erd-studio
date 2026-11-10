# Third-party logos

Used in the README cut ("How ERD Studio works", `VARIANT=readme`: `scenes/readme/import.js`,
`scenes/readme/confluence.js`) and the 2.0 LinkedIn post (`VARIANT=launch`: its logo wall,
export and Confluence scenes).

**Promotional use (the launch post).** On 2026-11-10 Liam decided to show every import source with
its official mark in the LinkedIn post, to say which tools ERD Studio is compatible with so people
recognise what they use (see the note at the end). Each mark stays unaltered, in its owner's
colours, beside its name, and none is presented as an endorsement. Re-check an owner's terms before
using a mark in a paid ad.

Each mark names the product it stands for, next to that product's real label in ERD Studio
(nominative use); none suggests endorsement. The marks remain their owners' trademarks. Colours are each
brand's own, unchanged.

Every file was downloaded on 2026-11-05, then parsed and rewritten by a sanitiser that keeps only
graphic SVG elements and refuses scripts, event handlers, `href`s and external `url()`s. The only
edits: a `fill` with the brand colour on the single-colour Simple Icons paths, a
`viewBox="0 0 48 48"` on `power-bi.svg` so it scales, and the standard SVG 1.1 `DOCTYPE` line
removed from `postgresql.svg` before parsing (the sanitiser refuses any DOCTYPE). No mark is
cropped, recoloured or redrawn.

| File | Source | Terms |
|---|---|---|
| `power-bi.svg` | Microsoft Fabric icons, `power_bi_48_color.svg` from `v6.1.0/package/dist/svg/` in https://github.com/microsoft/fabric-samples/raw/main/docs-samples/Icons.zip (linked from https://learn.microsoft.com/en-us/fabric/fundamentals/icons) | Microsoft permits these icons in architectural diagrams, training materials and documentation; Microsoft reserves all other rights |
| `sql-server.svg` | Azure architecture icons, `Icons/databases/10132-icon-service-SQL-Server.svg` in https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_V25.zip (linked from https://learn.microsoft.com/en-us/azure/architecture/icons/) | Microsoft's icon terms as above (`Microsoft_Terms_of_Use.pdf` and `Azure_Icons_FAQ.pdf` in the zip). This is the Azure "SQL Server" service icon, not the SQL Server product logo: Microsoft publishes no SQL Server product mark for third-party use, and its trademark guidelines do not let others use its product logos, so the icon set it does license is the one used |
| `confluence.svg` | Atlassian logo library, `confluence/SVG/Confluence_icon.svg` in https://atlassian.design/assets/7b2160bc07f6/logos/confluence_app.zip (https://atlassian.design/foundations/logos) | Atlassian's logo guidelines, https://atlassian.design/foundations/logos |
| `dbt.svg` | Simple Icons 13.21.0, https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/dbt.svg, colour `#FF694B` | Simple Icons: CC0 1.0; the mark is dbt Labs' trademark |
| `postgresql.svg` | The official PostgreSQL elephant ("Slonik", three colours), https://wiki.postgresql.org/images/a/a4/PostgreSQL_logo.3colors.svg (from https://wiki.postgresql.org/wiki/Logo) | PostgreSQL trademark policy, https://www.postgresql.org/about/policies/trademarks/, which allows the logo to refer to PostgreSQL |
| `snowflake.svg` | Simple Icons 13.21.0, `icons/snowflake.svg`, colour `#29B5E8` | CC0 1.0; Snowflake brand guidelines, https://www.snowflake.com/brand-guidelines/ |
| `databricks.svg` | Simple Icons 13.21.0, `icons/databricks.svg`, colour `#FF3621` | CC0 1.0; Databricks brand guide, https://brand.databricks.com/Styleguide/Guide/ |
| `github.svg` | Simple Icons 13.21.0, `icons/github.svg`, colour `#181717` (on the light Confluence page) | CC0 1.0; GitHub logo terms, https://github.com/logos |
| `fabric.svg` | Microsoft Fabric icons, `fabric_48_color.svg` from `v6.1.0/package/dist/svg/` in https://github.com/microsoft/fabric-samples/raw/main/docs-samples/Icons.zip (as `power-bi.svg`); `viewBox="0 0 48 48"` added so it scales | Microsoft's icon terms, as `power-bi.svg` |
| `mysql.svg` | Simple Icons 13.21.0, `icons/mysql.svg`, colour `#4479A1` | CC0 1.0; the mark is Oracle's trademark (https://www.mysql.com/about/legal/trademark.html) |
| `mariadb.svg` | Simple Icons 13.21.0, `icons/mariadb.svg`, colour `#003545` | CC0 1.0; MariaDB trademark policy, https://mariadb.com/trademarks/ |
| `oracle.svg` | Simple Icons 13.21.0, `icons/oracle.svg`, colour `#F80000` | CC0 1.0; Oracle trademark guidelines, https://www.oracle.com/legal/trademarks/ |
| `bigquery.svg` | Simple Icons 13.21.0, `icons/googlebigquery.svg`, colour `#669DF6` | CC0 1.0; Google Cloud icons may be used to reference Google technology, https://cloud.google.com/icons |
| `redshift.svg` | Simple Icons 13.21.0, `icons/amazonredshift.svg`, colour `#8C4FFF` | CC0 1.0; AWS architecture icon terms, https://aws.amazon.com/architecture/icons/ |
| `sqlite.svg` | Simple Icons 13.21.0, `icons/sqlite.svg`, colour `#003B57` | CC0 1.0; the SQLite name and mark belong to Hipp, Wyrick & Company |

One source has no logo on purpose:

- **DBML** has no mark of its own (dbdiagram.io's logo is that product's, and the Import picker's
  detail already names dbdiagram.io in text), so the DBML row draws a plain "DBML" text badge. The ERD Studio icon is the extension's own (`/media/icon.png`).

**Compatibility wall (2026-11-10).** On Liam's decision, every source the import reads is shown with
its mark, in one same-size grid, so people recognise what they already use: each mark unaltered, in
its owner's colours, beside its name, and none presented as an endorsement. This supersedes the
earlier "MySQL has no logo" rule. The marks remain their owners' trademarks.
