/**
 * Reading the v6 file naming (#162 part 3, #181): `tables/`, `logical.tables`,
 * `subjectArea`, `fromTable` / `toTable`, `tableRole`, `linkedTable`. One
 * detector, one normaliser right after validation, model yml normalised by
 * key, and the same DisplaySubjectArea as the v5 file it renames.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  CURRENT_SCHEMA_VERSION,
  LIBRARY_SCHEMA_VERSION,
  TABLE_NAMING_SCHEMA_VERSION,
  WRITTEN_SCHEMA_VERSION,
  describeUnsupportedSubjectAreaFormat,
  detectProjectNaming,
  detectSubjectAreaFormat,
  writesTableNaming,
  getRawSubjectAreaTableNames,
  mixesTableNaming,
  usesTableLibrary,
} from '../../src/types/semantic';
import { SubjectAreaValidationError, normaliseSubjectAreaDocument, validateSubjectAreaDocument } from '../../src/domain';
import { parseTableText } from '../../src/logicalModel';
import { loadDisplaySubjectArea } from '../../src/loadDisplayDomain';
import { DIAGRAM_EXPORT_FORMATS, exportDiagram } from '../../src/exportDiagram';
import { goldenFileName } from '../exportParsers';

const FIXTURES = path.resolve(__dirname, '../fixtures');
const GOLDEN_DIR = path.join(FIXTURES, 'golden');
const FILE = 'silver/sales.json';

/** A readFile over one fixture project: relative paths, ENOENT as null. */
function fsReadFile(root: string) {
  return async (p: string): Promise<string | null> => {
    try {
      return fs.readFileSync(path.join(root, p), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
}

describe('schema versions', () => {
  it('reads up to v6 and still writes v5', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(6);
    expect(TABLE_NAMING_SCHEMA_VERSION).toBe(6);
    expect(LIBRARY_SCHEMA_VERSION).toBe(5);
    // Writers emit v5 keys; stamping 6 on them would make a half-v6 file.
    expect(WRITTEN_SCHEMA_VERSION).toBe(5);
  });
});

describe('detectSubjectAreaFormat with the v6 naming', () => {
  it.each([
    ['v6 table names', { schemaVersion: 6, subjectArea: 's', logical: { tables: ['a', 'b'], relationships: [] } }, 'v6'],
    ['an empty v6 list', { schemaVersion: 6, logical: { tables: [] } }, 'v6'],
    ['v6 without a logical section', { schemaVersion: 6 }, 'v6'],
    ['an inline object in logical.tables', { schemaVersion: 6, logical: { tables: [{ name: 'a' }] } }, 'hybrid'],
    ['v6 keys under schemaVersion 5 (an old reader draws it empty)', { schemaVersion: 5, logical: { tables: ['a'] } }, 'hybrid'],
    ['subjectArea under schemaVersion 5', { schemaVersion: 5, subjectArea: 's', logical: { models: ['a'] } }, 'hybrid'],
    ['v5 keys under schemaVersion 6', { schemaVersion: 6, domain: 's', logical: { models: ['a'] } }, 'hybrid'],
    ['both lists', { schemaVersion: 6, logical: { tables: ['a'], models: ['a'] } }, 'hybrid'],
    ['both names', { schemaVersion: 6, domain: 's', subjectArea: 's', logical: { tables: [] } }, 'hybrid'],
  ])('%s', (_label, doc, format) => {
    expect(detectSubjectAreaFormat(doc)).toBe(format);
  });

  it('keeps every v5 and v4 answer it gave before v6 (the v5 threshold is fixed at 5)', () => {
    expect(detectSubjectAreaFormat({ schemaVersion: 5, logical: { models: [] } })).toBe('v5');
    expect(detectSubjectAreaFormat({ schemaVersion: 5, logical: { models: ['a'] } })).toBe('v5');
    expect(detectSubjectAreaFormat({ schemaVersion: 5, logical: { models: [{ name: 'a' }] } })).toBe('hybrid');
    expect(detectSubjectAreaFormat({ schemaVersion: 4, logical: { models: [{ name: 'a' }] } })).toBe('v4');
    expect(detectSubjectAreaFormat({ schemaVersion: 4, logical: { models: [] } })).toBe('v4');
    expect(detectSubjectAreaFormat({ schemaVersion: 3, logical: { models: [] } })).toBe('legacy');
  });

  it('v5 and v6 both resolve table names through the library', () => {
    expect(usesTableLibrary('v5')).toBe(true);
    expect(usesTableLibrary('v6')).toBe(true);
    expect(usesTableLibrary('v4')).toBe(false);
  });

  it('names a v5 / v6 mix rather than sending it to the inline-table migration', () => {
    const mix = { schemaVersion: 5, logical: { tables: ['a'] } };
    expect(mixesTableNaming(mix)).toBe(true);
    expect(mixesTableNaming({ schemaVersion: 5, logical: { models: [{ name: 'a' }] } })).toBe(false);
    // v5 names under 6 too: its fix is the number, not the inline-table migration.
    expect(mixesTableNaming({ schemaVersion: 6, domain: 'x', logical: { models: ['a'] } })).toBe(true);
    const message = describeUnsupportedSubjectAreaFormat('hybrid', FILE, mix)!;
    expect(message).toContain('uses the v6 names');
    expect(message).toContain('Set "schemaVersion" to 6');
    expect(message).not.toContain('Migrate');
    expect(() => validateSubjectAreaDocument(mix, FILE)).toThrow(SubjectAreaValidationError);
  });

  it('reads table names from logical.tables', () => {
    expect(getRawSubjectAreaTableNames({ schemaVersion: 6, logical: { tables: ['a', 'b'] } })).toEqual(['a', 'b']);
  });
});

describe('normaliseSubjectAreaDocument', () => {
  const v5 = {
    schemaVersion: 5,
    domain: 'sales',
    layer: 'gold',
    logical: {
      models: ['fct', 'dim'],
      relationships: [{ fromModel: 'fct', fromColumn: 'dim_id', toModel: 'dim', toColumn: 'id', cardinality: 'many-to-one', role: 'r' }],
    },
    viewConfig: { annotations: [{ id: 'n1', text: 't', x: 1, y: 2, linkedModel: 'fct' }], positions: { fct: { x: 0, y: 0 } } },
    unknownKey: { kept: true },
  };
  const v6 = {
    schemaVersion: 6,
    subjectArea: 'sales',
    layer: 'gold',
    logical: {
      tables: ['fct', 'dim'],
      relationships: [{ fromTable: 'fct', fromColumn: 'dim_id', toTable: 'dim', toColumn: 'id', cardinality: 'many-to-one', role: 'r' }],
    },
    viewConfig: { annotations: [{ id: 'n1', text: 't', x: 1, y: 2, linkedTable: 'fct' }], positions: { fct: { x: 0, y: 0 } } },
    unknownKey: { kept: true },
  };

  it('gives a v6 file the in-memory (v5) keys, keeping its schemaVersion and unknown keys', () => {
    const { obj, format } = validateSubjectAreaDocument(v6, FILE);
    expect(format).toBe('v6');
    expect(obj).toEqual({ ...v5, schemaVersion: 6 });
  });

  it('normalises the stage-level viewConfig fallback too', () => {
    const doc = { schemaVersion: 6, logical: { tables: [], viewConfig: { annotations: [{ id: 'a', x: 0, y: 0, linkedTable: 't' }] } } };
    const out = normaliseSubjectAreaDocument(doc) as { logical: { models: unknown; viewConfig: { annotations: Array<Record<string, unknown>> } } };
    expect(out.logical.models).toEqual([]);
    expect(out.logical.viewConfig.annotations[0]).toEqual({ id: 'a', x: 0, y: 0, linkedModel: 't' });
  });

  it('does not change the document it is given', () => {
    const copy = JSON.parse(JSON.stringify(v6));
    normaliseSubjectAreaDocument(v6);
    expect(v6).toEqual(copy);
  });

  it('leaves a v5 file as it is', () => {
    expect(validateSubjectAreaDocument(v5, FILE).obj).toBe(v5);
  });
});

describe('a malformed v6 key never hides a valid v5 one', () => {
  it('in a table yml', () => {
    const yml = 'name: f\nmodelRole: transaction-fact\ntableRole:\nrelationships:\n  - fromColumn: a\n    toModel: d\n    toTable: {}\n    toColumn: id\n';
    const model = parseTableText(yml, 'f')!;
    expect(model.modelRole).toBe('transaction-fact');
    expect(model.relationships).toEqual([{ fromColumn: 'a', toModel: 'd', toColumn: 'id', cardinality: 'many-to-one' }]);
  });

  it('in a v6 relationship entry', () => {
    const { obj } = validateSubjectAreaDocument({
      schemaVersion: 6, logical: { tables: [], relationships: [{ fromTable: 1, fromModel: 'f', fromColumn: 'a', toTable: 'd', toColumn: 'id', cardinality: 'many-to-one' }] },
    }, FILE);
    expect((obj.logical as { relationships: unknown[] }).relationships).toEqual([
      { fromModel: 'f', fromColumn: 'a', toModel: 'd', toColumn: 'id', cardinality: 'many-to-one' },
    ]);
  });
});

describe('model yml in the v6 naming', () => {
  const v5Yml = [
    'name: fct_order',
    'modelRole: transaction-fact',
    'columns:',
    '  - name: customer_key',
    '    dataType: INT',
    'relationships:',
    '  - fromColumn: customer_key',
    '    toModel: dim_customer',
    '    toColumn: customer_key',
    '    cardinality: many-to-one',
    '',
  ].join('\n');
  const v6Yml = v5Yml.replace('modelRole:', 'tableRole:').replace('toModel:', 'toTable:');

  it('reads tableRole and toTable as modelRole and toModel', () => {
    expect(parseTableText(v6Yml, 'fct_order')).toEqual(parseTableText(v5Yml, 'fct_order'));
  });

  it('prefers the v6 key when a file writes both', () => {
    const both = `${v6Yml.replace('tableRole: transaction-fact', 'tableRole: factless-fact\nmodelRole: transaction-fact')}`;
    expect(parseTableText(both, 'fct_order')?.modelRole).toBe('factless-fact');
  });
});

describe('detectProjectNaming', () => {
  it.each([
    // A new project writes v6 (#182).
    [{ hasLogicalModelsDir: false, hasTablesLibrary: false, subjectAreaFormats: [] }, 'v6'],
    [{ hasLogicalModelsDir: true, hasTablesLibrary: false, subjectAreaFormats: ['v5', 'v4'] }, 'v5'],
    [{ hasLogicalModelsDir: false, hasTablesLibrary: true, subjectAreaFormats: ['v6'] }, 'v6'],
    [{ hasLogicalModelsDir: false, hasTablesLibrary: false, subjectAreaFormats: ['v6'] }, 'v6'],
    [{ hasLogicalModelsDir: true, hasTablesLibrary: true, subjectAreaFormats: [] }, 'mixed'],
    [{ hasLogicalModelsDir: false, hasTablesLibrary: true, subjectAreaFormats: ['v5', 'v6'] }, 'mixed'],
    // Files that cannot load say nothing either way.
    [{ hasLogicalModelsDir: false, hasTablesLibrary: true, subjectAreaFormats: ['hybrid', 'legacy'] }, 'v6'],
    [{ hasLogicalModelsDir: false, hasTablesLibrary: false, subjectAreaFormats: ['hybrid'] }, 'v6'],
    [{ hasLogicalModelsDir: true, hasTablesLibrary: false, subjectAreaFormats: ['hybrid'] }, 'v5'],
  ] as const)('%o is %s', (evidence, naming) => {
    expect(detectProjectNaming(evidence)).toBe(naming);
    expect(writesTableNaming(detectProjectNaming(evidence))).toBe(naming !== 'v5');
  });
});

describe('an older reader refuses a v6 file', () => {
  // Every released extension (schema v5) refuses `schemaVersion > 5` with
  // "Please update the extension", before reading anything else; a v6 file
  // that kept schemaVersion 5 is the one shape it would draw empty, and that
  // shape is refused here as hybrid.
  it.each([
    'naming-v6/showcase/.erd-studio/silver/showcase.json',
    'naming-v6/library-relationships/.erd-studio/gold/sales.json',
    'naming-mixed/library-relationships/.erd-studio/gold/sales.json',
  ])('%s declares a schemaVersion no v5 reader accepts', (file) => {
    const doc = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf-8'));
    expect(doc.schemaVersion).toBeGreaterThan(LIBRARY_SCHEMA_VERSION);
    expect(detectSubjectAreaFormat(doc)).toBe('v6');
    expect(() => validateSubjectAreaDocument({ ...doc, schemaVersion: LIBRARY_SCHEMA_VERSION }, FILE)).toThrow(SubjectAreaValidationError);
  });
});

describe('loadDisplaySubjectArea on the v6 and mixed fixtures', () => {
  describe.each([
    ['naming-v6/showcase', '.erd-studio/silver/showcase.json', 'showcase', 6],
    ['naming-v6/library-relationships', '.erd-studio/gold/sales.json', 'library-relationships', 6],
    ['naming-mixed/library-relationships', '.erd-studio/gold/sales.json', 'library-relationships', 6],
    ['naming-mixed/library-relationships', '.erd-studio/gold/sales_v5.json', 'library-relationships', 5],
  ] as const)('%s %s', (project, domainPath, golden, schemaVersion) => {
    const load = () => loadDisplaySubjectArea({ domainPath, readFile: fsReadFile(path.join(FIXTURES, project)), readOnly: false, warn: () => {} });

    it(`builds the ${golden} golden's DisplaySubjectArea`, async () => {
      const expected = { ...JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, `${golden}.host.json`), 'utf-8')).payload };
      delete expected.templates;
      delete expected.manifestModels;
      delete expected.existingModels;
      expect(JSON.parse(JSON.stringify(await load()))).toEqual({ ...expected, schemaVersion });
    });

    it.each(DIAGRAM_EXPORT_FORMATS)(`exports the ${golden} %s golden byte for byte`, async (format) => {
      const text = exportDiagram(await load(), format);
      expect(text).toBe(fs.readFileSync(path.join(GOLDEN_DIR, goldenFileName(golden, format)), 'utf-8'));
    });
  });
});
