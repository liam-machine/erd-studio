/**
 * The words for a relationship's direction and cardinality that the canvas
 * (the New / Edit Relationship dialog, `webview/lib/relationshipDialog.ts`,
 * which re-exports them unchanged) and the host (Suggest Relationships'
 * "Which way does this relationship point?") both say. One copy, so the two
 * never drift. No `vscode`, no DOM: shared by both tsconfigs.
 */

/** `model.column`, or `model.(a, b)` for a composite. */
export function describeEnd(model: string, columns: readonly string[]): string {
  return columns.length === 1 ? `${model}.${columns[0]}` : `${model}.(${columns.join(', ')})`;
}

/** `column`, or `(a, b)` for a composite. */
export const columnsText = (columns: readonly string[]): string => (columns.length === 1 ? columns[0] : `(${columns.join(', ')})`);

/** One of the two choices the dialog offers when nothing says which side holds the foreign key. */
export interface DirectionChoice {
  text: string;
  detail: string;
}

/**
 * The choice "`from` holds the foreign key", named after the models: "Each
 * fct_order row points at one dim_customer", "fct_order holds dim_customer's
 * key" for a one-to-one, or "Each employee row's manager_id points at one
 * employee_id" for a self-reference.
 */
export function directionChoice(
  from: { model: string; columns: readonly string[] },
  to: { model: string; columns: readonly string[] },
  cardinality: string,
): DirectionChoice {
  const detail = `${describeEnd(from.model, from.columns)} → ${describeEnd(to.model, to.columns)}`;
  if (from.model.toLowerCase() === to.model.toLowerCase()) {
    return { text: `Each ${from.model} row's ${columnsText(from.columns)} points at one ${columnsText(to.columns)}`, detail };
  }
  if (cardinality === 'one-to-one') return { text: `${from.model} holds ${to.model}'s key`, detail };
  return { text: `Each ${from.model} row points at one ${to.model}`, detail };
}

// About what the relationship means, not where it is saved: the Ref (or yml entry) records it either way.
export const DIRECTION_QUESTION = 'Which way does this relationship point?';
export const DIRECTION_MISSING_HINT = "Pick one: neither table marks these columns as its key, and dbt has no test to tell. Once a table's primary key is marked, ERD Studio works this out itself.";
/** The same hint in a folder with no dbt project, where no dbt test could tell. */
export const DIRECTION_MISSING_HINT_LOGICAL = "Pick one: neither table marks these columns as its key. Once a table's primary key is marked, ERD Studio works this out itself.";

/** The one vocabulary for a cardinality's name, used by every menu and dialog. */
export const CARDINALITY_NAMES: Record<'many-to-one' | 'one-to-many' | 'one-to-one' | 'many-to-many', string> = {
  'many-to-one': 'Many-to-one',
  'one-to-many': 'One-to-many',
  'one-to-one': 'One-to-one',
  'many-to-many': 'Many-to-many',
};
