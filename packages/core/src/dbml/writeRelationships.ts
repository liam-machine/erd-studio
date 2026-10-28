/**
 * The relationships-file writer (§2.3 and §4.5 of the native DBML storage
 * spec): `tables/[<folder>/]_relationships.dbml`, one Ref line per
 * relationship unit, kept sorted, with a `use` line for every table a Ref
 * names.
 *
 * Only the owners an edit lists are touched. A Ref that is the same as
 * before keeps its bytes (its `?` marks, `[delete: cascade]` and trailing
 * comment included); one whose cardinality or role changed is rewritten in
 * place with its settings and comment kept; one an end of which was
 * renamed (the table, or a column the edit renames) is re-spelled in place,
 * only the renamed names changing; one that is gone is cut, and a
 * new one is inserted at its sorted place. `use` lines are maintained only
 * for the tables this edit touches, so hand-added or missing lines for
 * other tables stay as they are (Law 1). The file is never deleted (D15).
 */

import type { Cardinality, Relationship, TableRelationship } from '../types/semantic.js';
import { DBML_RELATIONSHIPS_FILE_HEADER, DBML_RELATIONSHIPS_FILE_STEM, pendingRefLine } from '../dbmlRichProperties.js';
import { dbmlName } from '../dbmlText.js';
import { canonicalRelationship } from '../relationships.js';
import { reverseBareOneToOne } from '../dbmlAttach.js';
import { TABLES_DIR } from '../logicalModel.js';
import { dirnamePosix, normalisePosix, relativePosix, resolvePosix } from '../storage.js';
import { DbmlEditRefused } from './errors.js';
import type { DbmlParserModule } from './parserModule.js';
import {
  PINNED_PARSER,
  compileOne,
  elementType,
  isUseDeclaration,
  nameFragments,
  plainNames,
  stripBom,
  topLevel,
  type AstNode,
} from './parser.js';
import { readRelationshipsDbml } from './readRelationships.js';
import { applyTextEdits, attachedStart, cutEdit, eolOf, headerEnd, lineEndOf, refuseOverlaps, type TextEdit } from './splice.js';

/** One relationship unit: a Ref line (a composite is one unit), canonical (`from` is the foreign-key table). */
export interface RefUnit {
  from: string;
  to: string;
  fromColumns: string[];
  toColumns: string[];
  cardinality: Cardinality;
  role?: string;
}

/** A table as a writer resolves it AFTER the edit being written. */
export interface DbmlResolvedTable {
  /** The real spelling of its name. */
  name: string;
  /** How Ref ends and `use` specifiers spell it: `x`, or `gold.x` for a schema-qualified Table. */
  reference: string;
  /** A column's real spelling, or undefined when the table has no such column. */
  columns(column: string): string | undefined;
  /** Its file, posix, relative to the semantic dir. */
  path: string;
  storage: 'yaml' | 'dbml';
  /**
   * Its primary-key columns (any case). Given for both ends, a bare `-` Ref in
   * the file is oriented by keys exactly as `attachRelationships` reads it
   * (§2.3, the shared `reverseBareOneToOne`). Without it the writer tries
   * both orientations against the desired units, so a Ref that is not
   * changing keeps its bytes either way.
   */
  primaryKey?: readonly string[];
}

/** What {@link editRelationshipsDbml} changes in one relationships file. */
export interface RelationshipsFileEdit {
  /** The file, posix, relative to the semantic dir (`use` paths are relative to it). */
  filePath: string;
  /**
   * Owners whose complete list for THIS file this edit sets, keyed
   * lower-case by their name after the edit (a key that is a renamed
   * owner's old name, or another spelling `resolve` maps, is read through
   * `renamedOwners` and `resolve` too). `null` drops every Ref it owns here.
   * Owners not listed keep their Refs byte for byte, apart from a Ref a
   * listed owner's list describes from the other end (a `one-to-many`
   * record), which is matched like the owner's own.
   */
  owners: ReadonlyMap<string, { name: string; relationships: readonly TableRelationship[] } | null>;
  /** Table renames done in this edit: old lower-case name → new name (Refs naming them are re-spelled). */
  renamedOwners?: ReadonlyMap<string, string>;
  /**
   * Column renames done in this edit: a table's name (after the edit, any
   * case) → its old column name, lower-case → the new name. A Ref naming a
   * renamed column is the same Ref as before: only the column's spelling
   * changes, so its settings, comments, block form and operator keep their bytes.
   */
  renamedColumns?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Ref texts moving INTO this file from another file, carried verbatim. */
  incoming?: ReadonlyArray<{ text: string; unit: RefUnit }>;
  /** Tables whose path changed in this edit (rename, move, delete), lower-case: their `use` lines are re-resolved. */
  pathChanged?: ReadonlySet<string>;
  /** A table as it is AFTER this edit; undefined when it has no file. */
  resolve(name: string): DbmlResolvedTable | undefined;
  /**
   * A new unit that cannot be a live Ref (an end with no `.dbml` table file,
   * a YAML end, or a column the table does not have) is written as a pending
   * line (D27, `// erd-studio pending: Ref …`) instead of being refused.
   * Convert sets it; canvas edits do not.
   */
  writePending?: boolean;
  /** The DBML parser; the pinned one unless a test passes another. */
  parser?: DbmlParserModule;
}

/**
 * Cuts for whole pending lines (D27, each span a line with its line break):
 * a run of cut lines that leaves a blank line above it and nothing (or
 * another blank line) below takes that blank line too, so removing the last
 * pending lines never leaves a blank line behind.
 */
export function pendingLineCuts(text: string, spans: ReadonlyArray<{ start: number; end: number }>): Array<{ start: number; end: number; text: string }> {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const runs: Array<{ start: number; end: number }> = [];
  for (const span of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.end === span.start) last.end = span.end;
    else runs.push({ ...span });
  }
  return runs.map((run) => {
    const rest = text.slice(run.end);
    const blankBelow = rest === '' || /^\r?\n/.test(rest) || /^\s*$/.test(rest);
    const above = text.slice(0, run.start);
    const blankAbove = /\r?\n\r?\n$/.test(above);
    if (blankAbove && blankBelow) return { start: run.start - (above.endsWith('\r\n') ? 2 : 1), end: run.end, text: '' };
    return { start: run.start, end: run.end, text: '' };
  });
}

/** The message for a Ref to a YAML table (D20). */
export const DBML_CONVERT_FIRST_MESSAGE = 'Convert the project to DBML first (ERD Studio: Convert Project to DBML)';

const lower = (s: string): string => s.toLowerCase();

function refuse(file: string, message: string, line?: number): never {
  throw new DbmlEditRefused(file, message, line);
}

/** The sort key of a unit (§4.5 step 3). */
export function refUnitSortKey(unit: RefUnit): string {
  return [lower(unit.from), lower(unit.to), unit.fromColumns.map(lower).join(','), unit.toColumns.map(lower).join(',')].join('\u0000');
}

/**
 * Ends and column pairs, without case and in any pair order: what "the same
 * Ref" means apart from cardinality and role. A composite listed with its
 * pairs in another order is the same link (core's `linkKey` is order-free too).
 */
function endsKey(unit: RefUnit): string {
  const pairs = unit.fromColumns.map((c, i) => `${lower(c)}>${lower(unit.toColumns[i] ?? '')}`).sort();
  return [lower(unit.from), lower(unit.to), pairs.join(',')].join('\u0000');
}

function identityKey(unit: RefUnit): string {
  return `${endsKey(unit)}\u0000${unit.cardinality}\u0000${unit.role ?? ''}`;
}

/** Which two column sets a unit joins, either way round (what `[5001]` compares). */
function endpointsKey(unit: RefUnit): string {
  const end = (table: string, columns: string[]): string => `${lower(table)}.${[...columns].map(lower).sort().join(',')}`;
  return [end(unit.from, unit.fromColumns), end(unit.to, unit.toColumns)].sort().join('\u0000');
}

/**
 * An owner's relationships as units: entries sharing a `compositeKey` (and
 * target) are one composite unit, every other entry is its own. Canonical:
 * a `one-to-many` becomes many-to-one from the other end.
 */
export function relationshipUnits(owner: string, relationships: readonly TableRelationship[]): RefUnit[] {
  const units: RefUnit[] = [];
  const groups = new Map<string, RefUnit>();
  for (const entry of relationships) {
    const rel = canonicalRelationship({ ...entry, fromModel: owner } as Relationship);
    const role = rel.role !== undefined && rel.role !== '' ? rel.role : undefined;
    if (entry.compositeKey) {
      const key = `${lower(rel.fromModel)}\u0000${lower(rel.toModel)}\u0000${entry.compositeKey}`;
      const held = groups.get(key);
      if (held) {
        held.fromColumns.push(rel.fromColumn);
        held.toColumns.push(rel.toColumn);
        continue;
      }
      const unit: RefUnit = { from: rel.fromModel, to: rel.toModel, fromColumns: [rel.fromColumn], toColumns: [rel.toColumn], cardinality: rel.cardinality, ...(role !== undefined ? { role } : {}) };
      groups.set(key, unit);
      units.push(unit);
      continue;
    }
    units.push({ from: rel.fromModel, to: rel.toModel, fromColumns: [rel.fromColumn], toColumns: [rel.toColumn], cardinality: rel.cardinality, ...(role !== undefined ? { role } : {}) });
  }
  return units;
}

/** `path` with `.dbml` added when it has none (a `use` path may leave it out). */
function withExtension(path: string): string {
  return path.toLowerCase().endsWith('.dbml') ? path : `${path}.dbml`;
}

/** A `use` path from `fromFile` to `toFile` (both relative to the semantic dir): `./x.dbml`, `../gold/x.dbml`. */
export function usePathBetween(fromFile: string, toFile: string): string {
  const rel = relativePosix(dirnamePosix(fromFile), toFile);
  return rel.startsWith('../') ? rel : `./${rel}`;
}

/** A `use` line in the file. */
interface UseLine {
  node: AstNode;
  importPath: string;
  /** Resolved against the file's folder, relative to the semantic dir. */
  resolved: string;
  stem: string;
  wildcard: boolean;
  /** Selective specifiers: each table's unqualified name, lower-case, and its source text. */
  tables: Array<{ name: string; text: string }>;
  /** How many specifiers the line has (tables and other kinds). */
  specifierCount: number;
}

/** The file's `use` lines, resolved against `filePath`'s folder. */
export function useLinesOf(ast: AstNode, text: string, filePath: string): UseLine[] {
  const lines: UseLine[] = [];
  const folder = dirnamePosix(filePath);
  for (const node of topLevel(ast)) {
    if (!isUseDeclaration(node)) continue;
    const importPath = typeof node.importPath?.value === 'string' ? (node.importPath.value as string) : '';
    const segments = importPath.split('/').filter((s) => s !== '');
    const file = segments[segments.length - 1] ?? '';
    const stem = file.toLowerCase().endsWith('.dbml') ? file.slice(0, -'.dbml'.length) : file;
    const list = node.specifiers;
    const wildcard = !list || list.kind === '<wildcard>';
    const tables: UseLine['tables'] = [];
    let specifierCount = 0;
    if (!wildcard && Array.isArray(list.specifiers)) {
      for (const specifier of list.specifiers as AstNode[]) {
        specifierCount++;
        if (lower(String(specifier?.importKind?.value ?? '')) !== 'table') continue;
        const parts = plainNames(specifier.name);
        if (parts && parts.length > 0) {
          tables.push({ name: lower(parts[parts.length - 1]), text: text.slice(specifier.name.start, specifier.name.end) });
        }
      }
    }
    lines.push({ node, importPath, resolved: normalisePosix(resolvePosix(folder, withExtension(importPath))), stem, wildcard, tables, specifierCount });
  }
  return lines;
}

/** Whether a resolved path points into the table library (`tables/…`). */
function inLibrary(resolved: string): boolean {
  const segments = normalisePosix(resolved).split('/');
  return segments[0] === TABLES_DIR && segments.length >= 2 && segments.length <= 3;
}

/** A Ref's parts in the file: its node, its application (the line with the ends) and its ends. */
interface RefNode {
  node: AstNode;
  application: AstNode | undefined;
  left: AstNode | undefined;
  right: AstNode | undefined;
}

function refNodeOf(node: AstNode): RefNode {
  const body = node.body;
  let application: AstNode | undefined;
  if (body?.kind === '<function-application>') application = body;
  else if (body?.kind === '<block-expression>' && Array.isArray(body.body)) {
    const lines = (body.body as AstNode[]).filter((n) => n?.kind === '<function-application>');
    application = lines.length === 1 ? lines[0] : undefined;
  }
  const callee = application?.callee;
  return {
    node,
    application,
    left: callee?.kind === '<infix-expression>' ? callee.leftExpression : undefined,
    right: callee?.kind === '<infix-expression>' ? callee.rightExpression : undefined,
  };
}

/** The column tokens of a Ref end expression (one, or a composite's list), in order. */
function columnTokens(expr: AstNode | undefined): AstNode[] {
  let last = expr;
  while (last?.kind === '<infix-expression>' && last.op?.value === '.') last = last.rightExpression;
  if (!last) return [];
  const inner = last.kind === '<primary-expression>' && last.expression?.kind === '<tuple-expression>' ? last.expression : last;
  if (inner.kind === '<tuple-expression>') return Array.isArray(inner.elementList) ? (inner.elementList as AstNode[]) : [];
  return [last];
}

/** The table part (qualifier removed) and columns of a Ref end expression. */
function endParts(expr: AstNode | undefined): { table: string; columns: string[] } | null {
  const fragments = nameFragments(expr);
  if (!fragments || fragments.length < 2) return null;
  const last = fragments[fragments.length - 1];
  const table = fragments[fragments.length - 2];
  if (typeof table !== 'string') return null;
  return { table, columns: typeof last === 'string' ? [last] : last };
}

/**
 * Edit (or, from `null`, create) a relationships file so each listed owner
 * holds exactly its relationships here. Pure; throws
 * {@link DbmlEditRefused} for a file that does not read (syntax error,
 * conflict markers), a unit that joins a column set to itself, two units
 * joining the same column sets, and a new or rewritten unit whose other end
 * is a YAML table (D20).
 */
export function editRelationshipsDbml(oldText: string | null, edit: RelationshipsFileEdit): string {
  return refuseOverlaps(edit.filePath, () => editRelationships(oldText, edit));
}

function editRelationships(oldText: string | null, edit: RelationshipsFileEdit): string {
  const parser = edit.parser ?? PINNED_PARSER;
  const file = edit.filePath;
  const renamed = new Map<string, string>();
  for (const [from, to] of edit.renamedOwners ?? []) renamed.set(lower(from), to);
  /** A name as it reads after the edit: renamed, then resolved (an alias or another case maps to the real name). */
  const canonical = (name: string): string => {
    const after = renamed.get(lower(name)) ?? name;
    return edit.resolve(after)?.name ?? after;
  };
  const columnSpelling = (table: string, column: string): string => edit.resolve(table)?.columns(column) ?? column;
  const columnRenames = new Map<string, ReadonlyMap<string, string>>();
  for (const [table, columns] of edit.renamedColumns ?? []) if (columns.size > 0) columnRenames.set(lower(canonical(table)), columns);
  /** A column as it is named after the edit (`table` is a name as it reads after the edit). */
  const columnAfter = (table: string, column: string): string => columnRenames.get(lower(table))?.get(lower(column)) ?? column;
  /** A unit (ends named as after the edit) with its renamed columns spelled anew. */
  const withRenamedColumns = (unit: RefUnit): RefUnit => (columnRenames.size === 0 ? unit : {
    ...unit,
    fromColumns: unit.fromColumns.map((c) => columnAfter(unit.from, c)),
    toColumns: unit.toColumns.map((c) => columnAfter(unit.to, c)),
  });
  const columnsDiffer = (a: RefUnit, b: RefUnit): boolean =>
    a.fromColumns.some((c, i) => c !== b.fromColumns[i]) || a.toColumns.some((c, i) => c !== b.toColumns[i]);
  const endText = (table: string, columns: readonly string[]): string => {
    const reference = edit.resolve(table)?.reference ?? dbmlName(table);
    const spelled = columns.map((c) => dbmlName(columnSpelling(table, c)));
    return spelled.length === 1 ? `${reference}.${spelled[0]}` : `${reference}.(${spelled.join(', ')})`;
  };
  /** A unit's ends and operator (§2.3 operators, the foreign-key end marked possibly null, D18). */
  const refBody = (unit: RefUnit): string => {
    const from = endText(unit.from, unit.fromColumns);
    const to = endText(unit.to, unit.toColumns);
    return unit.cardinality === 'one-to-one' ? `${to} ?- ${from}`
      : unit.cardinality === 'many-to-many' ? `${from} <>? ${to}`
        : `${from} >? ${to}`;
  };
  /** The Ref line for a unit. */
  const refText = (unit: RefUnit, rest = ''): string => `${unit.role !== undefined ? `Ref ${dbmlName(unit.role)}` : 'Ref'}: ${refBody(unit)}${rest}`;
  const checkUnit = (unit: RefUnit, line?: number): void => {
    const sameColumns = lower(unit.from) === lower(unit.to)
      && unit.fromColumns.length === unit.toColumns.length
      && unit.fromColumns.every((c, i) => lower(c) === lower(unit.toColumns[i]));
    if (sameColumns) refuse(file, `The relationship ${unit.from}.(${unit.fromColumns.join(', ')}) joins a column set to itself, which DBML refuses.`, line);
    for (const end of [unit.from, unit.to]) {
      if (edit.resolve(end)?.storage === 'yaml') {
        refuse(file, `${end} is a YAML table, and a DBML relationships file can only name DBML tables. ${DBML_CONVERT_FIRST_MESSAGE}.`, line);
      }
    }
  };

  // --- Read the file ---------------------------------------------------------
  const hadBom = oldText !== null && oldText.charCodeAt(0) === 0xfeff;
  const text = oldText === null ? '' : stripBom(oldText);
  const eol = oldText === null ? '\n' : eolOf(text);
  let ast: AstNode | undefined;
  /** Each Ref in the file: its unit as read and, for a bare `-` whose orientation the keys cannot settle, the other way round. */
  const current: Array<{ ref: RefNode; unit: RefUnit; spelledNames: string[]; alt?: { unit: RefUnit; spelledNames: string[] } }> = [];
  /** The file's pending relationships (D27): each one's unit, as named after the edit, and its line's span. */
  const pendingLines: Array<{ unit: RefUnit; start: number; end: number }> = [];
  if (oldText !== null) {
    const reading = readRelationshipsDbml(text, parser);
    for (const stored of reading.pending ?? []) {
      const rels = stored.relationships;
      if (rels.length === 0) continue;
      pendingLines.push({
        start: stored.start,
        end: stored.fullEnd,
        unit: {
          from: canonical(rels[0].fromModel),
          to: canonical(rels[0].toModel),
          fromColumns: rels.map((r) => r.fromColumn),
          toColumns: rels.map((r) => r.toColumn),
          cardinality: rels[0].cardinality,
          ...(rels[0].role !== undefined ? { role: rels[0].role } : {}),
        },
      });
    }
    if (!reading.readable) {
      const problem = reading.problems[0];
      const message = (problem?.message ?? 'it does not read').replace(/\. No relationship is read from (it|the file) until[^]*$/, '').replace(/\.$/, '');
      const where = problem?.line !== undefined && !/^line \d/i.test(message) ? `line ${problem.line}: ` : '';
      refuse(file, `Fix the DBML in ${file} first (${where}${message}). ERD Studio never rewrites a file it cannot read.`, problem?.line);
    }
    ast = compileOne(text, parser).ast;
    const refNodes = new Map<number, AstNode>();
    for (const node of topLevel(ast)) if (lower(elementType(node) ?? '') === 'ref') refNodes.set(node.start, node);
    for (const stored of reading.refs) {
      const node = refNodes.get(stored.start);
      if (!node) continue;
      let rels = stored.relationships;
      const reversed = rels.map((r) => ({ ...r, fromModel: r.toModel, fromColumn: r.toColumn, toModel: r.fromModel, toColumn: r.fromColumn }));
      let undecided = false;
      if (stored.oneToOneDirection === 'keys') {
        // A bare `-`: oriented by keys exactly as attachRelationships reads it (the shared rule). When a
        // table's key is not given, both orientations are tried against the desired units below.
        const fromKey = edit.resolve(canonical(rels[0].fromModel))?.primaryKey;
        const toKey = edit.resolve(canonical(rels[0].toModel))?.primaryKey;
        if (fromKey === undefined || toKey === undefined) undecided = true;
        else if (reverseBareOneToOne(fromKey, rels.map((r) => r.fromColumn), toKey, rels.map((r) => r.toColumn))) rels = reversed;
      }
      const unitOf = (list: typeof rels): RefUnit => ({
        from: canonical(list[0].fromModel),
        to: canonical(list[0].toModel),
        fromColumns: list.map((r) => r.fromColumn),
        toColumns: list.map((r) => r.toColumn),
        cardinality: list[0].cardinality,
        ...(list[0].role !== undefined ? { role: list[0].role } : {}),
      });
      current.push({
        ref: refNodeOf(node),
        unit: unitOf(rels),
        spelledNames: [rels[0].fromModel, rels[0].toModel],
        ...(undecided ? { alt: { unit: unitOf(reversed), spelledNames: [reversed[0].fromModel, reversed[0].toModel] } } : {}),
      });
    }
  }

  // --- Desired units -----------------------------------------------------------
  // Owners as named after the edit, however the caller keyed them.
  const listed = new Set([...edit.owners.keys()].map((k) => lower(canonical(k))));
  const desired: RefUnit[] = [];
  for (const [, entry] of edit.owners) {
    if (entry) desired.push(...relationshipUnits(entry.name, entry.relationships).map((u) => ({ ...u, from: canonical(u.from), to: canonical(u.to) })));
  }
  const incomingByKey = new Map<string, string>();
  for (const { text: refLine, unit } of edit.incoming ?? []) {
    const canon = withRenamedColumns({ ...unit, from: canonical(unit.from), to: canonical(unit.to) });
    incomingByKey.set(identityKey(canon), refLine);
    if (!desired.some((d) => identityKey(d) === identityKey(canon))) desired.push(canon);
  }

  // --- Match current Refs to desired units ---------------------------------------
  const edits: TextEdit[] = [];
  const matched = new Set<RefUnit>();
  type Kept = {
    unit: RefUnit;
    ref: RefNode;
    mode: 'keep' | 'respell' | 'regenerate';
    desired?: RefUnit;
    /** The table names as the file spells them (from, to). */
    spelledNames: string[];
    /** An end of it (a table, or a column) was renamed in this edit. */
    renamed: boolean;
    /** Its sort key as the file has it, before any rename. */
    keyBefore: string;
    /** Its role as the file has it (a regenerated block-form Ref splices its name only when this differs). */
    readRole?: string;
  };
  const kept: Kept[] = [];
  const cut: Array<{ unit: RefUnit; ref: RefNode; spelledNames: string[] }> = [];
  type KeptInput = Omit<Kept, 'keyBefore'>;
  const touched = new Set<string>();
  const renamedEnd = (names: readonly string[]): boolean => names.some((n) => renamed.has(lower(n)));
  const unmatched = (test: (d: RefUnit) => boolean): RefUnit | undefined => desired.find((d) => !matched.has(d) && test(d));

  for (const entry of current) {
    // A bare `-` whose orientation is not settled reads the way a desired unit has it, if one does.
    // Every unit is matched with its renamed columns spelled as they are after the edit.
    let read = entry.unit;
    let { spelledNames } = entry;
    let unit = withRenamedColumns(read);
    if (entry.alt) {
      const altUnit = withRenamedColumns(entry.alt.unit);
      if (!unmatched((d) => endsKey(d) === endsKey(unit)) && unmatched((d) => endsKey(d) === endsKey(altUnit))) {
        read = entry.alt.unit;
        unit = altUnit;
        spelledNames = entry.alt.spelledNames;
      }
    }
    const c = { ref: entry.ref, unit, spelledNames };
    const respell = renamedEnd(c.spelledNames) || columnsDiffer(read, unit);
    const keyBefore = refUnitSortKey({ ...read, from: spelledNames[0], to: spelledNames[1] });
    const keep = (k: KeptInput): void => { kept.push({ ...k, keyBefore }); };
    const touch = (...names: string[]): void => { for (const n of [...c.spelledNames, ...names]) touched.add(lower(n)); };
    const identical = unmatched((d) => identityKey(d) === identityKey(c.unit));
    if (identical) {
      // The same link, cardinality and role: its bytes stay (re-spelled only where an end was renamed).
      matched.add(identical);
      keep({ unit: c.unit, ref: c.ref, mode: respell ? 'respell' : 'keep', desired: identical, spelledNames: c.spelledNames, renamed: respell });
      if (respell) touch(c.unit.from, c.unit.to);
      continue;
    }
    const same = unmatched((d) => endsKey(d) === endsKey(c.unit));
    if (same) {
      // Same ends and pairs, another cardinality or role: rewritten in place, in the file's own pair order.
      matched.add(same);
      const unit2: RefUnit = { ...same, fromColumns: [...c.unit.fromColumns], toColumns: [...c.unit.toColumns] };
      keep({ unit: unit2, ref: c.ref, mode: 'regenerate', desired: same, spelledNames: c.spelledNames, renamed: respell, ...(c.unit.role !== undefined ? { readRole: c.unit.role } : {}) });
      touch(same.from, same.to);
      continue;
    }
    if (!listed.has(lower(c.unit.from))) {
      keep({ unit: c.unit, ref: c.ref, mode: respell ? 'respell' : 'keep', spelledNames: c.spelledNames, renamed: respell });
      if (respell) touch(c.unit.from, c.unit.to);
      continue;
    }
    cut.push({ unit: c.unit, ref: c.ref, spelledNames: c.spelledNames });
    touch(c.unit.from, c.unit.to);
  }
  // --- Pending relationships (D27) ---------------------------------------------------------
  // A pending line stays while its unit is desired and still cannot be live; it becomes a live Ref
  // (its line cut) once both ends have .dbml files with those columns; it goes when its owner is
  // listed without it, or was deleted. A new unit that cannot be live is written pending only when
  // the caller asks (Convert); otherwise it is refused below, as before.
  const liveable = (unit: RefUnit): boolean => [[unit.from, unit.fromColumns], [unit.to, unit.toColumns]].every(([name, columns]) => {
    const table = edit.resolve(name as string);
    return table !== undefined && table.storage === 'dbml' && (columns as string[]).every((c) => table.columns(c) !== undefined);
  });
  const pendingCuts: TextEdit[] = [];
  const stillPending = new Set<RefUnit>();
  const newPending: RefUnit[] = [];
  for (const pendingLine of pendingLines) {
    const unit = withRenamedColumns(pendingLine.unit);
    const owner = lower(unit.from);
    const wanted = desired.find((d) => !matched.has(d) && identityKey(d) === identityKey(unit));
    if (wanted) {
      matched.add(wanted);
      if (liveable(wanted)) {
        pendingCuts.push({ start: pendingLine.start, end: pendingLine.end, text: '' });
        stillPending.add(wanted); // re-added below as a live insert
      }
      continue;
    }
    if (listed.has(owner)) {
      const entry = [...edit.owners.entries()].find(([k]) => lower(canonical(k)) === owner)?.[1];
      if (entry || edit.resolve(unit.from) === undefined) pendingCuts.push({ start: pendingLine.start, end: pendingLine.end, text: '' });
      continue;
    }
    // An owner this edit does not list: its pending line turns live once both ends have files with those columns.
    if (liveable(unit)) {
      pendingCuts.push({ start: pendingLine.start, end: pendingLine.end, text: '' });
      desired.push(unit);
    }
  }
  const inserted = desired.filter((d) => !matched.has(d) || stillPending.has(d));
  if (edit.writePending) {
    for (let i = inserted.length - 1; i >= 0; i--) {
      const unit = inserted[i];
      if (incomingByKey.has(identityKey(unit)) || liveable(unit)) continue;
      newPending.push(unit);
      inserted.splice(i, 1);
    }
    newPending.sort((a, b) => (refUnitSortKey(a) < refUnitSortKey(b) ? -1 : refUnitSortKey(a) > refUnitSortKey(b) ? 1 : 0));
  }
  for (const unit of inserted) for (const n of [unit.from, unit.to]) touched.add(lower(n));

  // --- Refusals ---------------------------------------------------------------------
  for (const k of kept) if (k.mode === 'regenerate') checkUnit(k.unit, undefined);
  for (const unit of inserted) {
    checkUnit(unit);
    // A new Ref to a table with no file would not compile, and a relationships file that does not
    // compile is read as holding nothing (Law 5). A Ref already in the file, or carried in, stays as it is.
    if (incomingByKey.has(identityKey(unit))) continue;
    const missing = [unit.from, unit.to].find((end) => edit.resolve(end) === undefined);
    if (missing !== undefined) {
      refuse(file, `The relationship ${unit.from}.(${unit.fromColumns.join(', ')}) → ${unit.to}.(${unit.toColumns.join(', ')}) names ${missing}, which has no table file, so it cannot be written to ${file}.`);
    }
  }
  {
    const seen = new Map<string, RefUnit>();
    for (const unit of [...kept.map((k) => k.unit), ...inserted]) {
      const key = endpointsKey(unit);
      const held = seen.get(key);
      if (held) {
        refuse(file, `Two relationships in ${file} join the same columns (${held.from}.(${held.fromColumns.join(', ')}) and ${held.to}.(${held.toColumns.join(', ')})), which DBML refuses; keep one.`);
      }
      seen.set(key, unit);
    }
  }

  // --- Ref edits ----------------------------------------------------------------------
  const restOf = (ref: RefNode): string => {
    // Settings and the trailing comment stay: everything after the ends, up to the end of the node.
    if (ref.application && ref.node.body === ref.application && ref.right) return text.slice(ref.right.end, ref.node.end);
    const settings = ref.application?.args?.find?.((a: AstNode) => a?.kind === '<list-expression>');
    return settings ? ` ${text.slice(settings.start, settings.end)}` : '';
  };
  const respelled = (k: Kept): string =>
    // Each end whose table was renamed is spelled anew, and each renamed column token; the operator and the rest keep their bytes.
    applyTextEdits(text.slice(k.ref.node.start, k.ref.node.end), endRespellings([k.ref.left, k.ref.right], k.ref.node.start));
  /**
   * A regenerated Ref. A one-line Ref is written anew with its settings kept; a block-form Ref
   * (`Ref name {\n  // …\n  a.x > b.y [settings]\n}`) keeps its block and comments, and only its
   * ends, operator and name are spliced.
   */
  const regenerated = (k: Kept): string => {
    const node = k.ref.node;
    const callee = k.ref.application?.callee;
    if (!(k.ref.application && node.body !== k.ref.application && callee)) return refText(k.unit, restOf(k.ref));
    const base = node.start as number;
    const spans: TextEdit[] = [{ start: callee.start - base, end: callee.end - base, text: refBody(k.unit) }];
    if ((k.unit.role ?? '') !== (k.readRole ?? '')) {
      const name = node.name as AstNode | undefined;
      const type = node.type as AstNode;
      if (k.unit.role === undefined) {
        if (name) spans.push({ start: type.end - base, end: name.end - base, text: '' });
      } else if (name) {
        spans.push({ start: name.start - base, end: name.end - base, text: dbmlName(k.unit.role) });
      } else {
        spans.push({ start: type.end - base, end: type.end - base, text: ` ${dbmlName(k.unit.role)}` });
      }
    }
    return applyTextEdits(text.slice(node.start, node.end), spans);
  };
  const lineText = (k: Kept): string => (k.mode === 'regenerate' ? regenerated(k) : respelled(k));
  /** A moving Ref's text with its own trailing comment, which the cut takes from its old place. */
  const movedText = (k: Kept): string => {
    const end = k.ref.node.end as number;
    const tail = text.slice(end, lineEndOf(text, end));
    return `${lineText(k)}${/^[ \t]*(\/\/|\/\*)/.test(tail) ? tail : ''}`;
  };

  // A Ref re-spelled (or regenerated) with a renamed end moves only when its new sort key puts it out
  // of order with its neighbours where its old key did not (§4.5 step 2); every other kept Ref stays.
  const moving: Array<{ unit: RefUnit; text: string }> = [];
  const staying: Kept[] = [];
  const inFileOrder = kept.slice().sort((a, b) => a.ref.node.start - b.ref.node.start);
  const keyBefore = (k: Kept): string => k.keyBefore;
  const sign = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  for (const [i, k] of inFileOrder.entries()) {
    if (k.renamed && k.mode !== 'keep') {
      const neighbours = [inFileOrder[i - 1], inFileOrder[i + 1]].filter((n): n is Kept => n !== undefined);
      const outOfOrder = neighbours.some((n) => sign(keyBefore(k), keyBefore(n)) !== sign(refUnitSortKey(k.unit), refUnitSortKey(n.unit)));
      if (outOfOrder) {
        moving.push({ unit: k.unit, text: movedText(k) });
        edits.push(cutEdit(text, k.ref.node));
        continue;
      }
    }
    staying.push(k);
    if (k.mode === 'keep') continue;
    // A regenerated head is rewritten with its settings and trailing comment kept; a re-spelled one changes only its ends.
    const out = lineText(k);
    if (out !== text.slice(k.ref.node.start, k.ref.node.end)) edits.push({ start: k.ref.node.start, end: k.ref.node.end, text: out });
  }
  for (const c of cut) edits.push(cutEdit(text, c.ref.node));

  // New Refs (and moved ones) at their sorted places among the Refs that stay.
  const additions = [
    ...inserted.map((unit) => ({ unit, text: incomingText(unit) })),
    ...moving,
  ].sort((a, b) => (refUnitSortKey(a.unit) < refUnitSortKey(b.unit) ? -1 : refUnitSortKey(a.unit) > refUnitSortKey(b.unit) ? 1 : 0));
  // --- use lines (§4.5 step 5): only for the tables this edit touched -------------------
  for (const name of edit.pathChanged ?? []) touched.add(lower(name));
  const remaining = new Set<string>();
  for (const k of staying) for (const n of [k.unit.from, k.unit.to]) remaining.add(lower(n));
  for (const a of additions) for (const n of [a.unit.from, a.unit.to]) remaining.add(lower(n));
  const uses = ast ? useLinesOf(ast, text, file) : [];
  const useEdits: TextEdit[] = [];
  const handled = new Set<AstNode>();
  const oldNamesOf = (name: string): string[] => [...renamed.entries()].filter(([, to]) => lower(to) === lower(name)).map(([from]) => from);
  const linesFor = (name: string): UseLine[] => {
    const names = new Set([lower(name), ...oldNamesOf(name).map(lower)]);
    const target = edit.resolve(name)?.path;
    return uses.filter((u) => !handled.has(u.node) && lower(u.stem) !== DBML_RELATIONSHIPS_FILE_STEM && (
      u.tables.some((t) => names.has(t.name))
      || (u.wildcard && names.has(lower(u.stem)))
      || (target !== undefined && u.resolved === normalisePosix(target))
    ));
  };
  /** A line that imports only this table (so deleting or rewriting it takes nothing else away). */
  const only = (u: UseLine): boolean => u.wildcard || u.specifierCount <= 1;
  const newUses: Array<{ path: string; line: string }> = [];
  // Tables a Ref still names first, so a renamed table's old line is rewritten, not cut and re-added.
  const order = [...touched].sort((a, b) => Number(remaining.has(b)) - Number(remaining.has(a)) || (a < b ? -1 : a > b ? 1 : 0));
  for (const name of order) {
    const lines = linesFor(name);
    if (remaining.has(name)) {
      const table = edit.resolve(name);
      if (!table) continue; // a dangling end: no file to point at
      const path = usePathBetween(file, table.path);
      const line = `use { table ${table.reference} } from '${path}'`;
      const target = normalisePosix(table.path);
      const good = lines.find((u) => u.resolved === target && (u.wildcard || u.tables.some((t) => t.text === table.reference)));
      if (good) {
        handled.add(good.node);
        for (const u of lines) if (u !== good && u.resolved === target && only(u)) { handled.add(u.node); useEdits.push(cutEdit(text, u.node)); }
        continue;
      }
      const rewritable = lines.filter(only);
      if (rewritable.length > 0) {
        handled.add(rewritable[0].node);
        useEdits.push({ start: rewritable[0].node.start, end: rewritable[0].node.end, text: line });
        for (const u of rewritable.slice(1)) { handled.add(u.node); useEdits.push(cutEdit(text, u.node)); }
        continue;
      }
      newUses.push({ path, line });
    } else {
      for (const u of lines) {
        if (!only(u) || !inLibrary(u.resolved)) continue;
        handled.add(u.node);
        useEdits.push(cutEdit(text, u.node));
      }
    }
  }
  newUses.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const keptUses = uses.filter((u) => !useEdits.some((e) => e.text === '' && e.start <= u.node.start && e.end >= u.node.end));
  // ERD Studio's own header comment sits right above the first use line; it describes the file, not that line.
  const headerFloor = text.startsWith(DBML_RELATIONSHIPS_FILE_HEADER) && text.indexOf('\n') >= 0 ? text.indexOf('\n') + 1 : 0;
  for (const added of newUses) {
    const before = keptUses.find((u) => u.importPath > added.path);
    if (before) {
      const at = Math.max(attachedStart(text, before.node, headerFloor), Math.min(headerFloor, before.node.start));
      useEdits.push({ start: at, end: at, text: `${added.line}${eol}` });
      continue;
    }
    const last = keptUses[keptUses.length - 1] ?? uses[uses.length - 1];
    if (last) {
      const at = Math.max(last.node.fullEnd, last.node.end);
      useEdits.push({ start: at, end: at, text: `${text[at - 1] === '\n' ? '' : eol}${added.line}${eol}` });
      continue;
    }
    const at = headerEnd(text);
    const firstElement = topLevel(ast).find((n) => n.start >= at);
    const blankAfter = firstElement !== undefined && at === 0;
    useEdits.push({ start: at, end: at, text: `${at > 0 && text[at - 1] !== '\n' ? eol : ''}${added.line}${eol}${blankAfter && added === newUses[newUses.length - 1] ? eol : ''}` });
  }

  const stayingInOrder = staying.slice().sort((a, b) => a.ref.node.start - b.ref.node.start);
  const allRefNodes = current.map((c) => c.ref.node).sort((a, b) => a.start - b.start);
  const refInserts: TextEdit[] = [];
  for (const addition of additions) {
    const key = refUnitSortKey(addition.unit);
    const before = stayingInOrder.find((k) => refUnitSortKey(currentKeyOf(k)) > key);
    if (before) {
      const at = attachedStart(text, before.ref.node);
      refInserts.push({ start: at, end: at, text: `${addition.text}${eol}` });
      continue;
    }
    const last = stayingInOrder[stayingInOrder.length - 1]?.ref.node ?? allRefNodes[allRefNodes.length - 1];
    if (last) {
      const at = Math.max(last.fullEnd, last.end);
      refInserts.push({ start: at, end: at, text: `${text[at - 1] === '\n' ? '' : eol}${addition.text}${eol}` });
      continue;
    }
    const at = text.length;
    const lead = text === '' ? (newUses.length > 0 ? eol : '') : text.endsWith(`${eol}${eol}`) || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? eol : `${eol}${eol}`;
    refInserts.push({ start: at, end: at, text: `${refInserts.some((e) => e.start === at) ? '' : lead}${addition.text}${eol}` });
  }

  const pendingBlock = newPending.map((unit) => pendingRefLine(refText(unit)));
  if (oldText === null) {
    const header = DBML_RELATIONSHIPS_FILE_HEADER;
    const useBlock = newUses.map((u) => u.line).join('\n');
    const refBlock = additions.map((a) => a.text).join('\n');
    const tail = pendingBlock.length > 0 ? `\n${pendingBlock.join('\n')}\n` : '';
    if (additions.length === 0) return `${header}\n${tail}`;
    return `${header}\n${useBlock}${useBlock ? '\n' : ''}\n${refBlock}\n${tail}`;
  }
  if (pendingBlock.length > 0) {
    // New pending lines go at the end of the file, after a blank line.
    const at = text.length;
    const lead = text === '' ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? eol : `${eol}${eol}`;
    refInserts.push({ start: at, end: at, text: `${refInserts.some((e) => e.start === at) ? eol : lead}${pendingBlock.join(eol)}${eol}` });
  }
  const out = applyTextEdits(text, [...useEdits, ...edits, ...pendingLineCuts(text, pendingCuts), ...refInserts]);
  return hadBom ? `﻿${out}` : out;

  function incomingText(unit: RefUnit): string {
    const carried = incomingByKey.get(identityKey(unit));
    if (carried === undefined) return refText(unit);
    return respellIncoming(carried.replace(/\r?\n$/, ''));
  }

  /** An incoming Ref's text with each renamed end spelled anew; everything else kept verbatim. */
  function respellIncoming(refLine: string): string {
    if (renamed.size === 0 && columnRenames.size === 0) return refLine;
    let compiled;
    try {
      compiled = compileOne(refLine, parser);
    } catch {
      return refLine;
    }
    const node = topLevel(compiled.ast).find((n) => lower(elementType(n) ?? '') === 'ref');
    if (!node) return refLine;
    const ref = refNodeOf(node);
    return applyTextEdits(refLine, endRespellings([ref.left, ref.right], 0));
  }

  /**
   * The spans that re-spell Ref ends (offsets less `base`): an end whose table
   * was renamed is written anew; otherwise only its renamed column tokens are,
   * so a qualifier, alias or quoting the file uses for the table stays.
   */
  function endRespellings(sides: Array<AstNode | undefined>, base: number): TextEdit[] {
    const spans: TextEdit[] = [];
    for (const side of sides) {
      const parts = endParts(side);
      if (!parts || !side) continue;
      const table = canonical(parts.table);
      const after = parts.columns.map((c) => columnAfter(table, c));
      if (renamed.has(lower(parts.table))) {
        spans.push({ start: side.start - base, end: side.end - base, text: endText(table, after) });
        continue;
      }
      const tokens = columnTokens(side);
      if (tokens.length !== parts.columns.length) continue;
      parts.columns.forEach((c, i) => {
        if (after[i] === c) return;
        spans.push({ start: tokens[i].start - base, end: tokens[i].end - base, text: dbmlName(columnSpelling(table, after[i])) });
      });
    }
    return spans;
  }

  /** The sort key of a Ref that stays, as it reads after the edit. */
  function currentKeyOf(k: Kept): RefUnit {
    return k.unit;
  }
}
