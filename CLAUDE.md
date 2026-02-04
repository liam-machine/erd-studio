# dbt Semantic Designer — Project Context

## Architecture

VS Code extension with dual build targets:
- **Extension host** (Node.js, CJS) — `src/` directory
- **Webview** (Browser, IIFE with React) — `webview/` directory

Built with esbuild. Two TypeScript configs: `tsconfig.json` (Node.js) and `tsconfig.webview.json` (DOM).

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
                     schemaVersion: 1, domain: 'preview', layer: 'silver',
                     description: 'Dev preview', models: [], relationships: [],
                     viewConfig: {}
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

4. **Add test models/relationships** to the `domainLoaded` payload in `dev-preview.html` to render sample nodes and edges. The graph transformer (F108) converts `SemanticDomain` data into React Flow nodes/edges automatically.

5. **Use Chrome browser automation** (claude-in-chrome) to take screenshots and verify visual output.

### Important notes

- `dist/webview.css` is a **separate file** from `dist/webview.js` — both must be loaded
- The mock `acquireVsCodeApi` sends a fake `domainLoaded` message so the app gets past the loading guard
- The `<style>` block provides VS Code dark theme CSS variables — adjust for light theme testing
- Remember to `npm run build` after any code changes before refreshing the preview
- Clean up mock data and `dev-preview.html` before committing

## Dev Mock Data

`dev-preview.html` contains **mock SemanticDomain data** in its `domainLoaded` payload for visual development. This provides four models and three FK relationships demonstrating:
- Built many-to-one (blue solid with crow's foot)
- Design many-to-one (orange solid with crow's foot)
- Design one-to-one (orange dashed with perpendicular bars)

The graph transformer (`webview/lib/graphTransformer.ts`, F108) converts the SemanticDomain data into React Flow nodes/edges. The colour scheme logic lives in `webview/lib/colorScheme.ts`.

To preview in Chrome: create `dev-preview.html` (see instructions above), run `npm run build`, serve with `npx http-server -p 8765 --cors -c-1`, and open `http://localhost:8765/dev-preview.html`.

## Key Conventions

- Shared types live in `src/types/` and are included in both tsconfigs
- Webview components use BEM CSS class naming
- All colours use CSS custom properties from `webview/styles/theme.css`
- React Flow custom node/edge types must be defined as stable references (module-level constants, not inside components)
- Extension host writes use `WorkspaceEdit` for undo/redo integration

## Status Lifecycle

Models, columns, and relationships follow a progression from design to built:

### Model Status: `design` → `approved` → `built`

| Status | Description | Color | Source |
|--------|-------------|-------|--------|
| `design` | Planned model not yet in dbt | Orange | `source: 'design'` in JSON |
| `approved` | Ready for build, reviewed | Teal | `source: 'design'` + `approved: true` |
| `built` | Exists in dbt manifest | Blue | `source: 'built'` and found in manifest |
| `missing` | Referenced but not in manifest | Grey | `source: 'built'` but not in manifest |

### Column Status: `planned` → `approved` → `built`

| Status | Description | Color |
|--------|-------------|-------|
| `planned` | Column defined but not in manifest | Orange |
| `approved` | Column approved for build | Teal |
| `built` | Column exists in manifest | Blue |

### Relationship Status: `design` → `approved` → `built`

| Status | Description | Color |
|--------|-------------|-------|
| `design` | Planned FK relationship | Orange |
| `approved` | Relationship approved for build | Teal |
| `built` | Relationship test exists in manifest | Blue |

### Approval Rules

1. **Models**: Can be approved via DetailPanel button or right-click context menu
2. **Columns**:
   - On design models: require model approval first
   - On built models: can be approved independently (for planned columns)
3. **Relationships**: Can only be approved when **both** connected models are `built` or `approved`

### Cascade Behavior

When **unapproving a model**, the following cascades automatically:
- All columns in that model become unapproved
- All relationships connected to that model become unapproved

This maintains the invariant that approved items must have their dependencies also approved.

## Publishing to VS Code Marketplace

**Marketplace:** https://marketplace.visualstudio.com/items?itemName=liamwynne.dbt-semantic-designer

### Publish a New Version

1. Bump `version` in `package.json`
2. Run:
   ```bash
   source .env && npx @vscode/vsce publish --pat "$AZURE_PAT"
   ```

PAT is stored in `.env` as `AZURE_PAT`. Manage at https://dev.azure.com/LiamWynne/_usersSettings/tokens
