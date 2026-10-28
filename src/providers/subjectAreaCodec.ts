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
 *   (with its `.dbdiagram` layout) into a plain v5 object (`schemaVersion`
 *   5, D8), so every `detectSubjectAreaFormat` call site sees `v5`. Its
 *   `render` splices the diagram (`editSubjectAreaDbml`) against the library
 *   as an edit leaves it (a {@link SubjectAreaResolver}) and writes the
 *   layout file only when a position or sticky-note box changed.
 *
 * `parse` throws core's `SubjectAreaFileError` / `SubjectAreaValidationError`
 * (and {@link NotASubjectAreaObject}); the provider words them for the user.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  detectSubjectAreaFormat,
  editDiagramLayout,
  layoutFilePathOf,
  stickyLayoutsOf,
  normaliseSubjectAreaDocument,
  parseSubjectAreaJson,
  subjectAreaStorageOf,
  toTableNamingDocument,
} from '@erd-studio/core';
import { editSubjectAreaDbml } from '@erd-studio/core/dbml';
import { readDbmlDiagram } from '../services/dbmlDiagramReadings';
import type { DbmlDiagramTable } from '@erd-studio/core/dbml';
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
  /** DBML only: the layout file beside the diagram, and its text when it exists. */
  layoutPath?: string;
  layoutText?: string | null;
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
}

/** Turns one kind of diagram file into a {@link ParsedSubjectArea} and back. */
export interface SubjectAreaCodec {
  readonly storage: 'json' | 'dbml';
  parse(text: string, filePath: string, layoutText?: string | null): ParsedSubjectArea;
  /**
   * The writes that store `p` (absolute paths); the FIRST is always the
   * primary file's replace, even when its text is unchanged. A DBML diagram
   * needs `resolver`; the JSON codec ignores it.
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

/** The layout text for `diagramPath`: an open document's (unsaved edits included), else the file on disk, else null. */
export function readLayoutText(diagramPath: string): string | null {
  const layoutPath = layoutFilePathOf(diagramPath);
  const open = vscode.workspace.textDocuments?.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === layoutPath);
  if (open) return open.getText();
  try {
    return fs.readFileSync(layoutPath, 'utf-8');
  } catch {
    return null;
  }
}

const dbmlCodec: SubjectAreaCodec = {
  storage: 'dbml',
  parse(text, filePath, layoutText) {
    const layout = layoutText === undefined ? readLayoutText(filePath) : layoutText;
    const reading = readDbmlDiagram(text, filePath, layout ?? null);
    return {
      storage: 'dbml',
      parsed: reading.obj,
      snapshot: structuredClone(reading.obj),
      dbmlSchemaVersion: reading.schemaVersion,
      writable: reading.writable,
      ...(reading.holdsOwnTables ? { holdsOwnTables: true } : {}),
      layoutPath: layoutFilePathOf(filePath),
      layoutText: layout,
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
    });
    const writes: FileWrite[] = [{ kind: 'replace', path: filePath, text: primary }];
    const layout = layoutWrite(p, filePath);
    if (layout) writes.push(layout);
    return writes;
  },
  tableNames: subjectAreaTableNames,
};

/** A diagram object's positions and sticky-note boxes: what its layout file holds. */
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
 * sticky-note boxes (position and size). Such an edit writes a DBML
 * diagram's `.dbdiagram` alone — never the `.dbml`, nothing in the table
 * library — and changes nothing the sidebar shows, for either storage. An
 * edit that changed nothing at all is not one (it keeps the general path).
 */
export function isLayoutOnlyChange(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return !sameJson(before, after) && sameJson(withoutLayout(before), withoutLayout(after));
}

/**
 * The layout file's write for an edit, or null: written only when a position
 * or a sticky-note box changed, so an edit that moved nothing leaves the
 * layout file's bytes alone (D7), even where the reader placed a note the
 * file does not place yet.
 */
export function layoutWrite(p: ParsedSubjectArea, filePath: string): FileWrite | null {
  const before = layoutOf(p.snapshot);
  const after = layoutOf(p.parsed);
  const same = JSON.stringify(sortedPositions(before.positions)) === JSON.stringify(sortedPositions(after.positions))
    && JSON.stringify(stickyLayoutsOf(before.annotations)) === JSON.stringify(stickyLayoutsOf(after.annotations));
  if (same) return null;
  const layoutPath = p.layoutPath ?? layoutFilePathOf(filePath);
  const oldText = p.layoutText ?? null;
  const next = editDiagramLayout(oldText, after.positions, stickyLayoutsOf(after.annotations));
  if (next === null) return null;
  return oldText === null ? { kind: 'create', path: layoutPath, text: next } : { kind: 'replace', path: layoutPath, text: next };
}

function sortedPositions(positions: Record<string, NodePosition>): Array<[string, number, number]> {
  return Object.entries(positions)
    .filter(([, v]) => !!v && typeof v === 'object')
    .map(([k, v]): [string, number, number] => [k, Number(v.x), Number(v.y)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The codec for a diagram file, by its extension (`.dbml` → DBML, anything else → JSON). */
export function codecFor(filePath: string): SubjectAreaCodec {
  return subjectAreaStorageOf(filePath) === 'dbml' ? dbmlCodec : jsonCodec;
}
