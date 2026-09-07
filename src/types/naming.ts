/**
 * Naming rules shared by the extension host and the webview.
 *
 * This pattern is the *authoring* convention: it governs names the user types
 * in the New Model dialog (webview) and in a rename, and the host enforces it
 * through `validateModelName`.
 *
 * It is deliberately NOT applied to names discovered in the user's dbt project
 * ("Add Existing Model"), where dbt permits uppercase and digit-leading names.
 * Those go through `validateModelNameSafety`, which only rules out anything
 * unsafe as a file name under `.erd-studio/logical-models/`.
 */

/** A model name: lowercase, starts with a letter, then letters/digits/underscores. */
export const MODEL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Human-readable statement of the model-name rule (used in error messages). */
export const MODEL_NAME_RULE =
  'Model name must start with a letter and use lowercase letters, numbers, and underscores.';

/** A column name: lowercase letters, digits, and underscores. */
export const COLUMN_NAME_PATTERN = /^[a-z0-9_]+$/;

/** Return the names that appear more than once in `names` (trimmed; blanks ignored). */
export function findDuplicateNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (seen.has(name)) {
      duplicates.add(name);
    }
    seen.add(name);
  }
  return Array.from(duplicates);
}
