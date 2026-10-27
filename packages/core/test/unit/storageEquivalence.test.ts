/**
 * normaliseForStorageEquivalence — the one comparator (D24) applies exactly
 * the rows of §2.8 of docs/plans/native-dbml-storage.md, each tested here on
 * its own, and nothing else: a changed type, role or member still differs.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { normaliseForStorageEquivalence as norm, storageNoteText } from '../../src/storageEquivalence';
import { dbmlNoteText } from '../../src/dbmlText';

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

  it('note text: leading white space and a shared indent (descriptions, column notes, sticky notes)', () => {
    const a = display();
    const b = display();
    b.description = '  Sales';
    b.models[0].description = '\n\tOrders';
    b.models[0].columns[1].description = '  Buyer';
    b.viewConfig.annotations[0].text = '   Check the grain';
    same(a, b);
    a.description = '- bullet\n- bullet2';
    b.description = '  - bullet\n  - bullet2';
    same(a, b);
    expect(storageNoteText('  - bullet\n  - bullet2')).toBe('- bullet\n- bullet2');
    // It agrees with the writer's dbmlNoteText on a one-line text, and is idempotent.
    for (const text of ['  x', 'x  ', '\n\n x', '  a\n    b', '']) {
      expect(storageNoteText(storageNoteText(text))).toBe(storageNoteText(text));
      if (!text.includes('\n')) expect(storageNoteText(text)).toBe(dbmlNoteText(text));
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

  it('in a Unified shape, a diagram file\'s own relationships are attached to their owner', () => {
    const library = {
      schemaVersion: 5, domain: 'd', layer: 'gold', description: '',
      logical: {
        models: [
          { name: 'a', columns: [{ name: 'b_id', dataType: 'int', description: '' }], relationships: [{ fromColumn: 'b_id', toModel: 'b', toColumn: 'id', cardinality: 'many-to-one' }] },
          { name: 'b', columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true }] },
        ],
        relationships: [{ fromModel: 'a', fromColumn: 'b_id', toModel: 'b', toColumn: 'id', cardinality: 'many-to-one' }],
      },
      viewConfig: {},
    };
    const diagramHeld = JSON.parse(JSON.stringify(library));
    delete diagramHeld.logical.models[0].relationships;
    same(library, diagramHeld, true);
    differ(library, diagramHeld, false);
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
