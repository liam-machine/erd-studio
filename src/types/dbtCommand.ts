/**
 * The canvas toolbar's **dbt command** menu (`copyDbtCommand`): its choices
 * and payload limit, shared by the webview, the message types and the host.
 * The command itself is built in `src/services/dbtCommand.ts`.
 */

/** The menu's three choices, in its order. */
export const DBT_COMMAND_VERBS = ['build', 'run', 'test'] as const;
export type DbtCommandVerb = (typeof DBT_COMMAND_VERBS)[number];

export function isDbtCommandVerb(value: unknown): value is DbtCommandVerb {
  return typeof value === 'string' && (DBT_COMMAND_VERBS as readonly string[]).includes(value);
}

/** The most table names one `copyDbtCommand` may carry (payload validation). */
export const DBT_COMMAND_TABLES_LIMIT = 10000;
