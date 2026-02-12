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
import type { FkEdgeData } from '../../types/graph';
import './DetailPanel.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = {
  built: 'Built',
  approved: 'Approved',
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
  const openEdgeContextMenu = useEditorStore((s) => s.openEdgeContextMenu);
  const setDiscrepancyReviewModel = useEditorStore((s) => s.setDiscrepancyReviewModel);
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

  const handleApproveModel = useCallback(() => {
    if (!selectedNode) return;
    vscode.postMessage({
      type: 'approveModel',
      payload: { modelName: selectedNode },
    });
  }, [selectedNode, vscode]);

  const handleUnapproveModel = useCallback(() => {
    if (!selectedNode) return;
    vscode.postMessage({
      type: 'unapproveModel',
      payload: { modelName: selectedNode },
    });
  }, [selectedNode, vscode]);

  // Open context menu when clicking a relationship row (for cardinality editing)
  const handleRelationshipClick = useCallback(
    (x: number, y: number, rel: ReconciledRelationship) => {
      // Convert ReconciledRelationship to FkEdgeData shape for the context menu
      const edgeData: FkEdgeData = {
        fromModel: rel.fromModel,
        fromColumn: rel.fromColumn,
        toModel: rel.toModel,
        toColumn: rel.toColumn,
        cardinality: rel.cardinality,
        status: rel.status,
        approved: rel.approved,
      };
      // Position the context menu near the click
      openEdgeContextMenu(x, y, edgeData);
    },
    [openEdgeContextMenu],
  );

  const handleApproveRelationship = useCallback(
    (rel: ReconciledRelationship) => {
      vscode.postMessage({
        type: 'approveRelationship',
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

  const handleUnapproveRelationship = useCallback(
    (rel: ReconciledRelationship) => {
      vscode.postMessage({
        type: 'unapproveRelationship',
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

  // Check if a relationship can be approved (both models must be built or approved)
  const canApproveRelationship = useCallback(
    (rel: ReconciledRelationship): boolean => {
      if (!domain) return false;
      const fromModel = domain.models.find((m) => m.name === rel.fromModel);
      const toModel = domain.models.find((m) => m.name === rel.toModel);
      // Both models must be 'built' or 'approved' (not 'design' or 'missing')
      const isApprovable = (status: string | undefined) =>
        status === 'built' || status === 'approved';
      return isApprovable(fromModel?.status) && isApprovable(toModel?.status);
    },
    [domain],
  );

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
            {/* Approve/Unapprove button for design models */}
            {model.status === 'design' && (
              <button
                className="detail-panel__approve-btn"
                onClick={handleApproveModel}
                title="Mark model as approved for build"
              >
                Approve
              </button>
            )}
            {model.status === 'approved' && (
              <button
                className="detail-panel__approve-btn detail-panel__approve-btn--unapprove"
                onClick={handleUnapproveModel}
                title="Remove approval from model"
              >
                Unapprove
              </button>
            )}
          </div>
        </div>
        {model.description && (
          <p className="detail-panel__description">{model.description}</p>
        )}
      </div>

      {/* Remove from Domain button (design and built models) */}
      {(model.status === 'design' || model.status === 'built') && (
        <div className="detail-panel__section detail-panel__section--actions">
          {confirmingDelete ? (
            <>
              <span className="detail-panel__confirm-label">
                Remove model from domain?{totalRelationships > 0 ? ` (${totalRelationships} relationship(s) will also be removed)` : ''}
              </span>
              <div className="detail-panel__confirm-actions">
                <button
                  className="detail-panel__button detail-panel__button--danger"
                  onClick={handleDeleteModel}
                  aria-label="Confirm remove model"
                >
                  Yes, Remove
                </button>
                <button
                  className="detail-panel__button"
                  onClick={() => setConfirmingDelete(false)}
                  aria-label="Cancel"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <button
              className="detail-panel__button detail-panel__button--danger"
              onClick={() => setConfirmingDelete(true)}
              title="Remove this model from the domain"
              aria-label="Remove this model from the domain"
            >
              Remove from Domain
            </button>
          )}
        </div>
      )}

      {/* Columns (editable) */}
      <div className="detail-panel__section">
        <ColumnEditor
          modelName={model.name}
          modelStatus={model.status}
          modelApproved={model.approved}
          columns={model.columns}
          discrepancyCount={model.discrepancyCount}
        />
      </div>

      {/* Review All Discrepancies button */}
      {model.discrepancyCount && model.discrepancyCount > 0 && (
        <div className="detail-panel__section detail-panel__section--actions">
          <button
            className="detail-panel__button detail-panel__button--warning"
            onClick={() => setDiscrepancyReviewModel(model.name)}
            title="Open discrepancy review dialog"
          >
            Review All Discrepancies ({model.discrepancyCount})
          </button>
        </div>
      )}

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
                className={`detail-panel__relationship detail-panel__relationship--${rel.status} detail-panel__relationship--clickable`}
                onClick={(e) => handleRelationshipClick(e.clientX, e.clientY, rel)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    // For keyboard events, position context menu near the element
                    const rect = e.currentTarget.getBoundingClientRect();
                    handleRelationshipClick(rect.left + rect.width / 2, rect.top + rect.height / 2, rel);
                  }
                }}
                title="Click to edit cardinality"
              >
                <span className="detail-panel__rel-direction" title="Outgoing FK">
                  →
                </span>
                <span className="detail-panel__rel-columns">
                  <span className="detail-panel__rel-local" title={rel.fromColumn}>
                    {rel.fromColumn}
                  </span>
                  <span className="detail-panel__rel-arrow">→</span>
                  <span className="detail-panel__rel-target" title={`${rel.toModel}.${rel.toColumn}`}>
                    {rel.toModel}.{rel.toColumn}
                  </span>
                </span>
                <span className="detail-panel__rel-cardinality">
                  {rel.cardinality}
                </span>
                {/* Approval toggle for design/approved relationships (only if both models are ready) */}
                {(rel.status === 'design' || rel.status === 'approved') && canApproveRelationship(rel) && (
                  <button
                    className={`detail-panel__rel-approve ${rel.approved ? 'detail-panel__rel-approve--approved' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (rel.approved) {
                        handleUnapproveRelationship(rel);
                      } else {
                        handleApproveRelationship(rel);
                      }
                    }}
                    title={rel.approved ? 'Remove approval' : 'Approve relationship'}
                    aria-label={rel.approved ? 'Unapprove relationship' : 'Approve relationship'}
                  >
                    {rel.approved ? '✓' : '○'}
                  </button>
                )}
                {rel.status === 'design' && (
                  <button
                    className="detail-panel__rel-delete"
                    onClick={(e) => {
                      e.stopPropagation(); // Prevent row click from firing
                      handleDeleteRelationship(rel);
                    }}
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
                className={`detail-panel__relationship detail-panel__relationship--${rel.status} detail-panel__relationship--clickable`}
                onClick={(e) => handleRelationshipClick(e.clientX, e.clientY, rel)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    // For keyboard events, position context menu near the element
                    const rect = e.currentTarget.getBoundingClientRect();
                    handleRelationshipClick(rect.left + rect.width / 2, rect.top + rect.height / 2, rel);
                  }
                }}
                title="Click to edit cardinality"
              >
                <span className="detail-panel__rel-direction" title="Incoming FK">
                  ←
                </span>
                <span className="detail-panel__rel-columns">
                  <span className="detail-panel__rel-target" title={`${rel.fromModel}.${rel.fromColumn}`}>
                    {rel.fromModel}.{rel.fromColumn}
                  </span>
                  <span className="detail-panel__rel-arrow">→</span>
                  <span className="detail-panel__rel-local" title={rel.toColumn}>
                    {rel.toColumn}
                  </span>
                </span>
                <span className="detail-panel__rel-cardinality">
                  {rel.cardinality}
                </span>
                {/* Approval toggle for design/approved relationships (only if both models are ready) */}
                {(rel.status === 'design' || rel.status === 'approved') && canApproveRelationship(rel) && (
                  <button
                    className={`detail-panel__rel-approve ${rel.approved ? 'detail-panel__rel-approve--approved' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (rel.approved) {
                        handleUnapproveRelationship(rel);
                      } else {
                        handleApproveRelationship(rel);
                      }
                    }}
                    title={rel.approved ? 'Remove approval' : 'Approve relationship'}
                    aria-label={rel.approved ? 'Unapprove relationship' : 'Approve relationship'}
                  >
                    {rel.approved ? '✓' : '○'}
                  </button>
                )}
                {rel.status === 'design' && (
                  <button
                    className="detail-panel__rel-delete"
                    onClick={(e) => {
                      e.stopPropagation(); // Prevent row click from firing
                      handleDeleteRelationship(rel);
                    }}
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
