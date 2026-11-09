/**
 * Stopping a SQL conversion early (Cancel, or the import's time limit):
 * `convertSqlDdl`'s `shouldStop` is asked before every statement, what was
 * read is converted as usual, and every statement not read is in the ledger
 * as a `problem` with the stop's cause, placed at the line where the unread
 * part of its file starts. Conservation holds: the CREATE TABLEs found are
 * the tables read plus the tables reported. Progress is reported after every
 * statement.
 */

import { describe, expect, it } from 'vitest';

import type { LedgerEntry } from '../../src/services/importLedger';
import { ledgerLeftOut } from '../../src/services/importLedger';
import type { SqlConvertProgress, SqlDdlFile, SqlDdlToDbmlResult, SqlStopReason } from '../../src/services/sqlDdlImport';
import { sqlDdlToDbml } from '../../src/services/sqlImportEngine';
import { sqlPartialNotice } from '../../src/commands/importSqlDdl';

/** `count` tables t{from}…, each with a key to the one before; the line each CREATE TABLE starts on. */
function tables(from: number, count: number): { text: string; lines: number[] } {
  const lines: number[] = [];
  const parts: string[] = [];
  let line = 1;
  for (let i = from; i < from + count; i++) {
    lines.push(line);
    const block = `CREATE TABLE t${i} (\n  id INTEGER PRIMARY KEY,\n  name VARCHAR(40)${i > from ? `,\n  prev_id INTEGER REFERENCES t${i - 1}(id)` : ''}\n);\n`;
    parts.push(block);
    line += block.split('\n').length - 1;
  }
  return { text: parts.join(''), lines };
}

/** Stops before the statement numbered `at` (0-based, across every file). */
function stopAt(at: number, reason: SqlStopReason = 'cancelled'): { shouldStop: () => SqlStopReason | undefined; asked: () => number } {
  let asked = 0;
  return { shouldStop: () => (asked++ >= at ? reason : undefined), asked: () => asked };
}

const stopEntries = (ledger: readonly LedgerEntry[] | undefined, cause: SqlStopReason): LedgerEntry[] =>
  (ledger ?? []).filter((e) => e.cause === cause);

describe('a conversion stopped early', () => {
  it('keeps what it read, and reports the rest of the file from the line where reading stopped', () => {
    const { text, lines } = tables(0, 10);
    const stop = stopAt(4);
    const result = sqlDdlToDbml({ files: [{ name: 'a.sql', text }], dialect: 'postgres', options: { shouldStop: stop.shouldStop } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tableCount).toBe(4);
    expect(result.tablesFound).toBe(10);
    expect(result.stopped).toEqual({ reason: 'cancelled', statementsRead: 4, statementsUnread: 6, tablesUnread: 6, at: { file: 'a.sql', line: lines[4] } });
    expect(stopEntries(result.ledger, 'cancelled')).toEqual([
      { outcome: 'problem', unit: 'table', cause: 'cancelled', what: 'CREATE TABLE', count: 6, where: { file: 'a.sql', line: lines[4] }, detail: 'not read: the import was cancelled first' },
    ]);
    // Conservation: found = read + reported.
    const reported = stopEntries(result.ledger, 'cancelled').filter((e) => e.unit === 'table').reduce((n, e) => n + e.count, 0);
    expect(result.tableCount + reported).toBe(result.tablesFound);
    // The relationships among the tables read are kept.
    expect(result.refCount).toBe(3);
    // The draft says so first, and its Not imported list names the place.
    expect(sqlPartialNotice(result)).toBe(`The import was cancelled at a.sql line ${lines[4]}: 6 of 10 tables were not read; Show details lists them.`);
    expect(ledgerLeftOut(result.ledger)).toEqual(['6 tables: CREATE TABLE not read: the import was cancelled first.']);
  });

  it('reports every later file whole, at its first statement, and never calls an unread file empty', () => {
    const one = tables(0, 3);
    const two = tables(3, 2);
    const files: SqlDdlFile[] = [
      { name: 'one.sql', text: one.text },
      { name: 'two.sql', text: `-- header\n\n${two.text}CREATE INDEX ix ON t3 (name);\nALTER TABLE t4 ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES t0(id);\n` },
      { name: 'three.sql', text: 'CREATE VIEW v AS SELECT 1;\n' },
    ];
    const result = sqlDdlToDbml({ files, dialect: 'postgres', options: { shouldStop: stopAt(2, 'timeLimit').shouldStop, timeLimitMs: 90_000 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tableCount).toBe(2);
    expect(result.tablesFound).toBe(5);
    expect(result.stopped).toMatchObject({ reason: 'timeLimit', statementsRead: 2, tablesUnread: 3, statementsUnread: 6, at: { file: 'one.sql', line: one.lines[2] } });
    const detail = 'not read: the time limit (90 s) was reached first';
    expect(stopEntries(result.ledger, 'timeLimit')).toEqual([
      { outcome: 'problem', unit: 'table', cause: 'timeLimit', what: 'CREATE TABLE', count: 1, where: { file: 'one.sql', line: one.lines[2] }, detail },
      { outcome: 'problem', unit: 'table', cause: 'timeLimit', what: 'CREATE TABLE', count: 2, where: { file: 'two.sql', line: 3 }, detail },
      { outcome: 'problem', unit: 'statement', cause: 'timeLimit', what: '', count: 2, where: { file: 'two.sql', line: 3 }, detail },
      { outcome: 'problem', unit: 'statement', cause: 'timeLimit', what: '', count: 1, where: { file: 'three.sql', line: 1 }, detail },
    ]);
    expect(result.skipped.join('\n')).not.toMatch(/no tables, keys or comments/);
    // The ALTER in the unread file was never applied, and nothing skipped there is counted as read.
    expect(result.skipped.join('\n')).not.toMatch(/two\.sql|three\.sql/);
    expect(sqlPartialNotice(result)).toBe(`The import reached its time limit at one.sql line ${one.lines[2]}: 3 of 5 tables were not read; Show details lists them.`);
  });

  it('stopped before any table was read: not ok, with the whole file in the ledger and no problem made up', () => {
    const { text } = tables(0, 3);
    const result = sqlDdlToDbml({ files: [{ name: 'a.sql', text }], dialect: 'postgres', options: { shouldStop: () => 'cancelled' } });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([]);
    expect(result.stopped).toMatchObject({ reason: 'cancelled', statementsRead: 0, tablesUnread: 3, at: { file: 'a.sql', line: 1 } });
    expect(result.tablesFound).toBe(3);
    expect(stopEntries(result.ledger, 'cancelled').map((e) => e.count)).toEqual([3]);
  });

  it('never asked to stop: no stop, the same result as without the options', () => {
    const { text } = tables(0, 5);
    const files = [{ name: 'a.sql', text }];
    const plain = sqlDdlToDbml({ files, dialect: 'postgres' });
    const watched = sqlDdlToDbml({ files, dialect: 'postgres', options: { shouldStop: () => undefined, onProgress: () => {} } });
    expect(watched).toEqual(plain);
    expect('stopped' in watched).toBe(false);
  });

  it('says once that the reading ended, after the last statement, whether or not it stopped (and before converting what it read)', () => {
    const { text } = tables(0, 6);
    for (const shouldStop of [undefined, stopAt(3).shouldStop, stopAt(0).shouldStop]) {
      const events: string[] = [];
      sqlDdlToDbml({
        files: [{ name: 'a.sql', text }, { name: 'b.sql', text: tables(6, 2).text }],
        dialect: 'postgres',
        options: {
          ...(shouldStop ? { shouldStop: () => { const r = shouldStop(); events.push(r ? 'stop' : 'ask'); return r; } } : {}),
          onProgress: () => { events.push('progress'); },
          onReadingEnd: () => { events.push('end'); },
        },
      });
      expect(events.filter((e) => e === 'end')).toHaveLength(1);
      expect(events[events.length - 1]).toBe('end');
    }
  });

  it('counts as found only the tables a full reading would: never an IF NOT EXISTS of a table already defined, or a #temp table', () => {
    const cases: Array<{ dialect: 'postgres' | 'sqlserver'; files: SqlDdlFile[] }> = [
      {
        // An idempotent migration: the second CREATE of users does nothing.
        dialect: 'postgres',
        files: [
          { name: '001.sql', text: 'CREATE TABLE users (id INTEGER PRIMARY KEY);\nCREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER);\n' },
          { name: '002.sql', text: 'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY);\nCREATE TABLE IF NOT EXISTS items (id INTEGER);\nCREATE TABLE IF NOT EXISTS Items (id INTEGER);\n' },
        ],
      },
      {
        // SQL Server scratch tables are never the design.
        dialect: 'sqlserver',
        files: [
          { name: 'a.sql', text: 'CREATE TABLE dbo.users (id INT PRIMARY KEY);\nCREATE TABLE #staging (id INT);\nCREATE TABLE ##shared (id INT);\nCREATE TABLE dbo.orders (id INT);\n' },
        ],
      },
    ];
    for (const { dialect, files } of cases) {
      const full = sqlDdlToDbml({ files, dialect });
      const found = full.ok ? full.tablesFound : -1;
      const statements = files.reduce((n, f) => n + f.text.split(';').length - 1, 0);
      for (let at = 0; at < statements; at++) {
        const stopped = sqlDdlToDbml({ files, dialect, options: { shouldStop: stopAt(at).shouldStop } });
        // However early it stops, it finds what a full reading finds: read + reported = found.
        expect({ at, found: stopped.tablesFound }).toEqual({ at, found });
        const read = stopped.ok ? stopped.tableCount : 0;
        expect(read + (stopped.stopped?.tablesUnread ?? 0)).toBe(found);
      }
    }
  });

  it('reports progress after every statement, statements and tables read rising to the whole text', () => {
    const one = tables(0, 3);
    const two = tables(3, 3);
    const seen: SqlConvertProgress[] = [];
    const result: SqlDdlToDbmlResult = sqlDdlToDbml({
      files: [{ name: 'one.sql', text: one.text }, { name: 'two.sql', text: `${two.text}CREATE VIEW v AS SELECT 1;\n` }],
      dialect: 'postgres',
      options: { onProgress: (p) => seen.push({ ...p }) },
    });
    expect(result.ok).toBe(true);
    expect(seen.map((p) => p.statementsRead)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(seen.map((p) => p.tablesRead)).toEqual([1, 2, 3, 4, 5, 6, 6]);
    expect(seen.map((p) => p.filesRead)).toEqual([0, 0, 0, 1, 1, 1, 1]);
    expect(seen.every((p) => p.files === 2)).toBe(true);
    const fractions = seen.map((p) => p.fraction);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions);
    expect(fractions[fractions.length - 1]).toBeCloseTo(1, 2);
  });
});
