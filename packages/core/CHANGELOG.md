# Changelog

All notable changes to `@erd-studio/core`. While `0.x`, a breaking change bumps the minor version.

## 0.4.0

> **For hosts that render committed projects.** To draw a project stored as DBML (ERD Studio 2.0's default), a host needs this version and `dbml: dbmlStorageReader` (from `@erd-studio/core/dbml`) passed to `loadDisplaySubjectArea`, its bundler must include `@dbml/parse`, and its cache key needs a bump. A host on core 0.3.0 or older given a `.dbml` diagram path throws `SubjectAreaFileError('invalid-json')` with `transient: true`.

### Added
- **Native DBML storage: the `@erd-studio/core/dbml` subpath.** The readers and writers of ERD Studio 2.0's `.dbml` table, relationships and diagram files, in its layer-first tree: `<layer>/tables/<schema>/<name>.dbml` (one `Table <schema>.<name>`), `<layer>/relationships/<file>.dbml` (Refs and the `use` lines they need) and `<layer>/diagrams/<name>.dbml` (table `use` lines, `use *` of the relationships files it imports, sticky `Note`s, then the `Project` with the positions in `erd_layout`). `parseTableDbml(text, stem, { schemaFolder }, parser?)` (the schema is the qualifier, else the folder; warnings `unqualifiedTable`, `schemaFolderMismatch`, `schemaProperty`), `readRelationshipsDbml` (with the optional `uses` and `otherElements`), `parseSubjectAreaDbml(text, filePath)` (refuses a path that is not `<layer>/diagrams/<n>.dbml`; the reading has `relationshipsUses`, `otherUses`, `useTableDirs`, `layoutProblems` and `layoutConflictLine`), `subjectAreaMembersDbml(text, filePath)`, `diagramSummaryDbml` (members, imports and unlinked names from a syntax-only parse) and `diagramUseRole` (what a diagram's `use` line points at), `readErdLayoutDbml` / `erdLayoutEntrySpan` / `editDiagramLayoutDbml` (a diagram's positions), `compileDbmlProject` (a multi-file compile, as other DBML tools read the project), `outlineDbmlFile` (a file's `use` lines, Enums, `Metadata` block targets and the Tables it declares), `renderNewTableDbml` (needs a schema) / `editTableDbml` (with `requalify` to move a table to another schema), `editRelationshipsDbml` (with `relationshipUnits`, `relationshipUnitsWithMembers`, `refUnitSortKey`, `usePathBetween`, `DBML_CONVERT_FIRST_MESSAGE`, and the edit fields `requalified` and `columnChanges`, which rewrites a Ref in place), `renderNewSubjectAreaDbml` (the `Project` last, with `positions`) / `editSubjectAreaDbml` (`relationshipsImportsFor(memberNames, current, unlinked)` decides the imports; `keepLayoutIfConflicted`), `applyTextEdits` / `TextEdit`, `DbmlEditRefused`, and `dbmlStorageReader`, the value to pass as `loadDisplaySubjectArea`'s `dbml` option. The writers splice at parser node offsets: a no-op edit returns the text byte for byte, comments and settings ERD Studio does not model survive, and a file that does not parse is refused, never regenerated. Every export is typed with this package's own types. The main entry stays parser-free, so a bundle that never imports the subpath never pays for the parser.
- **`formatDbml(text, options?)`** (from `@erd-studio/core/dbml`, with the types `DbmlFormatOptions`, `DbmlFormatResult` and `DbmlFormatSkipReason`): ERD Studio's one canonical `.dbml` layout. It changes white space only (two-space indents, aligned column names, types and settings, a long column or index settings list one per line, `use … from` lines aligned, at most one blank line) and checks its own output: the token sequence, every comment's text and the syntax tree must be unchanged, or the text comes back as it was with `skipped: 'self-check'`; a file with a syntax error comes back unchanged with `skipped: 'parse-errors'` and its `errors`. String literals (a triple-quoted note's inner indentation included), quote styles and block comments are never touched. The extension runs it after every DBML write and behind Format Document; the writers themselves still splice, so a no-op edit stays byte-identical. The writers' new-content layout follows it: `renderNewTableDbml` writes the body `Note` first with a blank line after it, and a column's settings as `pk`, ERD Studio's properties, meta, then `note` last; `editTableDbml` puts a setting it adds at its place in that order (after the last setting that sorts at or before it, so a `note` that was last stays last) and a new description first in the body; `editRelationshipsDbml` writes a blank line between the Refs of different foreign-key tables in any file it changes.
- `loadDisplaySubjectArea` gains the options `dbml` (a `DbmlStorageReader`; without it a `.dbml` diagram rejects with a `SubjectAreaValidationError` saying to pass it) and `maxRelationshipsChars` (a relationships file longer than this is not read, with a warning). A DBML diagram's members are read by their `use` paths (then the diagram's `useTableDirs`, then YAML), and only the relationships files it imports are read, so it draws what other DBML tools draw. A `.dbml` outside `<layer>/diagrams/` is refused before anything is read (`dbmlNotADiagramMessage`; for an ERD Studio 1.9 pre-release path, `legacyDbmlFileMessage`, saying to convert the project again). A JSON diagram reads no DBML tables.
- `detectProjectStorage(evidence)` → `'yaml' | 'dbml' | 'mixed'` (a project with no evidence, a new one, is `'dbml'`; only library evidence decides), `writesDbml(storage)` and the types `ProjectStorage` / `ProjectStorageEvidence`.
- `classifySemanticFile(relPath, options)` → `'diagram' | 'table' | 'relationships' | 'readme' | 'layers' | 'template' | 'other'`, the one answer to "what is this file under `.erd-studio`?", by path alone (`SemanticFileClass` carries `layer`, `schema` and, for a 1.9 pre-release path, `legacy`), and the path helpers `subjectAreaStorageOf`, `DIAGRAMS_DIR`, `RELATIONSHIPS_DIR`, `dbmlTablePath`, `relationshipsFilePath`, `diagramFilePath`, `diagramPathOf`, `dbmlTreePathOf`, `isDbmlLayerName`, `RESERVED_LAYER_NAMES` / `isReservedLayerName` (`tables`, `templates`, `logical-models`), `legacyDbmlShapeOf`, `legacyDbmlFileMessage`, `dbmlNotADiagramMessage`, `SEMANTIC_README_NAME`, `tableFileCandidates`, `isLibraryFolderName`, `normalisePosix`, `joinPosix`, `dirnamePosix`, `resolvePosix`, `relativePosix`, `isInsidePosix` and `TEMPLATES_DIR`.
- **The `erd_layout` codec** (`erdLayout.ts`, parser-free): a diagram's table and sticky-note positions as one triple-quoted string in its `Project` (`<name> <x> <y>` lines sorted by name, then `note/<id> <x> <y> [<w> <h>]` (`ERD_LAYOUT_NOTE_PREFIX`), numbers to two decimals). `readErdLayout` (tolerant: bad lines, a repeated key and git conflict markers are reported, never thrown), `renderErdLayoutValue`, `erdLayoutOf`, `sameErdLayout`, `roundLayoutNumber`, `isErdLayoutName`, `withMemberSpelling`, `erdLayoutView` (the member mapping, exact then case-insensitive) and `placeUnlaidStickies` (places sticky notes with no line, deterministically, without writing); `DBML_DIAGRAM_PROPERTIES.layout`.
- `CURRENT_JSON_SCHEMA_VERSION` (6, the newest JSON diagram version read, with the same refusal text as before) and `DBML_SCHEMA_VERSION` (7, written as `erd_schema_version: '7'` on a DBML diagram's `Project`).
- `nextCompositeKey` (moved from the extension) and `normaliseCompositeKey`, `compositeGroupProblem`, `COMPOSITE_KEY_MAX_LENGTH`, `MAX_COMPOSITE_PAIRS`.
- `normaliseForStorageEquivalence(display, options?)` and `storageNoteText`: the one comparator that says whether a DBML and a YAML/JSON reading of the same model draw the same thing (the documented normalisations only).
- `ERD_STUDIO_DBML_HEADER_PREFIX`, `DBML_DIAGRAM_PROPERTIES`, `DBML_RELATIONSHIPS_FILE_HEADER`, `DBML_STORAGE_PLACEHOLDER_NOTE`, `rationaleKeyOf` and `bareDbmlProperty` in `dbmlRichProperties`; the shared DBML text helpers `dbmlString`, `dbmlNoteText`, `dbmlName`, `dbmlColumnType` and `DBML_KEYWORDS`.
- `attachRelationships`, `dbmlTableLookup` and `reverseBareOneToOne` (parser-free: attach Refs read from any relationships file to their foreign-key tables, files in path order; `locations` says which file and line holds each link). `DbmlStoredRef` carries `ownerQualifier` / `targetQualifier`; `DbmlUseOutline.specifiers` (from `outlineDbmlFile`) gives each `use` line's specifiers.
- `StorageEquivalenceOptions.schemaFallback` (the schema Convert gives a table that had none, for comparisons across a conversion).
- **Diagram members with no table file and pending relationships** (ERD Studio's Convert Project to DBML writes them; a host reading committed projects must read them to draw what the extension draws). A diagram's Project key `erd_unlinked_tables` (`DBML_DIAGRAM_PROPERTIES.unlinkedTables`; one quoted, comma-separated string, read with `parseUnlinkedTables` and written with `formatUnlinkedTables`) lists members that have no `.dbml` file to `use`: `parseSubjectAreaDbml` appends them to `members` (and the new optional `unlinked`) after the `use` members, `subjectAreaMembersDbml` lists them too, and `loadDisplaySubjectArea` resolves them by name like any member (no file: a placeholder, exactly as a JSON diagram's missing member). A whole-line comment `// erd-studio pending: Ref …` (`DBML_PENDING_REF_PREFIX`, `DBML_PENDING_REF_PATTERN`, `pendingRefLine`) is a pending relationship: in a relationships file `readRelationshipsDbml` returns it in the new optional `pending` (each `DbmlStoredRef` with `pending: true`) and `attachRelationships` attaches it like a Ref; in a diagram it is one of the diagram's own relationships (`logical.relationships`, and the new optional `DbmlSubjectAreaReading.pending`). `renderNewSubjectAreaDbml` takes optional `unlinked` and `pendingRefs`; `editSubjectAreaDbml` keeps the key in sync (never empty) and keeps or cuts the pending lines; `editRelationshipsDbml` keeps, cuts or turns live a pending line, and with the new optional `writePending` writes a new unit that cannot be live as one. Other DBML tools see a Project key they ignore and comments: these members and relationships are simply absent for them. All additive: every field is optional, and a core older than this one ignores both (an unlinked member is not drawn, a pending relationship is not drawn).
  - `erd_unlinked_tables` is read from the Project's AST by both readers (`parseSubjectAreaDbml` and `subjectAreaMembersDbml` agree): single-, triple- or double-quoted, the last entry when the key repeats (with a warning). A `// erd-studio pending:` line inside a `/* … */` block comment is not read. `editRelationshipsDbml` re-spells a pending line whose table or column this edit renames, and takes the new optional `pendingBefore` (units pending anywhere before the edit, which stay pending when written into this file); `editSubjectAreaDbml` re-spells a diagram's own pending line when an edit renames its ends or columns (same cardinality and role), and keeps a renamed unlinked member unlinked. New: `pendingRelationshipRef(members, referenceOf?)`, a pending relationship's Ref text.
- `findConflictMarkers(text)`: the lines of git conflict markers in any text file.
- `ExistingTablePreview` gains the optional `detailsPending` (a Table Library row whose file was not read yet: empty `schema` and `description`, `columnCount` 0). Absent on every row an older host sends.
- DBML table load errors: `TableDbmlError`, `classifyDbmlTableError`, `dbmlErrorClassOf`, `DbmlTableStructureRule`, `DBML_QUOTE_HINT` and its code sets `DBML_TABLE_QUOTE_HINT_CODES` / `DBML_DIAGRAM_QUOTE_HINT_CODES` (11.0.0 numbering), the `DbmlMetadataTarget` type, and `libraryCopyRank`.
- `SubjectAreaSummary` gains the optional `storage` (`'json' | 'dbml'`) and `conflict` fields.
- `subjectAreaViewConfig(doc, warn?)`: a validated domain document's view config as the loader reads it (the top-level `viewConfig`, else the stage-level `logical.viewConfig` older files hold), with malformed positions and sticky notes dropped.
- **Rich DBML export.** `toDbmlRich(area)`, and the new `'dbml-rich'` format of `exportDiagram` / `DIAGRAM_EXPORT_FORMATS` (saved as `.dbml`), write ERD Studio's fields as DBML custom properties (`role`, `grain`, `alias`, `schema` for the schema `public` (which DBML reads as no schema), `rationale_*`, `natural_key`, `scd_type`, `additive_type`, `foreign_key`, `meta_*` / `meta_json`), Refs from the foreign-key end (a one-to-one from its key end, since DBML and its SQL export read a one-to-one's second end as the foreign key) with `?` on every end that may be null, the layer as a `TableGroup`, sticky notes as `Note` blocks and the table and sticky-note positions in the `Project`'s `erd_layout`, behind the header `DBML_RICH_EXPORT_HEADER`. They need a DBML 9.1+ parser; the output is pinned by `<fixture>.rich.dbml` goldens read by `@dbml/parse` 9.1.1, 10.3.1 and 11.0.0. (The 1.9 pre-releases of the extension also wrote a dbdiagram `.dbdiagram` layout file; that API was never published and is gone.) The property names are `dbmlRichProperties.ts`'s constants, shared with ERD Studio's DBML import, plus `stickyColourOfHex`. `toDbml` and `toMermaid` are unchanged.
- **Where a domain file's JSON goes wrong** ([#186](https://github.com/liam-machine/erd-studio/issues/186)). A plain `'invalid-json'` `SubjectAreaFileError` (not a merge conflict) now carries optional `line` and `column` (1-based) and `syntaxProblem` (`'trailing-comma' | 'missing-comma' | 'truncated' | 'unexpected'`) when the mistake can be located, pointing where a person would put the fix (the trailing comma itself, the end of the value a comma is missing after) rather than where the parser stopped. `locateJsonSyntaxError(raw, parserMessage)` is the pure helper behind it; it works out the position from the text itself, so it is the same in every engine. `line` used to be set only for a merge conflict, so read it together with `mergeConflict`. `message` is unchanged.

### Changed
- `@erd-studio/core/dbml` keeps diagram compiles in their own small cache, so reading a diagram's tables no longer pushes the diagram out before an edit reads it again. What is read is unchanged.

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
- The DBML readers, writers and `compileDbmlProject` are about a third faster: while a compile runs, each of the parser's file paths computes its cache key once instead of on every query. The results are unchanged, and the parser is left as it was afterwards.
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
