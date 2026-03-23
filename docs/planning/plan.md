# dbt Semantic Model Designer — VS Code Extension Plan

## Vision

A VS Code extension that visualises semantic (FK-based) relationships between dbt models within curated business domains, and enables **interactive design** of new models, columns, and relationships before they are built. Built items appear in green; planned items appear in orange. The dbt repo becomes the single source of truth for both lineage (managed by dbt) and semantic relationships (managed via domain JSON files), giving AI tools full context when building or modifying models.

### Key Workflow

```
1. Open    →  Open a semantic domain in the visual graph editor
2. Design  →  Add new models (orange), columns, and FK relationships
3. Build   →  AI skill reads design state from JSON and generates dbt SQL/YAML
4. Compile →  Run dbt compile; extension auto-detects new models in manifest
5. Verify  →  Design models turn green once they appear in the manifest
```

**Single-Mode Philosophy**: No browse/design mode toggle. The visual distinction between built (green) and planned (orange) items IS the mode indicator. Click any model to select it — the detail panel shows edit controls for planned items while built items remain read-only.

---

## Decisions Summary

| Decision | Choice |
|----------|--------|
| Extension scope | Standalone, JHG-focused initially |
| Editor trigger | Custom editor for `.json` domain files + command palette for new domains |
| Relationship scope | Semantic (FK) only — dbt lineage handled by dbt's own tools |
| Design storage | Directly in the semantic domain JSON with `"source": "design"` markers |
| Build trigger (orange→green) | Auto-detect from manifest.json — models turn green when they appear in compiled manifest |
| AI integration | Document the JSON interface — Claude Code or other AI tools read design state externally |
| Domain management | Full CRUD — create, edit, and delete semantic domain files |
| Column source for repo models | manifest.json (green) + plannedColumns not in manifest (orange) — overlay semantics |
| Column source for design models | Defined inline in semantic domain JSON (all orange) |
| PK designation for repo models | `primaryKey` field in semantic JSON (user-defined) |
| Multi-project support | Single dbt project per workspace |
| Semantic file location | Inside dbt project: `erd-studio/{layer}/{domain}.json` |
| Sidebar | Tree view listing all domains by layer + graph editor panel |
| Cross-domain models | Allowed — a model can appear in multiple domains; conflicts flagged for resolution |
| Schema versioning | Yes — `"schemaVersion": 1` field in domain JSON for future migration |
| Collaboration | Git-based (local edits, merge via PRs) — no Live Share |
| dbt compilation | Local only — extension watches `manifest.json` for changes |
| Model templates | JHG-specific templates (dim, fact, bridge, SCD2, blank) |
| FK inference | Manual only — no auto-suggestion of relationships |
| Node position persistence | Manual positions stored in domain JSON `viewConfig.positions`; committed to git so layout is shared |
| ELK layout trigger | Manual button only — not auto-run on open; user clicks "Auto Layout" to recompute |
| Manifest parsing strategy | Streaming JSON (e.g., `stream-json`) from the start — 43MB manifest must not block extension host |
| Relationship identity | Composite key: `(fromModel, fromColumn, toModel, toColumn)` — supports multiple FKs between same models |
| Webview state restoration | Persist UI state (zoom, pan, selected node, detail panel state) via `getState()`/`setState()`; re-fetch domain data fresh on restore |
| UI component library | `@vscode-elements/elements` + `@vscode-elements/react-elements` for VS Code-native form elements |
| Test framework (unit + webview) | Vitest — fast, native TypeScript/ESM, esbuild-aligned |
| Test framework (integration) | Mocha via `@vscode/test-cli` + `@vscode/test-electron` — only officially supported path for Extension Host tests |
| PoC reference | Start fresh — `dbt-model-viewer/` PoC is archived and not referenced |
| `sync_domain_tags.py` | Future feature — out of scope for initial implementation, requires further requirements |

---

## Repository Strategy

### Two Repos, Clear Separation

```
/Users/liamwynne/GIT/
├── erd-studio/                         ← THIS REPO (VS Code extension)
│   ├── plan.md                         # This plan
│   ├── src/                            # Extension host code
│   ├── webview/                        # React webview code
│   └── package.json                    # VS Code extension manifest
│
├── edp-app-dataprocessing/             ← TARGET dbt repo (JHG EDP)
│   ├── dbt_project.yml
│   ├── models/
│   │   ├── silver/                     # dbt SQL models
│   │   ├── gold/
│   │   └── semantic/                   # Semantic domain JSONs (created/edited by extension)
│   │       ├── silver/
│   │       │   └── work-lots.json
│   │       └── gold/
│   └── target/
│       └── manifest.json               # Compiled manifest (~43MB)
│
└── dbt-model-viewer/                   ← PoC web app (archived, not referenced)
```

### How They Connect

The extension does **not** hardcode paths to the dbt repo. Instead:
1. User opens `edp-app-dataprocessing/` in VS Code
2. Extension activates on `workspaceContains:**/dbt_project.yml`
3. Extension reads `target/manifest.json` from the workspace root
4. Extension reads/writes `erd-studio/**/*.json` from the workspace root

### Development Setup

During development of the extension, use VS Code's Extension Development Host:

```bash
# In terminal 1: build extension continuously
cd /Users/liamwynne/GIT/LIAM/erd-studio
npm run watch

# Press F5 in VS Code → opens Extension Development Host
# In the new VS Code window, open the dbt project:
#   File → Open Folder → /Users/liamwynne/GIT/edp-app-dataprocessing
```

The Extension Development Host window runs the extension against the live dbt repo workspace. All file reads/writes target `edp-app-dataprocessing/` through VS Code's workspace APIs.

### Initial Semantic Files

To bootstrap the dbt repo with the semantic directory structure:

```bash
# Create semantic directory in the dbt repo
mkdir -p /Users/liamwynne/GIT/edp-app-dataprocessing/erd-studio/silver
mkdir -p /Users/liamwynne/GIT/edp-app-dataprocessing/erd-studio/gold

# Create an initial work-lots domain file manually (or via the extension's Create Domain command)
```

---

## Architecture

### High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ VS Code Extension Host (Node.js)                                 │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ TreeView     │  │ Custom       │  │ File Watchers          │  │
│  │ Provider     │  │ Editor       │  │ - manifest.json        │  │
│  │ (sidebar)    │  │ Provider     │  │ - erd-studio/**   │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬────────────┘  │
│         │                 │                      │               │
│  ┌──────┴─────────────────┴──────────────────────┴────────────┐  │
│  │                   Extension Services                        │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐  │  │
│  │  │ Manifest     │ │ Semantic     │ │ Design             │  │  │
│  │  │ Service      │ │ Domain       │ │ Reconciliation     │  │  │
│  │  │ (parse,      │ │ Service      │ │ Service            │  │  │
│  │  │  columns)    │ │ (CRUD,       │ │ (orange→green)     │  │  │
│  │  │              │ │  validate)   │ │                    │  │  │
│  │  └──────────────┘ └──────────────┘ └────────────────────┘  │  │
│  └────────────────────────┬────────────────────────────────────┘  │
│                           │ postMessage                           │
│  ┌────────────────────────┴────────────────────────────────────┐  │
│  │ Webview (React + React Flow)                                │  │
│  │                                                             │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │  │
│  │  │ Graph    │ │ Design   │ │ Toolbar  │ │ Detail Panel  │  │  │
│  │  │ Canvas   │ │ Palette  │ │ (zoom,   │ │ (columns,     │  │  │
│  │  │ (React   │ │ (add     │ │  layout, │ │  FK info,     │  │  │
│  │  │  Flow)   │ │  model,  │ │  mode    │ │  status)      │  │  │
│  │  │          │ │  column, │ │  toggle) │ │               │  │  │
│  │  │          │ │  FK)     │ │          │ │               │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Project Structure

```
erd-studio/
├── package.json                        # Extension manifest, contribution points
├── tsconfig.json                       # Extension host TypeScript config (Node.js)
├── tsconfig.webview.json               # Webview TypeScript config (DOM)
├── esbuild.js                          # Dual build: extension + webview
├── .vscodeignore                       # Files to exclude from VSIX package
│
├── src/                                # Extension host code (Node.js)
│   ├── extension.ts                    # activate() / deactivate()
│   ├── commands/
│   │   ├── createDomain.ts             # Command: create new semantic domain
│   │   ├── deleteDomain.ts             # Command: delete a domain
│   │   └── openDomain.ts              # Command: open domain in graph editor
│   ├── providers/
│   │   ├── DomainTreeProvider.ts       # Sidebar tree view (domains by layer)
│   │   └── SemanticEditorProvider.ts   # CustomTextEditorProvider for JSON files
│   ├── services/
│   │   ├── manifestService.ts          # Parse manifest.json, extract columns
│   │   ├── domainService.ts            # CRUD operations on semantic domain JSON
│   │   └── reconciliationService.ts    # Compare design models against manifest
│   ├── watchers/
│   │   └── fileWatchers.ts             # Watch manifest.json + semantic files
│   └── types/
│       ├── semantic.ts                 # Semantic domain types (shared with webview)
│       └── messages.ts                 # Extension ↔ webview message contracts
│
├── webview/                            # Webview code (browser/React)
│   ├── index.tsx                       # React entry point
│   ├── App.tsx                         # Root component
│   ├── hooks/
│   │   ├── useVsCodeApi.ts             # Singleton acquireVsCodeApi wrapper
│   │   └── useMessageBus.ts           # Typed message send/receive
│   ├── components/
│   │   ├── Graph/
│   │   │   ├── GraphCanvas.tsx         # React Flow canvas
│   │   │   ├── ModelNode.tsx           # Model card node (green/orange colouring)
│   │   │   └── FkEdge.tsx             # Custom FK edge with cardinality label
│   │   ├── Toolbar/
│   │   │   ├── Toolbar.tsx             # Top bar: zoom, fit, layout, mode toggle
│   │   │   └── DesignPalette.tsx      # Design mode controls (add model, add FK)
│   │   ├── DetailPanel/
│   │   │   ├── ModelDetail.tsx         # Selected model info + column list
│   │   │   └── ColumnEditor.tsx       # Add/edit columns on design models
│   │   └── Dialogs/
│   │       ├── NewModelDialog.tsx      # Create new design model
│   │       ├── NewFkDialog.tsx        # Create new FK relationship
│   │       └── NewColumnDialog.tsx    # Add column to a model
│   ├── lib/
│   │   ├── graphTransformer.ts         # Models → React Flow nodes/edges
│   │   ├── elkLayout.ts               # ELK layout integration
│   │   └── colorScheme.ts             # Green/orange/status colour logic
│   ├── store/
│   │   └── editorStore.ts             # Zustand state for the webview
│   └── styles/
│       └── theme.css                   # VS Code CSS variable mappings
│
├── media/
│   ├── icon.svg                        # Extension icon
│   └── domain-icon.svg                # Tree view icons
│
├── vitest.config.ts                    # Vitest config for unit + webview tests
│
└── test/
    ├── __mocks__/
    │   └── vscode.ts                      # Manual mock of vscode API for Vitest
    ├── unit/                              # Vitest: pure logic tests
    │   ├── manifestService.test.ts
    │   ├── domainService.test.ts
    │   └── reconciliationService.test.ts
    └── integration/                       # Mocha via @vscode/test-cli
        └── extension.test.ts
```

---

## Data Model

### Semantic Domain JSON Schema

This is the core data format. Files live at `{dbt_project}/erd-studio/{layer}/{domain}.json`.

```jsonc
{
  // Schema version for forward compatibility
  "schemaVersion": 1,

  // Domain metadata
  "domain": "work-lots",
  "layer": "silver",
  "description": "Work lot domain — work lots and their related dimension tables",

  // Models in this domain
  "models": [
    // Repo model — columns resolved from manifest at runtime
    // Use 'primaryKey' to designate the PK column
    // Use 'plannedColumns' for columns not yet built (overlay semantics)
    {
      "name": "dim_work_lot",
      "source": "repo",
      "primaryKey": "work_lot_id",
      "plannedColumns": [
        {
          "name": "estimated_cost",
          "dataType": "DECIMAL",
          "description": "Planned column for Q2 — not yet in manifest"
        }
      ]
    },

    // Design model — columns defined inline (all orange in UI)
    {
      "name": "dim_work_lot_status",
      "source": "design",
      "schema": "silver",
      "description": "Tracks work lot lifecycle status transitions",
      "columns": [
        {
          "name": "work_lot_status_id",
          "dataType": "INT",
          "description": "Surrogate key",
          "isPrimaryKey": true
        },
        {
          "name": "work_lot_id",
          "dataType": "INT",
          "description": "FK to dim_work_lot"
        },
        {
          "name": "status",
          "dataType": "VARCHAR",
          "description": "Current status label"
        }
      ]
    }
  ],

  // FK relationships between models in this domain
  "relationships": [
    {
      "fromModel": "dim_work_lot",
      "fromColumn": "project_id",
      "toModel": "dim_project",
      "toColumn": "project_id",
      "cardinality": "many-to-one"
    },
    // Design relationship (orange in UI)
    {
      "fromModel": "dim_work_lot_status",
      "fromColumn": "work_lot_id",
      "toModel": "dim_work_lot",
      "toColumn": "work_lot_id",
      "cardinality": "many-to-one",
      "source": "design"
    }
  ],

  // View configuration for this domain
  // layoutOptions map directly to ELK layout options (elk.* namespace)
  "viewConfig": {
    "showFkEdges": true,
    "layoutOptions": {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.aspectRatio": "1.778",
      "elk.spacing.nodeNode": "80",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120",
      "elk.portConstraints": "FIXED_ORDER",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX"
    },
    // Persisted node positions — committed to git so all users see the same layout.
    // When a user drags a node, its position is saved here.
    // Clicking "Auto Layout" runs ELK and overwrites all positions.
    // Models not listed here (e.g. newly added) get positioned by ELK on next auto-layout.
    "positions": {
      "dim_work_lot": { "x": 350, "y": 100 },
      "dim_project": { "x": 50, "y": 100 },
      "dim_work_lot_status": { "x": 350, "y": 350 }
    }
  }
}
```

### Model Status Logic

The extension determines model/column status at runtime by comparing the semantic domain JSON against the compiled manifest:

```
For each model in the semantic domain JSON:
  if model.source == "design":
    if model.name exists in manifest.json:
      → Status: BUILT (green border)
      → Columns: from manifest (green rows)
    else:
      → Status: DESIGN (orange border)
      → Columns: from inline 'columns' array (orange rows)
  else (source == "repo"):
    if model.name exists in manifest.json:
      → Status: BUILT (green border)
      → Columns: manifest (green) + plannedColumns not in manifest (orange)
      → PK: from 'primaryKey' field (green if exists, orange ghost if missing)
      → FK: inferred from relationships (green if exists, orange ghost if missing)
    else:
      → Status: MISSING (grey border)
      → Columns: ghost rows for PK/FK references only (orange)
```

**Column Row Colours:**
- **Green background**: Column exists in manifest (built)
- **Orange background**: Column is planned or missing (not in manifest)
- **"PLANNED" separator**: Visual divider between built and planned columns

### Column Resolution Rules (Overlay Semantics)

The extension uses **overlay semantics** for column resolution: manifest is the source of truth for built columns, and `plannedColumns` overlay for forward-planning.

| Model source | manifest has model? | Column source | Row colour |
|-------------|-------------------|---------------|------------|
| `"repo"` | Yes | manifest.json columns (green) + `plannedColumns` not in manifest (orange) | Green/Orange |
| `"repo"` | No | Warning state, no columns | Grey |
| `"design"` | No | Inline `columns` array | Orange |
| `"design"` | Yes | manifest.json (model has been built — transition to green) | Green |

**PK/FK Resolution:**
- **Primary Key (repo models)**: Designated via `primaryKey` field (e.g., `"primaryKey": "work_lot_id"`)
- **Primary Key (design models)**: Via `isPrimaryKey: true` flag in columns array
- **Foreign Keys (all models)**: Inferred from `relationships` array — any column appearing as `fromColumn` is marked as FK

**Overlay Behaviour:**
- Manifest columns always display first (green/built)
- `plannedColumns` not in manifest display below a "PLANNED" separator (orange)
- `plannedColumns` that exist in manifest are **skipped** (manifest wins, no duplicates)
- PK/FK references to non-existent columns appear as orange "ghost" rows with `???` dataType

This enables forward-planning: add a `plannedColumn` to a repo model, and it shows orange until you build it via dbt. Once it appears in manifest, it automatically transitions to green.

---

## UI Design

### 1. Sidebar Tree View

The extension contributes a view container in the VS Code sidebar:

```
SEMANTIC DOMAINS
├── 📁 Bronze
│   └── (empty — no domains yet)
├── 📁 Silver
│   ├── 📄 work-lots         (12 models, 3 design)
│   ├── 📄 projects          (8 models)
│   └── 📄 contacts          (6 models, 1 design)
├── 📁 Gold
│   └── 📄 revenue           (5 models)
└── ➕ New Domain...
```

- Clicking a domain opens its graph editor
- Right-click context menu: Open, Rename, Delete
- Badge shows model count and design model count
- "New Domain..." item at bottom triggers domain creation flow

### 2. Graph Editor (Webview)

The main visual editor panel, opened as a custom editor for `.json` domain files or via the tree view.

#### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Toolbar                                                         │
│ [+ Model] [+ Relationship]  |  [Auto Layout] [Fit] [Zoom]      │
│                              |  Domain: work-lots (silver)      │
├────────────────────────────────────────────────────┬────────────┤
│                                                    │            │
│                                                    │  Detail    │
│               Graph Canvas                         │  Panel     │
│               (React Flow)                         │            │
│                                                    │  Model:    │
│   ┌──────────┐         ┌──────────┐               │  dim_work  │
│   │dim_project│────────│dim_work  │               │  _lot      │
│   │(green)   │         │_lot      │               │            │
│   │          │         │(green)   │               │  Columns:  │
│   │project_id│         │          │               │  - work_   │
│   │name      │         │work_lot_ │               │    lot_id  │
│   │...       │         │id        │               │  - project │
│   └──────────┘         │project_id│               │    _id     │
│                        │...       │               │  - name    │
│          ┌─────────────┤          │               │  ...       │
│          │             └──────────┘               │            │
│   ┌──────┴─────┐                                  │  [+ Column]│
│   │dim_work_   │                                  │            │
│   │lot_status  │                                  │  Status:   │
│   │(ORANGE)    │                                  │  ● Built   │
│   │            │                                  │            │
│   │work_lot_   │                                  │            │
│   │status_id   │                                  │            │
│   │work_lot_id │                                  │            │
│   │status      │                                  │            │
│   └────────────┘                                  │            │
│                                                    │            │
├────────────────────────────────────────────────────┴────────────┤
│ Status Bar: 12 models (3 design) | 18 relationships             │
└─────────────────────────────────────────────────────────────────┘
```

#### Single-Mode Interaction

No mode toggle needed — the color scheme communicates state, and selection enables editing:

- **Green border** = Built model (exists in manifest)
- **Orange border** = Planned model (design model not yet built)
- **Green column rows** = Built columns (from manifest)
- **Orange column rows** = Planned columns (not in manifest yet)

**Always available:**
- Pan, zoom, select nodes
- Click '+ Model' to create a new design model
- Click '+ Relationship' to create an FK between models
- Drag from column handle to another model to create FK

**When a model is selected (detail panel):**
- Built models: view read-only built columns, add planned columns via '+ Column' button
- Planned models: edit all columns, delete the model
- Planned columns: edit name/type, delete
- Built columns: read-only display (no edit/delete)

#### Colour Scheme

| Element | Status | Colour | Hex |
|---------|--------|--------|-----|
| Model node border | Built (in manifest) | Green | `#22c55e` |
| Model node border | Design (not yet built) | Orange | `#f97316` |
| Model node border | Missing (referenced but not in manifest) | Grey | `#6b7280` |
| Column row background | Built (from manifest) | Light green | `rgba(34, 197, 94, 0.08)` |
| Column row background | Planned/Missing (not in manifest) | Light orange | `rgba(249, 115, 22, 0.1)` |
| Column separator | "PLANNED" label | Orange dashed border | `#f97316` |
| PK/FK badge | Built column | Yellow/Blue | `#ca8a04` / `#3b82f6` |
| PK/FK badge | Planned column | Orange | `#ea580c` |
| FK edge | Built relationship | Blue | `#3b82f6` |
| FK edge | Design relationship | Orange | `#f97316` |
| FK edge | 1:1 cardinality | Dashed line | — |
| FK edge | many-to-one / one-to-many | Solid line | — |

#### Model Node Component

```
┌────────────────────────────┐
│ ●  dim_work_lot      [SLV] │  ← Green border (built) or orange (design)
│ ─────────────────────────── │
│ 🔑 work_lot_id        INT  │  ← PK indicator
│ 🔗 project_id         INT  │  ← FK indicator
│ 🔗 contract_id        INT  │
│    name             VARCHAR │
│    description      VARCHAR │
│    status           VARCHAR │
│    created_at     TIMESTAMP │
│    ...                      │
│ ─────────────────────────── │
│ 15 columns                  │
└────────────────────────────┘
```

Design model nodes have an orange header bar and the layer badge reads the schema defined in the JSON.

### 3. Dialogs

#### New Domain Dialog
Fields: Domain name (slug), Layer (bronze/silver/gold), Description

#### New Model Dialog
Fields: Model name, Schema, Layer (auto-set from domain), Description. After creation, user adds columns via the detail panel.

#### New Column Dialog
Fields: Column name, Data type (dropdown: INT, VARCHAR, TIMESTAMP, BOOLEAN, NUMERIC, DATE), Description, Is primary key (checkbox)

#### New Relationship Dialog
Flow: Select source model → source column → target model → target column → cardinality (many-to-one / one-to-one). Can also be done by dragging from a column to another model on the canvas.

---

## Extension Host Services

### ManifestService

Parses `target/manifest.json` (~43MB) using **streaming JSON** (e.g., `stream-json`) to avoid blocking the extension host. Only the `nodes` section is extracted — other manifest sections (macros, sources, exposures, etc.) are skipped during the stream to minimise memory usage.

```typescript
class ManifestService {
  // Stream-parse manifest and cache model data (non-blocking)
  async loadManifest(projectPath: string): Promise<ManifestData>

  // Get columns for a specific model
  getModelColumns(modelName: string): ColumnInfo[]

  // Check if a model exists in the manifest
  hasModel(modelName: string): boolean

  // Get all model names
  getModelNames(): string[]

  // Invalidate cache (called on manifest file change)
  invalidate(): void
}
```

### DomainService

CRUD operations on semantic domain JSON files.

```typescript
class DomainService {
  // List all domains found in erd-studio/
  async listDomains(): Promise<DomainSummary[]>

  // Read a domain file
  async getDomain(layer: string, domain: string): Promise<SemanticDomain>

  // Create a new domain file
  async createDomain(layer: string, domain: string, metadata: DomainMetadata): Promise<void>

  // Update a domain (models, relationships, viewConfig)
  async updateDomain(layer: string, domain: string, data: SemanticDomain): Promise<void>

  // Delete a domain file
  async deleteDomain(layer: string, domain: string): Promise<void>

  // Add a design model to a domain
  async addDesignModel(layer: string, domain: string, model: DesignModel): Promise<void>

  // Add a relationship to a domain
  async addRelationship(layer: string, domain: string, rel: Relationship): Promise<void>

  // Remove a model or relationship
  async removeModel(layer: string, domain: string, modelName: string): Promise<void>
  async removeRelationship(layer: string, domain: string, key: { fromModel: string; fromColumn: string; toModel: string; toColumn: string }): Promise<void>
}
```

### ReconciliationService

Merges semantic domain JSON with manifest data using **overlay semantics**.

```typescript
class ReconciliationService {
  // Reconcile a domain against the manifest using overlay semantics
  // Returns ReconciledDomain with:
  //   - Models with resolved status (built/design/missing)
  //   - Columns with resolved status (built/planned/missing) and PK/FK flags
  //   - Columns ordered: built first, then planned (with separator), then ghost rows
  reconcile(domain: SemanticDomain, manifest: ManifestData): ReconciledDomain

  // Check if any design models have been built (appear in manifest)
  findNewlyBuiltModels(domain: SemanticDomain, manifest: ManifestData): string[]

  // Auto-transition: update source from "design" to "repo" for built models
  async autoTransition(layer: string, domainName: string, builtModels: string[]): Promise<void>
}
```

**Column Resolution Algorithm:**
1. For repo models in manifest: Start with manifest columns (status: `built`)
2. Add `plannedColumns` not in manifest (status: `planned`) — manifest wins if column exists in both
3. Add ghost rows for PK/FK references to non-existent columns (status: `missing`)
4. For design models not in manifest: Use inline `columns` array (all status: `planned`)

**SemanticModel Fields for Repo Models:**
- `primaryKey?: string` — Column name designated as PK
- `plannedColumns?: ColumnDef[]` — Columns not yet in manifest (overlay)
```

### File Watchers

```typescript
// Watch manifest.json for changes (dbt compile ran)
// → Triggers reconciliation, refreshes graph, transitions orange→green

// Watch erd-studio/**/*.json for external changes
// → Refreshes tree view and any open editors

// Watch dbt_project.yml for project config changes
// → Re-detect project root and settings
```

---

## Extension ↔ Webview Message Protocol

All communication is via typed `postMessage`. Messages are categorized by direction.

### Extension → Webview

```typescript
type ExtensionMessage =
  | { type: "domainLoaded"; payload: ReconciledDomain }
  | { type: "domainUpdated"; payload: ReconciledDomain }  // After file watcher trigger
  | { type: "manifestRefreshed"; payload: { newlyBuiltModels: string[] } }
  | { type: "error"; payload: { message: string } }
```

### Webview → Extension

```typescript
type WebviewMessage =
  | { type: "ready" }  // Webview initialized, request domain data
  | { type: "addModel"; payload: DesignModel }
  | { type: "addColumn"; payload: { modelName: string; column: ColumnDef } }
  | { type: "removeColumn"; payload: { modelName: string; columnName: string } }
  | { type: "addRelationship"; payload: Relationship }
  | { type: "removeModel"; payload: { modelName: string } }
  | { type: "removeRelationship"; payload: { fromModel: string; fromColumn: string; toModel: string; toColumn: string } }
  | { type: "updateViewConfig"; payload: ViewConfig }
  | { type: "addExistingModel"; payload: { modelName: string } }  // Add repo model to domain
  | { type: "updatePositions"; payload: { positions: Record<string, { x: number; y: number }> } }  // Persist node positions after drag (debounced)
  | { type: "runAutoLayout" }  // Trigger ELK layout, extension writes new positions to JSON
```

When the webview sends a mutation (add/remove), the extension:
1. Updates the semantic domain JSON file on disk
2. Re-reconciles against manifest
3. Sends `domainUpdated` back to the webview with fresh state

This keeps the JSON file as the source of truth and the webview as a pure view.

---

## AI Integration Interface

The extension does not call AI directly. Instead, it maintains a well-defined JSON interface that AI tools (Claude Code, Copilot, etc.) can read.

### How AI Reads Design State

An AI skill can read the semantic domain JSON file directly from the filesystem:

```bash
# Find all design models across all domains
find erd-studio -name "*.json" -exec cat {} \; | jq '.models[] | select(.source == "design")'
```

### What AI Needs to Generate

For each design model, an AI tool should generate:

1. **SQL model file**: `models/{layer}/{model_name}.sql` — the dbt SELECT statement
2. **YAML properties**: Add the model to the appropriate YAML file with column definitions (name, data_type, description, tests)
3. **Schema tests**: relationship tests for FK columns (`relationships_` test macros)

### AI Handoff Schema

The semantic JSON already contains everything AI needs:

```jsonc
{
  // Design model definition → generate SQL + YAML
  "name": "dim_work_lot_status",
  "source": "design",
  "schema": "silver",
  "description": "Tracks work lot lifecycle status transitions",
  "columns": [
    { "name": "work_lot_status_id", "dataType": "INT", "isPrimaryKey": true },
    { "name": "work_lot_id", "dataType": "INT", "description": "FK to dim_work_lot" },
    { "name": "status", "dataType": "VARCHAR" }
  ]
}

// Plus the relationships define the FK tests to generate:
{
  "fromModel": "dim_work_lot_status",
  "fromColumn": "work_lot_id",
  "toModel": "dim_work_lot",
  "toColumn": "work_lot_id",
  "cardinality": "many-to-one",
  "source": "design"
}
```

### Post-Build Workflow

After AI generates the dbt files:
1. User runs `dbt compile`
2. Extension's file watcher detects manifest change
3. ReconciliationService finds design models now in manifest
4. Models transition from orange → green
5. Extension updates the JSON: changes `"source": "design"` → `"source": "repo"` and removes inline `columns` (now sourced from manifest)

---

## Extension Configuration

### package.json Contribution Points

```jsonc
{
  "contributes": {
    // Commands
    "commands": [
      { "command": "dbtSemantic.createDomain", "title": "Create Semantic Domain", "category": "dbt" },
      { "command": "dbtSemantic.openDomain", "title": "Open Semantic Domain", "category": "dbt" },
      { "command": "dbtSemantic.deleteDomain", "title": "Delete Semantic Domain", "category": "dbt" },
      { "command": "dbtSemantic.refreshManifest", "title": "Refresh Manifest", "category": "dbt" }
    ],

    // Tree view in sidebar
    "viewsContainers": {
      "activitybar": [{
        "id": "dbt-semantic",
        "title": "Semantic Domains",
        "icon": "media/icon.svg"
      }]
    },
    "views": {
      "dbt-semantic": [{
        "id": "dbtSemantic.domainTree",
        "name": "Domains"
      }]
    },

    // Custom editor for semantic JSON files
    "customEditors": [{
      "viewType": "dbtSemantic.domainEditor",
      "displayName": "Semantic Domain Editor",
      "selector": [{ "filenamePattern": "**/erd-studio/**/*.json" }],
      "priority": "option"
    }],

    // Settings
    "configuration": {
      "title": "dbt Semantic Designer",
      "properties": {
        "dbtSemantic.projectPath": {
          "type": "string",
          "description": "Path to dbt project root (auto-detected from workspace)"
        },
        "dbtSemantic.semanticDir": {
          "type": "string",
          "default": "erd-studio",
          "description": "Relative path to semantic domain files within the dbt project"
        },
        "dbtSemantic.autoReconcile": {
          "type": "boolean",
          "default": true,
          "description": "Automatically transition design models to built when detected in manifest"
        }
      }
    }
  },

  // Activation events
  "activationEvents": [
    "workspaceContains:**/dbt_project.yml"
  ]
}
```

---

## Implementation Phases

### Phase 1: Foundation — Extension Scaffold + Read-Only Viewer

**Goal**: Get a working VS Code extension that displays semantic domain graphs in read-only mode.

**Deliverables**:
1. Extension project scaffold (esbuild dual build, tsconfigs)
2. `ManifestService` — parse manifest.json, extract models and columns
3. `DomainService` — read semantic domain JSON files
4. `DomainTreeProvider` — sidebar tree view listing domains by layer
5. `SemanticEditorProvider` — custom text editor that opens the React webview
6. Webview scaffold with React + React Flow
7. `ModelNode` component — display model cards with columns, PK/FK indicators
8. `FkEdge` component — display FK relationships with cardinality labels
9. ELK layout integration (implement from scratch using `elkjs`) — manual "Auto Layout" button only
10. Node position persistence — load from `viewConfig.positions`, save on drag (debounced), overwrite on auto-layout
11. `ReconciliationService` — resolve model status (green/orange/grey) against manifest
12. Colour scheme: green borders for built models, orange for design, grey for missing
13. Toolbar: zoom, fit view, auto-layout button (ELK — manual trigger only, not on open)

**What works at end of Phase 1**:
- Open VS Code in dbt project → sidebar shows semantic domains
- Click a domain → graph editor opens showing models and FK edges
- Models that exist in manifest are green; design models are orange
- Pan, zoom, select nodes, view column details

### Phase 2: Interactive Design — Create Models, Columns, and Relationships

**Goal**: Enable interactive design of new models and relationships using a single-mode approach.

**Design Philosophy**: No browse/design mode toggle. The visual distinction between built (green) and planned (orange) items IS the mode indicator. Click any model to select it — the detail panel shows edit controls for planned items. Built items are read-only; planned items are editable.

**Deliverables**:
1. '+ Model' and '+ Relationship' buttons always visible in toolbar
2. New Model dialog — create a design model with JHG templates (dim, fact, bridge, SCD2, blank)
3. Unified Column Editor in detail panel:
   - Built models: read-only built columns (green) + 'Add Planned Column' button for orange columns
   - Planned models: all columns editable
   - Planned columns on any model can be edited/deleted; built columns are always read-only
4. New Relationship dialog — create FK between models
5. Drag-to-connect — drag from a column handle to another model to create FK
6. Delete actions — remove planned models, planned columns, design relationships (disabled for built items)
7. All mutations write to the semantic domain JSON via extension host
8. Undo/redo via VS Code's `WorkspaceEdit` integration
9. Validation — prevent duplicate model names, circular FKs, missing PK references

**What works at end of Phase 2**:
- Click '+ Model' → New Model dialog opens → orange node appears on canvas
- Select any model → detail panel shows columns with appropriate edit controls
- Add planned columns to a built model → orange columns appear below the green ones
- Draw FK relationship → orange edge appears between models
- All changes persist to the semantic domain JSON file
- Delete only works on planned items — built items have disabled delete controls

### Phase 3: Domain Management + Auto-Reconciliation

**Goal**: Full CRUD on domains and automatic orange→green transitions.

**Deliverables**:
1. Create Domain command — new domain dialog, creates JSON file, appears in tree
2. Delete Domain command — confirmation dialog, removes file
3. Add existing model to domain — search/select models from manifest and add them
4. File watchers — watch manifest.json and semantic files for external changes
5. Auto-reconciliation — when manifest changes, detect newly built models
6. Auto-transition — update JSON (`design` → `repo`), remove inline columns, refresh graph
7. Notification: "3 design models have been built: dim_x, dim_y, dim_z"
8. Manual refresh command (force re-read manifest)

**What works at end of Phase 3**:
- Create a new "revenue" domain in gold layer → JSON file created, appears in tree
- Add existing manifest models to the domain → green nodes appear
- Design new models → orange nodes
- Run dbt compile externally → extension detects, design models turn green
- Tree view badges update to reflect current design vs built counts

### Phase 4: Polish + Developer Experience

**Goal**: Quality of life, performance, and edge cases.

**Deliverables**:
1. Keyboard shortcuts (Delete key, Ctrl+Z undo, Ctrl+Shift+Z redo)
2. Context menus on nodes and edges (right-click to delete, edit)
3. Search within the graph editor (highlight matching models)
4. Minimap for large domains
5. Export graph as PNG/SVG for documentation
6. Performance optimization for large domains (50+ models)
7. Error handling and user-friendly messages
8. Extension settings UI (configure paths, toggle auto-reconcile)
9. Welcome experience for new projects (no semantic dir yet)

---

## Technical Decisions

### Build Tooling
- **esbuild** for both extension host and webview bundles (fast, dual-target)
- Separate `tsconfig.json` (Node.js libs) and `tsconfig.webview.json` (DOM libs)
- `tsc --noEmit` for type checking (esbuild strips types without validating)

### Key Extension Host Dependencies
- **`stream-json`** — streaming JSON parser for the ~43MB `manifest.json`. Only the `nodes` section is extracted via `streamValues` + `filter`; other sections (macros, sources, exposures, metrics) are skipped to minimise memory. This runs in the extension host (Node.js), not the webview.

### Webview Framework
- **React 18** + **React Flow** (`@xyflow/react`) for the graph canvas
- **ELK** (`elkjs`) for automatic graph layout (see ELK Layout section below)
- **Zustand** for webview state management
- **`@vscode-elements/elements`** + **`@vscode-elements/react-elements`** for VS Code-native form elements (buttons, inputs, dropdowns, selects, tables). This is the community successor to the deprecated `@vscode/webview-ui-toolkit`, with 30+ components, active maintenance (v2.4.0, Dec 2025), and automatic VS Code theme integration via CSS custom properties
- **VS Code CSS custom properties** for additional theme-native styling where needed

### Testing
- **Vitest** for unit tests (services, pure logic) and webview React component tests
  - Native TypeScript/ESM support, uses esbuild internally (matches the project's build tooling)
  - Jest-compatible API (`describe`, `it`, `expect`, `vi.mock`, `vi.fn`)
  - The `vscode` module is mocked via Vitest's `alias` config pointing to `test/__mocks__/vscode.ts`
  - React components tested with `@testing-library/react` + `jsdom`
- **Mocha** via `@vscode/test-cli` + `@vscode/test-electron` for integration tests
  - Only officially supported path for tests running inside the Extension Development Host
  - Used sparingly for smoke-testing activation, custom editor registration, and file watcher behaviour
- **Test pyramid**: many fast Vitest unit tests, few slow Mocha integration tests

### ELK Layout

**Why elkjs over alternatives** (dagre, d3-dag, graphology, webcola):
- Only library with built-in **orthogonal edge routing** — clean right-angle paths that avoid crossing through nodes, essential for ER-style diagrams
- Native **aspect ratio control** — `elk.aspectRatio: '1.778'` targets 16:9 as a first-class layout option. Dagre and others require manual post-layout coordinate scaling
- **Port constraints** — FK edges connect at specific column positions on model nodes (`FIXED_ORDER`), not at the node center. Maps directly to React Flow handles on the ModelNode component
- **Web Worker support** — built-in async layout via Web Worker, preventing UI thread blocking for large domains (100+ nodes)
- 3 official React Flow integration examples on reactflow.dev
- Bundle size (~435 kB gzip) is acceptable for a locally-loaded VS Code webview

**Default ELK configuration:**

```typescript
const DEFAULT_ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.aspectRatio': '1.778',                         // 16:9 target
  'elk.spacing.nodeNode': '80',                        // Vertical spacing between nodes in same layer
  'elk.layered.spacing.nodeNodeBetweenLayers': '120',  // Horizontal spacing between layers
  'elk.portConstraints': 'FIXED_ORDER',                // Edges connect at specific column positions
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
};
```

These defaults are stored in the domain JSON's `viewConfig.layoutOptions` and can be overridden per-domain.

**Layout behaviour:**

- **On open**: The graph loads using persisted positions from `viewConfig.positions`. Models without a saved position (e.g. newly added) are placed at `(0, 0)` and flagged for the user to position manually or trigger auto-layout.
- **"Auto Layout" button**: Runs ELK over the full graph and writes the resulting positions back to `viewConfig.positions`. This **overwrites** all manual positions. The button should confirm before running if positions already exist ("This will rearrange all nodes. Continue?").
- **Drag a node**: Updates that model's entry in `viewConfig.positions` immediately (debounced write to JSON).
- **Committed to git**: Since positions live in the domain JSON, `git commit` shares the layout with the team.

**Web Worker setup in VS Code webview:**

VS Code webviews cannot use `importScripts` or dynamic `import()` for workers. The ELK worker must be bundled into a single file by esbuild, then loaded via blob URL:

```typescript
import elkWorkerCode from './elk-worker.js?raw';  // esbuild bundles this as a string

const workerBlob = new Blob([elkWorkerCode], { type: 'text/javascript' });
const workerUrl = URL.createObjectURL(workerBlob);
const elk = new ELK({ workerUrl });
```

### Custom Editor vs Webview Panel
Using `CustomTextEditorProvider` because:
- Semantic JSON files are text documents — VS Code manages save/dirty state
- Integrates with VS Code's tab system (open alongside code)
- Supports side-by-side view (graph editor + raw JSON)
- File changes from external edits (AI tools, git) are detected automatically
- `priority: "option"` means users can still open as raw JSON if preferred

### State Flow
```
Semantic JSON (disk) ─── CustomTextEditorProvider ───> Webview (React)
       ↑                         │
       │                         │ postMessage
       │                         ↓
       └──── WorkspaceEdit ←── Extension Host (mutations)
```

The JSON file on disk is always the source of truth. The extension host reads it, reconciles with the manifest, and sends the enriched data to the webview. Webview mutations go through the extension host which writes back to disk via `WorkspaceEdit`.

### Webview State Restoration

When the webview is hidden (user switches tabs) and later revealed, React state is destroyed. The extension handles this as follows:

1. **Persisted via `setState()`** (survives hide/reveal):
   - Zoom level and pan offset
   - Selected node name
   - Detail panel open/closed state

2. **Re-fetched from extension host** (always fresh):
   - Full domain data (models, relationships, columns)
   - Reconciled status (green/orange/grey)
   - Node positions (from `viewConfig.positions` in the domain JSON)

On reveal, the webview sends a `"ready"` message. The extension host responds with `domainLoaded`. The webview then applies the persisted UI state from `getState()` on top of the fresh data.

This avoids `retainContextWhenHidden` (which keeps the webview in memory permanently and increases resource usage).

### Update Loop Prevention
When the webview sends a mutation:
1. Extension writes to JSON via `WorkspaceEdit`
2. VS Code fires `onDidChangeTextDocument`
3. Extension checks a `pendingUpdate` flag to skip re-sending to webview
4. Clears flag after the cycle completes

---

## Semantic Directory Convention

The semantic files live inside the dbt project at `erd-studio/{layer}/{domain}.json`:

```
/Users/liamwynne/GIT/edp-app-dataprocessing/
├── dbt_project.yml
├── models/
│   ├── bronze/
│   │   └── ... (dbt model SQL files)
│   ├── silver/
│   │   └── ... (dbt model SQL files)
│   ├── gold/
│   │   └── ... (dbt model SQL files)
│   └── semantic/                        ← Semantic domain definitions
│       ├── bronze/
│       │   └── raw-ingestion.json
│       ├── silver/
│       │   ├── work-lots.json
│       │   ├── projects.json
│       │   └── contacts.json
│       └── gold/
│           └── revenue.json
├── target/
│   └── manifest.json                    ← Compiled manifest (read-only, ~43MB)
└── ...
```

This convention keeps semantic definitions close to the dbt models they describe, version-controlled alongside the project, and discoverable by the extension via the `erd-studio/` glob pattern.

---

## Risk & Considerations

| Risk | Mitigation |
|------|-----------|
| Manifest.json is stale after code changes | Show a "manifest may be stale" warning; provide refresh command; encourage dbt compile workflow |
| Large domains (100+ models) slow React Flow | Virtualize node rendering; lazy-load columns; use React Flow's built-in performance optimizations |
| Concurrent edits (user + AI editing same JSON) | Use VS Code's file watcher + `TextDocument` model; show merge conflicts via standard VS Code UI |
| Design models have incomplete column definitions | Validation in the new column dialog; allow AI to fill gaps during build phase |
| Extension activation slows VS Code | Use specific activation event (`workspaceContains:**/dbt_project.yml`); lazy-load services |
| 43MB manifest blocks extension host | Stream-parse with `stream-json`, extracting only the `nodes` section; skip macros/sources/exposures |
| Webview loses state when hidden | Persist UI state (zoom, pan, selected node, mode) via `getState()`/`setState()`; re-fetch domain data fresh on restore |

---

## Resolved Design Questions

| Question | Decision |
|----------|----------|
| **Cross-domain references** | Yes — a model can appear in multiple domains. Design columns are merged across domains; conflicts flagged for manual resolution. |
| **Schema versioning** | Yes — include a `"schemaVersion"` field (starting at `1`). Extension handles migration when the format evolves. |
| **Collaboration** | Git-based — rely on git for collaboration (local edits, merge via PRs). No Live Share integration needed. |
| **dbt Cloud integration** | Local only — users run `dbt compile` locally. Extension watches for manifest changes. No Cloud API integration. |
| **Model templates** | JHG-specific templates — provide a template picker with patterns tailored to JHG naming and column conventions (standard audit columns, surrogate keys, SCD2, fact, dim, bridge). |
| **FK relationship inference** | No auto-suggest — users create all FKs manually. Keeps the UX predictable and avoids false positives. |

### Cross-Domain Model Handling

Since models can appear in multiple domains, the following rules apply:

- A model can be listed in any number of semantic domain JSON files
- **Repo models** (`"source": "repo"`): No conflict — columns always come from manifest. Multiple domains simply reference the same model.
- **Design models** (`"source": "design"`): If the same design model appears in multiple domains with different column definitions, the extension flags a conflict warning. The user must resolve by choosing one domain as the "owner" of the design columns, or reconciling manually.
- **Future feature**: A `sync_domain_tags.py` script will handle multi-domain tagging (a model gets `domain:work_lots, domain:projects` etc.) — out of scope for initial implementation, requires further requirements gathering

### Schema Version Field

The semantic domain JSON includes a top-level version field:

```jsonc
{
  "schemaVersion": 1,
  "domain": "work-lots",
  "layer": "silver",
  // ... rest of domain definition
}
```

When the extension loads a domain file:
1. Check `schemaVersion` against the current expected version
2. If missing or older, run an in-place migration (update format, bump version)
3. If newer than the extension supports, show a "please update extension" warning

### JHG Model Templates

Available when creating a new design model in the "New Model" dialog:

| Template | Pre-populated columns |
|----------|----------------------|
| **Dimension (dim_)** | `{name}_id` (PK, INT), `name` (VARCHAR), `description` (VARCHAR), `is_active` (BOOLEAN), `valid_from` (TIMESTAMP), `valid_to` (TIMESTAMP), `dwh_inserted_at` (TIMESTAMP), `dwh_updated_at` (TIMESTAMP) |
| **Fact (fct_)** | `{name}_id` (PK, INT), `event_date` (DATE), `amount` (NUMERIC), `dwh_inserted_at` (TIMESTAMP), `dwh_updated_at` (TIMESTAMP) |
| **Bridge (brg_)** | `{name}_id` (PK, INT), `{left}_id` (INT, FK), `{right}_id` (INT, FK), `dwh_inserted_at` (TIMESTAMP) |
| **SCD Type 2** | Extends dim template with `scd_valid_from` (TIMESTAMP), `scd_valid_to` (TIMESTAMP), `scd_is_current` (BOOLEAN), `scd_hash` (VARCHAR) |
| **Blank** | No pre-populated columns — start from scratch |

**Placeholder resolution:**

- **`{name}`** (dim, fact, SCD2): Derived automatically by stripping the template prefix from the model name. E.g., model name `dim_work_lot` → `{name}` = `work_lot` → PK column becomes `work_lot_id`.
- **`{left}` / `{right}`** (bridge): The New Model dialog shows two additional fields ("Left entity", "Right entity") when the Bridge template is selected. E.g., left = `project`, right = `contract` → FK columns become `project_id` and `contract_id`.
- If the model name doesn't start with the expected prefix (e.g., user names a dim `work_lot` without the `dim_` prefix), `{name}` falls back to the full model name.

Templates are configurable via extension settings so JHG conventions can evolve without extension updates.
