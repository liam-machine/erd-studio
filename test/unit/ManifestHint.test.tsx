// @vitest-environment jsdom
/**
 * ManifestHint — the logical stage's "Run dbt parse" strip (#113). Driven by
 * the real editor store; only the message sender is mocked. The store's
 * `manifestMissing` is what App.tsx sets from every `domainLoaded` /
 * `stageData`, so `setManifestMissing(false)` stands in for a payload without
 * the flag (the watcher's refresh once dbt has written manifest.json).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

const send = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useMessageBus', () => ({ useSend: () => send }));

import { ManifestHint } from '../../webview/components/Canvas/ManifestHint';
import { useEditorStore } from '../../webview/store/editorStore';
import type { DisplayDomain } from '../../src/types/display';

const LEAD =
  "dbt hasn't parsed this project yet. Your diagram is fine, but the Physical view can't show columns and tests without it.";
const CLOSE_LABEL = "Don't show again for this project";

function domain(overrides: Partial<DisplayDomain> = {}): DisplayDomain {
  return {
    schemaVersion: 5,
    domain: 'orders',
    layer: 'silver',
    stage: 'logical',
    description: '',
    models: [{ name: 'fct_order', description: '', columns: [] }],
    relationships: [],
    viewConfig: {},
    readOnly: false,
    ...overrides,
  } as DisplayDomain;
}

beforeEach(() => {
  useEditorStore.setState({ manifestMissing: false, manifestHintDismissed: false });
  useEditorStore.getState().setDomain(domain());
  useEditorStore.getState().setManifestMissing(true);
});

afterEach(() => {
  cleanup();
  send.mockClear();
});

describe('ManifestHint', () => {
  it('renders on the logical stage with models when the manifest is missing', () => {
    render(<ManifestHint />);
    const text = document.body.textContent ?? '';
    expect(text).toContain(LEAD);
    expect(text).toContain('Needs a working dbt profile.');
  });

  it('"Run dbt parse" posts runDbtParse', () => {
    const { getByRole } = render(<ManifestHint />);
    fireEvent.click(getByRole('button', { name: 'Run dbt parse' }));
    expect(send).toHaveBeenCalledWith({ type: 'runDbtParse' });
    expect(useEditorStore.getState().manifestHintDismissed).toBe(false);
  });

  it('× posts dismissManifestHint and hides at once', () => {
    const { getByRole, container } = render(<ManifestHint />);
    const close = getByRole('button', { name: CLOSE_LABEL });
    expect(close.getAttribute('title')).toBe(CLOSE_LABEL);
    fireEvent.click(close);
    expect(send).toHaveBeenCalledWith({ type: 'dismissManifestHint' });
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing on an empty diagram (the EmptyCanvas card speaks there)', () => {
    useEditorStore.getState().setDomain(domain({ models: [] }));
    const { container } = render(<ManifestHint />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing on the physical stage', () => {
    useEditorStore.getState().setDomain(domain({ stage: 'physical' }));
    const { container } = render(<ManifestHint />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing once dismissed, even across later payloads', () => {
    useEditorStore.setState({ manifestHintDismissed: true });
    useEditorStore.getState().setDomain(domain());
    useEditorStore.getState().setManifestMissing(true);
    const { container } = render(<ManifestHint />);
    expect(container.innerHTML).toBe('');
  });

  it('disappears when a payload arrives without the flag', () => {
    const { container } = render(<ManifestHint />);
    expect(container.textContent).toContain(LEAD);
    act(() => useEditorStore.getState().setManifestMissing(false));
    expect(container.innerHTML).toBe('');
  });

  it('survives a local setDomain (a drag merging positions)', () => {
    const { container } = render(<ManifestHint />);
    act(() => useEditorStore.getState().setDomain(domain({ viewConfig: { positions: { fct_order: { x: 1, y: 2 } } } })));
    expect(container.textContent).toContain(LEAD);
  });
});
