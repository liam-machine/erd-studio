import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yaml')>();
  return { ...actual, parseDocument: vi.fn(actual.parseDocument) };
});

import { parseDocument } from 'yaml';
import {
  FileTooLargeError,
  TooManyModelsError,
  loadDisplayDomain,
  mapWithLimit,
  type LoadDisplayDomainOptions,
} from '../../src/loadDisplayDomain';
import { DomainFileError, DomainValidationError } from '../../src/domain';

const DOMAIN = '.erd-studio/silver/sales.json';

function modelYml(name: string, columns: string[] = ['id']): string {
  return [
    `name: ${name}`,
    'columns:',
    ...columns.flatMap((c) => [`  - name: ${c}`, '    dataType: INT']),
    '',
  ].join('\n');
}

function v5(models: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 5, domain: 'sales', layer: 'silver', logical: { models, relationships: [] }, ...extra });
}

/** An in-memory folder: `readFile` resolves null for anything not in `files`, and records every read. */
function memoryFs(files: Record<string, string>) {
  const reads: string[] = [];
  const readFile = vi.fn(async (p: string) => {
    reads.push(p);
    return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null;
  });
  return { reads, readFile };
}

function load(files: Record<string, string>, overrides: Partial<LoadDisplayDomainOptions> = {}) {
  const mem = memoryFs(files);
  const result = loadDisplayDomain({ domainPath: DOMAIN, readFile: mem.readFile, readOnly: true, warn: () => {}, ...overrides });
  return { ...mem, result };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('mapWithLimit', () => {
  it('keeps input order and never runs more than `limit` at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithLimit([5, 1, 4, 2, 3, 0, 6], 3, async (n, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return `${i}:${n}`;
    });
    expect(out).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3', '5:0', '6:6']);
    expect(peak).toBe(3);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapWithLimit([], 8, async () => 1)).toEqual([]);
    expect(await mapWithLimit([1, 2], 100, async (n) => n * 2)).toEqual([2, 4]);
  });

  it('rejects with the first error and starts nothing after it', async () => {
    const started: number[] = [];
    const boom = new Error('boom');
    const err = await rejection(
      mapWithLimit([0, 1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 2) throw boom;
        return n;
      }),
    );
    expect(err).toBe(boom);
    expect(started).toEqual([0, 1, 2]);
  });
});

describe('mapWithLimit limits', () => {
  it('rejects a limit that is not a number of at least 1 with a TypeError, and runs nothing', async () => {
    for (const bad of [NaN, 0, 0.5, -1, -Infinity, '4', null, undefined]) {
      const worker = vi.fn(async (n: number) => n);
      const err = await rejection(mapWithLimit([1, 2, 3], bad as number, worker));
      expect(err, String(bad)).toBeInstanceOf(TypeError);
      expect(worker).not.toHaveBeenCalled();
    }
  });

  it('runs everything at once for Infinity', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithLimit(Array.from({ length: 20 }, (_, i) => i), Infinity, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBe(20);
  });
});

describe('loadDisplayDomain', () => {
  it('reads the domain, then layers.json, then each model once, all inside the semantic dir', async () => {
    const { reads, result } = load({
      [DOMAIN]: v5(['dim_a', 'fct_b']),
      '.erd-studio/logical-models/dim_a.yml': modelYml('dim_a'),
      '.erd-studio/logical-models/fct_b.yml': modelYml('fct_b'),
    });
    const domain = await result;
    expect(reads).toEqual([
      DOMAIN,
      '.erd-studio/layers.json',
      '.erd-studio/logical-models/dim_a.yml',
      '.erd-studio/logical-models/fct_b.yml',
    ]);
    expect(domain.models.map((m) => m.name)).toEqual(['dim_a', 'fct_b']);
    expect(domain.readOnly).toBe(true);
    expect(domain.positionDraggable).toBe(true);
    expect(domain.layerConfig?.id).toBe('silver');
    expect('templates' in domain).toBe(false);
    expect('existingModels' in domain).toBe(false);
  });

  it('passes readOnly through', async () => {
    const domain = await load({ [DOMAIN]: v5([]) }, { readOnly: false }).result;
    expect(domain.readOnly).toBe(false);
  });

  it('never reads a model whose name could leave logical-models/, and shows it as a placeholder', async () => {
    const names = ['../secrets', 'a/b', 'a\\b', '..', 'a..b', '   ', 'ok'];
    const { reads, result } = load({
      [DOMAIN]: v5(names),
      '.erd-studio/logical-models/ok.yml': modelYml('ok'),
    });
    const domain = await result;
    expect(reads).toEqual([DOMAIN, '.erd-studio/layers.json', '.erd-studio/logical-models/ok.yml']);
    for (const r of reads) {
      expect(r.startsWith('.erd-studio/')).toBe(true);
      expect(r.includes('..')).toBe(false);
    }
    expect(domain.models.map((m) => [m.name, m.columns.length])).toEqual([
      ['../secrets', 0], ['a/b', 0], ['a\\b', 0], ['..', 0], ['a..b', 0], ['   ', 0], ['ok', 1],
    ]);
  });

  it('lets modelNameFilter narrow which names are read', async () => {
    const { reads, result } = load(
      {
        [DOMAIN]: v5(['keep', 'skip']),
        '.erd-studio/logical-models/keep.yml': modelYml('keep'),
        '.erd-studio/logical-models/skip.yml': modelYml('skip'),
      },
      { modelNameFilter: (n) => n === 'keep' },
    );
    const domain = await result;
    expect(reads).not.toContain('.erd-studio/logical-models/skip.yml');
    expect(domain.models.map((m) => [m.name, m.columns.length])).toEqual([['keep', 1], ['skip', 0]]);
  });

  it('reads and parses a model listed 200 times once, giving each occurrence its own object', async () => {
    vi.mocked(parseDocument).mockClear();
    const { reads, result } = load({
      [DOMAIN]: v5(Array(200).fill('dim_a')),
      '.erd-studio/logical-models/dim_a.yml': modelYml('dim_a'),
    });
    const domain = await result;
    expect(reads.filter((r) => r.endsWith('dim_a.yml'))).toHaveLength(1);
    expect(vi.mocked(parseDocument)).toHaveBeenCalledTimes(1);
    expect(domain.models).toHaveLength(200);
    expect(domain.models[0]).toEqual(domain.models[199]);
    expect(domain.models[0]).not.toBe(domain.models[1]);
    expect(domain.models[0].columns).not.toBe(domain.models[1].columns);
  });

  it('keeps at most maxParallelReads model reads in flight (8 by default)', async () => {
    const names = Array.from({ length: 30 }, (_, i) => `m${i}`);
    const files: Record<string, string> = { [DOMAIN]: v5(names) };
    for (const n of names) files[`.erd-studio/logical-models/${n}.yml`] = modelYml(n);

    for (const [limit, expected] of [[undefined, 8], [3, 3], [1, 1]] as const) {
      let inFlight = 0;
      let peak = 0;
      const readFile = async (p: string) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return files[p] ?? null;
      };
      const domain = await loadDisplayDomain({
        domainPath: DOMAIN, readFile, readOnly: true, warn: () => {},
        ...(limit === undefined ? {} : { maxParallelReads: limit }),
      });
      expect(domain.models).toHaveLength(30);
      expect(peak).toBe(expected);
    }
  });

  it('passes readFile rejections through unchanged', async () => {
    const boom = new Error('network down');
    for (const failing of [DOMAIN, '.erd-studio/layers.json', '.erd-studio/logical-models/dim_a.yml']) {
      const readFile = async (p: string) => {
        if (p === failing) throw boom;
        return p === DOMAIN ? v5(['dim_a']) : null;
      };
      expect(await rejection(loadDisplayDomain({ domainPath: DOMAIN, readFile, readOnly: true, warn: () => {} }))).toBe(boom);
    }
  });

  it('throws DomainFileError for a missing domain file', async () => {
    const err = await rejection(load({}).result);
    expect(err).toBeInstanceOf(DomainFileError);
    expect((err as DomainFileError).reason).toBe('missing');
    expect((err as DomainFileError).message).toBe(`Domain file not found: ${DOMAIN}`);
  });

  describe('maxModels', () => {
    it('rejects a v5 domain over the cap before reading any model', async () => {
      const names = Array.from({ length: 6 }, (_, i) => `m${i}`);
      const { reads, result } = load({ [DOMAIN]: v5(names) }, { maxModels: 5 });
      const err = await rejection(result);
      expect(err).toBeInstanceOf(TooManyModelsError);
      expect((err as TooManyModelsError).count).toBe(6);
      expect((err as TooManyModelsError).max).toBe(5);
      expect(reads).toEqual([DOMAIN, '.erd-studio/layers.json']);
    });

    it('counts duplicates and entries that would be filtered out', async () => {
      const dupes = await rejection(load({ [DOMAIN]: v5(Array(6).fill('dim_a')) }, { maxModels: 5 }).result);
      expect(dupes).toBeInstanceOf(TooManyModelsError);
      const unsafe = Array.from({ length: 600 }, (_, i) => `../m${i}`);
      const { reads, result } = load({ [DOMAIN]: v5(unsafe) }, { maxModels: 500 });
      const err = await rejection(result);
      expect(err).toBeInstanceOf(TooManyModelsError);
      expect((err as TooManyModelsError).count).toBe(600);
      expect(reads).toEqual([DOMAIN, '.erd-studio/layers.json']);
    });

    it('applies to v4 inline models too', async () => {
      const models = Array.from({ length: 501 }, (_, i) => ({ name: `m${i}`, columns: [] }));
      const domain = JSON.stringify({ schemaVersion: 4, layer: 'silver', logical: { models, relationships: [] } });
      const err = await rejection(load({ [DOMAIN]: domain }, { maxModels: 500 }).result);
      expect(err).toBeInstanceOf(TooManyModelsError);
      expect((err as TooManyModelsError).count).toBe(501);
    });

    it('allows a domain at the cap', async () => {
      const domain = await load({ [DOMAIN]: v5(['a', 'b']) }, { maxModels: 2 }).result;
      expect(domain.models).toHaveLength(2);
    });
  });

  it('rejects a domain file longer than maxDomainChars with FileTooLargeError', async () => {
    const text = v5(['dim_a']);
    const err = await rejection(load({ [DOMAIN]: text }, { maxDomainChars: text.length - 1 }).result);
    expect(err).toBeInstanceOf(FileTooLargeError);
    expect(err).toMatchObject({ path: DOMAIN, size: text.length, max: text.length - 1 });
    await expect(load({ [DOMAIN]: text }, { maxDomainChars: text.length }).result).resolves.toBeTruthy();
  });

  it('shows a model file longer than maxYamlChars as a placeholder', async () => {
    const big = modelYml('big', Array.from({ length: 50 }, (_, i) => `c${i}`));
    const warn = vi.fn();
    const domain = await load(
      {
        [DOMAIN]: v5(['big', 'small']),
        '.erd-studio/logical-models/big.yml': big,
        '.erd-studio/logical-models/small.yml': modelYml('small'),
      },
      { maxYamlChars: 200, warn },
    ).result;
    expect(domain.models.map((m) => [m.name, m.columns.length])).toEqual([['big', 0], ['small', 1]]);
    expect(warn).toHaveBeenCalledWith('Model "big" not found in logical-models/');
  });

  it('shows a model over maxYamlNodes, or with a YAML error, as a placeholder', async () => {
    const lines = ['name: bomb', 'a0: &a0 [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 10; i++) lines.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]`);
    lines.push('columns: *a9');
    const started = Date.now();
    const domain = await load(
      {
        [DOMAIN]: v5(['bomb', 'broken', 'fine']),
        '.erd-studio/logical-models/bomb.yml': lines.join('\n'),
        '.erd-studio/logical-models/broken.yml': 'name: broken\ncolumns: [\n',
        '.erd-studio/logical-models/fine.yml': modelYml('fine'),
      },
      { maxYamlNodes: 50_000 },
    ).result;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(domain.models.map((m) => [m.name, m.columns.length])).toEqual([['bomb', 0], ['broken', 0], ['fine', 1]]);
  });

  it('shows a model whose aliases expand past maxYamlChars as a placeholder, keeping the result small', async () => {
    const long = 'x'.repeat(100_000);
    const lines = ['name: wide', `description: &s ${long}`, 'columns:'];
    for (let i = 0; i < 3_000; i++) lines.push(`  - {name: c${i}, dataType: t, description: *s}`);
    const yml = lines.join('\n');
    const warn = vi.fn();
    const started = Date.now();
    const domain = await load(
      {
        [DOMAIN]: v5(Array(500).fill('wide')),
        '.erd-studio/logical-models/wide.yml': yml,
      },
      { maxModels: 500, maxYamlNodes: 50_000, maxYamlChars: 1_048_576, maxDomainChars: 1_048_576, warn },
    ).result;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(domain.models).toHaveLength(500);
    expect(domain.models[0].columns).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      'Failed to read model "wide": YAML document expands to more than 1048576 characters of text',
    );
    expect(JSON.stringify(domain).length).toBeLessThan(yml.length);
  });

  it('copies each occurrence of a model without structuredClone, which would copy every string too', async () => {
    const description = 'd'.repeat(10_000);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    let domain;
    try {
      domain = await load({
        [DOMAIN]: v5(['dim_a', 'dim_a']),
        '.erd-studio/logical-models/dim_a.yml': `name: dim_a\ndescription: ${description}\ncolumns:\n  - {name: id, dataType: INT}\n`,
      }).result;
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
    const [a, b] = domain.models;
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.columns[0]).not.toBe(b.columns[0]);
    expect(a.description).toBe(description);
  });

  it('does not parse a layers.json longer than maxDomainChars, and uses the default layers', async () => {
    const layers = JSON.stringify({
      schemaVersion: 1,
      layers: [{ id: 'platinum', label: 'Platinum', abbreviation: 'PLT', color: '#e5e4e2', creatable: true, order: 0 }],
    });
    const files = {
      '.erd-studio/platinum/p.json': JSON.stringify({ schemaVersion: 5, logical: { models: [] } }),
      '.erd-studio/silver/s.json': v5([]),
      '.erd-studio/layers.json': layers,
    };
    const warn = vi.fn();
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const err = await rejection(
        load(files, { domainPath: '.erd-studio/platinum/p.json', maxDomainChars: layers.length - 1, warn }).result,
      );
      expect(err).toBeInstanceOf(DomainValidationError);
      expect(parse.mock.calls.some(([text]) => text === layers)).toBe(false);
    } finally {
      parse.mockRestore();
    }
    expect(warn).toHaveBeenCalledWith(
      `.erd-studio/layers.json is ${layers.length} characters long; at most ${layers.length - 1} are read. Using the default layers`,
    );
    const silver = await load(files, { domainPath: '.erd-studio/silver/s.json', maxDomainChars: layers.length - 1 }).result;
    expect(silver.layerConfig?.id).toBe('silver');
    const platinum = await load(files, { domainPath: '.erd-studio/platinum/p.json', maxDomainChars: layers.length }).result;
    expect(platinum.layerConfig?.id).toBe('platinum');
  });

  it('reads layers.json from the semantic dir the domain sits in, with any separator', async () => {
    const layers = JSON.stringify({
      schemaVersion: 1,
      layers: [{ id: 'platinum', label: 'Platinum', abbreviation: 'PLT', color: '#e5e4e2', creatable: true, order: 0 }],
    });
    for (const [domainPath, prefix] of [
      ['repo/docs/.erd-studio/platinum/p.json', 'repo/docs/.erd-studio/'],
      ['C:\\work\\.erd-studio\\platinum\\p.json', 'C:\\work\\.erd-studio\\'],
    ]) {
      const { reads, readFile } = memoryFs({
        [domainPath]: JSON.stringify({ schemaVersion: 5, logical: { models: ['m'] } }),
        [`${prefix}layers.json`]: layers,
        [`${prefix}logical-models/m.yml`]: modelYml('m'),
      });
      const domain = await loadDisplayDomain({ domainPath, readFile, readOnly: true, warn: () => {} });
      expect(reads[1]).toBe(`${prefix}layers.json`);
      // the parent directory is the layer, and the file name is the domain
      expect(domain.layer).toBe('platinum');
      expect(domain.domain).toBe('p');
      expect(domain.layerConfig?.label).toBe('Platinum');
      expect(domain.models[0].columns).toHaveLength(1);
    }
  });

  it('rejects an unconfigured layer before reading any model', async () => {
    const { reads, result } = load({
      '.erd-studio/diamond/d.json': v5(['dim_a'], { layer: 'diamond' }),
    }, { domainPath: '.erd-studio/diamond/d.json' });
    const err = await rejection(result);
    expect(err).toBeInstanceOf(DomainValidationError);
    expect((err as Error).message).toBe(
      'Domain file .erd-studio/diamond/d.json has invalid layer "diamond". Expected one of: silver, gold',
    );
    expect(reads).toEqual(['.erd-studio/diamond/d.json', '.erd-studio/layers.json']);
  });

  it('fills in positions for models that have none', async () => {
    const domain = await load({
      [DOMAIN]: v5(['a', 'b'], { viewConfig: { positions: { a: { x: 10, y: 20 } } } }),
    }).result;
    expect(domain.viewConfig.positions?.a).toEqual({ x: 10, y: 20 });
    expect(domain.viewConfig.positions?.b).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
  });

  describe('ignoreStrayPositions', () => {
    const strayAtOrigin = v5(['a', 'b'], {
      viewConfig: { positions: { a: { x: 740, y: 100 }, gone: { x: 100, y: 100 } } },
    });

    it('is off by default: models are placed around every entry, as the extension places them', async () => {
      const domain = await load({ [DOMAIN]: strayAtOrigin }).result;
      expect(domain.viewConfig.positions?.b).toEqual({ x: 420, y: 100 });
    });

    it('places models around the positions of models only, keeping the other entries', async () => {
      const domain = await load({ [DOMAIN]: strayAtOrigin }, { ignoreStrayPositions: true }).result;
      expect(domain.viewConfig.positions).toEqual({
        a: { x: 740, y: 100 },
        gone: { x: 100, y: 100 },
        b: { x: 100, y: 100 },
      });
    });

    it('keeps placement fast however many stray entries a file lists', async () => {
      const positions: Record<string, { x: number; y: number }> = {};
      for (let i = 0; i < 25_000; i++) positions[`z${i}`] = { x: 10_000_000 + i * 1_000, y: 10_000_000 };
      for (let r = 0; r < 20; r++) for (let c = 0; c < 10; c++) positions[`g${r}_${c}`] = { x: c * 320 + 100, y: r * 240 + 100 };
      const models = Array.from({ length: 100 }, (_, i) => ({ name: `m${i}`, columns: [] }));
      const text = JSON.stringify({ schemaVersion: 4, layer: 'silver', logical: { models, relationships: [] }, viewConfig: { positions } });
      const started = Date.now();
      const domain = await load({ [DOMAIN]: text }, { ignoreStrayPositions: true }).result;
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(Object.keys(domain.viewConfig.positions ?? {})).toHaveLength(25_000 + 200 + 100);
    });
  });

  describe('limit options', () => {
    const NUMERIC = ['maxModels', 'maxYamlNodes', 'maxDomainChars', 'maxYamlChars'] as const;

    it('rejects a limit that is not a number of at least 0 with a TypeError, before reading anything', async () => {
      for (const name of NUMERIC) {
        for (const bad of [NaN, -1, -Infinity, '4', null]) {
          const { reads, result } = load({ [DOMAIN]: v5([]) }, { [name]: bad as number });
          const err = await rejection(result);
          expect(err, `${name}: ${String(bad)}`).toBeInstanceOf(TypeError);
          expect((err as Error).message).toContain(name);
          expect(reads).toEqual([]);
        }
      }
    });

    it('rejects a maxParallelReads that is not a whole number of at least 1', async () => {
      for (const bad of [NaN, 0, 2.5, -1, -Infinity, '4', null]) {
        const { reads, result } = load({ [DOMAIN]: v5([]) }, { maxParallelReads: bad as number });
        expect(await rejection(result), String(bad)).toBeInstanceOf(TypeError);
        expect(reads).toEqual([]);
      }
    });

    it('accepts Infinity for every limit, and 0 for the caps', async () => {
      const all = Object.fromEntries([...NUMERIC, 'maxParallelReads'].map((n) => [n, Infinity]));
      await expect(load({ [DOMAIN]: v5(['a']) }, all).result).resolves.toBeTruthy();
      const domain = await load({ [DOMAIN]: v5([]) }, { maxModels: 0 }).result;
      expect(domain.models).toEqual([]);
    });
  });

  describe('bad input only ever rejects with the four error classes', () => {
    const KNOWN = [DomainFileError, DomainValidationError, TooManyModelsError, FileTooLargeError];
    const expectKnown = (err: unknown) => {
      expect(KNOWN.some((cls) => err instanceof cls), String(err)).toBe(true);
    };

    it('for every error fixture', async () => {
      const root = path.resolve(__dirname, '../fixtures/errors');
      const dir = path.join(root, '.erd-studio');
      const readFile = async (p: string) => {
        try {
          return fs.readFileSync(path.join(root, p), 'utf-8');
        } catch {
          return null;
        }
      };
      const files = fs.readdirSync(dir, { recursive: true }) as string[];
      const domains = files.filter((f) => f.endsWith('.json')).map((f) => `.erd-studio/${f.split(path.sep).join('/')}`);
      expect(domains.length).toBeGreaterThanOrEqual(8);
      for (const domainPath of domains) {
        expectKnown(await rejection(loadDisplayDomain({ domainPath, readFile, readOnly: true, warn: () => {} })));
      }
    });

    it('for generated bad documents', async () => {
      const bad = ['', '   ', '{', 'null', '[]', '"text"', '42', '{}', '{"schemaVersion":"5"}', '{"schemaVersion":99}',
        '{"schemaVersion":2}', '{"schemaVersion":5,"models":[]}', '{"schemaVersion":5,"logical":{"models":["a",{"name":"b"}]}}',
        '{"schemaVersion":5,"logical":{"models":[null]}}', '{"schemaVersion":5,"layer":"nope"}'];
      for (const text of bad) {
        const err = await rejection(load({ '.erd-studio/nope/d.json': text }, { domainPath: '.erd-studio/nope/d.json' }).result);
        expectKnown(err);
      }
      expectKnown(await rejection(load({}).result));
      expectKnown(await rejection(load({ [DOMAIN]: v5(['a', 'b']) }, { maxModels: 1 }).result));
      expectKnown(await rejection(load({ [DOMAIN]: v5([]) }, { maxDomainChars: 3 }).result));
    });

    it('but never for bad model or layers files, which degrade instead', async () => {
      const domain = await load({
        [DOMAIN]: v5(['a', 'b', 'c']),
        '.erd-studio/layers.json': '{ not json',
        '.erd-studio/logical-models/a.yml': ': : :\n  - [',
        '.erd-studio/logical-models/b.yml': '- just\n- a list\n',
        '.erd-studio/logical-models/c.yml': 'name: c\nzz: *undefined_anchor\n',
      }).result;
      expect(domain.models.map((m) => m.name)).toEqual(['a', 'b', 'c']);
      expect(domain.layerConfig?.id).toBe('silver');
    });
  });
});
