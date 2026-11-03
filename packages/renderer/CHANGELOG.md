# Changelog

All notable changes to `@erd-studio/renderer`. While `0.x`, a breaking change bumps the minor version.

## 0.4.0

### Added
- A table's own layer on the canvas: with `DisplayTable.layer` and `DisplaySubjectArea.layerConfigs` (core 0.4.0), a table node is badged and striped (`--model-node-layer-color`) with its own layer, marked `model-node--other-layer` when that is not the diagram's, and reads `schema.name` (the schema only when it is not the layer's own name) with its alias after it (`as orders`). `TableNodeData` gains the optional `tableLayer`, `tableLayerConfig`, `otherLayer`, `shownSchema` and `alias`. Without those fields (YAML, the physical stage, an older core) the node is badged with the diagram's layer (see Changed); the schema shows only as the `schema.` prefix and in the badge's hover card. No new `--vscode-*` variables.
- Re-exports core's rich DBML export: `toDbmlRich`, `DBML_RICH_EXPORT_HEADER` and the `DbmlRichOptions` type. A rich export is one file per diagram, its table and sticky-note positions in its `Project`'s `erd_layout`.
- Hover focus and relationship flow: `useHoverFocus()` (hover preview handlers and a root class; a host that builds on `/editor` must call it, or nothing flows even on click), `EdgeFlow` / `EdgeFlowGlyphs`, `usePrefersReducedMotion`, `computeCanvasFocus`. `CanvasState` gains the ephemeral `hoverFocus` and `flowFocus` (a host that hand-builds `CanvasState` instead of using `createCanvasSlice` must add them). No `DisplaySubjectArea` change and no new `--vscode-*` variables.
- The canvas store has a `canvasContext` (null by default, from `createCanvasSlice`) and a `setCanvasContext` action. With a context, an editing host's detail panel shows the table's File line (**Open** posts `openModelFile`), Reviewed by, and **Not on this diagram (n)** with **+ Add** and **Add all related**, and the node header shows a muted `+n` chip. Without a context, and always in the viewer, none of these appear.
- `ErdCanvas` prop `logicalOnly` (optional, default false) and canvas-store field `logicalOnly` (false by default, from `createCanvasSlice`). When set, the canvas root gets `editor-canvas--neutral`: tables, lines, end labels, flow arrows, the hover ring, the minimap and the legend samples use neutral theme colours (new tokens `--canvas-neutral-line`, `--canvas-neutral-border`, `--canvas-neutral-ring`, `--canvas-selection`, `--canvas-selection-glow`, all built from existing `--vscode-*` variables, so the README's variable list is unchanged), and the legend leaves out the Physical, ghost, provenance and comparison entries. Without the prop the viewer looks as before.
- `TableNodeData.singleLayer` (optional) and the helpers `isSingleLayerProject`, `layerAbbreviation` and `LAYER_BADGE_FALLBACK` (from `@erd-studio/renderer/editor`). When `layerConfigs` lists one layer at most and every table is in the diagram's layer, the badge and colour strip are left off and the legend drops its layer-badge row. A domain with no `layerConfigs` (an older core) renders as before.

### Changed
- After a domain update, the canvas keeps the existing React Flow node and edge objects for everything that came out the same, so dragging a table re-renders only the tables that moved and their edges instead of every node. What is drawn is unchanged; no API change.
- A table whose file cannot be read says which format failed: "DBML error on line N" for a `.dbml` table file (ERD Studio 2.0's native DBML storage), and "YAML error on line N" as before for a `.yml` one. A `DisplaySubjectArea` from an older core never carries the DBML kinds, so its nodes read exactly as before.
- The table node badge always shows the layer the table lives in (`DisplayTable.layer`, else the diagram's `layer`): its text is the layer's abbreviation, then BRZ/SLV/GLD for the default layers, then the first three letters. The schema-abbreviation fallback and the `model-node__badge--layer` class are gone. The badge tooltip reads `Layer: …` and `Schema: …`, plus a line on the physical stage when no dbt schema is resolved; a domain with no `layer` draws no badge. This is a visible rendering change in the viewer.
- `shownSchema` (the dim `schema.` prefix) is set on every stage whenever the schema differs from the badge's layer id, and `estimateNodeWidth` reserves its width.
- The selection ring takes the colour of the stage being viewed (`--model-node-ring`, new class `model-node--stage-<stage>`), so a ghost on the physical stage rings green; it replaces React Flow's focusBorder ring, and the amber discrepancy-extra glow again wins over the selection.
- Outside the viewer, the detail panel puts Description, Columns and Relationships first and folds Table type, Grain, Meta and Design Rationale under **Modelling detail (optional)**, which opens on its own when any is set; **Remove from Diagram** (was Remove from Subject Area) moved to the bottom. Its confirmation says a table's relationships stay in the Table Library unless the diagram file holds them (`relationshipsInDiagramFile`; an older core keeps the old warning). The role picker is **Table type**, with plain names (Pre-joined fact, Flattened dimension, Local dimension; stored values unchanged). The viewer keeps its old layout and shows none of these.
- Legend: the layer badge is explained as “The layer the table lives in”, a schema-prefix row is added, and “Annotations” / “Build Note” now read “Notes” / “Note”.
- Outside the viewer, with the store's `logicalOnly` set (no dbt project), the detail panel shows the **Warehouse name** row only for a table that already has an alias, and words its hint and tooltip without dbt ("The table's name in the warehouse (its alias)…"). Without `logicalOnly` the editor's row reads as before. No API change.
- The viewer (`ErdCanvas`) never names dbt, since a page embedding it cannot know whether the project uses dbt: the **Warehouse name** tooltip reads "Named X in the warehouse…" (was "Built as X (dbt alias)…"), and on a physical-stage domain the "Columns from" row, the provenance chip and its hover text (the manifest chip reads `MNF`, was `DBT`), the ghost hover text and the layer badge's no-schema line ("No schema resolved.", without the dbt commands) use neutral words, as do the legend's Physical, ghost, provenance and comparison entries. The editor (no `viewer`) is unchanged. New exports from `lib/badgeLabels` (`/editor`): `SOURCE_LABEL_NEUTRAL`, `SOURCE_PHRASE_NEUTRAL`, `SOURCE_LEGEND_DESC_NEUTRAL`. This is a visible wording change in the viewer; no `DisplaySubjectArea` change and no new `--vscode-*` variables.

### Changed (breaking)
- `CanvasState` gains the required members `logicalOnly` and `canvasContext`, and `CanvasActions` the required `setCanvasContext`. A store built with `createCanvasSlice` has them; a host that hand-builds `CanvasState` instead must add them (as for `hoverFocus` / `flowFocus`).
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
