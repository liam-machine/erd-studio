// @vitest-environment jsdom
/**
 * The canvas's information button about converting a project from before 2.0
 * to DBML (#305): an "i" beside the diagram's name while the host's
 * `convertOffer` says so, on the logical stage only; its card says what
 * converting does, and Convert to DBML… posts `convertProjectToDbml`. Closing
 * the card never hides the "i"; Escape closes it and gives focus back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import {
  ConvertInfo,
  CONVERT_INFO_BUTTON,
  CONVERT_INFO_LABEL,
  CONVERT_INFO_TEXT,
} from '../../webview/components/Toolbar/ConvertInfo';
import { useEditorStore } from '../../webview/store/editorStore';
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const domainOn = (stage: 'logical' | 'physical'): DisplaySubjectArea => ({
  domain: 'sales', layer: 'gold', stage, schemaVersion: 5, models: [], relationships: [], viewConfig: {}, readOnly: stage === 'physical',
} as unknown as DisplaySubjectArea);

const answer = (show: boolean, stage: 'logical' | 'physical' = 'logical') => act(() => {
  useEditorStore.setState({ domain: domainOn(stage) });
  useEditorStore.getState().setConvertOffer(show);
});

const infoButton = () => screen.queryByRole('button', { name: CONVERT_INFO_LABEL });

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState(initialStoreState, true);
});

afterEach(() => cleanup());

describe('ConvertInfo', () => {
  it('shows nothing until the host says the project can be converted', () => {
    const { container } = render(<ConvertInfo />);
    answer(false);
    expect(container.textContent).toBe('');
    expect(infoButton()).toBeNull();
  });

  it('a quiet "i" with an accessible name; its card says what converting does', () => {
    const { container } = render(<ConvertInfo />);
    answer(true);
    const button = infoButton()!;
    expect(button.classList.contains('convert-info__button')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(button);
    const card = screen.getByRole('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(card.id);
    expect(card.textContent).toContain(CONVERT_INFO_TEXT);
    expect(CONVERT_INFO_TEXT).toMatch(/older ERD Studio/);
    expect(CONVERT_INFO_TEXT).toMatch(/DBML, an open format/);
    expect(CONVERT_INFO_TEXT).toMatch(/your tables and diagrams stay as they are/);
    expect(CONVERT_INFO_TEXT).toMatch(/see every change before anything is written/);
    // The card opens with its Convert button focused.
    const convert = container.querySelector<HTMLButtonElement>('.convert-info__convert')!;
    expect(convert.textContent).toBe(CONVERT_INFO_BUTTON);
    expect(document.activeElement).toBe(convert);
  });

  it('Convert to DBML… posts convertProjectToDbml once, with no payload', () => {
    const { container } = render(<ConvertInfo />);
    answer(true);
    fireEvent.click(infoButton()!);
    fireEvent.click(container.querySelector('.convert-info__convert')!);
    expect(mockVsCode.postMessage).toHaveBeenCalledTimes(1);
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({ type: 'convertProjectToDbml' });
    // The card closes; the "i" stays until the host says otherwise.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(infoButton()).not.toBeNull();
  });

  it('Escape and the close button close the card, keep the "i" and give it focus back; nothing is sent', () => {
    const { container } = render(<ConvertInfo />);
    answer(true);
    const button = infoButton()!;
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    fireEvent.click(container.querySelector('.convert-info__close')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(infoButton()).not.toBeNull();
    expect(document.activeElement).toBe(button);

    // A click outside closes it too.
    fireEvent.click(button);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mockVsCode.postMessage).not.toHaveBeenCalled();
  });

  it('hidden on the physical stage (read-only), and its open card goes with it', () => {
    render(<ConvertInfo />);
    answer(true);
    fireEvent.click(infoButton()!);
    answer(true, 'physical');
    expect(infoButton()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Back on the logical stage: the "i" again, its card closed.
    answer(true, 'logical');
    expect(infoButton()).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('goes when the host says the project can no longer be converted', () => {
    render(<ConvertInfo />);
    answer(true);
    expect(infoButton()).not.toBeNull();
    answer(false);
    expect(infoButton()).toBeNull();
  });
});
