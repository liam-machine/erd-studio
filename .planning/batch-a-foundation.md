# Batch A: Foundation + Cleanup (Phases 1, 12, 2)

## Prerequisites
- Branch: `feature/three-stage-design` (create from `main`)
- No prior batches — this is the first batch

## Goal
Replace the type system, delete old services, and update the domain service for the new three-stage architecture (`conceptual / logical / physical`). After this batch the extension **will not function** — consumers of the old types won't compile yet. That's expected; Batch B fixes the rendering pipeline.

## Context: What's Changing

The extension currently uses a single directory `erd-studio/{layer}/{domain}.json` with models that have `source: 'built' | 'design'`, an approval workflow, and manifest-merge reconciliation. We're replacing all of that with:

- Three stage directories: `erd-studio/{conceptual,logical}/{layer}/{domain}.json`
- Physical stage has no files — it's derived from manifest + logical domain's model list
- No more `source` field, no `approved` field, no `plannedColumns`, no `designedColumns`
- No more `ReconciliationService`, `AutoReconciliationService`, or `SchemaTagService`

Read `plan.md` in the project root for full architectural context.

---

## Phase 1: Type System Changes

### 1.1 Update `src/types/semantic.ts`

Add `Stage` type:
```ts
export type Stage = 'conceptual' | 'logical' | 'physical';
```

Bump schema version:
```ts
export const CURRENT_SCHEMA_VERSION = 2;
```

Simplify `ColumnDef` — **remove** these fields:
- `approved?: boolean`
- `expectedDataType?: string`
- `rejected?: boolean`
- `structuralRejected?: boolean`

Keep: `name`, `dataType`, `description`, `isPrimaryKey`, `isForeignKey`, `isNaturalKey`, `scdType`, `additiveType`

Simplify `SemanticModel` — **remove** these fields:
- `source: 'built' | 'design'`
- `approved?: boolean`
- `primaryKey?: string`
- `plannedColumns?: ColumnDef[]`
- `designedColumns?: string[]`

Keep: `name`, `schema?`, `description?`, `columns?`, `rationale?`, `grain?`, `modelRole?`

Simplify `Relationship` — **remove** these fields:
- `source?: 'design'`
- `approved?: boolean`

Keep: `fromModel`, `fromColumn`, `toModel`, `toColumn`, `cardinality`

Update `SemanticDomain` — **add** `stage: Stage`:
```ts
export interface SemanticDomain {
  schemaVersion: number;
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

Update `DomainSummary` — **add** `stage: Stage`:
```ts
export interface DomainSummary {
  domain: string;
  layer: Layer;
  stage: Stage;           // NEW
  filePath: string;
}
```

Remove the `DesignModel` interface (it was for the old "add design model" flow — we'll update the add model flow later to just use `SemanticModel`).

### 1.2 Create `src/types/display.ts`

New file with display types for the webview (replaces `reconciled.ts`):

```ts
/**
 * Display types for webview rendering.
 * These replace the old "reconciled" types. No more manifest-merge —
 * each stage is rendered directly from its own data source.
 */

import type { Rationale, Cardinality, Layer, Stage, ModelRole, ModelTemplate, ViewConfig } from './semantic';
import type { LayerConfig } from './layer';

export interface ManifestModelPreview {
  name: string;
  schema: string;
  description: string;
  columnCount: number;
}

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

export interface DisplayModel {
  name: string;
  schema: string;
  description: string;
  columns: DisplayColumn[];
  rationale?: Rationale;
  grain?: string;
  modelRole?: ModelRole;
  /** Physical stage: true if model exists in manifest. False = ghost/missing node. */
  existsInManifest?: boolean;
}

export interface DisplayRelationship {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
}

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
  templates?: ModelTemplate[];
  manifestModels?: ManifestModelPreview[];
  layerConfig?: LayerConfig;
  /** True when stage is physical — all editing disabled. */
  readOnly: boolean;
}
```

### 1.3 Create `src/types/discrepancy.ts`

New file with discrepancy report types:

```ts
import type { Cardinality, Stage } from './semantic';

export interface DiscrepancyReport {
  domain: string;
  layer: string;
  sourceStage: Stage;
  targetStage: Stage;
  models: ModelDiscrepancy[];
  relationships: RelationshipDiscrepancy[];
  summary: {
    totalModels: number;
    matchedModels: number;
    extraModels: number;
    missingModels: number;
    totalColumns: number;
    matchedColumns: number;
    extraColumns: number;
    missingColumns: number;
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
  sourceDataType?: string;
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

### 1.4 Update `src/types/messages.ts`

**Remove** all approval and old discrepancy message types (16+ types):
- `ApproveModelMessage`, `UnapproveModelMessage`
- `ApproveColumnMessage`, `UnapproveColumnMessage`
- `ApproveRelationshipMessage`, `UnapproveRelationshipMessage`
- `AcceptDiscrepancyMessage`, `RejectDiscrepancyMessage`, `UnrejectDiscrepancyMessage`
- `AcceptAllDiscrepanciesMessage`
- `AcceptStructuralDiscrepancyMessage`, `RejectStructuralDiscrepancyMessage`, `UnrejectStructuralDiscrepancyMessage`
- `ManifestRefreshedMessage`
- Remove `ColumnKeyType` (the toggle key message can stay but remove approved context)

Remove them from the `WebviewMessage` union and `ExtensionMessage` union too.

**Update** existing messages:
- `DomainLoadedMessage.payload` type changes from `ReconciledDomain` to `DisplayDomain`
- `DomainUpdatedMessage.payload` type changes from `ReconciledDomain` to `DisplayDomain`
- `AddModelMessage.payload` — change from `DesignModel` to a simpler inline type: `{ name: string; schema?: string; description: string; columns: ColumnDef[]; modelRole?: ModelRole }`

**Add** new message types:
```ts
interface SwitchStageMessage {
  type: 'switchStage';
  payload: { stage: Stage };
}

interface StageDataMessage {
  type: 'stageData';
  payload: DisplayDomain;
}

interface ToggleDiscrepancyMessage {
  type: 'toggleDiscrepancy';
  payload: { enabled: boolean; compareAgainst?: Stage };
}

interface DiscrepancyReportMessage {
  type: 'discrepancyReport';
  payload: DiscrepancyReport | null;
}
```

Add `SwitchStageMessage` and `ToggleDiscrepancyMessage` to the `WebviewMessage` union.
Add `StageDataMessage` and `DiscrepancyReportMessage` to the `ExtensionMessage` union.

Import `Stage` from `./semantic`, `DisplayDomain` from `./display`, and `DiscrepancyReport` from `./discrepancy`.

### 1.5 Delete `src/types/reconciled.ts`

This entire file is replaced by `src/types/display.ts`. Delete it.

Update any imports in the codebase that referenced `reconciled.ts` to use `display.ts` types instead. Key files that import from reconciled:
- `src/services/reconciliationService.ts` (being deleted)
- `src/providers/SemanticEditorProvider.ts` (updated later)
- `webview/lib/graphTransformer.ts` (updated later)
- `webview/store/editorStore.ts` (updated later)
- `webview/App.tsx` (updated later)

For files not being modified in this batch, just update the import path to `display.ts` and use the new type names. The actual logic changes happen in later batches.

---

## Phase 12: Code Removal

### 12.1 Delete Old Service Files

Delete these files entirely:
- `src/services/reconciliationService.ts`
- `src/services/autoReconciliationService.ts`
- `src/services/schemaTagService.ts`

### 12.2 Delete Old Test Files

Delete test files for deleted services:
- `test/unit/reconciliationService.test.ts` (if exists)
- `test/unit/autoReconciliationService.test.ts` (if exists)
- Any other test files that only test deleted services

Use `grep -r "reconciliationService\|autoReconciliationService\|schemaTagService" test/` to find them.

### 12.3 Remove Imports and References

Search the entire codebase for imports of the deleted services and remove them:
```
grep -r "ReconciliationService\|AutoReconciliationService\|SchemaTagService" src/
```

Key files that will have broken imports:
- `src/providers/SemanticEditorProvider.ts` — remove imports, constructor params, and all handler methods that used these services
- `src/extension.ts` — remove service instantiation and any command handlers that used them

For `SemanticEditorProvider.ts`, this is extensive. Remove:
- The `reconciliationService` constructor parameter and field
- The `autoReconciliationService` constructor parameter and field
- The `schemaTagService` constructor parameter and field
- The `reconcileAllOpenDomains()` method
- All approval handler methods: `handleApproveModel`, `handleUnapproveModel`, `handleApproveColumn`, `handleUnapproveColumn`, `handleApproveRelationship`, `handleUnapproveRelationship`
- All old discrepancy handler methods: `handleAcceptDiscrepancy`, `handleRejectDiscrepancy`, `handleUnrejectDiscrepancy`, `handleAcceptAllDiscrepancies`, `handleAcceptStructuralDiscrepancy`, `handleRejectStructuralDiscrepancy`, `handleUnrejectStructuralDiscrepancy`
- The corresponding `case` branches in the message switch statement
- The `ManifestRefreshedMessage` sending logic

For `src/extension.ts`:
- Remove instantiation of `ReconciliationService`, `AutoReconciliationService`, `SchemaTagService`
- Remove the `dbtSemantic.syncDomainTags` command registration
- Remove any auto-reconciliation wiring in file watcher setup
- Update `SemanticEditorProvider` constructor call to not pass deleted services

### 12.4 Remove Old Webview Components

Delete:
- `webview/components/DiscrepancyReviewDialog/` (entire directory — replaced by new DiscrepancyPanel in Batch D)

---

## Phase 2: Domain Service Changes

### 2.1 Update `src/services/domainService.ts`

**Update `listDomains()`** to scan stage directories:

Current: scans `erd-studio/{layer}/*.json`
New: scans `erd-studio/{stage}/{layer}/*.json` for stages `['conceptual', 'logical']`

```ts
listDomains(projectPath: string, semanticDir = DEFAULT_SEMANTIC_DIR): DomainSummary[] {
  const basePath = path.join(projectPath, semanticDir);
  if (!fs.existsSync(basePath)) return [];

  const summaries: DomainSummary[] = [];
  const layers = this.layerService.getAllLayers();
  const stages: Stage[] = ['conceptual', 'logical'];

  for (const stage of stages) {
    for (const layerConfig of layers) {
      const layer = layerConfig.id;
      const layerDir = path.join(basePath, stage, layer);
      if (!fs.existsSync(layerDir)) continue;

      let entries: string[];
      try {
        entries = fs.readdirSync(layerDir);
      } catch { continue; }

      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        summaries.push({
          domain: path.basename(entry, '.json'),
          layer,
          stage,
          filePath: path.join(layerDir, entry),
        });
      }
    }
  }

  return summaries;
}
```

**Update `getDomain()`** to infer `stage` from the file path:

```ts
getDomain(filePath: string): SemanticDomain {
  // ... existing read + parse logic ...
  // After parsing, infer stage from directory structure:
  // erd-studio/{stage}/{layer}/{domain}.json
  // The stage is the grandparent directory name
}
```

In `validateDomain()`, parse the `stage` field. If not present in the JSON, infer from the grandparent directory name:
```ts
private inferStage(filePath: string): Stage {
  const layerDir = path.dirname(filePath);      // erd-studio/conceptual/silver
  const stageDir = path.dirname(layerDir);       // erd-studio/conceptual
  const stageName = path.basename(stageDir);     // conceptual
  if (stageName === 'conceptual' || stageName === 'logical') return stageName;
  throw new Error(`Cannot infer stage from path: ${filePath}`);
}
```

**Update `parseLayer()`** — the layer is now the parent directory (not grandparent as before since we added the stage level).

**Add `buildPhysicalDomain()` method** (or put it in the editor provider — either location works):

This method takes a logical `SemanticDomain` and `ManifestData`, and returns a `DisplayDomain` where:
1. Each logical model is looked up in the manifest by name
2. Found models get manifest columns (name, data_type, description)
3. Not-found models get `existsInManifest: false` with empty columns
4. Relationships from the logical domain are included (they won't change)
5. `viewConfig.positions` is copied directly from the logical domain
6. `readOnly: true`
7. `stage: 'physical'`
8. No `templates` or `manifestModels` (no editing)

### 2.2 Update Domain Creation

In `src/extension.ts`, update the `dbtSemantic.createDomain` command handler to create files in **both** `conceptual/` and `logical/` directories:

```ts
// Create conceptual file
const conceptualDir = path.join(semanticDir, 'conceptual', layer);
const conceptualPath = path.join(conceptualDir, `${slug}.json`);
// Write JSON with stage: 'conceptual'

// Create logical file
const logicalDir = path.join(semanticDir, 'logical', layer);
const logicalPath = path.join(logicalDir, `${slug}.json`);
// Write JSON with stage: 'logical'
```

Similarly update `dbtSemantic.deleteDomain` to delete both files, and `dbtSemantic.renameDomain` to rename in both directories.

### 2.3 Update Setup Command

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

## Verification

After completing this batch:

1. **Type check**: `npm run compile` — expect errors in files not yet updated (webview components, graph transformer). The goal is that `src/types/` is clean and `src/services/domainService.ts` compiles.

2. **No deleted service references**: `grep -r "ReconciliationService\|AutoReconciliationService\|SchemaTagService" src/` should return nothing (except possibly comments).

3. **New type files exist**: `src/types/display.ts`, `src/types/discrepancy.ts`

4. **Old type file gone**: `src/types/reconciled.ts` should not exist

5. **Deleted service files gone**: `src/services/reconciliationService.ts`, `src/services/autoReconciliationService.ts`, `src/services/schemaTagService.ts`

6. **Tests**: `npm run test` — expect some test failures from deleted services. That's fine for now.

Commit message: `refactor: replace type system with three-stage architecture (Batch A)`
