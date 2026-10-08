/**
 * A file keeps its own line endings when ERD Studio rewrites it. `yaml` and
 * `JSON.stringify` always emit LF, so text rendered from a CRLF file is put
 * back into CRLF before it is written. Pure: no `vscode`, no `fs`.
 */

/** The file's own line ending: CRLF when it uses one anywhere, else LF. */
export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * `text` with every line break written the way `original` (the file's current
 * text) writes them. With no original — a new file — `text` is returned as is.
 */
export function keepLineEndings(text: string, original: string | undefined): string {
  if (original === undefined) return text;
  const eol = detectEol(original);
  return text.replace(/\r?\n/g, eol);
}
