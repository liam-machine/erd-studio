/**
 * `loadDisplaySubjectArea` on two tables of one name in different schema
 * folders (packages/core/test/fixtures/dbml/same-name-two-schemas: bqs and ccc, each with
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
const TWINS = path.resolve(__dirname, '../fixtures/dbml/same-name-two-schemas');
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

  it('with the finder, a Ref end whose use line names a file that is gone is not drawn on a namesake when the finder says the table is elsewhere', async () => {
    // The ccc-only diagram imports r.dbml, which names bqs.addresse by a use line to bqs's file; that file was
    // moved to ddd/. On the diagram the one addresse is ccc's, which the Ref never meant (the extension draws nothing).
    const files = fixture();
    files['.erd-studio/bronze/tables/ddd/addresse.dbml'] = files['.erd-studio/bronze/tables/bqs/addresse.dbml'].replace('bqs.addresse', 'ddd.addresse');
    delete files['.erd-studio/bronze/tables/bqs/addresse.dbml'];
    delete files['.erd-studio/bronze/relationships/bronze.dbml'];
    files['.erd-studio/bronze/relationships/r.dbml'] = [
      "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
      "use { table ccc.kunde } from '../tables/ccc/kunde.dbml'",
      'Ref: ccc.kunde.addresse_id > bqs.addresse.id', '',
    ].join('\n');
    files[diagramPath('ccc')] = files[diagramPath('ccc')].replace("use * from '../relationships/bronze.dbml'", "use * from '../relationships/r.dbml'");
    const listing = Object.keys(files).filter((p) => p.startsWith('.erd-studio/')).map((p) => p.slice('.erd-studio/'.length));
    const withFinder = await load(files, diagramPath('ccc'), { findDbmlTable: dbmlTableFinder(listing) }).promise;
    expect(links(withFinder)).toEqual([]);
    // The table moved, and is the one of its name the diagram shows: the end still lands on it, as it always did.
    const moved = fixture();
    moved['.erd-studio/bronze/tables/ddd/addresse.dbml'] = moved['.erd-studio/bronze/tables/ccc/addresse.dbml'].replace('ccc.addresse', 'ddd.addresse');
    for (const f of ['bronze/tables/bqs/addresse.dbml', 'bronze/tables/ccc/addresse.dbml', 'bronze/relationships/bronze.dbml']) delete moved[`.erd-studio/${f}`];
    moved['.erd-studio/bronze/relationships/r.dbml'] = files['.erd-studio/bronze/relationships/r.dbml'];
    moved[diagramPath('one')] = [
      "Project one {\n  erd_schema_version: '7'\n}",
      "use { table ddd.addresse } from '../tables/ddd/addresse.dbml'",
      "use { table ccc.kunde } from '../tables/ccc/kunde.dbml'",
      "use * from '../relationships/r.dbml'",
      '',
    ].join('\n');
    const movedListing = Object.keys(moved).filter((p) => p.startsWith('.erd-studio/')).map((p) => p.slice('.erd-studio/'.length));
    const stillDrawn = await load(moved, diagramPath('one'), { findDbmlTable: dbmlTableFinder(movedListing) }).promise;
    expect(links(stillDrawn)).toEqual(['kunde.addresse_id>addresse.id']);
  });

  describe('with no finder, in the folders the lines name (owner decision B, as the host)', () => {
    /** A diagram of bqs.addresse (its file gone), ccc.kunde and ddd.kunde: its lines name bqs, ccc and ddd. */
    function threeFolders(withDdd: boolean): Files {
      const files = fixture();
      files['.erd-studio/bronze/tables/ddd/kunde.dbml'] = files['.erd-studio/bronze/tables/ccc/kunde.dbml'].replace('ccc.kunde', 'ddd.kunde');
      if (withDdd) files['.erd-studio/bronze/tables/ddd/addresse.dbml'] = files['.erd-studio/bronze/tables/ccc/addresse.dbml'].replace('ccc.addresse', 'ddd.addresse');
      delete files['.erd-studio/bronze/tables/bqs/addresse.dbml'];
      files[diagramPath('three')] = [
        "Project three {\n  erd_schema_version: '7'\n}",
        "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
        "use { table ccc.kunde } from '../tables/ccc/kunde.dbml'",
        "use { table ddd.kunde } from '../tables/ddd/kunde.dbml'",
        '',
      ].join('\n');
      return files;
    }

    it('two other schema folders hold the name: the member is drawn missing, with a warning (both probed)', async () => {
      const { promise, reads, warnings } = load(threeFolders(true), diagramPath('three'));
      const display = await promise;
      expect(display.models.find((m) => m.name === 'addresse')!.columns).toEqual([]);
      expect(warnings.some((w) => w.includes('more than one other schema folder has a table of that name'))).toBe(true);
      expect(reads.filter((p) => p.endsWith('/addresse.dbml'))).toEqual([
        '.erd-studio/bronze/tables/bqs/addresse.dbml',
        '.erd-studio/bronze/tables/ccc/addresse.dbml',
        '.erd-studio/bronze/tables/ddd/addresse.dbml',
      ]);
    });

    it('one other schema folder holds it: the member is read from there, as before', async () => {
      const { promise, warnings } = load(threeFolders(false), diagramPath('three'));
      const display = await promise;
      expect(display.models.find((m) => m.name === 'addresse')!.columns.map((c) => c.name)).toEqual(['id', 'street', 'city', 'postcode']);
      expect(warnings.some((w) => w.includes('it was read from bronze/tables/ccc/addresse.dbml'))).toBe(true);
    });

    it('its own schema folder in another layer comes before another schema folder', async () => {
      const files = threeFolders(true);
      files['.erd-studio/layers.json'] = JSON.stringify({ schemaVersion: 1, layers: [{ id: 'bronze' }, { id: 'silver' }] });
      files['.erd-studio/silver/tables/bqs/addresse.dbml'] = 'Table bqs.addresse {\n  id INT [pk]\n  silver_only VARCHAR\n}\n';
      files['.erd-studio/silver/tables/bqs/x.dbml'] = 'Table bqs.x {\n  id INT [pk]\n}\n';
      files[diagramPath('three')] += "use { table bqs.x } from '../../silver/tables/bqs/x.dbml'\n";
      const display = await load(files, diagramPath('three')).promise;
      expect(display.models.find((m) => m.name === 'addresse')!.columns.map((c) => c.name)).toEqual(['id', 'silver_only']);
    });
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

describe('a qualified Ref end naming a schema folder with no table of its name (never guessed: core agrees with the canvas)', () => {
  /** bqs.kunde and ccc.addresse on a diagram importing only r.dbml, whose Ref names `<qualifier>.addresse`. */
  function mix(qualifier = 'zzz'): Files {
    const files = fixture();
    delete files['.erd-studio/bronze/relationships/bronze.dbml'];
    files[diagramPath('mix')] = [
      "Project mix {\n  erd_schema_version: '7'\n}",
      "use { table bqs.kunde } from '../tables/bqs/kunde.dbml'",
      "use { table ccc.addresse } from '../tables/ccc/addresse.dbml'",
      "use * from '../relationships/r.dbml'", '',
    ].join('\n');
    files['.erd-studio/bronze/relationships/r.dbml'] = [
      "use { table bqs.kunde } from '../tables/bqs/kunde.dbml'",
      `Ref: bqs.kunde.addresse_id > ${qualifier}.addresse.id`, '',
    ].join('\n');
    return files;
  }
  const listingOf = (files: Files): string[] => Object.keys(files).filter((p) => p.startsWith('.erd-studio/')).map((p) => p.slice('.erd-studio/'.length));

  it('bqs has an addresse too (a folder the files name): not drawn on ccc.addresse, with or without a finder', async () => {
    const files = mix();
    const { promise, reads } = load(files, diagramPath('mix'));
    expect(links(await promise)).toEqual([]);
    // One read in each folder the lines name, and in the qualifier's own: nothing else.
    expect(reads.filter((p) => p.endsWith('/addresse.dbml') && !p.includes('/ccc/'))).toEqual([
      '.erd-studio/bronze/tables/bqs/addresse.dbml',
      '.erd-studio/bronze/tables/zzz/addresse.dbml',
    ]);
    expect(links(await load(files, diagramPath('mix'), { findDbmlTable: dbmlTableFinder(listingOf(files)) }).promise)).toEqual([]);
  });

  it('the other addresse in a folder no line names (ddd): the finder says the name is shared, so not drawn; without one core cannot know, and draws it as before', async () => {
    const files = mix();
    files['.erd-studio/bronze/tables/ddd/addresse.dbml'] = files['.erd-studio/bronze/tables/bqs/addresse.dbml'].replace('bqs.addresse', 'ddd.addresse');
    delete files['.erd-studio/bronze/tables/bqs/addresse.dbml'];
    expect(links(await load(files, diagramPath('mix'), { findDbmlTable: dbmlTableFinder(listingOf(files)) }).promise)).toEqual([]);
    expect(links(await load(files, diagramPath('mix')).promise)).toEqual(['kunde.addresse_id>addresse.id']);
  });

  it('the qualifier\'s own folder has an addresse that is not on the diagram: the end is that table, not drawn on ccc\'s', async () => {
    const files = mix();
    delete files['.erd-studio/bronze/tables/bqs/addresse.dbml'];
    files['.erd-studio/bronze/tables/zzz/addresse.dbml'] = files['.erd-studio/bronze/tables/ccc/addresse.dbml'].replace('ccc.addresse', 'zzz.addresse');
    expect(links(await load(files, diagramPath('mix')).promise)).toEqual([]);
  });

  it('rule 4 holds where one table has the name: the stale qualifier still lands on it, with and without a finder', async () => {
    const files = mix();
    delete files['.erd-studio/bronze/tables/bqs/addresse.dbml'];
    const { promise, warnings } = load(files, diagramPath('mix'));
    expect(links(await promise)).toEqual(['kunde.addresse_id>addresse.id']);
    expect(warnings).toEqual([]);
    expect(links(await load(files, diagramPath('mix'), { findDbmlTable: dbmlTableFinder(listingOf(files)) }).promise)).toEqual(['kunde.addresse_id>addresse.id']);
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
