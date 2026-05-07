/**
 * AddExistingModelDialog — dialog for adding existing models to a domain.
 *
 * Displays a searchable, filterable list of models from three sources:
 * - Library: models with YAML definitions in erd-studio/logical-models/
 * - dbt: models defined in dbt .yml schema files
 * - Compiled: models only in compiled manifest (no .yml file)
 *
 * Each model shows its source badge, file path, and metadata.
 * Filter chips let the user show/hide each source type.
 */

import { useCallback, useMemo, useState } from 'react';
import { Panel } from '@xyflow/react';

import { useEditorStore } from '../../store/editorStore';
import { useMessageBus } from '../../hooks/useMessageBus';
import type { ExistingModelPreview, ManifestModelPreview } from '../../../src/types/display';
import './AddExistingModelDialog.css';

// ---------------------------------------------------------------------------
// Source configuration
// ---------------------------------------------------------------------------

type SourceKey = 'logical' | 'yml' | 'manifest';

const SOURCE_CONFIG: Record<SourceKey, { label: string; description: string }> = {
  logical: { label: 'Logical', description: 'ERD Studio model library' },
  yml: { label: 'Physical', description: 'dbt .yml schema file' },
  manifest: { label: 'Compiled', description: 'Compiled manifest only' },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AddExistingModelDialog() {
  const isOpen = useEditorStore((s) => s.addExistingModelDialogOpen);
  const setAddExistingModelDialogOpen = useEditorStore((s) => s.setAddExistingModelDialogOpen);
  const existingModels = useEditorStore((s) => s.existingModels);
  const manifestModels = useEditorStore((s) => s.manifestModels);
  const modelFolder = useEditorStore((s) => s.domain?.modelFolder);
  const { send } = useMessageBus(() => {});

  // Use existingModels if available (v5), fall back to manifestModels (v4 compat)
  const models: (ExistingModelPreview | ManifestModelPreview)[] =
    existingModels.length > 0 ? existingModels : manifestModels;

  // Local state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [activeFilters, setActiveFilters] = useState<Set<SourceKey>>(
    new Set(['logical', 'yml', 'manifest']),
  );

  // Compute source counts for filter chips
  const sourceCounts = useMemo(() => {
    const counts: Record<SourceKey, number> = { logical: 0, yml: 0, manifest: 0 };
    for (const m of models) {
      const source = 'source' in m ? (m.source as SourceKey) : 'manifest';
      counts[source]++;
    }
    return counts;
  }, [models]);

  // Filter models by search query + active source filters
  const filteredModels = useMemo(() => {
    let result = models;

    // Source filter
    result = result.filter((m) => {
      const source = 'source' in m ? (m.source as SourceKey) : 'manifest';
      return activeFilters.has(source);
    });

    // Text search
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (m) =>
          m.name.toLowerCase().includes(query) ||
          m.schema.toLowerCase().includes(query) ||
          m.description.toLowerCase().includes(query) ||
          ('sourcePath' in m && (m as ExistingModelPreview).sourcePath.toLowerCase().includes(query)),
      );
    }

    return result;
  }, [models, searchQuery, activeFilters]);

  // Handlers
  const handleClose = useCallback(() => {
    setAddExistingModelDialogOpen(false);
    setSearchQuery('');
    setSelectedModel(null);
    setActiveFilters(new Set(['logical', 'yml', 'manifest']));
  }, [setAddExistingModelDialogOpen]);

  const handleSelect = useCallback((modelName: string) => {
    setSelectedModel(modelName);
  }, []);

  const handleAdd = useCallback(() => {
    if (!selectedModel) return;
    send({ type: 'addExistingModel', payload: { modelName: selectedModel } });
    handleClose();
  }, [selectedModel, send, handleClose]);

  const handleDoubleClick = useCallback(
    (modelName: string) => {
      send({ type: 'addExistingModel', payload: { modelName } });
      handleClose();
    },
    [send, handleClose],
  );

  const toggleFilter = useCallback((source: SourceKey) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(source)) {
        // Don't allow deselecting all filters
        if (next.size > 1) {
          next.delete(source);
        }
      } else {
        next.add(source);
      }
      return next;
    });
  }, []);

  if (!isOpen) {
    return null;
  }

  // Empty state
  if (models.length === 0) {
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
            <p>No models available to add.</p>
            <p className="add-existing-model-dialog__empty-hint">
              {modelFolder ? (
                <>
                  No models found in <code>{modelFolder}/</code>. Add <code>.yml</code> schema files to your dbt project or run <code>dbt compile</code>.
                </>
              ) : (
                <>
                  Add <code>.yml</code> schema files to your dbt project, create models in <code>erd-studio/logical-models/</code>, or run <code>dbt compile</code>.
                </>
              )}
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
            {filteredModels.length} of {models.length}
          </span>
        </div>

        {/* Source filter chips */}
        <div className="add-existing-model-dialog__filters">
          {(Object.keys(SOURCE_CONFIG) as SourceKey[]).map((source) => {
            const count = sourceCounts[source];
            if (count === 0) return null;
            const isActive = activeFilters.has(source);
            return (
              <button
                key={source}
                className={`add-existing-model-dialog__filter-chip add-existing-model-dialog__filter-chip--${source}${isActive ? ' add-existing-model-dialog__filter-chip--active' : ''}`}
                onClick={() => toggleFilter(source)}
                title={`${isActive ? 'Hide' : 'Show'} ${SOURCE_CONFIG[source].description}`}
              >
                {SOURCE_CONFIG[source].label}
                <span className="add-existing-model-dialog__filter-count">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Model List */}
        <div className="add-existing-model-dialog__list">
          {filteredModels.length === 0 ? (
            <div className="add-existing-model-dialog__no-results">
              No models match your search or filters
            </div>
          ) : (
            filteredModels.map((model) => {
              const source: SourceKey = 'source' in model ? (model.source as SourceKey) : 'manifest';
              const sourcePath = 'sourcePath' in model ? (model as ExistingModelPreview).sourcePath : undefined;
              return (
                <ModelItem
                  key={model.name}
                  model={model}
                  source={source}
                  sourcePath={sourcePath}
                  isSelected={selectedModel === model.name}
                  onSelect={handleSelect}
                  onDoubleClick={handleDoubleClick}
                />
              );
            })
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
  source: SourceKey;
  sourcePath?: string;
  isSelected: boolean;
  onSelect: (name: string) => void;
  onDoubleClick: (name: string) => void;
}

function ModelItem({ model, source, sourcePath, isSelected, onSelect, onDoubleClick }: ModelItemProps) {
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
        <span className={`add-existing-model-dialog__item-source add-existing-model-dialog__item-source--${source}`}>
          {SOURCE_CONFIG[source].label}
        </span>
        {model.schema && (
          <span className="add-existing-model-dialog__item-schema">{model.schema}</span>
        )}
      </div>
      {sourcePath && (
        <div className="add-existing-model-dialog__item-path" title={sourcePath}>
          {sourcePath}
        </div>
      )}
      <div className="add-existing-model-dialog__item-meta">
        <span className="add-existing-model-dialog__item-columns">
          {model.columnCount} column{model.columnCount !== 1 ? 's' : ''}
        </span>
        {model.description && (
          <span className="add-existing-model-dialog__item-desc" title={model.description}>
            {model.description.length > 60 ? model.description.slice(0, 60) + '...' : model.description}
          </span>
        )}
      </div>
    </div>
  );
}
