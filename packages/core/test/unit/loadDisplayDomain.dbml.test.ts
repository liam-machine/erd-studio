/**
 * `loadDisplaySubjectArea` with native DBML storage, in the layer-first tree
 * (§1.4, §2.3 of the 2.0 design): the `dbml` option, the not-a-diagram rule
 * (a table or relationships file, a 1.9 pre-release file, any other path),
 * members read from the paths their `use` lines resolve to (then the same
 * name in each table folder those lines name, then the YAML probe), the
 * relationships files the diagram imports and no other, the limits on DBML
 * files, and JSON diagrams in a mixed project.
 */
import { describe, it, expect } from 'vitest';

import { FileTooLargeError, TooManyTablesError, loadDisplaySubjectArea, type LoadDisplaySubjectAreaOptions } from '../../src/loadDisplayDomain';
import { SubjectAreaValidationError } from '../../src/domain';
import { dbmlStorageReader } from '../../src/dbml/index';

type Files = Record<string, string>;

const LAYERS = JSON.stringify({
  schemaVersion: 1,
  layers: [
    { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 0 },
    { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 1 },
  ],
});

const DIAGRAM = '.erd-studio/gold/diagrams/sales.dbml';

function project(extra: Files = {}): Files {
  return {
    '.erd-studio/layers.json': LAYERS,
    [DIAGRAM]: `use { table finance.fct_order } from '../tables/finance/fct_order.dbml'
use { table finance.dim_customer } from '../tables/finance/dim_customer.dbml'
use { table crm.dim_date } from '../../silver/tables/crm/dim_date.dbml'
use * from '../relationships/gold.dbml'

Project sales {
  Note: 'Sales'
  erd_schema_version: '7'
  erd_layout: '''
    fct_order 10 20
  '''
}
`,
    '.erd-studio/gold/tables/finance/fct_order.dbml': 'Table finance.fct_order {\n  id int [pk]\n  customer_key int\n  date_key int\n}\n',
    '.erd-studio/gold/tables/finance/dim_customer.dbml': 'Table finance.dim_customer {\n  customer_key int [pk]\n}\n',
    '.erd-studio/silver/tables/crm/dim_date.dbml': 'Table crm.dim_date {\n  date_key int [pk]\n}\n',
    '.erd-studio/gold/relationships/gold.dbml': "use { table finance.dim_customer } from '../tables/finance/dim_customer.dbml'\nuse { table finance.fct_order } from '../tables/finance/fct_order.dbml'\n\nRef: finance.fct_order.customer_key >? finance.dim_customer.customer_key\n",
    ...extra,
  };
}

function load(files: Files, options: Partial<LoadDisplaySubjectAreaOptions> = {}) {
  const reads: string[] = [];
  const warnings: string[] = [];
  const promise = loadDisplaySubjectArea({
    domainPath: DIAGRAM,
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
  it('draws a DBML diagram: members from their use paths, erd_layout positions, relationships from its imports, schemaVersion 7', async () => {
    const { promise, reads, warnings } = load(project());
    const domain = await promise;
    expect(domain.schemaVersion).toBe(7);
    expect(domain.domain).toBe('sales');
    expect(domain.models.map((m) => [m.name, m.schema, m.columns.length])).toEqual([
      ['fct_order', 'finance', 3], ['dim_customer', 'finance', 1], ['dim_date', 'crm', 1],
    ]);
    expect(domain.viewConfig.positions!.fct_order).toEqual({ x: 10, y: 20 });
    expect(links(domain)).toEqual(['fct_order.customer_key>dim_customer.customer_key']);
    // One read per member, at the path its use line resolves to (across layers too), and one per import.
    expect(reads.filter((p) => p.endsWith('.dbml') && p !== DIAGRAM).sort()).toEqual([
      '.erd-studio/gold/relationships/gold.dbml',
      '.erd-studio/gold/tables/finance/dim_customer.dbml',
      '.erd-studio/gold/tables/finance/fct_order.dbml',
      '.erd-studio/silver/tables/crm/dim_date.dbml',
    ]);
    expect(reads.some((p) => p.endsWith('.yml'))).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('takes the layer from the diagram\'s path (not `diagrams`), and finds layers.json three levels up', async () => {
    // A semantic dir at the root of what readFile serves: the paths have no prefix.
    const files = Object.fromEntries(Object.entries(project()).map(([k, v]) => [k.replace(/^\.erd-studio\//, ''), v]));
    const { promise, reads } = load(files, { domainPath: 'gold/diagrams/sales.dbml' });
    const domain = await promise;
    expect(domain.layer).toBe('gold');
    expect(domain.layerConfig?.label).toBe('Gold');
    expect(reads).toContain('layers.json');
    expect(domain.models.map((m) => m.columns.length)).toEqual([3, 1, 1]);
    expect(links(domain)).toEqual(['fct_order.customer_key>dim_customer.customer_key']);
  });

  it('an unconfigured layer is refused, as for a JSON diagram', async () => {
    const files = project({ '.erd-studio/layers.json': JSON.stringify({ schemaVersion: 1, layers: [{ id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 0 }] }) });
    await expect(load(files).promise).rejects.toThrow(/has invalid layer "gold"/);
  });

  it('requires the dbml option for a .dbml diagram', async () => {
    const { promise } = load(project(), { dbml: undefined });
    await expect(promise).rejects.toThrow(SubjectAreaValidationError);
    await expect(load(project(), { dbml: undefined }).promise).rejects.toThrow(
      ".erd-studio/gold/diagrams/sales.dbml is a DBML diagram; pass dbml: dbmlStorageReader from '@erd-studio/core/dbml' to read it.",
    );
  });

  it.each([
    ['.erd-studio/gold/tables/finance/fct_order.dbml', 'gold'],
    ['.erd-studio/silver/tables/crm/dim_date.dbml', 'silver'],
    ['.erd-studio/gold/relationships/gold.dbml', 'gold'],
  ])('refuses the table or relationships file %s as not a diagram, before reading anything', async (domainPath, layer) => {
    const { promise, reads } = load(project(), { domainPath });
    await expect(promise).rejects.toThrow(
      `${domainPath} is a DBML table or relationships file, not a diagram. Open a diagram in ${layer}/diagrams/.`,
    );
    expect(reads).toEqual([]);
  });

  it.each([
    '.erd-studio/gold/sales.dbml',
    '.erd-studio/tables/gold/fct_order.dbml',
    '.erd-studio/tables/_relationships.dbml',
  ])('refuses %s, a file of the 1.9 pre-release tree, with the legacy message, even without the dbml option', async (domainPath) => {
    // Named relative to the semantic dir (§1.8: `legacyDbmlFileMessage(rel)`).
    const rel = domainPath.slice('.erd-studio/'.length);
    const message = `${rel} was written by an ERD Studio 1.9 pre-release, whose folder layout 2.0 does not read. `
      + 'Run erd-studio doctor in the project for the steps to convert it again.';
    await expect(load(project(), { domainPath }).promise).rejects.toThrow(message);
    const { promise, reads } = load(project(), { domainPath, dbml: undefined });
    await expect(promise).rejects.toThrow(SubjectAreaValidationError);
    await expect(promise).rejects.toThrow(message);
    expect(reads).toEqual([]);
  });

  it.each([
    '.erd-studio/gold/Diagrams/sales.dbml',
    '.erd-studio/Gold/diagrams/sales.dbml',
    '.erd-studio/gold/diagrams/sub/sales.dbml',
    '.erd-studio/logical-models/diagrams/sales.dbml',
  ])('refuses %s: diagrams live in <layer>/diagrams/<name>.dbml', async (domainPath) => {
    const { promise, reads } = load(project(), { domainPath });
    await expect(promise).rejects.toThrow(
      `${domainPath} is not a DBML diagram. ERD Studio diagrams live in <layer>/diagrams/<name>.dbml (the folder names are lower-case).`,
    );
    expect(reads).toEqual([]);
  });

  it('a member whose file moved within the folders the use lines name is read from there', async () => {
    // dim_customer's use line is stale (its file is now in finance/ of silver's tables, a folder another line names).
    const files = project({
      [DIAGRAM]: project()[DIAGRAM].replace("use { table crm.dim_date } from '../../silver/tables/crm/dim_date.dbml'",
        "use { table crm.dim_date } from '../../silver/tables/crm/dim_date.dbml'\nuse { table crm.dim_region } from '../../silver/tables/crm/dim_region.dbml'"),
      '.erd-studio/silver/tables/finance/x.dbml': '',
      '.erd-studio/silver/tables/crm/dim_region.dbml': undefined as never,
      '.erd-studio/gold/tables/finance/dim_region.dbml': 'Table finance.dim_region {\n  region_key int [pk]\n}\n',
    });
    delete files['.erd-studio/silver/tables/crm/dim_region.dbml'];
    const { promise, reads } = load(files);
    const domain = await promise;
    const region = domain.models.find((m) => m.name === 'dim_region')!;
    expect(region.columns.map((c) => c.name)).toEqual(['region_key']);
    // Its schema is the folder it was found in.
    expect(region.schema).toBe('finance');
    // The resolved path first, then the folders the use lines name, in byte order.
    expect(reads.filter((p) => p.includes('/dim_region.'))).toEqual([
      '.erd-studio/silver/tables/crm/dim_region.dbml',
      '.erd-studio/gold/tables/finance/dim_region.dbml',
    ]);
  });

  it('a member found in no DBML folder falls back to the YAML probe, and is drawn with a warning (D20)', async () => {
    const files = project({
      [DIAGRAM]: project()[DIAGRAM].replace("use * from", "use { table gold.dim_yaml } from '../tables/gold/dim_yaml.dbml'\nuse * from"),
      '.erd-studio/logical-models/dim_yaml.yml': 'name: dim_yaml\ncolumns:\n  - name: from_yml\n    dataType: int\n',
    });
    const { promise, reads, warnings } = load(files);
    const domain = await promise;
    expect(domain.models.find((m) => m.name === 'dim_yaml')!.columns.map((c) => c.name)).toEqual(['from_yml']);
    expect(reads.filter((p) => p.includes('/dim_yaml.'))).toEqual([
      '.erd-studio/gold/tables/gold/dim_yaml.dbml',
      '.erd-studio/gold/tables/finance/dim_yaml.dbml',
      '.erd-studio/silver/tables/crm/dim_yaml.dbml',
      '.erd-studio/logical-models/dim_yaml.yml',
    ]);
    expect(warnings.some((w) => w.includes('"dim_yaml" is a YAML table'))).toBe(true);
  });

  it('a use line that leaves the semantic dir is never read', async () => {
    const files = project({
      [DIAGRAM]: project()[DIAGRAM].replace("use * from", "use { table outside } from '../../../outside.dbml'\nuse * from"),
      'outside.dbml': 'Table outside {\n  id int\n}\n',
    });
    const { promise, reads } = load(files);
    const domain = await promise;
    expect(domain.models.find((m) => m.name === 'outside')!.columns).toEqual([]);
    // Only the folders the other use lines name are probed for it, inside the semantic dir.
    expect(reads.filter((p) => p.includes('outside.dbml'))).toEqual([
      '.erd-studio/gold/tables/finance/outside.dbml',
      '.erd-studio/silver/tables/crm/outside.dbml',
    ]);
  });

  it('a use path with a backslash is never read (on a Windows host `a\\..` would leave the semantic dir)', async () => {
    const files = project({
      [DIAGRAM]: project()[DIAGRAM].replace("use * from", "use { table dim } from 'a\\\\..\\\\..\\\\..\\\\..\\\\outside/dim.dbml'\nuse * from"),
    });
    const { promise, reads } = load(files);
    const domain = await promise;
    expect(domain.models.find((m) => m.name === 'dim')!.columns).toEqual([]);
    expect(reads.filter((p) => p.includes('\\'))).toEqual([]);
    expect(reads.filter((p) => p.includes('dim.dbml'))).toEqual([
      '.erd-studio/gold/tables/finance/dim.dbml',
      '.erd-studio/silver/tables/crm/dim.dbml',
    ]);
  });

  it('a doubled separator in the diagram\'s path is no segment: the prefix is still the semantic dir', async () => {
    const domainPath = '.erd-studio/gold/diagrams//sales.dbml';
    const files = project();
    files[domainPath] = files[DIAGRAM];
    const { promise, reads, warnings } = load(files, { domainPath });
    const domain = await promise;
    expect(reads).toContain('.erd-studio/layers.json');
    expect(domain.layer).toBe('gold');
    expect(domain.models.map((m) => m.columns.length)).toEqual([3, 1, 1]);
    expect(links(domain)).toEqual(['fct_order.customer_key>dim_customer.customer_key']);
    expect(warnings).toEqual([]);
  });

  it('an unqualified Table takes its schema folder; the [schema:] property is not the schema', async () => {
    const files = project({
      '.erd-studio/gold/tables/finance/dim_customer.dbml': "Table dim_customer [schema: 'other'] {\n  customer_key int [pk]\n}\n",
    });
    const { promise, warnings } = load(files);
    const domain = await promise;
    expect(domain.models.find((m) => m.name === 'dim_customer')!.schema).toBe('finance');
    expect(warnings.some((w) => w.startsWith('Model "dim_customer": ') && w.includes('Table finance.dim_customer'))).toBe(true);
  });

  it('draws only the Refs of the relationships files it imports: another file\'s Ref between its members is not drawn', async () => {
    const files = project({
      '.erd-studio/silver/relationships/silver.dbml': "use { table finance.fct_order } from '../../gold/tables/finance/fct_order.dbml'\nuse { table crm.dim_date } from '../tables/crm/dim_date.dbml'\n\nRef: finance.fct_order.date_key >? crm.dim_date.date_key\n",
    });
    const { promise, reads, warnings } = load(files);
    expect(links(await promise)).toEqual(['fct_order.customer_key>dim_customer.customer_key']);
    expect(reads).not.toContain('.erd-studio/silver/relationships/silver.dbml');
    expect(warnings).toEqual([]);
    // Imported, it is drawn too: the files in path byte order.
    const imported = { ...files, [DIAGRAM]: files[DIAGRAM].replace("use * from '../relationships/gold.dbml'", "use * from '../../silver/relationships/silver.dbml'\nuse * from '../relationships/gold.dbml'") };
    expect(links(await load(imported).promise)).toEqual([
      'fct_order.customer_key>dim_customer.customer_key',
      'fct_order.date_key>dim_date.date_key',
    ]);
  });

  it('an imported relationships file that does not exist draws nothing, with a warning', async () => {
    const files = project();
    delete files['.erd-studio/gold/relationships/gold.dbml'];
    const { promise, warnings } = load(files);
    expect((await promise).relationships).toEqual([]);
    expect(warnings).toEqual([`${DIAGRAM}: imports gold/relationships/gold.dbml, which does not exist; its relationships are not drawn`]);
  });

  it('a Ref whose owner is a library table off this diagram is not drawn and raises no warning', async () => {
    // fct_payment lives in gold/tables/finance but is not a member: core read only
    // the members, so it cannot call the Ref orphaned (§2.4).
    const files = project({
      '.erd-studio/gold/tables/finance/fct_payment.dbml': 'Table finance.fct_payment {\n  id int [pk]\n  customer_key int\n}\n',
      '.erd-studio/gold/relationships/gold.dbml': "use { table finance.dim_customer } from '../tables/finance/dim_customer.dbml'\nuse { table finance.fct_order } from '../tables/finance/fct_order.dbml'\nuse { table finance.fct_payment } from '../tables/finance/fct_payment.dbml'\n\nRef: finance.fct_order.customer_key >? finance.dim_customer.customer_key\nRef: finance.fct_payment.customer_key >? finance.dim_customer.customer_key\n",
    });
    const { promise, warnings } = load(files);
    expect(links(await promise)).toEqual(['fct_order.customer_key>dim_customer.customer_key']);
    expect(warnings.filter((w) => w.includes('fct_payment'))).toEqual([]);
  });

  it('a broken table file is a placeholder with its DBML load error', async () => {
    const files = project({ '.erd-studio/silver/tables/crm/dim_date.dbml': 'Table crm.dim_date {\n  date_key int [pk\n}\n' });
    const domain = await load(files).promise;
    expect(domain.models.find((m) => m.name === 'dim_date')).toMatchObject({ columns: [], loadError: { kind: 'dbmlSyntax', line: 3 } });
  });

  describe('limits', () => {
    it('maxModels counts the use lines', async () => {
      await expect(load(project(), { maxModels: 2 }).promise).rejects.toThrow(TooManyTablesError);
    });

    it('maxDomainChars limits the diagram; a .dbdiagram beside it is never read (positions are its erd_layout)', async () => {
      await expect(load(project(), { maxDomainChars: 50 }).promise).rejects.toThrow(FileTooLargeError);
      const files = project({ '.erd-studio/gold/diagrams/sales.dbdiagram': JSON.stringify({ version: '3.0.0', defaultView: { tablePositions: [{ name: 'fct_order', schemaName: 'public', x: 99, y: 99 }] } }) });
      const { promise, warnings, reads } = load(files, { maxDomainChars: 1000 });
      const domain = await promise;
      expect(domain.models).toHaveLength(3);
      expect(domain.viewConfig.positions!.fct_order).toEqual({ x: 10, y: 20 });
      expect(warnings.some((w) => w.includes('dbdiagram'))).toBe(false);
      expect(reads.some((p) => p.endsWith('.dbdiagram'))).toBe(false);
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
      expect(warnings.some((w) => w.includes('gold/relationships/gold.dbml is larger than the limit; its relationships are not drawn'))).toBe(true);
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
    '.erd-studio/gold/tables/gold/fct_order.dbml': 'Table gold.fct_order {\n  id int [pk]\n  customer_key int\n}\n',
    '.erd-studio/gold/relationships/gold.dbml': "use { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nRef: gold.fct_order.customer_key >? dim_customer.customer_key\n",
    '.erd-studio/logical-models/dim_customer.yml': 'name: dim_customer\ncolumns:\n  - name: customer_key\n    dataType: int\n    isPrimaryKey: true\n',
  });

  it.each([true, false])('loads exactly as without DBML (dbml option: %s): no .dbml is read, a DBML table is drawn as missing', async (withDbml) => {
    // The accepted parity gap (§2.3): core has no listing, so a JSON diagram
    // cannot find a DBML table by name; the extension, which lists, draws it.
    const { promise, reads } = load(mixed(), { domainPath: '.erd-studio/gold/mixed.json', ...(withDbml ? {} : { dbml: undefined }) });
    const domain = await promise;
    expect(domain.schemaVersion).toBe(5);
    expect(reads.some((p) => p.endsWith('.dbml'))).toBe(false);
    expect(domain.models.map((m) => [m.name, m.columns.length])).toEqual([['fct_order', 0], ['dim_customer', 1]]);
    expect(domain.relationships).toEqual([]);
  });
});
