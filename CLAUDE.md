# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Naming

The extension display name is **ERD Studio** (package name `erd-studio`).

### Directory Structure

ERD domain files live at `{project_root}/erd-studio/{stage}/{layer}/{domain}.json`. The custom editor activates for files matching:
- `**/erd-studio/conceptual/**/*.json`
- `**/erd-studio/logical/**/*.json`

The base directory is configurable via the `dbtSemantic.semanticDir` setting (default: `erd-studio`).

### Legacy Internal Identifiers

The following internal identifiers still use the legacy `dbtSemantic` prefix and must **not** be renamed (doing so would break existing user settings, keybindings, and stored state):

- **Command IDs**: `dbtSemantic.createDomain`, `dbtSemantic.openDomain`, `dbtSemantic.deleteDomain`, `dbtSemantic.refreshManifest`, `dbtSemantic.renameDomain`, `dbtSemantic.addLayer`, `dbtSemantic.editLayer`, `dbtSemantic.removeLayer`, `dbtSemantic.initializeLayerConfig`, `dbtSemantic.setupSemanticDirectory`, `dbtSemantic.switchTreeStage`
- **View IDs**: `dbt-semantic` (activity bar container), `dbtSemantic.domainTree`
- **Custom editor viewType**: `dbtSemantic.domainEditor`
- **Setting keys**: `dbtSemantic.projectPath`, `dbtSemantic.semanticDir`
- **Color IDs**: `dbtSemantic.layer.bronze`, `dbtSemantic.layer.silver`, `dbtSemantic.layer.gold`, `dbtSemantic.layer.platinum`, `dbtSemantic.layer.custom`
- **Command category**: `"category": "dbt"` in package.json command contributions

## Build & Test Commands

```bash
npm run build          # Build both extension + webview bundles (esbuild)
npm run watch          # Watch mode — rebuilds on change
npm run compile        # Type-check only (both tsconfigs, no emit)
npm run test           # Run unit tests (vitest)
npm run test:watch     # Run tests in watch mode
npm run package        # Production build (minified, no sourcemaps)
```

Single test file: `npx vitest run test/unit/domainService.test.ts`

Tests use vitest with `vscode` module aliased to `test/__mocks__/vscode.ts`. Test fixtures live in `test/fixtures/`.

## Architecture

VS Code extension with dual build targets:
- **Extension host** (Node.js, CJS) — `src/` directory
- **Webview** (Browser, IIFE with React) — `webview/` directory

Built with esbuild (`esbuild.js`). Two TypeScript configs: `tsconfig.json` (Node.js) and `tsconfig.webview.json` (DOM). The webview tsconfig includes `src/types/**/*` so types are shared.

### Three-Stage Architecture

The extension uses three design stages, each with a distinct purpose:

| Stage | Color | Purpose | Editable |
|-------|-------|---------|----------|
| **Conceptual** | Violet (`#8b5cf6`) | High-level entity design — model names, descriptions, entity-level relationships | Yes |
| **Logical** | Blue (`#60a5fa`) | Detailed data model — full columns, data types, PK/FK/NK, SCD types, grain, rationale | Yes |
| **Physical** | Green (`#22c55e`) | What exists in dbt — auto-derived from `manifest.json`, fully read-only | No |

Stage colors are defined in `webview/lib/stageColors.ts`.

### Data Flow

```
                         ┌─ conceptual/{layer}/{domain}.json ─→ DisplayDomain
DomainService reads ─────┤
                         └─ logical/{layer}/{domain}.json ────→ DisplayDomain
                                                                     │
manifest.json ─→ ManifestService ─→ buildPhysicalDomain() ──→ DisplayDomain
                                                                     │
                                              [message] ─→ graphTransformer ─→ React Flow
```

1. **ManifestService** stream-parses `target/manifest.json` (handles 40MB+ files via `stream-json`)
2. **DomainService** reads domain JSON from `erd-studio/{stage}/{layer}/*.json` and converts to `DisplayDomain`
3. For physical stage: `DomainService.buildPhysicalDomain()` derives data from logical domain + manifest
4. **DiscrepancyService** compares two `DisplayDomain` objects to produce a `DiscrepancyReport`
5. Extension sends `domainLoaded` / `stageData` message to webview
6. **graphTransformer** converts `DisplayDomain` → React Flow nodes + edges (with optional discrepancy overlays)
7. **elkLayout** runs ELK auto-layout in a Web Worker (injected at build time as `__ELK_WORKER_CODE__`)

### Extension Host (`src/`)

| Directory | Purpose |
|-----------|---------|
| `providers/` | `SemanticEditorProvider` (custom editor), `DomainTreeProvider` (sidebar tree) |
| `services/` | Business logic — manifest parsing, domain I/O, discrepancy comparison, layers, templates |
| `watchers/` | `FileWatcherService` — debounced watchers for manifest, domains, project config |
| `types/` | Shared type definitions (imported by both host and webview) |

### Webview (`webview/`)

| Directory | Purpose |
|-----------|---------|
| `components/` | React components — `Graph/` (ModelNode, ConceptualModelNode, FkEdge), `DetailPanel/`, `DiscrepancyPanel/`, `WelcomeModal/`, `Toolbar/` (StageTabs), dialogs |
| `store/` | Zustand store (`editorStore.ts`) — UI state, selection, dialogs, active stage, discrepancy |
| `hooks/` | `useMessageBus` (extension comms), `useVsCodeApi`, position/state persistence |
| `lib/` | Pure functions — `graphTransformer`, `elkLayout`, `stageColors`, `columnSort` |
| `styles/` | `theme.css` — CSS custom properties mapping VS Code theme vars |

### Message Protocol (`src/types/messages.ts`)

Extension <-> Webview communication uses discriminated unions on `type` field:
- **Extension -> Webview**: `domainLoaded`, `domainUpdated`, `stageData`, `discrepancyReport`, `error`
- **Webview -> Extension**: `addModel`, `addColumn`, `removeColumn`, `updateColumn`, `addRelationship`, `removeRelationship`, `renameModel`, `removeModel`, `updatePositions`, `runAutoLayout`, `switchStage`, `toggleDiscrepancy`, `refreshManifest`, `undo`, `redo`, etc.

All mutations go through `WorkspaceEdit` for undo/redo integration. Physical stage silently rejects all mutation messages.

## Key Conventions

- Shared types live in `src/types/` and are included in both tsconfigs
- Webview components use BEM CSS class naming
- All colours use CSS custom properties from `webview/styles/theme.css`
- React Flow custom node/edge types must be defined as stable references (module-level constants, not inside components)
- Extension host writes use `WorkspaceEdit` for undo/redo integration
- ELK worker code is injected at build time via `define` — VS Code webviews cannot use `importScripts()`
- Stage switching sends `switchStage` message; extension resolves sibling domain file and responds with `stageData`
- Physical stage is derived at runtime — no files on disk, positions inherited from logical domain

## Discrepancy System

Cross-stage comparison is handled by `DiscrepancyService.compare(source, target)`:

| Active Stage | Available Comparisons |
|-------------|----------------------|
| Physical | Compare to Logical |
| Logical | Compare to Physical, Compare to Conceptual |
| Conceptual | Compare to Logical |

Discrepancy statuses for models/columns/relationships: `matched`, `extra`, `missing`, `type-mismatch` (columns), `cardinality-mismatch` (relationships). Ghost nodes appear for missing models.

## Testing the Webview UI in Chrome

The webview runs inside VS Code's sandboxed iframe, making it hard to inspect visually. Use this workflow to render the full webview in a regular Chrome tab using browser automation tools.

### How it works

The built `dist/webview.js` is a self-contained IIFE bundle (React, React Flow, all components). The only external dependency is `acquireVsCodeApi()` which VS Code injects. By mocking that function and providing VS Code CSS variables, the entire webview renders in a plain browser.

### Steps

1. **Build the webview:**
   ```
   npm run build
   ```

2. **Create `dev-preview.html`** in the project root (gitignored):
   ```html
   <!DOCTYPE html>
   <html lang="en">
   <head>
     <meta charset="UTF-8" />
     <title>Webview Dev Preview</title>
     <link rel="stylesheet" href="dist/webview.css">
     <style>
       html, body, #root { margin: 0; padding: 0; width: 100%; height: 100vh; overflow: hidden; }
       :root {
         --vscode-editor-background: #1e1e1e;
         --vscode-editor-foreground: #d4d4d4;
         --vscode-sideBar-background: #252526;
         --vscode-panel-border: #404040;
         --vscode-editorGroup-border: #444444;
         --vscode-button-background: #0e639c;
         --vscode-button-foreground: #ffffff;
         --vscode-button-hoverBackground: #1177bb;
         --vscode-input-background: #3c3c3c;
         --vscode-input-foreground: #cccccc;
         --vscode-input-border: transparent;
         --vscode-focusBorder: #007fd4;
         --vscode-editor-selectionBackground: #264f78;
         --vscode-errorForeground: #f48771;
         --vscode-editorWarning-foreground: #cca700;
         --vscode-descriptionForeground: #999999;
         --vscode-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         --vscode-font-size: 13px;
         --vscode-font-weight: 400;
         --vscode-editor-font-family: 'SF Mono', Menlo, Consolas, monospace;
       }
     </style>
   </head>
   <body>
     <div id="root"></div>
     <script>
       window.acquireVsCodeApi = function() {
         return {
           postMessage: function(msg) {
             if (msg && msg.type === 'ready') {
               setTimeout(function() {
                 window.postMessage({
                   type: 'domainLoaded',
                   payload: {
                     schemaVersion: 2, domain: 'preview', layer: 'silver',
                     stage: 'logical',
                     description: 'Dev preview', models: [], relationships: [],
                     viewConfig: {}, readOnly: false
                   }
                 }, '*');
               }, 100);
             }
           },
           getState: function() { return null; },
           setState: function() {}
         };
       };
     </script>
     <script src="dist/webview.js"></script>
   </body>
   </html>
   ```

3. **Serve locally and open in Chrome:**
   ```
   npx http-server -p 8765 --cors -c-1 &
   ```
   Then navigate to `http://localhost:8765/dev-preview.html`

4. **Add test models/relationships** to the `domainLoaded` payload in `dev-preview.html` to render sample nodes and edges. The graph transformer converts `DisplayDomain` data into React Flow nodes/edges automatically.

5. **Use Chrome browser automation** (claude-in-chrome) to take screenshots and verify visual output.

### Important notes

- `dist/webview.css` is a **separate file** from `dist/webview.js` — both must be loaded
- The mock `acquireVsCodeApi` sends a fake `domainLoaded` message so the app gets past the loading guard
- The `<style>` block provides VS Code dark theme CSS variables — adjust for light theme testing
- Remember to `npm run build` after any code changes before refreshing the preview
- Clean up mock data and `dev-preview.html` before committing

## Dev Mock Data

`dev-preview.html` contains **mock DisplayDomain data** in its `domainLoaded` payload for visual development. The graph transformer (`webview/lib/graphTransformer.ts`) converts the DisplayDomain data into React Flow nodes/edges. The stage colour logic lives in `webview/lib/stageColors.ts`.

To preview in Chrome: create `dev-preview.html` (see instructions above), run `npm run build`, serve with `npx http-server -p 8765 --cors -c-1`, and open `http://localhost:8765/dev-preview.html`.

## Publishing to VS Code Marketplace

**Marketplace:** https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio

The old `liamwynne.dbt-semantic-designer` extension has been unpublished and removed from the marketplace. Only `liamwynne.erd-studio` exists now.

### Publish a New Version

1. Bump `version` in `package.json`
2. Run:
   ```bash
   source .env && npx @vscode/vsce publish --pat "$AZURE_PAT"
   ```
3. Commit the version bump and push.

PAT is stored in `.env` as `AZURE_PAT`. Manage at https://dev.azure.com/LiamWynne/_usersSettings/tokens

### Unpublish an Extension

```bash
source .env && npx @vscode/vsce unpublish <publisher>.<extension-id> --pat "$AZURE_PAT" --force
```
