# Example projects

Eight small data models, each laid out the way a common modelling pattern lays out a warehouse. Each folder is a project of its own: open it in VS Code with **File > Open Folder…**, then click **ERD Studio** in the Activity Bar. None needs dbt.

| Example | Pattern | Shows |
|---|---|---|
| [medallion](medallion/) | Bronze, silver and gold (Databricks) | one schema per layer, the same warehouse name in two layers, relationships split by owner, a wide reporting table |
| [dbt-project-layers](dbt-project-layers/) | Staging, intermediate and marts (dbt Labs) | the schema folder is dbt's `+schema`, `models/` folders as diagrams, plain mart names with Kimball roles |
| [kimball-bus-matrix](kimball-bus-matrix/) | Kimball's bus matrix | a single layer, conformed dimensions on every star, the three fact types, role-playing dates, a relationships file per team |
| [data-vault](data-vault/) | Data Vault 2.0 (AutomateDV names) | hubs, links, satellites, PIT and bridge tables; composite keys; relationships and diagrams across layers |
| [gitlab-style](gitlab-style/) | A database per stage (GitLab's handbook) | the database as the layer, the same schema in two layers, the same table name in two schemas |
| [bigquery-versioned](bigquery-versioned/) | Stage in the dataset name (Mozilla's BigQuery) | dataset suffixes as layers, versioned tables and the views over them |
| [data-mesh](data-mesh/) | Data mesh | domains as schema folders, a relationships file per domain team, `CODEOWNERS`, other domains' tables on a diagram |
| [enterprise-warehouse](enterprise-warehouse/) | Inmon: a normalised core, team-owned marts | many small source schemas, subtypes and many-to-many in third normal form, two teams sharing one schema, a join across layers, a one big table and an activity stream, a real `.github/CODEOWNERS`; with a ten-minute walkthrough |

**Where to start:** open the one closest to your warehouse. If you're not sure, or you're new to ERD Studio, open [enterprise-warehouse](enterprise-warehouse/) and follow its walkthrough: it shows every part of the tree, and where ERD Studio saves a new relationship and why.

[Modelling patterns](../modelling-patterns.md) explains how the tree fits each one, and the rules that keep any layout tidy.
