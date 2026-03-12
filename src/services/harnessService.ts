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
export const HARNESS_VERSION = '3';

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

Design data warehouse models across two stages: logical → physical. This guide covers the domain JSON format and how to write dbt YAML that produces a correct physical model.

## Quick Reference

**File:** \`erd-studio/{layer}/{domain}.json\` — one file per domain containing a \`logical\` section.

\`\`\`json
{
  "schemaVersion": 4,
  "domain": "{domain}",
  "layer": "silver",
  "description": "Domain description",
  "modelFolder": "models/silver",
  "logical": { "models": [], "relationships": [] },
  "viewConfig": {}
}
\`\`\`

Required fields: \`schemaVersion\`, \`domain\`, \`layer\`, \`logical\`, \`viewConfig\`.

**viewConfig** lives at the root level and applies to all stages. Leave empty for new domains — the extension auto-layouts on first open.

\`\`\`json
"viewConfig": { "positions": { "dim_customer": { "x": 100, "y": 200 } } }
\`\`\`

---

## Logical Design

The \`logical\` section is the detailed blueprint. Models should have full columns with data types, PK/FK/NK flags, grain, model role, and rationale.

### Model

\`\`\`json
{
  "name": "dim_customer",
  "schema": "silver",
  "description": "Customer master data",
  "grain": "One row per customer",
  "modelRole": "conformed-dim",
  "columns": [
    { "name": "customer_id", "dataType": "INTEGER", "description": "Surrogate key", "isPrimaryKey": true, "scdType": 0 },
    { "name": "email", "dataType": "STRING", "description": "Email address", "isNaturalKey": true, "scdType": 1 }
  ],
  "rationale": {
    "purpose": "Customer master data for cross-domain joins",
    "roleChoice": "Conformed dimension shared across domains"
  }
}
\`\`\`

### Column Definition

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| \`name\` | string | Yes | Column identifier |
| \`dataType\` | string | Logical: Yes | SQL type (STRING, INTEGER, BOOLEAN, DATE, DECIMAL(18,2), TIMESTAMP_NTZ) |
| \`description\` | string | Logical: Yes | Human-readable description |
| \`isPrimaryKey\` | boolean | No | Marks as PK. Only include when \`true\`. |
| \`isForeignKey\` | boolean | No | FK intent flag. Only include when \`true\`. |
| \`isNaturalKey\` | boolean | No | Business identifier. Only include when \`true\`. |
| \`scdType\` | \`0\`, \`1\`, \`2\` | No | SCD type for dimension columns |
| \`additiveType\` | string | No | Fact measures: \`"additive"\`, \`"semi-additive"\`, \`"non-additive"\` |

### Relationships

\`\`\`json
{
  "fromModel": "fct_orders", "fromColumn": "customer_id",
  "toModel": "dim_customer", "toColumn": "customer_id",
  "cardinality": "many-to-one"
}
\`\`\`

\`fromModel\` is the FK side. \`toModel\` is the PK side.

Cardinality values: \`many-to-one\` | \`one-to-one\` | \`one-to-many\` | \`many-to-many\`

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

Optional \`rationale\` object. All fields are optional strings: \`purpose\`, \`design\`, \`roleChoice\`, \`grainChoice\`, \`scdStrategy\`, \`measures\`. Omit entirely if empty.

### Naming Conventions

| Type | Prefix | PK Pattern | Example |
|------|--------|-----------|---------|
| Dimension | \`dim_\` | \`{entity}_id\` | \`dim_project\` → \`project_id\` |
| Fact | \`fct_\` | \`{entity}_id\` or composite | \`fct_order\` → \`order_id\` |
| Reference | \`ref_\` | \`ref_{entity}_code\` | \`ref_country\` → \`ref_country_code\` |
| Bridge | \`brg_\` | composite FK pair | \`brg_project_contact\` |

FK columns match the PK name of the referenced table.

---

## Physical Realization via dbt

The physical stage is **read-only** and has **no files on disk**. It is derived entirely from the dbt manifest (\`target/manifest.json\`) after running \`dbt compile\` or \`dbt build\`.

Understanding how the physical stage works is critical for AI-assisted modeling: it tells you what dbt YAML to write so the physical stage matches the logical design.

### How Physical Models Are Derived

1. **Models**: Logical models that also exist in the manifest appear in the physical stage. Columns come from the manifest; PK/FK/NK flags, grain, and model role carry forward from logical.
2. **Relationships**: Derived from **dbt relationship tests** in the manifest — NOT copied from logical. Each \`relationships\` test in your YAML becomes one edge.
3. **Cardinality**: Derived from **uniqueness tests** in the manifest — dbt's \`relationships\` test only checks referential integrity, not cardinality.

### Cardinality Rules

| FK column has \`unique\` test? | PK column has \`unique\` test? | Derived Cardinality |
|-------------------------------|-------------------------------|---------------------|
| No | Yes | \`many-to-one\` |
| Yes | Yes | \`one-to-one\` |
| Yes | No | \`one-to-many\` |
| No | No | \`many-to-many\` |

**No \`unique\` test = "many" side.** This is deliberate — the physical model reflects what is tested, not what is assumed.

### Writing dbt YAML for Correct Physical Relationships

To produce a \`many-to-one\` relationship from \`fct_orders.customer_id\` → \`dim_customer.customer_id\`, write:

\`\`\`yaml
models:
  - name: dim_customer
    columns:
      - name: customer_id
        tests:
          - unique           # Makes this side "one"
          - not_null

  - name: fct_orders
    columns:
      - name: order_id
        tests:
          - unique
          - not_null
      - name: customer_id
        tests:
          - not_null
          - relationships:   # Creates the edge in the physical model
              to: ref('dim_customer')
              field: customer_id
          # No unique test on FK column → "many" side
\`\`\`

### Composite Keys

For composite primary keys, use \`dbt_utils.unique_combination_of_columns\`:

\`\`\`yaml
models:
  - name: brg_project_contact
    tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns:
            - project_id
            - contact_id
    columns:
      - name: project_id
        tests:
          - relationships:
              to: ref('dim_project')
              field: project_id
      - name: contact_id
        tests:
          - relationships:
              to: ref('dim_contact')
              field: contact_id
\`\`\`

The composite unique test is recognized when **all** columns in the group are covered by relationship tests between the same model pair.

### Custom Relationship Tests

These test variants are also recognized: \`relationships_where\` (dbt_utils) and any custom test with the standard kwargs signature (\`column_name\`, \`field\`, \`to\`).

### Domain Scoping

Physical relationships are scoped to models within the current domain. If \`dim_customer\` is a conformed dimension referenced by many models, only relationships to other models **in the same domain** appear.

---

## Design Workflow

### From Logical to Physical — Checklist

When implementing a logical model in dbt, ensure each logical element has a corresponding dbt test:

| Logical Element | dbt YAML Required |
|----------------|-------------------|
| PK column (\`isPrimaryKey: true\`) | \`unique\` + \`not_null\` tests on that column |
| FK column (\`isForeignKey: true\`) | \`relationships\` test pointing to the PK model/column |
| Relationship with cardinality | \`relationships\` test on FK column + \`unique\` test on PK column |
| Composite PK | \`dbt_utils.unique_combination_of_columns\` model-level test |

### Discrepancy Resolution

The discrepancy overlay in ERD Studio compares stages. Common issues when comparing physical to logical:

| Discrepancy | Cause | Fix |
|------------|-------|-----|
| Missing relationship in physical | No \`relationships\` test in YAML | Add \`relationships\` test to the FK column |
| Cardinality mismatch (many-to-many vs many-to-one) | PK column missing \`unique\` test | Add \`unique\` test to the PK column |
| Missing model in physical | Model not compiled into manifest | Run \`dbt compile\` or check model is not disabled |
| Extra column in physical | Column in manifest but not in logical | Add the column to the logical model, or remove from dbt model |`;

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
