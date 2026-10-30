/**
 * `loadDisplaySubjectArea` with native DBML storage (§4.4 of the spec): the
 * `dbml` option, the not-a-diagram rule, the shared probe order with the
 * folders a diagram's `use` lines name, every relationships file of the probe
 * set, the limits on DBML files, and JSON diagrams in a mixed project.
 */
import { describe, it, expect } from 'vitest';

import { FileTooLargeError, TooManyTablesError, loadDisplaySubjectArea, type LoadDisplaySubjectAreaOptions } from '../../src/loadDisplayDomain';
import { SubjectAreaValidationError } from '../../src/domain';
import { dbmlStorageReader } from '../../src/dbml/index';
import { classifySemanticFile } from '../../src/storage';

type Files = Record<string, string>;

const LAYERS = JSON.stringify({ schemaVersion: 1, layers: [{ id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 0 }] });

function project(extra: Files = {}): Files {
  return {
    '.erd-studio/layers.json': LAYERS,
    '.erd-studio/gold/sales.dbml': `use { table fct_order } from '../tables/finance/fct_order.dbml'
use { table dim_customer } from '../tables/finance/dim_customer.dbml'
use { table dim_date } from '../tables/dim_date.dbml'
use * from '../tables/_relationships.dbml'
use * from '../tables/finance/_relationships.dbml'

Project sales {
  Note: 'Sales'
  erd_schema_version: '7'
  erd_layout: '''
    fct_order 10 20
  '''
}
`,
    // `finance` is a library folder, not a layer: only the use lines name it.
    '.erd-studio/tables/finance/fct_order.dbml': 'Table fct_order {\n  id int [pk]\n  customer_key int\n  date_key int\n}\n',
    '.erd-studio/tables/finance/dim_customer.dbml': 'Table dim_customer {\n  customer_key int [pk]\n}\n',
    '.erd-studio/tables/dim_date.dbml': 'Table dim_date {\n  date_key int [pk]\n}\n',
    '.erd-studio/tables/finance/_relationships.dbml': "use { table fct_order } from './fct_order.dbml'\nuse { table dim_customer } from './dim_customer.dbml'\n\nRef: fct_order.customer_key >? dim_customer.customer_key\n",
    ...extra,
  };
}

function load(files: Files, options: Partial<LoadDisplaySubjectAreaOptions> = {}) {
  const reads: string[] = [];
  const warnings: string[] = [];
  const promise = loadDisplaySubjectArea({
    domainPath: '.erd-studio/gold/sales.dbml',
    readFile: async (p) => {
      reads.push(p);
      return files[p] ?? null;
    },
    readOnly: false,
    warn: (m) => warnings.push(m),
    dbml: dbmlStorageReader,
    ...options,
  });
  return { promise, reads, warnings };
}

const links = (domain: { relationships: Array<{ fromModel: string; fromColumn: string; toModel: string; toColumn: string }> }) =>
  domain.relationships.map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}`);

describe('loadDisplaySubjectArea: DBML diagrams', () => {
  it('draws a DBML diagram: members from use lines, erd_layout positions, relationships from the library, schemaVersion 7', async () => {
    const { promise } = load(project());
    const domain = await promise;
    expect(domain.schemaVersion).toBe(7);
    expect(domain.domain).toBe('sales');
    expect(domain.layer).toBe('gold');
    expect(domain.models.map((m) => [m.name, m.columns.length])).toEqual([['fct_order', 3], ['dim_customer', 1], ['dim_date', 1]]);
    expect(domain.viewConfig.positions!.fct_order).toEqual({ x: 10, y: 20 });
    expect(links(domain)).toEqual(['fct_order.customer_key>dim_customer.customer_key']);
  });

  it('requires the dbml option for a .dbml diagram', async () => {
    const { promise } = load(project(), { dbml: undefined });
    await expect(promise).rejects.toThrow(SubjectAreaValidationError);
    await expect(load(project(), { dbml: undefined }).promise).rejects.toThrow(
      ".erd-studio/gold/sales.dbml is a DBML diagram; pass dbml: dbmlStorageReader from '@erd-studio/core/dbml' to read it.",
    );
  });

  it.each([
    '.erd-studio/tables/dim_date.dbml',
    '.erd-studio/tables/finance/fct_order.dbml',
    '.erd-studio/tables/finance/_relationships.dbml',
    '.erd-studio/gold/_Relationships.dbml',
  ])('refuses %s as not a diagram', async (domainPath) => {
    await expect(load(project(), { domainPath }).promise).rejects.toThrow(
      `${domainPath} is a DBML table or relationships file, not a diagram. Open a diagram in a layer folder.`,
    );
  });

  it('refuses tables/x.dbml even when layers.json lists a tables layer: no §3.3 row makes it a diagram', async () => {
    // With DBML evidence in tables/, a listed `tables` is either the library
    // (x.dbml is a table) or a YAML project's layer (its .dbml files are
    // `other`), the single classifier's two answers.
    const layers = JSON.stringify({ schemaVersion: 1, layers: [{ id: 'tables', label: 'Tables', abbreviation: 'TBL', color: '#a0a0a0', creatable: true, order: 0 }] });
    const files = { '.erd-studio/layers.json': layers, '.erd-studio/tables/t.dbml': "Project t {\n  erd_schema_version: '7'\n}\n" };
    for (const tablesDirIsLayer of [false, true]) {
      expect(classifySemanticFile('tables/t.dbml', { tablesDirIsLayer }).kind).not.toBe('diagram');
    }
    const { promise, reads } = load(files, { domainPath: '.erd-studio/tables/t.dbml' });
    await expect(promise).rejects.toThrow('.erd-studio/tables/t.dbml is a DBML table or relationships file, not a diagram. Open a diagram in a layer folder.');
    expect(reads).toEqual([]);
  });

  it('probes in the shared order: logical-models/ first, then each tables/ folder with .dbml before .yml', async () => {
    const { promise, reads } = load(project());
    await promise;
    const probes = reads.filter((p) => p.includes('/dim_customer.'));
    expect(probes).toEqual([
      '.erd-studio/logical-models/dim_customer.yml',
      '.erd-studio/logical-models/finance/dim_customer.yml',
      '.erd-studio/logical-models/gold/dim_customer.yml',
      '.erd-studio/tables/dim_customer.dbml',
      '.erd-studio/tables/dim_customer.yml',
      '.erd-studio/tables/finance/dim_customer.dbml',
    ]);
    // The relationships file of every folder in the probe set.
    expect(reads.filter((p) => p.endsWith('_relationships.dbml'))).toEqual([
      '.erd-studio/tables/_relationships.dbml',
      '.erd-studio/tables/finance/_relationships.dbml',
      '.erd-studio/tables/gold/_relationships.dbml',
    ]);
  });

  it('.dbml beats .yml in one directory, and logical-models/ beats tables/', async () => {
    const files = project({
      '.erd-studio/tables/dim_date.yml': 'name: dim_date\ncolumns:\n  - name: from_yml\n    dataType: int\n',
      '.erd-studio/logical-models/dim_customer.yml': 'name: dim_customer\ncolumns:\n  - name: from_logical_models\n    dataType: int\n',
    });
    const { promise, warnings } = load(files);
    const domain = await promise;
    expect(domain.models.find((m) => m.name === 'dim_date')!.columns.map((c) => c.name)).toEqual(['date_key']);
    expect(domain.models.find((m) => m.name === 'dim_customer')!.columns.map((c) => c.name)).toEqual(['from_logical_models']);
    // A DBML member that resolves to a .yml is drawn, with a warning (D20).
    expect(warnings.some((w) => w.includes('"dim_customer" is a YAML table'))).toBe(true);
  });

  it('a Ref whose owner is a library table off this diagram is not drawn and raises no warning', async () => {
    // fct_payment lives in tables/finance but is not a member: core read only
    // the members, so it cannot call the Ref orphaned (§2.4).
    const files = project({
      '.erd-studio/tables/finance/fct_payment.dbml': 'Table fct_payment {\n  id int [pk]\n  customer_key int\n}\n',
      '.erd-studio/tables/finance/_relationships.dbml': "use { table fct_order } from './fct_order.dbml'\nuse { table fct_payment } from './fct_payment.dbml'\nuse { table dim_customer } from './dim_customer.dbml'\n\nRef: fct_order.customer_key >? dim_customer.customer_key\nRef: fct_payment.customer_key >? dim_customer.customer_key\n",
    });
    const { promise, warnings } = load(files);
    expect(links(await promise)).toEqual(['fct_order.customer_key>dim_customer.customer_key']);
    expect(warnings.filter((w) => w.includes('fct_payment'))).toEqual([]);
  });

  it('draws a misplaced Ref from a probe-set folder\'s file, with a warning', async () => {
    const files = project({
      '.erd-studio/tables/_relationships.dbml': "use { table fct_order } from './finance/fct_order.dbml'\nuse { table dim_date } from './dim_date.dbml'\n\nRef: fct_order.date_key >? dim_date.date_key\n",
    });
    const { promise, warnings } = load(files);
    // Attached in the order the files are read: the top of the library first.
    expect(links(await promise)).toEqual(['fct_order.date_key>dim_date.date_key', 'fct_order.customer_key>dim_customer.customer_key']);
    expect(warnings.some((w) => w.includes('the next edit of fct_order'))).toBe(true);
  });

  it('a broken table file is a placeholder with its DBML load error', async () => {
    const files = project({ '.erd-studio/tables/dim_date.dbml': 'Table dim_date {\n  date_key int [pk\n}\n' });
    const domain = await load(files).promise;
    expect(domain.models.find((m) => m.name === 'dim_date')).toMatchObject({ columns: [], loadError: { kind: 'dbmlSyntax', line: 3 } });
  });

  describe('limits', () => {
    it('maxModels counts the use lines', async () => {
      await expect(load(project(), { maxModels: 2 }).promise).rejects.toThrow(TooManyTablesError);
    });

    it('maxDomainChars limits the diagram; a .dbdiagram beside it is never read (positions are its erd_layout)', async () => {
      await expect(load(project(), { maxDomainChars: 50 }).promise).rejects.toThrow(FileTooLargeError);
      const files = project({ '.erd-studio/gold/sales.dbdiagram': JSON.stringify({ version: '3.0.0', defaultView: { tablePositions: [{ name: 'fct_order', schemaName: 'public', x: 99, y: 99 }] } }) });
      const { promise, warnings } = load(files, { maxDomainChars: 1000 });
      const domain = await promise;
      expect(domain.models).toHaveLength(3);
      expect(domain.viewConfig.positions!.fct_order).toEqual({ x: 10, y: 20 });
      expect(warnings.some((w) => w.includes('dbdiagram'))).toBe(false);
    });

    it('maxYamlChars limits a .dbml table file as written: over it, a placeholder', async () => {
      const { promise, warnings } = load(project(), { maxYamlChars: 60 });
      const domain = await promise;
      expect(domain.models.find((m) => m.name === 'fct_order')!.columns).toEqual([]);
      expect(domain.models.find((m) => m.name === 'dim_date')!.columns).toHaveLength(1);
      expect(warnings.some((w) => w.includes('Model "fct_order" is'))).toBe(true);
    });

    it('maxRelationshipsChars: a longer relationships file is not read, with a warning', async () => {
      const { promise, warnings } = load(project(), { maxRelationshipsChars: 20 });
      expect((await promise).relationships).toEqual([]);
      expect(warnings.some((w) => w.includes('_relationships.dbml is larger than the limit; its relationships are not drawn'))).toBe(true);
    });

    it('maxRelationshipsChars must be a number', async () => {
      await expect(load(project(), { maxRelationshipsChars: Number.NaN }).promise).rejects.toThrow(TypeError);
    });
  });
});

describe('loadDisplaySubjectArea: JSON diagrams beside DBML tables', () => {
  const json = JSON.stringify({
    schemaVersion: 5,
    domain: 'mixed',
    layer: 'gold',
    description: '',
    logical: { models: ['fct_order', 'dim_customer'], relationships: [] },
    viewConfig: { positions: {} },
  });
  const mixed = (): Files => ({
    '.erd-studio/layers.json': LAYERS,
    '.erd-studio/gold/mixed.json': json,
    '.erd-studio/tables/gold/fct_order.dbml': 'Table fct_order {\n  id int [pk]\n  customer_key int\n}\n',
    '.erd-studio/tables/gold/_relationships.dbml': "use { table fct_order } from './fct_order.dbml'\n\nRef: fct_order.customer_key >? dim_customer.customer_key\n",
    '.erd-studio/logical-models/dim_customer.yml': 'name: dim_customer\ncolumns:\n  - name: customer_key\n    dataType: int\n    isPrimaryKey: true\n',
  });

  it('with the dbml option, draws the DBML tables and their library relationships', async () => {
    const domain = await load(mixed(), { domainPath: '.erd-studio/gold/mixed.json' }).promise;
    expect(domain.schemaVersion).toBe(5);
    expect(domain.models.map((m) => [m.name, m.columns.length])).toEqual([['fct_order', 2], ['dim_customer', 1]]);
    expect(links(domain)).toEqual(['fct_order.customer_key>dim_customer.customer_key']);
  });

  it('without it, loads exactly as before: no .dbml is probed', async () => {
    const { promise, reads } = load(mixed(), { domainPath: '.erd-studio/gold/mixed.json', dbml: undefined });
    const domain = await promise;
    expect(reads.some((p) => p.endsWith('.dbml'))).toBe(false);
    expect(domain.models.find((m) => m.name === 'fct_order')!.columns).toEqual([]);
    expect(domain.relationships).toEqual([]);
  });
});
