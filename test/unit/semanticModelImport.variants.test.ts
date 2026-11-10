/**
 * Edge-case classes of the Power BI converter, beyond the two real samples:
 * a spec that knows its own truth is written as TMDL (tabs or spaces, LF or
 * CRLF, a BOM, files in any order) and as TMSL (bare, inside createOrReplace,
 * text as strings or arrays, compatibility levels 1200 to 1604), and every
 * variant must convert to the same DBML with the same ledger, and conserve:
 * every table, column, relationship and model feature imported, or counted
 * in the ledger. Then each class on its own: date/time typing, keys and
 * uniqueness, descriptions kept verbatim, names, M sources, reported
 * features and format robustness.
 */

import { describe, expect, it } from 'vitest';

import { planDbmlImport, type DbmlImportPlan } from '../../src/services/dbmlImport';
import { readDbml } from '../../src/services/dbmlImportParse';
import { ledgerLeftOut, ledgerNotes, ledgerTotals, type LedgerEntry } from '../../src/services/importLedger';
import {
  CALCULATED_COLUMN_NOTE,
  SEMANTIC_MODEL_META,
  dateTimeFormatKind,
  describeMSource,
  isDefaultModelName,
  mNavigationTable,
  platformDisplayName,
  readSemanticModel,
  semanticColumnType,
  semanticModelToDbml,
  sentenceJoin,
  type SemanticModel,
  type SemanticModelFile,
} from '../../src/services/semanticModelImport';

// ---------------------------------------------------------------------------
// The spec and its two writers
// ---------------------------------------------------------------------------

interface ColumnSpec {
  name: string;
  dataType?: string;
  isKey?: boolean;
  isHidden?: boolean;
  description?: string;
  /** UnderlyingDateTimeDataType. */
  annotation?: string;
  formatString?: string;
  /** Report settings other than formatString (`sortByColumn: Month`…); a value of 'true' is a flag. */
  settings?: Record<string, string>;
  /** A variation onto this table's hierarchy. */
  variation?: { table: string; hierarchy: string };
  /** A calculated column's DAX. */
  dax?: string;
  isNullable?: false;
}

interface TableSpec {
  name: string;
  description?: string;
  dataCategory?: string;
  /** A calculated table's DAX. */
  dax?: string;
  calculationItems?: string[];
  columns: ColumnSpec[];
  measures?: Array<{ name: string; kpi?: boolean; description?: string }>;
  hierarchies?: Array<{ name: string; levels: string[] }>;
  /** The partition's M (lines). */
  m?: string[];
  entity?: { schema?: string; name: string };
}

interface RelSpec {
  from: [string, string];
  to: [string, string];
  fromCardinality?: 'one' | 'many';
  toCardinality?: 'one' | 'many';
  isActive?: false;
}

interface ModelSpec {
  database?: string;
  tables: TableSpec[];
  relationships: RelSpec[];
  roles?: Array<{ name: string; filters?: Record<string, string>; hiddenColumns?: Array<[string, string]>; hiddenTables?: string[] }>;
  perspectives?: string[];
  cultures?: Array<{ name: string; captions: string[]; linguistic?: boolean }>;
  expressions?: Array<{ name: string; m: string[] }>;
  dataSources?: string[];
}

interface Knobs {
  indent?: '\t' | '    ';
  eol?: '\n' | '\r\n';
  bom?: boolean;
  reverse?: boolean;
  /** model.tmdl lists the tables in reverse (its `ref table` order wins over file order). */
  refReverse?: boolean;
  /** TMSL only. */
  wrap?: boolean;
  arrays?: boolean;
  compatibilityLevel?: number;
}

const q = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

/** The spec as a TMDL definition folder under `Spec.SemanticModel/definition/`. */
function toTmdl(spec: ModelSpec, knobs: Knobs = {}): SemanticModelFile[] {
  const tab = knobs.indent ?? '\t';
  const ind = (n: number, line: string): string => `${tab.repeat(n)}${line}`;
  const files: Array<{ name: string; lines: string[] }> = [];
  const doc = (n: number, text: string | undefined): string[] => (text ? text.split('\n').map((l) => ind(n, `/// ${l}`)) : []);
  files.push({ name: 'database.tmdl', lines: [`database ${q(spec.database ?? 'Spec')}`, ind(1, 'compatibilityLevel: 1604')] });
  files.push({ name: 'model.tmdl', lines: ['model Model', ind(1, 'culture: en-US'), '', ...(knobs.refReverse ? [...spec.tables].reverse() : spec.tables).map((t) => `ref table ${q(t.name)}`)] });
  for (const t of spec.tables) {
    const lines: string[] = [...doc(0, t.description), `table ${q(t.name)}`, ind(1, 'lineageTag: 0000')];
    if (t.dataCategory) lines.push(ind(1, `dataCategory: ${t.dataCategory}`));
    if (t.calculationItems) {
      lines.push('', ind(1, 'calculationGroup'));
      for (const item of t.calculationItems) lines.push(ind(2, `calculationItem ${q(item)} = SELECTEDMEASURE()`));
    }
    for (const m of t.measures ?? []) {
      lines.push('', ...doc(1, m.description), ind(1, `measure ${q(m.name)} = SUM(${q(t.name)}[x])`), ind(2, 'formatString: 0'));
      if (m.kpi) lines.push('', ind(2, 'kpi'), ind(3, 'targetExpression = 1'));
    }
    for (const c of t.columns) {
      lines.push('', ...doc(1, c.description));
      if (c.dax) lines.push(ind(1, `column ${q(c.name)} = \`\`\``), ind(3, c.dax), ind(3, '```'));
      else lines.push(ind(1, `column ${q(c.name)}`));
      if (c.dataType) lines.push(ind(2, `dataType: ${c.dataType}`));
      if (c.isHidden) lines.push(ind(2, 'isHidden'));
      if (c.isKey) lines.push(ind(2, 'isKey'));
      if (c.isNullable === false) lines.push(ind(2, 'isNullable: false'));
      if (c.formatString) lines.push(ind(2, `formatString: ${c.formatString}`));
      for (const [k, v] of Object.entries(c.settings ?? {})) lines.push(ind(2, v === 'true' ? k : `${k}: ${v}`));
      lines.push(ind(2, 'lineageTag: 0001'));
      if (!c.dax) lines.push(ind(2, `sourceColumn: ${c.name}`));
      if (c.variation) {
        lines.push('', ind(2, 'variation Variation'), ind(3, 'isDefault'), ind(3, `defaultHierarchy: ${q(c.variation.table)}.${q(c.variation.hierarchy)}`));
      }
      lines.push('', ind(2, 'annotation SummarizationSetBy = Automatic'));
      if (c.annotation) lines.push('', ind(2, `annotation UnderlyingDateTimeDataType = ${c.annotation}`));
    }
    for (const h of t.hierarchies ?? []) {
      lines.push('', ind(1, `hierarchy ${q(h.name)}`));
      for (const l of h.levels) lines.push('', ind(2, `level ${q(l)}`), ind(3, `column: ${q(l)}`));
    }
    if (t.dax) lines.push('', ind(1, `partition ${q(t.name)} = calculated`), ind(2, 'mode: import'), ind(2, `source = ${t.dax}`));
    else if (t.entity) {
      lines.push('', ind(1, `partition ${q(t.name)} = entity`), ind(2, 'mode: directLake'), ind(2, 'source'), ind(3, `entityName: ${t.entity.name}`));
      if (t.entity.schema) lines.push(ind(3, `schemaName: ${t.entity.schema}`));
    } else if (t.m) {
      lines.push('', ind(1, `partition ${q(t.name)} = m`), ind(2, 'mode: import'), ind(2, 'source ='), ...t.m.map((l) => ind(4, l)));
    }
    lines.push('', ind(1, 'annotation PBI_ResultType = Table'));
    files.push({ name: `tables/${t.name}.tmdl`, lines });
  }
  const rels: string[] = [];
  spec.relationships.forEach((r, i) => {
    rels.push(`relationship r${i}`);
    if (r.isActive === false) rels.push(ind(1, 'isActive: false'));
    if (r.fromCardinality) rels.push(ind(1, `fromCardinality: ${r.fromCardinality}`));
    if (r.toCardinality) rels.push(ind(1, `toCardinality: ${r.toCardinality}`));
    rels.push(ind(1, `fromColumn: ${q(r.from[0])}.${q(r.from[1])}`), ind(1, `toColumn: ${q(r.to[0])}.${q(r.to[1])}`), '');
  });
  files.push({ name: 'relationships.tmdl', lines: rels });
  for (const role of spec.roles ?? []) {
    const lines = [`role ${q(role.name)}`, ind(1, 'modelPermission: read')];
    const tables = new Set([...Object.keys(role.filters ?? {}), ...(role.hiddenColumns ?? []).map(([t]) => t), ...(role.hiddenTables ?? [])]);
    for (const t of tables) {
      const filter = role.filters?.[t];
      lines.push('', ind(1, `tablePermission ${q(t)}${filter ? ` = ${filter}` : ''}`));
      if (role.hiddenTables?.includes(t)) lines.push(ind(2, 'metadataPermission: none'));
      for (const [, c] of (role.hiddenColumns ?? []).filter(([x]) => x === t)) lines.push('', ind(2, `columnPermission ${q(c)}`), ind(3, 'metadataPermission: none'));
    }
    files.push({ name: `roles/${role.name}.tmdl`, lines });
  }
  for (const p of spec.perspectives ?? []) files.push({ name: `perspectives/${p}.tmdl`, lines: [`perspective ${q(p)}`, '', ind(1, `perspectiveTable ${q(spec.tables[0].name)}`)] });
  for (const c of spec.cultures ?? []) {
    const lines = [`cultureInfo ${c.name}`];
    if (c.captions.length) {
      lines.push(ind(1, 'translations'), ind(2, 'model Model'));
      for (const t of c.captions) lines.push(ind(3, `table ${q(t)}`), ind(4, `caption: ${t} (${c.name})`));
    }
    if (c.linguistic) lines.push('', ind(1, 'linguisticMetadata ='), ind(3, '{'), ind(3, '  "Version": "1.0.0"'), ind(3, '}'), ind(2, 'contentType: json'));
    files.push({ name: `cultures/${c.name}.tmdl`, lines });
  }
  const expressions: string[] = [];
  for (const e of spec.expressions ?? []) {
    if (e.m.length === 1) expressions.push(`expression ${q(e.name)} = ${e.m[0]}`, ind(1, 'lineageTag: 0002'), '');
    else expressions.push(`expression ${q(e.name)} =`, ...e.m.map((l) => ind(2, l)), ind(1, 'lineageTag: 0002'), '');
  }
  for (const d of spec.dataSources ?? []) expressions.push(`dataSource ${q(d)}`, ind(1, 'type: structured'), '');
  if (expressions.length) files.push({ name: 'expressions.tmdl', lines: expressions });
  const eol = knobs.eol ?? '\n';
  const out = files.map((f) => ({ path: `Spec.SemanticModel/definition/${f.name}`, text: `${knobs.bom ? '\uFEFF' : ''}${f.lines.join(eol)}${eol}` }));
  return knobs.reverse ? out.reverse() : out;
}

/** The spec as one TMSL model.bim under `Spec.SemanticModel/`. */
function toTmsl(spec: ModelSpec, knobs: Knobs = {}): SemanticModelFile[] {
  const text = (s: string | undefined): string | string[] | undefined => (s === undefined ? undefined : knobs.arrays && s.includes('\n') ? s.split('\n') : s);
  const lines = (l: string[]): string | string[] => (knobs.arrays ? l : l.join('\n'));
  const tables = spec.tables.map((t) => ({
    name: t.name,
    ...(t.description ? { description: text(t.description) } : {}),
    ...(t.dataCategory ? { dataCategory: t.dataCategory } : {}),
    ...(t.calculationItems ? { calculationGroup: { calculationItems: t.calculationItems.map((name) => ({ name, expression: 'SELECTEDMEASURE()' })) } } : {}),
    columns: t.columns.map((c) => ({
      name: c.name,
      ...(c.dataType ? { dataType: c.dataType } : {}),
      ...(c.dax ? { type: 'calculated', expression: c.dax } : { sourceColumn: c.name }),
      ...(c.isKey ? { isKey: true } : {}),
      ...(c.isHidden ? { isHidden: true } : {}),
      ...(c.isNullable === false ? { isNullable: false } : {}),
      ...(c.description ? { description: text(c.description) } : {}),
      ...(c.formatString ? { formatString: c.formatString } : {}),
      ...Object.fromEntries(Object.entries(c.settings ?? {}).map(([k, v]) => [k, v === 'true' ? true : v])),
      ...(c.variation ? { variations: [{ name: 'Variation', isDefault: true, defaultHierarchy: { table: c.variation.table, hierarchy: c.variation.hierarchy } }] } : {}),
      annotations: [{ name: 'SummarizationSetBy', value: 'Automatic' }, ...(c.annotation ? [{ name: 'UnderlyingDateTimeDataType', value: c.annotation }] : [])],
    })),
    ...(t.measures ? { measures: t.measures.map((m) => ({ name: m.name, expression: 'SUM(x)', ...(m.description ? { description: text(m.description) } : {}), ...(m.kpi ? { kpi: { targetExpression: '1' } } : {}) })) } : {}),
    ...(t.hierarchies ? { hierarchies: t.hierarchies.map((h) => ({ name: h.name, levels: h.levels.map((l, ordinal) => ({ name: l, ordinal, column: l })) })) } : {}),
    partitions: [{
      name: t.name,
      source: t.dax
        ? { type: 'calculated', expression: t.dax }
        : t.entity
          ? { type: 'entity', entityName: t.entity.name, ...(t.entity.schema ? { schemaName: t.entity.schema } : {}), expressionSource: 'DatabaseQuery' }
          : { type: 'm', expression: lines(t.m ?? ['let', '    Source = #table({}, {})', 'in', '    Source']) },
    }],
  }));
  // TMDL tables with no partition: the reader sees none either.
  tables.forEach((t, i) => { if (!spec.tables[i].dax && !spec.tables[i].entity && !spec.tables[i].m) delete (t as { partitions?: unknown }).partitions; });
  const model = {
    culture: 'en-US',
    ...(spec.dataSources ? { dataSources: spec.dataSources.map((name) => ({ type: 'structured', name })) } : {}),
    tables,
    relationships: spec.relationships.map((r, i) => ({
      name: `r${i}`,
      fromTable: r.from[0], fromColumn: r.from[1], toTable: r.to[0], toColumn: r.to[1],
      ...(r.fromCardinality ? { fromCardinality: r.fromCardinality } : {}),
      ...(r.toCardinality ? { toCardinality: r.toCardinality } : {}),
      ...(r.isActive === false ? { isActive: false } : {}),
    })),
    ...(spec.perspectives ? { perspectives: spec.perspectives.map((name) => ({ name, tables: [{ name: spec.tables[0].name }] })) } : {}),
    ...(spec.roles ? {
      roles: spec.roles.map((role) => {
        const names = new Set([...Object.keys(role.filters ?? {}), ...(role.hiddenColumns ?? []).map(([t]) => t), ...(role.hiddenTables ?? [])]);
        return {
          name: role.name, modelPermission: 'read',
          tablePermissions: [...names].map((t) => ({
            name: t,
            ...(role.filters?.[t] ? { filterExpression: role.filters[t] } : {}),
            ...(role.hiddenTables?.includes(t) ? { metadataPermission: 'none' } : {}),
            ...((role.hiddenColumns ?? []).some(([x]) => x === t) ? { columnPermissions: (role.hiddenColumns ?? []).filter(([x]) => x === t).map(([, name]) => ({ name, metadataPermission: 'none' })) } : {}),
          })),
        };
      }),
    } : {}),
    ...(spec.cultures ? {
      cultures: spec.cultures.map((c) => ({
        name: c.name,
        ...(c.captions.length ? { translations: { model: { name: 'Model', tables: c.captions.map((t) => ({ name: t, translatedCaption: `${t} (${c.name})` })) } } } : {}),
        ...(c.linguistic ? { linguisticMetadata: { content: { Version: '1.0.0' }, contentType: 'json' } } : {}),
      })),
    } : {}),
    ...(spec.expressions ? { expressions: spec.expressions.map((e) => ({ name: e.name, kind: 'm', expression: lines(e.m) })) } : {}),
  };
  const database = { name: spec.database ?? 'SemanticModel', compatibilityLevel: knobs.compatibilityLevel ?? 1550, model };
  const json = knobs.wrap ? { createOrReplace: { object: { database: database.name }, database } } : database;
  return [{ path: 'Spec.SemanticModel/model.bim', text: `${knobs.bom ? '\uFEFF' : ''}${JSON.stringify(json, null, 2)}` }];
}

interface FolderKnobs extends Knobs {
  /** Relationships kept in each from-table's TabularEditor_Relationships annotation (else one file each under relationships/). */
  localRelationships?: boolean;
  /** Perspectives named in the model's TabularEditor_Perspectives annotation (else one file each under perspectives/). */
  localPerspectives?: boolean;
  /** Captions kept on each table in TabularEditor_TranslatedNames (else in the culture's file). */
  localTranslations?: boolean;
  /** `001 Name.json`: files numbered in model order. */
  prefixFilenames?: boolean;
}

/** A file name as Tabular Editor writes it: characters a file system refuses escaped as %XX. */
const teFileName = (name: string): string => name.replace(/[%/\\:*?"<>|]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/**
 * The spec as Tabular Editor's Save to Folder writes it under `Spec/`: the
 * TMSL database split into `database.json` and one JSON file per table,
 * column, measure, partition, hierarchy, calculation item, relationship,
 * role, perspective, culture, data source and expression.
 */
function toSaveToFolder(spec: ModelSpec, knobs: FolderKnobs = {}): SemanticModelFile[] {
  const db = JSON.parse(toTmsl(spec, { arrays: knobs.arrays, compatibilityLevel: knobs.compatibilityLevel ?? 1604 })[0].text) as Record<string, any>;
  const model = db.model as Record<string, any>;
  const files: Array<{ path: string; value: unknown }> = [];
  const name = (i: number, n: string): string => `${knobs.prefixFilenames ? `${String(i).padStart(3, '0')} ` : ''}${teFileName(n)}.json`;
  const tables = model.tables as Array<Record<string, any>>;
  const rels = (model.relationships ?? []) as Array<Record<string, any>>;
  if (knobs.localTranslations) {
    for (const c of model.cultures ?? []) {
      for (const t of c.translations?.model?.tables ?? []) {
        const table = tables.find((x) => x.name === t.name);
        if (!table) continue;
        table.annotations = [...(table.annotations ?? []), { name: 'TabularEditor_TranslatedNames', value: JSON.stringify({ [c.name]: t.translatedCaption }) }];
      }
      delete c.translations;
    }
  }
  tables.forEach((t, ti) => {
    const dir = `tables/${knobs.prefixFilenames ? `${String(ti).padStart(3, '0')} ` : ''}${teFileName(t.name)}`;
    for (const key of ['columns', 'measures', 'partitions', 'hierarchies']) {
      (t[key] ?? []).forEach((o: Record<string, any>, i: number) => files.push({ path: `${dir}/${key}/${name(i, o.name)}`, value: o }));
      delete t[key];
    }
    if (t.calculationGroup) {
      t.calculationGroup.calculationItems.forEach((o: Record<string, any>, i: number) => files.push({ path: `${dir}/calculationItems/${name(i, o.name)}`, value: o }));
      delete t.calculationGroup.calculationItems;
    }
    if (knobs.localRelationships) {
      const own = rels.filter((r) => r.fromTable === t.name);
      // Split one string per line, as Tabular Editor writes it (SplitMultilineStrings).
      t.annotations = [...(t.annotations ?? []), { name: 'TabularEditor_Relationships', value: JSON.stringify(own, null, 2).split('\n') }];
    }
    if (knobs.localPerspectives && (spec.perspectives ?? []).length && ti === 0) {
      t.annotations = [...(t.annotations ?? []), { name: 'TabularEditor_InPerspective', value: JSON.stringify(spec.perspectives) }];
    }
    files.push({ path: `${dir}/${teFileName(t.name)}.json`, value: t });
  });
  delete model.tables;
  if (!knobs.localRelationships) rels.forEach((r, i) => files.push({ path: `relationships/${name(i, r.name)}`, value: r }));
  delete model.relationships;
  for (const key of ['roles', 'perspectives', 'cultures', 'dataSources', 'expressions']) {
    if (key === 'perspectives' && knobs.localPerspectives) {
      if (model.perspectives) model.annotations = [{ name: 'TabularEditor_Perspectives', value: JSON.stringify(model.perspectives.map((p: { name: string }) => ({ Name: p.name, Description: '', Annotations: {} }))) }];
      delete model.perspectives;
      continue;
    }
    (model[key] ?? []).forEach((o: Record<string, any>, i: number) => files.push({ path: `${key}/${name(i, o.name)}`, value: o }));
    delete model[key];
  }
  model.annotations = [...(model.annotations ?? []), { name: 'TabularEditor_SerializeOptions', value: JSON.stringify({ LocalRelationships: !!knobs.localRelationships, LocalPerspectives: !!knobs.localPerspectives, LocalTranslations: !!knobs.localTranslations, PrefixFilenames: !!knobs.prefixFilenames }) }];
  files.push({ path: 'database.json', value: db });
  const eol = knobs.eol ?? '\n';
  const out = files.map((f) => ({ path: `Spec/${f.path}`, text: `${knobs.bom ? '\uFEFF' : ''}${JSON.stringify(f.value, null, 2).replace(/\n/g, eol)}${eol}` }));
  return knobs.reverse ? out.reverse() : out;
}

function read(files: SemanticModelFile[]): SemanticModel {
  const r = readSemanticModel(files);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.model;
}

function plan(dbml: string): DbmlImportPlan {
  const r = readDbml(dbml);
  if (!r.ok) throw new Error(`${JSON.stringify(r.diagnostics)}\n${dbml}`);
  return planDbmlImport({
    model: r.model, layer: 'main', subjectAreaName: 's', fileName: 's.dbml',
    library: { findTableName: () => null, getTable: () => null }, libraryRelationships: true,
  });
}

/** The ledger without places (TMSL has no lines), sorted: what the two formats must agree on. */
function shape(ledger: readonly LedgerEntry[]): string[] {
  return ledger.map((e) => `${e.outcome}|${e.unit}|${e.cause}|${e.what}|${e.where?.table ?? ''}|${e.where?.column ?? ''}|${e.count}`).sort();
}

const lostCount = (ledger: readonly LedgerEntry[], what: string): number =>
  ledger.filter((e) => e.outcome === 'lost' && e.what === what).reduce((n, e) => n + e.count, 0);

// ---------------------------------------------------------------------------
// A model that holds every class, and its truth
// ---------------------------------------------------------------------------

const RICH: ModelSpec = {
  database: 'Retail Insights',
  tables: [
    {
      name: 'Sales', description: 'One row per order line', columns: [
        { name: 'OrderKey', dataType: 'int64', isKey: true },
        { name: 'CustomerKey', dataType: 'int64', isHidden: true, settings: { summarizeBy: 'none' } },
        { name: 'OrderDate', dataType: 'dateTime', annotation: 'Date', formatString: 'Long Date', variation: { table: 'Date', hierarchy: 'Calendar' } },
        { name: 'ShipDate', dataType: 'dateTime', formatString: 'yyyy-mm-dd' },
        { name: 'OrderTime', dataType: 'dateTime', annotation: 'Time' },
        { name: 'Loaded At', dataType: 'dateTime', formatString: 'General Date' },
        { name: 'Amount', dataType: 'decimal', description: 'Net of discounts!', formatString: '\\$#,0.00', settings: { displayFolder: 'Money' } },
        { name: 'Margin %', dataType: 'double', dax: '[Amount] * 0.1', description: 'A rough margin' },
        { name: 'Due Date', dataType: 'dateTime', dax: '[OrderDate] + 30', formatString: 'Short Date' },
      ],
      measures: [{ name: 'Total', kpi: true }, { name: 'Count' }],
      m: ['let', '    Source = Sql.Database(Server, Database),', '    Nav = Source{[Schema="dbo",Item="FactSales"]}[Data]', 'in', '    Nav'],
    },
    {
      name: 'Customer', description: 'Who buys…', columns: [
        { name: 'CustomerKey', dataType: 'int64' },
        { name: 'Name', dataType: 'string', settings: { isDefaultLabel: 'true' }, description: 'Line one\nline two?' },
        { name: 'City', dataType: 'string', settings: { dataCategory: 'City' } },
        { name: 'Phone', dataType: 'string', isNullable: false },
      ],
      m: ['let', '    Source = Snowflake.Databases("acct.snowflakecomputing.com", "WH"),', '    Db = Source{[Name="SALES",Kind="Database"]}[Data],', '    Sch = Db{[Name="PUBLIC",Kind="Schema"]}[Data],', '    Tbl = Sch{[Name="CUSTOMER",Kind="Table"]}[Data]', 'in', '    Tbl'],
    },
    {
      name: 'Date', dataCategory: 'Time', columns: [
        { name: 'DateKey', dataType: 'int64' },
        { name: 'Date', dataType: 'dateTime', isKey: true, formatString: 'Long Date' },
        { name: 'Month Name', dataType: 'string', settings: { sortByColumn: 'Month' } },
        { name: 'Month', dataType: 'int64' },
      ],
      hierarchies: [{ name: 'Calendar', levels: ['Month', 'Date'] }],
      measures: [{ name: 'Days' }],
      m: ['let', '    Source = Databricks.Catalogs("adb.net", "/sql/1.0/x"),', '    Cat = Source{[Name="main",Kind="Database"]}[Data],', '    Sch = Cat{[Name="gold",Kind="Schema"]}[Data],', '    T = Sch{[Name="dim_date",Kind="Table"]}[Data]', 'in', '    T'],
    },
    {
      name: 'Product', columns: [{ name: 'ProductKey', dataType: 'int64' }, { name: 'Category', dataType: 'string' }],
      m: ['let', '    Source = Staging,', '    Kept = Table.SelectColumns(Source, {"ProductKey"})', 'in', '    Kept'],
    },
    { name: 'Rates', columns: [{ name: 'Currency', dataType: 'string' }, { name: 'Rate' }], m: ['let', '    Source = Csv.Document(File.Contents("C:\\rates.csv"))', 'in', '    Source'] },
    { name: 'Targets', columns: [{ name: 'Year', dataType: 'int64' }], m: ['let', '    Source = Value.NativeQuery(Sql.Database(Server, Database), "select * from t")', 'in', '    Source'] },
    { name: 'Lake Orders', columns: [{ name: 'OrderKey', dataType: 'int64' }], entity: { schema: 'dbo', name: 'orders' } },
    { name: 'Segments', dax: 'DATATABLE("S", STRING, {{"A"}})', columns: [{ name: 'Segment', dataType: 'string' }] },
    { name: 'Time Calcs', calculationItems: ['YTD', 'PY'], columns: [{ name: 'Name', dataType: 'string', settings: { sortByColumn: 'Ordinal' } }] },
  ],
  relationships: [
    { from: ['Sales', 'CustomerKey'], to: ['Customer', 'CustomerKey'] },
    { from: ['Sales', 'OrderDate'], to: ['Date', 'Date'] },
    { from: ['Sales', 'OrderKey'], to: ['Date', 'DateKey'], isActive: false },
    { from: ['Customer', 'City'], to: ['Segments', 'Segment'] },
    { from: ['Product', 'ProductKey'], to: ['Sales', 'OrderKey'], fromCardinality: 'many', toCardinality: 'many' },
    { from: ['Lake Orders', 'OrderKey'], to: ['Sales', 'OrderKey'], fromCardinality: 'one', toCardinality: 'one' },
    { from: ['Sales', 'Amount'], to: ['Time Calcs', 'Name'] },
  ],
  roles: [{ name: 'EU readers', filters: { Customer: '[City] = "Paris"' }, hiddenColumns: [['Customer', 'Phone']], hiddenTables: ['Targets'] }],
  perspectives: ['Finance'],
  cultures: [{ name: 'fr-FR', captions: ['Sales', 'Customer', 'Date'], linguistic: true }, { name: 'en-US', captions: [], linguistic: true }],
  expressions: [
    { name: 'Server', m: ['"sql.contoso.com" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]'] },
    { name: 'Database', m: ['"DW" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]'] },
    { name: 'Staging', m: ['let', '    Source = Sql.Database(Server, Database),', '    P = Source{[Schema="stage",Item="product"]}[Data]', 'in', '    P'] },
  ],
  dataSources: ['Warehouse'],
};

/** What the spec says the import must show. */
const TRUTH = {
  tables: 8, // 9 less the calculation group
  types: { 'sales.order_date': 'date', 'sales.ship_date': 'date', 'sales.order_time': 'time', 'sales.loaded_at': 'timestamp', 'sales.due_date': 'date', 'date.date': 'date' } as Record<string, string>,
  lost: {
    hierarchy: 1, 'security role': 1, 'row filter': 1, 'column permission': 1, 'table permission': 1, perspective: 1,
    'translated caption': 3, 'Q&A linguistic metadata': 2, 'data source': 1, 'Power Query expression': 1, 'Power Query parameter': 2,
    'Mark as date table': 1, variation: 1, KPI: 1, summarizeBy: 1, formatString: 6, displayFolder: 1, isDefaultLabel: 1, dataCategory: 1, sortByColumn: 1,
    'file source': 1, 'native query': 1, 'DAX expression': 3,
  } as Record<string, number>,
  sources: { sales: 'dbo.FactSales', customer: 'PUBLIC.CUSTOMER', date: 'gold.dim_date', product: 'stage.product', lake_orders: 'dbo.orders' } as Record<string, string>,
};

const VARIANTS: Array<[string, () => SemanticModelFile[]]> = [
  ['TMDL, tabs, LF', () => toTmdl(RICH)],
  ['TMDL, 4 spaces, CRLF, BOM, files reversed', () => toTmdl(RICH, { indent: '    ', eol: '\r\n', bom: true, reverse: true })],
  ['TMDL, 4 spaces, LF', () => toTmdl(RICH, { indent: '    ' })],
  ['TMSL, bare, level 1200', () => toTmsl(RICH, { compatibilityLevel: 1200 })],
  ['TMSL, createOrReplace, text as arrays, BOM, level 1604', () => toTmsl(RICH, { wrap: true, arrays: true, bom: true, compatibilityLevel: 1604 })],
  ['TMSL, createOrReplace, level 1550', () => toTmsl(RICH, { wrap: true })],
  ['Save to Folder, a file per object (files in name order)', () => toSaveToFolder(RICH)],
  ['Save to Folder, local relationships, perspectives and translations, numbered files, CRLF, BOM, reversed', () => toSaveToFolder(RICH, { localRelationships: true, localPerspectives: true, localTranslations: true, prefixFilenames: true, eol: '\r\n', bom: true, reverse: true, arrays: true })],
];

describe('variants: one rich model in every format', () => {
  const baseline = semanticModelToDbml(read(toTmdl(RICH)));

  it.each(VARIANTS)('%s: the same DBML and the same ledger', (label, files) => {
    const result = semanticModelToDbml(read(files()));
    // The format and model name aside. Save to Folder files not numbered are read in name order (tables and columns), so those compare as sets.
    const unordered = label.includes('name order');
    const blocks = (dbml: string): string[] => dbml
      .replace(/\((TMSL|TMDL|TMSL, Tabular Editor folder)\)/, '(X)')
      .replace(/semantic model "?[^".\n]+"?/g, 'semantic model M')
      .replace(/^Project .* \{$/m, 'Project M {')
      .split('\n\n')
      .map((b) => (unordered ? b.split('\n').sort().join('\n') : b))
      .sort();
    expect(blocks(result.dbml)).toEqual(blocks(baseline.dbml));
    expect(shape(result.ledger)).toEqual(shape(baseline.ledger));
  });

  it.each(VARIANTS)('%s: conserves every table, column, relationship and feature', (_label, files) => {
    const model = read(files());
    const result = semanticModelToDbml(model);
    const imported = plan(result.dbml);
    const totals = ledgerTotals(result.ledger);
    // Tables: imported, or skipped and counted.
    expect(imported.newTables).toHaveLength(TRUTH.tables);
    expect(result.tableCount + (totals.skipped.table ?? 0)).toBe(RICH.tables.length);
    // Columns of imported tables: every one.
    const kept = RICH.tables.filter((t) => !t.calculationItems);
    const byName = (list: Array<{ name: string; columns: unknown[] }>): string[] => list.map((t) => `${t.name.toLowerCase().replace(/[^a-z0-9]/g, '')}:${t.columns.length}`).sort();
    expect(byName(imported.newTables)).toEqual(byName(kept));
    // Relationships: drawn, or skipped and counted.
    expect(result.refCount + (totals.skipped.relationship ?? 0)).toBe(RICH.relationships.length);
    // Measures and calculation items: counted.
    expect(totals.skipped.object).toBe(3 + 2);
    // Every feature: named.
    for (const [what, n] of Object.entries(TRUTH.lost)) expect(lostCount(result.ledger, what), what).toBe(n);
    // Nothing lost that the truth does not hold.
    const unexpected = result.ledger.filter((e) => e.outcome === 'lost' && !(e.what in TRUTH.lost) && e.what !== 'Power Query source');
    expect(unexpected).toEqual([]);
    // Types.
    for (const [key, type] of Object.entries(TRUTH.types)) {
      const [t, c] = key.split('.');
      expect(imported.newTables.find((x) => x.name === t)?.columns.find((x) => x.name === c)?.dataType, key).toBe(type);
    }
    // Sources.
    for (const [t, s] of Object.entries(TRUTH.sources)) expect(imported.newTables.find((x) => x.name === t)?.meta?.[SEMANTIC_MODEL_META.source], t).toBe(s);
    // Every lost entry is rendered in Not imported; every changed one in the notes.
    const leftOut = ledgerLeftOut(result.ledger).join('\n');
    for (const what of Object.keys(TRUTH.lost)) expect(leftOut, what).toContain(what);
    expect(ledgerNotes(result.ledger).join('\n')).toMatch(/dateTime → date/);
  });

  it('names a TMDL feature with its file and line', () => {
    const result = semanticModelToDbml(read(toTmdl(RICH)));
    const hierarchy = result.ledger.find((e) => e.what === 'hierarchy')!;
    expect(hierarchy.where).toMatchObject({ file: 'Spec.SemanticModel/definition/tables/Date.tmdl', table: 'Date', column: 'Calendar' });
    const files = toTmdl(RICH);
    const text = files.find((f) => f.path.endsWith('tables/Date.tmdl'))!.text.split('\n');
    expect(text[hierarchy.where!.line! - 1].trim()).toBe('hierarchy Calendar');
    const role = result.ledger.find((e) => e.what === 'security role')!;
    expect(role.where).toMatchObject({ file: 'Spec.SemanticModel/definition/roles/EU readers.tmdl', line: 1, table: 'EU readers' });
  });
});

// ---------------------------------------------------------------------------
// Classes one by one
// ---------------------------------------------------------------------------

const one = (columns: ColumnSpec[], more: Partial<TableSpec> = {}): ModelSpec => ({ tables: [{ name: 'T', columns, ...more }], relationships: [] });
const typesOf = (spec: ModelSpec): string[] => plan(semanticModelToDbml(read(toTmdl(spec))).dbml).newTables[0].columns.map((c) => c.dataType);

describe('date and time columns', () => {
  it('reads the TMDL annotation Date, Time or DateTime, and the TMSL annotations array the same way', () => {
    const spec = one([
      { name: 'a', dataType: 'dateTime', annotation: 'Date' },
      { name: 'b', dataType: 'dateTime', annotation: 'Time' },
      { name: 'c', dataType: 'dateTime', annotation: 'DateTime' },
      { name: 'd', dataType: 'dateTime', annotation: 'date' },
    ]);
    expect(typesOf(spec)).toEqual(['date', 'time', 'timestamp', 'date']);
    expect(plan(semanticModelToDbml(read(toTmsl(spec))).dbml).newTables[0].columns.map((c) => c.dataType)).toEqual(['date', 'time', 'timestamp', 'date']);
  });

  it('falls back to the formatString: named and custom formats', () => {
    const formats: Array<[string, string]> = [
      ['Long Date', 'date'], ['Short Date', 'date'], ['Medium Date', 'date'], ['yyyy-mm-dd', 'date'], ['dd/MM/yyyy', 'date'], ['mmm yyyy', 'date'],
      ['dddd, mmmm d, yyyy', 'date'], ['"Q"q yyyy', 'date'],
      ['Long Time', 'time'], ['Short Time', 'time'], ['h:mm', 'time'], ['hh:mm:ss tt', 'time'], ['h:nn AM/PM', 'time'],
      ['General Date', 'timestamp'], ['dd/mm/yyyy hh:nn', 'timestamp'], ['yyyy-mm-dd hh:mm:ss', 'timestamp'],
      ['0', 'timestamp'], ['General Number', 'timestamp'], ['\\$#,0.00', 'timestamp'],
    ];
    expect(typesOf(one(formats.map(([formatString], i) => ({ name: `c${i}`, dataType: 'dateTime', formatString }))))).toEqual(formats.map(([, t]) => t));
    expect(dateTimeFormatKind(undefined)).toBeUndefined();
    expect(dateTimeFormatKind('[$-en-US]dd mmm yyyy')).toBe('date');
  });

  it('lets the annotation win over a conflicting format, and keeps timestamp with no signal', () => {
    expect(typesOf(one([
      { name: 'a', dataType: 'dateTime', annotation: 'DateTime', formatString: 'Long Date' },
      { name: 'b', dataType: 'dateTime', annotation: 'Date', formatString: 'Long Time' },
      { name: 'c', dataType: 'dateTime' },
    ]))).toEqual(['timestamp', 'date', 'timestamp']);
  });

  it('types a calculated dateTime column too, and never retypes a column that is not dateTime', () => {
    expect(typesOf(one([
      { name: 'due', dataType: 'dateTime', dax: '[x] + 1', formatString: 'Short Date' },
      { name: 'year', dataType: 'int64', formatString: 'yyyy' },
      { name: 'label', dataType: 'string', annotation: 'Date' },
    ]))).toEqual(['date', 'bigint', 'varchar']);
    expect(semanticColumnType({ dataType: 'DateTime', formatString: 'Long Time' })).toBe('time');
  });

  it('records each retyped column in the ledger, grouped in one note per kind', () => {
    const result = semanticModelToDbml(read(toTmdl(one([
      { name: 'a', dataType: 'dateTime', annotation: 'Date' },
      { name: 'b', dataType: 'dateTime', formatString: 'Long Date' },
      { name: 'c', dataType: 'dateTime', annotation: 'Time' },
    ]))));
    expect(ledgerNotes(result.ledger)).toEqual([
      '2 types: dateTime → date because Power BI marks the column date-only (T.a, T.b).',
      '1 type: dateTime → time because Power BI marks the column time-only (T.c).',
    ]);
  });
});

describe('keys and unique "one" ends', () => {
  const dim = (columns: ColumnSpec[], name = 'Dim'): TableSpec => ({ name, columns });
  const fact: TableSpec = { name: 'Fact', columns: [{ name: 'A', dataType: 'int64' }, { name: 'B', dataType: 'int64' }, { name: 'C', dataType: 'int64' }] };
  const run = (spec: ModelSpec, opts = {}) => {
    const result = semanticModelToDbml(read(toTmsl(spec)), opts);
    const p = plan(result.dbml);
    const t = (name: string) => p.newTables.find((x) => x.name === name)!;
    return {
      result,
      pk: (name: string) => t(name).columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
      unique: (name: string) => t(name).columns.filter((c) => (c.meta?.dbml as { unique?: boolean } | undefined)?.unique).map((c) => c.name),
      plan: p,
    };
  };

  it('isKey on a column relationships do not join: kept, and the joined column is unique, with a note', () => {
    const r = run({ tables: [fact, dim([{ name: 'Date', dataType: 'dateTime', isKey: true }, { name: 'DateKey', dataType: 'int64' }])], relationships: [{ from: ['Fact', 'A'], to: ['Dim', 'DateKey'] }] });
    expect(r.pk('dim')).toEqual(['date']);
    expect(r.unique('dim')).toEqual(['date_key']);
    expect(r.result.warnings).toEqual(['Dim: relationships join date_key, which Power BI requires to be unique; date stays the key (isKey).']);
  });

  it('a date table (dataCategory Time) whose isKey date no relationship joins: the joined column is the key, the date unique, with a note', () => {
    const dateDim = (columns: ColumnSpec[]): TableSpec => ({ name: 'Dim', dataCategory: 'Time', columns });
    const r = run({ tables: [fact, dateDim([{ name: 'Date', dataType: 'dateTime', isKey: true }, { name: 'DateKey', dataType: 'int64' }])],
      relationships: [{ from: ['Fact', 'A'], to: ['Dim', 'DateKey'] }, { from: ['Fact', 'B'], to: ['Dim', 'DateKey'] }] });
    expect(r.pk('dim')).toEqual(['date_key']);
    expect(r.unique('dim')).toEqual(['date']);
    expect(r.result.warnings).toEqual(['Dim: every relationship joins date_key, so it is the key; date, which Mark as date table flags isKey, is marked unique.']);
    expect(r.result.ledger).toContainEqual(expect.objectContaining({ outcome: 'changed', unit: 'primaryKey', what: 'date table key', where: expect.objectContaining({ table: 'Dim', column: 'DateKey' }) }));
    // Joined on the date itself: the key stays.
    const joinedOnDate = run({ tables: [fact, dateDim([{ name: 'Date', dataType: 'dateTime', isKey: true }, { name: 'DateKey', dataType: 'int64' }])],
      relationships: [{ from: ['Fact', 'A'], to: ['Dim', 'Date'] }] });
    expect(joinedOnDate.pk('dim')).toEqual(['date']);
    // Joined through two columns: no single key to move to, so isKey stays and both are unique.
    const two = run({ tables: [fact, dateDim([{ name: 'Date', dataType: 'dateTime', isKey: true }, { name: 'DateKey', dataType: 'int64' }, { name: 'Alt', dataType: 'int64' }])],
      relationships: [{ from: ['Fact', 'A'], to: ['Dim', 'DateKey'] }, { from: ['Fact', 'B'], to: ['Dim', 'Alt'] }] });
    expect(two.pk('dim')).toEqual(['date']);
    expect(two.unique('dim')).toEqual(['date_key', 'alt']);
    // An isKey that is not a date (a date table keyed on an int): never moved.
    const intKey = run({ tables: [fact, dateDim([{ name: 'Id', dataType: 'int64', isKey: true }, { name: 'DateKey', dataType: 'int64' }])],
      relationships: [{ from: ['Fact', 'A'], to: ['Dim', 'DateKey'] }] });
    expect(intKey.pk('dim')).toEqual(['id']);
    // With inferKeys off, nothing moves.
    const off = run({ tables: [fact, dateDim([{ name: 'Date', dataType: 'dateTime', isKey: true }, { name: 'DateKey', dataType: 'int64' }])],
      relationships: [{ from: ['Fact', 'A'], to: ['Dim', 'DateKey'] }] }, { inferKeys: false });
    expect(off.pk('dim')).toEqual(['date']);
  });

  it('isKey and the joined column agreeing: the key, nothing unique, no note', () => {
    const r = run({ tables: [fact, dim([{ name: 'K', dataType: 'int64', isKey: true }])], relationships: [{ from: ['Fact', 'A'], to: ['Dim', 'K'] }] });
    expect(r.pk('dim')).toEqual(['k']);
    expect(r.unique('dim')).toEqual([]);
    expect(r.result.warnings).toEqual([]);
  });

  it('no isKey, one joined column: inferred as the key (ledger, not a warning); with inferKeys off it is only unique', () => {
    const spec: ModelSpec = { tables: [fact, dim([{ name: 'K', dataType: 'int64' }, { name: 'X', dataType: 'string' }])], relationships: [{ from: ['Fact', 'A'], to: ['Dim', 'K'] }] };
    const r = run(spec);
    expect(r.pk('dim')).toEqual(['k']);
    expect(r.result.warnings).toEqual([]);
    expect(ledgerNotes(r.result.ledger)).toContain('1 primary key: inferred key chosen because relationships point at it (Dim.K).');
    const off = run(spec, { inferKeys: false });
    expect(off.pk('dim')).toEqual([]);
    expect(off.unique('dim')).toEqual(['k']);
  });

  it('several joined columns in one table and no isKey: each unique, no key inferred, said once', () => {
    const r = run({ tables: [fact, dim([{ name: 'K1', dataType: 'int64' }, { name: 'K2', dataType: 'int64' }])], relationships: [{ from: ['Fact', 'A'], to: ['Dim', 'K1'] }, { from: ['Fact', 'B'], to: ['Dim', 'K2'] }] });
    expect(r.pk('dim')).toEqual([]);
    expect(r.unique('dim')).toEqual(['k1', 'k2']);
    expect(r.result.warnings).toEqual(['Dim: relationships join k1 and k2, which Power BI requires to be unique; no primary key is inferred, as relationships join more than one column.']);
  });

  it('one-to-one in both directions: both ends unique (the key end stays the key); many-to-many: neither', () => {
    const r = run({
      tables: [
        dim([{ name: 'PersonKey', dataType: 'int64', isKey: true }], 'Person'),
        dim([{ name: 'PassportKey', dataType: 'int64', isKey: true }, { name: 'PersonKey', dataType: 'int64' }], 'Passport'),
        dim([{ name: 'PersonKey', dataType: 'int64' }, { name: 'Badge', dataType: 'string' }], 'Badge'),
        dim([{ name: 'Tag', dataType: 'string' }], 'Tags'),
        dim([{ name: 'Tag', dataType: 'string' }], 'Posts'),
      ],
      relationships: [
        { from: ['Passport', 'PersonKey'], to: ['Person', 'PersonKey'], fromCardinality: 'one', toCardinality: 'one' },
        { from: ['Person', 'PersonKey'], to: ['Badge', 'PersonKey'], fromCardinality: 'one', toCardinality: 'one' },
        { from: ['Posts', 'Tag'], to: ['Tags', 'Tag'], fromCardinality: 'many', toCardinality: 'many' },
      ],
    });
    // Written unique; Import DBML keeps that as the one-to-one itself (the relationship already says it).
    expect(r.result.dbml).toMatch(/Table passport [^}]*person_key bigint \[unique, foreign_key/);
    expect(r.plan.relationships.find((x) => x.fromModel === 'passport' || x.toModel === 'passport')?.cardinality).toBe('one-to-one');
    expect(r.pk('person')).toEqual(['person_key']);
    // Badge is the "to" end of a one-to-one with no key: its only joined column becomes its key.
    expect(r.pk('badge')).toEqual(['person_key']);
    expect(r.unique('tags')).toEqual([]);
    expect(r.unique('posts')).toEqual([]);
    expect(r.plan.relationships.map((x) => x.cardinality).sort()).toEqual(['many-to-many', 'one-to-one', 'one-to-one']);
  });

  it('inactive role-playing links count: Power BI requires their "one" end unique too', () => {
    const r = run({
      tables: [fact, dim([{ name: 'Date', dataType: 'dateTime', isKey: true }, { name: 'DateKey', dataType: 'int64' }])],
      relationships: [{ from: ['Fact', 'A'], to: ['Dim', 'DateKey'], isActive: false }, { from: ['Fact', 'B'], to: ['Dim', 'DateKey'], isActive: false }],
    });
    expect(r.unique('dim')).toEqual(['date_key']);
    expect(r.result.ledger.filter((e) => e.unit === 'uniqueKey')).toHaveLength(1);
  });

  it('relationships into a calculated table infer its key like any other', () => {
    const r = run({ tables: [fact, { name: 'Seg', dax: 'DATATABLE()', columns: [{ name: 'S', dataType: 'string' }] }], relationships: [{ from: ['Fact', 'A'], to: ['Seg', 'S'] }] });
    expect(r.pk('seg')).toEqual(['s']);
  });

  it('keeps isNullable false as not null, and TMSL isUnique as unique', () => {
    const files = toTmsl(one([{ name: 'a', dataType: 'string', isNullable: false }, { name: 'b', dataType: 'string' }]));
    const json = JSON.parse(files[0].text);
    json.model.tables[0].columns[1].isUnique = true;
    const p = plan(semanticModelToDbml(read([{ path: files[0].path, text: JSON.stringify(json) }])).dbml);
    expect(p.newTables[0].columns.map((c) => c.meta?.dbml)).toEqual([{ not_null: true }, { unique: true }]);
  });
});

describe('descriptions kept verbatim', () => {
  const texts = ['No final punctuation', 'Ends in an ellipsis...', 'A question?', 'Loud!', 'Sales 📈 by store', 'First line\nsecond line\n\nfourth', 'Unicode … ellipsis…', "It's quoted \"twice\" and has a \\ backslash"];

  it.each([['TMDL', toTmdl], ['TMSL', toTmsl], ['TMSL as arrays', (s: ModelSpec) => toTmsl(s, { arrays: true })]] as const)('%s: every description byte for byte, table and column', (_label, write) => {
    const spec: ModelSpec = { tables: texts.map((d, i) => ({ name: `T${i}`, description: d, columns: [{ name: 'c', dataType: 'string', description: d }] })), relationships: [] };
    const p = plan(semanticModelToDbml(read(write(spec))).dbml);
    expect(p.newTables.map((t) => t.description)).toEqual(texts);
    expect(p.newTables.map((t) => t.columns[0].description)).toEqual(texts);
  });

  it('keeps a calculated column\'s description as written; with none, the note says its DAX was not imported; empty stays empty', () => {
    const p = plan(semanticModelToDbml(read(toTmdl(one([
      { name: 'a', dataType: 'int64', dax: '1', description: 'Plain' },
      { name: 'b', dataType: 'int64', dax: '1', description: 'Already ends.' },
      { name: 'c', dataType: 'int64', dax: '1' },
      { name: 'd', dataType: 'int64' },
    ])))).dbml);
    expect(p.newTables[0].columns.map((c) => c.description)).toEqual(['Plain', 'Already ends.', CALCULATED_COLUMN_NOTE, '']);
    expect(sentenceJoin(['x'])).toBe('x');
    expect(sentenceJoin(['  x  ', ''])).toBe('x');
    expect(sentenceJoin(['Why?', 'Then'])).toBe('Why? Then');
    expect(sentenceJoin(['Wait…', 'Then'])).toBe('Wait… Then');
  });

  it('a TMDL /// block of blank lines is no description', () => {
    const files = toTmdl(one([{ name: 'c', dataType: 'string' }]));
    files[2] = { ...files[2], text: `///\n/// \n${files[2].text}` };
    expect(read(files).tables[0].description).toBeUndefined();
  });
});

describe('model names', () => {
  const tmsl = (path: string, database?: string, model?: string): string => {
    const r = readSemanticModel([{ path, text: JSON.stringify({ ...(database ? { name: database } : {}), model: { ...(model ? { name: model } : {}), tables: [{ name: 'T', columns: [{ name: 'c' }] }] } }) }]);
    if (!r.ok) throw new Error('did not read');
    return r.model.name;
  };

  it('prefers the <Name>.SemanticModel / .Dataset folder, then a database name that is not a tool default, then the folder (the model.bim\'s, or X of X.bim)', () => {
    expect(tmsl('repo/Sales.SemanticModel/model.bim', 'SemanticModel')).toBe('Sales');
    expect(tmsl('repo/Old Sales.Dataset/model.bim', 'Finance')).toBe('Old Sales');
    expect(tmsl('repo/AsPartitionProcessing.AdventureWorks/Model.bim', 'SemanticModel')).toBe('AsPartitionProcessing.AdventureWorks');
    expect(tmsl('repo/Tabular/Model.bim', 'Model', 'Model')).toBe('Tabular');
    expect(tmsl('repo/x/model.bim', '3f1c2d3e-4b5a-4c6d-9e8f-0a1b2c3d4e5f')).toBe('x');
    expect(tmsl('repo/x/model.bim', 'Finance Ops')).toBe('Finance Ops');
    expect(tmsl('repo/Budget 2025.bim', 'SemanticModel')).toBe('Budget 2025');
    expect(tmsl('model.bim')).toBe('semantic-model');
    expect(tmsl('repo/Ventes Été/model.bim', 'Model')).toBe('Ventes Été');
  });

  it('reads Fabric\'s .platform displayName (for TMDL and TMSL) and ignores one that does not parse', () => {
    const platform = (displayName: string) => JSON.stringify({ metadata: { type: 'SemanticModel', displayName }, config: { version: '2.0' } });
    const tmdl = toTmdl({ ...one([{ name: 'c', dataType: 'string' }]), database: 'Model' }).map((f) => ({ ...f, path: f.path.replace('Spec.SemanticModel/', 'fabric/') }));
    expect(read([...tmdl, { path: 'fabric/.platform', text: platform('Sales Insights (EU)') }]).name).toBe('Sales Insights (EU)');
    expect(read([...tmdl, { path: 'fabric/.platform', text: '{ not json' }]).name).toBe('fabric');
    expect(read(tmdl).name).toBe('fabric');
    // The item's displayName wins over its folder's name (a renamed item keeps its first folder).
    const pbip = toTmdl(one([{ name: 'c', dataType: 'string' }]));
    expect(read([...pbip, { path: 'Spec.SemanticModel/.platform', text: platform('Spec Renamed') }]).name).toBe('Spec Renamed');
    expect(read([...toTmsl(one([{ name: 'c' }])).map((f) => ({ ...f, path: 'bare/model.bim' })), { path: 'bare/.platform', text: platform('Retail') }]).name).toBe('Retail');
    expect(platformDisplayName('\uFEFF' + platform('  Spaced  '))).toBe('Spaced');
    expect(platformDisplayName('{}')).toBeUndefined();
  });

  it('a TMDL model with a default database name is named after its folder', () => {
    const files = toTmdl({ ...one([{ name: 'c', dataType: 'string' }]), database: 'SemanticModel' }).map((f) => ({ ...f, path: f.path.replace('Spec.SemanticModel/', 'My.Model v2/') }));
    expect(read(files).name).toBe('My.Model v2');
    expect(isDefaultModelName('Model')).toBe(true);
    expect(isDefaultModelName('semantic model')).toBe(true);
    expect(isDefaultModelName('{3F1C2D3E-4B5A-4C6D-9E8F-0A1B2C3D4E5F}')).toBe(true);
    expect(isDefaultModelName('Sales Model')).toBe(false);
  });
});

describe('M sources', () => {
  it('navigations: SQL Server / Fabric warehouse, Snowflake, Databricks, Fabric lakehouse; schema-less items', () => {
    expect(mNavigationTable('Source = Sql.Database("s", "d"), T = Source{[Schema="dbo",Item="DimDate"]}[Data]')).toBe('dbo.DimDate');
    expect(mNavigationTable('S = Snowflake.Databases("a"), D = S{[Name="DB",Kind="Database"]}[Data], Sc = D{[Name="PUBLIC",Kind="Schema"]}[Data], T = Sc{[Name="ORDERS",Kind="Table"]}[Data]')).toBe('PUBLIC.ORDERS');
    expect(mNavigationTable('S = Databricks.Catalogs("h","p"), C = S{[Name="main",Kind="Database"]}[Data], Sc = C{[Name="gold",Kind="Schema"]}[Data], V = Sc{[Name="v_sales",Kind="View"]}[Data]')).toBe('gold.v_sales');
    expect(mNavigationTable('S = Lakehouse.Contents(null), W = S{[workspaceId="w"]}[Data], L = W{[lakehouseId="l"]}[Data], T = L{[Id="customer",ItemKind="Table"]}[Data]')).toBe('customer');
    expect(mNavigationTable('T = Source{[Item="Orders"]}[Data]')).toBe('Orders');
    expect(mNavigationTable('T = Source{[Schema="we ""quote""",Item="t"]}[Data]')).toBe('we "quote".t');
    expect(mNavigationTable('let Source = #table({}, {}) in Source')).toBeUndefined();
  });

  it('native queries, file and web sources, and other M are told apart; a shared expression is followed only when the query starts from it', () => {
    expect(describeMSource('Value.NativeQuery(Sql.Database("s","d"), "select 1")').kind).toBe('nativeQuery');
    expect(describeMSource('Sql.Database("s", "d", [Query="select * from t"])').kind).toBe('nativeQuery');
    expect(describeMSource('Csv.Document(File.Contents("x.csv"))').kind).toBe('file');
    expect(describeMSource('Excel.Workbook(Web.Contents("https://x/y.xlsx"))').kind).toBe('file');
    expect(describeMSource('#table({"a"}, {{1}})').kind).toBe('other');
    const expressions = new Map([['Staging', 'let S = Sql.Database(a, b), T = S{[Schema="stage",Item="p"]}[Data] in T'], ['Two Words', 'S{[Schema="x",Item="y"]}']]);
    expect(describeMSource('let\n    Source = Staging,\n    K = Table.SelectColumns(Source, {"a"})\nin\n    K', expressions)).toEqual({ kind: 'navigation', table: 'stage.p' });
    expect(describeMSource('let Source = #"Two Words" in Source', expressions)).toEqual({ kind: 'navigation', table: 'x.y' });
    expect(describeMSource('Staging', expressions)).toEqual({ kind: 'navigation', table: 'stage.p' });
    // Only used inside a step (a generated calendar reading a min date): not where the rows come from.
    expect(describeMSource('let D = List.Dates(List.Min(Staging[Date]), 10, #duration(1,0,0,0)) in D', expressions).kind).toBe('other');
    // A name that only starts like the expression's.
    expect(describeMSource('let Source = Staging2, K = Source in K', expressions).kind).toBe('other');
  });

  it('a Direct Lake entity partition and a legacy query partition', () => {
    const lake = read(toTmdl(one([{ name: 'c', dataType: 'string' }], { entity: { schema: 'sales', name: 'orders' } })));
    expect(lake.tables[0].source).toMatchObject({ kind: 'entity', table: 'sales.orders' });
    const noSchema = read(toTmsl(one([{ name: 'c', dataType: 'string' }], { entity: { name: 'orders' } })));
    expect(noSchema.tables[0].source).toMatchObject({ kind: 'entity', table: 'orders' });
    const files = toTmsl(one([{ name: 'c', dataType: 'string' }], { m: ['x'] }));
    const json = JSON.parse(files[0].text);
    json.model.tables[0].partitions[0].source = { type: 'query', query: 'SELECT * FROM t', dataSource: 'SqlServer' };
    const legacy = semanticModelToDbml(read([{ path: files[0].path, text: JSON.stringify(json) }]));
    expect(legacy.ledger).toContainEqual(expect.objectContaining({ outcome: 'lost', what: 'native query', where: expect.objectContaining({ table: 'T' }) }));
  });

  it('parameters and multi-line let … in from expressions.tmdl: named in the ledger, never imported', () => {
    const result = semanticModelToDbml(read(toTmdl(RICH)));
    expect(result.ledger.filter((e) => e.what === 'Power Query parameter').map((e) => e.where?.table).sort()).toEqual(['Database', 'Server']);
    expect(result.ledger.filter((e) => e.what === 'Power Query expression').map((e) => e.where?.table)).toEqual(['Staging']);
    expect(result.dbml).not.toMatch(/Sql\.Database|IsParameterQuery/);
  });
});

describe('reported features', () => {
  it('a variation onto an auto date/time table goes with that table (already reported), any other is named', () => {
    const spec: ModelSpec = {
      tables: [
        { name: 'Fact', columns: [{ name: 'D', dataType: 'dateTime', variation: { table: 'LocalDateTable_1a2b', hierarchy: 'Date Hierarchy' } }, { name: 'E', dataType: 'dateTime', variation: { table: 'Calendar', hierarchy: 'Fiscal' } }] },
        { name: 'LocalDateTable_1a2b', columns: [{ name: 'Date', dataType: 'dateTime', settings: { summarizeBy: 'none' } }], hierarchies: [{ name: 'Date Hierarchy', levels: ['Date'] }] },
        { name: 'Calendar', columns: [{ name: 'Date', dataType: 'dateTime' }] },
      ],
      relationships: [],
    };
    for (const write of [toTmdl, toTmsl]) {
      const result = semanticModelToDbml(read(write(spec)));
      expect(result.ledger.filter((e) => e.outcome === 'lost').map((e) => `${e.what}:${e.where?.table}.${e.where?.column}`)).toEqual(['variation:Fact.E']);
    }
  });

  it('a calculation group\'s items are counted with it, never named as lost', () => {
    const result = semanticModelToDbml(read(toTmdl(one([{ name: 'Name', dataType: 'string' }], { calculationItems: ['A', 'B', 'C'] }))));
    expect(result.tableCount).toBe(0);
    expect(ledgerTotals(result.ledger).skipped).toEqual({ table: 1, object: 3 });
    expect(result.ledger.some((e) => e.outcome === 'lost')).toBe(false);
  });

  it('a column permission that grants read hides nothing, so is not named', () => {
    for (const write of [toTmdl, toTmsl]) {
      const files = write({ ...one([{ name: 'a', dataType: 'string' }]), roles: [{ name: 'R', hiddenColumns: [['T', 'a']] }] });
      const text = files.map((f) => ({ ...f, text: f.text.replace(/metadataPermission(["']?):\s*(["']?)none/g, 'metadataPermission$1: $2read') }));
      const result = semanticModelToDbml(read(text));
      expect(result.ledger.filter((e) => e.what === 'column permission')).toEqual([]);
      expect(result.ledger.filter((e) => e.what === 'security role')).toHaveLength(1);
    }
  });

  it('OLS: a table hidden by a role and a hidden column are named apart from the row filter', () => {
    const result = semanticModelToDbml(read(toTmdl(RICH)));
    expect(result.ledger.filter((e) => e.unit === 'object' && /permission|row filter/.test(e.what)).map((e) => `${e.what}:${e.where?.table}${e.where?.column ? `.${e.where.column}` : ''}`).sort())
      .toEqual(['column permission:Customer.Phone', 'row filter:Customer', 'table permission:Targets']);
  });

  it('renders security first and report settings last, each line counted', () => {
    const lines = ledgerLeftOut(semanticModelToDbml(read(toTmdl(RICH))).ledger);
    expect(lines[0]).toMatch(/^1 object: security role not kept/);
    expect(lines.findIndex((l) => /summarizeBy/.test(l))).toBeGreaterThan(lines.findIndex((l) => /hierarchy/.test(l)));
    expect(lines.find((l) => /formatString/.test(l))).toMatch(/^6 settings: formatString not kept: a report setting/);
  });
});

describe('format robustness', () => {
  it('a missing dataType is variant; quoted names with escaped quotes; ``` fences; ref table order', () => {
    const spec: ModelSpec = {
      tables: [
        { name: "O'Brien's", columns: [{ name: "Owner's Name", dataType: 'string' }, { name: 'Untyped' }, { name: 'Calc', dax: 'IF(TRUE(), "a", "b")' }] },
        { name: 'Second', columns: [{ name: 'x', dataType: 'int64' }] },
      ],
      relationships: [],
    };
    const model = read(toTmdl(spec, { refReverse: true }));
    // model.tmdl lists the tables in reverse: that order wins.
    expect(model.tables.map((t) => t.name)).toEqual(['Second', "O'Brien's"]);
    const p = plan(semanticModelToDbml(model).dbml);
    const t = p.newTables.find((x) => x.meta?.[SEMANTIC_MODEL_META.name] === "O'Brien's")!;
    expect(t.columns.map((c) => `${c.name}:${c.dataType}`)).toEqual(['owner_s_name:varchar', 'untyped:variant', 'calc:variant']);
  });

  it('every compatibility level from 1200 to 1604 reads the same', () => {
    const dbml = (level: number) => semanticModelToDbml(read(toTmsl(RICH, { compatibilityLevel: level }))).dbml;
    const first = dbml(1200);
    for (const level of [1400, 1500, 1550, 1600, 1604]) expect(dbml(level)).toBe(first);
  });
});

describe('the conversion stays deterministic and its ledger JSON-safe', () => {
  it('converts twice to the same text and ledger, and the ledger survives JSON', () => {
    const a = semanticModelToDbml(read(toTmdl(RICH)));
    const b = semanticModelToDbml(read(toTmdl(RICH, { reverse: true })));
    expect(b.dbml).toBe(a.dbml);
    expect(JSON.parse(JSON.stringify(a.ledger))).toEqual(a.ledger);
  });
});
