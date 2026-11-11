/**
 * The diagram writer (§2.5 and §4.5 of the native DBML storage spec, §1.4 of
 * the 2.0 tree design): a new `<layer>/diagrams/<name>.dbml` diagram, and an
 * edit that diffs the v5 object a diagram was read into (`before`) against
 * the one a handler produced (`after`) and splices only what changed —
 * Project values, table `use` lines, the relationships `use *` lines (each
 * line read by `diagramUseRole`, as the reader reads it; every other `use *`
 * line is kept as written), sticky-note `Note` blocks, and the
 * positions and sticky-note boxes in the Project's `erd_layout` (§1.6,
 * `erdLayoutTextEdit`). A DBML diagram holds no Refs (D5).
 *
 * A new diagram is written with its Project last (§1.4), so the file opens
 * on what the diagram holds and the `erd_layout` lines sit at the bottom.
 * An edit leaves an existing Project where it is; new `use` lines go after
 * the last `use` line, else before the first Note, else before the
 * Project, never inside or after it.
 */

import type { Annotation, AnnotationColor, Relationship } from '../types/semantic.js';
import { DBML_SCHEMA_VERSION, DBML_TWIN_SCHEMA_VERSION } from '../types/semantic.js';
import type { DbmlSubjectAreaReading } from '../types/dbmlStorage.js';
import { SubjectAreaFileError, SubjectAreaValidationError } from '../domain.js';
import {
  DBML_DIAGRAM_PROPERTIES,
  DBML_RICH_NOTE_PROPERTIES,
  DBML_RICH_STICKY_COLOURS,
  formatUnlinkedTables,
  pendingRefLine,
} from '../dbmlRichProperties.js';
import { readPendingRefs } from './readRelationships.js';
import { dbmlName, dbmlNoteText, dbmlString } from '../dbmlText.js';
import { erdLayoutOf, renderErdLayoutValue, sameErdLayout, withMemberRefs, type ErdLayout } from '../erdLayout.js';
import { rekeySubjectArea } from '../rekeySubjectArea.js';
import { assignTableRefs, qualifiedRef, tableIdOfPath, type TableId, type TableRefCandidate } from '../tableIdentity.js';
import type { NodePosition } from '../types/semantic.js';
import { normalisePosix } from '../storage.js';
import { DbmlEditRefused } from './errors.js';
import type { DbmlParserModule } from './parserModule.js';
import {
  PINNED_PARSER,
  attributeName,
  compileOne,
  elementType,
  lineStartOf,
  plainNames,
  stripBom,
  topLevel,
  type AstNode,
} from './parser.js';
import { diagramUseRole, parseSubjectAreaDbml } from './readDiagram.js';
import { erdLayoutTextEdit } from './erdLayoutDbml.js';
import {
  applyTextEdits,
  attachedStart,
  closeCutGaps,
  cutEdit,
  cutSpan,
  eolOf,
  headerEnd,
  lineEndOf,
  refuseOverlaps,
  renderListPlan,
  type ListPlan,
  type TextEdit,
} from './splice.js';
import { DBML_CONVERT_FIRST_MESSAGE, pendingLineCuts, usePathBetween, useLinesOf } from './writeRelationships.js';

/** A table as the diagram writer resolves it AFTER the edit. */
export interface DbmlDiagramTable {
  /** The real spelling of its name. */
  name: string;
  /** How a `use { table … }` specifier spells it: `x`, or `gold.x`. */
  reference: string;
  /** Its file, posix, relative to the semantic dir. */
  path: string;
  storage: 'yaml' | 'dbml';
}

/** What {@link editSubjectAreaDbml} is given (§4.5). */
export interface SubjectAreaDbmlEdit {
  /** The diagram, posix, relative to the semantic dir. */
  filePath: string;
  /** The v5 object as parsed (`schemaVersion` 5, D8). */
  before: Record<string, unknown>;
  /**
   * The v5 object after the handler's change. A member is named by its
   * reference on the diagram (its name, or `<schema>.<name>` while another
   * member has the same name), or by any text `resolveTable` resolves to its
   * table: a member whose reference this edit changes (a table of its name
   * joins or leaves the diagram) is written under its new reference, and so
   * are its position, sticky links and stub entries (`rekeySubjectArea`).
   */
  after: Record<string, unknown>;
  /** A table AFTER this edit, by the text `after` names it with; undefined when there is none. */
  resolveTable(name: string): DbmlDiagramTable | undefined;
  /**
   * Members whose reference this edit changes, by their reference before it
   * (any case) → the one `after` names them by, so each keeps its `use` line.
   * Optional: a member named by its table's name or `<schema>.<name>` keeps
   * the line that imports its table's file without it.
   */
  renamedMembers?: ReadonlyMap<string, string>;
  /** Tables whose file moved, was renamed or was deleted in this edit: their references on the diagram (lower-case). */
  pathChanged?: ReadonlySet<string>;
  /**
   * The relationships files (paths after this edit, relative to the semantic
   * dir) the diagram should import for these members; `current` is what it
   * imports now (its `use *` lines of relationships files, resolved), so an
   * implementation can keep one it cannot read. `unlinked` is the members it
   * names in `erd_unlinked_tables` after this edit (D26), so a file holding a
   * pending line (D27) to one of them can be imported too.
   */
  relationshipsImportsFor(memberNames: readonly string[], current: readonly string[], unlinked: readonly string[]): string[];
  /** Recompute the relationships `use` lines even when membership did not change (the settle pass). */
  refreshRelationshipsUses?: boolean;
  /**
   * Leave `erd_layout` byte-identical when it holds a git merge conflict,
   * instead of refusing a change to it (§1.6): set for every diagram an edit
   * re-renders that is not the one being edited (a rename or delete cascade,
   * the settle), so one conflicted diagram never blocks the project. Its
   * other changes (`use` lines, Note `linked_table`) are still written.
   */
  keepLayoutIfConflicted?: boolean;
  /** Whether a file exists AFTER this edit (posix, relative to the semantic dir). */
  fileExists(path: string): boolean;
  /** The DBML parser; the pinned one unless a test passes another. */
  parser?: DbmlParserModule;
}

/** What a new diagram holds (§2.5). */
export interface NewSubjectAreaDbml {
  /** The diagram, posix, relative to the semantic dir (`use` paths are relative to it). */
  filePath: string;
  domain: string;
  description?: string;
  modelFolder?: string;
  showFkEdges?: boolean;
  layoutOptions?: Record<string, string>;
  stubColumns?: string[];
  /** The member tables, in order: each one's file (relative to the semantic dir) and how a specifier spells it. */
  members: ReadonlyArray<{ name: string; reference?: string; path: string }>;
  /**
   * Members with no `.dbml` table file to `use` (D26), in order: written as
   * the Project's `erd_unlinked_tables`, never as `use` lines. Omitted or
   * empty: no key.
   */
  unlinked?: readonly string[];
  /**
   * The diagram's own pending relationships (D27), each a Ref line
   * (`Ref: a.x >? b.y`) written as `// erd-studio pending: <line>` after
   * the `use` lines. Their foreign-key table has no `.dbml` file.
   */
  pendingRefs?: readonly string[];
  /** The relationships files (relative to the semantic dir) the diagram imports. */
  relationshipsFiles: readonly string[];
  /** Sticky notes: a `Note` block each, and each one's box in `erd_layout`. */
  annotations?: readonly Annotation[];
  /** Table positions, written in `erd_layout` (§1.6); omitted or empty with no notes: no key, placed when it opens. */
  positions?: Record<string, NodePosition>;
}

const lower = (s: string): string => s.toLowerCase();

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function refuse(file: string, message: string, line?: number): never {
  throw new DbmlEditRefused(file, message, line);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ak = Object.keys(a).filter((k) => a[k] !== undefined);
    const bk = Object.keys(b).filter((k) => b[k] !== undefined);
    return ak.length === bk.length && ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * The Project keys after the Note, in the order a new diagram writes them.
 * `erd_layout` is always last; it is written by `erdLayoutTextEdit` (§1.6),
 * never by the string compare of {@link projectValues}, which leaves it out.
 */
const PROJECT_KEYS = [
  DBML_DIAGRAM_PROPERTIES.schemaVersion,
  DBML_DIAGRAM_PROPERTIES.modelFolder,
  DBML_DIAGRAM_PROPERTIES.showFkEdges,
  DBML_DIAGRAM_PROPERTIES.layoutOptions,
  DBML_DIAGRAM_PROPERTIES.stubColumns,
  DBML_DIAGRAM_PROPERTIES.unlinkedTables,
  DBML_DIAGRAM_PROPERTIES.layout,
] as const;

/** The Project's `erd_layout` line for `layout` (§1.6), indented by `indent`; undefined when there is nothing to place. */
function layoutLine(layout: ErdLayout, eol: string, indent: string): string | undefined {
  const value = renderErdLayoutValue(layout, { eol, indent });
  return value === undefined ? undefined : `${indent}${DBML_DIAGRAM_PROPERTIES.layout}: ${dbmlString(value)}`;
}

/**
 * The Project values a diagram object holds (§2.5), as the text each key is
 * written with; undefined = not written. `unlinked` is the members with no
 * table file to `use` (D26), which the object alone cannot tell apart.
 */
function projectValues(obj: Json, unlinked: readonly string[] = [], version = String(DBML_SCHEMA_VERSION)): Record<string, string | undefined> {
  const view = isObject(obj.viewConfig) ? obj.viewConfig : {};
  const description = typeof obj.description === 'string' ? dbmlNoteText(obj.description) : '';
  return {
    note: description === '' ? undefined : description,
    [DBML_DIAGRAM_PROPERTIES.schemaVersion]: version,
    [DBML_DIAGRAM_PROPERTIES.modelFolder]: typeof obj.modelFolder === 'string' ? obj.modelFolder : undefined,
    [DBML_DIAGRAM_PROPERTIES.showFkEdges]: typeof view.showFkEdges === 'boolean' ? String(view.showFkEdges) : undefined,
    [DBML_DIAGRAM_PROPERTIES.layoutOptions]: isObject(view.layoutOptions) ? JSON.stringify(view.layoutOptions) : undefined,
    [DBML_DIAGRAM_PROPERTIES.stubColumns]: Array.isArray(obj.stubColumns) ? JSON.stringify(obj.stubColumns) : undefined,
    [DBML_DIAGRAM_PROPERTIES.unlinkedTables]: unlinked.length > 0 ? formatUnlinkedTables(unlinked) : undefined,
  };
}

/** A Project block's lines: its Note, every key that is set, and `layout` (an `erd_layout` line) last. */
function projectLines(domain: string, values: Record<string, string | undefined>, layout?: string): string[] {
  const lines = [`Project ${dbmlName(domain)} {`];
  if (values.note !== undefined) lines.push(`  Note: ${dbmlString(values.note)}`);
  for (const key of PROJECT_KEYS) {
    const value = values[key];
    if (value !== undefined) lines.push(`  ${key}: ${dbmlString(value)}`);
  }
  if (layout !== undefined) lines.push(layout);
  lines.push('}');
  return lines;
}

/** A sticky note's settings: its swatch colour and the table it points at. */
function noteSettings(annotation: Annotation): string[] {
  const settings: string[] = [];
  const hex = annotation.color ? DBML_RICH_STICKY_COLOURS[annotation.color] : undefined;
  if (hex) settings.push(`color: ${hex}`);
  if (annotation.linkedModel) settings.push(`${DBML_RICH_NOTE_PROPERTIES.linkedTable}: ${dbmlString(annotation.linkedModel)}`);
  return settings;
}

function noteBlock(annotation: Annotation, eol: string): string {
  const settings = noteSettings(annotation);
  return [
    `Note ${dbmlName(annotation.id)}${settings.length > 0 ? ` [${settings.join(', ')}]` : ''} {`,
    `  ${dbmlString(dbmlNoteText(annotation.text ?? ''))}`,
    '}',
  ].join(eol);
}

/**
 * A pending relationship's Ref text (D27), from its column pairs (one unless
 * a composite), foreign-key end first: written as the relationships writer
 * writes a Ref (D18 marks). `referenceOf` spells a table that has a file
 * (`gold.x` for a schema-qualified one); a table with none is its name.
 */
export function pendingRelationshipRef(members: readonly Relationship[], referenceOf: (table: string) => string | undefined = () => undefined): string {
  const rel = members[0];
  const cols = (cs: string[]): string => (cs.length === 1 ? dbmlName(cs[0]) : `(${cs.map(dbmlName).join(', ')})`);
  const fromEnd = `${referenceOf(rel.fromModel) ?? dbmlName(rel.fromModel)}.${cols(members.map((m) => m.fromColumn))}`;
  const toEnd = `${referenceOf(rel.toModel) ?? dbmlName(rel.toModel)}.${cols(members.map((m) => m.toColumn))}`;
  const name = rel.role ? ` ${dbmlName(rel.role)}` : '';
  if (rel.cardinality === 'one-to-one') return `Ref${name}: ${toEnd} ?- ${fromEnd}`;
  if (rel.cardinality === 'many-to-many') return `Ref${name}: ${fromEnd} <>? ${toEnd}`;
  return `Ref${name}: ${fromEnd} >? ${toEnd}`;
}

function tableUseLine(reference: string, fromFile: string, toFile: string): string {
  return `use { table ${reference} } from '${usePathBetween(fromFile, toFile)}'`;
}

/**
 * A new diagram file (§1.4, in order): one table `use` line per member in
 * list order, one `use *` per relationships file sorted by path, the pending
 * lines, one `Note` block per sticky note, then the Project, last (its Note,
 * `erd_schema_version` and every other key that is set, and `erd_layout`
 * last when there is a position or a sticky-note box to place).
 */
export function renderNewSubjectAreaDbml(input: NewSubjectAreaDbml): string {
  const view: Json = {};
  if (input.showFkEdges !== undefined) view.showFkEdges = input.showFkEdges;
  if (input.layoutOptions !== undefined) view.layoutOptions = input.layoutOptions;
  // Two members of one name in different schema folders: version 8, and each layout line under its reference.
  const identities: TableId[] = input.members.map((m) => {
    const id = tableIdOfPath(normalisePosix(m.path));
    return id ? { schema: id.schema, name: id.name } : { schema: '', name: m.name };
  });
  const refs = assignTableRefs(identities);
  const pair = refs.some((ref, i) => lower(ref) !== lower(identities[i].name));
  const values = projectValues({
    description: input.description ?? '',
    ...(input.modelFolder !== undefined ? { modelFolder: input.modelFolder } : {}),
    ...(input.stubColumns !== undefined ? { stubColumns: input.stubColumns } : {}),
    viewConfig: view,
  }, input.unlinked ?? [], String(pair ? DBML_TWIN_SCHEMA_VERSION : DBML_SCHEMA_VERSION));
  const blocks: string[][] = [];
  const uses = input.members.map((m) => tableUseLine(m.reference ?? dbmlName(m.name), input.filePath, m.path));
  const relationships = [...new Set(input.relationshipsFiles.map(normalisePosix))]
    .map((path) => usePathBetween(input.filePath, path))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => `use * from '${path}'`);
  if (uses.length + relationships.length > 0) blocks.push([...uses, ...relationships]);
  const pending = (input.pendingRefs ?? []).map((line) => pendingRefLine(line));
  if (pending.length > 0) blocks.push(pending);
  for (const annotation of input.annotations ?? []) blocks.push([noteBlock(annotation, '\n')]);
  const placed = erdLayoutOf(input.positions, input.annotations);
  const tables: TableRefCandidate[] = [
    ...identities.map((id, i) => ({ ...id, ref: refs[i] })),
    ...(input.unlinked ?? []).map((name) => ({ schema: '', name, ref: name })),
  ];
  const layout = layoutLine(pair ? withMemberRefs(placed, tables) : placed, '\n', '  ');
  blocks.push(projectLines(input.domain, values, layout));
  return `${blocks.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}

/** The keys of a diagram object the DBML diagram stores (§2.5). Anything else cannot be written. */
const TOP_KEYS = new Set(['schemaVersion', 'domain', 'layer', 'description', 'modelFolder', 'logical', 'viewConfig', 'stubColumns']);
const VIEW_KEYS = new Set(['showFkEdges', 'layoutOptions', 'positions', 'annotations']);
const LOGICAL_KEYS = new Set(['models', 'relationships']);

function modelsOf(obj: Json): string[] {
  const logical = isObject(obj.logical) ? obj.logical : {};
  return Array.isArray(logical.models) ? logical.models.filter((m): m is string => typeof m === 'string') : [];
}

function annotationsOf(obj: Json): Annotation[] {
  const view = isObject(obj.viewConfig) ? obj.viewConfig : {};
  return Array.isArray(view.annotations) ? (view.annotations as Annotation[]).filter((a) => isObject(a) && typeof a.id === 'string') : [];
}

/** What a diagram object's `erd_layout` holds: its table positions and its sticky notes' boxes. */
function layoutOfObject(obj: Json): ErdLayout {
  const view = isObject(obj.viewConfig) ? obj.viewConfig : {};
  const positions = isObject(view.positions) ? view.positions as Record<string, NodePosition> : {};
  return erdLayoutOf(positions, annotationsOf(obj));
}

/**
 * Edit a diagram so it reads as `edit.after` (§4.5), splicing only what
 * changed from `edit.before`. Laws 1–5 hold; a no-op edit returns the text
 * unchanged, and a leading byte-order mark is kept.
 *
 * Throws {@link DbmlEditRefused} for a file that does not read, one with a
 * repeated Note name or a second Project, relationships in `after` (they
 * live in the table library), a change of layer or schema version or of
 * anything a DBML diagram does not store, a new member that is not a DBML
 * table (D20), and a change of positions while `erd_layout` holds a merge
 * conflict (unless `keepLayoutIfConflicted`, which leaves it as it is).
 */
export function editSubjectAreaDbml(oldText: string, edit: SubjectAreaDbmlEdit): string {
  return refuseOverlaps(edit.filePath, () => editSubjectArea(oldText, edit));
}

/** How the members of a diagram after an edit line up with its `use` lines before it ({@link planMembers}). */
interface MemberPlan {
  /** The `use` members after the edit, each named by its reference after the edit. */
  newMembers: string[];
  /** The members with no table file to `use` after the edit (D26), in order. */
  newUnlinked: string[];
  /** For each of `newMembers`, the old member `use` line it keeps (its index), or undefined for a new line. */
  oldIndexOf: Array<number | undefined>;
  /** For each of `newMembers`, its table after the edit. */
  tables: Array<DbmlDiagramTable | undefined>;
  /** What each kept old `use` line is written as: its own bytes, a rewritten line, or null when it is cut. */
  lineOf: Map<number, string | null>;
  /** For each of `newMembers`, whether its reference is `<schema>.<name>` (another member has its name). */
  qualified: boolean[];
  /** The caller's names for members whose reference after the edit is spelled otherwise → that reference. */
  renames: Map<string, string>;
  /** The members after the edit as text names them: the `use` members with their identities, then the unlinked ones. */
  candidates: TableRefCandidate[];
  /** Whether two members share a name (in different schema folders) before the edit, and after it. */
  pairBefore: boolean;
  pairAfter: boolean;
}

/**
 * Pair the members a diagram lists after an edit with its member `use` lines
 * (`memberUses`, which `reading` read as `allOldMembers`), and name each by
 * its reference after the edit.
 *
 * A member keeps the first unused line whose member had its name; else the
 * line of the member `renamedMembers` says it was; else the line that already
 * imports its table's file, when the member is named by that table's bare
 * name or `<schema>.<name>`. So a member whose reference changes (a table of
 * its name joins or leaves the diagram) keeps its line, byte for byte.
 *
 * Each member's reference is its bare name unless another member, in another
 * schema folder, has the same name (`assignTableRefs`): the identity of a
 * line kept as it is comes from that line, as the reader will read it, and
 * of a new or rewritten line from its table's file. On an edit that changes
 * nothing no member is renamed (Law 1). A bare reference keeps the caller's
 * spelling, so a diagram where no two members share a name is named exactly
 * as the caller named it.
 */
function planMembers(
  text: string,
  file: string,
  reading: DbmlSubjectAreaReading,
  memberUses: ReturnType<typeof useLinesOf>,
  allOldMembers: readonly string[],
  edit: SubjectAreaDbmlEdit,
  changing: boolean,
): MemberPlan {
  const oldMembers = allOldMembers.slice(0, memberUses.length);
  const oldUnlinked = allOldMembers.slice(memberUses.length);
  // The reader's member uses, index for index with `memberUses` (the same rule reads both).
  const readUses = reading.uses ?? [];
  const allNewMembers = modelsOf(edit.after);
  // Each member after the edit is a use line or stays unlinked: a use member keeps its line; an
  // unlinked one whose table now has a .dbml file gains a line on any edit that changes something
  // (a no-op stays one, Law 1); one that still has none stays in erd_unlinked_tables.
  const named: string[] = [];
  const newUnlinked: string[] = [];
  {
    const useLeft = oldMembers.map(lower);
    const unlinkedLeft = oldUnlinked.map(lower);
    for (const name of allNewMembers) {
      const atUse = useLeft.indexOf(lower(name));
      if (atUse >= 0) {
        useLeft[atUse] = '';
        named.push(name);
        continue;
      }
      const atUnlinked = unlinkedLeft.indexOf(lower(name));
      if (atUnlinked >= 0) {
        unlinkedLeft[atUnlinked] = '';
        const table = changing ? edit.resolveTable(name) : undefined;
        if (table && table.storage === 'dbml') named.push(name);
        else newUnlinked.push(name);
        continue;
      }
      named.push(name);
    }
    // A new member with no .dbml file that takes the place of an unlinked member this edit removed (that
    // member renamed: a YAML table Convert left, say) stays unlinked under its new name, in its place.
    const removedUnlinked = unlinkedLeft.filter((n) => n !== '').length;
    if (removedUnlinked > 0) {
      let slots = removedUnlinked;
      const unlinkedNow = new Set(newUnlinked.map(lower));
      const renamedUnlinked = new Set<string>();
      for (const name of named) {
        if (slots === 0) break;
        if (oldMembers.some((m) => lower(m) === lower(name)) || edit.resolveTable(name)?.storage === 'dbml') continue;
        renamedUnlinked.add(lower(name));
        slots--;
      }
      if (renamedUnlinked.size > 0) {
        named.splice(0, named.length, ...named.filter((n) => !renamedUnlinked.has(lower(n))));
        const ordered = allNewMembers.filter((n) => unlinkedNow.has(lower(n)) || renamedUnlinked.has(lower(n)));
        newUnlinked.splice(0, newUnlinked.length, ...ordered);
      }
    }
  }
  const tables = named.map((name) => edit.resolveTable(name));

  // --- Each member's line ------------------------------------------------------
  const taken = new Set<number>();
  const oldIndexOf: Array<number | undefined> = named.map(() => undefined);
  const take = (k: number, test: (oldName: string, i: number) => boolean): void => {
    if (oldIndexOf[k] !== undefined) return;
    const at = oldMembers.findIndex((m, i) => !taken.has(i) && test(m, i));
    if (at < 0) return;
    taken.add(at);
    oldIndexOf[k] = at;
  };
  // By name first: each entry takes the first unused line whose member had its name.
  named.forEach((name, k) => take(k, (m) => lower(m) === lower(name)));
  // Then a member the caller says was renamed.
  if (edit.renamedMembers && edit.renamedMembers.size > 0) {
    const renamedTo = new Map([...edit.renamedMembers].map(([from, to]) => [lower(from), lower(to)] as const));
    named.forEach((name, k) => take(k, (m) => renamedTo.get(lower(m)) === lower(name)));
  }
  // Then the line that already imports the member's table, when the member is named as that table.
  named.forEach((name, k) => {
    if (oldIndexOf[k] !== undefined) return;
    const table = tables[k];
    const id = table && table.storage === 'dbml' ? tableIdOfPath(normalisePosix(table.path)) : undefined;
    if (!table || !id || (lower(name) !== lower(id.name) && lower(name) !== lower(qualifiedRef(id.schema, id.name)))) return;
    const path = lower(normalisePosix(table.path));
    take(k, (_, i) => lower(memberUses[i].resolved) === path && lower(readUses[i]?.name ?? '') === lower(id.name));
  });

  // A kept line, rewritten when its table's path changed or its target is gone; else its own bytes.
  // Null when its table was deleted in this edit (in `pathChanged` with no file now): the line is
  // cut, so no other DBML tool meets an import of a file that is gone (D16).
  const pathChanged = new Set([...(edit.pathChanged ?? [])].map(lower));
  const lineOf = new Map<number, string | null>();
  oldIndexOf.forEach((i, k) => {
    if (i === undefined) return;
    const use = memberUses[i];
    const own = text.slice(use.node.start, use.node.end);
    const table = tables[k];
    // A member named by its bare name is also found by its file's stem; a qualified one only by its reference.
    const bare = lower(oldMembers[i]) === lower(readUses[i]?.name ?? oldMembers[i]);
    const names = [oldMembers[i], named[k], ...(bare ? [use.stem] : [])];
    if (names.some((n) => pathChanged.has(lower(n)))) {
      if (!table && !edit.fileExists(use.resolved)) lineOf.set(i, null);
      else lineOf.set(i, table && table.storage === 'dbml' ? tableUseLine(table.reference, file, table.path) : own);
      return;
    }
    // A stale path (its file is gone) is repointed by any edit that changes something; a no-op stays one (Law 1).
    if (changing && !edit.fileExists(use.resolved) && table && table.storage === 'dbml') lineOf.set(i, tableUseLine(table.reference, file, table.path));
    else lineOf.set(i, own);
  });

  // --- Each member's reference ----------------------------------------------------
  // A line kept as it is is read back from its own path; a new or rewritten one from its table's file.
  const identities: TableId[] = named.map((name, k) => {
    const i = oldIndexOf[k];
    if (i !== undefined) {
      const use = memberUses[i];
      const out = lineOf.get(i);
      if (out === null || out === text.slice(use.node.start, use.node.end)) {
        return { schema: readUses[i]?.schema ?? '', name: readUses[i]?.name ?? name };
      }
    }
    const table = tables[k];
    const id = table && table.storage === 'dbml' ? tableIdOfPath(normalisePosix(table.path)) : undefined;
    return id ? { schema: id.schema, name: id.name } : { schema: '', name: table?.name ?? name };
  });
  const refs = assignTableRefs(identities);
  const qualified = refs.map((ref, k) => lower(ref) !== lower(identities[k].name));
  const newMembers = named.map((name, k) => {
    if (!changing) return name;
    if (qualified[k]) return refs[k];
    return lower(name) === lower(identities[k].name) ? name : refs[k];
  });
  const renames = new Map<string, string>();
  named.forEach((name, k) => { if (newMembers[k] !== name && !renames.has(name)) renames.set(name, newMembers[k]); });
  const candidates: TableRefCandidate[] = [
    ...newMembers.map((ref, k) => {
      const i = oldIndexOf[k];
      const qualifier = i !== undefined ? readUses[i]?.qualifier : undefined;
      return { schema: identities[k].schema, name: identities[k].name, ref, ...(qualifier !== undefined ? { qualifiers: [qualifier] } : {}) };
    }),
    ...newUnlinked.map((name) => ({ schema: '', name, ref: name })),
  ];
  const pairBefore = readUses.some((u) => u.ref !== undefined && lower(u.ref) !== lower(u.name));
  return { newMembers, newUnlinked, oldIndexOf, tables, lineOf, qualified, renames, candidates, pairBefore, pairAfter: qualified.some((q) => q) };
}

function editSubjectArea(oldText: string, edit: SubjectAreaDbmlEdit): string {
  const parser = edit.parser ?? PINNED_PARSER;
  const file = edit.filePath;
  const hadBom = oldText.charCodeAt(0) === 0xfeff;
  const text = stripBom(oldText);
  const eol = eolOf(text);
  let reading;
  try {
    reading = parseSubjectAreaDbml(text, file, parser);
  } catch (err) {
    if (err instanceof SubjectAreaFileError || err instanceof SubjectAreaValidationError) {
      const line = err instanceof SubjectAreaFileError ? err.line : undefined;
      refuse(file, `Fix the DBML in ${file} first (${err.message}). ERD Studio never rewrites a file it cannot read.`, line);
    }
    throw err;
  }
  if (!reading.writable) {
    const why = reading.warnings.find((w) => /second Project|used twice/.test(w)) ?? 'it has a repeated Note name or a second Project';
    refuse(file, `${file}: ${why}.`);
  }
  const before = edit.before;

  // --- Members: use lines and erd_unlinked_tables (D26) -----------------------------------
  // Each use line by the reader's rule (§1.4): members, relationships imports, and the rest (kept as written).
  const ast = compileOne(text, parser, undefined, { diagram: true }).ast;
  const nodes = topLevel(ast);
  const uses = useLinesOf(ast, text, file);
  const roleOf = (u: (typeof uses)[number]): string => diagramUseRole(u.resolved, u.wildcard, u.tables.length > 0, u.stem).role;
  const memberUses = uses.filter((u) => roleOf(u) === 'member' || roleOf(u) === 'mismatch');
  const relUses = uses.filter((u) => roleOf(u) === 'relationships');
  const allOldMembers = modelsOf(before);
  // `before` must be what the text reads as: members are paired with their use lines by position,
  // and the members with no table file to use (D26) come after them.
  const linedUp = memberUses.length + (reading.unlinked ?? []).length === allOldMembers.length
    && reading.members.length === allOldMembers.length
    && reading.members.every((m, i) => lower(m) === lower(allOldMembers[i]));
  const changing = !deepEqual(before, edit.after) || edit.refreshRelationshipsUses === true || (edit.pathChanged?.size ?? 0) > 0;
  const plan = linedUp ? planMembers(text, file, reading, memberUses, allOldMembers, edit, changing) : undefined;
  // The object as it reads after the edit: every place that names a member under its reference.
  const after = plan && plan.renames.size > 0 ? rekeySubjectArea(edit.after, plan.renames) : edit.after;
  /** A member's table after the edit, by any name the caller or the plan gives it. */
  const tableOf = (name: string): DbmlDiagramTable | undefined => {
    const k = plan ? plan.newMembers.findIndex((m) => lower(m) === lower(name)) : -1;
    return k >= 0 ? plan!.tables[k] : edit.resolveTable(name);
  };

  // --- Refusals ----------------------------------------------------------------
  const afterLogical = isObject(after.logical) ? after.logical : {};
  // A DBML diagram's only relationships are its pending ones (D27): kept, or removed (their line cut); never added or changed.
  // Each is read as the reader names its ends (by the members' references), index for index with its line.
  const pendingRefs = readPendingRefs(text, parser, [], nodes);
  const pendingRead = pendingRefs.map((ref, i) => reading.pending?.[i]?.relationships ?? ref.relationships);
  const relationshipIdentity = (r: Relationship): string =>
    [r.fromModel, r.fromColumn, r.toModel, r.toColumn, r.cardinality, r.role ?? ''].map((part) => lower(String(part ?? ''))).join('\u0000');
  const pendingIds = new Set(pendingRead.flatMap((relationships) => relationships.map(relationshipIdentity)));
  const afterOwn = Array.isArray(afterLogical.relationships) ? (afterLogical.relationships as Relationship[]) : [];
  const beforeLogical = isObject(before.logical) ? before.logical : {};
  const beforeOwn = Array.isArray(beforeLogical.relationships) ? (beforeLogical.relationships as Relationship[]) : [];
  const afterOwnIds = new Set(afterOwn.filter(isObject).map(relationshipIdentity));
  // A pending relationship whose ends or columns an edit re-spelled (a table or column rename, here or in
  // the library) is the same relationship: it takes the place of the one it was, with the same cardinality
  // and role, and its line is re-spelled. Anything else new is refused: a DBML diagram holds no Refs (D5).
  const respelledTo = new Map<string, Relationship>();
  const notOwn = (): never => refuse(file, `${file} is a DBML diagram, which holds no relationships: they live in the table library, in the project's relationships files.`);
  afterOwn.forEach((r, i) => {
    if (!isObject(r)) notOwn();
    if (pendingIds.has(relationshipIdentity(r))) return;
    const was = beforeOwn[i];
    const same = isObject(was) && pendingIds.has(relationshipIdentity(was)) && !afterOwnIds.has(relationshipIdentity(was))
      && was.cardinality === r.cardinality && lower(was.role ?? '') === lower(r.role ?? '')
      && !respelledTo.has(relationshipIdentity(was));
    // Its foreign-key table still has no .dbml file: once it has one, the relationship belongs in the library.
    if (!same || (tableOf(r.fromModel)?.storage === 'dbml' && lower(r.fromModel) !== lower(was!.fromModel))) notOwn();
    respelledTo.set(relationshipIdentity(was!), r);
  });
  const pendingCuts: TextEdit[] = [];
  const pendingEdits: TextEdit[] = [];
  pendingRefs.forEach((ref, index) => {
    const read = pendingRead[index];
    const now = read.map((r) => (afterOwnIds.has(relationshipIdentity(r)) ? r : respelledTo.get(relationshipIdentity(r))));
    const kept = now.filter((r) => r !== undefined).length;
    if (kept === read.length) {
      if (now.every((r, i) => r === read[i])) return;
      const raw = text.slice(ref.start, ref.fullEnd).replace(/\r?\n$/, '');
      const m = /^([ \t]*\/\/[ \t]*erd-studio pending:[ \t]*)(\S.*?)[ \t]*$/i.exec(raw);
      if (m) pendingEdits.push({ start: ref.start + m[1].length, end: ref.start + m[1].length + m[2].length, text: pendingRelationshipRef(now as Relationship[], (t) => tableOf(t)?.reference) });
      return;
    }
    if (kept > 0) refuse(file, `${file}: line ${ref.line} is one pending relationship of several column pairs; remove all of it or none.`, ref.line);
    pendingCuts.push({ start: ref.start, end: ref.fullEnd, text: '' });
  });
  if (before.layer !== after.layer) refuse(file, `${file}: a DBML diagram's layer is its folder; move the file to change it.`);
  if (before.schemaVersion !== after.schemaVersion) refuse(file, `${file}: the schema version of a DBML diagram is not changed by an edit.`);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!TOP_KEYS.has(key) && !deepEqual(before[key], after[key])) refuse(file, `${file}: ${key} cannot be stored in a DBML diagram.`);
  }
  for (const [holder, keys, name] of [[before.viewConfig, VIEW_KEYS, 'viewConfig'], [before.logical, LOGICAL_KEYS, 'logical']] as const) {
    const a = isObject(holder) ? holder : {};
    const b = isObject(name === 'viewConfig' ? after.viewConfig : after.logical) ? (name === 'viewConfig' ? after.viewConfig : after.logical) as Json : {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!keys.has(key) && !deepEqual(a[key], b[key])) refuse(file, `${file}: ${name}.${key} cannot be stored in a DBML diagram.`);
    }
  }

  const edits: TextEdit[] = [];
  const lateEdits: TextEdit[] = [];
  const plans: ListPlan[] = [];
  const firstUses: string[] = [];

  if (!plan) {
    refuse(file, `ERD Studio could not line up the use lines of ${file} with its members (the diagram changed since it was read); reload it and try again.`);
  }
  const planned: MemberPlan = plan;
  const { newMembers, newUnlinked, oldIndexOf } = planned;
  const oldMembers = allOldMembers.slice(0, memberUses.length);
  const oldUnlinked = allOldMembers.slice(memberUses.length);
  // On an edit of a diagram that holds two members of one name (before or after it), every sticky link and
  // stub entry is written as the object names it: a bare name an older version wrote for two tables, or one
  // that would now name another table (its namesake left), never stays to be read as another member.
  const twinTexts = changing && (planned.pairBefore || planned.pairAfter);

  // --- Project ---------------------------------------------------------------------
  const project = nodes.find((n) => lower(elementType(n) ?? '') === 'project');
  const domainBefore = typeof before.domain === 'string' ? before.domain : '';
  const domainAfter = typeof after.domain === 'string' ? after.domain : domainBefore;
  // erd_schema_version (D-2): 8 while the diagram holds two members of one name, back to 7 on the edit
  // that leaves it none; a diagram with no such pair keeps the version it has (or none).
  const versionBefore = String(reading.schemaVersion);
  const versionAfter = changing && planned.pairAfter ? String(DBML_TWIN_SCHEMA_VERSION)
    : changing && planned.pairBefore ? String(DBML_SCHEMA_VERSION)
      : versionBefore;
  const valuesBefore = projectValues(before, oldUnlinked, versionBefore);
  const valuesAfter = projectValues(after, newUnlinked, versionAfter);
  const projectBody: AstNode[] = Array.isArray(project?.body?.body) ? project!.body.body : [];
  // A repeated key is read from its last entry (as the readers read it), so that is the one edited.
  const entryOf = (key: string): AstNode | undefined => [...projectBody].reverse().find((n) => lower(String(n?.type?.value ?? '')) === key);
  const stubKey = DBML_DIAGRAM_PROPERTIES.stubColumns;
  const stubWritten = valuesAfter[stubKey];
  const stubRespelled = twinTexts && stubWritten !== undefined
    && (() => {
      const value = entryOf(stubKey)?.body;
      return !value || text.slice(value.start, value.end) !== dbmlString(stubWritten);
    })();
  const projectChanged = stubRespelled || domainBefore !== domainAfter || Object.keys(valuesAfter).some((k) => valuesAfter[k] !== valuesBefore[k]);
  // The first erd_layout entry (any case): a key added before `}` goes above it, so erd_layout stays last.
  const layoutEntry = projectBody.find((n) => lower(String(n?.type?.value ?? '')) === DBML_DIAGRAM_PROPERTIES.layout);
  // With no Project, one is added at the end, after everything else (below, with erd_layout in it).
  if (projectChanged && project) {
    if (domainBefore !== domainAfter) {
      if (project.name) edits.push({ start: project.name.start, end: project.name.end, text: dbmlName(domainAfter) });
      else edits.push({ start: project.type.end, end: project.type.end, text: ` ${dbmlName(domainAfter)}` });
    }
    const body = projectBody;
    const close = project.body.blockCloseBrace as AstNode;
    const indent = body.length > 0 ? text.slice(text.lastIndexOf('\n', body[0].start - 1) + 1, body[0].start) : '  ';
    const order = ['note', ...PROJECT_KEYS];
    const closeAt = text.lastIndexOf('\n', close.start - 1) + 1;
    const closeAlone = /^[ \t]*$/.test(text.slice(closeAt, close.start));
    for (const key of order) {
      if (valuesAfter[key] === valuesBefore[key] && !(key === stubKey && stubRespelled)) continue;
      const entry = entryOf(key);
      const value = valuesAfter[key];
      if (value === undefined) {
        if (entry) edits.push(cutEdit(text, entry));
        continue;
      }
      const written = dbmlString(value);
      if (entry) {
        const valueNode = key === 'note' && entry.body?.kind === '<block-expression>'
          ? (entry.body.body as AstNode[]).find((n) => n?.kind === '<function-application>')
          : entry.body;
        if (valueNode) edits.push({ start: valueNode.start, end: valueNode.end, text: written });
        continue;
      }
      // A key added goes in after the last known key before it in the order (or before `}`).
      const line = `${indent}${key === 'note' ? 'Note' : key}: ${written}`;
      const previous = order.slice(0, order.indexOf(key)).map(entryOf).filter((n): n is AstNode => n !== undefined).pop();
      if (previous) {
        const at = Math.max(previous.fullEnd, previous.end);
        edits.push({ start: at, end: at, text: `${text[at - 1] === '\n' ? '' : eol}${line}${eol}` });
      } else if (key === 'note' && body.length > 0) {
        const at = attachedStart(text, body[0], project.body.start + 1);
        edits.push({ start: at, end: at, text: `${line}${eol}` });
      } else if (layoutEntry && key !== DBML_DIAGRAM_PROPERTIES.layout) {
        const at = attachedStart(text, layoutEntry, project.body.start + 1);
        edits.push({ start: at, end: at, text: `${line}${eol}` });
      } else {
        const at = closeAlone ? closeAt : close.start;
        edits.push({ start: at, end: at, text: `${closeAlone ? '' : eol}${line}${eol}` });
      }
    }
  }

  // --- Table use lines -----------------------------------------------------------------
  // Retained members keep the line the plan paired them with (planMembers).
  const taken = new Set(oldIndexOf.filter((i): i is number => i !== undefined));
  // A table whose reference changed (another member of its name joined or left) is the same member.
  const pairedNames = newMembers.map((name, k) => (oldIndexOf[k] !== undefined ? oldMembers[oldIndexOf[k]!] : name));
  const membershipChanged = oldMembers.length !== newMembers.length
    || [...new Set(oldMembers.map(lower))].sort().join('\u0000') !== [...new Set(pairedNames.map(lower))].sort().join('\u0000')
    || oldIndexOf.some((i) => i === undefined);
  const retained = oldIndexOf.filter((i): i is number => i !== undefined);
  const reordered = retained.some((i, k) => k > 0 && i < retained[k - 1]);
  const newLineFor = (k: number): string => {
    const name = newMembers[k];
    const table = planned.tables[k];
    if (!table || table.storage !== 'dbml') {
      refuse(file, `${name} cannot be added to a DBML diagram: ${table ? `it is a YAML table. ${DBML_CONVERT_FIRST_MESSAGE}.` : 'there is no table file with that name.'}`);
    }
    return tableUseLine(table.reference, file, table.path);
  };
  const retainedText = (oldIndex: number): string | null => planned.lineOf.get(oldIndex) ?? null;
  const lastTableUse = memberUses[memberUses.length - 1];
  const afterUses = (): number => {
    const last = uses[uses.length - 1];
    if (last) return Math.max(last.node.fullEnd, last.node.end);
    return -1;
  };
  if (reordered) {
    // Each line moves with the comment lines directly above it and its own trailing comment.
    const tailOf = (node: AstNode): string => {
      const tail = text.slice(node.end, lineEndOf(text, node.end));
      return /^[ \t]*(\/\/|\/\*)/.test(tail) ? tail : '';
    };
    const aboveOf = (node: AstNode): string => text.slice(attachedStart(text, node), lineStartOf(text, node.start));
    const lines = newMembers.flatMap((_, k) => {
      const i = oldIndexOf[k];
      if (i === undefined) return [newLineFor(k)];
      const node = memberUses[i].node;
      const out = retainedText(i);
      // A deleted member's line goes; the comment lines above it stay (the cut rule).
      if (out === null) return aboveOf(node) === '' ? [] : [aboveOf(node).replace(/\r?\n$/, '')];
      return [`${aboveOf(node)}${out}${tailOf(node)}`];
    });
    // A line that goes (a member removed) leaves the comment lines above it where they are.
    const startOf = (i: number): number => (taken.has(i) ? attachedStart(text, memberUses[i].node) : cutSpan(text, memberUses[i].node).start);
    const first = memberUses[0].node;
    const firstEnd = !taken.has(0) || tailOf(first) ? lineEndOf(text, first.end) : first.end;
    if (lines.length > 0) edits.push({ start: startOf(0), end: firstEnd, text: lines.join(eol) });
    else edits.push({ start: startOf(0), end: cutSpan(text, first).end, text: '' });
    memberUses.slice(1).forEach((use, k) => edits.push({ start: startOf(k + 1), end: cutSpan(text, use.node).end, text: '' }));
  } else {
    oldMembers.forEach((_, i) => {
      const use = memberUses[i];
      if (!taken.has(i)) {
        edits.push(cutEdit(text, use.node));
        return;
      }
      const out = retainedText(i);
      if (out === null) edits.push(cutEdit(text, use.node));
      else if (out !== text.slice(use.node.start, use.node.end)) edits.push({ start: use.node.start, end: use.node.end, text: out });
    });
    newMembers.forEach((_, k) => {
      if (oldIndexOf[k] !== undefined) return;
      const line = newLineFor(k);
      const next = oldIndexOf.slice(k + 1).find((i) => i !== undefined);
      if (next !== undefined) {
        const at = attachedStart(text, memberUses[next].node);
        edits.push({ start: at, end: at, text: `${line}${eol}` });
        return;
      }
      if (lastTableUse) {
        const at = Math.max(lastTableUse.node.fullEnd, lastTableUse.node.end);
        lateEdits.push({ start: at, end: at, text: `${text[at - 1] === '\n' ? '' : eol}${line}${eol}` });
        return;
      }
      const first = firstUseInsert(`${line}${eol}`);
      if (first) lateEdits.push(first);
    });
  }
  // --- Relationships use lines (only on a membership change or the settle pass) -------
  // The unlinked members count: a pending line to one of them brings its file's import (§2.4).
  const unlinkedChanged = [...new Set(oldUnlinked.map(lower))].sort().join('\u0000') !== [...new Set(newUnlinked.map(lower))].sort().join('\u0000');
  if (membershipChanged || unlinkedChanged || edit.refreshRelationshipsUses) {
    const current = [...new Set(relUses.map((u) => u.resolved))];
    const wanted = [...new Set(edit.relationshipsImportsFor(newMembers, current, newUnlinked).map(normalisePosix))].filter((p) => edit.fileExists(p));
    const keptRel = relUses.filter((u) => wanted.includes(u.resolved));
    for (const u of relUses) if (!wanted.includes(u.resolved)) edits.push(cutEdit(text, u.node));
    const have = new Set(keptRel.map((u) => u.resolved));
    const additions = wanted.filter((p) => !have.has(p))
      .map((p) => usePathBetween(file, p))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const path of additions) {
      const line = `use * from '${path}'`;
      const before = keptRel.find((u) => u.importPath > path);
      if (before) {
        const at = attachedStart(text, before.node);
        lateEdits.push({ start: at, end: at, text: `${line}${eol}` });
        continue;
      }
      const lastRel = keptRel[keptRel.length - 1];
      const anchor = lastRel ?? lastTableUse ?? uses[uses.length - 1];
      if (anchor) {
        const at = Math.max(anchor.node.fullEnd, anchor.node.end);
        lateEdits.push({ start: at, end: at, text: `${text[at - 1] === '\n' ? '' : eol}${line}${eol}` });
        continue;
      }
      const first = firstUseInsert(`${line}${eol}`);
      if (first) lateEdits.push(first);
    }
  }

  // The first use lines of a diagram that had none: one block, a blank line after it (§1.4).
  if (firstUses.length > 0) {
    const anchor = nodes.find((n) => lower(elementType(n) ?? '') === 'note') ?? project;
    if (anchor) {
      const at = attachedStart(text, anchor, headerEnd(text));
      lateEdits.push({ start: at, end: at, text: `${firstUses.join('')}${eol}` });
    } else {
      const lead = text.trim() === '' ? '' : text.endsWith('\n') ? eol : `${eol}${eol}`;
      lateEdits.push({ start: text.length, end: text.length, text: `${lead}${firstUses.join('')}` });
    }
  }

  // --- Notes ----------------------------------------------------------------------------
  const noteNodes = new Map<string, AstNode>();
  for (const node of nodes) {
    if (lower(elementType(node) ?? '') !== 'note') continue;
    const parts = plainNames(node.name);
    if (parts && parts.length > 0) noteNodes.set(parts.join('.'), node);
  }
  const notesBefore = new Map(annotationsOf(before).map((a) => [a.id, a]));
  const notesAfter = annotationsOf(after);
  const afterIds = new Set(notesAfter.map((a) => a.id));
  for (const [id] of notesBefore) {
    if (afterIds.has(id)) continue;
    const node = noteNodes.get(id);
    if (node) edits.push(cutEdit(text, node));
  }
  const appended: string[] = [];
  for (const annotation of notesAfter) {
    const old = notesBefore.get(annotation.id);
    const node = noteNodes.get(annotation.id);
    if (!old || !node) {
      if (!old && !node) appended.push(noteBlock(annotation, eol));
      continue;
    }
    if (dbmlNoteText(old.text ?? '') !== dbmlNoteText(annotation.text ?? '')) {
      const body = node.body;
      const value = body?.kind === '<block-expression>' && Array.isArray(body.body)
        ? (body.body as AstNode[]).find((n) => n?.kind === '<function-application>')
        : undefined;
      if (value) edits.push({ start: value.start, end: value.end, text: dbmlString(dbmlNoteText(annotation.text ?? '')) });
      else if (body?.blockCloseBrace) edits.push({ start: body.blockCloseBrace.start, end: body.blockCloseBrace.start, text: `  ${dbmlString(dbmlNoteText(annotation.text ?? ''))}${eol}` });
    }
    const colourChanged = (old.color as AnnotationColor | undefined) !== annotation.color;
    const list: AstNode | undefined = node.attributeList;
    const elements: AstNode[] = Array.isArray(list?.elementList) ? list!.elementList : [];
    const linkChanged = (old.linkedModel ?? undefined) !== (annotation.linkedModel ?? undefined)
      || (twinTexts && annotation.linkedModel !== undefined && (() => {
        const written = elements.filter((e) => attributeName(e) === DBML_RICH_NOTE_PROPERTIES.linkedTable).pop()?.value;
        return !written || text.slice(written.start, written.end) !== dbmlString(annotation.linkedModel!);
      })());
    if (colourChanged || linkChanged) {
      const plan: ListPlan = { list: list ?? null, anchor: node.body.start, elements: new Array(elements.length).fill(undefined), added: [], multiLineWhenNew: false };
      const set = (name: string, order: number, value: string | undefined): void => {
        const at = elements.map((e, i) => [e, i] as const).filter(([e]) => attributeName(e) === name);
        if (value === undefined) {
          for (const [, i] of at) plan.elements[i] = null;
          return;
        }
        if (at.length > 0) {
          const [element, i] = at[at.length - 1];
          plan.elements[i] = element.value
            ? text.slice(element.start, element.value.start) + value + text.slice(element.value.end, element.end)
            : `${name}: ${value}`;
          return;
        }
        plan.added.push({ order, text: `${name}: ${value}` });
      };
      if (colourChanged) set('color', 0, annotation.color ? DBML_RICH_STICKY_COLOURS[annotation.color] : undefined);
      if (linkChanged) set(DBML_RICH_NOTE_PROPERTIES.linkedTable, 1, annotation.linkedModel ? dbmlString(annotation.linkedModel) : undefined);
      plans.push(plan);
    }
  }
  for (const plan of plans) edits.push(...renderListPlan(text, plan, eol));
  if (appended.length > 0) {
    // New notes go after the others: before a Project that ends the file (§1.4, Project last), else at the end.
    if (project && nodes[nodes.length - 1] === project) {
      const at = attachedStart(text, project, headerEnd(text));
      lateEdits.push({ start: at, end: at, text: `${appended.join(`${eol}${eol}`)}${eol}${eol}` });
    } else {
      const at = text.length;
      const lead = text === '' ? '' : text.endsWith('\n') ? eol : `${eol}${eol}`;
      lateEdits.push({ start: at, end: at, text: `${lead}${appended.join(`${eol}${eol}`)}${eol}` });
    }
  }

  // --- erd_layout (§1.6): positions and sticky-note boxes ------------------------------
  // Written only when the canvas's positions or boxes changed, so an edit that moved nothing
  // leaves the value's bytes as they are (even where the reader placed a note the file does not).
  // A diagram where an older version kept one bare line for two members of one name
  // (`layoutSharedBare`) gets each member's own line on the next edit that changes something.
  const layoutAfter = layoutOfObject(after);
  const sharedBareLines = changing && (reading.layoutSharedBare?.length ?? 0) > 0;
  const layoutChanged = sharedBareLines || !sameErdLayout(layoutOfObject(before), layoutAfter);
  const keepLayout = edit.keepLayoutIfConflicted === true && reading.layoutConflictLine !== undefined;
  if (!project) {
    // No Project: one goes at the end (Project last), holding whatever this edit sets.
    const layout = layoutChanged ? layoutLine(withMemberRefs(layoutAfter, planned.candidates), eol, '  ') : undefined;
    if (projectChanged || layout !== undefined) {
      const block = projectLines(domainAfter, projectChanged ? valuesAfter : {}, layout).join(eol);
      const lead = text.trim() === '' && !appendsAtEnd() ? '' : text.endsWith('\n') || appendsAtEnd() ? eol : `${eol}${eol}`;
      lateEdits.push({ start: text.length, end: text.length, text: `${lead}${block}${eol}` });
    }
  } else if (layoutChanged && !keepLayout) {
    const change = erdLayoutTextEdit(text, ast, layoutAfter, eol, file, undefined, planned.candidates);
    if (change) lateEdits.push(change);
  }

  const out = applyTextEdits(text, [...closeCutGaps(text, edits, [...pendingEdits, ...lateEdits]), ...pendingEdits, ...pendingLineCuts(text, pendingCuts), ...lateEdits]);
  return hadBom ? `﻿${out}` : out;

  /** Whether an edit so far appends text at the very end of the file (a note, a first `use` line). */
  function appendsAtEnd(): boolean {
    return lateEdits.some((e) => e.start === text.length && e.end === text.length && e.text !== '');
  }

  /**
   * A new `use` line where there is no `use` line to place it by: after the
   * last `use` line when the file has one; else null, and the line joins the
   * first `use` lines, which go in one block before the first Note, else
   * before the Project, else at the end (§1.4).
   */
  function firstUseInsert(line: string): TextEdit | null {
    const at = afterUses();
    if (at >= 0) return { start: at, end: at, text: `${text[at - 1] === '\n' ? '' : eol}${line}` };
    firstUses.push(line);
    return null;
  }
}
