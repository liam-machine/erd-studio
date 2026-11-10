/**
 * The one definition of a layer, for every prompt that explains one (New
 * Diagram, New Layer, Import DBML, Import from dbt). Free of `vscode`.
 */

/** What a layer is, in full: where there is room for a sentence (an input box prompt). */
export const LAYER_DEFINITION =
  'A layer is a stage of your warehouse, such as Staging or Gold. It holds tables and the diagrams drawn from them; a diagram can show tables from any layer.';

/** The same, short enough for a Quick Pick placeholder. */
export const LAYER_DEFINITION_SHORT =
  'A layer is a stage of your warehouse, such as Staging or Gold; a diagram can show tables from any layer.';

/** The question a diagram's layer pick asks, with the short definition. */
export const WHICH_LAYER_FOR_DIAGRAM = `Which layer is this diagram for? ${LAYER_DEFINITION_SHORT}`;

/**
 * The layer a diagram goes in without asking, by New Diagram's rule: the only
 * creatable layer, or, while the project has no diagram yet (nothing to tell
 * the layers apart by), the last creatable one in `layers.json` order (gold,
 * of silver and gold; a new folder's one default layer). Undefined: ask.
 */
export function defaultDiagramLayer(creatableIds: readonly string[], diagramCount: number): string | undefined {
  if (creatableIds.length === 1) return creatableIds[0];
  if (creatableIds.length > 1 && diagramCount === 0) return creatableIds[creatableIds.length - 1];
  return undefined;
}
