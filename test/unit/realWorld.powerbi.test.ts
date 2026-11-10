/**
 * The two real Power BI samples (test/fixtures/real-world-imports/powerbi-*)
 * through the Power BI converter and Import DBML's own planner, against
 * what their files say (ANALYSIS.md): TMDL date/time columns typed by their
 * UnderlyingDateTimeDataType annotation, descriptions kept byte for byte,
 * every model feature an ERD has no place for named in the ledger (with its
 * table and, for TMDL, its line), the BIM's Date key kept on its isKey
 * column with date_key unique, and the model named after its folder. And
 * conservation: every table, column and relationship of the source is
 * imported or reported.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { planDbmlImport, suggestDbmlSubjectAreaName, type DbmlImportPlan } from '../../src/services/dbmlImport';
import { readDbml } from '../../src/services/dbmlImportParse';
import { ledgerLeftOut, ledgerNotes, ledgerTotals, type LedgerEntry } from '../../src/services/importLedger';
import {
  SEMANTIC_MODEL_META,
  findSemanticModels,
  readSemanticModel,
  semanticModelToDbml,
  type SemanticModel,
  type SemanticModelFile,
} from '../../src/services/semanticModelImport';

const ROOT = path.resolve(__dirname, '../fixtures/real-world-imports');

function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

/** The sample's model as the command reads it: found under its folder, its files (and Fabric's .platform) read. */
function sample(slug: string): { model: SemanticModel; files: SemanticModelFile[]; entryName: string } {
  const folder = path.join(ROOT, slug);
  const rel = walk(folder).map((p) => `${slug}/${p}`);
  const [entry] = findSemanticModels(rel.filter((p) => /\.(tmdl|bim)$/i.test(p)));
  const files = entry.files.map((p) => ({ path: p, text: fs.readFileSync(path.join(ROOT, p), 'utf-8') }));
  const platform = `${entry.root}/.platform`;
  if (fs.existsSync(path.join(ROOT, platform))) files.push({ path: platform, text: fs.readFileSync(path.join(ROOT, platform), 'utf-8') });
  const read = readSemanticModel(files);
  if (!read.ok) throw new Error(JSON.stringify(read.problems));
  return { model: read.model, files, entryName: entry.name };
}

function plan(dbml: string): DbmlImportPlan {
  const read = readDbml(dbml);
  if (!read.ok) throw new Error(JSON.stringify(read.diagnostics));
  return planDbmlImport({
    model: read.model, layer: 'main', subjectAreaName: 's', fileName: 's.dbml',
    library: { findTableName: () => null, getTable: () => null }, libraryRelationships: true,
  });
}

/** The ledger's lost entries of one `what`, as `table[.column]` names. */
function lostNames(ledger: readonly LedgerEntry[], what: string): string[] {
  return ledger.filter((e) => e.outcome === 'lost' && e.what === what)
    .map((e) => (e.where?.column ? `${e.where.table}.${e.where.column}` : e.where?.table ?? ''));
}

/** `/// …` lines of every table and column in the TMDL, joined as the reader joins them. */
function tmdlDescriptions(files: readonly SemanticModelFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files.filter((x) => /\/tables\/[^/]+\.tmdl$/.test(x.path))) {
    const lines = f.text.split(/\r?\n/);
    let doc: string[] = [];
    let table = '';
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('///')) { doc.push(t.slice(3).trim()); continue; }
      const m = /^(\t*)(table|column) ('(?:[^']|'')+'|[^\s=]+)/.exec(line);
      if (m) {
        const name = m[3].startsWith("'") ? m[3].slice(1, -1).replace(/''/g, "'") : m[3];
        if (m[2] === 'table') table = name;
        const text = doc.join('\n').trim();
        if (text) out.set(m[2] === 'table' ? table : `${table}.${name}`, text);
      }
      if (t !== '') doc = [];
    }
  }
  return out;
}

describe('real world: SM_SalesSense (TMDL, Fabric Git layout)', () => {
  const { model, files } = sample('powerbi-tmdl-salessense');
  const result = semanticModelToDbml(model);
  const imported = plan(result.dbml);
  const col = (table: string, column: string) => imported.newTables.find((t) => t.name === table)?.columns.find((c) => c.name === column);

  it('types the 9 date-only and 2 time-only dateTime columns from their UnderlyingDateTimeDataType annotation', () => {
    const types = imported.newTables.flatMap((t) => t.columns.map((c) => c.dataType));
    expect(types.filter((x) => x === 'date')).toHaveLength(9);
    expect(types.filter((x) => x === 'time')).toHaveLength(2);
    expect(types.filter((x) => x === 'timestamp')).toHaveLength(0);
    expect(col('calendar', 'date')?.dataType).toBe('date');
    expect(col('customer', 'birthday')?.dataType).toBe('date');
    expect(col('sales', 'time')?.dataType).toBe('time');
    expect(col('costs', 'time')?.dataType).toBe('time');
    // Counted in the notes, with where.
    const change = result.ledger.filter((e) => e.outcome === 'changed' && e.unit === 'type');
    expect(change.reduce((n, e) => n + e.count, 0)).toBe(11);
    expect(change.every((e) => e.where?.file?.endsWith('.tmdl') && typeof e.where.line === 'number')).toBe(true);
    expect(ledgerNotes(result.ledger).join('\n')).toMatch(/9 types: dateTime → date/);
  });

  it('keeps every description byte for byte (no full stop added)', () => {
    const source = tmdlDescriptions(files);
    let checked = 0;
    for (const [key, text] of source) {
      const [tableName, columnName] = key.split('.');
      const t = model.tables.find((x) => x.name === tableName);
      if (!t || t.kind === 'calculationGroup') continue;
      const table = imported.newTables.find((x) => x.meta?.[SEMANTIC_MODEL_META.name] === tableName || x.name === tableName.toLowerCase());
      const got = columnName
        ? table?.columns.find((c) => (c.meta?.[SEMANTIC_MODEL_META.name] ?? c.name) === columnName)?.description
        : table?.description;
      expect(got, key).toBe(text);
      checked++;
    }
    expect(checked).toBe(7);
    expect(imported.newTables.find((t) => t.name === 'customer')?.description).toBe('Customer data');
  });

  it('names the hierarchies, roles and their row filters, the perspective, translations, M expressions and report settings it does not keep', () => {
    expect(lostNames(result.ledger, 'hierarchy')).toEqual(['Calendar.Year-Month-Day', 'Product.Product Hierarchy']);
    expect(lostNames(result.ledger, 'security role')).toEqual(['Store - Canada', 'Store - United States']);
    expect(lostNames(result.ledger, 'row filter')).toEqual(['Store', 'Store']);
    expect(lostNames(result.ledger, 'perspective')).toEqual(['Sales']);
    expect(lostNames(result.ledger, 'translated caption')).toEqual(['pt-PT']);
    expect(lostNames(result.ledger, 'Q&A linguistic metadata')).toEqual(['en-US']);
    expect(lostNames(result.ledger, 'Power Query parameter').sort()).toEqual(['Database', 'Randomizer', 'Server']);
    expect(lostNames(result.ledger, 'KPI')).toEqual(['Sales.Margin']);
    for (const setting of ['formatString', 'sortByColumn', 'dataCategory', 'summarizeBy', 'isDefaultLabel']) {
      expect(lostNames(result.ledger, setting).length, setting).toBeGreaterThan(0);
    }
    expect(lostNames(result.ledger, 'isDefaultLabel')).toEqual(['Customer.Customer', 'Store.Store']);
    // Each with its file and line (TMDL), so the log can point at it.
    const hierarchy = result.ledger.find((e) => e.what === 'hierarchy' && e.where?.table === 'Calendar');
    expect(hierarchy?.where).toMatchObject({ file: expect.stringMatching(/tables\/Calendar\.tmdl$/), line: 155 });
    // The calculation groups' own settings go with their tables (already reported).
    expect(result.ledger.some((e) => e.outcome === 'lost' && /Smart Calcs|Time Intelligence/.test(e.where?.table ?? ''))).toBe(false);
    const leftOut = ledgerLeftOut(result.ledger).join('\n');
    expect(leftOut).toMatch(/2 objects: hierarchy not kept/);
    expect(leftOut).toMatch(/2 objects: security role not kept/);
  });

  it('keeps the warehouse table each M partition reads, following the shared expression it starts from', () => {
    const source = (name: string) => imported.newTables.find((t) => t.name === name)?.meta?.[SEMANTIC_MODEL_META.source];
    expect(source('customer')).toBe('raw.customer');
    expect(source('product')).toBe('raw.product');
    expect(source('store')).toBe('raw.store');
    // Sales and Costs start from SalesDateAdjustedAndSalesRandomized, which navigates to raw.sales.
    expect(source('sales')).toBe('raw.sales');
    expect(source('costs')).toBe('raw.sales');
    // Calendar is generated in M (it only reads the expression inside a step); About is a literal #table.
    expect(source('calendar')).toBeUndefined();
    expect(source('about')).toBeUndefined();
    expect(lostNames(result.ledger, 'Power Query source').sort()).toEqual(['About', 'Calendar']);
    // The calculated table keeps its own note, not a source.
    expect(source('field_parameter')).toBeUndefined();
  });

  it('is named after its folder, as Fabric\'s .platform names it', () => {
    expect(model.name).toBe('SM_SalesSense');
    expect(result.dbml).toContain('Converted from the Power BI semantic model SM_SalesSense.');
  });

  it('conserves: every source table and column imported or reported; the ledger counts the skipped', () => {
    const totals = ledgerTotals(result.ledger);
    expect(totals.skipped.table).toBe(2); // the calculation groups
    expect(totals.skipped.object).toBe(27 + 11); // measures, and the calculation items with their groups
    const sourceTables = model.tables.length;
    expect(result.tableCount + (totals.skipped.table ?? 0)).toBe(sourceTables);
    const sourceColumns = model.tables.filter((t) => t.kind !== 'calculationGroup').reduce((n, t) => n + t.columns.length, 0);
    expect(imported.newTables.reduce((n, t) => n + t.columns.length, 0)).toBe(sourceColumns);
    expect(result.refCount + (totals.skipped.relationship ?? 0)).toBe(model.relationships.length);
  });
});

describe('real world: AdventureWorks tabular model (model.bim)', () => {
  const { model, entryName } = sample('powerbi-bim-adventureworks');
  const result = semanticModelToDbml(model);
  const imported = plan(result.dbml);
  const date = imported.newTables.find((t) => t.name === 'date')!;

  it('is named after the folder holding Model.bim, not the TMSL default "SemanticModel"', () => {
    expect(model.name).toBe('AsPartitionProcessing.AdventureWorks');
    expect(model.name).toBe(entryName);
    expect(result.dbml).toContain('Converted from the Power BI semantic model AsPartitionProcessing.AdventureWorks.');
    const read = readDbml(result.dbml);
    expect(read.ok && suggestDbmlSubjectAreaName(read.model, `${entryName}.dbml`)).not.toMatch(/semantic-?model/i);
  });

  it('keys Date on date_key, which all 6 Date relationships join, and keeps date (isKey from Mark as date table) unique — and says so', () => {
    expect(date.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)).toEqual(['date_key']);
    expect(date.columns.find((c) => c.name === 'date')?.meta).toMatchObject({ dbml: { unique: true } });
    expect(result.warnings).toContain('Date: every relationship joins date_key, so it is the key; date, which Mark as date table flags isKey, is marked unique.');
    expect(imported.relationships.filter((r) => r.toModel === 'date').every((r) => r.toColumn === 'date_key')).toBe(true);
    expect(result.ledger).toContainEqual(expect.objectContaining({ outcome: 'changed', unit: 'primaryKey', what: 'date table key', where: expect.objectContaining({ table: 'Date', column: 'DateKey' }) }));
    // The six dimensions with no key get the one column relationships point at, counted in one note.
    const inferred = result.ledger.filter((e) => e.unit === 'primaryKey' && e.cause === 'inferred' && e.what === 'inferred key');
    expect(inferred.map((e) => e.where?.table).sort()).toEqual(['Customer', 'Employee', 'Geography', 'Product', 'Product Category', 'Product Subcategory']);
  });

  it('names every Gap 5 feature: hierarchies, the date-table marking, sortByColumn, the variation, the role with its row filter and column permission, the perspective, the data source', () => {
    expect(lostNames(result.ledger, 'hierarchy')).toEqual(['Date.Calendar', 'Date.Fiscal', 'Product.Category', 'Employee.Organization']);
    expect(lostNames(result.ledger, 'Mark as date table')).toEqual(['Date']);
    expect(lostNames(result.ledger, 'sortByColumn')).toEqual(['Date.EnglishMonthName']);
    expect(lostNames(result.ledger, 'variation')).toEqual(['Internet Sales.OrderDate']);
    expect(lostNames(result.ledger, 'security role')).toEqual(['General Users']);
    expect(lostNames(result.ledger, 'row filter')).toEqual(['Geography']);
    expect(lostNames(result.ledger, 'column permission')).toEqual(['Customer.Phone']);
    expect(lostNames(result.ledger, 'perspective')).toEqual(['Internet Sales']);
    expect(lostNames(result.ledger, 'data source')).toEqual(['AdventureWorks']);
    expect(lostNames(result.ledger, 'KPI')).toHaveLength(2);
    // Every one rendered in the draft's Not imported list.
    const leftOut = ledgerLeftOut(result.ledger).join('\n');
    for (const what of ['hierarchy', 'Mark as date table', 'sortByColumn', 'variation', 'security role', 'row filter', 'column permission', 'perspective', 'data source']) {
      expect(leftOut, what).toContain(what);
    }
  });

  it('keeps each table\'s warehouse table from its M navigation', () => {
    expect(imported.newTables.find((t) => t.name === 'internet_sales')?.meta?.[SEMANTIC_MODEL_META.source]).toBe('dbo.FactInternetSales');
    expect(date.meta?.[SEMANTIC_MODEL_META.source]).toBe('dbo.DimDate');
  });

  it('conserves: 9 tables, 174 columns and 13 relationships, nothing lost silently', () => {
    expect(result.tableCount).toBe(9);
    expect(imported.newTables.reduce((n, t) => n + t.columns.length, 0)).toBe(174);
    expect(result.refCount).toBe(13);
    expect(ledgerTotals(result.ledger).skipped.object).toBe(21);
  });
});
