/**
 * Tests for the runtime payload validators used by SemanticEditorProvider (H21).
 */

import { describe, it, expect } from 'vitest';
import {
  isValidCardinality,
  isValidKeyType,
  isValidModelRole,
  isValidStage,
  validateColumnDef,
  validateColumnDefs,
  validateModelName,
  validateAnnotationPositions,
  validatePoint,
  validatePositions,
  findDuplicateNames,
} from '../../src/providers/payloadValidation';
import { MODEL_NAME_PATTERN } from '../../src/types/naming';

describe('validateModelName', () => {
  it.each(['dim_customer', 'fct_order_2', 'a'])('accepts %j', (name) => {
    expect(validateModelName(name)).toBeNull();
  });

  it('accepts a name with surrounding whitespace (callers trim)', () => {
    expect(validateModelName('  dim_customer ')).toBeNull();
  });

  it.each([
    ['../escaped', /path separators/],
    ['sub/dir', /path separators/],
    ['a\\b', /path separators/],
    ['..', /path separators/],
    ['1abc', /start with a letter/],
    ['Dim_Customer', /start with a letter/],
    ['dim-customer', /start with a letter/],
    ['', /empty/],
    ['   ', /empty/],
  ])('rejects %j', (name, pattern) => {
    expect(validateModelName(name)).toMatch(pattern);
  });

  it('rejects non-string input', () => {
    expect(validateModelName(undefined)).toMatch(/required/);
    expect(validateModelName(42)).toMatch(/required/);
  });

  it('agrees with the shared MODEL_NAME_PATTERN used by the New Model dialog', () => {
    for (const name of ['dim_ok', '1bad', 'Bad', 'has-dash']) {
      expect(validateModelName(name) === null).toBe(MODEL_NAME_PATTERN.test(name));
    }
  });
});

describe('validateColumnDef / validateColumnDefs', () => {
  it('accepts a well-formed column', () => {
    expect(validateColumnDef({ name: 'id', dataType: 'int', description: '' })).toBeNull();
  });

  it('rejects missing name, bad name, and missing data type', () => {
    expect(validateColumnDef({ name: '', dataType: 'int' })).toMatch(/name is required/);
    expect(validateColumnDef({ name: 'Bad Name', dataType: 'int' })).toMatch(/lowercase/);
    expect(validateColumnDef({ name: 'id', dataType: '' })).toMatch(/Data type/);
    expect(validateColumnDef(null)).toMatch(/required/);
  });

  it('rejects duplicate column names in a list', () => {
    const error = validateColumnDefs([
      { name: 'name', dataType: 'string' },
      { name: 'is_active', dataType: 'boolean' },
      { name: 'name', dataType: 'string' },
    ]);
    expect(error).toMatch(/Duplicate column name "name"/);
  });

  it('accepts a list with unique names and rejects non-arrays', () => {
    expect(validateColumnDefs([{ name: 'a', dataType: 'int' }, { name: 'b', dataType: 'int' }])).toBeNull();
    expect(validateColumnDefs([])).toBeNull();
    expect(validateColumnDefs('nope')).toMatch(/list/);
  });

  it('findDuplicateNames ignores blanks and reports each duplicate once', () => {
    expect(findDuplicateNames(['a', '', 'b', 'a', ' a ', 'b', ''])).toEqual(['a', 'b']);
    expect(findDuplicateNames(['x', 'y'])).toEqual([]);
  });
});

describe('enumerated value guards', () => {
  it('cardinality', () => {
    expect(isValidCardinality('many-to-one')).toBe(true);
    expect(isValidCardinality('one-to-one')).toBe(true);
    expect(isValidCardinality('many')).toBe(false);
    expect(isValidCardinality(undefined)).toBe(false);
  });

  it('model role', () => {
    expect(isValidModelRole('conformed-dim')).toBe(true);
    expect(isValidModelRole('gold-dim')).toBe(true);
    expect(isValidModelRole('dimension')).toBe(false);
    expect(isValidModelRole(null)).toBe(false);
  });

  it('key type', () => {
    expect(isValidKeyType('PK')).toBe(true);
    expect(isValidKeyType('NK')).toBe(true);
    expect(isValidKeyType('bogus')).toBe(false);
    expect(isValidKeyType(undefined)).toBe(false);
  });

  it('stage', () => {
    expect(isValidStage('logical')).toBe(true);
    expect(isValidStage('physical')).toBe(true);
    expect(isValidStage('conceptual')).toBe(false);
    expect(isValidStage(1)).toBe(false);
  });
});

describe('positions', () => {
  it('validatePoint requires finite numeric coordinates', () => {
    expect(validatePoint({ x: 1, y: 2.5 })).toBeNull();
    expect(validatePoint({ x: NaN, y: 2 })).toMatch(/finite/);
    expect(validatePoint({ x: 1, y: Infinity })).toMatch(/finite/);
    expect(validatePoint({ x: undefined, y: 2 })).toMatch(/finite/);
    expect(validatePoint({ x: '1', y: 2 })).toMatch(/finite/);
    expect(validatePoint(null)).toMatch(/object/);
  });

  it('validatePositions checks every entry', () => {
    expect(validatePositions({ a: { x: 0, y: 0 }, b: { x: -10, y: 300 } })).toBeNull();
    expect(validatePositions({ a: { x: 0, y: 0 }, b: { x: NaN, y: 1 } })).toMatch(/"b"/);
    expect(validatePositions({ '': { x: 0, y: 0 } })).toMatch(/non-empty/);
    expect(validatePositions([])).toMatch(/map/);
    expect(validatePositions(null)).toMatch(/map/);
  });

  it('validateAnnotationPositions returns the list, or an error string (H27)', () => {
    expect(validateAnnotationPositions(undefined)).toEqual([]);
    expect(validateAnnotationPositions(null)).toEqual([]);
    expect(validateAnnotationPositions([{ id: 'n1', x: 1, y: 2 }, { id: 'n2', x: -3.5, y: 0 }])).toEqual([
      { id: 'n1', x: 1, y: 2 },
      { id: 'n2', x: -3.5, y: 0 },
    ]);
    // Extra properties are stripped from the returned entries
    expect(validateAnnotationPositions([{ id: 'n1', x: 1, y: 2, text: 'x' }])).toEqual([{ id: 'n1', x: 1, y: 2 }]);
    expect(validateAnnotationPositions({ id: 'n1', x: 1, y: 2 })).toMatch(/list/);
    expect(validateAnnotationPositions([{ id: '', x: 1, y: 2 }])).toMatch(/non-empty/);
    expect(validateAnnotationPositions([{ x: 1, y: 2 }])).toMatch(/non-empty/);
    expect(validateAnnotationPositions([null])).toMatch(/non-empty/);
    expect(validateAnnotationPositions([{ id: 'n1', x: NaN, y: 2 }])).toMatch(/"n1".*finite/);
    expect(validateAnnotationPositions([{ id: 'n1', x: 1 }])).toMatch(/"n1"/);
  });
});
