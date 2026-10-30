/**
 * The subject-area codec (native DBML storage, §5.2): how the editor turns a
 * diagram file's text into the v5 object every handler mutates, and back
 * into file writes. Two codecs, chosen by the file's extension
 * ({@link codecFor}):
 *
 * - **JSON** — `parseSubjectAreaJson` plus the v6 normalisation (#182),
 *   rendered back in the file's own naming and line endings. Today's
 *   behaviour, moved behind the interface unchanged.
 * - **DBML** — core's `parseSubjectAreaDbml`, which reads a `.dbml` diagram
 *   (positions from its Project's `erd_layout`) into a plain v5 object
 *   (`schemaVersion` 5, D8), so every `detectSubjectAreaFormat` call site
 *   sees `v5`. Its `render` splices the diagram (`editSubjectAreaDbml`)
 *   against the library as an edit leaves it (a {@link SubjectAreaResolver});
 *   a drag rewrites `erd_layout` alone ({@link layoutOnlyText}).
 *
 * `parse` throws core's `SubjectAreaFileError` / `SubjectAreaValidationError`
 * (and {@link NotASubjectAreaObject}); the provider words them for the user.
 */

import * as path from 'path';

import {
  detectSubjectAreaFormat,
  normaliseSubjectAreaDocument,
  parseSubjectAreaJson,
  subjectAreaStorageOf,
  toTableNamingDocument,
} from '@erd-studio/core';
import { readDbmlDiagram } from '../services/dbmlDiagramReadings';
import { erdLayoutEntrySpan } from '@erd-studio/core/dbml';
import type { DbmlDiagramTable } from '@erd-studio/core/dbml';
import { editDiagramLayoutDbml, editSubjectAreaDbml } from '../services/dbmlWriters';
import type { Annotation, NodePosition } from '@erd-studio/core';

import { subjectAreaTableNames } from '../services/domainService';
import type { FileWrite } from '../services/fileWrites';
import { keepLineEndings } from '../services/lineEndings';

/** A diagram file, parsed for an edit. */
export interface ParsedSubjectArea {
  storage: 'json' | 'dbml';
  /** The v5 object handlers mutate (v6 keys normalised; a DBML diagram's §2.5 object, `schemaVersion` 5). */
  parsed: Record<string, unknown>;
  /** A deep copy of `parsed` as read, before any mutation. */
  snapshot: Record<string, unknown>;
  /** DBML only: `erd_schema_version`, never written back by an edit. */
  dbmlSchemaVersion?: number;
  /** DBML only: the reader's writable flag (false with a repeated Note name or a second Project). */
  writable?: boolean;
  /** DBML only: the file declares Tables and has no table `use` line (a dropped-in single-file DBML). */
  holdsOwnTables?: boolean;
}

/**
 * The library as an edit leaves it, for rendering a DBML diagram (§5.2):
 * tables resolved after the edit's table writes, the relationships files of
 * their folders, and which files exist. Paths are posix, relative to
 * `semanticRoot`.
 */
export interface SubjectAreaResolver {
  /** The semantic dir, absolute. */
  semanticRoot: string;
  resolveTable(name: string): DbmlDiagramTable | undefined;
  relationshipsFilesFor(names: readonly string[]): string[];
  fileExists(relPath: string): boolean;
  /** Tables whose file moved, was renamed or was deleted in this edit (lower-case). */
  pathChanged?: ReadonlySet<string>;
  /** Recompute the relationships `use` lines even when membership did not change (the settle pass). */
  refreshRelationshipsUses?: boolean;
  /** Leave a conflicted `erd_layout` as it is (§1.6): set when rendering a diagram that is not the one being edited. */
  keepLayoutIfConflicted?: boolean;
}

/** Turns one kind of diagram file into a {@link ParsedSubjectArea} and back. */
export interface SubjectAreaCodec {
  readonly storage: 'json' | 'dbml';
  parse(text: string, filePath: string): ParsedSubjectArea;
  /**
   * The writes that store `p` (absolute paths): the primary file's replace,
   * even when its text is unchanged. A DBML diagram needs `resolver`; the
   * JSON codec ignores it.
   */
  render(p: ParsedSubjectArea, text: string, filePath: string, resolver?: SubjectAreaResolver): FileWrite[];
  /** The tables the file names, from its raw text; null when it does not parse. */
  tableNames(text: string, filePath: string): string[] | null;
}

/** Thrown by the JSON codec for a file that parses but is not a JSON object. */
export class NotASubjectAreaObject extends Error {
  constructor(readonly filePath: string) {
    super(`Subject area file ${filePath} does not contain a JSON object.`);
    this.name = 'NotASubjectAreaObject';
  }
}


/**
 * The subject area documents the JSON codec read from a v6 file (#162):
 * held under the in-memory (v5) keys like every other, and written back in
 * the v6 naming by {@link serialiseSubjectArea} (#182).
 */
const tableNamingDocuments = new WeakSet<object>();

/** Remember that `parsed` was read from a v6 file, so it is written back in v6. */
export function markTableNamingDocument(parsed: object): void {
  tableNamingDocuments.add(parsed);
}

/** Whether `parsed` was read from a v6 file. */
export function isTableNamingDocument(parsed: object): boolean {
  return tableNamingDocuments.has(parsed);
}

/** A parsed subject area document as its file's text: v6 keys again for a v6 file (#182), else as it is. */
export function subjectAreaFileObject(parsed: Record<string, unknown>): Record<string, unknown> {
  return tableNamingDocuments.has(parsed) ? toTableNamingDocument(parsed) : parsed;
}

/** `parsed` re-rendered as its file's text, in the file's own naming and line endings. */
export function serialiseSubjectArea(parsed: Record<string, unknown>, original: string): string {
  return keepLineEndings(JSON.stringify(subjectAreaFileObject(parsed), null, 2) + '\n', original);
}

const jsonCodec: SubjectAreaCodec = {
  storage: 'json',
  parse(text, filePath) {
    const data = parseSubjectAreaJson(text, filePath);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new NotASubjectAreaObject(filePath);
    let parsed = data as Record<string, unknown>;
    // A v6 file (#162) is edited under the v5 keys, like every other, and
    // written back in its own naming (`serialiseSubjectArea`, #182).
    if (detectSubjectAreaFormat(parsed) === 'v6') {
      parsed = normaliseSubjectAreaDocument(parsed);
      tableNamingDocuments.add(parsed);
    }
    return { storage: 'json', parsed, snapshot: structuredClone(parsed) };
  },
  render(p, text, filePath) {
    return [{ kind: 'replace', path: filePath, text: serialiseSubjectArea(p.parsed, text) }];
  },
  tableNames: subjectAreaTableNames,
};

const dbmlCodec: SubjectAreaCodec = {
  storage: 'dbml',
  parse(text, filePath) {
    const reading = readDbmlDiagram(text, filePath);
    return {
      storage: 'dbml',
      parsed: reading.obj,
      snapshot: structuredClone(reading.obj),
      dbmlSchemaVersion: reading.schemaVersion,
      writable: reading.writable,
      ...(reading.holdsOwnTables ? { holdsOwnTables: true } : {}),
    };
  },
  render(p, text, filePath, resolver) {
    if (!resolver) throw new Error('A DBML diagram is rendered against the library: pass a resolver.');
    const rel = path.relative(resolver.semanticRoot, filePath).split(path.sep).join('/');
    const primary = editSubjectAreaDbml(text, {
      filePath: rel,
      before: p.snapshot,
      after: p.parsed,
      resolveTable: (name) => resolver.resolveTable(name),
      relationshipsFilesFor: (names) => resolver.relationshipsFilesFor(names),
      fileExists: (relPath) => resolver.fileExists(relPath),
      ...(resolver.pathChanged ? { pathChanged: resolver.pathChanged } : {}),
      ...(resolver.refreshRelationshipsUses ? { refreshRelationshipsUses: true } : {}),
      ...(resolver.keepLayoutIfConflicted ? { keepLayoutIfConflicted: true } : {}),
    });
    return [{ kind: 'replace', path: filePath, text: primary }];
  },
  tableNames: subjectAreaTableNames,
};

/** A diagram object's positions and sticky-note boxes: what its `erd_layout` holds. */
function layoutOf(obj: Record<string, unknown>): { positions: Record<string, NodePosition>; annotations: Annotation[] } {
  const view = obj.viewConfig && typeof obj.viewConfig === 'object' && !Array.isArray(obj.viewConfig)
    ? obj.viewConfig as Record<string, unknown>
    : {};
  const positions = view.positions && typeof view.positions === 'object' && !Array.isArray(view.positions)
    ? view.positions as Record<string, NodePosition>
    : {};
  const annotations = Array.isArray(view.annotations) ? view.annotations as Annotation[] : [];
  return { positions, annotations };
}

/** The annotation fields a layout file holds (a sticky note's box); everything else about a note is in the diagram. */
const ANNOTATION_LAYOUT_KEYS = new Set(['x', 'y', 'width', 'height']);

/** `obj` without what only a layout changes: `viewConfig.positions` and each note's box. An emptied viewConfig goes too. */
function withoutLayout(obj: Record<string, unknown>): Record<string, unknown> {
  const view = obj.viewConfig;
  if (!view || typeof view !== 'object' || Array.isArray(view)) return obj;
  const { positions: _positions, ...rest } = view as Record<string, unknown>;
  if (Array.isArray(rest.annotations)) {
    rest.annotations = (rest.annotations as unknown[]).map((a) => {
      if (!a || typeof a !== 'object' || Array.isArray(a)) return a;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a as Record<string, unknown>)) if (!ANNOTATION_LAYOUT_KEYS.has(k)) out[k] = v;
      return out;
    });
    if ((rest.annotations as unknown[]).length === 0) delete rest.annotations;
  }
  const { viewConfig: _viewConfig, ...top } = obj;
  return Object.keys(rest).length > 0 ? { ...top, viewConfig: rest } : top;
}

/** Structural equality of parsed JSON values (key order ignored; `undefined` members count as absent). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => sameJson(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) if (!sameJson(ao[k], bo[k])) return false;
  return true;
}

/**
 * Whether an edit changed the layout and nothing else: table positions and
 * sticky-note boxes (position and size). Such an edit rewrites a DBML
 * diagram's `erd_layout` alone ({@link layoutOnlyText}) — nothing else in
 * the `.dbml`, nothing in the table library — and changes nothing the
 * sidebar shows, for either storage. An edit that changed nothing at all is
 * not one (it keeps the general path).
 */
export function isLayoutOnlyChange(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return !sameJson(before, after) && sameJson(withoutLayout(before), withoutLayout(after));
}

/**
 * A DBML diagram's text after a layout-only edit (a drag, an auto layout, a
 * note moved or resized): `text` with its Project's `erd_layout` rewritten
 * to `p.parsed`'s positions and sticky-note boxes, every other byte kept,
 * never formatted. `text` itself when nothing it stores moved. Throws core's
 * `DbmlEditRefused` (a merge conflict in `erd_layout`, a text that does not
 * parse, a second Project).
 */
export function layoutOnlyText(p: ParsedSubjectArea, text: string, filePath: string, semanticRoot: string): string {
  const { positions, annotations } = layoutOf(p.parsed);
  const rel = path.relative(semanticRoot, filePath).split(path.sep).join('/');
  return editDiagramLayoutDbml(text, { filePath: rel, positions, annotations });
}

/**
 * Whether two texts of one DBML diagram differ only inside the first
 * `erd_layout` entry: an undo or redo that rewound a drag. False when they
 * are equal or either does not parse.
 */
export function sameOutsideErdLayout(x: string, y: string): boolean {
  if (x === y) return false;
  const a = erdLayoutEntrySpan(x);
  const b = erdLayoutEntrySpan(y);
  if (!a || !b) return false;
  return x.slice(0, a.start) + x.slice(a.end) === y.slice(0, b.start) + y.slice(b.end);
}

/** The codec for a diagram file, by its extension (`.dbml` → DBML, anything else → JSON). */
export function codecFor(filePath: string): SubjectAreaCodec {
  return subjectAreaStorageOf(filePath) === 'dbml' ? dbmlCodec : jsonCodec;
}
