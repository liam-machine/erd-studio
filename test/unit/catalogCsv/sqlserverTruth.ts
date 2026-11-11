/**
 * Scores a DBML text (from either import route) against truth.json. Shared by the scratch comparison
 * and by the committed fixture test. Pure.
 */
import { readDbml, type DbmlModel } from '../../../src/services/dbmlImportParse';

export interface Truth {
  tables: Array<{ schema: string; name: string; pk: string[]; identity?: string[]; comment?: string; columns: Array<[string, string, boolean, (string | null)?, (string | null)?]> }>;
  views: Array<{ schema: string; name: string }>;
  uniques: Array<{ schema: string; table: string; name: string; columns: string[] }>;
  notUnique: Array<{ schema: string; table: string; name: string }>;
  foreignKeys: Array<{ name: string; from: string; columns: string[]; to: string; refColumns: string[] }>;
}

export interface RouteScore {
  tables: [number, number];
  columns: [number, number];
  typesExact: [number, number];
  typeMismatches: string[];
  notNull: [number, number];
  primaryKeys: [number, number];
  uniqueKeys: [number, number];
  wrongUnique: string[];
  foreignKeys: [number, number];
  fkMismatches: string[];
  tableComments: [number, number];
  columnComments: [number, number];
  commentMismatches: string[];
  defaults: [number, number];
  defaultMismatches: string[];
  identity: [number, number];
  viewsImported: number;
}

const key = (s: string | null, t: string): string => `${(s ?? '').toLowerCase()}.${t.toLowerCase()}`;
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.some((y) => y.toLowerCase() === x.toLowerCase()));
/** A default as the route kept it, spelled as a SQL literal would be ('AU', 0, now()). */
const defaultText = (d: { type: string; value: string } | undefined): string | null => (!d ? null : d.type === 'string' ? `'${d.value.replace(/'/g, "''")}'` : d.value);

export function scoreDbml(dbml: string, truth: Truth): RouteScore {
  const read = readDbml(dbml);
  if (!read.ok) throw new Error(`DBML does not read: ${JSON.stringify(read.diagnostics)}`);
  const m: DbmlModel = read.model;
  const byKey = new Map(m.tables.map((t) => [key(t.schema, t.name), t]));
  const s: RouteScore = {
    tables: [0, truth.tables.length], columns: [0, 0], typesExact: [0, 0], typeMismatches: [], notNull: [0, 0], primaryKeys: [0, truth.tables.filter((t) => t.pk.length).length],
    uniqueKeys: [0, truth.uniques.length], wrongUnique: [], foreignKeys: [0, truth.foreignKeys.length], fkMismatches: [],
    tableComments: [0, truth.tables.filter((t) => t.comment).length], columnComments: [0, 0], commentMismatches: [], defaults: [0, 0], defaultMismatches: [],
    identity: [0, 0], viewsImported: truth.views.filter((v) => byKey.has(key(v.schema, v.name))).length,
  };
  for (const tt of truth.tables) {
    const t = byKey.get(key(tt.schema, tt.name));
    s.columns[1] += tt.columns.length;
    for (const c of tt.columns) {
      if (c[4]) s.columnComments[1]++;
      if (c[3]) s.defaults[1]++;
      if (!c[2]) s.notNull[1]++;
    }
    s.identity[1] += (tt.identity ?? []).length;
    if (!t) continue;
    s.tables[0]++;
    if (tt.comment) { if (t.note === tt.comment) s.tableComments[0]++; else s.commentMismatches.push(`${tt.name}: ${JSON.stringify(t.note)}`); }
    // In key order: a composite key's column order is part of it.
    const pkCols = [...t.fields.filter((f) => f.pk).map((f) => f.name), ...t.indexes.filter((i) => i.pk).flatMap((i) => i.columns.map((c) => c.value))];
    if (tt.pk.length && pkCols.length === tt.pk.length && pkCols.every((c, i) => c.toLowerCase() === tt.pk[i].toLowerCase())) s.primaryKeys[0]++;
    for (const [name, type, nullable, def, comment] of tt.columns) {
      const f = t.fields.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!f) continue;
      s.columns[0]++;
      s.typesExact[1]++;
      if (f.type.replace(/\s+/g, '').toLowerCase() === type.replace(/\s+/g, '').toLowerCase()) s.typesExact[0]++; else s.typeMismatches.push(`${tt.name}.${name}: ${f.type} (truth ${type})`);
      const notNull = f.notNull || f.pk || tt.pk.includes(name);
      if (!nullable && notNull) s.notNull[0]++;
      if (comment) { if (f.note === comment) s.columnComments[0]++; else s.commentMismatches.push(`${tt.name}.${name}: ${JSON.stringify(f.note)}`); }
      if (def) { const got = defaultText(f.default); if (got === def) s.defaults[0]++; else s.defaultMismatches.push(`${tt.name}.${name}: ${got} (truth ${def})`); }
      if ((tt.identity ?? []).includes(name) && f.increment) s.identity[0]++;
    }
  }
  // Unique keys: single-column [unique] or a unique index; nothing else may be marked unique.
  const uniqueSets: Array<{ table: string; cols: string[] }> = [];
  for (const t of m.tables) {
    for (const f of t.fields) if (f.unique) uniqueSets.push({ table: key(t.schema, t.name), cols: [f.name] });
    for (const i of t.indexes) if (i.unique && !i.pk) uniqueSets.push({ table: key(t.schema, t.name), cols: i.columns.map((c) => c.value) });
  }
  for (const u of truth.uniques) if (uniqueSets.some((x) => x.table === key(u.schema, u.table) && sameSet(x.cols, u.columns))) s.uniqueKeys[0]++;
  for (const x of uniqueSets) if (!truth.uniques.some((u) => x.table === key(u.schema, u.table) && sameSet(x.cols, u.columns))) s.wrongUnique.push(`${x.table}(${x.cols.join(', ')})`);
  // Foreign keys: the many end's columns paired with the referenced columns, in order.
  for (const fk of truth.foreignKeys) {
    const [fs, ft] = fk.from.split('.');
    const [ts, tt] = fk.to.split('.');
    const pairs = fk.columns.map((c, i) => `${c.toLowerCase()}>${fk.refColumns[i].toLowerCase()}`).sort().join(',');
    const hit = m.refs.some((r) => {
      for (const [a, b] of [[0, 1], [1, 0]] as const) {
        const from = r.ends[a]; const to = r.ends[b];
        if (key(from.schema, from.table) !== key(fs, ft) || key(to.schema, to.table) !== key(ts, tt)) continue;
        const got = from.columns.map((c, i) => `${c.toLowerCase()}>${(to.columns[i] ?? '').toLowerCase()}`).sort().join(',');
        if (got === pairs && (from.relation === '*' || from.relation === '1' && (to.relation === '1'))) return true;
      }
      return false;
    });
    if (hit) s.foreignKeys[0]++; else s.fkMismatches.push(fk.name);
  }
  return s;
}
