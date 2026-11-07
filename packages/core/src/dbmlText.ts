/**
 * The DBML text helpers shared by the rich DBML export (`toDbmlRich`) and
 * native DBML storage's writers: how a string, a name, a column type and a
 * note are spelled in DBML. Moved out of `exportDbmlRich.ts` unchanged, so
 * every `*.rich.dbml` golden is byte-identical.
 *
 * Pure and parser-free.
 */

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Words DBML reads as keywords somewhere; quoted as names so no parser version has to guess. */
export const DBML_KEYWORDS: ReadonlySet<string> = new Set([
  'project', 'table', 'tablegroup', 'tablepartial', 'ref', 'note', 'enum', 'indexes', 'checks', 'records',
  'as', 'pk', 'null', 'not', 'unique', 'increment', 'default', 'true', 'false', 'primary', 'key',
]);

/** `value` as a DBML string every 9.1+ parser reads back exactly: single-quoted on one line, else triple-quoted. */
export function dbmlString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return /[\r\n]/.test(value) ? `'''${escaped}'''` : `'${escaped}'`;
}

/** Note text: DBML drops white space at the start of a note (and an indent every line shares), so drop it here too. */
export function dbmlNoteText(value: string): string {
  return value.replace(/^\s+/, '');
}

/** A DBML name: bare when it is a plain identifier and no keyword, else double-quoted with `\"` / `\\` escapes. */
export function dbmlName(value: string): string {
  if (PLAIN_IDENTIFIER.test(value) && !DBML_KEYWORDS.has(value.toLowerCase())) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** A column type: bare when a plain identifier, else double-quoted; an empty type is `""`. */
export function dbmlColumnType(dataType: string): string {
  return dataType === '' ? '""' : dbmlName(dataType);
}
