/**
 * AddExistingModelDialog — dialog for adding existing manifest models to a domain.
 *
 * Displays a searchable list of models from the dbt manifest that are not yet
 * in the current domain. Selecting a model sends the `addExistingModel` message
 * to the extension host, which adds it with source: 'repo'.
 */

import { useCallback, useMemo, useState } from 'react';
import { Panel } from '@xyflow/react';

import { useEditorStore } from '../../store/editorStore';
import { useMessageBus } from '../../hooks/useMessageBus';
import type { ManifestModelPreview } from '../../../src/types/reconciled';
import './AddExistingModelDialog.css';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AddExistingModelDialog() {
  const isOpen = useEditorStore((s) => s.addExistingModelDialogOpen);
  const setAddExistingModelDialogOpen = useEditorStore((s) => s.setAddExistingModelDialogOpen);
  const manifestModels = useEditorStore((s) => s.manifestModels);
  const { send } = useMessageBus(() => {});

  // Local state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  // Filter models by search query (case-insensitive substring match)
  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) {
      return manifestModels;
    }
    const query = searchQuery.toLowerCase();
    return manifestModels.filter(
      (m) =>
        m.name.toLowerCase().includes(query) ||
        m.schema.toLowerCase().includes(query) ||
        m.description.toLowerCase().includes(query),
    );
  }, [manifestModels, searchQuery]);

  // Handlers
  const handleClose = useCallback(() => {
    setAddExistingModelDialogOpen(false);
    setSearchQuery('');
    setSelectedModel(null);
  }, [setAddExistingModelDialogOpen]);

  const handleSelect = useCallback((modelName: string) => {
    setSelectedModel(modelName);
  }, []);

  const handleAdd = useCallback(() => {
    if (!selectedModel) return;

    send({
      type: 'addExistingModel',
      payload: { modelName: selectedModel },
    });

    handleClose();
  }, [selectedModel, send, handleClose]);

  const handleDoubleClick = useCallback(
    (modelName: string) => {
      send({
        type: 'addExistingModel',
        payload: { modelName },
      });
      handleClose();
    },
    [send, handleClose],
  );

  // Early return if dialog is closed
  if (!isOpen) {
    return null;
  }

  // Empty state: no manifest models available
  if (manifestModels.length === 0) {
    return (
      <Panel position="top-center" className="add-existing-model-dialog">
        <div className="add-existing-model-dialog__header">
          <h3 className="add-existing-model-dialog__title">Add Existing Model</h3>
          <button
            className="add-existing-model-dialog__close"
            onClick={handleClose}
            title="Close dialog"
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
        <div className="add-existing-model-dialog__content">
          <div className="add-existing-model-dialog__empty">
            <p>No manifest models available.</p>
            <p className="add-existing-model-dialog__empty-hint">
              Run <code>dbt compile</code> to generate the manifest, or all models may already be in this domain.
            </p>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel position="top-center" className="add-existing-model-dialog">
      {/* Header */}
      <div className="add-existing-model-dialog__header">
        <h3 className="add-existing-model-dialog__title">Add Existing Model</h3>
        <button
          className="add-existing-model-dialog__close"
          onClick={handleClose}
          title="Close dialog"
          aria-label="Close dialog"
        >
          ×
        </button>
      </div>

      {/* Content */}
      <div className="add-existing-model-dialog__content">
        {/* Search */}
        <div className="add-existing-model-dialog__search">
          <input
            type="text"
            className="add-existing-model-dialog__search-input"
            placeholder="Search models..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
          />
          <span className="add-existing-model-dialog__search-count">
            {filteredModels.length} of {manifestModels.length}
          </span>
        </div>

        {/* Model List */}
        <div className="add-existing-model-dialog__list">
          {filteredModels.length === 0 ? (
            <div className="add-existing-model-dialog__no-results">
              No models match "{searchQuery}"
            </div>
          ) : (
            filteredModels.map((model) => (
              <ModelItem
                key={model.name}
                model={model}
                isSelected={selectedModel === model.name}
                onSelect={handleSelect}
                onDoubleClick={handleDoubleClick}
              />
            ))
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="add-existing-model-dialog__footer">
        <button
          className="add-existing-model-dialog__button add-existing-model-dialog__button--secondary"
          onClick={handleClose}
        >
          Cancel
        </button>
        <button
          className="add-existing-model-dialog__button add-existing-model-dialog__button--primary"
          onClick={handleAdd}
          disabled={!selectedModel}
        >
          Add Model
        </button>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// ModelItem subcomponent
// ---------------------------------------------------------------------------

interface ModelItemProps {
  model: ManifestModelPreview;
  isSelected: boolean;
  onSelect: (name: string) => void;
  onDoubleClick: (name: string) => void;
}

function ModelItem({ model, isSelected, onSelect, onDoubleClick }: ModelItemProps) {
  const handleClick = useCallback(() => {
    onSelect(model.name);
  }, [onSelect, model.name]);

  const handleDblClick = useCallback(() => {
    onDoubleClick(model.name);
  }, [onDoubleClick, model.name]);

  return (
    <div
      className={`add-existing-model-dialog__item ${isSelected ? 'add-existing-model-dialog__item--selected' : ''}`}
      onClick={handleClick}
      onDoubleClick={handleDblClick}
      role="option"
      aria-selected={isSelected}
    >
      <div className="add-existing-model-dialog__item-main">
        <span className="add-existing-model-dialog__item-name">{model.name}</span>
        <span className="add-existing-model-dialog__item-schema">{model.schema}</span>
      </div>
      <div className="add-existing-model-dialog__item-meta">
        <span className="add-existing-model-dialog__item-columns">
          {model.columnCount} column{model.columnCount !== 1 ? 's' : ''}
        </span>
        {model.description && (
          <span className="add-existing-model-dialog__item-desc" title={model.description}>
            {model.description.length > 60 ? model.description.slice(0, 60) + '…' : model.description}
          </span>
        )}
      </div>
    </div>
  );
}
