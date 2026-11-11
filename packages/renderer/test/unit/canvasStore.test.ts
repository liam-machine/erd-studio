// @vitest-environment jsdom
/**
 * The canvas store slice, the standalone store factory and the context that
 * supplies a store to the canvas components.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import type { DisplaySubjectArea } from '@erd-studio/core';
import {
  createCanvasSlice,
  createCanvasStore,
  CanvasStoreProvider,
  useEditorStore,
  useEditorStoreApi,
  type CanvasSet,
} from '../../src/store/editorStore';

const subjectArea = (stage: 'logical' | 'physical' = 'logical'): DisplaySubjectArea => ({
  schemaVersion: 5,
  domain: 'sales',
  layer: 'silver',
  stage,
  description: '',
  models: [],
  relationships: [],
  viewConfig: {},
  readOnly: false,
  positionDraggable: true,
});

describe('createCanvasSlice', () => {
  it('starts with nothing selected, loaded, open or expanded', () => {
    const slice = createCanvasSlice((() => {}) as CanvasSet);
    expect(slice).toMatchObject({
      searchQuery: '',
      selectedNode: null,
      selectedEdges: [],
      selectedEdge: null,
      detailPanelOpen: false,
      pendingDeleteConfirmation: false,
      domain: null,
      nodes: [],
      edges: [],
      editingAnnotationId: null,
      existingModels: [],
      contextMenu: null,
      legendOpen: false,
      dragLineState: null,
      annotationLinkDrag: null,
      allExpanded: false,
      selectedColumns: [],
      lastSelectedColumn: null,
      editingColumn: null,
      selectedAnnotation: null,
      // Today's look: the stage colours, until a host says there is no dbt project.
      logicalOnly: false,
    });
    expect(slice.highlightedColumns).toEqual(new Set());
    expect(slice.expandedNodes).toEqual(new Set());
  });

  it('writes through the setter it is given', () => {
    const writes: unknown[] = [];
    const slice = createCanvasSlice(((partial: unknown) => { writes.push(partial); }) as CanvasSet);
    slice.setLegendOpen(true);
    slice.closeContextMenu();
    expect(writes).toEqual([{ legendOpen: true }, { contextMenu: null }]);
  });
});

describe('createCanvasStore', () => {
  it('seeds the initial state over the defaults', () => {
    const d = subjectArea();
    const store = createCanvasStore({ domain: d, legendOpen: true });
    expect(store.getState().domain).toBe(d);
    expect(store.getState().legendOpen).toBe(true);
    expect(store.getState().selectedNode).toBeNull();
  });

  it('gives each store its own state', () => {
    const a = createCanvasStore();
    const b = createCanvasStore();
    a.getState().selectNode('orders');
    expect(a.getState().selectedNode).toBe('orders');
    expect(b.getState().selectedNode).toBeNull();
  });

  it('setDomain replaces the domain and clears the column selection', () => {
    const store = createCanvasStore();
    store.getState().selectColumn('id');
    store.getState().setEditingColumn('id');
    const d = subjectArea();
    store.getState().setDomain(d);
    expect(store.getState()).toMatchObject({
      domain: d,
      selectedColumns: [],
      lastSelectedColumn: null,
      editingColumn: null,
    });
  });

  it('selecting an annotation clears the model selection and closes the panel', () => {
    const store = createCanvasStore();
    store.getState().selectNode('orders');
    store.getState().setDetailPanelOpen(true);
    store.getState().selectAnnotation('note-1');
    expect(store.getState()).toMatchObject({
      selectedAnnotation: 'note-1',
      selectedNode: null,
      detailPanelOpen: false,
    });
  });

  it('toggles column expansion per model and leaves "all expanded" mode', () => {
    const store = createCanvasStore();
    store.getState().expandAll(['a', 'b']);
    expect(store.getState().allExpanded).toBe(true);
    store.getState().toggleExpansion('a');
    expect([...store.getState().expandedNodes]).toEqual(['b']);
    expect(store.getState().allExpanded).toBe(false);
  });
});

describe('table detail level', () => {
  it('starts with no level, where the older actions behave as before', () => {
    const store = createCanvasStore();
    expect(store.getState().tableDetail).toBeNull();
    store.getState().expandAll(['a', 'b']);
    expect(store.getState()).toMatchObject({ tableDetail: null, allExpanded: true });
    expect([...store.getState().expandedNodes]).toEqual(['a', 'b']);
    store.getState().collapseAll();
    expect(store.getState()).toMatchObject({ tableDetail: null, allExpanded: false });
  });

  it('setTableDetail sets the level, mirrors "all" in allExpanded and closes the opened tables', () => {
    const store = createCanvasStore();
    store.getState().setTableDetail('keys');
    store.getState().toggleExpansion('a');
    store.getState().toggleExpansion('b');
    expect([...store.getState().expandedNodes]).toEqual(['a', 'b']);
    expect(store.getState()).toMatchObject({ tableDetail: 'keys', allExpanded: false });

    store.getState().setTableDetail('name');
    expect(store.getState()).toMatchObject({ tableDetail: 'name', allExpanded: false });
    expect(store.getState().expandedNodes.size).toBe(0);

    store.getState().setTableDetail('all');
    expect(store.getState()).toMatchObject({ tableDetail: 'all', allExpanded: true });
  });

  it('choosing the level already on closes the opened tables, and is no write when none is', () => {
    const store = createCanvasStore({ tableDetail: 'keys' });
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getState().expandedNodes;
    store.getState().setTableDetail('keys');
    expect(store.getState().expandedNodes).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    store.getState().toggleExpansion('a');
    store.getState().setTableDetail('keys');
    expect(store.getState().expandedNodes.size).toBe(0);
  });

  it('opening one table at a level keeps the level and the allExpanded mirror', () => {
    const store = createCanvasStore();
    store.getState().setTableDetail('keys');
    store.getState().toggleExpansion('a');
    expect(store.getState()).toMatchObject({ tableDetail: 'keys', allExpanded: false });
    store.getState().toggleExpansion('a');
    expect(store.getState().expandedNodes.size).toBe(0);
  });

  it('the older actions map onto the levels: expandAll is all, collapseAll is keys', () => {
    const store = createCanvasStore({ tableDetail: 'name' });
    store.getState().toggleExpansion('a');
    store.getState().expandAll(['a', 'b']);
    expect(store.getState()).toMatchObject({ tableDetail: 'all', allExpanded: true });
    expect(store.getState().expandedNodes.size).toBe(0);
    store.getState().collapseAll();
    expect(store.getState()).toMatchObject({ tableDetail: 'keys', allExpanded: false });
  });

  it('setTableDetail(null) drops the level with every table collapsed', () => {
    const store = createCanvasStore({ tableDetail: 'all', allExpanded: true });
    store.getState().setTableDetail(null);
    expect(store.getState()).toMatchObject({ tableDetail: null, allExpanded: false });
  });
});

describe('CanvasStoreProvider', () => {
  it('supplies its store to useEditorStore and useEditorStoreApi', () => {
    const store = createCanvasStore({ searchQuery: 'cust' });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(CanvasStoreProvider, { store, children });
    const { result } = renderHook(() => ({ query: useEditorStore((s) => s.searchQuery), api: useEditorStoreApi() }), { wrapper });
    expect(result.current.query).toBe('cust');
    expect(result.current.api).toBe(store);
  });

  it('throws a clear error when a component reads the store outside a provider', () => {
    // React logs the render error before rethrowing it; keep the output clean.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => renderHook(() => useEditorStore((s) => s.searchQuery))).toThrow(
        'useEditorStore must be used inside a CanvasStoreProvider (or <ErdCanvas>).',
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
