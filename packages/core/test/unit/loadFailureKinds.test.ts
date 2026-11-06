/**
 * What core tells a host about a failed or degraded load without the
 * message (2.0, additive): `SubjectAreaFileError.dbmlErrorClass` /
 * `parserThrew`, `SubjectAreaValidationError.kind`, the reading's
 * `warningCodes`, and the code every `warn` call passes. Each at its site.
 */
import { describe, expect, it } from 'vitest';

import {
  LOADER_WARNING_CODES,
  SubjectAreaFileError,
  SubjectAreaValidationError,
  loadDisplaySubjectArea,
  validateSubjectAreaDocument,
  type LoaderWarningCode,
} from '../../src/index';
import { dbmlStorageReader, parseSubjectAreaDbml } from '../../src/dbml/index';
import type { DbmlParserModule } from '../../src/dbml/parserModule';

const DIAGRAM = '/p/.erd-studio/gold/diagrams/sales.dbml';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

describe('SubjectAreaFileError for a DBML diagram', () => {
  it('carries the class of the diagnostic that stopped the read', () => {
    const err = thrown(() => parseSubjectAreaDbml('Table x {\n  id int [pk\n}\n', DIAGRAM));
    expect(err).toBeInstanceOf(SubjectAreaFileError);
    expect((err as SubjectAreaFileError).reason).toBe('invalid-dbml');
    expect((err as SubjectAreaFileError).dbmlErrorClass).toBe('syntax');
    expect((err as SubjectAreaFileError).parserThrew).toBeUndefined();
  });

  it('says when the parser itself threw', () => {
    const exploding = new Proxy({}, { get: () => { throw new RangeError('parser bug'); } }) as unknown as DbmlParserModule;
    const err = thrown(() => parseSubjectAreaDbml("Project p {\n  erd_schema_version: '7'\n}\n", DIAGRAM, exploding));
    expect(err).toBeInstanceOf(SubjectAreaFileError);
    expect((err as SubjectAreaFileError).parserThrew).toBe(true);
    expect((err as SubjectAreaFileError).dbmlErrorClass).toBeUndefined();
  });

  it('carries neither for a conflict or a JSON file', () => {
    const conflict = thrown(() => parseSubjectAreaDbml('<<<<<<< HEAD\nProject a {\n}\n=======\nProject b {\n}\n>>>>>>> x\n', DIAGRAM)) as SubjectAreaFileError;
    expect(conflict.mergeConflict).toBe(true);
    expect(conflict.dbmlErrorClass).toBeUndefined();
    const json = new SubjectAreaFileError('invalid-json', '/p/a.json', 'x');
    expect(json.dbmlErrorClass).toBeUndefined();
    expect(json.parserThrew).toBeUndefined();
  });
});

describe('SubjectAreaValidationError.kind', () => {
  it('is newerSchema for a newer JSON or DBML schema version', () => {
    expect((thrown(() => validateSubjectAreaDocument({ schemaVersion: 99 }, '/p/x.json')) as SubjectAreaValidationError).kind).toBe('newerSchema');
    expect((thrown(() => parseSubjectAreaDbml("Project p {\n  erd_schema_version: '99'\n}\n", DIAGRAM)) as SubjectAreaValidationError).kind).toBe('newerSchema');
  });

  it('is legacyFormat for a legacy or hybrid document', () => {
    const legacy = thrown(() => validateSubjectAreaDocument({ schemaVersion: 3, domain: 'x', layer: 'silver', logical: { models: ['a'], relationships: [] } }, '/p/x.json'));
    expect((legacy as SubjectAreaValidationError).kind).toBe('legacyFormat');
  });

  it('is notADiagram for a .dbml that is not a diagram', async () => {
    expect((thrown(() => parseSubjectAreaDbml('Project p {\n}\n', '/p/.erd-studio/gold/tables/x.dbml')) as SubjectAreaValidationError).kind).toBe('notADiagram');
    const err = await loadDisplaySubjectArea({ domainPath: '.erd-studio/gold/tables/x.dbml', readFile: async () => null, dbml: dbmlStorageReader })
      .catch((e: unknown) => e);
    expect((err as SubjectAreaValidationError).kind).toBe('notADiagram');
  });

  it('has no kind for any other refusal, and keeps the plain Error name', () => {
    const err = thrown(() => validateSubjectAreaDocument({}, '/p/x.json')) as SubjectAreaValidationError;
    expect(err).toBeInstanceOf(SubjectAreaValidationError);
    expect(err.kind).toBeUndefined();
    expect(err.name).toBe('Error');
  });
});

describe('the reading’s warningCodes', () => {
  it('codes each warning index for index', () => {
    const reading = parseSubjectAreaDbml([
      'Table a {\n  id int [pk]\n}',
      'Enum e {\n  x\n}',
      "Project p {\n  erd_schema_version: '7'\n  erd_show_fk_edges: 'maybe'\n  erd_layout: '''\n    not a line\n  '''\n}",
      '',
    ].join('\n'), DIAGRAM);
    expect(reading.warningCodes).toHaveLength(reading.warnings.length);
    expect(reading.warningCodes).toEqual(expect.arrayContaining(['inlineElement', 'foreignDbml', 'layoutProblem', 'other']));
    expect(reading.warningCodes!.filter((c) => c === 'inlineElement')).toHaveLength(2);
    expect(reading.warningCodes![reading.warnings.findIndex((w) => w.includes('single-file DBML'))]).toBe('foreignDbml');
    expect(reading.warningCodes![reading.warnings.findIndex((w) => w.includes('erd_show_fk_edges'))]).toBe('other');
  });

  it('codes a use line that points elsewhere', () => {
    const reading = parseSubjectAreaDbml("use { table a } from '../../silver/diagrams/a.dbml'\nProject p {\n}\n", DIAGRAM);
    expect(reading.warningCodes).toHaveLength(reading.warnings.length);
    expect(reading.warningCodes).toContain('usePathMismatch');
  });

  it('is empty for a clean diagram', () => {
    const reading = parseSubjectAreaDbml("Project p {\n  erd_schema_version: '7'\n}\n", DIAGRAM);
    expect(reading.warnings).toEqual([]);
    expect(reading.warningCodes).toEqual([]);
  });
});

const LAYERS = JSON.stringify({
  schemaVersion: 1,
  layers: [{ id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 0 }],
});

async function warnings(files: Record<string, string>, domainPath: string, options: { maxDomainChars?: number } = {}) {
  const calls: Array<[string, LoaderWarningCode | undefined]> = [];
  await loadDisplaySubjectArea({
    domainPath,
    readFile: async (p) => files[p] ?? null,
    dbml: dbmlStorageReader,
    warn: (message, code) => calls.push([message, code]),
    ...options,
  });
  return calls;
}

describe('loadDisplaySubjectArea passes a code with every warning', () => {
  it('modelNotFound for a JSON diagram naming a table with no file', async () => {
    const calls = await warnings({
      '.erd-studio/layers.json': LAYERS,
      '.erd-studio/gold/sales.json': JSON.stringify({ schemaVersion: 5, domain: 'sales', layer: 'gold', logical: { models: ['nowhere'], relationships: [] }, viewConfig: {} }),
    }, '.erd-studio/gold/sales.json');
    expect(calls.map(([, c]) => c)).toContain('modelNotFound');
  });

  it('foreignDbml and inlineElement for a diagram holding its own Tables, from the reading', async () => {
    const calls = await warnings({
      '.erd-studio/layers.json': LAYERS,
      '.erd-studio/gold/diagrams/sales.dbml': "Table a {\n  id int [pk]\n}\nProject sales {\n  erd_schema_version: '7'\n}\n",
    }, '.erd-studio/gold/diagrams/sales.dbml');
    expect(calls.map(([, c]) => c)).toEqual(expect.arrayContaining(['foreignDbml', 'inlineElement']));
  });

  it('relationshipsFileMissing and layersFile at their sites', async () => {
    const calls = await warnings({
      '.erd-studio/layers.json': LAYERS + ' '.repeat(5000),
      '.erd-studio/gold/diagrams/sales.dbml': "use * from '../relationships/gold.dbml'\nProject sales {\n  erd_schema_version: '7'\n}\n",
    }, '.erd-studio/gold/diagrams/sales.dbml', { maxDomainChars: 4000 });
    const codes = calls.map(([, c]) => c);
    expect(codes).toContain('relationshipsFileMissing');
    expect(codes).toContain('layersFile');
  });

  it('never passes a code outside the list', async () => {
    const calls = await warnings({
      '.erd-studio/layers.json': LAYERS,
      '.erd-studio/gold/diagrams/sales.dbml': "use { table gold.x } from '../tables/gold/x.dbml'\nTable a {\n  id int [pk]\n}\nProject sales {\n  erd_layout: '''\n    junk\n  '''\n}\n",
    }, '.erd-studio/gold/diagrams/sales.dbml');
    expect(calls.length).toBeGreaterThan(0);
    for (const [, code] of calls) expect(LOADER_WARNING_CODES).toContain(code);
  });
});
