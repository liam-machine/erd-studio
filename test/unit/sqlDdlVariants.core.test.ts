/**
 * The sql-core variant corpus: the sample spec (`importVariants/sqlSpec.ts`)
 * written with each repair-ladder class (an exotic type, a column named like
 * a keyword, a column modifier), a table no dialect reads, a routine whose
 * body holds a CREATE TABLE, template placeholders and trailing options —
 * alone and combined, in every dialect, with the file noise knobs — held to
 * a whole import (or, for the broken table, exactly one reported problem and
 * everything else imported). The generator knows the truth, so nothing here
 * hand-counts a sample.
 */
import { describe, expect, it } from 'vitest';

import { convertSqlDdl, SQL_DIALECTS, type SqlDialect } from '../../src/services/sqlDdlImport';
import { dbmlCoreSqlEngine } from '../../src/services/sqlImportEngine';
import { PLACEHOLDER_SYNTAXES, sampleSpec, specToDdl, TRAILING_OPTIONS, type ExtraColumnClass, type PlaceholderSyntax, type VariantKnobs } from './importVariants/sqlSpec';

type Knobs = Omit<VariantKnobs, 'dialect'>;
const CLASSES: readonly ExtraColumnClass[] = ['exoticType', 'keywordColumn', 'modifier'];

function variants(dialect: SqlDialect): Array<[string, Knobs]> {
  const allOptions = TRAILING_OPTIONS[dialect].map((_o, i) => i);
  return [
    ...CLASSES.map((c): [string, Knobs] => [c, { extras: [c] }]),
    ['every class', { extras: CLASSES }],
    ['every class, quoted, crlf, bom, lower keywords', { extras: CLASSES, quoting: 'dialect', lineEnding: '\r\n', bom: true, keywordCase: 'lower' }],
    ['every class + trailing options reversed', { extras: CLASSES, trailingOptions: [...allOptions].reverse() }],
    ['every class + comment before options', { extras: CLASSES, trailingOptions: allOptions, tableCommentFirst: true }],
    ['every class + fk per alter, file per table', { extras: CLASSES, fkStyle: 'alter', filePerTable: true }],
    ['a broken table', { brokenTable: true }],
    ['a broken table, file per table', { brokenTable: true, filePerTable: true, fkStyle: 'alter' }],
    ['a routine holding a CREATE TABLE', { routine: true }],
    ['everything at once', { extras: CLASSES, brokenTable: true, routine: true, trailingOptions: allOptions, quoting: 'dialect' }],
    ...(Object.keys(PLACEHOLDER_SYNTAXES) as PlaceholderSyntax[]).map((p): [string, Knobs] => [`placeholder ${p} + every class`, { placeholder: p, extras: CLASSES }]),
    ['huge (100 copies) + every class', { copies: 100, extras: CLASSES }],
  ];
}

/** Classes a dialect's files cannot hold at all (not a gap: the dialect has no such thing). */
const NOT_APPLICABLE: ReadonlySet<string> = new Set([
  // A `{{ schema }}."x"` qualifier needs a quoted name after it; fine everywhere. Nothing excluded yet.
]);

describe('sql-core variants import whole (or report exactly what did not read)', () => {
  for (const dialect of SQL_DIALECTS) {
    for (const [label, knobs] of variants(dialect)) {
      if (NOT_APPLICABLE.has(`${dialect}:${label}`)) continue;
      it(`${dialect}: ${label}`, () => {
        const { files, truth } = specToDdl(sampleSpec(), { dialect, ...knobs });
        const result = convertSqlDdl({ files, dialect }, dbmlCoreSqlEngine);
        if (!result.ok) throw new Error(`${dialect} ${label}: ${JSON.stringify(result.problems.slice(0, 3))}`);
        expect({ tables: result.tableCount, relationships: result.refCount }, `${dialect} ${label}`).toEqual({ tables: truth.tables, relationships: truth.relationships });
        const unreadable = truth.unreadableTables ?? 0;
        expect(result.problems.map((p) => p.table?.replace(/^.*\./, '')), `${dialect} ${label}`).toEqual(Array(unreadable).fill('broken'));
        expect(result.tablesFound, `${dialect} ${label}`).toBe(truth.tables + unreadable);
        // Every column the spec writes (and every extra one) is in the DBML: the repairs never drop a column.
        const columnLines = result.dbml.split('\n').filter((l) => /^ {2}"/.test(l)).length;
        expect(columnLines, `${dialect} ${label} columns`).toBe(truth.columns);
        // Conservation in the ledger: every table that did not read is a problem entry with its line.
        const problems = result.ledger.filter((e) => e.outcome === 'problem' && e.unit === 'table');
        expect(problems.reduce((n, e) => n + e.count, 0)).toBe(unreadable);
        for (const e of problems) expect(e.where?.line).toBeGreaterThan(0);
      });
    }
  }
});
