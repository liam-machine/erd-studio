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

const README_TEXT = `# .erd-studio

This folder is an ERD Studio data model, stored as DBML, an open format (https://dbml.dbdiagram.io).
Edit it in VS Code with ERD Studio, or with any text editor or AI assistant.

Every file lives under a layer folder (bronze, silver, gold, …), and layers.json lists the layers:

    <layer>/tables/<schema>/<table>.dbml   one table: Table <schema>.<table> { … }
    <layer>/relationships/<file>.dbml      Refs between tables, split across files however you like
    <layer>/diagrams/<diagram>.dbml        one diagram: the tables it shows (use lines), the
                                           relationships files it needs, its sticky notes, and
                                           the table positions (erd_layout in its Project)

- A table's name is unique across the whole project. Tables that share a warehouse name get
  unique names (silver_customer, gold_customer), with the warehouse name in their alias.
- Each relationship is one Ref, stored once, in any relationships file.
- Other DBML tools read a diagram as a normal DBML project: open <layer>/diagrams/<name>.dbml.

Check the files with \`erd-studio doctor\`.
`;

/** The README's text. */
export function semanticReadmeText(): string {
  return README_TEXT;
}

/**
 * The README's create under `semanticRoot`, or null when the file already
 * exists (`exists` is asked with the full path): it is never replaced.
 */
export function semanticReadmeCreate(semanticRoot: string, exists: (p: string) => boolean): FileWrite | null {
  const file = path.join(semanticRoot, SEMANTIC_README_FILE);
  return exists(file) ? null : { kind: 'create', path: file, text: semanticReadmeText() };
}
