/**
 * storage.ts — the single file classifier, the table lookup order, the paths
 * that belong together and the posix helpers (native DBML storage, §3.4 and
 * §3.5 of docs/plans/native-dbml-storage.md).
 */

import { describe, expect, it } from 'vitest';

import {
  classifySemanticFile,
  dbmlNotADiagramMessage,
  dirnamePosix,
  isInsidePosix,
  isLibraryFolderName,
  isReservedTableName,
  joinPosix,
  legacyDbmlFileMessage,
  normalisePosix,
  relativePosix,
  resolvePosix,
  subjectAreaStorageOf,
  tableFileCandidates,
  type SemanticFileClass,
} from '../../src/storage';
import { NON_SUBJECT_AREA_DIRS } from '../../src/domain';
import { ERD_STUDIO_DBML_HEADER_PREFIX } from '../../src/dbmlRichProperties';
import { DBML_RICH_EXPORT_HEADER } from '../../src/exportDbmlRich';

const LIBRARY = { tablesDirIsLayer: false };
const LAYER = { tablesDirIsLayer: true };

describe('classifySemanticFile', () => {
  const LEGACY_TABLE: SemanticFileClass = { kind: 'other', legacy: 'table' };
  const LEGACY_RELATIONSHIPS: SemanticFileClass = { kind: 'other', legacy: 'relationships' };
  const LEGACY_DIAGRAM: SemanticFileClass = { kind: 'other', legacy: 'diagram' };
  const LEGACY_LAYOUT: SemanticFileClass = { kind: 'other', legacy: 'layout' };
  // [path, expected while tables/ is the library, expected while tables/ is a layer]
  const rows: Array<[string, SemanticFileClass, SemanticFileClass]> = [
    // depth 1
    ['layers.json', { kind: 'layers' }, { kind: 'layers' }],
    ['README.md', { kind: 'readme' }, { kind: 'readme' }],
    ['readme.md', { kind: 'other' }, { kind: 'other' }],
    ['sales.json', { kind: 'other' }, { kind: 'other' }],
    ['sales.dbml', { kind: 'other' }, { kind: 'other' }],
    ['sales.dbdiagram', LEGACY_LAYOUT, LEGACY_LAYOUT],
    // templates
    ['templates/dim.json', { kind: 'template' }, { kind: 'template' }],
    ['templates/a/b.json', { kind: 'template' }, { kind: 'template' }],
    ['templates/diagrams/x.dbml', { kind: 'template' }, { kind: 'template' }],
    // logical-models
    ['logical-models/dim_date.yml', { kind: 'table', storage: 'yaml', name: 'dim_date' }, { kind: 'table', storage: 'yaml', name: 'dim_date' }],
    ['logical-models/gold/fct.yml', { kind: 'table', storage: 'yaml', folder: 'gold', name: 'fct' }, { kind: 'table', storage: 'yaml', folder: 'gold', name: 'fct' }],
    ['logical-models/Finance/fct.yml', { kind: 'table', storage: 'yaml', folder: 'Finance', name: 'fct' }, { kind: 'table', storage: 'yaml', folder: 'Finance', name: 'fct' }],
    ['logical-models/SAP FI/fct.yml', { kind: 'table', storage: 'yaml', folder: 'SAP FI', name: 'fct' }, { kind: 'table', storage: 'yaml', folder: 'SAP FI', name: 'fct' }],
    ['logical-models/.git/fct.yml', { kind: 'other' }, { kind: 'other' }],
    ['logical-models/a/b/fct.yml', { kind: 'other' }, { kind: 'other' }],
    // A two-segment .dbml has the 1.9 pre-release's diagram shape, wherever it is (§1.8).
    ['logical-models/fct.dbml', LEGACY_DIAGRAM, LEGACY_DIAGRAM],
    ['logical-models/fct.json', { kind: 'other' }, { kind: 'other' }],
    ['logical-models/diagrams/x.dbml', { kind: 'other' }, { kind: 'other' }],
    // tables/: the YAML library, or a YAML layer; a .dbml in it is the 1.9 pre-release's
    ['tables/dim_date.dbml', LEGACY_TABLE, LEGACY_TABLE],
    ['tables/gold/fct_order.dbml', LEGACY_TABLE, LEGACY_TABLE],
    ['tables/Finance/x.dbml', LEGACY_TABLE, LEGACY_TABLE],
    ['tables/SAP FI/x.dbml', LEGACY_TABLE, LEGACY_TABLE],
    ['tables/_relationships.dbml', LEGACY_RELATIONSHIPS, LEGACY_RELATIONSHIPS],
    ['tables/_Relationships.dbml', LEGACY_RELATIONSHIPS, LEGACY_RELATIONSHIPS],
    ['tables/gold/_relationships.dbml', LEGACY_RELATIONSHIPS, LEGACY_RELATIONSHIPS],
    ['tables/_x.dbml', LEGACY_TABLE, LEGACY_TABLE],
    ['tables/_relationships.yml', { kind: 'table', storage: 'yaml', name: '_relationships' }, { kind: 'other' }],
    ['tables/dim.yml', { kind: 'table', storage: 'yaml', name: 'dim' }, { kind: 'other' }],
    ['tables/gold/dim.yml', { kind: 'table', storage: 'yaml', folder: 'gold', name: 'dim' }, { kind: 'other' }],
    ['tables/sales.json', { kind: 'other' }, { kind: 'diagram', storage: 'json', layer: 'tables', name: 'sales' }],
    ['tables/sales.dbdiagram', LEGACY_LAYOUT, LEGACY_LAYOUT],
    ['tables/.hidden/x.dbml', { kind: 'other' }, { kind: 'other' }],
    ['tables/a/b/x.dbml', { kind: 'other' }, { kind: 'other' }],
    ['tables/gold/notes.txt', { kind: 'other' }, { kind: 'other' }],
    // `tables` is no DBML layer (reserved: tables/tables/S/x.dbml would look like the 1.9 tree).
    ['tables/tables/gold/x.dbml', { kind: 'other' }, { kind: 'other' }],
    ['tables/diagrams/x.dbml', LEGACY_TABLE, LEGACY_TABLE],
    // JSON diagrams in layer folders (unchanged; `diagrams` and `relationships` are layers like any other)
    ['gold/sales.json', { kind: 'diagram', storage: 'json', layer: 'gold', name: 'sales' }, { kind: 'diagram', storage: 'json', layer: 'gold', name: 'sales' }],
    ['gold/_x.json', { kind: 'diagram', storage: 'json', layer: 'gold', name: '_x' }, { kind: 'diagram', storage: 'json', layer: 'gold', name: '_x' }],
    ['diagrams/x.json', { kind: 'diagram', storage: 'json', layer: 'diagrams', name: 'x' }, { kind: 'diagram', storage: 'json', layer: 'diagrams', name: 'x' }],
    ['relationships/x.json', { kind: 'diagram', storage: 'json', layer: 'relationships', name: 'x' }, { kind: 'diagram', storage: 'json', layer: 'relationships', name: 'x' }],
    ['SAP FI/sales.json', { kind: 'diagram', storage: 'json', layer: 'SAP FI', name: 'sales' }, { kind: 'diagram', storage: 'json', layer: 'SAP FI', name: 'sales' }],
    ['gold/sales.yml', { kind: 'other' }, { kind: 'other' }],
    ['gold/.sales.json', { kind: 'other' }, { kind: 'other' }],
    ['.git/sales.json', { kind: 'other' }, { kind: 'other' }],
    ['logical/sales.json', { kind: 'other' }, { kind: 'other' }],
    ['gold/diagrams/sales.json', { kind: 'other' }, { kind: 'other' }],
    // The 1.9 pre-release's diagrams and layout files (§1.8)
    ['gold/sales.dbml', LEGACY_DIAGRAM, LEGACY_DIAGRAM],
    ['gold/_x.dbml', LEGACY_DIAGRAM, LEGACY_DIAGRAM],
    ['gold/_relationships.dbml', LEGACY_DIAGRAM, LEGACY_DIAGRAM],
    ['gold/_RELATIONSHIPS.dbml', LEGACY_DIAGRAM, LEGACY_DIAGRAM],
    ['SAP FI/sales.dbml', LEGACY_DIAGRAM, LEGACY_DIAGRAM],
    ['physical/sales.dbml', LEGACY_DIAGRAM, LEGACY_DIAGRAM],
    ['gold/sales.dbdiagram', LEGACY_LAYOUT, LEGACY_LAYOUT],
    ['gold/_relationships.dbdiagram', LEGACY_LAYOUT, LEGACY_LAYOUT],
    ['gold/diagrams/sales.dbdiagram', LEGACY_LAYOUT, LEGACY_LAYOUT],
    ['.git/sales.dbml', { kind: 'other' }, { kind: 'other' }],
    ['gold/sub/sales.dbml', { kind: 'other' }, { kind: 'other' }],
    // The layer-first DBML tree (§1.1)
    ['gold/diagrams/sales.dbml', { kind: 'diagram', storage: 'dbml', layer: 'gold', name: 'sales' }, { kind: 'diagram', storage: 'dbml', layer: 'gold', name: 'sales' }],
    ['gold/diagrams/_x.dbml', { kind: 'diagram', storage: 'dbml', layer: 'gold', name: '_x' }, { kind: 'diagram', storage: 'dbml', layer: 'gold', name: '_x' }],
    ['gold-old/diagrams/x.dbml', { kind: 'diagram', storage: 'dbml', layer: 'gold-old', name: 'x' }, { kind: 'diagram', storage: 'dbml', layer: 'gold-old', name: 'x' }],
    ['diagrams/diagrams/x.dbml', { kind: 'diagram', storage: 'dbml', layer: 'diagrams', name: 'x' }, { kind: 'diagram', storage: 'dbml', layer: 'diagrams', name: 'x' }],
    ['gold/tables/sales/fct.dbml', { kind: 'table', storage: 'dbml', layer: 'gold', folder: 'sales', schema: 'sales', name: 'fct' }, { kind: 'table', storage: 'dbml', layer: 'gold', folder: 'sales', schema: 'sales', name: 'fct' }],
    ['gold/tables/SAP FI/afih.dbml', { kind: 'table', storage: 'dbml', layer: 'gold', folder: 'SAP FI', schema: 'SAP FI', name: 'afih' }, { kind: 'table', storage: 'dbml', layer: 'gold', folder: 'SAP FI', schema: 'SAP FI', name: 'afih' }],
    ['gold/tables/relationships/x.dbml', { kind: 'table', storage: 'dbml', layer: 'gold', folder: 'relationships', schema: 'relationships', name: 'x' }, { kind: 'table', storage: 'dbml', layer: 'gold', folder: 'relationships', schema: 'relationships', name: 'x' }],
    ['gold/tables/sales/_relationships.dbml', { kind: 'table', storage: 'dbml', layer: 'gold', folder: 'sales', schema: 'sales', name: '_relationships' }, { kind: 'table', storage: 'dbml', layer: 'gold', folder: 'sales', schema: 'sales', name: '_relationships' }],
    ['gold/relationships/gold.dbml', { kind: 'relationships', storage: 'dbml', layer: 'gold', name: 'gold' }, { kind: 'relationships', storage: 'dbml', layer: 'gold', name: 'gold' }],
    ['relationships/relationships/relationships.dbml', { kind: 'relationships', storage: 'dbml', layer: 'relationships', name: 'relationships' }, { kind: 'relationships', storage: 'dbml', layer: 'relationships', name: 'relationships' }],
    ['gold/relationships/sub/x.dbml', { kind: 'other' }, { kind: 'other' }],
    ['gold/tables/x.dbml', { kind: 'other' }, { kind: 'other' }],
    ['gold/tables/.hidden/x.dbml', { kind: 'other' }, { kind: 'other' }],
    ['gold/tables/a/b/x.dbml', { kind: 'other' }, { kind: 'other' }],
    ['gold/tables/sales/fct.yml', { kind: 'other' }, { kind: 'other' }],
    ['gold/diagrams/sales.DBML', { kind: 'other' }, { kind: 'other' }],
    ['gold/diagrams/.sales.dbml', { kind: 'other' }, { kind: 'other' }],
    ['gold/diagrams/sub/sales.dbml', { kind: 'other' }, { kind: 'other' }],
    // The fixed folder names are compared exactly, and a layer folder is a layer id (§1.1).
    ['gold/Diagrams/sales.dbml', { kind: 'other' }, { kind: 'other' }],
    ['gold/Tables/sales/fct.dbml', { kind: 'other' }, { kind: 'other' }],
    ['Gold/diagrams/sales.dbml', { kind: 'other' }, { kind: 'other' }],
    ['sales area/diagrams/sales.dbml', { kind: 'other' }, { kind: 'other' }],
    ['gold.old/diagrams/sales.dbml', { kind: 'other' }, { kind: 'other' }],
    ['1gold/diagrams/sales.dbml', { kind: 'other' }, { kind: 'other' }],
    ['logical/diagrams/sales.dbml', { kind: 'other' }, { kind: 'other' }],
    ['physical/tables/s/x.dbml', { kind: 'other' }, { kind: 'other' }],
    ['logical-models/relationships/x.dbml', { kind: 'other' }, { kind: 'other' }],
    ['.git/diagrams/sales.dbml', { kind: 'other' }, { kind: 'other' }],
    // paths that leave the semantic dir, or are not relative posix paths
    ['../gold/sales.json', { kind: 'other' }, { kind: 'other' }],
    ['/abs/gold/sales.json', { kind: 'other' }, { kind: 'other' }],
    ['gold\\sales.json', { kind: 'other' }, { kind: 'other' }],
    ['../gold/diagrams/sales.dbml', { kind: 'other' }, { kind: 'other' }],
    ['', { kind: 'other' }, { kind: 'other' }],
  ];

  it.each(rows)('%s', (relPath, asLibrary, asLayer) => {
    expect(classifySemanticFile(relPath, LIBRARY)).toEqual(asLibrary);
    expect(classifySemanticFile(relPath, LAYER)).toEqual(asLayer);
  });

  it('every NON_SUBJECT_AREA_DIRS folder holds no diagram', () => {
    for (const dir of NON_SUBJECT_AREA_DIRS) {
      expect(classifySemanticFile(`${dir}/x.json`, LIBRARY).kind).not.toBe('diagram');
      expect(classifySemanticFile(`${dir}/x.dbml`, LIBRARY).kind).not.toBe('diagram');
      expect(classifySemanticFile(`${dir}/diagrams/x.dbml`, LIBRARY).kind).not.toBe('diagram');
    }
  });

  it('a .dbml is classified by its path alone: the first line is ignored (2.0-switch: S5 removes the option)', () => {
    expect(DBML_RICH_EXPORT_HEADER.startsWith(ERD_STUDIO_DBML_HEADER_PREFIX)).toBe(true);
    expect(classifySemanticFile('gold/diagrams/sales.dbml', { ...LIBRARY, firstLine: DBML_RICH_EXPORT_HEADER })).toEqual({
      kind: 'diagram', storage: 'dbml', layer: 'gold', name: 'sales',
    });
    expect(classifySemanticFile('gold/sales.dbml', { ...LIBRARY, firstLine: 'Project sales {' })).toEqual(LEGACY_DIAGRAM);
  });

  it('normalises ./ and inner .. before classifying', () => {
    expect(classifySemanticFile('./gold/diagrams/sales.dbml', LIBRARY).kind).toBe('diagram');
    expect(classifySemanticFile('tables/../gold/diagrams/sales.dbml', LIBRARY).kind).toBe('diagram');
    expect(classifySemanticFile('gold/diagrams/../tables/s/x.dbml', LIBRARY).kind).toBe('table');
  });
});

describe('dbmlNotADiagramMessage (§1.8)', () => {
  it('names a 1.9 shape, a table or relationships file, or where diagrams live', () => {
    expect(dbmlNotADiagramMessage('gold/sales.dbml')).toBe(legacyDbmlFileMessage('gold/sales.dbml'));
    expect(dbmlNotADiagramMessage('tables/gold/fct.dbml')).toBe(legacyDbmlFileMessage('tables/gold/fct.dbml'));
    // The 1.9 message names the file relative to the semantic dir (§1.8: `legacyDbmlFileMessage(rel)`).
    expect(dbmlNotADiagramMessage('/p/.erd-studio/gold/sales.dbml')).toBe(legacyDbmlFileMessage('gold/sales.dbml'));
    expect(dbmlNotADiagramMessage('.erd-studio/gold/sales.dbml')).toBe(legacyDbmlFileMessage('gold/sales.dbml'));
    expect(dbmlNotADiagramMessage('C:\\p\\.erd-studio\\tables\\gold\\fct.dbml')).toBe(legacyDbmlFileMessage('tables/gold/fct.dbml'));
    expect(dbmlNotADiagramMessage('gold/tables/sales/fct.dbml'))
      .toBe('gold/tables/sales/fct.dbml is a DBML table or relationships file, not a diagram. Open a diagram in gold/diagrams/.');
    expect(dbmlNotADiagramMessage('C:\\p\\x\\silver\\relationships\\silver.dbml'))
      .toBe('C:\\p\\x\\silver\\relationships\\silver.dbml is a DBML table or relationships file, not a diagram. Open a diagram in silver/diagrams/.');
    expect(dbmlNotADiagramMessage('gold/Diagrams/sales.dbml'))
      .toBe('gold/Diagrams/sales.dbml is not a DBML diagram. ERD Studio diagrams live in <layer>/diagrams/<name>.dbml (the folder names are lower-case).');
    // An absolute path with no semantic dir in it is never called a 1.9 file by its last two segments.
    expect(dbmlNotADiagramMessage('/somewhere/gold/sales.dbml')).toMatch(/is not a DBML diagram/);
    // A table or relationships file is known by its last segments behind any semantic dir (`model/`),
    // and behind an `erd-studio` folder that is not the semantic dir.
    for (const p of ['model/gold/tables/s/x.dbml', '/home/u/erd-studio/model/gold/tables/s/x.dbml', 'model/silver/relationships/silver.dbml']) {
      expect(dbmlNotADiagramMessage(p)).toContain('is a DBML table or relationships file, not a diagram');
    }
  });
});

describe('tableFileCandidates', () => {
  it('probes logical-models first, then tables/, each top level first: the YAML probe the core loader has always made', () => {
    expect(tableFileCandidates('/p/.erd-studio/', 'fct', ['silver', 'gold', 'gold'])).toEqual([
      '/p/.erd-studio/logical-models/fct.yml',
      '/p/.erd-studio/logical-models/gold/fct.yml',
      '/p/.erd-studio/logical-models/silver/fct.yml',
      '/p/.erd-studio/tables/fct.yml',
      '/p/.erd-studio/tables/gold/fct.yml',
      '/p/.erd-studio/tables/silver/fct.yml',
    ]);
    const folders = ['silver', 'gold'];
    const legacy = ['logical-models', 'tables'].flatMap((dir) => ['', 'gold/', 'silver/'].map((sub) => `${dir}/${sub}fct.yml`));
    expect(tableFileCandidates('', 'fct', folders)).toEqual(legacy);
  });

  it('sorts folders with localeCompare and de-duplicates them', () => {
    const list = tableFileCandidates('', 'x', ['SAP FI', 'Finance', 'finance', 'Finance']);
    expect(list.slice(0, 4)).toEqual([
      'logical-models/x.yml',
      ...['Finance', 'finance', 'SAP FI'].sort((a, b) => a.localeCompare(b)).map((f) => `logical-models/${f}/x.yml`),
    ]);
  });

  it('does not change the folders it is given', () => {
    const folders = ['b', 'a'];
    tableFileCandidates('', 'x', folders);
    expect(folders).toEqual(['b', 'a']);
  });
});

describe('paths that belong together', () => {
  it('subjectAreaStorageOf is by extension', () => {
    expect(subjectAreaStorageOf('gold/a.json')).toBe('json');
    expect(subjectAreaStorageOf('gold/a.dbml')).toBe('dbml');
    expect(subjectAreaStorageOf('gold/a.dbdiagram')).toBeUndefined();
    expect(subjectAreaStorageOf('gold/a.yml')).toBeUndefined();
  });

  it('isLibraryFolderName is the listFoldersOf rule', () => {
    for (const ok of ['gold', 'Finance', 'SAP FI', '_x', 'a-b']) expect(isLibraryFolderName(ok)).toBe(true);
    for (const bad of ['', '.git', '.', '..', 'a/b', 'a\\b', 'a\u0000b']) expect(isLibraryFolderName(bad)).toBe(false);
  });
});

describe('the reserved name', () => {
  it('is _relationships in any case, and nothing else', () => {
    expect(isReservedTableName('_relationships')).toBe(true);
    expect(isReservedTableName('_Relationships')).toBe(true);
    expect(isReservedTableName('_RELATIONSHIPS')).toBe(true);
    // As sameName compares: surrounding white space is ignored.
    for (const padded of [' _relationships ', '_relationships ', ' _Relationships', '\t_relationships\n']) {
      expect(isReservedTableName(padded)).toBe(true);
    }
    for (const name of ['relationships', '_relationships_x', '_x', '__relationships', '_relationship']) {
      expect(isReservedTableName(name)).toBe(false);
    }
  });
});

describe('posix helpers', () => {
  it('normalisePosix', () => {
    expect(normalisePosix('a/./b//c')).toBe('a/b/c');
    expect(normalisePosix('a/b/../c')).toBe('a/c');
    expect(normalisePosix('../a/../../b')).toBe('../../b');
    expect(normalisePosix('/a/../../b')).toBe('/b');
    expect(normalisePosix('a/..')).toBe('.');
    expect(normalisePosix('')).toBe('.');
    expect(normalisePosix('/')).toBe('/');
  });

  it('joinPosix, dirnamePosix and resolvePosix', () => {
    expect(joinPosix('gold', '..', 'tables', 'gold', 'x.dbml')).toBe('tables/gold/x.dbml');
    expect(joinPosix('', 'a')).toBe('a');
    expect(dirnamePosix('tables/gold/x.dbml')).toBe('tables/gold');
    expect(dirnamePosix('x.dbml')).toBe('.');
    expect(dirnamePosix('/x.dbml')).toBe('/');
    expect(resolvePosix('gold', '../tables/gold/x.dbml')).toBe('tables/gold/x.dbml');
    expect(resolvePosix('gold', './x.dbml')).toBe('gold/x.dbml');
    expect(resolvePosix('gold', '/abs/x.dbml')).toBe('/abs/x.dbml');
  });

  it('relativePosix gives the path from a directory, and resolvePosix goes back', () => {
    expect(relativePosix('gold', 'tables/gold/x.dbml')).toBe('../tables/gold/x.dbml');
    expect(relativePosix('tables/gold', 'tables/dim.dbml')).toBe('../dim.dbml');
    expect(relativePosix('tables/gold', 'tables/gold/x.dbml')).toBe('x.dbml');
    expect(relativePosix('a/b', 'a/b')).toBe('.');
    expect(relativePosix('.', 'gold/x.dbml')).toBe('gold/x.dbml');
    for (const [from, to] of [['gold', 'tables/gold/x.dbml'], ['tables/SAP FI', 'tables/x.dbml'], ['a/b/c', 'd/e']]) {
      expect(resolvePosix(from, relativePosix(from, to))).toBe(to);
    }
  });

  it('isInsidePosix confines a path after normalising, never by prefix alone', () => {
    expect(isInsidePosix('tables', 'tables/gold/x.dbml')).toBe(true);
    expect(isInsidePosix('tables', 'tables')).toBe(true);
    expect(isInsidePosix('tables', 'tables-old/x.dbml')).toBe(false);
    expect(isInsidePosix('tables', 'tables/../gold/x.dbml')).toBe(false);
    expect(isInsidePosix('/p/.erd-studio', '/p/.erd-studio/gold/x.dbml')).toBe(true);
    expect(isInsidePosix('/p/.erd-studio', '/p/other/x.dbml')).toBe(false);
    expect(isInsidePosix('.', 'gold/x.dbml')).toBe(true);
    expect(isInsidePosix('.', '../x.dbml')).toBe(false);
    expect(isInsidePosix('.', '/x.dbml')).toBe(false);
  });
});
