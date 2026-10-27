/**
 * normaliseForStorageEquivalence — the one comparator (D24) applies exactly
 * the rows of §2.8 of docs/plans/native-dbml-storage.md, each tested here on
 * its own, and nothing else: a changed type, role or member still differs.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  normaliseForStorageEquivalence as norm,
  normaliseStorageRows,
  storageNoteText,
  STORAGE_EQUIVALENCE_CONVERT_ROWS,
  STORAGE_EQUIVALENCE_ROWS,
  type StorageEquivalenceRow,
} from '../../src/storageEquivalence';
import { dbmlNoteText, dbmlString } from '../../src/dbmlText';
import { parseDbmlRich } from '../exportParsers';

type Area = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A small Display-shaped subject area. */
function display(): Area {
  return {
    schemaVersion: 5,
    domain: 'sales',
    layer: 'gold',
    stage: 'logical',
    description: 'Sales',
    models: [
      {
        name: 'fct_order', schema: '', description: 'Orders',
        columns: [
          { name: 'order_id', dataType: 'int', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false },
          { name: 'customer_id', dataType: 'int', description: 'Buyer', isPrimaryKey: false, isForeignKey: true, isNaturalKey: false },
          { name: 'region_code', dataType: 'text', description: '', isPrimaryKey: false, isForeignKey: true, isNaturalKey: false },
          { name: 'country_code', dataType: 'text', description: '', isPrimaryKey: false, isForeignKey: true, isNaturalKey: false },
        ],
      },
      {
        name: 'dim_customer', schema: '', description: '',
        columns: [{ name: 'customer_id', dataType: 'int', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false }],
      },
      {
        name: 'dim_region', schema: '', description: '',
        columns: [
          { name: 'region_code', dataType: 'text', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false },
          { name: 'country_code', dataType: 'text', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false },
        ],
      },
    ],
    relationships: [
      { fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one', role: 'buyer' },
      { fromModel: 'fct_order', fromColumn: 'region_code', toModel: 'dim_region', toColumn: 'region_code', cardinality: 'many-to-one', compositeKey: 'fk_dim_region' },
      { fromModel: 'fct_order', fromColumn: 'country_code', toModel: 'dim_region', toColumn: 'country_code', cardinality: 'many-to-one', compositeKey: 'fk_dim_region' },
    ],
    viewConfig: {
      positions: { fct_order: { x: 400, y: 200 }, dim_customer: { x: 40, y: 40 } },
      annotations: [{ id: 'n1', text: 'Check the grain', x: 720, y: 40, color: 'yellow' }],
    },
    readOnly: false,
    positionDraggable: true,
  };
}

const same = (a: Area, b: Area, convert = false): void => {
  expect(norm(a, { convert })).toEqual(norm(b, { convert }));
};
const differ = (a: Area, b: Area, convert = false): void => {
  expect(norm(a, { convert })).not.toEqual(norm(b, { convert }));
};

describe('normaliseForStorageEquivalence: each §2.8 row in isolation', () => {
  it('is a deep copy and leaves its input alone', () => {
    const a = display();
    const before = JSON.parse(JSON.stringify(a));
    const out = norm(a);
    expect(a).toEqual(before);
    expect(out).not.toBe(a);
  });

  it('note text: leading white space (descriptions, column notes, sticky notes), as dbmlNoteText', () => {
    const a = display();
    const b = display();
    b.description = '  Sales';
    b.models[0].description = '\n\tOrders';
    b.models[0].columns[1].description = '  Buyer';
    b.viewConfig.annotations[0].text = '   Check the grain';
    same(a, b);
    // The writer stores dbmlNoteText(text), so the first line loses its indent
    // and the other lines keep theirs: DBML's shared-indent trim never applies.
    a.description = '- bullet\n  - bullet2';
    b.description = '  - bullet\n  - bullet2';
    same(a, b);
    a.description = '- bullet\n- bullet2';
    differ(a, b);
    expect(storageNoteText('  - bullet\n  - bullet2')).toBe('- bullet\n  - bullet2');
    expect(storageNoteText('\tSee:\n\tfinance')).toBe('See:\n\tfinance');
    for (const text of ['  x', 'x  ', '\n\n x', '  a\n    b', '', '  - bullet\n  - bullet2']) {
      expect(storageNoteText(storageNoteText(text))).toBe(storageNoteText(text));
      expect(storageNoteText(text)).toBe(dbmlNoteText(text));
    }
    // Trailing white space is not dropped.
    b.description = 'Sales ';
    a.description = 'Sales';
    differ(a, b);
  });

  it('positions and sticky-note boxes to two decimals', () => {
    const a = display();
    const b = display();
    b.viewConfig.positions.fct_order = { x: 400.001, y: 199.996 };
    b.viewConfig.annotations[0] = { ...b.viewConfig.annotations[0], x: 720.004, y: 40.0001 };
    same(a, b);
    b.viewConfig.positions.fct_order = { x: 400.01, y: 200 };
    differ(a, b);
  });

  it('composite keys are renamed to the nextCompositeKey sequence in the owner\'s order', () => {
    const a = display();
    const b = display();
    b.relationships[1].compositeKey = 'region_fk';
    b.relationships[2].compositeKey = 'REGION_FK';
    same(a, b);
    expect(norm(b).relationships[1].compositeKey).toBe('fk_dim_region');
  });

  it('a one-member composite group loses its key', () => {
    const a = display();
    const b = display();
    b.relationships[0].compositeKey = 'fk_lonely';
    same(a, b);
    expect(norm(b).relationships[0].compositeKey).toBeUndefined();
  });

  it('relationship ends are respelled to the real table and column spelling', () => {
    const a = display();
    const b = display();
    b.relationships[0] = { ...b.relationships[0], fromModel: 'FCT_ORDER', fromColumn: 'Customer_ID', toModel: 'Dim_Customer', toColumn: 'CUSTOMER_ID' };
    same(a, b);
    // An end that names no table is kept as written.
    b.relationships[0].toModel = 'dim_gone';
    differ(a, b);
  });

  it('a library one-to-many is stored canonically', () => {
    const a = display();
    const b = display();
    b.relationships[0] = { fromModel: 'dim_customer', fromColumn: 'customer_id', toModel: 'fct_order', toColumn: 'customer_id', cardinality: 'one-to-many', role: 'buyer' };
    same(a, b);
  });

  it('relationship order: every list in a relationships file\'s sort order, a composite group moving as one', () => {
    const b = display();
    b.relationships = [b.relationships[1], b.relationships[2], b.relationships[0]];
    same(display(), b);
    // The members of a composite keep their order inside the group.
    const swapped = display();
    swapped.relationships = [swapped.relationships[0], swapped.relationships[2], swapped.relationships[1]];
    differ(display(), swapped);
  });

  it('an empty sticky-note list is the same as none', () => {
    const a = display();
    a.viewConfig.annotations = [];
    const b = display();
    delete b.viewConfig.annotations;
    same(a, b);
  });

  it('schemaVersion is overridden', () => {
    const a = display();
    const b = display();
    b.schemaVersion = 7;
    same(a, b);
    a.schemaVersion = 4;
    same(a, b);
    expect(norm(a).schemaVersion).toBe(7);
  });
});

describe('normaliseStorageRows: one row at a time (the twin goldens\' per-case check)', () => {
  /** A difference only `row` normalises away. */
  const CASES: Array<[StorageEquivalenceRow, (b: Area) => void]> = [
    ['noteText', (b) => { b.description = '  Sales'; }],
    ['positions', (b) => { b.viewConfig.positions.fct_order = { x: 400.001, y: 200 }; }],
    ['emptyAnnotations', (b) => { b.viewConfig.annotations = []; }],
    ['respelling', (b) => { b.relationships[0] = { ...b.relationships[0], toModel: 'Dim_Customer', toColumn: 'CUSTOMER_ID' }; }],
    ['oneToMany', (b) => { b.relationships[0] = { fromModel: 'dim_customer', fromColumn: 'customer_id', toModel: 'fct_order', toColumn: 'customer_id', cardinality: 'one-to-many', role: 'buyer' }; }],
    ['loneCompositeKey', (b) => { b.relationships[0].compositeKey = 'fk_lonely'; }],
    ['compositeKeyNames', (b) => { b.relationships[1].compositeKey = 'region_fk'; b.relationships[2].compositeKey = 'region_fk'; }],
    ['schemaVersion', (b) => { b.schemaVersion = 7; }],
    ['relationshipOrder', (b) => { b.relationships = [b.relationships[1], b.relationships[2], b.relationships[0]]; }],
  ];

  it('every non-Convert row has a case', () => {
    expect(CASES.map(([row]) => row).sort()).toEqual([...STORAGE_EQUIVALENCE_ROWS].sort());
  });

  it.each(CASES)('%s: that row alone removes the difference, and every other row together does not', (row, mutate) => {
    const a = display();
    if (row === 'emptyAnnotations') delete a.viewConfig.annotations;
    const b = display();
    if (row === 'emptyAnnotations') delete b.viewConfig.annotations;
    mutate(b);
    expect(normaliseStorageRows(a, [row])).toEqual(normaliseStorageRows(b, [row]));
    const others = [...STORAGE_EQUIVALENCE_ROWS, ...STORAGE_EQUIVALENCE_CONVERT_ROWS].filter((r) => r !== row);
    expect(normaliseStorageRows(a, others)).not.toEqual(normaliseStorageRows(b, others));
  });

  it('with every row, it is the comparator (with and without convert)', () => {
    const b = display();
    b.relationships[0].compositeKey = 'fk_lonely';
    b.description = '  Sales';
    expect(normaliseStorageRows(b, STORAGE_EQUIVALENCE_ROWS)).toEqual(norm(b));
    expect(normaliseStorageRows(b, [...STORAGE_EQUIVALENCE_ROWS, ...STORAGE_EQUIVALENCE_CONVERT_ROWS])).toEqual(norm(b, { convert: true }));
    expect(normaliseStorageRows(b, [])).toEqual(b);
  });
});

describe('normaliseForStorageEquivalence: note text through a real DBML round trip', () => {
  /** `text` written as the writer writes a note (`dbmlString(dbmlNoteText(text))`) and read back by every 9.1+ parser. */
  const roundTrips = (text: string): Array<[string, string]> =>
    parseDbmlRich(`Table t {\n  id int\n  Note: ${dbmlString(dbmlNoteText(text))}\n}\n`).map(({ parser, db, diagnostics }) => {
      expect(db, `${parser}: ${JSON.stringify(diagnostics)}`).not.toBeNull();
      const note = db.tables[0].note;
      return [parser, typeof note === 'string' ? note : note.value];
    });

  it('compares a written-and-read note equal to the text it was written from', () => {
    const texts = ['  - bullet\n  - bullet2', '\tSee:\n\tfinance', 'a\n    b\n    c', '  one line', '\n\n  - a\n  - b', 'plain'];
    for (const text of texts) {
      for (const [version, read] of roundTrips(text)) {
        const a = display();
        const b = display();
        a.description = text;
        b.description = read;
        expect(norm(b), `${version}: ${JSON.stringify(text)} read back as ${JSON.stringify(read)}`).toEqual(norm(a));
      }
    }
  });
});

describe('normaliseForStorageEquivalence: nothing else is normalised', () => {
  it('a changed column type is a difference', () => {
    const b = display();
    b.models[0].columns[0].dataType = 'bigint';
    differ(display(), b);
  });

  it('a changed role is a difference', () => {
    const b = display();
    b.relationships[0].role = 'payer';
    differ(display(), b);
    const c = display();
    delete c.relationships[0].role;
    differ(display(), c);
  });

  it('a changed member, member order or cardinality is a difference', () => {
    const b = display();
    b.models.pop();
    differ(display(), b);
    const c = display();
    c.models.reverse();
    differ(display(), c);
    const d = display();
    d.relationships[0].cardinality = 'one-to-one';
    differ(display(), d);
  });

  it('a changed annotation (text, colour, link or id) is a difference without convert', () => {
    for (const change of [{ text: 'Other' }, { color: 'blue' }, { linkedModel: 'fct_order' }, { id: 'n2' }]) {
      const b = display();
      Object.assign(b.viewConfig.annotations[0], change);
      differ(display(), b);
    }
  });

  it('a link stored twice, a disagreeing composite role and a dangling relationship differ without convert', () => {
    const twice = display();
    twice.relationships.push({ ...twice.relationships[0] });
    differ(display(), twice);
    const roles = display();
    roles.relationships[2].role = 'other';
    differ(display(), roles);
    const dangling = display();
    dangling.relationships.push({ fromModel: 'fct_order', fromColumn: 'order_id', toModel: 'dim_gone', toColumn: 'id', cardinality: 'many-to-one' });
    differ(display(), dangling);
  });
});

describe('normaliseForStorageEquivalence: the Convert-only rows', () => {
  it('a link stored twice is kept once', () => {
    const b = display();
    b.relationships.push({ ...b.relationships[0] });
    same(display(), b, true);
  });

  it('a composite group takes its first member\'s role', () => {
    const a = display();
    a.relationships[1].role = 'where';
    a.relationships[2].role = 'where';
    const b = display();
    b.relationships[1].role = 'where';
    b.relationships[2].role = 'elsewhere';
    same(a, b, true);
  });

  it('a dangling relationship (missing table or column) is dropped', () => {
    const b = display();
    b.relationships.push({ fromModel: 'fct_order', fromColumn: 'order_id', toModel: 'dim_gone', toColumn: 'id', cardinality: 'many-to-one' });
    b.relationships.push({ fromModel: 'fct_order', fromColumn: 'order_id', toModel: 'dim_customer', toColumn: 'gone_column', cardinality: 'many-to-one' });
    same(display(), b, true);
  });

  it('annotation ids are ignored', () => {
    const b = display();
    b.viewConfig.annotations[0].id = 'renewed-uuid';
    same(display(), b, true);
  });

  it('in a Unified shape, a diagram file\'s own relationships move to their owner and the diagram holds none', () => {
    const rel = { fromColumn: 'b_id', toModel: 'b', toColumn: 'id', cardinality: 'many-to-one' };
    // Before Convert: the relationship lives only in the diagram file.
    const before = {
      schemaVersion: 5, domain: 'd', layer: 'gold', description: '',
      logical: {
        models: [
          { name: 'a', columns: [{ name: 'b_id', dataType: 'int', description: '' }] },
          { name: 'b', columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true }] },
        ],
        relationships: [{ fromModel: 'a', ...rel }],
      },
      viewConfig: {},
    };
    // After Convert, read back from DBML: the owner holds it, the diagram holds no Refs (D5).
    const after = JSON.parse(JSON.stringify(before));
    after.logical.models[0].relationships = [{ ...rel }];
    after.logical.relationships = [];
    same(before, after, true);
    differ(before, after, false);
    expect((norm(before, { convert: true }) as Area).logical.relationships).toEqual([]);
    expect((norm(before, { convert: true }) as Area).logical.models[0].relationships).toEqual([rel]);
  });
});

describe('normaliseForStorageEquivalence: a link stored twice across the two ends\' files', () => {
  const unified = (twice: boolean): Area => ({
    schemaVersion: 5, domain: 'd', layer: 'gold', description: '',
    logical: {
      models: [
        { name: 'fct', columns: [{ name: 'dim_id', dataType: 'int', description: '' }], relationships: [{ fromColumn: 'dim_id', toModel: 'dim', toColumn: 'id', cardinality: 'many-to-one' }] },
        {
          name: 'dim', columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true }],
          relationships: twice ? [{ fromColumn: 'id', toModel: 'fct', toColumn: 'dim_id', cardinality: 'one-to-many' }] : [],
        },
      ],
      relationships: [],
    },
    viewConfig: {},
  });

  it('differs without convert (a writer that double-stores a link is caught)', () => {
    differ(unified(false), unified(true));
    expect((norm(unified(true)) as Area).logical.models[0].relationships).toHaveLength(2);
  });

  it('is kept once with convert', () => {
    same(unified(false), unified(true), true);
  });
});

describe('normaliseForStorageEquivalence on the goldens', () => {
  const GOLDEN = path.resolve(__dirname, '../fixtures/golden');

  it('is idempotent on every host and unified golden', () => {
    for (const file of fs.readdirSync(GOLDEN).filter((f) => /\.(host|unified)\.json$/.test(f))) {
      const raw = JSON.parse(fs.readFileSync(path.join(GOLDEN, file), 'utf-8'));
      const area = raw && typeof raw === 'object' && raw.payload && typeof raw.payload === 'object' ? raw.payload : raw;
      const once = norm(area);
      expect(norm(once)).toEqual(once);
      const convert = norm(area, { convert: true });
      expect(norm(convert, { convert: true })).toEqual(convert);
    }
  });

  it('composite-and-self: the lone key is dropped and Mentor_ID / Employee / EMPLOYEE_ID respelled in the Unified shape', () => {
    const unified = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'composite-and-self.unified.json'), 'utf-8'));
    const out = norm(unified) as Area;
    const pit = out.logical.models.find((m: Area) => m.name === 'pit_customer');
    expect(pit.relationships.map((r: Area) => r.compositeKey)).toEqual(['fk_sat_customer', 'fk_sat_customer', undefined]);
    const employee = out.logical.models.find((m: Area) => m.name === 'employee');
    expect(employee.relationships[1]).toMatchObject({ fromColumn: 'mentor_id', toModel: 'employee', toColumn: 'employee_id' });
    expect(out.schemaVersion).toBe(7);
  });
});
