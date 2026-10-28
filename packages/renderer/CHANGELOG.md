# Changelog

All notable changes to `@erd-studio/renderer`. While `0.x`, a breaking change bumps the minor version.

## 0.4.0

### Added
- Re-exports core's rich DBML export and its dbdiagram layout file: `toDbmlRich`, `DBML_RICH_EXPORT_HEADER`, `toDbdiagramLayout`, `serializeDbdiagramLayout`, `dbdiagramLayoutFileName` and the `DbmlRichOptions`, `DbdiagramLayout` and `DbdiagramTablePosition` types.

### Changed
- After a domain update, the canvas keeps the existing React Flow node and edge objects for everything that came out the same, so dragging a table re-renders only the tables that moved and their edges instead of every node. What is drawn is unchanged; no API change.
- A table whose file cannot be read says which format failed: "DBML error on line N" for a `.dbml` table file (ERD Studio 2.0's native DBML storage), and "YAML error on line N" as before for a `.yml` one. A `DisplaySubjectArea` from an older core never carries the DBML kinds, so its nodes read exactly as before.

### Changed (breaking)
- Pins `@erd-studio/core` 0.4.0, whose `TableLoadErrorKind` gains three DBML kinds and whose `@dbml/parse` runtime dependency is loaded only by its `@erd-studio/core/dbml` subpath (the renderer never imports it). The re-exported `DiagramExportFormat` gains `'dbml-rich'` and `DIAGRAM_EXPORT_FORMATS` now ends with it, so a page that offers every format offers it too, and a `Record<DiagramExportFormat, …>` (a label or hint per format) or an exhaustive `switch` over it needs a case.

## 0.3.0

### Changed
- Pins `@erd-studio/core` 0.3.0, which reads schema v6, the table naming ([#181](https://github.com/liam-machine/erd-studio/issues/181)). No change to the renderer's own API: a v6 subject area reaches `ErdCanvas` as the same `DisplaySubjectArea` its v5 twin does.

## 0.2.0

### Changed (breaking)
- **Exports use the new words: table and subject area** ([#180](https://github.com/liam-machine/erd-studio/issues/180), part 2 of [#162](https://github.com/liam-machine/erd-studio/issues/162)). What was called a *model* is a **table**, and a *domain* is a **subject area**. Pins `@erd-studio/core` 0.2.0. The types re-exported from core carry its new names. Only names changed: every function behaves as before, and object shapes, property names (`DisplaySubjectArea.models`, `domainPath`, `ErdCanvas`'s `domain` prop, …), message `type` strings and the files read on disk are the same, so a `DisplaySubjectArea` from 0.2.0 is the `DisplayDomain` of 0.1.x. There are no aliases for the old names. Rename the imports:

| 0.1.x | 0.2.0 |
|---|---|
| `computeModelLabels` | `computeTableLabels` |
| `DisplayDomain` | `DisplaySubjectArea` |
| `DisplayModel` | `DisplayTable` |
| `LabelledModel` | `LabelledTable` |
| `matchesModelSearch` | `matchesTableSearch` |
| `ModelFlowNode` | `TableFlowNode` |
| `ModelNode` | `TableNode` |
| `ModelNodeData` | `TableNodeData` |
| `ModelRole` | `TableRole` |
| `transformDomain` | `transformSubjectArea` |
