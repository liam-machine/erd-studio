# Plan: Three-Stage Model Design (Conceptual / Logical / Physical)

## Summary

Replace the current flat `erd-studio/{layer}/{domain}.json` structure with a three-stage architecture:

```
erd-studio/
  conceptual/
    silver/orders.json
    gold/analytics.json
  logical/
    silver/orders.json
    gold/analytics.json
  physical/
    (no files — derived from manifest + logical domain's model list)
  layers.json
```

Each domain can be viewed at three design stages via **canvas-level tabs**, with **discrepancy reports** comparing adjacent stages.

### Key Decisions

- **Remove** the approval workflow (`approved` field, approve/unapprove messages, cascade logic)
- **Remove** auto-reconciliation service (design→built transition detection)
- **Remove** overlay semantics (manifest columns + planned columns merged view)
- **Remove** `source: 'built' | 'design'` distinction on SemanticModel
- **Keep** column-level discrepancy tracking — dataType mismatches, extra/missing columns between stages
- **Physical model mirrors logical layout** — same models, same canvas positions, derived from manifest data
- **Physical model is fully read-only** — all edit tools disabled in toolbar and detail panel

---

## Stage Definitions

### Conceptual (Editable)
- **Purpose**: High-level business entity design. "What entities exist and how do they relate?"
- **Content**: Models with names, descriptions, optional high-level columns (no data types required), entity-level relationships (cardinality only, FK columns optional)
- **No manifest interaction** — purely a design artifact
- **Schema**: Same `SemanticDomain` structure but with relaxed column requirements (dataType defaults to `''`)

### Logical (Editable)
- **Purpose**: Detailed data model design. "What columns, data types, and FK relationships exist?"
- **Content**: Models with full column definitions (names, data types, descriptions), FK relationships with explicit column references, PK/FK/NK designations, grain, modelRole, rationale
- **No manifest interaction** — this is the blueprint for what the dbt developer should build
- **Schema**: Same `SemanticDomain` structure, fully specified

### Physical (Read-Only)
- **Purpose**: "What actually exists in dbt right now?"
- **Content**: Auto-derived from `manifest.json`, scoped to the models listed in the corresponding logical domain
- **No editable JSON file** — renders manifest data only
- **Model list**: Same models as the logical domain (looked up in manifest by name)
- **Canvas positions**: Inherited from the logical domain's `viewConfig.positions` — same layout
- **Missing models**: If a logical model doesn't exist in the manifest yet, it appears as a ghost/missing node
- **All toolbar edit tools disabled**: No "+ Add", no "New Model", no "New Relationship", no undo/redo

---

## Architecture Changes

### Phase 1: Type System & Stage Infrastructure

**Goal**: Add `stage` as a first-class concept. Remove `source`, `approved`, and status enums.

#### 1.1 New Type: `Stage`

File: `src/types/semantic.ts`

```ts
/** The three design stages of a domain. */
export type Stage = 'conceptual' | 'logical' | 'physical';
```

#### 1.2 Simplify `SemanticModel`

Remove fields that belong to the old reconciliation model:

```ts
export interface SemanticModel {
  name: string;
  // REMOVED: source: 'built' | 'design'
  // REMOVED: approved?: boolean
  // REMOVED: primaryKey?: string (use isPrimaryKey on columns instead)
  // REMOVED: plannedColumns?: ColumnDef[] (no overlay semantics)
  // REMOVED: designedColumns?: string[] (no structural discrepancy tracking within a stage)
  schema?: string;
  description?: string;
  columns?: ColumnDef[];
  rationale?: Rationale;
  grain?: string;
  modelRole?: ModelRole;
}
```

#### 1.3 Simplify `ColumnDef`

Remove approval and discrepancy-tracking fields:

```ts
export interface ColumnDef {
  name: string;
  dataType: string;           // defaults to '' for conceptual stage
  description: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  isNaturalKey?: boolean;
  // REMOVED: approved?: boolean
  // REMOVED: expectedDataType?: string
  // REMOVED: rejected?: boolean
  // REMOVED: structuralRejected?: boolean
  scdType?: 0 | 1 | 2;
  additiveType?: 'additive' | 'semi-additive' | 'non-additive';
}
```

#### 1.4 Simplify `Relationship`

```ts
export interface Relationship {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
  // REMOVED: source?: 'design'
  // REMOVED: approved?: boolean
}
```

#### 1.5 Update `SemanticDomain`

```ts
export interface SemanticDomain {
  schemaVersion: number;  // bump to 2
  domain: string;
  layer: Layer;
  stage: Stage;           // NEW
  description: string;
  modelFolder?: string;
  models: SemanticModel[];
  relationships: Relationship[];
  viewConfig: ViewConfig;
}
```

Bump `CURRENT_SCHEMA_VERSION` to `2`.

#### 1.6 Update `DomainSummary`

```ts
export interface DomainSummary {
  domain: string;
  layer: Layer;
  stage: Stage;           // NEW
  filePath: string;
}
```

#### 1.7 Simplify Reconciled Types

Since there's no more manifest-merge reconciliation, the "reconciled" types become simpler display types. Rename to `DisplayDomain`, `DisplayModel`, `DisplayColumn`:

```ts
/** Column ready for webview display. */
export interface DisplayColumn {
  name: string;
  dataType: string;
  description: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isNaturalKey: boolean;
  scdType?: 0 | 1 | 2;
  additiveType?: 'additive' | 'semi-additive' | 'non-additive';
}

/** Model ready for webview display. */
export interface DisplayModel {
  name: string;
  schema: string;
  description: string;
  columns: DisplayColumn[];
  rationale?: Rationale;
  grain?: string;
  modelRole?: ModelRole;
  /** True if model exists in manifest (physical stage only). */
  existsInManifest?: boolean;
}

/** Relationship ready for webview display. */
export interface DisplayRelationship {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
}

/** Domain ready for webview rendering. */
export interface DisplayDomain {
  schemaVersion: number;
  domain: string;
  layer: Layer;
  stage: Stage;
  description: string;
  modelFolder?: string;
  models: DisplayModel[];
  relationships: DisplayRelationship[];
  viewConfig: ViewConfig;
  /** Available templates (only for editable stages). */
  templates?: ModelTemplate[];
  /** Manifest models available to add (only for editable stages). */
  manifestModels?: ManifestModelPreview[];
  /** Layer config for badge styling. */
  layerConfig?: LayerConfig;
  /** Whether this stage is read-only (physical). */
  readOnly: boolean;
}
```

#### 1.8 New: Discrepancy Types

File: `src/types/discrepancy.ts`

```ts
import type { Cardinality, Stage } from './semantic';

export interface DiscrepancyReport {
  domain: string;
  layer: string;
  /** The stage currently being viewed. */
  sourceStage: Stage;
  /** The stage being compared against. */
  targetStage: Stage;
  models: ModelDiscrepancy[];
  relationships: RelationshipDiscrepancy[];
  summary: {
    totalModels: number;
    matchedModels: number;
    extraModels: number;       // in source but not target
    missingModels: number;     // in target but not source
    totalColumns: number;
    matchedColumns: number;
    extraColumns: number;      // in source model but not target model
    missingColumns: number;    // in target model but not source model
    dataTypeMismatches: number;
  };
}

export interface ModelDiscrepancy {
  name: string;
  status: 'matched' | 'extra' | 'missing';
  columns: ColumnDiscrepancy[];
}

export interface ColumnDiscrepancy {
  name: string;
  status: 'matched' | 'extra' | 'missing' | 'type-mismatch';
  /** Data type in the source stage (the stage being viewed). */
  sourceDataType?: string;
  /** Data type in the target stage (the comparison stage). */
  targetDataType?: string;
}

export interface RelationshipDiscrepancy {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  status: 'matched' | 'extra' | 'missing' | 'cardinality-mismatch';
  sourceCardinality?: Cardinality;
  targetCardinality?: Cardinality;
}
```

---

### Phase 2: Domain Service Changes

**Goal**: DomainService discovers and manages domains across stage directories.

#### 2.1 Update `DomainService.listDomains()`

Change discovery from `erd-studio/{layer}/*.json` to `erd-studio/{stage}/{layer}/*.json`:

```
for stage in ['conceptual', 'logical']:
  for layer in layers:
    scan erd-studio/{stage}/{layer}/*.json
```

Physical domains aren't listed from disk — they're derived.

#### 2.2 Update `DomainService.getDomain()`

The `stage` field is inferred from the grandparent directory:
```
erd-studio / conceptual / silver / orders.json
              ^stage       ^layer   ^domain
```

#### 2.3 New: `DomainService.buildPhysicalDomain()`

```ts
buildPhysicalDomain(
  logicalDomain: SemanticDomain,
  manifest: ManifestData,
): DisplayDomain
```

1. Takes the logical domain's model list
2. For each model, looks it up in the manifest:
   - **Found**: Creates a `DisplayModel` with manifest columns, data types, descriptions
   - **Not found**: Creates a ghost `DisplayModel` with `existsInManifest: false` and empty columns
3. For relationships: checks if corresponding relationship tests exist in manifest
4. **Copies `viewConfig.positions` from the logical domain** — physical layout mirrors logical
5. Sets `readOnly: true`
6. Does NOT include `templates` or `manifestModels` (no editing in physical)

#### 2.4 Domain Creation

When creating a new domain, create files in both `conceptual/` and `logical/` directories:
- `erd-studio/conceptual/{layer}/{domain}.json` — empty models/relationships, `stage: 'conceptual'`
- `erd-studio/logical/{layer}/{domain}.json` — empty models/relationships, `stage: 'logical'`

Both files share the same `domain` name and `layer`.

---

### Phase 3: Discrepancy Service

**Goal**: Cross-stage comparison producing column-level diffs.

#### 3.1 Delete Old Services

- **Delete** `src/services/reconciliationService.ts` — no more manifest-merge reconciliation
- **Delete** `src/services/autoReconciliationService.ts` — no more design→built auto-transition
- **Delete** `src/services/schemaTagService.ts` — no more schema.yml tag syncing (was tied to approval workflow)

#### 3.2 New: `DiscrepancyService`

File: `src/services/discrepancyService.ts`

```ts
export class DiscrepancyService {
  /**
   * Compare two display domains and produce a discrepancy report.
   *
   * @param source - The domain being viewed (e.g., physical)
   * @param target - The domain being compared against (e.g., logical)
   */
  compare(source: DisplayDomain, target: DisplayDomain): DiscrepancyReport {
    // 1. Match models by name
    // 2. For matched models, compare columns by name:
    //    - Column in both → check dataType match
    //    - Column in source only → 'extra'
    //    - Column in target only → 'missing'
    // 3. Match relationships by composite key (fromModel, fromColumn, toModel, toColumn)
    //    - Matched → check cardinality
    //    - In source only → 'extra'
    //    - In target only → 'missing'
    // 4. Produce summary counts
  }
}
```

#### 3.3 Discrepancy Comparison Matrix

| Active Stage | Toggle Label | Comparison Direction |
|-------------|-------------|---------------------|
| Physical | "Compare to Logical" | Physical (source) vs Logical (target) |
| Logical | "Compare to Physical" | Logical (source) vs Physical (target) |
| Logical | "Compare to Conceptual" | Logical (source) vs Conceptual (target) |
| Conceptual | "Compare to Logical" | Conceptual (source) vs Logical (target) |

Primary use cases:
1. **Physical canvas + discrepancy ON**: "What did we build vs what we designed?" — shows extra columns dbt added, missing columns not yet built, data type differences
2. **Logical canvas + compare to conceptual**: "Does my logical model cover all conceptual entities?"

---

### Phase 4: Editor Provider & Stage Switching

**Goal**: Enable switching between stages within the same editor canvas. Physical stage is fully read-only.

#### 4.1 Stage State in Webview Store

```ts
export interface EditorState {
  // ... existing fields (minus removed approval/discrepancy fields)
  activeStage: Stage;                        // NEW
  discrepancyReport: DiscrepancyReport | null; // NEW
  discrepancyVisible: boolean;               // NEW: toggle for overlay
  readOnly: boolean;                         // NEW: true when physical
}
```

#### 4.2 New Message Types

```ts
// Webview → Extension
interface SwitchStageMessage {
  type: 'switchStage';
  payload: { stage: Stage };
}

interface ToggleDiscrepancyMessage {
  type: 'toggleDiscrepancy';
  payload: { enabled: boolean; compareAgainst?: Stage };
}

// Extension → Webview
interface StageDataMessage {
  type: 'stageData';
  payload: DisplayDomain;
}

interface DiscrepancyReportMessage {
  type: 'discrepancyReport';
  payload: DiscrepancyReport | null;  // null = cleared
}
```

#### 4.3 Remove Old Message Types

Remove these webview→extension messages entirely:

```
approveModel, unapproveModel
approveColumn, unapproveColumn
approveRelationship, unapproveRelationship
acceptDiscrepancy, rejectDiscrepancy, unrejectDiscrepancy
acceptAllDiscrepancies
acceptStructuralDiscrepancy, rejectStructuralDiscrepancy, unrejectStructuralDiscrepancy
refreshManifest (keep as toolbar action but route differently)
```

#### 4.4 SemanticEditorProvider Changes

The editor provider is activated by opening any `erd-studio/{stage}/{layer}/{domain}.json` file.

**Stage switching flow**:

1. Webview sends `switchStage { stage: 'physical' }`
2. Provider determines domain name and layer from current file path
3. For **conceptual/logical**: Reads `erd-studio/{newStage}/{layer}/{domain}.json`, converts to `DisplayDomain`
4. For **physical**: Calls `buildPhysicalDomain()` using the logical domain's model list + manifest data. Copies positions from logical domain's `viewConfig`
5. Sends `stageData` message with `DisplayDomain` (includes `readOnly: true` for physical)

**Edit routing**:

All mutation message handlers (`addModel`, `addColumn`, `removeColumn`, etc.) check `activeStage`:
- `conceptual` or `logical`: Process normally (write to the corresponding JSON file)
- `physical`: Reject silently (shouldn't happen since UI disables controls, but defensive)

**Document tracking**:

The provider tracks the active stage and switches which JSON file it writes to:
- When stage is `conceptual`: writes to `erd-studio/conceptual/{layer}/{domain}.json`
- When stage is `logical`: writes to `erd-studio/logical/{layer}/{domain}.json`
- When stage is `physical`: no document — derived view, all writes rejected

#### 4.5 Physical Stage: Position Inheritance

When building the physical display domain:

```ts
// Copy positions from logical domain
physicalDomain.viewConfig.positions = { ...logicalDomain.viewConfig.positions };
```

This ensures the physical canvas has the exact same layout as the logical canvas. The user sees the same spatial arrangement and can immediately compare visually.

If a logical model doesn't exist in manifest, it still appears as a ghost node at its logical position.

---

### Phase 5: Toolbar & Read-Only Mode

**Goal**: Stage tabs in toolbar. Disable edit controls in physical stage.

#### 5.1 Stage Tabs

Add stage tabs to the toolbar between domain info and zoom controls:

```
[orders] [SLV] | [Conceptual] [Logical] [Physical] | [-] 100% [+] [Fit] | ...
```

- Active tab is visually highlighted (e.g., underline + bold)
- Clicking a tab sends `switchStage` message
- Keyboard shortcuts: `Alt+1` = conceptual, `Alt+2` = logical, `Alt+3` = physical

Component: `webview/components/Toolbar/StageTabs.tsx`

#### 5.2 Read-Only Toolbar

When `readOnly === true` (physical stage), the toolbar **hides or disables** these controls:

| Control | Behaviour in Physical |
|---------|----------------------|
| "+ Add" dropdown | **Hidden** |
| Undo / Redo | **Hidden** |
| Auto Layout | **Disabled** (positions come from logical) |
| Refresh Manifest | **Visible** (refreshes physical data from manifest) |
| Search | **Visible** (still useful) |
| Expand/Collapse All | **Visible** (viewing aid) |
| Palette | **Visible** (viewing aid) |
| Zoom controls | **Visible** |
| Fit View | **Visible** |

The toolbar shows a subtle "Read-only" indicator near the stage tabs when physical is active.

#### 5.3 Read-Only Detail Panel

When physical stage is active and user clicks a model node:
- Detail panel opens in **view-only mode**
- Shows model name, schema, description, columns, relationships
- **No** edit buttons, rename, add/remove column, add/remove relationship
- **No** context menu actions for editing
- Columns display as a read-only table (no inline editing)

#### 5.4 Read-Only Canvas Interactions

When physical stage is active:
- Node dragging: **Disabled** (positions are inherited from logical, not independently editable)
- Column drag-to-connect: **Disabled**
- Right-click context menu: **View-only** (no delete, no edit cardinality on edges)
- Delete/Backspace key: **No-op**

#### 5.5 Discrepancy Toggle

A toggle button in the toolbar, visible when in physical or logical stage:

```
[Discrepancy ▾] [ON/OFF]
```

Clicking the dropdown shows comparison options based on active stage:
- **Physical**: "Compare to Logical" (only option)
- **Logical**: "Compare to Physical" | "Compare to Conceptual"
- **Conceptual**: "Compare to Logical" (only option)

When toggled ON:
1. Webview sends `toggleDiscrepancy { enabled: true, compareAgainst: 'logical' }`
2. Extension runs `DiscrepancyService.compare()` between the two stages
3. Extension sends `discrepancyReport` message with the result
4. Webview overlays discrepancy indicators on the canvas

---

### Phase 6: Discrepancy Overlay UI

**Goal**: Visual indicators on the canvas showing column-level differences between stages.

#### 6.1 Model Node Discrepancy Indicators

When discrepancy mode is ON, each model node shows its comparison status:

- **Matched model**: Normal rendering, with column-level annotations inside
- **Extra model** (in current stage but not comparison): Amber/yellow border glow
- **Missing model** (in comparison but not current stage): Ghost node — dashed border, 50% opacity, shown at the position it would occupy in the comparison stage

For ghost (missing) models: they appear on the canvas using positions from the comparison domain's `viewConfig`. This gives spatial context for what's missing.

#### 6.2 Column-Level Discrepancy Indicators

Within a matched model node, columns are annotated:

| Discrepancy | Visual |
|-------------|--------|
| Matched column | Normal rendering (no indicator) |
| Extra column | Amber background highlight + "extra" badge |
| Missing column | Ghost row — grey text, strikethrough, "missing" badge |
| Data type mismatch | Both types shown: `VARCHAR → TEXT` with red indicator |

Missing columns are appended after the model's own columns as ghost rows.

#### 6.3 Edge Discrepancy Indicators

Relationships also show comparison status:

- **Matched**: Normal rendering
- **Extra**: Amber dashed edge
- **Missing**: Grey dashed ghost edge (rendered from comparison data)
- **Cardinality mismatch**: Normal edge with cardinality badge in red showing `M:1 → 1:1`

#### 6.4 Discrepancy Summary Panel

A collapsible summary panel at the bottom or side of the canvas:

```
Physical vs Logical
━━━━━━━━━━━━━━━━━━
Models: 4 matched, 1 extra, 0 missing
Columns: 28 matched, 3 extra, 2 missing, 1 type mismatch

▸ dim_customer (matched)
    email_hash: VARCHAR (physical) → TEXT (logical)
▸ fct_orders (matched)
  + _dbt_loaded_at (extra — not in logical)
  - order_priority (missing — in logical but not built)
▸ stg_raw_events (extra — not in logical)
```

Clicking a model or column in the summary panel navigates to and highlights it on the canvas.

Component: `webview/components/DiscrepancyPanel/DiscrepancyPanel.tsx`

---

### Phase 7: Graph Transformer Updates

**Goal**: Adapt the rendering pipeline for stage-aware data with discrepancy overlay.

#### 7.1 Conceptual Stage Rendering

- Models render as **entity boxes** — larger, simpler, no column rows (just entity name + description)
- Relationships render as simple lines with cardinality symbols
- No PK/FK badges, no column expansion toggle
- New component: `ConceptualModelNode`

#### 7.2 Logical Stage Rendering

- Models render as current `ModelNode` — full column detail
- All columns show data types, PK/FK/NK badges
- Relationships render as current `FkEdge` with column references
- **Single colour scheme** — no built/design/approved distinction. All models in one consistent colour per stage
- Column expansion, search dimming, selection dimming all work as before

#### 7.3 Physical Stage Rendering

- Models render with current `ModelNode` component but with **read-only visual cue**
- Lock icon (🔒) in model node header
- All data comes from manifest
- Models not found in manifest render as ghost nodes (dashed border, "Not yet built" label)
- **Same positions as logical** — inherited from logical domain's viewConfig
- No drag handles, no column drag-to-connect handles

#### 7.4 Graph Transformer Stage Routing

```ts
export function transformDomain(
  domain: DisplayDomain,
  discrepancyReport?: DiscrepancyReport,
): TransformResult {
  // Choose node type based on stage
  const nodeType = domain.stage === 'conceptual' ? 'conceptual' : 'model';

  // Build nodes
  const nodes = domain.models.map(model => ({
    id: model.name,
    type: nodeType,
    position: positions[model.name] ?? DEFAULT_POSITION,
    data: {
      ...modelData,
      readOnly: domain.readOnly,
      // Inject per-model discrepancy data if report active
      discrepancy: discrepancyReport
        ? findModelDiscrepancy(discrepancyReport, model.name)
        : undefined,
    },
  }));

  // If discrepancy is active, add ghost nodes for missing models
  if (discrepancyReport) {
    for (const modelDisc of discrepancyReport.models) {
      if (modelDisc.status === 'missing') {
        nodes.push(createGhostNode(modelDisc, ...));
      }
    }
  }

  // Similar for edges + ghost edges
  ...
}
```

---

### Phase 8: Colour System Changes

**Goal**: Replace the built/approved/design colour scheme with stage-aware colours.

#### 8.1 New Colour Scheme

Each stage has a single primary colour for all models (no status variants):

| Stage       | Model Colour | Rationale |
|-------------|-------------|-----------|
| Conceptual  | Purple/Violet | High-level, abstract design |
| Logical     | Blue/Teal    | Detailed, concrete design |
| Physical    | Green        | Built, exists in dbt |

#### 8.2 Discrepancy Overlay Colours (Cross-Stage)

| Discrepancy     | Visual |
|-----------------|--------|
| Matched         | Normal stage colour |
| Extra           | Amber/yellow border |
| Missing (ghost) | Grey dashed border, 50% opacity |
| Type mismatch   | Red indicator on affected column |

#### 8.3 Remove Old Colour System

- Remove `ModelStatus`, `ColumnStatus`, `RelationshipStatus` enums
- Remove status-based CSS classes (`model-node--built`, `model-node--design`, etc.)
- Remove status-based palette entries (`modelBuilt`, `modelApproved`, `modelDesign`, `modelMissing`)
- Replace with stage-based palette entries (`stageConceptual`, `stageLogical`, `stagePhysical`)
- Update `colorPalettes.ts` with new palette definitions

---

### Phase 9: Sidebar Tree Changes

**Goal**: Stage toggle at top of sidebar.

#### 9.1 Tree Structure

Stage toggle filters which directory set is shown:

```
[Conceptual] [Logical] [Physical]
─────────────────────────────────
▾ Silver
    orders (4 models)
    finance (2 models)
    + New Domain...
▾ Gold
    analytics (3 models)
    + New Domain...
```

#### 9.2 DomainTreeProvider Changes

- Add `currentStage` state (stored in `ExtensionContext.workspaceState`)
- `getChildren()` reads from `erd-studio/{currentStage}/{layer}/` instead of `erd-studio/{layer}/`
- For **physical** stage: list domains that exist in `erd-studio/logical/` (since physical mirrors logical's model list). Opening one switches the editor to physical view.
- "New Domain..." only appears in conceptual and logical stages (not physical)
- New command: `dbtSemantic.switchTreeStage` (sets currentStage and refreshes tree)

---

### Phase 10: Command & Configuration Updates

#### 10.1 Updated Commands

| Command | Change |
|---------|--------|
| `dbtSemantic.createDomain` | Creates both `conceptual/{layer}/{domain}.json` and `logical/{layer}/{domain}.json` |
| `dbtSemantic.deleteDomain` | Deletes files in both `conceptual/` and `logical/` directories |
| `dbtSemantic.renameDomain` | Renames in both directories (atomic WorkspaceEdit) |
| `dbtSemantic.openDomain` | Opens with stage context from sidebar's current stage |
| NEW: `dbtSemantic.switchStage` | Switch active stage in editor |
| NEW: `dbtSemantic.switchTreeStage` | Switch sidebar tree stage filter |
| KEEP: `dbtSemantic.refreshManifest` | Now only refreshes physical view data |
| REMOVE: `dbtSemantic.syncDomainTags` | No longer relevant (was tied to approval workflow) |

#### 10.2 Custom Editor Glob

Update the file activation glob in `package.json`:
```
**/erd-studio/{conceptual,logical}/**/*.json
```

Note: VS Code globs don't support `{a,b}` syntax in `customEditors.selector`. Use two patterns:
```json
"selector": [
  { "filenamePattern": "**/erd-studio/conceptual/**/*.json" },
  { "filenamePattern": "**/erd-studio/logical/**/*.json" }
]
```

#### 10.3 Settings

| Setting | Change |
|---------|--------|
| `dbtSemantic.semanticDir` | Still `erd-studio` (parent of stage dirs) |
| REMOVE: `dbtSemantic.autoReconcile` | No more auto-reconciliation |

#### 10.4 Setup Command

`dbtSemantic.setupSemanticDirectory` now creates:
```
erd-studio/
  conceptual/
    silver/
    gold/
  logical/
    silver/
    gold/
  layers.json
  templates/
```

---

### Phase 11: File Watcher Changes

#### 11.1 Domain File Watchers

Watch `erd-studio/conceptual/**/*.json` and `erd-studio/logical/**/*.json`.

#### 11.2 Manifest Watcher

Keep the manifest watcher (`target/manifest.json`) but change its role:
- Only triggers refresh of physical view data in any open editor showing physical stage
- **No** auto-reconciliation, no design→built transitions, no schema.yml tag syncing

---

### Phase 12: Code Removal

**Goal**: Clean deletion of old systems that are replaced by the stage architecture.

#### 12.1 Files to Delete

| File | Reason |
|------|--------|
| `src/services/reconciliationService.ts` | Replaced by stage separation + DiscrepancyService |
| `src/services/autoReconciliationService.ts` | No more design→built auto-transition |
| `src/services/schemaTagService.ts` | Was tied to approval workflow |

#### 12.2 Code to Remove from Existing Files

**`src/types/semantic.ts`**:
- `SemanticModel.source` field
- `SemanticModel.approved` field
- `SemanticModel.primaryKey` field (use `isPrimaryKey` on columns)
- `SemanticModel.plannedColumns` field
- `SemanticModel.designedColumns` field
- `ColumnDef.approved` field
- `ColumnDef.expectedDataType` field
- `ColumnDef.rejected` field
- `ColumnDef.structuralRejected` field
- `Relationship.source` field
- `Relationship.approved` field

**`src/types/reconciled.ts`**:
- `ModelStatus`, `ColumnStatus`, `RelationshipStatus` types
- `ReconciledColumn.discrepancy` field
- `ReconciledColumn.approved` field
- `ReconciledModel.approved` field
- `ReconciledModel.discrepancyCount` field
- Entire file may be replaced by new `DisplayDomain` types

**`src/types/messages.ts`**:
- All 16 approval/discrepancy message types (approve*, unapprove*, accept*, reject*, unreject*)
- `ManifestRefreshedMessage` (no more auto-reconciliation notifications)

**`src/providers/SemanticEditorProvider.ts`**:
- All approval handler methods (`handleApproveModel`, `handleUnapproveModel`, etc.)
- All discrepancy handler methods (`handleAcceptDiscrepancy`, etc.)
- Auto-reconciliation logic in `reconcileAllOpenDomains()`
- SchemaTagService integration

**`webview/store/editorStore.ts`**:
- `discrepancyReviewModel` field (replaced by new discrepancy system)

**`webview/components/`**:
- `DiscrepancyReviewDialog/` — replaced by new DiscrepancyPanel
- Approval buttons/UI in `DetailPanel`
- Status-based styling in `ModelNode`, `FkEdge`

---

## Implementation Order

```
Phase 1 (Types)
  ↓
Phase 12 (Code Removal) ── do this early to reduce confusion
  ↓
Phase 2 (Domain Service)
  ↓
Phase 3 (Discrepancy Service)
  ↓
Phase 8 (Colours)
  ↓
Phase 7 (Graph Transformer)
  ↓
Phase 4 (Editor Provider + Stage Switching)
  ↓
Phase 5 (Toolbar + Read-Only Mode)
  ↓
Phase 6 (Discrepancy Overlay UI)
  ↓
Phase 9 (Sidebar Tree)
  ↓
Phase 10 (Commands)
  ↓
Phase 11 (Watchers)
```

Suggested work batches:

1. **Batch A** (Foundation + Cleanup): Phases 1, 12, 2 — new types, delete old code, update domain service
2. **Batch B** (Core Services): Phases 3, 8, 7 — discrepancy service, colours, graph transformer
3. **Batch C** (Editor + Toolbar): Phases 4, 5 — stage switching, read-only mode, toolbar changes
4. **Batch D** (Discrepancy UI): Phase 6 — overlay rendering, summary panel
5. **Batch E** (Shell): Phases 9, 10, 11 — sidebar, commands, watchers

---

## Migration

No migration needed — per user instruction, assume no existing users. All existing domain files under `erd-studio/{layer}/` can be deleted. The extension will create the new `erd-studio/{stage}/{layer}/` structure on first use via the setup command.

---

## Files Affected

### New Files
- `src/types/discrepancy.ts` — DiscrepancyReport, ModelDiscrepancy, ColumnDiscrepancy types
- `src/types/display.ts` — DisplayDomain, DisplayModel, DisplayColumn, DisplayRelationship
- `src/services/discrepancyService.ts` — Cross-stage comparison logic
- `webview/components/Graph/ConceptualModelNode.tsx` — Simplified entity node for conceptual stage
- `webview/components/Graph/ConceptualModelNode.css`
- `webview/components/DiscrepancyPanel/DiscrepancyPanel.tsx` — Discrepancy summary panel
- `webview/components/DiscrepancyPanel/DiscrepancyPanel.css`
- `webview/components/Toolbar/StageTabs.tsx` — Stage tab switcher component
- `webview/components/Toolbar/StageTabs.css`

### Major Modifications
- `src/types/semantic.ts` — Add Stage, simplify SemanticModel (remove source/approved/plannedColumns)
- `src/types/messages.ts` — Add stage/discrepancy messages, remove 16+ approval messages
- `src/services/domainService.ts` — Stage-aware discovery, `buildPhysicalDomain()`, domain creation in both dirs
- `src/providers/SemanticEditorProvider.ts` — Stage switching, physical view, edit routing, remove approval handlers
- `src/providers/DomainTreeProvider.ts` — Stage toggle, updated tree structure
- `webview/store/editorStore.ts` — Add activeStage, discrepancyReport, readOnly; remove approval state
- `webview/App.tsx` — Route to correct node type per stage, discrepancy overlay, read-only guards
- `webview/lib/graphTransformer.ts` — Stage-aware node/edge generation, ghost nodes/edges for discrepancy
- `webview/components/Toolbar/Toolbar.tsx` — Stage tabs, discrepancy toggle, hide edit controls when readOnly
- `webview/components/Graph/ModelNode.tsx` — Read-only mode, discrepancy indicators on columns
- `webview/components/Graph/FkEdge.tsx` — Discrepancy indicators, remove status colouring
- `webview/components/DetailPanel/DetailPanel.tsx` — Remove approval UI, view-only mode for physical
- `webview/lib/colorPalettes.ts` — Stage-based colour scheme replacing status-based

### Deleted Files
- `src/services/reconciliationService.ts`
- `src/services/autoReconciliationService.ts`
- `src/services/schemaTagService.ts`
- `webview/components/DiscrepancyReviewDialog/` (entire directory)
- `test/unit/reconciliationService.test.ts` (replaced by discrepancyService tests)
- `test/unit/autoReconciliationService.test.ts`
