/**
 * Which deleted diagram files really removed a subject area.
 *
 * A subject area is one diagram in a layer folder, stored as
 * `<layer>/<name>.json` or `<layer>/<name>.dbml`. When the file goes but the
 * same name in the other format is there now, the subject area still exists:
 * its format changed. That is what Edit > Undo of **Convert Project to DBML**
 * does (the `.dbml` diagrams are deleted and their `.json` comes back), and
 * what Convert itself does the other way round. Only a diagram whose name is
 * gone in both formats was removed, so only those are worth the "Regenerate
 * dbt selectors.yml" prompt.
 *
 * Pure apart from `exists`, and free of `vscode`.
 */

import * as path from 'path';

/** The formats a diagram file is stored in. */
const DIAGRAM_EXTENSIONS = ['.json', '.dbml'] as const;

/** The deleted diagram paths whose subject area no longer exists in any format, in their order. */
export function removedSubjectAreaPaths(deleted: readonly string[], exists: (filePath: string) => boolean): string[] {
  return deleted.filter((filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!(DIAGRAM_EXTENSIONS as readonly string[]).includes(ext)) return true;
    const stem = filePath.slice(0, filePath.length - ext.length);
    return !DIAGRAM_EXTENSIONS.some((other) => exists(stem + other));
  });
}
