/**
 * The one-line note Draw from dbt shows after drawing. The flow itself runs
 * end to end against a fixture copy in extension.activate.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { describeDraftNotice, NO_DBT_MODELS_MESSAGE } from '../../src/commands/drawFromDbt';

describe('describeDraftNotice', () => {
  it('says nothing when every chosen model was drawn', () => {
    expect(describeDraftNotice({ modelNames: ['a', 'b'], skipped: [], truncated: false })).toBeUndefined();
    // A repeated pick or a model already in the domain is not worth a sentence.
    expect(describeDraftNotice({
      modelNames: ['a'],
      skipped: [{ name: 'A', reason: 'duplicate' }, { name: 'b', reason: 'already-in-domain' }],
      truncated: false,
    })).toBeUndefined();
  });

  it('names the cap and how many were left out', () => {
    expect(describeDraftNotice({
      modelNames: Array.from({ length: 15 }, (_, i) => `m${i}`),
      skipped: [{ name: 'x', reason: 'over-limit' }, { name: 'y', reason: 'over-limit' }],
      truncated: true,
    })).toBe('Drew the 15 best-connected models and left 2 out to keep the diagram readable. Add more from the canvas.');
  });

  it('lists up to three skipped models by name', () => {
    const notice = describeDraftNotice({
      modelNames: ['a'],
      skipped: ['b', 'c', 'd', 'e'].map((name) => ({ name, reason: 'not-found' as const })),
      truncated: false,
    });
    expect(notice).toBe('Skipped b, c, d and 1 more: disabled in dbt, missing columns, or a name ERD Studio cannot use.');
  });
});

it('the empty-project message says how to get models', () => {
  expect(NO_DBT_MODELS_MESSAGE).toContain('dbt parse');
  expect(NO_DBT_MODELS_MESSAGE).toContain('.yml');
});
