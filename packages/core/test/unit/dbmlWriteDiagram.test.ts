/**
 * The diagram writer (§2.5, §4.5 of the native DBML storage spec): every
 * Project, member, relationships-use and sticky-note mapping, splicing only
 * what changed, and the refusals. The cases live in
 * `../dbmlWriterCases/diagramCases.ts`, so `dbmlMultiParser.test.ts` can
 * compile each output again in every parser.
 */
import { describe, it, expect } from 'vitest';

import { DbmlEditRefused } from '../../src/dbml/errors';
import { editSubjectAreaDbml } from '../../src/dbml/writeDiagram';
import { DIAGRAM_CASES, DIAGRAM_LIBRARY, DIAGRAM_PATH, NEW_DIAGRAM_CASES, SALES, SALES_CONFLICTED, diagramEdit, lookups, readDiagram } from '../dbmlWriterCases/diagramCases';
import { clone } from '../dbmlWriterSupport';

describe('editSubjectAreaDbml', () => {
  for (const c of DIAGRAM_CASES) it(c.name, () => c.check(c.run()));
});

describe('editSubjectAreaDbml refusals', () => {
  const refused = (text: string, change: (a: Record<string, any>) => void, yaml: Record<string, string> = {}): string => { // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      diagramEdit(text, change, { yaml });
    } catch (err) {
      expect(err).toBeInstanceOf(DbmlEditRefused);
      return (err as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it('a diagram with a repeated Note name or a second Project (writable: false)', () => {
    const repeated = `${SALES}\nNote "3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c" {\n  'again'\n}\n`;
    expect(refused(repeated, (a) => { a.description = 'x'; })).toMatch(/used twice/);
    expect(refused(`${SALES}\nProject other {\n  Note: 'x'\n}\n`, (a) => { a.description = 'x'; })).toMatch(/second Project/);
  });

  it('a position change while erd_layout holds a merge conflict (§1.6): positions are not saved until one side is kept', () => {
    expect(refused(SALES_CONFLICTED, (a) => { a.viewConfig.positions.dim_customer = { x: 9, y: 9 }; }))
      .toBe('gold/sales.dbml has a merge conflict in erd_layout (line 8). Only positions differ: keep either side, then try again. Positions are not saved until then.');
  });

  it('relationships in the diagram', () => {
    expect(refused(SALES, (a) => {
      a.logical.relationships = [{ fromModel: 'fct_order', fromColumn: 'Customer_Key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }];
    })).toMatch(/holds no relationships: they live in the table library/);
  });

  it('a layer or schemaVersion change, and a key a DBML diagram does not store', () => {
    expect(refused(SALES, (a) => { a.layer = 'silver'; })).toMatch(/layer is its folder/);
    expect(refused(SALES, (a) => { a.schemaVersion = 6; })).toMatch(/schema version/);
    expect(refused(SALES, (a) => { a.owner = 'me'; })).toMatch(/owner cannot be stored/);
    expect(refused(SALES, (a) => { a.viewConfig.zoom = 2; })).toMatch(/viewConfig\.zoom cannot be stored/);
  });

  it('a new member with no table file, or one that is a YAML table (D20)', () => {
    expect(refused(SALES, (a) => { a.logical.models.push('nowhere'); })).toMatch(/no table file/);
    expect(refused(SALES, (a) => { a.logical.models.push('yml_t'); }, { yml_t: 'logical-models/yml_t.yml' }))
      .toMatch(/YAML table\. Convert the project to DBML first \(ERD Studio: Convert Project to DBML\)/);
  });

  it('a `before` that is not what the text reads as (a stale snapshot)', () => {
    const before = readDiagram(SALES);
    const stale = clone(before);
    stale.logical.models = ['dim_customer', 'fct_order'];
    const after = clone(stale);
    after.logical.models = ['dim_customer'];
    expect(() => editSubjectAreaDbml(SALES, { filePath: DIAGRAM_PATH, before: stale, after, ...lookups(DIAGRAM_LIBRARY) }))
      .toThrow(/could not line up the use lines of gold\/sales\.dbml with its members \(the diagram changed since it was read\)/);
  });

  it('a file that does not parse', () => {
    expect(() => editSubjectAreaDbml('Project x {\n', {
      filePath: DIAGRAM_PATH, before: {}, after: {}, ...lookups(DIAGRAM_LIBRARY),
    })).toThrow(/^Fix the DBML in gold\/sales\.dbml first/);
  });
});

describe('renderNewSubjectAreaDbml', () => {
  for (const c of NEW_DIAGRAM_CASES) it(c.name, () => c.check(c.run()));
});
