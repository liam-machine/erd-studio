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
export const HARNESS_VERSION = '35';

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
 * Whether marker `version` comes from a later ERD Studio than this one (a
 * teammate's): such a file is `newer`, never `outdated`, and is never
 * replaced, so an older build cannot put older text back over it. Markers
 * are whole numbers; anything else that differs counts as older.
 */
export function isNewerHarnessVersion(version: string): boolean {
  return /^\d+$/.test(version) && /^\d+$/.test(HARNESS_VERSION) && Number(version) > Number(HARNESS_VERSION);
}

/** The state a file carrying marker `version` is in. */
function stateOfVersion(version: string): FileState {
  return version === HARNESS_VERSION ? 'current' : isNewerHarnessVersion(version) ? 'newer' : 'outdated';
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
    description: 'AGENTS.md section, with .agents/skills/erd-studio/DBML.md and LEGACY.md',
    relativePath: 'AGENTS.md',
    // No gitignorePattern — AGENTS.md may contain non-ERD-Studio content
  },
];

// ---------------------------------------------------------------------------
// Core schema content (shared across all harnesses)
// ---------------------------------------------------------------------------

/**
 * The schema guide is three parts (native DBML storage, §7.3): the skill
 * itself (what to write, the layout, the edit rules and every rule the
 * formats share), the DBML format, and the YAML/JSON rules of projects from
 * before 2.0, complete. The two skill targets install them as `SKILL.md`
 * plus the version-marked companions `DBML.md` and `LEGACY.md` (as `SYNC.md`
 * already is), which keeps each file under the 500-line skill limit; the
 * single-file targets Copilot and Gemini carry all three inline
 * ({@link SCHEMA_CONTENT}); Codex's `AGENTS.md` carries the skill part only
 * and points at the Agent Skills copies of the other two
 * ({@link CODEX_CONTENT}), as Codex reads only the first 32 KiB of
 * `AGENTS.md`. `{SKILL}`, `{DBML}`, `{LEGACY}` and `{BESIDE}`
 * are how each part refers to the others, filled in by {@link schemaPart}.
 */
const SKILL_PART = `# ERD Studio — AI Data Modeling Guide

ERD Studio keeps a project's logical data model in \`.erd-studio/\` as plain text files you read and write: **tables**, the **relationships** between them, and **diagrams** (subject areas) that each show a set of tables. Since ERD Studio 2.0 a project stores them as **DBML**, an open format that other DBML tools (dbdiagram.io, dbdocs, the DBML CLI) read too; a project from before 2.0 keeps **YAML** tables and **JSON** diagrams, which stay readable and editable. This file says which format to write and holds the rules every format shares; the formats themselves are in {DBML} and {LEGACY}{BESIDE}.

## What to write: read \`erd.storage\` first

**Before writing any \`.erd-studio\` file, run \`erd-studio doctor --json\` and read \`erd.storage\`** (doctor works in a folder without dbt too, reporting \`dbtProject: false\`):

- **\`dbml\`, or no \`.erd-studio/\` folder yet** (a new project) → write DBML: follow {DBML}.
- **\`yaml\`** → write YAML tables and JSON diagrams: follow {LEGACY}, in the file naming doctor's \`erd.naming\` reports.
- **\`mixed\`** (a project half-way to DBML) → new tables and new diagrams are DBML; an existing file keeps its format (edit a \`.yml\` table as YAML and a \`.json\` diagram as JSON, by {LEGACY}). A JSON diagram may list DBML tables; a DBML diagram may list only DBML tables, and a DBML table's Refs may name only DBML tables. A relationship between a DBML table and a YAML table cannot be stored yet: leave it out, and tell the user it needs **ERD Studio: Convert Project to DBML** first. Suggest **ERD Studio: Convert Project to DBML** to the user rather than converting anything yourself.
- **The doctor result has no \`erd.storage\` field** (an ERD Studio CLI older than 2.0, perhaps a teammate's) → write what the files already are: if \`.erd-studio/tables/\` holds \`.dbml\` table files, DBML; otherwise follow {LEGACY}. Tell the user their ERD Studio is older than these instructions.
- **No CLI** (the command is not found, exit 127) → the same rule from the files: any \`.erd-studio/**/*.dbml\`, or no \`.erd-studio/\` folder at all, means DBML; only \`.yml\` tables and \`.json\` diagrams means {LEGACY}.

**Never convert files between the formats by hand**, and never write a \`.yml\` table or a \`.json\` diagram into a DBML project. The user converts a project with **ERD Studio: Convert Project to DBML**, one undoable step that doctor's \`erd.dbmlConversion\` previews. ERD Studio versions before 2.0 cannot read DBML, so converting is the user's decision, never yours.

## Layout (DBML)

\`\`\`
.erd-studio/
├── layers.json                     ← the layers (JSON); write it first in a new project
├── modelling-approach.md           ← optional: the team's modelling rules (see below)
├── tables/                         ← the table library: one Table per file
│   ├── dim_date.dbml
│   ├── _relationships.dbml         ← Refs owned by the top-level tables
│   └── gold/                       ← optional folder, one level only
│       ├── dim_customer.dbml
│       ├── fct_order.dbml
│       └── _relationships.dbml     ← Refs owned by the tables in tables/gold/
└── gold/                           ← a layer folder
    ├── sales.dbml                  ← a diagram: its tables by use lines, sticky notes
    └── sales.dbdiagram             ← its layout (positions); omit it for auto layout
\`\`\`

A new project also needs \`.erd-studio/layers.json\`, which lists the layer folders. Write it first, with every field of each layer (ids are lowercase letters, digits, \`-\` and \`_\`; \`color\` is a six-digit hex):

\`\`\`json
{
  "schemaVersion": 1,
  "layers": [
    { "id": "silver", "label": "Silver", "abbreviation": "SLV", "color": "#a0a0a0", "creatable": true, "order": 1 },
    { "id": "gold", "label": "Gold", "abbreviation": "GLD", "color": "#d4a800", "creatable": true, "order": 2 }
  ]
}
\`\`\`

- A table's **name is its identity everywhere** and is unique across the whole library, ignoring case: never create a second file with a name that exists in another folder. Folders are organisational only. \`tables/\` is never a layer.
- **To find a table**, look at \`tables/{name}.dbml\` first, then in each folder (\`tables/*/{name}.dbml\`).
- **Folders are opt-in per project.** If a folder named after a layer in \`layers.json\` (\`tables/{layer}/\`) already holds a table file (or \`tables/\` is empty), create a new table in the folder of the layer of the diagram you are adding it to (adding \`fct_sale\` to \`gold/reporting.dbml\` creates \`tables/gold/fct_sale.dbml\`). If every table file is at the top level, create the new file at the top level too. Keep an existing table's file in the folder it is in.

## Edit rules

- **Edit in place and never reformat.** Change only the lines you mean to change; keep comments, order, spacing and every setting you do not understand exactly as they are. ERD Studio does the same.
- **Add a table to a diagram** = a new table file (when no file has that name) + a table \`use\` line in the diagram (+ the \`use\` line of that table's folder's \`_relationships.dbml\`, when the diagram does not import it yet).
- **Add a relationship** = one \`Ref\` line in the \`_relationships.dbml\` of the foreign-key table's folder, + a \`use\` line there for every table the Ref names that the file does not import yet.
- **Remove a table from a diagram** = delete its \`use\` line there (and its position in the layout file). The table file and its Refs stay: the diagram just stops showing them.
- **Never hand-merge a conflicted file.** When a file holds git conflict markers (\`<<<<<<<\` … \`>>>>>>>\`), show the user the file and line and ask which side to keep; never pick a side yourself or run git commands.
- **Check your work** with \`erd-studio doctor\` (its \`erd.dbmlProblems\` names every problem with its file, line and the exact line to write) and \`erd-studio export --domain .erd-studio/<layer>/<name>.dbml --format dbml\` (the diagram's path from the project folder, \`.erd-studio/\` included). Fix every \`fix-dbml-file\` error before anything else. Then fix every \`missingUse\`, \`missingRelationshipsUse\`, \`unquotedValue\` and \`usePathMismatch\` warning in a file you wrote (the message gives the exact line): ERD Studio reads on without the fix, but other DBML tools reject the file and every diagram that imports it. Fix a \`foreignMetadata\` warning too: a Metadata block outside the table's own file, whose values the canvas never shows while other DBML tools apply them; do what its message says: move its properties into the table file (as inline settings in a \`.dbml\` one) and remove the block. Other warnings are information.

## Team Modelling Approach

If \`.erd-studio/modelling-approach.md\` exists, **read it before creating or editing models and follow it.** It records how this team models data — the technique (e.g. Kimball dimensional modelling, Data Vault 2.0), the user's own words, the concrete rules, and how each rule maps onto ERD Studio fields (the table's role, grain, SCD and additive types, natural keys and rationale, whatever the file format). The \`/erd-studio-setup\` guide writes it after asking the user; it can also be written or edited by hand. It is free-form markdown: ERD Studio never parses it, and a project without one is valid. When a rule in it conflicts with a user request, say so and ask which wins. If it has a **Target-design backlog** section, the differences between logical and physical listed there are intentional: when a sync plan or diff proposes undoing one, report it as a backlog item and leave it as it is unless the user says otherwise. If it has a **Metadata** section, that is the team's metadata list — follow it as "The team's metadata list" below says. A file holding only a title and a Metadata section is valid: no modelling technique has been agreed yet.

### The team's metadata list

If \`.erd-studio/modelling-approach.md\` has a \`## Metadata\` section, it lists the \`meta\` keys this team records, as a table: **Key**, **On** (models, columns or both), **Values**, and **Source** (\`dbt\` or \`the team\`). Read it before creating or editing a model, and follow it:

- **Use its key names exactly.** When the user describes a key in other words ("data owner", "does it hold personal data?"), use the listed key (\`owner\`, \`pii\`), never a new spelling, and put it where **On** says. When **Values** names a fixed set, use one of those values; an example in **Values** is never a default. Keep the kind of value (text, \`true\` / \`false\`, a list).
- **Source \`dbt\`: copy it; never make it up.** The value comes from the dbt model's own \`meta:\` — best from \`~/.erd-studio-cli/bin/erd-studio inventory --models <name> --json\` (\`models[].meta\`, \`columns[].meta\`, already merged as dbt merges them, including project-wide \`+meta\` from \`dbt_project.yml\`) when that helper is installed, else from the model's schema \`.yml\` (\`meta:\` and \`config: meta:\`, the \`config\` one winning per key; a column's are under that column) and the \`+meta\` entries in \`dbt_project.yml\`. Copy it whenever you create a logical model or add a column from dbt, including from a sync plan. Keep the kind of value: in a DBML table a text value is one \`meta_<key>: '<text>'\` setting and anything else (\`true\` / \`false\`, a number, a list) goes into the one \`meta_json\` setting as JSON ({DBML}); in YAML, \`true\` / \`false\` stay unquoted and a list stays a list, and numbers may be written quoted or not (ERD Studio reads \`24\` and \`"24"\` the same), but keep the quotes when leaving them off would change the digits (\`"1.10"\`, \`"007"\`). When dbt has no value (or \`null\`), leave the key out: never guess and never write a placeholder.
  - When you are already reading that dbt model and the model file's value for a listed \`dbt\` key differs from dbt's, say so in one line and ask before changing it — the difference may be deliberate.
  - When the user gives a value for a \`dbt\` key ("its owner is finance-team"), write it, say that dbt does not record it, and offer to add it to the dbt model's \`meta:\` too so the two agree — never edit dbt files unasked. When they ask for a \`dbt\` key that dbt has no value for and give none, say so and ask for the value.
- **Source \`the team\`: leave it to people.** Never fill it in yourself unless the user gives you the value. After creating models, say in one line which of them still lack these keys (one line for a whole batch or sync plan).
- **A key that is not on the list:** add it when the user asks, then offer once to add it to the list (Source \`the team\`, or \`dbt\` when dbt records it). Keys the list names under **Left out** (another tool's settings) are never copied from dbt.

Without that section, add or change only the keys the user asks for, and never copy dbt's \`meta:\` unasked. Ask for a value you were not given; never make one up.

## Table roles

A table's role is \`role\` in a DBML table file and \`modelRole\` (\`tableRole\` in the v6 naming) in a YAML one. Use one of these values:

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


## Design rationale

Optional, and every field is optional text: in DBML each is a table setting \`rationale_<field in snake_case>\` (\`rationale_purpose\`, \`rationale_grain_choice\`, …); in YAML they are keys of one \`rationale:\` map. Write only the fields there is something to say about.

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

**Does NOT apply to:** renaming a column, changing a single flag, or executing an \`.erd-studio/.sync-plan.json\` (see SYNC.md for that workflow). A **DBML file** (\`.dbml\`) from another tool has its own command — see "DBML: import and export" in {DBML}.

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
Write the table's file — the existing file if the table already exists (in whichever folder it is in), otherwise a new file: in a DBML project \`.erd-studio/tables/{layer}/{name}.dbml\` for the layer of the target diagram when the project uses layer folders, else \`.erd-studio/tables/{name}.dbml\` (see "Layout" above); in a YAML project the \`.yml\` path {LEGACY} gives. When the source is a dbt model and the team's metadata list has \`dbt\` keys, copy those too (see "The team's metadata list").

### Step 4 — Reconcile via set-difference
Re-read the table file you just wrote. Compute the set-difference between source columns and the file's columns — do not rely on a total count alone, because counts can coincidentally match while columns still differ.

Report in this exact form:

> Reconcile: \`dim_customer.dbml\` has **M** columns; source has **N**.
>
> **In source but not in the file** (K): \`created_at\` (audit — not modelled), \`updated_at\` (audit), \`_dbt_source_relation\` (dbt internal).
>
> **In the file but not in source** (J): \`customer_sk\` (synthesised surrogate key), \`loaded_at\` (added for SCD2 tracking).

Every entry in "in source but not in the file" must have a specific reason. A class-level reason already declared in Step 2 (e.g. "excluding audit columns") is sufficient — you don't need to restate it per column. But an unexplained entry, or a vague reason like "not needed", means **stop and tell the user** that a column may have been dropped unintentionally. Do not claim the task is complete.

**Rule of thumb:** if your reconcile message doesn't name specific columns on both sides, you skipped a step.

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

**A folder without \`dbt_project.yml\` is logical-only.** ERD Studio works there as a logical data modelling tool: the canvas shows no Physical tab and no ⊕ Diff, there is no sync plan, and \`erd-studio diff\` exits with \`not-dbt-project\` (\`doctor\` and \`export\` still work). The \`.erd-studio\` files are the whole model. Never tell the user they need dbt, and never run dbt there; if they use dbt elsewhere, opening that folder adds the Physical view.

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
10. **Carried forward from logical**: PK/FK/NK flags, grain, the table role, SCD type and additive type — dbt yml does not carry them. \`meta\` is logical-only and is never read from, or compared with, dbt.

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
3. Follow the execution steps in SYNC.md to reconcile logical and physical models
4. Write each logical-side change in the project's format: SYNC.md gives the DBML lines (a column line in the Table block, a Ref line in \`relationshipsPath\`) and the YAML ones (legacy)`;

const DBML_PART = `# ERD Studio — the DBML format

This is how an ERD Studio project stores its model as DBML (ERD Studio 2.0 and later): one file per table in \`.erd-studio/tables/\`, one \`_relationships.dbml\` per library folder, and one \`.dbml\` per diagram in a layer folder, with its layout beside it. The files are a multi-file DBML project, so other DBML tools (DBML 9.1 and later) read them too — keep every rule below, or those tools fail where ERD Studio reads on. Read {SKILL} first: it says when this file applies.

## Table file: \`tables/[<folder>/]<name>.dbml\`

**First rule: quote every custom value, even \`'true'\` and numbers** — \`natural_key: 'true'\`, \`scd_type: '2'\`, \`grain: 'One row per order line'\`. ERD Studio reads an unquoted \`true\` or \`2\`, but DBML 9 and 10 tools reject the whole file (and every diagram that imports it), and an unquoted word or phrase (\`role: fact\`, \`grain: one row\`) is an error everywhere, ERD Studio included. \`erd-studio doctor\` flags both (\`unquotedValue\`, or the parser's code with "Quote the value"). The same holds for the Project keys of a diagram (\`erd_schema_version: '7'\`).

\`\`\`dbml
// Order lines from the shop. Comments like this one survive every save.
Table fct_order [
  schema: 'gold',
  role: 'transaction-fact',
  grain: 'One row per order line',
  rationale_purpose: 'Revenue reporting by day, customer and region',
  meta_owner: 'sales-data',
  meta_json: '{"pii":false,"tags":["finance"]}'
] {
  order_line_id BIGINT [pk, note: 'Line id from the shop']
  customer_key INT [foreign_key: 'true']
  order_date_key INT [foreign_key: 'true']
  amount "DECIMAL(18,2)" [additive_type: 'additive', note: 'Line total']
  order_number VARCHAR [natural_key: 'true']
  loaded_at timestamp [not null, default: \`now()\`]
  Note: 'Order lines'
}
\`\`\`

- **Exactly one \`Table\` per file**, named exactly as the file (\`tables/gold/fct_order.dbml\` holds \`Table fct_order\`), unqualified: the schema is the \`schema\` setting, never \`Table gold.fct_order\`. Any number of \`Enum\`s and comments may sit beside it. No \`Project\`, \`TableGroup\`, top-level \`Note\`, \`TablePartial\` or \`Records\`.
- **No \`use\`, no \`Ref\`, and no inline \`[ref: …]\` in a table file**: relationships go in the folder's \`_relationships.dbml\` (below). ERD Studio reads such a file but refuses to change it until the line is moved, and doctor gives the exact Ref line to write instead.
- **Spell names exactly**: the table and column names as they are, in their case (DBML is case-sensitive). A name that is not a plain identifier, or is a DBML keyword, is double-quoted (\`"order"\`); a type that is not a plain identifier is too (\`"DECIMAL(18,2)"\`).
- **A table needs at least one column.** A table with none yet holds the placeholder line \`_erd_no_columns unknown [erd_placeholder: 'true', note: 'ERD Studio: this table has no columns yet, and DBML needs one']\`; delete it when you add the first real column.
- **Primary key**: \`pk\` on the column; for two or more columns, an \`indexes { (a, b) [pk] }\` block instead, with no \`pk\` on the columns.
- The table's description is the \`Note: '…'\` line, last in the block. A text with a line break is triple-quoted (\`'''…'''\`); escape \`'\` as \`\\'\` and \`\\\` as \`\\\\\`.
- A flag is written only when it is set (\`natural_key: 'true'\`); to unset it, delete the setting. Settings ERD Studio does not model (\`not null\`, \`unique\`, \`default\`, \`increment\`, \`note\` on an index, \`headercolor\`, other indexes, Enums, your own custom settings) are kept exactly as written.
- **Never write a \`Metadata\` block** (\`Metadata Table x { … }\`): put every property inline, on the Table or the column. A Metadata block silently overrides the inline value.

## Field names

| Meaning | In a table file | Example |
|---|---|---|
| table name | \`Table <name>\` (the file stem) | \`Table dim_customer\` |
| schema | \`schema\` (table setting) | \`schema: 'gold'\` |
| description | the body's \`Note\` (last line) | \`Note: 'Customer master data'\` |
| role (see "Table roles" in {SKILL}) | \`role\` | \`role: 'conformed-dim'\` |
| grain | \`grain\` | \`grain: 'One row per customer'\` |
| warehouse table name (dbt \`alias\`) | \`alias\` (never DBML's own \`as\`) | \`alias: 'customer'\` |
| design rationale | \`rationale_<field>\` | \`rationale_grain_choice: '…'\` |
| metadata, text values | \`meta_<key>\` (key matching \`[a-z_][a-z0-9_]*\`) | \`meta_owner: 'crm-team'\` |
| metadata, anything else | one \`meta_json\` with exactly those entries as JSON | \`meta_json: '{"pii":true}'\` |
| column type | the column's type | \`email VARCHAR\` |
| column description | \`note\` (column setting) | \`[note: 'Email address']\` |
| primary key | \`pk\`, or \`indexes { (a, b) [pk] }\` | \`[pk]\` |
| foreign key (intent) | \`foreign_key: 'true'\` | \`[foreign_key: 'true']\` |
| natural (business) key | \`natural_key: 'true'\` | \`[natural_key: 'true']\` |
| SCD type | \`scd_type: '0'\`, \`'1'\` or \`'2'\` | \`[scd_type: '2']\` |
| additive type | \`additive_type\` | \`[additive_type: 'semi-additive']\` |
| column metadata | \`meta_<key>\` / \`meta_json\` on the column | \`[meta_pii: 'yes']\` |

Every custom value is a quoted string. \`foreign_key\` records the intent only: a Ref never sets it, so set it on a foreign-key column yourself. ERD Studio never compares \`meta_*\` with dbt (see "The team's metadata list" in {SKILL}); an imported table may carry a \`meta_json\` with a \`dbml\` entry (what an imported DBML file said that ERD Studio has no field for): keep it as it is.

## Relationships file: \`tables/[<folder>/]_relationships.dbml\`

Each relationship is **one \`Ref\` line, in the \`_relationships.dbml\` of the folder that holds its foreign-key table** (the "many" side). Every diagram that shows both tables draws it; one that lacks either does not.

\`\`\`dbml
// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.
use { table dim_date } from '../dim_date.dbml'
use { table customer_profile } from './customer_profile.dbml'
use { table dim_customer } from './dim_customer.dbml'
use { table fct_order } from './fct_order.dbml'

Ref: dim_customer.customer_key ?- customer_profile.customer_key
Ref parent: dim_customer.parent_customer_key >? dim_customer.customer_key
Ref: fct_order.customer_key >? dim_customer.customer_key
Ref "order date": fct_order.order_date_key >? dim_date.date_key
Ref "ship date": fct_order.ship_date_key >? dim_date.date_key
Ref: fct_order.(region_code, country_code) >? dim_region.(region_code, country_code)
\`\`\`

- **\`use\` lines: one for every table any Ref in the file names**, \`use { table <name> } from '<path from this file, with .dbml>'\`, sorted by path, in one block under the header comment. Without it every DBML tool fails the file (\`use\` is not transitive); ERD Studio reads the Ref anyway and doctor reports \`missingUse\` with the line to add.
- **Operators**, with the foreign-key end marked possibly null by \`?\`:

  | Cardinality | Write | Notes |
  |---|---|---|
  | many-to-one | \`Ref: fct.fk >? dim.pk\` | the foreign key first |
  | one-to-one | \`Ref: dim.pk ?- fct.fk\` | **the key end first, the foreign key second**, marked by \`?\` |
  | many-to-many | \`Ref: a.x <>? b.y\` | |

  Never write \`<\` (one-to-many): turn it round and write \`>?\` from the other end. **Warning:** a one-to-one written foreign key first (\`Ref: fct.fk - dim.pk\`, no \`?\`) is read by its keys and may be read the wrong way round; always write \`Ref: dim.pk ?- fct.fk\`.
- **A role** (what the link means, e.g. \`order date\` and \`ship date\` for two columns pointing at one date table) is the Ref's name: \`Ref "ship date": …\`. **Name a Ref only to give it a role; the name is shown on the line.** Two Refs may share a role.
- **Composite foreign keys** are one Ref with both column lists in the same order: \`Ref: pit.(customer_hk, as_of_date) >? sat.(customer_hk, load_date)\`.
- **One Ref per pair of column sets, in one file only.** The same two column sets joined twice — in two files, twice in one, or once each way round — fails every DBML tool (\`[5001]\`), and doctor reports it as \`duplicateRef\`.
- **Spell every end exactly** as its table and column are named; a Ref whose other table has no file is not drawn. A self-reference (\`employee.manager_id >? employee.employee_id\`) is fine; a column never points at itself.
- Keep the Refs sorted (by from table, to table, then columns). Settings on a Ref (\`[delete: cascade]\`, \`[color: …]\`) are kept as written.
- **Mark the keys.** Direction comes from keys: mark the referenced column \`pk\` (or \`natural_key: 'true'\`) on the table it points at, and \`foreign_key: 'true'\` on the foreign-key column. Keys win: the many side is never its table's whole primary or natural key while the other end is a column of a table with a different key — such a Ref is drawn backwards, flagged with a ⚠ and reported by doctor as \`turn-round-relationships\`; offer to rewrite it as \`>?\` from the column that is not a key to the key, in the relationships file of that column's table.

## Diagram: \`<layer>/<name>.dbml\`

\`\`\`dbml
Project sales {
  Note: 'Sales star schema'
  erd_schema_version: '7'
  erd_show_fk_edges: 'false'
}

use { table fct_order } from '../tables/gold/fct_order.dbml'
use { table dim_customer } from '../tables/gold/dim_customer.dbml'
use { table dim_date } from '../tables/dim_date.dbml'
use * from '../tables/_relationships.dbml'
use * from '../tables/gold/_relationships.dbml'

Note "3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c" [color: #f59e0b, linked_table: 'fct_order'] {
  'Check the grain with finance'
}
\`\`\`

- **\`Project <name>\`** (the diagram's name, its file stem for a new one; double-quote it when it is not a plain identifier or is a DBML keyword, as \`Project "customer-360"\`, or every DBML tool rejects the file) with its description as \`Note\`, and \`erd_schema_version: '7'\` always. Optional quoted keys: \`erd_model_folder\` (the dbt \`models/\` path filter), \`erd_show_fk_edges\` (\`'true'\` / \`'false'\`), \`erd_layout_options\` (JSON text) and \`erd_stub_columns\` (a JSON array of table names whose physical-only columns are not compared — for conformed dimensions included only to anchor relationships). Keep any other Project key as it is.
- **The diagram's tables are its table \`use\` lines**, in order, with paths **relative to the diagram file**, not to \`.erd-studio\` (\`../tables/gold/fct_order.dbml\`). Doctor reports a path that does not point at the table's file (\`usePathMismatch\`) with the corrected line.
- **Then one \`use * from '…'\` for the \`_relationships.dbml\` of every library folder that holds one of the diagram's tables**, when that file exists, sorted by path. Without it other DBML tools draw no Refs (doctor: \`missingRelationshipsUse\`); ERD Studio draws them anyway.
- **No Tables, Refs or TableGroups in a diagram**: they belong in the library. A file that declares its own Tables and imports none is a single-file DBML (a dbdiagram.io download): run **ERD Studio: Import DBML…** on it (doctor: \`import-dbml-file\`).
- **Sticky notes** are \`Note "<id>" [color: <hex>, linked_table: '<table>'] { '<text>' }\` at the end, each with its own id (a UUID; two Notes with one name fail every DBML tool). Colours: \`#f59e0b\` yellow, \`#3b82f6\` blue, \`#22c55e\` green, \`#ec4899\` pink, \`#f97316\` orange. \`linked_table\` is optional and draws a dashed line to that table.
- **The layout file** \`<name>.dbdiagram\` beside the diagram is JSON holding the positions (\`defaultView.tablePositions\`, \`[{ "name": "fct_order", "schemaName": "public", "x": 400, "y": 200 }]\`, and \`stickyNoteLayouts\`). **Omit it, or leave a table out of it, for auto layout**: ERD Studio places what has no position the first time the diagram opens. Never clear positions the user arranged.

## DBML: import and export

The project's own files are DBML; these commands bring other DBML in and send diagrams out.

- **A DBML file in** — from dbdiagram.io, dbdocs, another tool, or an ERD Studio export: point the user at **ERD Studio: Import DBML…** (Command Palette, or the Subject Areas view's **…** menu). It needs no dbt and no AI. It reads one self-contained file (no \`use\` lines), creates a **new** diagram, splits the tables into the library (using tables the library already has as they are, never overwriting them), places them from the \`<name>.dbdiagram\` layout file beside the \`.dbml\` when there is one, and shows what it will create before writing anything. Prefer it to converting the file yourself; if the user asks you to do it by hand anyway, follow "Building Models from External Sources" in {SKILL}.
- **Diagrams out** — **ERD Studio: Export Diagram…** (one diagram) or **ERD Studio: Export All Diagrams…** (every one, into a folder outside \`.erd-studio\`), with the choice **DBML for dbdiagram.io**: one self-contained \`<name>.dbml\` with ERD Studio's fields as DBML custom properties (\`role\`, \`grain\`, \`scd_type\`, \`natural_key\`, \`meta_*\`, …), plus \`<name>.dbdiagram\` beside it holding the table positions. That single file is the route to dbdiagram.io. The plain **DBML** choice is the portable, notes-only form any DBML tool opens.
- **From the CLI** (stdout only; it never writes a file): \`erd-studio export --domain <path> --format dbml-rich\` prints the single-file \`.dbml\`, \`--format dbml-layout\` its \`.dbdiagram\`, and \`--all\` in place of \`--domain\` prints every diagram as a JSON list of \`{ fileName, content }\`. When the user asks you to save them, write each \`content\` to its \`fileName\` (outside \`.erd-studio\`) with your own file tools, so the writes stay visible.
- **dbdiagram.io** — \`dbdiagram push <name>.dbml --name "<Name>"\` (dbdiagram's own CLI: \`npm install -g dbdiagram\`, then \`dbdiagram auth login\`) uploads an exported diagram with the \`.dbdiagram\` positions next to it. It sends the data model to dbdiagram.io under the user's account: run it only when the user asks, and show the command first. ERD Studio itself never contacts dbdiagram.io.
- **\`meta.dbml\`** — an imported table or column may carry a \`dbml\` entry in its metadata (\`meta_json\` in DBML, \`meta.dbml\` in YAML): what the DBML file said that ERD Studio has no field for (\`not_null\`, \`unique\`, \`default\`, \`increment\`, \`checks\`, \`enum\`, \`indexes\`, \`header_color\`, the original \`name\` when it had to change, another tool's own \`properties\`). Keep it exactly as it is — the next DBML export carries it back out — and write or change it only when the user asks.`;

const LEGACY_PART = `# ERD Studio — YAML and JSON files (projects before 2.0)

**Read this file only when \`erd-studio doctor --json\` reports \`erd.storage: yaml\`** (or, in a \`mixed\` project, to edit an existing \`.yml\` table or \`.json\` diagram in place). A new project, and every new file in a \`dbml\` or \`mixed\` project, is DBML: follow {DBML}. **Never convert by hand: run ERD Studio: Convert Project to DBML** (the user runs it in VS Code: one undoable step that doctor's \`erd.dbmlConversion\` previews).

In a YAML project, model (table) definitions are YAML files in \`.erd-studio/logical-models/\` (at the top level, or one folder down in a per-layer folder). Domain (subject area) JSON files reference models by name and hold the layout. Relationships are defined once, in the YAML of the model holding the foreign key (the "many" side), and every domain holding both models draws them — or, in a project that still keeps them per domain, in each domain JSON (see \`Where relationships live\`). The rules every format shares — the team's modelling approach and metadata list, table roles, rationale fields, building from a source, naming, the physical stage and sync plans — are in {SKILL}.

## File naming: v5 or v6 — use the one \`erd-studio doctor\` reports

A project's files use one of two namings for the same format. **Before writing any \`.erd-studio\` file, run \`erd-studio doctor --json\` and read \`erd.naming\`**, then write every file in that naming (doctor works in a folder without dbt too, reporting \`dbtProject: false\`; when it finds no project at all — no \`dbt_project.yml\` and no \`.erd-studio/\` yet — the project is new, so it is DBML: follow {DBML}):

| What | v5 naming (\`naming: v5\`) | v6 naming (\`naming: v6\` or \`mixed\`, and a new project) |
|------|------|------|
| Table (model) library folder | \`.erd-studio/logical-models/\` | \`.erd-studio/tables/\` |
| Subject area (domain) file \`schemaVersion\` | \`5\` | \`6\` |
| Its slug key | \`domain\` | \`subjectArea\` |
| Its list of table names | \`logical.models\` | \`logical.tables\` |
| A relationship's ends (subject area JSON) | \`fromModel\` / \`toModel\` | \`fromTable\` / \`toTable\` |
| A relationship's far end (table YAML) | \`toModel\` | \`toTable\` |
| A table's role (table YAML) | \`modelRole\` | \`tableRole\` |
| An annotation's linked table | \`linkedModel\` | \`linkedTable\` |

Everything else — \`layer\`, \`modelFolder\` (the dbt \`models/\` path filter), \`viewConfig\`, \`positions\`, columns, keys, the subject area file's path \`.erd-studio/{layer}/{name}.json\` — is the same in both. **The examples below use the v5 names; in a v6 project write the v6 name from this table instead.**

- \`naming: v5\` → write the v5 names, and create new table files in \`logical-models/\`.
- \`naming: v6\` or \`mixed\` (a project half-way through the move) → write the v6 names, and create new table files in \`tables/\`. In a mixed project, edit an existing file in the naming it already uses.
- **Never mix the two in one file** (\`schemaVersion: 6\` with \`domain\`, or \`logical.tables\` beside \`logical.models\`): such a file does not open. A YAML file holding both \`modelRole\` and \`tableRole\` cannot be edited on the canvas; only the v6 key is read.
- **Never move files between \`logical-models/\` and \`tables/\` yourself.** The user moves a project with **ERD Studio: Migrate to the New File Naming**, one undoable step; doctor's \`erd.namingMigration\` previews it. ERD Studio versions before the one that wrote v6 cannot open v6 files, so the move is the user's decision, never yours.

## Architecture Overview

\`\`\`
.erd-studio/
├── modelling-approach.md     ← Optional: the team's modelling rules (see {SKILL})
├── logical-models/           ← Central model definitions (YAML, one per model)
│   ├── dim_project.yml       ← top level (flat libraries keep working)
│   ├── silver/               ← optional per-layer folders
│   │   └── dim_customer.yml
│   └── gold/
│       └── fct_sale.yml
├── silver/
│   ├── customer-360.json     ← Domain file (model references + layout; relationships only in per-domain projects)
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
| \`schemaVersion\` | Yes | \`5\` in the v5 naming, \`6\` in the v6 naming (see "File naming" above) |
| \`domain\` | Yes | Domain slug (matches filename without \`.json\`) |
| \`layer\` | Yes | Layer name matching parent directory (e.g. \`silver\`, \`gold\`) |
| \`description\` | No | Human-readable domain description |
| \`modelFolder\` | No | Filter for "Add Existing Model" dialog (e.g. \`models/silver\`) |
| \`stubColumns\` | No | Model names whose physical-only columns are suppressed in sync comparison. Use for conformed dimensions and reference tables included only to anchor relationships — they define a few key columns (PK/NK) but not the full physical column set. Missing-column discrepancies are hidden; extra and type-mismatch discrepancies on defined columns still surface. |
| \`logical.models\` | Yes | Array of model name strings (references to \`logical-models/*.yml\` or \`logical-models/{folder}/*.yml\`) |
| \`logical.relationships\` | Yes | Array of relationship objects — \`[]\` when the project keeps relationships in the model YAML (see "Where relationships live") |
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
| Change grain, modelRole, description, rationale, meta | the model's \`.yml\` |
| Add a model to a domain diagram | Domain \`.json\` → add name to \`logical.models[]\` AND, if no file for that name exists in any folder, create it — \`logical-models/{layer}/{name}.yml\` (the domain's layer) when the project uses layer folders, else \`logical-models/{name}.yml\` |
| Remove a model from a domain | Domain \`.json\` → remove name from \`logical.models[]\` AND remove its relationships from \`logical.relationships[]\` (relationships in model YAML stay — the domain just stops drawing them) |
| Add/remove/edit a relationship | The many-side (FK) model's \`.yml\` → \`relationships:\` when the project keeps relationships in the model library, else domain \`.json\` → \`logical.relationships[]\` — see "Where relationships live" |
| Change layout positions | Domain \`.json\` → \`viewConfig.positions\` |

> **Common mistake:** Editing the \`.yml\` file alone is sufficient for column and model property changes — the extension picks up YAML changes automatically. But adding a model to the **diagram** requires BOTH creating the \`.yml\` AND adding the name string to the domain \`.json\`. A relationship is stored in exactly one place — the FK (many-side) model's \`.yml\` or the domain \`.json\`, never both (see \`Where relationships live\`).

---

## Models

Model definitions live in \`.erd-studio/logical-models/{model_name}.yml\` or \`.erd-studio/logical-models/{layer}/{model_name}.yml\` (see "Model file location" above). Create/edit these YAML files to define models. Then reference them by name in domain files.

**File:** \`.erd-studio/logical-models/silver/dim_customer.yml\`

\`\`\`yaml
name: dim_customer
schema: silver
description: "Customer master data. Status: one of active, closed"
grain: "One row per customer"
modelRole: conformed-dim
rationale:
  purpose: "Customer master data for cross-domain joins"
  roleChoice: "Conformed dimension shared across domains"
meta:
  owner: crm-team
  source_system: salesforce
columns:
  - name: customer_id
    dataType: "INT"
    description: "Surrogate key"
    isPrimaryKey: true
    scdType: 0
  - name: email
    dataType: "VARCHAR"
    description: "Email address"
    isNaturalKey: true
    scdType: 1
  - name: full_name
    dataType: "VARCHAR"
    description: |
      Customer display name.
      Built from first_name and last_name.
    scdType: 2
\`\`\`

**YAML quoting — the file must parse, or ERD Studio shows the model as empty.** Wrap every \`description\`, \`grain\`, \`rationale\` and \`dataType\` value in double quotes (escape an inner \`"\` as \`\\"\`), or use a \`|\` block for multi-line text. Always quote a value that contains \`: \` or \` #\`, or starts with any of \`\` \` @ * & ! % [ { - | > ' " \`\`. Indent with spaces, never tabs. Write each key once per block: before adding a \`description\` (or any key) to a model or column, check it is not already there, and edit the existing line instead — a key written twice makes ERD Studio refuse every change to that file until one copy is removed. One YAML document per file: no \`---\` separators, no markdown code fences, no \`{{ doc() }}\` — paste the text itself. \`erd-studio doctor\` and \`erd-studio diff\` report a file that does not parse as \`fix-model-yaml\` with its line — fix that before anything else, unless that file's entry in their \`unreadableModelFiles\` list has \`mergeConflict: true\` (the fix itself carries no such field): git left two versions in that file after a merge, so show the user the file and line and ask which side to keep — never pick a side yourself or run git commands. A diagram file with conflict markers gets doctor's \`resolve-merge-conflicts\` step instead; handle it the same way.

| Field | Required | Description |
|-------|----------|-------------|
| \`name\` | Yes | Model name (see "Naming Conventions" in {SKILL}) |
| \`schema\` | No | Target schema for materialization |
| \`alias\` | No | Warehouse table name when it differs from \`name\` — dbt's \`alias\` config. \`name\` stays the identity (domain files and relationships use it); the canvas shows the alias. Use it for the same table name in two layers (\`silver_date\` and \`gold_date\`, both \`alias: date\`). A plain identifier: letters, digits, underscores |
| \`description\` | No | Human-readable model description |
| \`grain\` | No | Grain statement — "One row per ___" |
| \`modelRole\` | No | Architecture role (see "Table roles" in {SKILL}) |
| \`columns\` | No | Array of column definitions |
| \`rationale\` | No | Design rationale object (omit if empty) |
| \`meta\` | No | Free-form metadata map (see "Metadata" below) |
| \`relationships\` | No | Relationships leaving this model (it holds the foreign key), shared by every domain (see "Where relationships live") |

### Metadata (\`meta\`)

Optional \`meta\` map on a model **and** on any column — free-form key/value metadata named after, and shaped like, dbt's \`meta:\` (owner, source system, lineage, classification…). Keys are strings; values may be text, numbers, booleans, \`null\`, lists or nested maps. Omit \`meta\` entirely when there is nothing to record (an empty map is removed).

\`\`\`yaml
meta:
  owner: crm-team
  lineage:
    upstream: [stg_salesforce__account]
    refreshed: daily
columns:
  - name: email
    dataType: "VARCHAR"
    description: "Email address"
    meta:
      pii: true
      classification: confidential
\`\`\`

- ERD Studio **never compares, diffs or syncs \`meta\` with dbt** — it is not part of the physical stage, discrepancy reports or sync plans, and does not need to match the dbt model's \`meta:\`. (Assistants may copy it from dbt by hand, only as the team's metadata list in {SKILL} says.)
- The canvas shows it in the Detail panel and when the user hovers a model's name or a column; top-level text values can be edited in the panel, nested maps, lists, booleans and \`null\` are shown read-only.
- **Keep every existing entry** when you edit a model file — including keys that are not on the team's list, values the user typed in, and values dbt no longer records — and never move keys between the model and its columns. Never invent metadata.

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
| \`meta\` | No | Free-form dbt-style metadata map for this column (see "Metadata" above) |

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
| \`cardinality\` | Yes | \`many-to-one\`, \`one-to-one\`, or \`many-to-many\` (\`one-to-many\` is still read, but never write it — see Direction) |
| \`role\` | No | A label for what the link means, e.g. \`order date\` and \`ship date\` for two columns pointing at the same date dimension. At most 60 characters. A label only — not part of the relationship's identity |
| \`compositeKey\` | No | Groups entries into one composite foreign key (see below). At most 64 characters |

**Spelling:** always spell \`fromModel\`, \`toModel\` and the columns exactly as the model and column are named. ERD Studio matches them ignoring case, but writes the real spelling the next time it changes that entry.

**Direction:** \`fromModel\` is always the many (FK) side, \`toModel\` the side it points at (PK). Never write \`one-to-many\`: swap the ends and write \`many-to-one\`, in the other model's file — it is the same relationship. \`one-to-one\` and \`many-to-many\` keep the direction they were drawn in. Keys win: the many side is never its model's whole primary or natural key while the other end is a column of a model with a different key — such a \`many-to-one\` is drawn backwards: ERD Studio draws it as stored but flags it (an amber ⚠ on the line with **Turn round**, a comment in the DBML / Mermaid export, a \`backwardsRelationships\` count in \`erd-studio doctor\`), **Move Relationships to Model Library** stores it the right way round, and the canvas refuses a ⇄ that would write it. Never write one; when doctor reports some (\`turn-round-relationships\`), offer to turn them round: a \`many-to-one\` from the column that is not a key to the key, in that column's model file. FK column names should match the PK column name of the referenced table.

### Where relationships live

A relationship is defined **once** for the whole project, in the YAML of its \`fromModel\`, the model holding the foreign key (the many side), under \`relationships:\` — the same fields without \`fromModel\`, which is the file's own model. Every domain whose \`logical.models\` holds both ends draws it; a domain missing either end does not. Changing it changes every diagram that shows it.

\`\`\`yaml
# logical-models/gold/fct_orders.yml
name: fct_orders
columns: [...]
relationships:
  - fromColumn: customer_id
    toModel: dim_customer
    toColumn: customer_id
    cardinality: many-to-one
  - fromColumn: ship_date_key
    toModel: dim_date
    toColumn: date_key
    cardinality: many-to-one
    role: ship date
\`\`\`

So adding a new fact only ever changes the fact's own file; its dimensions never list who points at them.

**Mark the keys.** Direction comes from keys: when you add a relationship, mark the referenced column with \`isPrimaryKey: true\` (or \`isNaturalKey\`) on the model it points at, unless that model already marks a key. Without a key marked, ERD Studio falls back to dbt's \`unique\` tests, and with neither the user has to say which side holds the foreign key.

**Self-references** (\`employee.manager_id → employee.employee_id\`) are stored in the model's own file with \`toModel\` set to the model itself. A column never points at itself.

\`\`\`yaml
# logical-models/employee.yml
relationships:
  - fromColumn: manager_id
    toModel: employee
    toColumn: employee_id
    cardinality: many-to-one
    role: manager
\`\`\`

**Composite foreign keys** (several columns together, e.g. a Data Vault PIT or bridge, a multi-column natural key) are one entry per column pair, all sharing the same \`compositeKey\` value, stored together on the FK side. Every entry points at the same \`toModel\` with the same cardinality (\`many-to-one\` or \`one-to-one\`, never \`many-to-many\`), and no column appears twice. ERD Studio draws them as one line. Name the key \`fk_<toModel>\` (\`fk_<toModel>_2\` for a second one in the same file). Never use array forms such as \`fromColumns: [...]\` — older ERD Studio versions would delete them.

\`\`\`yaml
# logical-models/gold/pit_customer.yml
relationships:
  - fromColumn: customer_hk
    toModel: sat_customer
    toColumn: customer_hk
    cardinality: many-to-one
    compositeKey: fk_sat_customer
  - fromColumn: as_of_date
    toModel: sat_customer
    toColumn: load_date
    cardinality: many-to-one
    compositeKey: fk_sat_customer
\`\`\`

**Which to use:** put new relationships in the model YAML when **any** model file already has a \`relationships:\` list, or **no** domain file has a \`logical.relationships\` entry (a new project). Otherwise the project keeps relationships per domain: add them to the domain JSON's \`logical.relationships[]\`, and leave that choice to the user (the **ERD Studio: Move Relationships to Model Library** command moves them). Never define the same two columns twice — not in both places, and not once in each direction; if a domain and the model YAML disagree, the model YAML wins.`;

/** How the parts refer to each other: files beside the skill, or parts of one inline guide. */
interface PartRefs { SKILL: string; DBML: string; LEGACY: string; BESIDE: string }

const SPLIT_REFS: PartRefs = {
  SKILL: '`SKILL.md`',
  DBML: '`DBML.md`',
  LEGACY: '`LEGACY.md`',
  BESIDE: ', both in the same folder as this file',
};

const INLINE_REFS: PartRefs = {
  SKILL: 'the "AI Data Modeling Guide" part of this guide',
  DBML: 'the "DBML format" part of this guide',
  LEGACY: 'the "YAML and JSON files" part of this guide',
  BESIDE: '',
};

function schemaPart(part: string, refs: PartRefs): string {
  return part.replace(/\{(SKILL|DBML|LEGACY|BESIDE)\}/g, (_, key: keyof PartRefs) => refs[key]);
}

/** The whole guide in one text, for the single-file targets (Copilot, Gemini). */
const SCHEMA_CONTENT = [SKILL_PART, DBML_PART, LEGACY_PART].map((part) => schemaPart(part, INLINE_REFS)).join('\n\n---\n\n');

/**
 * Codex reads `AGENTS.md` only up to its `project_doc_max_bytes` (32 KiB by
 * default), and the whole guide is far longer: the region carries the skill
 * part (which format to write, and every rule the formats share) and points
 * at the DBML and YAML/JSON parts in the Agent Skills folder, which the
 * Codex install writes beside it (`CODEX_COMPANIONS`), as the recommended
 * install does.
 */
const CODEX_REFS: PartRefs = {
  SKILL: 'the ERD Studio section of `AGENTS.md`',
  DBML: '`.agents/skills/erd-studio/DBML.md`',
  LEGACY: '`.agents/skills/erd-studio/LEGACY.md`',
  BESIDE: '. Read the one that applies before writing any `.erd-studio` file. Both are installed with this section (and with the Agent Skills install); if they are missing, ask the user to run **ERD Studio: Install AI Coding Harness** → OpenAI Codex (or **ERD Studio: Set Up My AI Helper**) again first, and never write a `.erd-studio` file without them',
};
const CODEX_CONTENT = schemaPart(SKILL_PART, CODEX_REFS);

/** The skill targets' `SKILL.md` body, and its two companions. */
const SKILL_CONTENT = schemaPart(SKILL_PART, SPLIT_REFS);
const DBML_CONTENT = schemaPart(DBML_PART, SPLIT_REFS);
const LEGACY_CONTENT = schemaPart(LEGACY_PART, SPLIT_REFS);

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
      "logicalModelPath": ".erd-studio/tables/silver/dim_customer.dbml",
      "relationshipsPath": ".erd-studio/tables/silver/_relationships.dbml",
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
- **modelContext**: File paths for every model referenced — use these to locate files to edit. \`logicalModelPath\` is the table's file (a \`.dbml\` table file, or a \`.yml\` in a project from before 2.0, or the path a new one gets); \`relationshipsPath\`, present only for a DBML table, is the \`_relationships.dbml\` that holds the Refs it owns
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

Write each change in the format of the file it touches (the schema skill's "What to write"): DBML for a \`.dbml\` table or diagram, YAML/JSON (legacy, below) for a \`.yml\` table or \`.json\` diagram. Quote every DBML custom value (\`natural_key: 'true'\`).

| Action | What to do (DBML) |
|--------|-----------|
| \`add-to-logical\` | Add a \`use { table <name> } from '…'\` line for the table to the diagram (and the \`use *\` line of its folder's \`_relationships.dbml\` when the diagram lacks it), and create the table file at \`logicalModelPath\` from manifest data unless a file for that name already exists in any folder. Copy the dbt \`meta\` keys the team's metadata list names, reading them from the schema yml or \`erd-studio inventory\`, not from the manifest (the schema skill's "The team's metadata list") |
| \`remove-from-logical\` | Delete the table's \`use\` line from the diagram (and its position from the layout file). The table file and its Refs stay |
| \`add-column-to-logical\` | Add a column line to the Table block in \`logicalModelPath\` (\`name TYPE [note: '…']\`), with the dbt column \`meta\` keys the team's metadata list names |
| \`remove-column-from-logical\` | Delete the column's line from \`logicalModelPath\`, and every Ref in a \`_relationships.dbml\` that names it |
| \`update-type-in-logical\` | Change the column's type in \`logicalModelPath\` to \`resolvedDataType\` (double-quoted when it is not a plain identifier: \`"DECIMAL(18,2)"\`) |
| \`add-relationship-to-logical\` | Add one Ref line to \`relationshipsPath\` of the many-side (FK) table — \`Ref: fk_table.fk_col >? pk_table.pk_col\` for many-to-one, \`Ref: pk_table.pk_col ?- fk_table.fk_col\` for one-to-one, \`<>?\` for many-to-many — plus a \`use { table x }\` line there for each table it names that the file does not import. A \`one-to-many\` is written from the other end as \`>?\` |
| \`remove-relationship-from-logical\` | Delete the matching Ref line from the \`_relationships.dbml\` that holds it (leave the \`use\` lines; doctor reports nothing for an unused one) |
| \`update-cardinality-in-logical\` | Rewrite the matching Ref's operator to \`targetCardinality\`; a change to \`one-to-many\` turns it round: \`>?\` from the other end, in the relationships file of that end's folder |

**Legacy (a \`.yml\` table or \`.json\` diagram, projects from before 2.0):**

| Action | What to do (YAML / JSON) |
|--------|-----------|
| \`add-to-logical\` | Add model name to domain JSON \`logical.models[]\` + create the model file from manifest data at \`logicalModelPath\` — \`logical-models/{layer}/{name}.yml\` (the plan's \`layer\`) when the project uses layer folders, else \`logical-models/{name}.yml\` — unless a file for that name already exists in any folder. Copy the dbt \`meta\` keys the team's metadata list names, as above |
| \`remove-from-logical\` | Remove model name from domain JSON \`logical.models[]\` + remove related relationships from \`logical.relationships[]\` |
| \`add-column-to-logical\` | Add column to the model's yml (\`modelContext[name].logicalModelPath\`) columns array, with the dbt column \`meta\` keys the team's metadata list names |
| \`remove-column-from-logical\` | Remove column from the model's yml (\`logicalModelPath\`) |
| \`update-type-in-logical\` | Update column \`dataType\` in the model's yml (\`logicalModelPath\`) to the value in \`resolvedDataType\` |
| \`add-relationship-to-logical\` | Add the relationship (fromModel/fromColumn/toModel/toColumn from the action) where the project keeps relationships — the many-side (FK) model's YAML \`relationships:\` or domain JSON \`logical.relationships[]\` (see "Where relationships live"). A \`one-to-many\` is written with its ends swapped as \`many-to-one\`, in the other model's file |
| \`remove-relationship-from-logical\` | Remove the matching relationship from wherever it is defined — the many-side (FK) model's YAML \`relationships:\` (either end's file, for one written before this rule) or domain JSON \`logical.relationships[]\` |
| \`update-cardinality-in-logical\` | Update \`cardinality\` on the matching relationship, wherever it is defined, to \`targetCardinality\`. In a model YAML, a change to \`one-to-many\` moves the entry: take it out, swap the ends and add it to the other model's file as \`many-to-one\` |

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
   - For logical-side actions: edit files at \`modelContext[modelName].logicalModelPath\`, \`relationshipsPath\` and/or the diagram file
   - For physical-side actions: edit files at \`modelContext[modelName].dbtSqlPath\` and \`dbtSchemaPath\`
   - For destructive actions (\`remove-*\`): confirm with the user before proceeding
3. **Compile** if \`requiresCompile\` is \`true\`: run \`dbt compile\` to regenerate the manifest
4. **Verify**: Re-open the domain in ERD Studio and run the diff comparison to confirm discrepancies are resolved
5. **Clean up**: Delete \`.erd-studio/.sync-plan.json\` on success

## Important Notes

- **Preserve positions**: Never clear or overwrite layout positions (a DBML diagram's \`.dbdiagram\` file, a JSON diagram's \`viewConfig.positions\`)
- **Match existing patterns**: When editing dbt YAML, follow the formatting and test patterns already present in the file
- **Cascade deletions**: When removing a model from a JSON domain, also remove the domain JSON's relationships referencing it. When renaming or deleting a table or column, update every Ref (DBML) or model YAML \`relationships:\` entry that points at it
- **Column ordering**: When adding columns, append them after the table's last column (before its \`indexes\` block and \`Note\` in DBML; to the end of the columns array in YAML)`;

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
  holds DBML tables, relationships and diagrams (YAML/JSON for older
  projects) with strict format rules you must read before editing. Use this
  skill whenever the task touches files in .erd-studio/ (.dbml tables,
  _relationships.dbml, .dbml diagrams, older .yml tables and .json diagrams,
  or .sync-plan.json), asks to add/edit/remove tables, columns,
  relationships, or cardinality in a data model or ERD diagram, mentions
  dim_/fct_/ref_/brg_ prefixed tables in an erd-studio context, or involves
  writing dbt schema YAML tests to match an ERD physical stage. The skill
  tells you which format and which file to edit for each operation —
  without it you will put data in the wrong file.
---

${SKILL_CONTENT}

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

/** `DBML.md`, the schema skill's companion: the DBML format in full. */
function generateDbmlGuide(): string {
  return `${DBML_CONTENT}

${buildVersionMarker()}
`;
}

/** `LEGACY.md`, the schema skill's companion: the YAML/JSON rules of projects from before 2.0, complete. */
function generateLegacyGuide(): string {
  return `${LEGACY_CONTENT}

${buildVersionMarker()}
`;
}

/** The schema skill's version-marked companions, beside its SKILL.md: `[file name, generator]`. */
const SKILL_COMPANIONS: ReadonlyArray<readonly [string, () => string]> = [
  ['SYNC.md', generateSyncGuide],
  ['DBML.md', generateDbmlGuide],
  ['LEGACY.md', generateLegacyGuide],
];

function generateCopilotInstructions(): string {
  return `---
name: 'ERD Studio'
description: 'Data modeling guide for ERD Studio — DBML tables, relationships and diagrams (YAML/JSON for older projects), dbt YAML tests for physical model, naming conventions'
applyTo: '**/.erd-studio/**'
---

${SCHEMA_CONTENT}

${buildVersionMarker()}
`;
}

function generateGeminiStyleguide(): string {
  return `${SCHEMA_CONTENT}

## Code Review Rules

### ERD Studio DBML files (\`.erd-studio/**/*.dbml\`)

1. **Custom values are quoted strings**, even \`'true'\` and numbers (\`natural_key: 'true'\`, \`scd_type: '2'\`, \`erd_schema_version: '7'\`): an unquoted value breaks DBML 9 and 10 tools
2. **One Table per table file**, named exactly as the file, unqualified (schema in \`[schema: '…']\`), with no \`use\`, \`Ref\` or inline \`[ref: …]\`
3. **Relationships** are \`Ref\` lines in the foreign-key table's folder's \`_relationships.dbml\`: \`>?\` many-to-one with the FK end first, \`?-\` one-to-one with the key end first, \`<>?\` many-to-many; never \`<\`; one Ref per pair of column sets across all files
4. **\`use\` lines**: a relationships file imports every table its Refs name; a diagram imports its tables (\`use { table x } from '…'\`, paths relative to the diagram) and the relationships file of each of their folders (\`use * from '…'\`)
5. **Diagrams** hold a \`Project\` with \`erd_schema_version: '7'\`, \`use\` lines and sticky \`Note\`s only — no Tables, Refs or TableGroups
6. **Model names** follow naming conventions: \`dim_\`, \`fct_\`, \`ref_\`, or \`brg_\` prefixes

### ERD Studio YAML/JSON files (projects from before 2.0: \`.erd-studio/**/*.json\`, \`*.yml\`)

7. **Required sections**: \`logical\` and \`viewConfig\` must both be present at root level of a subject area file, whose \`schemaVersion\` matches its naming (\`5\` or \`6\`)
8. **Relationships**: \`fromModel\` is always the many (FK) side, \`toModel\` is the PK side, and \`one-to-many\` is never written (swap the ends to \`many-to-one\`); each relationship is defined in exactly one place — the FK model's YAML \`relationships:\` or a domain's \`logical.relationships\`
9. **Logical columns** must have \`dataType\` and \`description\`
10. **Boolean key flags** (\`isPrimaryKey\`, \`isForeignKey\`, \`isNaturalKey\`) should only be present when \`true\`

### dbt YAML Schema Files

11. **PK columns** in logical model should have \`unique\` + \`not_null\` tests in dbt YAML
12. **FK columns** in logical model should have a \`relationships\` test pointing to the PK model/column
13. **Composite keys** should use \`dbt_utils.unique_combination_of_columns\` model-level test

${buildVersionMarker()}
`;
}

function generateCodexAgents(): string {
  return `
${CODEX_REGION_BEGIN}
${CODEX_SECTION_HEADING}

${CODEX_CONTENT}

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
  /** Every version-marked companion beside the schema skill (SYNC.md, DBML.md, LEGACY.md). */
  companions: string[];
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
    companions: SKILL_COMPANIONS.map(([name]) => `${base}/erd-studio/${name}`),
    setupDir,
    setupSkill: `${setupDir}/SKILL.md`,
    setupIgnore: `${setupDir}/`,
  };
}

/**
 * The companions Codex's `AGENTS.md` region points at (`CODEX_REFS`), in the
 * Agent Skills folder: `[workspace-relative path, generator]`.
 */
const CODEX_COMPANIONS: ReadonlyArray<readonly [string, () => string]> = SKILL_COMPANIONS
  .filter(([name]) => name === 'DBML.md' || name === 'LEGACY.md')
  .map(([name, generate]) => [`.agents/skills/erd-studio/${name}`, generate] as const);

/** Codex's version-marked companions, workspace-relative (see `CODEX_COMPANIONS`). */
export function codexManagedFiles(): string[] {
  return CODEX_COMPANIONS.map(([p]) => p);
}

function isSkillTarget(id: HarnessTarget['id']): id is SkillHarnessTarget {
  return id === 'claude' || id === 'agents';
}

/**
 * The Claude target's version-marked files, workspace-relative: the schema
 * skill, its companions (SYNC.md, DBML.md, LEGACY.md) and the setup skill's
 * SKILL.md. Staleness is judged per file (see `detectStale`).
 */
export function claudeManagedFiles(): string[] {
  const p = skillTargetPaths('claude');
  return [p.schemaSkill, ...p.companions, p.setupSkill];
}

/** The `agents` target's version-marked files: the same, under `.agents/skills/`. */
export function agentsManagedFiles(): string[] {
  const p = skillTargetPaths('agents');
  return [p.schemaSkill, ...p.companions, p.setupSkill];
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
  return stateOfVersion(version);
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
   * A hand-written SKILL.md companion (SYNC.md, DBML.md, LEGACY.md with no
   * marker) is replaced only with `replaceUnmanagedCompanions`, the same
   * confirmed Replace; every other caller (Update All) leaves it alone.
   */
  install(
    workspaceRoot: string,
    target: HarnessTarget,
    overwrite: boolean = false,
    options: { replaceUnmanagedSetupSkill?: boolean; keepUnmanagedPrimary?: boolean; replaceUnmanagedCompanions?: boolean } = {},
  ): HarnessInstallResult {
    const filePath = path.join(workspaceRoot, target.relativePath);
    const dir = path.dirname(filePath);
    const alreadyExisted = fs.existsSync(filePath);
    const skillTarget = isSkillTarget(target.id) ? target.id : null;
    const keepPrimary = options.keepUnmanagedPrimary === true && skillTarget !== null
      && alreadyExisted && fileState(filePath) === 'unmanaged';
    // A file from a newer ERD Studio (a teammate's) is never replaced with older text.
    const primaryNewer = alreadyExisted && target.id !== 'codex' && fileState(filePath) === 'newer';

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
        const region = findCodexRegion(existing);
        const hasSection = region !== null;
        const regionVersion = region ? extractHarnessVersion(existing.slice(region.start, region.end)) : null;
        // A region from a newer ERD Studio (a teammate's) is never replaced with older text.
        if ((hasSection && !overwrite) || (regionVersion !== null && isNewerHarnessVersion(regionVersion))) {
          // The region stays; a missing or outdated companion it points at is still put right.
          return {
            target,
            success: true,
            filePath,
            alreadyExisted: true,
            filesWritten: this.writeCodexCompanions(workspaceRoot, { repairOnly: true, replaceUnmanaged: false }),
          };
        }
        fs.writeFileSync(filePath, mergeCodexContent(existing, content), 'utf-8');
      } else if (keepPrimary || primaryNewer) {
        // "Keep mine": the user's SKILL.md stays exactly as it is; a newer one too.
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
      const filesWritten: string[] = keepPrimary || primaryNewer ? [] : [rel(filePath)];

      // Codex's region points at the DBML and YAML/JSON parts: they come with it (§7.3).
      if (target.id === 'codex') {
        filesWritten.push(...this.writeCodexCompanions(workspaceRoot, { repairOnly: false, replaceUnmanaged: options.replaceUnmanagedCompanions === true }));
      }

      // Companion files for the two skill targets
      let setupDirExisted = true;
      if (skillTarget) {
        const paths = skillTargetPaths(skillTarget);
        // SYNC.md, DBML.md, LEGACY.md — loaded on demand beside SKILL.md.
        // A hand-written companion (no marker) is kept unless the user
        // confirmed Replace, and a newer one (a teammate's) is never replaced.
        for (const [name, generate] of SKILL_COMPANIONS) {
          const companionPath = path.join(dir, name);
          const state = fileState(companionPath);
          if ((state === 'unmanaged' && (keepPrimary || options.replaceUnmanagedCompanions !== true)) || state === 'newer') continue;
          fs.writeFileSync(companionPath, applySemanticDir(generate(), this.semanticDir), 'utf-8');
          filesWritten.push(rel(companionPath));
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
   * The files Codex's `AGENTS.md` region points at (`CODEX_REFS`):
   * `.agents/skills/erd-studio/DBML.md` and `LEGACY.md`, byte for byte the
   * Agent Skills target's copies, so a Codex-only install is never left
   * without the format rules. A hand-written one (no marker) is kept unless
   * the user confirmed Replace (`replaceUnmanaged`), and a newer one (a
   * teammate's) is never replaced. `repairOnly` writes only a missing or
   * outdated one. Returns the workspace-relative paths written.
   */
  private writeCodexCompanions(workspaceRoot: string, options: { repairOnly: boolean; replaceUnmanaged: boolean }): string[] {
    const written: string[] = [];
    for (const [relativePath, generate] of CODEX_COMPANIONS) {
      const filePath = path.join(workspaceRoot, ...relativePath.split('/'));
      const state = fileState(filePath);
      if (state === 'newer' || (state === 'unmanaged' && !options.replaceUnmanaged)) continue;
      if (options.repairOnly && state !== 'missing' && state !== 'outdated') continue;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, applySemanticDir(generate(), this.semanticDir), 'utf-8');
      written.push(relativePath);
    }
    return written;
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
    const state = fileState(path.join(workspaceRoot, paths.setupSkill));
    if ((!replaceUnmanaged && state === 'unmanaged') || state === 'newer') {
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
   * The schema skill's files exactly as `install()` writes them for a skill
   * target: `[file name, content]` for `SKILL.md`, `SYNC.md`, `DBML.md` and
   * `LEGACY.md`. Exposed for tests and for anything that needs the installed
   * text without writing it.
   */
  schemaSkillFiles(): Array<[string, string]> {
    return [
      ['SKILL.md', this.generateContent('claude')],
      ...SKILL_COMPANIONS.map(([name, generate]): [string, string] => [name, applySemanticDir(generate(), this.semanticDir)]),
    ];
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
      // Only an older marker is stale: a newer one is a teammate's, never replaced.
      if (stateOfVersion(version) === 'outdated') {
        stale.push(target);
      } else if (version === HARNESS_VERSION && isSkillTarget(target.id) && this.skillCompanionsStale(workspaceRoot, target.id)) {
        stale.push(target);
      } else if (version === HARNESS_VERSION && target.id === 'codex' && this.codexCompanionsStale(workspaceRoot)) {
        stale.push(target);
      }
    }
    return stale;
  }

  /**
   * Per-file staleness of a managed skill install's companions. A companion
   * (SYNC.md, DBML.md, LEGACY.md) missing or carrying an older marker is
   * stale, so a partial install gets repaired. The setup skill is stale only
   * when it carries an older marker: a *missing* one is reported by
   * `harnessStatus()` instead (the v18 "Update All" writes it anyway), an
   * unmarked one is the user's, and a newer one a teammate's.
   */
  private skillCompanionsStale(workspaceRoot: string, target: SkillHarnessTarget): boolean {
    const paths = skillTargetPaths(target);
    for (const companion of paths.companions) {
      const state = fileState(path.join(workspaceRoot, companion));
      if (state === 'missing' || state === 'outdated') { return true; }
    }
    return fileState(path.join(workspaceRoot, paths.setupSkill)) === 'outdated';
  }

  /** A Codex companion (`CODEX_COMPANIONS`) missing or carrying an older marker. */
  private codexCompanionsStale(workspaceRoot: string): boolean {
    return codexManagedFiles().some((p) => {
      const state = fileState(path.join(workspaceRoot, ...p.split('/')));
      return state === 'missing' || state === 'outdated';
    });
  }

  /** Schema skill (folding in SYNC.md) and setup skill state for one skill folder. */
  private skillFolderStatus(workspaceRoot: string, target: SkillHarnessTarget): { schemaSkill: FileState; setupSkill: FileState } {
    const paths = skillTargetPaths(target);
    let schemaSkill = fileState(path.join(workspaceRoot, paths.schemaSkill));
    if (schemaSkill === 'current') {
      const companions = paths.companions.map((c) => fileState(path.join(workspaceRoot, c)));
      if (companions.some((c) => c === 'missing' || c === 'outdated')) { schemaSkill = 'outdated'; }
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
        codex = version === null ? 'outdated' : stateOfVersion(version);
        // A current region whose companions are missing or older reads as outdated, as a skill folder's does.
        if (codex === 'current' && this.codexCompanionsStale(workspaceRoot)) codex = 'outdated';
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
      // A hand-written SYNC.md / DBML.md / LEGACY.md is the user's too: asked about, never silently replaced.
      for (const companion of paths.companions) {
        if (fileState(path.join(workspaceRoot, companion)) === 'unmanaged') { unmanaged.push(companion); }
      }
    }
    const keep = options.keepUnmanaged === true && !options.replaceUnmanaged;
    if (unmanaged.length > 0 && !options.replaceUnmanaged && !keep) {
      return { status: 'needs-confirmation', unmanaged, filesWritten: [], targets };
    }

    // A newer file (a teammate on a later ERD Studio) is never replaced, so it counts as up to date.
    const fine = (state: FileState): boolean => state === 'current' || state === 'newer';
    // A hand-written companion the user chose to replace is not up to date either.
    const replacing = (t: SkillHarnessTarget): boolean => options.replaceUnmanaged
      && skillTargetPaths(t).companions.some((c) => unmanaged.includes(c));
    const upToDate = (t: SkillHarnessTarget) => fine(status[t].schemaSkill) && fine(status[t].setupSkill)
      && (t !== 'claude' || status.claude.hookRegistered) && !replacing(t);
    if (targets.every(upToDate)) {
      return { status: 'unchanged', unmanaged: [], filesWritten: [], targets };
    }

    const filesWritten: string[] = [];
    for (const t of targets) {
      if (upToDate(t)) { continue; }
      const target = HARNESS_TARGETS.find((h) => h.id === t)!;
      const result = this.install(workspaceRoot, target, true, {
        replaceUnmanagedSetupSkill: options.replaceUnmanaged,
        replaceUnmanagedCompanions: options.replaceUnmanaged,
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
