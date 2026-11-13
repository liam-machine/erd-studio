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
 * The editor's panel is a floating glass inspector: a sticky header (the
 * name, chips for the stage, layer, role and read-only, and a jump bar to
 * the sections once there are three), then the description and a grouped
 * "Details" card, the columns, the relationships and the rest, each a
 * quiet titled section.
 *
 * The viewer (`useIsViewer`) never has the host's context and keeps the
 * layout it always had, in the old order, with the Fields where the role,
 * grain, meta and rationale sections were: a section folded to its heading
 * and count until the reader opens it (it sits above Columns, so a few long
 * rationale values would push the columns and relationships out of a short
 * embedded canvas), and remembered from table to table. Its relationship
 * rows wrap instead of cutting names off, and it is never taller than the
 * canvas it floats over, stopping above the minimap's row.
 *
 * In both, the close button hides the panel but keeps the table selected
 * (its relationships stay lit; a click on the table opens the panel again),
 * which is exactly what the first click on the empty canvas, or Escape,
 * leaves (`lib/clickAway.ts`); the next click or Escape clears it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Panel, useStoreApi } from '@xyflow/react';

import { DescriptionEditor } from './DescriptionEditor';
import { AliasEditor } from './AliasEditor';
import { ColumnEditor } from './ColumnEditor';
import { FieldsSection, fieldRows, tableFieldsShown, type FieldsTable } from './FieldsSection';
import { IconChevron, IconClose, IconOpen, IconPencil } from './panelIcons';
import { roleLabel } from '../../lib/roleOptions';
import { useEditorStore, useEditorStoreApi } from '../../store/editorStore';
import { CLOSE_PANEL_PATCH } from '../../lib/clickAway';
import { useCanvasChrome } from '../../canvas/useCanvasChrome';
import { useCanvasHost, useIsViewer } from '../../host/canvasEnvironment';
import { STARTING_FIELD_LIST, backwardsRelationshipNote } from '@erd-studio/core';
import type { ColumnPair, DisplayRelationship, FieldList, PhysicalColumnSource, PhysicalProvenance } from '@erd-studio/core';
import { swapCardinality } from '../../lib/cardinalityUtils';
import type { FkEdgeData } from '../../types/graph';
import { columnPairs, foldComposites, relationshipEdgeId } from '../../lib/relationshipDisplayKey';
import { cardinalityLabel, offDiagramRows, offDiagramTableRows, ownValue, schemaFolderOfFile } from '../../lib/canvasContext';
import './DetailPanel.css';

/** A relationship row: a composite foreign key carries all its column pairs. */
type PanelRelationship = DisplayRelationship & { pairs?: ColumnPair[] };

/** One end's columns: `customer_key`, or `(customer_hk, as_of_date)` for a composite. */
function columnsText(rel: PanelRelationship, end: 'from' | 'to'): string {
  const cols = columnPairs(rel).map((p) => (end === 'from' ? p.fromColumn : p.toColumn));
  return cols.length === 1 ? cols[0] : `(${cols.join(', ')})`;
}

/**
 * A name the viewer's wrapping rows may break: a line break opportunity
 * (`<wbr>`) after each `_`, `.` and `, `, so a long identifier breaks at a
 * word boundary before `overflow-wrap: anywhere` has to cut it mid-word.
 */
function breakable(text: string): ReactNode[] {
  return text.split(/(?<=[_.]|, )/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]));
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
 * A relationship's cardinality in crow's-foot shorthand (`N:1`), read left
 * to right as the row reads (from → to). The editor's rows show it; the
 * full wording is the pill's tooltip. Anything unknown is shown as written.
 */
const CARDINALITY_SHORT: Record<string, string> = {
  'many-to-one': 'N:1',
  'one-to-many': '1:N',
  'one-to-one': '1:1',
  'many-to-many': 'N:M',
};

/** The editor's section jump bar: where each item scrolls to. */
type PanelSectionKey = 'overview' | 'columns' | 'relationships' | 'modelling';

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
  // The viewer's Fields fold: closed until the reader opens it, then kept open for the next table.
  const [viewerFieldsOpen, setViewerFieldsOpen] = useState(false);

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

  // The close button: hide the panel, keep the selection (and its
  // highlight), as the first click on the empty canvas does, and give the
  // focus to the selected table so a keyboard user keeps their place (Enter
  // on it opens the panel again).
  const flowStore = useStoreApi();
  const storeApi = useEditorStoreApi();
  // The viewer's panel stops above the minimap's row (sized from the canvas).
  const { panelBottomReserve } = useCanvasChrome();
  const handleHide = useCallback(() => {
    const id = selectedNode;
    storeApi.setState({ ...CLOSE_PANEL_PATCH });
    setConfirmingDelete(false);
    if (!id) return;
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    const el = flowStore.getState().domNode?.querySelector<HTMLElement>(`.react-flow__node[data-id="${escaped}"]`);
    el?.focus({ preventScroll: true });
  }, [selectedNode, storeApi, flowStore]);

  // The selected table's own name: what the rename box starts from and
  // compares with. For one of two same-named tables from different schema
  // folders the selection is `<schema>.<name>` and this is `<name>`; the
  // host is still told the selection (`oldName`), which names the table.
  const selectedTableName = useMemo(() => {
    if (!selectedNode) return null;
    const selected = domain?.models.find((m) => m.name === selectedNode);
    return selected?.tableName || selectedNode;
  }, [domain, selectedNode]);

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
      if (selectedTableName && trimmed !== selectedTableName && same(selectedTableName)) {
        return 'Only the upper/lower case differs — rename to another name first';
      }
      // A DBML table is a schema folder and a name: another schema folder's table
      // of the new name is another table (the diagram then names both
      // `<schema>.<name>`). Where either folder is unknown (a YAML table, the
      // host's context not in yet), the name alone decides, as before.
      const ownFolder = selectedNode ? schemaFolderOfFile(ownValue(canvasContext?.tableFiles, selectedNode)) : undefined;
      const clashes = (folder: string | undefined): boolean =>
        ownFolder === undefined || folder === undefined || folder.toLowerCase() === ownFolder.toLowerCase();
      // Each table's own name: two same-named tables are named `<schema>.<name>` on the diagram.
      if (domain && trimmed !== selectedTableName && domain.models.some((m) => same(m.tableName || m.name)
        && clashes(schemaFolderOfFile(ownValue(canvasContext?.tableFiles, m.name))))) {
        return 'A table with this name already exists';
      }
      // logical-models/ is shared across domains — renaming onto an existing
      // library model would overwrite a file another domain depends on.
      if (
        trimmed !== selectedTableName &&
        existingModels.some((m) => m.source === 'logical' && same(m.name) && clashes(m.schemaFolder))
      ) {
        return 'A table with this name already exists in the Table Library';
      }
      return '';
    },
    [domain, selectedTableName, selectedNode, existingModels, canvasContext],
  );

  const handleStartRename = useCallback(() => {
    if (!selectedNode || !selectedTableName) return;
    setNameValue(selectedTableName);
    setNameError('');
    setEditingName(true);
  }, [selectedNode, selectedTableName]);

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
    if (!trimmed || trimmed === selectedTableName) {
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
  }, [selectedNode, selectedTableName, nameValue, host, selectNode, validateModelName]);

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
    (tables: ReadonlyArray<{ otherTable: string; otherTablePath?: string }>) => {
      if (tables.length === 0) return;
      // A table the host named by its file is added by it too (another schema folder may have its name).
      const byFile = tables.some((t) => t.otherTablePath !== undefined);
      if (tables.length === 1) {
        host.postMessage({ type: 'addExistingModel', payload: { modelName: tables[0].otherTable, ...(byFile ? { sourcePath: tables[0].otherTablePath! } : {}) } });
      } else {
        const picked = tables.slice(0, ADD_ALL_RELATED_LIMIT);
        host.postMessage({
          type: 'addExistingModels',
          payload: { modelNames: picked.map((t) => t.otherTable), ...(byFile ? { sourcePaths: picked.map((t) => t.otherTablePath ?? '') } : {}) },
        });
      }
    },
    [host],
  );

  // --- Scroll: the header's hairline and the editor's section jump bar ------
  // The panel scrolls itself. Its sticky header shows a hairline only once
  // something has scrolled under it (the "scroll edge" look), and in the
  // editor the jump bar marks the section at the top of the view.
  const panelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [activeSection, setActiveSection] = useState<PanelSectionKey>('overview');
  const panelShown = detailPanelOpen && !!domain && !!model;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panelShown || !panel) return undefined;
    const onScroll = () => {
      setScrolled(panel.scrollTop > 2);
      if (viewer) return;
      const sections = [...panel.querySelectorAll<HTMLElement>('[data-panel-section]')];
      if (sections.length === 0) return;
      const limit = panel.getBoundingClientRect().top + (headerRef.current?.offsetHeight ?? 0) + 24;
      let current = sections[0].dataset.panelSection as PanelSectionKey;
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= limit) current = section.dataset.panelSection as PanelSectionKey;
      }
      // At the very bottom, a short last section is the one being read.
      if (panel.scrollHeight > panel.clientHeight && panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 2) {
        current = sections[sections.length - 1].dataset.panelSection as PanelSectionKey;
      }
      setActiveSection(current);
    };
    onScroll();
    panel.addEventListener('scroll', onScroll, { passive: true });
    return () => panel.removeEventListener('scroll', onScroll);
  }, [panelShown, viewer, selectedNode]);

  const jumpToSection = useCallback((key: PanelSectionKey) => {
    const panel = panelRef.current;
    const target = panel?.querySelector<HTMLElement>(`[data-panel-section="${key}"]`);
    if (!panel || !target) return;
    const headerHeight = headerRef.current?.offsetHeight ?? 0;
    const top = key === 'overview'
      ? 0
      : panel.scrollTop + target.getBoundingClientRect().top - panel.getBoundingClientRect().top - headerHeight - 8;
    const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof panel.scrollTo === 'function') {
      panel.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
    }
    setActiveSection(key);
  }, []);

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
    <div className="detail-panel__section detail-panel__section--fields">
      <FieldsSection
        modelName={model.name}
        table={model}
        fields={fieldList}
        readOnly={isReadOnly}
        logicalOnly={logicalOnly}
        {...(viewer ? { open: viewerFieldsOpen, onOpenChange: setViewerFieldsOpen } : {})}
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
      <div className="detail-panel__section detail-panel__section--columns" data-panel-section="columns">
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

  // The editor's pill reads N:1 (the wording is its tooltip); the viewer's wrapping row keeps the words.
  const cardinalityPill = (cardinality: string) => (
    viewer ? (
      <span className="detail-panel__rel-cardinality">
        {cardinality}
      </span>
    ) : (
      <span className="detail-panel__rel-cardinality" title={cardinalityLabel(cardinality)}>
        {CARDINALITY_SHORT[cardinality] ?? cardinality}
      </span>
    )
  );

  const relationshipsSection = (
    <>
      {/* Relationships */}
      {totalRelationships > 0 && (
        <div className="detail-panel__section detail-panel__section--relationships" data-panel-section="relationships">
          <h4 className="detail-panel__section-title">
            Relationships ({totalRelationships})
          </h4>
          <div className="detail-panel__relationships">
            {/* The viewer can't edit cardinality, so its rows are plain (not clickable). */}
            {/* Outgoing: this model references others */}
            {outgoing.map((rel) => (
              <div
                key={`out-${relationshipEdgeId(rel)}`}
                className={viewer ? 'detail-panel__relationship detail-panel__relationship--wrap' : 'detail-panel__relationship detail-panel__relationship--clickable'}
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
                    {viewer ? breakable(columnsText(rel, 'from')) : columnsText(rel, 'from')}
                  </span>
                  {viewer ? null : <span className="detail-panel__rel-arrow">→</span>}
                  <span className="detail-panel__rel-target" title={`${rel.toModel}.${columnsText(rel, 'to')}`}>
                    {/* The viewer keeps the arrow with the name it points at (a no-break space), so it never wraps onto a line alone. */}
                    {viewer ? <><span className="detail-panel__rel-arrow">→</span>{' '}</> : null}
                    {viewer ? breakable(`${rel.toModel}.${columnsText(rel, 'to')}`) : <>{rel.toModel}.{columnsText(rel, 'to')}</>}
                  </span>
                  {viewer ? (rel.role ? <span className="detail-panel__rel-role" title={`Role: ${rel.role}`}>{rel.role}</span> : null) : null}
                </span>
                {cardinalityPill(rel.cardinality)}
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
                    <IconClose size={12} />
                  </button>
                )}
              </div>
            ))}
            {/* Incoming: others reference this model */}
            {incoming.map((rel) => (
              <div
                key={`in-${relationshipEdgeId(rel)}`}
                className={viewer ? 'detail-panel__relationship detail-panel__relationship--wrap' : 'detail-panel__relationship detail-panel__relationship--clickable'}
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
                <span className="detail-panel__rel-direction detail-panel__rel-direction--in" title="Incoming FK">
                  ←
                </span>
                <span className="detail-panel__rel-columns">
                  <span className="detail-panel__rel-target" title={`${rel.fromModel}.${columnsText(rel, 'from')}`}>
                    {viewer ? breakable(`${rel.fromModel}.${columnsText(rel, 'from')}`) : <>{rel.fromModel}.{columnsText(rel, 'from')}</>}
                  </span>
                  {viewer ? null : <span className="detail-panel__rel-arrow">→</span>}
                  <span className="detail-panel__rel-local" title={columnsText(rel, 'to')}>
                    {viewer ? <><span className="detail-panel__rel-arrow">→</span>{' '}</> : null}
                    {viewer ? breakable(columnsText(rel, 'to')) : columnsText(rel, 'to')}
                  </span>
                  {viewer ? (rel.role ? <span className="detail-panel__rel-role" title={`Role: ${rel.role}`}>{rel.role}</span> : null) : null}
                </span>
                {cardinalityPill(rel.cardinality)}
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
                    <IconClose size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );

  // --- Overview: the table's facts (a grouped card) and its description ---

  const metadataCard = (
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
            <IconOpen size={12} />
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
        <span className="detail-panel__value" title={viewer ? undefined : (model.schema || undefined)}>{model.schema || '—'}</span>
      </div>
      {/* Without a dbt project the row shows only for a table that already
          has a warehouse name, so it can be seen and cleared. The viewer
          keeps the row it always had, worded without dbt: a page outside
          VS Code cannot know whether the project uses it. */}
      {viewer ? (
        <AliasEditor modelName={model.name} tableName={model.tableName} alias={model.alias} readOnly dbtWording={false} />
      ) : (!logicalOnly || model.alias?.trim()) ? (
        <AliasEditor modelName={model.name} tableName={model.tableName} alias={model.alias} readOnly={isReadOnly} dbtWording={!logicalOnly} />
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
  );

  const descriptionBlock = isReadOnly ? (
    model.description && (
      <p className="detail-panel__description">{model.description}</p>
    )
  ) : (
    <DescriptionEditor modelName={model.name} description={model.description} />
  );

  // --- Header: the name, what kind of table it is, and the jump bar -------

  const layerName = model.layer ?? domain.layer;
  const chips = viewer ? null : (
    <div className="detail-panel__chips">
      {!logicalOnly && (
        <span className={`detail-panel__chip detail-panel__chip--stage detail-panel__chip--${domain.stage}`}>
          {domain.stage === 'physical' ? 'Physical' : 'Logical'}
        </span>
      )}
      {layerName && <span className="detail-panel__chip" title="Layer">{layerName}</span>}
      {model.modelRole && <span className="detail-panel__chip" title="Table role">{roleLabel(model.modelRole)}</span>}
      {isReadOnly && <span className="detail-panel__chip detail-panel__chip--muted">Read-only</span>}
    </div>
  );

  const navItems: Array<{ key: PanelSectionKey; label: string }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'columns', label: 'Columns' },
    ...(totalRelationships > 0 || showOffDiagram ? [{ key: 'relationships' as const, label: 'Relationships' }] : []),
    ...(fieldsSection ? [{ key: 'modelling' as const, label: 'Modelling' }] : []),
  ];
  const nav = viewer || navItems.length < 3 ? null : (
    <nav className="detail-panel__nav" aria-label="Panel sections">
      {navItems.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`detail-panel__nav-item${activeSection === item.key ? ' detail-panel__nav-item--active' : ''}`}
          aria-current={activeSection === item.key ? 'true' : undefined}
          onClick={() => jumpToSection(item.key)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );

  // --- Render ------------------------------------------------------------

  return (
    <Panel
      ref={panelRef}
      position="top-right"
      className={viewer ? 'detail-panel detail-panel--viewer' : 'detail-panel'}
      style={viewer ? ({ '--detail-panel-bottom-reserve': `${panelBottomReserve}px` } as CSSProperties) : undefined}
    >
      {/* Header */}
      <div ref={headerRef} className={`detail-panel__header${scrolled ? ' detail-panel__header--scrolled' : ''}`}>
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
              aria-label="Table name"
              aria-invalid={nameError ? true : undefined}
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
            title={!isReadOnly ? 'Double-click to rename' : (model.tableName || model.name)}
            onDoubleClick={!isReadOnly ? handleStartRename : undefined}
          >
            {model.tableName || model.name}
          </h3>
        )}
        {!isReadOnly && !editingName && (
          <button
            className="detail-panel__title-edit-btn"
            onClick={handleStartRename}
            title="Rename table"
            aria-label="Rename table"
          >
            <IconPencil size={13} />
          </button>
        )}
        <button
          className="detail-panel__close"
          onClick={handleHide}
          title="Close the panel (the table stays selected)"
          aria-label="Close detail panel"
        >
          <IconClose size={14} />
        </button>
        {chips}
        {nav}
      </div>

      {viewer ? (
        <>
          {/* Metadata */}
          <div className="detail-panel__section detail-panel__section--overview">
            {metadataCard}
            {descriptionBlock}
          </div>
          {fieldsSection}
          {removeSection}
          {columnsSection}
          {relationshipsSection}
        </>
      ) : (
        <>
          {/* Overview: the description first, then the table's facts as a grouped card. */}
          <div className="detail-panel__section detail-panel__section--overview" data-panel-section="overview">
            {descriptionBlock}
            <h4 className="detail-panel__section-title detail-panel__section-title--details">Details</h4>
            {metadataCard}
          </div>
          {columnsSection}
          {relationshipsSection}
          {/* Editing host, logical stage: relationships to tables not on this diagram. */}
          {showOffDiagram && (
            <div
              className="detail-panel__section detail-panel__off-diagram"
              {...(totalRelationships > 0 ? {} : { 'data-panel-section': 'relationships' })}
            >
              <div className="detail-panel__off-diagram-head">
                <h4 className="detail-panel__section-title detail-panel__off-diagram-title">
                  Not on this diagram ({offRows.length})
                </h4>
                <button
                  type="button"
                  className="detail-panel__off-add-all"
                  onClick={() => handleAddTables(offDiagramTableRows(offRows))}
                  title="Add every table listed here to this diagram"
                >
                  Add all related
                </button>
              </div>
              <div className="detail-panel__relationships">
                {offRows.map((row) => {
                  const text = [row.columns, cardinalityLabel(row.cardinality), ...(row.otherLayer ? [`in ${row.otherLayer}`] : [])].join(' · ');
                  return (
                    <div
                      key={`off-${row.direction}-${row.otherTable}-${row.columns}`}
                      className="detail-panel__relationship detail-panel__off-row"
                    >
                      <span
                        className={`detail-panel__rel-direction${row.direction === 'out' ? '' : ' detail-panel__rel-direction--in'}`}
                        title={row.direction === 'out' ? 'Outgoing FK' : 'Incoming FK'}
                      >
                        {row.direction === 'out' ? '→' : '←'}
                      </span>
                      <span className="detail-panel__off-text" title={`${row.otherTable} · ${text}`}>
                        <span className="detail-panel__rel-target">{row.otherTable}</span>
                        <span className="detail-panel__off-detail">{` · ${text}`}</span>
                      </span>
                      <button
                        type="button"
                        className="detail-panel__off-add"
                        onClick={() => handleAddTables([row])}
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
            <div className="detail-panel__section detail-panel__modelling" data-panel-section="modelling">
              <button
                type="button"
                className="detail-panel__modelling-toggle"
                aria-expanded={modellingOpen}
                onClick={() => setModellingOpen((open) => !open)}
              >
                <span className="detail-panel__modelling-chevron" aria-hidden="true"><IconChevron size={12} /></span>
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
