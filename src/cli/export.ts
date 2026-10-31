/**
 * `erd-studio export` — a domain's logical (design) diagram as Mermaid, DBML
 * or rich DBML (`dbml-rich`, its positions in the Project's `erd_layout`);
 * with `--all`, every domain.
 *
 * The text comes from `exportSubjectAreaFile` / `exportSubjectAreaFiles`
 * (`src/services/diagramExport.ts`), the host entry points the palette
 * commands and the canvas also call, so the CLI, the extension and the
 * Confluence app print the same bytes — and `--all` gives the same file
 * names **Export All Diagrams…** writes. The dbt key evidence is passed the
 * way `computeSubjectAreaDiff` passes it, so a link stored twice is exported
 * from the copy the canvas draws.
 *
 * Read-only like every subcommand: the text goes to stdout and nothing is
 * written — `> schema.dbml` is the user's own redirect, never an `--out`.
 */

import { exportSubjectAreaFile, exportSubjectAreaFiles } from '../services/diagramExport';
import { dbtKeyIndexOf } from '../services/stageDisplay';
import type { CliExportFormat } from './args';
import { CliEnvError, relPath, type CliContext } from './context';
import { describeSubjectAreaError, listAllSubjectAreas, resolveSubjectAreaPath } from './diff';

export interface ExportOptions {
  /** The `--domain` argument, resolved like `diff --domain`. */
  domain: string;
  format: CliExportFormat;
  cwd?: string;
}

/** The `--json` shape. Paths are project-relative with forward slashes. */
export interface ExportResult {
  cliVersion: string;
  /** The domain file, project-relative. */
  domain: string;
  format: CliExportFormat;
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
  const file = resolveSubjectAreaPath(ctx, opts.domain, opts.cwd);
  try {
    const exported = await exportSubjectAreaFile(ctx.subjectAreaService, file, opts.format, {
      dbtKeyIndex: dbtKeyIndexOf(ctx.ymlData, ctx.manifest),
      layers: ctx.layerService,
    });
    return {
      cliVersion: ctx.envelope.cliVersion,
      domain: relPath(ctx.root, file),
      format: opts.format,
      fileName: exported.fileName,
      content: exported.content,
    };
  } catch (err) {
    const { code, message } = describeSubjectAreaError(ctx, file, err);
    throw new CliEnvError(code, message);
  }
}

/** One file of `export --all`: what the human-mode list holds. */
export interface ExportedFileEntry {
  fileName: string;
  content: string;
}

/** `export --all --json`. Paths are project-relative with forward slashes. */
export interface ExportAllResult {
  cliVersion: string;
  format: CliExportFormat;
  /** By layer, then domain file: one file per domain. */
  files: Array<ExportedFileEntry & { domain: string }>;
  /** Domains that could not be read, with `diff --all`'s per-domain error codes. */
  skipped: Array<{ domain: string; error: { code: string; message: string } }>;
}

/**
 * Export every domain under the semantic dir: one file each, named as
 * **Export All Diagrams…** names them (`<layer>-<name>` when two layers hold
 * the same name). A domain that cannot be read is skipped and reported, not
 * fatal; no semantic dir or no domains is a `CliEnvError` (exit 3).
 */
export async function runExportAll(ctx: CliContext, opts: { format: CliExportFormat }): Promise<ExportAllResult> {
  const summaries = listAllSubjectAreas(ctx);
  const exported = await exportSubjectAreaFiles(
    ctx.subjectAreaService,
    summaries.map((s) => s.filePath),
    opts.format,
    { dbtKeyIndex: dbtKeyIndexOf(ctx.ymlData, ctx.manifest), layers: ctx.layerService },
  );
  return {
    cliVersion: ctx.envelope.cliVersion,
    format: opts.format,
    files: exported.files.map((f) => ({ domain: relPath(ctx.root, f.domainPath), fileName: f.fileName, content: f.content })),
    skipped: exported.skipped.map((s) => ({
      domain: relPath(ctx.root, s.domainPath),
      error: describeSubjectAreaError(ctx, s.domainPath, s.error),
    })),
  };
}
