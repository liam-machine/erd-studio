// @vitest-environment jsdom
/**
 * #294 — a large import's first-open layout that times out.
 *
 * Drives the real Toolbar and the real `runElkLayout` (only the ELK engine is
 * faked: it never answers, as a layout past the 30 s guard does) against the
 * real store, and checks what the issue's acceptance criteria ask for:
 *
 *  - a first-open layout that times out leaves the diagram with saved
 *    positions (one `updatePositions` for every table), so the next open does
 *    not start another 30-second layout;
 *  - no toast contains "ELK" or a raw error message, for any failure class:
 *    each class's words and buttons are pinned below (`layoutFailureNotice`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const fakes = vi.hoisted(() => {
  const state = {
    layoutCalls: 0,
    layoutImpl: (_graph?: unknown): Promise<unknown> => new Promise(() => {}), // never answers
  };
  class FakeELK {
    constructor(opts: { workerFactory: () => unknown }) {
      opts.workerFactory();
    }
    layout(graph: unknown): Promise<unknown> {
      state.layoutCalls++;
      return state.layoutImpl(graph);
    }
  }
  return { FakeELK, state };
});
const mockVsCode = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));

vi.mock('elkjs/lib/elk-api', () => ({ default: fakes.FakeELK }));
vi.mock('../../webview/hooks/useVsCodeApi', () => ({ useVsCodeApi: () => mockVsCode }));
vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useReactFlow: () => ({ zoomIn: vi.fn(), zoomOut: vi.fn(), fitView: vi.fn(), getNode: vi.fn(), getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })) }),
  useStore: () => 1,
  useNodesInitialized: () => true,
}));
vi.mock('../../webview/components/Toolbar/StageTabs', () => ({ StageTabs: () => null }));

import { Toolbar } from '../../webview/components/Toolbar/Toolbar';
import { useEditorStore } from '../../webview/store/editorStore';
import { LAYOUT_TIMEOUT_MS, classifyLayoutFailure, layoutFailureNotice } from '../../webview/lib/elkLayout';
import type { TableFlowNode, FkFlowEdge } from '../../webview/types/graph';
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();
const TABLES = 300; // the "51+" bucket the reporter hit; under GRID_LAYOUT_MIN_TABLES, so ELK is tried

const names = Array.from({ length: TABLES }, (_, i) => `table_${i}`);

/** The host's simple fallback placement, sent with `autoLayout` and not persisted. */
function importedSubjectArea(positions: Record<string, { x: number; y: number }>): DisplaySubjectArea {
  return {
    schemaVersion: 5,
    domain: 'imported',
    layer: 'silver',
    stage: 'logical',
    models: names.map((name) => ({ name, columns: [] })),
    relationships: [],
    viewConfig: { positions },
    readOnly: false,
  } as unknown as DisplaySubjectArea;
}
const hostFallback = Object.fromEntries(names.map((n, i) => [n, { x: (i % 20) * 300, y: Math.floor(i / 20) * 250 }]));

const nodes: TableFlowNode[] = names.map((id) => ({
  id,
  type: 'model',
  position: hostFallback[id],
  measured: { width: 260, height: 180 },
  data: { modelName: id, stage: 'logical', layer: 'silver', columns: [], isStub: false },
} as TableFlowNode));
const edges: FkFlowEdge[] = [];

const posts = (type: string) => mockVsCode.postMessage.mock.calls.filter(([m]) => m?.type === type).map(([m]) => m);

beforeEach(() => {
  useEditorStore.setState(initialStoreState, true);
  vi.clearAllMocks();
  fakes.state.layoutCalls = 0;
  fakes.state.layoutImpl = () => new Promise(() => {});
  (globalThis as Record<string, unknown>).__ELK_WORKER_CODE__ = '';
  (globalThis as Record<string, unknown>).Worker = class { onerror = null; onmessage = null; terminate = vi.fn(); };
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:fake');
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('#294 first-open layout of a large import that times out', () => {
  it('saves positions for every table once, and the next open does not lay out again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => {
      useEditorStore.getState().setDomain(importedSubjectArea(hostFallback));
      useEditorStore.getState().setPendingAutoLayout(true);
    });
    await act(async () => { render(<Toolbar nodes={nodes} edges={edges} />); });
    expect(fakes.state.layoutCalls).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(LAYOUT_TIMEOUT_MS + 10); });

    // One ELK attempt only: a timeout goes straight to the grid.
    expect(fakes.state.layoutCalls).toBe(1);
    const saved = posts('updatePositions');
    expect(saved).toHaveLength(1);
    expect(Object.keys(saved[0].payload.positions)).toHaveLength(TABLES);
    expect(posts('layoutFinished')[0].payload).toMatchObject({ ok: true, firstOpen: true, rung: 3 });
    // The timeout's plain words, with Send Feedback only (trying again would wait again).
    expect(useEditorStore.getState().toastMessage).toBe(
      'This diagram is too large to arrange automatically (ERD Studio stopped after 30 seconds). Your tables are all here, in tidy columns in relationship order. This is a limit in ERD Studio, not a problem with your files.',
    );
    expect(useEditorStore.getState().toastActions).toEqual(['layoutFeedback']);

    // The host's next load carries the saved positions and no autoLayout flag.
    act(() => {
      useEditorStore.getState().setDomain(importedSubjectArea(saved[0].payload.positions));
      useEditorStore.getState().setPendingAutoLayout(false);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(fakes.state.layoutCalls).toBe(1);
  });

  // When even the grid fails, runElkLayout rejects with the first error; the
  // toast must still use plain words: no "ELK", no raw message.
  it.each([
    ['timeout', `ELK layout timed out after ${LAYOUT_TIMEOUT_MS / 1000}s`],
    ['worker', 'ELK layout worker crashed: out of memory'],
    ['stack', 'Maximum call stack size exceeded'],
    ['other', 'java.lang.NullPointerException: org.eclipse.elk.alg.layered.p5edges.Foo'],
  ] as const)('a %s failure toast shows neither "ELK" nor the raw error message', async (_cls, message) => {
    fakes.state.layoutImpl = () => Promise.reject(new Error(message));
    // Break the grid as well, so the ladder is exhausted and runElkLayout rejects.
    let reads = 0;
    const breaking = nodes.map((n, i) => (i === 0 ? {
      ...n,
      get measured() { if (++reads > 2) throw new Error('grid failed'); return { width: 260, height: 180 }; },
    } as TableFlowNode : n));
    act(() => {
      useEditorStore.getState().setDomain(importedSubjectArea(hostFallback));
      useEditorStore.getState().setPendingAutoLayout(true);
    });
    await act(async () => { render(<Toolbar nodes={breaking} edges={edges} />); });
    await vi.waitFor(() => expect(posts('layoutFinished')).toHaveLength(1));
    expect(posts('layoutFinished')[0].payload).toMatchObject({ ok: false, firstOpen: true });

    const toast = useEditorStore.getState().toastMessage ?? '';
    expect(toast).not.toBe('');
    expect(toast).not.toContain('ELK');
    expect(toast).not.toContain(message);
    // The tables stayed where they were: the words and buttons of the class
    // this error is classified as (untagged text here, so a "timed out" is
    // `other` and "out of memory" is `memory`; the guard's own errors are tagged).
    const expected = layoutFailureNotice(classifyLayoutFailure(new Error(message)), false);
    expect(toast).toBe(expected.message);
    expect(useEditorStore.getState().toastActions).toEqual(expected.actions);
    expect(posts('updatePositions')).toHaveLength(0);
  });
});

// The issue's acceptance criterion: each class's message and buttons, pinned.
describe('layoutFailureNotice (#294)', () => {
  const LIMIT_GRID = 'This diagram is too large to arrange automatically (ERD Studio stopped after 30 seconds). Your tables are all here, in tidy columns in relationship order. This is a limit in ERD Studio, not a problem with your files.';
  const LIMIT_IN_PLACE = 'This diagram is too large to arrange automatically (ERD Studio stopped after 30 seconds). Your tables are all here, where they were. This is a limit in ERD Studio, not a problem with your files.';
  const BUG_GRID = "ERD Studio couldn't arrange this diagram automatically, so your tables are in tidy columns in relationship order. This is a bug in ERD Studio, not a problem with your files.";
  const BUG_IN_PLACE = "ERD Studio couldn't arrange this diagram. Your tables are where they were. This is a bug in ERD Studio, not a problem with your files.";

  it.each([
    ['timeout', true, LIMIT_GRID, ['layoutFeedback']],
    ['timeout', false, LIMIT_IN_PLACE, ['layoutFeedback']],
    ['worker', true, BUG_GRID, ['retryLayout', 'layoutFeedback']],
    ['worker', false, BUG_IN_PLACE, ['retryLayout', 'layoutFeedback']],
    ['stack', true, BUG_GRID, ['retryLayout', 'layoutFeedback']],
    ['stack', false, BUG_IN_PLACE, ['retryLayout', 'layoutFeedback']],
    ['other', true, BUG_GRID, ['retryLayout', 'layoutFeedback']],
    ['other', false, BUG_IN_PLACE, ['retryLayout', 'layoutFeedback']],
  ] as const)('%s (arranged in the grid: %s)', (failure, arranged, message, actions) => {
    expect(layoutFailureNotice(failure, arranged)).toEqual({ message, actions });
  });

  it('running out of memory is a limit too, and no class names the engine', () => {
    expect(layoutFailureNotice('memory', true)).toEqual({
      message: 'This diagram is too large to arrange automatically (ERD Studio ran out of memory). Your tables are all here, in tidy columns in relationship order. This is a limit in ERD Studio, not a problem with your files.',
      actions: ['layoutFeedback'],
    });
    for (const failure of ['timeout', 'worker', 'stack', 'other', 'memory', 'unsupported', 'input', 'engine', 'result'] as const) {
      for (const arranged of [true, false]) {
        expect(layoutFailureNotice(failure, arranged).message).not.toMatch(/ELK|Eclipse|exception|error/i);
      }
    }
  });
});
