/**
 * The diagram writer (§2.5 and §4.5 of the native DBML storage spec): a new
 * `<layer>/<name>.dbml` diagram, and an edit that diffs the v5 object a
 * diagram was read into (`before`) against the one a handler produced
 * (`after`) and splices only what changed — Project values, table `use`
 * lines, the relationships `use` lines, sticky-note `Note` blocks. Positions
 * and sticky-note boxes live in the layout file (`editDiagramLayout`), not
 * here. A DBML diagram holds no Refs (D5).
 */

import type { Annotation, AnnotationColor } from '../types/semantic.js';
import { DBML_SCHEMA_VERSION } from '../types/semantic.js';
import { SubjectAreaFileError, SubjectAreaValidationError } from '../domain.js';
import {
  DBML_DIAGRAM_PROPERTIES,
  DBML_RELATIONSHIPS_FILE_STEM,
  DBML_RICH_NOTE_PROPERTIES,
  DBML_RICH_STICKY_COLOURS,
} from '../dbmlRichProperties.js';
import { dbmlName, dbmlNoteText, dbmlString } from '../dbmlText.js';
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
import { DBML_CONVERT_FIRST_MESSAGE, usePathBetween, useLinesOf } from './writeRelationships.js';

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
  /** The relationships files (relative to the semantic dir) the diagram imports. */
  relationshipsFiles: readonly string[];
  annotations?: readonly Annotation[];
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

/** The Project keys after the Note, in the order a new diagram writes them. */
const PROJECT_KEYS = [
  DBML_DIAGRAM_PROPERTIES.schemaVersion,
  DBML_DIAGRAM_PROPERTIES.modelFolder,
  DBML_DIAGRAM_PROPERTIES.showFkEdges,
  DBML_DIAGRAM_PROPERTIES.layoutOptions,
  DBML_DIAGRAM_PROPERTIES.stubColumns,
] as const;

/** The Project values a diagram object holds (§2.5), as the text each key is written with; undefined = not written. */
function projectValues(obj: Json): Record<string, string | undefined> {
  const view = isObject(obj.viewConfig) ? obj.viewConfig : {};
  const description = typeof obj.description === 'string' ? dbmlNoteText(obj.description) : '';
  return {
    note: description === '' ? undefined : description,
    [DBML_DIAGRAM_PROPERTIES.schemaVersion]: String(DBML_SCHEMA_VERSION),
    [DBML_DIAGRAM_PROPERTIES.modelFolder]: typeof obj.modelFolder === 'string' ? obj.modelFolder : undefined,
    [DBML_DIAGRAM_PROPERTIES.showFkEdges]: typeof view.showFkEdges === 'boolean' ? String(view.showFkEdges) : undefined,
    [DBML_DIAGRAM_PROPERTIES.layoutOptions]: isObject(view.layoutOptions) ? JSON.stringify(view.layoutOptions) : undefined,
    [DBML_DIAGRAM_PROPERTIES.stubColumns]: Array.isArray(obj.stubColumns) ? JSON.stringify(obj.stubColumns) : undefined,
  };
}

function projectLines(domain: string, values: Record<string, string | undefined>): string[] {
  const lines = [`Project ${dbmlName(domain)} {`];
  if (values.note !== undefined) lines.push(`  Note: ${dbmlString(values.note)}`);
  for (const key of PROJECT_KEYS) {
    const value = values[key];
    if (value !== undefined) lines.push(`  ${key}: ${dbmlString(value)}`);
  }
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

function tableUseLine(reference: string, fromFile: string, toFile: string): string {
  return `use { table ${reference} } from '${usePathBetween(fromFile, toFile)}'`;
}

/**
 * A new diagram file (§2.5, in order): the Project (its Note, then
 * `erd_schema_version` and every other key that is set), one table `use`
 * line per member in list order, one `use *` per relationships file sorted
 * by path, then one `Note` block per sticky note.
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
  });
  const out: string[] = [...projectLines(input.domain, values)];
  const uses = input.members.map((m) => tableUseLine(m.reference ?? dbmlName(m.name), input.filePath, m.path));
  const relationships = [...new Set(input.relationshipsFiles.map(normalisePosix))]
    .map((path) => usePathBetween(input.filePath, path))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => `use * from '${path}'`);
  if (uses.length + relationships.length > 0) out.push('', ...uses, ...relationships);
  for (const annotation of input.annotations ?? []) out.push('', noteBlock(annotation, '\n'));
  return `${out.join('\n')}\n`;
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

/**
 * Edit a diagram so it reads as `edit.after` (§4.5), splicing only what
 * changed from `edit.before`. Laws 1–5 hold; a no-op edit returns the text
 * unchanged, and a leading byte-order mark is kept.
 *
 * Throws {@link DbmlEditRefused} for a file that does not read, one with a
 * repeated Note name or a second Project, relationships in `after` (they
 * live in the table library), a change of layer or schema version or of
 * anything a DBML diagram does not store, and a new member that is not a
 * DBML table (D20).
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
    reading = parseSubjectAreaDbml(text, file, null, parser);
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
  if (Array.isArray(afterLogical.relationships) && afterLogical.relationships.length > 0) {
    refuse(file, `${file} is a DBML diagram, which holds no relationships: they live in the table library, in the relationships file of the foreign-key table's folder.`);
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

  const ast = compileOne(text, parser).ast;
  const nodes = topLevel(ast);
  const edits: TextEdit[] = [];
  const lateEdits: TextEdit[] = [];
  const plans: ListPlan[] = [];
  let firstUseDone = false;

  // --- Project ---------------------------------------------------------------------
  const project = nodes.find((n) => lower(elementType(n) ?? '') === 'project');
  const domainBefore = typeof before.domain === 'string' ? before.domain : '';
  const domainAfter = typeof after.domain === 'string' ? after.domain : domainBefore;
  const valuesBefore = projectValues(before);
  const valuesAfter = projectValues(after);
  const projectChanged = domainBefore !== domainAfter || Object.keys(valuesAfter).some((k) => valuesAfter[k] !== valuesBefore[k]);
  if (projectChanged) {
    if (!project) {
      const at = headerEnd(text);
      const block = projectLines(domainAfter, valuesAfter).join(eol);
      const following = text.slice(at).trim() !== '';
      // After a header comment the blank line that ends it stays below the block; at the top, one is added.
      edits.push({ start: at, end: at, text: `${at > 0 && text[at - 1] !== '\n' ? eol : ''}${block}${eol}${following && at === 0 ? eol : ''}` });
    } else {
      if (domainBefore !== domainAfter) {
        if (project.name) edits.push({ start: project.name.start, end: project.name.end, text: dbmlName(domainAfter) });
        else edits.push({ start: project.type.end, end: project.type.end, text: ` ${dbmlName(domainAfter)}` });
      }
      const body: AstNode[] = Array.isArray(project.body?.body) ? project.body.body : [];
      const entryOf = (key: string): AstNode | undefined => body.find((n) => lower(String(n?.type?.value ?? '')) === key);
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
        } else {
          const at = closeAlone ? closeAt : close.start;
          edits.push({ start: at, end: at, text: `${closeAlone ? '' : eol}${line}${eol}` });
        }
      }
    }
  }

  // --- Table use lines -----------------------------------------------------------------
  const uses = useLinesOf(ast, text, file);
  const memberUses = uses.filter((u) => lower(u.stem) !== DBML_RELATIONSHIPS_FILE_STEM && isSafeTableName(u.stem));
  const relUses = uses.filter((u) => lower(u.stem) === DBML_RELATIONSHIPS_FILE_STEM);
  const oldMembers = modelsOf(before);
  const newMembers = modelsOf(after);
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
  const changing = !deepEqual(before, after) || edit.refreshRelationshipsUses === true || pathChanged.size > 0;
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
  // `before` must be what the text reads as: members are paired with their use lines by position.
  if (memberUses.length !== oldMembers.length
    || reading.members.length !== oldMembers.length
    || reading.members.some((m, i) => lower(m) !== lower(oldMembers[i]))) {
    refuse(file, `ERD Studio could not line up the use lines of ${file} with its members (the diagram changed since it was read); reload it and try again.`);
  }
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
      lateEdits.push(firstUseInsert(`${line}${eol}`));
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
      lateEdits.push(firstUseInsert(`${line}${eol}`));
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
    const at = text.length;
    const lead = text === '' ? '' : text.endsWith('\n') ? eol : `${eol}${eol}`;
    lateEdits.push({ start: at, end: at, text: `${lead}${appended.join(`${eol}${eol}`)}${eol}` });
  }

  const out = applyTextEdits(text, [...edits, ...lateEdits]);
  return hadBom ? `﻿${out}` : out;

  /** The first `use` line of a diagram that has none: after the Project (one blank line between), else after the header. */
  function firstUseInsert(line: string): TextEdit {
    const at = afterUses();
    if (at >= 0) return { start: at, end: at, text: `${text[at - 1] === '\n' ? '' : eol}${line}` };
    const first = !firstUseDone;
    firstUseDone = true;
    const projectNode = nodes.find((n) => lower(elementType(n) ?? '') === 'project');
    if (projectNode) {
      const end = Math.max(projectNode.fullEnd, projectNode.end);
      return { start: end, end, text: first ? `${text[end - 1] === '\n' ? '' : eol}${eol}${line}` : line };
    }
    if (!first) {
      const start = headerEnd(text);
      return { start, end: start, text: line };
    }
    const start = headerEnd(text);
    const following = text.slice(start).trim() !== '';
    return { start, end: start, text: `${line}${following && start === 0 ? eol : ''}` };
  }
}
