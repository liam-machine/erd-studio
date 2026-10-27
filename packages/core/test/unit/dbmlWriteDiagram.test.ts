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
import { detectSubjectAreaFormat } from '../../src/types/semantic';
import { DIAGRAM_CASES, DIAGRAM_LIBRARY, DIAGRAM_PATH, NEW_DIAGRAM_CASES, SALES, diagramEdit, lookups, readDiagram } from '../dbmlWriterCases/diagramCases';
import { clone } from '../dbmlWriterSupport';

describe('editSubjectAreaDbml', () => {
  for (const c of DIAGRAM_CASES) it(c.name, () => c.check(c.run()));

  it('reads back as the object it was given (Law 3) and is idempotent (Law 2)', () => {
    const change = (a: Record<string, any>): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
      a.domain = 'sales_v2';
      a.description = '  Indented first line is dropped';
      a.logical.models = ['dim_date', 'fct_order'];
      a.viewConfig.showFkEdges = true;
      a.viewConfig.annotations[0].text = 'edited';
      a.viewConfig.annotations.push({ id: 'n2', text: 'two', x: 0, y: 0, linkedModel: 'dim_date' });
    };
    const once = diagramEdit(SALES, change);
    const before = readDiagram(SALES);
    const after = clone(before);
    change(after);
    expect(editSubjectAreaDbml(once, { filePath: DIAGRAM_PATH, before: readDiagram(once), after, ...lookups(DIAGRAM_LIBRARY) })).toBe(once);
    const read = readDiagram(once);
    expect(read.domain).toBe('sales_v2');
    expect(read.description).toBe('Indented first line is dropped');
    expect(read.logical.models).toEqual(['dim_date', 'fct_order']);
    expect(read.viewConfig.showFkEdges).toBe(true);
    expect(read.viewConfig.annotations.map((n: { id: string; text: string }) => [n.id, n.text])).toEqual([
      ['3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', 'edited'], ['n2', 'two'],
    ]);
    expect(detectSubjectAreaFormat(read)).toBe('v5');
  });

  it('a byte-order mark and CRLF line endings are kept', () => {
    const crlf = `﻿${SALES.replace(/\n/g, '\r\n')}`;
    const out = diagramEdit(crlf, (a) => { a.logical.models.push('dim_date'); a.description = 'x'; });
    expect(out.startsWith('﻿')).toBe(true);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out).toContain("use { table dim_date } from '../tables/dim_date.dbml'\r\n");
  });
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

  it('a file that does not parse', () => {
    expect(() => editSubjectAreaDbml('Project x {\n', {
      filePath: DIAGRAM_PATH, before: {}, after: {}, ...lookups(DIAGRAM_LIBRARY),
    })).toThrow(/^Fix the DBML in gold\/sales\.dbml first/);
  });
});

describe('renderNewSubjectAreaDbml', () => {
  for (const c of NEW_DIAGRAM_CASES) it(c.name, () => c.check(c.run()));
});
