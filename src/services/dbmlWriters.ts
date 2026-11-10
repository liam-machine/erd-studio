/**
 * ERD Studio's DBML writers as the host uses them: core's splicers
 * (`@erd-studio/core/dbml`), with the formatter applied where it keeps a
 * file's layout rather than replacing it. The canonical layout (`formatDbml`:
 * aligned columns, long settings lists one per line, two-space indents, one
 * blank line at most) is what ERD Studio writes a new file in, and a file
 * already in it stays in it. A file laid out any other way (by hand, or by an
 * older version) keeps its layout: an edit changes only the spans the splice
 * wrote (#275; the reference doc's promise that formatting survives an edit).
 *
 * Every host module that writes DBML imports the writers from here, never
 * from core (`test/unit/dbmlWriters.test.ts` holds that), so no write path
 * can skip the rule. Three rules:
 *
 * - **A no-op stays a no-op.** An edit whose splice leaves the text as it was
 *   returns it unchanged, unformatted: a file is never rewritten just because
 *   an edit looked at it. Callers keep detecting no-op writes by comparing the
 *   result with the text they passed in.
 * - **Canonical in, canonical out; anything else is spliced.** An edit of a
 *   file the formatter would leave as it is gets formatted, so a name that
 *   becomes its group's longest re-pads that group and the file stays
 *   aligned. An edit of any other file is the splice alone: no line it did
 *   not touch is re-aligned. Format Document tidies such a file on request.
 * - **Never the layout-only path.** A canvas move rewrites the diagram's
 *   `erd_layout` value and nothing else ({@link editDiagramLayoutDbml},
 *   passed through unformatted), so a drag changes one span of the file and
 *   undoes as that one change.
 *
 * When the formatter refuses (a syntax error, or its own self-check — it
 * should never happen for text the splicers wrote), the unformatted text is
 * written and the reason logged at `info`.
 *
 * No `vscode`: Convert, `doctor`'s preview of it and the settle pass bundle
 * this into the CLI.
 */

import {
  editDiagramLayoutDbml as spliceLayout,
  editRelationshipsDbml as spliceRelationships,
  editSubjectAreaDbml as spliceSubjectArea,
  editTableDbml as spliceTable,
  formatDbml,
  renderNewSubjectAreaDbml as renderSubjectArea,
  renderNewTableDbml as renderTable,
} from '@erd-studio/core/dbml';
import type { DiagramLayoutEdit, EditTableDbmlOptions, NewSubjectAreaDbml, RelationshipsFileEdit, SubjectAreaDbmlEdit } from '@erd-studio/core/dbml';
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

/** Whether `text` is already in the canonical layout (the formatter reads it and would change nothing). */
function isCanonical(text: string): boolean {
  const result = formatDbml(text);
  return !result.skipped && result.text === text;
}

/**
 * The edit's result: a new file formatted; an edit of a file that was in the
 * canonical layout formatted, so it stays in it; any other edit (a hand-laid
 * file, or a no-op) exactly as spliced.
 */
function finish(oldText: string | null, out: string, file: string): string {
  if (oldText === null) return formatWrittenDbml(out, file);
  if (out === oldText || !isCanonical(oldText)) return out;
  return formatWrittenDbml(out, file);
}

/** A new table file (core's `renderNewTableDbml`), formatted. */
export function renderNewTableDbml(table: SemanticTable): string {
  return formatWrittenDbml(renderTable(table), `${table.name}.dbml`);
}

/** An edit of a table file (core's `editTableDbml`), kept canonical when it was ({@link finish}). */
export function editTableDbml(oldText: string, desired: SemanticTable, options: EditTableDbmlOptions = {}): string {
  return finish(oldText, spliceTable(oldText, desired, options), options.file ?? `${options.fileStem ?? desired.name}.dbml`);
}

/** A new relationships file (formatted) or an edit of one ({@link finish}): core's `editRelationshipsDbml`. */
export function editRelationshipsDbml(oldText: string | null, edit: RelationshipsFileEdit): string {
  return finish(oldText, spliceRelationships(oldText, edit), edit.filePath);
}

/** A new diagram file (core's `renderNewSubjectAreaDbml`), formatted. */
export function renderNewSubjectAreaDbml(input: NewSubjectAreaDbml): string {
  return formatWrittenDbml(renderSubjectArea(input), input.filePath);
}

/** An edit of a diagram file (core's `editSubjectAreaDbml`), kept canonical when it was ({@link finish}). */
export function editSubjectAreaDbml(oldText: string, edit: SubjectAreaDbmlEdit): string {
  return finish(oldText, spliceSubjectArea(oldText, edit), edit.filePath);
}

/**
 * A layout-only edit of a diagram (core's `editDiagramLayoutDbml`): only the
 * `erd_layout` value changes. Deliberately NOT formatted, so a drag never
 * re-lays the rest of a hand-written file and its undo is that one span.
 */
export function editDiagramLayoutDbml(oldText: string, edit: DiagramLayoutEdit): string {
  return spliceLayout(oldText, edit);
}
