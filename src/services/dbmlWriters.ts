/**
 * ERD Studio's DBML writers as the host uses them: core's splicers
 * (`@erd-studio/core/dbml`), with the formatter applied where it keeps a
 * file's layout rather than replacing it. The canonical layout (`formatDbml`:
 * aligned columns, long settings lists one per line, two-space indents, one
 * blank line at most) is what ERD Studio writes a new file in. An edit of an
 * existing file changes only the lines the splice wrote (#275; the reference
 * doc's promise that formatting survives an edit); in a file already in the
 * canonical layout, those lines are written in it.
 *
 * Every host module that writes DBML imports the writers from here, never
 * from core (`test/unit/dbmlWriters.test.ts` holds that), so no write path
 * can skip the rule. Three rules:
 *
 * - **A no-op stays a no-op.** An edit whose splice leaves the text as it was
 *   returns it unchanged, unformatted: a file is never rewritten just because
 *   an edit looked at it. Callers keep detecting no-op writes by comparing the
 *   result with the text they passed in.
 * - **An edit changes only the lines it touches** (#275). No line the
 *   splice did not write is re-aligned, in any file. In a file already in
 *   the canonical layout the touched lines are formatted, so a new or renamed
 *   line lines up with its group where it fits the group's widths; a name
 *   that becomes its group's longest goes in with single spaces and does not
 *   re-pad the rest. A file laid out any other way gets the splice alone.
 *   Format Document re-aligns a whole file on request.
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
import { linesOf, minimalLineEdits } from './lineDiff';

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

/** `text` with runs of white space as one space and none at either end: a line as the formatter sees it. */
const squeezed = (line: string): string => line.replace(/\s+/g, ' ').trim();

/**
 * `out` (an edit of `oldText`, which is in the canonical layout) with only
 * the lines the edit touched in that layout: each touched line is the
 * formatter's version of it, every other line keeps its bytes. A touched
 * line therefore lines up with its group when it fits the group's widths,
 * and a line that is now its group's longest does not re-pad the rest
 * (#275). When the formatter would add or remove lines (a settings list
 * split one per line, say), the lines cannot be paired and `out` comes back
 * as spliced.
 */
function formatTouchedLines(oldText: string, out: string, file: string): string {
  const formatted = linesOf(formatWrittenDbml(out, file));
  const lines = linesOf(out);
  if (formatted.length !== lines.length) return out;
  const oldLineAt = new Map<number, number>();
  let offset = 0;
  linesOf(oldText).forEach((line, i) => { oldLineAt.set(offset, i); offset += line.length; });
  oldLineAt.set(offset, oldLineAt.size);
  const touched = new Set<number>();
  let shift = 0;
  for (const edit of minimalLineEdits(oldText, out)) {
    const first = oldLineAt.get(edit.start);
    const end = oldLineAt.get(edit.end);
    if (first === undefined || end === undefined) return out;
    const written = linesOf(edit.text).length;
    for (let i = 0; i < written; i++) touched.add(first + shift + i);
    shift += written - (end - first);
  }
  // Every untouched line must read the same in both (only its spacing may differ), or the pairing is off.
  for (let i = 0; i < lines.length; i++) {
    if (!touched.has(i) && squeezed(formatted[i]) !== squeezed(lines[i])) return out;
  }
  return lines.map((line, i) => (touched.has(i) ? formatted[i] : line)).join('');
}

/**
 * The edit's result. A new file is formatted. An edit changes only the lines
 * it touches, in every file: a no-op comes back as it was, a hand-laid file's
 * edit exactly as spliced, and in a file that was in the canonical layout
 * the touched lines take that layout ({@link formatTouchedLines}) while no
 * other line is re-padded.
 */
function finish(oldText: string | null, out: string, file: string): string {
  if (oldText === null) return formatWrittenDbml(out, file);
  if (out === oldText || !isCanonical(oldText)) return out;
  return formatTouchedLines(oldText, out, file);
}

/** A new table file (core's `renderNewTableDbml`), formatted. */
export function renderNewTableDbml(table: SemanticTable): string {
  return formatWrittenDbml(renderTable(table), `${table.name}.dbml`);
}

/** An edit of a table file (core's `editTableDbml`): only the lines it touches change ({@link finish}). */
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

/** An edit of a diagram file (core's `editSubjectAreaDbml`): only the lines it touches change ({@link finish}). */
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
