// @vitest-environment jsdom
/**
 * The viewer never names dbt. A page that embeds `ErdCanvas` (a downstream
 * app) cannot know whether the project it shows uses dbt, so every string the
 * viewer can show — the detail panel's Warehouse name row and "Columns from",
 * the node's ghost, provenance and layer-badge hover text, and the legend —
 * is worded without it. The editor (no `viewer`) in a dbt project keeps its
 * dbt wording, pinned at the bottom of this file and in the component tests.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { DisplaySubjectArea } from '@erd-studio/core';
import { ErdCanvas } from '../../src/ErdCanvas';
import { createCanvasStore, CanvasStoreProvider } from '../../src/store/editorStore';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import { DetailPanel } from '../../src/components/DetailPanel/DetailPanel';
import { transformSubjectArea } from '../../src/lib/graphTransformer';
import { Legend } from '../../src/components/Legend/Legend';
import { SOURCE_LABEL_NEUTRAL, SOURCE_LEGEND_DESC_NEUTRAL, SOURCE_PHRASE_NEUTRAL } from '../../src/lib/badgeLabels';

beforeAll(() => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;
});

afterEach(cleanup);

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

const col = (name: string, isPrimaryKey = false, dataType = 'bigint') =>
  ({ name, dataType, description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });

/**
 * A physical-stage domain with every dbt-derived cue the canvas can draw: an
 * alias, provenance whose types come from the manifest, no resolved schema
 * (the badge's "no schema" line), and both kinds of ghost.
 */
function physicalDomain(): DisplaySubjectArea {
  return {
    schemaVersion: 5,
    domain: 'sales',
    layer: 'gold',
    stage: 'physical',
    description: '',
    models: [
      {
        name: 'fct_sale',
        schema: '',
        alias: 'sale',
        description: 'One row per sale line',
        columns: [col('sale_key', true), col('amount', false, '')],
        provenance: { columns: ['yml', 'manifest'], types: 'manifest' },
      },
      { name: 'dim_gone', schema: 'gold', description: '', columns: [col('gone_key', true)], existsInProject: false },
      { name: 'dim_off', schema: 'gold', description: '', columns: [col('off_key', true)], existsInProject: false, missingReason: 'disabled' },
    ],
    relationships: [],
    viewConfig: { positions: { fct_sale: { x: 0, y: 0 }, dim_gone: { x: 600, y: 0 }, dim_off: { x: 0, y: 500 } } },
    readOnly: true,
    positionDraggable: true,
  } as DisplaySubjectArea;
}

/** Every visible string, tooltip, hover-card label and placeholder under `root`. */
function allText(root: HTMLElement): string {
  const attrs = (name: string) => [...root.querySelectorAll(`[${name}]`)].map((el) => el.getAttribute(name));
  return [root.textContent, ...attrs('title'), ...attrs('aria-label'), ...attrs('placeholder')].join('\n');
}

describe('ErdCanvas (the viewer) never names dbt', () => {
  async function renderViewer() {
    const view = render(
      <div style={{ width: 1200, height: 800 }}>
        <ErdCanvas domain={physicalDomain()} />
      </div>,
    );
    await flush();
    // Open the legend and the detail panel, so their text is in the page too.
    fireEvent.click(view.container.querySelector('.legend-toggle__button')!);
    fireEvent.click(view.container.querySelector('.react-flow__node-model[data-id="fct_sale"]')!);
    await flush();
    return view;
  }

  it('shows no dbt word anywhere: nodes, hover text, detail panel, legend', async () => {
    const { container } = await renderViewer();
    expect(container.querySelector('.legend')).not.toBeNull();
    expect(container.querySelector('.detail-panel')).not.toBeNull();
    // document.body: hover cards portal out of the canvas.
    expect(allText(document.body)).not.toMatch(/dbt/i);
  });

  it('words the Warehouse name row neutrally', async () => {
    const { container } = await renderViewer();
    const value = container.querySelector('.detail-panel__metadata-row--alias .detail-panel__value')!;
    expect(value.textContent).toBe('sale');
    expect(value.getAttribute('title')).toBe("Named sale in the warehouse; the table's name is fct_sale");
  });

  it('names the physical sources neutrally in the panel, the chip and the legend', async () => {
    const { container } = await renderViewer();
    expect(container.querySelector('.detail-panel')!.textContent).toContain('schema .yml and compiled manifest');

    const chip = container.querySelector('.react-flow__node-model[data-id="fct_sale"] .model-node__source')!;
    expect(chip.textContent).toBe(SOURCE_LABEL_NEUTRAL.manifest);
    expect(chip.getAttribute('aria-label')).toContain(`types from ${SOURCE_PHRASE_NEUTRAL.manifest}`);

    const legend = container.querySelector('.legend')!;
    // The legend explains the chip the canvas draws (the types' source), in neutral words.
    expect(legend.textContent).toContain(SOURCE_LEGEND_DESC_NEUTRAL.manifest);
    expect(legend.textContent).not.toMatch(/dbt/);
    expect(legend.textContent).toContain('Built from the project (read-only)');
    expect(legend.textContent).toContain('Not found in the project');
    expect(legend.textContent).toContain('Disabled in the project');
    // The viewer never compares stages, so the legend has no comparison entries.
    expect(legend.querySelector('.legend__swatch')).toBeNull();
    expect(legend.textContent).not.toContain('Comparing Stages');
  });

  it('explains ghosts and a missing schema without dbt commands', async () => {
    const { container } = await renderViewer();
    const name = (id: string) =>
      container.querySelector(`.react-flow__node-model[data-id="${id}"] .model-node__name`)!.getAttribute('aria-label');
    expect(name('dim_gone')).toContain('not found in the project');
    expect(name('dim_off')).toContain('disabled in the project');
    const badge = container.querySelector('.react-flow__node-model[data-id="fct_sale"] .model-node__badge')!;
    expect(badge.getAttribute('aria-label')).toContain('No schema resolved.');
  });
});

describe('The editor in a dbt project keeps its dbt wording', () => {
  it('names dbt in the Warehouse name row, Columns from and the legend', () => {
    const domain = physicalDomain();
    const store = createCanvasStore({
      domain,
      ...transformSubjectArea(domain),
      selectedNode: 'fct_sale',
      detailPanelOpen: true,
      legendOpen: true,
    });
    const { container } = render(
      <CanvasStoreProvider store={store}>
        <CanvasEnvironmentProvider host={{ postMessage: vi.fn() }} viewer={false}>
          <ReactFlowProvider>
            <DetailPanel />
            <Legend />
          </ReactFlowProvider>
        </CanvasEnvironmentProvider>
      </CanvasStoreProvider>,
    );
    const value = container.querySelector('.detail-panel__metadata-row--alias .detail-panel__value')!;
    expect(value.getAttribute('title')).toBe("Built as sale (dbt alias); the table's name is fct_sale");
    expect(container.querySelector('.detail-panel')!.textContent).toContain('your dbt .yml and dbt manifest');
    const legend = container.querySelector('.legend')!.textContent!;
    expect(legend).toContain('What your dbt project builds (read-only)');
    expect(legend).toContain('Not found in your dbt project');
    expect(legend).toContain('Disabled in dbt');
    expect(legend).toContain('The compiled dbt manifest');
  });
});
