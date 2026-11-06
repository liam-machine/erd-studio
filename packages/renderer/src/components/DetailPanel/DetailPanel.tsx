/**
 * DetailPanel — floating detail view for the selected model.
 *
 * Displays at top-right when a node is clicked. Shows:
 * - Model metadata (its file, when the editing host says, then name, schema, description)
 * - Editable column list
 * - Incoming and outgoing FK relationships, then (editing host only) the
 *   relationships to tables not on this diagram, each with "+ Add"
 * - "Modelling detail (optional)": the table's Fields (its context fields,
 *   from the project's field list), folded until one of them has a value
 *
 * The viewer (`useIsViewer`) never has the host's context and keeps the
 * layout it always had: every section open, in the old order, with the
 * Fields where the role, grain, meta and rationale sections were.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from '@xyflow/react';

import { DescriptionEditor } from './DescriptionEditor';
import { AliasEditor } from './AliasEditor';
import { ColumnEditor } from './ColumnEditor';
import { FieldsSection, fieldRows, tableFieldsShown, type FieldsTable } from './FieldsSection';
import { useEditorStore } from '../../store/editorStore';
import { useCanvasHost, useIsViewer } from '../../host/canvasEnvironment';
import { STARTING_FIELD_LIST, backwardsRelationshipNote } from '@erd-studio/core';
import type { ColumnPair, DisplayRelationship, FieldList, PhysicalColumnSource, PhysicalProvenance } from '@erd-studio/core';
import { swapCardinality } from '../../lib/cardinalityUtils';
import type { FkEdgeData } from '../../types/graph';
import { columnPairs, foldComposites, relationshipEdgeId } from '../../lib/relationshipDisplayKey';
import { cardinalityLabel, offDiagramRows, offDiagramTables, ownValue } from '../../lib/canvasContext';
import './DetailPanel.css';

/** A relationship row: a composite foreign key carries all its column pairs. */
type PanelRelationship = DisplayRelationship & { pairs?: ColumnPair[] };

/** One end's columns: `customer_key`, or `(customer_hk, as_of_date)` for a composite. */
function columnsText(rel: PanelRelationship, end: 'from' | 'to'): string {
  const cols = columnPairs(rel).map((p) => (end === 'from' ? p.fromColumn : p.toColumn));
  return cols.length === 1 ? cols[0] : `(${cols.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Physical provenance
// ---------------------------------------------------------------------------

/**
 * How each physical column source is named in the metadata row. The canvas chip
 * has three letters and a tooltip; this is the place someone lands when they
 * want to know why a data type is blank, so it spells the source out.
 */
const SOURCE_NAME: Record<PhysicalColumnSource, string> = {
  catalog: 'warehouse catalog',
  yml: 'your dbt .yml',
  manifest: 'dbt manifest',
  file: '.sql file only',
};

/** The viewer's twin: a page outside VS Code cannot know the project uses dbt. */
const SOURCE_NAME_NEUTRAL: Record<PhysicalColumnSource, string> = {
  catalog: 'warehouse catalog',
  yml: 'schema .yml',
  manifest: 'compiled manifest',
  file: 'source file only',
};

/**
 * One line describing where a physical model's shape came from.
 *
 * `provenance.columns` is ordered most-authoritative-first, so its head is the
 * list's principal supplier; `provenance.types` is named separately only when
 * it differs, which happens when the principal supplier contributed column
 * names but no data types.
 */
function describeProvenance(provenance: PhysicalProvenance, untyped: number, viewer = false): string {
  const sourceName = viewer ? SOURCE_NAME_NEUTRAL : SOURCE_NAME;
  const names = provenance.columns.map((c) => sourceName[c]);
  const parts = [
    names.length > 1
      ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
      : names[0] ?? sourceName[provenance.types],
  ];
  if (provenance.types !== provenance.columns[0]) {
    parts.push(`types from ${sourceName[provenance.types]}`);
  }
  if (untyped > 0) {
    parts.push(`${untyped} untyped`);
  }
  return parts.join(' \u00b7 ');
}

// ---------------------------------------------------------------------------
// Remove confirmation
// ---------------------------------------------------------------------------

/**
 * The detail panel's "Remove from Diagram" question. A table's relationships
 * go with it only when the diagram file holds them itself (a YAML/JSON
 * domain's own list); in the Table Library (every DBML diagram) they stay.
 * `inDiagramFile` is absent from an older core: then every relationship the
 * table draws is counted, the old warning.
 */
export function removeConfirmText(
  tableName: string,
  relationshipsInDiagramFile: boolean | undefined,
  outgoing: readonly Pick<DisplayRelationship, 'inDiagramFile'>[],
  incoming: readonly Pick<DisplayRelationship, 'inDiagramFile'>[],
): string {
  const question = `Remove ${tableName} from this diagram?`;
  if (relationshipsInDiagramFile === false) {
    return `${question} The table and its relationships stay in the Table Library.`;
  }
  const all = [...outgoing, ...incoming];
  const going = relationshipsInDiagramFile === true ? all.filter((r) => r.inDiagramFile).length : all.length;
  if (going === 0) return question;
  return `${question} ${going === 1 ? 'Its 1 relationship in this diagram file' : `Its ${going} relationships in this diagram file`} will also be removed.`;
}

/** Most tables one "Add all related" asks for (the host's `addExistingModels` limit). */
const ADD_ALL_RELATED_LIMIT = 200;

/**
 * Whether any of the table's fields has a value, so "Modelling detail" opens
 * by itself. Import DBML's bookkeeping (`meta.dbml`) is not a field.
 */
export function hasModellingDetail(model: FieldsTable, list: FieldList = STARTING_FIELD_LIST): boolean {
  return fieldRows(model, undefined, list).some((row) => row.value !== undefined);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DetailPanel() {
  const host = useCanvasHost();
  const viewer = useIsViewer();
  const domain = useEditorStore((s) => s.domain);
  const existingModels = useEditorStore((s) => s.existingModels);
  const selectedNode = useEditorStore((s) => s.selectedNode);
  const detailPanelOpen = useEditorStore((s) => s.detailPanelOpen);
  const selectNode = useEditorStore((s) => s.selectNode);
  const setDetailPanelOpen = useEditorStore((s) => s.setDetailPanelOpen);
  const pendingDeleteConfirmation = useEditorStore((s) => s.pendingDeleteConfirmation);
  const setPendingDeleteConfirmation = useEditorStore((s) => s.setPendingDeleteConfirmation);
  const openEdgeContextMenu = useEditorStore((s) => s.openEdgeContextMenu);
  // No dbt project: the warehouse name (dbt's alias) shows only when set.
  const logicalOnly = useEditorStore((s) => s.logicalOnly) === true;
  // The editing host's context (never set in the viewer).
  const canvasContext = useEditorStore((s) => s.canvasContext);
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
      if (!/^[A-Za-z]/.test(trimmed)) return 'Must start with a letter';
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(trimmed)) return 'Only letters, numbers, and underscores';
      // Names are compared without case: `DimDate` and `dimdate` are one file
      // on macOS/Windows and one table in dbt.
      const same = (name: string) => name.toLowerCase() === trimmed.toLowerCase();
      if (selectedNode && trimmed !== selectedNode && same(selectedNode)) {
        return 'Only the upper/lower case differs — rename to another name first';
      }
      if (domain && trimmed !== selectedNode && domain.models.some((m) => same(m.name))) {
        return 'A table with this name already exists';
      }
      // logical-models/ is shared across domains — renaming onto an existing
      // library model would overwrite a file another domain depends on.
      if (
        trimmed !== selectedNode &&
        existingModels.some((m) => m.source === 'logical' && same(m.name))
      ) {
        return 'A table with this name already exists in the Table Library';
      }
      return '';
    },
    [domain, selectedNode, existingModels],
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
    host.postMessage({
      type: 'renameModel',
      payload: { oldName: selectedNode, newName: trimmed },
    });
    selectNode(trimmed);
    setEditingName(false);
    setNameError('');
  }, [selectedNode, nameValue, host, selectNode, validateModelName]);

  const handleDeleteModel = useCallback(() => {
    if (!selectedNode) return;
    host.postMessage({
      type: 'removeModel',
      payload: { modelName: selectedNode },
    });
    setConfirmingDelete(false);
    handleClose();
  }, [selectedNode, host, handleClose]);

  const handleDeleteRelationship = useCallback(
    // A composite sends its first pair; the host removes the whole group (#133 L2).
    (rel: PanelRelationship) => {
      host.postMessage({
        type: 'removeRelationship',
        payload: {
          fromModel: rel.fromModel,
          fromColumn: rel.fromColumn,
          toModel: rel.toModel,
          toColumn: rel.toColumn,
        },
      });
    },
    [host],
  );

  // Turn round a relationship drawn backwards (#163): the ⇄ the line offers,
  // which the host stores the right way round. A composite sends its first pair.
  const handleTurnRound = useCallback(
    (rel: PanelRelationship) => {
      host.postMessage({
        type: 'updateRelationship',
        payload: {
          fromModel: rel.fromModel,
          fromColumn: rel.fromColumn,
          toModel: rel.toModel,
          toColumn: rel.toColumn,
          cardinality: swapCardinality(rel.cardinality),
        },
      });
    },
    [host],
  );

  // Open context menu when clicking a relationship row (for cardinality editing)
  const handleRelationshipClick = useCallback(
    (x: number, y: number, rel: PanelRelationship) => {
      const edgeData: FkEdgeData = {
        fromModel: rel.fromModel,
        fromColumn: rel.fromColumn,
        toModel: rel.toModel,
        toColumn: rel.toColumn,
        cardinality: rel.cardinality,
        // Carried so Edit opens with it — the dialog saves what it shows.
        ...(rel.role ? { role: rel.role } : {}),
        ...(rel.pairs ? { pairs: rel.pairs, ...(rel.compositeKey ? { compositeKey: rel.compositeKey } : {}) } : {}),
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
      return { outgoing: [] as PanelRelationship[], incoming: [] as PanelRelationship[] };
    }
    // One row per composite foreign key (#133 L2).
    const rels: PanelRelationship[] = foldComposites(domain.relationships);
    const outgoing = rels.filter((r) => r.fromModel === selectedNode);
    // A self-reference is listed once, under outgoing (#133 L3).
    const incoming = rels.filter((r) => r.toModel === selectedNode && r.fromModel !== selectedNode);
    return { outgoing, incoming };
  }, [domain, selectedNode]);

  const isReadOnly = domain?.readOnly ?? false;
  // The project's field list; absent (no fields.yml, or an older core) is the starting set.
  const fieldList = domain?.fields ?? STARTING_FIELD_LIST;

  // Relationships to tables not on this diagram (the host's context, logical stage).
  const offRows = useMemo(
    () => (selectedNode ? offDiagramRows(canvasContext, domain, selectedNode) : []),
    [canvasContext, domain, selectedNode],
  );

  // "Modelling detail (optional)": open when any field is set, else folded.
  // It opens by itself once one is set and only a new selection folds it
  // again, so it never shuts while someone is filling it in.
  const hasModelling = model ? hasModellingDetail(model, fieldList) : false;
  const [modellingOpen, setModellingOpen] = useState(hasModelling);
  useEffect(() => {
    setModellingOpen(hasModelling);
    // Only a new selection resets it; `hasModelling` turning true opens it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode]);
  useEffect(() => {
    if (hasModelling) setModellingOpen(true);
  }, [hasModelling]);

  const handleAddTables = useCallback(
    (names: readonly string[]) => {
      if (names.length === 0) return;
      if (names.length === 1) {
        host.postMessage({ type: 'addExistingModel', payload: { modelName: names[0] } });
      } else {
        host.postMessage({ type: 'addExistingModels', payload: { modelNames: names.slice(0, ADD_ALL_RELATED_LIMIT) } });
      }
    },
    [host],
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

  // Editing host, logical stage only: the viewer never has a context, and shows nothing it feeds.
  const hostContext = domain.stage === 'logical' ? canvasContext : null;
  const tableFile = viewer ? undefined : ownValue(hostContext?.tableFiles, model.name);
  const reviewers = viewer ? undefined : ownValue(hostContext?.owners, model.name);
  const showOffDiagram = viewer ? false : !isReadOnly && offRows.length > 0;

  // The sections, placed below in the viewer's order or the editor's.
  // A read-only panel (viewer, physical stage) shows the Fields only when one has a value.
  const fieldsShown = viewer ? tableFieldsShown(model, fieldList) : (isReadOnly ? tableFieldsShown(model, fieldList) : true);
  const fieldsSection = fieldsShown ? (
    <div className="detail-panel__section">
      <FieldsSection
        modelName={model.name}
        table={model}
        fields={fieldList}
        readOnly={isReadOnly}
        logicalOnly={logicalOnly}
      />
    </div>
  ) : null;
  const removeSection = (
    <>
      {/* Remove from Diagram button */}
      {!isReadOnly && (
        <div className="detail-panel__section detail-panel__section--actions">
          {confirmingDelete ? (
            <>
              <span className="detail-panel__confirm-label">
                {removeConfirmText(model.name, domain.relationshipsInDiagramFile, outgoing, incoming)}
              </span>
              <div className="detail-panel__confirm-actions">
                <button
                  className="detail-panel__button detail-panel__button--danger"
                  onClick={handleDeleteModel}
                  aria-label="Confirm remove table"
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
              title="Remove this table from this diagram"
              aria-label="Remove this table from this diagram"
            >
              Remove from Diagram
            </button>
          )}
        </div>
      )}
    </>
  );
  const columnsSection = (
    <>
      {/* Columns (editable) */}
      <div className="detail-panel__section">
        <ColumnEditor
          modelName={model.name}
          columns={model.columns}
          readOnly={isReadOnly}
          modelRole={model.modelRole}
          fields={fieldList}
          logicalOnly={logicalOnly}
        />
      </div>
    </>
  );
  const relationshipsSection = (
    <>
      {/* Relationships */}
      {totalRelationships > 0 && (
        <div className="detail-panel__section">
          <h4 className="detail-panel__section-title">
            Relationships ({totalRelationships})
          </h4>
          <div className="detail-panel__relationships">
            {/* The viewer can't edit cardinality, so its rows are plain (not clickable). */}
            {/* Outgoing: this model references others */}
            {outgoing.map((rel) => (
              <div
                key={`out-${relationshipEdgeId(rel)}`}
                className={viewer ? 'detail-panel__relationship' : 'detail-panel__relationship detail-panel__relationship--clickable'}
                onClick={viewer ? undefined : (e) => handleRelationshipClick(e.clientX, e.clientY, rel)}
                role={viewer ? undefined : 'button'}
                tabIndex={viewer ? undefined : 0}
                onKeyDown={viewer ? undefined : (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    handleRelationshipClick(rect.left + rect.width / 2, rect.top + rect.height / 2, rel);
                  }
                }}
                title={viewer ? undefined : 'Click to edit cardinality'}
              >
                <span className="detail-panel__rel-direction" title={rel.toModel === rel.fromModel ? 'Self-reference' : 'Outgoing FK'}>
                  {rel.toModel === rel.fromModel ? '↻' : '→'}
                </span>
                <span className="detail-panel__rel-columns">
                  <span className="detail-panel__rel-local" title={columnsText(rel, 'from')}>
                    {columnsText(rel, 'from')}
                  </span>
                  <span className="detail-panel__rel-arrow">→</span>
                  <span className="detail-panel__rel-target" title={`${rel.toModel}.${columnsText(rel, 'to')}`}>
                    {rel.toModel}.{columnsText(rel, 'to')}
                  </span>
                </span>
                <span className="detail-panel__rel-cardinality">
                  {rel.cardinality}
                </span>
                {viewer ? null : (!isReadOnly && rel.keysContradict && (
                  <button
                    className="detail-panel__rel-backwards"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTurnRound(rel);
                    }}
                    title={`${backwardsRelationshipNote(rel, rel.pairs ?? [rel])} Click to turn it round.`}
                  >
                    &#x26A0; Turn round
                  </button>
                ))}
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
                key={`in-${relationshipEdgeId(rel)}`}
                className={viewer ? 'detail-panel__relationship' : 'detail-panel__relationship detail-panel__relationship--clickable'}
                onClick={viewer ? undefined : (e) => handleRelationshipClick(e.clientX, e.clientY, rel)}
                role={viewer ? undefined : 'button'}
                tabIndex={viewer ? undefined : 0}
                onKeyDown={viewer ? undefined : (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    handleRelationshipClick(rect.left + rect.width / 2, rect.top + rect.height / 2, rel);
                  }
                }}
                title={viewer ? undefined : 'Click to edit cardinality'}
              >
                <span className="detail-panel__rel-direction" title="Incoming FK">
                  ←
                </span>
                <span className="detail-panel__rel-columns">
                  <span className="detail-panel__rel-target" title={`${rel.fromModel}.${columnsText(rel, 'from')}`}>
                    {rel.fromModel}.{columnsText(rel, 'from')}
                  </span>
                  <span className="detail-panel__rel-arrow">→</span>
                  <span className="detail-panel__rel-local" title={columnsText(rel, 'to')}>
                    {columnsText(rel, 'to')}
                  </span>
                </span>
                <span className="detail-panel__rel-cardinality">
                  {rel.cardinality}
                </span>
                {viewer ? null : (!isReadOnly && rel.keysContradict && (
                  <button
                    className="detail-panel__rel-backwards"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTurnRound(rel);
                    }}
                    title={`${backwardsRelationshipNote(rel, rel.pairs ?? [rel])} Click to turn it round.`}
                  >
                    &#x26A0; Turn round
                  </button>
                ))}
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
    </>
  );

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
            title="Rename table"
            aria-label="Rename table"
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
          {/* Editing host only: the table's file, and who reviews a change to it. */}
          {tableFile !== undefined && (
            <div className="detail-panel__metadata-row detail-panel__metadata-row--file">
              <span className="detail-panel__label detail-panel__label--wide">File</span>
              <span className="detail-panel__value detail-panel__file-path" title={tableFile}>{tableFile}</span>
              <button
                type="button"
                className="detail-panel__file-open"
                onClick={() => host.postMessage({ type: 'openModelFile', payload: { modelName: model.name } })}
                title={`Open ${tableFile}`}
                aria-label="Open this table's file"
              >
                Open
              </button>
            </div>
          )}
          {reviewers !== undefined && (
            <div className="detail-panel__metadata-row">
              <span className="detail-panel__label detail-panel__label--wide">Reviewed by</span>
              <span className="detail-panel__value detail-panel__value--provenance" title={reviewers}>{reviewers}</span>
            </div>
          )}
          <div className="detail-panel__metadata-row">
            <span className="detail-panel__label detail-panel__label--wide">Schema</span>
            <span className="detail-panel__value">{model.schema || '—'}</span>
          </div>
          {/* Without a dbt project the row shows only for a table that already
              has a warehouse name, so it can be seen and cleared. The viewer
              keeps the row it always had, worded without dbt: a page outside
              VS Code cannot know whether the project uses it. */}
          {viewer ? (
            <AliasEditor modelName={model.name} alias={model.alias} readOnly dbtWording={false} />
          ) : (!logicalOnly || model.alias?.trim()) ? (
            <AliasEditor modelName={model.name} alias={model.alias} readOnly={isReadOnly} dbtWording={!logicalOnly} />
          ) : null}
          {/* Physical stage only — logical models never carry provenance, so the
              logical panel does not sprout an empty row. */}
          {model.provenance && (
            <div className="detail-panel__metadata-row">
              <span className="detail-panel__label detail-panel__label--wide">Columns from</span>
              <span className="detail-panel__value detail-panel__value--provenance">
                {describeProvenance(
                  model.provenance,
                  model.columns.filter((c) => !c.dataType).length,
                  viewer,
                )}
              </span>
            </div>
          )}
        </div>
        {isReadOnly ? (
          model.description && (
            <p className="detail-panel__description">{model.description}</p>
          )
        ) : (
          <DescriptionEditor modelName={model.name} description={model.description} />
        )}
      </div>

      {viewer ? (
        <>
          {fieldsSection}
          {removeSection}
          {columnsSection}
          {relationshipsSection}
        </>
      ) : (
        <>
          {columnsSection}
          {relationshipsSection}
          {/* Editing host, logical stage: relationships to tables not on this diagram. */}
          {showOffDiagram && (
            <div className="detail-panel__section detail-panel__off-diagram">
              <div className="detail-panel__off-diagram-head">
                <h4 className="detail-panel__section-title detail-panel__off-diagram-title">
                  Not on this diagram ({offRows.length})
                </h4>
                <button
                  type="button"
                  className="detail-panel__off-add-all"
                  onClick={() => handleAddTables(offDiagramTables(offRows))}
                  title="Add every table listed here to this diagram"
                >
                  Add all related
                </button>
              </div>
              <div className="detail-panel__relationships">
                {offRows.map((row) => {
                  const text = [row.columns, cardinalityLabel(row.cardinality), ...(row.otherLayer ? [`in ${row.otherLayer}`] : [])].join(' \u00b7 ');
                  return (
                    <div
                      key={`off-${row.direction}-${row.otherTable}-${row.columns}`}
                      className="detail-panel__relationship detail-panel__off-row"
                    >
                      <span className="detail-panel__rel-direction" title={row.direction === 'out' ? 'Outgoing FK' : 'Incoming FK'}>
                        {row.direction === 'out' ? '\u2192' : '\u2190'}
                      </span>
                      <span className="detail-panel__off-text" title={`${row.otherTable} \u00b7 ${text}`}>
                        <span className="detail-panel__rel-target">{row.otherTable}</span>
                        <span className="detail-panel__off-detail">{` \u00b7 ${text}`}</span>
                      </span>
                      <button
                        type="button"
                        className="detail-panel__off-add"
                        onClick={() => handleAddTables([row.otherTable])}
                        title={`Add ${row.otherTable} to this diagram`}
                        aria-label={`Add ${row.otherTable} to this diagram`}
                      >
                        + Add
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* The table's Fields: folded until one has a value (a read-only stage shows the fold only when one has). */}
          {fieldsSection && (
            <div className="detail-panel__section detail-panel__modelling">
              <button
                type="button"
                className="detail-panel__modelling-toggle"
                aria-expanded={modellingOpen}
                onClick={() => setModellingOpen((open) => !open)}
              >
                <span className="detail-panel__modelling-chevron" aria-hidden="true">{modellingOpen ? '\u25be' : '\u25b8'}</span>
                <span className="detail-panel__modelling-title">Modelling detail</span>{' '}
                <span className="detail-panel__modelling-optional">(optional)</span>
              </button>
            </div>
          )}
          {fieldsSection && modellingOpen && (
            <div className="detail-panel__modelling-body">
              {fieldsSection}
            </div>
          )}

          {removeSection}
        </>
      )}
    </Panel>
  );
}
