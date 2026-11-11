// @vitest-environment jsdom
/**
 * TableDetailSwitch — the toolbar's Names / Keys / All control: a radio group
 * with one tab stop, operable by click and by the arrow keys, that sets the
 * diagram's table detail level, closes the tables opened on their own, and
 * posts nothing to the host.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const mockVsCode = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => mockVsCode,
}));

import { TableDetailSwitch, TABLE_DETAIL_LABELS } from '../../webview/components/Toolbar/TableDetailSwitch';
import { useEditorStore } from '../../webview/store/editorStore';

const initialStoreState = useEditorStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState(initialStoreState, true);
});
afterEach(cleanup);

const radios = () => screen.getAllByRole('radio') as HTMLButtonElement[];
const checked = () => radios().filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent);

describe('TableDetailSwitch', () => {
  it('is a labelled radio group of Names, Keys and All with their accessible names and hover text', () => {
    useEditorStore.getState().setTableDetail('all');
    render(<TableDetailSwitch />);

    expect(screen.getByRole('radiogroup', { name: 'Table detail' })).toBeTruthy();
    expect(radios().map((r) => r.textContent)).toEqual(['Names', 'Keys', 'All']);
    expect(screen.getByRole('radio', { name: 'Table names only' }).textContent).toBe('Names');
    expect(screen.getByRole('radio', { name: 'Key columns only' }).textContent).toBe('Keys');
    expect(screen.getByRole('radio', { name: 'All columns' }).textContent).toBe('All');
    expect(radios().map((r) => r.title)).toEqual([
      TABLE_DETAIL_LABELS.name.title, TABLE_DETAIL_LABELS.keys.title, TABLE_DETAIL_LABELS.all.title,
    ]);
    expect(radios().every((r) => r.type === 'button')).toBe(true);
  });

  it('shows the level that is on, with one tab stop on it', () => {
    useEditorStore.getState().setTableDetail('keys');
    render(<TableDetailSwitch />);

    expect(checked()).toEqual(['Keys']);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(screen.getByRole('radio', { name: 'Key columns only' }).className).toContain('table-detail-switch__option--on');
  });

  it('a click chooses the level, closes the tables opened on their own, and posts nothing', () => {
    useEditorStore.getState().setTableDetail('keys');
    useEditorStore.getState().toggleExpansion('fct_order');
    render(<TableDetailSwitch />);

    fireEvent.click(screen.getByRole('radio', { name: 'Table names only' }));

    expect(useEditorStore.getState().tableDetail).toBe('name');
    expect(useEditorStore.getState().expandedNodes.size).toBe(0);
    expect(checked()).toEqual(['Names']);
    expect(mockVsCode.postMessage).not.toHaveBeenCalled();
  });

  it('a click on the level already on closes the opened tables (the way back to the level)', () => {
    useEditorStore.getState().setTableDetail('keys');
    useEditorStore.getState().toggleExpansion('fct_order');
    render(<TableDetailSwitch />);

    fireEvent.click(screen.getByRole('radio', { name: 'Key columns only' }));

    expect(useEditorStore.getState().tableDetail).toBe('keys');
    expect(useEditorStore.getState().expandedNodes.size).toBe(0);
  });

  it('the arrow keys, Home and End move the choice and the focus, wrapping at the ends', () => {
    useEditorStore.getState().setTableDetail('keys');
    render(<TableDetailSwitch />);
    const group = screen.getByRole('radiogroup');
    const press = (key: string) => fireEvent.keyDown(group, { key });

    press('ArrowRight');
    expect(useEditorStore.getState().tableDetail).toBe('all');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'All columns' }));

    press('ArrowRight');
    expect(useEditorStore.getState().tableDetail).toBe('name');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Table names only' }));

    press('ArrowLeft');
    expect(useEditorStore.getState().tableDetail).toBe('all');
    press('ArrowUp');
    expect(useEditorStore.getState().tableDetail).toBe('keys');
    press('ArrowDown');
    expect(useEditorStore.getState().tableDetail).toBe('all');
    press('Home');
    expect(useEditorStore.getState().tableDetail).toBe('name');
    press('End');
    expect(useEditorStore.getState().tableDetail).toBe('all');
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('leaves other keys alone', () => {
    useEditorStore.getState().setTableDetail('keys');
    render(<TableDetailSwitch />);
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    screen.getByRole('radiogroup').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(useEditorStore.getState().tableDetail).toBe('keys');
  });

  it('before a diagram has loaded no option is on and the first is the tab stop', () => {
    render(<TableDetailSwitch />);
    expect(checked()).toEqual([]);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });
});
