/**
 * Helpers that moved into `@erd-studio/core` for native DBML storage stay
 * importable from their old host modules, as the very same values: the
 * planner and the DBML reader share one `nextCompositeKey`, and Import DBML
 * and the file classifier share one export-header prefix.
 */

import { describe, expect, it } from 'vitest';

import * as core from '@erd-studio/core';
import { nextCompositeKey } from '../../src/services/libraryRelationships';
import { ERD_STUDIO_DBML_HEADER_PREFIX } from '../../src/services/dbmlImportParse';

describe('host re-exports of moved core helpers', () => {
  it('nextCompositeKey is core\'s function', () => {
    expect(nextCompositeKey).toBe(core.nextCompositeKey);
  });

  it('ERD_STUDIO_DBML_HEADER_PREFIX is core\'s constant', () => {
    expect(ERD_STUDIO_DBML_HEADER_PREFIX).toBe(core.ERD_STUDIO_DBML_HEADER_PREFIX);
    expect(core.DBML_RICH_EXPORT_HEADER.startsWith(ERD_STUDIO_DBML_HEADER_PREFIX)).toBe(true);
  });
});
