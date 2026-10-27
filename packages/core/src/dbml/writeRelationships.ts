/**
 * The relationships-file writer (§2.3 and §4.5 of the native DBML storage
 * spec): `tables/[<folder>/]_relationships.dbml`, one Ref line per
 * relationship unit, kept sorted, with a `use` line for every table a Ref
 * names.
 *
 * Only the owners an edit lists are touched. A Ref that is the same as
 * before keeps its bytes (its `?` marks, `[delete: cascade]` and trailing
 * comment included); one whose cardinality or role changed is rewritten in
 * place with its settings and comment kept; one that is gone is cut, and a
 * new one is inserted at its sorted place. `use` lines are maintained only
 * for the tables this edit touches, so hand-added or missing lines for
 * other tables stay as they are (Law 1). The file is never deleted (D15).
 */

import type { Cardinality, Relationship, TableRelationship } from '../types/semantic.js';
import { DBML_RELATIONSHIPS_FILE_HEADER, DBML_RELATIONSHIPS_FILE_STEM } from '../dbmlRichProperties.js';
import { dbmlName } from '../dbmlText.js';
import { canonicalRelationship } from '../relationships.js';
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
import { applyTextEdits, attachedStart, cutEdit, eolOf, headerEnd, type TextEdit } from './splice.js';

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
   * Its primary-key columns (any case). Given, a bare `-` Ref in the file is
   * oriented by keys exactly as `attachRelationships` reads it (§2.3); without
   * it, the second end is read as the foreign key.
   */
  primaryKey?: readonly string[];
}

/** Whether `columns` are exactly the key `key` (without case). */
function isWholeKey(key: readonly string[], columns: readonly string[]): boolean {
  const k = new Set(key.map(lower));
  const c = new Set(columns.map(lower));
  return k.size > 0 && k.size === c.size && [...c].every((x) => k.has(x));
}

/** What {@link editRelationshipsDbml} changes in one relationships file. */
export interface RelationshipsFileEdit {
  /** The file, posix, relative to the semantic dir (`use` paths are relative to it). */
  filePath: string;
  /**
   * Owners whose complete list for THIS file this edit sets, keyed
   * lower-case. `null` drops every Ref it owns here. Owners not listed keep
   * their Refs byte for byte.
   */
  owners: ReadonlyMap<string, { name: string; relationships: readonly TableRelationship[] } | null>;
  /** Table renames done in this edit: old lower-case name → new name (Refs naming them are re-spelled). */
  renamedOwners?: ReadonlyMap<string, string>;
  /** Ref texts moving INTO this file from another file, carried verbatim. */
  incoming?: ReadonlyArray<{ text: string; unit: RefUnit }>;
  /** Tables whose path changed in this edit (rename, move, delete), lower-case: their `use` lines are re-resolved. */
  pathChanged?: ReadonlySet<string>;
  /** A table as it is AFTER this edit; undefined when it has no file. */
  resolve(name: string): DbmlResolvedTable | undefined;
  /** The DBML parser; the pinned one unless a test passes another. */
  parser?: DbmlParserModule;
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

/** Ends and columns, without case: what "the same Ref" means apart from cardinality and role. */
function endsKey(unit: RefUnit): string {
  return refUnitSortKey(unit);
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
  const endText = (table: string, columns: readonly string[]): string => {
    const reference = edit.resolve(table)?.reference ?? dbmlName(table);
    const spelled = columns.map((c) => dbmlName(columnSpelling(table, c)));
    return spelled.length === 1 ? `${reference}.${spelled[0]}` : `${reference}.(${spelled.join(', ')})`;
  };
  /** The Ref line for a unit (§2.3 operators, the foreign-key end marked possibly null, D18). */
  const refText = (unit: RefUnit, rest = ''): string => {
    const from = endText(unit.from, unit.fromColumns);
    const to = endText(unit.to, unit.toColumns);
    const body = unit.cardinality === 'one-to-one' ? `${to} ?- ${from}`
      : unit.cardinality === 'many-to-many' ? `${from} <>? ${to}`
        : `${from} >? ${to}`;
    return `${unit.role !== undefined ? `Ref ${dbmlName(unit.role)}` : 'Ref'}: ${body}${rest}`;
  };
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
  const current: Array<{ ref: RefNode; unit: RefUnit; spelledNames: string[] }> = [];
  if (oldText !== null) {
    const reading = readRelationshipsDbml(text, parser);
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
      if (stored.oneToOneDirection === 'keys') {
        // A bare `-`: oriented by keys exactly as attachRelationships reads it (the first end is the
        // foreign key only when the second end alone is its table's whole primary key).
        const fromKey = edit.resolve(canonical(rels[0].fromModel))?.primaryKey;
        const toKey = edit.resolve(canonical(rels[0].toModel))?.primaryKey;
        if (fromKey && toKey && isWholeKey(fromKey, rels.map((r) => r.fromColumn)) && !isWholeKey(toKey, rels.map((r) => r.toColumn))) {
          rels = rels.map((r) => ({ ...r, fromModel: r.toModel, fromColumn: r.toColumn, toModel: r.fromModel, toColumn: r.fromColumn }));
        }
      }
      const unit: RefUnit = {
        from: canonical(rels[0].fromModel),
        to: canonical(rels[0].toModel),
        fromColumns: rels.map((r) => r.fromColumn),
        toColumns: rels.map((r) => r.toColumn),
        cardinality: rels[0].cardinality,
        ...(rels[0].role !== undefined ? { role: rels[0].role } : {}),
      };
      current.push({ ref: refNodeOf(node), unit, spelledNames: [rels[0].fromModel, rels[0].toModel] });
    }
  }

  // --- Desired units -----------------------------------------------------------
  const listed = new Set([...edit.owners.keys()].map(lower));
  const desired: RefUnit[] = [];
  for (const [, entry] of edit.owners) {
    if (entry) desired.push(...relationshipUnits(entry.name, entry.relationships).map((u) => ({ ...u, from: canonical(u.from), to: canonical(u.to) })));
  }
  const incomingByKey = new Map<string, string>();
  for (const { text: refLine, unit } of edit.incoming ?? []) {
    const canon = { ...unit, from: canonical(unit.from), to: canonical(unit.to) };
    incomingByKey.set(identityKey(canon), refLine);
    if (!desired.some((d) => identityKey(d) === identityKey(canon))) desired.push(canon);
  }

  // --- Match current Refs to desired units ---------------------------------------
  const edits: TextEdit[] = [];
  const matched = new Set<RefUnit>();
  type Kept = { unit: RefUnit; ref: RefNode; mode: 'keep' | 'respell' | 'regenerate'; desired?: RefUnit };
  const kept: Kept[] = [];
  const cut: Array<{ unit: RefUnit; ref: RefNode; spelledNames: string[] }> = [];
  const touched = new Set<string>();
  const renamedEnd = (names: readonly string[]): boolean => names.some((n) => renamed.has(lower(n)));

  for (const c of current) {
    const isListed = listed.has(lower(c.unit.from));
    const respell = renamedEnd(c.spelledNames);
    if (!isListed) {
      kept.push({ unit: c.unit, ref: c.ref, mode: respell ? 'respell' : 'keep' });
      if (respell) for (const n of [...c.spelledNames, c.unit.from, c.unit.to]) touched.add(lower(n));
      continue;
    }
    const candidates = [c.unit];
    let found: { want: RefUnit; read: RefUnit } | undefined;
    for (const read of candidates) {
      const want = desired.find((d) => !matched.has(d) && identityKey(d) === identityKey(read));
      if (want) { found = { want, read }; break; }
    }
    if (found) {
      matched.add(found.want);
      kept.push({ unit: found.read, ref: c.ref, mode: respell ? 'respell' : 'keep', desired: found.want });
      if (respell) for (const n of [...c.spelledNames, c.unit.from, c.unit.to]) touched.add(lower(n));
      continue;
    }
    for (const read of candidates) {
      const want = desired.find((d) => !matched.has(d) && endsKey(d) === endsKey(read));
      if (want) { found = { want, read }; break; }
    }
    if (found) {
      matched.add(found.want);
      kept.push({ unit: found.want, ref: c.ref, mode: 'regenerate', desired: found.want });
      for (const n of [...c.spelledNames, found.want.from, found.want.to]) touched.add(lower(n));
      continue;
    }
    cut.push({ unit: c.unit, ref: c.ref, spelledNames: c.spelledNames });
    for (const n of [...c.spelledNames, c.unit.from, c.unit.to]) touched.add(lower(n));
  }
  const inserted = desired.filter((d) => !matched.has(d));
  for (const unit of inserted) for (const n of [unit.from, unit.to]) touched.add(lower(n));

  // --- Refusals ---------------------------------------------------------------------
  for (const k of kept) if (k.mode === 'regenerate') checkUnit(k.unit, undefined);
  for (const unit of inserted) checkUnit(unit);
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
  const respelled = (k: Kept): string => {
    // Each end whose table was renamed is spelled anew; the operator and the rest keep their bytes.
    const spans: TextEdit[] = [];
    for (const side of [k.ref.left, k.ref.right]) {
      const parts = endParts(side);
      if (!parts || !renamed.has(lower(parts.table))) continue;
      const table = canonical(parts.table);
      spans.push({ start: side!.start - k.ref.node.start, end: side!.end - k.ref.node.start, text: endText(table, parts.columns) });
    }
    return applyTextEdits(text.slice(k.ref.node.start, k.ref.node.end), spans);
  };
  const lineText = (k: Kept): string => (k.mode === 'regenerate' ? refText(k.unit, restOf(k.ref)) : respelled(k));

  // A Ref re-spelled for a rename moves only when its new sort key puts it out of order with its
  // neighbours where its old key did not (§4.5 step 2); every other kept Ref stays where it is.
  const moving: Array<{ unit: RefUnit; text: string }> = [];
  const staying: Kept[] = [];
  const inFileOrder = kept.slice().sort((a, b) => a.ref.node.start - b.ref.node.start);
  const keyBefore = (k: Kept): string => {
    const before = current.find((c) => c.ref === k.ref)!;
    return refUnitSortKey({ ...k.unit, from: before.spelledNames[0], to: before.spelledNames[1] });
  };
  const sign = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  for (const [i, k] of inFileOrder.entries()) {
    if (k.mode === 'respell') {
      const neighbours = [inFileOrder[i - 1], inFileOrder[i + 1]].filter((n): n is Kept => n !== undefined);
      const outOfOrder = neighbours.some((n) => sign(keyBefore(k), keyBefore(n)) !== sign(refUnitSortKey(k.unit), refUnitSortKey(n.unit)));
      if (outOfOrder) {
        moving.push({ unit: k.unit, text: lineText(k) });
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
  for (const added of newUses) {
    const before = keptUses.find((u) => u.importPath > added.path);
    if (before) {
      const at = attachedStart(text, before.node);
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

  if (oldText === null) {
    const header = DBML_RELATIONSHIPS_FILE_HEADER;
    const useBlock = newUses.map((u) => u.line).join('\n');
    const refBlock = additions.map((a) => a.text).join('\n');
    if (additions.length === 0) return `${header}\n`;
    return `${header}\n${useBlock}${useBlock ? '\n' : ''}\n${refBlock}\n`;
  }
  const out = applyTextEdits(text, [...useEdits, ...edits, ...refInserts]);
  return hadBom ? `﻿${out}` : out;

  function incomingText(unit: RefUnit): string {
    const carried = incomingByKey.get(identityKey(unit));
    if (carried === undefined) return refText(unit);
    return respellIncoming(carried.replace(/\r?\n$/, ''));
  }

  /** An incoming Ref's text with each renamed end spelled anew; everything else kept verbatim. */
  function respellIncoming(refLine: string): string {
    if (renamed.size === 0) return refLine;
    let compiled;
    try {
      compiled = compileOne(refLine, parser);
    } catch {
      return refLine;
    }
    const node = topLevel(compiled.ast).find((n) => lower(elementType(n) ?? '') === 'ref');
    if (!node) return refLine;
    const ref = refNodeOf(node);
    const spans: TextEdit[] = [];
    for (const side of [ref.left, ref.right]) {
      const parts = endParts(side);
      if (!parts || !renamed.has(lower(parts.table))) continue;
      spans.push({ start: side!.start, end: side!.end, text: endText(canonical(parts.table), parts.columns) });
    }
    return applyTextEdits(refLine, spans);
  }

  /** The sort key of a Ref that stays, as it reads after the edit. */
  function currentKeyOf(k: Kept): RefUnit {
    return k.unit;
  }
}
