/**
 * One-way exports of a diagram to open text formats: Mermaid `erDiagram` and
 * DBML. ERD Studio's own files (the model library and the domain JSON) stay
 * the only storage; nothing reads these exports back.
 *
 * Pure functions over a `DisplayDomain`, with no dependency beyond core
 * itself, so every host — the extension, its CLI and any page that renders a
 * diagram with `@erd-studio/renderer` — produces the same text. Hosts pass
 * the logical (design) stage; the functions accept any `DisplayDomain`,
 * including one built by an older core, and never throw on it.
 *
 * The mapping of each format is documented at the top of `exportMermaid.ts`
 * and `exportDbml.ts`.
 */

import type { DisplayDomain } from './types/display.js';
import { toDbml } from './exportDbml.js';
import { toMermaid } from './exportMermaid.js';

export { toDbml } from './exportDbml.js';
export { toMermaid } from './exportMermaid.js';

/** A text format a diagram can be exported to. */
export type DiagramExportFormat = 'mermaid' | 'dbml';

/** Every export format, in the order a picker offers them. */
export const DIAGRAM_EXPORT_FORMATS: readonly DiagramExportFormat[] = Object.freeze(['mermaid', 'dbml'] as const);

/** The file extension (without the dot) each format is saved under. */
export const DIAGRAM_EXPORT_FILE_EXTENSIONS: Readonly<Record<DiagramExportFormat, string>> = Object.freeze({
  mermaid: 'mmd',
  dbml: 'dbml',
});

/**
 * The diagram in `format`. Deterministic: the same domain always gives the
 * same text. Throws only for a format that is not in
 * {@link DIAGRAM_EXPORT_FORMATS}.
 */
export function exportDiagram(domain: DisplayDomain, format: DiagramExportFormat): string {
  switch (format) {
    case 'mermaid':
      return toMermaid(domain);
    case 'dbml':
      return toDbml(domain);
    default:
      throw new Error(`Unknown diagram export format: ${String(format)}`);
  }
}

// Windows reserves these names whatever extension follows them (`NUL.tar.gz` too).
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?=\.|$)/i;
const MAX_BASE_LENGTH = 100;

/**
 * A file name for the export of `domain` in `format`, e.g. `showcase.dbml`:
 * the domain name with characters no file system accepts (`/ \ : * ? " < > |`
 * and control characters) replaced by `-`, leading and trailing dots and
 * spaces removed, at most 100 characters, and `diagram` when nothing is left.
 * A name Windows reserves (`con`, `nul.txt`, …) gets `-diagram` after the
 * reserved word, and a format outside {@link DIAGRAM_EXPORT_FORMATS} the
 * extension `txt`.
 */
export function diagramExportFileName(domain: Pick<DisplayDomain, 'domain'>, format: DiagramExportFormat): string {
  const raw = typeof domain?.domain === 'string' ? domain.domain : '';
  let base = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/[\s.]+$/g, '');
  if (base === '') base = 'diagram';
  base = base.replace(WINDOWS_RESERVED, '$1-diagram');
  // Only the formats themselves: a plain lookup would also find `toString` and every other inherited property.
  const extension = DIAGRAM_EXPORT_FORMATS.includes(format) ? DIAGRAM_EXPORT_FILE_EXTENSIONS[format] : 'txt';
  return `${base}.${extension}`;
}
