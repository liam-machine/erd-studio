/**
 * Unresolved git merge conflicts in a file this package reads (issue #145).
 *
 * Two people moving models on different branches is enough for git to leave
 * `<<<<<<<` / `=======` / `>>>>>>>` markers in a domain file's
 * `viewConfig.positions`. The file then fails to parse, and saying "Invalid
 * JSON" makes an ordinary merge look like corruption. Callers run this only
 * once a parse has already failed, so a valid file is never reported.
 *
 * Internal to the package: hosts learn about a conflict from the errors that
 * carry it (`DomainFileError.mergeConflict`, `ModelLoadError.mergeConflict`).
 */

// The marker lines as git writes and recognises them (`is_conflict_marker`):
// seven or more of the character, then the end of the line or whitespace and
// a label. The separator carries no label.
const OPENING = /^<{7,}(?:[ \t].*)?$/;
const SEPARATOR = /^={7,}[ \t]*$/;
const CLOSING = /^>{7,}(?:[ \t].*)?$/;

/**
 * The 1-based line of the first `<<<<<<<` that opens a complete conflict, or
 * null when the text holds none.
 *
 * A conflict is an opening line, then a separator, then a closing line, in
 * that order; a diff3 / zdiff3 `|||||||` base line may sit between the
 * opening and the separator. A lone marker-like line — a Markdown `=======`
 * underline in a description, say — is not a conflict.
 */
export function findConflictMarkers(text: string): number | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let open = 0; open < lines.length; open++) {
    if (!OPENING.test(lines[open])) continue;
    let separator = -1;
    for (let i = open + 1; i < lines.length; i++) {
      if (SEPARATOR.test(lines[i])) { separator = i; break; }
      // Another opening (or a closing) before any separator ends this
      // candidate; a diff3 `|||||||` base line is ordinary content here.
      if (OPENING.test(lines[i]) || CLOSING.test(lines[i])) break;
    }
    if (separator === -1) continue;
    for (let i = separator + 1; i < lines.length; i++) {
      if (CLOSING.test(lines[i])) return open + 1;
      if (OPENING.test(lines[i]) || SEPARATOR.test(lines[i])) break;
    }
  }
  return null;
}
