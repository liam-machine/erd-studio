/**
 * DetailPanel — floating detail view for the selected model.
 *
 * Displays at top-right when a node is clicked. Shows:
 * - Model metadata (name, schema, description)
 * - Editable column list
 * - Incoming and outgoing FK relationships
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from '@xyflow/react';

import { ModelRationale } from './ModelRationale';
import { GrainEditor } from './GrainEditor';
import { RoleEditor } from './RoleEditor';
import { ColumnEditor } from './ColumnEditor';
import { useEditorStore } from '../../store/editorStore';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import type { DisplayRelationship } from '../../../src/types/display';
import type { FkEdgeData } from '../../types/graph';
import './DetailPanel.css';

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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [nameError, setNameError] = useState('');

  // Handle pending delete confirmation from keyboard shortcut
  useEffect(() => {
    if (pendingDeleteConfirmation && detailPanelOpen) {
      setConfirmingDelete(true);
      setPendingDeleteConfirmation(false);
    }
  }, [pendingDeleteConfirmation, detailPanelOpen, setPendingDeleteConfirmation]);

  // Reset rename state when selected node changes
  useEffect(() => {
    setEditingName(false);
    setNameValue('');
    setNameError('');
  }, [selectedNode]);

  const handleClose = useCallback(() => {
    setDetailPanelOpen(false);
    selectNode(null);
    setConfirmingDelete(false);
  }, [setDetailPanelOpen, selectNode]);

  const validateModelName = useCallback(
    (value: string): string => {
      const trimmed = value.trim();
      if (!trimmed) return 'Name cannot be empty';
      if (/\s/.test(trimmed)) return 'Name cannot contain spaces';
      if (!/^[a-z]/.test(trimmed)) return 'Must start with a lowercase letter';
      if (!/^[a-z][a-z0-9_]*$/.test(trimmed)) return 'Only lowercase letters, numbers, and underscores';
      if (domain && trimmed !== selectedNode && domain.models.some((m) => m.name === trimmed)) {
        return 'A model with this name already exists';
      }
      return '';
    },
    [domain, selectedNode],
  );

  const handleStartRename = useCallback(() => {
    if (!selectedNode) return;
    setNameValue(selectedNode);
    setNameError('');
    setEditingName(true);
  }, [selectedNode]);

  const handleCancelRename = useCallback(() => {
    setEditingName(false);
    setNameValue('');
    setNameError('');
  }, []);

  const handleNameChange = useCallback(
    (value: string) => {
      setNameValue(value);
      setNameError(validateModelName(value));
    },
    [validateModelName],
  );

  const handleSubmitRename = useCallback(() => {
    if (!selectedNode) return;
    const trimmed = nameValue.trim();
    if (!trimmed || trimmed === selectedNode) {
      setEditingName(false);
      setNameError('');
      return;
    }
    const error = validateModelName(nameValue);
    if (error) {
      setNameError(error);
      return;
    }
    vscode.postMessage({
      type: 'renameModel',
      payload: { oldName: selectedNode, newName: trimmed },
    });
    selectNode(trimmed);
    setEditingName(false);
    setNameError('');
  }, [selectedNode, nameValue, vscode, selectNode, validateModelName]);

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
    (rel: DisplayRelationship) => {
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

  // Open context menu when clicking a relationship row (for cardinality editing)
  const handleRelationshipClick = useCallback(
    (x: number, y: number, rel: DisplayRelationship) => {
      const edgeData: FkEdgeData = {
        fromModel: rel.fromModel,
        fromColumn: rel.fromColumn,
        toModel: rel.toModel,
        toColumn: rel.toColumn,
        cardinality: rel.cardinality,
      };
      openEdgeContextMenu(x, y, edgeData);
    },
    [openEdgeContextMenu],
  );

  // Find the selected model
  const model = useMemo(() => {
    if (!domain || !selectedNode) return null;
    return domain.models.find((m) => m.name === selectedNode) ?? null;
  }, [domain, selectedNode]);

  // Find relationships (both directions)
  const relationships = useMemo(() => {
    if (!domain || !selectedNode) {
      return { outgoing: [] as DisplayRelationship[], incoming: [] as DisplayRelationship[] };
    }
    const outgoing = domain.relationships.filter((r) => r.fromModel === selectedNode);
    const incoming = domain.relationships.filter((r) => r.toModel === selectedNode);
    return { outgoing, incoming };
  }, [domain, selectedNode]);

  const isReadOnly = domain?.readOnly ?? false;

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
        {editingName ? (
          <div className="detail-panel__title-edit">
            <input
              className={`detail-panel__title-input${nameError ? ' detail-panel__title-input--error' : ''}`}
              value={nameValue}
              onChange={(e) => handleNameChange(e.target.value)}
              onBlur={() => {
                if (nameError) {
                  handleCancelRename();
                } else {
                  handleSubmitRename();
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSubmitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  handleCancelRename();
                }
              }}
              autoFocus
              spellCheck={false}
            />
            {nameError && (
              <span className="detail-panel__title-error">{nameError}</span>
            )}
          </div>
        ) : (
          <h3
            className={`detail-panel__title${!isReadOnly ? ' detail-panel__title--editable' : ''}`}
            title={!isReadOnly ? 'Double-click to rename' : model.name}
            onDoubleClick={!isReadOnly ? handleStartRename : undefined}
          >
            {model.name}
          </h3>
        )}
        {!isReadOnly && !editingName && (
          <button
            className="detail-panel__title-edit-btn"
            onClick={handleStartRename}
            title="Rename model"
            aria-label="Rename model"
          >
            ✎
          </button>
        )}
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
        </div>
        {model.description && (
          <p className="detail-panel__description">{model.description}</p>
        )}
      </div>

      {/* Model role */}
      {!isReadOnly && (
        <div className="detail-panel__section">
          <RoleEditor modelName={model.name} modelRole={model.modelRole} />
        </div>
      )}

      {/* Grain statement */}
      {!isReadOnly && (
        <div className="detail-panel__section">
          <GrainEditor modelName={model.name} grain={model.grain} />
        </div>
      )}

      {/* Design Rationale */}
      <div className="detail-panel__section">
        <ModelRationale
          modelName={model.name}
          rationale={model.rationale}
          modelRole={model.modelRole}
          grain={model.grain}
        />
      </div>

      {/* Remove from Domain button */}
      {!isReadOnly && (
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
          columns={model.columns}
          readOnly={isReadOnly}
          modelRole={model.modelRole}
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
                className="detail-panel__relationship detail-panel__relationship--clickable"
                onClick={(e) => handleRelationshipClick(e.clientX, e.clientY, rel)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
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
                {!isReadOnly && (
                  <button
                    className="detail-panel__rel-delete"
                    onClick={(e) => {
                      e.stopPropagation();
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
                className="detail-panel__relationship detail-panel__relationship--clickable"
                onClick={(e) => handleRelationshipClick(e.clientX, e.clientY, rel)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
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
                {!isReadOnly && (
                  <button
                    className="detail-panel__rel-delete"
                    onClick={(e) => {
                      e.stopPropagation();
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
