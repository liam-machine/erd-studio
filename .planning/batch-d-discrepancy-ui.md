# Batch D: Discrepancy Overlay UI (Phase 6)

## Prerequisites
- Batches A, B, C complete
- Extension functionally working with stage switching
- Branch: `feature/three-stage-design`

## Goal
Visual discrepancy overlay on the canvas — when toggled ON, model nodes and edges show column-level differences between the current stage and a comparison stage. Plus a summary panel listing all discrepancies.

## Context

After Batch C:
- Stage switching works (conceptual/logical/physical tabs)
- `DiscrepancyService.compare()` produces a `DiscrepancyReport`
- Toolbar has a discrepancy toggle button
- Extension sends `discrepancyReport` message when toggled ON
- Store has `discrepancyReport` and `discrepancyVisible` state
- `graphTransformer` accepts optional `DiscrepancyReport` parameter

Read `plan.md` in the project root for full architectural context.

---

## Phase 6: Discrepancy Overlay Rendering

### 6.1 Graph Transformer: Inject Discrepancy Data

In `webview/lib/graphTransformer.ts`, when a `discrepancyReport` is provided:

**For existing nodes (models in the current stage):**

```ts
if (discrepancyReport) {
  const modelDisc = discrepancyReport.models.find(m => m.name === model.name);
  if (modelDisc) {
    nodeData.discrepancy = modelDisc;
    // Also inject column-level discrepancies into ColumnDisplay
    nodeData.columns = nodeData.columns.map(col => {
      const colDisc = modelDisc.columns.find(c => c.name === col.name);
      return colDisc ? { ...col, discrepancy: colDisc } : col;
    });
    // Add ghost column rows for "missing" columns (in target but not source)
    const missingCols = modelDisc.columns.filter(c => c.status === 'missing');
    for (const mc of missingCols) {
      nodeData.columns.push({
        name: mc.name,
        dataType: mc.targetDataType ?? '',
        isPrimaryKey: false,
        isForeignKey: false,
        isNaturalKey: false,
        discrepancy: mc,
      });
    }
  }
}
```

**For ghost nodes (models in comparison stage but not current):**

```ts
if (discrepancyReport) {
  for (const modelDisc of discrepancyReport.models) {
    if (modelDisc.status === 'missing') {
      // Create a ghost node using position from comparison domain's viewConfig
      // (The extension should send comparison positions in the report or alongside it)
      nodes.push({
        id: `ghost-${modelDisc.name}`,
        type: 'model',
        position: comparisonPositions[modelDisc.name] ?? DEFAULT_POSITION,
        data: {
          modelName: modelDisc.name,
          stage: domain.stage,
          columns: modelDisc.columns.map(c => ({
            name: c.name,
            dataType: c.targetDataType ?? '',
            isPrimaryKey: false,
            isForeignKey: false,
            isNaturalKey: false,
            discrepancy: c,
          })),
          readOnly: true,
          discrepancy: modelDisc,
          isGhost: true,  // New flag for ghost styling
          ...
        },
      });
    }
  }
}
```

**For edges:**

```ts
if (discrepancyReport) {
  // Mark existing edges with their discrepancy status
  edges = edges.map(edge => {
    const relDisc = discrepancyReport.relationships.find(r =>
      r.fromModel === edge.data.fromModel &&
      r.fromColumn === edge.data.fromColumn &&
      r.toModel === edge.data.toModel &&
      r.toColumn === edge.data.toColumn
    );
    return relDisc
      ? { ...edge, data: { ...edge.data, discrepancy: relDisc.status } }
      : edge;
  });

  // Add ghost edges for missing relationships
  for (const relDisc of discrepancyReport.relationships) {
    if (relDisc.status === 'missing') {
      edges.push({
        id: `ghost-fk-${relDisc.fromModel}-${relDisc.fromColumn}-${relDisc.toModel}-${relDisc.toColumn}`,
        type: 'fk',
        source: relDisc.fromModel,
        target: relDisc.toModel,
        // ... ghost edge data with discrepancy: 'missing'
      });
    }
  }
}
```

### 6.2 ModelNode: Column Discrepancy Rendering

In `webview/components/Graph/ModelNode.tsx`, update column row rendering:

```tsx
function ColumnRow({ col }: { col: ColumnDisplay }) {
  const disc = col.discrepancy;

  let className = 'model-node__column';
  if (disc?.status === 'extra') className += ' model-node__column--disc-extra';
  if (disc?.status === 'missing') className += ' model-node__column--disc-missing';
  if (disc?.status === 'type-mismatch') className += ' model-node__column--disc-mismatch';

  return (
    <div className={className}>
      <span className="model-node__column-name">{col.name}</span>
      <span className="model-node__column-type">
        {disc?.status === 'type-mismatch' ? (
          <>
            <span className="model-node__type-old">{disc.sourceDataType}</span>
            <span className="model-node__type-arrow"> → </span>
            <span className="model-node__type-new">{disc.targetDataType}</span>
          </>
        ) : (
          col.dataType
        )}
      </span>
      {disc && disc.status !== 'matched' && (
        <span className={`model-node__disc-badge model-node__disc-badge--${disc.status}`}>
          {disc.status === 'extra' ? '+' : disc.status === 'missing' ? '−' : '≠'}
        </span>
      )}
    </div>
  );
}
```

### 6.3 ModelNode: Model-Level Discrepancy Border

```tsx
// In ModelNode component:
const discStatus = data.discrepancy?.status;
const isGhost = data.isGhost;

let nodeClassName = `model-node model-node--${data.stage}`;
if (discStatus === 'extra') nodeClassName += ' model-node--disc-extra';
if (isGhost) nodeClassName += ' model-node--ghost';
if (data.dimmed) nodeClassName += ' model-node--dimmed';
```

### 6.4 CSS for Discrepancy Indicators

Add to `webview/components/Graph/ModelNode.css`:

```css
/* Model-level discrepancy */
.model-node--disc-extra {
  box-shadow: 0 0 0 2px var(--discrepancy-extra);
}

.model-node--ghost {
  opacity: 0.5;
  border-style: dashed;
}

/* Column-level discrepancy */
.model-node__column--disc-extra {
  background-color: rgba(var(--discrepancy-extra-rgb), 0.15);
}

.model-node__column--disc-missing {
  opacity: 0.5;
  text-decoration: line-through;
  font-style: italic;
}

.model-node__column--disc-mismatch {
  background-color: rgba(var(--discrepancy-mismatch-rgb), 0.1);
}

.model-node__type-old {
  text-decoration: line-through;
  opacity: 0.6;
}

.model-node__type-arrow {
  color: var(--discrepancy-mismatch);
  font-weight: 600;
}

.model-node__type-new {
  color: var(--discrepancy-mismatch);
  font-weight: 600;
}

.model-node__disc-badge {
  font-size: 10px;
  padding: 0 4px;
  border-radius: 3px;
  font-weight: 600;
}

.model-node__disc-badge--extra {
  background: var(--discrepancy-extra);
  color: #000;
}

.model-node__disc-badge--missing {
  background: var(--model-ghost);
  color: #fff;
}

.model-node__disc-badge--type-mismatch {
  background: var(--discrepancy-mismatch);
  color: #fff;
}
```

### 6.5 FkEdge: Discrepancy Styling

In `webview/components/Graph/FkEdge.tsx`:

```tsx
const discStatus = data.discrepancy;

let strokeClass = `fk-edge fk-edge--${data.stage}`;
if (discStatus === 'extra') strokeClass += ' fk-edge--disc-extra';
if (discStatus === 'missing') strokeClass += ' fk-edge--disc-ghost';
if (discStatus === 'cardinality-mismatch') strokeClass += ' fk-edge--disc-mismatch';
```

Add CSS:
```css
.fk-edge--disc-extra {
  stroke: var(--discrepancy-extra);
  stroke-dasharray: 8 4;
}

.fk-edge--disc-ghost {
  stroke: var(--model-ghost);
  stroke-dasharray: 4 4;
  opacity: 0.5;
}

.fk-edge--disc-mismatch {
  stroke: var(--discrepancy-mismatch);
}
```

### 6.6 Create Discrepancy Summary Panel

Create `webview/components/DiscrepancyPanel/DiscrepancyPanel.tsx`:

A collapsible panel (similar to Legend or DetailPanel) that shows the full report:

```tsx
export function DiscrepancyPanel() {
  const discrepancyReport = useEditorStore(s => s.discrepancyReport);
  const discrepancyVisible = useEditorStore(s => s.discrepancyVisible);

  if (!discrepancyVisible || !discrepancyReport) return null;

  const { summary, models, sourceStage, targetStage } = discrepancyReport;

  return (
    <Panel position="bottom-left" className="discrepancy-panel">
      <div className="discrepancy-panel__header">
        <span>{capitalize(sourceStage)} vs {capitalize(targetStage)}</span>
      </div>

      <div className="discrepancy-panel__summary">
        <div>Models: {summary.matchedModels} matched, {summary.extraModels} extra, {summary.missingModels} missing</div>
        <div>Columns: {summary.matchedColumns} matched, {summary.extraColumns} extra, {summary.missingColumns} missing, {summary.dataTypeMismatches} type mismatches</div>
      </div>

      <div className="discrepancy-panel__models">
        {models.filter(m => m.status !== 'matched' || m.columns.some(c => c.status !== 'matched')).map(model => (
          <DiscrepancyModelItem key={model.name} model={model} />
        ))}
      </div>
    </Panel>
  );
}

function DiscrepancyModelItem({ model }: { model: ModelDiscrepancy }) {
  const [expanded, setExpanded] = useState(false);
  const hasColumnIssues = model.columns.some(c => c.status !== 'matched');

  return (
    <div className="discrepancy-panel__model">
      <button
        className="discrepancy-panel__model-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`discrepancy-panel__status discrepancy-panel__status--${model.status}`}>
          {model.status === 'extra' ? '+' : model.status === 'missing' ? '−' : '○'}
        </span>
        <span>{model.name}</span>
        {hasColumnIssues && <span className="discrepancy-panel__col-count">
          ({model.columns.filter(c => c.status !== 'matched').length} issues)
        </span>}
      </button>

      {expanded && (
        <div className="discrepancy-panel__columns">
          {model.columns.filter(c => c.status !== 'matched').map(col => (
            <div key={col.name} className={`discrepancy-panel__col discrepancy-panel__col--${col.status}`}>
              {col.status === 'extra' && <span>+ {col.name} ({col.sourceDataType})</span>}
              {col.status === 'missing' && <span>− {col.name} ({col.targetDataType})</span>}
              {col.status === 'type-mismatch' && (
                <span>{col.name}: {col.sourceDataType} → {col.targetDataType}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

Create `webview/components/DiscrepancyPanel/DiscrepancyPanel.css` with styling.

### 6.7 Wire DiscrepancyPanel into App.tsx

Import and add `<DiscrepancyPanel />` alongside the other panels in `EditorCanvas`.

### 6.8 Extension: Send Comparison Positions

When the extension sends a `discrepancyReport`, it should also include the comparison domain's positions so ghost nodes can be placed correctly.

Option A: Include positions in the report itself (add `comparisonPositions` field to `DiscrepancyReport`)
Option B: Send them as part of the `discrepancyReport` message payload alongside the report

Recommend Option A — extend `DiscrepancyReport`:
```ts
export interface DiscrepancyReport {
  // ... existing fields
  /** Positions from the comparison domain for placing ghost nodes. */
  comparisonPositions?: Record<string, { x: number; y: number }>;
}
```

---

## Verification

After completing this batch:

1. **Build**: `npm run build` — clean build

2. **Manual test**:
   - Open a logical domain with some models
   - Create a corresponding physical view (need a dbt manifest with some of the same models)
   - Switch to physical stage
   - Toggle "Compare to Logical" — should see:
     - Columns in physical but not logical highlighted amber
     - Columns in logical but not physical shown as grey strikethrough ghost rows
     - Data type differences shown with `old → new` format
     - Summary panel at bottom-left with counts
   - Toggle OFF — all discrepancy indicators disappear
   - Switch to logical stage
   - Toggle "Compare to Conceptual" — should see entity-level differences

3. **Edge cases**:
   - Empty domain (no models) — discrepancy should show all as missing
   - All models matched, all columns matched — summary shows clean state
   - Ghost nodes from missing models positioned correctly

Commit message: `feat: add discrepancy overlay UI with column-level comparison (Batch D)`
