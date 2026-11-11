/**
 * The fail-closed guard of library writes (D-5, `src/services/ambiguousTableName.ts`):
 * a bare name that tables in more than one schema folder share is refused,
 * naming every table it could mean; one table, a table listed twice and a
 * name with no table pass. The guard of each write entry is tested where the
 * entry is (`tableLibrary.sameName.test.ts`, and the planner's own in stage 6).
 */
import { describe, it, expect } from 'vitest';

import { AmbiguousTableName, refuseAmbiguousTableName } from '../../src/services/ambiguousTableName';

describe('refuseAmbiguousTableName', () => {
  it('refuses a name two schema folders share, naming each table by its schema', () => {
    let thrown: unknown;
    try {
      refuseAmbiguousTableName('addresse', [{ schema: 'bqs', name: 'addresse' }, { schema: 'ccc', name: 'addresse' }]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AmbiguousTableName);
    expect((thrown as AmbiguousTableName).message).toBe(
      'More than one table is named addresse (bqs.addresse, ccc.addresse), and this change does not say which one; nothing was changed.',
    );
    expect((thrown as AmbiguousTableName).tableName).toBe('addresse');
    expect((thrown as AmbiguousTableName).candidates).toEqual([{ schema: 'bqs', name: 'addresse' }, { schema: 'ccc', name: 'addresse' }]);
  });

  it('passes one table, one table listed twice (or in two layers, or folders spelled in two cases), and none', () => {
    expect(() => refuseAmbiguousTableName('addresse', [{ schema: 'bqs', name: 'addresse' }])).not.toThrow();
    expect(() => refuseAmbiguousTableName('addresse', [{ schema: 'bqs', name: 'addresse' }, { schema: 'BQS', name: 'Addresse' }])).not.toThrow();
    expect(() => refuseAmbiguousTableName('addresse', [])).not.toThrow();
    // A YAML table has no schema folder: its name alone is its identity.
    expect(() => refuseAmbiguousTableName('dim_date', [{ schema: '', name: 'dim_date' }, { schema: '', name: 'DIM_DATE' }])).not.toThrow();
  });

  it('lists each identity once, in the order given', () => {
    expect(() => refuseAmbiguousTableName('x', [{ schema: 'b', name: 'x' }, { schema: 'a', name: 'x' }, { schema: 'B', name: 'X' }]))
      .toThrow('More than one table is named x (b.x, a.x),');
  });
});
