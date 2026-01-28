/**
 * DetailPanel — floating detail view for the selected model.
 *
 * Displays at top-right when a node is clicked. Shows:
 * - Model metadata (name, schema, status, description)
 * - Column list with PK/FK indicators and data types
 * - Incoming and outgoing FK relationships
 *
 * Read-only in Phase 1 (F113). Editing will be added in Phase 2 (F203).
 */

import { useCallback, useMemo } from 'react';
import { Panel } from '@xyflow/react';

import { useEditorStore } from '../../store/editorStore';
import type { ReconciledRelationship } from '../../../src/types/reconciled';
import './DetailPanel.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = {
  built: 'Built',
  design: 'Design',
  missing: 'Missing',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DetailPanel() {
  const domain = useEditorStore((s) => s.domain);
  const selectedNode = useEditorStore((s) => s.selectedNode);
  const detailPanelOpen = useEditorStore((s) => s.detailPanelOpen);
  const selectNode = useEditorStore((s) => s.selectNode);
  const setDetailPanelOpen = useEditorStore((s) => s.setDetailPanelOpen);

  const handleClose = useCallback(() => {
    setDetailPanelOpen(false);
    selectNode(null);
  }, [setDetailPanelOpen, selectNode]);

  // Find the selected model
  const model = useMemo(() => {
    if (!domain || !selectedNode) return null;
    return domain.models.find((m) => m.name === selectedNode) ?? null;
  }, [domain, selectedNode]);

  // Find relationships (both directions)
  const relationships = useMemo(() => {
    if (!domain || !selectedNode) {
      return { outgoing: [] as ReconciledRelationship[], incoming: [] as ReconciledRelationship[] };
    }
    const outgoing = domain.relationships.filter((r) => r.fromModel === selectedNode);
    const incoming = domain.relationships.filter((r) => r.toModel === selectedNode);
    return { outgoing, incoming };
  }, [domain, selectedNode]);

  // --- Early returns -----------------------------------------------------

  if (!detailPanelOpen || !selectedNode || !domain) {
    return null;
  }

  if (!model) {
    return null;
  }

  const { outgoing, incoming } = relationships;
  const totalRelationships = outgoing.length + incoming.length;

  // --- Render ------------------------------------------------------------

  return (
    <Panel position="top-right" className="detail-panel">
      {/* Header */}
      <div className="detail-panel__header">
        <h3 className="detail-panel__title" title={model.name}>
          {model.name}
        </h3>
        <button
          className="detail-panel__close"
          onClick={handleClose}
          title="Close detail panel"
          aria-label="Close detail panel"
        >
          ×
        </button>
      </div>

      {/* Metadata */}
      <div className="detail-panel__section">
        <div className="detail-panel__metadata">
          <div className="detail-panel__metadata-row">
            <span className="detail-panel__label">Schema</span>
            <span className="detail-panel__value">{model.schema || '—'}</span>
          </div>
          <div className="detail-panel__metadata-row">
            <span className="detail-panel__label">Status</span>
            <span className={`detail-panel__status-badge detail-panel__status-badge--${model.status}`}>
              {STATUS_LABEL[model.status] ?? model.status}
            </span>
          </div>
        </div>
        {model.description && (
          <p className="detail-panel__description">{model.description}</p>
        )}
      </div>

      {/* Columns */}
      <div className="detail-panel__section">
        <h4 className="detail-panel__section-title">
          Columns ({model.columns.length})
        </h4>
        <div className="detail-panel__columns">
          {model.columns.length === 0 ? (
            <div className="detail-panel__empty">No columns</div>
          ) : (
            model.columns.map((col) => (
              <div
                key={col.name}
                className={`detail-panel__column detail-panel__column--${col.status}`}
                title={col.description || undefined}
              >
                <span className="detail-panel__col-indicators">
                  {col.isPrimaryKey && (
                    <span className="detail-panel__pk" title="Primary Key">
                      PK
                    </span>
                  )}
                  {col.isForeignKey && (
                    <span className="detail-panel__fk" title="Foreign Key">
                      FK
                    </span>
                  )}
                </span>
                <span className="detail-panel__col-name">{col.name}</span>
                <span className="detail-panel__col-type">{col.dataType}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Relationships */}
      {totalRelationships > 0 && (
        <div className="detail-panel__section">
          <h4 className="detail-panel__section-title">
            Relationships ({totalRelationships})
          </h4>
          <div className="detail-panel__relationships">
            {/* Outgoing: this model references others */}
            {outgoing.map((rel) => (
              <div
                key={`out-${rel.fromColumn}-${rel.toModel}-${rel.toColumn}`}
                className={`detail-panel__relationship detail-panel__relationship--${rel.status}`}
              >
                <span className="detail-panel__rel-direction" title="Outgoing FK">
                  →
                </span>
                <span className="detail-panel__rel-columns">
                  <span className="detail-panel__rel-local">{rel.fromColumn}</span>
                  <span className="detail-panel__rel-arrow">→</span>
                  <span className="detail-panel__rel-target">
                    {rel.toModel}.{rel.toColumn}
                  </span>
                </span>
                <span className="detail-panel__rel-cardinality">
                  {rel.cardinality}
                </span>
              </div>
            ))}
            {/* Incoming: others reference this model */}
            {incoming.map((rel) => (
              <div
                key={`in-${rel.fromModel}-${rel.fromColumn}-${rel.toColumn}`}
                className={`detail-panel__relationship detail-panel__relationship--${rel.status}`}
              >
                <span className="detail-panel__rel-direction" title="Incoming FK">
                  ←
                </span>
                <span className="detail-panel__rel-columns">
                  <span className="detail-panel__rel-target">
                    {rel.fromModel}.{rel.fromColumn}
                  </span>
                  <span className="detail-panel__rel-arrow">→</span>
                  <span className="detail-panel__rel-local">{rel.toColumn}</span>
                </span>
                <span className="detail-panel__rel-cardinality">
                  {rel.cardinality}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
