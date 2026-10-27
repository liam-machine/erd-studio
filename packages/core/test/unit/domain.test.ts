import { describe, it, expect, vi } from 'vitest';

import {
  SubjectAreaFileError,
  SubjectAreaValidationError,
  NON_SUBJECT_AREA_DIRS,
  VALID_CARDINALITIES,
  buildUnifiedSubjectArea,
  DBML_DIAGRAM_QUOTE_HINT_CODES,
  DBML_QUOTE_HINT,
  DBML_TABLE_QUOTE_HINT_CODES,
  TableDbmlError,
  classifyDbmlTableError,
  classifyTableLoadError,
  dbmlErrorClassOf,
  describeTableLoadError,
  parseSubjectAreaJson,
  locateJsonSyntaxError,
  resolveSubjectAreaLayer,
  toLogicalStage,
  validateSubjectAreaDocument,
  type BuildUnifiedSubjectAreaContext,
  type LayerLookup,
} from '../../src/domain';
import type { SemanticTable, UnifiedSubjectArea } from '../../src/types/semantic';
import { CURRENT_JSON_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION, DBML_SCHEMA_VERSION } from '../../src/types/semantic';
import { toDisplaySubjectArea } from '../../src/displayDomain';

const FILE = '/proj/.erd-studio/silver/sales.json';

function layers(...ids: string[]): LayerLookup {
  return {
    hasLayer: (id) => ids.includes(id),
    getValidLayerIds: () => [...ids],
  };
}

function ctx(overrides: Partial<BuildUnifiedSubjectAreaContext> = {}): BuildUnifiedSubjectAreaContext {
  return {
    filePath: FILE,
    domainNameFallback: 'sales',
    parentDirName: 'silver',
    layers: layers('silver', 'gold'),
    warn: () => {},
    ...overrides,
  };
}

/** Validate then build, the way every host calls the pair. */
function build(doc: unknown, overrides: Partial<BuildUnifiedSubjectAreaContext> = {}): UnifiedSubjectArea {
  const { obj, format } = validateSubjectAreaDocument(doc, FILE);
  return buildUnifiedSubjectArea(obj, format, ctx(overrides));
}

describe('NON_SUBJECT_AREA_DIRS', () => {
  it('lists the directories that never hold domain files', () => {
    expect([...NON_SUBJECT_AREA_DIRS].sort()).toEqual(['logical', 'logical-models', 'physical', 'templates']);
  });
});

describe('VALID_CARDINALITIES', () => {
  it('holds the four cardinalities', () => {
    expect([...VALID_CARDINALITIES].sort()).toEqual(['many-to-many', 'many-to-one', 'one-to-many', 'one-to-one']);
  });
});

describe('SubjectAreaFileError', () => {
  it('is transient only for empty and invalid-json files', () => {
    expect(new SubjectAreaFileError('empty', FILE, 'm').transient).toBe(true);
    expect(new SubjectAreaFileError('invalid-json', FILE, 'm').transient).toBe(true);
    expect(new SubjectAreaFileError('missing', FILE, 'm').transient).toBe(false);
    expect(new SubjectAreaFileError('unreadable', FILE, 'm').transient).toBe(false);
  });

  it('carries its reason, path, message and name', () => {
    const err = new SubjectAreaFileError('missing', FILE, 'gone');
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe('missing');
    expect(err.filePath).toBe(FILE);
    expect(err.message).toBe('gone');
    expect(err.name).toBe('SubjectAreaFileError');
  });
});

describe('parseSubjectAreaJson', () => {
  it('returns the parsed document', () => {
    expect(parseSubjectAreaJson('{"schemaVersion":5}', FILE)).toEqual({ schemaVersion: 5 });
  });

  it('reports an empty or whitespace-only file as a transient "empty" error', () => {
    for (const raw of ['', '  \n\t']) {
      let caught: unknown;
      try {
        parseSubjectAreaJson(raw, FILE);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SubjectAreaFileError);
      expect((caught as SubjectAreaFileError).reason).toBe('empty');
      expect((caught as SubjectAreaFileError).transient).toBe(true);
      expect((caught as SubjectAreaFileError).message).toBe(`Subject area file is empty: ${FILE}`);
    }
  });

  it('reports text that is not JSON as a transient "invalid-json" error naming the file', () => {
    let caught: unknown;
    try {
      parseSubjectAreaJson('{"schemaVersion": 5,', FILE);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SubjectAreaFileError);
    expect((caught as SubjectAreaFileError).reason).toBe('invalid-json');
    expect((caught as SubjectAreaFileError).message.startsWith(`Invalid JSON in subject area file ${FILE}: `)).toBe(true);
  });
});

describe('where an invalid-json domain file goes wrong (#186)', () => {
  const caught = (raw: string): SubjectAreaFileError => {
    try {
      parseSubjectAreaJson(raw, FILE);
    } catch (err) {
      return err as SubjectAreaFileError;
    }
    throw new Error('did not throw');
  };
  const lines = (...l: string[]): string => l.join('\n');
  const where = (err: SubjectAreaFileError) => ({ line: err.line, column: err.column, problem: err.syntaxProblem });

  it('points at a trailing comma, not at the bracket the parser stopped on', () => {
    expect(where(caught(lines('{', '  "schemaVersion": 5,', '  "layer": "gold",', '}'))))
      .toEqual({ line: 3, column: 18, problem: 'trailing-comma' });
    expect(where(caught('{"models": ["a", "b",]}'))).toEqual({ line: 1, column: 21, problem: 'trailing-comma' });
    expect(where(caught('{"a": 1,}'))).toEqual({ line: 1, column: 8, problem: 'trailing-comma' });
  });

  it('points just after the value a comma is missing from, on its own line', () => {
    expect(where(caught(lines('{', '  "schemaVersion": 5', '  "layer": "gold"', '}'))))
      .toEqual({ line: 2, column: 21, problem: 'missing-comma' });
  });

  it('points at the end of a file that stops before the JSON does', () => {
    expect(where(caught(lines('{', '  "schemaVersion": 5,', '  "layer": "go'))))
      .toEqual({ line: 3, column: 15, problem: 'truncated' });
    expect(where(caught(lines('{', '  "models": [', '')))).toEqual({ line: 2, column: 14, problem: 'truncated' });
  });

  it('counts CRLF line endings as one line break', () => {
    expect(where(caught('{\r\n  "a": 1,\r\n}'))).toEqual({ line: 2, column: 9, problem: 'trailing-comma' });
  });

  it('reads a file that starts with a byte order mark, which the text editor hides', () => {
    expect(parseSubjectAreaJson('\ufeff{"schemaVersion": 5}', FILE)).toEqual({ schemaVersion: 5 });
  });

  it('locates a mistake in a file with a byte order mark as the text editor shows it', () => {
    expect(where(caught('\ufeff{\n  "a": 1,\n}'))).toEqual({ line: 2, column: 9, problem: 'trailing-comma' });
    expect(where(caught('\ufeff{"a": 1, "b": 2,}'))).toEqual({ line: 1, column: 16, problem: 'trailing-comma' });
  });

  it('calls a mistake a missing comma only where a comma could go', () => {
    // A missing colon, in the words an older V8 (Node 18, VS Code 1.85) uses.
    expect(locateJsonSyntaxError('{"a" "b": 1}', 'Unexpected string in JSON at position 5')?.problem).toBe('unexpected');
    // An assistant appending a second copy of the document.
    expect(where(caught('{"a": 1}\n{"a": 1}')).problem).toBe('unexpected');
    // A bad number, not two values.
    expect(where(caught('{"a": 01}')).problem).toBe('unexpected');
  });

  it('points at the start of a misspelt literal', () => {
    expect(where(caught('{"a": tru}'))).toEqual({ line: 1, column: 7, problem: 'unexpected' });
  });

  it('keeps the message the CLI and logs print', () => {
    const err = caught('{"a": 1,}');
    expect(err.message.startsWith(`Invalid JSON in subject area file ${FILE}: `)).toBe(true);
    expect(err.mergeConflict).toBe(false);
    expect(err.transient).toBe(true);
  });
});

describe('locateJsonSyntaxError', () => {
  it('reads the position from older V8, SpiderMonkey and end-of-input messages', () => {
    const raw = '{\n  "a": 1,\n}';
    expect(locateJsonSyntaxError(raw, 'Unexpected token } in JSON at position 12'))
      .toEqual({ line: 2, column: 9, problem: 'trailing-comma' });
    expect(locateJsonSyntaxError(raw, 'JSON.parse: expected double-quoted property name at line 3 column 1 of the JSON data'))
      .toEqual({ line: 2, column: 9, problem: 'trailing-comma' });
    expect(locateJsonSyntaxError('{"a": [1', 'Unexpected end of JSON input'))
      .toEqual({ line: 1, column: 9, problem: 'truncated' });
  });

  it('finds the mistake itself when the parser names no position (V8 "Unexpected token", Safari)', () => {
    expect(locateJsonSyntaxError('{"a": 1,}', "JSON Parse error: Expected '}'"))
      .toEqual({ line: 1, column: 8, problem: 'trailing-comma' });
    expect(locateJsonSyntaxError('{\n  // a comment\n  "a": 1\n}', "Unexpected token '/', ...\"{ // a com\"... is not valid JSON"))
      .toEqual({ line: 2, column: 3, problem: 'unexpected' });
  });

  it('says nothing for text that is JSON after all', () => {
    expect(locateJsonSyntaxError('{"a": [1, -2.5e3, "x\\u00e9", true, null]}', 'no position here')).toBeUndefined();
  });

  it('does not call a missing colon a missing comma', () => {
    const raw = '{"a" 1}';
    let message = '';
    try { JSON.parse(raw); } catch (err) { message = (err as Error).message; }
    expect(locateJsonSyntaxError(raw, message)?.problem).toBe('unexpected');
  });
});

describe('validateSubjectAreaDocument', () => {
  const rejects = (data: unknown, message: string) => {
    expect(() => validateSubjectAreaDocument(data, FILE)).toThrow(SubjectAreaValidationError);
    expect(() => validateSubjectAreaDocument(data, FILE)).toThrow(message);
  };

  it('rejects anything that is not a JSON object', () => {
    for (const data of [null, [], 'text', 42]) {
      rejects(data, `Subject area file ${FILE} does not contain a JSON object`);
    }
  });

  it('rejects a document without a numeric schemaVersion', () => {
    rejects({ logical: { models: [] } }, `Subject area file ${FILE} is missing a valid "schemaVersion" field`);
    rejects({ schemaVersion: '5' }, 'is missing a valid "schemaVersion" field');
  });

  it('rejects a schemaVersion newer than this version supports', () => {
    rejects(
      { schemaVersion: 7 },
      `Subject area file ${FILE} has schemaVersion 7 but this extension only supports up to version 6. Please update the extension.`,
    );
  });

  it('rejects legacy and hybrid layouts with the migration hint', () => {
    rejects({ schemaVersion: 3, logical: { models: [] } }, 'uses a pre-v4 layout');
    rejects({ schemaVersion: 5, logical: { models: ['a', { name: 'b' }] } }, 'mixes inline table objects');
  });

  it('returns the object and its format', () => {
    const v5 = { schemaVersion: 5, logical: { models: ['a'] } };
    expect(validateSubjectAreaDocument(v5, FILE)).toEqual({ obj: v5, format: 'v5' });
    const v4 = { schemaVersion: 4, logical: { models: [{ name: 'a' }] } };
    expect(validateSubjectAreaDocument(v4, FILE)).toEqual({ obj: v4, format: 'v4' });
  });

  it('keeps the plain Error name, so logged errors read as before', () => {
    try {
      validateSubjectAreaDocument([], FILE);
    } catch (err) {
      expect(err).toBeInstanceOf(SubjectAreaValidationError);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('Error');
    }
  });
});

describe('resolveSubjectAreaLayer', () => {
  it('uses the layer field when it is configured', () => {
    expect(resolveSubjectAreaLayer('gold', FILE, 'silver', layers('silver', 'gold'))).toBe('gold');
  });

  it('falls back to the parent directory', () => {
    expect(resolveSubjectAreaLayer('platinum', FILE, 'silver', layers('silver', 'gold'))).toBe('silver');
    expect(resolveSubjectAreaLayer(undefined, FILE, 'gold', layers('silver', 'gold'))).toBe('gold');
    expect(resolveSubjectAreaLayer(7, FILE, 'gold', layers('silver', 'gold'))).toBe('gold');
  });

  it('throws a SubjectAreaValidationError listing the configured layers', () => {
    const call = () => resolveSubjectAreaLayer('diamond', FILE, 'platinum', layers('silver', 'gold'));
    expect(call).toThrow(SubjectAreaValidationError);
    expect(call).toThrow(`Subject area file ${FILE} has invalid layer "diamond". Expected one of: silver, gold`);
  });
});

describe('buildUnifiedSubjectArea', () => {
  it('fills defaults for a minimal v5 document', () => {
    expect(build({ schemaVersion: 5 })).toEqual({
      schemaVersion: 5,
      domain: 'sales',
      layer: 'silver',
      description: '',
      logical: { models: [], relationships: [] },
      viewConfig: {},
    });
  });

  it('keeps the domain, description and modelFolder strings and drops other types', () => {
    const u = build({ schemaVersion: 5, domain: 'orders', description: 'd', modelFolder: 'models/x', layer: 'gold' });
    expect(u).toMatchObject({ domain: 'orders', description: 'd', modelFolder: 'models/x', layer: 'gold' });
    const v = build({ schemaVersion: 5, domain: 1, description: 2, modelFolder: 3 });
    expect(v.domain).toBe('sales');
    expect(v.description).toBe('');
    expect('modelFolder' in v).toBe(false);
  });

  it('keeps only string stubColumns, and omits an empty list', () => {
    expect(build({ schemaVersion: 5, stubColumns: ['a', 7, 'b'] }).stubColumns).toEqual(['a', 'b']);
    expect('stubColumns' in build({ schemaVersion: 5, stubColumns: [7] })).toBe(false);
  });

  it('reads the global viewConfig, falling back to the logical stage one', () => {
    const positions = { a: { x: 1, y: 2 } };
    expect(build({ schemaVersion: 5, viewConfig: { positions } }).viewConfig.positions).toEqual(positions);
    expect(build({ schemaVersion: 5, logical: { models: [], viewConfig: { positions } } }).viewConfig.positions)
      .toEqual(positions);
  });

  it('drops malformed positions and annotations, with a warning for positions', () => {
    const warn = vi.fn();
    const u = build(
      {
        schemaVersion: 5,
        viewConfig: {
          showFkEdges: 'yes',
          layoutOptions: ['nope'],
          positions: { a: { x: 1, y: 2 }, b: { x: 'left', y: 0 }, c: null, d: { x: Infinity, y: 0 } },
          annotations: [{ id: 'n1', x: 0, y: 0, text: 't' }, { id: 'n2', text: 'no coordinates' }, null],
        },
      },
      { warn },
    );
    expect(u.viewConfig).toEqual({
      showFkEdges: undefined,
      layoutOptions: undefined,
      positions: { a: { x: 1, y: 2 } },
      annotations: [{ id: 'n1', x: 0, y: 0, text: 't' }],
    });
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      'Ignoring malformed viewConfig.positions entry for "b"',
      'Ignoring malformed viewConfig.positions entry for "c"',
      'Ignoring malformed viewConfig.positions entry for "d"',
    ]);
  });

  it('drops malformed relationships and defaults an unknown cardinality, warning for each', () => {
    const warn = vi.fn();
    const good = { fromModel: 'a', fromColumn: 'k', toModel: 'b', toColumn: 'k', cardinality: 'one-to-one', note: 'kept' };
    const u = build(
      {
        schemaVersion: 5,
        logical: {
          models: [],
          relationships: [good, { ...good, fromColumn: 'k2', cardinality: 'sometimes' }, { fromModel: 'a' }, 'nope'],
        },
      },
      { warn },
    );
    expect(u.logical.relationships).toEqual([good, { ...good, fromColumn: 'k2', cardinality: 'many-to-one' }]);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      `Relationship a.k2 → b.k in ${FILE} has invalid cardinality "sometimes"; defaulting to many-to-one`,
      `Skipping malformed relationship entry in ${FILE}: {"fromModel":"a"}`,
      `Skipping malformed relationship entry in ${FILE}: "nope"`,
    ]);
  });

  it('resolves v5 references through getModel, with a warned placeholder for each miss', () => {
    const warn = vi.fn();
    const dimA: SemanticTable = { name: 'dim_a', columns: [{ name: 'k', dataType: 'INT', description: '' }] };
    const getModel = vi.fn((name: string) => (name === 'dim_a' ? structuredClone(dimA) : null));
    const u = build({ schemaVersion: 5, logical: { models: ['dim_a', 'gone', 'dim_a'] } }, { getModel, warn });
    expect(u.logical.models).toEqual([dimA, { name: 'gone', columns: [] }, dimA]);
    expect(getModel.mock.calls.map((c) => c[0])).toEqual(['dim_a', 'gone', 'dim_a']);
    expect(warn).toHaveBeenCalledWith('Model "gone" not found in the table library');
  });

  it('names a known load error in the warning and carries it on the placeholder (#110)', () => {
    const warn = vi.fn();
    const getModelError = vi.fn((name: string) => (name === 'broken' ? { kind: 'yamlScalar' as const, line: 4 } : null));
    const u = build(
      { schemaVersion: 5, logical: { models: ['broken', 'gone'] } },
      { getModel: () => null, getModelError, warn },
    );
    expect(u.logical.models).toEqual([
      { name: 'broken', columns: [], loadError: { kind: 'yamlScalar', line: 4 } },
      { name: 'gone', columns: [] },
    ]);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      'Model "broken": logical-models file has a YAML error on line 4',
      'Model "gone" not found in the table library',
    ]);
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).not.toContain('"broken" not found');

    // toDisplaySubjectArea passes it through to the node.
    const display = toDisplaySubjectArea(toLogicalStage(u), { viewConfig: {}, layerConfig: undefined, readOnly: false });
    expect(display.models.map((m) => m.loadError)).toEqual([{ kind: 'yamlScalar', line: 4 }, undefined]);
  });

  it('never asks getModelError about a model getModel resolved', () => {
    const getModelError = vi.fn(() => ({ kind: 'yamlOther' as const }));
    build(
      { schemaVersion: 5, logical: { models: ['dim_a'] } },
      { getModel: (name) => ({ name, columns: [] }), getModelError },
    );
    expect(getModelError).not.toHaveBeenCalled();
  });

  it('classifies parser errors by code and position only', () => {
    expect(classifyTableLoadError(Object.assign(new Error('x'), { code: 'TAB_AS_INDENT', linePos: [{ line: 3, col: 1 }] })))
      .toEqual({ kind: 'yamlIndent', line: 3, column: 1, code: 'TAB_AS_INDENT' });
    expect(classifyTableLoadError(Object.assign(new Error('x'), { code: 'EACCES' }))).toEqual({ kind: 'read' });
    expect(classifyTableLoadError(new Error('no code'))).toEqual({ kind: 'yamlOther' });
    expect(describeTableLoadError({ kind: 'read' })).toBe('logical-models file could not be read');
    expect(describeTableLoadError({ kind: 'yamlDuplicateKey' })).toBe('logical-models file has a YAML error');
  });

  it('makes silent placeholders for every v5 reference when there is no getModel', () => {
    const warn = vi.fn();
    const u = build({ schemaVersion: 5, logical: { models: ['a', 'b'] } }, { warn });
    expect(u.logical.models).toEqual([{ name: 'a', columns: [] }, { name: 'b', columns: [] }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps v4 inline models that have a string name and skips the rest', () => {
    const warn = vi.fn();
    const u = build(
      { schemaVersion: 4, logical: { models: [{ name: 'a', extra: 1 }, { description: 'no name' }] } },
      { warn },
    );
    expect(u.logical.models).toEqual([{ name: 'a', extra: 1 }]);
    expect(warn).toHaveBeenCalledWith(`Skipping inline model without a string "name" in ${FILE}`);
  });

  it('throws the layer error before resolving any model', () => {
    const getModel = vi.fn(() => null);
    expect(() =>
      build({ schemaVersion: 5, layer: 'diamond', logical: { models: ['a'] } }, { parentDirName: 'platinum', getModel }),
    ).toThrow(SubjectAreaValidationError);
    expect(getModel).not.toHaveBeenCalled();
  });

  it('warns through console.warn when no warn callback is given', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { obj, format } = validateSubjectAreaDocument({ schemaVersion: 5, viewConfig: { positions: { a: null } } }, FILE);
    buildUnifiedSubjectArea(obj, format, { ...ctx(), warn: undefined });
    expect(spy).toHaveBeenCalledWith('Ignoring malformed viewConfig.positions entry for "a"');
    spy.mockRestore();
  });
});

describe('toLogicalStage', () => {
  it('projects the logical stage, keeping modelFolder only when set', () => {
    const u = build({
      schemaVersion: 5,
      domain: 'd',
      modelFolder: 'models/d',
      logical: { models: ['a'], relationships: [] },
    });
    expect(toLogicalStage(u)).toEqual({
      schemaVersion: 5,
      domain: 'd',
      layer: 'silver',
      stage: 'logical',
      description: '',
      modelFolder: 'models/d',
      models: [{ name: 'a', columns: [] }],
      relationships: [],
    });
    expect('modelFolder' in toLogicalStage(build({ schemaVersion: 5 }))).toBe(false);
  });
});

describe('relationship ends spelled in another case are drawn (#133 L4)', () => {
  const models: Record<string, SemanticTable> = {
    dim_customer: { name: 'dim_customer', columns: [{ name: 'customer_id', dataType: 'int', description: '', isPrimaryKey: true }] },
    fct_order: {
      name: 'fct_order',
      columns: [{ name: 'customer_id', dataType: 'int', description: '' }],
      relationships: [{ fromColumn: 'Customer_ID', toModel: 'Dim_Customer', toColumn: 'CUSTOMER_ID', cardinality: 'many-to-one' }],
    },
  };
  const getModel = (name: string): SemanticTable | null => models[name] ?? null;
  const REAL = { fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id' };

  it('a library entry with toModel Dim_Customer is drawn as dim_customer, and badges the column', () => {
    const u = build({ schemaVersion: 5, logical: { models: ['dim_customer', 'fct_order'] } }, { getModel });
    expect(u.logical.relationships).toEqual([{ ...REAL, cardinality: 'many-to-one' }]);
    const display = toDisplaySubjectArea(toLogicalStage(u), { viewConfig: {}, layerConfig: undefined, readOnly: false });
    expect(display.models.find((m) => m.name === 'fct_order')!.columns[0].isForeignKey).toBe(true);
  });

  it('a domain file\'s own mis-cased entry is drawn with the real names (no library entries)', () => {
    const own = { fromModel: 'FCT_ORDER', fromColumn: 'customer_ID', toModel: 'dim_Customer', toColumn: 'Customer_id', cardinality: 'many-to-one' };
    const u = build(
      { schemaVersion: 5, logical: { models: ['dim_customer', 'fct_order'], relationships: [own, { ...own, fromColumn: 'CUSTOMER_ID' }] } },
      { getModel: (n) => ({ ...getModel(n)!, relationships: undefined }) },
    );
    expect(u.logical.relationships).toEqual([{ ...REAL, cardinality: 'many-to-one' }]);
  });

  it('a v4 domain\'s inline relationships are respelled too', () => {
    const u = build({
      schemaVersion: 4,
      logical: {
        models: [models.dim_customer, { name: 'fct_order', columns: models.fct_order.columns }],
        relationships: [{ fromModel: 'Fct_Order', fromColumn: 'CUSTOMER_ID', toModel: 'DIM_CUSTOMER', toColumn: 'Customer_Id', cardinality: 'many-to-one' }],
      },
    });
    expect(u.logical.relationships).toEqual([{ ...REAL, cardinality: 'many-to-one' }]);
  });
});

describe('the read winner reads dbt evidence when no key is flagged (#133 L1)', () => {
  it('dbt-unique on dim.k makes fct\'s copy win, with no flags anywhere', async () => {
    const { buildDbtKeyIndex } = await import('../../src/keyEvidence');
    const dim: SemanticTable = { name: 'dim', columns: [{ name: 'k', dataType: 'int', description: '' }], relationships: [{ fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'many-to-one' }] };
    const fct: SemanticTable = { name: 'fct', columns: [{ name: 'k', dataType: 'int', description: '' }], relationships: [{ fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one', role: 'r' }] };
    const getModel = (name: string): SemanticTable | null => ({ dim, fct } as Record<string, SemanticTable>)[name] ?? null;
    const doc = { schemaVersion: 5, logical: { models: ['dim', 'fct'] } };
    expect(build(doc, { getModel }).logical.relationships).toEqual([{ fromModel: 'dim', fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'many-to-one' }]);
    const dbtKeyIndex = buildDbtKeyIndex([{ uniqueColumns: new Map([['dim', new Set(['k'])]]) }]);
    expect(build(doc, { getModel, dbtKeyIndex }).logical.relationships).toEqual([{ fromModel: 'fct', fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one', role: 'r' }]);
  });
});

describe('composite foreign keys are drawn when they form one (#133 L2)', () => {
  const col = (name: string) => ({ name, dataType: 'int', description: '' });
  const sat: SemanticTable = { name: 'sat', columns: [col('hk'), col('load_date')] };
  const other: SemanticTable = { name: 'hub', columns: [col('hk')] };
  const m = (fromColumn: string, toColumn: string, extra: Record<string, unknown> = {}) =>
    ({ fromColumn, toModel: 'sat', toColumn, cardinality: 'many-to-one' as const, compositeKey: 'FK_Sat', ...extra });
  const pit = (relationships: SemanticTable['relationships']): SemanticTable => ({ name: 'pit', columns: [col('hk'), col('as_of'), col('x')], relationships });
  const draw = (models: SemanticTable[], own: unknown[] = [], warn = vi.fn()) => {
    const lookup = Object.fromEntries(models.map((x) => [x.name, x]));
    const u = build({ schemaVersion: 5, logical: { models: models.map((x) => x.name), relationships: own } }, { getModel: (n) => lookup[n] ?? null, warn });
    return u.logical.relationships;
  };

  it('a valid group keeps compositeKey, spelled as its first member, with the first member\'s role on every member', () => {
    const rels = draw([pit([m('hk', 'hk', { role: 'as of' }), m('as_of', 'load_date', { compositeKey: 'fk_sat', role: 'other' })]), sat]);
    expect(rels.map((r) => [r.fromColumn, r.compositeKey, r.role])).toEqual([['hk', 'FK_Sat', 'as of'], ['as_of', 'FK_Sat', 'as of']]);
  });

  it.each([
    ['one member', [m('hk', 'hk')]],
    ['mixed toModel', [m('hk', 'hk'), m('as_of', 'hk', { toModel: 'hub' })]],
    ['mixed cardinality', [m('hk', 'hk'), m('as_of', 'load_date', { cardinality: 'one-to-one' })]],
    ['many-to-many', [m('hk', 'hk', { cardinality: 'many-to-many' }), m('as_of', 'load_date', { cardinality: 'many-to-many' })]],
    ['a repeated column', [m('hk', 'hk'), m('hk', 'load_date')]],
  ])('an invalid group (%s) draws as singles, with one warning', (_name, entries) => {
    const warn = vi.fn();
    const rels = draw([pit(entries as SemanticTable['relationships']), sat, other], [], warn);
    expect(rels.length).toBe(entries.length);
    expect(rels.every((r) => r.compositeKey === undefined)).toBe(true);
    expect(warn.mock.calls.filter(([msg]) => /do not form one composite key/.test(msg))).toHaveLength(1);
  });

  it('a 1.6.7 single copy elsewhere does not break the group in its home file', () => {
    const stray: SemanticTable = { ...sat, relationships: [{ fromColumn: 'hk', toModel: 'pit', toColumn: 'hk', cardinality: 'one-to-many' }] };
    const rels = draw([pit([m('hk', 'hk'), m('as_of', 'load_date')]), stray]);
    expect(rels.map((r) => [r.fromModel, r.fromColumn, r.compositeKey])).toEqual([['pit', 'hk', 'FK_Sat'], ['pit', 'as_of', 'FK_Sat']]);
  });

  it('a domain file\'s own group is drawn too, by (fromModel, compositeKey)', () => {
    const own = [
      { fromModel: 'pit', fromColumn: 'hk', toModel: 'sat', toColumn: 'hk', cardinality: 'many-to-one', compositeKey: 'k' },
      { fromModel: 'pit', fromColumn: 'as_of', toModel: 'sat', toColumn: 'load_date', cardinality: 'many-to-one', compositeKey: 'K' },
    ];
    expect(draw([{ ...pit(undefined) }, sat], own).map((r) => r.compositeKey)).toEqual(['k', 'k']);
  });

  it('file and model order do not change the result', () => {
    const entries = [m('hk', 'hk', { role: 'r' }), m('as_of', 'load_date')];
    const a = draw([pit(entries), sat]);
    const b = draw([sat, pit(entries)]);
    const sorted = (rels: typeof a) => rels.map((r) => JSON.stringify(r)).sort();
    expect(sorted(b)).toEqual(sorted(a));
    expect(a.map((r) => [r.compositeKey, r.role])).toEqual([['FK_Sat', 'r'], ['FK_Sat', 'r']]);
  });
});

describe('native DBML storage: versions, the invalid-dbml reason and DBML table-file errors', () => {
  it('a JSON file declaring schemaVersion 7 (a DBML version) is still refused, word for word as before', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(7);
    expect(CURRENT_JSON_SCHEMA_VERSION).toBe(6);
    expect(DBML_SCHEMA_VERSION).toBe(7);
    for (const version of [7, 8]) {
      expect(() => validateSubjectAreaDocument({ schemaVersion: version, logical: { models: [] } }, FILE)).toThrow(
        `Subject area file ${FILE} has schemaVersion ${version} but this extension only supports up to version 6. Please update the extension.`,
      );
    }
  });

  it("'invalid-dbml' is transient unless the file holds merge conflicts", () => {
    expect(new SubjectAreaFileError('invalid-dbml', FILE, 'm').transient).toBe(true);
    const conflict = new SubjectAreaFileError('invalid-dbml', FILE, 'm', { mergeConflict: true, line: 3 });
    expect(conflict.transient).toBe(false);
    expect(conflict.mergeConflict).toBe(true);
    const located = new SubjectAreaFileError('invalid-dbml', FILE, 'm', { line: 4, column: 7 });
    expect([located.line, located.column]).toEqual([4, 7]);
  });

  it('dbmlErrorClassOf maps a code by its range', () => {
    expect(dbmlErrorClassOf(1000)).toBe('syntax');
    expect(dbmlErrorClassOf(1999)).toBe('syntax');
    expect(dbmlErrorClassOf(3025)).toBe('invalid');
    expect(dbmlErrorClassOf(4000)).toBe('binding');
    expect(dbmlErrorClassOf(4001)).toBe('binding');
    expect(dbmlErrorClassOf(5001)).toBe('interpreter');
    expect(dbmlErrorClassOf(2000)).toBe('invalid');
  });

  it('classifyTableLoadError classifies a TableDbmlError by its code or rule, never its message', () => {
    const at = { line: 4, column: 9 };
    expect(classifyTableLoadError(new TableDbmlError('quote me', { dbmlCode: 1001, ...at }))).toEqual({ kind: 'dbmlSyntax', ...at, code: '1001' });
    expect(classifyTableLoadError(new TableDbmlError('x', { dbmlCode: 3025, ...at }))).toEqual({ kind: 'dbmlInvalid', ...at, code: '3025' });
    expect(classifyTableLoadError(new TableDbmlError('x', { dbmlCode: 5001 }))).toEqual({ kind: 'dbmlInvalid', code: '5001' });
    expect(classifyTableLoadError(new TableDbmlError('x', { dbmlCode: 4000, line: 2 }))).toEqual({ kind: 'dbmlStructure', line: 2, code: '4000' });
    expect(classifyTableLoadError(new TableDbmlError('x', { rule: 'notOneTable' }))).toEqual({ kind: 'dbmlStructure', code: 'structure:notOneTable' });
    expect(classifyTableLoadError(new TableDbmlError('x', { rule: 'nameMismatch', line: 1, column: 7 }))).toEqual({
      kind: 'dbmlStructure', line: 1, column: 7, code: 'structure:nameMismatch',
    });
    expect(classifyTableLoadError(new TableDbmlError('x', { rule: 'unsupportedElement' })).code).toBe('structure:unsupportedElement');
    expect(classifyTableLoadError(new TableDbmlError('x', { mergeConflict: true, line: 6, column: 1 }))).toEqual({
      kind: 'dbmlSyntax', line: 6, mergeConflict: true,
    });
    expect(classifyTableLoadError(new TableDbmlError('x'))).toEqual({ kind: 'dbmlInvalid' });
    // The same answer from the plain classifier a reader can call without throwing.
    expect(classifyDbmlTableError({ dbmlCode: 3075, line: 1 })).toEqual({ kind: 'dbmlInvalid', line: 1, code: '3075' });
    // YAML errors are classified as before.
    expect(classifyTableLoadError(Object.assign(new Error('x'), { code: 'TAB_AS_INDENT', linePos: [{ line: 3, col: 1 }] })))
      .toEqual({ kind: 'yamlIndent', line: 3, column: 1, code: 'TAB_AS_INDENT' });
  });

  it('describeTableLoadError words each DBML kind, with the quote hint for 3025 and 3075 only', () => {
    expect(describeTableLoadError({ kind: 'dbmlSyntax', line: 4 })).toBe('table file has a DBML syntax error on line 4');
    expect(describeTableLoadError({ kind: 'dbmlSyntax' })).toBe('table file has a DBML syntax error');
    expect(describeTableLoadError({ kind: 'dbmlSyntax', line: 6, mergeConflict: true })).toBe('table file has an unresolved git merge conflict on line 6');
    expect(describeTableLoadError({ kind: 'dbmlInvalid', line: 2, code: '3025' }))
      .toBe("table file has an unquoted value on line 2; quote it, as in grain: 'One row per order line'");
    expect(describeTableLoadError({ kind: 'dbmlInvalid', code: '3075' }))
      .toBe("table file has an unquoted value; quote it, as in grain: 'One row per order line'");
    // 3073 is a TablePartial error in the pinned parser: no quote hint.
    expect(describeTableLoadError({ kind: 'dbmlInvalid', line: 2, code: '3073' })).toBe('table file is not valid DBML (3073) on line 2');
    expect(describeTableLoadError({ kind: 'dbmlInvalid' })).toBe('table file is not valid DBML');
    expect(describeTableLoadError({ kind: 'dbmlStructure', code: 'structure:notOneTable' }))
      .toBe('table file must hold exactly one Table that needs no other file');
    expect(DBML_TABLE_QUOTE_HINT_CODES.has('3073')).toBe(false);
    expect([...DBML_DIAGRAM_QUOTE_HINT_CODES].sort()).toEqual(['3051', '3063']);
    expect(DBML_QUOTE_HINT).toContain("grain: 'One row per order line'");
    // The YAML wording does not change.
    expect(describeTableLoadError({ kind: 'yamlScalar', line: 5 })).toBe('logical-models file has a YAML error on line 5');
    expect(describeTableLoadError({ kind: 'yamlOther', line: 5, mergeConflict: true }))
      .toBe('logical-models file has an unresolved git merge conflict on line 5');
  });

  it('the relationship-mismatch warning names the table library, not a folder', () => {
    const warn = vi.fn();
    const models: SemanticTable[] = [
      { name: 'a', columns: [{ name: 'b_id', dataType: 'int', description: '' }], relationships: [{ fromColumn: 'b_id', toModel: 'b', toColumn: 'id', cardinality: 'one-to-one' }] },
      { name: 'b', columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true }] },
    ];
    build(
      { schemaVersion: 5, domain: 'd', layer: 'silver', logical: { models: ['a', 'b'], relationships: [{ fromModel: 'a', fromColumn: 'b_id', toModel: 'b', toColumn: 'id', cardinality: 'many-to-one' }] } },
      { getModel: (name) => models.find((m) => m.name === name) ?? null, warn },
    );
    expect(warn.mock.calls.flat().join('\n')).toContain('but the table library defines it as one-to-one');
    expect(warn.mock.calls.flat().join('\n')).not.toContain('logical-models/');
  });
});
