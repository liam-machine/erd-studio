/**
 * `erd-studio export` — a domain's logical (design) diagram as Mermaid or DBML.
 *
 * The text comes from `exportDomainFile` (`src/services/diagramExport.ts`),
 * the one host entry point the palette command and the canvas also call, so
 * the CLI, the extension and the Confluence app print the same bytes. The
 * dbt key evidence is passed the way `computeDomainDiff` passes it, so a link
 * stored twice is exported from the copy the canvas draws.
 *
 * Read-only like every subcommand: the text goes to stdout and nothing is
 * written — `> schema.dbml` is the user's own redirect, never an `--out`.
 */

import type { DiagramExportFormat } from '@erd-studio/core';

import { exportDomainFile } from '../services/diagramExport';
import { dbtKeyIndexOf } from '../services/stageDisplay';
import { CliEnvError, relPath, type CliContext } from './context';
import { describeDomainError, resolveDomainPath } from './diff';

export interface ExportOptions {
  /** The `--domain` argument, resolved like `diff --domain`. */
  domain: string;
  format: DiagramExportFormat;
  cwd?: string;
}

/** The `--json` shape. Paths are project-relative with forward slashes. */
export interface ExportResult {
  cliVersion: string;
  /** The domain file, project-relative. */
  domain: string;
  format: DiagramExportFormat;
  /** A safe file name for the text, e.g. `showcase.dbml`. */
  fileName: string;
  /** The export text, ending in a newline. */
  content: string;
}

/**
 * Export one domain. A file that cannot be read is a `CliEnvError` with the
 * same codes and messages `diff --domain` uses (exit 3).
 */
export async function runExport(ctx: CliContext, opts: ExportOptions): Promise<ExportResult> {
  const file = resolveDomainPath(ctx, opts.domain, opts.cwd);
  try {
    const exported = await exportDomainFile(ctx.domainService, file, opts.format, {
      dbtKeyIndex: dbtKeyIndexOf(ctx.ymlData, ctx.manifest),
    });
    return {
      cliVersion: ctx.envelope.cliVersion,
      domain: relPath(ctx.root, file),
      format: opts.format,
      fileName: exported.fileName,
      content: exported.content,
    };
  } catch (err) {
    const { code, message } = describeDomainError(ctx, file, err);
    throw new CliEnvError(code, message);
  }
}
