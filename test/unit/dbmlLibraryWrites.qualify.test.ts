/**
 * `planDbmlLibraryWrites`' `qualify` op (Qualify Tables) over Gerhard's
 * photo-2 shape (packages/core/test/fixtures/dbml/same-name-unqualified:
 * `Table adresse` with no schema in tables/bqs/ and tables/ccc/, and the
 * relationships file 2.0.4 wrote, which imports both as `adresse`).
 *
 * The header gains its schema folder's qualifier in place (no file moves),
 * and every `use` specifier and Ref end naming the table is re-spelled, the
 * Ref ends told apart by their columns; a table already qualified, under
 * `public/`, or not asked for is left byte for byte.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { compileDbmlProject } from '@erd-studio/core/dbml';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { clearDiagramSummaries } from '../../src/services/dbmlDiagramSummaries';
import type { FileWrite } from '../../src/services/fileWrites';

const FIXTURE = path.resolve(__dirname, '../../packages/core/test/fixtures/dbml/same-name-unqualified/.erd-studio');

let root: string;
let semantic: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-qualify-'));
  semantic = path.join(root, '.erd-studio');
  fs.cpSync(FIXTURE, semantic, { recursive: true });
  clearDiagramSummaries();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const rel = (filePath: string): string => path.relative(semantic, filePath).split(path.sep).join('/');
const BQS = { schema: 'bqs', name: 'adresse' };
const CCC = { schema: 'ccc', name: 'adresse' };

function plan(qualify: Array<{ schema: string; name: string }>): Map<string, FileWrite> {
  const lib = new TableLibraryService(root, '.erd-studio');
  const { writes } = lib.planDbmlLibraryOps({ qualify });
  return new Map(writes.map((w) => [rel(w.path), w]));
}
const textOf = (w: FileWrite | undefined): string => (w && w.kind !== 'delete' ? w.text : '');

describe('qualify', () => {
  it('declares both adresse tables in their folders\' schemas in place and re-spells the relationships file\'s use lines and Ref ends by their columns', () => {
    const writes = plan([BQS, CCC]);
    expect([...writes.keys()].sort()).toEqual([
      'bronze/relationships/bronze.dbml',
      'bronze/tables/bqs/adresse.dbml',
      'bronze/tables/ccc/adresse.dbml',
    ]);
    expect([...writes.values()].every((w) => w.kind === 'replace')).toBe(true);
    expect(textOf(writes.get('bronze/tables/bqs/adresse.dbml'))).toBe('Table bqs.adresse {\n  id INT [pk]\n  strasse VARCHAR\n  ort VARCHAR\n}\n');
    expect(textOf(writes.get('bronze/tables/ccc/adresse.dbml'))).toMatch(/^Table ccc\.adresse \{\n {2}adr_id INT \[pk\]/);
    const rels = textOf(writes.get('bronze/relationships/bronze.dbml'));
    expect(rels).toContain("use { table bqs.adresse }");
    expect(rels).toContain("use { table ccc.adresse }");
    expect(rels).toContain('Ref: bqs__v_sap_prod_unit2.bqs_adresse_id >? bqs.adresse.id');
    expect(rels).toContain('Ref: bqs__v_sap_prod_unit2.ccc_adresse_id >? ccc.adresse.adr_id');
    expect(rels).toContain('Ref: ccc.adresse.adr_id >? bqs.adresse.id');
    // The end whose columns neither table has stays as written: nothing says which table it is.
    expect(rels).toContain('Ref: bqs__v_sap_prod_unit2.unit_id >? adresse.nowhere');
  });

  it('the files it writes compile in the pinned parser, but for the Ref nothing could name', () => {
    const writes = plan([BQS, CCC]);
    const files: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.name.endsWith('.dbml')) files[rel(abs)] = fs.readFileSync(abs, 'utf-8');
      }
    };
    walk(semantic);
    for (const [p, w] of writes) files[p] = textOf(w);
    const diagnostics = Object.entries(compileDbmlProject(files, ['bronze/relationships/bronze.dbml']))
      .flatMap(([f, ds]) => ds.map((d) => `${f}:${d.line} [${d.code}]`));
    expect(diagnostics).toEqual(['bronze/relationships/bronze.dbml:9 [4000]']);
  });

  it('a table already qualified is left as it is', () => {
    const file = path.join(semantic, 'bronze/tables/bqs/adresse.dbml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('Table adresse', 'Table bqs.adresse'));
    const writes = plan([BQS]);
    expect(writes.has('bronze/tables/bqs/adresse.dbml')).toBe(false);
  });

  it('a table under public/ is left as it is (DBML reads it as public already)', () => {
    fs.mkdirSync(path.join(semantic, 'bronze/tables/public'), { recursive: true });
    fs.renameSync(path.join(semantic, 'bronze/tables/ccc/adresse.dbml'), path.join(semantic, 'bronze/tables/public/adresse.dbml'));
    const writes = plan([{ schema: 'public', name: 'adresse' }]);
    expect(writes.size).toBe(0);
  });
});
