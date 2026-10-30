/**
 * The diagram writer (§2.5 and §4.5 of the native DBML storage spec): a new
 * `<layer>/<name>.dbml` diagram, and an edit that diffs the v5 object a
 * diagram was read into (`before`) against the one a handler produced
 * (`after`) and splices only what changed — Project values, table `use`
 * lines, the relationships `use` lines, sticky-note `Note` blocks, and the
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
import { DBML_SCHEMA_VERSION } from '../types/semantic.js';
import { SubjectAreaFileError, SubjectAreaValidationError } from '../domain.js';
import {
  DBML_DIAGRAM_PROPERTIES,
  DBML_RELATIONSHIPS_FILE_STEM,
  DBML_RICH_NOTE_PROPERTIES,
  DBML_RICH_STICKY_COLOURS,
  formatUnlinkedTables,
  pendingRefLine,
} from '../dbmlRichProperties.js';
import { readPendingRefs } from './readRelationships.js';
import { dbmlName, dbmlNoteText, dbmlString } from '../dbmlText.js';
import { erdLayoutOf, renderErdLayoutValue, sameErdLayout, withMemberSpelling, type ErdLayout } from '../erdLayout.js';
import type { NodePosition } from '../types/semantic.js';
import { isSafeTableName } from '../logicalModel.js';
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
import { parseSubjectAreaDbml } from './readDiagram.js';
import { erdLayoutTextEdit } from './erdLayoutDbml.js';
import {
  applyTextEdits,
  attachedStart,
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
  /** The v5 object after the handler's change. */
  after: Record<string, unknown>;
  /** A table AFTER this edit; undefined when there is none. */
  resolveTable(name: string): DbmlDiagramTable | undefined;
  /** Tables whose file moved, was renamed or was deleted in this edit (lower-case). */
  pathChanged?: ReadonlySet<string>;
  /** The relationships files (paths after this edit, relative to the semantic dir) of the library folders holding these DBML tables. */
  relationshipsFilesFor(memberNames: readonly string[]): string[];
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
function projectValues(obj: Json, unlinked: readonly string[] = []): Record<string, string | undefined> {
  const view = isObject(obj.viewConfig) ? obj.viewConfig : {};
  const description = typeof obj.description === 'string' ? dbmlNoteText(obj.description) : '';
  return {
    note: description === '' ? undefined : description,
    [DBML_DIAGRAM_PROPERTIES.schemaVersion]: String(DBML_SCHEMA_VERSION),
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
  const values = projectValues({
    description: input.description ?? '',
    ...(input.modelFolder !== undefined ? { modelFolder: input.modelFolder } : {}),
    ...(input.stubColumns !== undefined ? { stubColumns: input.stubColumns } : {}),
    viewConfig: view,
  }, input.unlinked ?? []);
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
  const layout = layoutLine(erdLayoutOf(input.positions, input.annotations), '\n', '  ');
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
  const after = edit.after;

  // --- Refusals ----------------------------------------------------------------
  const afterLogical = isObject(after.logical) ? after.logical : {};
  // A DBML diagram's only relationships are its pending ones (D27): kept, or removed (their line cut); never added or changed.
  const pendingRefs = readPendingRefs(text, parser, [], topLevel(compileOne(text, parser, undefined, { diagram: true }).ast));
  const relationshipIdentity = (r: Relationship): string =>
    [r.fromModel, r.fromColumn, r.toModel, r.toColumn, r.cardinality, r.role ?? ''].map((part) => lower(String(part ?? ''))).join('\u0000');
  const pendingIds = new Set(pendingRefs.flatMap((ref) => ref.relationships.map(relationshipIdentity)));
  const afterOwn = Array.isArray(afterLogical.relationships) ? (afterLogical.relationships as Relationship[]) : [];
  const beforeLogical = isObject(before.logical) ? before.logical : {};
  const beforeOwn = Array.isArray(beforeLogical.relationships) ? (beforeLogical.relationships as Relationship[]) : [];
  const afterOwnIds = new Set(afterOwn.filter(isObject).map(relationshipIdentity));
  // A pending relationship whose ends or columns an edit re-spelled (a table or column rename, here or in
  // the library) is the same relationship: it takes the place of the one it was, with the same cardinality
  // and role, and its line is re-spelled. Anything else new is refused: a DBML diagram holds no Refs (D5).
  const respelledTo = new Map<string, Relationship>();
  const notOwn = (): never => refuse(file, `${file} is a DBML diagram, which holds no relationships: they live in the table library, in the relationships file of the foreign-key table's folder.`);
  afterOwn.forEach((r, i) => {
    if (!isObject(r)) notOwn();
    if (pendingIds.has(relationshipIdentity(r))) return;
    const was = beforeOwn[i];
    const same = isObject(was) && pendingIds.has(relationshipIdentity(was)) && !afterOwnIds.has(relationshipIdentity(was))
      && was.cardinality === r.cardinality && lower(was.role ?? '') === lower(r.role ?? '')
      && !respelledTo.has(relationshipIdentity(was));
    // Its foreign-key table still has no .dbml file: once it has one, the relationship belongs in the library.
    if (!same || (edit.resolveTable(r.fromModel)?.storage === 'dbml' && lower(r.fromModel) !== lower(was!.fromModel))) notOwn();
    respelledTo.set(relationshipIdentity(was!), r);
  });
  const pendingCuts: TextEdit[] = [];
  const pendingEdits: TextEdit[] = [];
  for (const ref of pendingRefs) {
    const now = ref.relationships.map((r) => (afterOwnIds.has(relationshipIdentity(r)) ? r : respelledTo.get(relationshipIdentity(r))));
    const kept = now.filter((r) => r !== undefined).length;
    if (kept === ref.relationships.length) {
      if (now.every((r, i) => r === ref.relationships[i])) continue;
      const raw = text.slice(ref.start, ref.fullEnd).replace(/\r?\n$/, '');
      const m = /^([ \t]*\/\/[ \t]*erd-studio pending:[ \t]*)(\S.*?)[ \t]*$/i.exec(raw);
      if (m) pendingEdits.push({ start: ref.start + m[1].length, end: ref.start + m[1].length + m[2].length, text: pendingRelationshipRef(now as Relationship[], (t) => edit.resolveTable(t)?.reference) });
      continue;
    }
    if (kept > 0) refuse(file, `${file}: line ${ref.line} is one pending relationship of several column pairs; remove all of it or none.`, ref.line);
    pendingCuts.push({ start: ref.start, end: ref.fullEnd, text: '' });
  }
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

  const ast = compileOne(text, parser, undefined, { diagram: true }).ast;
  const nodes = topLevel(ast);
  const edits: TextEdit[] = [];
  const lateEdits: TextEdit[] = [];
  const plans: ListPlan[] = [];
  const firstUses: string[] = [];

  // --- Members: use lines and erd_unlinked_tables (D26) -----------------------------------
  const uses = useLinesOf(ast, text, file);
  const memberUses = uses.filter((u) => lower(u.stem) !== DBML_RELATIONSHIPS_FILE_STEM && isSafeTableName(u.stem));
  const relUses = uses.filter((u) => lower(u.stem) === DBML_RELATIONSHIPS_FILE_STEM);
  const allOldMembers = modelsOf(before);
  const allNewMembers = modelsOf(after);
  // `before` must be what the text reads as: members are paired with their use lines by position,
  // and the members with no table file to use (D26) come after them.
  if (memberUses.length + (reading.unlinked ?? []).length !== allOldMembers.length
    || reading.members.length !== allOldMembers.length
    || reading.members.some((m, i) => lower(m) !== lower(allOldMembers[i]))) {
    refuse(file, `ERD Studio could not line up the use lines of ${file} with its members (the diagram changed since it was read); reload it and try again.`);
  }
  const changing = !deepEqual(before, after) || edit.refreshRelationshipsUses === true || (edit.pathChanged?.size ?? 0) > 0;
  const oldMembers = allOldMembers.slice(0, memberUses.length);
  const oldUnlinked = allOldMembers.slice(memberUses.length);
  // Each member after the edit is a use line or stays unlinked: a use member keeps its line; an
  // unlinked one whose table now has a .dbml file gains a line on any edit that changes something
  // (a no-op stays one, Law 1); one that still has none stays in erd_unlinked_tables.
  const newMembers: string[] = [];
  const newUnlinked: string[] = [];
  {
    const useLeft = oldMembers.map(lower);
    const unlinkedLeft = oldUnlinked.map(lower);
    for (const name of allNewMembers) {
      const atUse = useLeft.indexOf(lower(name));
      if (atUse >= 0) {
        useLeft[atUse] = '';
        newMembers.push(name);
        continue;
      }
      const atUnlinked = unlinkedLeft.indexOf(lower(name));
      if (atUnlinked >= 0) {
        unlinkedLeft[atUnlinked] = '';
        const table = changing ? edit.resolveTable(name) : undefined;
        if (table && table.storage === 'dbml') newMembers.push(name);
        else newUnlinked.push(name);
        continue;
      }
      newMembers.push(name);
    }
    // A new member with no .dbml file that takes the place of an unlinked member this edit removed (that
    // member renamed: a YAML table Convert left, say) stays unlinked under its new name, in its place.
    const removedUnlinked = unlinkedLeft.filter((n) => n !== '').length;
    if (removedUnlinked > 0) {
      let slots = removedUnlinked;
      const unlinkedNow = new Set(newUnlinked.map(lower));
      const renamedUnlinked = new Set<string>();
      for (const name of newMembers) {
        if (slots === 0) break;
        if (oldMembers.some((m) => lower(m) === lower(name)) || edit.resolveTable(name)?.storage === 'dbml') continue;
        renamedUnlinked.add(lower(name));
        slots--;
      }
      if (renamedUnlinked.size > 0) {
        newMembers.splice(0, newMembers.length, ...newMembers.filter((n) => !renamedUnlinked.has(lower(n))));
        const ordered = allNewMembers.filter((n) => unlinkedNow.has(lower(n)) || renamedUnlinked.has(lower(n)));
        newUnlinked.splice(0, newUnlinked.length, ...ordered);
      }
    }
  }

  // --- Project ---------------------------------------------------------------------
  const project = nodes.find((n) => lower(elementType(n) ?? '') === 'project');
  const domainBefore = typeof before.domain === 'string' ? before.domain : '';
  const domainAfter = typeof after.domain === 'string' ? after.domain : domainBefore;
  const valuesBefore = projectValues(before, oldUnlinked);
  const valuesAfter = projectValues(after, newUnlinked);
  const projectChanged = domainBefore !== domainAfter || Object.keys(valuesAfter).some((k) => valuesAfter[k] !== valuesBefore[k]);
  // The first erd_layout entry (any case): a key added before `}` goes above it, so erd_layout stays last.
  const layoutEntry = (Array.isArray(project?.body?.body) ? project!.body.body as AstNode[] : [])
    .find((n) => lower(String(n?.type?.value ?? '')) === DBML_DIAGRAM_PROPERTIES.layout);
  // With no Project, one is added at the end, after everything else (below, with erd_layout in it).
  if (projectChanged && project) {
    if (domainBefore !== domainAfter) {
      if (project.name) edits.push({ start: project.name.start, end: project.name.end, text: dbmlName(domainAfter) });
      else edits.push({ start: project.type.end, end: project.type.end, text: ` ${dbmlName(domainAfter)}` });
    }
    const body: AstNode[] = Array.isArray(project.body?.body) ? project.body.body : [];
    // A repeated key is read from its last entry (as the readers read it), so that is the one edited.
    const entryOf = (key: string): AstNode | undefined => [...body].reverse().find((n) => lower(String(n?.type?.value ?? '')) === key);
    const close = project.body.blockCloseBrace as AstNode;
    const indent = body.length > 0 ? text.slice(text.lastIndexOf('\n', body[0].start - 1) + 1, body[0].start) : '  ';
    const order = ['note', ...PROJECT_KEYS];
    const closeAt = text.lastIndexOf('\n', close.start - 1) + 1;
    const closeAlone = /^[ \t]*$/.test(text.slice(closeAt, close.start));
    for (const key of order) {
      if (valuesAfter[key] === valuesBefore[key]) continue;
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
  // Retained members: each new entry takes the first unused old one with its name.
  const taken = new Set<number>();
  const oldIndexOf: Array<number | undefined> = newMembers.map((name) => {
    const at = oldMembers.findIndex((m, i) => !taken.has(i) && lower(m) === lower(name));
    if (at < 0) return undefined;
    taken.add(at);
    return at;
  });
  const membershipChanged = oldMembers.length !== newMembers.length
    || [...new Set(oldMembers.map(lower))].sort().join('\u0000') !== [...new Set(newMembers.map(lower))].sort().join('\u0000')
    || oldIndexOf.some((i) => i === undefined);
  const retained = oldIndexOf.filter((i): i is number => i !== undefined);
  const reordered = retained.some((i, k) => k > 0 && i < retained[k - 1]);
  const pathChanged = new Set([...(edit.pathChanged ?? [])].map(lower));
  const newLineFor = (name: string): string => {
    const table = edit.resolveTable(name);
    if (!table || table.storage !== 'dbml') {
      refuse(file, `${name} cannot be added to a DBML diagram: ${table ? `it is a YAML table. ${DBML_CONVERT_FIRST_MESSAGE}.` : 'there is no table file with that name.'}`);
    }
    return tableUseLine(table.reference, file, table.path);
  };
  /**
   * A retained line, rewritten when its table's path changed or its target is gone; else its own
   * bytes. Null when its table was deleted in this edit (in `pathChanged` with no file now): the
   * line is cut, so no other DBML tool meets an import of a file that is gone (D16).
   */
  const retainedText = (oldIndex: number): string | null => {
    const use = memberUses[oldIndex];
    const own = text.slice(use.node.start, use.node.end);
    const name = oldMembers[oldIndex];
    const table = edit.resolveTable(name);
    if (pathChanged.has(lower(name)) || pathChanged.has(lower(use.stem))) {
      if (!table && !edit.fileExists(use.resolved)) return null;
      return table && table.storage === 'dbml' ? tableUseLine(table.reference, file, table.path) : own;
    }
    // A stale path (its file is gone) is repointed by any edit that changes something; a no-op stays one (Law 1).
    if (changing && !edit.fileExists(use.resolved) && table && table.storage === 'dbml') return tableUseLine(table.reference, file, table.path);
    return own;
  };
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
    const lines = newMembers.flatMap((name, k) => {
      const i = oldIndexOf[k];
      if (i === undefined) return [newLineFor(name)];
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
    newMembers.forEach((name, k) => {
      if (oldIndexOf[k] !== undefined) return;
      const line = newLineFor(name);
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
  if (membershipChanged || edit.refreshRelationshipsUses) {
    const wanted = [...new Set(edit.relationshipsFilesFor(newMembers).map(normalisePosix))].filter((p) => edit.fileExists(p));
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
    const linkChanged = (old.linkedModel ?? undefined) !== (annotation.linkedModel ?? undefined);
    if (colourChanged || linkChanged) {
      const list: AstNode | undefined = node.attributeList;
      const elements: AstNode[] = Array.isArray(list?.elementList) ? list!.elementList : [];
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
  const layoutAfter = layoutOfObject(after);
  const layoutChanged = !sameErdLayout(layoutOfObject(before), layoutAfter);
  const keepLayout = edit.keepLayoutIfConflicted === true && reading.layoutConflictLine !== undefined;
  if (!project) {
    // No Project: one goes at the end (Project last), holding whatever this edit sets.
    const layout = layoutChanged ? layoutLine(withMemberSpelling(layoutAfter, allNewMembers), eol, '  ') : undefined;
    if (projectChanged || layout !== undefined) {
      const block = projectLines(domainAfter, projectChanged ? valuesAfter : {}, layout).join(eol);
      const lead = text.trim() === '' && !appendsAtEnd() ? '' : text.endsWith('\n') || appendsAtEnd() ? eol : `${eol}${eol}`;
      lateEdits.push({ start: text.length, end: text.length, text: `${lead}${block}${eol}` });
    }
  } else if (layoutChanged && !keepLayout) {
    const change = erdLayoutTextEdit(text, ast, layoutAfter, eol, file, allNewMembers);
    if (change) lateEdits.push(change);
  }

  const out = applyTextEdits(text, [...edits, ...pendingEdits, ...pendingLineCuts(text, pendingCuts), ...lateEdits]);
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
