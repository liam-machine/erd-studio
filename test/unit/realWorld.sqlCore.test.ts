/**
 * sql-core against the six real published SQL samples
 * (`test/fixtures/real-world-imports/`): every one imports every table it
 * holds through the command's own steps (gather, the detected dialect, the
 * converter), the dialect ranking picks the dialect the files are in, and
 * the start screen counts what the import reads. Four of them imported
 * nothing before the repair ladder (one bad statement stopped the rest).
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { gatherSqlFiles, readAsDialects, sqlPartialNotice } from '../../src/commands/importSqlDdl';
import { sqlScriptTableCount } from '../../src/services/importSources';
import { detectSqlDialect, rankSqlDialectReadings, rankSqlDialects, type SqlDialect } from '../../src/services/sqlDdlImport';
import * as engine from '../../src/services/sqlImportEngine';

const ROOT = path.join(__dirname, '../fixtures/real-world-imports');
const fsUi = {
  readDirectory: async (folder: string) => fs.readdirSync(folder, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
  readFile: async (file: string) => fs.readFileSync(file, 'utf-8'),
  fileSize: async (file: string) => fs.statSync(file).size,
};

const SAMPLES: ReadonlyArray<{ slug: string; source: { files: string[] } | { folder: string }; dialect: SqlDialect; tables: number; before: number }> = [
  // 16: payment's 55 ATTACHed partitions fold into payment (sqlDdlPartitions.ts); 71 with each kept as a table.
  { slug: 'postgres-pagila', source: { files: ['postgres-pagila/pagila-schema.sql'] }, dialect: 'postgres', tables: 16, before: 0 },
  { slug: 'mysql-sakila', source: { files: ['mysql-sakila/sakila-schema.sql'] }, dialect: 'mysql', tables: 16, before: 16 },
  { slug: 'sqlserver-adventureworks', source: { files: ['sqlserver-adventureworks/instawdb.sql'] }, dialect: 'sqlserver', tables: 71, before: 0 },
  { slug: 'snowflake-grid-reliability', source: { folder: 'snowflake-grid-reliability/scripts' }, dialect: 'snowflake', tables: 18, before: 0 },
  { slug: 'databricks-open-retail-data-model', source: { folder: 'databricks-open-retail-data-model/canonical-core' }, dialect: 'databricks', tables: 34, before: 0 },
  { slug: 'migrations-harbor', source: { folder: 'migrations-harbor/make/migrations/postgresql' }, dialect: 'postgres', tables: 48, before: 48 },
];

async function gather(source: { files: string[] } | { folder: string }) {
  const sources = 'folder' in source ? { folder: path.join(ROOT, source.folder) } : { files: source.files.map((f) => path.join(ROOT, f)) };
  const gathered = await gatherSqlFiles(sources, fsUi);
  if ('message' in gathered) throw new Error(gathered.message);
  return gathered;
}

describe('the real-world SQL samples import every table', () => {
  for (const sample of SAMPLES) {
    it(`${sample.slug}: ${sample.tables} tables (was ${sample.before}), nothing reported as unreadable`, async () => {
      const { files } = await gather(sample.source);
      const dialect = detectSqlDialect(files.map((f) => f.text).join('\n'));
      expect(dialect).toBe(sample.dialect);
      const result = engine.sqlDdlToDbml({ files, dialect: sample.dialect });
      if (!result.ok) throw new Error(JSON.stringify(result.problems.slice(0, 3)));
      expect(result.tableCount).toBe(sample.tables);
      expect(result.problems).toEqual([]);
      expect(sqlPartialNotice(result)).toBeUndefined();
      // Nothing was salvaged without a grammar: every table read by one, as written or rewritten.
      expect(result.readWith?.salvaged).toBe(0);
    });
  }

  it('each sample\'s dialect ranks first when every dialect reads it (the quick path and the pick agree with the detection)', async () => {
    for (const sample of SAMPLES) {
      const { files } = await gather(sample.source);
      const text = files.map((f) => f.text).join('\n');
      const readings = readAsDialects(engine, files, rankSqlDialects(text));
      expect(rankSqlDialectReadings([...readings.values()], detectSqlDialect(text))[0].dialect, sample.slug).toBe(sample.dialect);
    }
  }, 60000);
});

describe('what the samples needed, as ledger entries (repaired, never silent)', () => {
  const ledgerOf = async (slug: string) => {
    const sample = SAMPLES.find((s) => s.slug === slug)!;
    const { files } = await gather(sample.source);
    const result = engine.sqlDdlToDbml({ files, dialect: sample.dialect });
    if (!result.ok) throw new Error('not ok');
    return result.ledger.filter((e) => e.outcome === 'repaired');
  };

  it('pagila: the PostgreSQL 18 VIRTUAL column on film', async () => {
    expect(await ledgerOf('postgres-pagila')).toContainEqual(expect.objectContaining({ what: 'VIRTUAL generated column', where: expect.objectContaining({ table: 'public.film', column: 'length_hours', line: 453 }) }));
  });

  it('adventureworks: the typed XML columns, kept as written', async () => {
    const xml = (await ledgerOf('sqlserver-adventureworks')).filter((e) => e.what === 'XML type');
    expect(xml.reduce((n, e) => n + e.count, 0)).toBe(6);
  });

  it('snowflake: COMMENT before CLUSTER BY on 8 tables, and VECTOR / FILE_FORMAT on the unstructured ones', async () => {
    const entries = await ledgerOf('snowflake-grid-reliability');
    expect(entries.filter((e) => e.cause === 'trailingOption')).toHaveLength(8);
    expect(entries.some((e) => e.what === 'VECTOR type')).toBe(true);
    expect(entries.some((e) => e.what === 'names like keywords')).toBe(true);
  });

  it('databricks: the ${catalog}.${schema} placeholders, one entry per file', async () => {
    const entries = (await ledgerOf('databricks-open-retail-data-model')).filter((e) => e.cause === 'templatePlaceholder');
    expect(entries.length).toBeGreaterThanOrEqual(34);
    expect(entries.every((e) => e.where?.file && e.where.line)).toBe(true);
  });
});

describe('the start screen counts what the import reads', () => {
  it('sakila: 16 tables (a procedure body\'s CREATE TEMPORARY TABLE is not one; it said 17)', () => {
    const file = path.join(ROOT, 'mysql-sakila/sakila-schema.sql');
    expect(sqlScriptTableCount(file, fs.readFileSync(file, 'utf-8'))).toBe(16);
  });

  it('databricks: templated ${catalog}.${schema} tables are found (the start screen showed the example instead)', async () => {
    const { files } = await gather({ folder: 'databricks-open-retail-data-model/canonical-core' });
    expect(files.reduce((n, f) => n + sqlScriptTableCount(f.name, f.text), 0)).toBe(34);
  });
});
