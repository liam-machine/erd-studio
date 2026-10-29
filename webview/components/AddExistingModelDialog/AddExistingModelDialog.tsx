/**
 * AddExistingTableDialog — dialog for adding existing models to a domain.
 *
 * Displays a searchable, filterable list of models from three sources:
 * - Library: models with YAML definitions in .erd-studio/logical-models/
 * - dbt: models defined in dbt .yml schema files
 * - Compiled: models only in compiled manifest (no .yml file)
 *
 * Each model shows its source badge, file path, and metadata.
 * Filter chips let the user show/hide each source type.
 *
 * Several models can be picked at once: a click ticks or unticks a row, and
 * "Select all" ticks every row the search and filters show. One pick posts
 * `addExistingModel { modelName }` as before; more post one `addExistingModels`, which
 * the host adds in one edit (one undo step). Double-click adds that row, with
 * any others ticked. A v4 domain (no central model store) picks one at a time.
 *
 * On a large Table Library opened before its files were read, some rows
 * arrive with `detailsPending` (name and file only). Opening the dialog then
 * asks the host for the rest (`requestExistingTables`); the rows fill in when
 * its `existingTables` answer arrives.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from '@xyflow/react';

import { useEditorStore } from '../../store/editorStore';
import { useSend } from '../../hooks/useMessageBus';
import type { ExistingTablePreview, ManifestModelPreview } from '../../../src/types/display';
import { ADD_EXISTING_TABLES_LIMIT } from '../../../src/types/messages';
import './AddExistingModelDialog.css';

// ---------------------------------------------------------------------------
// Source configuration
// ---------------------------------------------------------------------------

type SourceKey = 'logical' | 'yml' | 'manifest';

const SOURCE_CONFIG: Record<SourceKey, { label: string; description: string }> = {
  logical: { label: 'Logical', description: 'ERD Studio Table Library' },
  yml: { label: 'Physical', description: 'dbt .yml schema file' },
  manifest: { label: 'Compiled', description: 'Compiled manifest only' },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AddExistingTableDialog() {
  const isOpen = useEditorStore((s) => s.addExistingModelDialogOpen);
  const setAddExistingModelDialogOpen = useEditorStore((s) => s.setAddExistingModelDialogOpen);
  const existingModels = useEditorStore((s) => s.existingModels);
  const manifestModels = useEditorStore((s) => s.manifestModels);
  const modelFolder = useEditorStore((s) => s.domain?.modelFolder);
  // No dbt project: the only source is the Table Library, so no dbt advice.
  const logicalOnly = useEditorStore((s) => s.logicalOnly);
  // The host adds several at once only into a v5 domain (`addExistingModels`).
  const canPickMany = useEditorStore((s) => (s.domain?.schemaVersion ?? 5) >= 5);
  const send = useSend();

  // Use existingModels if available (v5), fall back to manifestModels (v4 compat)
  const models: (ExistingTablePreview | ManifestModelPreview)[] =
    existingModels.length > 0 ? existingModels : manifestModels;

  // Local state
  const [searchQuery, setSearchQuery] = useState('');
  // Picked names, in the order they were ticked.
  const [selected, setSelected] = useState<string[]>([]);
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
          ('sourcePath' in m && (m as ExistingTablePreview).sourcePath.toLowerCase().includes(query)),
      );
    }

    return result;
  }, [models, searchQuery, activeFilters]);

  // Rows the host has not read yet: ask for them once each time the dialog opens.
  const detailsPending = useMemo(
    () => existingModels.some((m) => m.detailsPending === true),
    [existingModels],
  );
  useEffect(() => {
    if (isOpen && detailsPending) send({ type: 'requestExistingTables' });
    // Only on opening: the answer clears `detailsPending`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Escape closes the dialog through the store, not handleClose: start the
  // next opening clean either way, so no tick survives into it unseen.
  useEffect(() => {
    if (isOpen) return;
    setSearchQuery('');
    setSelected([]);
    setActiveFilters(new Set(['logical', 'yml', 'manifest']));
  }, [isOpen]);

  // Handlers
  const handleClose = useCallback(() => {
    setAddExistingModelDialogOpen(false);
    setSearchQuery('');
    setSelected([]);
    setActiveFilters(new Set(['logical', 'yml', 'manifest']));
  }, [setAddExistingModelDialogOpen]);

  // Only the rows on screen count: a pick hidden by the search or a filter is
  // dropped, so Add never adds a model the user cannot see ticked.
  const shownNames = useMemo(() => new Set(filteredModels.map((m) => m.name)), [filteredModels]);
  const visibleSelected = useMemo(
    () => selected.filter((name) => shownNames.has(name)),
    [selected, shownNames],
  );

  const handleToggle = useCallback((modelName: string) => {
    setSelected((prev) => {
      if (!canPickMany) return [modelName];
      const shown = prev.filter((name) => shownNames.has(name));
      if (shown.includes(modelName)) return shown.filter((name) => name !== modelName);
      return shown.length >= ADD_EXISTING_TABLES_LIMIT ? shown : [...shown, modelName];
    });
  }, [canPickMany, shownNames]);

  const allShownSelected = filteredModels.length > 0 && visibleSelected.length === filteredModels.length;
  const atLimit = visibleSelected.length >= ADD_EXISTING_TABLES_LIMIT;
  const overLimit = filteredModels.length > ADD_EXISTING_TABLES_LIMIT;

  // Ticks every shown row, up to the limit; picks hidden by the search go.
  const handleSelectAllShown = useCallback(() => {
    setSelected((prev) => {
      const next = prev.filter((name) => filteredModels.some((m) => m.name === name));
      for (const m of filteredModels) {
        if (next.length >= ADD_EXISTING_TABLES_LIMIT) break;
        if (!next.includes(m.name)) next.push(m.name);
      }
      return next;
    });
  }, [filteredModels]);

  const handleClearSelection = useCallback(() => {
    setSelected([]);
  }, []);

  const addModels = useCallback((names: readonly string[]) => {
    if (names.length === 0) return;
    if (names.length === 1) {
      send({ type: 'addExistingModel', payload: { modelName: names[0] } });
    } else {
      send({ type: 'addExistingModels', payload: { modelNames: [...names] } });
    }
    handleClose();
  }, [send, handleClose]);

  const handleAdd = useCallback(() => addModels(visibleSelected), [addModels, visibleSelected]);

  // Adds the double-clicked row together with any other ticked rows — with
  // nothing else ticked, that row alone, as before. (Its two clicks have
  // already ticked and unticked it.)
  const handleDoubleClick = useCallback(
    (modelName: string) => {
      const others = canPickMany ? visibleSelected.filter((name) => name !== modelName) : [];
      addModels([...others.slice(0, ADD_EXISTING_TABLES_LIMIT - 1), modelName]);
    },
    [addModels, canPickMany, visibleSelected],
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
          <h3 className="add-existing-model-dialog__title">Add Existing Table</h3>
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
            <p>No tables available to add.</p>
            <p className="add-existing-model-dialog__empty-hint">
              {logicalOnly ? (
                <>
                  Tables you create in any diagram are saved to the Table Library and can be added here.
                </>
              ) : modelFolder ? (
                <>
                  No dbt models found in <code>{modelFolder}/</code>. Add <code>.yml</code> schema files to your dbt project or run <code>dbt compile</code>.
                </>
              ) : (
                <>
                  Add <code>.yml</code> schema files to your dbt project, add tables to the Table Library, or run <code>dbt compile</code>.
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
        <h3 className="add-existing-model-dialog__title">Add Existing Table</h3>
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
            placeholder="Search tables..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
          />
          <span className="add-existing-model-dialog__search-count">
            {filteredModels.length} of {models.length}
          </span>
        </div>

        {detailsPending && (
          <div className="add-existing-model-dialog__pending" role="status">
            Reading table details…
          </div>
        )}

        {/* Selection */}
        {canPickMany && <div className="add-existing-model-dialog__selection">
          <span className="add-existing-model-dialog__selection-count">
            {visibleSelected.length} selected
          </span>
          <button
            className="add-existing-model-dialog__link"
            onClick={handleSelectAllShown}
            disabled={allShownSelected || atLimit}
            title={overLimit
              ? `At most ${ADD_EXISTING_TABLES_LIMIT} tables can be added at once`
              : 'Tick every table the search and filters show'}
          >
            {overLimit ? `Select first ${ADD_EXISTING_TABLES_LIMIT} shown` : `Select all ${filteredModels.length} shown`}
          </button>
          <button
            className="add-existing-model-dialog__link"
            onClick={handleClearSelection}
            disabled={selected.length === 0}
          >
            Clear
          </button>
        </div>}

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
        <div className="add-existing-model-dialog__list" role="listbox" aria-multiselectable={canPickMany} aria-label="Tables">
          {filteredModels.length === 0 ? (
            <div className="add-existing-model-dialog__no-results">
              No tables match your search or filters
            </div>
          ) : (
            filteredModels.map((model) => {
              const source: SourceKey = 'source' in model ? (model.source as SourceKey) : 'manifest';
              const sourcePath = 'sourcePath' in model ? (model as ExistingTablePreview).sourcePath : undefined;
              return (
                <TableItem
                  key={model.name}
                  model={model}
                  source={source}
                  sourcePath={sourcePath}
                  isSelected={visibleSelected.includes(model.name)}
                  showCheck={canPickMany}
                  onToggle={handleToggle}
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
          disabled={visibleSelected.length === 0}
        >
          {visibleSelected.length > 1 ? `Add ${visibleSelected.length} Tables` : 'Add Table'}
        </button>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// ModelItem subcomponent
// ---------------------------------------------------------------------------

interface TableItemProps {
  model: ManifestModelPreview;
  source: SourceKey;
  sourcePath?: string;
  isSelected: boolean;
  showCheck: boolean;
  onToggle: (name: string) => void;
  onDoubleClick: (name: string) => void;
}

function TableItem({ model, source, sourcePath, isSelected, showCheck, onToggle, onDoubleClick }: TableItemProps) {
  const handleClick = useCallback(() => {
    onToggle(model.name);
  }, [onToggle, model.name]);

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
        {showCheck && <input
          type="checkbox"
          className="add-existing-model-dialog__item-check"
          checked={isSelected}
          readOnly
          tabIndex={-1}
          aria-hidden="true"
        />}
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
          {'detailsPending' in model && model.detailsPending
            ? 'Reading…'
            : `${model.columnCount} column${model.columnCount !== 1 ? 's' : ''}`}
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
