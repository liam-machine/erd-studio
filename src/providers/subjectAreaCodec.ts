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
 *   `render` is refused until the editor pipeline writes DBML (S5).
 *
 * `parse` throws core's `SubjectAreaFileError` / `SubjectAreaValidationError`
 * (and {@link NotASubjectAreaObject}); the provider words them for the user.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';

import {
  detectSubjectAreaFormat,
  layoutFilePathOf,
  normaliseSubjectAreaDocument,
  parseSubjectAreaJson,
  subjectAreaStorageOf,
  toTableNamingDocument,
} from '@erd-studio/core';
import { parseSubjectAreaDbml } from '@erd-studio/core/dbml';

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

/** Turns one kind of diagram file into a {@link ParsedSubjectArea} and back. */
export interface SubjectAreaCodec {
  readonly storage: 'json' | 'dbml';
  parse(text: string, filePath: string, layoutText?: string | null): ParsedSubjectArea;
  /** The writes that store `p`; the FIRST is always the primary file's replace, even when its text is unchanged. */
  render(p: ParsedSubjectArea, text: string, filePath: string): FileWrite[];
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

/** The message a DBML diagram edit gets until the editor pipeline writes DBML (S5). */
export const DBML_DIAGRAM_EDITING_NOT_AVAILABLE = 'Editing DBML diagrams is not available yet in this build of ERD Studio.';

/** Thrown by the DBML codec's `render` until DBML diagrams are written (S5). */
export class DbmlDiagramEditingNotAvailable extends Error {
  constructor() {
    super(DBML_DIAGRAM_EDITING_NOT_AVAILABLE);
    this.name = 'DbmlDiagramEditingNotAvailable';
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
    const reading = parseSubjectAreaDbml(text, filePath, layout);
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
  render() {
    throw new DbmlDiagramEditingNotAvailable();
  },
  tableNames: subjectAreaTableNames,
};

/** The codec for a diagram file, by its extension (`.dbml` → DBML, anything else → JSON). */
export function codecFor(filePath: string): SubjectAreaCodec {
  return subjectAreaStorageOf(filePath) === 'dbml' ? dbmlCodec : jsonCodec;
}
