/**
 * editorStore — the UI state transitions the canvas relies on: stage-switch
 * resets, selection exclusivity (node / annotation / column), FK dialog modes,
 * the discrepancy + sync lifecycle, column expansion and the error ring buffer
 * sent with bug reports. Complements editorStoreError.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '../../webview/store/editorStore';
import type { DisplayDomain } from '../../src/types/display';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { FeedbackAnalysis } from '../../src/types/feedback';
import type { FkEdgeData } from '../../webview/types/graph';

function domain(stage: 'logical' | 'physical', extra: Partial<DisplayDomain> = {}): DisplayDomain {
  return {
    schemaVersion: 5,
    domain: 'orders',
    layer: 'silver',
    stage,
    description: '',
    models: [],
    relationships: [],
    viewConfig: {},
    readOnly: stage === 'physical',
    positionDraggable: true,
    ...extra,
  } as DisplayDomain;
}

/** A minimal analysis reply, for the feedback-dialog lifecycle assertions. */
function analysis(): FeedbackAnalysis {
  return {
    kind: 'bug',
    confidence: 0.9,
    title: 'Edge vanished after a rename',
    context: '1. Rename a model',
    reasons: { desc: null, ctx: null, image: null },
    duplicates: [],
  };
}

const report = {
  domain: 'orders',
  layer: 'silver',
  sourceStage: 'logical',
  targetStage: 'physical',
  models: [],
  relationships: [],
} as unknown as DiscrepancyReport;

const edgeData: FkEdgeData = {
  fromModel: 'fact_order',
  fromColumn: 'customer_id',
  toModel: 'dim_customer',
  toColumn: 'customer_id',
  cardinality: 'many-to-one',
  stage: 'logical',
} as FkEdgeData;

const state = () => useEditorStore.getState();

/** Put the store into a fully-populated discrepancy + sync session. */
function startSyncSession() {
  const s = state();
  s.setDiscrepancyVisible(true);
  s.setDiscrepancyCompareStage('physical');
  s.setDiscrepancyReport(report);
  s.setSyncMode(true);
  s.setSyncSelection('model:dim_customer', 'logical');
  s.setManifestStale(true);
  s.setSyncPlanGenerated({ filePath: '.erd-studio/.sync-plan.json', totalActions: 2 });
}

beforeEach(() => {
  useEditorStore.setState(useEditorStore.getInitialState(), true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('editorStore domain lifecycle', () => {
  it('a stage switch clears discrepancy, sync state and the canvas mode', () => {
    state().setDomain(domain('logical'));
    startSyncSession();
    state().setCanvasMode('select');

    state().setDomain(domain('physical'));

    const s = state();
    expect(s.domain?.stage).toBe('physical');
    expect(s.discrepancyVisible).toBe(false);
    expect(s.discrepancyCompareStage).toBeNull();
    expect(s.discrepancyReport).toBeNull();
    expect(s.syncMode).toBe(false);
    expect(s.syncSelections).toEqual({});
    expect(s.manifestStale).toBe(false);
    expect(s.syncPlanGenerated).toBeNull();
    expect(s.canvasMode).toBe('pan');
  });

  it('a same-stage reload keeps discrepancy state and the canvas mode', () => {
    state().setDomain(domain('logical'));
    startSyncSession();
    state().setCanvasMode('select');

    state().setDomain(domain('logical', { description: 'reloaded' }));

    const s = state();
    expect(s.domain?.description).toBe('reloaded');
    expect(s.discrepancyVisible).toBe(true);
    expect(s.discrepancyReport).toBe(report);
    expect(s.syncMode).toBe(true);
    expect(s.syncSelections).toEqual({ 'model:dim_customer': 'logical' });
    expect(s.canvasMode).toBe('select');
  });

  it('the first domain payload does not reset the canvas mode (nothing to switch from)', () => {
    state().setCanvasMode('select');
    state().setDomain(domain('logical'));
    expect(state().canvasMode).toBe('select');
  });

  it('every domain payload clears column selection and editing', () => {
    state().setDomain(domain('logical'));
    state().selectColumn('customer_id');
    state().setEditingColumn('customer_id');

    state().setDomain(domain('logical'));

    expect(state().selectedColumns).toEqual([]);
    expect(state().lastSelectedColumn).toBeNull();
    expect(state().editingColumn).toBeNull();
  });
});

describe('editorStore selection exclusivity', () => {
  it('selectNode clears annotation and column selection', () => {
    const s = state();
    s.selectAnnotation('note-1');
    s.selectColumn('customer_id');
    s.setEditingColumn('customer_id');

    s.selectNode('dim_customer');

    expect(state().selectedNode).toBe('dim_customer');
    expect(state().selectedAnnotation).toBeNull();
    expect(state().selectedColumns).toEqual([]);
    expect(state().lastSelectedColumn).toBeNull();
    expect(state().editingColumn).toBeNull();
  });

  it('selectAnnotation clears node, edge and column state and closes the detail panel', () => {
    const s = state();
    s.selectNode('dim_customer');
    s.setDetailPanelOpen(true);
    s.setSelectedEdge('fk-1');
    s.setSelectedEdges(['fk-1']);
    s.setHighlightedColumns(new Set(['dim_customer:customer_id']));
    s.setPendingDeleteConfirmation(true);
    s.selectColumn('customer_id');

    s.selectAnnotation('note-1');

    const after = state();
    expect(after.selectedAnnotation).toBe('note-1');
    expect(after.selectedNode).toBeNull();
    expect(after.detailPanelOpen).toBe(false);
    expect(after.selectedEdge).toBeNull();
    expect(after.selectedEdges).toEqual([]);
    expect(after.highlightedColumns.size).toBe(0);
    expect(after.pendingDeleteConfirmation).toBe(false);
    expect(after.selectedColumns).toEqual([]);
    expect(after.lastSelectedColumn).toBeNull();
  });

  it('selectNode(null) deselects without throwing', () => {
    state().selectNode('dim_customer');
    state().selectNode(null);
    expect(state().selectedNode).toBeNull();
  });
});

describe('editorStore column selection', () => {
  const all = ['a', 'b', 'c', 'd', 'e'];

  it('single select, ctrl-toggle and shift-range from the anchor', () => {
    const s = state();
    s.selectColumn('b');
    expect(state().selectedColumns).toEqual(['b']);
    expect(state().lastSelectedColumn).toBe('b');

    s.toggleColumnSelection('d');
    expect(state().selectedColumns).toEqual(['b', 'd']);
    expect(state().lastSelectedColumn).toBe('d');

    s.toggleColumnSelection('d');
    expect(state().selectedColumns).toEqual(['b']);

    s.selectColumnRange('e', all);
    expect(state().selectedColumns).toEqual(['d', 'e']);
    // The anchor is kept so a second shift-click extends from the same point.
    expect(state().lastSelectedColumn).toBe('d');

    s.selectColumnRange('a', all);
    expect(state().selectedColumns).toEqual(['a', 'b', 'c', 'd']);
  });

  it('range-select without an anchor, or with an anchor not in the list, selects only the target', () => {
    state().selectColumnRange('c', all);
    expect(state().selectedColumns).toEqual(['c']);
    expect(state().lastSelectedColumn).toBe('c');

    useEditorStore.setState({ lastSelectedColumn: 'zzz' });
    state().selectColumnRange('d', all);
    expect(state().selectedColumns).toEqual(['d']);
    expect(state().lastSelectedColumn).toBe('d');
  });

  it('selecting a column ends any in-progress edit; clearColumnSelection resets everything', () => {
    state().setEditingColumn('a');
    state().selectColumn('a');
    expect(state().editingColumn).toBeNull();

    state().setEditingColumn('a');
    state().clearColumnSelection();
    expect(state().selectedColumns).toEqual([]);
    expect(state().lastSelectedColumn).toBeNull();
    expect(state().editingColumn).toBeNull();
  });
});

describe('editorStore FK dialog', () => {
  it('prefill (drag-to-connect) and edit data are mutually exclusive', () => {
    const s = state();
    s.openFkDialogWithPrefill({ fromModel: 'fact_order', fromColumn: 'customer_id', toModel: 'dim_customer' });
    expect(state().newFkDialogOpen).toBe(true);
    expect(state().fkDialogPrefill?.toModel).toBe('dim_customer');
    expect(state().fkDialogEditData).toBeNull();

    s.openFkDialogForEdit({ ...edgeData, cardinality: 'one-to-one' });
    expect(state().fkDialogEditData?.cardinality).toBe('one-to-one');
    expect(state().fkDialogPrefill).toBeNull();

    s.clearFkDialogEditData();
    s.setNewFkDialogOpen(false);
    expect(state().fkDialogEditData).toBeNull();
    expect(state().newFkDialogOpen).toBe(false);

    s.openFkDialogWithPrefill({ fromModel: 'a', fromColumn: 'b', toModel: 'c', toColumn: 'd' });
    s.clearFkDialogPrefill();
    expect(state().fkDialogPrefill).toBeNull();
  });
});

describe('editorStore discrepancy and sync', () => {
  it('hiding the overlay clears sync state; showing it does not', () => {
    startSyncSession();
    state().setDiscrepancyVisible(true);
    expect(state().syncMode).toBe(true);
    expect(state().syncSelections).toEqual({ 'model:dim_customer': 'logical' });

    state().setDiscrepancyVisible(false);
    const s = state();
    expect(s.discrepancyVisible).toBe(false);
    expect(s.syncMode).toBe(false);
    expect(s.syncSelections).toEqual({});
    expect(s.manifestStale).toBe(false);
    expect(s.syncPlanGenerated).toBeNull();
    // The report itself is owned by the extension and stays until replaced.
    expect(s.discrepancyReport).toBe(report);
  });

  it('entering sync mode discards a previously generated plan', () => {
    state().setSyncPlanGenerated({ filePath: 'p', totalActions: 1 });
    state().setSyncMode(true);
    expect(state().syncPlanGenerated).toBeNull();
    expect(state().syncMode).toBe(true);
  });

  it('bulk and single selections merge; clearSyncSelections drops them and the plan', () => {
    const s = state();
    s.setSyncSelectionBulk(['a', 'b', 'c'], 'physical');
    s.setSyncSelection('b', 'logical');
    expect(state().syncSelections).toEqual({ a: 'physical', b: 'logical', c: 'physical' });

    s.setSyncPlanGenerated({ filePath: 'p', totalActions: 3 });
    s.clearSyncSelections();
    expect(state().syncSelections).toEqual({});
    expect(state().syncPlanGenerated).toBeNull();
  });
});

describe('editorStore column expansion', () => {
  it('expandAll / toggle / expandNew / collapseAll / setExpandedNodes', () => {
    const s = state();
    s.expandAll(['a', 'b']);
    expect([...state().expandedNodes]).toEqual(['a', 'b']);
    expect(state().allExpanded).toBe(true);

    s.toggleExpansion('a');
    expect([...state().expandedNodes]).toEqual(['b']);
    expect(state().allExpanded).toBe(false);

    s.toggleExpansion('c');
    expect([...state().expandedNodes].sort()).toEqual(['b', 'c']);

    s.expandNew(['b', 'd']);
    expect([...state().expandedNodes].sort()).toEqual(['b', 'c', 'd']);
    expect(state().allExpanded).toBe(false);

    s.collapseAll();
    expect(state().expandedNodes.size).toBe(0);
    expect(state().allExpanded).toBe(false);

    s.setExpandedNodes(['x'], true);
    expect([...state().expandedNodes]).toEqual(['x']);
    expect(state().allExpanded).toBe(true);
  });

  it('never mutates the previous Set instance (React sees a new reference)', () => {
    state().expandAll(['a']);
    const before = state().expandedNodes;
    state().toggleExpansion('b');
    expect(state().expandedNodes).not.toBe(before);
    expect(before.has('b')).toBe(false);
  });
});

describe('editorStore bug report support', () => {
  it('recordError stamps entries with time and source and keeps only the newest 20', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
    state().recordError('webview', 'boom');
    expect(state().recentErrors).toEqual(['2026-01-02T03:04:05.000Z [webview] boom']);

    for (let i = 0; i < 25; i++) state().recordError('host', `err ${i}`);
    const errors = state().recentErrors;
    expect(errors).toHaveLength(20);
    expect(errors[0]).toContain('err 5');
    expect(errors[19]).toContain('err 24');
  });

  it('keeps the prefill only while the dialog is open', () => {
    state().setFeedbackDialogOpen(true, { kind: 'bug', title: 'Edge vanished' });
    expect(state().feedbackDialogOpen).toBe(true);
    expect(state().feedbackPrefill).toEqual({ kind: 'bug', title: 'Edge vanished' });

    state().setFeedbackDialogOpen(false, { title: 'ignored' });
    expect(state().feedbackDialogOpen).toBe(false);
    expect(state().feedbackPrefill).toBeNull();

    state().setFeedbackDialogOpen(true);
    expect(state().feedbackPrefill).toBeNull();
  });

  it('throws the analysis away when the dialog closes', () => {
    state().setFeedbackDialogOpen(true);
    state().setFeedbackAnalysisPending();
    expect(state().feedbackAnalysisState).toBe('thinking');

    state().setFeedbackAnalysis(analysis());
    expect(state().feedbackAnalysis).not.toBeNull();
    expect(state().feedbackAnalysisState).toBe('ready');

    state().setFeedbackAnalysis(null, 'The analysis could not be completed.');
    expect(state().feedbackAnalysisState).toBe('error');
    expect(state().feedbackError).toBe('The analysis could not be completed.');

    state().setFeedbackDialogOpen(false);
    expect(state().feedbackAnalysis).toBeNull();
    expect(state().feedbackAnalysisState).toBe('idle');
    expect(state().feedbackError).toBeNull();
  });

  it('stores the host diagnostics and capability snapshot verbatim', () => {
    const view = { chips: [{ label: 'ERD Studio 0.6.49', tone: 'normal' as const }], text: 'ERD Studio: 0.6.49' };
    const capabilities = {
      extensionVersion: '0.6.49',
      aiAvailable: false,
      aiProviderLabel: null,
      githubHandle: null,
      canCaptureCanvas: true,
    };
    state().setFeedbackContext(view, capabilities);
    expect(state().feedbackDiagnostics).toEqual(view);
    expect(state().feedbackCapabilities).toEqual(capabilities);
  });
});

describe('editorStore transient interaction state', () => {
  it('column drag line only updates while active', () => {
    const s = state();
    s.updateDragLineMouse(5, 5);
    expect(state().dragLineState).toBeNull();

    s.startDragLine('fact_order', 'customer_id', 1, 2);
    expect(state().dragLineState).toEqual({
      sourceModelName: 'fact_order', sourceColumnName: 'customer_id', sourceX: 1, sourceY: 2, currentX: 1, currentY: 2,
    });
    s.updateDragLineMouse(9, 8);
    expect(state().dragLineState?.currentX).toBe(9);
    expect(state().dragLineState?.currentY).toBe(8);
    s.endDragLine();
    expect(state().dragLineState).toBeNull();
  });

  it('annotation link drag only updates while active', () => {
    const s = state();
    s.updateAnnotationLinkDrag(5, 5);
    expect(state().annotationLinkDrag).toBeNull();

    s.startAnnotationLinkDrag('note-1', 3, 4);
    s.updateAnnotationLinkDrag(30, 40);
    expect(state().annotationLinkDrag).toEqual({ annotationId: 'note-1', sourceX: 3, sourceY: 4, currentX: 30, currentY: 40 });
    s.endAnnotationLinkDrag();
    expect(state().annotationLinkDrag).toBeNull();
  });

  it('context menus replace each other and close to null', () => {
    const s = state();
    s.openEdgeContextMenu(1, 2, edgeData);
    expect(state().contextMenu).toEqual({ type: 'edge', x: 1, y: 2, data: edgeData });
    s.openNodeContextMenu(3, 4, 'dim_customer');
    expect(state().contextMenu).toEqual({ type: 'node', x: 3, y: 4, modelName: 'dim_customer' });
    s.openAnnotationContextMenu(5, 6, 'note-1');
    expect(state().contextMenu).toEqual({ type: 'annotation', x: 5, y: 6, annotationId: 'note-1' });
    s.closeContextMenu();
    expect(state().contextMenu).toBeNull();
  });

  it('registered search-focus and auto-layout callbacks are invoked, and unregistering is safe', () => {
    const s = state();
    expect(() => s.focusSearchInput()).not.toThrow();
    expect(() => s.triggerAutoLayout()).not.toThrow();

    const focus = vi.fn();
    const layout = vi.fn();
    s.registerSearchFocus(focus);
    s.registerAutoLayout(layout);
    s.focusSearchInput();
    s.triggerAutoLayout();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(layout).toHaveBeenCalledTimes(1);

    s.registerSearchFocus(null);
    s.registerAutoLayout(null);
    s.focusSearchInput();
    s.triggerAutoLayout();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(layout).toHaveBeenCalledTimes(1);
  });

  it('simple setters store their values', () => {
    const s = state();
    s.setSearchQuery('dim');
    s.setViewport({ x: 10, y: 20, zoom: 2 });
    s.setToastMessage('Saved');
    s.setLegendOpen(true);
    s.setWelcomeModalOpen(true);
    s.setNewModelDialogOpen(true);
    s.setAddExistingModelDialogOpen(true);
    s.setEditingAnnotationId('note-1');
    s.setTemplates([{ name: 'dim' } as never]);
    s.setExistingModels([{ name: 'dim_x' } as never]);
    const after = state();
    expect(after.searchQuery).toBe('dim');
    expect(after.viewport).toEqual({ x: 10, y: 20, zoom: 2 });
    expect(after.toastMessage).toBe('Saved');
    expect(after.legendOpen).toBe(true);
    expect(after.welcomeModalOpen).toBe(true);
    expect(after.newModelDialogOpen).toBe(true);
    expect(after.addExistingModelDialogOpen).toBe(true);
    expect(after.editingAnnotationId).toBe('note-1');
    expect(after.templates).toHaveLength(1);
    expect(after.existingModels).toHaveLength(1);
  });
});
