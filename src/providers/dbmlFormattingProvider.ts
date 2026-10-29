/**
 * Format Document (⇧⌥F) for `.dbml` files: core's `formatDbml`, the same
 * formatter every ERD Studio DBML write ends with (`src/services/dbmlWriters.ts`),
 * so a file tidied by hand reads exactly as one ERD Studio wrote.
 *
 * The formatter changes white space only (it re-checks its own output and
 * gives the text back unchanged when anything else would change). The
 * provider answers with the smallest set of whole-line edits that turns the
 * document into the formatted text, never one replace of the whole file, so
 * the cursor, the selection and Undo stay where they belong.
 *
 * A file with syntax errors is left as it is: no edits, a status-bar message
 * saying how many errors to fix, and an `info` line in the ERD Studio log.
 *
 * It answers with no edits while ERD Studio itself is saving the document
 * (`isErdStudioSaving`): with `editor.formatOnSave` on, VS Code would run it
 * on ERD Studio's own saves too, and a layout-only move's undo anchor or a
 * flushed Undo must leave a `.dbml`'s bytes as they are. ERD Studio's writes
 * are already formatted; the user's own saves still format.
 *
 * Registered in `activate()` before the no-project early return: a `.dbml`
 * file opened anywhere (a single file, a folder with no ERD Studio project)
 * formats the same.
 */

import * as vscode from 'vscode';
import { formatDbml } from '@erd-studio/core/dbml';

import { createLogger } from '../services/logger';
import { isErdStudioSaving } from './documentSave';

const log = createLogger('dbml');

/** The language id `package.json` contributes for `.dbml` files. */
export const DBML_LANGUAGE_ID = 'dbml';

/** How long the "fix the errors first" message stays in the status bar. */
export const DBML_FORMAT_STATUS_MS = 5000;

/** One edit of the minimal diff: replace `[start, end)` of the old text with `text`. */
export interface LineEdit {
  start: number;
  end: number;
  text: string;
}

/** `text` cut into lines, each keeping its own line break (the last may have none). */
function linesOf(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf('\n', at);
    const end = nl < 0 ? text.length : nl + 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

/**
 * The smallest set of whole-line edits (Myers' O((N+M)·D) diff over lines)
 * that turns `before` into `after`, as offsets into `before`. Unchanged lines
 * are never touched; a run of changed lines is one edit. Linear when the two
 * texts share most of their lines; when the diff would be large (more than
 * `maxEdits` differing lines, which bounds the memory at about 16 MB) the
 * changed middle is one edit, still leaving the common first and last lines
 * alone.
 */
export function minimalLineEdits(before: string, after: string, maxEdits = 2000): LineEdit[] {
  if (before === after) return [];
  const a = linesOf(before);
  const b = linesOf(after);
  // Common first and last lines.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const offsets: number[] = [0];
  for (const line of a) offsets.push(offsets[offsets.length - 1] + line.length);
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const whole = (): LineEdit[] => [{ start: offsets[head], end: offsets[head + A.length], text: B.join('') }];
  if (A.length === 0 || B.length === 0) return whole();

  // Myers: the furthest-reaching path for each diagonal, per number of differences. Each round keeps
  // only the diagonals it can reach (2d + 3 entries), so memory grows with D², not with D·(N + M).
  const n = A.length;
  const m = B.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  /** The furthest x on diagonal k before round d (as recorded). */
  const at = (d: number, k: number): number => trace[d][d + 1 + k];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  if (!found) return whole();

  // Walk back: matched lines split the changed runs.
  const keep: Array<[number, number]> = []; // matched (x, y) pairs, last first
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const k = x - y;
    const prevK = k === -d || (k !== d && at(d, k - 1) < at(d, k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; keep.push([x, y]); }
    if (d === 0) break;
    x = prevX;
    y = prevY;
  }
  keep.reverse();
  const edits: LineEdit[] = [];
  let ax = 0;
  let by = 0;
  const flush = (toX: number, toY: number): void => {
    if (toX > ax || toY > by) {
      edits.push({ start: offsets[head + ax], end: offsets[head + toX], text: B.slice(by, toY).join('') });
    }
  };
  for (const [kx, ky] of keep) {
    flush(kx, ky);
    ax = kx + 1;
    by = ky + 1;
  }
  flush(n, m);
  return edits;
}

/** The status-bar line for a file the formatter would not touch because of syntax errors. */
export function parseErrorsMessage(count: number): string {
  return count === 1
    ? 'ERD Studio: this DBML file has 1 error — fix it, then format again'
    : `ERD Studio: this DBML file has ${count} errors — fix them, then format again`;
}

/** Format Document for `.dbml` files. */
export class DbmlFormattingProvider implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token?: vscode.CancellationToken,
  ): vscode.TextEdit[] {
    // Format on save during ERD Studio's own save: its writes are formatted already, and a move or an Undo keeps the bytes.
    if (isErdStudioSaving(document.uri)) return [];
    const text = document.getText();
    const result = formatDbml(text);
    const name = document.uri.scheme === 'file' ? vscode.workspace.asRelativePath?.(document.uri, false) ?? document.uri.fsPath : document.uri.toString();
    if (result.skipped === 'parse-errors') {
      const count = result.errors?.length ?? 0;
      const first = result.errors?.[0];
      log.info(`Format Document left ${name} as it is: ${count} syntax error${count === 1 ? '' : 's'}${first ? ` (first: line ${first.line}: ${first.message})` : ''}.`);
      vscode.window.setStatusBarMessage(parseErrorsMessage(count), DBML_FORMAT_STATUS_MS);
      return [];
    }
    if (result.skipped) {
      log.info(`Format Document left ${name} as it is: the formatter's self-check failed${result.detail ? ` (${result.detail})` : ''}.`);
      vscode.window.setStatusBarMessage('ERD Studio: this DBML file could not be formatted safely, so nothing was changed', DBML_FORMAT_STATUS_MS);
      return [];
    }
    if (!result.changed || token?.isCancellationRequested) return [];
    return minimalLineEdits(text, result.text).map((e) => vscode.TextEdit.replace(
      new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)),
      e.text,
    ));
  }
}

/** Register Format Document for every `.dbml` document, in any folder or none. */
export function registerDbmlFormatting(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(
    { language: DBML_LANGUAGE_ID },
    new DbmlFormattingProvider(),
  ));
}
