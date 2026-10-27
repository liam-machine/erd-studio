/**
 * The reserved relationships-file stem `_relationships` (native DBML
 * storage, §2.1): a diagram slug can never be it, so a new diagram never
 * collides with a relationships file's name.
 */

import { describe, expect, it } from 'vitest';

import { isReservedTableName } from '@erd-studio/core';
import { toSubjectAreaSlug } from '../../src/services/dbtDraft';

describe('toSubjectAreaSlug never yields the reserved name', () => {
  it.each(['_relationships', '_Relationships', '__relationships', ' _relationships ', '_relationships_', '-_relationships'])('%j', (text) => {
    const slug = toSubjectAreaSlug(text);
    expect(isReservedTableName(slug)).toBe(false);
    expect(slug.startsWith('_')).toBe(false);
  });

  it('keeps the word, without the underscore', () => {
    expect(toSubjectAreaSlug('_relationships')).toBe('relationships');
  });
});
