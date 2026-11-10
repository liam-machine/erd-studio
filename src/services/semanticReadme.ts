/**
 * The `README.md` a DBML project's semantic dir starts with (ERD Studio
 * 2.0): what the folder is and where each kind of file lives, for anyone who
 * opens it without ERD Studio. It is only ever created, never replaced:
 * once the file exists it is the user's.
 *
 * No `vscode`: the CLI bundles the paths that create a project.
 */

import * as path from 'path';

import type { FileWrite } from './fileWrites';

/** The README's file name, at the root of the semantic dir. */
export const SEMANTIC_README_FILE = 'README.md';

/** A layer as the README lists it: its folder (the id) and its label. */
export interface SemanticReadmeLayer {
  readonly id: string;
  readonly label: string;
}

const README_HEAD = `# .erd-studio

This folder is an ERD Studio data model, stored as DBML, an open format (https://dbml.dbdiagram.io).
Edit it in VS Code with ERD Studio, or with any text editor or AI assistant.

`;

const README_LAYERS_GENERIC = `Every file lives under a layer folder (bronze, silver, gold, …), and layers.json lists the layers:
`;

const README_TREE = `
    <layer>/tables/<schema>/<table>.dbml   one table: Table <schema>.<table> { … }
    <layer>/relationships/<file>.dbml      Refs between tables, split across files however you like
    <layer>/diagrams/<diagram>.dbml        one diagram: the tables it shows (use lines), the
                                           relationships files it needs, its sticky notes, and
                                           the table positions (erd_layout in its Project)

- A table's name is unique across the whole project. Tables that share a warehouse name get
  unique names (silver_customer, gold_customer), with the warehouse name in their alias.
- Each relationship is one Ref, stored once, in any relationships file.
- Other DBML tools read a diagram as a normal DBML project: open <layer>/diagrams/<name>.dbml.
- fields.yml (optional, beside layers.json) lists the fields each table and column records, in
  order; each is one setting, such as purpose: '…'. Without it, ERD Studio's starting set is used.

Check the files with \`erd-studio doctor\`.
`;

/** The project's layers in order, one line each: stage number, label and folder. */
function layersText(layers: readonly SemanticReadmeLayer[]): string {
  const width = Math.max(...layers.map((l) => l.label.length));
  const lines = layers.map((l, i) => `    ${i + 1}. ${l.label.padEnd(width)}   ${l.id}/`);
  return [
    'Every file lives under a layer folder. This project\'s layers, in order (layers.json lists them):',
    '',
    ...lines,
    '',
    'In each layer folder:',
    '',
  ].join('\n');
}

/**
 * The README's text. With `layers` (layers.json's, in order), it lists the
 * project's own layers with their labels and folders; without, it names the
 * usual ones.
 */
export function semanticReadmeText(layers?: readonly SemanticReadmeLayer[]): string {
  const listed = (layers ?? []).filter((l) => l.id !== '');
  return README_HEAD + (listed.length === 0 ? README_LAYERS_GENERIC : layersText(listed)) + README_TREE;
}

/**
 * The README's create under `semanticRoot`, or null when the file already
 * exists (`exists` is asked with the full path): it is never replaced.
 * `layers`: the project's layers, in order, for the README to list.
 */
export function semanticReadmeCreate(
  semanticRoot: string,
  exists: (p: string) => boolean,
  layers?: readonly SemanticReadmeLayer[],
): FileWrite | null {
  const file = path.join(semanticRoot, SEMANTIC_README_FILE);
  return exists(file) ? null : { kind: 'create', path: file, text: semanticReadmeText(layers) };
}
