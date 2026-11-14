/**
 * Legend — collapsible panel explaining the visual language of the graph.
 *
 * It lists only what this diagram can show, worked out from what is on the
 * canvas (`legendFacts`): the stage card (none on a logical-only canvas,
 * which has no stage colours), the ghosts and provenance chips a physical
 * diagram draws, the header marks its tables carry (the layer badge, in the
 * diagram's own layer colour; the schema prefix; the warehouse name; the
 * grain line; the editor's "+n" chip), the key badges and SCD / additive
 * symbols its columns use, the cardinalities, roles, composite keys and
 * x-ray stretches its lines draw, its notes, and the comparison colours only
 * while a comparison is open. The storage decides the layer badge's wording:
 * on a DBML diagram each table names its own layer (`DisplayTable.layer`),
 * on a YAML/JSON one every table is drawn in the diagram's layer.
 *
 * The viewer (`useIsViewer`) never names dbt (a page outside VS Code cannot
 * know whether the project uses it) and never shows an editing hint. The
 * badge vocabulary is imported from lib/badgeLabels so the legend cannot
 * fall out of step with what TableNode renders. Positioned in the
 * bottom-left corner, collapsible to a `?` icon button, and never taller
 * than its canvas (it scrolls inside).
 */

import { useCallback, useMemo, type CSSProperties } from 'react';
import { Panel } from '@xyflow/react';
import type { CanvasContext, Cardinality, DisplaySubjectArea, PhysicalColumnSource } from '@erd-studio/core';
import { useEditorStore } from '../../store/editorStore';
import { useIsViewer } from '../../host/canvasEnvironment';
import {
  SOURCE_LABEL,
  SOURCE_LABEL_NEUTRAL,
  SOURCE_LEGEND_DESC,
  SOURCE_LEGEND_DESC_NEUTRAL,
  SOURCE_ORDER,
  SCD_BADGE,
  ADDITIVE_BADGE,
  SCD_TITLE,
  ADDITIVE_TITLE,
} from '../../lib/badgeLabels';
import { EdgeFlowGlyphs } from '../Graph/EdgeFlow';
import { isSingleLayerProject, layerAbbreviation } from '../../lib/layerCues';
import { offDiagramRows } from '../../lib/canvasContext';
import type { FlowMode } from '../../lib/edgeFlow';
import type { RoutedEdge } from '../../lib/edgeRouting/types';
import type { GraphNode, GraphEdge } from '../../lib/nodeOverlays';
import type { TableNodeData, FkEdgeData } from '../../types/graph';
import { useCanvasChrome } from '../../canvas/useCanvasChrome';
import './Legend.css';

/**
 * Samples of the relationship flow, drawn with the canvas's own glyphs
 * between the same `1` / `*` end labels the cardinality rows use.
 */
const FLOW_SAMPLES: { mode: FlowMode; from: '1' | '*'; to: '1' | '*'; desc: string }[] = [
  { mode: 'forward', from: '1', to: '*', desc: 'Arrows run 1 → *' },
  { mode: 'both', from: '*', to: '*', desc: 'Both ways: many-to-many' },
  { mode: 'meet', from: '1', to: '1', desc: 'Dots meet: one-to-one' },
];
const FLOW_SAMPLE_PATH = 'M2,6 H46';

/** Which optional groups of entries the legend shows. */
export interface LegendEntries {
  /** The Logical stage card. */
  logicalStage: boolean;
  /** The Physical stage card, both ghosts and the provenance chips. */
  physical: boolean;
  /** "Line colour follows the stage": a logical and a physical line. */
  lineColours: boolean;
  /** "Comparing Stages": the discrepancy colours and lines. */
  comparison: boolean;
}

/**
 * The legend's optional entries by stage alone. The editor shows every one
 * (without a dbt project, `logicalOnly`, none of the physical or comparison
 * ones). The viewer draws one stage, read-only, and never a comparison, so it
 * shows only that stage's entries.
 *
 * @deprecated The legend now decides from what the diagram draws
 * (`legendFacts`); this coarser answer is kept for hosts that call it.
 */
export function legendEntries(options: { viewer: boolean; logicalOnly: boolean; stage: string | undefined }): LegendEntries {
  const { viewer, logicalOnly } = options;
  const physicalStage = options.stage === 'physical';
  return {
    logicalStage: viewer ? !physicalStage || logicalOnly : true,
    physical: viewer ? physicalStage && !logicalOnly : !logicalOnly,
    lineColours: viewer ? false : !logicalOnly,
    comparison: viewer ? false : !logicalOnly,
  };
}

function cardinalityLabel(label: '1' | '*') {
  return (
    <span className={`legend__cardinality-label${label === '*' ? ' legend__cardinality-label--many' : ''}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// What the diagram draws (pure)
// ---------------------------------------------------------------------------

/** The cardinalities in the order the legend lists them, with their end labels. */
const CARDINALITY_ROWS: { cardinality: Cardinality; from: '1' | '*'; to: '1' | '*'; desc: string }[] = [
  { cardinality: 'many-to-one', from: '*', to: '1', desc: 'Many-to-one' },
  { cardinality: 'one-to-one', from: '1', to: '1', desc: 'One-to-one' },
  { cardinality: 'one-to-many', from: '1', to: '*', desc: 'One-to-many' },
  { cardinality: 'many-to-many', from: '*', to: '*', desc: 'Many-to-many' },
];

/** Which flow sample a cardinality's line carries. */
const FLOW_OF: Record<string, FlowMode> = {
  'many-to-one': 'forward',
  'one-to-many': 'forward',
  'many-to-many': 'both',
  'one-to-one': 'meet',
};

/** What the legend explains for one diagram: everything it can draw, nothing it cannot. */
export interface LegendFacts {
  /** The stage card: null on a logical-only canvas (no stage colours). */
  stage: 'logical' | 'physical' | null;
  /** Physical ghosts on the diagram. */
  ghostAbsent: boolean;
  ghostDisabled: boolean;
  /** The physical provenance chips its tables carry, in `SOURCE_ORDER`. */
  sources: PhysicalColumnSource[];
  /**
   * The layer badge the tables carry, or null when they carry none (a
   * single-layer project). `perTable`: each table names its own layer (DBML
   * storage); otherwise every table carries the diagram's layer (YAML/JSON).
   * `otherLayers`: some tables come from another layer.
   */
  layerBadge: { abbreviation: string; color?: string; perTable: boolean; otherLayers: boolean } | null;
  /** A schema prefix before some table's name (`sales.`). */
  schemaPrefix: boolean;
  /** A warehouse name after some table's name (`as orders`). */
  alias: boolean;
  /** A grain line under some table's name. */
  grain: boolean;
  /** The editor's "+n" chip: relationships to tables not on this diagram. */
  offDiagram: boolean;
  /** Key badges its columns carry. */
  keys: { pk: boolean; fk: boolean; nk: boolean };
  scd: boolean;
  additive: boolean;
  /** The cardinalities its lines draw. */
  cardinalities: Cardinality[];
  /** A role name on some line. */
  roles: boolean;
  /** A composite key's ⧉ chip on some line. */
  composite: boolean;
  /** The editor's ⚠ on a line probably drawn backwards. */
  backwards: boolean;
  /** A line passing under a table, drawn as a faint dashed x-ray. */
  xray: boolean;
  /**
   * The colour the lines of the hovered or selected table light up in,
   * when the lines rest in the neutral grey (a logical-only canvas, or the
   * editor's dbt canvas with no comparison open) and the diagram's layer
   * has a colour. Null otherwise.
   */
  litColour: string | null;
  /** Notes on the canvas, and notes linked to a table. */
  notes: boolean;
  linkedNotes: boolean;
  /** A comparison is open (the editor's Compare): its colours are on the canvas. */
  comparing: boolean;
}

/** What `legendFacts` reads. */
export interface LegendFactsInput {
  viewer: boolean;
  logicalOnly: boolean;
  domain: Pick<DisplaySubjectArea, 'stage' | 'layer' | 'layerConfig' | 'layerConfigs' | 'models'> | null;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  /** The editing host's context (never in the viewer): the "+n" chips. */
  canvasContext?: CanvasContext | null;
  /** Some routed line passes under a table (`hasXray` of the router's routes). */
  xray?: boolean;
}

/** Whether any routed line has an x-ray stretch: a stretch drawn over a table it passes under. */
export function hasXray(routes: ReadonlyMap<string, RoutedEdge> | null | undefined): boolean {
  if (!routes) return false;
  for (const route of routes.values()) if (route.tunnels && route.tunnels.length > 0) return true;
  return false;
}

const isModel = (n: GraphNode): n is GraphNode & { type: 'model'; data: TableNodeData } => n.type === 'model';
const isFk = (e: GraphEdge): e is GraphEdge & { type: 'fk'; data: FkEdgeData } => e.type === 'fk' && e.data != null;

/** Work out the legend's entries from what the canvas draws (pure). */
export function legendFacts(input: LegendFactsInput): LegendFacts {
  const { viewer, logicalOnly, domain } = input;
  const models = input.nodes.filter(isModel);
  const lines = input.edges.filter(isFk);
  const data = models.map((n) => n.data);
  const columns = data.flatMap((d) => d.columns ?? []);

  const comparing = !viewer && (
    data.some((d) => d.discrepancySourceStage !== undefined) || lines.some((e) => e.data.discrepancyStatus !== undefined)
  );
  const stage = logicalOnly ? null : domain?.stage === 'physical' ? 'physical' : 'logical';
  const sources = SOURCE_ORDER.filter((src) => data.some((d) => d.provenance?.types === src));

  const singleLayer = domain ? isSingleLayerProject(domain) : true;
  const badged = data.filter((d) => !d.singleLayer && (d.tableLayer ?? d.layer));
  let layerBadge: LegendFacts['layerBadge'] = null;
  if (domain && !singleLayer && badged.length > 0) {
    const perTable = data.some((d) => d.tableLayer !== undefined);
    layerBadge = {
      abbreviation: layerAbbreviation(domain.layer, domain.layerConfig),
      ...(domain.layerConfig?.color ? { color: domain.layerConfig.color } : {}),
      perTable,
      otherLayers: data.some((d) => d.otherLayer === true),
    };
  }

  // Lines rest neutral on a logical-only canvas, and on the editor's dbt
  // canvas while no comparison is open (`.editor-canvas--quiet-lines`).
  const neutralLines = logicalOnly || (!viewer && !comparing);
  const layerColour = domain?.layerConfig?.color;
  const litColour = neutralLines && lines.length > 0 && layerColour ? layerColour : null;

  const cardinalities = CARDINALITY_ROWS
    .map((r) => r.cardinality)
    .filter((c) => lines.some((e) => (e.data.cardinality ?? 'many-to-one') === c));

  return {
    stage,
    ghostAbsent: data.some((d) => d.ghostReason === 'not-in-project'),
    ghostDisabled: data.some((d) => d.ghostReason === 'disabled'),
    sources,
    layerBadge,
    schemaPrefix: data.some((d) => !!d.shownSchema),
    alias: data.some((d) => !!d.alias),
    grain: data.some((d) => !!d.grain),
    offDiagram: !viewer && !!input.canvasContext && !!domain &&
      data.some((d) => offDiagramRows(input.canvasContext ?? null, domain as DisplaySubjectArea, d.modelName).length > 0),
    keys: {
      pk: columns.some((c) => c.isPrimaryKey),
      fk: columns.some((c) => c.isForeignKey),
      nk: columns.some((c) => c.isNaturalKey),
    },
    scd: columns.some((c) => c.scdType != null && SCD_BADGE[c.scdType] !== undefined),
    additive: columns.some((c) => !!c.additiveType && ADDITIVE_BADGE[c.additiveType] !== undefined),
    cardinalities,
    roles: lines.some((e) => !!e.data.role),
    composite: lines.some((e) => (e.data.pairs?.length ?? 0) > 1),
    backwards: !viewer && lines.some((e) => e.data.keysContradict === true && !e.data.readOnly && e.data.discrepancyStatus !== 'missing'),
    xray: input.xray === true && lines.length > 0,
    litColour,
    notes: input.nodes.some((n) => n.type === 'annotation'),
    linkedNotes: input.edges.some((e) => e.type === 'annotationLink'),
    comparing,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const NO_NODES: GraphNode[] = [];
const NO_EDGES: GraphEdge[] = [];

function cardinalityLine() {
  return (
    <svg className="legend__cardinality-line" viewBox="0 0 32 8" aria-hidden="true">
      <line x1="0" y1="4" x2="32" y2="4" className="legend__edge legend__edge--logical" />
    </svg>
  );
}

export function Legend() {
  const legendOpen = useEditorStore((s) => s.legendOpen);
  const setLegendOpen = useEditorStore((s) => s.setLegendOpen);
  const logicalOnly = useEditorStore((s) => s.logicalOnly) === true;
  const viewer = useIsViewer();
  const domain = useEditorStore((s) => s.domain);
  // Read what the canvas draws only while the legend is open, so a drag
  // never re-renders the closed ? button.
  const nodes = useEditorStore((s) => (s.legendOpen ? s.nodes : NO_NODES));
  const edges = useEditorStore((s) => (s.legendOpen ? s.edges : NO_EDGES));
  const canvasContext = useEditorStore((s) => (s.legendOpen && !viewer ? s.canvasContext : null));
  const xray = useEditorStore((s) => s.legendOpen && hasXray(s.edgeRoutes));
  const { legendMaxHeight } = useCanvasChrome();

  const facts = useMemo(
    () => legendFacts({
      viewer,
      logicalOnly,
      domain,
      nodes,
      edges,
      canvasContext,
      xray,
    }),
    [viewer, logicalOnly, domain, nodes, edges, canvasContext, xray],
  );
  const sourceLabel = viewer ? SOURCE_LABEL_NEUTRAL : SOURCE_LABEL;
  const sourceDesc = viewer ? SOURCE_LEGEND_DESC_NEUTRAL : SOURCE_LEGEND_DESC;

  const handleToggle = useCallback(() => {
    setLegendOpen(!legendOpen);
  }, [legendOpen, setLegendOpen]);

  const handleClose = useCallback(() => {
    setLegendOpen(false);
  }, [setLegendOpen]);

  // Collapsed state: just show the ? button
  if (!legendOpen) {
    return (
      <Panel position="bottom-left" className="legend-toggle">
        <button
          className="legend-toggle__button"
          onClick={handleToggle}
          title={viewer ? 'Show legend' : 'Show legend (Shift+?)'}
          aria-label="Show legend"
        >
          ?
        </button>
      </Panel>
    );
  }

  const physical = facts.stage === 'physical';
  const flowModes = new Set(facts.cardinalities.map((c) => FLOW_OF[c]));
  const flowSamples = FLOW_SAMPLES.filter((f) => flowModes.has(f.mode));
  const anyKeys = facts.keys.pk || facts.keys.fk || facts.keys.nk;
  const header = facts.layerBadge || facts.schemaPrefix || facts.alias || facts.grain || facts.offDiagram || facts.sources.length > 0;
  const linesShown = facts.cardinalities.length > 0;
  const stageCard = facts.stage !== null;
  const empty = !stageCard && !header && !anyKeys && !facts.scd && !facts.additive && !linesShown && !facts.notes && !facts.comparing;
  const layerDesc = facts.layerBadge
    ? facts.layerBadge.perTable
      ? facts.layerBadge.otherLayers
        ? "The layer the table's file is in (a table from another layer carries its own)"
        : "The layer the table's file is in"
      : "The diagram's layer"
    : '';

  return (
    <Panel
      position="bottom-left"
      className={physical ? 'legend legend--stage-physical' : 'legend'}
      style={legendMaxHeight !== null ? { maxHeight: legendMaxHeight } : undefined}
    >
      <div className="legend__header">
        <span className="legend__title">Legend</span>
        <button
          className="legend__close"
          onClick={handleClose}
          title="Hide legend"
          aria-label="Hide legend"
        >
          ×
        </button>
      </div>

      <div className="legend__content">
        {empty && <p className="legend__note legend__note--empty">Nothing on this diagram yet.</p>}

        {/* The stage: its colour on the table cards (none on a logical-only canvas). */}
        {stageCard && (
          <section className="legend__section">
            <h3 className="legend__section-title">Stage</h3>
            <div className="legend__items">
              {physical ? (
                <div className="legend__item">
                  <div className="legend__model-card legend__model-card--physical">
                    <div className="legend__model-header legend__model-header--physical" />
                  </div>
                  <div className="legend__item-text">
                    <span className="legend__item-label">Physical</span>
                    <span className="legend__item-desc">{viewer ? 'Built from the project (read-only)' : 'What your dbt project builds (read-only)'}</span>
                  </div>
                </div>
              ) : (
                <div className="legend__item">
                  <div className="legend__model-card legend__model-card--logical">
                    <div className="legend__model-header legend__model-header--logical" />
                  </div>
                  <div className="legend__item-text">
                    <span className="legend__item-label">Logical</span>
                    <span className="legend__item-desc">Your data model design</span>
                  </div>
                </div>
              )}
              {facts.ghostAbsent && (
                <div className="legend__item">
                  <div className="legend__model-card legend__model-card--ghost">
                    <div className="legend__model-header legend__model-header--ghost" />
                  </div>
                  <div className="legend__item-text">
                    <span className="legend__item-label">Ghost</span>
                    <span className="legend__item-desc">{viewer ? 'Not found in the project' : 'Not found in your dbt project'}</span>
                  </div>
                </div>
              )}
              {facts.ghostDisabled && (
                <div className="legend__item">
                  <div className="legend__model-card legend__model-card--ghost legend__model-card--ghost-disabled">
                    <div className="legend__model-header legend__model-header--ghost" />
                  </div>
                  <div className="legend__item-text">
                    <span className="legend__item-label">Ghost, dotted</span>
                    <span className="legend__item-desc">
                      {viewer
                        ? <>Disabled in the project &mdash; it is not built</>
                        : <>Disabled in dbt &mdash; <code>ref()</code> to it will not compile</>}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* The table header's marks. */}
        {header && (
          <section className="legend__section">
            <h3 className="legend__section-title">Table Header</h3>
            <div className="legend__items legend__items--header">
              {facts.layerBadge && (
                <div className="legend__item">
                  <span className="legend__sample">
                    <span
                      className="legend__badge legend__badge--layer"
                      style={facts.layerBadge.color ? ({ '--legend-layer-color': facts.layerBadge.color } as CSSProperties) : undefined}
                    >
                      {facts.layerBadge.abbreviation}
                    </span>
                  </span>
                  <span className="legend__item-desc">{layerDesc}</span>
                </div>
              )}
              {facts.schemaPrefix && (
                <div className="legend__item">
                  <span className="legend__sample"><span className="legend__schema-sample">sales.</span></span>
                  <span className="legend__item-desc">The table&apos;s schema, when it is not the layer&apos;s name</span>
                </div>
              )}
              {facts.alias && (
                <div className="legend__item">
                  <span className="legend__sample"><span className="legend__alias-sample">as name</span></span>
                  <span className="legend__item-desc">The table&apos;s name in the warehouse</span>
                </div>
              )}
              {facts.grain && (
                <div className="legend__item">
                  <span className="legend__sample"><span className="legend__grain-sample">grain</span></span>
                  <span className="legend__item-desc">The line under the name: what one row is</span>
                </div>
              )}
              {facts.offDiagram && (
                <div className="legend__item">
                  <span className="legend__sample"><span className="legend__off-diagram-sample">+2</span></span>
                  <span className="legend__item-desc">Relationships to tables not on this diagram</span>
                </div>
              )}
            </div>
            {facts.sources.length > 0 && (
              <>
                <h4 className="legend__subsection-title">Where the shape came from</h4>
                <div className="legend__items legend__items--sources">
                  {facts.sources.map((source) => (
                    <div className="legend__item" key={source}>
                      <span className={`legend__badge legend__badge--source legend__badge--source-${source}`}>
                        {sourceLabel[source]}
                      </span>
                      <span className="legend__item-desc">{sourceDesc[source]}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {/* Column badges and symbols. */}
        {(anyKeys || facts.scd || facts.additive) && (
          <section className="legend__section">
            <h3 className="legend__section-title">Columns</h3>
            {anyKeys && (
              <div className="legend__items legend__items--badges">
                {facts.keys.pk && (
                  <div className="legend__item">
                    <span className="legend__badge legend__badge--pk">PK</span>
                    <span className="legend__item-desc">Primary key</span>
                  </div>
                )}
                {facts.keys.fk && (
                  <div className="legend__item">
                    <span className="legend__badge legend__badge--fk">FK</span>
                    <span className="legend__item-desc">Foreign key</span>
                  </div>
                )}
                {facts.keys.nk && (
                  <div className="legend__item">
                    <span className="legend__badge legend__badge--nk">NK</span>
                    <span className="legend__item-desc">Natural key</span>
                  </div>
                )}
              </div>
            )}
            {(facts.scd || facts.additive) && (
              <div className={`legend__items legend__items--symbols${anyKeys ? '' : ' legend__items--first'}`}>
                {facts.scd && (
                  <div className="legend__item">
                    <span className="legend__symbols legend__symbols--scd">
                      {[0, 1, 2].map((t) => (
                        <span key={t} title={SCD_TITLE[t]}>{SCD_BADGE[t]}</span>
                      ))}
                    </span>
                    <span className="legend__item-desc">SCD type &mdash; fixed / overwritten / new row per change</span>
                  </div>
                )}
                {facts.additive && (
                  <div className="legend__item">
                    <span className="legend__symbols legend__symbols--additive">
                      {Object.keys(ADDITIVE_BADGE).map((a) => (
                        <span key={a} title={ADDITIVE_TITLE[a]}>{ADDITIVE_BADGE[a]}</span>
                      ))}
                    </span>
                    <span className="legend__item-desc">Additive / semi-additive / non-additive measure</span>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Relationship lines: their ends, flow, labels and colours. */}
        {linesShown && (
          <section className="legend__section">
            <h3 className="legend__section-title">Relationships</h3>
            <div className="legend__items legend__items--cardinality">
              {CARDINALITY_ROWS.filter((r) => facts.cardinalities.includes(r.cardinality)).map((r) => (
                <div className="legend__item" key={r.cardinality}>
                  <div className="legend__cardinality">
                    {cardinalityLabel(r.from)}
                    {cardinalityLine()}
                    {cardinalityLabel(r.to)}
                  </div>
                  <span className="legend__item-desc">{r.desc}</span>
                </div>
              ))}
            </div>
            {(facts.roles || facts.composite || facts.backwards || facts.xray) && (
              <div className="legend__items legend__items--marks">
                {facts.roles && (
                  <div className="legend__item">
                    <span className="legend__sample"><span className="legend__role-sample">role</span></span>
                    <span className="legend__item-desc">Text on a line: what the link means</span>
                  </div>
                )}
                {facts.composite && (
                  <div className="legend__item">
                    <span className="legend__sample"><span className="legend__composite-sample">⧉ 2</span></span>
                    <span className="legend__item-desc">A composite key: one line, 2 column pairs</span>
                  </div>
                )}
                {facts.backwards && (
                  <div className="legend__item">
                    <span className="legend__sample"><span className="legend__backwards-sample" aria-hidden="true">&#x26A0;</span></span>
                    <span className="legend__item-desc">Probably drawn backwards &mdash; hover it to turn it round</span>
                  </div>
                )}
                {facts.xray && (
                  <div className="legend__item">
                    <span className="legend__sample">
                      <svg className="legend__edge-sample" viewBox="0 0 48 8" aria-hidden="true">
                        <line x1="0" y1="4" x2="48" y2="4" className="legend__edge legend__edge--xray" />
                      </svg>
                    </span>
                    <span className="legend__item-desc">Faint and dashed: the line passes under a table</span>
                  </div>
                )}
              </div>
            )}
            {flowSamples.length > 0 && (
              <>
                <h4 className="legend__subsection-title">Hover or click a table</h4>
                <div className="legend__items legend__items--flow">
                  {flowSamples.map(({ mode, from, to, desc }) => (
                    <div className="legend__item" key={mode}>
                      <div className="legend__cardinality">
                        {cardinalityLabel(from)}
                        <svg className="legend__flow-line" viewBox="0 0 48 12" aria-hidden="true">
                          <path d={FLOW_SAMPLE_PATH} className="legend__edge legend__edge--logical" />
                          <EdgeFlowGlyphs d={FLOW_SAMPLE_PATH} mode={mode} animate statusKey="logical" />
                        </svg>
                        {cardinalityLabel(to)}
                      </div>
                      <span className="legend__item-desc">{desc}</span>
                    </div>
                  ))}
                  {facts.litColour && (
                    <div className="legend__item">
                      <svg
                        className="legend__edge-sample"
                        viewBox="0 0 48 8"
                        aria-hidden="true"
                        style={{ '--legend-lit-color': facts.litColour } as CSSProperties}
                      >
                        <line x1="0" y1="4" x2="22" y2="4" className="legend__edge legend__edge--rest" />
                        <line x1="26" y1="4" x2="48" y2="4" className="legend__edge legend__edge--lit" />
                      </svg>
                      <span className="legend__item-desc">Its lines light up in the layer&apos;s colour</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        )}

        {/* Notes */}
        {facts.notes && (
          <section className="legend__section">
            <h3 className="legend__section-title">Notes</h3>
            <div className="legend__items">
              <div className="legend__item">
                <div className="legend__annotation-card" />
                <span className="legend__item-desc">A note on the canvas</span>
              </div>
              {facts.linkedNotes && (
                <div className="legend__item">
                  <svg className="legend__edge-sample" viewBox="0 0 48 8" aria-hidden="true">
                    <line x1="0" y1="4" x2="48" y2="4" className="legend__edge legend__edge--annotation" />
                  </svg>
                  <span className="legend__item-desc">Note linked to a table</span>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Comparing stages — only while a comparison is open (never in the viewer). */}
        {facts.comparing && (
          <section className="legend__section">
            <h3 className="legend__section-title">Comparing Stages</h3>
            <div className="legend__items">
              <div className="legend__item">
                <span className="legend__swatch legend__swatch--extra" />
                <span className="legend__item-desc">
                  Amber &mdash; only in the stage you are viewing (<code>only here</code>)
                </span>
              </div>
              <div className="legend__item">
                <span className="legend__swatch legend__swatch--mismatch" />
                <span className="legend__item-desc">Red &mdash; declared differently in each stage</span>
              </div>
              <div className="legend__item">
                <span className="legend__swatch legend__swatch--missing" />
                <span className="legend__item-desc">
                  Grey, struck through &mdash; only in the stage being compared against
                </span>
              </div>
            </div>
            <h4 className="legend__subsection-title">Relationship lines</h4>
            <div className="legend__items legend__items--disc-edges">
              <div className="legend__item">
                <svg className="legend__edge-sample" viewBox="0 0 48 8" aria-hidden="true">
                  <line x1="0" y1="4" x2="48" y2="4" className="legend__edge legend__edge--disc-extra" />
                </svg>
                <span className="legend__item-desc">Only in this stage</span>
              </div>
              <div className="legend__item">
                <svg className="legend__edge-sample" viewBox="0 0 48 8" aria-hidden="true">
                  <line x1="0" y1="4" x2="48" y2="4" className="legend__edge legend__edge--disc-missing" />
                </svg>
                <span className="legend__item-desc">Only in the compared stage</span>
              </div>
              <div className="legend__item">
                <svg className="legend__edge-sample" viewBox="0 0 48 8" aria-hidden="true">
                  <line x1="0" y1="4" x2="48" y2="4" className="legend__edge legend__edge--disc-mismatch" />
                </svg>
                <span className="legend__item-desc">Cardinality differs (<code>!</code> at the midpoint)</span>
              </div>
            </div>
          </section>
        )}
      </div>
    </Panel>
  );
}
