/**
 * storage.ts — the single file classifier, the table lookup order, the paths
 * that belong together and the posix helpers (native DBML storage, §3.4 and
 * §3.5 of docs/plans/native-dbml-storage.md).
 */

import { describe, expect, it } from 'vitest';

import {
  classifySemanticFile,
  dirnamePosix,
  isInsidePosix,
  isLibraryFolderName,
  isReservedTableName,
  joinPosix,
  normalisePosix,
  relationshipsFilePathOf,
  relativePosix,
  resolvePosix,
  subjectAreaStorageOf,
  tableFileCandidates,
  type SemanticFileClass,
} from '../../src/storage';
import { NON_SUBJECT_AREA_DIRS } from '../../src/domain';
import { DBML_RELATIONSHIPS_FILE_NAME, ERD_STUDIO_DBML_HEADER_PREFIX } from '../../src/dbmlRichProperties';
import { DBML_RICH_EXPORT_HEADER } from '../../src/exportDbmlRich';

const LIBRARY = { tablesDirIsLayer: false };
const LAYER = { tablesDirIsLayer: true };

describe('classifySemanticFile', () => {
  // [path, expected while tables/ is the library, expected while tables/ is a layer]
  const rows: Array<[string, SemanticFileClass, SemanticFileClass]> = [
    // depth 1
    ['layers.json', { kind: 'layers' }, { kind: 'layers' }],
    ['readme.md', { kind: 'other' }, { kind: 'other' }],
    ['sales.json', { kind: 'other' }, { kind: 'other' }],
    ['sales.dbml', { kind: 'other' }, { kind: 'other' }],
    // templates
    ['templates/dim.json', { kind: 'template' }, { kind: 'template' }],
    ['templates/a/b.json', { kind: 'template' }, { kind: 'template' }],
    // logical-models
    ['logical-models/dim_date.yml', { kind: 'table', storage: 'yaml', name: 'dim_date' }, { kind: 'table', storage: 'yaml', name: 'dim_date' }],
    ['logical-models/gold/fct.yml', { kind: 'table', storage: 'yaml', folder: 'gold', name: 'fct' }, { kind: 'table', storage: 'yaml', folder: 'gold', name: 'fct' }],
    ['logical-models/Finance/fct.yml', { kind: 'table', storage: 'yaml', folder: 'Finance', name: 'fct' }, { kind: 'table', storage: 'yaml', folder: 'Finance', name: 'fct' }],
    ['logical-models/SAP FI/fct.yml', { kind: 'table', storage: 'yaml', folder: 'SAP FI', name: 'fct' }, { kind: 'table', storage: 'yaml', folder: 'SAP FI', name: 'fct' }],
    ['logical-models/.git/fct.yml', { kind: 'other' }, { kind: 'other' }],
    ['logical-models/a/b/fct.yml', { kind: 'other' }, { kind: 'other' }],
    ['logical-models/fct.dbml', { kind: 'other' }, { kind: 'other' }],
    ['logical-models/fct.json', { kind: 'other' }, { kind: 'other' }],
    // tables/: the library
    ['tables/dim_date.dbml', { kind: 'table', storage: 'dbml', name: 'dim_date' }, { kind: 'other' }],
    ['tables/gold/fct_order.dbml', { kind: 'table', storage: 'dbml', folder: 'gold', name: 'fct_order' }, { kind: 'other' }],
    ['tables/Finance/x.dbml', { kind: 'table', storage: 'dbml', folder: 'Finance', name: 'x' }, { kind: 'other' }],
    ['tables/SAP FI/x.dbml', { kind: 'table', storage: 'dbml', folder: 'SAP FI', name: 'x' }, { kind: 'other' }],
    ['tables/_relationships.dbml', { kind: 'relationships', storage: 'dbml' }, { kind: 'other' }],
    ['tables/_Relationships.dbml', { kind: 'relationships', storage: 'dbml' }, { kind: 'other' }],
    ['tables/gold/_relationships.dbml', { kind: 'relationships', storage: 'dbml', folder: 'gold' }, { kind: 'other' }],
    ['tables/_x.dbml', { kind: 'table', storage: 'dbml', name: '_x' }, { kind: 'other' }],
    ['tables/_relationships.yml', { kind: 'table', storage: 'yaml', name: '_relationships' }, { kind: 'other' }],
    ['tables/dim.yml', { kind: 'table', storage: 'yaml', name: 'dim' }, { kind: 'other' }],
    ['tables/gold/dim.yml', { kind: 'table', storage: 'yaml', folder: 'gold', name: 'dim' }, { kind: 'other' }],
    ['tables/sales.json', { kind: 'other' }, { kind: 'diagram', storage: 'json', layer: 'tables', name: 'sales' }],
    ['tables/sales.dbdiagram', { kind: 'other' }, { kind: 'other' }],
    ['tables/.hidden/x.dbml', { kind: 'other' }, { kind: 'other' }],
    ['tables/a/b/x.dbml', { kind: 'other' }, { kind: 'other' }],
    ['tables/gold/notes.txt', { kind: 'other' }, { kind: 'other' }],
    // layer folders
    ['gold/sales.json', { kind: 'diagram', storage: 'json', layer: 'gold', name: 'sales' }, { kind: 'diagram', storage: 'json', layer: 'gold', name: 'sales' }],
    ['gold/sales.dbml', { kind: 'diagram', storage: 'dbml', layer: 'gold', name: 'sales' }, { kind: 'diagram', storage: 'dbml', layer: 'gold', name: 'sales' }],
    ['gold/_x.dbml', { kind: 'diagram', storage: 'dbml', layer: 'gold', name: '_x' }, { kind: 'diagram', storage: 'dbml', layer: 'gold', name: '_x' }],
    ['gold/_x.json', { kind: 'diagram', storage: 'json', layer: 'gold', name: '_x' }, { kind: 'diagram', storage: 'json', layer: 'gold', name: '_x' }],
    ['gold/_relationships.dbml', { kind: 'other' }, { kind: 'other' }],
    ['gold/_RELATIONSHIPS.dbml', { kind: 'other' }, { kind: 'other' }],
    // Positions live in the diagram's erd_layout: a .dbdiagram is no file of the project.
    ['gold/sales.dbdiagram', { kind: 'other' }, { kind: 'other' }],
    ['gold/_relationships.dbdiagram', { kind: 'other' }, { kind: 'other' }],
    ['SAP FI/sales.dbml', { kind: 'diagram', storage: 'dbml', layer: 'SAP FI', name: 'sales' }, { kind: 'diagram', storage: 'dbml', layer: 'SAP FI', name: 'sales' }],
    ['gold/sales.yml', { kind: 'other' }, { kind: 'other' }],
    ['gold/.sales.json', { kind: 'other' }, { kind: 'other' }],
    ['.git/sales.json', { kind: 'other' }, { kind: 'other' }],
    ['gold/sub/sales.dbml', { kind: 'other' }, { kind: 'other' }],
    ['logical/sales.json', { kind: 'other' }, { kind: 'other' }],
    ['physical/sales.dbml', { kind: 'other' }, { kind: 'other' }],
    // paths that leave the semantic dir, or are not relative posix paths
    ['../gold/sales.json', { kind: 'other' }, { kind: 'other' }],
    ['/abs/gold/sales.json', { kind: 'other' }, { kind: 'other' }],
    ['gold\\sales.json', { kind: 'other' }, { kind: 'other' }],
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
    }
  });

  it('a .dbml in a layer whose first line is the export header is an export, not a diagram', () => {
    expect(DBML_RICH_EXPORT_HEADER.startsWith(ERD_STUDIO_DBML_HEADER_PREFIX)).toBe(true);
    expect(classifySemanticFile('gold/sales.dbml', { ...LIBRARY, firstLine: DBML_RICH_EXPORT_HEADER })).toEqual({ kind: 'other' });
    expect(classifySemanticFile('gold/sales.dbml', { ...LIBRARY, firstLine: '// erd-studio dbml-export v1' })).toEqual({ kind: 'other' });
    expect(classifySemanticFile('gold/sales.dbml', { ...LIBRARY, firstLine: `\uFEFF${DBML_RICH_EXPORT_HEADER}` })).toEqual({ kind: 'other' });
    expect(classifySemanticFile('gold/sales.dbml', { ...LIBRARY, firstLine: 'Project sales {' })).toEqual({
      kind: 'diagram', storage: 'dbml', layer: 'gold', name: 'sales',
    });
    expect(classifySemanticFile('gold/sales.dbml', { ...LIBRARY, firstLine: '' }).kind).toBe('diagram');
    // A JSON diagram and a table file are classified by path; the line does not matter.
    expect(classifySemanticFile('gold/sales.json', { ...LIBRARY, firstLine: DBML_RICH_EXPORT_HEADER }).kind).toBe('diagram');
    expect(classifySemanticFile('tables/x.dbml', { ...LIBRARY, firstLine: DBML_RICH_EXPORT_HEADER }).kind).toBe('table');
  });

  it('normalises ./ and inner .. before classifying', () => {
    expect(classifySemanticFile('./gold/sales.dbml', LIBRARY).kind).toBe('diagram');
    expect(classifySemanticFile('tables/../gold/sales.dbml', LIBRARY).kind).toBe('diagram');
  });
});

describe('tableFileCandidates', () => {
  it('probes logical-models first, then tables/ with .dbml before .yml in each directory', () => {
    expect(tableFileCandidates('/p/.erd-studio/', 'fct', ['silver', 'gold', 'gold'], { dbml: true })).toEqual([
      '/p/.erd-studio/logical-models/fct.yml',
      '/p/.erd-studio/logical-models/gold/fct.yml',
      '/p/.erd-studio/logical-models/silver/fct.yml',
      '/p/.erd-studio/tables/fct.dbml',
      '/p/.erd-studio/tables/fct.yml',
      '/p/.erd-studio/tables/gold/fct.dbml',
      '/p/.erd-studio/tables/gold/fct.yml',
      '/p/.erd-studio/tables/silver/fct.dbml',
      '/p/.erd-studio/tables/silver/fct.yml',
    ]);
  });

  it('without dbml, is the YAML probe the core loader has always made', () => {
    const folders = ['silver', 'gold'];
    const legacy = ['logical-models', 'tables'].flatMap((dir) => ['', 'gold/', 'silver/'].map((sub) => `${dir}/${sub}fct.yml`));
    expect(tableFileCandidates('', 'fct', folders, { dbml: false })).toEqual(legacy);
  });

  it('sorts folders with localeCompare and de-duplicates them', () => {
    const list = tableFileCandidates('', 'x', ['SAP FI', 'Finance', 'finance', 'Finance'], { dbml: false });
    expect(list.slice(0, 4)).toEqual([
      'logical-models/x.yml',
      ...['Finance', 'finance', 'SAP FI'].sort((a, b) => a.localeCompare(b)).map((f) => `logical-models/${f}/x.yml`),
    ]);
  });

  it('does not change the folders it is given', () => {
    const folders = ['b', 'a'];
    tableFileCandidates('', 'x', folders, { dbml: true });
    expect(folders).toEqual(['b', 'a']);
  });
});

describe('paths that belong together', () => {
  it('relationshipsFilePathOf is the table folder\'s _relationships.dbml', () => {
    expect(relationshipsFilePathOf('tables/gold/fct.dbml')).toBe(`tables/gold/${DBML_RELATIONSHIPS_FILE_NAME}`);
    expect(relationshipsFilePathOf('/p/.erd-studio/tables/dim.dbml')).toBe('/p/.erd-studio/tables/_relationships.dbml');
    expect(relationshipsFilePathOf('C:\\p\\.erd-studio\\tables\\gold\\fct.dbml')).toBe('C:\\p\\.erd-studio\\tables\\gold\\_relationships.dbml');
    expect(relationshipsFilePathOf('fct.dbml')).toBe('_relationships.dbml');
  });

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
