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

/**
 * A model name: starts with a letter, then letters/digits/underscores. Either
 * case is allowed (`dim_date`, `DimDate`, `D_Date`) — issue #93.
 */
export const MODEL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Human-readable statement of the model-name rule (used in error messages). */
export const MODEL_NAME_RULE =
  'Model name must start with a letter and use only letters, numbers, and underscores.';

/** A column name: letters (either case), digits, and underscores. */
export const COLUMN_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

/** Human-readable statement of the column-name rule (used in error messages). */
export const COLUMN_NAME_RULE = 'Use only letters, numbers, and underscores';

/**
 * Whether two names are the same identifier: trimmed and compared without
 * case. Names are allowed in either case, but `DimDate` and `dimdate` must
 * never both exist — they are one file on macOS/Windows and one relation in
 * the warehouse — so every uniqueness check compares with this.
 */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Return the names that appear more than once in `names`, compared with
 * {@link sameName} (trimmed; blanks ignored). Every spelling in a clash is
 * listed once, so `['Date', 'date']` flags both rows.
 */
export function findDuplicateNames(names: readonly string[]): string[] {
  const firstSpelling = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const first = firstSpelling.get(key);
    if (first === undefined) {
      firstSpelling.set(key, name);
    } else {
      duplicates.add(first);
      duplicates.add(name);
    }
  }
  return Array.from(duplicates);
}
