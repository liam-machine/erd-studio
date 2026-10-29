/**
 * ERD Studio's DBML writers as the host uses them: core's splicers
 * (`@erd-studio/core/dbml`), each followed by the formatter, so every `.dbml`
 * ERD Studio writes is in the one canonical layout (`formatDbml`: aligned
 * columns, long settings lists one per line, two-space indents, one blank
 * line at most). Files written by hand or by an older version converge on it
 * the first time ERD Studio changes them.
 *
 * Every host module that writes DBML imports the writers from here, never
 * from core (`test/unit/dbmlWriters.test.ts` holds that), so no write path
 * can skip the formatter. Two rules:
 *
 * - **A no-op stays a no-op.** An edit whose splice leaves the text as it was
 *   returns it unchanged, unformatted: a file is never rewritten just because
 *   an edit looked at it. Callers keep detecting no-op writes by comparing the
 *   result with the text they passed in.
 * - **Never the layout-only path.** A canvas move writes the `.dbdiagram`
 *   (and a one-character undo anchor on the diagram that leaves its bytes as
 *   they are, `applyFileWrites`); neither goes through here.
 *
 * When the formatter refuses (a syntax error, or its own self-check — it
 * should never happen for text the splicers wrote), the unformatted text is
 * written and the reason logged at `info`.
 *
 * No `vscode`: Convert, `doctor`'s preview of it and the settle pass bundle
 * this into the CLI.
 */

import {
  editRelationshipsDbml as spliceRelationships,
  editSubjectAreaDbml as spliceSubjectArea,
  editTableDbml as spliceTable,
  formatDbml,
  renderNewSubjectAreaDbml as renderSubjectArea,
  renderNewTableDbml as renderTable,
} from '@erd-studio/core/dbml';
import type { EditTableDbmlOptions, NewSubjectAreaDbml, RelationshipsFileEdit, SubjectAreaDbmlEdit } from '@erd-studio/core/dbml';
import type { SemanticTable } from '@erd-studio/core';

import { createLogger } from './logger';

const log = createLogger('dbml');

/**
 * `text` in the canonical DBML layout. `file` names it in the log line when
 * the formatter declines; the text then comes back as it is.
 */
export function formatWrittenDbml(text: string, file: string): string {
  const result = formatDbml(text);
  if (result.skipped) {
    const why = result.skipped === 'parse-errors'
      ? `${result.errors?.length ?? 0} syntax error${result.errors?.length === 1 ? '' : 's'}${result.errors?.[0] ? ` (first: line ${result.errors[0].line}: ${result.errors[0].message})` : ''}`
      : `its self-check failed${result.detail ? ` (${result.detail})` : ''}`;
    log.info(`${file} was written without formatting: ${why}.`);
    return text;
  }
  return result.text;
}

/**
 * `text` in the canonical layout, or `undefined` when the formatter declines
 * it; logs nothing. For comparing a file ERD Studio reads but does not write
 * (Convert's clash check), where {@link formatWrittenDbml}'s "was written"
 * line would report a write that never happened.
 */
export function canonicalDbml(text: string): string | undefined {
  const result = formatDbml(text);
  return result.skipped ? undefined : result.text;
}

/** The edit's result, formatted unless it is the text it started from. */
function finish(oldText: string | null, out: string, file: string): string {
  return oldText !== null && out === oldText ? out : formatWrittenDbml(out, file);
}

/** A new table file (core's `renderNewTableDbml`), formatted. */
export function renderNewTableDbml(table: SemanticTable): string {
  return formatWrittenDbml(renderTable(table), `${table.name}.dbml`);
}

/** An edit of a table file (core's `editTableDbml`), formatted when it changed anything. */
export function editTableDbml(oldText: string, desired: SemanticTable, options: EditTableDbmlOptions = {}): string {
  return finish(oldText, spliceTable(oldText, desired, options), options.file ?? `${options.fileStem ?? desired.name}.dbml`);
}

/** A new or edited relationships file (core's `editRelationshipsDbml`), formatted when it changed anything. */
export function editRelationshipsDbml(oldText: string | null, edit: RelationshipsFileEdit): string {
  return finish(oldText, spliceRelationships(oldText, edit), edit.filePath);
}

/** A new diagram file (core's `renderNewSubjectAreaDbml`), formatted. */
export function renderNewSubjectAreaDbml(input: NewSubjectAreaDbml): string {
  return formatWrittenDbml(renderSubjectArea(input), input.filePath);
}

/** An edit of a diagram file (core's `editSubjectAreaDbml`), formatted when it changed anything. */
export function editSubjectAreaDbml(oldText: string, edit: SubjectAreaDbmlEdit): string {
  return finish(oldText, spliceSubjectArea(oldText, edit), edit.filePath);
}
