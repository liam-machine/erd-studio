/**
 * The SQL fidelity variant corpus (`importVariants/sqlFidelitySpec.ts`):
 * one schema whose structure is declared every way real scripts declare it,
 * in every dialect, held to its truth end to end — converted, then read and
 * planned by Import DBML exactly as Import SQL DDL… does:
 *
 *  - every table, in schema `shop`, with each column's type as written;
 *  - every unique key, from wherever it was declared, and none that was
 *    dropped again;
 *  - every relationship from its FK side, with its cardinality (an FK that
 *    is its table's whole key, or unique, is one-to-one; part of a key is
 *    many-to-one), its ON DELETE action listed by Import, and nothing extra;
 *  - the descriptions, exactly.
 */
import { describe, expect, it } from 'vitest';
import { convertSqlDdl, SQL_DIALECTS, type SqlDdlToDbmlResult } from '../../src/services/sqlDdlImport';
import { dbmlCoreSqlEngine } from '../../src/services/sqlImportEngine';
import { readDbml, type DbmlModel } from '../../src/services/dbmlImportParse';
import { planDbmlImport, type DbmlImportPlan } from '../../src/services/dbmlImport';
import { fidelitySpecToDdl, fidelityVariants, type FidelityTruth } from './importVariants/sqlFidelitySpec';

const canon = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const normType = (t: string): string => t.toLowerCase().replace(/[[\]"`]/g, '').replace(/\s+/g, ' ').replace(/\s*([(),<>])\s*/g, '$1').trim();

function plan(dbml: string): { model: DbmlModel; plan: DbmlImportPlan } {
  const read = readDbml(dbml);
  if (!read.ok) throw new Error(`Import DBML rejected the output: ${JSON.stringify(read.diagnostics)}\n${dbml}`);
  return {
    model: read.model,
    plan: planDbmlImport({
      model: read.model,
      layer: 'main',
      subjectAreaName: 'variant',
      fileName: 'variant.sql',
      library: { findTableName: () => null, getTable: () => null },
      libraryRelationships: true,
    }),
  };
}

/** What the import got, in the truth's terms. */
function imported(result: Extract<SqlDdlToDbmlResult, { ok: true }>): FidelityTruth & { actions: string[] } {
  const { model, plan: p } = plan(result.dbml);
  const groups = new Map<string, DbmlImportPlan['relationships']>();
  for (const r of p.relationships) {
    const key = r.compositeKey ? `${r.fromModel}:${r.compositeKey}` : `${r.fromModel}.${r.fromColumn}>${r.toModel}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return {
    schema: [...new Set(model.tables.map((t) => t.schema ?? ''))].join(','),
    tables: p.newTables.map((t) => ({
      name: t.name,
      columns: (t.columns ?? []).map((c) => ({ name: c.name, type: c.dataType })),
      ...(t.description ? { description: t.description } : {}),
      ...((t.columns ?? []).some((c) => c.description) ? { columnDescriptions: Object.fromEntries((t.columns ?? []).filter((c) => c.description).map((c) => [c.name, c.description as string])) } : {}),
    })),
    uniques: model.tables.flatMap((t) => [
      ...t.fields.filter((f) => f.unique && !f.pk).map((f) => ({ table: t.name, columns: [f.name] })),
      ...t.indexes.filter((ix) => ix.unique && !ix.pk).map((ix) => ({ table: t.name, columns: ix.columns.map((c) => c.value) })),
    ]),
    relationships: [...groups.values()].map((rs) => ({
      from: rs[0].fromModel,
      fromColumns: rs.map((r) => r.fromColumn),
      to: rs[0].toModel,
      toColumns: rs.map((r) => r.toColumn),
      cardinality: rs[0].cardinality as 'many-to-one' | 'one-to-one',
    })),
    actions: p.report.dropped.filter((d) => d.kind === 'reference-settings').map((d) => d.what),
  };
}

describe('SQL fidelity variants import as their truth', () => {
  for (const dialect of SQL_DIALECTS) {
    for (const [label, knobs] of fidelityVariants(dialect)) {
      it(`${dialect}: ${label}`, () => {
        const { files, truth } = fidelitySpecToDdl(knobs);
        const result = convertSqlDdl({ files, dialect }, dbmlCoreSqlEngine);
        if (!result.ok) throw new Error(`${dialect} ${label}: ${JSON.stringify(result.problems)}\n${files.map((f) => f.text).join('\n')}`);
        expect(result.problems, `${dialect} ${label} problems`).toEqual([]);
        const got = imported(result);

        // Tables, in schema shop, and every column's type as written.
        expect(canon(got.schema), `${dialect} ${label} schema`).toBe('shop');
        expect(got.tables.map((t) => t.name).sort()).toEqual(truth.tables.map((t) => t.name).sort());
        for (const t of truth.tables) {
          const g = got.tables.find((x) => x.name === t.name)!;
          expect(g.columns.map((c) => `${c.name} ${normType(c.type)}`), `${dialect} ${label} ${t.name} types`)
            .toEqual(t.columns.map((c) => `${c.name} ${normType(c.type)}`));
          if (t.description) expect(g.description, `${dialect} ${label} ${t.name} description`).toBe(t.description);
          for (const [column, text] of Object.entries(t.columnDescriptions ?? {})) {
            expect(g.columnDescriptions?.[column], `${dialect} ${label} ${t.name}.${column} description`).toBe(text);
          }
        }

        // Unique keys from wherever declared; none of the dropped ones.
        const key = (u: { table: string; columns: string[] }): string => `${canon(u.table)}(${u.columns.map(canon).sort().join(',')})`;
        expect(got.uniques.map(key).sort(), `${dialect} ${label} unique keys`).toEqual(truth.uniques.map(key).sort());

        // Relationships from the FK side, with their cardinality, and nothing extra.
        const rel = (r: { from: string; fromColumns: string[]; to: string; cardinality: string }): string =>
          `${canon(r.from)}(${r.fromColumns.map(canon).join(',')})>${canon(r.to)} ${r.cardinality}`;
        expect(got.relationships.map(rel).sort(), `${dialect} ${label} relationships`).toEqual(truth.relationships.map(rel).sort());

        // FK actions travel on the Ref: Import's reference-settings report lists each.
        for (const r of truth.relationships.filter((x) => x.onDelete)) {
          expect(got.actions.some((a) => a.includes(`${r.from}.${r.fromColumns[0]}`) && a.includes(`delete: ${r.onDelete}`)), `${dialect} ${label} ${r.from} ON DELETE ${r.onDelete}`).toBe(true);
        }
      });
    }
  }
});
