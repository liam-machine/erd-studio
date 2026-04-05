# Batch C: Editor Provider + Toolbar (Phases 4, 5)

## Prerequisites
- Batch A complete (types, code removal, domain service)
- Batch B complete (discrepancy service, colours, graph transformer)
- Branch: `feature/three-stage-design`

## Goal
Wire up stage switching in the editor provider and toolbar. Physical stage renders as read-only with edit tools disabled. After this batch the extension is **functionally working** — you can open a domain, switch between stages, and see data rendered per stage.

## Context

After Batch B:
- `DisplayDomain` types are in place
- `DiscrepancyService` is built and tested
- `graphTransformer` accepts `DisplayDomain` and renders stage-aware nodes
- The editor provider (`SemanticEditorProvider`) still has broken code from the removal of old services

Read `plan.md` in the project root for full architectural context.

---

## Phase 4: Editor Provider & Stage Switching

### 4.1 Update `SemanticEditorProvider` Constructor

Remove deleted service parameters. The constructor should now take:
```ts
constructor(
  private readonly context: vscode.ExtensionContext,
  private readonly domainService: DomainService,
  private readonly manifestService: ManifestService,
  private readonly templateService: TemplateService,
  private readonly discrepancyService: DiscrepancyService,  // NEW (replaces reconciliation)
  private readonly layerService: LayerService,
  private readonly workspaceRoot: string,
)
```

### 4.2 Add Stage Tracking

Add state tracking for which stage is active per open editor:

```ts
/** Track active stage per document URI. */
private readonly activeStages = new Map<string, Stage>();
```

### 4.3 Update `sendDomainData()`

This method currently reconciles domain + manifest. Replace with stage-aware data building:

```ts
private async sendDomainData(
  document: vscode.TextDocument,
  webview: vscode.Webview,
): Promise<void> {
  try {
    const domain = this.domainService.getDomain(document.uri.fsPath);
    const panelKey = document.uri.toString();
    const activeStage = this.activeStages.get(panelKey) ?? domain.stage;

    let displayDomain: DisplayDomain;

    if (activeStage === 'physical') {
      // Physical: derive from manifest using logical domain's model list
      const logicalPath = this.getLogicalPath(document.uri.fsPath, domain);
      const logicalDomain = this.domainService.getDomain(logicalPath);
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      displayDomain = this.domainService.buildPhysicalDomain(logicalDomain, manifest);
    } else {
      // Conceptual or Logical: convert SemanticDomain → DisplayDomain directly
      displayDomain = this.buildDisplayDomain(domain, activeStage);
    }

    // Add templates and manifest models for editable stages
    if (!displayDomain.readOnly) {
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const { templates, manifestModels } = this.buildWebviewPayload(
        displayDomain, manifest, domain.modelFolder,
      );
      displayDomain.templates = templates;
      displayDomain.manifestModels = manifestModels;
    }

    // Add layer config
    displayDomain.layerConfig = this.layerService.getLayer(domain.layer) ?? undefined;

    webview.postMessage({ type: 'domainLoaded', payload: displayDomain });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    webview.postMessage({ type: 'error', payload: { message } });
  }
}
```

### 4.4 Add Helper: `buildDisplayDomain()`

Converts a `SemanticDomain` (from JSON) to a `DisplayDomain` (for webview):

```ts
private buildDisplayDomain(domain: SemanticDomain, stage: Stage): DisplayDomain {
  return {
    schemaVersion: domain.schemaVersion,
    domain: domain.domain,
    layer: domain.layer,
    stage,
    description: domain.description,
    modelFolder: domain.modelFolder,
    models: domain.models.map(m => ({
      name: m.name,
      schema: m.schema ?? '',
      description: m.description ?? '',
      columns: (m.columns ?? []).map(c => ({
        name: c.name,
        dataType: c.dataType,
        description: c.description,
        isPrimaryKey: c.isPrimaryKey ?? false,
        isForeignKey: c.isForeignKey ?? false,
        isNaturalKey: c.isNaturalKey ?? false,
        ...(c.scdType != null ? { scdType: c.scdType } : {}),
        ...(c.additiveType ? { additiveType: c.additiveType } : {}),
      })),
      ...(m.rationale ? { rationale: m.rationale } : {}),
      ...(m.grain ? { grain: m.grain } : {}),
      ...(m.modelRole ? { modelRole: m.modelRole } : {}),
    })),
    relationships: domain.relationships.map(r => ({
      fromModel: r.fromModel,
      fromColumn: r.fromColumn,
      toModel: r.toModel,
      toColumn: r.toColumn,
      cardinality: r.cardinality,
    })),
    viewConfig: domain.viewConfig,
    readOnly: false,
  };
}
```

### 4.5 Add Helper: `getLogicalPath()`

Given any domain file path, returns the logical stage path for the same domain:

```ts
private getLogicalPath(currentPath: string, domain: SemanticDomain): string {
  // currentPath: .../erd-studio/conceptual/silver/orders.json
  // returns:     .../erd-studio/logical/silver/orders.json
  const fileName = path.basename(currentPath);
  const semanticDir = this.getSetting('semanticDir') ?? 'erd-studio';
  return path.join(this.workspaceRoot, semanticDir, 'logical', domain.layer, fileName);
}
```

### 4.6 Handle `switchStage` Message

Add a new case in the message switch:

```ts
case 'switchStage': {
  const payload = (message as { payload?: { stage: Stage } }).payload;
  if (payload) {
    const panelKey = document.uri.toString();
    this.activeStages.set(panelKey, payload.stage);

    if (payload.stage === 'physical') {
      // Build physical domain from manifest + logical model list
      await this.sendPhysicalData(document, webviewPanel.webview);
    } else {
      // Read the corresponding stage file
      await this.sendStageData(document, webviewPanel.webview, payload.stage);
    }
  }
  break;
}
```

Implement `sendStageData()` — reads `erd-studio/{stage}/{layer}/{domain}.json` and sends `stageData` message.

Implement `sendPhysicalData()` — builds physical domain from manifest + logical domain's model list, sends `stageData` message with `readOnly: true`.

### 4.7 Handle `toggleDiscrepancy` Message

```ts
case 'toggleDiscrepancy': {
  const payload = (message as { payload?: { enabled: boolean; compareAgainst?: Stage } }).payload;
  if (payload) {
    if (payload.enabled && payload.compareAgainst) {
      const report = await this.buildDiscrepancyReport(
        document, payload.compareAgainst,
      );
      webviewPanel.webview.postMessage({
        type: 'discrepancyReport', payload: report,
      });
    } else {
      webviewPanel.webview.postMessage({
        type: 'discrepancyReport', payload: null,
      });
    }
  }
  break;
}
```

Implement `buildDiscrepancyReport()` — loads both stages' data as `DisplayDomain`, calls `discrepancyService.compare()`.

### 4.8 Edit Guard for Physical Stage

At the top of each mutation handler (addModel, addColumn, removeColumn, etc.), add a guard:

```ts
const panelKey = document.uri.toString();
const activeStage = this.activeStages.get(panelKey);
if (activeStage === 'physical') {
  // Physical is read-only — reject mutations silently
  return;
}
```

### 4.9 Document Routing for Stage Switching

When the active stage changes to conceptual or logical, mutations need to write to the correct file. The current `applyDomainEdit()` writes to `document` (the file that was opened). When the user switches stages, we need to track which document is the current write target.

Add a `stageDocuments` map that tracks the TextDocument per stage:

```ts
private readonly stageDocuments = new Map<string, Map<Stage, vscode.TextDocument>>();
```

When switching stages, open the corresponding file silently (not in editor) and use it as the write target.

### 4.10 Update `extension.ts`

Update the `SemanticEditorProvider` instantiation to pass `DiscrepancyService` instead of old services:

```ts
const discrepancyService = new DiscrepancyService();
const provider = new SemanticEditorProvider(
  context,
  domainService,
  manifestService,
  templateService,
  discrepancyService,
  layerService,
  workspaceRoot,
);
```

---

## Phase 5: Toolbar & Read-Only Mode

### 5.1 Create `webview/components/Toolbar/StageTabs.tsx`

```tsx
interface StageTabsProps {
  activeStage: Stage;
  onStageChange: (stage: Stage) => void;
  readOnly: boolean;
}

export function StageTabs({ activeStage, onStageChange, readOnly }: StageTabsProps) {
  const stages: { id: Stage; label: string }[] = [
    { id: 'conceptual', label: 'Conceptual' },
    { id: 'logical', label: 'Logical' },
    { id: 'physical', label: 'Physical' },
  ];

  return (
    <div className="stage-tabs">
      {stages.map(s => (
        <button
          key={s.id}
          className={`stage-tabs__tab ${activeStage === s.id ? 'stage-tabs__tab--active' : ''}`}
          onClick={() => onStageChange(s.id)}
        >
          {s.label}
          {s.id === 'physical' && <span className="stage-tabs__lock" title="Read-only">🔒</span>}
        </button>
      ))}
      {readOnly && <span className="stage-tabs__read-only-badge">Read-only</span>}
    </div>
  );
}
```

Create `webview/components/Toolbar/StageTabs.css` with appropriate styling.

### 5.2 Update `webview/components/Toolbar/Toolbar.tsx`

**Add stage tabs** between domain info and zoom controls.

**Add discrepancy toggle** — a button that appears when not in conceptual stage.

**Conditionally hide/disable controls based on `readOnly`:**

```tsx
// Get readOnly from store
const readOnly = useEditorStore((s) => s.readOnly);
const activeStage = useEditorStore((s) => s.activeStage);

// In render:
return (
  <Panel position="top-center" className="toolbar">
    {/* Domain info */}
    <div className="toolbar__section toolbar__domain">...</div>
    <div className="toolbar__divider" />

    {/* Stage tabs — NEW */}
    <StageTabs
      activeStage={activeStage}
      onStageChange={handleStageChange}
      readOnly={readOnly}
    />
    <div className="toolbar__divider" />

    {/* Zoom controls — always visible */}
    <div className="toolbar__section toolbar__zoom">...</div>
    <div className="toolbar__divider" />

    {/* Undo/Redo — HIDDEN when readOnly */}
    {!readOnly && (
      <>
        <div className="toolbar__section toolbar__undo-redo">...</div>
        <div className="toolbar__divider" />
      </>
    )}

    {/* Auto Layout — DISABLED when readOnly */}
    <div className="toolbar__section">
      <button disabled={readOnly || isLayouting || nodes.length === 0} ...>
      {/* Refresh Manifest — always visible, useful for physical */}
      <button ...>↻</button>
    </div>

    {/* Search — always visible */}
    <div className="toolbar__section toolbar__search">...</div>
    <div className="toolbar__divider" />

    {/* Column Expansion — always visible */}
    ...

    {/* Palette — always visible */}
    ...

    {/* Discrepancy toggle — visible when not conceptual stage */}
    {activeStage !== 'conceptual' && (
      <DiscrepancyToggle activeStage={activeStage} />
    )}

    {/* Add dropdown — HIDDEN when readOnly */}
    {!readOnly && (
      <>
        <div className="toolbar__divider" />
        <div className="toolbar__section">
          <div className="toolbar__dropdown" ref={modelDropdownRef}>...</div>
        </div>
      </>
    )}
  </Panel>
);
```

**Add `handleStageChange`:**

```ts
const handleStageChange = useCallback((stage: Stage) => {
  const message: WebviewMessage = { type: 'switchStage', payload: { stage } };
  vscode.postMessage(message);
}, [vscode]);
```

### 5.3 Create Discrepancy Toggle Component

A small inline component in the toolbar for toggling discrepancy overlay:

```tsx
function DiscrepancyToggle({ activeStage }: { activeStage: Stage }) {
  const discrepancyVisible = useEditorStore(s => s.discrepancyVisible);
  const setDiscrepancyVisible = useEditorStore(s => s.setDiscrepancyVisible);
  const vscode = useVsCodeApi();

  const options = activeStage === 'logical'
    ? [{ label: 'vs Physical', stage: 'physical' }, { label: 'vs Conceptual', stage: 'conceptual' }]
    : activeStage === 'physical'
    ? [{ label: 'vs Logical', stage: 'logical' }]
    : [{ label: 'vs Logical', stage: 'logical' }];

  const handleToggle = (compareAgainst: Stage) => {
    const newState = !discrepancyVisible;
    setDiscrepancyVisible(newState);
    vscode.postMessage({
      type: 'toggleDiscrepancy',
      payload: { enabled: newState, compareAgainst },
    });
  };

  // Render toggle button(s)
  ...
}
```

### 5.4 Update Detail Panel for Read-Only Mode

In `webview/components/DetailPanel/DetailPanel.tsx`:

- Read `readOnly` from the store
- When `readOnly === true`:
  - Hide rename button
  - Hide add column button
  - Hide remove column buttons
  - Hide edit column inline controls
  - Hide remove model button
  - Hide add/remove relationship buttons
  - Hide all approval-related UI (already removed in Batch A types, but clean up any residual UI)
  - Show columns as a simple read-only table

### 5.5 Update Canvas Interactions for Read-Only

In `webview/App.tsx`:

- When `readOnly === true`:
  - Disable node dragging: pass `nodesDraggable={!readOnly}` to `<ReactFlow>`
  - Disable column drag-to-connect: check `readOnly` before dispatching custom events
  - Disable Delete/Backspace key handling
  - Disable right-click edit options in context menu

### 5.6 Add Keyboard Shortcuts for Stage Switching

In the keyboard handler in `App.tsx`:

```ts
// Alt+1/2/3: Switch stages
if (e.altKey && e.key === '1') { handleStageChange('conceptual'); return; }
if (e.altKey && e.key === '2') { handleStageChange('logical'); return; }
if (e.altKey && e.key === '3') { handleStageChange('physical'); return; }
```

### 5.7 Update Store Actions

Add to `editorStore.ts`:

```ts
setActiveStage: (stage: Stage) => void;
setReadOnly: (readOnly: boolean) => void;
setDiscrepancyVisible: (visible: boolean) => void;
setDiscrepancyReport: (report: DiscrepancyReport | null) => void;
```

Update `onMessage` in `App.tsx` to handle `stageData`:

```ts
case 'stageData':
  setDomain(msg.payload);
  setActiveStage(msg.payload.stage);
  setReadOnly(msg.payload.readOnly);
  if (msg.payload.templates) setTemplates(msg.payload.templates);
  if (msg.payload.manifestModels) setManifestModels(msg.payload.manifestModels);
  break;

case 'discrepancyReport':
  setDiscrepancyReport(msg.payload);
  break;
```

---

## Verification

After completing this batch:

1. **Full build**: `npm run build` — both extension and webview should compile and bundle

2. **Type check**: `npm run compile` — zero errors

3. **Manual test** (in VS Code):
   - Create the directory structure: `erd-studio/conceptual/silver/` and `erd-studio/logical/silver/`
   - Create a test domain JSON in both directories with `stage` field
   - Open the logical file — canvas should render
   - Click stage tabs — should switch between stages
   - Physical tab — should show read-only view with manifest data (or empty if no manifest)
   - "+ Add" should be hidden in physical view
   - Undo/Redo should be hidden in physical view
   - Node dragging should be disabled in physical view

4. **Tests**: `npm run test` — existing tests may need updating for new types

Commit message: `feat: add stage switching, physical read-only mode, and toolbar tabs (Batch C)`
