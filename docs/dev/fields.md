# Context fields

> Read before touching the field catalogue or the field list (`packages/core/src/fields.ts`, `packages/core/src/fieldsFile.ts`), `.erd-studio/fields.yml` and its reader (`src/services/fieldsService.ts`), how a field is spelled in a `.dbml` or `.yml` table, the Detail panel's Fields section, `doctor`'s `erd.fields`, or the skill's **Fields** section. The on-disk format is in `docs/semantic-domain-json-reference.md` (Field list); the storage decision is D34 in `docs/plans/native-dbml-storage.md`; what an old file must still render is in `docs/dev/compatibility.md`.

A **field** is one thing a team writes down about a table or a column: its grain, its purpose, the decisions behind it, an owner, a sensitivity level, whether a column holds personal data. ERD Studio ships a **catalogue** of built-in fields; a project picks from it, and adds its own, in one optional file, `.erd-studio/fields.yml`; each table file holds only the values. The canvas shows a table's fields in the list's order, the AI skill tells assistants to fill exactly those fields, and `doctor` checks the list and the values.

In a `.dbml` table every field, built-in or the team's own, on the `Table` line or on a column, is one quoted setting named after the field:

```dbml
Table sales.dim_customer [
  role: 'conformed-dim',
  grain: 'One row per customer per version',
  purpose: 'The one customer list every mart joins to.',
  decisions: 'customer_key is a surrogate key because the CRM reuses ids after two accounts merge.',
  scd_strategy: 'Segment and region keep history (type 2). Email overwrites (type 1).',
  owner: 'crm-team',
  sensitivity: 'confidential'
] {
  Note: 'Every customer who has placed an order.'

  customer_key  bigint  [pk]
  customer_code varchar [natural_key: 'true', note: 'The CRM account number']
  email         varchar [scd_type: '1', pii: 'true']
}
```

## Where things live

| Piece | File | Notes |
|---|---|---|
| Catalogue, key rules, spellings, resolver | `packages/core/src/fields.ts` | Pure, in the main entry: no `yaml`, no `@dbml/parse`, no `dbmlRichProperties.ts` import (so `dbmlRichProperties.ts` and `src/dbml/*` import it without a cycle; `fields.test.ts` pins its literal prefixes equal to the `DBML_RICH_*` constants). The one place a field's key, label, type, guidance, home, reserved names and spellings are decided |
| `fields.yml` reader and writer | `packages/core/src/fieldsFile.ts` | `parseFieldsText(text, { maxNodes, maxChars })` (never throws on any text; alias-safe budgets, as `parseTableText`), `renderFieldsText(list)` (the starting set as a file, for **Customise Fields…**), `FIELDS_FILE_NAME`, `FIELDS_FILE_VERSION`, the problem codes |
| Host reader | `src/services/fieldsService.ts` | No `vscode` (the CLI bundles it). `FieldsService(semanticRoot)`: `read()` cached by mtime and size, `getList()`, `displayFields()` (the list only when the file exists and has no `fieldsYamlInvalid` problem, as core's loader omits it), `invalidate()`. `readFieldsFile(semanticRoot)` is the uncached read for the CLI. Files over 1 MiB are not read, and a file is parsed within `FIELDS_FILE_PARSE_BUDGET` (50,000 nodes, 1 MiB of expanded text), so aliases cannot blow up |
| Values | the table's own properties | `rationale` (built-in text fields), `meta` (team fields and `business_rule`), `grain`, `modelRole`, `isNaturalKey`, `scdType`, `additiveType`. No new value map |
| DBML spelling | `packages/core/src/dbml/readTable.ts`, `writeTable.ts` | One shared setter resolution (reader precedence and the writer's `effective()` are the same function) |
| Detail panel | `packages/renderer/src/components/DetailPanel/FieldsSection.tsx` | Driven by `resolveTableFields` / `resolveColumnFields(… , subjectArea.fields ?? STARTING_FIELD_LIST)` |
| Checks | `src/cli/` (`doctor`) | `erd.fields`, kept out of `erd.dbmlProblems` |
| Assistants | `src/services/harnessService.ts` | The schema skill's **Fields** section; the setup guide writes `fields.yml` (`src/harness/`) |
| Editor support | `schemas/fields.schema.json` | `yamlValidation` for `**/.erd-studio/fields.yml` |

## The catalogue

`BUILT_IN_FIELDS`, frozen, in this order. *Starting* fields are on without a `fields.yml`; *optional* ones are on once a project lists them; *retired* ones are still read and shown, never offered.

| Key | Scope | Label | Type | Status | Home | Shows for |
|---|---|---|---|---|---|---|
| `grain` | table | Grain | text | starting | `grain` | all |
| `purpose` | table | Purpose | text | starting | `rationale.purpose` | all |
| `decisions` | table | Decisions | text | starting | `rationale.decisions` | all |
| `open_questions` | table | Open questions | text | starting | `rationale.openQuestions` | all |
| `role` | table | Table role | choice (`TABLE_ROLE_VALUES`) | starting | `modelRole` | all |
| `scd_strategy` | table | History | text | starting | `rationale.scdStrategy` | dimensions |
| `measures` | table | Measures | text | starting | `rationale.measures` | facts |
| `source_of_truth` | table | Source of truth | value | optional | `rationale.sourceOfTruth` | all |
| `freshness` | table | Freshness | text | optional | `rationale.freshness` | all |
| `known_issues` | table | Known issues | text | optional | `rationale.knownIssues` | all |
| `retention` | table | Retention | text, filled by people | optional | `rationale.retention` | all |
| `design` | table | Design | text | retired | `rationale.design` | all |
| `role_choice` | table | Role choice | text | retired | `rationale.roleChoice` | all |
| `grain_choice` | table | Grain choice | text | retired | `rationale.grainChoice` | all |
| `natural_key` | column | Natural key | yes-no | starting | `isNaturalKey` | all |
| `scd_type` | column | SCD type | choice `0` / `1` / `2` | starting | `scdType` | dimensions |
| `additive_type` | column | Additivity | choice `additive` / `semi-additive` / `non-additive` | starting | `additiveType` | facts |
| `business_rule` | column | Business rule | text | optional | column `meta.business_rule` | all |

The guidance sentences (one per field) are in `fields.ts`; they are both the canvas placeholder and the assistant's instruction, so the two never drift. A retired field's guidance says where its text goes ("Move to Decisions, or to Purpose."). `STARTING_FIELD_LIST` is `grain, purpose, decisions, open_questions, role, scd_strategy, measures` on tables and `natural_key, scd_type, additive_type` on columns, `leftOut` empty.

**Show for.** Dimensions are `conformed-dim`, `domain-dim`, `gold-dim` and `reference`; facts are `transaction-fact`, `periodic-snapshot`, `accumulating-snapshot`, `factless-fact` and `gold-fact` (`DIMENSION_ROLES`, `FACT_ROLES`). A table with no role, or a role this core does not know, shows both kinds. A field with a value always shows, whatever its `show_for`.

**Rationale keys.** `RATIONALE_FIELD_KEYS` is the one ordered list of rationale-home keys (camelCase): `purpose, decisions, openQuestions, design, grainChoice, roleChoice, scdStrategy, measures, sourceOfTruth, freshness, knownIssues, retention`. The six keys of the first release keep their relative order, so a new-file writer and the exports changed spelling, never order. `logicalModel.ts`'s exported `RATIONALE_KEYS` stays the legacy six (a public export); every reader, writer, schema and renderer that used a hand-copied list now uses the catalogue. `fieldKeyToRationaleKey('open_questions')` → `openQuestions` (catalogue only), `rationaleKeyToFieldKey` the reverse, `isRationaleFieldKey` the membership test. `rationaleKeyOf` (`dbmlRichProperties.ts`) accepts every catalogue key and still returns `undefined` for an unknown one.

## `fields.yml`

```yaml
version: 1
tables:
  - grain                    # bare name = built-in, as shipped
  - purpose
  - key: decisions           # built-in with the team's own wording
    guidance: Choices finance signed off, and why.
  - open_questions
  - role
  - scd_strategy
  - measures
  - key: owner               # team field
    label: Owner
    type: value              # text (default) | value | choice | yes-no
    guidance: The team that owns it, e.g. crm-team.
    filled_by: dbt           # anyone (default) | people | dbt
  - key: sensitivity
    label: Sensitivity
    type: choice
    values: [public, internal, confidential]
    filled_by: people
    show_for: all            # dimensions | facts | all (default)
columns:
  - natural_key
  - scd_type
  - additive_type
  - key: pii
    label: Personal data
    type: yes-no
    filled_by: dbt
left_out: [dimension, metrics]   # dbt meta keys never copied
```

- **Optional**, directly in the semantic dir next to `layers.json` (never in a layer folder). No file = the starting set. ERD Studio **never writes it**: the setup guide writes it after one yes, a person edits it, and **Customise Fields…** (`erdStudio.customiseFields`, also the Detail panel's **Customise fields** link, message `openFieldsFile`) opens it, or, with no file, an untitled YAML document holding `renderFieldsText(STARTING_FIELD_LIST)` that is written only when the user saves it.
- **Sections.** A missing `tables:` (or `columns:`) uses the starting set's fields for that scope, so a file that only adds team table fields keeps the column flags. `tables: []` (or a bare `tables:`) means none. No `version:` reads as 1. Unknown top-level keys and unknown entry keys are ignored. An empty or comment-only file reads as the starting set.
- **Entries.** A bare name is a built-in as shipped. `{ key: <built-in>, label?, guidance?, filled_by? }` rewords a built-in: its `type`, `values`, `show_for` and home never change (a warning). Any other `{ key, … }` is a team field, stored in `meta`. A retired name is accepted with a warning and shown as listed.
- **Problems** (stable codes; `FieldsFileProblem { code, severity, line?, key?, message }`, the message naming no file — the host or the CLI adds the path and line):

| Code | Severity | Meaning, and what is read |
|---|---|---|
| `fieldsYamlInvalid` | error | not YAML, not a map, or over budget: the starting set |
| `fieldsSectionInvalid` | error | `tables:` / `columns:` / `left_out:` is not a list: that section is the starting set's (`left_out` none) |
| `fieldsEntryInvalid` | error | neither a name nor a map with `key`: skipped |
| `fieldsKeyInvalid` | error | not `FIELD_KEY_PATTERN` (`^[a-z_][a-z0-9_]*$`, because DBML lower-cases setting names): skipped |
| `fieldsKeyReserved` | error | a reserved name (below): skipped |
| `fieldsKeyDuplicate` | error | listed twice in one section: the later copy skipped |
| `fieldsTypeInvalid` | error | unknown `type`: text |
| `fieldsChoiceWithoutValues` | error | a choice with fewer than two values: text |
| `fieldsFilledByInvalid`, `fieldsShowForInvalid` | error | unknown value: the default |
| `fieldsUnknownName` | warning | a bare name that is not a built-in (with the closest built-in suggested): skipped |
| `fieldsBuiltInOverride` | warning | a built-in's `type`, `values`, `show_for` or home: ignored |
| `fieldsRetiredListed` | warning | a retired built-in on the list: still shown |
| `fieldsVersionNewer` | warning | `version:` above `FIELDS_FILE_VERSION`: what this core understands is read |
| `fieldsVersionInvalid` | warning | `version:` not a whole number ≥ 1: read as 1 |
| `fieldsPropertyInvalid` | warning | a `label` or `guidance` that is not text: ignored |

`schemas/fields.schema.json` describes the same rules for the YAML extension (bare names per scope, the key pattern, the reserved names and prefixes, the enums); `test/unit/fileSchemas.test.ts` holds it to `fields.ts` and `parseFieldsText`.

## Reserved keys

Never a field key (`fields.yml` rejects them), never written bare by ERD Studio, and a bare one in a file is not read as a field (kept byte for byte). `isReservedFieldKey(key, scope)` / `reservedFieldKeyReason` compare lower-cased:

- DBML's own settings, both scopes, any parser version (`DBML_SETTING_NAMES`): `note, headercolor, color, pk, primary key, primary_key, unique, ref, dep, not null, not_null, null, increment, default, name, type, check, update, delete, inactive, example`.
- ERD Studio's own (`ERD_SETTING_NAMES`): `schema, alias, role, grain, foreign_key, natural_key, scd_type, additive_type, meta_json, erd_placeholder, linked_table`, plus the `meta` keys it keeps for itself, `json` (its `meta_` spelling would be `meta_json`) and `dbml` (Import DBML's bookkeeping, never a field row).
- Parser-unsafe names (`UNSAFE_FIELD_KEYS`): `constructor`, `__proto__`.
- Any key starting `erd_`, `rationale_` or `meta_` (`RESERVED_FIELD_KEY_PREFIXES`). Those prefixed settings are still **decoded** as spellings (below); only DBML's and ERD Studio's own names are left unread.

`role`, `grain`, `natural_key`, `scd_type` and `additive_type` are reserved for team fields but are built-ins. A team key may also not equal a catalogue key of its scope: that is a rewording of the built-in.

## Homes: derive, don't store

A field's value stays where it always lived; nothing keeps a second copy, and the resolver reads the homes:

- **`rationale`** (`packages/core/src/types/semantic.ts`) gained the optional keys `decisions`, `openQuestions`, `sourceOfTruth`, `freshness`, `knownIssues`, `retention`. The six first-release keys stay.
- **`meta`** holds every team field and `business_rule`. It keeps its meaning: the user's free-form map, never compared, diffed or synced with dbt.
- **Typed built-ins** keep their properties: `grain`, `modelRole`, `isNaturalKey`, `scdType`, `additiveType`.

`DisplayTable` and `DisplayColumn` did not change shape. `DisplaySubjectArea` gained one optional property, `fields?: FieldList` (the resolved list, full definitions), emitted **only when the project has a `fields.yml`**, so every golden of a project without one is byte-identical. Absent means the starting set: the renderer always does `subjectArea.fields ?? STARTING_FIELD_LIST`.

## Spellings and precedence

**DBML.** Every spelling an older file used is the same field. `rationaleSpellingNames` / `metaSpellingNames` give them in precedence order; the reader and the writer share one setter resolution over the parser's AST setters (rawDb only supplies value text), and a setting inline and in a same-file `Metadata` block counts as one spelling, the block's entry used (D25):

| Home | Spellings, in precedence order | Which one wins |
|---|---|---|
| rationale, key `K` (snake) | `erd_K`, `K`, `erd_rationale_K`, `rationale_K` | the first whose value is non-empty text; empty ones are skipped |
| meta, key `k` | `erd_k` and `k` (only when `isBareMetaKey(k, scope)`), `erd_meta_k`, `meta_k` (never for `json`), `erd_rationale_k` and `rationale_k` (only when `k` is not a catalogue rationale key of the scope), then the `meta_json` entry `k` | the first present; `''` is a value and stops the search. The key's place in `meta` is its winning spelling's |
| typed (`role`, `grain`, `alias`, `schema`, column `natural_key`, `scd_type`, `additive_type`, `foreign_key`) | `erd_<name>`, `<name>` | unchanged from 2.0 |

- **`isBareMetaKey(key, scope)`** = matches `FIELD_KEY_PATTERN`, is not reserved, and is not a catalogue key **of this scope** whose home is not `meta`. So `business_rule` (a column built-in kept in `meta`) is bare like a team field, and a column's `purpose` (a table built-in only) is a bare column meta key. Catalogue membership is always per scope.
- **A shadowed meta key.** A `meta` key that is reserved, or equal to a same-scope catalogue key with another home (`meta.purpose`, `meta.retention`, `meta.role`, `meta.note`), keeps `meta` as its home: it is written `meta_<k>` (or in `meta_json`), never merged with or hidden by the built-in, and the resolver shows it as its own row labelled `<key> (metadata)` (row id `meta:<key>`), edited through `updateMeta`. `docs/examples/bigquery-versioned` keeps `meta_retention` for this reason; `doctor` counts them (`fieldMetaShadowsBuiltIn`).
- **New values are bare.** `renderNewTableDbml` writes `role`, `grain`, `alias`, then the rationale fields in `RATIONALE_FIELD_KEYS` order (`purpose: '…'`, `decisions: '…'`, `open_questions: '…'`, …), then `meta` in its key order: a text value under a bare meta key as `k: '…'`; a text value under a reserved or shadowed identifier key as `meta_k: '…'`; everything else (non-text, a non-identifier key, `json`) in the one `meta_json`, placed as before. Columns the same after ERD Studio's flags; `note` last. The canonical column setting order is `pk`, DBML's own, ERD Studio's flags, fields, `note`.
- **Edits stay where they are.** `editTableDbml` changes the spelling the reader read (any spelling, inline or in a same-file `Metadata` block, or its `meta_json` entry), so a change to an old file is one line of diff. A clear removes **every spelling of that home** (nothing resurfaces from a lower one); an add writes the new-file spelling into the inline list, in the field band: after ERD Studio's typed settings come the rationale-home fields in `RATIONALE_FIELD_KEYS` order, then any setting ERD Studio does not read, then every `meta` spelling as one group (bare, `meta_<key>`, `rationale_<key>` and an existing `meta_json`), then a new `meta_json`, and `note` last (`RATIONALE_ORDER`, `OTHER_ORDER`, `META_ORDER`, `META_JSON_ORDER`, `NOTE_ORDER` in `writeTable.ts`), so the meta map keeps its order. A value that becomes non-text moves into `meta_json`; a `meta_json` value that becomes text is written in the new-file spelling and its entry removed. The writer never writes a reserved key bare, a typed value, a duplicate or a non-identifier key. There is **no rename**: an assistant renames old spellings on a yes, and `doctor` lists them.
- **`fieldSpellings`** (additive on `DbmlTableReading`): every field-bearing setting found, `{ owner ('' = the table, else the column name), home: 'rationale' | 'meta', key, spelling: 'bare' | 'erd' | 'rationale' | 'meta' | 'json', name?, used, old }`; `name` is the setting as written (`erd_rationale_purpose`; for a `json` entry, the `meta_json` setting), which `doctor`'s `fieldSpelledTwice` message names. `old` means the new-file writer would spell that key and value differently (`rationale_<K>`; `meta_<k>` or a text `meta_json` entry under a bare meta key, unless `meta_json` must hold it to keep the key order). `erd_` spellings, shadowed `meta_<k>` and non-text `meta_json` entries are never old. Kept out of `reading.problems` (the CLI pipes those into `dbmlProblems`).
- **The rich export and Import DBML are unchanged** ("storage is not export"): `toDbmlRich` still writes `rationale_<snake>` / `meta_*` / `meta_json` (so it exports `rationale_decisions` and friends), and Import DBML reads `rationale_<k>` for every catalogue key through `rationaleKeyOf`, while another tool's bare settings still go to `meta.dbml` (D19). Bare spellings in the rich export, and Import reading bare fields, are follow-ups.

**YAML (pre-2.0 table files, still read and edited).** Built-in text fields live in the `rationale:` map under their **camelCase** keys only (`openQuestions`, never `open_questions`), team fields and `business_rule` in `meta:`, typed built-ins in their own keys. `TableLibraryService.syncMap` manages `RATIONALE_FIELD_KEYS` and deletes only managed keys: the `rationale:` map goes only when no key at all remains, so an unknown key a hand edit left survives clearing the last field. A yes-no team field writes a YAML boolean (`pii: true`) when the field is yes-no or the existing value is a boolean, and keeps an existing `meta_json` entry boolean; a DBML bare setting is always the text `'true'` / `'false'`. `schemas/logical-model.schema.json` declares the camelCase keys.

## The resolver

`resolveTableFields(table, list?)` / `resolveColumnFields(column, table, list?)` → `FieldRow[]` (`{ id, definition, value?, choice?, source, editable, outsideChoices? }`):

1. The list's fields, in list order. A listed field that does not suit the table's role is left out unless it has a value.
2. Then every field with a value the list leaves out: retired built-ins (`source: 'retired'`), other built-ins with a value (`'notInList'`), then `meta` keys in map order (`'notInList'`, `metaFieldDefinition`: label = key, text, status team; `<key> (metadata)` for a shadow). `left_out` keys are **shown** like any other off-list key.
3. `meta.dbml` is never a row (the panel shows it separately, read-only, as **Kept from DBML import**).

Row ids are stable per table or column: `rationale:<camelKey>`, `meta:<key>`, or the typed home's kind (`grain`, `role`, `naturalKey`, `scdType`, `additiveType`); the renderer uses them as React keys. Values: text homes give text (`scdType` 2 → `'2'`, a natural key → `'true'`; a false or absent `isNaturalKey` is no value); a `meta` value keeps its shape; blank rationale or grain text is no value, a `meta` `''` is a value. `choice` is the normalised option for a choice or yes-no row: yes-no reads booleans and case-insensitive trimmed `'true'` / `'false'`; anything else (`'yes'`, `'no'`) is `outsideChoices: true`, still returned. A role outside `TABLE_ROLE_VALUES` is shown with `outsideChoices`, never dropped. Lists, maps and `null` are `editable: false`. An unknown `type`, `filledBy`, `showFor` or `home.kind` in a cached list (a newer core) gives a read-only text row, read from `meta[key]` when the home is unknown. It never throws on malformed or older-core input (v4 inline values of any type included).

## Loading and the host

- **Core's loader** reads `fields.yml` only with the new `loadDisplaySubjectArea` option `readFieldsFile: true` (default false, so existing read sequences and tests are unchanged): `${prefix}fields.yml`, once, right after `layers.json` and before any model; a missing file is handled exactly like a missing `layers.json`; text over `maxDomainChars` warns and is left out; `maxYamlNodes` is the parse budget; a broken file warns and is left out; never a new error class. The Confluence app opts in when it wants the list.
- **The extension** does not use the loader path: one `FieldsService` per project passes `displayFields()` into `toDisplaySubjectArea` (`ToDisplaySubjectAreaOptions.fields`) for **both** stages. The physical stage stays read-only (nothing new in `NON_MUTATION_TYPES`); it shows the logical table's and columns' `meta` next to `rationale`, display only, never persisted.
- **Watcher.** Exactly `<semanticDir>/fields.yml` (root only). A change invalidates the cache and re-sends the subject area to open editors; a refresh path never writes. ERD Studio never writes the file, so there are no own writes to record.
- **`doctor`'s root allowance**: `fields.yml` is an expected root file of a DBML project (`ALLOWED_ROOT_FILES` in `src/cli/dbmlProblems.ts`), not `unexpectedFileInDbmlFolder`; `classifySemanticFile` sees it as `other`. The `.erd-studio/README.md` generator mentions it in one line.
- **Assistant hooks**: `fields.yml` is not exempt from the one-time skill check; its format is in the skill.

## The Detail panel

`FieldsSection` (BEM block `fields-section`, theme variables only) replaces the six hard-coded rationale fields (`ModelRationale.tsx`), the table and column `MetaEditor`s and the separate role and grain sections; `DescriptionEditor` and `AliasEditor` stay outside it. In the editor it is the body of the **Modelling detail (optional)** fold, which opens when any row has a value (`meta.dbml` aside); in the viewer it takes the old sections' place.

| Type | Editor |
|---|---|
| text | multi-line text box, the guidance as its placeholder |
| value | one-line box |
| choice | a dropdown of `values` (the current value added and marked when it is outside them) |
| yes-no | a yes / no / unset dropdown |

Edits use existing messages, chosen by the field's home (no new edit message type):

| Home | Message |
|---|---|
| rationale | `updateModelRationale { modelName, rationale: { [camelKey]: string } }`; `''` (or `null`) clears. Payload validation checks the model name, a plain object, keys in `RATIONALE_FIELD_KEYS`, values string or null |
| meta | `updateMeta { modelName, columnName?, set?, remove? }`; clearing a text field posts `remove: [key]` |
| grain / role | `updateModelGrain` / `updateModelRole` |
| column `natural_key`, `scd_type`, `additive_type` | the existing column messages (`toggleColumnKey`, `updateColumn`); the controls stay in `ColumnRowEditor`, shown when the field is on the list or has a value (its optional `fieldVisibility` prop; without it, the old `modelRole` gating). The NK key badge is never hidden |

- **Badges and groups (editor only):** **from dbt** (`filled_by: dbt`, and only in a dbt project), **people only**, **Retired** (still editable in place); off-list rows under **Not in your list**. **+ Add field** adds a free-form `meta` key (it refuses reserved keys and same-scope catalogue keys, pointing at the built-in row, and warns that a non-identifier key is stored in `meta_json`). The header's **Customise fields** link posts `openFieldsFile` (no payload, not an edit), which runs `erdStudio.customiseFields`.
- **Read-only = viewer** (`viewer || domain.readOnly`, the physical stage included): rows with a value only, one flat list in resolver order, labels and values, no headings, badges, guidance, **+ Add field** or posts. Gates are written `viewer ? … : (readOnly ? … : <editable>)`.
- `graphTransformer`'s `hasRationale` reads every rationale key with text. Hover tooltips are unchanged.

## `doctor`

`erd.fields` (additive JSON): `{ file: string | null, source: 'file' | 'starting-set', tables, columns, leftOut, problems: FieldFinding[] }`, `FieldFinding = { code, severity: 'error' | 'warning' | 'info', message, file?, line?, table?, column?, key?, count? }`. Kept out of `erd.dbmlProblems`, so a clean project stays clean. It works for YAML projects too (the spelling checks are DBML-only).

| Code | Severity | When |
|---|---|---|
| every `fieldsFile.ts` code | as above | a problem in `fields.yml` (with its project-relative path and line) |
| `fieldValueOutsideChoices` | warning | per table or column: a team choice value outside its `values`, or a yes-no that is not true or false (the role is not checked here) |
| `fieldSpelledTwice` | warning | per table: one field under more than one spelling (`fieldSpellings`), the used one named |
| `fieldOldSpellings` | info | one finding, with a count and an example: settings the new-file writer would spell bare |
| `fieldRetired` | info | one finding: the number of tables with `design`, `role_choice` or `grain_choice` |
| `fieldMetaShadowsBuiltIn` | info | one finding: `meta` keys named like a built-in of their scope |
| `fieldNotInList` | info | one finding, only with a `fields.yml`: keys with values the list leaves out (`left_out` keys ignored) |

Errors raise the next step **`fix-fields-file`**, right after `fix-dbml-file`; warnings and info never raise one. Human output: errors ✗, warnings !, each info as one summary line. A finding for a new built-in a release adds (`fieldNewBuiltIn`) is deferred.

## The skill

`SKILL_PART` has one compact **Fields** section in place of "Design rationale" and "The team's metadata list" (the setting-name table and the full `fields.yml` format are in `DBML_PART`, the YAML value rules in `LEGACY_PART`; the Codex region stays under its 26 KB cap). It says: read `.erd-studio/fields.yml` first, else the starting set; one setting per field, `<key>: '<value>'`, every value quoted; how each type is written; `filled_by: people` (only a value the user gives) and `dbt` (copied exactly from the dbt model's `meta`, never typed in, never a `left_out` key); `show_for`; no placeholders; `open_questions` is where an assistant writes the question it cannot answer, moving the answer into `decisions`; keep every setting the list does not name; old spellings are the same field, edited in place and renamed only on a yes (never a `meta_json` entry or a shadowed `meta_<key>`); retired fields are kept, with one offer to move their text into `decisions`. A team's old `## Metadata` table in `modelling-approach.md` is still followed while `fields.yml` has no team fields, and the assistant offers once to move it into `fields.yml`. The setup guide offers the field list (the starting set, the modelling style, dbt's `meta`) with one yes and writes `fields.yml`. `HARNESS_VERSION` 46. Copying `filled_by: dbt` values stays the assistant's job: no extension code copies dbt `meta`.

## Exports

Plain DBML and Mermaid notes print the rationale fields under `RATIONALE_LABELS`, extended with the new keys in `RATIONALE_FIELD_KEYS` order and their labels (Decisions, Open questions, Source of truth, Freshness, Known issues, Retention); the first six keep their labels (Purpose, Design, Grain choice, Role choice, SCD strategy, Measures), so no existing golden changed. Team fields still export as meta lines. `fields.yml` labels in exports are deferred.

## Compatibility

- **Old files read the same.** `rationale_*`, `meta_*`, `meta_json` and YAML `rationale:` / `meta:` maps read as before; a project with no `fields.yml` shows what it showed, plus Decisions and Open questions, with Design marked retired. Core's old-shape fixtures and goldens (`rationale-and-meta`, the DBML twins) pin the old spellings; `test/fixtures/dbml-native` stays in the old spelling as the extension-level old-spelling project.
- **Mixed versions.** A 2.0 pre-release from before this change ignores bare settings (it shows only the old spellings) and keeps every setting byte for byte when it edits. A pre-2.0 extension clearing the last legacy rationale key on a YAML table deletes the whole `rationale:` map, the new keys included. Versions before 2.0 cannot open `.dbml` tables at all.
- **Confluence.** The package change is additive (`fields?` on `DisplaySubjectArea`, the new `Rationale` keys, the `fields.ts` / `fieldsFile.ts` exports, `readFieldsFile`). The renderer's Detail panel changed, so recommend a Confluence cache-key bump with the 0.4.0 pin.

## Adding a built-in field

1. Add it to `BUILT_IN_FIELDS` (with its guidance), and to `RATIONALE_FIELD_KEYS` and `Rationale` when its home is `rationale` (append: never reorder). Keys already there are a contract: never rename one; retire it instead.
2. Add it to `RATIONALE_LABELS` (exports), `schemas/logical-model.schema.json` (`rationale`), `schemas/fields.schema.json` (the bare-name enum and its description) and the grammar's ERD Studio property list (`syntaxes/dbml.tmLanguage.json`).
3. Update the skill (`SCHEMA_CONTENT`), bump `HARNESS_VERSION`, and update `docs/semantic-domain-json-reference.md` and this page.
4. A project with a `fields.yml` does not get it until it is listed; say so in the CHANGELOG.

## Tests

`packages/core/test/unit/fields.test.ts` (catalogue, reserved names, spellings, resolver), `fieldsFile.test.ts` (every problem code, budgets, `renderFieldsText` round trip), `rationaleAndMeta.golden.test.ts` and its fixture (old spellings before the writer changed); the DBML reader / writer cases and codec laws (`dbmlCodecLaws.test.ts`: `constructor` / `__proto__` in the meta pool); `test/unit/fieldsService.test.ts`; `test/unit/fileSchemas.test.ts` (the schema against core); `test/unit/dbmlGrammar.test.ts` (every catalogue key scoped as ERD Studio's); `test/unit/docExamplesProjects.test.ts` (examples spell fields bare; `docs/examples/data-mesh` carries a `fields.yml` that reads with no problem).
