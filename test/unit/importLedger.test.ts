import { describe, expect, it } from 'vitest';
import {
  createLedger,
  ledgerHasLosses,
  ledgerLeftOut,
  ledgerLogLines,
  ledgerNotes,
  ledgerText,
  ledgerTotals,
  savedOptionalNote,
  type LedgerEntry,
} from '../../src/services/importLedger';

describe('the import ledger', () => {
  it('counts the same thing in the same place together, and keeps entries plain JSON', () => {
    const ledger = createLedger();
    ledger.lost('column', 'noField', 'UNSIGNED', { file: 'a.sql', table: 'film', column: 'length' });
    ledger.lost('column', 'noField', 'UNSIGNED', { file: 'a.sql', table: 'film', column: 'length' });
    ledger.lost('column', 'noField', 'UNSIGNED', { file: 'a.sql', table: 'film', column: 'rating' });
    ledger.skipped('statement', 'notDesign', 'view', { file: 'a.sql' }, undefined, 3);
    expect(ledger.entries).toHaveLength(3);
    expect(ledger.entries[0].count).toBe(2);
    expect(JSON.parse(JSON.stringify(ledger.entries))).toEqual(ledger.entries);
    // A zero count records nothing; an empty where is left off.
    ledger.changed('type', 'normalised', 'x', {}, undefined, 0);
    ledger.changed('type', 'normalised', 'x', {});
    expect(ledger.entries[3]).toEqual({ outcome: 'changed', unit: 'type', cause: 'normalised', what: 'x', count: 1 });
  });

  it('merges ledgers from other modules (a result crossing the bundle)', () => {
    const a = createLedger();
    a.problem('table', 'parseError', 'CREATE TABLE', { file: 'a.sql', line: 3, table: 'x' });
    const b = createLedger(a.entries);
    b.merge(a.entries);
    expect(b.entries).toEqual([{ outcome: 'problem', unit: 'table', cause: 'parseError', what: 'CREATE TABLE', count: 2, where: { file: 'a.sql', line: 3, table: 'x' } }]);
  });

  it('totals by outcome and unit, and says whether anything was lost', () => {
    const ledger = createLedger();
    ledger.repaired('statement', 'trailingOption', 'CLUSTER BY', { file: 'a.sql', line: 4 });
    ledger.changed('column', 'normalised', 'WITH TIME ZONE', undefined, undefined, 5);
    ledger.changed('column', 'normalised', 'UNSIGNED');
    expect(ledgerTotals(ledger.entries)).toEqual({ lost: {}, changed: { column: 6 }, repaired: { statement: 1 }, skipped: {}, problem: {} });
    expect(ledgerHasLosses(ledger.entries)).toBe(false);
    ledger.lost('relationship', 'noField', 'FK action');
    expect(ledgerHasLosses(ledger.entries)).toBe(true);
    expect(ledgerHasLosses([{ outcome: 'problem', unit: 'table', cause: 'parseError', what: 'x', count: 1 }])).toBe(true);
  });

  it('groups notes by what, with the count, the plural and a few names', () => {
    const ledger = createLedger();
    for (const t of ['rental', 'payment', 'film', 'actor', 'staff']) ledger.changed('column', 'normalised', 'WITH TIME ZONE', { table: t, column: 'last_update' }, 'kept in the type');
    ledger.repaired('statement', 'trailingOption', 'CLUSTER BY', { file: 'a.sql', line: 1, table: 'one' });
    ledger.lost('column', 'noField', 'UNSIGNED', { table: 'film' });
    expect(ledgerNotes(ledger.entries)).toEqual([
      '5 columns: WITH TIME ZONE kept in the type (rental.last_update, payment.last_update, film.last_update and 2 more).',
      '1 statement: CLUSTER BY rewritten so it reads: a table option (one).',
    ]);
    expect(ledgerLeftOut(ledger.entries)).toEqual(['1 column: UNSIGNED not kept: ERD Studio has no field for it (film).']);
  });

  it('a group whose entries give different details falls back to the cause', () => {
    const ledger = createLedger();
    ledger.lost('relationship', 'noField', 'FK action', { table: 'a' }, 'ON DELETE CASCADE');
    ledger.lost('relationship', 'noField', 'FK action', { table: 'b' }, 'ON UPDATE SET NULL');
    expect(ledgerLeftOut(ledger.entries)).toEqual(['2 relationships: FK action not kept: ERD Studio has no field for it (a, b).']);
  });

  it('lists what could not be read before what was lost', () => {
    const ledger = createLedger();
    ledger.lost('column', 'noField', 'UNSIGNED');
    ledger.problem('table', 'grammarGap', 'CREATE TABLE', { file: 'x.sql', line: 9, table: 'film' });
    const lines = ledgerLeftOut(ledger.entries);
    expect(lines[0]).toMatch(/^1 table: CREATE TABLE could not be read/);
    expect(lines[1]).toMatch(/^1 column: UNSIGNED/);
  });

  it('caps the number of lines, the last one counting the rest', () => {
    const ledger = createLedger();
    for (let i = 0; i < 7; i++) ledger.lost('column', 'noField', `detail ${i}`);
    const lines = ledgerLeftOut(ledger.entries, { max: 3 });
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('And 5 more: ERD Studio: Show Logs lists every one.');
    expect(ledgerLeftOut(ledger.entries, { max: 7 })).toHaveLength(7);
    expect(ledgerLeftOut(ledger.entries)).toHaveLength(7);
  });

  it('never renders more than a name or a short fixed phrase: no file text, newlines or escapes', () => {
    const sql = 'CREATE TABLE x (\n  a int -- a comment\r\n)'.repeat(20);
    const entries: LedgerEntry[] = [{
      outcome: 'problem', unit: 'table', cause: 'parseError', what: sql, count: 1,
      where: { file: 'a.sql', line: 2, table: 'n'.repeat(300), column: 'c\nd' }, detail: `mismatched input\\r\\n ${sql}`,
    }];
    for (const line of [...ledgerLeftOut(entries), ...ledgerLogLines(entries, 'Import SQL DDL')]) {
      expect(line).not.toMatch(/[\r\n]/);
      expect(line).not.toMatch(/\\[rn]/);
      expect(line.length).toBeLessThan(300);
    }
    expect(ledgerText('C:\\new\\table.sql', 100)).toBe('C:\\new\\table.sql');
  });

  it('logs one line per entry with the file and line; skipped entries only with a line', () => {
    const ledger = createLedger();
    ledger.problem('table', 'parseError', 'CREATE TABLE', { file: 'db/a.sql', line: 12, table: 'film' }, 'VIRTUAL generated column');
    ledger.skipped('statement', 'notDesign', 'view', { file: 'db/a.sql' }, undefined, 4);
    ledger.skipped('statement', 'notDesign', 'view', { file: 'db/a.sql', line: 30, table: 'v_sales' });
    ledger.changed('column', 'normalised', 'UNSIGNED', undefined, undefined, 3);
    expect(ledgerLogLines(ledger.entries, 'Import SQL DDL')).toEqual([
      'Import SQL DDL: db/a.sql line 12: table film: problem, parseError: CREATE TABLE (VIRTUAL generated column)',
      'Import SQL DDL: 3 × column: changed, normalised: UNSIGNED',
      'Import SQL DDL: db/a.sql line 30: statement v_sales: skipped, notDesign: view',
    ]);
  });

  it('renders the one D18 sentence every source shares, with a count the scorecard can read', () => {
    expect(savedOptionalNote(0, 10)).toBe('');
    expect(savedOptionalNote(1)).toBe('Every relationship is saved as optional (?: its foreign key may be empty), as ERD Studio saves them all. In the source, 1 relationship was not optional (its foreign key columns are NOT NULL).');
    const note = savedOptionalNote(40, 96);
    expect(note).toBe('Every relationship is saved as optional (?: its foreign key may be empty), as ERD Studio saves them all. In the source, 40 relationships were not optional (their foreign key columns are NOT NULL); the other 56 may be empty.');
    expect(Number(note.match(/(\d+) (?:references?|relationships?)[^.]*not optional|(\d+) required/i)?.slice(1).find(Boolean))).toBe(40);
  });
});
