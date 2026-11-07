/**
 * The words for Migrate to the Central Table Library and the smaller
 * activation messages of #243: every after-text and its buttons.
 */
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  MANIFEST_RETRY_FAILED_MESSAGE,
  MANIFEST_STILL_WRITING_MESSAGE,
  describeMigrationResult,
  migrationFailedMessage,
  moveRefusedMessage,
} from '../../src/services/migrationMessages';
import type { MigrationResult } from '../../src/services/migrationService';

const ROOT = path.join(path.sep, 'project');
const file = (...parts: string[]) => path.join(ROOT, '.erd-studio', ...parts);
const result = (over: Partial<MigrationResult>): MigrationResult => ({
  domainsConverted: 0, modelsCreated: 0, mergeConflicts: [], skipped: [], domainsFound: 0, ...over,
});

describe('describeMigrationResult', () => {
  it('all converted: complete, with what it did', () => {
    expect(describeMigrationResult(result({ domainsFound: 3, domainsConverted: 3, modelsCreated: 5, mergeConflicts: ['dim_a'] }), ROOT)).toEqual({
      level: 'info',
      message: 'Migration complete: 3 diagrams converted, 5 table files created in the Table Library, 1 table defined differently in several diagrams (the most detailed version was kept).',
      migrateAgain: false,
    });
  });

  it('one of each: singular words', () => {
    expect(describeMigrationResult(result({ domainsFound: 1, domainsConverted: 1, modelsCreated: 1 }), ROOT).message)
      .toBe('Migration complete: 1 diagram converted, 1 table file created in the Table Library.');
  });

  it('nothing to do: never "Migration complete: ."', () => {
    expect(describeMigrationResult(result({}), ROOT)).toEqual({ level: 'info', message: 'Nothing needed migrating.', migrateAgain: false });
  });

  it('partial, unreadable: names the file and the fix, offers Open File and Migrate Again, never "complete"', () => {
    const report = describeMigrationResult(result({
      domainsFound: 4, domainsConverted: 3, modelsCreated: 2,
      skipped: [{ filePath: file('silver', 'orders.json'), reason: 'unreadable' }],
    }), ROOT);
    expect(report).toEqual({
      level: 'warning',
      message: "Converted 3 of 4 diagrams. .erd-studio/silver/orders.json wasn't converted: it isn't valid JSON. Fix the file, then run Migrate again.",
      openFile: file('silver', 'orders.json'),
      migrateAgain: true,
    });
    expect(report.message).not.toMatch(/complete/i);
  });

  it('partial, write failed: says permission denied, offers Migrate Again only', () => {
    const err = Object.assign(new Error("EACCES: permission denied, open 'x'"), { code: 'EACCES' });
    expect(describeMigrationResult(result({
      domainsFound: 2, domainsConverted: 1,
      skipped: [{ filePath: file('gold', 'sales.json'), reason: 'writeFailed', error: err }],
    }), ROOT)).toEqual({
      level: 'warning',
      message: "Converted 1 of 2 diagrams. ERD Studio couldn't write .erd-studio/gold/sales.json (permission denied). Check the folder isn't read-only, then run Migrate again.",
      migrateAgain: true,
    });
  });

  it('several skipped: every file named, Open File at the first one the user can fix', () => {
    const report = describeMigrationResult(result({
      domainsFound: 3, domainsConverted: 1,
      skipped: [
        { filePath: file('gold', 'full.json'), reason: 'writeFailed', error: Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) },
        { filePath: file('silver', 'broken.json'), reason: 'unreadable' },
      ],
    }), ROOT);
    expect(report.message).toBe(
      "Converted 1 of 3 diagrams. ERD Studio couldn't write .erd-studio/gold/full.json: the disk is full. Free some space. " +
      ".erd-studio/silver/broken.json wasn't converted: it isn't valid JSON. Fix the file, then run Migrate again.",
    );
    expect(report.openFile).toBe(file('silver', 'broken.json'));
  });
});

describe('migrationFailedMessage (ours)', () => {
  it('nothing written: no diagram files were changed', () => {
    expect(migrationFailedMessage(0)).toBe(
      "Migrate to the Central Table Library hit a problem in ERD Studio while migrating, so no diagram files were changed. This isn't something you did. Please send us a report.",
    );
  });

  it('table files already written: says they were kept', () => {
    expect(migrationFailedMessage(2)).toBe(
      "Migrate to the Central Table Library hit a problem in ERD Studio while migrating, so no diagram files were changed (the 2 table files already written to the Table Library were kept). This isn't something you did. Please send us a report.",
    );
    expect(migrationFailedMessage(1)).toContain('the 1 table file already written to the Table Library was kept');
  });
});

describe('the smaller messages', () => {
  it('a manifest still being written says dbt parse, not compile', () => {
    expect(MANIFEST_STILL_WRITING_MESSAGE).toBe('dbt manifest is still being written — the diagram may be out of date. Run dbt parse once dbt has finished.');
    expect(MANIFEST_STILL_WRITING_MESSAGE).not.toMatch(/compile/);
  });

  it('a failed manifest re-read says what to do', () => {
    expect(MANIFEST_RETRY_FAILED_MESSAGE).toMatch(/Reload the window/);
  });

  it('a refused move says why it usually happens and what to try', () => {
    expect(moveRefusedMessage('the file moves', 'Organise Table Library: ')).toBe(
      'Organise Table Library: VS Code refused the file moves, usually because a file with that name already exists or a file is open with unsaved changes. Nothing was changed. Save open files and try again.',
    );
    expect(moveRefusedMessage('the rename')).toBe(
      'VS Code refused the rename, usually because a file with that name already exists or a file is open with unsaved changes. Nothing was changed. Save open files and try again.',
    );
  });
});
