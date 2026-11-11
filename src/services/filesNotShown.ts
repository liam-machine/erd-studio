/**
 * The canvas's "not shown" notes for one diagram: what its files hold that
 * the canvas is not drawing (`src/types/filesNotShown.ts`).
 *
 * This arranges findings; it detects nothing itself. Every note comes from
 * the reader that already decided the thing is not drawn, the same one
 * `doctor` reports from (`src/cli/dbmlProblems.ts`), so the canvas and
 * `doctor` cannot disagree about which file and line hold it:
 *
 * - a relationships file the diagram should import: the diagram reader's
 *   import drift (`SubjectAreaService.relationshipsImportDrift`, the one
 *   import rule; `doctor`'s `missingRelationshipsUse`);
 * - a `Ref`, inline `[ref: …]` or `use` line in a table file: core's table
 *   reader (`parseTableDbml`'s problems, the codes below);
 * - a relationships file that does not read: core's relationships reader
 *   (`readRelationshipsDbml`, `readable: false`);
 * - a `.dbml` where no file is read: core's classifier (`classifySemanticFile`)
 *   and `doctor`'s own hint (`outsideKnownFoldersHint`).
 *
 * The words are the canvas's own: short sentences that name the file (the
 * strip lists several, each with a link to its line). `doctor` keeps its
 * longer, terminal wording for the same findings.
 *
 * `doctor` stays the full audit of a project (it compiles every file, which
 * takes seconds on a large library); this is the part of it that answers "why
 * is what I just wrote not on the canvas?", from readings the canvas has
 * already made. Pure and free of `vscode`: it never reads a file and never
 * writes.
 */

import type { DbmlProblem, DbmlRelationshipsReading } from '@erd-studio/core';

import type { FileNote } from '../types/filesNotShown';
import { outsideKnownFoldersNote } from './unreadDbmlFile';

/** The table reader's codes for something written in a table file that is never drawn from there. */
export const NOT_DRAWN_IN_TABLE_FILE_CODES: ReadonlySet<string> = new Set(['refInTableFile', 'inlineRefInTableFile', 'useInTableFile']);

export interface FilesNotShownInput {
  /**
   * The relationships files (relative to the semantic dir) holding a
   * relationship between two of the diagram's tables that it does not import.
   */
  readonly importDrift: readonly string[];
  /** The diagram can be edited from the canvas, so the note offers to add the import. */
  readonly canAddImports: boolean;
  /** Each of the diagram's DBML tables: its file (relative to the semantic dir) and its reader's problems. */
  readonly memberTables: ReadonlyArray<{ readonly file: string; readonly problems: readonly DbmlProblem[] }>;
  /** Every relationships file of the library (relative to the semantic dir) with its reading. */
  readonly relationshipsFiles: ReadonlyArray<{ readonly file: string; readonly reading: DbmlRelationshipsReading }>;
  /** `.dbml` files (relative to the semantic dir) saved this session where ERD Studio reads no file. */
  readonly unreadFiles: readonly string[];
  /** A path relative to the semantic dir, as the note names it: relative to the workspace folder. */
  readonly shown: (semanticRelative: string) => string;
}

/** A sentence's end, when the reader's text has none. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The note for a relationships file a diagram does not import (the canvas's
 * words; `doctor` gives the line to write). `file` is its path inside the
 * ERD Studio folder.
 */
export function relationshipsNotImportedMessage(file: string, canAddImports: boolean): string {
  return `This diagram does not import ${file}, so a relationship in it is not drawn.${canAddImports
    ? ''
    : ' Add a use * line for that file to the diagram file to draw it.'}`;
}

/** The note for a relationships file that does not read. */
export function relationshipsFileNotReadMessage(file: string, reading: DbmlRelationshipsReading): string {
  const first = reading.problems.find((p) => p.severity === 'error') ?? reading.problems[0];
  if (first?.mergeConflict) return `${file} has unresolved git merge conflicts, so none of its relationships are drawn. Keep one side of each.`;
  // The reader ends its message with what the lead already says ("No relationship is read …"): left out here.
  const why = first === undefined ? '' : first.message.replace(/\.?\s*No relationship is read from (it|the file) until[^]*$/, '').trim();
  return `${file} has a mistake, so none of its relationships are drawn.${why === '' ? '' : ` ${sentence(why)}`}`;
}

/** The note for a line in a table file that is never drawn from there, by the table reader's code. */
export function notDrawnInTableFileMessage(file: string, code: string): string {
  switch (code) {
    case 'useInTableFile':
      return `A use line in ${file} is not needed: a table file imports nothing. ERD Studio cannot edit this table until it is removed.`;
    case 'inlineRefInTableFile':
      return `A [ref: …] in ${file} is not drawn: relationships go in a relationships file. ERD Studio cannot edit this table until it is moved.`;
    default:
      return `A Ref in ${file} is not drawn: relationships go in a relationships file. ERD Studio cannot edit this table until it is moved.`;
  }
}

/**
 * Every note for one diagram, in the order the strip lists them: what stops
 * relationships being drawn first (the missing import, then a file that does
 * not read, then lines in a table file), then files that are not read at all.
 */
export function collectFilesNotShown(input: FilesNotShownInput): FileNote[] {
  const notes: FileNote[] = [];
  const seen = new Set<string>();
  const push = (note: FileNote): void => {
    const key = `${note.code}\u0001${note.file ?? ''}\u0001${note.line ?? ''}\u0001${note.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    notes.push(note);
  };

  for (const file of [...input.importDrift].sort()) {
    const shown = input.shown(file);
    push({
      code: 'relationshipsNotImported',
      message: relationshipsNotImportedMessage(file, input.canAddImports),
      file: shown,
      ...(input.canAddImports ? { action: 'addRelationshipsImports' as const } : {}),
    });
  }

  for (const { file, reading } of input.relationshipsFiles) {
    if (reading.readable) continue;
    const shown = input.shown(file);
    const first = reading.problems.find((p) => p.severity === 'error') ?? reading.problems[0];
    push({
      code: 'relationshipsFileNotRead',
      message: relationshipsFileNotReadMessage(file, reading),
      file: shown,
      ...(first?.line !== undefined ? { line: first.line } : {}),
    });
  }

  for (const { file, problems } of input.memberTables) {
    for (const problem of problems) {
      if (typeof problem.code !== 'string' || !NOT_DRAWN_IN_TABLE_FILE_CODES.has(problem.code)) continue;
      push({
        code: 'notDrawnInTableFile',
        message: notDrawnInTableFileMessage(file, problem.code),
        file: input.shown(file),
        ...(problem.line !== undefined ? { line: problem.line } : {}),
      });
    }
  }

  for (const file of [...input.unreadFiles].sort()) {
    push({ code: 'fileNotRead', message: outsideKnownFoldersNote(file), file: input.shown(file) });
  }
  return notes;
}
