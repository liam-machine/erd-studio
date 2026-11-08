/**
 * Grammar-free salvage: the last rung of the repair ladder
 * (`sqlDdlRepair.ts`). When no grammar reads a `CREATE TABLE`, even
 * rewritten, its column list is read here with the lexer's own tokens:
 * each column's name, its type as written (up to the first constraint word),
 * `NOT NULL` / `NULL`, `PRIMARY KEY`, `UNIQUE`, `REFERENCES t (c)`,
 * `DEFAULT …`, `COMMENT '…'`, `CHECK (…)` and identity
 * (`IDENTITY`, `AUTO_INCREMENT`, `AUTOINCREMENT`, `GENERATED … AS IDENTITY`,
 * `serial`); and the table's `PRIMARY KEY`, `UNIQUE` and `FOREIGN KEY`
 * constraints. The result has the grammars' raw shape (`RawSqlDatabase`), so
 * the converter's column reading and DBML writer are the same for every
 * table.
 *
 * Salvage is strict about structure, so a statement that is broken (not just
 * outside a grammar) is still a problem with a line: an empty column
 * definition, a column without a type, or a word after a type that is
 * neither part of a type nor a constraint or modifier it knows.
 *
 * Pure: no `vscode`, no `@dbml/core`. Bundled into `dist/cli.js` and
 * `dist/sqlImport.js`.
 */

import type { LedgerCause } from './importLedger';
import { isName, isPunct, matchParen, readName, splitTopLevel, upper, type Statement, type Token } from './sqlDdlLexer';
import type { RawSqlDatabase, RawSqlField, RawSqlIndex, RawSqlRef, RawSqlTable } from './sqlDdlModel';
import { cleanTypeText, columnTypeSpan, isConstraintItem, strayTypeToken } from './sqlDdlRepair';

export type SalvageResult =
  | { ok: true; raw: RawSqlDatabase }
  | { ok: false; line: number; reason: string; cause: LedgerCause };

/** Modifiers salvage reads past (with how many value tokens follow the word). */
const SKIPPED_MODIFIERS: Readonly<Record<string, number>> = {
  INVISIBLE: 0, VISIBLE: 0, SPARSE: 0, ROWGUIDCOL: 0, FILESTREAM: 0, PERSISTED: 0, STORED: 0, VIRTUAL: 0, ENFORCED: 0,
  RELY: 0, NORELY: 0, NOVALIDATE: 0, VALIDATE: 0, DEFERRABLE: 0, CLUSTERED: 0, NONCLUSTERED: 0, ASC: 0, DESC: 0, KEY: 0,
  SRID: 1, ENCODE: 1, COLLATE: 1, CHARSET: 1, COMPRESSION: 1, STORAGE: 1, COLUMN_FORMAT: 1,
};

/** MySQL attributes written `WORD [=] 'value'`. */
const ASSIGNED_MODIFIERS = new Set(['ENGINE_ATTRIBUTE', 'SECONDARY_ENGINE_ATTRIBUTE']);

const IDENTITY_WORDS = new Set(['IDENTITY', 'AUTO_INCREMENT', 'AUTOINCREMENT']);

/** Reads `CREATE TABLE <name> ( … )` without a grammar. */
export function salvageCreateTable(
  text: string,
  st: Statement,
  name: { parts: string[]; next: number },
  open: number,
  close: number,
): SalvageResult {
  const t = st.tokens;
  const tableName = name.parts[name.parts.length - 1];
  const schemaName = name.parts.length >= 2 ? name.parts[name.parts.length - 2] : null;
  const table: RawSqlTable = { name: tableName, schemaName, fields: [], indexes: [], checks: [] };
  const refs: RawSqlRef[] = [];
  const fail = (at: number, reason: string, cause: LedgerCause = 'parseError'): SalvageResult => ({ ok: false, line: t[Math.min(at, t.length - 1)]?.line ?? st.line, reason, cause });
  const endpoint = (parts: string[], fieldNames: string[], relation: string) => ({
    tableName: parts[parts.length - 1],
    schemaName: parts.length >= 2 ? parts[parts.length - 2] : null,
    fieldNames,
    relation,
  });
  /**
   * A parenthesised list of columns at `at`: each item's column, and whether
   * any item is an expression instead (`(lower(email))`, `(a + b)`), which is
   * never read as a column named like its first word.
   */
  const columnList = (at: number): { columns: string[]; expression: boolean; next: number } | undefined => {
    if (!isPunct(t[at], '(')) return undefined;
    const end = matchParen(t as Token[], at);
    if (end < 0) return undefined;
    const columns: string[] = [];
    let expression = false;
    for (const [from, to] of splitTopLevel(t as Token[], at + 1, end, false)) {
      if (from >= to) continue;
      const column = keyPartColumn(t, from, to);
      if (column === undefined) expression = true;
      else columns.push(column);
    }
    return { columns, expression, next: end + 1 };
  };
  /** `REFERENCES name [(cols)] [ON DELETE x] [ON UPDATE y] …` at `at`: the ref's far end and actions, and the index after. */
  const references = (at: number, to: number): { parts: string[]; columns: string[]; onDelete?: string; onUpdate?: string; next: number } | undefined => {
    const target = readName(t as Token[], at + 1);
    if (!target) return undefined;
    let k = target.next;
    const list = columnList(k);
    if (list) k = list.next;
    const out: { parts: string[]; columns: string[]; onDelete?: string; onUpdate?: string; next: number } = { parts: target.parts, columns: list?.columns ?? [], next: k };
    while (k < to) {
      const w = upper(t[k]);
      if (w === 'ON' && (upper(t[k + 1]) === 'DELETE' || upper(t[k + 1]) === 'UPDATE')) {
        const which = upper(t[k + 1]);
        const words: string[] = [];
        let j = k + 2;
        while (j < to && t[j].kind === 'word' && /^(CASCADE|RESTRICT|NO|ACTION|SET|NULL|DEFAULT)$/.test(upper(t[j]))) { words.push(upper(t[j])); j++; }
        // PostgreSQL 15's `SET NULL (col, …)`: the columns it sets (the action is the same).
        if (isPunct(t[j], '(') && words[0] === 'SET') { const end = matchParen(t as Token[], j); if (end > 0) j = end + 1; }
        if (which === 'DELETE') out.onDelete = words.join(' ').toLowerCase();
        else out.onUpdate = words.join(' ').toLowerCase();
        k = j;
        continue;
      }
      if (w === 'MATCH' || w === 'INITIALLY') { k += 2; continue; }
      if (w === 'NOT' && (upper(t[k + 1]) === 'DEFERRABLE' || upper(t[k + 1]) === 'ENFORCED' || upper(t[k + 1]) === 'FOR')) { k += upper(t[k + 1]) === 'FOR' ? 3 : 2; continue; }
      if (w === 'DEFERRABLE' || w === 'ENFORCED' || w === 'RELY' || w === 'NORELY' || w === 'NOVALIDATE') { k++; continue; }
      break;
    }
    out.next = k;
    return out;
  };

  const items = splitTopLevel(t as Token[], open + 1, close, true);
  if (items.length === 0) return fail(open, 'its column list is empty', 'other');
  for (let index = 0; index < items.length; index++) {
    const [from, to] = items[index];
    if (from >= to) return fail(Math.min(from, close), 'an empty column definition (two commas in a row)');
    if (isConstraintItem(t, from, to)) {
      const problem = readConstraint(from, to);
      if (problem) return problem;
      continue;
    }
    if (!isName(t[from])) return fail(from, `a column definition that does not start with a name`);
    const field: RawSqlField = { name: t[from].value };
    const span = columnTypeSpan(t, from, to);
    if (span.end > span.start) {
      const stray = strayTypeToken(t, span.start, span.end);
      if (stray >= 0) return fail(stray, `unexpected "${shortWord(t[stray].value)}" after the type of ${shortWord(field.name)}`);
      const typeText = cleanTypeText(text.slice(t[span.start].start, t[span.end - 1].end));
      field.type = { type_name: typeText };
      if (/^(small|big)?serial[248]?$/i.test(typeText)) field.increment = true;
    } else if (!(upper(t[span.end]) === 'AS' && isPunct(t[span.end + 1], '('))) {
      return fail(span.end < to ? span.end : from, `the column ${shortWord(field.name)} has no type`);
    } else {
      field.type = { type_name: '' };
    }
    const problem = readColumnConstraints(field, span.end, to);
    if (problem) return problem;
    table.fields!.push(field);
  }
  return { ok: true, raw: { tables: [table], refs } };

  function readColumnConstraints(field: RawSqlField, from: number, to: number): SalvageResult | undefined {
    let k = from;
    while (k < to) {
      const w = upper(t[k]);
      const next = upper(t[k + 1]);
      if (w === 'NOT' && next === 'NULL') { field.not_null = true; k += 2; continue; }
      if (w === 'NULL') { k++; continue; }
      if (w === 'PRIMARY' && next === 'KEY') { field.pk = true; k += 2; continue; }
      if (w === 'UNIQUE') { field.unique = true; k++; if (upper(t[k]) === 'KEY') k++; continue; }
      if (w === 'CONSTRAINT' && isName(t[k + 1])) { k += 2; continue; }
      if (w === 'DEFAULT') {
        const end = expressionEnd(k + 1, to);
        if (end === k + 1) return fail(k, `DEFAULT without a value on ${shortWord(field.name)}`);
        field.dbdefault = defaultOf(k + 1, end);
        k = end;
        continue;
      }
      if (w === 'COMMENT') {
        const value = isPunct(t[k + 1], '=') ? k + 2 : k + 1;
        if (t[value]?.kind !== 'string') return fail(k, `COMMENT without a string on ${shortWord(field.name)}`);
        field.note = t[value].value;
        k = value + 1;
        continue;
      }
      if (w === 'CHECK' && isPunct(t[k + 1], '(')) {
        const end = matchParen(t as Token[], k + 1);
        if (end < 0) return fail(k, 'a CHECK whose parenthesis never closes');
        (field.checks ??= []).push({ expression: text.slice(t[k + 2]?.start ?? t[end].start, t[end - 1]?.end ?? t[end].start).replace(/\s+/g, ' ').trim() });
        k = end + 1;
        continue;
      }
      if (w === 'REFERENCES') {
        const ref = references(k, to);
        if (!ref) return fail(k, `REFERENCES without a table on ${shortWord(field.name)}`);
        refs.push({
          endpoints: [endpoint([...(schemaName ? [schemaName] : []), tableName], [field.name], '*'), endpoint(ref.parts, ref.columns, '1')],
          ...(ref.onDelete ? { onDelete: ref.onDelete } : {}),
          ...(ref.onUpdate ? { onUpdate: ref.onUpdate } : {}),
        });
        k = ref.next;
        continue;
      }
      if (w === 'GENERATED') {
        let a = k + 1;
        while (a < to && upper(t[a]) !== 'AS') a++;
        if (upper(t[a + 1]) === 'IDENTITY') {
          field.increment = true;
          k = a + 2;
          if (isPunct(t[k], '(')) k = matchParen(t as Token[], k) + 1;
          continue;
        }
        if (isPunct(t[a + 1], '(')) { const end = matchParen(t as Token[], a + 1); if (end < 0) return fail(k, 'a generated column whose parenthesis never closes'); k = end + 1; continue; }
        return fail(k, `an unexpected GENERATED clause on ${shortWord(field.name)}`);
      }
      if (w === 'AS' && isPunct(t[k + 1], '(')) { const end = matchParen(t as Token[], k + 1); if (end < 0) return fail(k, 'a computed column whose parenthesis never closes'); k = end + 1; continue; }
      if (IDENTITY_WORDS.has(w)) {
        field.increment = true;
        k++;
        if (isPunct(t[k], '(')) { const end = matchParen(t as Token[], k); k = end < 0 ? to : end + 1; }
        while ((upper(t[k]) === 'START' || upper(t[k]) === 'INCREMENT') && k < to) k += upper(t[k + 1]) === 'WITH' || upper(t[k + 1]) === 'BY' ? 3 : 2;
        if (upper(t[k]) === 'ORDER' || upper(t[k]) === 'NOORDER') k++;
        continue;
      }
      if (w === 'ON' && next === 'UPDATE') { k += 3; if (isPunct(t[k], '(')) { const end = matchParen(t as Token[], k); k = end < 0 ? to : end + 1; } continue; }
      if (w === 'CHARACTER' && next === 'SET') { k += 3; continue; }
      if (w === 'NOT' && next === 'FOR' && upper(t[k + 2]) === 'REPLICATION') { k += 3; continue; }
      if (w === 'NOT' && (next === 'ENFORCED' || next === 'DEFERRABLE')) { k += 2; continue; }
      if (w === 'INITIALLY') { k += 2; continue; }
      // SQL Server's inline `FOREIGN KEY REFERENCES t (c)`.
      if (w === 'FOREIGN' && next === 'KEY' && upper(t[k + 2]) === 'REFERENCES') { k += 2; continue; }
      if (w === 'MASK' && isName(t[k + 1])) {
        // Databricks' MASK [catalog.schema.]fn [USING COLUMNS (…)].
        k = readName(t as Token[], k + 1)?.next ?? k + 2;
        if (upper(t[k]) === 'USING') { k++; if (upper(t[k]) === 'COLUMNS') k++; if (isPunct(t[k], '(')) { const end = matchParen(t as Token[], k); k = end < 0 ? to : end + 1; } }
        continue;
      }
      const policyAt = w === 'WITH' && (next === 'MASKING' || next === 'PROJECTION') ? k + 1 : (w === 'MASKING' || w === 'PROJECTION') ? k : -1;
      if (policyAt >= 0 && upper(t[policyAt + 1]) === 'POLICY' && isName(t[policyAt + 2])) {
        // Snowflake's [WITH] MASKING | PROJECTION POLICY [db.schema.]fn [USING (…)].
        k = readName(t as Token[], policyAt + 2)?.next ?? policyAt + 3;
        if (upper(t[k]) === 'USING' && isPunct(t[k + 1], '(')) { const end = matchParen(t as Token[], k + 1); k = end < 0 ? to : end + 1; }
        continue;
      }
      if (ASSIGNED_MODIFIERS.has(w)) { k += isPunct(t[k + 1], '=') ? 3 : 2; continue; }
      if ((w === 'MASKED' || w === 'ENCRYPTED') && next === 'WITH' && isPunct(t[k + 2], '(')) { const end = matchParen(t as Token[], k + 2); k = end < 0 ? to : end + 1; continue; }
      if ((w === 'TAG' && isPunct(t[k + 1], '(')) || (w === 'WITH' && (next === 'TAG' || isPunct(t[k + 1], '(')))) {
        const at = w === 'TAG' ? k + 1 : next === 'TAG' ? k + 2 : k + 1;
        const end = matchParen(t as Token[], at);
        k = end < 0 ? to : end + 1;
        continue;
      }
      if (w in SKIPPED_MODIFIERS) { k += 1 + SKIPPED_MODIFIERS[w]; continue; }
      return fail(k, `unexpected "${shortWord(t[k].value)}" in the definition of ${shortWord(field.name)}`);
    }
    return undefined;
  }

  /** Where a DEFAULT's expression ends: the next constraint word outside parentheses. */
  function expressionEnd(from: number, to: number): number {
    let k = from;
    let depth = 0;
    for (; k < to; k++) {
      if (isPunct(t[k], '(')) depth++;
      else if (isPunct(t[k], ')')) depth--;
      else if (depth === 0 && k > from && (CONSTRAINT_AFTER_DEFAULT.has(upper(t[k])) || (upper(t[k]) === 'ON' && upper(t[k + 1]) === 'UPDATE'))) break;
    }
    return k;
  }

  function defaultOf(from: number, to: number): RawSqlField['dbdefault'] {
    let a = from;
    let b = to - 1;
    while (isPunct(t[a], '(') && matchParen(t as Token[], a) === b) { a++; b--; }
    if (a === b) {
      const tok = t[a];
      if (tok.kind === 'string') return { type: 'string', value: tok.value };
      if (tok.kind === 'number') return { type: 'number', value: tok.value };
      if (/^(TRUE|FALSE)$/.test(upper(tok))) return { type: 'boolean', value: tok.value.toLowerCase() };
    }
    if (a + 1 === b && isPunct(t[a], '-') && t[b].kind === 'number') return { type: 'number', value: `-${t[b].value}` };
    if (a + 1 === b && upper(t[a]) === 'N' && t[b].kind === 'string') return { type: 'string', value: t[b].value };
    return { type: 'expression', value: text.slice(t[from].start, t[to - 1].end).replace(/\s+/g, ' ').trim() };
  }

  function readConstraint(from: number, to: number): SalvageResult | undefined {
    let k = from;
    let constraintName: string | undefined;
    if (upper(t[k]) === 'CONSTRAINT') { constraintName = t[k + 1]?.value; k += 2; }
    const w = upper(t[k]);
    const findList = (at: number): { columns: string[]; expression: boolean; next: number } | undefined => {
      for (let j = at; j < to; j++) if (isPunct(t[j], '(')) return columnList(j);
      return undefined;
    };
    // A key part that is an expression stays an expression part (the converter keeps no key with one).
    const parts = (list: { columns: string[]; expression: boolean }): RawSqlIndex['columns'] => [
      ...list.columns.map((value) => ({ value, type: 'column' })),
      ...(list.expression ? [{ value: 'expression', type: 'expression' }] : []),
    ];
    if (w === 'PRIMARY' && upper(t[k + 1]) === 'KEY') {
      const list = findList(k + 2);
      if (!list) return fail(k, 'a PRIMARY KEY without columns');
      const index: RawSqlIndex = { pk: true, columns: parts(list), ...(constraintName ? { name: constraintName } : {}) };
      table.indexes!.push(index);
      return undefined;
    }
    if (w === 'UNIQUE') {
      const list = findList(k + 1);
      if (!list) return fail(k, 'a UNIQUE constraint without columns');
      table.indexes!.push({ unique: true, columns: parts(list), ...(constraintName ? { name: constraintName } : {}) });
      return undefined;
    }
    if (w === 'FOREIGN' && upper(t[k + 1]) === 'KEY') {
      const list = findList(k + 2);
      if (!list) return fail(k, 'a FOREIGN KEY without columns');
      if (list.expression) return fail(k, 'a FOREIGN KEY on an expression');
      let r = list.next;
      while (r < to && upper(t[r]) !== 'REFERENCES') r++;
      const ref = r < to ? references(r, to) : undefined;
      if (!ref) return fail(k, 'a FOREIGN KEY without REFERENCES');
      refs.push({
        ...(constraintName ? { name: constraintName } : {}),
        endpoints: [endpoint([...(schemaName ? [schemaName] : []), tableName], list.columns, '*'), endpoint(ref.parts, ref.columns, '1')],
        ...(ref.onDelete ? { onDelete: ref.onDelete } : {}),
        ...(ref.onUpdate ? { onUpdate: ref.onUpdate } : {}),
      });
      return undefined;
    }
    if (w === 'CHECK' && isPunct(t[k + 1], '(')) {
      const end = matchParen(t as Token[], k + 1);
      if (end < 0) return fail(k, 'a CHECK whose parenthesis never closes');
      table.checks!.push({ expression: text.slice(t[k + 2]?.start ?? t[end].start, t[end - 1]?.end ?? t[end].start).replace(/\s+/g, ' ').trim(), ...(constraintName ? { name: constraintName } : {}) });
      return undefined;
    }
    if (w === 'INDEX' || w === 'KEY' || w === 'FULLTEXT' || w === 'SPATIAL') {
      const list = findList(k + 1);
      if (list) table.indexes!.push({ columns: list.columns.map((value) => ({ value, type: 'column' })) });
      return undefined;
    }
    if (w === 'PERIOD' || w === 'EXCLUDE' || w === 'LIKE') return undefined;
    return fail(k, 'a table constraint it does not know');
  }
}

/**
 * A key or index part `[from, to)` that is a column: a name, then only a
 * MySQL prefix length `(10)`, ASC / DESC, COLLATE, an operator class or
 * `NULLS FIRST`. Undefined for an expression (`(lower(email))`, `lower(email)`,
 * `a + b`).
 */
export function keyPartColumn(t: readonly Token[], from: number, to: number): string | undefined {
  if (from >= to || !isName(t[from])) return undefined;
  for (let k = from + 1; k < to; k++) {
    const tok = t[k];
    if (k === from + 1 && isPunct(tok, '(') && t[k + 1]?.kind === 'number' && isPunct(t[k + 2], ')')) { k += 2; continue; }
    if (tok.kind === 'word' || tok.kind === 'ident' || tok.kind === 'string') continue;
    if (isPunct(tok, '.') && k > from + 1) continue; // an operator class's or collation's schema
    return undefined;
  }
  return t[from].value;
}

/** Words that end a DEFAULT's expression. */
const CONSTRAINT_AFTER_DEFAULT = new Set([
  'NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'CONSTRAINT', 'COMMENT', 'COLLATE', 'IDENTITY', 'AUTO_INCREMENT',
  'AUTOINCREMENT', 'GENERATED', 'MASK', 'MASKED', 'INVISIBLE', 'VISIBLE', 'SPARSE', 'ROWGUIDCOL', 'PERSISTED', 'WITH',
]);

/** A name or word shown in a message: one short line. */
function shortWord(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 32 ? `${flat.slice(0, 31)}…` : flat;
}
