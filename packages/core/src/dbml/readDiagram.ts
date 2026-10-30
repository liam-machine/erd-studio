/**
 * Read a `.dbml` diagram (§2.5 of the native DBML storage spec) into the v5
 * subject-area object the rest of core reads, beside its DBML schema version
 * (D8). Tolerant (D6): every `use` line, every `Table`, `Ref`, `TableGroup`,
 * `Enum`, `TablePartial`, `Records`, `DiagramView` and `Metadata` block,
 * every repeated Note name and every Project after the first is blanked out
 * (offsets and line breaks kept) before the rest is compiled on its own, so a
 * deleted table file or a hand-written construct never makes a diagram
 * unreadable. Only a syntax error, or an error left after blanking, does.
 */

import type { Annotation, AnnotationColor, NodePosition, Relationship } from '../types/semantic.js';
import { CURRENT_SCHEMA_VERSION, DBML_SCHEMA_VERSION, WRITTEN_SCHEMA_VERSION } from '../types/semantic.js';
import type { DbmlMemberUse, DbmlSubjectAreaReading } from '../types/dbmlStorage.js';
import {
  DBML_DIAGRAM_QUOTE_HINT_CODES,
  SubjectAreaFileError,
  SubjectAreaValidationError,
} from '../domain.js';
import {
  DBML_DIAGRAM_PROPERTIES,
  DBML_RELATIONSHIPS_FILE_STEM,
  DBML_RICH_NOTE_PROPERTIES,
  parseUnlinkedTables,
  stickyColourOfHex,
} from '../dbmlRichProperties.js';
import { nextCompositeKey } from '../relationships.js';
import { readPendingRefs } from './readRelationships.js';
import type { DbmlProblem } from '../types/dbmlStorage.js';
import { placeUnlaidNotes, readDbdiagramLayout } from '../dbdiagramLayout.js';
import { findConflictMarkers } from '../mergeConflict.js';
import { isSafeTableName } from '../logicalModel.js';
import { TABLES_DIR } from '../logicalModel.js';
import { dbmlTreePathOf, diagramPathOf, isLibraryFolderName, normalisePosix, resolvePosix } from '../storage.js';
import type { DbmlParserModule } from './parserModule.js';
import {
  PINNED_PARSER,
  blankSpans,
  compileOne,
  elementType,
  isUseDeclaration,
  lineAt,
  parseSyntax,
  plainNames,
  propertyText,
  stripBom,
  topLevel,
  type AstNode,
  type CompiledFile,
  type ParserDiagnostic,
} from './parser.js';

/** Elements a diagram may declare but ERD Studio never reads from it: blanked, warned about and kept. */
const DECLARED_ELEMENTS: ReadonlySet<string> = new Set(['table', 'ref', 'tablegroup', 'enum', 'tablepartial', 'records', 'diagramview']);

/**
 * `Metadata Table t { … }` / `Metadata Column t.c { … }` (DBML 9.1+, D25):
 * valid in a diagram when other DBML tools read the project, but its target
 * is an imported table, which is blanked with the `use` lines, so it would
 * be a binding error. Blanked, warned about and kept, like the elements
 * above; ERD Studio reads table properties from the table file only.
 */
const METADATA_ELEMENT = 'metadata';

/** The diagram-quote hint: the example is an error in every parser (Project keys must be quoted). */
const DIAGRAM_QUOTE_HINT = "Quote the value, as in erd_schema_version: '7'.";

/** Split a diagram path into its parent folder name and its stem, either separator. */
function pathParts(filePath: string): { folder: string; stem: string } {
  const segments = filePath.split(/[\\/]/).filter((s) => s !== '');
  const file = segments[segments.length - 1] ?? '';
  const stem = file.toLowerCase().endsWith('.dbml') ? file.slice(0, -'.dbml'.length) : file;
  return { folder: segments.length >= 2 ? segments[segments.length - 2] : '', stem };
}

/** The stem of a `use` path: its last segment without `.dbml` (the extension is optional in DBML). */
function useStem(importPath: string): string {
  const segments = importPath.split('/').filter((s) => s !== '');
  const file = segments[segments.length - 1] ?? '';
  return file.toLowerCase().endsWith('.dbml') ? file.slice(0, -'.dbml'.length) : file;
}

/** `path` with `.dbml` added when the `use` line left it out. */
function withExtension(path: string): string {
  return path.toLowerCase().endsWith('.dbml') ? path : `${path}.dbml`;
}

/**
 * The library folder a resolved `use` path names (`tables/gold/x.dbml` →
 * `gold`, `tables/x.dbml` → `''`), or undefined when it does not point into
 * the library by the §2.1 shape.
 */
function libraryFolderOf(resolved: string): string | undefined {
  const segments = normalisePosix(resolved).split('/');
  if (segments[0] === TABLES_DIR && segments.length === 2) return '';
  if (segments[0] === TABLES_DIR && segments.length === 3 && isLibraryFolderName(segments[1])) return segments[1];
  return undefined;
}

/** The table names a selective `use { table x }` line names (unqualified), or [] for `use *`. */
function specifiedTables(node: AstNode): string[] {
  const list = node.specifiers;
  if (!list || list.kind === '<wildcard>' || !Array.isArray(list.specifiers)) return [];
  const names: string[] = [];
  for (const specifier of list.specifiers as AstNode[]) {
    if (String(specifier?.importKind?.value ?? '').toLowerCase() !== 'table') continue;
    const parts = plainNames(specifier.name);
    if (parts && parts.length > 0) names.push(parts[parts.length - 1]);
  }
  return names;
}

function invalidDbml(filePath: string, d: ParserDiagnostic): SubjectAreaFileError {
  const hint = DBML_DIAGRAM_QUOTE_HINT_CODES.has(String(d.code)) ? ` ${DIAGRAM_QUOTE_HINT}` : '';
  return new SubjectAreaFileError(
    'invalid-dbml',
    filePath,
    `Invalid DBML in subject area file ${filePath} at line ${d.line}, column ${d.column}: ${d.message} [${d.code}].${hint}`,
    { line: d.line, column: d.column },
  );
}

function compile(text: string, parser: DbmlParserModule, filePath: string): CompiledFile {
  try {
    return compileOne(text, parser, undefined, { diagram: true });
  } catch (err) {
    throw new SubjectAreaFileError(
      'invalid-dbml',
      filePath,
      `Invalid DBML in subject area file ${filePath}: the DBML parser stopped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** A Project or Note custom value as text (Project keys are plain strings in every parser; Notes may be typed in 11.0). */
function textOf(value: unknown, text: string): string | undefined {
  return propertyText(value, text)?.text;
}

/** The parsed JSON of a Project key, or undefined with a warning when it is not what the key holds. */
function jsonValue<T>(raw: string | undefined, key: string, check: (v: unknown) => v is T, warnings: string[]): T | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (check(value)) return value;
  } catch {
    // fall through
  }
  warnings.push(`The Project's ${key} is not valid JSON of the right shape; it is ignored`);
  return undefined;
}

const isStringRecord = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === 'string');
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Read a DBML diagram. `filePath` names it in messages, and its parent
 * folder is the diagram's layer; `layoutText` is its `.dbdiagram` file, or
 * null when there is none.
 *
 * Throws `SubjectAreaFileError` (`empty`; `invalid-dbml`, transient unless
 * the file holds git conflict markers) and `SubjectAreaValidationError` (a
 * schema version that is not a whole number, or newer than this core
 * reads). `parser` is the pinned DBML parser unless a test passes another.
 */
export function parseSubjectAreaDbml(
  rawText: string,
  filePath: string,
  layoutText: string | null,
  parser: DbmlParserModule = PINNED_PARSER,
): DbmlSubjectAreaReading {
  const text = stripBom(rawText);
  if (text.trim() === '') {
    throw new SubjectAreaFileError('empty', filePath, `Subject area file is empty: ${filePath}`);
  }
  const first = compile(text, parser, filePath);
  if (first.errors.length > 0) {
    const conflict = findConflictMarkers(text);
    if (conflict !== null) {
      throw new SubjectAreaFileError(
        'invalid-dbml',
        filePath,
        `Subject area file ${filePath} has unresolved git merge conflicts (first at line ${conflict}). `
          + 'Resolve them in the file — if only the layout conflicts, either side is safe to keep.',
        { mergeConflict: true, line: conflict },
      );
    }
  }
  const syntax = first.errors.filter((d) => d.errorClass === 'syntax').sort((a, b) => a.start - b.start);
  if (syntax.length > 0) throw invalidDbml(filePath, syntax[0]);

  const { folder: layer, stem } = pathParts(filePath);
  const warnings: string[] = [];
  const blanks: Array<{ start: number; end: number }> = [];
  const members: string[] = [];
  const uses: DbmlMemberUse[] = [];
  const useFolders = new Set<string>();
  const noteNames = new Set<string>();
  let writable = true;
  let projects = 0;
  let declaredTables = 0;

  for (const node of topLevel(first.ast)) {
    const line = lineAt(text, node.start);
    if (isUseDeclaration(node)) {
      blanks.push({ start: node.start, end: node.end });
      const importPath = typeof node.importPath?.value === 'string' ? node.importPath.value as string : '';
      const name = useStem(importPath);
      if (name.toLowerCase() === DBML_RELATIONSHIPS_FILE_STEM) continue; // a relationships file: output only (D4)
      if (!isSafeTableName(name)) {
        warnings.push(`Line ${line}: the use line for '${importPath}' does not name a table ERD Studio can read; it is ignored`);
        continue;
      }
      const resolved = resolvePosix(layer, withExtension(importPath));
      const folder = libraryFolderOf(resolved);
      if (folder !== undefined) useFolders.add(folder);
      const specified = specifiedTables(node);
      // DBML names are case-sensitive, but a table file may declare its name
      // in another case than its stem (D2), and the specifier spells the
      // declared name: only a different name is a mismatch. A path whose case
      // differs from the file on disk needs a listing (host, doctor; §3.4).
      const misnamed = specified.find((n) => n.toLowerCase() !== name.toLowerCase());
      if (folder === undefined) {
        warnings.push(`Line ${line}: the use line for ${name} points at '${importPath}', not at a table file in ${TABLES_DIR}/ (usePathMismatch); the table is still read by name`);
      } else if (misnamed !== undefined) {
        warnings.push(`Line ${line}: the use line imports table ${misnamed} from '${importPath}', whose file is named ${name} (usePathMismatch); the table is read by its file name`);
      }
      members.push(name);
      uses.push({ name, path: importPath, resolved, line });
      continue;
    }
    const type = elementType(node);
    const lower = type?.toLowerCase();
    if (lower !== undefined && DECLARED_ELEMENTS.has(lower)) {
      blanks.push({ start: node.start, end: node.end });
      if (lower === 'table') declaredTables++;
      warnings.push(`Line ${line}: a ${type} is declared in the diagram file; ERD Studio shows only tables from the library through use lines, and keeps it as written`);
      continue;
    }
    if (lower === METADATA_ELEMENT) {
      blanks.push({ start: node.start, end: node.end });
      warnings.push(`Line ${line}: a Metadata block is declared in the diagram file; ERD Studio reads table properties only from the table file, and keeps it as written`);
      continue;
    }
    if (lower === 'project') {
      projects++;
      if (projects > 1) {
        blanks.push({ start: node.start, end: node.end });
        writable = false;
        warnings.push(`Line ${line}: the diagram has a second Project; the first is read, and ERD Studio will not edit the file until there is one`);
      }
      continue;
    }
    if (lower === 'note') {
      const parts = plainNames(node.name);
      const key = parts && parts.length > 0 ? parts.join('.').toLowerCase() : undefined;
      if (key !== undefined && noteNames.has(key)) {
        blanks.push({ start: node.start, end: node.end });
        writable = false;
        warnings.push(`Line ${line}: the Note name ${parts!.join('.')} is used twice; the first is read, and ERD Studio will not edit the file until each Note has its own name`);
        continue;
      }
      if (key !== undefined) noteNames.add(key);
    }
  }

  const compiled = blanks.length > 0 ? compile(blankSpans(text, blanks), parser, filePath) : first;
  const remaining = [...compiled.errors].sort((a, b) => a.start - b.start);
  const fatal = remaining.find((d) => d.errorClass !== 'binding');
  if (fatal) throw invalidDbml(filePath, fatal);
  for (const d of remaining) {
    warnings.push(`Line ${d.line}: ${d.message} [${d.code}]`);
  }
  const db = remaining.length === 0 ? compiled.rawDb() : undefined;
  if (remaining.length > 0 && !db) {
    // Binding errors leave no rawDb, so there is nothing to read. Every
    // construct that names a table (D25's Metadata blocks included) is
    // blanked above, so only one ERD Studio does not know can cause it.
    throw invalidDbml(filePath, remaining[0]);
  }

  // The Project: name, Note and ERD Studio's keys (plain strings in every parser).
  const project = (db?.project && typeof db.project === 'object' ? db.project : {}) as AstNode;
  const projectText = (key: string): string | undefined => textOf(project[key], text);
  const domain = typeof project.name === 'string' && project.name !== '' ? project.name : stem;
  const description = typeof project.note?.value === 'string' ? project.note.value as string : typeof project.note === 'string' ? project.note as string : '';

  const rawVersion = projectText(DBML_DIAGRAM_PROPERTIES.schemaVersion);
  let schemaVersion = DBML_SCHEMA_VERSION;
  if (rawVersion !== undefined) {
    const trimmed = rawVersion.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new SubjectAreaValidationError(
        `${filePath} has erd_schema_version '${rawVersion}', which is not a whole number`,
      );
    }
    schemaVersion = Number(trimmed);
  }
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new SubjectAreaValidationError(
      `${filePath} has erd_schema_version ${schemaVersion} but this extension only supports up to version ${CURRENT_SCHEMA_VERSION}. Please update the extension.`,
    );
  }

  const viewConfig: Record<string, unknown> = {};
  const showFkEdges = projectText(DBML_DIAGRAM_PROPERTIES.showFkEdges);
  if (showFkEdges !== undefined) {
    const value = showFkEdges.trim().toLowerCase();
    if (value === 'true' || value === 'false') viewConfig.showFkEdges = value === 'true';
    else warnings.push(`The Project's ${DBML_DIAGRAM_PROPERTIES.showFkEdges} is '${showFkEdges}', not 'true' or 'false'; it is ignored`);
  }
  const layoutOptions = jsonValue(projectText(DBML_DIAGRAM_PROPERTIES.layoutOptions), DBML_DIAGRAM_PROPERTIES.layoutOptions, isStringRecord, warnings);
  if (layoutOptions) viewConfig.layoutOptions = layoutOptions;
  const stubColumns = jsonValue(projectText(DBML_DIAGRAM_PROPERTIES.stubColumns), DBML_DIAGRAM_PROPERTIES.stubColumns, isStringArray, warnings);
  const modelFolder = projectText(DBML_DIAGRAM_PROPERTIES.modelFolder);

  // Members with no table file to `use` (D26): read by name, after the `use` members. Read from the AST,
  // as subjectAreaMembersDbml reads it (trees, commands, the CLI), so every reader lists the same members.
  const unlinkedEntry = projectEntry(first.ast, text, DBML_DIAGRAM_PROPERTIES.unlinkedTables);
  if (unlinkedEntry.count > 1) {
    warnings.push(`The Project names ${DBML_DIAGRAM_PROPERTIES.unlinkedTables} ${unlinkedEntry.count} times; only the last is read. Keep one`);
  }
  const unlinked = unlinkedMembers(unlinkedEntry.value, members, warnings);
  members.push(...unlinked);

  // Pending relationships (D27): the diagram's own, owned by a table with no table file.
  const pendingProblems: DbmlProblem[] = [];
  const pendingRefs = readPendingRefs(text, parser, pendingProblems, topLevel(first.ast));
  for (const problem of pendingProblems) warnings.push(problem.message);
  const pending = pendingRefs.map((ref) => ({ line: ref.line, relationships: ref.relationships }));
  const ownRelationships = pendingRelationships(pending.map((p) => p.relationships));

  // The layout file: table positions and sticky-note boxes.
  const positions: Record<string, NodePosition> = {};
  let stickies: ReturnType<typeof readDbdiagramLayout>['stickies'] = [];
  if (layoutText !== null && layoutText !== undefined) {
    const layout = readDbdiagramLayout(layoutText);
    for (const problem of layout.problems) warnings.push(`Layout file: ${problem}`);
    const seen = new Set<string>();
    for (const p of layout.tables) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      positions[p.name] = { x: p.x, y: p.y };
    }
    stickies = layout.stickies;
  }
  viewConfig.positions = positions;

  // Notes: sticky notes, in file order.
  const notes = Array.isArray(db?.notes) ? (db!.notes as AstNode[]) : [];
  if (notes.length > 0) {
    const ids = notes.map((n) => (typeof n?.name === 'string' ? n.name : ''));
    const placed = placeUnlaidNotes(ids.filter((id) => id !== ''), positions, stickies);
    const byName = new Map(stickies.map((s) => [s.name, s]));
    const annotations: Annotation[] = [];
    for (const note of notes) {
      const id = typeof note?.name === 'string' ? note.name : '';
      if (id === '') continue;
      const laid = byName.get(id);
      const place = laid ?? placed[id] ?? { x: 0, y: 0 };
      const annotation: Annotation = {
        id,
        text: typeof note.content === 'string' ? note.content : '',
        x: place.x,
        y: place.y,
      };
      const colour: AnnotationColor | undefined = typeof note.color === 'string'
        ? stickyColourOfHex(note.color)
        : typeof note.headerColor === 'string' ? stickyColourOfHex(note.headerColor) : undefined;
      if (colour) annotation.color = colour;
      if (laid?.width !== undefined) annotation.width = laid.width;
      if (laid?.height !== undefined) annotation.height = laid.height;
      const linked = textOf(note.metadata?.[DBML_RICH_NOTE_PROPERTIES.linkedTable], text);
      if (linked !== undefined && linked !== '') annotation.linkedModel = linked;
      annotations.push(annotation);
    }
    if (annotations.length > 0) viewConfig.annotations = annotations;
  }

  const obj: Record<string, unknown> = {
    schemaVersion: WRITTEN_SCHEMA_VERSION,
    domain,
    layer,
    description,
    ...(modelFolder !== undefined ? { modelFolder } : {}),
    logical: { models: [...members], relationships: ownRelationships },
    viewConfig,
    ...(stubColumns !== undefined ? { stubColumns } : {}),
  };
  const holdsOwnTables = declaredTables > 0 && uses.length === 0;
  if (holdsOwnTables) {
    warnings.push('The diagram declares its own Tables and imports none from the library: it looks like a single-file DBML to import (ERD Studio: Import DBML)');
  }
  return {
    obj,
    schemaVersion,
    members,
    useFolders: [...useFolders].sort((a, b) => a.localeCompare(b)),
    writable,
    warnings,
    uses,
    holdsOwnTables,
    ...(unlinked.length > 0 ? { unlinked } : {}),
    ...(pending.length > 0 ? { pending } : {}),
  };
}

/**
 * The names an `erd_unlinked_tables` value lists (D26), in order: each one
 * that passes `isSafeTableName` and is not already a member (a `use` line, or
 * an earlier entry, compared without case), with a warning for the rest.
 */
function unlinkedMembers(value: string | undefined, members: readonly string[], warnings: string[]): string[] {
  if (value === undefined) return [];
  const seen = new Set(members.map((m) => m.toLowerCase()));
  const out: string[] = [];
  for (const name of parseUnlinkedTables(value)) {
    if (!isSafeTableName(name)) {
      warnings.push(`The Project's ${DBML_DIAGRAM_PROPERTIES.unlinkedTables} names '${name}', which is not a table name ERD Studio can read; it is ignored`);
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      warnings.push(`The Project's ${DBML_DIAGRAM_PROPERTIES.unlinkedTables} names ${name}, which the diagram already lists; it is shown once`);
      continue;
    }
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** Pending Refs as a diagram's own relationships: a Ref of several column pairs is one composite (`nextCompositeKey`, per owner, in file order). */
function pendingRelationships(refs: ReadonlyArray<readonly Relationship[]>): Relationship[] {
  const out: Relationship[] = [];
  const byOwner = new Map<string, Relationship[]>();
  for (const rels of refs) {
    if (rels.length === 0) continue;
    const owner = rels[0].fromModel.toLowerCase();
    const list = byOwner.get(owner) ?? [];
    byOwner.set(owner, list);
    if (rels.length === 1) {
      list.push(rels[0]);
      out.push({ ...rels[0] });
      continue;
    }
    const compositeKey = nextCompositeKey(list, rels[0].toModel);
    for (const rel of rels) {
      const entry = { ...rel, compositeKey };
      list.push(entry);
      out.push(entry);
    }
  }
  return out;
}

/**
 * A diagram's members from its `use` lines, from the AST alone (no compile
 * of the rest): the stem of every table `use` path, in order. Null when the
 * text has a syntax error.
 */
export function subjectAreaMembersDbml(rawText: string, parser: DbmlParserModule = PINNED_PARSER): string[] | null {
  const text = stripBom(rawText);
  let compiled: CompiledFile;
  try {
    compiled = compileOne(text, parser, undefined, { diagram: true });
  } catch {
    return null;
  }
  if (compiled.errors.some((d) => d.errorClass === 'syntax')) return null;
  return diagramMembersFromAst(compiled.ast, text);
}

/**
 * {@link subjectAreaMembersDbml} from a diagram already parsed (`ast` of
 * `text`, without its byte-order mark): the table `use` stems, then
 * `erd_unlinked_tables`. The `erd_layout` writer spells lines by them.
 */
export function diagramMembersFromAst(ast: AstNode, text: string): string[] {
  const members: string[] = [];
  for (const node of topLevel(ast)) {
    if (!isUseDeclaration(node)) continue;
    const importPath = typeof node.importPath?.value === 'string' ? node.importPath.value as string : '';
    const name = useStem(importPath);
    if (name.toLowerCase() === DBML_RELATIONSHIPS_FILE_STEM || !isSafeTableName(name)) continue;
    members.push(name);
  }
  const unlinked = projectEntry(ast, text, DBML_DIAGRAM_PROPERTIES.unlinkedTables).value;
  members.push(...unlinkedMembers(unlinked, members, []));
  return members;
}

/** What {@link diagramSummaryDbml} reads from a diagram of the layer-first tree. */
export interface DbmlDiagramSummary {
  /** The `use` members, in file order: each named by its file stem. */
  members: string[];
  /** The `use` line of each member, in the same order. */
  memberUses: DbmlMemberUse[];
  /** The relationships files the diagram imports (`use *`), resolved, without repeats, in file order. */
  relationshipsUses: string[];
  /** Every other `use *` line's path (a relationships file in a subfolder, `../../shared/enums.dbml`, …), resolved, in file order. */
  otherUses: string[];
  /** The `erd_unlinked_tables` members (D26), after the `use` members. */
  unlinked: string[];
}

/**
 * A layer-first diagram's imports, from a lex and parse alone (no binding,
 * no compile of the rest): for the settle rule, which must know whether a
 * diagram needs rewriting before it pays for a full read. Each `use` path is
 * resolved against the diagram's folder (`L/diagrams`) and classified by
 * its shape ({@link dbmlTreePathOf}):
 *
 * - a selective `use { table … }` line or a `use *` line whose path is a
 *   table file is a member, named by the file stem;
 * - a `use *` line whose path is a relationships file is one of
 *   `relationshipsUses`;
 * - a selective `use { table … }` line whose path is anything else is still
 *   a member when its stem is a safe table name (D4 tolerance);
 * - any other `use *` line is one of `otherUses`: never a member, never a
 *   relationships import;
 * - any other line is ignored.
 *
 * Null when the text has a syntax error, or when `filePath` (absolute or
 * relative, either separator) is not a diagram's (`diagramPathOf`).
 */
export function diagramSummaryDbml(rawText: string, filePath: string, parser: DbmlParserModule = PINNED_PARSER): DbmlDiagramSummary | null {
  const where = diagramPathOf(filePath);
  if (where === undefined) return null;
  const text = stripBom(rawText);
  let ast: AstNode;
  try {
    const parsed = parseSyntax(text, parser);
    if (parsed.errors.length > 0) return null;
    ast = parsed.ast;
  } catch {
    return null;
  }
  const members: string[] = [];
  const memberUses: DbmlMemberUse[] = [];
  const relationshipsUses: string[] = [];
  const otherUses: string[] = [];
  for (const node of topLevel(ast)) {
    if (!isUseDeclaration(node)) continue;
    const importPath = typeof node.importPath?.value === 'string' ? node.importPath.value as string : '';
    const resolved = resolvePosix(where.dir, withExtension(importPath));
    const shape = dbmlTreePathOf(resolved);
    const wildcard = isWildcardUse(node);
    const selective = !wildcard && specifiedTables(node).length > 0;
    let member: string | undefined;
    if (shape?.kind === 'table' && (wildcard || selective)) member = shape.name;
    else if (selective && isSafeTableName(useStem(importPath))) member = useStem(importPath);
    if (member !== undefined) {
      members.push(member);
      memberUses.push({ name: member, path: importPath, resolved, line: lineAt(text, node.start) });
    } else if (wildcard && shape?.kind === 'relationships') {
      if (!relationshipsUses.includes(resolved)) relationshipsUses.push(resolved);
    } else if (wildcard) {
      otherUses.push(resolved);
    }
  }
  const unlinked = unlinkedMembers(projectEntry(ast, text, DBML_DIAGRAM_PROPERTIES.unlinkedTables).value, members, []);
  return { members, memberUses, relationshipsUses, otherUses, unlinked };
}

/** Whether a `use` line imports everything (`use * from …`). */
function isWildcardUse(node: AstNode): boolean {
  return node.specifiers?.kind === '<wildcard>';
}

/**
 * A Project key's string value from the AST alone (no compile of the rest):
 * the first Project's LAST entry of the key (any case), as the parser's own
 * database reads a repeated key, its single-, triple- or double-quoted
 * string unescaped; and how many entries the key has. `value` is undefined
 * when there is no such entry or it is not a string.
 */
function projectEntry(ast: AstNode, text: string, key: string): { value: string | undefined; count: number } {
  const project = topLevel(ast).find((n) => elementType(n)?.toLowerCase() === 'project');
  const body: AstNode[] = Array.isArray(project?.body?.body) ? project!.body.body : [];
  const entries = body.filter((n) => String(n?.type?.value ?? '').toLowerCase() === key);
  const value = entries[entries.length - 1]?.body;
  if (!value || typeof value.start !== 'number' || typeof value.end !== 'number') return { value: undefined, count: entries.length };
  const source = text.slice(value.start, value.end).trim();
  const quoted = /^'''([^]*)'''$/.exec(source) ?? /^'([^]*)'$/.exec(source) ?? /^"([^]*)"$/.exec(source);
  if (!quoted) return { value: undefined, count: entries.length };
  return { value: quoted[1].replace(/\\(.)/g, '$1'), count: entries.length };
}
