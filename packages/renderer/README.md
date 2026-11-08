# @erd-studio/renderer

The entity-relationship diagram canvas from the [ERD Studio](https://github.com/liam-machine/erd-studio) VS Code extension, packaged for reuse. It is built on React Flow and renders a `DisplaySubjectArea` from `@erd-studio/core`: model nodes with their columns and key badges, FK edges with cardinality, annotations, the detail panel and the legend.

Peer dependencies: `react` and `react-dom` 18.3+, `@xyflow/react` 12.4+.

## Entry points

| Import | What it is for |
|---|---|
| `@erd-studio/renderer` | Showing a domain: the `ErdCanvas` viewer component (below), plus `transformSubjectArea` (a `DisplaySubjectArea` to React Flow nodes and edges), `pickHandleSides`, `repickHandleSides` / `nodeRect`, the diagram exporters re-exported from `@erd-studio/core` (below), and the display, domain and graph types (`DisplaySubjectArea`, `TableFlowNode`, `FkFlowEdge`, …). |
| `@erd-studio/renderer/editor` | Everything above plus what a host needs to build a full editor around the canvas, as the extension's webview does: the store (below), the host adapter, `useCanvasGraph`, `useHoverFocus` (hover preview and relationship flow: spread its `hoverHandlers` onto `<ReactFlow>` and pass its `flowClassName` as the `className`; without it nothing flows, even on click), `CanvasBackdrop`, `canvasNodeTypes` / `canvasEdgeTypes`, the components (`TableNode`, `FkEdge`, `EdgeFlow` / `EdgeFlowGlyphs` (the moving direction glyphs on a line), `AnnotationNode`, `AnnotationEdge`, `DetailPanel`, `Legend`, `StatusBar`, `KeyBadge`, `KeyBadgeGroup`, `DataTypeSelect`, `ColumnRowEditor`), the canvas hooks and the pure helpers. |
| `@erd-studio/renderer/store` | The canvas store on its own, with no React Flow runtime: `createCanvasSlice`, `createCanvasStore`, `CanvasStoreProvider`, `useEditorStore`, `useEditorStoreApi` and their types. |
| `@erd-studio/renderer/sizing` | Model node size estimation (`NODE_WIDTH`, `estimateNodeWidth`, `estimateNodeHeight`, `countVisibleColumnRows`, `resolveNodeDimensions`), for layout code that needs node sizes before React Flow has measured them. No components. |
| `@erd-studio/renderer/styles.css` | The stylesheet: every component's CSS in cascade order, then the theme tokens. It `@import`s `@xyflow/react/dist/style.css`, which your bundler resolves. |

All four JavaScript entry points share their modules, so a store or context created through one is the same one the others see.

## Viewer: `ErdCanvas`

`ErdCanvas` renders a `DisplaySubjectArea` read-only, the way the extension shows a read-only domain: model nodes with their columns and key badges, FK edges, annotations, the minimap, the legend with the table and relationship counts beside it, and the detail panel a click on a model opens. Closing the panel keeps the table selected (its relationships stay lit, unlike the extension); a click on the empty canvas, or Escape, clears the selection. Escape is heard on `window` and acts only when it is pressed inside the canvas, or with nothing focused for the canvas last clicked, pointed at or focused, so with several canvases on a page it clears only that one's selection. It presents no editing affordances and posts nothing anywhere.

```tsx
import { useRef, useState } from 'react';
import { ErdCanvas, type ErdCanvasHandle, type DisplaySubjectArea } from '@erd-studio/renderer';
import '@erd-studio/renderer/styles.css';

function Diagram({ domain }: { domain: DisplaySubjectArea }) {
  const canvas = useRef<ErdCanvasHandle>(null);
  const [moved, setMoved] = useState(false);
  return (
    <div style={{ height: 600, position: 'relative' }}>
      <ErdCanvas ref={canvas} domain={domain} nodesDraggable onLayoutModifiedChange={setMoved} />
      {moved && <button onClick={() => canvas.current?.resetLayout()}>Reset layout</button>}
    </div>
  );
}
```

| Prop | |
|---|---|
| `domain` | The domain to show. It is rendered read-only whatever its `readOnly` flag says. Missing `layer`, `stage`, `relationships`, `viewConfig`, model `columns` and column `dataType` are filled with defaults. Pass a new object to show a new domain; re-rendering with the same object keeps the reader's view. |
| `nodesDraggable` | Let readers move model and annotation nodes (default `false`). Moves are never saved; the edges on a moved node re-pick their sides as it moves. |
| `onLayoutModifiedChange(modified)` | Called when the layout starts or stops differing from the domain's positions (a node moved; `resetLayout()`, a new domain, or a node moved back). |
| `onReady()` | Called once, after the first nodes are measured and fitted into view (straight away for an empty domain). |
| `logicalOnly` | Draw the diagram of a project with no dbt project (default `false`): tables, lines and the selection ring take neutral theme colours instead of the logical stage's blue, so the layer badge carries the colour, and the legend leaves out the Physical stage, ghosts, provenance chips and comparison colours. |
| `lineStyle` | How relationship lines are drawn (default `'curved'`; `LINE_STYLES` lists both, `LineStyle` is the type). Both route every line around the tables in its way. `'curved'`: soft curves, a halo where two lines cross (the line underneath is cut), and a faint dashed "x-ray" where a line has no way round a table. `'hops'`: square corners and a small hop where two lines cross. Any other value reads as `'curved'`. A view preference: readers cannot change it, and nothing is posted. Diagrams over 100 lines are routed in a Web Worker started from a blob URL, so allow `worker-src blob:` in the page's CSP: with it any size is routed (2,000 tables in about 1.5 s) without pausing the page; without it, diagrams up to 150 lines route on the main thread and larger ones keep simple lines. |
| `className`, `style` | Applied to the canvas's wrapper element, which fills its parent. |

The ref exposes `resetLayout()`, which puts every node back at its position in the domain with its original edge sides.

Each `ErdCanvas` has its own store, so several can share a page.

**Line routing.** Every FK line is routed in one pass over the whole diagram, on the frame after a node moves or is measured; each canvas has its own router, so diagrams on one page never share its state. A self-loop, a line the router cannot place and every line on a diagram too large or too slow to route draw the smooth-step path older versions drew. While a node is dragged on a slow diagram, its lines take that path until the drag ends. On a `logicalOnly` canvas the lines are neutral grey at rest, and the lines of the hovered or selected table (with their end labels, role labels, flow arrows and x-ray) take the diagram's layer colour (`layerConfig.color`, else the grey). Nothing here reads a new field: a `DisplaySubjectArea` from an older core routes the same way.

## Exporting a diagram

The `.` entry re-exports `@erd-studio/core`'s exporters, so a page that shows a diagram with `ErdCanvas` can offer it as text without depending on core itself: `toMermaid`, `toDbml`, `toDbmlRich`, `DBML_RICH_EXPORT_HEADER`, `exportDiagram`, `diagramExportFileName`, `DIAGRAM_EXPORT_FORMATS`, `DIAGRAM_EXPORT_FILE_EXTENSIONS` and the `DiagramExportFormat` and `DbmlRichOptions` types. Rich DBML is one file per diagram: its Project carries the table positions in `erd_layout`. The exporters are pure functions with no React or DOM use; the same `DisplaySubjectArea` gives the same text everywhere ERD Studio exports it.

```ts
import { exportDiagram, diagramExportFileName, type DisplaySubjectArea } from '@erd-studio/renderer';

function downloadDbml(domain: DisplaySubjectArea) {
  const text = exportDiagram(domain, 'dbml'); // or 'mermaid'
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: diagramExportFileName(domain, 'dbml') });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

See the [`@erd-studio/core` README](https://github.com/liam-machine/erd-studio/blob/main/packages/core/README.md#exporting-a-diagram) for what each format carries.

## Editor: store and host

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
- `CanvasEnvironmentProvider`'s `viewer` flag switches the components to the read-only presentation `ErdCanvas` uses. It is separate from a domain's `readOnly` flag, which the extension sets for the physical stage and which still offers menus such as the key-type picker.
- A host with more state of its own can build its store from `createCanvasSlice(set)` and pass that to `CanvasStoreProvider`, which is what the extension does.
- Components used outside a `CanvasStoreProvider` throw.

## CSS variables

The styles are written against VS Code's theme variables. A page that is not a VS Code webview must define these 31 on `:root` (or any ancestor of the canvas). Most have fallbacks, but the canvas only matches your theme when they are set.

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

These four more are read only by the data-type picker, which appears only while editing a column (never in `ErdCanvas`):

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

The sources import each other without file extensions, as bundlers expect. The build's last step (`scripts/dts-extensions.mjs`) adds `.js` to the relative imports in the emitted declarations, so the types also work for consumers on `moduleResolution: node16` or `nodenext`.

## License

[PolyForm Shield 1.0.0](./LICENSE), the same licence as the rest of the repository.
