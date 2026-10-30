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
      .toBe('gold/diagrams/sales.dbml has a merge conflict in erd_layout (line 8). Only positions differ: keep either side, then try again. Positions are not saved until then.');
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
      .toThrow(/could not line up the use lines of gold\/diagrams\/sales\.dbml with its members \(the diagram changed since it was read\)/);
  });

  it('a file that does not parse', () => {
    expect(() => editSubjectAreaDbml('Project x {\n', {
      filePath: DIAGRAM_PATH, before: {}, after: {}, ...lookups(DIAGRAM_LIBRARY),
    })).toThrow(/^Fix the DBML in gold\/diagrams\/sales\.dbml first/);
  });
});

describe('editSubjectAreaDbml in the layer-first tree (§1.4)', () => {
  const OTHER_USES = SALES.replace(
    "use * from '../relationships/gold.dbml'\n",
    "use * from '../relationships/gold.dbml'\nuse * from '../../shared/enums.dbml'\nuse * from '../relationships/sub/old.dbml'\n",
  );

  it('every other use * line is kept verbatim through a membership change, and is never a member', () => {
    const out = diagramEdit(OTHER_USES, (a) => { a.logical.models.push('dim_date'); });
    expect(out).toContain("use * from '../../shared/enums.dbml'\nuse * from '../relationships/sub/old.dbml'\n");
    expect(out).toContain("use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'\n");
    expect(readDiagram(out).logical.models).toEqual(['fct_order', 'dim_customer', 'dim_date']);
    // …and through the settle pass, which recomputes only the relationships imports.
    expect(diagramEdit(OTHER_USES, () => undefined, { extra: { refreshRelationshipsUses: true } })).toBe(OTHER_USES);
  });

  it('relationshipsImportsFor gets the members after the edit and the relationships files the diagram imports now', () => {
    const calls: Array<[string[], string[]]> = [];
    const before = readDiagram(OTHER_USES);
    const after = clone(before);
    after.logical.models.push('dim_date');
    const base = lookups(DIAGRAM_LIBRARY);
    editSubjectAreaDbml(OTHER_USES, {
      filePath: DIAGRAM_PATH, before, after, ...base,
      relationshipsImportsFor: (names, current) => { calls.push([[...names], [...current]]); return base.relationshipsImportsFor(names, current); },
    });
    expect(calls).toEqual([[['fct_order', 'dim_customer', 'dim_date'], ['gold/relationships/gold.dbml']]]);
  });

  it('an import the resolver keeps (a relationships file that does not read) stays; one it drops goes', () => {
    const library = { ...DIAGRAM_LIBRARY, 'gold/relationships/broken.dbml': 'Ref: gold.fct_order.Customer_Key >\n' };
    const text = SALES.replace("use * from '../relationships/gold.dbml'\n", "use * from '../relationships/broken.dbml'\nuse * from '../relationships/gold.dbml'\n");
    const out = diagramEdit(text, (a) => { a.logical.models.push('dim_date'); }, { library });
    expect(out).toContain("use * from '../relationships/broken.dbml'\nuse * from '../relationships/dates.dbml'\nuse * from '../relationships/gold.dbml'\n");
    const dropped = diagramEdit(text, (a) => { a.logical.models = ['dim_customer']; }, { library });
    expect(dropped).toContain("use * from '../relationships/broken.dbml'\n");
    expect(dropped).not.toContain('relationships/gold.dbml');
  });

  it('a relationships file named like a table is an import, never a member', () => {
    const library = { ...DIAGRAM_LIBRARY, 'gold/relationships/fct_order.dbml': DIAGRAM_LIBRARY['gold/relationships/gold.dbml'] };
    const text = SALES.replace("use * from '../relationships/gold.dbml'\n", "use * from '../relationships/fct_order.dbml'\n");
    expect(readDiagram(text).logical.models).toEqual(['fct_order', 'dim_customer']);
    const out = diagramEdit(text, (a) => { a.logical.models.push('dim_date'); }, { library });
    expect(out).toContain("use * from '../relationships/dates.dbml'\nuse * from '../relationships/fct_order.dbml'\nuse * from '../relationships/gold.dbml'\n");
  });

  it('a diagram path that is not <layer>/diagrams/<name>.dbml does not read, so it is refused', () => {
    expect(() => editSubjectAreaDbml(SALES, { filePath: 'gold/sales.dbml', before: {}, after: {}, ...lookups(DIAGRAM_LIBRARY) }))
      .toThrow(/^Fix the DBML in gold\/sales\.dbml first \(gold\/sales\.dbml was written by an ERD Studio 1\.9 pre-release/);
  });
});

describe('renderNewSubjectAreaDbml', () => {
  for (const c of NEW_DIAGRAM_CASES) it(c.name, () => c.check(c.run()));
});
