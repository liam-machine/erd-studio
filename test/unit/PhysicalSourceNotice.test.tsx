// @vitest-environment jsdom
/**
 * PhysicalSourceNotice — the physical stage's strip when dbt has not been run
 * (#110): says why columns and tests are missing, and "Run dbt parse" posts
 * `runDbtParse`. Nothing renders once dbt has written a manifest or catalog,
 * on the logical stage, or after dismissal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const send = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useMessageBus', () => ({ useSend: () => send }));

const dismissPhysicalSourceNotice = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../../webview/store/editorStore', () => ({
  useEditorStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
}));

import { PhysicalSourceNotice } from '../../webview/components/Canvas/PhysicalSourceNotice';

function setDomain(overrides: Record<string, unknown> = {}) {
  storeState.domain = {
    stage: 'physical',
    physicalSources: { yml: true, manifest: false, catalog: false },
    ...overrides,
  };
}

beforeEach(() => {
  Object.assign(storeState, { physicalSourceNoticeDismissed: false, dismissPhysicalSourceNotice });
  setDomain();
});

afterEach(() => {
  cleanup();
  send.mockClear();
  dismissPhysicalSourceNotice.mockClear();
});

describe('PhysicalSourceNotice', () => {
  it('explains the missing manifest and what parse needs', () => {
    render(<PhysicalSourceNotice />);
    const text = document.body.textContent ?? '';
    expect(text).toContain("dbt hasn't been run in this project yet, so ERD Studio can't read your models' columns and tests.");
    expect(text).toContain('Needs a working dbt profile. For real column types, run dbt docs generate afterwards.');
    expect(text).not.toContain('dbt compile');
  });

  it('"Run dbt parse" posts runDbtParse', () => {
    const { getByRole } = render(<PhysicalSourceNotice />);
    fireEvent.click(getByRole('button', { name: 'Run dbt parse' }));
    expect(send).toHaveBeenCalledWith({ type: 'runDbtParse' });
    expect(dismissPhysicalSourceNotice).not.toHaveBeenCalled();
  });

  it('the dismiss button still dismisses without posting', () => {
    const { getByRole } = render(<PhysicalSourceNotice />);
    fireEvent.click(getByRole('button', { name: 'Dismiss' }));
    expect(dismissPhysicalSourceNotice).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['a manifest', { physicalSources: { yml: true, manifest: true, catalog: false } }],
    ['a catalog', { physicalSources: { yml: true, manifest: false, catalog: true } }],
    ['the logical stage', { stage: 'logical', physicalSources: undefined }],
  ])('renders nothing with %s', (_label, overrides) => {
    setDomain(overrides);
    const { container } = render(<PhysicalSourceNotice />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing once dismissed', () => {
    storeState.physicalSourceNoticeDismissed = true;
    const { container } = render(<PhysicalSourceNotice />);
    expect(container.innerHTML).toBe('');
  });
});
