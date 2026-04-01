/**
 * HarnessService — generates AI coding assistant configuration files.
 *
 * Supports installing ERD Studio schema reference into:
 *   - Claude Code (.claude/skills/erd-studio/SKILL.md)
 *   - GitHub Copilot (.github/instructions/erd-studio.instructions.md)
 *   - Google Gemini (.gemini/styleguide.md)
 *   - OpenAI Codex (AGENTS.md)
 *
 * Each harness uses a different file format and location, but the core
 * content (ERD Studio schema reference) is the same across all.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Version marker — embedded in every generated harness file
// ---------------------------------------------------------------------------

/** Version of the harness content. Bump when SCHEMA_CONTENT or generators change. */
export const HARNESS_VERSION = '12';

const VERSION_MARKER_PREFIX = '<!-- erd-studio-harness:';
const VERSION_MARKER_SUFFIX = ' -->';

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
  id: 'claude' | 'copilot' | 'gemini' | 'codex';
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

ERD Studio uses a **central model store** architecture. Model definitions are YAML files in \`erd-studio/logical-models/\`. Domain JSON files reference models by name and define relationships and layout.

## Architecture Overview

\`\`\`
erd-studio/
├── logical-models/           ← Central model definitions (YAML, one per model)
│   ├── dim_customer.yml
│   ├── dim_project.yml
│   └── fct_sale.yml
├── silver/
│   ├── customer-360.json     ← Domain file (model references + relationships + layout)
│   └── orders.json
└── gold/
    └── reporting.json
\`\`\`

**Key principle:** Models are defined ONCE in \`logical-models/\` and referenced from multiple domain files. Editing a model from any domain updates the shared definition.

### Model Library (Sidebar)

The **Model Library** panel in the ERD Studio sidebar shows all YAML files in \`logical-models/\`. Use it to understand the difference between "model definition exists" and "model is referenced by a domain":

- **Referenced models** show how many domains use them (e.g. "2 domains")
- **Orphaned models** show a warning icon and "(unused)" — these exist as \`.yml\` files but are not in any domain's \`logical.models[]\` array

**Important for AI agents:** Before saying a model "already exists in the ERD", check whether it is referenced by the target domain's \`logical.models[]\` array — not just whether the \`.yml\` file exists. A model file in \`logical-models/\` may be unused (orphaned) or only referenced by other domains.

## Domain File Structure

**File:** \`erd-studio/{layer}/{domain}.json\`

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
| \`logical.models\` | Yes | Array of model name strings (references to \`logical-models/*.yml\`) |
| \`logical.relationships\` | Yes | Array of relationship objects |
| \`viewConfig\` | Yes | Root-level view settings. The extension auto-assigns positions for new models |

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
| Add/remove/rename a column | \`logical-models/{name}.yml\` |
| Change column type, PK/FK/NK flags, SCD type | \`logical-models/{name}.yml\` |
| Change grain, modelRole, description, rationale | \`logical-models/{name}.yml\` |
| Add a model to a domain diagram | Domain \`.json\` → add name to \`logical.models[]\` AND create \`logical-models/{name}.yml\` if it doesn't exist |
| Remove a model from a domain | Domain \`.json\` → remove name from \`logical.models[]\` AND remove its relationships from \`logical.relationships[]\` |
| Add/remove/edit a relationship | Domain \`.json\` → \`logical.relationships[]\` |
| Change layout positions | Domain \`.json\` → \`viewConfig.positions\` |

> **Common mistake:** Editing the \`.yml\` file alone is sufficient for column and model property changes — the extension picks up YAML changes automatically. But adding a model to the **diagram** requires BOTH creating the \`.yml\` AND adding the name string to the domain \`.json\`. Similarly, relationships are ONLY stored in the domain \`.json\`, never in the \`.yml\`.

---

## Models

Model definitions live in \`erd-studio/logical-models/{model_name}.yml\`. Create/edit these YAML files to define models. Then reference them by name in domain files.

**File:** \`erd-studio/logical-models/dim_customer.yml\`

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

The physical stage has **no files on disk**. It is derived at runtime primarily from dbt \`.yml\` schema files, with optional enrichment from \`target/manifest.json\`:

1. **Models**: Logical models that have a corresponding \`.yml\` schema file appear in physical. Columns come from the \`.yml\` file; \`data_type\` is enriched from the manifest when available. PK/FK/NK flags, grain, modelRole, scdType, and additiveType carry forward from logical.
2. **Relationships**: Derived from **dbt relationship tests declared in \`.yml\` files** — not copied from logical. Each \`relationships\` test becomes an edge.
3. **Cardinality**: Derived from **uniqueness tests** in \`.yml\` files (and manifest when available) — no \`unique\` test = "many" side.
4. **Scoping**: Only relationships between models **within the same domain** appear. References to models outside the domain are silently excluded.
5. **Fallback**: If no \`.yml\` files are found, the physical stage falls back to deriving entirely from \`target/manifest.json\`.

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

When asked to execute a sync plan, or when \`erd-studio/.sync-plan.json\` exists:

1. Read \`SYNC.md\` in the same directory as this skill file for the full action reference and execution guide
2. Read \`erd-studio/.sync-plan.json\` for the specific actions to execute
3. Follow the execution steps in SYNC.md to reconcile logical and physical models`;

// ---------------------------------------------------------------------------
// Sync guide content (companion file — loaded on demand)
// ---------------------------------------------------------------------------

const SYNC_CONTENT = `# ERD Studio — Sync Reconciliation Guide

This guide is loaded when you need to execute a sync plan generated by ERD Studio.
The sync plan reconciles differences between the **logical** (user-defined) and
**physical** (dbt manifest-derived) stages of a domain.

## When to Use

When \`erd-studio/.sync-plan.json\` exists in the project, the user has reviewed
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
      "logicalModelPath": "erd-studio/logical-models/dim_customer.yml",
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
      "sourceDataType": "VARCHAR"
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

## Action Reference

### Logical-side actions (edit ERD Studio files)

| Action | What to do |
|--------|-----------|
| \`add-to-logical\` | Add model name to domain JSON \`logical.models[]\` + create \`logical-models/{name}.yml\` from manifest data |
| \`remove-from-logical\` | Remove model name from domain JSON \`logical.models[]\` + remove related relationships from \`logical.relationships[]\` |
| \`add-column-to-logical\` | Add column to \`logical-models/{name}.yml\` columns array |
| \`remove-column-from-logical\` | Remove column from \`logical-models/{name}.yml\` |
| \`update-type-in-logical\` | Update column \`dataType\` in \`logical-models/{name}.yml\` to the value in \`targetDataType\` |
| \`add-relationship-to-logical\` | Add relationship object to domain JSON \`logical.relationships[]\` using the fromModel/fromColumn/toModel/toColumn from the action |
| \`remove-relationship-from-logical\` | Remove the matching relationship from domain JSON \`logical.relationships[]\` |
| \`update-cardinality-in-logical\` | Update \`cardinality\` field on matching relationship in domain JSON to \`targetCardinality\` |

### Physical-side actions (edit dbt project files)

| Action | What to do |
|--------|-----------|
| \`add-to-physical\` | Create dbt SQL model file + schema YAML entry (confirm with user first — this is a major change) |
| \`remove-from-physical\` | Remove dbt SQL file + schema YAML entry (confirm with user first — destructive) |
| \`add-column-to-physical\` | Add column to the dbt SQL SELECT statement + add column entry to schema YAML |
| \`remove-column-from-physical\` | Remove column from dbt SQL SELECT + schema YAML (confirm with user first) |
| \`update-type-in-physical\` | Update column casting in dbt SQL or \`data_type\` in schema YAML to \`sourceDataType\` |
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

1. **Read** \`erd-studio/.sync-plan.json\`
2. **Execute each action** in order:
   - For logical-side actions: edit files at \`modelContext[modelName].logicalModelPath\` and/or the domain JSON
   - For physical-side actions: edit files at \`modelContext[modelName].dbtSqlPath\` and \`dbtSchemaPath\`
   - For destructive actions (\`remove-*\`): confirm with the user before proceeding
3. **Compile** if \`requiresCompile\` is \`true\`: run \`dbt compile\` to regenerate the manifest
4. **Verify**: Re-open the domain in ERD Studio and run the diff comparison to confirm discrepancies are resolved
5. **Clean up**: Delete \`erd-studio/.sync-plan.json\` on success

## Important Notes

- **Preserve viewConfig.positions**: Never clear or overwrite layout positions in domain JSON
- **Match existing patterns**: When editing dbt YAML, follow the formatting and test patterns already present in the file
- **Cascade deletions**: When removing a model from logical, also remove any relationships referencing it
- **Column ordering**: When adding columns to logical-models YAML, append to the end of the columns array`;

// ---------------------------------------------------------------------------
// Format-specific generators
// ---------------------------------------------------------------------------

function generateClaudeSkill(): string {
  return `---
name: erd-studio
description: Data modeling guide for ERD Studio — covers logical domain JSON format, dbt YAML tests for physical model relationships and cardinality, naming conventions, and design workflow. Use when creating, editing, or validating data models, dbt schema files, or executing a .sync-plan.json reconciliation plan.
---

${SCHEMA_CONTENT}

${buildVersionMarker()}
`;
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
applyTo: '**/erd-studio/**/*.json'
---

${SCHEMA_CONTENT}

${buildVersionMarker()}
`;
}

function generateGeminiStyleguide(): string {
  return `${SCHEMA_CONTENT}

## Code Review Rules

### ERD Studio Domain Files (\`erd-studio/**/*.json\`)

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
## ERD Studio Domain Files

${SCHEMA_CONTENT}

${buildVersionMarker()}
`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class HarnessService {
  /**
   * Generate the config file content for a given harness target.
   */
  generateContent(targetId: HarnessTarget['id']): string {
    switch (targetId) {
      case 'claude':
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
   * For Codex (AGENTS.md), appends to existing file if present.
   * For all others, creates the file (with confirmation if it already exists).
   */
  install(
    workspaceRoot: string,
    target: HarnessTarget,
    overwrite: boolean = false,
  ): HarnessInstallResult {
    const filePath = path.join(workspaceRoot, target.relativePath);
    const dir = path.dirname(filePath);
    const alreadyExisted = fs.existsSync(filePath);

    try {
      // Ensure parent directory exists
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const content = this.generateContent(target.id);

      if (target.id === 'codex' && alreadyExisted && !overwrite) {
        // Append to existing AGENTS.md
        const existing = fs.readFileSync(filePath, 'utf-8');
        if (existing.includes('## ERD Studio Domain Files')) {
          return {
            target,
            success: true,
            filePath,
            alreadyExisted: true,
          };
        }
        fs.appendFileSync(filePath, '\n' + content, 'utf-8');
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

      // Write companion SYNC.md for Claude harness (progressive context loading)
      if (target.id === 'claude') {
        const syncPath = path.join(dir, 'SYNC.md');
        fs.writeFileSync(syncPath, generateSyncGuide(), 'utf-8');
      }

      // Add to .gitignore on first install only — subsequent updates and
      // version bumps skip this so the user can remove the entry if they
      // want the harness files tracked in version control.
      if (!alreadyExisted && target.gitignorePattern) {
        try {
          this.addToGitignore(workspaceRoot, target.gitignorePattern);
        } catch {
          // Best-effort — don't fail the install if .gitignore is unwritable
        }
      }

      return {
        target,
        success: true,
        filePath,
        alreadyExisted,
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
   * Add a pattern to the workspace .gitignore if not already present.
   * Only called on first install — subsequent updates skip this so users
   * who remove the entry don't have it re-added.
   */
  private addToGitignore(workspaceRoot: string, pattern: string): void {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
      // Check if the pattern is already present (exact line match)
      const lines = content.split('\n').map(l => l.trim());
      if (lines.includes(pattern)) { return; }
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
        return;
      }
    }

    // No existing section — append a new one
    const needsLeadingNewline = content.length > 0 && !content.endsWith('\n');
    fs.appendFileSync(gitignorePath, (needsLeadingNewline ? '\n' : '') + section, 'utf-8');
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
   * current HARNESS_VERSION.  Returns only targets that exist AND are stale
   * (missing marker or older version).
   */
  detectStale(workspaceRoot: string): HarnessTarget[] {
    const stale: HarnessTarget[] = [];
    for (const target of HARNESS_TARGETS) {
      const filePath = path.join(workspaceRoot, target.relativePath);
      if (!fs.existsSync(filePath)) { continue; }

      const content = fs.readFileSync(filePath, 'utf-8');

      // For Codex, only consider it an ERD Studio harness if our section exists
      if (target.id === 'codex' && !content.includes('## ERD Studio Domain Files')) {
        continue;
      }

      const version = extractHarnessVersion(content);
      if (version !== HARNESS_VERSION) {
        stale.push(target);
      }
    }
    return stale;
  }
}
