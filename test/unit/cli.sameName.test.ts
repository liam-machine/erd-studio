/**
 * The CLI on two tables of one name in different schema folders (the twin
 * fixture, packages/core/test/fixtures/dbml/same-name-two-schemas), with the
 * library telling tables apart by identity (`schemaScopedNames`, turned on
 * here for every TableLibraryService the CLI builds). Existing JSON fields
 * keep a table's own name; an additive `schema` field says which one (D-11).
 * The old rule's duplicateTableName stays until the rule flips.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCliContext } from '../../src/cli/context';
import { runDiff } from '../../src/cli/diff';
import { runDoctor } from '../../src/cli/doctor';
import { runInventory } from '../../src/cli/inventory';
import { diffModelSnapshots } from '../../src/cli/modelChanges';
import { readModelSnapshot } from '../../src/cli/modelSnapshot';
import { listSemanticFiles } from '../../src/services/semanticFiles';

vi.mock('../../src/services/logicalModelService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/logicalModelService')>();
  /** The CLI's Table Library with the identity rule on, whoever builds it. */
  class ScopedTableLibraryService extends actual.TableLibraryService {
    constructor(...args: ConstructorParameters<typeof actual.TableLibraryService>) {
      const [workspaceRoot, semanticDir, ownWriteTracker, options] = args;
      super(workspaceRoot, semanticDir, ownWriteTracker, { ...options, schemaScopedNames: true });
    }
  }
  return { ...actual, TableLibraryService: ScopedTableLibraryService };
});

const TWINS = path.resolve(__dirname, '../../packages/core/test/fixtures/dbml/same-name-two-schemas');
let tmp: string;
let root: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-cli-same-name-'));
  root = path.join(tmp, 'project');
  fs.cpSync(TWINS, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const semantic = (rel: string): string => path.join(root, '.erd-studio', rel);
const REL = 'bronze/relationships/bronze.dbml';

async function problems(): Promise<Array<{ file: string; line?: number; code: string | number; message: string }>> {
  const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: tmp });
  return r.erd.dbmlProblems.map((p) => ({ file: p.file, ...(p.line !== undefined ? { line: p.line } : {}), code: p.code, message: p.message }));
}

/** A snapshot of the project's files as they are now (what `changes` reads for the working tree). */
function snapshotNow() {
  const semanticRoot = path.join(root, '.erd-studio');
  const files = listSemanticFiles(semanticRoot, { tablesDirIsLayer: false }).map((e) => e.rel);
  return readModelSnapshot(files, (rel) => {
    try { return fs.readFileSync(path.join(semanticRoot, rel), 'utf-8'); } catch { return null; }
  });
}

describe('doctor: two tables of one name in different schema folders', () => {
  it('reports no Ref twice, no extra import and nothing but the old rule\'s duplicate, plus the 2.0.2-style diagram\'s version', async () => {
    const codes = (await problems()).map((p) => [p.file.replace('.erd-studio/', ''), p.code]);
    expect(codes).toEqual([
      ['bronze/tables/ccc/addresse.dbml', 'duplicateTableName'],
      ['bronze/tables/ccc/kunde.dbml', 'duplicateTableName'],
      ['bronze/diagrams/kunden-bare.dbml', 'twinDiagramVersion'],
    ]);
    const version = (await problems()).find((p) => p.code === 'twinDiagramVersion')!;
    expect(version.message).toMatch(/two tables named addresse, kunde from different schema folders/);
    expect(version.message).toMatch(/erd_schema_version '7'/);
    expect(version.message).toMatch(/ERD Studio 2\.0\.4 and later/);
  });

  it('a Ref whose table the file does not import names the right table\'s use line', async () => {
    const text = fs.readFileSync(semantic(REL), 'utf-8').replace("use { table ccc.addresse } from '../tables/ccc/addresse.dbml'\n", '');
    fs.writeFileSync(semantic(REL), text);
    const missing = (await problems()).filter((p) => p.code === 'missingUse');
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain("use { table ccc.addresse } from '../tables/ccc/addresse.dbml'");
  });

  it('a Ref naming a column ccc\'s table lacks is dangling against ccc\'s columns, not bqs\'s', async () => {
    fs.appendFileSync(semantic(REL), 'Ref: ccc.kunde.full_name > ccc.addresse.strasse\n');
    const dangling = (await problems()).filter((p) => p.code === 'danglingRef');
    expect(dangling.map((p) => p.line)).toEqual([10]);
    expect(dangling[0].message).toContain('addresse.strasse');
  });

  it('an unqualified Ref end two schema folders share is ambiguous, never a self-join', async () => {
    fs.appendFileSync(semantic(REL), 'Ref: ccc.kunde.full_name > addresse.street\nRef: ccc.addresse.id > addresse.id\n');
    // (The parser's own [4000] for each line stays: other DBML tools fail it too.)
    const found = (await problems()).filter((p) => p.file.endsWith(REL) && p.line !== undefined && p.line >= 10 && typeof p.code === 'string');
    expect(found.map((p) => [p.line, p.code]).sort()).toEqual([[10, 'ambiguousTableReference'], [11, 'ambiguousTableReference']]);
    expect(found.every((p) => /bqs, ccc/.test(p.message))).toBe(true);
    expect(found.some((p) => /itself/.test(p.message))).toBe(false);
  });

  it('an unqualified end goes to the table in tables/public/ when one is there (D-10)', async () => {
    fs.mkdirSync(semantic('bronze/tables/public'), { recursive: true });
    fs.writeFileSync(semantic('bronze/tables/public/ort.dbml'), 'Table ort {\n  id INT [pk]\n}\n');
    fs.writeFileSync(semantic('bronze/tables/ccc/ort.dbml'), 'Table ccc.ort {\n  id INT [pk]\n}\n');
    fs.appendFileSync(semantic(REL), "use { table ort } from '../tables/public/ort.dbml'\nRef: ccc.kunde.addresse_id > ort.id\n");
    expect((await problems()).filter((p) => p.code === 'ambiguousTableReference')).toEqual([]);
  });

  it('a copied schema folder whose files declare the same schema is a duplicate declaration (D-15)', async () => {
    fs.cpSync(semantic('bronze/tables/bqs'), semantic('bronze/tables/bqs_backup'), { recursive: true });
    const dup = (await problems()).filter((p) => p.code === 'duplicateDeclaredTable');
    expect(dup.map((p) => p.file.replace('.erd-studio/', '')).sort()).toEqual([
      'bronze/tables/bqs/addresse.dbml', 'bronze/tables/bqs/kunde.dbml', 'bronze/tables/bqs_backup/addresse.dbml', 'bronze/tables/bqs_backup/kunde.dbml',
    ]);
    expect(dup.find((p) => p.file.includes('bqs_backup/addresse'))!.message).toContain('Table bqs_backup.addresse');
  });

  it('a YAML table whose stored relationship names a shared DBML name is reported, not resolved (D-9)', async () => {
    fs.mkdirSync(semantic('logical-models'), { recursive: true });
    fs.writeFileSync(semantic('logical-models/lieferung.yml'), [
      'name: lieferung', 'columns:', '  - name: id', '    isPrimaryKey: true', '  - name: addresse_id',
      'relationships:', '  - toModel: addresse', '    fromColumn: addresse_id', '    toColumn: id', '    cardinality: many-to-one', '',
    ].join('\n'));
    const ambiguous = (await problems()).filter((p) => p.code === 'ambiguousTableReference');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].file).toBe('.erd-studio/logical-models/lieferung.yml');
    expect(ambiguous[0].message).toMatch(/names addresse, which DBML tables in more than one schema folder have \(bqs, ccc\)/);
  });
});

describe('inventory: two tables of one name in different schema folders', () => {
  it('lists each table by its own name, its own columns and diagrams, with its schema folder beside it', async () => {
    const r = runInventory(await buildCliContext({ project: root, semanticDir: '.erd-studio' }));
    const addresse = r.logicalTables.filter((t) => t.name === 'addresse');
    expect(addresse.map((t) => [t.schema, t.file, t.columns?.map((c) => c.name), t.domains])).toEqual([
      ['bqs', '.erd-studio/bronze/tables/bqs/addresse.dbml', ['id', 'strasse', 'ort'],
        ['.erd-studio/bronze/diagrams/kunden-bare.dbml', '.erd-studio/bronze/diagrams/kunden.dbml']],
      ['ccc', '.erd-studio/bronze/tables/ccc/addresse.dbml', ['id', 'street', 'city', 'postcode'],
        ['.erd-studio/bronze/diagrams/ccc.dbml', '.erd-studio/bronze/diagrams/kunden-bare.dbml', '.erd-studio/bronze/diagrams/kunden.dbml']],
    ]);
    const kunden = r.domains.find((d) => d.domain === 'kunden')!;
    expect(kunden.models).toEqual(['addresse', 'kunde', 'addresse', 'kunde']);
    expect(kunden.tables).toEqual([
      { name: 'addresse', schema: 'bqs' }, { name: 'kunde', schema: 'bqs' }, { name: 'addresse', schema: 'ccc' }, { name: 'kunde', schema: 'ccc' },
    ]);
  });
});

describe('diff: two tables of one name in different schema folders', () => {
  it('names a fix\'s table by its own name with its schema, and its file by the table\'s own file', async () => {
    fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: p\nprofile: p\n');
    fs.mkdirSync(path.join(root, 'models'), { recursive: true });
    fs.writeFileSync(path.join(root, 'models', 'schema.yml'), [
      'version: 2', 'models:', '  - name: addresse', '    config:', '      schema: ccc',
      '    columns:', '      - name: id', '      - name: street', '      - name: city', '      - name: postcode', '      - name: country', '',
    ].join('\n'));
    const ctx = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
    const { result } = runDiff(ctx, { domains: [semantic('bronze/diagrams/kunden.dbml')] });
    const r = result.domains[0] as unknown as { fixes: Array<{ kind: string; model: string; schema?: string; column?: string; file: string }>; missingModelFiles: string[] };
    expect(r.missingModelFiles).toEqual([]);
    const country = r.fixes.find((f) => f.kind === 'add-column' && f.column === 'country');
    expect(country).toMatchObject({ model: 'addresse', schema: 'ccc', file: '.erd-studio/bronze/tables/ccc/addresse.dbml' });
    expect(r.fixes.some((f) => f.model.includes('.'))).toBe(false);
    // bqs's addresse is not the dbt model called addresse (built in ccc): it has none, and is told so by its schema.
    const phantom = r.fixes.find((f) => f.kind === 'resolve-phantom' && f.model === 'addresse') as { schema?: string; explain?: string } | undefined;
    expect(phantom?.schema).toBe('bqs');
    expect(phantom?.explain).toMatch(/^No dbt model is bqs's addresse/);
  });
});

describe('changes: two tables of one name in different schema folders', () => {
  it('a second table of a name appearing is one added table and no change to the first', () => {
    // Before: no ccc.addresse, and no Ref to it.
    const full = fs.readFileSync(semantic(REL), 'utf-8');
    fs.writeFileSync(semantic(REL), full.split('\n').filter((l) => !/ccc\.addresse/.test(l)).join('\n'));
    fs.rmSync(semantic('bronze/tables/ccc/addresse.dbml'));
    const base = snapshotNow();
    fs.cpSync(path.join(TWINS, '.erd-studio/bronze/tables/ccc/addresse.dbml'), semantic('bronze/tables/ccc/addresse.dbml'));
    fs.writeFileSync(semantic(REL), full);
    const changes = diffModelSnapshots(base, snapshotNow());
    expect(changes.tables.added.map((t) => [t.name, t.file])).toEqual([['addresse', 'bronze/tables/ccc/addresse.dbml']]);
    expect(changes.tables.removed).toEqual([]);
    expect(changes.tables.moved).toEqual([]);
    expect(changes.tables.changed).toEqual([]);
    // bqs's relationships are the same relationships, though they are now named bqs.addresse.
    expect(changes.relationships.removed).toEqual([]);
    expect(changes.relationships.added.map((r) => `${r.fromTable}.${r.fromColumn}>${r.toTable}.${r.toColumn}`).sort())
      .toEqual(['ccc.addresse.id>bqs.addresse.id', 'ccc.kunde.addresse_id>ccc.addresse.id']);
  });

  it('deleting one of the two is one removed table and no change to the other', () => {
    const base = snapshotNow();
    fs.rmSync(semantic('bronze/tables/bqs/addresse.dbml'));
    const changes = diffModelSnapshots(base, snapshotNow());
    expect(changes.tables.removed.map((t) => [t.name, t.file])).toEqual([['addresse', 'bronze/tables/bqs/addresse.dbml']]);
    expect(changes.tables.added).toEqual([]);
    expect(changes.tables.changed).toEqual([]);
    expect(changes.tables.moved).toEqual([]);
  });

  it('a table moved to another schema folder is still moved', () => {
    const base = snapshotNow();
    fs.mkdirSync(semantic('bronze/tables/ddd'));
    fs.writeFileSync(semantic('bronze/tables/ddd/kunde.dbml'), fs.readFileSync(semantic('bronze/tables/ccc/kunde.dbml'), 'utf-8').replace('Table ccc.kunde', 'Table ddd.kunde'));
    fs.rmSync(semantic('bronze/tables/ccc/kunde.dbml'));
    fs.rmSync(semantic('bronze/tables/bqs/kunde.dbml'));
    const changes = diffModelSnapshots(base, snapshotNow());
    expect(changes.tables.moved.map((m) => [m.name, m.from.file, m.to.file])).toEqual([['kunde', 'bronze/tables/ccc/kunde.dbml', 'bronze/tables/ddd/kunde.dbml']]);
    expect(changes.tables.removed.map((t) => t.file)).toEqual(['bronze/tables/bqs/kunde.dbml']);
    expect(changes.tables.added).toEqual([]);
  });
});
