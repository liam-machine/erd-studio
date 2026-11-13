/**
 * `planDbmlLibraryWrites`' `qualify` op (Qualify Tables) over the reporter's
 * photo-2 shape (packages/core/test/fixtures/dbml/same-name-unqualified:
 * `Table adresse` with no schema in tables/bqs/ and tables/ccc/, and the
 * relationships file 2.0.4 wrote, which imports both as `adresse`).
 *
 * The header gains its schema folder's qualifier in place (no file moves),
 * and every `use` specifier and Ref end naming the table is re-spelled, the
 * Ref ends told apart by their columns, or, where the columns do not say
 * (both tables have them, or neither does), by the user's pick
 * (`qualifyEnds`): with no pick such a plan is refused, never guessed. A
 * table under `public/` or not asked for is left byte for byte; one already
 * qualified keeps its file, and its bare use lines and Ref ends are
 * re-spelled.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { compileDbmlProject } from '@erd-studio/core/dbml';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { decideSharedSpellingEnds, type SharedSpellingEndChoice } from '../../src/services/dbmlLibraryWrites';
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

/** The fixture's Ref whose column neither adresse has (line 9), told to be bqs's. */
const NOWHERE_IS_BQS: SharedSpellingEndChoice = { file: 'bronze/relationships/bronze.dbml', line: 9, side: 'right', table: { schema: 'bqs', name: 'adresse' } };

function plan(qualify: Array<{ schema: string; name: string }>, qualifyEnds: SharedSpellingEndChoice[] = [NOWHERE_IS_BQS]): Map<string, FileWrite> {
  const lib = new TableLibraryService(root, '.erd-studio');
  const { writes } = lib.planDbmlLibraryOps({ qualify, qualifyEnds });
  return new Map(writes.map((w) => [rel(w.path), w]));
}

/** Every .dbml of the project with `writes` applied, compiled from `entry` by the pinned parser. */
function compiledWith(writes: Map<string, FileWrite>, entry: string): string[] {
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
  return Object.entries(compileDbmlProject(files, [entry])).flatMap(([f, ds]) => ds.map((d) => `${f}:${d.line} [${d.code}] ${d.message}`));
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
    // The end whose column neither table has: the table the user picked for it.
    expect(rels).toContain('Ref: bqs__v_sap_prod_unit2.unit_id >? bqs.adresse.nowhere');
  });

  it('the files it writes compile in the pinned parser, but for the column nothing has', () => {
    const diagnostics = compiledWith(plan([BQS, CCC]), 'bronze/relationships/bronze.dbml');
    // Never [3003] or a missing table: only the column the Ref names and bqs.adresse lacks.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/^bronze\/relationships\/bronze\.dbml:9 \[\d+\] .*nowhere/);
  });

  it('with no pick for an end the columns do not decide, it refuses: never guessed, nothing written', () => {
    expect(() => plan([BQS, CCC], [])).toThrow(/bronze\/relationships\/bronze\.dbml line 9: Ref: bqs__v_sap_prod_unit2\.unit_id >\? adresse\.nowhere names adresse.*neither bqs\.adresse and ccc\.adresse has adresse\.nowhere/);
  });

  it('a table already qualified keeps its file; its bare use lines and Ref ends are re-spelled', () => {
    const file = path.join(semantic, 'bronze/tables/bqs/adresse.dbml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('Table adresse', 'Table bqs.adresse'));
    const writes = plan([BQS]);
    expect(writes.has('bronze/tables/bqs/adresse.dbml')).toBe(false);
    const rels = textOf(writes.get('bronze/relationships/bronze.dbml'));
    expect(rels).toContain("use { table bqs.adresse }");
    expect(rels).toContain('Ref: bqs__v_sap_prod_unit2.bqs_adresse_id >? bqs.adresse.id');
  });

  it('a table under public/ is left as it is (DBML reads it as public already)', () => {
    fs.mkdirSync(path.join(semantic, 'bronze/tables/public'), { recursive: true });
    fs.renameSync(path.join(semantic, 'bronze/tables/ccc/adresse.dbml'), path.join(semantic, 'bronze/tables/public/adresse.dbml'));
    const writes = plan([{ schema: 'public', name: 'adresse' }]);
    expect(writes.size).toBe(0);
  });
});

/** Both address tables have `id` (the usual case the breaker found): only the user can say which a Ref end means. */
describe('qualify when both tables have the Ref\'s column', () => {
  const RELS = 'bronze/relationships/bronze.dbml';
  beforeEach(() => {
    fs.writeFileSync(path.join(semantic, 'bronze/tables/ccc/adresse.dbml'), 'Table adresse {\n  id INT [pk]\n  street VARCHAR\n}\n');
    fs.writeFileSync(path.join(semantic, RELS), [
      "use { table adresse }               from '../tables/bqs/adresse.dbml'",
      "use { table bqs__v_sap_prod_unit2 } from '../tables/bqs/bqs__v_sap_prod_unit2.dbml'",
      "use { table adresse }               from '../tables/ccc/adresse.dbml'",
      '',
      'Ref: bqs__v_sap_prod_unit2.bqs_adresse_id >? adresse.id',
      'Ref: bqs__v_sap_prod_unit2.ccc_adresse_id >? adresse.id',
      '',
    ].join('\n'));
  });

  it('lists each such end with its line, side, Ref and both tables', () => {
    const lib = new TableLibraryService(root, '.erd-studio');
    const undecided = decideSharedSpellingEnds(lib.dbmlSnapshot(), [BQS, CCC]).undecided;
    expect(undecided.map((e) => [e.file, e.line, e.side, e.endText, e.fitting, e.candidates.map((c) => c.schema)])).toEqual([
      [RELS, 5, 'right', 'adresse.id', 2, ['bqs', 'ccc']],
      [RELS, 6, 'right', 'adresse.id', 2, ['bqs', 'ccc']],
    ]);
    expect(undecided[0].refText).toBe('Ref: bqs__v_sap_prod_unit2.bqs_adresse_id >? adresse.id');
    expect(undecided[0].paths).toEqual(['bronze/tables/bqs/adresse.dbml', 'bronze/tables/ccc/adresse.dbml']);
  });

  it('writes each end as picked, re-spells both use lines, and the relationships file compiles', () => {
    const writes = plan([BQS, CCC], [
      { file: RELS, line: 5, side: 'right', table: BQS },
      { file: RELS, line: 6, side: 'right', table: CCC },
    ]);
    const rels = textOf(writes.get(RELS));
    expect(rels).toContain('Ref: bqs__v_sap_prod_unit2.bqs_adresse_id >? bqs.adresse.id');
    expect(rels).toContain('Ref: bqs__v_sap_prod_unit2.ccc_adresse_id >? ccc.adresse.id');
    expect(rels).not.toMatch(/use \{ table adresse \}/);
    // (Diagrams' use lines are the editor's settle: test/unit/semanticEditorProvider.sharedUseSpelling.test.ts.)
    expect(compiledWith(writes, RELS)).toEqual([]);
  });

  it('refuses with no pick, naming the line', () => {
    expect(() => plan([BQS, CCC], [])).toThrow(/line 5: .*bqs\.adresse and ccc\.adresse both have them/);
  });

  it('a relationships file that only imports both (no Ref) gets its use lines re-spelled too', () => {
    fs.writeFileSync(path.join(semantic, RELS), [
      "use { table adresse } from '../tables/bqs/adresse.dbml'",
      "use { table adresse } from '../tables/ccc/adresse.dbml'",
      '',
    ].join('\n'));
    const rels = textOf(plan([BQS, CCC], []).get(RELS));
    expect(rels).not.toMatch(/use \{ table adresse \}/);
  });
});
