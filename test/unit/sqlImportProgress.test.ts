/**
 * Import SQL DDL…'s progress notification and time limit setting:
 * `withDelayedProgress` shows a cancellable notification only once a reading
 * runs longer than a moment, its Cancel aborts the reading's signal and its
 * bar only moves forward; `erdStudio.import.timeLimitSeconds` is contributed
 * and read through `getErdStudioSetting()`; the automatic draft's quiet UI
 * shows no notification.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { _resetMockConfiguration, _setMockConfiguration } from '../__mocks__/vscode';
import {
  DEFAULT_SQL_TIME_LIMIT_MS,
  TIME_LIMIT_SETTING,
  quietImportSqlDdlUi,
  sqlImportTimeLimitMs,
  sqlProgressMessage,
  withDelayedProgress,
  type ImportSqlDdlUi,
} from '../../src/commands/importSqlDdl';
import packageJson from '../../package.json';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  _resetMockConfiguration();
});

/** A stand-in for `window.withProgress`: records the options and reports, and presses Cancel when asked. */
function fakeProgress(pressCancel = false) {
  const reports: Array<{ message?: string; increment?: number }> = [];
  const shown: unknown[] = [];
  const spy = vi.spyOn(vscode.window, 'withProgress').mockImplementation(((options: unknown, task: (p: unknown, t: unknown) => Thenable<unknown>) => {
    shown.push(options);
    const token = { isCancellationRequested: false, onCancellationRequested: (cb: () => void) => { if (pressCancel) setTimeout(cb, 0); return { dispose: () => {} }; } };
    return task({ report: (r: { message?: string; increment?: number }) => reports.push(r) }, token);
  }) as never);
  return { spy, reports, shown };
}

describe('the reading\'s progress notification', () => {
  it('a reading quicker than the delay shows nothing', async () => {
    const { spy } = fakeProgress();
    expect(await withDelayedProgress('t', async () => 42, 50)).toBe(42);
    await new Promise((r) => setTimeout(r, 80));
    expect(spy).not.toHaveBeenCalled();
  });

  it('a longer one shows a cancellable notification with the latest line; the bar never goes back', async () => {
    const { reports, shown } = fakeProgress();
    const result = await withDelayedProgress('Import SQL DDL: reading the scripts', async (progress) => {
      progress.report('first', 0.2);
      await new Promise((r) => setTimeout(r, 40));
      progress.report('second', 0.5);
      progress.report('again', 0.1); // another dialect starts from the beginning
      progress.report('third', 0.9);
      return 'done';
    }, 10);
    expect(result).toBe('done');
    expect(shown).toEqual([{ location: vscode.ProgressLocation.Notification, title: 'Import SQL DDL: reading the scripts', cancellable: true }]);
    expect(reports).toEqual([
      { message: 'first', increment: 20 },
      { message: 'second', increment: 30 },
      { message: 'again' },
      { message: 'third', increment: 40 },
    ]);
  });

  it('the next dialect\'s reading gets a new, empty bar: never one already full while it runs', async () => {
    const { reports, shown } = fakeProgress();
    const result = await withDelayedProgress('t', async (progress) => {
      await new Promise((r) => setTimeout(r, 30));
      progress.report('as PostgreSQL', 1);
      progress.restart?.();
      progress.report('as MySQL', 0.25);
      await new Promise((r) => setTimeout(r, 10));
      progress.report('as MySQL', 0.5);
      return 'done';
    }, 10);
    expect(result).toBe('done');
    expect(shown).toHaveLength(2);
    expect(reports).toEqual([
      { message: 'as PostgreSQL', increment: 100 },
      { message: 'as MySQL', increment: 25 },
      { message: 'as MySQL', increment: 25 },
    ]);
  });

  it('a restart before the bar moved (or before anything shows) keeps the one notification', async () => {
    const { shown } = fakeProgress();
    await withDelayedProgress('t', async (progress) => {
      progress.restart?.();
      await new Promise((r) => setTimeout(r, 30));
      progress.report('as PostgreSQL');
      progress.restart?.();
      progress.report('as MySQL', 0.5);
    }, 10);
    expect(shown).toHaveLength(1);
  });

  it('its Cancel aborts the reading\'s signal', async () => {
    fakeProgress(true);
    const aborted = await withDelayedProgress('t', (_progress, signal) => new Promise<boolean>((resolve) => {
      signal.addEventListener('abort', () => resolve(true));
      setTimeout(() => resolve(false), 2_000);
    }), 5);
    expect(aborted).toBe(true);
  });

  it('says what has been read, and in which file of several', () => {
    expect(sqlProgressMessage('postgres', { statementsRead: 1234, tablesRead: 1000, filesRead: 1, files: 3, fraction: 0.4 }))
      .toBe('1,234 statements, 1,000 tables read as PostgreSQL (file 2 of 3)');
    expect(sqlProgressMessage('sqlserver', { statementsRead: 1, tablesRead: 1, filesRead: 0, files: 1, fraction: 1 }))
      .toBe('1 statement, 1 table read as SQL Server / Azure SQL');
  });

  it('the automatic draft shows no notification', () => {
    const base = { withProgress: async () => undefined } as unknown as ImportSqlDdlUi;
    expect(quietImportSqlDdlUi(base).withProgress).toBeUndefined();
  });
});

describe('erdStudio.import.timeLimitSeconds', () => {
  it('is contributed: a number of seconds, 0 for none, 120 by default', () => {
    const props = (packageJson as unknown as { contributes: { configuration: { properties: Record<string, { type: string; default: unknown; minimum?: number }> } } }).contributes.configuration.properties;
    expect(props[TIME_LIMIT_SETTING]).toMatchObject({ type: 'number', default: DEFAULT_SQL_TIME_LIMIT_MS / 1000, minimum: 0 });
  });

  it('is read in ms, 0 meaning no limit, anything else not a number ≥ 0 the default', () => {
    expect(sqlImportTimeLimitMs()).toBe(DEFAULT_SQL_TIME_LIMIT_MS);
    _setMockConfiguration('erdStudio', 'import.timeLimitSeconds', { workspaceValue: 30 });
    expect(sqlImportTimeLimitMs()).toBe(30_000);
    _setMockConfiguration('erdStudio', 'import.timeLimitSeconds', { workspaceValue: 0 });
    expect(sqlImportTimeLimitMs()).toBe(0);
    _setMockConfiguration('erdStudio', 'import.timeLimitSeconds', { workspaceValue: -5 });
    expect(sqlImportTimeLimitMs()).toBe(DEFAULT_SQL_TIME_LIMIT_MS);
    _setMockConfiguration('erdStudio', 'import.timeLimitSeconds', { workspaceValue: 'soon' });
    expect(sqlImportTimeLimitMs()).toBe(DEFAULT_SQL_TIME_LIMIT_MS);
  });
});
