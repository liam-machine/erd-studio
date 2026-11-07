/**
 * Payload validation for the canvas's ways out of one diagram: the search
 * hint's `goToTable` and a table context menu's `showTableOnOtherDiagrams`,
 * `moveTable`, `copyTablePath` and `revealTableInLibrary`.
 */
import { describe, it, expect } from 'vitest';
import { validateGoToTablePayload, validateTableActionPayload } from '../../src/providers/payloadValidation';
import { GO_TO_TABLE_QUERY_MAX } from '../../src/types/messages';

describe('validateGoToTablePayload', () => {
  it('accepts no payload, an empty one, and a one-line search', () => {
    expect(validateGoToTablePayload(undefined)).toBeNull();
    expect(validateGoToTablePayload({})).toBeNull();
    expect(validateGoToTablePayload({ query: 'fct_' })).toBeNull();
    expect(validateGoToTablePayload({ query: 'x'.repeat(GO_TO_TABLE_QUERY_MAX) })).toBeNull();
  });

  it('refuses anything else', () => {
    expect(validateGoToTablePayload(null)).toMatch(/object/);
    expect(validateGoToTablePayload(['q'])).toMatch(/object/);
    expect(validateGoToTablePayload({ query: 3 })).toMatch(/text/);
    expect(validateGoToTablePayload({ query: 'x'.repeat(GO_TO_TABLE_QUERY_MAX + 1) })).toMatch(/at most/);
    expect(validateGoToTablePayload({ query: 'a\nb' })).toMatch(/one line/);
  });
});

describe('validateTableActionPayload', () => {
  it('accepts any name dbt allows', () => {
    expect(validateTableActionPayload({ modelName: 'fct_order' })).toBeNull();
    expect(validateTableActionPayload({ modelName: 'FCT_Order2' })).toBeNull();
    expect(validateTableActionPayload({ modelName: '2024_orders' })).toBeNull();
  });

  it('refuses a missing, empty or path-like name', () => {
    expect(validateTableActionPayload(undefined)).toMatch(/table name/);
    expect(validateTableActionPayload({})).toMatch(/required/);
    expect(validateTableActionPayload({ modelName: '  ' })).toMatch(/empty/);
    expect(validateTableActionPayload({ modelName: '../etc/passwd' })).toMatch(/path/);
    expect(validateTableActionPayload({ modelName: 'C:x' })).toMatch(/path/);
  });
});
