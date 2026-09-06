// @vitest-environment jsdom
/**
 * Global keydown decision helpers (webview/lib/keyboardShortcuts.ts).
 *
 * Covers the three H12 regressions:
 *  - '?' must be typeable in text-entry controls (guard runs before the legend toggle)
 *  - Alt+1 / Alt+2 must match on e.code so macOS Option+digit ('¡' / '™') works
 *  - Delete with columns selected must remove the columns, not prompt to delete the model
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  isTextEntryElement,
  isLegendToggleShortcut,
  altStageShortcut,
  resolveSingleDeleteTarget,
} from '../../webview/lib/keyboardShortcuts';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isTextEntryElement', () => {
  it('is false for null / body / plain div', () => {
    expect(isTextEntryElement(null)).toBe(false);
    expect(isTextEntryElement(document.body)).toBe(false);
    expect(isTextEntryElement(document.createElement('div'))).toBe(false);
  });

  it('is true for input, textarea and select', () => {
    expect(isTextEntryElement(document.createElement('input'))).toBe(true);
    expect(isTextEntryElement(document.createElement('textarea'))).toBe(true);
    expect(isTextEntryElement(document.createElement('select'))).toBe(true);
  });

  it('is true for contentEditable hosts (attribute fallback)', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    expect(isTextEntryElement(div)).toBe(true);

    const bare = document.createElement('div');
    bare.setAttribute('contenteditable', '');
    expect(isTextEntryElement(bare)).toBe(true);

    const off = document.createElement('div');
    off.setAttribute('contenteditable', 'false');
    expect(isTextEntryElement(off)).toBe(false);
  });

  it('is true for the focused textarea (document.activeElement)', () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    expect(document.activeElement).toBe(ta);
    expect(isTextEntryElement(document.activeElement)).toBe(true);
  });
});

describe('isLegendToggleShortcut', () => {
  it('matches Shift+? only', () => {
    expect(isLegendToggleShortcut({ shiftKey: true, key: '?' })).toBe(true);
    expect(isLegendToggleShortcut({ shiftKey: false, key: '?' })).toBe(false);
    expect(isLegendToggleShortcut({ shiftKey: true, key: '/' })).toBe(false);
  });

  it("'?' typed in a focused textarea is a text-entry keystroke, not a shortcut", () => {
    // Mirrors the handler ordering in App.tsx: the guard is consulted first.
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    const e = new KeyboardEvent('keydown', { key: '?', shiftKey: true, cancelable: true });
    const intercepted = !isTextEntryElement(document.activeElement) && isLegendToggleShortcut(e);
    expect(intercepted).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('altStageShortcut', () => {
  const base = { altKey: true, ctrlKey: false, metaKey: false };

  it('maps Alt+Digit1 / Alt+Digit2 to logical / physical', () => {
    expect(altStageShortcut({ ...base, code: 'Digit1' })).toBe('logical');
    expect(altStageShortcut({ ...base, code: 'Digit2' })).toBe('physical');
  });

  it('works on macOS where Option+1/2 produce a translated e.key', () => {
    // On macOS Chromium: Option+1 -> key '¡', Option+2 -> key '™', code unchanged.
    const e1 = new KeyboardEvent('keydown', { key: '¡', code: 'Digit1', altKey: true });
    const e2 = new KeyboardEvent('keydown', { key: '™', code: 'Digit2', altKey: true });
    expect(altStageShortcut(e1)).toBe('logical');
    expect(altStageShortcut(e2)).toBe('physical');
  });

  it('accepts numpad digits', () => {
    expect(altStageShortcut({ ...base, code: 'Numpad1' })).toBe('logical');
    expect(altStageShortcut({ ...base, code: 'Numpad2' })).toBe('physical');
  });

  it('returns null without Alt, with other modifiers, or for other keys', () => {
    expect(altStageShortcut({ ...base, altKey: false, code: 'Digit1' })).toBeNull();
    expect(altStageShortcut({ ...base, ctrlKey: true, code: 'Digit1' })).toBeNull();
    expect(altStageShortcut({ ...base, metaKey: true, code: 'Digit2' })).toBeNull();
    expect(altStageShortcut({ ...base, code: 'Digit3' })).toBeNull();
    expect(altStageShortcut({ ...base, code: 'KeyA' })).toBeNull();
  });
});

describe('resolveSingleDeleteTarget', () => {
  const none = {
    selectedAnnotation: null,
    selectedNode: null,
    modelExists: false,
    selectedColumnCount: 0,
    detailPanelOpen: false,
    selectedEdgeCount: 0,
  };

  it('returns null when nothing is selected', () => {
    expect(resolveSingleDeleteTarget(none)).toBeNull();
  });

  it('deletes selected columns before falling back to the model (H12 ordering bug)', () => {
    expect(
      resolveSingleDeleteTarget({
        ...none,
        selectedNode: 'dim_customer',
        modelExists: true,
        detailPanelOpen: true,
        selectedColumnCount: 2,
      }),
    ).toBe('columns');
  });

  it('prompts to delete the model when no columns are selected', () => {
    expect(
      resolveSingleDeleteTarget({
        ...none,
        selectedNode: 'dim_customer',
        modelExists: true,
        detailPanelOpen: true,
      }),
    ).toBe('model');
    expect(
      resolveSingleDeleteTarget({ ...none, selectedNode: 'dim_customer', modelExists: true }),
    ).toBe('model');
  });

  it('ignores column selection when the detail panel is closed', () => {
    expect(
      resolveSingleDeleteTarget({
        ...none,
        selectedNode: 'dim_customer',
        modelExists: true,
        detailPanelOpen: false,
        selectedColumnCount: 1,
      }),
    ).toBe('model');
  });

  it('annotation wins over everything else', () => {
    expect(
      resolveSingleDeleteTarget({
        ...none,
        selectedAnnotation: 'ann-1',
        selectedNode: 'dim_customer',
        modelExists: true,
        detailPanelOpen: true,
        selectedColumnCount: 1,
        selectedEdgeCount: 1,
      }),
    ).toBe('annotation');
  });

  it('falls through to edges when the selected node no longer exists', () => {
    expect(
      resolveSingleDeleteTarget({
        ...none,
        selectedNode: 'gone',
        modelExists: false,
        selectedEdgeCount: 1,
      }),
    ).toBe('edges');
    expect(resolveSingleDeleteTarget({ ...none, selectedEdgeCount: 1 })).toBe('edges');
  });
});
