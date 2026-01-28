/**
 * StatusBar — displays model and relationship counts at the bottom of the editor.
 *
 * Format: "12 models (3 design) | 18 relationships"
 * Omits "(0 design)" when there are no design models.
 */

import { useMemo } from 'react';
import { Panel } from '@xyflow/react';

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
    const designModels = domain.models.filter((m) => m.status === 'design').length;
    const totalRelationships = domain.relationships.length;

    return { totalModels, designModels, totalRelationships };
  }, [domain]);

  if (!stats) {
    return null;
  }

  const { totalModels, designModels, totalRelationships } = stats;

  // Build model count string
  const modelText = designModels > 0
    ? `${totalModels} models (${designModels} design)`
    : `${totalModels} models`;

  // Build relationship count string
  const relationshipText = `${totalRelationships} relationship${totalRelationships !== 1 ? 's' : ''}`;

  return (
    <Panel position="bottom-left" className="status-bar">
      <span className="status-bar__item">{modelText}</span>
      <span className="status-bar__divider">|</span>
      <span className="status-bar__item">{relationshipText}</span>
    </Panel>
  );
}
