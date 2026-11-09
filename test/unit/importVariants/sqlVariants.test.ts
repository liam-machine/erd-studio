/**
 * The SQL variant corpus: one schema (`sampleSpec`) written every way the
 * generator knows (`sqlSpec.ts`) in every dialect, each held to
 * conservation — every table and relationship the files hold is imported or
 * reported, never lost without a word:
 *
 *   tables:        imported + reported (problems)                 = source
 *   relationships: imported + reported (Not imported, the ledger) = source
 *
 * A failed import (`ok: false`) reports everything (the user is told nothing
 * was imported), so it conserves too; it must still name a problem.
 *
 * Beyond conservation, every variant not in {@link KNOWN_GAPS} must import
 * whole. A package that fixes a class deletes its entries here, so the
 * corpus ratchets: the test prints the gaps that now read whole.
 */
import { describe, expect, it } from 'vitest';
import { convertSqlDdl, SQL_DIALECTS, type SqlDialect } from '../../../src/services/sqlDdlImport';
import { dbmlCoreSqlEngine } from '../../../src/services/sqlImportEngine';
import { ledgerTotals } from '../../../src/services/importLedger';
import {
  PLACEHOLDER_SYNTAXES,
  sampleSpec,
  specToDdl,
  specTruth,
  TRAILING_OPTIONS,
  type PlaceholderSyntax,
  type VariantKnobs,
} from './sqlSpec';

type Variant = [label: string, knobs: Omit<VariantKnobs, 'dialect'>];

function permutations(items: readonly number[]): number[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]));
}

function variantsOf(dialect: SqlDialect): Variant[] {
  const options = TRAILING_OPTIONS[dialect].map((_o, i) => i);
  return [
    ['plain', {}],
    ['crlf', { lineEnding: '\r\n' }],
    ['bom', { bom: true }],
    ['lower keywords', { keywordCase: 'lower' }],
    ['mixed keywords', { keywordCase: 'mixed' }],
    ['quoted names', { quoting: 'dialect' }],
    ['crlf + bom + lower + quoted', { lineEnding: '\r\n', bom: true, keywordCase: 'lower', quoting: 'dialect' }],
    ['fk per alter', { fkStyle: 'alter' }],
    ['fk alter list', { fkStyle: 'alterList' }],
    ['file per table', { filePerTable: true, fkStyle: 'alter' }],
    ['huge (200 copies)', { copies: 200 }],
    ...(Object.keys(PLACEHOLDER_SYNTAXES) as PlaceholderSyntax[]).map((p): Variant => [`placeholder ${p}`, { placeholder: p }]),
    ...permutations(options).map((order): Variant => [`options ${order.join(',')}`, { trailingOptions: order }]),
    ['comment before options', { trailingOptions: [0], tableCommentFirst: true }],
  ];
}

/**
 * Variant classes today's converter does not import whole, by `dialect:label`
 * (a `*` dialect: every one), with the package that owns the fix. Delete an
 * entry when its class is fixed; the test then holds it to a whole import.
 */
const KNOWN_GAPS: Readonly<Record<string, string>> = {
  // sql-core fixed: template placeholders (sqlDdlPlaceholders.ts) and trailing options in any order (sqlDdlRepair.ts) read whole.
  // sql-fidelity fixed: every item of an ALTER TABLE action list is read (sqlDdlStatements.ts).
};

const gapOf = (dialect: SqlDialect, label: string): string | undefined => KNOWN_GAPS[`${dialect}:${label}`] ?? KNOWN_GAPS[`*:${label}`];

describe('the variant generator', () => {
  it('knows the truth of the sample spec', () => {
    expect(specTruth(sampleSpec())).toEqual({ tables: 5, columns: 19, primaryKeys: 5, relationships: 5, requiredRelationships: 3, uniqueKeys: 1, descriptions: 3 });
    expect(specTruth(sampleSpec(), 3).tables).toBe(15);
  });

  it('writes what its knobs say', () => {
    const { files } = specToDdl(sampleSpec(), { dialect: 'postgres', lineEnding: '\r\n', bom: true, keywordCase: 'lower', quoting: 'dialect', placeholder: 'jinja' });
    const text = files[0].text;
    expect(text.startsWith('﻿')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/);
    expect(text).toContain('create table {{ schema }}."customer"');
    expect(specToDdl(sampleSpec(), { dialect: 'sqlserver', quoting: 'dialect' }).files[0].text).toContain('[order_line]');
    expect(specToDdl(sampleSpec(), { dialect: 'mysql', filePerTable: true, fkStyle: 'alter' }).files.map((f) => f.name)).toEqual([
      'customer.sql', 'orders.sql', 'order_line.sql', 'shipment.sql', 'customer_profile.sql', 'zz_constraints.sql',
    ]);
  });
});

describe('SQL variants conserve every table and relationship', () => {
  const nowWhole: string[] = [];

  for (const dialect of SQL_DIALECTS) {
    for (const [label, knobs] of variantsOf(dialect)) {
      it(`${dialect}: ${label}`, () => {
        const { files, truth } = specToDdl(sampleSpec(), { dialect, ...knobs });
        const result = convertSqlDdl({ files, dialect }, dbmlCoreSqlEngine);
        const gap = gapOf(dialect, label);
        if (!result.ok) {
          // Nothing imported, and the user is told why.
          expect(result.problems.length, `${dialect} ${label}`).toBeGreaterThan(0);
          expect(gap, `${dialect} ${label} failed: ${result.problems[0]?.message}`).toBeDefined();
          return;
        }
        const totals = ledgerTotals(result.ledger);
        const tablesReported = (totals.problem.table ?? 0) + (totals.lost.table ?? 0);
        const relationshipsReported = (totals.problem.relationship ?? 0) + (totals.lost.relationship ?? 0)
          + result.skipped.filter((line) => /foreign key/i.test(line)).length;
        const whole = result.tableCount === truth.tables && result.refCount === truth.relationships;
        if (gap) {
          if (whole) nowWhole.push(`${dialect}:${label}`);
          // Conservation at least: nothing counted twice; every table imported or reported.
          expect(result.tableCount + tablesReported, `${dialect} ${label} tables`).toBe(truth.tables);
          expect(result.refCount + relationshipsReported, `${dialect} ${label} relationships`).toBeLessThanOrEqual(truth.relationships);
          return;
        }
        expect({ tables: result.tableCount, relationships: result.refCount }, `${dialect} ${label}`).toEqual({ tables: truth.tables, relationships: truth.relationships });
        expect(result.problems, `${dialect} ${label}`).toEqual([]);
        expect(result.tablesFound, `${dialect} ${label}`).toBe(truth.tables);
      });
    }
  }

  it('lists the known gaps that now import whole (delete them from KNOWN_GAPS)', () => {
    if (nowWhole.length) console.log(`Known gaps that now import whole: ${nowWhole.join('; ')}`);
  });
});
