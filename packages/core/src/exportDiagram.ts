/**
 * Exports of a diagram to open text formats: Mermaid `erDiagram`, portable
 * DBML and rich DBML. ERD Studio's own files (the model library and the
 * domain JSON) stay the only storage; Mermaid and portable DBML are one way,
 * and rich DBML is what ERD Studio's DBML import reads back.
 *
 * Pure functions over a `DisplaySubjectArea`, with no dependency beyond core
 * itself, so every host — the extension, its CLI and any page that renders a
 * diagram with `@erd-studio/renderer` — produces the same text. Hosts pass
 * the logical (design) stage; the functions accept any `DisplaySubjectArea`,
 * including one built by an older core, and never throw on it.
 *
 * The mapping of each format is documented at the top of `exportMermaid.ts`,
 * `exportDbml.ts` and `exportDbmlRich.ts` (its layout file in
 * `dbdiagramLayout.ts`).
 */

import type { DisplaySubjectArea } from './types/display.js';
import { toDbml } from './exportDbml.js';
import { toDbmlRich } from './exportDbmlRich.js';
import { toMermaid } from './exportMermaid.js';
import { exportFileBase } from './exportFileName.js';

export { toDbml } from './exportDbml.js';
export { toDbmlRich, DBML_RICH_EXPORT_HEADER, type DbmlRichOptions } from './exportDbmlRich.js';
export { toMermaid } from './exportMermaid.js';

/**
 * A text format a diagram can be exported to: `mermaid`, `dbml` (portable,
 * notes only) or `dbml-rich` (ERD Studio's fields as DBML custom properties,
 * DBML 9.1+, with a `.dbdiagram` layout file beside it).
 */
export type DiagramExportFormat = 'mermaid' | 'dbml' | 'dbml-rich';

/** Every export format, in the order a picker offers them. */
export const DIAGRAM_EXPORT_FORMATS: readonly DiagramExportFormat[] = Object.freeze(['mermaid', 'dbml', 'dbml-rich'] as const);

/** The file extension (without the dot) each format is saved under. Both DBML formats are `.dbml`. */
export const DIAGRAM_EXPORT_FILE_EXTENSIONS: Readonly<Record<DiagramExportFormat, string>> = Object.freeze({
  mermaid: 'mmd',
  dbml: 'dbml',
  'dbml-rich': 'dbml',
});

/**
 * The diagram in `format`. Deterministic: the same domain always gives the
 * same text. Throws only for a format that is not in
 * {@link DIAGRAM_EXPORT_FORMATS}.
 */
export function exportDiagram(domain: DisplaySubjectArea, format: DiagramExportFormat): string {
  switch (format) {
    case 'mermaid':
      return toMermaid(domain);
    case 'dbml':
      return toDbml(domain);
    case 'dbml-rich':
      return toDbmlRich(domain);
    default:
      throw new Error(`Unknown diagram export format: ${String(format)}`);
  }
}

/**
 * A file name for the export of `domain` in `format`, e.g. `showcase.dbml`:
 * the domain name with characters no file system accepts (`/ \ : * ? " < > |`
 * and control characters) replaced by `-`, leading and trailing dots and
 * spaces removed, at most 100 characters, and `diagram` when nothing is left.
 * A name Windows reserves (`con`, `nul.txt`, …) gets `-diagram` after the
 * reserved word, and a format outside {@link DIAGRAM_EXPORT_FORMATS} the
 * extension `txt`. A rich DBML export's layout file has the same base
 * (`dbdiagramLayoutFileName`).
 */
export function diagramExportFileName(domain: Pick<DisplaySubjectArea, 'domain'>, format: DiagramExportFormat): string {
  // Only the formats themselves: a plain lookup would also find `toString` and every other inherited property.
  const extension = DIAGRAM_EXPORT_FORMATS.includes(format) ? DIAGRAM_EXPORT_FILE_EXTENSIONS[format] : 'txt';
  return `${exportFileBase(domain)}.${extension}`;
}
