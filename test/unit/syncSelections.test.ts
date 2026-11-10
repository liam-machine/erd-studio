/**
 * Sync modal decisions: the store's click-again-to-clear toggle, single
 * clear and Reset, and the pure rule that keeps an inferred table decision in
 * step with its columns (webview/lib/syncSelections.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '../../webview/store/editorStore';
import { inferTableChoice, reconcileInferredTableKey } from '../../webview/lib/syncSelections';
import type { GroundTruth } from '../../src/types/syncPlan';

const state = () => useEditorStore.getState();

beforeEach(() => {
  state().clearSyncSelections();
});

describe('editorStore sync decisions', () => {
  it('toggleSyncSelection picks a side, switches sides, and clears on a second click of the same side', () => {
    state().toggleSyncSelection('rel:a', 'logical');
    expect(state().syncSelections).toEqual({ 'rel:a': 'logical' });

    state().toggleSyncSelection('rel:a', 'physical');
    expect(state().syncSelections).toEqual({ 'rel:a': 'physical' });

    state().toggleSyncSelection('rel:a', 'physical');
    // The key is gone, not set to null: the Apply count is Object.keys().length.
    expect(state().syncSelections).toEqual({});
    expect('rel:a' in state().syncSelections).toBe(false);
  });

  it('clearSyncSelection drops one decision and leaves the others', () => {
    state().setSyncSelectionBulk(['a', 'b'], 'logical');
    state().clearSyncSelection('a');
    expect(state().syncSelections).toEqual({ b: 'logical' });
    // Clearing an undecided key changes nothing.
    const before = state().syncSelections;
    state().clearSyncSelection('missing');
    expect(state().syncSelections).toBe(before);
  });

  it('any change to the decisions discards a prepared plan', () => {
    const plan = { filePath: '.erd-studio/.sync-plan.json', totalActions: 2 };
    for (const change of [
      () => state().setSyncSelection('a', 'logical'),
      () => state().toggleSyncSelection('a', 'logical'),
      () => state().clearSyncSelection('a'),
      () => state().setSyncSelectionBulk(['a', 'b'], 'physical'),
      () => state().clearSyncSelections(),
    ]) {
      state().setSyncSelection('a', 'logical');
      state().setSyncPlanGenerated(plan);
      change();
      expect(state().syncPlanGenerated).toBeNull();
    }
  });
});

describe('inferTableChoice', () => {
  it('is null until every column is decided, then the majority wins (logical on a tie)', () => {
    expect(inferTableChoice({}, [])).toBeNull();
    expect(inferTableChoice({ a: 'physical' }, ['a', 'b'])).toBeNull();
    expect(inferTableChoice({ a: 'physical', b: 'physical', c: 'logical' }, ['a', 'b', 'c'])).toBe('physical');
    expect(inferTableChoice({ a: 'physical', b: 'logical' }, ['a', 'b'])).toBe('logical');
  });
});

describe('reconcileInferredTableKey', () => {
  const cols = ['col:t:a', 'col:t:b'];
  const T = 'table:t';
  const sel = (s: Record<string, GroundTruth>) => s;

  it('sets the table key once every column is decided', () => {
    expect(reconcileInferredTableKey(sel({ 'col:t:a': 'physical' }), T, cols, null))
      .toEqual({ change: null, inferred: null });
    expect(reconcileInferredTableKey(sel({ 'col:t:a': 'physical', 'col:t:b': 'physical' }), T, cols, null))
      .toEqual({ change: { kind: 'set', choice: 'physical' }, inferred: 'physical' });
  });

  it('clears an inferred table key when a column is cleared', () => {
    const r = reconcileInferredTableKey(sel({ [T]: 'physical', 'col:t:a': 'physical' }), T, cols, 'physical');
    expect(r).toEqual({ change: { kind: 'clear' }, inferred: null });
  });

  it('re-infers when the columns switch side', () => {
    const r = reconcileInferredTableKey(
      sel({ [T]: 'physical', 'col:t:a': 'logical', 'col:t:b': 'logical' }), T, cols, 'physical',
    );
    expect(r).toEqual({ change: { kind: 'set', choice: 'logical' }, inferred: 'logical' });
  });

  it('is stable once in step', () => {
    const r = reconcileInferredTableKey(
      sel({ [T]: 'logical', 'col:t:a': 'logical', 'col:t:b': 'logical' }), T, cols, 'logical',
    );
    expect(r).toEqual({ change: null, inferred: 'logical' });
  });

  it('leaves a table decision the user made ("Keep all") alone', () => {
    // Not inferred by the modal (lastInferred null): a column cleared later keeps the table decision.
    expect(reconcileInferredTableKey(sel({ [T]: 'logical', 'col:t:a': 'logical' }), T, cols, null))
      .toEqual({ change: null, inferred: null });
    // The user overwrote an inferred value: no longer the modal's to manage.
    expect(reconcileInferredTableKey(sel({ [T]: 'logical', 'col:t:a': 'physical' }), T, cols, 'physical'))
      .toEqual({ change: null, inferred: null });
  });

  it('after Reset (everything cleared) there is nothing to do', () => {
    expect(reconcileInferredTableKey({}, T, cols, 'logical')).toEqual({ change: null, inferred: null });
  });
});
