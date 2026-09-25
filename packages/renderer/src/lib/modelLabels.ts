/**
 * What a model node's header says.
 *
 * A model's NAME is its identity (domain files, relationships, positions); its
 * LABEL is what a person reads. They differ when the model sets an `alias` —
 * the table name dbt builds it as — which is how `silver_date` and `gold_date`
 * can both be the table `date`. Two models on one canvas that would read the
 * same are told apart by schema (`silver.date`, `gold.date`).
 */

/** The fields a label is computed from. */
export interface LabelledModel {
  name: string;
  schema?: string;
  alias?: string;
}

/**
 * Header label per model name, for the models whose label differs from their
 * name. A model absent from the map is labelled with its name, exactly as
 * before aliases existed.
 */
export function computeModelLabels(models: readonly LabelledModel[]): Map<string, string> {
  const baseOf = (m: LabelledModel): string => m.alias?.trim() || m.name;
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

/** Whether a search query (already lower-cased) matches a model by name or label. */
export function matchesModelSearch(data: { modelName: string; label?: string }, query: string): boolean {
  return data.modelName.toLowerCase().includes(query)
    || (data.label !== undefined && data.label.toLowerCase().includes(query));
}
