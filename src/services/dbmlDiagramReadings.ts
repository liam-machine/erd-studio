/**
 * The last few DBML diagram readings, so one open compiles its diagram once.
 *
 * Opening a canvas reads the diagram (`SubjectAreaService.getSubjectArea`),
 * then asks the same file whether it holds its own tables, surveys its
 * relationships for telemetry, and — when tables need positions — parses it
 * again to save them. Core keeps a small cache of compiles, but reading a
 * large diagram's tables pushes the diagram out of it, so each of those
 * compiled the diagram afresh (twice each: as written and with its `use`
 * lines blanked). Keyed by the diagram's text and the three parts of its path
 * a reading depends on — its layer, its `diagrams/` folder (the base its
 * `use` paths resolve against) and its stem (the name when the Project has
 * none): `<layer>/diagrams/<name>` — so the canvas, which names the file
 * project-relative in its messages, and the domain service, which names it
 * absolute, share one reading; a changed file is always read again. A
 * failure is never remembered: it is thrown again, naming the caller's path.
 * Each caller gets its own copy: the reading's object is edited in place by
 * the edit pipeline.
 *
 * A drag rewrites only the diagram's `erd_layout`: {@link primeLayoutOnlyReading}
 * remembers the reading of the text it wrote, derived from the one before
 * it, so the next drag (or the refresh after it) compiles nothing.
 *
 * No `vscode`: the CLI bundles the domain service.
 */

import { DBML_TWIN_SCHEMA_VERSION, erdLayoutOf, erdLayoutView, withMemberRefs } from '@erd-studio/core';
import type { Annotation, NodePosition, TableRefCandidate } from '@erd-studio/core';
import { parseSubjectAreaDbml } from '@erd-studio/core/dbml';

type DbmlSubjectAreaReading = ReturnType<typeof parseSubjectAreaDbml>;

const MEMO_SIZE = 4;
const memo = new Map<string, DbmlSubjectAreaReading>();

/**
 * What of `filePath` a successful reading depends on, as core's reader
 * splits it (`diagramPathOf`): the last three segments — the layer, the
 * `diagrams` folder and the file name without `.dbml` (the fallback domain
 * name) — with either separator.
 */
export function readingPathKey(filePath: string): string {
  const segments = filePath.split(/[\\/]/).filter((s) => s !== '');
  const file = segments[segments.length - 1] ?? '';
  const stem = file.toLowerCase().endsWith('.dbml') ? file.slice(0, -'.dbml'.length) : file;
  const folders = segments.slice(Math.max(0, segments.length - 3), -1);
  while (folders.length < 2) folders.unshift('');
  return `${folders.join('/')}/${stem}`;
}

const keyOf = (text: string, filePath: string): string => `${readingPathKey(filePath)}\u0000${text}`;

function remember(key: string, reading: DbmlSubjectAreaReading): void {
  memo.delete(key);
  memo.set(key, structuredClone(reading));
  if (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value as string);
}

/** `parseSubjectAreaDbml(text, filePath)`, answered from the last few readings when nothing changed. Throws as it does. */
export function readDbmlDiagram(text: string, filePath: string): DbmlSubjectAreaReading {
  const key = keyOf(text, filePath);
  const hit = memo.get(key);
  if (hit) {
    memo.delete(key);
    memo.set(key, hit);
    return structuredClone(hit);
  }
  const reading = parseSubjectAreaDbml(text, filePath);
  remember(key, reading);
  return reading;
}

/** The members of a remembered reading of `text` (use lines, then `erd_unlinked_tables`), or undefined: never reads. */
export function rememberedDbmlMembers(text: string, filePath: string): string[] | undefined {
  const hit = memo.get(keyOf(text, filePath));
  return hit ? [...hit.members] : undefined;
}

/**
 * The members of `reading` as text names them (index for index with
 * `reading.members`: its `use` members, then `erd_unlinked_tables`), each with
 * the schema folder of its file and the qualifier its `use` line writes, as
 * the diagram reader matches `erd_layout` lines with them.
 */
function memberTablesOf(reading: DbmlSubjectAreaReading): TableRefCandidate[] {
  return [
    ...(reading.uses ?? []).map((u) => ({ schema: u.schema ?? '', name: u.name, ref: u.ref ?? u.name, ...(u.qualifier !== undefined ? { qualifiers: [u.qualifier] } : {}) })),
    ...(reading.unlinked ?? []).map((name) => ({ schema: '', name, ref: name })),
  ];
}

/**
 * After a layout-only write (a drag: `oldText` → `newText`, only
 * `erd_layout` changed): remember `newText`'s reading without compiling it,
 * from `oldText`'s remembered one with the positions and sticky-note boxes
 * `parsedAfter` (the object the drag wrote) holds as the file now does —
 * what `erd_layout` keeps of them (rounded, each member's line under its
 * reference, as the layout writer spells them), mapped back as the reader
 * maps it (with each member's schema folder and qualifier, so a
 * `<schema>.<name>` line lands on its own table), and the lines it recorded
 * after `erd_layout` moved as the value's line count changed. So the
 * remembered reading is the one a fresh read of `newText` gives. Does
 * nothing when `oldText` has no reading remembered: the next read compiles
 * as usual.
 */
export function primeLayoutOnlyReading(oldText: string, newText: string, filePath: string, parsedAfter: Record<string, unknown>): void {
  const before = memo.get(keyOf(oldText, filePath));
  if (!before) return;
  // A drag on a diagram holding two tables of one name (a member named `<schema>.<name>`) that is
  // not yet at erd_schema_version '8' also writes '8': not layout-only, so the next read compiles.
  if (before.schemaVersion < DBML_TWIN_SCHEMA_VERSION && (before.uses ?? []).some((u) => u.ref !== undefined && u.ref !== u.name)) return;
  const reading = structuredClone(before);
  const tables = memberTablesOf(reading);
  const viewAfter = (parsedAfter.viewConfig ?? {}) as { positions?: Record<string, NodePosition>; annotations?: Annotation[] };
  const layout = withMemberRefs(erdLayoutOf(viewAfter.positions, viewAfter.annotations), tables);
  const view = reading.obj.viewConfig as { positions?: Record<string, NodePosition>; annotations?: Annotation[] };
  const annotations = Array.isArray(view.annotations) ? view.annotations : [];
  const shown = erdLayoutView(layout, reading.members, annotations.map((a) => a.id), tables);
  if (shown.sharedBare) reading.layoutSharedBare = shown.sharedBare; else delete reading.layoutSharedBare;
  view.positions = shown.positions;
  for (const annotation of annotations) {
    const box = shown.boxes[annotation.id];
    if (!box) continue;
    annotation.x = box.x;
    annotation.y = box.y;
    if (box.width !== undefined) annotation.width = box.width; else delete annotation.width;
    if (box.height !== undefined) annotation.height = box.height; else delete annotation.height;
  }
  // The write rewrote the value: only a repeated key is still there (the writer edits the first).
  const gone = new Set((reading.layoutProblems ?? []).filter((p) => p.code !== 'layoutDuplicateKey'));
  if (gone.size > 0) {
    const messages = new Set([...gone].map((p) => (p.line !== undefined ? `Line ${p.line}: ${p.message}` : p.message)));
    // `warningCodes` stays index for index with `warnings`.
    const keptWarnings = reading.warnings.map((w, i) => ({ w, code: reading.warningCodes?.[i] })).filter(({ w }) => !messages.has(w));
    reading.warnings = keptWarnings.map(({ w }) => w);
    if (reading.warningCodes) reading.warningCodes = keptWarnings.map(({ code }) => code ?? 'other');
    const kept = (reading.layoutProblems ?? []).filter((p) => !gone.has(p));
    if (kept.length > 0) reading.layoutProblems = kept; else delete reading.layoutProblems;
  }
  delete reading.layoutConflictLine;
  // Lines after the rewritten value move by the lines it gained or lost (a Project first: every use line and Note).
  const shift = lineShift(oldText, newText);
  for (const use of reading.uses ?? []) use.line = shift(use.line);
  for (const entry of reading.pending ?? []) entry.line = shift(entry.line);
  for (const problem of reading.layoutProblems ?? []) if (problem.line !== undefined) problem.line = shift(problem.line);
  reading.warnings = reading.warnings.map((w) => w.replace(/^Line (\d+):/, (_m, n: string) => `Line ${shift(Number(n))}:`));
  remember(keyOf(newText, filePath), reading);
}

/**
 * Maps a 1-based line of `oldText` to `newText`'s: a line after the region
 * the two differ in moves by the change in line count; one before it stays.
 */
function lineShift(oldText: string, newText: string): (line: number) => number {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const firstAfter = a.length - suffix + 1;
  const delta = b.length - a.length;
  return (line) => (line >= firstAfter ? line + delta : line);
}

/** Forget every reading (tests). */
export function clearDbmlDiagramReadings(): void {
  memo.clear();
}
