/**
 * StatusBar — the diagram's counts at the bottom-left of the canvas, and a key
 * to its layers: "5 tables | 4 relationships | [GLD] Gold 4  [SLV] Silver 1".
 *
 * Relationships are counted as the canvas draws them: a composite foreign key
 * is one line, so one relationship, however many column pairs it has.
 *
 * The key appears once the tables' own layers are known (DBML storage), so a
 * diagram that borrows tables from other layers says which, with the badge
 * each table's header carries. A single-layer project has no key.
 *
 * Shared by the extension's editor and the viewer (`ErdCanvas`): it only reads
 * the store's domain, posts nothing and offers nothing to click. Render it as
 * a child of `<ReactFlow>` (it is a React Flow `Panel`, beside the legend's
 * `?` button). In the viewer it stays in sight while the legend is open, to
 * the legend's right, and wraps rather than running under the minimap.
 */

import { useMemo } from 'react';
import { Panel } from '@xyflow/react';
import type { DisplaySubjectArea } from '@erd-studio/core';

import { useEditorStore } from '../../store/editorStore';
import { useIsViewer } from '../../host/canvasEnvironment';
import { foldComposites } from '../../lib/relationshipDisplayKey';
import { isSingleLayerProject, layerAbbreviation } from '../../lib/layerCues';
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
  const relationships = foldComposites(domain.relationships ?? []).length;

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

  const stats = useMemo(() => (domain ? statusBarStats(domain) : null), [domain]);

  if (!stats) {
    return null;
  }

  const { tables, relationships, layers } = stats;

  return (
    <Panel
      position="bottom-left"
      className={viewer ? `status-bar status-bar--viewer${legendOpen ? ' status-bar--beside-legend' : ''}` : 'status-bar'}
    >
      <span className="status-bar__item">{counted(tables, 'table')}</span>
      <span className="status-bar__divider">|</span>
      <span className="status-bar__item">{counted(relationships, 'relationship')}</span>
      {layers.length > 0 && (
        <>
          <span className="status-bar__divider">|</span>
          <span className="status-bar__layers" title="The layers this diagram's tables belong to. Each table's header strip and badge are drawn in its layer's colour.">
            {layers.map((l) => (
              <span key={l.id} className="status-bar__layer">
                <span
                  className="status-bar__badge"
                  style={l.color ? { backgroundColor: `${l.color}33`, color: l.color } : undefined}
                >
                  {l.abbreviation}
                </span>
                {l.label} {l.count}
              </span>
            ))}
          </span>
        </>
      )}
    </Panel>
  );
}
