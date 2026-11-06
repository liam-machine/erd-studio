/**
 * The words commands use for a failure (#189): which failures are the
 * user's to act on, and that ERD Studio's own never reach the toast raw.
 */

import { describe, expect, it } from 'vitest';

import { SubjectAreaFileError, SubjectAreaValidationError } from '@erd-studio/core';

import {
  classifyWriteFailure,
  describeDiagramFileProblem,
  feedbackPrefill,
  oursMessage,
  projectRelative,
} from '../../src/services/commandErrors';

describe('classifyWriteFailure', () => {
  it('reads Node errno codes and VS Code FileSystemError codes alike', () => {
    for (const code of ['EACCES', 'EPERM', 'EROFS', 'NoPermissions']) {
      expect(classifyWriteFailure(Object.assign(new Error('x'), { code }))).toBe('permission');
    }
    for (const code of ['ENOSPC', 'EDQUOT']) {
      expect(classifyWriteFailure(Object.assign(new Error('x'), { code }))).toBe('disk-full');
    }
  });

  it('falls back to the errno in a FileSystemError\'s message, which carries no code of its own for a full disk', () => {
    expect(classifyWriteFailure(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'Unknown' }))).toBe('disk-full');
  });

  it('calls anything else ours', () => {
    expect(classifyWriteFailure(new Error('Cannot read properties of undefined'))).toBe('other');
    expect(classifyWriteFailure('a string')).toBe('other');
    expect(classifyWriteFailure(undefined)).toBe('other');
  });
});

describe('ours', () => {
  it('never shows the raw error; the report carries it with every path redacted', () => {
    const err = new Error('boom reading /home/someone/project/.erd-studio/x.yml');
    expect(oursMessage('Import from dbt', 'while saving the diagram', 'nothing was changed')).not.toContain('boom');
    const prefill = feedbackPrefill('Import from dbt', 'while saving the diagram', err);
    expect(prefill.kind).toBe('bug');
    expect(prefill.description).toContain('boom reading');
    expect(prefill.description).not.toContain('/home/someone');
  });
});

describe('projectRelative', () => {
  it('is relative with / separators, and the base name outside the project', () => {
    expect(projectRelative('/p', '/p/.erd-studio/silver')).toBe('.erd-studio/silver');
    expect(projectRelative('/p', '/elsewhere/x.json')).toBe('x.json');
  });

  it('keeps a folder whose name starts with .. inside the project', () => {
    expect(projectRelative('/p', '/p/..data/x.json')).toBe('..data/x.json');
  });
});

describe('describeDiagramFileProblem', () => {
  it('says where a JSON mistake is, as the canvas does (#186)', () => {
    const err = new SubjectAreaFileError('invalid-json', '/p/a.json', 'Invalid JSON in /p/a.json', { line: 3, column: 7, syntaxProblem: 'missing-comma' });
    expect(describeDiagramFileProblem(err, '/p/a.json', 'a.json')).toEqual({
      reason: 'there is a mistake at line 3, column 7: a comma is missing after this value', openable: true, line: 3, column: 7,
    });
  });

  it('a merge conflict names its first line', () => {
    const err = new SubjectAreaFileError('invalid-json', '/p/a.json', 'conflict', { mergeConflict: true, line: 9 });
    expect(describeDiagramFileProblem(err, '/p/a.json', 'a.json')).toMatchObject({ openable: true, line: 9 });
  });

  it('calls core\'s wrapped TypeError ours, never showing the raw exception', () => {
    const err = new SubjectAreaValidationError('/p/a.json is not a loadable subject area: Cannot read properties of undefined');
    Object.defineProperty(err, 'cause', { value: new TypeError('Cannot read properties of undefined') });
    expect(describeDiagramFileProblem(err, '/p/a.json', 'a.json')).toBeUndefined();
  });

  it('is undefined for a failure that is not the file\'s', () => {
    expect(describeDiagramFileProblem(new Error('x'), '/p/a.json', 'a.json')).toBeUndefined();
  });
});
