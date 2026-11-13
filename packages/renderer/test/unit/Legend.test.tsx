// @vitest-environment jsdom
/**
 * Legend — the panel that decodes the canvas.
 *
 * It lists only what the diagram it sits on can draw (`legendFacts`), so
 * these tests build a diagram the way the canvas does (`transformSubjectArea`)
 * and check the entries per case: viewer or editor, logical or physical,
 * DBML (tables name their own layer) or YAML/JSON storage, with or without
 * dbt, a comparison open or not. They also pin the samples to
 * `lib/badgeLabels`, the maps TableNode renders from, so a renamed chip
 * fails here rather than shipping a legend that explains the wrong thing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { CanvasContext, DisplaySubjectArea, DiscrepancyReport, LayerConfig } from '@erd-studio/core';

import { Legend, legendEntries, legendFacts, hasXray, type LegendFactsInput } from '../../src/components/Legend/Legend';
import { CanvasEnvironmentProvider, NOOP_CANVAS_HOST } from '../../src/host/canvasEnvironment';
import { CanvasStoreProvider, createCanvasStore } from '../../src/store/editorStore';
import { transformSubjectArea } from '../../src/lib/graphTransformer';
import type { RoutedEdge } from '../../src/lib/edgeRouting/types';
import {
  SOURCE_LABEL,
  SOURCE_LEGEND_DESC,
  SOURCE_LEGEND_DESC_NEUTRAL,
  SCD_BADGE,
  SCD_TITLE,
  ADDITIVE_BADGE,
  ADDITIVE_TITLE,
} from '../../src/lib/badgeLabels';

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Diagrams
// ---------------------------------------------------------------------------

const SILVER: LayerConfig = { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#7c8a99', order: 1, creatable: true } as LayerConfig;
const GOLD: LayerConfig = { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', order: 2, creatable: true } as LayerConfig;

const col = (name: string, keys: { pk?: boolean; fk?: boolean; nk?: boolean } = {}, extra: Record<string, unknown> = {}) => ({
  name, dataType: 'bigint', description: '',
  isPrimaryKey: !!keys.pk, isForeignKey: !!keys.fk, isNaturalKey: !!keys.nk, ...extra,
});

/** A plain diagram: two tables, one many-to-one, PK and FK only. */
function plain(overrides: Partial<DisplaySubjectArea> = {}): DisplaySubjectArea {
  return {
    schemaVersion: 6, domain: 'sales', layer: 'silver', stage: 'logical', description: '',
    readOnly: false, positionDraggable: true, viewConfig: {},
    layerConfig: SILVER,
    models: [
      { name: 'orders', schema: 'silver', description: '', columns: [col('order_key', { pk: true }), col('customer_key', { fk: true })] },
      { name: 'customers', schema: 'silver', description: '', columns: [col('customer_key', { pk: true })] },
    ],
    relationships: [{ fromModel: 'orders', fromColumn: 'customer_key', toModel: 'customers', toColumn: 'customer_key', cardinality: 'many-to-one' }],
    ...overrides,
  } as DisplaySubjectArea;
}

/** A DBML diagram: each table names its own layer, one from another layer. */
function dbml(): DisplaySubjectArea {
  const d = plain({ layerConfigs: [SILVER, GOLD] });
  d.models = [
    { ...d.models[0], layer: 'silver' },
    { ...d.models[1], layer: 'gold', schema: 'gold' },
  ];
  return d;
}

/** A YAML/JSON diagram in a multi-layer project: no table names its own layer. */
function yaml(): DisplaySubjectArea {
  return plain({ layerConfigs: [SILVER, GOLD] });
}

/** Everything a logical diagram can draw. */
function rich(): DisplaySubjectArea {
  const d = plain({ layerConfigs: [SILVER, GOLD] });
  d.models = [
    {
      name: 'orders', schema: 'sales', alias: 'orders_v2', grain: 'One row per order line', description: '', layer: 'silver',
      columns: [
        col('order_key', { pk: true }), col('customer_key', { fk: true }), col('order_number', { nk: true }),
        col('amount', {}, { additiveType: 'additive' }), col('status', {}, { scdType: 2 }),
        col('ship_date_key', { fk: true }), col('ship_time_key', { fk: true }),
      ],
    },
    { name: 'customers', schema: 'silver', description: '', layer: 'silver', columns: [col('customer_key', { pk: true }), col('parent_key', { fk: true })] },
    { name: 'dates', schema: 'silver', description: '', layer: 'silver', columns: [col('date_key', { pk: true }), col('time_key', { pk: true })] },
  ];
  d.relationships = [
    { fromModel: 'orders', fromColumn: 'customer_key', toModel: 'customers', toColumn: 'customer_key', cardinality: 'many-to-one', role: 'buyer' },
    { fromModel: 'orders', fromColumn: 'ship_date_key', toModel: 'dates', toColumn: 'date_key', cardinality: 'many-to-one', compositeKey: 'ship' },
    { fromModel: 'orders', fromColumn: 'ship_time_key', toModel: 'dates', toColumn: 'time_key', cardinality: 'many-to-one', compositeKey: 'ship' },
    { fromModel: 'customers', fromColumn: 'customer_key', toModel: 'orders', toColumn: 'order_key', cardinality: 'one-to-one', keysContradict: true },
    { fromModel: 'customers', fromColumn: 'parent_key', toModel: 'dates', toColumn: 'date_key', cardinality: 'many-to-many' },
  ];
  d.viewConfig = { annotations: [{ id: 'n1', text: 'Note', x: 0, y: 0, linkedModel: 'orders' }] } as DisplaySubjectArea['viewConfig'];
  return d;
}

/** A physical diagram: provenance from the manifest, both ghosts. */
function physical(): DisplaySubjectArea {
  return {
    ...plain({ layerConfigs: [SILVER, GOLD] }),
    stage: 'physical', readOnly: true,
    models: [
      { name: 'orders', schema: 'silver', description: '', columns: [col('order_key', { pk: true })], provenance: { columns: ['yml', 'manifest'], types: 'manifest' }, existsInProject: true },
      { name: 'gone', schema: 'silver', description: '', columns: [col('gone_key', { pk: true })], existsInProject: false },
      { name: 'off', schema: 'silver', description: '', columns: [col('off_key', { pk: true })], existsInProject: false, missingReason: 'disabled' },
    ],
    relationships: [],
  } as DisplaySubjectArea;
}

const REPORT: DiscrepancyReport = {
  domain: 'sales', layer: 'silver', sourceStage: 'logical', targetStage: 'physical',
  models: [{ name: 'orders', status: 'extra', columns: [] }],
  relationships: [],
  summary: {} as DiscrepancyReport['summary'],
} as DiscrepancyReport;

function facts(domain: DisplaySubjectArea, extra: Partial<LegendFactsInput> & { report?: DiscrepancyReport } = {}) {
  const { report, ...rest } = extra;
  const { nodes, edges } = transformSubjectArea(domain, report ? { discrepancyReport: report } : undefined);
  return legendFacts({ viewer: false, logicalOnly: false, domain, nodes, edges, ...rest });
}

function renderLegend(domain: DisplaySubjectArea, opts: { viewer?: boolean; logicalOnly?: boolean; open?: boolean; report?: DiscrepancyReport } = {}) {
  const { nodes, edges } = transformSubjectArea(domain, opts.report ? { discrepancyReport: opts.report } : undefined);
  const store = createCanvasStore({ domain, nodes, edges, legendOpen: opts.open ?? true, logicalOnly: opts.logicalOnly === true });
  const utils = render(
    <CanvasStoreProvider store={store}>
      <CanvasEnvironmentProvider host={NOOP_CANVAS_HOST} viewer={opts.viewer === true}>
        <ReactFlowProvider><Legend /></ReactFlowProvider>
      </CanvasEnvironmentProvider>
    </CanvasStoreProvider>,
  );
  const text = () => utils.container.querySelector('.legend__content')?.textContent ?? '';
  return { ...utils, store, text };
}

// ---------------------------------------------------------------------------
// legendFacts: what each kind of diagram can draw
// ---------------------------------------------------------------------------

describe('legendFacts — storage and layers', () => {
  it('DBML: each table names its own layer, so the badge says the table\'s file\'s layer, and notes a table from another layer', () => {
    const f = facts(dbml(), { logicalOnly: true });
    expect(f.layerBadge).toEqual({ abbreviation: 'SLV', color: SILVER.color, perTable: true, otherLayers: true });
  });

  it('YAML/JSON: every table carries the diagram\'s layer', () => {
    expect(facts(yaml(), { logicalOnly: true }).layerBadge).toEqual({ abbreviation: 'SLV', color: SILVER.color, perTable: false, otherLayers: false });
  });

  it('a single-layer project draws no badge, so none is explained', () => {
    const d = plain({ layerConfigs: [SILVER] });
    d.models = d.models.map((m) => ({ ...m, layer: 'silver' }));
    expect(facts(d).layerBadge).toBeNull();
  });

  it('an older core that lists no layers keeps the badge (the canvas draws one)', () => {
    expect(facts(plain()).layerBadge?.abbreviation).toBe('SLV');
  });
});

describe('legendFacts — stage, dbt and comparison', () => {
  it('a logical-only canvas has no stage colours: no stage card', () => {
    expect(facts(plain(), { logicalOnly: true }).stage).toBeNull();
    expect(facts(plain(), { logicalOnly: true, viewer: true }).stage).toBeNull();
  });

  it('a dbt project: the stage shown, its own card only', () => {
    expect(facts(plain()).stage).toBe('logical');
    expect(facts(physical()).stage).toBe('physical');
  });

  it('physical: the ghosts and the provenance chips actually on the diagram', () => {
    const f = facts(physical());
    expect(f.ghostAbsent).toBe(true);
    expect(f.ghostDisabled).toBe(true);
    expect(f.sources).toEqual(['manifest']);
    expect(facts(plain()).sources).toEqual([]);
    expect(facts(plain()).ghostAbsent).toBe(false);
  });

  it('comparison colours only while a comparison is open, and never in the viewer', () => {
    expect(facts(plain()).comparing).toBe(false);
    expect(facts(plain(), { report: REPORT }).comparing).toBe(true);
    expect(facts(plain(), { report: REPORT, viewer: true }).comparing).toBe(false);
  });

  it('lines rest grey and light up in the layer colour: logical-only, or the editor\'s dbt canvas with no comparison', () => {
    expect(facts(plain(), { logicalOnly: true }).litColour).toBe(SILVER.color);
    expect(facts(plain(), { logicalOnly: true, viewer: true }).litColour).toBe(SILVER.color);
    expect(facts(plain()).litColour).toBe(SILVER.color);
    // Comparing: lines take the stage and comparison colours.
    expect(facts(plain(), { report: REPORT }).litColour).toBeNull();
    // The viewer on a dbt diagram draws its lines in the stage colour.
    expect(facts(plain(), { viewer: true }).litColour).toBeNull();
    // No layer colour: the lit lines stay grey, nothing to explain.
    expect(facts(plain({ layerConfig: undefined }), { logicalOnly: true }).litColour).toBeNull();
    // No lines: nothing lights up.
    expect(facts(plain({ relationships: [] }), { logicalOnly: true }).litColour).toBeNull();
  });
});

describe('legendFacts — what the tables and lines carry', () => {
  it('a plain diagram: PK and FK, one many-to-one, and nothing else', () => {
    const f = facts(plain(), { logicalOnly: true });
    expect(f.keys).toEqual({ pk: true, fk: true, nk: false });
    expect([f.scd, f.additive, f.roles, f.composite, f.backwards, f.xray, f.notes, f.linkedNotes, f.schemaPrefix, f.alias, f.grain, f.offDiagram])
      .toEqual([false, false, false, false, false, false, false, false, false, false, false, false]);
    expect(f.cardinalities).toEqual(['many-to-one']);
  });

  it('a rich diagram: every mark it draws', () => {
    const f = facts(rich(), { logicalOnly: true, xray: true });
    expect(f.keys).toEqual({ pk: true, fk: true, nk: true });
    expect([f.scd, f.additive, f.roles, f.composite, f.backwards, f.xray, f.notes, f.linkedNotes, f.schemaPrefix, f.alias, f.grain])
      .toEqual([true, true, true, true, true, true, true, true, true, true, true]);
    expect(f.cardinalities).toEqual(['many-to-one', 'one-to-one', 'many-to-many']);
  });

  it('the ⚠ backwards mark is the editor\'s only: the viewer never draws it', () => {
    expect(facts(rich(), { viewer: true }).backwards).toBe(false);
  });

  it('the "+n" chip: the editor with a host context naming an off-diagram link', () => {
    const context = { offDiagram: { orders: [{ otherTable: 'returns', direction: 'in', column: 'order_key', otherColumn: 'order_key', cardinality: 'many-to-one' }] } } as unknown as CanvasContext;
    expect(facts(plain(), { canvasContext: context }).offDiagram).toBe(true);
    expect(facts(plain(), { canvasContext: context, viewer: true }).offDiagram).toBe(false);
    expect(facts(plain()).offDiagram).toBe(false);
  });

  it('x-ray only when a routed line passes under a table', () => {
    const route = (tunnels?: unknown) => new Map([['e', { tunnels } as unknown as RoutedEdge]]);
    expect(hasXray(route([[{ x: 0, y: 0 }, { x: 1, y: 0 }]]))).toBe(true);
    expect(hasXray(route(undefined))).toBe(false);
    expect(hasXray(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

describe('Legend — collapsed', () => {
  it('renders only the toggle when closed; the viewer\'s names no shortcut it does not have', () => {
    const editor = renderLegend(plain(), { open: false });
    expect(editor.container.querySelector('.legend__content')).toBeNull();
    expect(editor.container.querySelector('.legend-toggle__button')!.getAttribute('title')).toBe('Show legend (Shift+?)');
    cleanup();
    const viewer = renderLegend(plain(), { open: false, viewer: true });
    expect(viewer.container.querySelector('.legend-toggle__button')!.getAttribute('title')).toBe('Show legend');
  });
});

describe('Legend — a logical-only diagram (no dbt)', () => {
  it('no stage card, ghost, provenance, comparison or dbt; the badge, keys and its one cardinality', () => {
    const { container, text } = renderLegend(dbml(), { logicalOnly: true });
    expect(container.querySelector('.legend__model-card')).toBeNull();
    expect(container.querySelector('.legend__items--sources')).toBeNull();
    expect(container.querySelector('.legend__swatch')).toBeNull();
    expect(text()).not.toMatch(/dbt/);
    expect(container.querySelector('.legend__badge--layer')!.textContent).toBe('SLV');
    expect(text()).toContain("The layer the table's file is in (a table from another layer carries its own)");
    expect(text()).toContain('Primary key');
    expect(text()).toContain('Foreign key');
    expect(text()).not.toContain('Natural key');
    expect([...container.querySelectorAll('.legend__items--cardinality .legend__item-desc')].map((e) => e.textContent)).toEqual(['Many-to-one']);
    expect(text()).toContain("Its lines light up in the layer's colour");
    expect(text()).not.toContain('Notes');
  });

  it('draws the badge in the diagram\'s own layer colour, as the table header does', () => {
    const { container } = renderLegend(dbml(), { logicalOnly: true });
    expect((container.querySelector('.legend__badge--layer') as HTMLElement).style.getPropertyValue('--legend-layer-color')).toBe(SILVER.color);
  });

  it('YAML/JSON storage: the badge is the diagram\'s layer', () => {
    const { text } = renderLegend(yaml(), { logicalOnly: true });
    expect(text()).toContain("The diagram's layer");
    expect(text()).not.toContain("table's file");
  });
});

describe('Legend — a rich diagram', () => {
  it('explains every mark the canvas draws, with the canvas\'s own symbols', () => {
    const { container, text } = renderLegend(rich(), { logicalOnly: true });
    for (const s of ['sales.', 'as name', "The table's name in the warehouse", 'what one row is', 'Natural key',
      'Text on a line: what the link means', 'A composite key', 'Probably drawn backwards', 'A note on the canvas', 'Note linked to a table']) {
      expect(text()).toContain(s);
    }
    expect([...container.querySelectorAll('.legend__symbols--scd > span')].map((s) => [s.textContent, s.getAttribute('title')]))
      .toEqual([0, 1, 2].map((t) => [SCD_BADGE[t], SCD_TITLE[t]]));
    const additive = Object.keys(ADDITIVE_BADGE);
    expect([...container.querySelectorAll('.legend__symbols--additive > span')].map((s) => [s.textContent, s.getAttribute('title')]))
      .toEqual(additive.map((k) => [ADDITIVE_BADGE[k], ADDITIVE_TITLE[k]]));
    expect([...container.querySelectorAll('.legend__items--cardinality .legend__item-desc')].map((e) => e.textContent))
      .toEqual(['Many-to-one', 'One-to-one', 'Many-to-many']);
  });

  it('explains the moving arrows with the canvas\'s own glyphs, for the cardinalities drawn', () => {
    const { container } = renderLegend(rich(), { logicalOnly: true });
    const rows = [...container.querySelectorAll('.legend__items--flow .legend__item')].filter((r) => r.querySelector('.fk-edge__flow'));
    expect(rows.map((r) => r.querySelector('.legend__item-desc')!.textContent)).toEqual([
      'Arrows run 1 → *', 'Both ways: many-to-many', 'Dots meet: one-to-one',
    ]);
    expect(rows[2].querySelectorAll('.fk-edge__flow-dot')).toHaveLength(2);
    expect(container.querySelector('.legend__items--flow [repeatCount="indefinite"]')).not.toBeNull();
  });

  it('stands the arrows still under the reduce-motion setting', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'), media: query,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    try {
      const { container } = renderLegend(rich(), { logicalOnly: true });
      expect(container.querySelectorAll('.legend__items--flow .fk-edge__flow')).toHaveLength(3);
      expect(container.querySelector('[repeatCount="indefinite"]')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the viewer: the same marks, less the editor\'s ⚠', () => {
    const { text } = renderLegend(rich(), { logicalOnly: true, viewer: true });
    expect(text()).not.toContain('Probably drawn backwards');
    expect(text()).toContain('A composite key');
  });
});

describe('Legend — a dbt project', () => {
  it('the editor, logical stage: the Logical card, grey lines that light up, no comparison until one is open', () => {
    const { container, text } = renderLegend(plain());
    expect(container.querySelector('.legend__model-card--logical')).not.toBeNull();
    expect(container.querySelector('.legend__model-card--physical')).toBeNull();
    expect(text()).not.toContain('Comparing Stages');
    expect(text()).not.toContain('Line colour follows the stage');
    expect(text()).toContain("Its lines light up in the layer's colour");
  });

  it('the editor with a comparison open: its colours, and the lines no longer grey', () => {
    const { container, text } = renderLegend(plain(), { report: REPORT });
    expect(text()).toContain('Comparing Stages');
    expect(container.querySelectorAll('.legend__swatch')).toHaveLength(3);
    expect(container.querySelectorAll('.legend__edge--disc-extra, .legend__edge--disc-missing, .legend__edge--disc-mismatch')).toHaveLength(3);
    expect(text()).not.toContain("Its lines light up in the layer's colour");
  });

  it('the editor, physical stage: Physical, the ghosts drawn and only the chips drawn, in dbt words', () => {
    const { container, text } = renderLegend(physical());
    expect(container.querySelector('.legend')!.classList.contains('legend--stage-physical')).toBe(true);
    expect(container.querySelector('.legend__model-card--logical')).toBeNull();
    expect(text()).toContain('What your dbt project builds (read-only)');
    expect(text()).toContain('Not found in your dbt project');
    expect(container.querySelector('.legend__model-card--ghost-disabled')).not.toBeNull();
    const rows = container.querySelectorAll('.legend__items--sources .legend__item');
    expect(rows).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByText(SOURCE_LABEL.manifest)).toBeTruthy();
    expect(rows[0].textContent).toContain(SOURCE_LEGEND_DESC.manifest);
  });

  it('the viewer, physical stage: the same entries in neutral words, never a comparison', () => {
    const { container, text } = renderLegend(physical(), { viewer: true });
    expect(text()).toContain('Built from the project (read-only)');
    expect(text()).toContain(SOURCE_LEGEND_DESC_NEUTRAL.manifest);
    expect(text()).not.toMatch(/dbt/);
    expect(container.querySelector('.legend__swatch')).toBeNull();
  });

  it('the viewer, logical stage: the Logical card and its stage-coloured lines (nothing lights up)', () => {
    const { container, text } = renderLegend(plain(), { viewer: true });
    expect(container.querySelector('.legend__model-card--logical')).not.toBeNull();
    expect(container.querySelector('.legend__model-card--physical')).toBeNull();
    expect(text()).not.toContain("Its lines light up in the layer's colour");
  });
});

describe('Legend — an empty diagram', () => {
  it('says there is nothing on it rather than explaining what is not there', () => {
    const { text } = renderLegend(plain({ models: [], relationships: [] }), { logicalOnly: true });
    expect(text()).toContain('Nothing on this diagram yet.');
  });
});

describe('legendEntries (kept for hosts that call it)', () => {
  it('editor: everything, less the physical and comparison groups without dbt', () => {
    expect(legendEntries({ viewer: false, logicalOnly: false, stage: 'physical' })).toEqual({ logicalStage: true, physical: true, lineColours: true, comparison: true });
    expect(legendEntries({ viewer: false, logicalOnly: true, stage: 'logical' })).toEqual({ logicalStage: true, physical: false, lineColours: false, comparison: false });
  });

  it('viewer: the stage shown, never a comparison', () => {
    expect(legendEntries({ viewer: true, logicalOnly: false, stage: 'logical' })).toEqual({ logicalStage: true, physical: false, lineColours: false, comparison: false });
    expect(legendEntries({ viewer: true, logicalOnly: false, stage: 'physical' })).toEqual({ logicalStage: false, physical: true, lineColours: false, comparison: false });
  });
});
