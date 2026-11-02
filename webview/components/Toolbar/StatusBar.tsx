/**
 * StatusBar — the diagram's counts at the bottom of the editor, and a key to
 * its layers: "5 tables | 4 relationships | [GLD] Gold 4  [SLV] Silver 1".
 *
 * Relationships are counted as the canvas draws them: a composite foreign key
 * is one line, so one relationship, however many column pairs it has.
 *
 * The key appears once the tables' own layers are known (DBML storage), so a
 * diagram that borrows tables from other layers says which, with the badge
 * each table's header carries. A single-layer project has no key.
 */

import { useMemo } from 'react';
import { Panel } from '@xyflow/react';
import { foldComposites, isSingleLayerProject, layerAbbreviation } from '@erd-studio/renderer/editor';

import { useEditorStore } from '../../store/editorStore';
import './StatusBar.css';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StatusBar() {
  const domain = useEditorStore((s) => s.domain);

  const stats = useMemo(() => {
    if (!domain) {
      return null;
    }

    const totalModels = domain.models.length;
    // One per line on the canvas: a composite's column pairs fold into one.
    const totalRelationships = foldComposites(domain.relationships).length;

    // Each layer the tables belong to, with its count: the diagram's own layer first, then layers.json order.
    const counts = new Map<string, number>();
    for (const model of domain.models) {
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

    return { totalModels, totalRelationships, layers };
  }, [domain]);

  if (!stats) {
    return null;
  }

  const { totalModels, totalRelationships, layers } = stats;

  const modelText = `${totalModels} table${totalModels !== 1 ? 's' : ''}`;

  // Build relationship count string
  const relationshipText = `${totalRelationships} relationship${totalRelationships !== 1 ? 's' : ''}`;

  return (
    <Panel position="bottom-left" className="status-bar">
      <span className="status-bar__item">{modelText}</span>
      <span className="status-bar__divider">|</span>
      <span className="status-bar__item">{relationshipText}</span>
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
