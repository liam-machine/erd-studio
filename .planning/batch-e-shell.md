# Batch E: Sidebar, Commands, Watchers (Phases 9, 10, 11)

## Prerequisites
- Batches A–D complete
- Extension fully functional with stage switching and discrepancy overlay
- Branch: `feature/three-stage-design`

## Goal
Update the sidebar tree with stage toggle, update commands for dual-directory operations, and fix file watchers for the new directory structure. After this batch the extension is **release-ready**.

## Context

After Batch D:
- Stage switching works in the editor (toolbar tabs)
- Discrepancy overlay renders column-level diffs
- Physical stage is read-only
- But the sidebar tree still uses the old flat directory structure
- Commands (create, delete, rename) still target old paths
- File watchers still watch old paths

Read `plan.md` in the project root for full architectural context.

---

## Phase 9: Sidebar Tree Changes

### 9.1 Update `DomainTreeProvider`

**Add stage state:**

```ts
export class DomainTreeProvider {
  private currentStage: Stage = 'logical';  // default to logical

  setStage(stage: Stage): void {
    this.currentStage = stage;
    this.refresh();
  }

  getStage(): Stage {
    return this.currentStage;
  }
}
```

**Update `getChildren()` for root level:**

When returning root-level children (layers), the tree reads from `erd-studio/{currentStage}/{layer}/`:

```ts
getChildren(element?: TreeElement): TreeElement[] | undefined {
  if (!element) {
    const stage = this.currentStage;
    // For physical, list domains from logical (physical mirrors logical's model list)
    const effectiveStage = stage === 'physical' ? 'logical' : stage;
    const fullSemanticDir = path.join(this.projectPath, this.semanticDir, effectiveStage);
    if (!fs.existsSync(fullSemanticDir)) return [];

    const layers = this.layerService.getAllLayers();
    return layers.map((lc): LayerNode => ({ type: 'layer', layer: lc.id }));
  }
  // ... rest unchanged
}
```

**Update `getLayerChildren()`:**

```ts
private getLayerChildren(layer: Layer): TreeElement[] {
  const effectiveStage = this.currentStage === 'physical' ? 'logical' : this.currentStage;
  const summaries = this.domainService.listDomains(this.projectPath, this.semanticDir);
  const layerDomains = summaries.filter(s => s.layer === layer && s.stage === effectiveStage);
  // ... rest similar to current, create DomainNode items
}
```

**"New Domain..." visibility:**

Only show "New Domain..." when `currentStage` is `conceptual` or `logical` (not `physical`):

```ts
if (this.currentStage !== 'physical' && this.layerService.isCreatable(layer)) {
  children.push({ type: 'newDomain', layer });
}
```

**Domain descriptions:**

Currently shows "4 models, 2 designs". Since there's no more design distinction, simplify to just "4 models" (or "4 entities" for conceptual stage):

```ts
const unit = this.currentStage === 'conceptual' ? 'entity' : 'model';
const plural = modelCount === 1 ? unit : `${unit}s`;
item.description = `${modelCount} ${plural}`;
```

### 9.2 Add Stage Toggle to Sidebar

VS Code tree views don't natively support tabs at the top. Options:

**Option A: Use view actions (toolbar icons at top of sidebar):**

In `package.json`, add view/title commands:
```json
"view/title": [
  {
    "command": "dbtSemantic.switchTreeStageConceptual",
    "when": "view == dbtSemantic.domainTree",
    "group": "navigation@1"
  },
  {
    "command": "dbtSemantic.switchTreeStageLogical",
    "when": "view == dbtSemantic.domainTree",
    "group": "navigation@2"
  },
  {
    "command": "dbtSemantic.switchTreeStagePhysical",
    "when": "view == dbtSemantic.domainTree",
    "group": "navigation@3"
  }
]
```

Register three commands that call `treeProvider.setStage('conceptual' | 'logical' | 'physical')`.

Use a context key to highlight the active stage:
```ts
vscode.commands.executeCommand('setContext', 'dbtSemantic.treeStage', stage);
```

And conditionally set icons:
```json
{
  "command": "dbtSemantic.switchTreeStageLogical",
  "title": "Logical",
  "icon": "$(symbol-class)"
}
```

**Option B: Use a QuickPick dropdown:**

A single button that opens a QuickPick to select the stage. Simpler but requires an extra click.

Recommend **Option A** — three icon buttons at the top of the tree view.

### 9.3 Open Domain with Stage Context

When clicking a domain in the sidebar, it should open in the editor at the sidebar's current stage:

```ts
item.command = {
  command: 'dbtSemantic.openDomain',
  title: 'Open Domain',
  arguments: [element.summary.filePath, this.currentStage],
};
```

Update `dbtSemantic.openDomain` handler to accept an optional stage parameter and set it as the initial active stage in the editor provider.

---

## Phase 10: Command Updates

### 10.1 `dbtSemantic.createDomain`

Update to create files in **both** `conceptual/` and `logical/` directories:

```ts
// After getting slug, layer, description from user:

const semanticDir = getSetting('semanticDir') ?? 'erd-studio';

for (const stage of ['conceptual', 'logical'] as const) {
  const dir = path.join(workspaceRoot, semanticDir, stage, layer);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filePath = path.join(dir, `${slug}.json`);
  const content = JSON.stringify({
    schemaVersion: 2,
    domain: slug,
    layer,
    stage,
    description,
    ...(modelFolder ? { modelFolder } : {}),
    models: [],
    relationships: [],
    viewConfig: {},
  }, null, 2);

  fs.writeFileSync(filePath, content, { flag: 'wx' });
}

// Open the logical file by default
const logicalPath = path.join(workspaceRoot, semanticDir, 'logical', layer, `${slug}.json`);
// open in custom editor...
```

### 10.2 `dbtSemantic.deleteDomain`

Update to delete files in **both** directories:

```ts
// Get the domain name and layer from the selected tree item
const domain = summary.domain;
const layer = summary.layer;
const semanticDir = getSetting('semanticDir') ?? 'erd-studio';

for (const stage of ['conceptual', 'logical'] as const) {
  const filePath = path.join(workspaceRoot, semanticDir, stage, layer, `${domain}.json`);
  if (fs.existsSync(filePath)) {
    await vscode.workspace.fs.delete(vscode.Uri.file(filePath));
  }
}
```

Make sure to close any open editor tabs for both files before deleting.

### 10.3 `dbtSemantic.renameDomain`

Update to rename in **both** directories:

```ts
const oldName = summary.domain;
const newName = /* validated new slug */;
const semanticDir = getSetting('semanticDir') ?? 'erd-studio';
const edit = new vscode.WorkspaceEdit();

for (const stage of ['conceptual', 'logical'] as const) {
  const oldPath = path.join(workspaceRoot, semanticDir, stage, layer, `${oldName}.json`);
  const newPath = path.join(workspaceRoot, semanticDir, stage, layer, `${newName}.json`);

  if (fs.existsSync(oldPath)) {
    // Read, update domain name, write to new path, delete old
    const content = JSON.parse(fs.readFileSync(oldPath, 'utf-8'));
    content.domain = newName;
    edit.createFile(vscode.Uri.file(newPath));
    edit.insert(vscode.Uri.file(newPath), new vscode.Position(0, 0), JSON.stringify(content, null, 2));
    edit.deleteFile(vscode.Uri.file(oldPath));
  }
}

await vscode.workspace.applyEdit(edit);
```

### 10.4 Remove `dbtSemantic.syncDomainTags`

If not already removed in Batch A, remove this command registration and handler. It was part of the approval/reconciliation workflow.

### 10.5 Update `dbtSemantic.refreshManifest`

Keep the command but simplify its role:
- Invalidate manifest cache
- Reload manifest
- If any open editor is showing the physical stage, resend physical data to that webview

### 10.6 Register New Commands

Add to `package.json` and `extension.ts`:
- `dbtSemantic.switchTreeStageConceptual` — sets tree to conceptual view
- `dbtSemantic.switchTreeStageLogical` — sets tree to logical view
- `dbtSemantic.switchTreeStagePhysical` — sets tree to physical view

### 10.7 Update `package.json` Custom Editor Selector

Change the custom editor activation pattern:

```json
"customEditors": [
  {
    "viewType": "dbtSemantic.domainEditor",
    "displayName": "ERD Studio",
    "selector": [
      { "filenamePattern": "**/erd-studio/conceptual/**/*.json" },
      { "filenamePattern": "**/erd-studio/logical/**/*.json" }
    ]
  }
]
```

### 10.8 Update `package.json` — Remove `autoReconcile` Setting

Remove from `contributes.configuration`:
```json
"dbtSemantic.autoReconcile": { ... }
```

### 10.9 Update `dbtSemantic.setupSemanticDirectory`

Create the new directory structure:

```ts
const semanticDir = getSetting('semanticDir') ?? 'erd-studio';
const basePath = path.join(workspaceRoot, semanticDir);
const layers = layerService.getAllLayers();

for (const stage of ['conceptual', 'logical']) {
  for (const layer of layers) {
    const dir = path.join(basePath, stage, layer.id);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// layers.json and templates/ stay at basePath level (unchanged)
```

### 10.10 Update Layer Add/Remove Commands

When a layer is added, create directories in both `conceptual/` and `logical/`:
```ts
for (const stage of ['conceptual', 'logical']) {
  fs.mkdirSync(path.join(basePath, stage, newLayerId), { recursive: true });
}
```

When a layer is removed, delete directories in both stages:
```ts
for (const stage of ['conceptual', 'logical']) {
  const dir = path.join(basePath, stage, layerId);
  if (fs.existsSync(dir)) {
    await vscode.workspace.fs.delete(vscode.Uri.file(dir), { recursive: true });
  }
}
```

---

## Phase 11: File Watcher Changes

### 11.1 Update Domain File Watchers

In `src/watchers/FileWatcherService.ts` (or wherever watchers are configured):

Change the domain file watcher glob from:
```
**/erd-studio/**/*.json
```
to:
```
**/erd-studio/{conceptual,logical}/**/*.json
```

Or use two separate watchers:
```ts
const conceptualWatcher = vscode.workspace.createFileSystemWatcher(
  new vscode.RelativePattern(workspaceRoot, `${semanticDir}/conceptual/**/*.json`)
);
const logicalWatcher = vscode.workspace.createFileSystemWatcher(
  new vscode.RelativePattern(workspaceRoot, `${semanticDir}/logical/**/*.json`)
);
```

Both trigger a tree refresh on change/create/delete.

### 11.2 Update Manifest Watcher

Keep the manifest watcher (`target/manifest.json`) but simplify its callback:

```ts
manifestWatcher.onDidChange(async () => {
  // Invalidate manifest cache
  manifestService.invalidate();

  // Refresh any open editors showing physical stage
  for (const [panelKey, panel] of provider.openPanels) {
    const activeStage = provider.getActiveStage(panelKey);
    if (activeStage === 'physical') {
      await provider.sendPhysicalData(panel.document, panel.webview);
    }
  }
});
```

Remove:
- Auto-reconciliation logic (design→built detection)
- Schema tag syncing on manifest change

### 11.3 Layers.json Watcher

Keep the layers.json watcher unchanged — it still refreshes the tree and layer decorations.

---

## Verification

After completing this batch:

1. **Full build**: `npm run build` — clean build

2. **Type check**: `npm run compile` — zero errors

3. **Tests**: `npm run test` — all tests pass (update/create tests as needed)

4. **Manual test — sidebar**:
   - Stage toggle buttons appear at top of tree view
   - Clicking each shows domains for that stage
   - "New Domain..." only appears in conceptual/logical, not physical
   - Domain count badges show correctly

5. **Manual test — create domain**:
   - Creates files in both `erd-studio/conceptual/{layer}/` and `erd-studio/logical/{layer}/`
   - Both files have correct `stage` field
   - Opens in editor at logical stage by default

6. **Manual test — delete domain**:
   - Deletes from both conceptual and logical directories
   - Editor tabs close

7. **Manual test — rename domain**:
   - Renames in both directories
   - JSON `domain` field updated in both files

8. **Manual test — file watcher**:
   - Edit a domain JSON externally → editor refreshes
   - Run `dbt compile` to update manifest → physical view refreshes

9. **Manual test — layer management**:
   - Add a new layer → directories created in both conceptual/ and logical/
   - Remove a layer → directories removed from both

10. **E2E workflow**:
    - Create a domain
    - Switch to conceptual, add some entities
    - Switch to logical, add detailed columns
    - Switch to physical, see manifest data
    - Toggle discrepancy on physical → see differences from logical
    - Delete the domain → both files removed

Commit message: `feat: update sidebar, commands, and watchers for three-stage architecture (Batch E)`

---

## Post-Completion

After all batches are merged:

1. **Update CLAUDE.md** — reflect the new directory structure, stage concept, removed services
2. **Update dev-preview.html** instructions — mock data needs `stage` field
3. **Bump version** in `package.json`
4. **Delete old test fixtures** that reference `source: 'built'` or `approved: true`
5. **Consider**: update `.gitignore` if the old `erd-studio/{layer}/` structure should be ignored
6. **Publish** new version to marketplace
