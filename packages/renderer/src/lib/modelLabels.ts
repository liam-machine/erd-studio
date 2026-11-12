/**
 * What a model node's header says.
 *
 * A model's NAME is its identity (domain files, relationships, positions); its
 * LABEL is what a person reads. They differ when the model sets an `alias` —
 * the table name dbt builds it as — which is how `silver_date` and `gold_date`
 * can both be the table `date`. Two models on one canvas that would read the
 * same are told apart by schema (`silver.date`, `gold.date`).
 *
 * On a DBML diagram that shows two tables of one name from different schema
 * folders, each NAME is `<schema>.<name>` (`bqs.addresse`) and the table's own
 * name travels beside it as `tableName`: labels and the header start from
 * that own name, so neither reads the schema twice.
 */

/** The fields a label is computed from. */
export interface LabelledTable {
  name: string;
  /** The table's own name when `name` is not it (`DisplayTable.tableName`); absent from an older core. */
  tableName?: string;
  schema?: string;
  alias?: string;
}

/**
 * Header label per model name, for the models whose label differs from their
 * name. A model absent from the map is labelled with its name, exactly as
 * before aliases existed.
 */
export function computeTableLabels(models: readonly LabelledTable[]): Map<string, string> {
  const baseOf = (m: LabelledTable): string => m.alias?.trim() || m.tableName || m.name;
  const counts = new Map<string, number>();
  for (const m of models) {
    const key = baseOf(m).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const m of models) {
    const base = baseOf(m);
    const clashes = (counts.get(base.toLowerCase()) ?? 0) > 1;
    const label = clashes && m.schema ? `${m.schema}.${base}` : base;
    if (label !== m.name) {
      labels.set(m.name, label);
    }
  }
  return labels;
}

/**
 * The name a header prints after its schema prefix: the table's own name
 * when a prefix is shown (`ccc.` then `addresse`), else the model name, which
 * for one of two same-named tables already carries its schema. Without a
 * `tableName` (every other table, and every older core) it is the model name,
 * as it always was.
 */
export function headerName(data: { modelName: string; tableName?: string; shownSchema?: string }): string {
  return data.shownSchema && data.tableName ? data.tableName : data.modelName;
}

/** Whether a search query (already lower-cased) matches a model by name or label. */
export function matchesTableSearch(data: { modelName: string; label?: string }, query: string): boolean {
  return data.modelName.toLowerCase().includes(query)
    || (data.label !== undefined && data.label.toLowerCase().includes(query));
}
