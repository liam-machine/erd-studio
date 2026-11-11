/**
 * `loadDisplaySubjectArea` on two tables of one name in different schema
 * folders (test/fixtures/same-name-two-schemas: bqs and ccc, each with
 * addresse and kunde). A table's identity is its schema folder and name:
 * each member is read from its own file, a diagram that shows both names
 * them `bqs.addresse` and `ccc.addresse` (with `tableName` beside), every
 * Ref end lands on its own table, and a diagram that shows one draws no Ref
 * of the other. With the stale-path rules (a member whose file is gone is
 * never read from its namesake) and the reads they cost: a contested Ref end
 * costs one read, and none in a project whose qualifiers match.
 *
 * Goldens (packages/core/test/fixtures/golden/same-name-two-schemas.*):
 * regenerate with UPDATE_GOLDEN=1 for an intended change.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { loadDisplaySubjectArea, type LoadDisplaySubjectAreaOptions } from '../../src/loadDisplayDomain';
import { dbmlStorageReader } from '../../src/dbml/index';
import { dbmlTableFinder } from '../../src/storage';
import type { DisplaySubjectArea } from '../../src/types/display';

type Files = Record<string, string>;

const UPDATE = process.env.UPDATE_GOLDEN === '1';
const TWINS = path.resolve(__dirname, '../../../../test/fixtures/same-name-two-schemas');
const GOLDEN_DIR = path.resolve(__dirname, '../fixtures/golden');
const diagramPath = (name: string): string => `.erd-studio/bronze/diagrams/${name}.dbml`;

/** The fixture's files, by path from the project root. */
function fixture(): Files {
  const out: Files = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(TWINS, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf-8');
    }
  };
  walk(TWINS);
  return out;
}

function load(files: Files, domainPath: string, options: Partial<LoadDisplaySubjectAreaOptions> = {}) {
  const reads: string[] = [];
  const warnings: string[] = [];
  const promise = loadDisplaySubjectArea({
    domainPath,
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

const links = (display: DisplaySubjectArea): string[] =>
  display.relationships.map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}`).sort();
const tables = (display: DisplaySubjectArea) =>
  display.models.map((m) => ({ name: m.name, tableName: m.tableName, schema: m.schema, layer: m.layer, columns: m.columns.map((c) => c.name) }));

describe('a diagram with both tables of each name (kunden)', () => {
  it('draws each from its own file, named <schema>.<name> with its own name beside it, at its own position', async () => {
    const { promise, reads, warnings } = load(fixture(), diagramPath('kunden'));
    const display = await promise;
    expect(tables(display)).toEqual([
      { name: 'bqs.addresse', tableName: 'addresse', schema: 'bqs', layer: 'bronze', columns: ['id', 'strasse', 'ort'] },
      { name: 'bqs.kunde', tableName: 'kunde', schema: 'bqs', layer: 'bronze', columns: ['id', 'name', 'addresse_id'] },
      { name: 'ccc.addresse', tableName: 'addresse', schema: 'ccc', layer: 'bronze', columns: ['id', 'street', 'city', 'postcode'] },
      { name: 'ccc.kunde', tableName: 'kunde', schema: 'ccc', layer: 'bronze', columns: ['id', 'full_name', 'addresse_id'] },
    ]);
    expect(display.viewConfig.positions).toEqual({
      'bqs.addresse': { x: 40, y: 40 }, 'bqs.kunde': { x: 400, y: 40 }, 'ccc.addresse': { x: 40, y: 360 }, 'ccc.kunde': { x: 400, y: 360 },
    });
    expect(display.viewConfig.annotations?.map((a) => a.linkedModel)).toEqual(['ccc.addresse']);
    expect(display.schemaVersion).toBe(8);
    expect(warnings).toEqual([]);
    // One read per member and one per import: every end names its table by a use line, so nothing is probed.
    expect(reads.filter((p) => p.endsWith('.dbml') && p !== diagramPath('kunden'))).toEqual([
      '.erd-studio/bronze/tables/bqs/addresse.dbml',
      '.erd-studio/bronze/tables/bqs/kunde.dbml',
      '.erd-studio/bronze/tables/ccc/addresse.dbml',
      '.erd-studio/bronze/tables/ccc/kunde.dbml',
      '.erd-studio/bronze/relationships/bronze.dbml',
    ]);
  });

  it('draws the Refs to each and the one between them: none stored twice, none a self-loop', async () => {
    const { promise, warnings } = load(fixture(), diagramPath('kunden'));
    const display = await promise;
    expect(links(display)).toEqual([
      'bqs.kunde.addresse_id>bqs.addresse.id',
      'ccc.addresse.id>bqs.addresse.id',
      'ccc.kunde.addresse_id>ccc.addresse.id',
    ]);
    expect(warnings.filter((w) => w.includes('stored twice') || w.includes('itself'))).toEqual([]);
    // Every end and every position key is some table's name, exactly.
    const names = new Set(display.models.map((m) => m.name));
    for (const r of display.relationships) expect([names.has(r.fromModel), names.has(r.toModel)]).toEqual([true, true]);
    for (const key of Object.keys(display.viewConfig.positions ?? {})) expect(names.has(key)).toBe(true);
  });

  it('the 2.0.2 copy (one bare line per name) places the first twin of each and links its sticky to it; the others are placed automatically', async () => {
    const { promise, warnings } = load(fixture(), diagramPath('kunden-bare'));
    const display = await promise;
    const positions = display.viewConfig.positions!;
    expect(positions['bqs.addresse']).toEqual({ x: 40, y: 40 });
    expect(positions['bqs.kunde']).toEqual({ x: 400, y: 40 });
    expect(Object.keys(positions).sort()).toEqual(['bqs.addresse', 'bqs.kunde', 'ccc.addresse', 'ccc.kunde']);
    expect(display.viewConfig.annotations?.map((a) => a.linkedModel)).toEqual(['bqs.addresse']);
    expect(links(display)).toEqual(links(await load(fixture(), diagramPath('kunden')).promise));
    expect(display.schemaVersion).toBe(7);
    expect(warnings).toEqual([]);
  });
});

describe('a diagram with the ccc tables only', () => {
  it('names them bare, as before, and draws only ccc\'s Ref: no bqs Ref lands on a ccc table', async () => {
    const { promise, reads, warnings } = load(fixture(), diagramPath('ccc'));
    const display = await promise;
    expect(tables(display)).toEqual([
      { name: 'addresse', tableName: undefined, schema: 'ccc', layer: 'bronze', columns: ['id', 'street', 'city', 'postcode'] },
      { name: 'kunde', tableName: undefined, schema: 'ccc', layer: 'bronze', columns: ['id', 'full_name', 'addresse_id'] },
    ]);
    expect(links(display)).toEqual(['kunde.addresse_id>addresse.id']);
    expect(warnings).toEqual([]);
    // The bqs ends name the ccc tables' names with another qualifier and their own use lines: one read
    // of each of those files says the ends mean tables elsewhere.
    expect(reads.filter((p) => p.includes('/bqs/')).sort()).toEqual([
      '.erd-studio/bronze/tables/bqs/addresse.dbml',
      '.erd-studio/bronze/tables/bqs/kunde.dbml',
    ]);
  });

  it('a probe read that fails says nothing: the end stays where 2.0 drew it, and the load does not fail', async () => {
    const files = fixture();
    const { promise } = load(files, diagramPath('ccc'), {});
    const base = await promise;
    const failing = await loadDisplaySubjectArea({
      domainPath: diagramPath('ccc'),
      readFile: async (p) => {
        if (p.includes('/bqs/')) throw new Error('network');
        return files[p] ?? null;
      },
      readOnly: false,
      warn: () => {},
      dbml: dbmlStorageReader,
    });
    expect(tables(failing)).toEqual(tables(base));
  });
});

describe('a member whose file is gone (the stale-path rule)', () => {
  it('is drawn missing, never from its namesake that another member is read from', async () => {
    const files = fixture();
    delete files['.erd-studio/bronze/tables/bqs/addresse.dbml'];
    const { promise, reads } = load(files, diagramPath('kunden'));
    const display = await promise;
    const bqs = display.models.find((m) => m.name === 'bqs.addresse')!;
    expect(bqs.columns).toEqual([]);
    expect(bqs.tableName).toBe('addresse');
    expect(display.models.find((m) => m.name === 'ccc.addresse')!.columns.map((c) => c.name)).toEqual(['id', 'street', 'city', 'postcode']);
    // ccc's file was read once: for ccc.addresse.
    expect(reads.filter((p) => p === '.erd-studio/bronze/tables/ccc/addresse.dbml')).toHaveLength(1);
  });

  it('findDbmlTable is told what the stale line said, and an answer that is another member\'s file is ignored', async () => {
    const files = fixture();
    delete files['.erd-studio/bronze/tables/bqs/addresse.dbml'];
    const asked: unknown[] = [];
    const display = await load(files, diagramPath('kunden'), {
      findDbmlTable: (name, hint) => {
        asked.push([name, hint]);
        return 'bronze/tables/ccc/addresse.dbml';
      },
    }).promise;
    expect(asked).toEqual([['addresse', { schema: 'bqs', layer: 'bronze', stalePath: 'bronze/tables/bqs/addresse.dbml' }]]);
    expect(display.models.find((m) => m.name === 'bqs.addresse')!.columns).toEqual([]);
  });

  it('with the finder over a listing, a table moved to another schema folder is still found when it is the one of its name', async () => {
    const files = fixture();
    files['.erd-studio/bronze/tables/ddd/addresse.dbml'] = files['.erd-studio/bronze/tables/bqs/addresse.dbml'].replace('bqs.addresse', 'ddd.addresse');
    delete files['.erd-studio/bronze/tables/bqs/addresse.dbml'];
    delete files['.erd-studio/bronze/tables/ccc/addresse.dbml'];
    const listing = Object.keys(files).filter((p) => p.startsWith('.erd-studio/')).map((p) => p.slice('.erd-studio/'.length));
    // The ccc-only diagram's addresse line points at ccc's file, now gone; ddd holds the only addresse.
    const { promise, warnings } = load(files, diagramPath('ccc'), { findDbmlTable: dbmlTableFinder(listing) });
    const display = await promise;
    expect(display.models.find((m) => m.name === 'addresse')!.schema).toBe('ddd');
    expect(warnings.some((w) => w.includes('it was read from bronze/tables/ddd/addresse.dbml'))).toBe(true);
  });

  it('a leftover stale line beside the real one: the table that exists keeps the old bare position', async () => {
    const files: Files = {
      '.erd-studio/layers.json': fixture()['.erd-studio/layers.json'],
      '.erd-studio/bronze/tables/fin/x.dbml': 'Table fin.x {\n  id int [pk]\n}\n',
      [diagramPath('d')]: [
        'Project d {', "  erd_layout: '''", '    x 10 20', "  '''", '}',
        "use { table crm.x } from '../tables/crm/x.dbml'",
        "use { table fin.x } from '../tables/fin/x.dbml'", '',
      ].join('\n'),
    };
    const { promise } = load(files, diagramPath('d'));
    const display = await promise;
    expect(tables(display).map((t) => [t.name, t.columns])).toEqual([['crm.x', []], ['fin.x', ['id']]]);
    expect(display.viewConfig.positions!['fin.x']).toEqual({ x: 10, y: 20 });
    expect(display.viewConfig.positions!['crm.x']).not.toEqual({ x: 10, y: 20 });
  });
});

describe('a project with no shared name reads as before, with the cost it had', () => {
  const LAYERS = JSON.stringify({ schemaVersion: 1, layers: [
    { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 0 },
    { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 1 },
  ] });
  const SALES = '.erd-studio/gold/diagrams/sales.dbml';
  const base = (relationships: string, diagramUses: string): Files => ({
    '.erd-studio/layers.json': LAYERS,
    [SALES]: `${diagramUses}\nuse * from '../relationships/gold.dbml'\n`,
    '.erd-studio/gold/tables/finance/fct_order.dbml': 'Table finance.fct_order {\n  id int [pk]\n  region_key int\n}\n',
    '.erd-studio/gold/tables/finance/dim_region.dbml': 'Table finance.dim_region {\n  region_key int [pk]\n}\n',
    '.erd-studio/gold/relationships/gold.dbml': relationships,
  });
  const ORDER_USE = "use { table finance.fct_order } from '../tables/finance/fct_order.dbml'";

  it('a stale qualifier on a unique name still draws its line, as 2.0.2 did, at the cost of one read', async () => {
    const files = base(
      `${ORDER_USE}\nuse { table crm.dim_region } from '../../silver/tables/crm/dim_region.dbml'\n\nRef: finance.fct_order.region_key > crm.dim_region.region_key\n`,
      `${ORDER_USE}\nuse { table finance.dim_region } from '../tables/finance/dim_region.dbml'`,
    );
    const { promise, reads, warnings } = load(files, SALES);
    expect(links(await promise)).toEqual(['fct_order.region_key>dim_region.region_key']);
    expect(warnings).toEqual([]);
    expect(reads.filter((p) => p.includes('/crm/'))).toEqual(['.erd-studio/silver/tables/crm/dim_region.dbml']);
  });

  it('a stale diagram use line with a correct relationships file: drawn from where it is, its line drawn, and nothing probed', async () => {
    const files = base(
      `${ORDER_USE}\nuse { table finance.dim_region } from '../tables/finance/dim_region.dbml'\n\nRef: finance.fct_order.region_key > finance.dim_region.region_key\n`,
      `${ORDER_USE}\nuse { table crm.dim_region } from '../../silver/tables/crm/dim_region.dbml'`,
    );
    const { promise, reads } = load(files, SALES);
    const display = await promise;
    expect(display.models.find((m) => m.name === 'dim_region')!.schema).toBe('finance');
    expect(links(display)).toEqual(['fct_order.region_key>dim_region.region_key']);
    // The member's own stale path, then the folder its other line names: no read beyond the lookup itself.
    expect(reads.filter((p) => p.includes('dim_region'))).toEqual([
      '.erd-studio/silver/tables/crm/dim_region.dbml',
      '.erd-studio/gold/tables/finance/dim_region.dbml',
    ]);
  });

  it('a copied schema folder (bqs_backup, still declaring bqs.x): every bqs Ref lands on the bqs file its use line names', async () => {
    const files = fixture();
    for (const name of ['addresse', 'kunde']) {
      files[`.erd-studio/bronze/tables/bqs_backup/${name}.dbml`] = files[`.erd-studio/bronze/tables/bqs/${name}.dbml`].replace('Addresses', 'Old addresses');
    }
    files[diagramPath('copy')] = [
      "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
      "use { table bqs.addresse } from '../tables/bqs_backup/addresse.dbml'",
      "use { table bqs.kunde } from '../tables/bqs/kunde.dbml'",
      "use * from '../relationships/bronze.dbml'", '',
    ].join('\n');
    const display = await load(files, diagramPath('copy')).promise;
    expect(display.models.map((m) => [m.name, m.description])).toEqual([
      ['bqs.addresse', 'Addresses from the BQS system'],
      ['bqs_backup.addresse', 'Old addresses from the BQS system'],
      ['kunde', 'Customers from the BQS system'],
    ]);
    expect(links(display)).toEqual(['kunde.addresse_id>bqs.addresse.id']);
    // A diagram of the bqs tables alone is what it always was.
    const bqsOnly = { ...files, [diagramPath('bqs')]: files[diagramPath('copy')].replace("use { table bqs.addresse } from '../tables/bqs_backup/addresse.dbml'\n", '') };
    const alone = await load(bqsOnly, diagramPath('bqs')).promise;
    expect(alone.models.map((m) => m.name)).toEqual(['addresse', 'kunde']);
    expect(links(alone)).toEqual(['kunde.addresse_id>addresse.id']);
  });
});

describe('golden: what core draws for the twin fixture', () => {
  it.each(['kunden', 'ccc', 'kunden-bare'])('the %s diagram', async (name) => {
    const display = await load(fixture(), diagramPath(name)).promise;
    const file = path.join(GOLDEN_DIR, `same-name-two-schemas.${name}.display.json`);
    const text = JSON.stringify(display, null, 2) + '\n';
    if (UPDATE) fs.writeFileSync(file, text);
    expect(text).toBe(fs.readFileSync(file, 'utf-8'));
  });
});
