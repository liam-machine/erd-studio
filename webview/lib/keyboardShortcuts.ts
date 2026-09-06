/**
 * Pure helpers for the global keydown handler in App.tsx.
 *
 * Kept free of React / store imports so the decision logic can be unit-tested
 * in isolation (see test/unit/keyboardShortcuts.test.ts).
 */

import type { Stage } from '../../src/types/semantic';

/**
 * True when keyboard input should be left alone because the user is typing
 * into a text-entry control (input, textarea, select, or contentEditable).
 *
 * `isContentEditable` is not implemented by every DOM (jsdom returns
 * `undefined`), so the `contenteditable` attribute is checked as a fallback.
 */
export function isTextEntryElement(el: Element | null | undefined): boolean {
  if (!el) return false;
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    return true;
  }
  if ((el as HTMLElement).isContentEditable === true) return true;
  const attr = el.getAttribute('contenteditable');
  return attr !== null && attr !== 'false';
}

/** Shift+? toggles the legend. Checked *after* the text-entry guard. */
export function isLegendToggleShortcut(e: Pick<KeyboardEvent, 'shiftKey' | 'key'>): boolean {
  return e.shiftKey && e.key === '?';
}

/**
 * Alt+1 / Alt+2 stage switch.
 *
 * Uses `e.code` (physical key) rather than `e.key` because macOS translates
 * Option+1 / Option+2 into '¡' / '™' at the `key` level, which made the
 * shortcut dead on Mac. `code` stays 'Digit1' / 'Digit2' on every platform.
 */
export function altStageShortcut(
  e: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'code'>,
): Stage | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.code === 'Digit1' || e.code === 'Numpad1') return 'logical';
  if (e.code === 'Digit2' || e.code === 'Numpad2') return 'physical';
  return null;
}

export type SingleDeleteTarget = 'annotation' | 'columns' | 'model' | 'edges' | null;

export interface SingleDeleteContext {
  selectedAnnotation: string | null;
  selectedNode: string | null;
  /** Whether `selectedNode` still resolves to a model in the current domain. */
  modelExists: boolean;
  selectedColumnCount: number;
  detailPanelOpen: boolean;
  selectedEdgeCount: number;
}

/**
 * Decides what Delete/Backspace should act on when fewer than two canvas
 * items are multi-selected.
 *
 * Priority (highest first):
 *   1. annotation — immediate, undo exists
 *   2. columns   — selected rows in the open detail panel (must win over the
 *                  model so Delete on a column does not prompt to delete the
 *                  whole model)
 *   3. model     — opens the delete-model confirmation
 *   4. edges     — immediate
 */
export function resolveSingleDeleteTarget(ctx: SingleDeleteContext): SingleDeleteTarget {
  if (ctx.selectedAnnotation) return 'annotation';
  if (ctx.selectedColumnCount > 0 && ctx.detailPanelOpen && ctx.selectedNode) return 'columns';
  if (ctx.selectedNode && ctx.modelExists) return 'model';
  if (ctx.selectedEdgeCount > 0) return 'edges';
  return null;
}
