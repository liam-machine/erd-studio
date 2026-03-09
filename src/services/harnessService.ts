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
export const HARNESS_VERSION = '1';

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

const SCHEMA_CONTENT = `# ERD Studio JSON Schema

Schema reference for ERD Studio domain files (schemaVersion 3, unified format with three-stage architecture).

## File Location

\`\`\`
erd-studio/{layer}/{domain}.json
\`\`\`

Where \`{layer}\` is a configured layer (e.g., \`silver\`, \`gold\`). Each file contains both conceptual and logical stages as sections. Physical stage has no files — it is derived at runtime from the dbt manifest.

## Top-Level Structure

\`\`\`json
{
  "schemaVersion": 3,
  "domain": "{domain}",
  "layer": "silver",
  "description": "Domain description",
  "modelFolder": "models/silver",
  "conceptual": {
    "models": [],
    "relationships": []
  },
  "logical": {
    "models": [],
    "relationships": []
  },
  "viewConfig": {}
}
\`\`\`

Required fields: \`schemaVersion\`, \`domain\`, \`layer\`, \`conceptual\`, \`logical\`, \`viewConfig\`.

## Stages

**Conceptual** (\`conceptual\` section) — High-level planning. Models can omit \`columns\` entirely (entity-level only). Focus on entity names, descriptions, relationships, and model roles.

**Logical** (\`logical\` section) — Detailed blueprint. Models should have full \`columns\` with \`dataType\` and \`description\`. PK/FK/NK flags, \`grain\`, \`modelRole\`, and \`rationale\` should be populated where known.

**Physical** — No files. Derived at runtime from the dbt manifest. Read-only but nodes are draggable.

## viewConfig (Global Positioning)

The \`viewConfig\` lives at the **root level** and applies to **all stages**. It stores node positions as a global map.

\`\`\`json
"viewConfig": {
  "positions": {
    "dim_customer": { "x": 100, "y": 200 },
    "fct_orders": { "x": 400, "y": 200 }
  }
}
\`\`\`

Leave empty for new domains — the extension auto-layouts on first open.

## Model

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

## Column Definition

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

## Relationships

\`\`\`json
{
  "fromModel": "fct_order",
  "fromColumn": "customer_id",
  "toModel": "dim_customer",
  "toColumn": "customer_id",
  "cardinality": "many-to-one"
}
\`\`\`

\`fromModel\` is the FK side. \`toModel\` is the PK side.

Cardinality values: \`many-to-one\` | \`one-to-one\` | \`one-to-many\` | \`many-to-many\`

## Naming Conventions

| Type | Prefix | PK Pattern | Example |
|------|--------|-----------|---------|
| Dimension | \`dim_\` | \`{entity}_id\` | \`dim_project\` → \`project_id\` |
| Fact | \`fct_\` | \`{entity}_id\` or composite | \`fct_order\` → \`order_id\` |
| Reference | \`ref_\` | \`ref_{entity}_code\` | \`ref_country\` → \`ref_country_code\` |
| Bridge | \`brg_\` | composite FK pair | \`brg_project_contact\` |

FK columns match the PK name of the referenced table.`;

// ---------------------------------------------------------------------------
// Format-specific generators
// ---------------------------------------------------------------------------

function generateClaudeSkill(): string {
  return `${buildVersionMarker()}
---
name: erd-studio
description: Reference schema for ERD Studio domain files (v3 unified format). Defines model structure, column metadata, relationships, naming conventions, and model roles. Use when creating or validating data model design files.
---

${SCHEMA_CONTENT}
`;
}

function generateCopilotInstructions(): string {
  return `${buildVersionMarker()}
---
name: 'ERD Studio Schema'
description: 'Schema reference for ERD Studio domain files — models, columns, relationships, naming conventions'
applyTo: '**/erd-studio/**/*.json'
---

${SCHEMA_CONTENT}
`;
}

function generateGeminiStyleguide(): string {
  return `${buildVersionMarker()}
${SCHEMA_CONTENT}

## Code Review Rules for ERD Studio Files

When reviewing changes to \`erd-studio/**/*.json\` files:

1. **Schema version** must be \`3\`
2. **Required sections**: \`conceptual\`, \`logical\`, and \`viewConfig\` must all be present at root level
3. **Model names** must follow naming conventions: \`dim_\`, \`fct_\`, \`ref_\`, or \`brg_\` prefixes
4. **Relationships**: \`fromModel\` is always the FK side, \`toModel\` is the PK side
5. **Logical columns** must have \`dataType\` and \`description\`
6. **viewConfig** must be at root level (not inside conceptual or logical sections)
7. **Boolean key flags** (\`isPrimaryKey\`, \`isForeignKey\`, \`isNaturalKey\`) should only be present when \`true\`
`;
}

function generateCodexAgents(): string {
  return `${buildVersionMarker()}

## ERD Studio Domain Files

${SCHEMA_CONTENT}
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
