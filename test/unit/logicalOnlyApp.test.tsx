// @vitest-environment jsdom
/**
 * Logical-only mode end to end in the webview: App.tsx reads the host's
 * `logicalOnly` envelope flag from every `domainLoaded` / `stageData` (the
 * same way as `manifestMissing`). Without a dbt project the canvas shows no
 * stage tabs, no Diff and no manifest refresh, the empty-diagram card drops
 * "Add Tables from dbt". A payload without the flag (an older host, or a dbt
 * project) keeps today's behaviour. The retired first-open "Two Stages"
 * modal never shows, whatever an older host's `welcomeDismissed` says.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

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
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const emptySubjectArea = {
  schemaVersion: 6, domain: 'sales', layer: 'gold', stage: 'logical', description: '',
  models: [], relationships: [], viewConfig: {}, readOnly: false, positionDraggable: true,
} as unknown as DisplaySubjectArea;

function postFromHost(data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

const sent = () => mockVsCode.postMessage.mock.calls.map((c) => c[0] as { type: string });

beforeAll(() => {
  // React Flow measures its container; jsdom has no ResizeObserver.
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
  useEditorStore.setState(initialStoreState, true);
});

afterEach(() => cleanup());

describe('logical-only mode (no dbt project)', () => {
  it('domainLoaded with logicalOnly: no tabs, no Diff, no refresh, no dbt button', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: emptySubjectArea, welcomeDismissed: false, logicalOnly: true });

    expect(useEditorStore.getState().logicalOnly).toBe(true);
    expect(screen.queryByRole('tablist', { name: 'Design stage' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Compare with dbt' })).toBeNull();
    expect(screen.queryByRole('button', { name: /refresh manifest data/i })).toBeNull();

    expect(screen.queryByText('The Two Stages')).toBeNull();
    expect(sent().some((m) => m.type === 'dismissWelcome')).toBe(false);

    expect(screen.queryByRole('button', { name: 'Add Tables from dbt' })).toBeNull();
    expect(screen.getByText('Add your first table.')).toBeTruthy();
  });

  it('draws the neutral canvas without dbt, and the stage colours with it', () => {
    const { container } = render(<App />);
    postFromHost({ type: 'domainLoaded', payload: emptySubjectArea, welcomeDismissed: true, logicalOnly: true });
    expect(container.querySelector('.editor-canvas')!.className).toContain('editor-canvas--neutral');

    postFromHost({ type: 'stageData', payload: emptySubjectArea });
    expect(container.querySelector('.editor-canvas')!.className).not.toContain('editor-canvas--neutral');
  });

  it('stageData carries the flag too', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: emptySubjectArea, welcomeDismissed: true });
    expect(useEditorStore.getState().logicalOnly).toBe(false);

    postFromHost({ type: 'stageData', payload: emptySubjectArea, logicalOnly: true });
    expect(useEditorStore.getState().logicalOnly).toBe(true);
    expect(screen.queryByRole('tablist', { name: 'Design stage' })).toBeNull();
  });

  it('a payload without the flag keeps today\'s behaviour: tabs, Diff and refresh, and no welcome modal', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: emptySubjectArea, welcomeDismissed: false });

    expect(useEditorStore.getState().logicalOnly).toBe(false);
    expect(screen.getByRole('tablist', { name: 'Design stage' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Compare with dbt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /refresh manifest data/i })).toBeTruthy();
    // An older host still sends welcomeDismissed: false; the retired modal stays gone.
    expect(screen.queryByText('Welcome to ERD Studio')).toBeNull();
    expect(screen.queryByText('The Two Stages')).toBeNull();
  });
});
