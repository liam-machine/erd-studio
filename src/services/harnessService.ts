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
export const HARNESS_VERSION = '4';

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
  },
  {
    label: '$(github) GitHub Copilot',
    id: 'copilot',
    description: '.github/instructions/erd-studio.instructions.md',
    relativePath: '.github/instructions/erd-studio.instructions.md',
  },
  {
    label: '$(sparkle) Google Gemini',
    id: 'gemini',
    description: '.gemini/styleguide.md',
    relativePath: '.gemini/styleguide.md',
  },
  {
    label: '$(code) OpenAI Codex',
    id: 'codex',
    description: 'codex-erd-studio.md (appended to AGENTS.md)',
    relativePath: 'AGENTS.md',
  },
];

// ---------------------------------------------------------------------------
// Core schema content (shared across all harnesses)
// ---------------------------------------------------------------------------

const SCHEMA_CONTENT = `# ERD Studio — AI Data Modeling Guide

Generate domain JSON files that render as ERD canvases in ERD Studio. Each file defines a logical data model with models, columns, and relationships.

## Domain File Structure

**File:** \`erd-studio/{layer}/{domain}.json\`

\`\`\`json
{
  "schemaVersion": 4,
  "domain": "customer-360",
  "layer": "silver",
  "description": "Customer domain — master data and transaction history",
  "modelFolder": "models/silver",
  "logical": {
    "models": [],
    "relationships": []
  },
  "viewConfig": {}
}
\`\`\`

| Field | Required | Description |
|-------|----------|-------------|
| \`schemaVersion\` | Yes | Must be \`4\` |
| \`domain\` | Yes | Domain slug (matches filename without \`.json\`) |
| \`layer\` | Yes | Layer name matching parent directory (e.g. \`silver\`, \`gold\`) |
| \`description\` | No | Human-readable domain description |
| \`modelFolder\` | No | Filter for "Add Existing Model" dialog (e.g. \`models/silver\`) |
| \`logical\` | Yes | Contains \`models\` and \`relationships\` arrays |
| \`viewConfig\` | Yes | Root-level view settings. Leave as \`{}\` — the extension auto-layouts on first open |

**viewConfig** must be at the root level, not inside \`logical\`. It stores node positions keyed by model name:

\`\`\`json
"viewConfig": { "positions": { "dim_customer": { "x": 100, "y": 200 } } }
\`\`\`

---

## Models

\`\`\`json
{
  "name": "dim_customer",
  "schema": "silver",
  "description": "Customer master data",
  "grain": "One row per customer",
  "modelRole": "conformed-dim",
  "columns": [
    { "name": "customer_id", "dataType": "INT", "description": "Surrogate key", "isPrimaryKey": true, "scdType": 0 },
    { "name": "email", "dataType": "VARCHAR", "description": "Email address", "isNaturalKey": true, "scdType": 1 },
    { "name": "full_name", "dataType": "VARCHAR", "description": "Customer display name", "scdType": 2 }
  ],
  "rationale": {
    "purpose": "Customer master data for cross-domain joins",
    "roleChoice": "Conformed dimension shared across domains"
  }
}
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

The physical stage has **no files on disk**. It is derived at runtime from the dbt manifest (\`target/manifest.json\`):

1. **Models**: Logical models that exist in the manifest appear in physical. Columns come from the manifest; PK/FK/NK flags, grain, modelRole, scdType, and additiveType carry forward from logical.
2. **Relationships**: Derived from **dbt relationship tests** — not copied from logical. Each \`relationships\` test becomes an edge.
3. **Cardinality**: Derived from **uniqueness tests** — no \`unique\` test = "many" side.
4. **Scoping**: Only relationships between models **within the same domain** appear. References to models outside the domain are silently excluded.

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
| Composite PK | \`dbt_utils.unique_combination_of_columns\` model-level test |`;

// ---------------------------------------------------------------------------
// Format-specific generators
// ---------------------------------------------------------------------------

function generateClaudeSkill(): string {
  return `---
name: erd-studio
description: Data modeling guide for ERD Studio — covers logical domain JSON format, dbt YAML tests for physical model relationships and cardinality, naming conventions, and design workflow. Use when creating, editing, or validating data models or dbt schema files.
---

${SCHEMA_CONTENT}

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

1. **Schema version** must be \`4\`
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
