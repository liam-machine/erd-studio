# Changelog

All notable changes to `@erd-studio/core`. While `0.x`, a breaking change bumps the minor version.

## 0.4.0

> **For hosts that render committed projects.** To draw a project stored as DBML (ERD Studio 2.0's default), a host needs this version and `dbml: dbmlStorageReader` (from `@erd-studio/core/dbml`) passed to `loadDisplaySubjectArea`, its bundler must include `@dbml/parse`, and its cache key needs a bump. A host on core 0.3.0 or older given a `.dbml` diagram path throws `SubjectAreaFileError('invalid-json')` with `transient: true`.

### Added
- **Native DBML storage: the `@erd-studio/core/dbml` subpath.** The readers and writers of ERD Studio 2.0's `.dbml` table, relationships and diagram files: `parseTableDbml`, `readRelationshipsDbml`, `parseSubjectAreaDbml`, `subjectAreaMembersDbml`, `compileDbmlProject` (a multi-file compile, as other DBML tools read the project), `outlineDbmlFile` (a file's `use` lines, Enums, `Metadata` block targets and the Tables it declares), `renderNewTableDbml` / `editTableDbml`, `editRelationshipsDbml` (with `relationshipUnits`, `refUnitSortKey`, `usePathBetween` and `DBML_CONVERT_FIRST_MESSAGE`), `renderNewSubjectAreaDbml` / `editSubjectAreaDbml`, `applyTextEdits` / `TextEdit`, `DbmlEditRefused`, and `dbmlStorageReader`, the value to pass as `loadDisplaySubjectArea`'s `dbml` option. The writers splice at parser node offsets: a no-op edit returns the text byte for byte, comments and settings ERD Studio does not model survive, and a file that does not parse is refused, never regenerated. Every export is typed with this package's own types. The main entry stays parser-free, so a bundle that never imports the subpath never pays for the parser.
- `loadDisplaySubjectArea` gains the options `dbml` (a `DbmlStorageReader`; without it a `.dbml` diagram rejects with a `SubjectAreaValidationError` saying to pass it) and `maxRelationshipsChars` (a relationships file longer than this is not read, with a warning). With `dbml`, a JSON diagram also finds tables stored as `.dbml` and draws their relationships.
- `detectProjectStorage(evidence)` → `'yaml' | 'dbml' | 'mixed'` (a project with no evidence, a new one, is `'dbml'`; only library evidence decides), `writesDbml(storage)` and the types `ProjectStorage` / `ProjectStorageEvidence`.
- `classifySemanticFile(relPath, options)` → `'diagram' | 'table' | 'relationships' | 'layout' | 'layers' | 'template' | 'other'`, the one answer to "what is this file under `.erd-studio`?", and the path helpers `subjectAreaStorageOf`, `relationshipsFilePathOf`, `layoutFilePathOf`, `diagramPathOfLayout`, `tableFileCandidates`, `isLibraryFolderName`, `isReservedTableName`, `normalisePosix`, `joinPosix`, `dirnamePosix`, `resolvePosix`, `relativePosix`, `isInsidePosix` and `TEMPLATES_DIR`.
- `editDiagramLayout` (write a `.dbdiagram`'s table positions and sticky-note layouts, keeping every other key; `null` for a no-op; `DbdiagramLayoutRefused` for a file that is not a JSON object). An existing file is edited as text: only the entries that changed are rewritten, each in its own style (one line or indented), and every other byte is kept, so moving one table changes only that table's lines in any mix of styles. Entries keep their order, key order, unknown keys, schema name and unrounded coordinates; `stickyLayoutsOf` and `placeUnlaidNotes` (places sticky notes a layout file has no entry for, deterministically, without writing).
- `CURRENT_JSON_SCHEMA_VERSION` (6, the newest JSON diagram version read, with the same refusal text as before) and `DBML_SCHEMA_VERSION` (7, written as `erd_schema_version: '7'` on a DBML diagram's `Project`).
- `nextCompositeKey` (moved from the extension) and `normaliseCompositeKey`, `compositeGroupProblem`, `COMPOSITE_KEY_MAX_LENGTH`, `MAX_COMPOSITE_PAIRS`.
- `normaliseForStorageEquivalence(display, options?)` and `storageNoteText`: the one comparator that says whether a DBML and a YAML/JSON reading of the same model draw the same thing (the documented normalisations only).
- `ERD_STUDIO_DBML_HEADER_PREFIX`, `DBML_DIAGRAM_PROPERTIES`, `DBML_RELATIONSHIPS_FILE_NAME` / `_STEM` / `_HEADER`, `DBML_STORAGE_PLACEHOLDER_NOTE`, `rationaleKeyOf` and `bareDbmlProperty` in `dbmlRichProperties`; the shared DBML text helpers `dbmlString`, `dbmlNoteText`, `dbmlName`, `dbmlColumnType` and `DBML_KEYWORDS`.
- `attachRelationships`, `dbmlTableLookup`, `relationshipsFileFolder` and `reverseBareOneToOne` (parser-free: attach Refs read from relationships files to their foreign-key tables).
- `findConflictMarkers(text)`: the lines of git conflict markers in any text file.
- DBML table load errors: `TableDbmlError`, `classifyDbmlTableError`, `dbmlErrorClassOf`, `DbmlTableStructureRule`, `DBML_QUOTE_HINT` and its code sets `DBML_TABLE_QUOTE_HINT_CODES` / `DBML_DIAGRAM_QUOTE_HINT_CODES` (11.0.0 numbering), the `DbmlMetadataTarget` type, and `libraryCopyRank`.
- `SubjectAreaSummary` gains the optional `storage` (`'json' | 'dbml'`) and `conflict` fields.
- `subjectAreaViewConfig(doc, warn?)`: a validated domain document's view config as the loader reads it (the top-level `viewConfig`, else the stage-level `logical.viewConfig` older files hold), with malformed positions and sticky notes dropped.
- **Rich DBML export and its dbdiagram layout file.** `toDbmlRich(area, { layoutFileName? })`, and the new `'dbml-rich'` format of `exportDiagram` / `DIAGRAM_EXPORT_FORMATS` (saved as `.dbml`), write ERD Studio's fields as DBML custom properties (`role`, `grain`, `alias`, `schema` for the schema `public` (which DBML reads as no schema), `rationale_*`, `natural_key`, `scd_type`, `additive_type`, `foreign_key`, `meta_*` / `meta_json`), Refs from the foreign-key end (a one-to-one from its key end, since DBML and its SQL export read a one-to-one's second end as the foreign key) with `?` on every end that may be null, the layer as a `TableGroup` and sticky notes as `Note` blocks, behind the header `DBML_RICH_EXPORT_HEADER`. They need a DBML 9.1+ parser; the output is pinned by `<fixture>.rich.dbml` goldens read by `@dbml/parse` 9.1.1, 10.3.1 and 11.0.0. `toDbdiagramLayout` / `serializeDbdiagramLayout` write the positions as dbdiagram's `<name>.dbdiagram` (`dbdiagramLayoutFileName`), which `dbdiagram push` reads, and `readDbdiagramLayout` reads one back without ever throwing. The property names are `dbmlRichProperties.ts`'s constants, shared with ERD Studio's DBML import, plus `stickyColourOfHex`. `toDbml` and `toMermaid` are unchanged.
- **Where a domain file's JSON goes wrong** ([#186](https://github.com/liam-machine/erd-studio/issues/186)). A plain `'invalid-json'` `SubjectAreaFileError` (not a merge conflict) now carries optional `line` and `column` (1-based) and `syntaxProblem` (`'trailing-comma' | 'missing-comma' | 'truncated' | 'unexpected'`) when the mistake can be located, pointing where a person would put the fix (the trailing comma itself, the end of the value a comma is missing after) rather than where the parser stopped. `locateJsonSyntaxError(raw, parserMessage)` is the pure helper behind it; it works out the position from the text itself, so it is the same in every engine. `line` used to be set only for a merge conflict, so read it together with `mergeConflict`. `message` is unchanged.

### Changed (breaking)
- `@dbml/parse` **11.0.0** (exact) is a runtime dependency, loaded only by the `@erd-studio/core/dbml` subpath. A bundler that follows that subpath must include it.
- `CURRENT_SCHEMA_VERSION` is 7, the newest version read in any format. A JSON diagram declaring 7 or more is still refused (`CURRENT_JSON_SCHEMA_VERSION`); a DBML diagram's `erd_schema_version` above 7 is refused with the same "Please update the extension" text.
- `TableLoadErrorKind` gains `'dbmlSyntax'`, `'dbmlInvalid'` and `'dbmlStructure'`, so an exhaustive `Record` or `switch` over it needs cases. `TableLoadError` gains the optional `code` (the DBML parser's error code) and `target`.
- `SubjectAreaFileErrorReason` gains `'invalid-dbml'` (a DBML diagram that does not parse: transient, with `line` and `column`; not transient, with `mergeConflict: true`, for git conflict markers).
- The loader's warning for a table it cannot find now reads `Model "<name>" not found in the table library` (was `… not found in logical-models/`).
- `describeTableLoadError` says `table file could not be read` for a `read` failure (was `logical-models file could not be read`): the `read` kind carries no format, and a `.dbml` table file can fail it too. The YAML and DBML wordings are unchanged.
- Cores 0.3.0 and older cannot read DBML projects (see the note at the top of this section).
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
