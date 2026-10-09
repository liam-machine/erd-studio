/**
 * Unresolved git merge conflicts in a domain or model file (#145).
 *
 * A file git left `<<<<<<<` / `=======` / `>>>>>>>` markers in is reported as
 * a merge conflict with the line of its first marker — not as "Invalid JSON",
 * and not as a transient failure worth re-reading.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { findConflictMarkers } from '../../src/mergeConflict';
import { DomainFileError, classifyModelLoadError, describeModelLoadError, parseDomainJson } from '../../src/domain';
import { parseLogicalModelText } from '../../src/logicalModel';
import { loadDisplayDomain } from '../../src/loadDisplayDomain';

const FILE = '/proj/.erd-studio/silver/sales.json';
const ERRORS_ROOT = path.resolve(__dirname, '../fixtures/errors');

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

const lines = (...l: string[]) => l.join('\n');

const POSITIONS_CONFLICT = lines(
  '{',
  '  "schemaVersion": 5,',
  '  "logical": { "models": ["a", "b"], "relationships": [] },',
  '  "viewConfig": {',
  '    "positions": {',
  '<<<<<<< HEAD',
  '      "a": { "x": 0, "y": 0 }',
  '=======',
  '      "a": { "x": 10, "y": 40 }',
  '>>>>>>> feature/move',
  '    }',
  '  }',
  '}',
);

describe('parseDomainJson on a file with conflict markers', () => {
  const cases: Array<[string, string, number]> = [
    ['at the start of the file', lines('<<<<<<< HEAD', '{"schemaVersion": 5}', '=======', '{"schemaVersion": 5, "domain": "x"}', '>>>>>>> other'), 1],
    ['inside viewConfig.positions only', POSITIONS_CONFLICT, 6],
    ['inside logical.models', lines(
      '{',
      '  "schemaVersion": 5,',
      '  "logical": {',
      '    "models": [',
      '<<<<<<< ours',
      '      "a"',
      '=======',
      '      "a", "b"',
      '>>>>>>> theirs',
      '    ]',
      '  }',
      '}',
    ), 5],
    ['in diff3 style, with a ||||||| base section', lines(
      '{',
      '<<<<<<< HEAD',
      '  "domain": "ours",',
      '||||||| merged common ancestors',
      '  "domain": "base",',
      '=======',
      '  "domain": "theirs",',
      '>>>>>>> feature',
      '  "schemaVersion": 5',
      '}',
    ), 2],
    ['with CRLF line endings', POSITIONS_CONFLICT.replace(/\n/g, '\r\n'), 6],
    ['after a byte order mark', `\uFEFF${POSITIONS_CONFLICT}`, 6],
    ['with label-less markers', lines('{', '<<<<<<<', '"a": 1', '=======', '"a": 2', '>>>>>>>', '}'), 2],
  ];

  it.each(cases)('reports a merge conflict %s, with the line of the first marker', (_name, raw, line) => {
    const err = caught(() => parseDomainJson(raw, FILE));
    expect(err).toBeInstanceOf(DomainFileError);
    const e = err as DomainFileError;
    expect(e.reason).toBe('invalid-json');
    expect(e.mergeConflict).toBe(true);
    expect(e.line).toBe(line);
    // Re-reading in a second cannot resolve a conflict.
    expect(e.transient).toBe(false);
    expect(e.message).toBe(
      `Domain file ${FILE} has unresolved git merge conflicts (first at line ${line}). `
        + 'Resolve them in the file — if only positions conflict, either side is safe to keep.',
    );
  });

  it('parses valid JSON whose text quotes marker-like lines', () => {
    const doc = { schemaVersion: 5, description: '=======\n<<<<<<< x\n=======\n>>>>>>> y' };
    expect(parseDomainJson(JSON.stringify(doc, null, 2), FILE)).toEqual(doc);
  });

  it('keeps invalid JSON with only a lone separator line an ordinary, transient invalid-json', () => {
    const err = caught(() => parseDomainJson(lines('{', '  "schemaVersion": 5,', '=======', '}'), FILE)) as DomainFileError;
    expect(err.reason).toBe('invalid-json');
    expect(err.mergeConflict).toBe(false);
    expect(err.line).toBeUndefined();
    expect(err.transient).toBe(true);
    expect(err.message.startsWith(`Invalid JSON in domain file ${FILE}: `)).toBe(true);
  });

  it('still reports an empty file as empty', () => {
    const err = caught(() => parseDomainJson('', FILE)) as DomainFileError;
    expect(err.reason).toBe('empty');
    expect(err.mergeConflict).toBe(false);
    expect(err.transient).toBe(true);
  });
});

describe('DomainFileError.mergeConflict', () => {
  it('defaults to false, so every existing constructor call is unchanged', () => {
    for (const reason of ['missing', 'unreadable', 'empty', 'invalid-json'] as const) {
      const err = new DomainFileError(reason, FILE, 'm');
      expect(err.mergeConflict).toBe(false);
      expect(err.line).toBeUndefined();
    }
  });
});

describe('findConflictMarkers', () => {
  it('needs an opening, a separator and a closing line, in that order', () => {
    expect(findConflictMarkers(lines('<<<<<<< a', 'x', '>>>>>>> b'))).toBeNull();
    expect(findConflictMarkers(lines('<<<<<<< a', '=======', 'x'))).toBeNull();
    expect(findConflictMarkers(lines('=======', '<<<<<<< a', '>>>>>>> b'))).toBeNull();
    expect(findConflictMarkers(lines('>>>>>>> b', '=======', '<<<<<<< a'))).toBeNull();
    expect(findConflictMarkers(lines('Title', '=======', 'text'))).toBeNull();
  });

  it('accepts longer markers but not shorter ones, nor text glued to the marker', () => {
    expect(findConflictMarkers(lines('<<<<<<<< a', '========', '>>>>>>>> b'))).toBe(1);
    expect(findConflictMarkers(lines('<<<<<< a', '======', '>>>>>> b'))).toBeNull();
    expect(findConflictMarkers(lines('<<<<<<<a', '=======', '>>>>>>> b'))).toBeNull();
    expect(findConflictMarkers(lines('<<<<<<< a', '======= x', '>>>>>>> b'))).toBeNull();
    expect(findConflictMarkers(lines('  <<<<<<< a', '=======', '>>>>>>> b'))).toBeNull();
  });

  it('reports the first complete conflict, skipping a stray opening line before it', () => {
    expect(findConflictMarkers(lines('<<<<<<< stray', 'x', '<<<<<<< a', 'y', '=======', 'z', '>>>>>>> b'))).toBe(3);
  });
});

describe('a model file with conflict markers', () => {
  const CONFLICTED = lines(
    'name: fct_order',
    'columns:',
    '  - name: order_id',
    '<<<<<<< HEAD',
    '    dataType: int',
    '=======',
    '    dataType: bigint',
    '>>>>>>> feature',
  );

  it('throws an error core classifies as a merge conflict at the first marker', () => {
    const err = caught(() => parseLogicalModelText(CONFLICTED, 'fct_order'));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Unresolved git merge conflict (first at line 4)');
    expect(classifyModelLoadError(err)).toEqual({ kind: 'yamlOther', line: 4, mergeConflict: true });
  });

  it('describes it as a merge conflict, and an ordinary YAML error as before', () => {
    expect(describeModelLoadError({ kind: 'yamlOther', line: 4, mergeConflict: true }))
      .toBe('logical-models file has an unresolved git merge conflict on line 4');
    expect(describeModelLoadError({ kind: 'yamlOther', mergeConflict: true }))
      .toBe('logical-models file has an unresolved git merge conflict');
    expect(describeModelLoadError({ kind: 'yamlScalar', line: 4 })).toBe('logical-models file has a YAML error on line 4');
  });

  it('leaves a marker-like line in a block scalar that parses alone', () => {
    const text = lines('name: dim_x', 'description: |', '  <<<<<<< a', '  =======', '  >>>>>>> b', 'columns: []');
    expect(parseLogicalModelText(text, 'dim_x')?.description).toBe('<<<<<<< a\n=======\n>>>>>>> b\n');
  });

  it('reaches the DisplayDomain through loadDisplayDomain', async () => {
    const files: Record<string, string> = {
      '.erd-studio/silver/sales.json': JSON.stringify({ schemaVersion: 5, domain: 'sales', layer: 'silver', logical: { models: ['fct_order'], relationships: [] } }),
      '.erd-studio/logical-models/fct_order.yml': CONFLICTED,
    };
    const warnings: string[] = [];
    const domain = await loadDisplayDomain({
      domainPath: '.erd-studio/silver/sales.json',
      readFile: async (p) => files[p] ?? null,
      readOnly: true,
      warn: (m) => warnings.push(m),
    });
    expect(domain.models[0].loadError).toEqual({ kind: 'yamlOther', line: 4, mergeConflict: true });
    expect(warnings).toContain('Model "fct_order": logical-models file has an unresolved git merge conflict on line 4');
  });
});

describe('loadDisplayDomain on the conflicted fixtures', () => {
  const readFile = async (p: string) => {
    try {
      return fs.readFileSync(path.join(ERRORS_ROOT, p), 'utf-8');
    } catch {
      return null;
    }
  };

  it.each([
    ['conflict-positions.json', 12],
    ['conflict-models.json', 9],
  ])('rejects %s with a merge-conflict DomainFileError', async (file, line) => {
    const domainPath = `.erd-studio/silver/${file}`;
    const err = await loadDisplayDomain({ domainPath, readFile, readOnly: true, warn: () => {} }).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DomainFileError);
    expect((err as DomainFileError).reason).toBe('invalid-json');
    expect((err as DomainFileError).mergeConflict).toBe(true);
    expect((err as DomainFileError).line).toBe(line);
  });
});
