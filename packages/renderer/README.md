# @erd-studio/renderer

The entity-relationship diagram canvas from the [ERD Studio](https://github.com/liam-machine/erd-studio) VS Code extension, packaged for reuse. It is built on React Flow and renders a `DisplayDomain` from `@erd-studio/core`: model nodes with their columns and key badges, FK edges with cardinality, annotations, the detail panel and the legend.

Peer dependencies: `react` and `react-dom` 18.3+, `@xyflow/react` 12.4+.

## Entry points

| Import | What it is for |
|---|---|
| `@erd-studio/renderer` | Rendering a domain: `transformDomain` (a `DisplayDomain` to React Flow nodes and edges), `pickHandleSides`, and the display, domain and graph types (`DisplayDomain`, `ModelFlowNode`, `FkFlowEdge`, …). |
| `@erd-studio/renderer/editor` | Everything above plus what a host needs to build a full editor around the canvas, as the extension's webview does: the store (below), the host adapter, `useCanvasGraph`, `CanvasBackdrop`, `canvasNodeTypes` / `canvasEdgeTypes`, the components (`ModelNode`, `FkEdge`, `AnnotationNode`, `AnnotationEdge`, `DetailPanel`, `Legend`, `KeyBadge`, `KeyBadgeGroup`, `DataTypeSelect`, `ColumnRowEditor`), the canvas hooks and the pure helpers. |
| `@erd-studio/renderer/store` | The canvas store on its own, with no React Flow runtime: `createCanvasSlice`, `createCanvasStore`, `CanvasStoreProvider`, `useEditorStore`, `useEditorStoreApi` and their types. |
| `@erd-studio/renderer/sizing` | Model node size estimation (`NODE_WIDTH`, `estimateNodeWidth`, `estimateNodeHeight`, `countVisibleColumnRows`, `resolveNodeDimensions`), for layout code that needs node sizes before React Flow has measured them. No components. |
| `@erd-studio/renderer/styles.css` | The stylesheet: every component's CSS in cascade order, then the theme tokens. It `@import`s `@xyflow/react/dist/style.css`, which your bundler resolves. |

All four JavaScript entry points share their modules, so a store or context created through one is the same one the others see.

### Store and host

The canvas components read their state from the store supplied by the nearest `CanvasStoreProvider`, and post the edits a user makes on the canvas (renaming a column, moving an annotation, changing a cardinality, …) as `CanvasEditMessage`s to the `CanvasHost` supplied by `CanvasEnvironmentProvider`.

```tsx
import { ReactFlowProvider } from '@xyflow/react';
import {
  createCanvasStore,
  CanvasStoreProvider,
  CanvasEnvironmentProvider,
  type CanvasHost,
} from '@erd-studio/renderer/editor';
import '@erd-studio/renderer/styles.css';

const store = createCanvasStore({ domain });
const host: CanvasHost = { postMessage: (edit) => applyEdit(edit) };

<CanvasStoreProvider store={store}>
  <CanvasEnvironmentProvider host={host}>
    <ReactFlowProvider>{/* <ReactFlow nodeTypes={canvasNodeTypes} … /> */}</ReactFlowProvider>
  </CanvasEnvironmentProvider>
</CanvasStoreProvider>
```

- Without a `CanvasEnvironmentProvider`, edits go to a no-op host.
- A host with more state of its own can build its store from `createCanvasSlice(set)` and pass that to `CanvasStoreProvider`, which is what the extension does.
- Components used outside a `CanvasStoreProvider` throw.

## CSS variables

The styles are written against VS Code's theme variables. A page that is not a VS Code webview must define these on `:root` (or any ancestor of the canvas). Most have fallbacks, but the canvas only matches your theme when they are set.

```
--vscode-button-background                 --vscode-font-family
--vscode-button-foreground                 --vscode-font-size
--vscode-button-hoverBackground            --vscode-font-weight
--vscode-charts-green                      --vscode-input-background
--vscode-charts-purple                     --vscode-input-border
--vscode-descriptionForeground             --vscode-input-foreground
--vscode-editor-background                 --vscode-list-activeSelectionBackground
--vscode-editor-font-family                --vscode-list-activeSelectionForeground
--vscode-editor-foreground                 --vscode-panel-border
--vscode-editor-inactiveSelectionBackground --vscode-sideBar-background
--vscode-editor-selectionBackground        --vscode-textLink-activeForeground
--vscode-editorGroup-border                --vscode-textLink-foreground
--vscode-editorHoverWidget-background
--vscode-editorHoverWidget-border
--vscode-editorHoverWidget-foreground
--vscode-editorWarning-foreground
--vscode-editorWidget-background
--vscode-errorForeground
--vscode-focusBorder
```

These four are read only by the data-type picker, which appears only while editing a column:

```
--vscode-dropdown-background   --vscode-dropdown-border
--vscode-dropdown-foreground   --vscode-list-hoverBackground
```

Dark-theme variants of a few annotation and legend colours key off `body[data-vscode-theme-kind="vscode-dark"]` (and `vscode-high-contrast`).

The stylesheet does not size the page. Give the element the canvas is mounted in an explicit height.

## Development

This package lives in the `packages/renderer` workspace of the ERD Studio repository. Inside the repository it is consumed from source (TypeScript `paths` and vitest aliases); the published package ships only `dist/`.

```sh
npm run build -w @erd-studio/renderer       # dist/*.js (esbuild, ESM), dist/styles.css, dist/types/*.d.ts
npm run typecheck -w @erd-studio/renderer
npm test -w @erd-studio/renderer
```

## License

[PolyForm Shield 1.0.0](./LICENSE), the same licence as the rest of the repository.
