/**
 * The schema folder rule (`<layer>/tables/<schema>/`), shared by the host's
 * writers and the webview's New Table dialog, so a schema the dialog accepts
 * is one the host writes.
 */

import { isLibraryFolderName } from '@erd-studio/core';

/**
 * Whether a schema can be a NEW schema folder, the one check every writer
 * shares (Import, Import from dbt and Add from dbt through the library write
 * planner, Convert, and New Table): a library folder name with no dbt Jinja
 * (`{{ target.schema }}`, `{% … %}`, `{# … #}`, which a schema yml read
 * without a manifest leaves unrendered), no character Windows refuses in a
 * file name, no `'` or `\` (either would end or escape the quoted path of a
 * `use` line, which no parser reads back), no white space at either end, no
 * trailing `.`, and not a Windows device name (`con`, `nul`, `com1`, …).
 */
export function isSchemaFolderName(schema: string): boolean {
  return isLibraryFolderName(schema) && schema === schema.trim()
    && !/[{}%#<>:"'|?*\u0000-\u001f\\]/.test(schema) && !/[ .]$/.test(schema)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(schema);
}

/** The plain-words rule the New Table dialog and the host show for a schema {@link isSchemaFolderName} refuses. */
export const SCHEMA_FOLDER_RULE =
  'Use a folder name: letters, numbers, - and _ are safe; no slashes, quotes or { } % # : * ? < > |, and no dot or space at the start or end.';

/**
 * The file New Table creates, as the dialog previews it:
 * `<dir>/<layer>/tables/<schema>/<name>.dbml`, the schema spelled as an
 * existing folder that matches it without case (the host writes it so).
 */
export function newTablePathPreview(dir: string, layer: string, schemas: readonly string[], schema: string, name: string): string {
  const listed = schemas.find((s) => s.toLowerCase() === schema.toLowerCase()) ?? schema;
  return `${dir ? `${dir}/` : ''}${layer}/tables/${listed}/${name}.dbml`;
}
