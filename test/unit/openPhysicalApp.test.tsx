// @vitest-environment jsdom
/**
 * Run dbt parse's **Open Physical view** switches a canvas with the host's
 * existing `switchStageForUri`, which posts `stageData` with no `requestId`.
 * The webview applies such a host-initiated reply even after the user's own
 * earlier switchStage requests (a non-zero latest request id): no new
 * message type is needed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const mockVsCode = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn(),
}));

vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => mockVsCode,
  getVsCodeApi: () => mockVsCode,
}));

import { App } from '../../webview/App';
import { useEditorStore } from '../../webview/store/editorStore';
import { _resetStageRequests, currentStageRequestId, nextStageRequestId } from '../../webview/lib/stageRequest';
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const subjectArea = (stage: 'logical' | 'physical') => ({
  schemaVersion: 7, domain: 'sales', layer: 'gold', stage, description: '',
  models: [], relationships: [], viewConfig: {}, readOnly: stage === 'physical', positionDraggable: true,
}) as unknown as DisplaySubjectArea;

function postFromHost(data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  _resetStageRequests();
  useEditorStore.setState(initialStoreState, true);
});

afterEach(() => cleanup());

describe('Open Physical view after dbt parse', () => {
  it('applies a host-initiated physical stageData (no requestId) after earlier switchStage requests', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea('logical') });
    // The user had switched stages before (Logical → Physical → Logical).
    const a = nextStageRequestId();
    postFromHost({ type: 'stageData', payload: subjectArea('physical'), requestId: a });
    const b = nextStageRequestId();
    postFromHost({ type: 'stageData', payload: subjectArea('logical'), requestId: b });
    expect(useEditorStore.getState().domain?.stage).toBe('logical');
    expect(currentStageRequestId()).toBeGreaterThan(0);

    postFromHost({ type: 'stageData', payload: subjectArea('physical') });
    expect(useEditorStore.getState().domain?.stage).toBe('physical');
  });
});
