/**
 * detectProjectStorage — the single answer to "which format do new files
 * use?" (§3.2 of docs/plans/native-dbml-storage.md). Only library evidence
 * makes a project DBML; a `.dbml` diagram alone never does.
 */

import { describe, expect, it } from 'vitest';

import { detectProjectStorage, writesDbml, type ProjectStorage, type ProjectStorageEvidence } from '../../src/types/semantic';

const none: ProjectStorageEvidence = { hasYamlTables: false, hasV5Folder: false, hasDbmlTables: false, subjectAreaStorages: [] };

describe('detectProjectStorage', () => {
  const rows: Array<[string, Partial<ProjectStorageEvidence>, ProjectStorage]> = [
    ['an empty project (a new one)', {}, 'dbml'],
    ['only .dbml diagrams (no library yet): no evidence either way', { subjectAreaStorages: ['dbml', 'dbml'] }, 'dbml'],
    ['.yml tables', { hasYamlTables: true }, 'yaml'],
    ['an empty logical-models/ (an older version made it)', { hasV5Folder: true }, 'yaml'],
    ['a JSON diagram', { subjectAreaStorages: ['json'] }, 'yaml'],
    ['.dbml diagrams beside JSON ones', { subjectAreaStorages: ['dbml', 'json', 'dbml'] }, 'yaml'],
    ['.dbml diagrams beside .yml tables', { hasYamlTables: true, subjectAreaStorages: ['dbml'] }, 'yaml'],
    ['DBML tables', { hasDbmlTables: true }, 'dbml'],
    ['DBML tables and DBML diagrams', { hasDbmlTables: true, subjectAreaStorages: ['dbml'] }, 'dbml'],
    ['DBML tables and .yml tables', { hasDbmlTables: true, hasYamlTables: true }, 'mixed'],
    ['DBML tables and a JSON diagram', { hasDbmlTables: true, subjectAreaStorages: ['json'] }, 'mixed'],
    ['DBML tables and an empty logical-models/', { hasDbmlTables: true, hasV5Folder: true }, 'mixed'],
    ['everything', { hasDbmlTables: true, hasYamlTables: true, hasV5Folder: true, subjectAreaStorages: ['json', 'dbml'] }, 'mixed'],
  ];

  it.each(rows)('%s', (_label, evidence, expected) => {
    expect(detectProjectStorage({ ...none, ...evidence })).toBe(expected);
  });

  it('reads the subject area storages from any iterable, once', () => {
    let reads = 0;
    function* storages(): Generator<'json' | 'dbml'> {
      reads++;
      yield 'dbml';
      yield 'json';
    }
    expect(detectProjectStorage({ ...none, subjectAreaStorages: storages() })).toBe('yaml');
    expect(reads).toBe(1);
  });
});

describe('writesDbml', () => {
  it('is true for dbml and mixed, false for yaml', () => {
    expect(writesDbml('dbml')).toBe(true);
    expect(writesDbml('mixed')).toBe(true);
    expect(writesDbml('yaml')).toBe(false);
  });
});
