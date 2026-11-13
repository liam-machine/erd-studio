/**
 * StatusBar — the diagram's counts at the bottom-left of the canvas, and a key
 * to its layers: "5 tables | 4 relationships | [GLD] Gold 4  [SLV] Silver 1".
 *
 * Relationships are counted as the canvas draws them: a composite foreign key
 * is one line, so one relationship, however many column pairs it has, and a
 * relationship whose other end is not on the diagram is not drawn, so not
 * counted.
 *
 * The key appears once the tables' own layers are known (DBML storage), so a
 * diagram that borrows tables from other layers says which, with the badge
 * each table's header carries. A single-layer project has no key.
 *
 * Shared by the extension's editor and the viewer (`ErdCanvas`): it only reads
 * the store's domain, posts nothing and offers nothing to click. Render it as
 * a child of `<ReactFlow>` (it is a React Flow `Panel`, beside the legend's
 * `?` button). While the legend is open it moves to the legend's right, and
 * is hidden while the legend is open on a canvas too narrow for both.
 *
 * It is always one line. Its room is what the canvas leaves between the ?
 * button (or the open legend) and the minimap / the editor's detail panel
 * (`lib/canvasChrome.ts`); when that is short it drops, in order, the layer
 * names (badges and counts stay), then layer badges into a "+N", then the
 * layer key, keeping the two counts, and truncates them only as a last
 * resort (`fitStatusBar`). What it drops is in its tooltip.
 */

import { useMemo } from 'react';
import { Panel } from '@xyflow/react';
import type { DisplaySubjectArea } from '@erd-studio/core';

import { useEditorStore } from '../../store/editorStore';
import { useIsViewer } from '../../host/canvasEnvironment';
import { foldComposites } from '../../lib/relationshipDisplayKey';
import { isSingleLayerProject, layerAbbreviation } from '../../lib/layerCues';
import { fitStatusBar } from '../../lib/canvasChrome';
import { useCanvasChrome } from '../../canvas/useCanvasChrome';
import './StatusBar.css';

// ---------------------------------------------------------------------------
// Counts (pure)
// ---------------------------------------------------------------------------

/** One entry of the layer key. */
export interface StatusBarLayer {
  id: string;
  count: number;
  abbreviation: string;
  label: string;
  color?: string;
}

/** What the status bar shows for a domain. */
export interface StatusBarStats {
  tables: number;
  /** One per line on the canvas: a composite's column pairs fold into one. */
  relationships: number;
  /** Empty in a single-layer project. */
  layers: StatusBarLayer[];
}

/**
 * The status bar's counts for a domain: its tables, its relationships as the
 * canvas draws them, and each layer its tables belong to with its count (the
 * diagram's own layer first, then `layerConfigs` order, then by name).
 */
export function statusBarStats(
  domain: Pick<DisplaySubjectArea, 'models' | 'relationships' | 'layer' | 'layerConfigs'>,
): StatusBarStats {
  const models = domain.models ?? [];
  const tables = models.length;
  // Only the lines the canvas draws: both ends on the diagram (the graph
  // transformer's filter, by exact name).
  const names = new Set(models.map((m) => m.name));
  const relationships = foldComposites(domain.relationships ?? [])
    .filter((rel) => names.has(rel.fromModel) && names.has(rel.toModel)).length;

  const counts = new Map<string, number>();
  for (const model of models) {
    if (model.layer) counts.set(model.layer, (counts.get(model.layer) ?? 0) + 1);
  }
  const configs = domain.layerConfigs ?? [];
  const rank = (id: string): number => {
    if (id === domain.layer) return -1;
    const i = configs.findIndex((l) => l.id === id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const layers = isSingleLayerProject(domain) ? [] : [...counts.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([id, count]) => {
      const config = configs.find((l) => l.id === id);
      return { id, count, abbreviation: layerAbbreviation(id, config), label: config?.label ?? id, color: config?.color };
    });

  return { tables, relationships, layers };
}

/** "5 tables", "1 relationship". */
function counted(n: number, noun: string): string {
  return `${n} ${noun}${n !== 1 ? 's' : ''}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StatusBar() {
  const domain = useEditorStore((s) => s.domain);
  const legendOpen = useEditorStore((s) => s.legendOpen);
  const viewer = useIsViewer();
  const { statusBarLeft, statusBarRoom } = useCanvasChrome();

  const stats = useMemo(() => (domain ? statusBarStats(domain) : null), [domain]);
  // Beside the open legend (it covers the corner) in the editor and the viewer.
  const besideLegend = legendOpen;
  const tablesText = stats ? counted(stats.tables, 'table') : '';
  const relationshipsText = stats ? counted(stats.relationships, 'relationship') : '';
  const fit = useMemo(
    () => (stats ? fitStatusBar({ tables: tablesText, relationships: relationshipsText }, stats.layers, statusBarRoom, besideLegend) : null),
    [stats, tablesText, relationshipsText, statusBarRoom, besideLegend],
  );

  if (!stats || !fit || fit.mode === 'hidden') {
    return null;
  }

  const { layers } = stats;
  const shown = layers.slice(0, fit.shownLayers);
  const hidden = layers.slice(fit.shownLayers);
  const named = fit.mode === 'full';
  const layerKey = (l: StatusBarLayer) => `${l.label} (${l.abbreviation}): ${counted(l.count, 'table')}`;
  // Whatever the pill leaves out is in its tooltip.
  const title = fit.mode === 'full' || layers.length === 0
    ? undefined
    : [`${tablesText}, ${relationshipsText}`, ...layers.map(layerKey)].join('\n');

  return (
    <Panel
      position="bottom-left"
      className={viewer ? `status-bar status-bar--viewer${besideLegend ? ' status-bar--beside-legend' : ''}` : 'status-bar'}
      data-fit={fit.mode}
      title={title}
      style={{ marginLeft: statusBarLeft, ...(statusBarRoom !== null ? { maxWidth: statusBarRoom } : {}) }}
    >
      <span className="status-bar__counts">
        <span className="status-bar__item">{tablesText}</span>
        <span className="status-bar__divider">|</span>
        <span className="status-bar__item">{relationshipsText}</span>
      </span>
      {shown.length > 0 && (
        <>
          <span className="status-bar__divider status-bar__divider--layers">|</span>
          <span
            className="status-bar__layers"
            title={named ? 'The layers this diagram\'s tables belong to. Each table\'s header strip and badge are drawn in its layer\'s colour.' : undefined}
          >
            {shown.map((l) => (
              <span key={l.id} className="status-bar__layer" title={named ? undefined : layerKey(l)}>
                <span
                  className="status-bar__badge"
                  style={l.color ? { backgroundColor: `${l.color}33`, color: l.color } : undefined}
                >
                  {l.abbreviation}
                </span>
                {named ? `${l.label} ${l.count}` : l.count}
              </span>
            ))}
            {hidden.length > 0 && (
              <span className="status-bar__more" title={hidden.map(layerKey).join('\n')}>
                +{hidden.length}
              </span>
            )}
          </span>
        </>
      )}
    </Panel>
  );
}
