/**
 * HarnessService — generates AI coding assistant configuration files.
 *
 * Supports installing ERD Studio schema reference into:
 *   - Claude Code (.claude/skills/erd-studio/SKILL.md, plus the
 *     /erd-studio-setup onboarding skill in .claude/skills/erd-studio-setup/)
 *   - Agent Skills (.agents/skills/erd-studio/SKILL.md + .agents/skills/erd-studio-setup/),
 *     the open-standard folder GitHub Copilot, Codex, Gemini CLI and Cursor read
 *   - GitHub Copilot (.github/instructions/erd-studio.instructions.md)
 *   - Google Gemini (.gemini/styleguide.md)
 *   - OpenAI Codex (AGENTS.md)
 *
 * Each harness uses a different file format and location, but the core
 * content (ERD Studio schema reference) is the same across all.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FileState, HarnessStatus, RecommendedInstallResult } from '../types/harness';
import { recommendedSkillTargets, type AiAssistantId, type SkillHarnessTarget } from '../types/aiAssistants';
import { SETUP_SKILL_DIRS, SETUP_SKILL_FILES, skillForTarget } from './harnessAssets';

export type { FileState, HarnessStatus, RecommendedInstallResult } from '../types/harness';

// ---------------------------------------------------------------------------
// Version marker — embedded in every generated harness file
// ---------------------------------------------------------------------------

/** Version of the harness content. Bump when SCHEMA_CONTENT or generators change. */
export const HARNESS_VERSION = '20';

const VERSION_MARKER_PREFIX = '<!-- erd-studio-harness:';
const VERSION_MARKER_SUFFIX = ' -->';

/**
 * Region markers wrapping the ERD Studio section inside shared files that
 * may also hold user content (currently only Codex's AGENTS.md). Updates
 * replace only the text between these markers so everything else the user
 * wrote in the file survives a HARNESS_VERSION bump.
 */
export const CODEX_REGION_BEGIN = '<!-- BEGIN erd-studio-harness -->';
export const CODEX_REGION_END = '<!-- END erd-studio-harness -->';

/** Heading of the Codex section — used to recognise pre-region installs. */
const CODEX_SECTION_HEADING = '## ERD Studio Domain Files';

function buildVersionMarker(): string {
  return `${VERSION_MARKER_PREFIX} ${HARNESS_VERSION}${VERSION_MARKER_SUFFIX}`;
}

/**
 * Extract the harness version from file content, or `null` if no marker found.
 */
export function extractHarnessVersion(content: string): string | null {
  const match = content.match(/<!-- erd-studio-harness: (.+?) -->/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HarnessTarget {
  /** Display label shown in QuickPick. */
  label: string;
  /** Internal identifier. */
  id: 'claude' | 'agents' | 'copilot' | 'gemini' | 'codex';
  /** Brief description shown in QuickPick. */
  description: string;
  /** Relative path from workspace root where the file will be written. */
  relativePath: string;
  /** Pattern to add to .gitignore on first install. Omit if the file may contain non-ERD-Studio content. */
  gitignorePattern?: string;
}

export interface HarnessInstallResult {
  target: HarnessTarget;
  success: boolean;
  filePath: string;
  alreadyExisted: boolean;
  error?: string;
  /** Workspace-relative (POSIX) paths this install wrote, set on success. */
  filesWritten?: string[];
}

// ---------------------------------------------------------------------------
// Harness targets
// ---------------------------------------------------------------------------

export const HARNESS_TARGETS: HarnessTarget[] = [
  {
    label: '$(hubot) Claude Code',
    id: 'claude',
    description: '.claude/skills/erd-studio/SKILL.md',
    relativePath: '.claude/skills/erd-studio/SKILL.md',
    gitignorePattern: '.claude/skills/erd-studio/',
  },
  {
    label: '$(folder-library) Agent Skills — GitHub Copilot, Codex, Gemini CLI, Cursor',
    id: 'agents',
    description: '.agents/skills/erd-studio/SKILL.md',
    relativePath: '.agents/skills/erd-studio/SKILL.md',
    // No gitignorePattern, deliberately: Gemini CLI's read_file refuses any
    // path .gitignore matches (`respectGitIgnore` defaults to true), so an
    // ignored `.agents/skills/` would let the guide start (skill activation
    // does not go through read_file) and then stall at its first reference
    // file. See install().
  },
  {
    label: '$(github) GitHub Copilot',
    id: 'copilot',
    description: '.github/instructions/erd-studio.instructions.md',
    relativePath: '.github/instructions/erd-studio.instructions.md',
    gitignorePattern: '.github/instructions/erd-studio.instructions.md',
  },
  {
    label: '$(sparkle) Google Gemini',
    id: 'gemini',
    description: '.gemini/styleguide.md',
    relativePath: '.gemini/styleguide.md',
    gitignorePattern: '.gemini/styleguide.md',
  },
  {
    label: '$(code) OpenAI Codex',
    id: 'codex',
    description: 'codex-erd-studio.md (appended to AGENTS.md)',
    relativePath: 'AGENTS.md',
    // No gitignorePattern — AGENTS.md may contain non-ERD-Studio content
  },
];

// ---------------------------------------------------------------------------
// Core schema content (shared across all harnesses)
// ---------------------------------------------------------------------------

const SCHEMA_CONTENT = `# ERD Studio — AI Data Modeling Guide

ERD Studio uses a **central model store** architecture. Model definitions are YAML files in \`.erd-studio/logical-models/\` (at the top level, or one folder down in a per-layer folder). Domain JSON files reference models by name and define relationships and layout.

## Architecture Overview

\`\`\`
.erd-studio/
├── modelling-approach.md     ← Optional: the team's modelling rules (see below)
├── logical-models/           ← Central model definitions (YAML, one per model)
│   ├── dim_project.yml       ← top level (flat libraries keep working)
│   ├── silver/               ← optional per-layer folders
│   │   └── dim_customer.yml
│   └── gold/
│       └── fct_sale.yml
├── silver/
│   ├── customer-360.json     ← Domain file (model references + relationships + layout)
│   └── orders.json
└── gold/
    └── reporting.json
\`\`\`

**Key principle:** Models are defined ONCE in \`logical-models/\` and referenced from multiple domain files. Editing a model from any domain updates the shared definition.

### Model file location (layer folders)

- A model file lives at \`logical-models/{name}.yml\` **or** exactly one folder down at \`logical-models/{folder}/{name}.yml\`. By convention the folder is a layer id (\`bronze\`, \`silver\`, \`gold\`). Deeper nesting and dot-folders are ignored.
- The folder is organisational only. Domain files reference models **by name**, never by path, and model names are **unique across all folders** (as dbt model names are across a project). Never create a second file with a name that already exists in another folder.
- **The same table name in two layers** (a silver \`date\` and a gold \`date\`) is two models with different names and the same \`alias\`: \`logical-models/silver/silver_date.yml\` (\`alias: date\`) and \`logical-models/gold/gold_date.yml\` (\`alias: date\`), exactly as a dbt project gets two \`date\` tables. Name the model \`{layer}_{name}\` and set \`alias\` to the table name; never reuse the bare name.
- **To find a model**, look at \`logical-models/{name}.yml\` first, then in each folder (\`logical-models/*/{name}.yml\`). If the same name exists twice, the top-level file wins, then folders in alphabetical order; the others are ignored.
- **Folders are opt-in per project.** Check first: if a folder named after a layer in \`layers.json\` (\`logical-models/{layer}/\`) already holds a \`.yml\` file (or \`logical-models/\` is empty), the project uses layer folders — create a new model in the folder of the layer of the domain you are adding it to (adding \`fct_sale\` to \`gold/reporting.json\` creates \`logical-models/gold/fct_sale.yml\`). If every model file is at the top level, the project is **flat** — create the new file at the top level too, and never start the folder layout on your own (the user opts in with **ERD Studio: Organise Model Library by Layer**). When editing or renaming an existing model, keep its file in the folder it is already in.

### Team Modelling Approach

If \`.erd-studio/modelling-approach.md\` exists, **read it before creating or editing models and follow it.** It records how this team models data — the technique (e.g. Kimball dimensional modelling, Data Vault 2.0), the user's own words, the concrete rules, and how each rule maps onto ERD Studio fields (\`modelRole\`, \`grain\`, \`scdType\`, \`additiveType\`, \`isNaturalKey\`, \`rationale\`). The \`/erd-studio-setup\` guide writes it after asking the user; it can also be written or edited by hand. It is free-form markdown: ERD Studio never parses it, and a project without one is valid. When a rule in it conflicts with a user request, say so and ask which wins. If it has a **Target-design backlog** section, the differences between logical and physical listed there are intentional: when a sync plan or diff proposes undoing one, report it as a backlog item and leave it as it is unless the user says otherwise.

### Model Library (Sidebar)

The **Model Library** panel in the ERD Studio sidebar shows all YAML files in \`logical-models/\`, grouped by folder. Use it to understand the difference between "model definition exists" and "model is referenced by a domain":

- **Referenced models** show how many domains use them (e.g. "2 domains")
- **Orphaned models** show a warning icon and "(unused)" — these exist as \`.yml\` files but are not in any domain's \`logical.models[]\` array

**Important for AI agents:** Before saying a model "already exists in the ERD", check whether it is referenced by the target domain's \`logical.models[]\` array — not just whether the \`.yml\` file exists. A model file in \`logical-models/\` may be unused (orphaned) or only referenced by other domains.

## Domain File Structure

**File:** \`.erd-studio/{layer}/{domain}.json\`

\`\`\`json
{
  "schemaVersion": 5,
  "domain": "customer-360",
  "layer": "silver",
  "description": "Customer domain — master data and transaction history",
  "modelFolder": "models/silver",
  "stubColumns": ["dim_project"],
  "logical": {
    "models": ["dim_customer", "fct_sale", "dim_product", "dim_project"],
    "relationships": []
  },
  "viewConfig": {}
}
\`\`\`

| Field | Required | Description |
|-------|----------|-------------|
| \`schemaVersion\` | Yes | Must be \`5\` |
| \`domain\` | Yes | Domain slug (matches filename without \`.json\`) |
| \`layer\` | Yes | Layer name matching parent directory (e.g. \`silver\`, \`gold\`) |
| \`description\` | No | Human-readable domain description |
| \`modelFolder\` | No | Filter for "Add Existing Model" dialog (e.g. \`models/silver\`) |
| \`stubColumns\` | No | Model names whose physical-only columns are suppressed in sync comparison. Use for conformed dimensions and reference tables included only to anchor relationships — they define a few key columns (PK/NK) but not the full physical column set. Missing-column discrepancies are hidden; extra and type-mismatch discrepancies on defined columns still surface. |
| \`logical.models\` | Yes | Array of model name strings (references to \`logical-models/*.yml\` or \`logical-models/{folder}/*.yml\`) |
| \`logical.relationships\` | Yes | Array of relationship objects |
| \`viewConfig\` | Yes | Root-level view settings. The extension auto-assigns positions for new models; a new domain written with \`viewConfig: {}\` (no positions at all) is auto-arranged with the canvas's auto layout the first time it opens |

**viewConfig** must be at the root level, not inside \`logical\`. It stores node positions keyed by model name, and optional canvas annotations (build notes):

\`\`\`json
"viewConfig": {
  "positions": { "dim_customer": { "x": 100, "y": 200 } },
  "annotations": [
    { "id": "uuid", "text": "Build note text", "x": 300, "y": 50, "color": "yellow", "linkedModel": "dim_customer" }
  ]
}
\`\`\`

Annotations are temporary build notes — visible on the canvas while constructing models. They are view-layer data, not semantic data. Valid colours: \`yellow\`, \`blue\`, \`green\`, \`pink\`, \`orange\`. The \`linkedModel\` field is optional and draws a dashed edge to the named model.

> **WARNING — Preserve existing positions:** When adding models to an existing domain file, do NOT clear or overwrite \`viewConfig.positions\`. The extension automatically computes positions for any new models that lack entries. Clearing existing positions will reset the user's carefully arranged layout.

---

## Editing Quick Reference

**CRITICAL — Two files control the diagram.** Column data lives in the YAML; structural data lives in the JSON. You must edit the correct file for each operation.

| User asks to... | Edit this file |
|-----------------|---------------|
| Add/remove/rename a column | the model's \`.yml\` (\`logical-models/{name}.yml\` or \`logical-models/{folder}/{name}.yml\`) |
| Change column type, PK/FK/NK flags, SCD type | the model's \`.yml\` |
| Change grain, modelRole, description, rationale | the model's \`.yml\` |
| Add a model to a domain diagram | Domain \`.json\` → add name to \`logical.models[]\` AND, if no file for that name exists in any folder, create it — \`logical-models/{layer}/{name}.yml\` (the domain's layer) when the project uses layer folders, else \`logical-models/{name}.yml\` |
| Remove a model from a domain | Domain \`.json\` → remove name from \`logical.models[]\` AND remove its relationships from \`logical.relationships[]\` |
| Add/remove/edit a relationship | Domain \`.json\` → \`logical.relationships[]\` |
| Change layout positions | Domain \`.json\` → \`viewConfig.positions\` |

> **Common mistake:** Editing the \`.yml\` file alone is sufficient for column and model property changes — the extension picks up YAML changes automatically. But adding a model to the **diagram** requires BOTH creating the \`.yml\` AND adding the name string to the domain \`.json\`. Similarly, relationships are ONLY stored in the domain \`.json\`, never in the \`.yml\`.

---

## Models

Model definitions live in \`.erd-studio/logical-models/{model_name}.yml\` or \`.erd-studio/logical-models/{layer}/{model_name}.yml\` (see "Model file location" above). Create/edit these YAML files to define models. Then reference them by name in domain files.

**File:** \`.erd-studio/logical-models/silver/dim_customer.yml\`

\`\`\`yaml
name: dim_customer
schema: silver
description: Customer master data
grain: One row per customer
modelRole: conformed-dim
rationale:
  purpose: Customer master data for cross-domain joins
  roleChoice: Conformed dimension shared across domains
columns:
  - name: customer_id
    dataType: INT
    description: Surrogate key
    isPrimaryKey: true
    scdType: 0
  - name: email
    dataType: VARCHAR
    description: Email address
    isNaturalKey: true
    scdType: 1
  - name: full_name
    dataType: VARCHAR
    description: Customer display name
    scdType: 2
\`\`\`

| Field | Required | Description |
|-------|----------|-------------|
| \`name\` | Yes | Model name (see naming conventions below) |
| \`schema\` | No | Target schema for materialization |
| \`alias\` | No | Warehouse table name when it differs from \`name\` — dbt's \`alias\` config. \`name\` stays the identity (domain files and relationships use it); the canvas shows the alias. Use it for the same table name in two layers (\`silver_date\` and \`gold_date\`, both \`alias: date\`). A plain identifier: letters, digits, underscores |
| \`description\` | No | Human-readable model description |
| \`grain\` | No | Grain statement — "One row per ___" |
| \`modelRole\` | No | Architecture role (see values below) |
| \`columns\` | No | Array of column definitions |
| \`rationale\` | No | Design rationale object (omit if empty) |

### modelRole Values

| Value | Use Case |
|-------|----------|
| \`conformed-dim\` | Shared dimension reused across domains |
| \`domain-dim\` | Dimension specific to this domain |
| \`transaction-fact\` | Discrete event fact |
| \`periodic-snapshot\` | Recurring measurement per period |
| \`accumulating-snapshot\` | Lifecycle with milestones |
| \`factless-fact\` | M:M bridge table, FKs only |
| \`reference\` | Low-cardinality lookup |
| \`gold-fact\` | Pre-joined Gold view |
| \`gold-dim\` | Flattened Gold dimension view |

### Design Rationale

Optional \`rationale\` object — all fields are optional strings. Omit the entire object if no rationale is needed.

| Field | Purpose |
|-------|---------|
| \`purpose\` | What requirements this model fulfils |
| \`design\` | Why it was designed this way |
| \`grainChoice\` | Why this grain was chosen over alternatives |
| \`roleChoice\` | Why this model role was selected |
| \`scdStrategy\` | Overall SCD strategy across dimension attributes |
| \`measures\` | Why measures are structured this way |

---

## Building Models from External Sources

When the user asks you to create a new model — or materially add columns to an existing one — from an external source (planning doc, DDL, staging SQL, CSV, notebook, or another YAML), follow this protocol. It exists to prevent silent column truncation.

**Does NOT apply to:** renaming a column, changing a single flag, or executing an \`.erd-studio/.sync-plan.json\` (see SYNC.md for that workflow).

### Step 1 — Read the source fully, then enumerate
Before listing anything, confirm you have read the source **in full**. For files longer than 2000 lines, page through with \`Read\` using \`offset\`/\`limit\` until you reach the end of the file. A partial read is a silent-truncation trap before you even start — the columns you never saw cannot appear in your output.

Then list every source column in order, with a total count. Do not summarise or elide:

> Source \`models/staging/stg_customer.sql\` has **47 columns**:
> 1. customer_id
> 2. email
> …

For wide tables (50+ columns), group the list in numbered chunks of 50 so you and the user can verify nothing was dropped mid-list. Tables over 100 columns are common in EDW staging — the chunking exists for exactly this case.

If you cannot identify a source, stop and ask which source to build from before listing.

### Step 2 — State scope
State which of those columns you intend to build, in plain English.

> Proposed scope: **all 47 columns**.
> — or —
> Proposed scope: **23 of 47 columns** (PK, NKs, and measures; excluding audit columns and deprecated fields).

Proceed straight to step 3 — do not wait for confirmation. The user will correct you if the scope is wrong.

### Step 3 — Build
Write the model's YAML file — the existing file if the model already exists (in whichever folder it is in), otherwise a new file — \`.erd-studio/logical-models/{layer}/{name}.yml\` for the layer of the target domain when the project uses layer folders, else \`.erd-studio/logical-models/{name}.yml\` (see "Model file location").

### Step 4 — Reconcile via set-difference
Re-read the YAML file you just wrote. Compute the set-difference between source columns and YAML columns — do not rely on a total count alone, because counts can coincidentally match while columns still differ.

Report in this exact form:

> Reconcile: \`dim_customer.yml\` has **M** columns; source has **N**.
>
> **In source but not in YAML** (K): \`created_at\` (audit — not modelled), \`updated_at\` (audit), \`_dbt_source_relation\` (dbt internal).
>
> **In YAML but not in source** (J): \`customer_sk\` (synthesised surrogate key), \`loaded_at\` (added for SCD2 tracking).

Every entry in "in source but not in YAML" must have a specific reason. A class-level reason already declared in Step 2 (e.g. "excluding audit columns") is sufficient — you don't need to restate it per column. But an unexplained entry, or a vague reason like "not needed", means **stop and tell the user** that a column may have been dropped unintentionally. Do not claim the task is complete.

**Rule of thumb:** if your reconcile message doesn't name specific columns on both sides, you skipped a step.

---

## Columns

| Field | Required | Description |
|-------|----------|-------------|
| \`name\` | Yes | Column identifier |
| \`dataType\` | Yes | SQL type: \`INT\`, \`INTEGER\`, \`VARCHAR\`, \`STRING\`, \`FLOAT\`, \`BOOLEAN\`, \`DATE\`, \`DECIMAL(18,2)\`, \`TIMESTAMP_NTZ\`, etc. |
| \`description\` | Yes | Human-readable description |
| \`isPrimaryKey\` | No | Primary key. Only include when \`true\`. |
| \`isForeignKey\` | No | Foreign key intent. Only include when \`true\`. |
| \`isNaturalKey\` | No | Business identifier (email, SKU, etc.). Only include when \`true\`. |
| \`scdType\` | No | SCD type for dimensions: \`0\` = fixed/never changes, \`1\` = overwrite, \`2\` = track history |
| \`additiveType\` | No | Fact measures: \`"additive"\`, \`"semi-additive"\`, \`"non-additive"\` |

**Boolean flags** (\`isPrimaryKey\`, \`isForeignKey\`, \`isNaturalKey\`): omit rather than setting to \`false\`.

---

## Relationships

\`\`\`json
{
  "fromModel": "fct_orders",
  "fromColumn": "customer_id",
  "toModel": "dim_customer",
  "toColumn": "customer_id",
  "cardinality": "many-to-one"
}
\`\`\`

| Field | Required | Description |
|-------|----------|-------------|
| \`fromModel\` | Yes | FK side model name |
| \`fromColumn\` | Yes | FK column name |
| \`toModel\` | Yes | PK side model name |
| \`toColumn\` | Yes | PK column name |
| \`cardinality\` | Yes | \`many-to-one\`, \`one-to-one\`, \`one-to-many\`, or \`many-to-many\` |

**Direction:** \`fromModel\` is always the FK side, \`toModel\` is the PK side. FK column names should match the PK column name of the referenced table.

---

## Naming Conventions

| Type | Prefix | PK Pattern | Example |
|------|--------|-----------|---------|
| Dimension | \`dim_\` | \`{entity}_id\` | \`dim_customer\` → PK \`customer_id\` |
| Fact | \`fct_\` | \`{entity}_id\` or composite | \`fct_order\` → PK \`order_id\` |
| Reference | \`ref_\` | \`ref_{entity}_code\` | \`ref_country\` → PK \`ref_country_code\` |
| Bridge | \`brg_\` | composite FK pair | \`brg_project_contact\` |

---

## Physical Stage (Read-Only)

The physical stage has **no files on disk**. It is derived at runtime from the dbt project itself — source files, schema \`.yml\` files, \`{target-path}/manifest.json\` and \`{target-path}/catalog.json\`. None of those four is required, and in particular a project that has never been compiled still renders real models.

1. **Existence**: a model is real (not a ghost) when **any** of these holds:
   - a \`<name>.sql\`, \`<name>.py\` or \`<name>.csv\` file sits under a configured \`model-paths\`, \`seed-paths\` or \`snapshot-paths\` directory (so seeds and snapshots count), **and** dbt has not disabled the model;
   - a dbt schema \`.yml\` under \`model-paths\` declares it;
   - the compiled manifest carries a node for it;
   - \`catalog.json\` carries a relation for it.

   A model found in **none** of those is still drawn, as a **ghost** with no columns — the design references something the dbt project does not have. A model dbt has **disabled** lands in the manifest's \`disabled\` section and \`ref()\` to it fails, so a bare source file does not make it exist; with no other evidence it ghosts with a "disabled" reason. Ghosting therefore means "not in your dbt project", never "you have not run \`dbt compile\` lately".
2. **Columns** come from two *kinds* of source. The **declared** list is the schema \`.yml\` when there is one, otherwise the manifest's copy of it — one source, because the manifest's column list is a compiled copy of the same yml patch, so where they disagree the manifest is merely stale. The **observed** list is \`catalog.json\`, an independent look at the warehouse relation. When a catalog relation resolves, the rendered list is their **union**: catalog order first, then any declared column the catalog has not seen. With no catalog it is the declared list alone. The catalog is only as fresh as the last \`dbt docs generate\`, which is exactly why it never *replaces* the declared list: a column added to the SQL and the yml an hour ago would otherwise vanish from physical and be proposed for deletion. A column in both keeps the **declared** spelling (Snowflake reports UPPERCASE keys; they never win the label).
3. **Data types** are an ordered fallthrough per column: \`catalog.json\`, then the declared \`data_type:\`, then the manifest's copy of it, then blank. A column typed on only one stage is reported as **\`undeclared\`**, not as a type mismatch — writing \`data_type:\` into the schema yml (or running \`dbt docs generate\`) is what fills it in. Comparison understands warehouse spellings (\`NUMBER\`, \`character varying(255)\`, \`timestamp without time zone\`, \`ARRAY<...>\`), and treats a whole-number \`NUMBER\`/\`decimal\` as an integer.
4. **Descriptions**: the \`.yml\` description, then the manifest's, then the catalog's column \`comment\` — the human's words beat the warehouse's echo of them, since \`persist_docs\` writes the dbt description *into* that comment.
5. **Schema name**: manifest \`schema\`, then the catalog's \`metadata.schema\`, then blank. It cannot be derived from the filesystem (it needs \`generate_schema_name\` and \`profiles.yml\`), so with neither artifact the node badge falls back to the ERD **layer** abbreviation and says so — "physical works without dbt" does **not** extend to schema names.
6. **Provenance**: every real physical model records which sources contributed its columns and which one supplied its types, shown as a chip on the node (WH = warehouse catalog, YML = your dbt \`.yml\`, DBT = the dbt manifest, SQL = the source file only) and spelled out in the detail panel. Runtime only — never written to disk.
7. **Relationships**: derived from **dbt relationship tests** — the union of those declared in \`.yml\` files and those in the manifest, deduped; never copied from logical. \`catalog.json\` holds no constraint or foreign-key information, so it contributes no edges.
8. **Cardinality**: derived from **uniqueness tests** merged from yml and manifest — no \`unique\` test = "many" side.
9. **Scoping**: only relationships between models **within the same domain** appear. References to models outside the domain are silently excluded.
10. **Carried forward from logical**: PK/FK/NK flags, grain, modelRole, scdType and additiveType — dbt yml does not carry them.

A model known **only** by the file that defines it renders as a real node with **zero columns**: nothing has stated its shape, and seeding it from the logical design would invent one. Sync comparison skips such a model entirely rather than reporting every logical column as missing. That suppression is automatic and distinct from \`stubColumns\`, which is the user's own switch for models they know are deliberately partial.

### Cardinality Derivation

| FK has \`unique\` test? | PK has \`unique\` test? | Result |
|------------------------|------------------------|--------|
| No | Yes | \`many-to-one\` |
| Yes | Yes | \`one-to-one\` |
| Yes | No | \`one-to-many\` |
| No | No | \`many-to-many\` |

For composite keys, \`dbt_utils.unique_combination_of_columns\` is recognized when **all** columns in the group are covered by relationship tests between the same model pair.

Recognized test types: \`relationships\`, \`relationships_where\`, and any test whose name starts with \`relationships\`.

### Implementing Logical → Physical

| Logical Element | dbt YAML Required |
|----------------|-------------------|
| PK column | \`unique\` + \`not_null\` tests |
| FK column | \`relationships\` test to PK model/column |
| Cardinality | \`unique\` test on PK column + \`relationships\` test on FK column |
| Composite PK | \`dbt_utils.unique_combination_of_columns\` model-level test |

---

## Sync Reconciliation

When asked to execute a sync plan, or when \`.erd-studio/.sync-plan.json\` exists:

1. Read \`SYNC.md\` in the same directory as this skill file for the full action reference and execution guide
2. Read \`.erd-studio/.sync-plan.json\` for the specific actions to execute
3. Follow the execution steps in SYNC.md to reconcile logical and physical models`;

// ---------------------------------------------------------------------------
// Sync guide content (companion file — loaded on demand)
// ---------------------------------------------------------------------------

const SYNC_CONTENT = `# ERD Studio — Sync Reconciliation Guide

This guide is loaded when you need to execute a sync plan generated by ERD Studio.
The sync plan reconciles differences between the **logical** (user-defined) and
**physical** (derived from your dbt project) stages of a domain.

## When to Use

When \`.erd-studio/.sync-plan.json\` exists in the project, the user has reviewed
logical-vs-physical discrepancies in ERD Studio and chosen which side is "ground truth"
for each difference. Your job is to execute those choices.

## Reading the Plan

\`\`\`json
{
  "generatedAt": "2025-01-15T10:30:00.000Z",
  "domain": "customer-360",
  "layer": "silver",
  "sourceStage": "logical",
  "targetStage": "physical",
  "modelContext": {
    "dim_customer": {
      "modelName": "dim_customer",
      "logicalModelPath": ".erd-studio/logical-models/silver/dim_customer.yml",
      "dbtSqlPath": "models/silver/dim_customer.sql",
      "dbtSchemaPath": "models/silver/dim_customer.yml"
    }
  },
  "models": [],
  "columns": [
    {
      "modelName": "dim_customer",
      "columnName": "region_code",
      "discrepancyStatus": "extra",
      "groundTruth": "logical",
      "action": "add-column-to-physical",
      "sourceDataType": "VARCHAR",
      "resolvedDataType": "VARCHAR"
    }
  ],
  "relationships": [],
  "requiresCompile": true
}
\`\`\`

Key fields:
- **modelContext**: File paths for every model referenced — use these to locate files to edit
- **models/columns/relationships**: Arrays of resolved discrepancies with concrete actions
- **requiresCompile**: If \`true\`, run \`dbt compile\` after making physical-side changes
- **resolvedDataType**: The type to WRITE. Always use this for the two
  \`update-type-*\` actions. \`sourceDataType\` / \`targetDataType\` are named for the
  comparison direction, so which of them holds the ground-truth value flips when
  the plan was generated from the physical stage — \`resolvedDataType\` never does.

## Action Reference

A column entry whose \`discrepancyStatus\` is \`undeclared\` means only one stage
declares a data type at all — most often a dbt schema yml with no \`data_type:\`
and no \`catalog.json\` to observe the real one. It resolves exactly like
\`type-mismatch\`: copy the declared type onto the side that has none.

### Logical-side actions (edit ERD Studio files)

| Action | What to do |
|--------|-----------|
| \`add-to-logical\` | Add model name to domain JSON \`logical.models[]\` + create the model file from manifest data — \`logical-models/{layer}/{name}.yml\` (the plan's \`layer\`) when the project uses layer folders, else \`logical-models/{name}.yml\` — unless a file for that name already exists in any folder |
| \`remove-from-logical\` | Remove model name from domain JSON \`logical.models[]\` + remove related relationships from \`logical.relationships[]\` |
| \`add-column-to-logical\` | Add column to the model's yml (\`modelContext[name].logicalModelPath\`) columns array |
| \`remove-column-from-logical\` | Remove column from the model's yml (\`logicalModelPath\`) |
| \`update-type-in-logical\` | Update column \`dataType\` in the model's yml (\`logicalModelPath\`) to the value in \`resolvedDataType\` |
| \`add-relationship-to-logical\` | Add relationship object to domain JSON \`logical.relationships[]\` using the fromModel/fromColumn/toModel/toColumn from the action |
| \`remove-relationship-from-logical\` | Remove the matching relationship from domain JSON \`logical.relationships[]\` |
| \`update-cardinality-in-logical\` | Update \`cardinality\` field on matching relationship in domain JSON to \`targetCardinality\` |

### Physical-side actions (edit dbt project files)

| Action | What to do |
|--------|-----------|
| \`add-to-physical\` | Create dbt SQL model file + schema YAML entry (confirm with user first — this is a major change). If the logical model has an \`alias\`, set \`config: { alias: <alias> }\` on the dbt model (and its \`schema\` if set) so it builds the same table name |
| \`remove-from-physical\` | Remove dbt SQL file + schema YAML entry (confirm with user first — destructive) |
| \`add-column-to-physical\` | Add column to the dbt SQL SELECT statement + add column entry to schema YAML |
| \`remove-column-from-physical\` | Remove column from dbt SQL SELECT + schema YAML (confirm with user first) |
| \`update-type-in-physical\` | Update column casting in dbt SQL or \`data_type\` in schema YAML to \`resolvedDataType\` |
| \`add-relationship-test-to-physical\` | Add \`relationships\` test to dbt schema YAML (see format below) |
| \`remove-relationship-test-from-physical\` | Remove the \`relationships\` test from dbt schema YAML |
| \`update-cardinality-in-physical\` | Add/remove \`unique\` test on FK column in dbt schema YAML to match target cardinality |

## dbt Relationship Test Format

When adding a \`relationships\` test, use this standard dbt YAML format:

\`\`\`yaml
models:
  - name: fct_orders
    columns:
      - name: customer_id
        tests:
          - relationships:
              to: ref('dim_customer')
              field: customer_id
\`\`\`

## Execution Steps

1. **Read** \`.erd-studio/.sync-plan.json\`
2. **Execute each action** in order:
   - For logical-side actions: edit files at \`modelContext[modelName].logicalModelPath\` and/or the domain JSON
   - For physical-side actions: edit files at \`modelContext[modelName].dbtSqlPath\` and \`dbtSchemaPath\`
   - For destructive actions (\`remove-*\`): confirm with the user before proceeding
3. **Compile** if \`requiresCompile\` is \`true\`: run \`dbt compile\` to regenerate the manifest
4. **Verify**: Re-open the domain in ERD Studio and run the diff comparison to confirm discrepancies are resolved
5. **Clean up**: Delete \`.erd-studio/.sync-plan.json\` on success

## Important Notes

- **Preserve viewConfig.positions**: Never clear or overwrite layout positions in domain JSON
- **Match existing patterns**: When editing dbt YAML, follow the formatting and test patterns already present in the file
- **Cascade deletions**: When removing a model from logical, also remove any relationships referencing it
- **Column ordering**: When adding columns to logical-models YAML, append to the end of the columns array`;

// ---------------------------------------------------------------------------
// Format-specific generators
// ---------------------------------------------------------------------------

/**
 * The schema skill. Its frontmatter is only \`name\` + \`description\`, which
 * is portable, so the same text installs for Claude Code
 * (\`.claude/skills/erd-studio/\`) and for the Agent Skills tools
 * (\`.agents/skills/erd-studio/\`).
 */
function generateClaudeSkill(): string {
  return `---
name: erd-studio
description: >-
  Schema rules for ERD Studio data model files — the .erd-studio/ directory
  uses a two-file system (YAML model definitions + JSON domain diagrams)
  with strict format rules you must read before editing. Use this skill
  whenever the task touches files in .erd-studio/ (domain JSON, logical-models
  YAML, or .sync-plan.json), asks to add/edit/remove models, columns,
  relationships, or cardinality in a data model or ERD diagram, mentions
  dim_/fct_/ref_/brg_ prefixed tables in an erd-studio context, or involves
  writing dbt schema YAML tests to match an ERD physical stage. The skill
  tells you which of the two files to edit for each operation — without it
  you will put data in the wrong file.
---

${SCHEMA_CONTENT}

${buildVersionMarker()}
`;
}

function generateEnforceSkillHook(): string {
  return [
    '#!/usr/bin/env bash',
    '# ERD Studio — PreToolUse hook for Edit and Write tools.',
    '# Blocks the first .erd-studio file edit per Claude Code session to ensure the',
    '# /erd-studio skill is loaded before any changes are made. Every other call',
    '# exits 0 with NO output, so Claude Code\'s normal permission flow decides —',
    '# this hook only ever denies, it never approves an edit.',
    '',
    'deny=\'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"ERD Studio: load the /erd-studio skill (file-format rules) before editing .erd-studio files, then retry. This is a one-time check per session — the /erd-studio-setup walkthrough expects it."}}\'',
    '',
    '# Read all stdin (Claude sends hook input JSON via stdin)',
    'input="$(cat)"',
    '',
    '# Extract fields from JSON using grep (avoids jq/python dependency)',
    'tool_name="$(echo "$input" | grep -o \'"tool_name" *: *"[^"]*"\' | head -1 | sed \'s/.*: *"//;s/"$//\')"',
    '# Claude Code\'s own Edit and Write only. Copilot can run this hook too when',
    '# it reads Claude hooks (chat.useClaudeHooks), and it ignores the matcher,',
    '# so every other tool name is waved through here.',
    'case "$tool_name" in',
    '  Edit|Write) ;;',
    '  *) exit 0 ;;',
    'esac',
    'file_path="$(echo "$input" | grep -o \'"file_path" *: *"[^"]*"\' | head -1 | sed \'s/.*: *"//;s/"$//\')"',
    'session_id="$(echo "$input" | grep -o \'"session_id" *: *"[^"]*"\' | head -1 | sed \'s/.*: *"//;s/"$//\')"',
    '',
    '# Only act on files inside .erd-studio/ directories. modelling-approach.md is',
    '# free-form notes with no file format, so it needs no skill loaded first.',
    'case "$file_path" in',
    '  */.erd-studio/modelling-approach.md) ;;',
    '  */.erd-studio/*)',
    '    flag="/tmp/.erd-studio-skill-${session_id}"',
    '    if [ ! -f "$flag" ]; then',
    '      touch "$flag"',
    '      echo "$deny"; exit 0',
    '    fi',
    '    ;;',
    'esac',
    '',
    '# Not ours to decide: no output, normal permission flow.',
    'exit 0',
  ].join('\n') + '\n';
}

function generateSyncGuide(): string {
  return `${SYNC_CONTENT}

${buildVersionMarker()}
`;
}

function generateCopilotInstructions(): string {
  return `---
name: 'ERD Studio'
description: 'Data modeling guide for ERD Studio — domain JSON format, dbt YAML tests for physical model, naming conventions'
applyTo: '**/.erd-studio/**'
---

${SCHEMA_CONTENT}

${buildVersionMarker()}
`;
}

function generateGeminiStyleguide(): string {
  return `${SCHEMA_CONTENT}

## Code Review Rules

### ERD Studio Domain Files (\`.erd-studio/**/*.json\`)

1. **Schema version** must be \`5\`
2. **Required sections**: \`logical\` and \`viewConfig\` must both be present at root level
3. **Model names** must follow naming conventions: \`dim_\`, \`fct_\`, \`ref_\`, or \`brg_\` prefixes
4. **Relationships**: \`fromModel\` is always the FK side, \`toModel\` is the PK side
5. **Logical columns** must have \`dataType\` and \`description\`
6. **viewConfig** must be at root level (not inside the logical section)
7. **Boolean key flags** (\`isPrimaryKey\`, \`isForeignKey\`, \`isNaturalKey\`) should only be present when \`true\`

### dbt YAML Schema Files

8. **PK columns** in logical model should have \`unique\` + \`not_null\` tests in dbt YAML
9. **FK columns** in logical model should have a \`relationships\` test pointing to the PK model/column
10. **Composite keys** should use \`dbt_utils.unique_combination_of_columns\` model-level test

${buildVersionMarker()}
`;
}

function generateCodexAgents(): string {
  return `
${CODEX_REGION_BEGIN}
${CODEX_SECTION_HEADING}

${SCHEMA_CONTENT}

${buildVersionMarker()}
${CODEX_REGION_END}
`;
}

/**
 * Locate the ERD Studio-managed region inside an existing AGENTS.md.
 *
 * Prefers the BEGIN/END region markers. Falls back to the pre-v16 layout
 * (heading … version marker, no region markers) so users upgrading from an
 * older harness still get an in-place replacement rather than a duplicate
 * section. Returns `null` when no managed region can be identified.
 */
export function findCodexRegion(content: string): { start: number; end: number } | null {
  const beginIdx = content.indexOf(CODEX_REGION_BEGIN);
  if (beginIdx !== -1) {
    const endIdx = content.indexOf(CODEX_REGION_END, beginIdx);
    if (endIdx !== -1) {
      return { start: beginIdx, end: endIdx + CODEX_REGION_END.length };
    }
  }

  const headingIdx = content.indexOf(CODEX_SECTION_HEADING);
  if (headingIdx === -1) { return null; }
  const markerRe = /<!-- erd-studio-harness: .+? -->/g;
  markerRe.lastIndex = headingIdx;
  const markerMatch = markerRe.exec(content);
  if (!markerMatch) { return null; }
  return { start: headingIdx, end: markerMatch.index + markerMatch[0].length };
}

/**
 * Splice freshly generated Codex content into an existing AGENTS.md,
 * replacing only the ERD Studio-managed region and preserving all other
 * user content. Appends when no managed region exists yet.
 */
export function mergeCodexContent(existing: string, generated: string): string {
  const region = findCodexRegion(existing);
  const block = generated.trim();
  if (!region) {
    const sep = existing.length === 0 || existing.endsWith('\n') ? '\n' : '\n\n';
    return existing + sep + block + '\n';
  }
  return existing.slice(0, region.start) + block + existing.slice(region.end);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const DEFAULT_SEMANTIC_DIR = '.erd-studio';

/**
 * Rewrite every reference to the default `.erd-studio` data directory in
 * generated harness content to the user's configured `erdStudio.semanticDir`.
 * Only the dotted directory token is touched; skill/hook names such as
 * `.claude/skills/erd-studio/` and the `/tmp/.erd-studio-skill-*` flag file
 * are left alone (no leading dot, or followed by `-`).
 */
export function applySemanticDir(content: string, semanticDir: string): string {
  const dir = semanticDir.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!dir || dir === DEFAULT_SEMANTIC_DIR) {
    return content;
  }
  return content.replace(/\.erd-studio(?![\w-])/g, dir);
}

const CLAUDE_HOOK_SCRIPT = '.claude/skills/erd-studio/enforce-skill.sh';
const CLAUDE_SETTINGS = '.claude/settings.local.json';
/**
 * The registered hook command. `$CLAUDE_PROJECT_DIR` makes the path work on
 * any machine; the guard makes it a no-op anywhere that variable is unset —
 * GitHub Copilot runs `.claude/settings.local.json` hooks when Claude hooks are
 * enabled in its settings, and would otherwise run `bash /.claude/…` and fail
 * on every tool call.
 */
const HOOK_COMMAND = '[ -n "$CLAUDE_PROJECT_DIR" ] && bash "$CLAUDE_PROJECT_DIR/.claude/skills/erd-studio/enforce-skill.sh" || true';

/** The per-folder paths of the two skill targets (`claude` → `.claude/skills/`, `agents` → `.agents/skills/`). */
interface SkillTargetPaths {
  schemaSkill: string;
  syncGuide: string;
  setupDir: string;
  setupSkill: string;
  /** The setup skill directory's ignore line (added only where the schema skill's is — see install()). */
  setupIgnore: string;
}

function skillTargetPaths(target: SkillHarnessTarget): SkillTargetPaths {
  const base = target === 'claude' ? '.claude/skills' : '.agents/skills';
  const setupDir = SETUP_SKILL_DIRS[target];
  return {
    schemaSkill: `${base}/erd-studio/SKILL.md`,
    syncGuide: `${base}/erd-studio/SYNC.md`,
    setupDir,
    setupSkill: `${setupDir}/SKILL.md`,
    setupIgnore: `${setupDir}/`,
  };
}

function isSkillTarget(id: HarnessTarget['id']): id is SkillHarnessTarget {
  return id === 'claude' || id === 'agents';
}

/**
 * The Claude target's version-marked files, workspace-relative: the schema
 * skill, its SYNC.md companion and the setup skill's SKILL.md. Staleness is
 * judged per file (see `detectStale`).
 */
export function claudeManagedFiles(): string[] {
  const p = skillTargetPaths('claude');
  return [p.schemaSkill, p.syncGuide, p.setupSkill];
}

/** The `agents` target's version-marked files: the same three, under `.agents/skills/`. */
export function agentsManagedFiles(): string[] {
  const p = skillTargetPaths('agents');
  return [p.schemaSkill, p.syncGuide, p.setupSkill];
}

/** Classify one harness file by its version marker. An unreadable file counts as unmanaged — never ours to replace. */
function fileState(filePath: string): FileState {
  if (!fs.existsSync(filePath)) { return 'missing'; }
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 'unmanaged';
  }
  const version = extractHarnessVersion(content);
  if (version === null) { return 'unmanaged'; }
  return version === HARNESS_VERSION ? 'current' : 'outdated';
}

/** Whether `.gitignore` already lists `pattern` (tolerating a leading `/` and a missing trailing `/`). */
function gitignoreLists(workspaceRoot: string, pattern: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(path.join(workspaceRoot, '.gitignore'), 'utf-8');
  } catch {
    return false;
  }
  const norm = (p: string) => p.trim().replace(/^\//, '').replace(/\/$/, '');
  const want = norm(pattern);
  return content.split('\n').some((line) => norm(line) === want);
}

export class HarnessService {
  /**
   * @param semanticDir — the configured `erdStudio.semanticDir`; generated
   *   files reference this directory instead of the default `.erd-studio`.
   */
  constructor(private readonly semanticDir: string = DEFAULT_SEMANTIC_DIR) {}

  /**
   * Generate the config file content for a given harness target.
   */
  generateContent(targetId: HarnessTarget['id']): string {
    return applySemanticDir(this.generateDefaultContent(targetId), this.semanticDir);
  }

  private generateDefaultContent(targetId: HarnessTarget['id']): string {
    switch (targetId) {
      case 'claude':
      case 'agents':
        return generateClaudeSkill();
      case 'copilot':
        return generateCopilotInstructions();
      case 'gemini':
        return generateGeminiStyleguide();
      case 'codex':
        return generateCodexAgents();
    }
  }

  /**
   * Install a harness config file into the workspace.
   *
   * For Codex (AGENTS.md), appends to an existing file on first install and
   * replaces only the BEGIN/END-delimited ERD Studio region on update —
   * user content elsewhere in AGENTS.md is always preserved.
   * For all others, creates the file (refusing to overwrite unless
   * `overwrite` is true).
   *
   * The two skill targets (`claude`, `agents`) also write companions: SYNC.md
   * and the `/erd-studio-setup` skill; `claude` additionally writes the
   * PreToolUse hook and its `.claude/settings.local.json` entry.
   *
   * `overwrite` is about the primary file only — the file the caller's
   * prompt named. The `/erd-studio-setup` companion has its own switch: a
   * hand-written setup SKILL.md is replaced only with
   * `replaceUnmanagedSetupSkill`, which only the Welcome panel's
   * Replace / Keep mine modal ever passes. `keepUnmanagedPrimary` is that
   * modal's "Keep mine": a hand-written primary SKILL.md is left alone while
   * every companion that is not hand-written is still installed.
   */
  install(
    workspaceRoot: string,
    target: HarnessTarget,
    overwrite: boolean = false,
    options: { replaceUnmanagedSetupSkill?: boolean; keepUnmanagedPrimary?: boolean } = {},
  ): HarnessInstallResult {
    const filePath = path.join(workspaceRoot, target.relativePath);
    const dir = path.dirname(filePath);
    const alreadyExisted = fs.existsSync(filePath);
    const skillTarget = isSkillTarget(target.id) ? target.id : null;
    const keepPrimary = options.keepUnmanagedPrimary === true && skillTarget !== null
      && alreadyExisted && fileState(filePath) === 'unmanaged';

    try {
      // Ensure parent directory exists
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const content = this.generateContent(target.id);

      if (target.id === 'codex' && alreadyExisted) {
        // AGENTS.md is a shared file: never replace it wholesale. Without
        // overwrite, leave an existing ERD section alone; with overwrite,
        // replace only the managed region (or append if there is none).
        const existing = fs.readFileSync(filePath, 'utf-8');
        const hasSection = findCodexRegion(existing) !== null;
        if (hasSection && !overwrite) {
          return {
            target,
            success: true,
            filePath,
            alreadyExisted: true,
            filesWritten: [],
          };
        }
        fs.writeFileSync(filePath, mergeCodexContent(existing, content), 'utf-8');
      } else if (keepPrimary) {
        // "Keep mine": the user's SKILL.md stays exactly as it is.
      } else if (alreadyExisted && !overwrite) {
        return {
          target,
          success: false,
          filePath,
          alreadyExisted: true,
          error: 'File already exists',
        };
      } else {
        fs.writeFileSync(filePath, content, 'utf-8');
      }

      const rel = (p: string) => path.relative(workspaceRoot, p).split(path.sep).join('/');
      const filesWritten: string[] = keepPrimary ? [] : [rel(filePath)];

      // Companion files for the two skill targets
      let setupDirExisted = true;
      if (skillTarget) {
        const paths = skillTargetPaths(skillTarget);
        // SYNC.md — progressive context loading for sync plan execution.
        // Under "Keep mine" a hand-written SYNC.md is kept too.
        const syncPath = path.join(dir, 'SYNC.md');
        if (!(keepPrimary && fileState(syncPath) === 'unmanaged')) {
          fs.writeFileSync(syncPath, applySemanticDir(generateSyncGuide(), this.semanticDir), 'utf-8');
          filesWritten.push(rel(syncPath));
        }

        if (skillTarget === 'claude') {
          // enforce-skill.sh — PreToolUse hook that blocks first .erd-studio edit
          // per session so Claude loads the /erd-studio skill before making changes.
          // Claude Code only: the other tools' hook formats differ.
          const hookPath = path.join(dir, 'enforce-skill.sh');
          fs.writeFileSync(hookPath, applySemanticDir(generateEnforceSkillHook(), this.semanticDir), { mode: 0o755 });
          filesWritten.push(rel(hookPath));

          // Merge hook config into .claude/settings.local.json (local only, never committed)
          try {
            if (this.mergeHookConfig(workspaceRoot)) { filesWritten.push(CLAUDE_SETTINGS); }
          } catch {
            // Best-effort — don't fail install if settings merge fails
          }
        }

        // /erd-studio-setup — the onboarding skill, a companion of this target.
        // Checked before writing so the ignore step below knows whether
        // this is the directory's first appearance (upgraders included).
        setupDirExisted = fs.existsSync(path.join(workspaceRoot, paths.setupDir));
        filesWritten.push(...this.writeSetupSkill(workspaceRoot, skillTarget, options.replaceUnmanagedSetupSkill === true));
      }

      // Add to .gitignore on first install only — subsequent updates and
      // version bumps skip this so the user can remove the entry if they
      // want the harness files tracked in version control. The `.agents/`
      // target has no pattern and is never ignored (Gemini CLI cannot read
      // an ignored file — see its HARNESS_TARGETS entry).
      if (!alreadyExisted && target.gitignorePattern) {
        try {
          if (this.addToGitignore(workspaceRoot, target.gitignorePattern)) { filesWritten.push('.gitignore'); }
        } catch {
          // Best-effort — don't fail the install if .gitignore is unwritable
        }
      }

      // The setup skill follows the user's existing choice for the schema
      // skill in the same folder: it is ignored only while that directory is.
      // Keyed on the setup directory's first appearance rather than the
      // primary file's, so users upgrading from v17 get the line too.
      if (skillTarget && !setupDirExisted && target.gitignorePattern
        && gitignoreLists(workspaceRoot, target.gitignorePattern)) {
        try {
          if (this.addToGitignore(workspaceRoot, skillTargetPaths(skillTarget).setupIgnore)
            && !filesWritten.includes('.gitignore')) {
            filesWritten.push('.gitignore');
          }
        } catch {
          // Best-effort — don't fail the install if .gitignore is unwritable
        }
      }

      return {
        target,
        success: true,
        filePath,
        alreadyExisted,
        filesWritten,
      };
    } catch (err) {
      return {
        target,
        success: false,
        filePath,
        alreadyExisted,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Write the `/erd-studio-setup` skill into one target's folder.
   * `applySemanticDir` rewrites data-directory references but leaves the
   * `~/.erd-studio-cli` launcher path alone (its `(?![\w-])` lookahead); the
   * version marker is appended to SKILL.md only, and SKILL.md's frontmatter
   * is cut to the portable fields for `.agents/` (`skillForTarget`). An
   * existing SKILL.md with no marker is the user's: unless `replaceUnmanaged`
   * is set, none of the skill's files are touched. Returns the
   * workspace-relative paths written.
   */
  private writeSetupSkill(workspaceRoot: string, target: SkillHarnessTarget, replaceUnmanaged: boolean): string[] {
    const paths = skillTargetPaths(target);
    if (!replaceUnmanaged && fileState(path.join(workspaceRoot, paths.setupSkill)) === 'unmanaged') {
      return [];
    }
    const written: string[] = [];
    for (const [relativePath, content] of this.setupSkillFiles(target)) {
      const filePath = path.join(workspaceRoot, ...paths.setupDir.split('/'), ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
      written.push(`${paths.setupDir}/${relativePath}`);
    }
    return written;
  }

  /**
   * The setup skill's files exactly as `install()` writes them for `target`:
   * `[path relative to the skill directory, content]`. Exposed for tests and
   * for anything that needs to show the installed text without writing it.
   */
  setupSkillFiles(target: SkillHarnessTarget): Array<[string, string]> {
    return SETUP_SKILL_FILES.map((asset) => {
      let content = applySemanticDir(asset.content, this.semanticDir);
      if (asset.relativePath === 'SKILL.md') { content = skillForTarget(content, target); }
      if (asset.versioned) {
        content = content.replace(/\s*$/, '') + '\n\n' + buildVersionMarker() + '\n';
      }
      return [asset.relativePath, content];
    });
  }

  /**
   * Add a pattern to the workspace .gitignore if not already present.
   * Only called on first install — subsequent updates skip this so users
   * who remove the entry don't have it re-added. Returns whether the file
   * was changed.
   */
  private addToGitignore(workspaceRoot: string, pattern: string): boolean {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
      // Check if the pattern is already present (exact line match)
      const lines = content.split('\n').map(l => l.trim());
      if (lines.includes(pattern)) { return false; }
    }

    const section = '\n# ERD Studio AI coding harness (auto-generated, safe to remove)\n' + pattern + '\n';

    // If there's already an ERD Studio section, append the pattern there
    const sectionHeader = '# ERD Studio AI coding harness';
    if (content.includes(sectionHeader)) {
      // Find the section and append the pattern after the last ERD Studio entry
      const lines = content.split('\n');
      let insertIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(sectionHeader)) {
          // Walk forward past the header and any existing patterns
          insertIndex = i + 1;
          while (insertIndex < lines.length && lines[insertIndex].trim() !== '' && !lines[insertIndex].startsWith('#')) {
            insertIndex++;
          }
          break;
        }
      }
      if (insertIndex >= 0) {
        lines.splice(insertIndex, 0, pattern);
        fs.writeFileSync(gitignorePath, lines.join('\n'), 'utf-8');
        return true;
      }
    }

    // No existing section — append a new one
    const needsLeadingNewline = content.length > 0 && !content.endsWith('\n');
    fs.appendFileSync(gitignorePath, (needsLeadingNewline ? '\n' : '') + section, 'utf-8');
    return true;
  }

  /**
   * Check which harness configs already exist in the workspace.
   */
  detectExisting(workspaceRoot: string): Map<HarnessTarget['id'], boolean> {
    const result = new Map<HarnessTarget['id'], boolean>();
    for (const target of HARNESS_TARGETS) {
      const filePath = path.join(workspaceRoot, target.relativePath);
      result.set(target.id, fs.existsSync(filePath));
    }
    return result;
  }

  /**
   * Detect installed harness files whose embedded version differs from the
   * current HARNESS_VERSION.  Returns only targets that exist, carry a
   * version marker (i.e. were written by this extension) AND are stale.
   *
   * Files with NO marker are treated as unmanaged — a hand-written
   * `.gemini/styleguide.md` or AGENTS.md is the user's, not ours — and are
   * never reported (so they are never offered for overwrite at activation).
   */
  detectStale(workspaceRoot: string): HarnessTarget[] {
    const stale: HarnessTarget[] = [];
    for (const target of HARNESS_TARGETS) {
      const filePath = path.join(workspaceRoot, target.relativePath);
      if (!fs.existsSync(filePath)) { continue; }

      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      // For Codex, only consider it an ERD Studio harness if our section exists
      if (target.id === 'codex' && findCodexRegion(content) === null) {
        continue;
      }

      const version = extractHarnessVersion(content);
      if (version === null) {
        // Unmanaged file — leave it alone.
        continue;
      }
      if (version !== HARNESS_VERSION) {
        stale.push(target);
      } else if (isSkillTarget(target.id) && this.skillCompanionsStale(workspaceRoot, target.id)) {
        stale.push(target);
      }
    }
    return stale;
  }

  /**
   * Per-file staleness of a managed skill install's companions. SYNC.md
   * missing or carrying another marker is stale, so a partial install gets
   * repaired. The setup skill is stale only when it carries another marker:
   * a *missing* one is reported by `harnessStatus()` instead (the v18
   * "Update All" writes it anyway), and an unmarked one is the user's.
   */
  private skillCompanionsStale(workspaceRoot: string, target: SkillHarnessTarget): boolean {
    const paths = skillTargetPaths(target);
    const sync = fileState(path.join(workspaceRoot, paths.syncGuide));
    if (sync === 'missing' || sync === 'outdated') { return true; }
    return fileState(path.join(workspaceRoot, paths.setupSkill)) === 'outdated';
  }

  /** Schema skill (folding in SYNC.md) and setup skill state for one skill folder. */
  private skillFolderStatus(workspaceRoot: string, target: SkillHarnessTarget): { schemaSkill: FileState; setupSkill: FileState } {
    const paths = skillTargetPaths(target);
    let schemaSkill = fileState(path.join(workspaceRoot, paths.schemaSkill));
    if (schemaSkill === 'current') {
      const sync = fileState(path.join(workspaceRoot, paths.syncGuide));
      if (sync === 'missing' || sync === 'outdated') { schemaSkill = 'outdated'; }
    }
    return { schemaSkill, setupSkill: fileState(path.join(workspaceRoot, paths.setupSkill)) };
  }

  /**
   * Per-file state of every harness target, for the Welcome panel and the
   * CLI's `doctor`. Each skill folder's `schemaSkill` folds in SYNC.md: a
   * current SKILL.md whose SYNC.md is missing or outdated reads as
   * `outdated`. Codex is `missing` while AGENTS.md has no ERD Studio region
   * (appending one is always safe there), so it is never `unmanaged`.
   */
  harnessStatus(workspaceRoot: string): HarnessStatus {
    let codex: FileState = 'missing';
    try {
      const agents = fs.readFileSync(path.join(workspaceRoot, 'AGENTS.md'), 'utf-8');
      const region = findCodexRegion(agents);
      if (region !== null) {
        const version = extractHarnessVersion(agents.slice(region.start, region.end));
        codex = version === HARNESS_VERSION ? 'current' : 'outdated';
      }
    } catch {
      // No AGENTS.md (or unreadable) — nothing of ours there.
    }

    const targetPath = (id: HarnessTarget['id']) =>
      path.join(workspaceRoot, HARNESS_TARGETS.find((t) => t.id === id)!.relativePath);

    return {
      claude: {
        ...this.skillFolderStatus(workspaceRoot, 'claude'),
        hookRegistered: fs.existsSync(path.join(workspaceRoot, CLAUDE_HOOK_SCRIPT))
          && this.isHookRegistered(workspaceRoot),
      },
      agents: this.skillFolderStatus(workspaceRoot, 'agents'),
      copilot: fileState(targetPath('copilot')),
      gemini: fileState(targetPath('gemini')),
      codex,
    };
  }

  /**
   * One-click install for the Welcome panel. `assistants` (the detected AI
   * assistants) picks the skill folders via `recommendedSkillTargets()`:
   * `.claude/skills/` for Claude Code, `.agents/skills/` for any other, both
   * when none is detected (or `assistants` is omitted). Each folder gets its
   * schema skill, SYNC.md and setup skill; the Claude one also gets the hook
   * and settings merge.
   *
   * Writes nothing and returns `needs-confirmation` when any selected
   * SKILL.md exists without a marker and neither `replaceUnmanaged` nor
   * `keepUnmanaged` is set; returns `unchanged` when every selected folder is
   * current (and, for Claude, the hook is registered). `keepUnmanaged`
   * ("Keep mine") installs everything that is not hand-written and leaves
   * each hand-written SKILL.md exactly as it is.
   */
  installRecommended(
    workspaceRoot: string,
    options: { replaceUnmanaged: boolean; keepUnmanaged?: boolean; assistants?: readonly AiAssistantId[] },
  ): RecommendedInstallResult {
    const targets = recommendedSkillTargets(options.assistants ?? []);
    let status: HarnessStatus;
    try {
      status = this.harnessStatus(workspaceRoot);
    } catch (err) {
      return { status: 'failed', unmanaged: [], filesWritten: [], targets, error: err instanceof Error ? err.message : String(err) };
    }

    const unmanaged: string[] = [];
    for (const t of targets) {
      const paths = skillTargetPaths(t);
      if (status[t].schemaSkill === 'unmanaged') { unmanaged.push(paths.schemaSkill); }
      if (status[t].setupSkill === 'unmanaged') { unmanaged.push(paths.setupSkill); }
    }
    const keep = options.keepUnmanaged === true && !options.replaceUnmanaged;
    if (unmanaged.length > 0 && !options.replaceUnmanaged && !keep) {
      return { status: 'needs-confirmation', unmanaged, filesWritten: [], targets };
    }

    const upToDate = (t: SkillHarnessTarget) => status[t].schemaSkill === 'current' && status[t].setupSkill === 'current'
      && (t !== 'claude' || status.claude.hookRegistered);
    if (targets.every(upToDate)) {
      return { status: 'unchanged', unmanaged: [], filesWritten: [], targets };
    }

    const filesWritten: string[] = [];
    for (const t of targets) {
      if (upToDate(t)) { continue; }
      const target = HARNESS_TARGETS.find((h) => h.id === t)!;
      const result = this.install(workspaceRoot, target, true, {
        replaceUnmanagedSetupSkill: options.replaceUnmanaged,
        keepUnmanagedPrimary: keep,
      });
      for (const f of result.filesWritten ?? []) {
        if (!filesWritten.includes(f)) { filesWritten.push(f); }
      }
      if (!result.success) {
        return { status: 'failed', unmanaged: [], filesWritten, targets, error: result.error };
      }
    }
    return {
      status: targets.every((t) => status[t].schemaSkill === 'missing') ? 'installed' : 'updated',
      unmanaged: [],
      filesWritten,
      targets,
    };
  }

  /** Whether `.claude/settings.local.json` registers the `enforce-skill.sh` PreToolUse hook. */
  private isHookRegistered(workspaceRoot: string): boolean {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(workspaceRoot, CLAUDE_SETTINGS), 'utf-8'));
      const preToolUse: unknown = settings?.hooks?.PreToolUse;
      if (!Array.isArray(preToolUse)) { return false; }
      return preToolUse.some((entry: { hooks?: Array<{ command?: unknown }> } | null) =>
        Array.isArray(entry?.hooks) && entry.hooks.some((h) =>
          typeof h?.command === 'string' && h.command.includes('enforce-skill.sh')));
    } catch {
      return false;
    }
  }

  /**
   * Merge the PreToolUse hook config into .claude/settings.local.json.
   * Creates the file if it doesn't exist; adds the hook entry if missing.
   * Uses settings.local.json (not settings.json) so it stays local and never committed.
   * Returns whether the file was written.
   */
  private mergeHookConfig(workspaceRoot: string): boolean {
    const settingsPath = path.join(workspaceRoot, '.claude', 'settings.local.json');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let settings: Record<string, any> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      } catch {
        // Malformed JSON — bail out rather than overwriting the user's file
        return false;
      }
    }

    const hookEntry = {
      matcher: 'Edit|Write',
      hooks: [
        {
          type: 'command',
          command: HOOK_COMMAND,
          timeout: 5,
        },
      ],
    };

    // Ensure hooks.PreToolUse array exists
    if (!settings.hooks) { settings.hooks = {}; }
    if (!Array.isArray(settings.hooks.PreToolUse)) { settings.hooks.PreToolUse = []; }

    // Check if our hook is already registered (detect current and legacy script names)
    const preToolUse = settings.hooks.PreToolUse as Array<Record<string, unknown>>;
    const isErdStudioHook = (h: Record<string, unknown>) =>
      typeof h.command === 'string' &&
      (h.command.includes('enforce-skill.sh') || h.command.includes('check-skill.sh'));

    const alreadyRegistered = preToolUse.some((entry) => {
      const hooks = entry.hooks as Array<Record<string, unknown>> | undefined;
      return hooks?.some(isErdStudioHook);
    });

    if (alreadyRegistered) {
      // Replace an outdated ERD Studio entry — the legacy check-skill.sh, or an
      // enforce-skill.sh command without the $CLAUDE_PROJECT_DIR guard — with
      // the current one. An entry already carrying HOOK_COMMAND is left alone.
      const isOutdated = (h: Record<string, unknown>) => isErdStudioHook(h) && h.command !== HOOK_COMMAND;
      const hasOutdated = preToolUse.some((entry) => {
        const hooks = entry.hooks as Array<Record<string, unknown>> | undefined;
        return hooks?.some(isOutdated);
      });
      if (!hasOutdated) { return false; } // Current version already registered

      // Remove every ERD Studio hook (keeping any other hook that shares its
      // entry), drop entries left empty, then register the current one once.
      settings.hooks.PreToolUse = preToolUse
        .map((entry) => {
          const hooks = entry.hooks as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(hooks) || !hooks.some(isErdStudioHook)) { return entry; }
          const rest = hooks.filter((h) => !isErdStudioHook(h));
          return rest.length > 0 ? { ...entry, hooks: rest } : null;
        })
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      (settings.hooks.PreToolUse as Array<Record<string, unknown>>).push(hookEntry);
    } else {
      preToolUse.push(hookEntry);
    }

    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    return true;
  }
}
