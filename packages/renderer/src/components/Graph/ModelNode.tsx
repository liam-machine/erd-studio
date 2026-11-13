/**
 * TableNode — custom React Flow node for displaying a semantic model card.
 *
 * Shows model name with a layer badge, a list of columns with PK/FK
 * indicators and data types, and a footer with the total column count.
 *
 * Provides node-level handles (top/right/bottom/left) used by FkEdge for
 * Power BI-style connections that route to whichever side creates the
 * least bends.
 *
 * Relationships are created via long-press on column rows:
 *   1. Long-press (200-250ms) on a column to start drag mode
 *   2. Drag to a column in another model
 *   3. Release to open the relationship dialog with prefilled data
 */

import { memo, useCallback, useMemo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { TableFlowNode, TableNodeData, ColumnDisplay } from '../../types/graph';
import type { TableLoadError, TableLoadWarning, Stage } from '@erd-studio/core';
import type { ColumnDiscrepancy } from '@erd-studio/core';
import type { PhysicalColumnSource, PhysicalProvenance } from '@erd-studio/core';
import { resolveVisibleColumns } from '../../lib/tableDetail';
import { useLongPressDrag } from '../../hooks/useLongPressDrag';
import { useEditorStore } from '../../store/editorStore';
import { useIsViewer, useSend } from '../../host/canvasEnvironment';
import { dbtKeyTitle } from '../../lib/dbtKeyTitle';
import { useColumnReorder } from '../../hooks/useColumnReorder';
import { KeyBadge } from '../common/KeyBadge';
import { DataTypeSelect } from '../common/DataTypeSelect';
import { ColumnTooltip, hasTooltipContent } from './ColumnTooltip';
import { useHoverTip } from './HoverTip';
import { metaRows } from '../../lib/metaFormat';
import { tableFocusRole } from '../../lib/canvasFocus';
import { STAGE_HEX } from '../../lib/stageColors';
import { getDataTypeColor } from '../../lib/dataTypeColors';
import { layerAbbreviation } from '../../lib/layerCues';
import { headerName } from '../../lib/modelLabels';
import { offDiagramChipTip, offDiagramRows } from '../../lib/canvasContext';
import {
  SOURCE_LABEL,
  SOURCE_LABEL_NEUTRAL,
  SOURCE_PHRASE,
  SOURCE_PHRASE_NEUTRAL,
  SCD_BADGE,
  SCD_TITLE,
  ADDITIVE_BADGE,
  ADDITIVE_TITLE,
} from '../../lib/badgeLabels';
import './ModelNode.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * What a ghosted node is actually telling the user. A ghost used to mean only
 * "the manifest has not been compiled recently", which was never worth saying;
 * now it means the model is not in the project at all, or dbt refuses to build
 * it, and those two are worth telling apart.
 */
const GHOST_REASON_TITLE: Record<NonNullable<TableNodeData['ghostReason']>, string> = {
  'not-in-project': 'not found in your dbt project (no .sql/.py/.csv file, no schema .yml entry, no manifest node)',
  'disabled': 'disabled in dbt (enabled: false), so ref() to it does not compile',
  'missing-in-comparison': 'not present in the stage being compared against',
};

/** The viewer's twin: a page outside VS Code cannot know the project uses dbt. */
const GHOST_REASON_TITLE_NEUTRAL: Record<NonNullable<TableNodeData['ghostReason']>, string> = {
  'not-in-project': 'not found in the project (no source file, schema .yml entry or manifest node)',
  'disabled': 'disabled in the project (enabled: false), so it is not built',
  'missing-in-comparison': 'not present in the stage being compared against',
};

/** Join a contributor list as prose: "a", "a and b", "a, b and c". */
function joinPhrases(sources: PhysicalColumnSource[], phrase: Record<PhysicalColumnSource, string>): string {
  const phrases = sources.map((s) => phrase[s]);
  if (phrases.length <= 1) { return phrases[0] ?? ''; }
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
}

/**
 * The chip's full explanation. The untyped count is derived from the columns
 * already in node data rather than shipped on the wire — "why is this type
 * blank?" is the one question the chip has to be able to answer, and the
 * answer is `dataType === ''`.
 */
function sourceTitle(provenance: PhysicalProvenance, columns: ColumnDisplay[], viewer: boolean): string {
  const untyped = columns.filter((c) => !c.dataType).length;
  const label = viewer ? SOURCE_LABEL_NEUTRAL : SOURCE_LABEL;
  const phrase = viewer ? SOURCE_PHRASE_NEUTRAL : SOURCE_PHRASE;
  const base = `${label[provenance.types]} \u2014 types from ${phrase[provenance.types]}; columns from ${joinPhrases(provenance.columns, phrase)}`;
  return untyped > 0
    ? `${base} \u00b7 ${untyped} column${untyped === 1 ? ' has' : 's have'} no type`
    : base;
}


/**
 * Node-level handles — invisible connection points on each side of the card.
 * FkEdge connects to these for Power BI-style routing (least bends).
 */
const NODE_HANDLE_STYLE: CSSProperties = {
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  opacity: 0,
  pointerEvents: 'none',
};

// ---------------------------------------------------------------------------
// ColumnRow — individual column with long-press drag support
// ---------------------------------------------------------------------------

interface ColumnRowProps {
  column: ColumnDisplay;
  modelName: string;
  /** Whether this column is read-only (physical stage). */
  readOnly?: boolean;
  /** All column names in the model (for duplicate validation during rename). */
  existingColumnNames?: string[];
  /** Column-level discrepancy indicator (from cross-stage comparison). */
  discrepancy?: ColumnDiscrepancy;
  /** Props for the drag reorder handle (shown when node is selected). */
  dragHandleProps?: { onMouseDown: (e: React.MouseEvent) => void };
  /** Whether this row is being dragged. */
  isReorderDragging?: boolean;
  /** Whether the drop indicator should show above this row. */
  isReorderTarget?: boolean;
  /** The stage being viewed (for stage-labeled type mismatches). */
  discrepancySourceStage?: Stage;
  /** The stage being compared against (for stage-labeled type mismatches). */
  discrepancyTargetStage?: Stage;
}

function ColumnRow({ column, modelName, readOnly, existingColumnNames, discrepancy, dragHandleProps, isReorderDragging, isReorderTarget, discrepancySourceStage, discrepancyTargetStage }: ColumnRowProps) {
  const send = useSend();
  const viewer = useIsViewer();

  // Highlight when this column is involved in a selected edge
  const isHighlighted = useEditorStore(
    (s) => s.highlightedColumns?.has?.(`${modelName}:${column.name}`) ?? false
  );

  // Store actions for drag line visualization
  const startDragLine = useEditorStore((s) => s.startDragLine);
  const updateDragLineMouse = useEditorStore((s) => s.updateDragLineMouse);
  const endDragLine = useEditorStore((s) => s.endDragLine);

  // Stable selector: only re-renders when drag starts/ends, not on every mouse move
  const dragSourceModel = useEditorStore((s) => s.dragLineState?.sourceModelName ?? null);

  // Track whether cursor is over this column during a cross-model drag
  const [isDropTarget, setIsDropTarget] = useState(false);

  // Tooltip hover state — delayed show, instant hide
  const [showTooltip, setShowTooltip] = useState(false);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipEligible = hasTooltipContent(column);

  // --- Inline edit state ---
  const [editingField, setEditingField] = useState<'name' | 'dataType' | null>(null);
  const [localValue, setLocalValue] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input when entering edit mode
  useEffect(() => {
    if (editingField && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingField]);

  const startEdit = useCallback((field: 'name' | 'dataType') => {
    if (readOnly) return;
    setEditingField(field);
    setLocalValue(field === 'name' ? column.name : column.dataType);
    setEditError(null);
  }, [readOnly, column.name, column.dataType]);

  const cancelEdit = useCallback(() => {
    setEditingField(null);
    setLocalValue('');
    setEditError(null);
  }, []);

  const commitEdit = useCallback((revertOnError = false) => {
    if (!editingField) return;
    const trimmed = localValue.trim();
    const description = (column as unknown as { description?: string }).description ?? '';
    // Forward SCD/additive so an inline rename or type change doesn't erase them.
    const baseColumn = {
      name: column.name,
      dataType: column.dataType,
      description,
      isPrimaryKey: column.isPrimaryKey,
      isForeignKey: column.isForeignKey,
      isNaturalKey: column.isNaturalKey,
      ...(column.scdType != null ? { scdType: column.scdType } : {}),
      ...(column.additiveType ? { additiveType: column.additiveType } : {}),
    };

    if (editingField === 'name') {
      if (!trimmed) { cancelEdit(); return; }
      if (!/^[A-Za-z0-9_]+$/.test(trimmed)) {
        if (revertOnError) { cancelEdit(); return; }
        setEditError('Use only letters, numbers, underscores');
        return;
      }
      // Case is ignored (`Date` and `date` are one column to the warehouse),
      // but renaming this column to its own name in another case is allowed.
      if (
        trimmed !== column.name &&
        existingColumnNames?.some((n) => n !== column.name && n.toLowerCase() === trimmed.toLowerCase())
      ) {
        if (revertOnError) { cancelEdit(); return; }
        setEditError('Column name already exists');
        return;
      }
      if (trimmed === column.name) { cancelEdit(); return; }
      send({
        type: 'updateColumn',
        payload: { modelName, oldColumnName: column.name, column: { ...baseColumn, name: trimmed } },
      });
    } else {
      if (!trimmed) { cancelEdit(); return; }
      if (trimmed === column.dataType) { cancelEdit(); return; }
      send({
        type: 'updateColumn',
        payload: { modelName, oldColumnName: column.name, column: { ...baseColumn, dataType: trimmed } },
      });
    }
    setEditingField(null);
    setEditError(null);
  }, [editingField, localValue, column, modelName, existingColumnNames, send, cancelEdit]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  }, [commitEdit, cancelEdit]);

  // On blur, commit if valid, otherwise silently revert (no error display)
  const handleEditBlur = useCallback(() => {
    commitEdit(true);
  }, [commitEdit]);

  const handleDoubleClickName = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    startEdit('name');
  }, [startEdit]);

  const handleDoubleClickType = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    startEdit('dataType');
  }, [startEdit]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    send({ type: 'removeColumn', payload: { modelName, columnName: column.name } });
  }, [send, modelName, column.name]);

  // Reset drop target state when drag ends
  useEffect(() => {
    if (!dragSourceModel) setIsDropTarget(false);
  }, [dragSourceModel]);

  // Ref to the column element for position calculation
  const elementRef = useRef<HTMLDivElement>(null);

  const { isPressing, isDragging, endDrag, handlers } = useLongPressDrag({
    delay: 220,
    onLongPressStart: () => {
      // Calculate absolute position of the column element center
      if (elementRef.current) {
        const rect = elementRef.current.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        startDragLine(modelName, column.name, centerX, centerY);
      }
    },
  });

  // Track mounted state to prevent state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // When drag starts, track mouse position and detect drop target
  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!mountedRef.current) return;
      updateDragLineMouse(e.clientX, e.clientY);
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (!mountedRef.current) return;

      const targetElement = document.elementFromPoint(e.clientX, e.clientY);
      if (!targetElement) {
        endDrag();
        endDragLine();
        return;
      }

      const columnRow = targetElement.closest('[data-column-name]') as HTMLElement | null;
      const modelNode = targetElement.closest('[data-model-name]') as HTMLElement | null;

      if (columnRow && modelNode) {
        const targetColumnName = columnRow.dataset.columnName;
        const targetModelName = modelNode.dataset.modelName;

        if (targetColumnName && targetModelName) {
          // Another column of the same model draws a self-reference (#133
          // L3), e.g. employee.manager_id → employee.employee_id. Only the
          // column itself is refused.
          if (targetModelName === modelName && targetColumnName.toLowerCase() === column.name.toLowerCase()) {
            window.dispatchEvent(new CustomEvent('column-relationship-self-drop'));
          } else {
            window.dispatchEvent(
              new CustomEvent('column-relationship-drop', {
                detail: {
                  fromModel: modelName,
                  fromColumn: column.name,
                  toModel: targetModelName,
                  toColumn: targetColumnName,
                },
              }),
            );
          }
        }
      }

      endDrag();
      endDragLine();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!mountedRef.current) return;
        endDrag();
        endDragLine();
      }
    };

    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isDragging, endDrag, endDragLine, updateDragLineMouse, modelName, column.name]);

  // Drop target: highlight when dragging from a different model and hovering this column
  const isValidDropTarget = dragSourceModel !== null && dragSourceModel !== modelName;

  // Hide tooltip when drag/press starts or when editing
  useEffect(() => {
    if (isPressing || isDragging || editingField) {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
      setShowTooltip(false);
    }
  }, [isPressing, isDragging, editingField]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    };
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (isValidDropTarget) setIsDropTarget(true);
    if (tooltipEligible && !isDragging && !isPressing && !editingField) {
      tooltipTimerRef.current = setTimeout(() => setShowTooltip(true), 450);
    }
  }, [isValidDropTarget, tooltipEligible, isDragging, isPressing, editingField]);

  const handleMouseLeave = useCallback(() => {
    setIsDropTarget(false);
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    setShowTooltip(false);
    handlers.onMouseLeave();
  }, [handlers]);

  const pressClass = isPressing ? 'model-node__column--pressing' : '';
  const dragClass = isDragging ? 'model-node__column--dragging' : '';
  const dropTargetClass = isDropTarget ? 'model-node__column--drop-target' : '';
  const highlightClass = isHighlighted ? 'model-node__column--relationship-highlight' : '';
  const reorderDragClass = isReorderDragging ? 'model-node__column--reorder-dragging' : '';
  const reorderTargetClass = isReorderTarget ? 'model-node__column--reorder-target' : '';
  const discrepancyClass = discrepancy?.status === 'extra' ? 'model-node__column--disc-extra'
    : discrepancy?.status === 'type-mismatch' ? 'model-node__column--disc-mismatch'
    : '';

  return (
    <div
      ref={elementRef}
      className={`model-node__column ${pressClass} ${dragClass} ${dropTargetClass} ${highlightClass} ${reorderDragClass} ${reorderTargetClass} ${discrepancyClass} nodrag`.trim()}
      data-column-name={column.name}
      onMouseEnter={handleMouseEnter}
      // Viewer: no long-press drag-to-relate.
      {...(viewer ? {} : handlers)}
      onMouseLeave={handleMouseLeave}
    >
      {dragHandleProps && (
        <span
          className="model-node__col-reorder-handle nodrag"
          onMouseDown={(e) => { e.stopPropagation(); dragHandleProps.onMouseDown(e); }}
          title="Drag to reorder"
        >
          ⠿
        </span>
      )}
      <span className="model-node__col-indicators">
        {column.isPrimaryKey && (
          <KeyBadge type="PK" active={true} mode="readonly" />
        )}
        {column.isForeignKey && (
          <KeyBadge type="FK" active={true} mode="readonly" />
        )}
        {column.isNaturalKey && (
          <KeyBadge type="NK" active={true} mode="readonly" />
        )}
      </span>
      {editingField === 'name' ? (
        <input
          ref={editInputRef}
          className="model-node__col-edit-input model-node__col-edit-input--name nodrag"
          value={localValue}
          onChange={(e) => { setLocalValue(e.target.value); setEditError(null); }}
          onKeyDown={handleEditKeyDown}
          onBlur={handleEditBlur}
          onMouseDown={(e) => e.stopPropagation()}
          placeholder="column_name"
        />
      ) : (
        <span
          className={`model-node__col-name${!readOnly ? ' model-node__col-name--editable' : ''}`}
          title={!viewer && column.dbtKey ? `${column.name}\n${dbtKeyTitle(column.dbtKey)}` : column.name}
          onDoubleClick={!readOnly ? handleDoubleClickName : undefined}
        >
          {column.name}
        </span>
      )}
      {editingField === 'dataType' ? (
        <DataTypeSelect
          value={column.dataType}
          onChange={(newType) => {
            if (newType !== column.dataType) {
              const description = (column as unknown as { description?: string }).description ?? '';
              send({
                type: 'updateColumn',
                payload: {
                  modelName,
                  oldColumnName: column.name,
                  column: {
                    name: column.name,
                    dataType: newType,
                    description,
                    isPrimaryKey: column.isPrimaryKey,
                    isForeignKey: column.isForeignKey,
                    isNaturalKey: column.isNaturalKey,
                    ...(column.scdType != null ? { scdType: column.scdType } : {}),
                    ...(column.additiveType ? { additiveType: column.additiveType } : {}),
                  },
                },
              });
            }
            setEditingField(null);
            setEditError(null);
          }}
          onBlur={() => { setEditingField(null); setEditError(null); }}
          className="nodrag"
          autoOpen={true}
        />
      ) : discrepancy?.status === 'type-mismatch' ? (
        <span className="model-node__col-type model-node__col-type--mismatch" title={`${discrepancySourceStage ?? 'current'}: ${discrepancy.sourceDataType}, ${discrepancyTargetStage ?? 'target'}: ${discrepancy.targetDataType}`}>
          <span className="model-node__col-type-line" style={{ color: STAGE_HEX[discrepancySourceStage ?? ''] ?? 'inherit' }}>
            <span className="model-node__col-type-stage">{discrepancySourceStage ?? 'current'}:</span> {discrepancy.sourceDataType}
          </span>
          <span className="model-node__col-type-line" style={{ color: STAGE_HEX[discrepancyTargetStage ?? ''] ?? 'inherit' }}>
            <span className="model-node__col-type-stage">{discrepancyTargetStage ?? 'target'}:</span> {discrepancy.targetDataType}
          </span>
        </span>
      ) : (
        <span
          className={`model-node__col-type${!readOnly ? ' model-node__col-type--editable' : ''}`}
          // The type's colour as a hint the stylesheet blends into the quiet text tier.
          style={{ '--model-node-type-color': getDataTypeColor(column.dataType) } as CSSProperties}
          onDoubleClick={!readOnly ? handleDoubleClickType : undefined}
        >
          {column.dataType}
        </span>
      )}
      {editError && (
        <span className="model-node__col-edit-error">{editError}</span>
      )}
      {discrepancy?.status === 'extra' && (
        <span className="model-node__col-disc-badge model-node__col-disc-badge--extra" title={`Only in ${discrepancySourceStage ?? 'this stage'}`}>only here</span>
      )}
      {column.scdType != null && SCD_BADGE[column.scdType] && (
        <span
          className="model-node__col-badge model-node__col-badge--scd"
          title={SCD_TITLE[column.scdType] ?? `SCD Type ${column.scdType}`}
        >
          {SCD_BADGE[column.scdType]}
        </span>
      )}
      {column.additiveType && ADDITIVE_BADGE[column.additiveType] && (
        <span
          className="model-node__col-badge model-node__col-badge--additive"
          title={ADDITIVE_TITLE[column.additiveType] ?? column.additiveType}
        >
          {ADDITIVE_BADGE[column.additiveType]}
        </span>
      )}
      {!readOnly && !editingField && (
        <button
          type="button"
          className="model-node__col-delete nodrag"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleDelete}
          title="Delete column"
          aria-label={`Delete column ${column.name}`}
        >
          ×
        </button>
      )}
      <ColumnTooltip column={column} anchorRef={elementRef} visible={showTooltip} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// TableNode Component
// ---------------------------------------------------------------------------

/** The node's one line for a model file that exists but cannot be read. */
function describeLoadError(error: TableLoadError): string {
  if (error.kind === 'read') {
    return "ERD Studio can't read this file.";
  }
  // Absent from a DisplaySubjectArea built by an older core, which then reads as
  // the YAML error below — still true of a conflicted file.
  if (error.mergeConflict) {
    return error.line !== undefined
      ? `Unresolved git merge conflict on line ${error.line} — ERD Studio can't read this file.`
      : "Unresolved git merge conflict — ERD Studio can't read this file.";
  }
  // A `.dbml` table file (native DBML storage); an older core never sends
  // these kinds, so its nodes read exactly as before.
  const format = typeof error.kind === 'string' && error.kind.startsWith('dbml') ? 'DBML' : 'YAML';
  return error.line !== undefined
    ? `${format} error on line ${error.line} — ERD Studio can't read this file.`
    : `${format} error — ERD Studio can't read this file.`;
}

/** The node's one line for a model read from a file that needs fixing (#164). */
function describeLoadWarning(warning: TableLoadWarning): string {
  const key = warning.key ? `"${warning.key}"` : 'A key';
  return `${key} is written twice (line ${warning.line}) — the last one is shown. Remove the other copy to edit this table.`;
}

function TableNodeComponent({ id, data, selected }: NodeProps<TableFlowNode>) {
  const { modelName, tableName, label, stage, layer, layerConfig, schema, tableLayer, tableLayerConfig, otherLayer, shownSchema, singleLayer, alias, columns, grain, meta, dimmed, readOnly, isGhost, ghostReason, provenance, loadError, loadWarning, isStub, isExpanded = false, tableDetail, onToggleExpansion, discrepancy, discrepancySourceStage, discrepancyTargetStage } = data;
  const openNodeContextMenu = useEditorStore((s) => s.openNodeContextMenu);
  // Hover preview (useHoverFocus): the hovered table and its related tables
  // stay bright. A primitive, so a table outside the focus never re-renders.
  const focusRole = useEditorStore((s) => tableFocusRole(s.hoverFocus, id));
  const send = useSend();
  const viewer = useIsViewer();

  // Show reorder handles when this node is selected and editable
  const showReorderHandles = !!selected && !readOnly;

  const handleReorder = useCallback(
    (orderedNames: string[]) => {
      send({ type: 'reorderColumns', payload: { modelName, orderedNames } });
    },
    [send, modelName],
  );

  const { dragIndex, dropIndex, getDragHandleProps } = useColumnReorder({
    columns,
    onReorder: handleReorder,
    containerSelector: '.model-node__columns',
    rowSelector: '.model-node__column',
  });

  // The rows this table draws: the diagram's detail level (name / keys / all),
  // this table's own override, and the stub rule (PK / NK only), all decided
  // by the helper the size estimate also calls.
  const visible = useMemo(
    () => resolveVisibleColumns({ columns, isStub, isExpanded, tableDetail, loadError }),
    [columns, isExpanded, isStub, tableDetail, loadError],
  );
  const { columns: displayColumns, hiddenCount, toggle, toggleInFooter, isFullList } = visible;
  // The button row under the columns; at the name level the footer is the button instead.
  const rowToggle = toggleInFooter ? null : toggle;
  // With a level the buttons name what they do; without one they read as before.
  const hasLevel = tableDetail != null;
  const rowNoun = isStub ? 'key column' : 'column';
  // A stub's footer counts its key columns: all of them at a level, the rows drawn without one (as before).
  const stubKeyCount = hasLevel ? visible.expandedCount : displayColumns.length;

  // Handler for expand/collapse button
  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpansion?.(modelName);
  };

  // Handler for right-click to open context menu
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      openNodeContextMenu(e.clientX, e.clientY, modelName);
    },
    [openNodeContextMenu, modelName],
  );

  // All column names for inline rename duplicate validation
  const columnNames = useMemo(() => columns.map((c) => c.name), [columns]);

  // Build column discrepancy lookup (keyed by column name)
  const columnDiscrepancyMap = useMemo(() => {
    if (!discrepancy?.columns?.length) return undefined;
    const map = new Map<string, ColumnDiscrepancy>();
    for (const cd of discrepancy.columns) {
      map.set(cd.name, cd);
    }
    return map;
  }, [discrepancy]);

  // Missing columns (ghost rows) — only shown when every column is (the
  // `all` level or an opened table), so a closed table draws nothing per row.
  const showMissing = visible.expanded;
  const missingColumns = useMemo(() => {
    if (!showMissing || !columnDiscrepancyMap) return [];
    return (discrepancy?.columns ?? []).filter((cd) => cd.status === 'missing');
  }, [showMissing, columnDiscrepancyMap, discrepancy]);
  // The "No columns" line or the load error; at the `name` level only the error.
  const showPlaceholder = visible.placeholder && !missingColumns.length;
  // A table at a level with nothing to list is header and footer only.
  const hasBody = !hasLevel || displayColumns.length > 0 || rowToggle !== null || missingColumns.length > 0 || showPlaceholder;

  // Determine CSS modifier for stage/ghost
  const isDiscExtra = discrepancy?.status === 'extra';
  const stageClass = isGhost ? 'ghost' : stage;

  // Header hover tips. `title` is not a usable tooltip on a React Flow node —
  // the node is a drag surface and the browser shows the grab cursor instead —
  // so the header uses the same portal hover card the column rows use.
  // The header reads as the sidebar does: the model name, with the warehouse
  // name (alias) after it. The tip names the warehouse table in full.
  // A label without an alias or a schema prefix (older node data) keeps the
  // label-first header: the label, then the model name beside it.
  // One of two same-named tables prints its own name after its schema
  // (`ccc.addresse`), never the schema twice; see `headerName`.
  const labelFirst = !!label && !shownSchema && !alias;
  const shownName = headerName({ modelName, tableName, shownSchema });
  const qualified = `${shownSchema ? `${shownSchema}.` : ''}${shownName}`;
  const title = alias ? `${qualified} (warehouse table ${alias})` : labelFirst ? `${label} (table ${modelName})` : qualified;
  const modelMeta = useMemo(() => metaRows(meta), [meta]);
  const nameTip = useHoverTip<HTMLSpanElement>(
    ghostReason
      ? `${title} \u2014 ${(viewer ? GHOST_REASON_TITLE_NEUTRAL : GHOST_REASON_TITLE)[ghostReason]}`
      : isDiscExtra
        ? `${title} \u2014 only in ${discrepancySourceStage ?? 'this stage'}, not in ${discrepancyTargetStage ?? 'the stage being compared'}`
        : title,
    modelMeta,
  );
  // Relationships to tables not on this diagram: the editing host's context
  // only (a primitive, so other tables never re-render). Never in the viewer.
  const offDiagramCount = useEditorStore((s) => (viewer ? 0 : offDiagramRows(s.canvasContext, s.domain, modelName).length));
  const offDiagramTip = useHoverTip<HTMLSpanElement>(offDiagramCount > 0 ? offDiagramChipTip(offDiagramCount) : '');
  const sourceTip = useHoverTip<HTMLSpanElement>(
    provenance ? sourceTitle(provenance, columns, viewer) : '',
  );
  // The badge has one meaning: the layer the table lives in — its own when
  // known (DBML storage), else the diagram's. The schema is in the hover card
  // and, when it is not the layer's name, a prefix of the name.
  const ownLayer = tableLayer !== undefined;
  const badgeLayer = ownLayer ? tableLayer : layer;
  const badgeConfig = ownLayer ? tableLayerConfig : layerConfig;
  const badgeText = badgeLayer ? layerAbbreviation(badgeLayer, badgeConfig) : '';
  // A single-layer project has nothing to tell apart: no badge, no strip.
  const showBadge = !singleLayer && badgeText !== '';
  const layered = !singleLayer && ownLayer && !!tableLayerConfig?.color;
  const badgeTip = useHoverTip<HTMLSpanElement>(
    [
      `Layer: ${badgeConfig?.label ?? badgeLayer}`,
      ...(schema ? [`Schema: ${schema}`] : []),
      ...(otherLayer ? [`From another layer: this diagram is in ${layerConfig?.label ?? layer}.`] : []),
      ...(stage === 'physical' && !schema
        ? [viewer ? 'No schema resolved.' : 'No dbt schema resolved (run dbt compile or dbt docs generate).']
        : []),
    ].join('\n'),
  );

  return (
    <div
      className={`model-node model-node--${stageClass} model-node--stage-${stage}${ghostReason ? ` model-node--ghost-${ghostReason}` : ''}${dimmed ? ' model-node--dimmed' : ''}${readOnly ? ' model-node--readonly' : ''}${isDiscExtra ? ' model-node--disc-extra' : ''}${selected ? ' model-node--selected' : ''}${focusRole ? ` model-node--focus-${focusRole}` : ''}${layered ? ' model-node--layered' : ''}${otherLayer ? ' model-node--other-layer' : ''}`}
      style={layered ? ({ '--model-node-layer-color': tableLayerConfig!.color } as CSSProperties) : undefined}
      data-model-name={modelName}
      // Viewer: no context menu, so leave right-click to the browser.
      onContextMenu={viewer ? undefined : handleContextMenu}
    >
      {/* Node-level handles — one source + one target per side */}
      <Handle type="source" position={Position.Top} id="node-top-src" style={NODE_HANDLE_STYLE} />
      <Handle type="target" position={Position.Top} id="node-top-tgt" style={NODE_HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} id="node-right-src" style={NODE_HANDLE_STYLE} />
      <Handle type="target" position={Position.Right} id="node-right-tgt" style={NODE_HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} id="node-bottom-src" style={NODE_HANDLE_STYLE} />
      <Handle type="target" position={Position.Bottom} id="node-bottom-tgt" style={NODE_HANDLE_STYLE} />
      <Handle type="source" position={Position.Left} id="node-left-src" style={NODE_HANDLE_STYLE} />
      <Handle type="target" position={Position.Left} id="node-left-tgt" style={NODE_HANDLE_STYLE} />

      {/* Header */}
      <div className="model-node__header">
        <span className="model-node__name" {...nameTip.anchorProps}>
          {!labelFirst ? (
            <>
              {shownSchema && <span className="model-node__schema">{shownSchema}.</span>}
              {shownName}
              {alias && <span className="model-node__model-id">as {alias}</span>}
            </>
          ) : (
            <>
              {label}
              <span className="model-node__model-id">{modelName}</span>
            </>
          )}
        </span>
        {nameTip.tip}
        {offDiagramCount > 0 && (
          <span className="model-node__off-diagram" {...offDiagramTip.anchorProps}>
            +{offDiagramCount}
          </span>
        )}
        {offDiagramCount > 0 && offDiagramTip.tip}
        {provenance && (
          <span
            className={`model-node__source model-node__source--${provenance.types}`}
            {...sourceTip.anchorProps}
          >
            {(viewer ? SOURCE_LABEL_NEUTRAL : SOURCE_LABEL)[provenance.types]}
          </span>
        )}
        {sourceTip.tip}
        {showBadge && (
          <span
            className="model-node__badge"
            // The layer's colour; the stylesheet derives the capsule's fill, edge and text from it.
            style={badgeConfig?.color ? ({ '--model-node-badge-color': badgeConfig.color } as CSSProperties) : undefined}
            {...badgeTip.anchorProps}
          >
            {badgeText}
          </span>
        )}
        {showBadge && badgeTip.tip}
      </div>

      {/* Grain subtitle */}
      {grain && (
        <div className="model-node__grain" title={grain}>
          {grain}
        </div>
      )}

      {loadWarning && (
        <div className="model-node__load-warning" role="status">
          <span className="model-node__load-warning-text">{describeLoadWarning(loadWarning)}</span>
          {viewer ? null : (
            <button
              type="button"
              className="model-node__load-error-open nodrag"
              onClick={(e) => {
                e.stopPropagation();
                send({ type: 'openModelFile', payload: { modelName } });
              }}
            >
              Open file
            </button>
          )}
        </div>
      )}

      {/* Columns */}
      {hasBody && (
      <div className={`model-node__columns${displayColumns.length === 0 && rowToggle !== null && !missingColumns.length ? ' model-node__columns--closed' : ''}`}>
        {displayColumns.map((col, idx) => (
          <ColumnRow
            key={col.name}
            column={col}
            modelName={modelName}
            readOnly={readOnly}
            existingColumnNames={columnNames}
            discrepancy={columnDiscrepancyMap?.get(col.name)}
            // Only when the rows are the whole column list: `idx` is then the
            // column's index in the file, which is what a reorder moves.
            dragHandleProps={showReorderHandles && isFullList ? getDragHandleProps(idx) : undefined}
            isReorderDragging={dragIndex === idx}
            isReorderTarget={dropIndex === idx && dragIndex !== idx}
            discrepancySourceStage={discrepancySourceStage}
            discrepancyTargetStage={discrepancyTargetStage}
          />
        ))}

        {/* F405: Expansion button when columns are collapsed */}
        {rowToggle === 'expand' && (
          <button
            type="button"
            className="model-node__expand-button"
            onClick={handleToggleClick}
            title={hasLevel
              ? `Show every ${rowNoun} of this table (${hiddenCount} hidden)`
              : `Show ${hiddenCount} more column${hiddenCount !== 1 ? 's' : ''}`}
          >
            {hasLevel
              ? `Show all ${visible.expandedCount} ${rowNoun}${visible.expandedCount !== 1 ? 's' : ''}`
              : `...and ${hiddenCount} more`}
          </button>
        )}

        {/* F405: Collapse button when expanded */}
        {rowToggle === 'collapse' && (
          <button
            type="button"
            className="model-node__expand-button"
            onClick={handleToggleClick}
            title={hasLevel
              ? (tableDetail === 'name' ? 'Show only the name of this table again' : 'Show only the key columns of this table again')
              : 'Show fewer columns'}
          >
            {hasLevel ? (tableDetail === 'name' ? 'Show name only' : 'Show keys only') : 'Show less'}
          </button>
        )}

        {/* Ghost rows for missing columns (discrepancy overlay) */}
        {missingColumns.length > 0 && (
          <>
            <div
              className="model-node__separator model-node__separator--disc"
              title={`Below this line: columns ${discrepancyTargetStage ?? 'the compared stage'} has and ${discrepancySourceStage ?? 'this stage'} does not`}
            >
              <span className="model-node__separator-label model-node__separator-label--missing">only in {discrepancyTargetStage ?? 'comparison'}</span>
            </div>
            {missingColumns.map((cd) => (
              <div
                key={`ghost-${cd.name}`}
                className="model-node__column model-node__column--disc-missing nodrag"
                title={`${cd.name} is in ${discrepancyTargetStage ?? 'the compared stage'} but not in ${discrepancySourceStage ?? 'this stage'}`}
              >
                <span className="model-node__col-name">{cd.name}</span>
                <span className="model-node__col-type" style={cd.targetDataType ? ({ '--model-node-type-color': getDataTypeColor(cd.targetDataType) } as CSSProperties) : undefined}>{cd.targetDataType ?? ''}</span>
                <span className="model-node__col-disc-badge model-node__col-disc-badge--missing">{discrepancyTargetStage ?? 'target'} only</span>
              </div>
            ))}
          </>
        )}

        {showPlaceholder && (loadError ? (
          <div className="model-node__load-error" role="alert">
            <span className="model-node__load-error-text">{describeLoadError(loadError)}</span>
            {!viewer && (
              <button
                type="button"
                className="model-node__load-error-open nodrag"
                onClick={(e) => {
                  e.stopPropagation();
                  send({ type: 'openModelFile', payload: { modelName } });
                }}
              >
                Open file
              </button>
            )}
          </div>
        ) : (
          <div className="model-node__empty">No columns</div>
        ))}
      </div>
      )}

      {/* Footer. At the name level a closed table's footer is its "show all" button. */}
      {(() => {
        const footerContent = (
          <>
            {isStub
              ? `${stubKeyCount} key col${stubKeyCount !== 1 ? 's' : ''} of ${columns.length}`
              : tableDetail === 'keys' && toggle === 'expand'
                ? `${displayColumns.length} of ${columns.length} ${columns.length === 1 ? 'column' : 'columns'}`
                : `${columns.length} ${columns.length === 1 ? 'column' : 'columns'}`}
            {discrepancy && discrepancy.columns.length > 0 && (() => {
              const issues = discrepancy.columns.filter((c) => c.status !== 'matched').length;
              return issues > 0 ? (
                <span className="model-node__footer-disc" title={`${issues} column discrepanc${issues === 1 ? 'y' : 'ies'}`}>
                  {' '}&middot; {issues} diff{issues !== 1 ? 's' : ''}
                </span>
              ) : null;
            })()}
          </>
        );
        if (!toggleInFooter) return <div className="model-node__footer">{footerContent}</div>;
        const showAll = `Show all ${visible.expandedCount} ${rowNoun}${visible.expandedCount !== 1 ? 's' : ''}`;
        return (
          <button
            type="button"
            className="model-node__footer model-node__footer--toggle"
            onClick={handleToggleClick}
            aria-label={showAll}
            title={showAll}
          >
            {footerContent}
            <span className="model-node__footer-chevron" aria-hidden="true">▾</span>
          </button>
        );
      })()}
    </div>
  );
}

export const TableNode = memo(TableNodeComponent);
