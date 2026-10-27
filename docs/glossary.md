# Glossary

ERD Studio's screens say **table**, **Table Library** and **subject area**. Older releases said *model*, *Model Library* and *domain*. The files can say the new words too: a project on the new file naming (schema v6) uses them on disk, and **ERD Studio: Migrate to the New File Naming** moves an existing project over in one undoable step. A project that has not migrated keeps the old names on disk (schema v5), and every file written by any release keeps loading.

This page matches each word on screen to the name you'll find in the files and in the code. Where the two namings differ, the on-disk column shows the new name first and the old one after it.

| On screen | On disk (new naming · old naming) | In the code | Meaning |
|---|---|---|---|
| **Table** | One YAML file in `.erd-studio/tables/` · `.erd-studio/logical-models/` (`{name}.yml`, or one folder down) | `SemanticTable` (core types), `DisplayTable` (what the canvas draws), `TableNode` (the canvas node) | One table in your design: its columns, keys, grain and rationale. Its `name` is its identity everywhere. |
| **Table Library** | The `.erd-studio/tables/` folder · `.erd-studio/logical-models/` | `TableLibraryService`, `TableLibraryTreeProvider` (view id `erdStudio.modelLibrary`) | Every table in the project, each stored once and shared by every subject area that uses it. |
| **Subject Area** | One JSON file, `.erd-studio/{layer}/{name}.json` (the same path in both), named by its `subjectArea` · `domain` field. Its tables are listed in `logical.tables` · `logical.models`; `schemaVersion` is 6 · 5 | `SemanticSubjectArea` / `UnifiedSubjectArea` (the file as read), `DisplaySubjectArea` (one stage, ready to draw), `SubjectAreaService` | One area of the business (sales, finance…): the tables it shows, its layout and, in older projects, its relationships. |
| **The data model** | Everything under `.erd-studio/` | — | All of it together: every subject area, every table and the relationships between them. |
| **dbt model** (meaning unchanged) | dbt's own files: `.sql` / `.py` under `models/`, schema `.yml`, `target/manifest.json` | `ManifestService`, `YmlParserService`, `CatalogService` | A model in your dbt project. **Draw from dbt** and **Add Tables from dbt** turn dbt models into tables. |
| **Diagram / canvas** | The `viewConfig` section of the subject area file (positions, notes) | `ErdCanvas` (`@erd-studio/renderer`), `SemanticEditorProvider` (the VS Code editor) | The picture of one subject area that you edit. |
| **Layer** | `.erd-studio/layers.json`; the `{layer}` folder a subject area file sits in, and the `layer` field | `Layer`, `LayerConfig`, `LayerService` | A stage of your warehouse (bronze, silver, gold). Optionally also a folder in the Table Library. |
| **Logical stage** | The table YAMLs plus the subject area file's `logical` section | `Stage` = `'logical'`, `buildLogicalDisplaySubjectArea` | Your design, in blue. The stage you edit. |
| **Physical stage** | Nothing: it is never saved | `Stage` = `'physical'`, `SubjectAreaService.buildPhysicalSubjectArea` | What your dbt project has, in green, read from dbt every time. Read-only. Its tab shows only when the open folder has a `dbt_project.yml`. |
| **Relationship** | A `relationships:` entry in the table YAML that holds the foreign key, pointing at `toTable` · `toModel` (no from end, since that is the file's own table), or a `logical.relationships` entry with `fromTable` / `toTable` · `fromModel` / `toModel` in a subject area file | `Relationship`, `DisplayRelationship` | A line between two tables, from the foreign key to the key it points at. |

Other renamed keys: a table's role is `tableRole` · `modelRole` (such as `conformed-dim`), and a note's linked table is `linkedTable` · `linkedModel`. Names that keep the old word in both: `modelFolder` (it is dbt's `models/` path filter), and the `--domain` and `--models` options of the `erd-studio` command-line helper.

## Command and setting ids

Only the words on screen changed. The ids of commands, settings and views keep their old names, so your keybindings, `settings.json` and `when` clauses keep working. For example, **ERD Studio: New Subject Area** is still the command `erdStudio.createDomain` (the sidebar's **New Diagram** button runs it), and the folder setting is still `erdStudio.semanticDir`.

For the file formats in full, see the [file format reference](semantic-domain-json-reference.md).
