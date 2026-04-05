# Batch B: Core Services (Phases 3, 8, 7)

## Prerequisites
- Batch A complete (types updated, old services deleted, domain service updated)
- Branch: `feature/three-stage-design`

## Goal
Build the discrepancy service, update the colour system, and update the graph transformer so the webview can render stage-aware data. After this batch the graph transformer accepts `DisplayDomain` and produces React Flow nodes/edges.

## Context

After Batch A:
- `src/types/display.ts` has `DisplayDomain`, `DisplayModel`, `DisplayColumn`, `DisplayRelationship`
- `src/types/discrepancy.ts` has `DiscrepancyReport`, `ModelDiscrepancy`, `ColumnDiscrepancy`, `RelationshipDiscrepancy`
- `src/types/semantic.ts` has simplified `SemanticModel` (no source/approved) and `Stage` type
- Old reconciliation services are deleted
- The webview doesn't compile yet — imports are broken

Read `plan.md` in the project root for full architectural context.

---

## Phase 3: Discrepancy Service

### 3.1 Create `src/services/discrepancyService.ts`

```ts
/**
 * DiscrepancyService — compares two display domains across stages.
 *
 * Produces a DiscrepancyReport showing:
 * - Which models exist in one stage but not the other
 * - Which columns differ (extra, missing, dataType mismatch)
 * - Which relationships differ (extra, missing, cardinality mismatch)
 */

import type { DisplayDomain, DisplayModel } from '../types/display';
import type {
  DiscrepancyReport,
  ModelDiscrepancy,
  ColumnDiscrepancy,
  RelationshipDiscrepancy,
} from '../types/discrepancy';

export class DiscrepancyService {
  /**
   * Compare source domain (the stage being viewed) against
   * target domain (the comparison stage).
   */
  compare(source: DisplayDomain, target: DisplayDomain): DiscrepancyReport {
    const targetModelMap = new Map(target.models.map(m => [m.name, m]));
    const sourceModelMap = new Map(source.models.map(m => [m.name, m]));

    const models: ModelDiscrepancy[] = [];
    let totalColumns = 0, matchedColumns = 0, extraColumns = 0,
        missingColumns = 0, dataTypeMismatches = 0;

    // Check each source model against target
    for (const sourceModel of source.models) {
      const targetModel = targetModelMap.get(sourceModel.name);
      if (!targetModel) {
        // Model in source but not target
        models.push({
          name: sourceModel.name,
          status: 'extra',
          columns: sourceModel.columns.map(c => ({
            name: c.name, status: 'extra' as const,
            sourceDataType: c.dataType,
          })),
        });
        extraColumns += sourceModel.columns.length;
        totalColumns += sourceModel.columns.length;
      } else {
        // Model in both — compare columns
        const colResult = this.compareColumns(sourceModel, targetModel);
        models.push({
          name: sourceModel.name,
          status: 'matched',
          columns: colResult.columns,
        });
        totalColumns += colResult.total;
        matchedColumns += colResult.matched;
        extraColumns += colResult.extra;
        missingColumns += colResult.missing;
        dataTypeMismatches += colResult.typeMismatches;
      }
    }

    // Check for models in target but not source (missing)
    for (const targetModel of target.models) {
      if (!sourceModelMap.has(targetModel.name)) {
        models.push({
          name: targetModel.name,
          status: 'missing',
          columns: targetModel.columns.map(c => ({
            name: c.name, status: 'missing' as const,
            targetDataType: c.dataType,
          })),
        });
        missingColumns += targetModel.columns.length;
        totalColumns += targetModel.columns.length;
      }
    }

    // Compare relationships
    const relationships = this.compareRelationships(source, target);

    return {
      domain: source.domain,
      layer: source.layer,
      sourceStage: source.stage,
      targetStage: target.stage,
      models,
      relationships,
      summary: {
        totalModels: source.models.length + models.filter(m => m.status === 'missing').length,
        matchedModels: models.filter(m => m.status === 'matched').length,
        extraModels: models.filter(m => m.status === 'extra').length,
        missingModels: models.filter(m => m.status === 'missing').length,
        totalColumns,
        matchedColumns,
        extraColumns,
        missingColumns,
        dataTypeMismatches,
      },
    };
  }

  private compareColumns(source: DisplayModel, target: DisplayModel) {
    const targetColMap = new Map(target.columns.map(c => [c.name, c]));
    const sourceColMap = new Map(source.columns.map(c => [c.name, c]));
    const columns: ColumnDiscrepancy[] = [];
    let matched = 0, extra = 0, missing = 0, typeMismatches = 0;

    for (const col of source.columns) {
      const targetCol = targetColMap.get(col.name);
      if (!targetCol) {
        columns.push({ name: col.name, status: 'extra', sourceDataType: col.dataType });
        extra++;
      } else if (col.dataType && targetCol.dataType && col.dataType !== targetCol.dataType) {
        columns.push({
          name: col.name, status: 'type-mismatch',
          sourceDataType: col.dataType, targetDataType: targetCol.dataType,
        });
        typeMismatches++;
      } else {
        columns.push({ name: col.name, status: 'matched' });
        matched++;
      }
    }

    for (const col of target.columns) {
      if (!sourceColMap.has(col.name)) {
        columns.push({ name: col.name, status: 'missing', targetDataType: col.dataType });
        missing++;
      }
    }

    const total = matched + extra + missing + typeMismatches;
    return { columns, total, matched, extra, missing, typeMismatches };
  }

  private compareRelationships(source: DisplayDomain, target: DisplayDomain): RelationshipDiscrepancy[] {
    const relKey = (r: { fromModel: string; fromColumn: string; toModel: string; toColumn: string }) =>
      `${r.fromModel}|${r.fromColumn}|${r.toModel}|${r.toColumn}`;

    const targetRelMap = new Map(target.relationships.map(r => [relKey(r), r]));
    const sourceRelMap = new Map(source.relationships.map(r => [relKey(r), r]));
    const results: RelationshipDiscrepancy[] = [];

    for (const rel of source.relationships) {
      const key = relKey(rel);
      const targetRel = targetRelMap.get(key);
      if (!targetRel) {
        results.push({ ...rel, status: 'extra', sourceCardinality: rel.cardinality });
      } else if (rel.cardinality !== targetRel.cardinality) {
        results.push({
          ...rel, status: 'cardinality-mismatch',
          sourceCardinality: rel.cardinality, targetCardinality: targetRel.cardinality,
        });
      } else {
        results.push({ ...rel, status: 'matched' });
      }
    }

    for (const rel of target.relationships) {
      if (!sourceRelMap.has(relKey(rel))) {
        results.push({ ...rel, status: 'missing', targetCardinality: rel.cardinality });
      }
    }

    return results;
  }
}
```

### 3.2 Write Tests for DiscrepancyService

Create `test/unit/discrepancyService.test.ts` with tests for:
- Two identical domains → all matched, zero discrepancies
- Source has extra model → model shows as 'extra'
- Target has extra model → model shows as 'missing'
- Matched model with extra/missing/mismatched columns
- Relationship extra/missing/cardinality mismatch
- Empty data types (conceptual stage) should not trigger type-mismatch

---

## Phase 8: Colour System Changes

### 8.1 Update `webview/lib/colorPalettes.ts`

Replace the old status-based palette entries with stage-based entries.

Current palette entries: `modelBuilt`, `modelApproved`, `modelDesign`, `modelMissing`
New palette entries: `stageConceptual`, `stageLogical`, `stagePhysical`, `ghost`

Update each palette in `PALETTES`:

```ts
export interface PaletteColors {
  stageConceptual: string;    // Purple/Violet
  stageLogical: string;       // Blue/Teal
  stagePhysical: string;      // Green
  ghost: string;              // Grey (for missing/ghost nodes in discrepancy)
  discrepancyExtra: string;   // Amber
  discrepancyMismatch: string; // Red
}
```

Update `applyPalette()` to set the new CSS custom properties:
```css
--model-conceptual: #8b5cf6;
--model-logical: #3b82f6;
--model-physical: #22c55e;
--model-ghost: #6b7280;
--discrepancy-extra: #f59e0b;
--discrepancy-mismatch: #ef4444;
```

The exact colours can vary per palette, but every palette must define all six entries.

### 8.2 Update `webview/styles/theme.css`

Add CSS custom properties for the new scheme. Remove old status-based properties:

Remove:
```css
--model-built, --model-approved, --model-design, --model-missing
--edge-built, --edge-approved, --edge-design
--column-built, --column-approved, --column-planned, --column-missing
```

Add:
```css
--model-conceptual, --model-logical, --model-physical, --model-ghost
--discrepancy-extra, --discrepancy-mismatch
```

### 8.3 Update CSS in `webview/components/Graph/ModelNode.css`

Replace status-based class selectors:
- `.model-node--built` → Remove
- `.model-node--approved` → Remove
- `.model-node--design` → Remove
- `.model-node--missing` → Remove

Add stage-based selectors:
- `.model-node--conceptual` — uses `var(--model-conceptual)`
- `.model-node--logical` — uses `var(--model-logical)`
- `.model-node--physical` — uses `var(--model-physical)`
- `.model-node--ghost` — uses `var(--model-ghost)`, dashed border, 50% opacity
- `.model-node--read-only` — subtle lock indicator styling

### 8.4 Update CSS in `webview/components/Graph/FkEdge.css`

Replace status-based edge colours with a single stage colour applied dynamically.

---

## Phase 7: Graph Transformer Updates

### 7.1 Update `webview/types/graph.ts`

Replace status-based fields with stage-based fields:

```ts
import type { Stage, ModelRole, Layer } from '../../src/types/semantic';
import type { LayerConfig } from '../../src/types/layer';
import type { ModelDiscrepancy, ColumnDiscrepancy } from '../../src/types/discrepancy';
import type { Cardinality } from '../../src/types/semantic';

export interface ColumnDisplay {
  name: string;
  dataType: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isNaturalKey: boolean;
  scdType?: 0 | 1 | 2;
  additiveType?: 'additive' | 'semi-additive' | 'non-additive';
  /** Discrepancy status when overlay is active. */
  discrepancy?: ColumnDiscrepancy;
}

export interface ModelNodeData {
  modelName: string;
  stage: Stage;
  layer: Layer;
  layerConfig?: LayerConfig;
  columns: ColumnDisplay[];
  readOnly: boolean;
  /** Discrepancy info when overlay is active. */
  discrepancy?: ModelDiscrepancy;
  // Ephemeral UI state (injected by App.tsx)
  dimmed?: boolean;
  isExpanded?: boolean;
  onToggleExpansion?: (modelName: string) => void;
  // Metadata
  hasRationale?: boolean;
  grain?: string;
  modelRole?: ModelRole;
  /** Physical: false means model not in manifest (ghost node). */
  existsInManifest?: boolean;
}

export type ModelFlowNode = Node<ModelNodeData, 'model' | 'conceptual'>;

export interface FkEdgeData {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
  stage: Stage;
  dimmed?: boolean;
  /** Discrepancy status when overlay is active. */
  discrepancy?: 'matched' | 'extra' | 'missing' | 'cardinality-mismatch';
}

export type FkFlowEdge = Edge<FkEdgeData, 'fk'>;
```

### 7.2 Update `webview/lib/graphTransformer.ts`

Change the function signature to accept `DisplayDomain` and optional `DiscrepancyReport`:

```ts
import type { DisplayDomain } from '../../src/types/display';
import type { DiscrepancyReport } from '../../src/types/discrepancy';

export function transformDomain(
  domain: DisplayDomain,
  discrepancyReport?: DiscrepancyReport | null,
): TransformResult {
  // ... build nodes from domain.models
  // ... set node.type = domain.stage === 'conceptual' ? 'conceptual' : 'model'
  // ... set data.stage = domain.stage
  // ... set data.readOnly = domain.readOnly
  // ... if discrepancyReport, inject per-model discrepancy
  // ... if discrepancyReport, add ghost nodes for missing models
  // ... build edges similarly
}
```

Remove all references to old status types (`ModelStatus`, `ColumnStatus`, `RelationshipStatus`).

### 7.3 Update `webview/components/Graph/ModelNode.tsx`

- Replace `status`-based CSS class (e.g., `model-node--built`) with `stage`-based class (e.g., `model-node--logical`)
- Remove approval badge rendering
- Remove discrepancy count badge (old system)
- Add `readOnly` check: when true, hide column drag handles, show lock icon in header
- Add `existsInManifest` check: when false in physical stage, apply ghost styling (`.model-node--ghost`)
- Column rows: remove `status`-based colouring (no more built/planned/approved/missing per column)

### 7.4 Update `webview/components/Graph/FkEdge.tsx`

- Replace `status`-based colouring with `stage`-based colouring
- Remove approval badge
- Edge colour is now determined by `data.stage` not `data.status`

### 7.5 Update `webview/store/editorStore.ts`

- Change `domain` type from old `ReconciledDomain` to `DisplayDomain`
- Add `activeStage: Stage` (default `'logical'`)
- Add `discrepancyReport: DiscrepancyReport | null` (default `null`)
- Add `discrepancyVisible: boolean` (default `false`)
- Add `readOnly: boolean` (default `false`)
- Remove `discrepancyReviewModel` (old system)
- Keep all other UI state (selection, viewport, dialogs, etc.)

### 7.6 Update `webview/App.tsx`

- Update `onMessage` handler: `domainLoaded` payload is now `DisplayDomain`
- Add handler for `stageData` message type (updates domain + activeStage + readOnly)
- Add handler for `discrepancyReport` message type
- Remove `manifestRefreshed` handler
- Register `'conceptual'` node type alongside `'model'` in `nodeTypes`
- Pass `discrepancyReport` to `transformDomain()` when `discrepancyVisible` is true
- Remove `discrepancyReviewModel` / `DiscrepancyReviewDialog` references

---

## Verification

After completing this batch:

1. **Type check**: `npm run compile` — the webview types should now compile. There may still be errors in the editor provider (Batch C).

2. **Discrepancy tests pass**: `npx vitest run test/unit/discrepancyService.test.ts`

3. **Graph transformer accepts DisplayDomain**: Check that `graphTransformer.ts` imports from `display.ts` and uses `DisplayDomain`.

4. **No old status references in webview**: `grep -r "ModelStatus\|ColumnStatus\|RelationshipStatus\|model-node--built\|model-node--approved" webview/` should return nothing.

5. **Build**: `npm run build` — the webview bundle should build. The extension host may have errors in the provider (fixed in Batch C).

Commit message: `feat: add discrepancy service, stage colours, and update graph transformer (Batch B)`
