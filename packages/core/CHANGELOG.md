# Changelog

All notable changes to `@erd-studio/core`. While `0.x`, a breaking change bumps the minor version.

## 0.4.0

### Added
- `subjectAreaViewConfig(doc, warn?)`: a validated domain document's view config as the loader reads it (the top-level `viewConfig`, else the stage-level `logical.viewConfig` older files hold), with malformed positions and sticky notes dropped.
- **Rich DBML export and its dbdiagram layout file.** `toDbmlRich(area, { layoutFileName? })`, and the new `'dbml-rich'` format of `exportDiagram` / `DIAGRAM_EXPORT_FORMATS` (saved as `.dbml`), write ERD Studio's fields as DBML custom properties (`role`, `grain`, `alias`, `schema` for the schema `public` (which DBML reads as no schema), `rationale_*`, `natural_key`, `scd_type`, `additive_type`, `foreign_key`, `meta_*` / `meta_json`), Refs from the foreign-key end (a one-to-one from its key end, since DBML and its SQL export read a one-to-one's second end as the foreign key) with `?` on every end that may be null, the layer as a `TableGroup` and sticky notes as `Note` blocks, behind the header `DBML_RICH_EXPORT_HEADER`. They need a DBML 9.1+ parser; the output is pinned by `<fixture>.rich.dbml` goldens read by `@dbml/parse` 9.1.1, 10.3.1 and 11.0.0. `toDbdiagramLayout` / `serializeDbdiagramLayout` write the positions as dbdiagram's `<name>.dbdiagram` (`dbdiagramLayoutFileName`), which `dbdiagram push` reads, and `readDbdiagramLayout` reads one back without ever throwing. The property names are `dbmlRichProperties.ts`'s constants, shared with ERD Studio's DBML import, plus `stickyColourOfHex`. `toDbml` and `toMermaid` are unchanged.
- **Where a domain file's JSON goes wrong** ([#186](https://github.com/liam-machine/erd-studio/issues/186)). A plain `'invalid-json'` `SubjectAreaFileError` (not a merge conflict) now carries optional `line` and `column` (1-based) and `syntaxProblem` (`'trailing-comma' | 'missing-comma' | 'truncated' | 'unexpected'`) when the mistake can be located, pointing where a person would put the fix (the trailing comma itself, the end of the value a comma is missing after) rather than where the parser stopped. `locateJsonSyntaxError(raw, parserMessage)` is the pure helper behind it; it works out the position from the text itself, so it is the same in every engine. `line` used to be set only for a merge conflict, so read it together with `mergeConflict`. `message` is unchanged.

### Changed (breaking)
- `DiagramExportFormat` gains `'dbml-rich'` and `DIAGRAM_EXPORT_FORMATS` a third entry: an exhaustive `switch` or a `Record<DiagramExportFormat, …>` over it needs a case, and a picker built from `DIAGRAM_EXPORT_FORMATS` offers it. `DIAGRAM_EXPORT_FILE_EXTENSIONS` maps both `dbml` and `'dbml-rich'` to `dbml`, so a `.dbml` file name no longer names one format.

### Fixed
- `parseSubjectAreaJson` (and so `loadDisplaySubjectArea`) reads a domain file that starts with a byte order mark, which used to be rejected as invalid JSON.
- `loadDisplaySubjectArea` keeps a `meta` key named `__proto__` on a model or column. The model file reader kept it, but the copy each listing gets dropped a text value and turned a map value into the meta's prototype.

## 0.3.0

### Added
- **Reads schema v6, the table naming** ([#181](https://github.com/liam-machine/erd-studio/issues/181), part 3 of [#162](https://github.com/liam-machine/erd-studio/issues/162)): `.erd-studio/tables/`, `logical.tables`, `subjectArea`, `fromTable` / `toTable`, `tableRole` and `linkedTable`. `validateSubjectAreaDocument` returns a v6 document under the v5 keys (`normaliseSubjectAreaDocument`, exported, does the renaming), so `buildUnifiedSubjectArea` and everything after it is unchanged and a v6 file builds the same `DisplaySubjectArea` as its v5 twin, apart from `schemaVersion`. `parseTableText` reads `tableRole` and `toTable` as `modelRole` and `toModel` (the v6 key wins when both are written). `loadDisplaySubjectArea` probes `tables/` after `logical-models/`, in the same order, so a v6 library costs one extra read per folder probed first; a v5 library costs what it did.
- `detectProjectNaming(evidence)` → `'v5' | 'v6' | 'mixed'`, from what a host found on disk (a project with no evidence either way, a new one, is `'v6'`); `writesTableNaming(naming)`, true for every naming but `'v5'`; `usesTableLibrary(format)`; `mixesTableNaming(raw)`; `TABLES_DIR` and `TABLE_LIBRARY_DIRS`; `LIBRARY_SCHEMA_VERSION` (5), `TABLE_NAMING_SCHEMA_VERSION` (6) and `WRITTEN_SCHEMA_VERSION` (5, what a writer of the v5 keys stamps).
- **Writes v6 too** ([#182](https://github.com/liam-machine/erd-studio/issues/182), part 4 of #162): `toTableNamingDocument(doc)`, the inverse of `normaliseSubjectAreaDocument`, turns a document held under the v5 keys back into the v6 naming with `schemaVersion` 6. Both keep the file's key order (a renamed key stays where it was), so a host can rewrite a file byte for byte.

### Changed (breaking)
- `SubjectAreaFormat` gains `'v6'`: an exhaustive `switch` needs a case for it. `detectSubjectAreaFormat` calls a file `hybrid` when it mixes the v5 and v6 names, uses the v6 names under `schemaVersion` 5 (which 0.2.0 drew as an empty diagram), or the v5 names under `schemaVersion` 6, and `describeUnsupportedSubjectAreaFormat` takes the raw document as an optional third argument to say which.
- `CURRENT_SCHEMA_VERSION` is 6: the newest version read. A file declaring 7 or more is refused with "Please update the extension". Code that stamped `CURRENT_SCHEMA_VERSION` on a file it writes should use `WRITTEN_SCHEMA_VERSION`.

## 0.2.0

### Changed (breaking)
- **Exports use the new words: table and subject area** ([#180](https://github.com/liam-machine/erd-studio/issues/180), part 2 of [#162](https://github.com/liam-machine/erd-studio/issues/162)). What was called a *model* is a **table**, and a *domain* is a **subject area**. The four error classes `loadDisplaySubjectArea` rejects with are renamed too; `instanceof` works as before, and `SubjectAreaFileError` and `TooManyTablesError` report their new class name in `name` (`SubjectAreaValidationError` still reports `Error`), and a bad limit option is reported as `loadDisplaySubjectArea: …` / `parseTableText: …`. Only names changed: every function behaves as before, and object shapes, property names (`DisplaySubjectArea.models`, `domainPath`, `ErdCanvas`'s `domain` prop, …), message `type` strings and the files read on disk are the same, so a `DisplaySubjectArea` from 0.2.0 is the `DisplayDomain` of 0.1.x. There are no aliases for the old names. Rename the imports:

| 0.1.x | 0.2.0 |
|---|---|
| `buildUnifiedDomain` | `buildUnifiedSubjectArea` |
| `BuildUnifiedDomainContext` | `BuildUnifiedSubjectAreaContext` |
| `classifyModelLoadError` | `classifyTableLoadError` |
| `computeNewModelPositions` | `computeNewTablePositions` |
| `describeModelLoadError` | `describeTableLoadError` |
| `describeUnsupportedDomainFormat` | `describeUnsupportedSubjectAreaFormat` |
| `DesignModel` | `DesignTable` |
| `detectDomainFormat` | `detectSubjectAreaFormat` |
| `DisplayDomain` | `DisplaySubjectArea` |
| `DisplayDomainEditorPayload` | `DisplaySubjectAreaEditorPayload` |
| `DisplayModel` | `DisplayTable` |
| `DomainFileError` | `SubjectAreaFileError` |
| `DomainFileErrorReason` | `SubjectAreaFileErrorReason` |
| `DomainFormat` | `SubjectAreaFormat` |
| `DomainSummary` | `SubjectAreaSummary` |
| `DomainValidationError` | `SubjectAreaValidationError` |
| `ExistingModelPreview` | `ExistingTablePreview` |
| `getRawDomainModelNames` | `getRawSubjectAreaTableNames` |
| `isDomainV5` | `isSubjectAreaV5` |
| `isSafeModelName` | `isSafeTableName` |
| `isValidModelAlias` | `isValidTableAlias` |
| `KeyedModel` | `KeyedTable` |
| `loadDisplayDomain` | `loadDisplaySubjectArea` |
| `LoadDisplayDomainOptions` | `LoadDisplaySubjectAreaOptions` |
| `MODEL_ALIAS_MAX_LENGTH` | `TABLE_ALIAS_MAX_LENGTH` |
| `MODEL_ALIAS_RULE` | `TABLE_ALIAS_RULE` |
| `ModelDiscrepancy` | `TableDiscrepancy` |
| `ModelLoadError` | `TableLoadError` |
| `ModelLoadErrorKind` | `TableLoadErrorKind` |
| `modelLoadErrorOf` | `tableLoadErrorOf` |
| `ModelLoadWarning` | `TableLoadWarning` |
| `modelLoadWarningOf` | `tableLoadWarningOf` |
| `ModelRelationship` | `TableRelationship` |
| `ModelRole` | `TableRole` |
| `ModelTemplate` | `TableTemplate` |
| `ModelWithLoadWarning` | `TableWithLoadWarning` |
| `NON_DOMAIN_DIRS` | `NON_SUBJECT_AREA_DIRS` |
| `parseDomainJson` | `parseSubjectAreaJson` |
| `ParseLogicalModelOptions` | `ParseTableOptions` |
| `parseLogicalModelText` | `parseTableText` |
| `RawDomainFile` | `RawSubjectAreaFile` |
| `resolveDomainLayer` | `resolveSubjectAreaLayer` |
| `SemanticDomain` | `SemanticSubjectArea` |
| `SemanticModel` | `SemanticTable` |
| `toDisplayDomain` | `toDisplaySubjectArea` |
| `ToDisplayDomainOptions` | `ToDisplaySubjectAreaOptions` |
| `TooManyModelsError` | `TooManyTablesError` |
| `UnifiedDomain` | `UnifiedSubjectArea` |
| `UnifiedDomainV5` | `UnifiedSubjectAreaV5` |
| `UnreadableModelPlaceholder` | `UnreadableTablePlaceholder` |
| `validateDomainDocument` | `validateSubjectAreaDocument` |
