/**
 * Context fields in the Display pipeline: `toDisplaySubjectArea`'s `fields`
 * option (set only when given) and `loadDisplaySubjectArea`'s opt-in
 * `readFieldsFile` (fields.yml next to layers.json, read once, right after it,
 * before any model; never a new error class).
 */

import { describe, it, expect, vi } from 'vitest';

import { loadDisplaySubjectArea, type LoadDisplaySubjectAreaOptions } from '../../src/loadDisplayDomain';
import { toDisplaySubjectArea } from '../../src/displayDomain';
import { FileTooLargeError, TooManyTablesError } from '../../src/loadDisplayDomain';
import { SubjectAreaFileError, SubjectAreaValidationError } from '../../src/domain';
import { parseFieldsText } from '../../src/fieldsFile';
import { STARTING_FIELD_LIST, resolveTableFields } from '../../src/fields';
import type { SemanticSubjectArea } from '../../src/types/semantic';
import { dbmlStorageReader } from '../../src/dbml/index';

const SUBJECT_AREA = '.erd-studio/silver/sales.json';
const LAYERS = '.erd-studio/layers.json';
const FIELDS = '.erd-studio/fields.yml';

const FIELDS_YML = [
  'version: 1',
  'tables:',
  '  - grain',
  '  - purpose',
  '  - key: owner',
  '    label: Owner',
  '    type: value',
  '    filled_by: dbt',
  'columns:',
  '  - natural_key',
  'left_out: [dimension]',
  '',
].join('\n');

const MODEL = 'name: fct_sale\nrationale:\n  purpose: Sales\n  openQuestions: Returns?\nmeta:\n  owner: sales-team\ncolumns:\n  - name: id\n    dataType: INT\n';

function v5(models: unknown[]): string {
  return JSON.stringify({ schemaVersion: 5, domain: 'sales', layer: 'silver', logical: { models, relationships: [] } });
}

function memoryFs(files: Record<string, string>) {
  const reads: string[] = [];
  const readFile = vi.fn(async (p: string) => {
    reads.push(p);
    return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null;
  });
  return { reads, readFile };
}

async function load(files: Record<string, string>, overrides: Partial<LoadDisplaySubjectAreaOptions> = {}) {
  const mem = memoryFs(files);
  const warnings: string[] = [];
  const area = await loadDisplaySubjectArea({
    domainPath: SUBJECT_AREA,
    readFile: mem.readFile,
    readOnly: true,
    warn: (m) => warnings.push(m),
    ...overrides,
  });
  return { area, warnings, reads: mem.reads };
}

const base = (): Record<string, string> => ({
  [SUBJECT_AREA]: v5(['fct_sale']),
  '.erd-studio/logical-models/fct_sale.yml': MODEL,
});

describe('toDisplaySubjectArea: fields', () => {
  const stage: SemanticSubjectArea = {
    schemaVersion: 5,
    domain: 'sales',
    layer: 'silver',
    stage: 'logical',
    description: '',
    modelFolder: '',
    models: [{ name: 'a', rationale: { decisions: 'Kept', openQuestions: 'Why?' } }],
    relationships: [],
  } as unknown as SemanticSubjectArea;
  const options = { viewConfig: {}, layerConfig: undefined, readOnly: false };

  it('sets no fields without the option, so a project without fields.yml draws exactly as before', () => {
    const area = toDisplaySubjectArea(stage, options);
    expect(area).not.toHaveProperty('fields');
  });

  it('sets the list it is given as DisplaySubjectArea.fields', () => {
    const { list } = parseFieldsText(FIELDS_YML);
    const area = toDisplaySubjectArea(stage, { ...options, fields: list });
    expect(area.fields).toBe(list);
    // JSON (postMessage, a cache) keeps it whole.
    expect(JSON.parse(JSON.stringify(area)).fields).toEqual(list);
  });

  it('carries the new rationale keys through to the DisplayTable', () => {
    const area = toDisplaySubjectArea(stage, options);
    expect(area.models[0].rationale).toEqual({ decisions: 'Kept', openQuestions: 'Why?' });
  });
});

describe('loadDisplaySubjectArea: readFieldsFile', () => {
  it('is off by default: fields.yml is never read and the result has no fields', async () => {
    const { area, reads } = await load({ ...base(), [FIELDS]: FIELDS_YML });
    expect(reads).not.toContain(FIELDS);
    expect(area).not.toHaveProperty('fields');
  });

  it('reads the read sequence it always read when off', async () => {
    const off = await load({ ...base(), [FIELDS]: FIELDS_YML });
    const on = await load({ ...base(), [FIELDS]: FIELDS_YML }, { readFieldsFile: true });
    expect(on.reads.filter((p) => p !== FIELDS)).toEqual(off.reads);
  });

  it('reads fields.yml once, right after layers.json and before any model, and sets the parsed list', async () => {
    const { area, reads, warnings } = await load({ ...base(), [FIELDS]: FIELDS_YML }, { readFieldsFile: true });
    expect(reads.filter((p) => p === FIELDS)).toHaveLength(1);
    expect(reads.indexOf(FIELDS)).toBe(reads.indexOf(LAYERS) + 1);
    expect(reads.indexOf(FIELDS)).toBeLessThan(reads.indexOf('.erd-studio/logical-models/fct_sale.yml'));
    expect(area.fields).toEqual(parseFieldsText(FIELDS_YML).list);
    expect(area.fields!.tables.map((f) => f.key)).toEqual(['grain', 'purpose', 'owner']);
    expect(area.fields!.leftOut).toEqual(['dimension']);
    expect(warnings).toEqual([]);
    // The renderer draws the rows from it: owner is on the list, open questions has a value off it.
    const rows = resolveTableFields(area.models[0], area.fields);
    expect(rows.map((r) => [r.id, r.source])).toEqual([
      ['grain', 'list'],
      ['rationale:purpose', 'list'],
      ['meta:owner', 'list'],
      ['rationale:openQuestions', 'notInList'],
    ]);
  });

  it('handles a missing fields.yml as a missing layers.json is handled: no list, no warning', async () => {
    const { area, warnings, reads } = await load(base(), { readFieldsFile: true });
    expect(reads).toContain(FIELDS);
    expect(area).not.toHaveProperty('fields');
    expect(warnings).toEqual([]);
  });

  it('treats a readFile that resolves undefined as missing', async () => {
    const files = base();
    const readFile = async (p: string) => (p in files ? files[p] : undefined);
    const area = await loadDisplaySubjectArea({ domainPath: SUBJECT_AREA, readFile, readOnly: true, warn: () => {}, readFieldsFile: true });
    expect(area).not.toHaveProperty('fields');
  });

  it('does not parse a file longer than maxDomainChars: a warning, and no list', async () => {
    const big = `${FIELDS_YML}# ${'x'.repeat(400)}\n`;
    const { area, warnings } = await load({ ...base(), [FIELDS]: big }, { readFieldsFile: true, maxDomainChars: 300 });
    expect(area).not.toHaveProperty('fields');
    expect(warnings).toEqual([
      `${FIELDS} is ${big.length} characters long; at most 300 are read. Using the starting set of fields`,
    ]);
  });

  it('gives a file that is not YAML a warning with its line, and no list', async () => {
    const { area, warnings } = await load({ ...base(), [FIELDS]: 'tables:\n  - grain\n bad: [\n' }, { readFieldsFile: true });
    expect(area).not.toHaveProperty('fields');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\.erd-studio\/fields\.yml \(line \d+\): The file is not valid YAML/);
  });

  it('gives a file that is not a map a warning, and no list', async () => {
    const { area, warnings } = await load({ ...base(), [FIELDS]: '- grain\n- purpose\n' }, { readFieldsFile: true });
    expect(area).not.toHaveProperty('fields');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('must be a map');
  });

  it('warns every other problem with the file and line, and uses the list', async () => {
    const text = 'tables:\n  - grain\n  - not_a_built_in\n  - key: note\n';
    const { area, warnings } = await load({ ...base(), [FIELDS]: text }, { readFieldsFile: true });
    const { list, problems } = parseFieldsText(text);
    expect(area.fields).toEqual(list);
    expect(area.fields!.tables.map((f) => f.key)).toEqual(['grain']);
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(warnings).toEqual(problems.map((p) => `${FIELDS}${p.line !== undefined ? ` (line ${p.line})` : ''}: ${p.message}`));
  });

  it('bounds the file by maxYamlNodes: over it is a warning and no list, never an expansion or a throw', async () => {
    // Each alias is followed against the budget: 300 copies of a 3-entry list.
    const text = `x: &x [grain, purpose, decisions]\ntables: [${Array(300).fill('*x').join(', ')}]\n`;
    const { area, warnings } = await load({ ...base(), [FIELDS]: text }, { readFieldsFile: true, maxYamlNodes: 200 });
    expect(parseFieldsText(text).problems.some((p) => p.code === 'fieldsYamlInvalid')).toBe(false);
    expect(area).not.toHaveProperty('fields');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('too large to read');
    // The models still load within the same budget.
    expect(area.models.map((m) => m.name)).toEqual(['fct_sale']);
  });

  it('reads an empty fields.yml as the starting set, with no warning', async () => {
    const { area, warnings } = await load({ ...base(), [FIELDS]: '' }, { readFieldsFile: true });
    expect(area.fields).toEqual(STARTING_FIELD_LIST);
    expect(warnings).toEqual([]);
  });

  it('passes a readFile rejection for fields.yml through unchanged', async () => {
    const files = base();
    const failure = new Error('EACCES');
    const readFile = async (p: string) => {
      if (p === FIELDS) throw failure;
      return p in files ? files[p] : null;
    };
    await expect(
      loadDisplaySubjectArea({ domainPath: SUBJECT_AREA, readFile, readOnly: true, warn: () => {}, readFieldsFile: true }),
    ).rejects.toBe(failure);
  });

  it('never rejects with a new error class, whatever fields.yml holds', async () => {
    const texts = ['\u0000', '{', ': :', '<<<<<<< HEAD\ntables: []\n=======\n>>>>>>> x\n', 'tables: 7', 'version: 99\ntables: [{key: 1}]', '[1, 2'];
    for (const text of texts) {
      try {
        await load({ ...base(), [FIELDS]: text }, { readFieldsFile: true });
      } catch (err) {
        expect([SubjectAreaFileError, SubjectAreaValidationError, TooManyTablesError, FileTooLargeError].some((c) => err instanceof c), text).toBe(true);
        throw err;
      }
    }
  });

  it('reads fields.yml from the semantic dir of a DBML diagram, three folders up', async () => {
    const diagram = '.erd-studio/silver/diagrams/sales.dbml';
    const files: Record<string, string> = {
      [diagram]: "Project sales {\n  erd_schema_version: '7'\n}\n",
      [FIELDS]: FIELDS_YML,
    };
    const { area, reads } = await load(files, { domainPath: diagram, dbml: dbmlStorageReader, readFieldsFile: true });
    expect(reads).toContain(FIELDS);
    expect(area.fields?.tables.map((f) => f.key)).toEqual(['grain', 'purpose', 'owner']);
  });
});
