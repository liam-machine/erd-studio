import { describe, it, expect, vi } from 'vitest';

import {
  DomainFileError,
  DomainValidationError,
  NON_DOMAIN_DIRS,
  VALID_CARDINALITIES,
  buildUnifiedDomain,
  parseDomainJson,
  resolveDomainLayer,
  toLogicalStage,
  validateDomainDocument,
  type BuildUnifiedDomainContext,
  type LayerLookup,
} from '../../src/domain';
import type { SemanticModel, UnifiedDomain } from '../../src/types/semantic';

const FILE = '/proj/.erd-studio/silver/sales.json';

function layers(...ids: string[]): LayerLookup {
  return {
    hasLayer: (id) => ids.includes(id),
    getValidLayerIds: () => [...ids],
  };
}

function ctx(overrides: Partial<BuildUnifiedDomainContext> = {}): BuildUnifiedDomainContext {
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
function build(doc: unknown, overrides: Partial<BuildUnifiedDomainContext> = {}): UnifiedDomain {
  const { obj, format } = validateDomainDocument(doc, FILE);
  return buildUnifiedDomain(obj, format, ctx(overrides));
}

describe('NON_DOMAIN_DIRS', () => {
  it('lists the directories that never hold domain files', () => {
    expect([...NON_DOMAIN_DIRS].sort()).toEqual(['logical', 'logical-models', 'physical', 'templates']);
  });
});

describe('VALID_CARDINALITIES', () => {
  it('holds the four cardinalities', () => {
    expect([...VALID_CARDINALITIES].sort()).toEqual(['many-to-many', 'many-to-one', 'one-to-many', 'one-to-one']);
  });
});

describe('DomainFileError', () => {
  it('is transient only for empty and invalid-json files', () => {
    expect(new DomainFileError('empty', FILE, 'm').transient).toBe(true);
    expect(new DomainFileError('invalid-json', FILE, 'm').transient).toBe(true);
    expect(new DomainFileError('missing', FILE, 'm').transient).toBe(false);
    expect(new DomainFileError('unreadable', FILE, 'm').transient).toBe(false);
  });

  it('carries its reason, path, message and name', () => {
    const err = new DomainFileError('missing', FILE, 'gone');
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe('missing');
    expect(err.filePath).toBe(FILE);
    expect(err.message).toBe('gone');
    expect(err.name).toBe('DomainFileError');
  });
});

describe('parseDomainJson', () => {
  it('returns the parsed document', () => {
    expect(parseDomainJson('{"schemaVersion":5}', FILE)).toEqual({ schemaVersion: 5 });
  });

  it('reports an empty or whitespace-only file as a transient "empty" error', () => {
    for (const raw of ['', '  \n\t']) {
      let caught: unknown;
      try {
        parseDomainJson(raw, FILE);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainFileError);
      expect((caught as DomainFileError).reason).toBe('empty');
      expect((caught as DomainFileError).transient).toBe(true);
      expect((caught as DomainFileError).message).toBe(`Domain file is empty: ${FILE}`);
    }
  });

  it('reports text that is not JSON as a transient "invalid-json" error naming the file', () => {
    let caught: unknown;
    try {
      parseDomainJson('{"schemaVersion": 5,', FILE);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainFileError);
    expect((caught as DomainFileError).reason).toBe('invalid-json');
    expect((caught as DomainFileError).message.startsWith(`Invalid JSON in domain file ${FILE}: `)).toBe(true);
  });
});

describe('validateDomainDocument', () => {
  const rejects = (data: unknown, message: string) => {
    expect(() => validateDomainDocument(data, FILE)).toThrow(DomainValidationError);
    expect(() => validateDomainDocument(data, FILE)).toThrow(message);
  };

  it('rejects anything that is not a JSON object', () => {
    for (const data of [null, [], 'text', 42]) {
      rejects(data, `Domain file ${FILE} does not contain a JSON object`);
    }
  });

  it('rejects a document without a numeric schemaVersion', () => {
    rejects({ logical: { models: [] } }, `Domain file ${FILE} is missing a valid "schemaVersion" field`);
    rejects({ schemaVersion: '5' }, 'is missing a valid "schemaVersion" field');
  });

  it('rejects a schemaVersion newer than this version supports', () => {
    rejects(
      { schemaVersion: 6 },
      `Domain file ${FILE} has schemaVersion 6 but this extension only supports up to version 5. Please update the extension.`,
    );
  });

  it('rejects legacy and hybrid layouts with the migration hint', () => {
    rejects({ schemaVersion: 3, logical: { models: [] } }, 'uses a pre-v4 layout');
    rejects({ schemaVersion: 5, logical: { models: ['a', { name: 'b' }] } }, 'mixes inline model objects');
  });

  it('returns the object and its format', () => {
    const v5 = { schemaVersion: 5, logical: { models: ['a'] } };
    expect(validateDomainDocument(v5, FILE)).toEqual({ obj: v5, format: 'v5' });
    const v4 = { schemaVersion: 4, logical: { models: [{ name: 'a' }] } };
    expect(validateDomainDocument(v4, FILE)).toEqual({ obj: v4, format: 'v4' });
  });

  it('keeps the plain Error name, so logged errors read as before', () => {
    try {
      validateDomainDocument([], FILE);
    } catch (err) {
      expect(err).toBeInstanceOf(DomainValidationError);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('Error');
    }
  });
});

describe('resolveDomainLayer', () => {
  it('uses the layer field when it is configured', () => {
    expect(resolveDomainLayer('gold', FILE, 'silver', layers('silver', 'gold'))).toBe('gold');
  });

  it('falls back to the parent directory', () => {
    expect(resolveDomainLayer('platinum', FILE, 'silver', layers('silver', 'gold'))).toBe('silver');
    expect(resolveDomainLayer(undefined, FILE, 'gold', layers('silver', 'gold'))).toBe('gold');
    expect(resolveDomainLayer(7, FILE, 'gold', layers('silver', 'gold'))).toBe('gold');
  });

  it('throws a DomainValidationError listing the configured layers', () => {
    const call = () => resolveDomainLayer('diamond', FILE, 'platinum', layers('silver', 'gold'));
    expect(call).toThrow(DomainValidationError);
    expect(call).toThrow(`Domain file ${FILE} has invalid layer "diamond". Expected one of: silver, gold`);
  });
});

describe('buildUnifiedDomain', () => {
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
          relationships: [good, { ...good, cardinality: 'sometimes' }, { fromModel: 'a' }, 'nope'],
        },
      },
      { warn },
    );
    expect(u.logical.relationships).toEqual([good, { ...good, cardinality: 'many-to-one' }]);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      `Relationship a.k → b.k in ${FILE} has invalid cardinality "sometimes"; defaulting to many-to-one`,
      `Skipping malformed relationship entry in ${FILE}: {"fromModel":"a"}`,
      `Skipping malformed relationship entry in ${FILE}: "nope"`,
    ]);
  });

  it('resolves v5 references through getModel, with a warned placeholder for each miss', () => {
    const warn = vi.fn();
    const dimA: SemanticModel = { name: 'dim_a', columns: [{ name: 'k', dataType: 'INT', description: '' }] };
    const getModel = vi.fn((name: string) => (name === 'dim_a' ? structuredClone(dimA) : null));
    const u = build({ schemaVersion: 5, logical: { models: ['dim_a', 'gone', 'dim_a'] } }, { getModel, warn });
    expect(u.logical.models).toEqual([dimA, { name: 'gone', columns: [] }, dimA]);
    expect(getModel.mock.calls.map((c) => c[0])).toEqual(['dim_a', 'gone', 'dim_a']);
    expect(warn).toHaveBeenCalledWith('Model "gone" not found in logical-models/');
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
    ).toThrow(DomainValidationError);
    expect(getModel).not.toHaveBeenCalled();
  });

  it('warns through console.warn when no warn callback is given', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { obj, format } = validateDomainDocument({ schemaVersion: 5, viewConfig: { positions: { a: null } } }, FILE);
    buildUnifiedDomain(obj, format, { ...ctx(), warn: undefined });
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
