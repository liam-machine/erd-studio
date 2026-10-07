// @vitest-environment jsdom
/**
 * RelationshipIssuesBanner (#133): the editable logical canvas's strip for the
 * findings a line cannot show — REL003 (missing model), REL004 (missing
 * column), REL008 (unreadable entry) — whose button posts repairRelationships.
 * Never on the physical stage, a read-only payload or an empty diagram.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const send = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useMessageBus', () => ({ useSend: () => send }));

import { RelationshipIssuesBanner, bannerHeadline } from '../../webview/components/Canvas/RelationshipIssuesBanner';
import { useEditorStore } from '../../webview/store/editorStore';
import type { DisplayDomain } from '../../src/types/display';

type Issue = NonNullable<DisplayDomain['relationshipIssues']>[number];
const REL003: Issue = { code: 'REL003', severity: 'error', message: 'fct_order points at dim_store, which is not in the model library.', link: 'x' };
const REL008: Issue = { code: 'REL008', severity: 'error', message: 'logical-models/fct_order.yml entry 2 was skipped.' };
const REL001: Issue = { code: 'REL001', severity: 'warning', message: 'Stored twice.', link: 'y' };

function setDomain(overrides: Partial<DisplayDomain> = {}) {
  useEditorStore.getState().setDomain({
    schemaVersion: 5, domain: 'sales', layer: 'gold', stage: 'logical', description: '',
    models: [{ name: 'fct_order', description: '', columns: [] }], relationships: [], viewConfig: {},
    readOnly: false, positionDraggable: true, relationshipIssues: [REL003, REL001, REL008],
    ...overrides,
  } as DisplayDomain);
}

beforeEach(() => setDomain());
afterEach(() => {
  cleanup();
  send.mockClear();
});

describe('RelationshipIssuesBanner', () => {
  it('counts only REL003 / REL004 / REL008 and lists them in its hover text', () => {
    render(<RelationshipIssuesBanner />);
    const headline = screen.getByText('2 relationships need attention');
    expect(headline.getAttribute('title')).toBe(`REL003: ${REL003.message}\nREL008: ${REL008.message}`);
    expect(bannerHeadline(1)).toBe('1 relationship needs attention');
  });

  it('Repair Relationships… posts repairRelationships with no payload', () => {
    render(<RelationshipIssuesBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Repair Relationships…' }));
    expect(send).toHaveBeenCalledWith({ type: 'repairRelationships' });
  });

  it('× hides it until the findings change', () => {
    const { container, rerender } = render(<RelationshipIssuesBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide until something changes' }));
    expect(container.innerHTML).toBe('');
    act(() => setDomain({ relationshipIssues: [REL003] }));
    rerender(<RelationshipIssuesBanner />);
    expect(screen.getByText('1 relationship needs attention')).toBeTruthy();
  });

  it('renders nothing without banner findings', () => {
    setDomain({ relationshipIssues: [REL001] });
    expect(render(<RelationshipIssuesBanner />).container.innerHTML).toBe('');
    cleanup();
    setDomain({ relationshipIssues: undefined });
    expect(render(<RelationshipIssuesBanner />).container.innerHTML).toBe('');
  });

  it('renders nothing on the physical stage, a read-only payload or an empty diagram', () => {
    for (const overrides of [{ stage: 'physical', readOnly: true }, { readOnly: true }, { models: [] }] as Partial<DisplayDomain>[]) {
      setDomain(overrides);
      expect(render(<RelationshipIssuesBanner />).container.innerHTML).toBe('');
      cleanup();
    }
  });
});
