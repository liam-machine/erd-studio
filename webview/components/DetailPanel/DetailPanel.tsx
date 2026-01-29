/**
 * DetailPanel — floating detail view for the selected model.
 *
 * Displays at top-right when a node is clicked. Shows:
 * - Model metadata (name, schema, status, description)
 * - Editable column list (Phase 2 F202)
 * - Incoming and outgoing FK relationships
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from '@xyflow/react';

import { ColumnEditor } from './ColumnEditor';
import { useEditorStore } from '../../store/editorStore';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
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
  const vscode = useVsCodeApi();
  const domain = useEditorStore((s) => s.domain);
  const selectedNode = useEditorStore((s) => s.selectedNode);
  const detailPanelOpen = useEditorStore((s) => s.detailPanelOpen);
  const selectNode = useEditorStore((s) => s.selectNode);
  const setDetailPanelOpen = useEditorStore((s) => s.setDetailPanelOpen);
  const pendingDeleteConfirmation = useEditorStore((s) => s.pendingDeleteConfirmation);
  const setPendingDeleteConfirmation = useEditorStore((s) => s.setPendingDeleteConfirmation);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Handle pending delete confirmation from keyboard shortcut
  useEffect(() => {
    if (pendingDeleteConfirmation && detailPanelOpen) {
      setConfirmingDelete(true);
      setPendingDeleteConfirmation(false);
    }
  }, [pendingDeleteConfirmation, detailPanelOpen, setPendingDeleteConfirmation]);

  const handleClose = useCallback(() => {
    setDetailPanelOpen(false);
    selectNode(null);
    setConfirmingDelete(false);
  }, [setDetailPanelOpen, selectNode]);

  const handleDeleteModel = useCallback(() => {
    if (!selectedNode) return;
    vscode.postMessage({
      type: 'removeModel',
      payload: { modelName: selectedNode },
    });
    setConfirmingDelete(false);
    handleClose();
  }, [selectedNode, vscode, handleClose]);

  const handleDeleteRelationship = useCallback(
    (rel: ReconciledRelationship) => {
      vscode.postMessage({
        type: 'removeRelationship',
        payload: {
          fromModel: rel.fromModel,
          fromColumn: rel.fromColumn,
          toModel: rel.toModel,
          toColumn: rel.toColumn,
        },
      });
    },
    [vscode],
  );

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

      {/* Delete Model button (design models only) */}
      {model.status === 'design' && (
        <div className="detail-panel__section detail-panel__section--actions">
          {confirmingDelete ? (
            <>
              <span className="detail-panel__confirm-label">
                Delete model{totalRelationships > 0 ? ` and ${totalRelationships} relationship(s)` : ''}?
              </span>
              <div className="detail-panel__confirm-actions">
                <button
                  className="detail-panel__button detail-panel__button--danger"
                  onClick={handleDeleteModel}
                  aria-label="Confirm delete model"
                >
                  Yes, Delete
                </button>
                <button
                  className="detail-panel__button"
                  onClick={() => setConfirmingDelete(false)}
                  aria-label="Cancel delete"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <button
              className="detail-panel__button detail-panel__button--danger"
              onClick={() => setConfirmingDelete(true)}
              title="Delete this design model"
              aria-label="Delete this design model"
            >
              Delete Model
            </button>
          )}
        </div>
      )}

      {/* Columns (editable) */}
      <div className="detail-panel__section">
        <ColumnEditor
          modelName={model.name}
          modelStatus={model.status}
          columns={model.columns}
        />
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
                {rel.status === 'design' && (
                  <button
                    className="detail-panel__rel-delete"
                    onClick={() => handleDeleteRelationship(rel)}
                    title="Delete relationship"
                    aria-label="Delete relationship"
                  >
                    ×
                  </button>
                )}
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
                {rel.status === 'design' && (
                  <button
                    className="detail-panel__rel-delete"
                    onClick={() => handleDeleteRelationship(rel)}
                    title="Delete relationship"
                    aria-label="Delete relationship"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
