/**
 * A `.dbml` file saved where ERD Studio reads no file (the layer-first tree,
 * §1.1): what to say about it. One hint for `doctor`'s
 * `dbmlOutsideKnownFolders` (`src/cli/dbmlProblems.ts`) and the canvas's
 * "not shown" notes (`src/services/filesNotShown.ts`), so the two never
 * disagree about where the file belongs; each has its own lead sentence.
 *
 * Path-only and free of `vscode` and `fs`: bundled into `dist/cli.js`.
 */

import {
  DIAGRAMS_DIR,
  LOGICAL_MODELS_DIR,
  NON_SUBJECT_AREA_DIRS,
  RELATIONSHIPS_DIR,
  TABLES_DIR,
  isDbmlLayerName,
  isReservedLayerName,
} from '@erd-studio/core';

/**
 * Where a `.dbml` the tree has no place for belongs (§1.1): the hint
 * `dbmlOutsideKnownFolders` gives, by the shape of its path. The fixed names
 * are compared exactly, as the classifier compares them.
 */
export function outsideKnownFoldersHint(rel: string): string {
  const segments = rel.split('/');
  const file = segments[segments.length - 1];
  if (!file.endsWith('.dbml')) return `rename it to ${file.replace(/\.dbml$/i, '.dbml')}: the extension is lower-case`;
  if (segments.length === 1) return `a diagram belongs at <layer>/${DIAGRAMS_DIR}/${file}, a table at <layer>/${TABLES_DIR}/<schema>/${file}`;
  const top = segments[0];
  if (!isDbmlLayerName(top)) {
    const lower = top.toLowerCase();
    if (lower !== top && isDbmlLayerName(lower)) return `layer folders are lower-case ids; rename ${top}/ to ${lower}/ and set its label in layers.json`;
    if (top === LOGICAL_MODELS_DIR) return `the folder ${LOGICAL_MODELS_DIR}/ holds YAML tables only; a DBML table belongs at <layer>/${TABLES_DIR}/<schema>/${file}`;
    if (isReservedLayerName(top) || NON_SUBJECT_AREA_DIRS.has(lower)) {
      return `the folder ${top}/ cannot be a layer: ERD Studio reserves the name ${lower}. A diagram belongs at <layer>/${DIAGRAMS_DIR}/${file}, a table at <layer>/${TABLES_DIR}/<schema>/${file}`;
    }
    return `the folder ${top}/ is not a valid layer name: a layer folder is a lower-case id (a letter, then letters, digits, - or _)`;
  }
  if (segments.length === 2) return `a diagram belongs at ${top}/${DIAGRAMS_DIR}/${file}`;
  const second = segments[1];
  const fixed = [DIAGRAMS_DIR, TABLES_DIR, RELATIONSHIPS_DIR].find((name) => name !== second && name === second.toLowerCase());
  if (fixed !== undefined) return `rename the folder to ${fixed} (lower-case)`;
  if (second === RELATIONSHIPS_DIR) return `relationships files are flat in ${top}/${RELATIONSHIPS_DIR}/`;
  if (second === DIAGRAMS_DIR) return `diagrams are flat in ${top}/${DIAGRAMS_DIR}/`;
  if (second === TABLES_DIR) {
    return segments.length === 3
      ? `a table belongs in a schema folder: ${top}/${TABLES_DIR}/<schema>/${file}`
      : `a table belongs at ${top}/${TABLES_DIR}/<schema>/${file}, one schema folder deep`;
  }
  return `a diagram belongs at ${top}/${DIAGRAMS_DIR}/${file}, a relationships file at ${top}/${RELATIONSHIPS_DIR}/${file}, a table at ${top}/${TABLES_DIR}/<schema>/${file}`;
}

/**
 * `dbmlOutsideKnownFolders`' message for `rel` (relative to the semantic dir).
 * Every hint starts with a word, never a folder name, so capitalising it never
 * misspells a folder (case matters in the tree, §1.1).
 */
export function outsideKnownFoldersMessage(rel: string): string {
  return `ERD Studio does not read this file: it is outside the folders of a DBML project. ${capitalisedHint(rel)}.`;
}

/**
 * The canvas's shorter sentence for the same file (a "not shown" note): it
 * names the file, since the strip lists several, and ends with the very hint
 * `doctor` gives, so the two always agree on where the file belongs.
 */
export function outsideKnownFoldersNote(rel: string): string {
  return `ERD Studio does not read ${rel} where it is. ${capitalisedHint(rel)}.`;
}

function capitalisedHint(rel: string): string {
  const hint = outsideKnownFoldersHint(rel);
  return `${hint[0].toUpperCase()}${hint.slice(1)}`;
}
