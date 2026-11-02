/**
 * The one definition of a layer, for every prompt that explains one (New
 * Diagram, New Layer, Import DBML, Draw from dbt). Free of `vscode`.
 */

/** What a layer is, in full: where there is room for a sentence (an input box prompt). */
export const LAYER_DEFINITION =
  'A layer is a stage of your warehouse, such as Staging or Gold. It holds tables and the diagrams drawn from them; a diagram can show tables from any layer.';

/** The same, short enough for a Quick Pick placeholder. */
export const LAYER_DEFINITION_SHORT =
  'A layer is a stage of your warehouse, such as Staging or Gold; a diagram can show tables from any layer.';

/** The question a diagram's layer pick asks, with the short definition. */
export const WHICH_LAYER_FOR_DIAGRAM = `Which layer is this diagram for? ${LAYER_DEFINITION_SHORT}`;
