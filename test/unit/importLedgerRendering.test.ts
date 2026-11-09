/**
 * The loss ledger in what an import shows: the dry run's notes and Not
 * imported list, the fallback modal, the draft's drawer and banner, and the
 * dbt draft — and the "not lost" claim made only when it is true (Bug 9).
 */
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LAYERS } from '@erd-studio/core';
import {
  dedupeLines,
  describeDbmlImportPlan,
  importLeftOut,
  importPlanNotes,
  planDbmlImport,
  summariseDbmlImportPlan,
  type DbmlImportPlan,
  type DescribeDbmlImportOptions,
} from '../../src/services/dbmlImport';
import { readDbml } from '../../src/services/dbmlImportParse';
import { buildDbtDraft, listDraftScopes, suggestSubjectAreaName, type DraftScope } from '../../src/services/dbtDraft';
import { draftFromDbt, draftFromImportPlan } from '../../src/services/draftModel';
import { createLedger, type LedgerEntry } from '../../src/services/importLedger';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { toDraftView } from '../../src/types/draft';
import type { ManifestData } from '../../src/types/manifest';
import type { YmlData } from '../../src/types/ymlData';

const DBML = `Table customer {
  id int [pk]
  email varchar [not null, unique]
}
Table orders {
  id int [pk]
  customer_id int [not null, default: 0]
}
Ref: orders.customer_id > customer.id
`;

function planOf(text: string): DbmlImportPlan {
  const read = readDbml(text);
  if (!read.ok) throw new Error(JSON.stringify(read.diagnostics));
  return planDbmlImport({
    model: read.model, layer: 'main', subjectAreaName: 'shop',
    library: { findTableName: () => null, getTable: () => null },
    libraryRelationships: true, diagramHoldsNoRelationships: true,
  });
}

function sqlLedger(): LedgerEntry[] {
  const ledger = createLedger();
  ledger.problem('table', 'grammarGap', 'CREATE TABLE', { file: 'a.sql', line: 12, table: 'film' });
  ledger.lost('column', 'noField', 'UNSIGNED', { table: 'orders', column: 'id' });
  ledger.changed('column', 'normalised', 'WITH TIME ZONE', { table: 'orders', column: 'placed_at' }, 'kept in the type');
  ledger.skipped('statement', 'notDesign', 'view', { file: 'a.sql' }, undefined, 3);
  return ledger.entries;
}

const SQL_ORIGIN = (ledger: LedgerEntry[] = sqlLedger()): DescribeDbmlImportOptions => ({
  layerLabel: 'Main',
  dbml: { relationshipsFiles: ['main/relationships/main.dbml'] },
  origin: { from: 'from 1 SQL file (MySQL)', notes: [], skipped: ['a.sql: skipped 3 views', 'a.sql: skipped 3 views.'], ledger, notice: '1 table could not be read; Show details lists it.' },
});

describe('the ledger in the dry run', () => {
  it('notes list what was changed, grouped and counted, after the existing notes', () => {
    const notes = importPlanNotes(planOf(DBML), SQL_ORIGIN());
    expect(notes[notes.length - 1]).toBe('1 column: WITH TIME ZONE kept in the type (orders.placed_at).');
  });

  it('Not imported leads with what could not be read, then what was lost, and never says a line twice', () => {
    expect(importLeftOut(planOf(DBML), SQL_ORIGIN())).toEqual([
      '1 table: CREATE TABLE could not be read: not in the SQL grammar (film)',
      '1 column: UNSIGNED not kept: ERD Studio has no field for it (orders.id)',
      'a.sql: skipped 3 views',
    ]);
    expect(dedupeLines(['A b.', 'a  B', 'c'])).toEqual(['A b.', 'c']);
  });

  it('the plain-text dry run and the modal say the same', () => {
    const text = describeDbmlImportPlan(planOf(DBML), SQL_ORIGIN());
    expect(text).toContain('Not imported:\n• 1 table: CREATE TABLE could not be read: not in the SQL grammar (film).\n• 1 column: UNSIGNED');
    expect(text.match(/skipped 3 views/g)).toHaveLength(1);
    expect(text).toContain('• 1 column: WITH TIME ZONE kept in the type (orders.placed_at).');
    const modal = summariseDbmlImportPlan(planOf(DBML), SQL_ORIGIN());
    expect(modal.detail).toContain('• Not imported: 1 table: CREATE TABLE could not be read: not in the SQL grammar (film); and 2 more.');
  });

  it('a plan with its own ledger renders it too (the DBML importer\'s own changes)', () => {
    const p = planOf(DBML);
    p.report.ledger.push({ outcome: 'changed', unit: 'default', cause: 'normalised', what: '0.0 written 0', count: 4 });
    expect(importPlanNotes(p, { dbml: { relationshipsFiles: [] } })).toContain('4 defaults: 0.0 written 0 changed on the way: written differently.');
  });
});

describe('"so they are not lost" (Bug 9)', () => {
  const claim = (notes: readonly string[]): string | undefined => notes.find((n) => /kept in the table files/.test(n));

  it('a DBML file with nothing lost may say it', () => {
    expect(claim(importPlanNotes(planOf(DBML), { dbml: { relationshipsFiles: [] } }))).toBe(
      'Not null, defaults, indexes and other details ERD Studio has no field for are kept in the table files, so they are not lost.');
  });

  it('never for a conversion: SQL or a semantic model may have lost what its DBML never held', () => {
    // An empty conversion ledger is not proof: the converter's own losses are not all counted yet (sakila: UNSIGNED, ON UPDATE…).
    for (const ledger of [[], sqlLedger()]) {
      expect(claim(importPlanNotes(planOf(DBML), SQL_ORIGIN(ledger)))).toBe(
        'Not null, defaults and other details ERD Studio has no field for are kept in the table files.');
    }
    expect(describeDbmlImportPlan(planOf(DBML), SQL_ORIGIN([]))).not.toContain('not lost');
  });

  it('nor for a DBML file whose import lost something', () => {
    const p = planOf(DBML);
    p.report.ledger.push({ outcome: 'lost', unit: 'setting', cause: 'noField', what: 'composite key name', count: 1, where: { table: 'customer' } });
    expect(claim(importPlanNotes(p, {}))).toBe('Not null, defaults, indexes and other details ERD Studio has no field for are kept in the table files.');
  });
});

describe('the ledger in the draft', () => {
  it('the origin\'s notice is the banner\'s, unless the draft was redrawn', () => {
    const plan = planOf(DBML);
    const input = {
      plan, importSource: 'sql' as const, trigger: 'sidebar' as const,
      target: { layer: 'main', layerLabel: 'Main', name: 'shop', diagramFile: '.erd-studio/main/diagrams/shop.dbml' },
      fileName: 'a.sql', describe: SQL_ORIGIN(), libraryTable: () => undefined,
      layers: [{ id: 'main', label: 'Main', abbreviation: 'MN', color: '#888888', creatable: true, order: 1 }],
      logicalOnly: true, hasFolder: true, changeOptions: true,
    };
    const draft = draftFromImportPlan(input);
    expect(draft.banner.notice).toBe('1 table could not be read; Show details lists it.');
    expect(draftFromImportPlan({ ...input, notice: 'Redrawn.' }).banner.notice).toBe('Redrawn.');
    const view = toDraftView(draft);
    const left = view.details.find((s) => s.id === 'leftOut');
    expect(left?.items.map((i) => i.text)).toEqual([
      '1 table: CREATE TABLE could not be read: not in the SQL grammar (film)',
      '1 column: UNSIGNED not kept: ERD Studio has no field for it (orders.id)',
      'a.sql: skipped 3 views',
    ]);
    expect(draft.summary.leftOut).toBe(3);
  });
});

describe('the ledger in a dbt draft', () => {
  const DBT_ROOT = path.join(__dirname, '../fixtures/dbt-project');
  let ymlData: YmlData;
  let manifest: ManifestData | undefined;
  let scopes: DraftScope[];

  beforeAll(async () => {
    ymlData = await new YmlParserService().loadYmlData(DBT_ROOT);
    manifest = await new ManifestService({ parseInProcess: true }).loadManifest(DBT_ROOT);
    scopes = listDraftScopes({ ymlData, manifest, projectRoot: DBT_ROOT, modelPaths: ['models'] });
  });

  it('has a Notes section and Not drawn lines from the draft\'s ledger, counted in the summary', () => {
    const scope = scopes.find((s) => s.id === 'folder:gold')!;
    const built = buildDbtDraft({ modelNames: scope.modelNames, ymlData, manifest, libraryHas: () => false });
    // The gold folder's one undrawn link (fct_task_event.task_key → dim_task in silver) is a
    // skipped entry: counted for conservation, listed in Not drawn by undrawnLinks, never rendered twice.
    expect(built.ledger).toEqual([expect.objectContaining({
      outcome: 'skipped', unit: 'relationship', what: 'link to a model not drawn', detail: 'to dim_task',
      where: { table: 'fct_task_event', column: 'task_key' },
    })]);
    const draw = (ledger: LedgerEntry[]) => draftFromDbt({
      draft: { ...built, ledger }, relationships: built.relationships, scope, scopes, trigger: 'prompt',
      target: { layer: 'gold', layerLabel: 'Gold', name: suggestSubjectAreaName(scope), diagramFile: '.erd-studio/gold/diagrams/gold.dbml' },
      libraryTable: () => undefined, layers: DEFAULT_LAYERS,
    });
    const plain = draw([]);
    // A DBML target always gets the layer-schema note (dbtLayerSchemaNote); nothing from a ledger.
    const plainNotes = plain.details?.find((s) => s.id === 'notes')?.items.map((i) => i.text) ?? [];
    expect(plainNotes.every((t) => !/changed on the way/.test(t))).toBe(true);
    expect(plain.summary.notes).toBe(plainNotes.length);
    const ledger = createLedger();
    ledger.changed('column', 'inferred', 'not_null kept', { table: 'fct_order', column: 'customer_id' });
    ledger.lost('relationship', 'notInFiles', 'to a model not drawn', { table: 'fct_order', column: 'location_id' });
    const draft = draw(ledger.entries);
    expect(draft.details?.find((s) => s.id === 'notes')?.items.map((i) => i.text)).toEqual([
      ...plainNotes, '1 column: not_null kept changed on the way: inferred (fct_order.customer_id).']);
    expect(draft.details?.find((s) => s.id === 'leftOut')?.items.map((i) => i.text)).toContain(
      '1 relationship: to a model not drawn not kept: not in the files (fct_order.location_id).');
    expect(draft.summary.notes).toBe(plain.summary.notes + 1);
    expect(draft.summary.leftOut).toBe(plain.summary.leftOut + 1);
  });
});
