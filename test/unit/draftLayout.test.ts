// @vitest-environment jsdom
/**
 * The draft page's layout and schema filter (docs/dev/draft-first.md §2.3,
 * §2.5): `layoutDraft` runs the canvas's ELK with exactly the options the
 * canvas's first-open layout uses (the real Toolbar is driven through a
 * flagged load and both calls are compared), and `filterDisplayToSchema`
 * keeps one schema's tables and only the relationships between them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import * as fs from 'fs';
import * as path from 'path';

const mockRunElkLayout = vi.hoisted(() => vi.fn());

vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }),
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    Panel: ({ children }: { children: unknown }) => createElement('div', null, children as never),
    useReactFlow: () => ({ zoomIn: vi.fn(), zoomOut: vi.fn(), fitView: vi.fn(), getNode: vi.fn() }),
    useStore: () => 1,
    useNodesInitialized: () => true,
  };
});
vi.mock('../../webview/components/Toolbar/StageTabs', () => ({ StageTabs: () => null }));
vi.mock('../../webview/lib/elkLayout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../webview/lib/elkLayout')>();
  return { ...actual, runElkLayout: mockRunElkLayout };
});

import { Toolbar } from '../../webview/components/Toolbar/Toolbar';
import { useEditorStore } from '../../webview/store/editorStore';
import { layoutDraft, withPositions } from '../../webview-draft/lib/draftLayout';
import { filterDisplayToSchema, tablesInSchema } from '../../webview-draft/lib/filterDisplayToSchema';
import { FIRST_OPEN_LAYOUT, buildLayoutOptions, firstOpenLayoutOptions } from '../../webview/lib/firstOpenLayout';
import { DEFAULT_ELK_OPTIONS, SPACING_PRESETS, detectLayerBound } from '../../webview/lib/elkLayout';
import { transformSubjectArea } from '@erd-studio/renderer';
import { countVisibleColumnRows, estimateNodeHeight, resolveNodeDimensions } from '@erd-studio/renderer/sizing';
import type { DisplaySubjectArea } from '../../src/types/display';
import type { DraftView } from '../../src/types/draft';
import type { FkFlowEdge, TableFlowNode } from '@erd-studio/renderer/editor';

const FIXTURES = path.resolve(__dirname, '../fixtures/draft');
const fixture = (name: string): DraftView => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as DraftView;

const initialStoreState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialStoreState, true);
  mockRunElkLayout.mockReset();
  mockRunElkLayout.mockImplementation(async (nodes: TableFlowNode[]) =>
    Object.fromEntries(nodes.map((n, i) => [n.id, { x: i * 10, y: 0 }])));
});

afterEach(cleanup);

describe('firstOpenLayout', () => {
  it('starts on the popover defaults the canvas has always used', () => {
    expect(FIRST_OPEN_LAYOUT).toEqual({ partitionStrategy: 'auto', layerBound: 5, direction: 'RIGHT', spacing: 'M' });
  });

  it('builds the diagram options, then direction, spacing and the √n layer bound', () => {
    expect(firstOpenLayoutOptions(16, { 'elk.aspectRatio': '1.5', 'elk.direction': 'DOWN' })).toEqual({
      'elk.aspectRatio': '1.5',
      'elk.direction': 'RIGHT',
      ...SPACING_PRESETS.M,
      'elk.layered.layering.coffmanGraham.layerBound': String(detectLayerBound(16)),
    });
    expect(buildLayoutOptions({ partitionStrategy: 'depth', layerBound: 7, direction: 'DOWN', spacing: 'L' }, 16)).toEqual({
      'elk.direction': 'DOWN',
      ...SPACING_PRESETS.L,
      'elk.layered.layering.coffmanGraham.layerBound': '7',
    });
    expect(DEFAULT_ELK_OPTIONS['elk.algorithm']).toBe('layered');
  });
});

describe('layoutDraft', () => {
  it('lays out every table and relationship with the first-open options and the auto strategy', async () => {
    const display = fixture('small').display;
    const positions = await layoutDraft(display);
    expect(mockRunElkLayout).toHaveBeenCalledTimes(1);
    const [nodes, edges, options, strategy] = mockRunElkLayout.mock.calls[0] as [TableFlowNode[], FkFlowEdge[], Record<string, string>, string];
    expect(nodes.map((n) => n.id).sort()).toEqual(['customers', 'orders', 'products']);
    expect(edges).toHaveLength(2);
    expect(options).toEqual(firstOpenLayoutOptions(3, display.viewConfig.layoutOptions));
    expect(strategy).toBe('auto');
    expect(Object.keys(positions).sort()).toEqual(['customers', 'orders', 'products']);
  });

  it('uses the same options as the canvas first-open layout (the real Toolbar on a flagged load)', async () => {
    const display: DisplaySubjectArea = {
      ...fixture('dbt').display,
      readOnly: false,
      viewConfig: { layoutOptions: { 'elk.aspectRatio': '1.8' } },
    };
    // The canvas: a flagged load of the same diagram, drawn as nodes and lines.
    const graph = transformSubjectArea(display);
    act(() => {
      useEditorStore.getState().setDomain(display);
      useEditorStore.getState().setPendingAutoLayout(true);
    });
    await act(async () => {
      render(createElement(Toolbar, {
        nodes: graph.nodes as TableFlowNode[],
        edges: graph.edges as FkFlowEdge[],
      }));
    });
    await vi.waitFor(() => expect(mockRunElkLayout).toHaveBeenCalledTimes(1));
    const canvasCall = mockRunElkLayout.mock.calls[0];

    await layoutDraft(display);
    expect(mockRunElkLayout).toHaveBeenCalledTimes(2);
    const draftCall = mockRunElkLayout.mock.calls[1];
    expect(draftCall[2]).toEqual(canvasCall[2]);
    expect(draftCall[3]).toEqual(canvasCall[3]);
    expect((draftCall[0] as TableFlowNode[]).map((n) => n.id)).toEqual((canvasCall[0] as TableFlowNode[]).map((n) => n.id));
    expect((draftCall[1] as FkFlowEdge[]).map((e) => e.id)).toEqual((canvasCall[1] as FkFlowEdge[]).map((e) => e.id));
  });

  it('sizes every table expanded, as ErdCanvas draws a diagram under NODE_THRESHOLD', async () => {
    const base = fixture('small').display;
    const wide = {
      ...base.models[0],
      columns: Array.from({ length: 12 }, (_, i) => ({ ...base.models[0].columns[0], name: `col_${i}` })),
    };
    const display: DisplaySubjectArea = { ...base, models: [wide, ...base.models.slice(1)] };
    await layoutDraft(display);
    const [nodes] = mockRunElkLayout.mock.calls[0] as [TableFlowNode[]];
    const node = nodes.find((n) => n.id === wide.name)!;
    expect(node.data.isExpanded).toBe(true);
    const expandedHeight = resolveNodeDimensions(node).height;
    const collapsedHeight = resolveNodeDimensions({ ...node, data: { ...node.data, isExpanded: false } }).height;
    expect(expandedHeight).toBeGreaterThan(collapsedHeight);
    expect(expandedHeight).toBe(estimateNodeHeight(countVisibleColumnRows({ ...node.data, isExpanded: true }), !!node.data.grain));
  });

  it('lays nothing out for an empty draft', async () => {
    expect(await layoutDraft({ ...fixture('small').display, models: [], relationships: [] })).toEqual({});
    expect(mockRunElkLayout).not.toHaveBeenCalled();
  });

  it('rejects when ELK fails (the page then draws the fallback placement)', async () => {
    mockRunElkLayout.mockRejectedValueOnce(new Error('ELK layout worker crashed'));
    await expect(layoutDraft(fixture('small').display)).rejects.toThrow('crashed');
  });

  it('withPositions draws the laid-out tables where ELK put them', () => {
    const display = fixture('small').display;
    const moved = withPositions(display, { orders: { x: 1, y: 2 } });
    expect(moved.viewConfig.positions).toEqual({ ...display.viewConfig.positions, orders: { x: 1, y: 2 } });
    expect(display.viewConfig.positions?.orders).toEqual({ x: 420, y: 0 });
  });
});

describe('filterDisplayToSchema', () => {
  const display = fixture('large').display;

  it('returns the same diagram for All tables', () => {
    expect(filterDisplayToSchema(display, undefined)).toBe(display);
    expect(tablesInSchema(display, undefined)).toBe(80);
  });

  it('keeps one schema’s tables and only the relationships inside it', () => {
    const finance = filterDisplayToSchema(display, 'finance');
    expect(finance.models).toHaveLength(25);
    expect(finance.models.every((m) => m.schema === 'finance')).toBe(true);
    const names = new Set(finance.models.map((m) => m.name));
    expect(finance.relationships.every((r) => names.has(r.fromModel) && names.has(r.toModel))).toBe(true);
    // finance_t00 → sales_t00 and hr_t00 → finance_t00 cross schemas: neither is drawn.
    expect(finance.relationships).toHaveLength(24);
    expect(finance.relationships.some((r) => r.toModel === 'sales_t00' || r.fromModel === 'hr_t00')).toBe(false);
    expect(Object.keys(finance.viewConfig.positions ?? {}).sort()).toEqual([...names].sort());
    expect(tablesInSchema(display, 'finance')).toBe(25);
    // The draft itself is untouched.
    expect(display.models).toHaveLength(80);
  });

  it('filters the tables with no schema under ""', () => {
    const coffee = fixture('example-no-folder').display;
    expect(filterDisplayToSchema(coffee, '').models).toHaveLength(2);
    expect(filterDisplayToSchema(coffee, 'sales').models).toHaveLength(0);
  });

  it('keeps only the notes linked to a kept table', () => {
    const withNotes: DisplaySubjectArea = {
      ...display,
      viewConfig: {
        ...display.viewConfig,
        annotations: [
          { id: 'a', text: 'on sales', x: 0, y: 0, linkedModel: 'sales_t01' },
          { id: 'b', text: 'on hr', x: 0, y: 0, linkedModel: 'hr_t01' },
          { id: 'c', text: 'loose', x: 0, y: 0 },
        ],
      },
    };
    expect(filterDisplayToSchema(withNotes, 'sales').viewConfig.annotations?.map((a) => a.id)).toEqual(['a']);
    expect(filterDisplayToSchema(withNotes, undefined).viewConfig.annotations).toHaveLength(3);
  });
});
