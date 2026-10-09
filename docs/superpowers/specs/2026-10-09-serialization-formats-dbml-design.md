# Storage formats, DBML and an import/export layer — Design

**Date:** 2026-10-09
**Prompted by:** a question from @gbrueckl: is the model YAML a standard, could it be DBML, and could an abstraction layer offer several serializations (JSON, YAML, DBML, xDBML, …) chosen by setting or file extension?
**Status:** Implemented (export) — Mermaid and DBML exporters in `@erd-studio/core`, the `erd-studio export` CLI subcommand and the **Export Diagram…** command (2026-10-09, see [What shipped](#what-shipped)). Storage decisions 1–4 stand. The `data_type` read alias, conflict-marker detection, DBML import guidance and the schema `$id` work are still open.

## What shipped

Liam decided after the council that **Mermaid and DBML ship together in v1**, and that the Confluence app gets export too. That supersedes the council's order (DBML first, Mermaid in a later PR, Confluence deferred) and its "copy command only" surface list. Everything else the council agreed holds: storage is unchanged, there is no mirror file and no converter registry, the export is one way, logical stage only, middle depth, no positions, and `alias` is never DBML `as`. One council choice was reversed before release: the ERD fields were first written as `erd_*` DBML custom properties, but custom properties are only accepted by `@dbml/parse` 9.1 or later (July 2026); every older DBML parser — the `@dbml/core` 2.x / 3.x most DBML tools still embed, and the `dbml` CLI and editors built on it — rejects the whole file as an unknown setting. **For portability the DBML is notes-only:** the same fields travel as readable lines in the table and column notes, which every DBML parser from `@dbml/core` 2.4.2 (June 2022) onwards reads — 2.3 and older reject a schema-qualified table name, and 2.4.0 / 2.4.1 a many-to-many `<>`, so 2.4.2 is the promised floor.

**API** (`packages/core/src/exportDiagram.ts`, re-exported from core's and the renderer's `.` entries): `DiagramExportFormat` (`'mermaid' | 'dbml'`), `DIAGRAM_EXPORT_FORMATS`, `DIAGRAM_EXPORT_FILE_EXTENSIONS` (`mmd`, `dbml`), `toMermaid`, `toDbml`, `exportDiagram` (throws only on an unknown format) and `diagramExportFileName` (a safe file name, `diagram` when nothing is left, Windows reserved names — with or without an extension, `nul.txt` too — suffixed; `txt` for a format that is not one of the two). Both formats share one traversal (`exportShared.ts`), so they skip and order things identically. Core's runtime dependencies are still `yaml` only. The parsers are exact-version devDependencies, each published at least two weeks before it was adopted: `@dbml/parse` 10.2.0 and the old `@dbml/core` 3.13.4, 2.6.1 and 2.4.2 (npm aliases `dbml-core-v3`, `dbml-core-v2` — the two most-downloaded old releases — and `dbml-core-v24`, the floor; it adds no package the others do not already pull in), which must all read every DBML output the same way; Mermaid 10.0.0 (`mermaid`, the oldest 10.x) and 12.0.0 (`mermaid-current`), which must both parse every Mermaid output; and `jsdom` 25.0.1 for Mermaid's DOM. Two accepted costs of those pins: a full `npm audit` (dev dependencies included) reports mermaid's own advisories and those of its dependencies (DOMPurify, lodash-es, chevrotain, …) — test-only, never bundled, invisible to the CI gate `npm audit --omit=dev`, and 10.0.0 is pinned on purpose as the strictest 10.x grammar, so dismiss any such Dependabot alert as a dev-only fixture; and Mermaid 12.0.0 declares `engines.node >= 22.12` while CI runs the tests on Node 20, where it parses correctly (npm only warns) — a later `mermaid-current` that really needs Node 22 means moving CI's test jobs to 22.

**Surfaces**
- `erd-studio export --domain <path> --format mermaid|dbml` prints to stdout (`--json` wraps it as `{ cliVersion, domain, format, fileName, content }`). No `--out`: the CLI stays read-only.
- **ERD Studio: Export Diagram…** in the palette, on a diagram's right-click menu in the sidebar, and behind an Export button in the canvas's top corner (a `⤓` glyph the size of the `⋯` trigger: a third labelled button made the corner fold into `⋯` about 155px of window sooner, hiding the Feedback and View File labels at common laptop widths; the glyph still costs about 70px) (the `exportDiagram` webview message, allowed on the physical stage because it writes nothing and always exports the logical design). It asks for the format, then **Copy to Clipboard**, **Open in Editor** or **Save As…**.
- Both read the domain through `exportDomainFile` (`src/services/diagramExport.ts`): `getDomain` → `buildLogicalDisplayDomain` → `exportDiagram`, with the same key evidence the canvas uses. The CLI's output is byte-identical to the core goldens.
- Telemetry FEATURES `exportMermaid`, `exportDbml`, `exportCancelled` and the error `exportFailed`, appended to the extension's and the Worker's lists.
- **Confluence:** an Export panel (Mermaid | DBML switch, Copy, Download) built in the reader's browser from the `DisplayDomain` already on the page, through the renderer's re-exports. It is on a branch stacked on erd-studio-pro PR #5 and needs the renderer 0.1.3 release (automatic PATCH from this change) before its pin and lockfile can move. No backend change, no new Forge permission, no cache-key bump.

**Mapping (v1)**

| ERD Studio | DBML | Mermaid |
|---|---|---|
| header | `// erd-studio dbml-export v1`, a "Not exported" line, a line saying the ERD fields are in the notes | `erDiagram` first (Mermaid 10.0–10.4 reject any line before it), then `%% erd-studio mermaid-export v1`, a "Not exported" line, a note on name sanitising, a `Diagram:` line |
| domain | `Project <domain> { … }`, or `Project { … }` when it has no name (old parsers reject `Project ""`) | a `%% Diagram:` line |
| layer, stage, description | the Project `Note`: `Layer: …`, `Stage: …`, a blank line, the description | `%%` lines |
| model | `Table [schema.]name` (never `as`) | quoted entity `"name"`; `"`, `%` and `\` written as `'`, `_` and `/` (a `%%` line gives the original), and a model whose entity name an earlier one took is left out with a comment, as are its relationships |
| role, grain, alias | table `Note` lines `Role: …`, `Grain: …`, `Warehouse table (alias): …` | `%%` lines above the entity |
| description, rationale, meta | table `Note`, after a blank line each: the description; `Purpose: …`, `Design: …` lines; `Meta – key: value` lines | `%%` lines |
| primary key | `[pk]`, composite as `indexes { (a, b) [pk] }` | `PK` |
| foreign key | the `Ref`; "foreign key" in the column note only when no exported Ref leaves the column (the to end of a one-to-many, else the from end — however the link is stored) | `FK` |
| column description | `note` | attribute comment (`~` written `∼`, since Mermaid reads `~…~` there as a generic type) |
| natural key, SCD, additivity, column meta | after the description in the column note: `(natural key; SCD type 2; semi-additive; meta unit: EUR)` | `UK`; "SCD type N" and the additive type in the attribute comment; meta as `%%` lines |
| relationship | `Ref` with `>` `<` `-` `<>`, composite `a.(x, y) > b.(u, v)` | `}o--\|\|` `\|\|--o{` `\|\|--\|\|` `}o--o{`, label = role else the FK columns, plus a `%% a.x -> b.y` line |
| relationship role | the Ref's name (`Ref "ship date": …`); a `// Role: …` comment above the Ref when the role holds `"` or `\` | the label |
| sticky note | `// Sticky note <n>: …` comment lines at the end (old parsers have no `Note` blocks) | `%%` lines at the end |
| zero-column or unreadable model | a comment (DBML has no column-less table) | an empty entity with a comment |
| positions, note colours, nested meta | not exported (named in the header) | same |

Rules both follow: model and column order is kept; duplicates (compared without case) and nameless entries are skipped; a composite group goes out once at its first member; a relationship whose model or column is missing, that points a column at itself, that repeats an exported link (either way round) or whose cardinality is unknown is skipped with a comment giving the reason. DBML uses no custom properties and no standalone `Note` blocks. Its strings are single-quoted (`\'` escapes) when they are one line without a backslash, and otherwise triple-quoted with `\'` and `\\` escapes, because the old parsers keep `\n`, `\t` and `\\` inside single quotes as written; white space at either end of a note is dropped, since old and new parsers trim it differently. In a triple-quoted note the old parsers read a run of backslashes as one fewer and drop a backslash before `'` (refusing the file when a note ends in `\'`), and no escape reads alike in both grammars, so a backslash before another backslash or a `'` is followed by a space, with a `//` comment naming the note. The old parsers have no escape inside a double-quoted name, so a name or type holding `"` or `\` is written with `'` and `/` (a comment or the column note gives the original), and a table or column whose written name another already took is left out with a comment, as are the Refs that join it. Mermaid types and names keep only `[A-Za-z0-9_]` (the original goes in the comment), every entity name is quoted (Mermaid 10.0.0 already reads quoted names, and different keywords fail bare in different releases), no comment line is a bare `%%`, which Mermaid 10 and 12 reject, and every `%%` in free text (comment lines, labels, attribute comments) is written `% %`: Mermaid reads `%%{…}%%` anywhere in the text as a directive, so a description could otherwise restyle every reader's diagram, and 10.x refuses a label that starts with `%%`.

**Not in this change:** the `HARNESS_VERSION` bump the council attached to the export (the setup skill's CLI table, the enrich route reading the export, DBML-as-source guidance), the `data_type` read alias, conflict-marker detection, physical-stage export, and the schema `$id` work.

## Questions

1. Should the domain file (`{layer}/{domain}.json`: model names, positions, notes) become YAML, to match the model library?
2. Should the model library (or everything) move to DBML?
3. Should the storage format be pluggable — one data model, several on-disk serializations?
4. Should we keep a generated DBML "mirror" next to the YAML?
5. Should users be able to import and export DBML?

## Recommendation in one line

Keep **one storage format** (YAML models + JSON diagrams, unchanged) and open ERD Studio up through **one-way converters at the edges**: a DBML export first (CLI to stdout and a copy command), Mermaid next, DBML import first as AI-assistant instructions. Alongside, fix two problems the council found in today's format handling: dbt's `data_type` spelling is silently lost, and a git merge conflict in a diagram file gives an unhelpful error. No configurable storage, no generated mirror, no JSON → YAML switch.

## What the formats actually are today

- **Model library** (`logical-models/**/*.yml`): one file per model, *dbt-flavoured* — `name`, `description`, `columns`, `meta`, `alias` mean what they mean in a dbt `schema.yml` — but it is our own schema, not a standard (columns use `dataType`, not dbt's `data_type`; `grain`, `modelRole`, `scdType`, `additiveType`, `isNaturalKey`, `rationale` and `relationships:` are ours). It is written by editing the parsed `yaml` Document in place, so comments, key order and unknown keys survive every canvas edit.
- **Domain file** (`{layer}/{domain}.json`): a *view*. Since v5 and #126 it holds model names, the few relationships not yet in the library, `viewConfig.positions`, sticky notes and `stubColumns`. Almost every byte is written by the canvas, not by a person.
- The format has already moved several times (v4 inline → v5 library, layer folders, relationships into the library). Each move costs us a read path we must keep for as long as the Confluence app ships ("old files must always render").

## What DBML can and cannot hold

DBML (dbml.dbdiagram.io, Holistics, Apache-2.0, `@dbml/core` 10.3.1) now has: tables with schema, notes, `headercolor`; column settings (`pk`, `not null`, `unique`, `default`, `note`, …); `indexes` (incl. composite `pk`); `Ref` with `>` `<` `-` `<>` and composite refs `a.(x,y) > b.(x,y)`; `Enum`; `TableGroup` (note, colour); standalone sticky `Note` blocks; `TablePartial`; `Records`; **free-form custom properties** on tables and columns (`Table users [owner: "data-team"]`); and a **module system** (`use * from './file'`).

What it has **no place for**: diagram positions (dbdiagram keeps layout in its own cloud), and none of ERD Studio's modelling semantics — grain, model role, SCD type, additivity, natural keys, rationale, relationship role. Those would all be custom properties, i.e. an ERD Studio dialect that other DBML tools parse but ignore.

One trap: DBML's `Table x as y` alias is a *short reference name* that must be unique; our `alias` is dbt's warehouse table name and is deliberately *not* unique (`silver_date` and `gold_date` are both `alias: date`). They must not be mapped onto each other.

xDBML (Hackolade, v0.3 draft) is a strict superset of DBML adding nested types, views, graph edges, `granularity`/`business_term`/`x_*` metadata and modules. Its own FAQ says it is **not** a round-trip format. Anything we export as DBML is already valid xDBML; nothing more is worth doing until it reaches 1.0.

## Decisions

### 1. Domain file JSON → YAML: no

- **Benefit is small.** Comments and visual consistency, in a file people rarely hand-write. Canvas/view files are JSON almost everywhere (Excalidraw, JSON Canvas, draw.io's JSON), and AI assistants write JSON as reliably as YAML.
- **Cost is large and permanent.** The custom editor binds to `**/.erd-studio/*/*.json` (and the legacy location); `detectDomainFormat()`, the watchers, the tree, the CLI, the MCP server, `SCHEMA_CONTENT` + a `HARNESS_VERSION` bump, a migration command, and a second read path in `@erd-studio/core` that the Confluence app must keep for ever.
- **Team split.** A teammate on an older version would not see `.yml` diagrams at all — the same problem layer folders had, which is why those are opt-in.
- Revisit only if the domain file starts carrying hand-authored content again.

### 2. Move to DBML: no

- The library's audience is dbt users and their AI assistants; its vocabulary is dbt's. DBML would only hold our data through custom properties, so it would be "ERD Studio DBML" — no more portable than the YAML, and less familiar to a dbt team.
- Positions still need a sidecar, so the domain file would remain anyway.
- We would lose in-place, comment-preserving writes: `@dbml/core`'s exporter regenerates whole files; we would have to write a CST-preserving DBML writer.
- `@dbml/core` is ~37 MB unpacked (it carries SQL importers); `@dbml/parse` alone is ~1.6 MB. Neither belongs in `@erd-studio/core`, which the Confluence backend runs.

### 3. Pluggable storage format: no — the abstraction already exists, in memory

@gbrueckl is right that serialization should sit behind an abstraction: it already does (`UnifiedDomain` / `SemanticModel` / `DisplayDomain` in `@erd-studio/core`). The question is only whether *storage* should vary per project. It should not:

- **Only lossless formats can be storage.** DBML and xDBML are lossy for us (no positions, no modelling semantics without a dialect).
- **Every reader reads every format, for ever.** The Confluence app, the CLI, the MCP server, the setup skill and every assistant's harness text would have to support each one — the backward-compatibility rule makes that permanent.
- **Writes are per format.** Our edit pipeline (one `WorkspaceEdit`, one undo step, comment-preserving yml edits, the relationship state-space checker) would multiply by the number of formats.
- **Mixed repos.** Choosing by setting or extension lets one team hold two formats at once, with reviewers reading diffs in both.

The pattern that does work — and is what dbt and dbdiagram themselves do — is **one canonical store, many converters at the edges**.

### 4. Generated DBML mirror: no

A mirror written on every edit means two sources of truth (someone will edit the copy), merge conflicts in a generated file, extra noise in every commit, and a write nobody asked for (against our "no unprompted writes" rule). Teams that want a `.dbml` in the repo or in CI can run `erd-studio export … > schema.dbml` themselves (below) — on their terms, at their cadence.


## Council outcome

Five seats debated the draft over two rounds: open standards, backward compatibility / Confluence, a dbt practitioner on a team, maintainer cost, and AI-assistant workflow. Every seat agreed with decisions 1–4 above. The rest of this section is what they settled for export and import, plus two issues they found.

### Agreed by all five

1. **`toDbml(domain: DisplayDomain): string` in `@erd-studio/core`**
   - Plain function, no converter registry. A registry is public API we would keep for ever, and two functions do not need one.
   - **Logical stage only** in v1. Ghost models and provenance need their own design, and dbt's own tooling already covers what dbt has.
   - **Middle depth.** Every ERD semantic field goes out as an `erd_`-prefixed custom property (`erd_grain`, `erd_role`, `erd_scd`, `erd_additive`, `erd_natural_key`, `erd_alias`), along with rationale and relationship role. *(Superseded before release: custom properties need `@dbml/parse` 9.1 or later, so for portability the same fields go into the notes — see [What shipped](#what-shipped).)* `meta` goes out only where its values are plain text.
   - **No positions.** Layout in DBML would make the export a second storage format, and other tools ignore it anyway. A minimal export was also rejected: an AI reading an export with no grain or role fills the gaps in itself.
   - `alias` is never DBML `as`, whose names must be unique while ours deliberately are not.
   - **Output is a contract.** Ordering is deterministic, and every export starts with a version line (`// erd-studio dbml-export v1`) followed by comments listing what was dropped. Goldens cover all nine core fixtures, including `v4-inline`, and `@dbml/parse` (a devDependency only) parses each one. A mapping change is a deliberate golden update plus a CHANGELOG line.
   - **Tolerant input.** A test feeds a `DisplayDomain` carrying only its required fields, as an older core in the Confluence cache would produce, plus ghost models and models with a `loadError`. Another test asserts that core's runtime dependencies are still `yaml` only.
   - Additive API, so the release is an automatic package PATCH.
2. **Surfaces in v1**
   - `erd-studio export --domain <path> --format dbml`, printing to stdout. It never gets `--out`, so the CLI stays read-only. Add it to the CLAUDE.md subcommand list.
   - One palette command, **Copy Diagram as DBML**, which puts the export on the clipboard. Add it to `NO_LEGACY_ALIAS`, and add one telemetry FEATURE key to the Worker's list and redeploy the Worker first.
   - No Save As, tree or overflow-menu entries yet.
3. **Deferred**
   - Mermaid `erDiagram` is the next PR, built on the same traversal. Nothing can parse Mermaid output in a test, so it does not ship in v1.
   - The code importer waits until someone asks for it.
   - Physical-stage export.
   - Confluence "Download DBML", until a core release carries `toDbml` and the app moves its pin to that version.
   - xDBML, until it reaches 1.0; ODCS.
4. **Read dbt's `data_type` as an alias of `dataType`** (separate small PR)
   - Today `parseLogicalModelText` silently turns `data_type:` into `unknown`. People and assistants both copy columns straight out of `schema.yml`, so this bites in practice.
   - Accept it on read only. Writes normalise the key to `dataType`, and `doctor` warns when it finds `data_type`.
   - The assistant instructions keep saying "write `dataType`". If they advertised `data_type`, assistants would write it and every pinned Confluence core would render `unknown`.
   - Add a fixture and a golden. For files that already use `data_type`, the rendering changes deliberately, from `unknown` to the real type.
5. **Detect git conflict markers in diagram files**
   - This is its own issue, not part of the format work.
   - `parseDomainJson` recognises `<<<<<<<` / `>>>>>>>` and reports a clear, specific error in place of a JSON parse failure, and `doctor` reports it as well.
   - No merge UI. At most, a later "re-arrange the conflicted layout" offer.
   - A new `DomainFileError` kind is part of core's public API, so the Confluence side should be told.

### Majority view

- **DBML import as assistant instructions now (3–2).** In the bundled `HARNESS_VERSION` bump below, `SCHEMA_CONTENT`'s "Building models from external sources" gains DBML / dbdiagram, with its mapping table: `Ref >` is stored in the FK model's file, `as` is not `alias`, and names that fail the naming patterns are refused. The setup skill gets a "from DBML" entry. Whatever the assistant writes must use today's shapes (v5, names-only domain, `.yml` models, one entry per composite pair) and must pass `erd-studio diff`. The objection was that a harness bump makes every user see an "outdated" prompt. It weakens because the export command's row in the skill's CLI table needs the same bump anyway, so the two ship together.
- **No `--format json` in v1 (3–2).** Its output would freeze the `DisplayDomain` shape, including internal fields like `dbtKey`, as a second public contract. If it ships later, call it `json-unstable`.

### Liam to decide

- **Schemas** (`schemas/*.json`): there is agreement on a stable, versioned `$id`, with SchemaStore submission later. The council split 2–3 on relaxing the root `additionalProperties: false`.
  - **For relaxing:** strict roots contradict the "unknown keys are ignored" reader rule, so an older extension underlines a newer file's keys as errors.
  - **Against:** strict roots catch typos in the editor, including an AI's, and the reader ignores unknown keys regardless.
  - Either way it is its own PR.

### Suggested order

1. `data_type` read alias — the smallest change, and it fixes a real silent bug.
2. `toDbml`, the CLI `export` and the copy command, with one `HARNESS_VERSION` bump in the same release. The bump covers the CLI-table row, the enrich route reading the export instead of every model file, and the DBML-as-source guidance.
3. Conflict-marker detection.
4. `toMermaid`.
5. Schema `$id` and SchemaStore, plus the `additionalProperties` decision.
