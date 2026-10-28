/**
 * The last few DBML diagram readings, so one open compiles its diagram once.
 *
 * Opening a canvas reads the diagram (`SubjectAreaService.getSubjectArea`),
 * then asks the same file whether it holds its own tables, surveys its
 * relationships for telemetry, and — when tables need positions — parses it
 * again to save them. Core keeps a small cache of compiles, but reading a
 * large diagram's tables pushes the diagram out of it, so each of those
 * compiled the diagram afresh (twice each: as written and with its `use`
 * lines blanked). Keyed by the diagram's text, its layout text and the two
 * parts of its path a reading depends on — its folder (the layer) and its
 * stem (the name when the Project has none) — so the canvas, which names
 * the file project-relative in its messages, and the domain service, which
 * names it absolute, share one reading; a changed file is always read
 * again. A failure is never remembered: it is thrown again, naming the
 * caller's path. Each caller gets its own copy: the reading's object is
 * edited in place by the edit pipeline.
 *
 * No `vscode`: the CLI bundles the domain service.
 */

import { parseSubjectAreaDbml } from '@erd-studio/core/dbml';

type DbmlSubjectAreaReading = ReturnType<typeof parseSubjectAreaDbml>;

const MEMO_SIZE = 4;
const memo = new Map<string, DbmlSubjectAreaReading>();

/**
 * What of `filePath` a successful reading depends on, as core's reader
 * splits it: the parent folder (the layer) and the file name without
 * `.dbml` (the fallback domain name), with either separator.
 */
export function readingPathKey(filePath: string): string {
  const segments = filePath.split(/[\\/]/).filter((s) => s !== '');
  const file = segments[segments.length - 1] ?? '';
  const stem = file.toLowerCase().endsWith('.dbml') ? file.slice(0, -'.dbml'.length) : file;
  return `${segments.length >= 2 ? segments[segments.length - 2] : ''}/${stem}`;
}

/** `parseSubjectAreaDbml(text, filePath, layoutText)`, answered from the last few readings when nothing changed. Throws as it does. */
export function readDbmlDiagram(text: string, filePath: string, layoutText: string | null): DbmlSubjectAreaReading {
  const key = `${readingPathKey(filePath)}\u0000${layoutText === null ? '\u0001' : `\u0002${layoutText}`}\u0000${text}`;
  const hit = memo.get(key);
  if (hit) {
    memo.delete(key);
    memo.set(key, hit);
    return structuredClone(hit);
  }
  const reading = parseSubjectAreaDbml(text, filePath, layoutText);
  memo.set(key, structuredClone(reading));
  if (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value as string);
  return reading;
}

/** Forget every reading (tests). */
export function clearDbmlDiagramReadings(): void {
  memo.clear();
}
