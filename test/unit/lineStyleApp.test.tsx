// @vitest-environment jsdom
/**
 * The line style in the webview: the toolbar's Curved / Hops switch renders
 * both options on every stage (a view preference, so read-only and physical
 * diagrams have it too), a click switches the store at once and posts
 * `setLineStyle`, and the host's `lineStyle` message sets the store (an
 * unknown value is ignored).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

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
import { LINE_STYLE_LABELS } from '../../webview/components/Toolbar/LineStyleSwitch';
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const subjectArea = (overrides: Partial<DisplaySubjectArea> = {}) =>
  ({
    schemaVersion: 6, domain: 'sales', layer: 'gold', stage: 'logical', description: '',
    models: [], relationships: [], viewConfig: {}, readOnly: false, positionDraggable: true,
    ...overrides,
  }) as unknown as DisplaySubjectArea;

function postFromHost(data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

const sent = () => mockVsCode.postMessage.mock.calls.map((c) => c[0] as { type: string; payload?: unknown });

const option = (name: string) => screen.getByRole('radio', { name });

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
  useEditorStore.setState(initialStoreState, true);
});

afterEach(() => cleanup());

describe('the toolbar line style switch', () => {
  it('shows Curved and Hops, Curved chosen by default, with hover text', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea() });
    const group = screen.getByRole('radiogroup', { name: 'Line style' });
    expect(group).toBeTruthy();
    expect(option('Curved').getAttribute('aria-checked')).toBe('true');
    expect(option('Hops').getAttribute('aria-checked')).toBe('false');
    expect(option('Curved').getAttribute('title')).toBe('Curved lines: soft curves that go around tables');
    expect(option('Hops').getAttribute('title')).toBe(LINE_STYLE_LABELS.hops.title);
    expect(option('Curved').className).toBe('line-style-switch__option line-style-switch__option--on');
  });

  it('a click switches at once and posts setLineStyle; a click on the chosen one posts nothing', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea() });
    mockVsCode.postMessage.mockClear();

    fireEvent.click(option('Hops'));
    expect(useEditorStore.getState().lineStyle).toBe('hops');
    expect(option('Hops').getAttribute('aria-checked')).toBe('true');
    expect(sent()).toEqual([{ type: 'setLineStyle', payload: { lineStyle: 'hops' } }]);

    fireEvent.click(option('Hops'));
    expect(sent()).toHaveLength(1);
  });

  it('is there on a read-only diagram and on the physical stage too', () => {
    render(<App />);
    postFromHost({ type: 'domainLoaded', payload: subjectArea({ readOnly: true }) });
    expect(screen.getByRole('radiogroup', { name: 'Line style' })).toBeTruthy();
    postFromHost({ type: 'stageData', payload: subjectArea({ stage: 'physical', readOnly: true }) });
    expect(screen.getByRole('radiogroup', { name: 'Line style' })).toBeTruthy();
    fireEvent.click(option('Hops'));
    expect(sent().at(-1)).toEqual({ type: 'setLineStyle', payload: { lineStyle: 'hops' } });
  });
});

describe('the host\'s lineStyle message', () => {
  it('sets the store and the switch; an unknown value is ignored', () => {
    render(<App />);
    postFromHost({ type: 'lineStyle', payload: { lineStyle: 'hops' } });
    expect(useEditorStore.getState().lineStyle).toBe('hops');
    postFromHost({ type: 'domainLoaded', payload: subjectArea() });
    expect(option('Hops').getAttribute('aria-checked')).toBe('true');

    postFromHost({ type: 'lineStyle', payload: { lineStyle: 'wavy' } });
    postFromHost({ type: 'lineStyle' });
    expect(useEditorStore.getState().lineStyle).toBe('hops');

    postFromHost({ type: 'lineStyle', payload: { lineStyle: 'curved' } });
    expect(option('Curved').getAttribute('aria-checked')).toBe('true');
  });

  it('survives a new diagram payload (setDomain keeps the reader\'s style)', () => {
    render(<App />);
    postFromHost({ type: 'lineStyle', payload: { lineStyle: 'hops' } });
    postFromHost({ type: 'domainLoaded', payload: subjectArea() });
    postFromHost({ type: 'stageData', payload: subjectArea({ stage: 'physical', readOnly: true }) });
    expect(useEditorStore.getState().lineStyle).toBe('hops');
  });
});
