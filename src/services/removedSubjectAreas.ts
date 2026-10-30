/**
 * Which deleted diagram files really removed a subject area.
 *
 * A subject area is one diagram of a layer, stored as `<layer>/<name>.json`
 * or `<layer>/diagrams/<name>.dbml`. When the file goes but the same name in
 * the other format is there now (or the file itself is back), the subject
 * area still exists:
 * its format changed. That is what Edit > Undo of **Convert Project to DBML**
 * does (the `.dbml` diagrams are deleted and their `.json` comes back), and
 * what Convert itself does the other way round. Only a diagram whose name is
 * gone in both formats was removed, so only those are worth the "Regenerate
 * dbt selectors.yml" prompt.
 *
 * Pure apart from `exists`, and free of `vscode`.
 */

import * as path from 'path';

/** The other format's file for a diagram path: `<layer>/<name>.json` ↔ `<layer>/diagrams/<name>.dbml`. */
function otherFormatPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const stem = path.basename(filePath, path.extname(filePath));
  const dir = path.dirname(filePath);
  if (ext === '.json') return path.join(dir, 'diagrams', `${stem}.dbml`);
  if (ext === '.dbml' && path.basename(dir) === 'diagrams') return path.join(path.dirname(dir), `${stem}.json`);
  return undefined;
}

/** The deleted diagram paths whose subject area no longer exists in any format, in their order. */
export function removedSubjectAreaPaths(deleted: readonly string[], exists: (filePath: string) => boolean): string[] {
  return deleted.filter((filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.json' && ext !== '.dbml') return true;
    const other = otherFormatPath(filePath);
    return !exists(filePath) && (other === undefined || !exists(other));
  });
}
