/**
 * Export a domain file as Mermaid or DBML — the one host-side entry point the
 * palette command, the canvas and the `erd-studio export` CLI share.
 *
 * The domain is read exactly as the canvas's logical stage reads it
 * (`DomainService.getDomain` → `buildLogicalDisplayDomain`, the same core
 * `computeDomainDiff` uses), so library relationships are merged and a link
 * stored twice is drawn from the same winner. The text itself comes from
 * `@erd-studio/core`'s `exportDiagram`, which every host shares.
 *
 * Read-only: nothing is written. No `vscode` import — this module is bundled
 * into `dist/cli.js`.
 */

import { DIAGRAM_EXPORT_FORMATS, diagramExportFileName, exportDiagram } from '@erd-studio/core';
import type { DbtKeyIndex, DiagramExportFormat } from '@erd-studio/core';

import { DomainService } from './domainService';
import { buildLogicalDisplayDomain } from './stageDisplay';

export interface DomainExport {
  /** The export text, ending in a newline. */
  content: string;
  /** A safe file name for it, e.g. `showcase.dbml`. */
  fileName: string;
  /** The domain's name as the domain file gives it. */
  domainName: string;
  /** The domain's layer. */
  layer: string;
}

export interface ExportDomainFileOptions {
  /**
   * dbt's key evidence (#133 L1), as the canvas and `computeDomainDiff` pass
   * it: with it, a link stored twice with no key flagged is exported from the
   * copy the canvas draws. Optional — without it the read is the same one
   * `getDomain` makes for any caller that does not pass it.
   */
  dbtKeyIndex?: DbtKeyIndex;
}

/**
 * The logical (design) stage of the domain at `domainPath` in `format`.
 *
 * Throws what `DomainService.getDomain` throws (`DomainFileError`, an
 * unsupported-format or unknown-layer error), and an `Error` for a format
 * that is not in `DIAGRAM_EXPORT_FORMATS` — before reading anything.
 */
export async function exportDomainFile(
  domainService: DomainService,
  domainPath: string,
  format: DiagramExportFormat,
  options: ExportDomainFileOptions = {},
): Promise<DomainExport> {
  if (!DIAGRAM_EXPORT_FORMATS.includes(format)) {
    throw new Error(`Unknown diagram export format: ${String(format)}`);
  }
  const unified = domainService.getDomain(domainPath, options.dbtKeyIndex ? { dbtKeyIndex: options.dbtKeyIndex } : {});
  const display = buildLogicalDisplayDomain(DomainService.toLogicalStage(unified), unified.viewConfig, unified.stubColumns);
  return {
    content: exportDiagram(display, format),
    fileName: diagramExportFileName(display, format),
    domainName: display.domain,
    layer: display.layer,
  };
}
