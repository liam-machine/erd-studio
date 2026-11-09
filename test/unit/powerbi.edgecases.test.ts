/**
 * The Power BI importer under attack: inputs the two real samples and the
 * variant corpus (`semanticModelImport.variants.test.ts`) do not hold, each a
 * class of file seen in the wild — TMDL quoting and line endings, TMDL
 * scripts, incremental refresh, measure tables, DAX functions and calendars,
 * workbooks navigated like warehouses, non-Latin names, model names that
 * break a line, UTF-16 files, hostile nesting and size.
 *
 * Each case holds the conservation invariant: no throw; every source table,
 * column, relationship and model feature is imported, or named in a shown
 * string (a warning, the skipped list or a ledger line) with its place; no
 * message echoes the file; and the DBML always reads back whole.
 */

import { describe, expect, it } from 'vitest';

import { isUnreadModelFile, modelPathPrefix, unreadModelFormat } from '../../src/commands/importSemanticModel';
import { planDbmlImport, type DbmlImportPlan } from '../../src/services/dbmlImport';
import { readDbml } from '../../src/services/dbmlImportParse';
import { ledgerLeftOut, ledgerNotes, type LedgerEntry } from '../../src/services/importLedger';
import {
  SEMANTIC_MODEL_META,
  cleanModelName,
  decodeSemanticModelFile,
  describeMSource,
  findSemanticModels,
  isImportableName,
  readSemanticModel,
  semanticModelToDbml,
  toSnakeCaseName,
  unquoteTmdlValue,
  type SemanticModel,
  type SemanticModelFile,
  type SemanticModelToDbmlResult,
} from '../../src/services/semanticModelImport';

const T = '\t';
const tmdl = (path: string, lines: string[], eol = '\n'): SemanticModelFile => ({ path: `Edge.SemanticModel/definition/${path}`, text: lines.join(eol) });
const bim = (model: unknown, db: Record<string, unknown> = {}): SemanticModelFile[] => [
  { path: 'Edge.SemanticModel/model.bim', text: JSON.stringify({ name: 'SemanticModel', compatibilityLevel: 1567, ...db, model }) },
];

function read(files: SemanticModelFile[]): { model: SemanticModel; warnings: string[] } {
  const r = readSemanticModel(files);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return { model: r.model, warnings: r.warnings };
}

function plan(dbml: string): DbmlImportPlan {
  const r = readDbml(dbml);
  if (!r.ok) throw new Error(`${JSON.stringify(r.diagnostics)}\n${dbml}`);
  return planDbmlImport({
    model: r.model, layer: 'main', subjectAreaName: 's', fileName: 's.dbml',
    library: { findTableName: () => null, getTable: () => null }, libraryRelationships: true,
  });
}

/** Read, convert and import; every string the user is shown. */
function importAll(files: SemanticModelFile[]): { model: SemanticModel; result: SemanticModelToDbmlResult; imported: DbmlImportPlan; shown: string } {
  const { model, warnings } = read(files);
  const result = semanticModelToDbml(model);
  const imported = plan(result.dbml);
  const shown = [...warnings, ...result.warnings, ...result.skipped, ...ledgerNotes(result.ledger, { max: 1000 }), ...ledgerLeftOut(result.ledger, { max: 1000 })].join('\n');
  return { model, result, imported, shown };
}

const lost = (ledger: readonly LedgerEntry[], what: string): LedgerEntry[] => ledger.filter((e) => e.outcome === 'lost' && e.what === what);
const table = (p: DbmlImportPlan, name: string) => p.newTables.find((t) => t.name === name);

// ---------------------------------------------------------------------------
// TMDL format
// ---------------------------------------------------------------------------

describe('TMDL property values wrapped in double quotes', () => {
  it('unwraps a whole quoted value (a doubled quote inside is one), and leaves a format with quoted text inside alone', () => {
    expect(unquoteTmdlValue('"dd/mm/yyyy"')).toBe('dd/mm/yyyy');
    expect(unquoteTmdlValue('"She said ""hi"""')).toBe('She said "hi"');
    expect(unquoteTmdlValue('"Q"q yyyy')).toBe('"Q"q yyyy');
    expect(unquoteTmdlValue('"Week "ww"!"')).toBe('"Week "ww"!"');
    expect(unquoteTmdlValue('int64')).toBe('int64');
  });

  it('reads a quoted dataType, formatString and description as the values they quote', () => {
    const { imported } = importAll([tmdl('tables/T.tmdl', [
      'table T',
      `${T}column D`,
      `${T}${T}dataType: dateTime`,
      `${T}${T}formatString: "dd/mm/yyyy"`,
      `${T}${T}description: "  Padded, so TMDL quotes it  "`,
      `${T}column E`,
      `${T}${T}dataType: "int64"`,
    ])]);
    const columns = table(imported, 't')!.columns;
    expect(columns.map((c) => c.dataType)).toEqual(['date', 'bigint']);
    expect(columns[0].description).toBe('Padded, so TMDL quotes it');
  });
});

describe('TMDL /// descriptions keep their indentation', () => {
  it('drops only the one space after ///, so an indented bullet stays indented, through Import DBML', () => {
    const { imported } = importAll([tmdl('tables/T.tmdl', [
      '/// Header',
      '///   - indented bullet',
      '///',
      '/// after a blank line',
      'table T',
      `${T}/// Column note`,
      `${T}///${T}tabbed`,
      `${T}column a`,
      `${T}${T}dataType: string`,
    ])]);
    expect(table(imported, 't')!.description).toBe('Header\n  - indented bullet\n\nafter a blank line');
    expect(table(imported, 't')!.columns[0].description).toBe(`Column note\n${T}tabbed`);
  });
});

describe('TMDL line endings', () => {
  it.each([['LF', '\n'], ['CRLF', '\r\n'], ['a lone CR (classic Mac)', '\r']])('%s reads the same tables, columns and ref order', (_label, eol) => {
    const files = [
      tmdl('model.tmdl', ['model Model', `${T}culture: en-US`, '', 'ref table B', 'ref table A'], eol),
      tmdl('tables/A.tmdl', ['table A', `${T}column a1`, `${T}${T}dataType: int64`, `${T}column a2`, `${T}${T}dataType: string`], eol),
      tmdl('tables/B.tmdl', ['table B', `${T}column b1`, `${T}${T}dataType: int64`], eol),
    ];
    const { imported } = importAll(files);
    expect(imported.newTables.map((t) => `${t.name}:${t.columns.map((c) => c.name).join(',')}`)).toEqual(['b:b1', 'a:a1,a2']);
  });
});

describe('TMDL scripts', () => {
  it('reads tables inside createOrReplace → database → model (the TMDL view\'s whole-database script)', () => {
    const { model, imported } = importAll([tmdl('script.tmdl', [
      'createOrReplace',
      '',
      `${T}database 'Retail Sales'`,
      `${T}${T}compatibilityLevel: 1567`,
      '',
      `${T}${T}model Model`,
      `${T}${T}${T}culture: en-US`,
      '',
      `${T}${T}${T}table Orders`,
      `${T}${T}${T}${T}column OrderKey`,
      `${T}${T}${T}${T}${T}dataType: int64`,
      '',
      `${T}${T}${T}table Customer`,
      `${T}${T}${T}${T}column CustomerKey`,
      `${T}${T}${T}${T}${T}dataType: int64`,
      '',
      `${T}${T}${T}relationship r1`,
      `${T}${T}${T}${T}fromColumn: Orders.OrderKey`,
      `${T}${T}${T}${T}toColumn: Customer.CustomerKey`,
    ])]);
    expect(imported.newTables.map((t) => t.name)).toEqual(['orders', 'customer']);
    expect(imported.relationships).toHaveLength(1);
    expect(model.name).toBe('Edge');
  });
});

describe('nameless objects are named in a warning with their place, never dropped silently', () => {
  it('a TMDL column with no name: a warning with its table, file and line', () => {
    const { imported, shown } = importAll([tmdl('tables/T.tmdl', ['table T', `${T}column`, `${T}${T}dataType: string`, `${T}column b`, `${T}${T}dataType: string`])]);
    expect(table(imported, 't')!.columns.map((c) => c.name)).toEqual(['b']);
    expect(shown).toMatch(/A column in table T \(T\.tmdl, line 2\) has no name, so it was skipped\./);
  });

  it('a TMDL table with no name is a problem with its line (its columns go with it); the other tables still import', () => {
    const r = readSemanticModel([tmdl('tables/T.tmdl', ['table', `${T}column a`, `${T}${T}dataType: string`]), tmdl('tables/U.tmdl', ['table U', `${T}column u`])]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model.tables.map((t) => t.name)).toEqual(['U']);
    expect(r.problems).toEqual([{ file: 'Edge.SemanticModel/definition/tables/T.tmdl', line: 1, message: 'A table has no name.' }]);
    expect(r.model.ledger).toEqual([expect.objectContaining({ outcome: 'problem', unit: 'table', what: 'TMDL table with no name', where: { file: 'Edge.SemanticModel/definition/tables/T.tmdl', line: 1 } })]);
  });

  it('a TMDL relationship with no name is still read', () => {
    const { imported } = importAll([
      tmdl('tables/F.tmdl', ['table F', `${T}column k`, `${T}${T}dataType: int64`]),
      tmdl('tables/D.tmdl', ['table D', `${T}column k`, `${T}${T}dataType: int64`]),
      tmdl('relationships.tmdl', ['relationship', `${T}fromColumn: F.k`, `${T}toColumn: D.k`]),
    ]);
    expect(imported.relationships).toHaveLength(1);
  });

  it('a TMSL column with no name, and a relationship that is not an object: warnings naming them', () => {
    const { imported, shown } = importAll(bim({
      tables: [{ name: 'T', columns: [{ dataType: 'string' }, { name: '  ' }, 'junk', { name: 'b', dataType: 'string' }] }],
      relationships: ['junk'],
    }));
    expect(table(imported, 't')!.columns.map((c) => c.name)).toEqual(['b']);
    expect(shown).toMatch(/Column 1 of table T in model\.bim has no name/);
    expect(shown).toMatch(/Column 2 of table T in model\.bim has no name/);
    expect(shown).toMatch(/Column 3 of table T in model\.bim has no name/);
    expect(shown).toMatch(/Relationship 1 in model\.bim is not an object/);
  });
});

// ---------------------------------------------------------------------------
// TMSL wrappers
// ---------------------------------------------------------------------------

describe('TMSL scripts around the database', () => {
  const database = { name: 'Retail', model: { tables: [{ name: 'T', columns: [{ name: 'a', dataType: 'string' }] }] } };
  it.each([
    ['createOrReplace', { createOrReplace: { object: { database: 'Retail' }, database } }],
    ['create', { create: { database } }],
    ['a bare { database }', { database }],
    ['a sequence of operations (Tabular Editor deployment)', { sequence: { maxParallelism: 1, operations: [{ refresh: { type: 'full' } }, { createOrReplace: { object: { database: 'Retail' }, database } }] } }],
  ])('%s', (_label, json) => {
    const r = readSemanticModel([{ path: 'Retail/deploy.bim', text: JSON.stringify(json) }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.tables.map((t) => t.name)).toEqual(['T']);
  });
});

// ---------------------------------------------------------------------------
// Tables an ERD cannot hold
// ---------------------------------------------------------------------------

describe('measure tables (tables with only measures, no columns)', () => {
  it('are named as not drawn, with their measures counted, and the rest imports (DBML refuses a table with no columns)', () => {
    const { result, imported, shown } = importAll(bim({
      tables: [
        { name: '_Measures', measures: [{ name: 'Total Sales', expression: 'SUM(Sales[Amount])', kpi: { targetExpression: '1' } }, { name: 'Orders', expression: 'COUNTROWS(Sales)' }] },
        { name: 'Key Measures', columns: [{ name: 'RowNumber-2662979B-1795-4F74-8F37-6A1BA8059B61', dataType: 'int64', isHidden: true, type: 'rowNumber' }], measures: [{ name: 'Margin', expression: '1' }] },
        { name: 'Empty', columns: [] },
        { name: 'Sales', columns: [{ name: 'Amount', dataType: 'decimal' }] },
      ],
    }));
    expect(imported.newTables.map((t) => t.name)).toEqual(['sales']);
    expect(lost(result.ledger, 'table with no columns').map((e) => [e.where?.table, e.detail])).toEqual([
      ['_Measures', 'not drawn: it holds only measures'],
      ['Key Measures', 'not drawn: it holds only measures'],
      ['Empty', 'not drawn: it has no columns'],
    ]);
    expect(result.skippedCounts.measures).toBe(3);
    expect(shown).toMatch(/_Measures/);
    expect(shown).toMatch(/Key Measures/);
    expect(shown).toMatch(/Empty/);
    // Its KPI is still named, as any measure's is.
    expect(lost(result.ledger, 'KPI').map((e) => e.where?.table)).toEqual(['_Measures']);
    expect(result.renamed.map((r) => r.from)).toEqual(['Sales', 'Amount']);
  });

  it('a relationship into one says why it was skipped', () => {
    const { result } = importAll(bim({
      tables: [{ name: 'M', columns: [] }, { name: 'S', columns: [{ name: 'k', dataType: 'int64' }] }],
      relationships: [{ fromTable: 'S', fromColumn: 'k', toTable: 'M', toColumn: 'k' }],
    }));
    expect(result.skipped).toContain('Relationship S[k] → M[k]: M has no columns.');
  });
});

// ---------------------------------------------------------------------------
// Model features new in 2025: DAX user-defined functions, calendars
// ---------------------------------------------------------------------------

describe('DAX user-defined functions and calendars are named as not kept', () => {
  it('TMDL: function objects and a table\'s calendar, with their file and line', () => {
    const { result, shown } = importAll([
      tmdl('functions.tmdl', ['function AddTax = (amount : NUMERIC) => amount * 1.1', '', 'function \'Fiscal Year\' =', `${T}${T}(d : DATETIME) =>`, `${T}${T}YEAR(EDATE(d, 6))`]),
      tmdl('tables/Date.tmdl', ['table Date', `${T}column Date`, `${T}${T}dataType: dateTime`, `${T}${T}formatString: Long Date`, '', `${T}calendar 'Fiscal Calendar'`, `${T}${T}calendarColumnGroup = year`, `${T}${T}${T}primaryColumn: Date`]),
    ]);
    expect(lost(result.ledger, 'DAX function').map((e) => [e.where?.table, e.where?.line])).toEqual([['AddTax', 1], ['Fiscal Year', 3]]);
    expect(lost(result.ledger, 'calendar').map((e) => [e.where?.table, e.where?.column, e.where?.line])).toEqual([['Date', 'Fiscal Calendar', 6]]);
    expect(shown).toMatch(/DAX function not kept/);
    expect(shown).toMatch(/calendar not kept/);
  });

  it('TMSL: model.functions and table.calendars', () => {
    const { result } = importAll(bim({
      tables: [{ name: 'Date', columns: [{ name: 'Date', dataType: 'dateTime' }], calendars: [{ name: 'Gregorian' }] }],
      functions: [{ name: 'AddTax', expression: '(x) => x * 1.1' }],
    }));
    expect(lost(result.ledger, 'DAX function')).toHaveLength(1);
    expect(lost(result.ledger, 'calendar')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Where rows come from
// ---------------------------------------------------------------------------

describe('M sources', () => {
  it('a workbook sheet or table navigated like a warehouse table is a file source, not a warehouse table', () => {
    expect(describeMSource('let\n  Source = Excel.Workbook(File.Contents("C:\\x.xlsx"), null, true),\n  S = Source{[Item="Sales",Kind="Sheet"]}[Data]\nin S').kind).toBe('file');
    expect(describeMSource('let\n  Source = Excel.Workbook(Web.Contents("https://x/y.xlsx")),\n  T = Source{[Item="tblSales",Kind="Table"]}[Data]\nin T').kind).toBe('file');
    expect(describeMSource('let\n  Source = SharePoint.Tables("https://x", [ApiVersion = 15]),\n  L = Source{[Id="abc"]}[Items]\nin L').kind).toBe('file');
    // A database query that also reads a file still navigates its table.
    expect(describeMSource('let\n  Map = Csv.Document(File.Contents("m.csv")),\n  Source = Sql.Database("s", "d"),\n  T = Source{[Schema="dbo",Item="Fact"]}[Data]\nin T')).toEqual({ kind: 'navigation', table: 'dbo.Fact' });
    expect(describeMSource('let\n  Source = PostgreSQL.Database("h", "db"),\n  public_orders = Source{[Schema="public",Item="orders"]}[Data]\nin public_orders')).toEqual({ kind: 'navigation', table: 'public.orders' });
  });

  it('an incremental-refresh table (policyRange partitions) reads its refreshPolicy sourceExpression: TMDL and TMSL', () => {
    const m = ['let', '    Source = Sql.Database("srv", "dw"),', '    T = Source{[Schema="dbo",Item="FactSales"]}[Data],', '    F = Table.SelectRows(T, each [Date] >= RangeStart and [Date] < RangeEnd)', 'in', '    F'];
    const viaTmdl = importAll([tmdl('tables/Sales.tmdl', [
      'table Sales',
      `${T}column Amount`,
      `${T}${T}dataType: decimal`,
      '',
      `${T}refreshPolicy`,
      `${T}${T}policyType: basic`,
      `${T}${T}rollingWindowGranularity: year`,
      `${T}${T}sourceExpression =`,
      ...m.map((l) => `${T}${T}${T}${T}${l}`),
      '',
      `${T}partition Sales-2023 = policyRange`,
      `${T}${T}mode: import`,
      `${T}${T}start: 2023-01-01T00:00:00`,
      `${T}${T}end: 2024-01-01T00:00:00`,
      `${T}${T}granularity: year`,
    ])]);
    const viaTmsl = importAll(bim({
      tables: [{
        name: 'Sales', columns: [{ name: 'Amount', dataType: 'decimal' }],
        refreshPolicy: { policyType: 'basic', sourceExpression: m },
        partitions: [{ name: 'Sales-2023', source: { type: 'policyRange', start: '2023-01-01T00:00:00', end: '2024-01-01T00:00:00', granularity: 'year' } }],
      }],
    }));
    for (const { imported, result } of [viaTmdl, viaTmsl]) {
      expect(table(imported, 'sales')!.meta?.[SEMANTIC_MODEL_META.source]).toBe('dbo.FactSales');
      expect(lost(result.ledger, 'Power Query source')).toEqual([]);
    }
  });

  it('a partition with its own M keeps it over the refresh policy', () => {
    const { imported } = importAll(bim({
      tables: [{
        name: 'Sales', columns: [{ name: 'Amount', dataType: 'decimal' }],
        refreshPolicy: { sourceExpression: 'let Source = Sql.Database("s","d"), T = Source{[Schema="dbo",Item="Policy"]}[Data] in T' },
        partitions: [{ name: 'p', source: { type: 'm', expression: 'let Source = Sql.Database("s","d"), T = Source{[Schema="dbo",Item="Own"]}[Data] in T' } }],
      }],
    }));
    expect(table(imported, 'sales')!.meta?.[SEMANTIC_MODEL_META.source]).toBe('dbo.Own');
  });
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe('non-Latin names', () => {
  it.each([
    ['Клиенты', 'table', 'klienty'],
    ['ДатаЗаказа', 'column', 'data_zakaza'],
    ['Сумма продаж', 'column', 'summa_prodazh'],
    ['Πελάτες', 'table', 'pelates'],
    ['Größe', 'column', 'grosse'],
    ['Straße', 'column', 'strasse'],
    ['Søknad Ærø', 'column', 'soknad_aero'],
    ['Łódź', 'table', 'lodz'],
    ['Þing', 'table', 'thing'],
    ['客户', 'table', 'table'],
    ['名前', 'column', 'column'],
  ] as const)('%s (%s) → %s', (input, kind, expected) => {
    const out = toSnakeCaseName(input, kind);
    expect(out).toBe(expected);
    expect(isImportableName(out, kind)).toBe(true);
    expect(toSnakeCaseName(out, kind)).toBe(out);
  });

  it('a Russian model imports with readable names, the originals kept, relationships joined', () => {
    const { imported, result } = importAll(bim({
      tables: [
        { name: 'Продажи', columns: [{ name: 'КлиентID', dataType: 'int64' }, { name: 'Сумма', dataType: 'decimal' }] },
        { name: 'Клиенты', columns: [{ name: 'КлиентID', dataType: 'int64' }, { name: 'Имя', dataType: 'string' }] },
      ],
      relationships: [{ fromTable: 'Продажи', fromColumn: 'КлиентID', toTable: 'Клиенты', toColumn: 'КлиентID' }],
    }));
    expect(imported.newTables.map((t) => `${t.name}(${t.columns.map((c) => c.name).join(',')})`)).toEqual(['prodazhi(klient_id,summa)', 'klienty(klient_id,imya)']);
    expect(table(imported, 'klienty')!.meta?.[SEMANTIC_MODEL_META.name]).toBe('Клиенты');
    expect(imported.relationships).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('a Chinese model still imports whole: numbered names, the originals kept, a warning per collision', () => {
    const { imported, result } = importAll(bim({ tables: [{ name: '客户', columns: [{ name: '名前', dataType: 'string' }, { name: '€', dataType: 'string' }] }, { name: '订单', columns: [{ name: '客户', dataType: 'string' }] }] }));
    expect(imported.newTables.map((t) => t.name)).toEqual(['table', 'table_2']);
    expect(table(imported, 'table_2')!.meta?.[SEMANTIC_MODEL_META.name]).toBe('订单');
    expect(result.warnings.join('\n')).toMatch(/订单 and another both become table, so 订单 is table_2/);
  });
});

describe('model names that would break a line', () => {
  it.each([
    ['Sales\nModel', 'Sales Model'],
    ['Sales\r\n\tModel', 'Sales Model'],
    ['Sales\u2028Model', 'Sales Model'],
    ['Sales\u0000Model', 'Sales Model'],
    ['  \n ', undefined],
  ])('%j → %j', (name, expected) => {
    expect(cleanModelName(name)).toBe(expected);
  });

  it('a .platform displayName or a TMSL database name with a line break still converts to DBML that reads', () => {
    for (const files of [
      [...bim({ tables: [{ name: 'T', columns: [{ name: 'a', dataType: 'string' }] }] }), { path: 'Edge.SemanticModel/.platform', text: JSON.stringify({ metadata: { type: 'SemanticModel', displayName: 'Sales\nInsights "EU" \\ 2025' } }) }],
      [{ path: 'reports/model.bim', text: JSON.stringify({ name: 'Finance\r\nModel', model: { tables: [{ name: 'T', columns: [{ name: 'a', dataType: 'string' }] }] } }) }],
    ]) {
      const { model, result } = importAll(files);
      expect(model.name).not.toMatch(/[\r\n]/);
      expect(readDbml(result.dbml).ok).toBe(true);
    }
  });
});

describe('picking a model\'s definition folder itself', () => {
  it('lists its files under the model folder, so the model is named after X.SemanticModel', () => {
    expect(modelPathPrefix('/repo/Sales.SemanticModel/definition')).toEqual(['Sales.SemanticModel', 'definition']);
    expect(modelPathPrefix('/repo/Sales.SemanticModel')).toEqual(['Sales.SemanticModel']);
    expect(modelPathPrefix('/definition')).toEqual(['definition']);
    const [entry] = findSemanticModels(['Sales.SemanticModel/definition/model.tmdl', 'Sales.SemanticModel/definition/tables/T.tmdl']);
    expect(entry).toMatchObject({ name: 'Sales', kind: 'tmdl', root: 'Sales.SemanticModel' });
  });
});

// ---------------------------------------------------------------------------
// Encodings
// ---------------------------------------------------------------------------

describe('file encodings', () => {
  const json = JSON.stringify({ model: { tables: [{ name: 'Café', columns: [{ name: 'Größe', dataType: 'string' }] }] } });
  const utf16le = (s: string): Uint8Array => {
    const out = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      out[i * 2] = s.charCodeAt(i) & 0xff;
      out[i * 2 + 1] = s.charCodeAt(i) >> 8;
    }
    return out;
  };
  const swap = (b: Uint8Array): Uint8Array => b.map((_x, i) => b[i % 2 === 0 ? i + 1 : i - 1]);
  const cat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  it.each([
    ['UTF-8', new TextEncoder().encode(json)],
    ['UTF-8 with a BOM', cat(new Uint8Array([0xef, 0xbb, 0xbf]), new TextEncoder().encode(json))],
    ['UTF-16 LE with a BOM (Visual Studio)', cat(new Uint8Array([0xff, 0xfe]), utf16le(json))],
    ['UTF-16 BE with a BOM', cat(new Uint8Array([0xfe, 0xff]), swap(utf16le(json)))],
    ['UTF-16 LE without a BOM', utf16le(json)],
  ])('%s decodes to the same model', (_label, bytes) => {
    const text = decodeSemanticModelFile(bytes);
    const r = readSemanticModel([{ path: 'X/model.bim', text }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.tables[0]).toMatchObject({ name: 'Café', columns: [{ name: 'Größe' }] });
  });

  it('UTF-16 read as UTF-8 anyway (another host): a problem that says so, not JSON gibberish or "no tables"', () => {
    const asUtf8 = new TextDecoder('utf-8').decode(cat(new Uint8Array([0xff, 0xfe]), utf16le(json)));
    for (const path of ['X/model.bim', 'X/definition/tables/T.tmdl']) {
      const r = readSemanticModel([{ path, text: asUtf8 }]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.problems[0].message).toMatch(/not UTF-8 text.*UTF-16/);
        expect(r.problems[0].message).not.toMatch(/\u0000/);
      }
    }
  });

  it('an empty .bim says it is empty', () => {
    const r = readSemanticModel([{ path: 'X/model.bim', text: ' \n' }]);
    expect(r).toEqual({ ok: false, problems: [{ file: 'X/model.bim', message: 'The file is empty, so it holds no semantic model.' }] });
  });
});

// ---------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------

describe('hostile input never throws', () => {
  it('cultures nested 30 000 deep (TMSL) and a TMDL translation block indented 12 000 deep', () => {
    // Built as text: JSON.stringify of a 30 000-deep value overflows the stack on Node 20 (CI) before the reader runs.
    const deep = `${'['.repeat(30000)}{"translatedCaption":"x"}${']'.repeat(30000)}`;
    const viaTmsl = readSemanticModel([{ path: 'X/model.bim', text: `{"model":{"tables":[{"name":"T","columns":[{"name":"a"}]}],"cultures":[{"name":"fr","translations":${deep}}]}}` }]);
    expect(viaTmsl.ok).toBe(true);
    if (viaTmsl.ok) expect(viaTmsl.model.features?.find((f) => f.kind === 'translation')?.count).toBe(1);
    const lines = ['cultureInfo fr', `${T}translations`];
    for (let i = 0; i < 12000; i++) lines.push(`${' '.repeat(i + 8)}caption: x${i}`);
    const viaTmdl = readSemanticModel([{ path: 'X/definition/c.tmdl', text: lines.join('\n') }, { path: 'X/definition/t.tmdl', text: 'table T\n\tcolumn a\n' }]);
    expect(viaTmdl.ok).toBe(true);
    if (viaTmdl.ok) expect(viaTmdl.model.features?.find((f) => f.kind === 'translation')?.count).toBe(12000);
  });

  it('a 2000-table, 80 000-column TMDL model reads and converts in well under a few seconds', () => {
    const files: SemanticModelFile[] = [];
    for (let t = 0; t < 2000; t++) {
      const l = [`table 'Table ${t}'`];
      for (let c = 0; c < 40; c++) l.push(`${T}column 'Col ${c}'`, `${T}${T}dataType: int64`, `${T}${T}summarizeBy: sum`);
      files.push({ path: `X.SemanticModel/definition/tables/T${t}.tmdl`, text: l.join('\n') });
    }
    const rels: string[] = [];
    for (let t = 1; t < 2000; t++) rels.push(`relationship r${t}`, `${T}fromColumn: 'Table ${t}'.'Col 1'`, `${T}toColumn: 'Table ${t - 1}'.'Col 0'`);
    files.push({ path: 'X.SemanticModel/definition/relationships.tmdl', text: rels.join('\n') });
    const started = Date.now();
    const r = readSemanticModel(files);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = semanticModelToDbml(r.model);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.tableCount).toBe(2000);
    expect(result.refCount).toBe(1999);
  });

  it('broken files are problems with a file and line, and no message echoes the file', () => {
    const long = 'x'.repeat(5000);
    const cases: SemanticModelFile[][] = [
      [{ path: 'X/model.bim', text: `{"model": {"tables": [{"name": "T", "description": "${long}` }],
      [{ path: 'X/model.bim', text: '\u0000\u0001binary' }],
      [{ path: 'X/definition/tables/T.tmdl', text: `table 'Unclosed ${long}\n\tcolumn a` }],
      [{ path: 'X/definition/tables/T.tmdl', text: `table T\n\tmeasure M = \`\`\`\n\t\t${long}` }],
      [{ path: 'X/definition/tables/T.tmdl', text: '' }],
    ];
    for (const files of cases) {
      let r: ReturnType<typeof readSemanticModel> | undefined;
      expect(() => { r = readSemanticModel(files); }).not.toThrow();
      expect(r!.ok).toBe(false);
      if (r!.ok) continue;
      for (const p of r!.problems) {
        expect(p.file).toBe(files[0].path);
        expect(p.message.length).toBeLessThan(300);
      }
    }
  });
});

describe('many relationships that filter both ways', () => {
  it('are one Not imported line naming three and counting the rest, each in the ledger, so they do not bury the other notes', () => {
    const tables = [{ name: 'F', columns: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, dataType: 'int64' })) }, ...['A', 'B', 'C', 'D', 'E'].map((name) => ({ name, columns: [{ name: 'k', dataType: 'int64' }] }))];
    const relationships = ['a', 'b', 'c', 'd', 'e'].map((c) => ({ fromTable: 'F', fromColumn: c, toTable: c.toUpperCase(), toColumn: 'k', crossFilteringBehavior: 'bothDirections' }));
    const { result, imported } = importAll(bim({ tables, relationships }));
    expect(imported.relationships).toHaveLength(5);
    expect(result.warnings).toEqual([]);
    expect(result.ledger.filter((e) => e.what === 'cross-filter direction')).toHaveLength(5);
    expect(ledgerLeftOut(result.ledger)).toContain('5 settings: cross-filter direction not kept: it filters both ways in Power BI (F.a, F.b, F.c and 2 more).');
  });
});

describe('M that a quick read would get wrong', () => {
  it('a commented-out step is not the source: // lines and /* */ blocks, a URL inside a string kept', () => {
    expect(describeMSource([
      'let',
      '    Source = Sql.Database("srv", "dw"),',
      '    T = Source{[Schema="dbo",Item="FactSales"]}[Data]',
      '    // Old = Source{[Schema="dbo",Item="FactSales_Old"]}[Data],',
      '    /* Q = Value.NativeQuery(Source, "select 1") */',
      'in',
      '    T',
    ].join('\n'))).toEqual({ kind: 'navigation', table: 'dbo.FactSales' });
    expect(describeMSource('let\n  // Source = Csv.Document(File.Contents("old.csv")),\n  Source = Sql.Database("s","d"),\n  T = Source{[Schema="x",Item="y"]}[Data]\nin T')).toEqual({ kind: 'navigation', table: 'x.y' });
    expect(describeMSource('let\n  Source = Web.Contents("https://example.com/data.csv")\nin Source').kind).toBe('file');
  });

  it('a bracket inside a quoted item name does not cut the selector short', () => {
    expect(describeMSource('let\n  Source = Sql.Database("s","d"),\n  T = Source{[Schema="dbo",Item="Sales[2024]"]}[Data]\nin T')).toEqual({ kind: 'navigation', table: 'dbo.Sales[2024]' });
  });
});

describe('very long table names', () => {
  it('are cut to a name that fits in a file name, still unique, the original kept', () => {
    const long = `Sales ${'Very Long Name '.repeat(30)}`;
    const { imported } = importAll(bim({ tables: [{ name: `${long}A`, columns: [{ name: 'a', dataType: 'string' }] }, { name: `${long}B`, columns: [{ name: 'b', dataType: 'string' }] }] }));
    const names = imported.newTables.map((t) => t.name);
    expect(names.every((n) => n.length <= 102 && isImportableName(n, 'table'))).toBe(true);
    expect(new Set(names).size).toBe(2);
    expect(imported.newTables[1].meta?.[SEMANTIC_MODEL_META.name]).toBe(`${long}B`);
  });
});

describe('model formats this import does not read', () => {
  it('a .pbix / .pbit is named with what to do, and a database.json with no tables/ beside it; anything else is not (Save to Folder is read)', () => {
    expect(isUnreadModelFile('Sales.pbix')).toBe(true);
    expect(isUnreadModelFile('Sales.PBIT')).toBe(true);
    expect(isUnreadModelFile('Model/database.json')).toBe(false);
    expect(isUnreadModelFile('package.json')).toBe(false);
    expect(unreadModelFormat(['repo/README.md'])).toBeUndefined();
    expect(unreadModelFormat(['repo/Sales.pbit'])).toMatch(/^Sales\.pbit is a Power BI Desktop file/);
    expect(unreadModelFormat(['repo/Model/database.json'])).toMatch(/^repo\/Model\/database\.json has no tables\/ folder/);
  });
});
